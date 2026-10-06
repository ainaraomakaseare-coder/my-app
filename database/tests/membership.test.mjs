import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('membership, administrator actions and revocation enforce server access', async (t) => {
  const db = new PGlite();
  const ids = [1, 2, 3, 4, 5].map(n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`);
  const [admin, member, outsider, otherAdmin, freshUser] = ids;
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    create table public.people(id text primary key, room_id text, name text, photo_urls jsonb default '[]');
    create table public.tag_notes(room_id text, tag_name text, episodes jsonb default '[]');
    create schema storage;
    create table storage.buckets(id text primary key, public boolean);
    create table storage.objects(id uuid default gen_random_uuid(), bucket_id text, name text);
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon, authenticated;
    grant select, insert, update, delete on storage.objects to anon, authenticated;
    -- Deliberately permissive previous policies: migration must defeat these.
    create policy old_photos_all on storage.objects for all to public using(true) with check(true);
    create policy old_people_all on public.people for all to public using(true) with check(true);
    insert into storage.buckets values ('photos', true), ('unrelated', true);
    insert into storage.objects(bucket_id,name) values ('photos','old-photo.jpg'), ('unrelated','open.jpg');
    insert into public.people values ('legacy-person','legacy-room','Old profile',
      '["https://example.supabase.co/storage/v1/object/public/photos/old-photo.jpg"]');
  `);
  for (const id of ids) await db.query('insert into auth.users values ($1)', [id]);
  await db.exec(await readFile(new URL('../community-quiz.sql', import.meta.url), 'utf8'));
  const migration = await readFile(new URL('../community-members.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(await readFile(new URL('../community-fiction.sql', import.meta.url), 'utf8'));

  async function as(id, sql, args = []) {
    await db.exec(`set role ${id ? 'authenticated' : 'anon'}`);
    try {
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id || '']);
      return (await db.query(sql, args)).rows;
    } finally { await db.exec('reset role'); }
  }
  async function rpc(id, name, args = []) {
    const params = args.map((_, i) => `$${i + 1}`).join(',');
    return (await as(id, `select public.${name}(${params}) as value`, args))[0].value;
  }

  await t.test('old room cannot be claimed by knowing its old ID; bucket is private', async () => {
    assert.deepEqual(await as(outsider, 'select * from public.people'), []);
    await assert.rejects(rpc(outsider, 'binder_join_room', ['legacy-room', 'Stranger']), /invite_invalid/);
    await assert.rejects(as(outsider, 'insert into public.binder_members(room_id,user_id,display_name,role) values ($1,$2,$3,$4)', ['legacy-room', outsider, 'Stranger', 'admin']), /permission denied/);
    assert.equal((await db.query("select public from storage.buckets where id='photos'")).rows[0].public, false);
  });

  const first = await rpc(admin, 'binder_create_room', ['Community A', 'Admin']);
  const second = await rpc(otherAdmin, 'binder_create_room', ['Community B', 'Other Admin']);
  const room = first.room_id;
  assert.equal(await rpc(member, 'binder_join_room', [first.invite_code, 'Member']), room);
  await as(admin, 'insert into public.people(id,room_id,name) values ($1,$2,$3)', ['person-a', room, 'Alice']);
  await as(otherAdmin, 'insert into public.people(id,room_id,name) values ($1,$2,$3)', ['person-b', second.room_id, 'Bob']);
  await as(member, 'insert into public.tag_notes(room_id,tag_name) values ($1,$2)', [room, 'Team']);
  await as(member, 'insert into public.quiz_scores(room_id,user_id) values ($1,$2)', [room, member]);
  const photo = `${room}/${member}/member-photo.jpg`;
  await as(member, 'insert into storage.objects(bucket_id,name) values ($1,$2)', ['photos', photo]);

  await t.test('active members see own room; outsiders and other admins cannot', async () => {
    assert.deepEqual((await as(member, 'select id from public.people')).map(x => x.id), ['person-a']);
    assert.deepEqual(await as(outsider, 'select id from public.people'), []);
    assert.deepEqual((await as(otherAdmin, 'select id from public.people')).map(x => x.id), ['person-b']);
    assert.equal((await as(member, 'select * from storage.objects where name=$1', [photo])).length, 1);
    assert.equal((await as(outsider, 'select * from storage.objects where name=$1', [photo])).length, 0);
    assert.equal((await as(member, 'select * from public.binder_members')).length, 1);
    assert.equal((await as(admin, 'select * from public.binder_members')).length, 2);
    await assert.rejects(as(member, 'insert into public.people values ($1,$2,$3,$4)', ['forged', second.room_id, 'x', '[]']), /row-level security/);
    await assert.rejects(as(member, 'insert into public.quiz_scores(room_id,user_id) values ($1,$2)', [room, admin]), /row-level security/);
    await assert.rejects(as(member, 'select * from binder_private.invites'), /permission denied/);
    await assert.rejects(as(null, 'select * from public.people'), /permission denied/);
    // Migration must not change unrelated bucket policies.
    assert.equal((await as(null, "select * from storage.objects where bucket_id='unrelated'")).length, 1);
  });

  await t.test('member cannot remove/rotate or elevate self; admin cannot remove self or another admin', async () => {
    await assert.rejects(rpc(member, 'binder_remove_member', [room, admin]), /admin_required/);
    await assert.rejects(rpc(otherAdmin, 'binder_remove_member', [room, member]), /admin_required/);
    await assert.rejects(rpc(member, 'binder_rotate_invite', [room]), /admin_required/);
    await assert.rejects(as(member, "update public.binder_members set role='admin' where user_id=$1", [member]), /permission denied/);
    await assert.rejects(rpc(admin, 'binder_remove_member', [room, admin]), /cannot_remove_self/);
    await db.query("insert into public.binder_members(room_id,user_id,display_name,role) values ($1,$2,'Trusted admin','admin')", [room, otherAdmin]);
    await assert.rejects(rpc(admin, 'binder_remove_member', [room, otherAdmin]), /cannot_remove_admin/);
    // Failed remove rolled back the attempted invitation rotation.
    assert.equal(await rpc(member, 'binder_join_room', [first.invite_code, 'Member']), room);
  });

  const rotated = await rpc(admin, 'binder_remove_member', [room, member]);
  await t.test('removal revokes all room data, score writes, photo reads/writes and old invite', async () => {
    assert.equal(await rpc(member, 'binder_is_member', [room]), false);
    for (const table of ['people', 'tag_notes', 'quiz_scores']) {
      assert.deepEqual(await as(member, `select * from public.${table} where room_id=$1`, [room]), []);
    }
    assert.equal((await as(member, 'select * from storage.objects where name=$1', [photo])).length, 0);
    await assert.rejects(as(member, 'insert into storage.objects(bucket_id,name) values ($1,$2)', ['photos', `${room}/${member}/new.jpg`]), /row-level security/);
    await assert.rejects(as(member, 'insert into public.quiz_scores(room_id,user_id) values ($1,$2)', [room, member]), /row-level security/);
    await assert.rejects(as(member, 'insert into public.people(id,room_id,name) values ($1,$2,$3)', ['blocked', room, 'x']), /row-level security/);
    await as(member, "update public.people set name='hacked' where id='person-a'");
    assert.equal((await as(admin, "select name from public.people where id='person-a'"))[0].name, 'Alice');
    await as(member, 'delete from storage.objects where name=$1', [photo]);
    assert.equal((await as(admin, 'select * from storage.objects where name=$1', [photo])).length, 1);
    await assert.rejects(rpc(member, 'binder_join_room', [rotated, 'Again']), /membership_removed/);
    await assert.rejects(rpc(freshUser, 'binder_join_room', [first.invite_code, 'Different device']), /invite_invalid/);
    assert.equal((await as(admin, 'select * from public.quiz_scores where user_id=$1', [member])).length, 0);
    assert.equal((await as(admin, "select * from public.people where id='person-a'")).length, 1);
  });

  await t.test('new invite works for invited new member; existing members stay active', async () => {
    assert.equal(await rpc(freshUser, 'binder_join_room', [rotated, 'New member']), room);
    assert.equal(await rpc(otherAdmin, 'binder_is_member', [room]), true);
    const latest = await rpc(admin, 'binder_rotate_invite', [room]);
    await assert.rejects(rpc(outsider, 'binder_join_room', [rotated, 'Old link']), /invite_invalid/);
    assert.equal(await rpc(outsider, 'binder_join_room', [latest, 'New link']), room);
    assert.equal(await rpc(freshUser, 'binder_is_member', [room]), true);
  });

  await t.test('emergency pause blocks joins, survives rotation/removal and resumes only with a fresh code', async () => {
    const emergency = await rpc(admin, 'binder_create_room', ['Emergency room', 'Admin']);
    const r = emergency.room_id;
    await rpc(member, 'binder_join_room', [emergency.invite_code, 'Member']);
    assert.equal(await rpc(admin, 'binder_get_invite_status', [r]), true);
    await assert.rejects(rpc(member, 'binder_set_invites_enabled', [r, false]), /admin_required/);
    await assert.rejects(rpc(otherAdmin, 'binder_set_invites_enabled', [r, false]), /admin_required/);
    await assert.rejects(rpc(member, 'binder_get_invite_status', [r]), /admin_required/);
    await assert.rejects(rpc(admin, 'binder_set_invites_enabled', [r, null]), /enabled_required/);
    const paused = await rpc(admin, 'binder_set_invites_enabled', [r, false]);
    assert.deepEqual(paused, { enabled: false, invite_code: null });
    await assert.rejects(rpc(outsider, 'binder_join_room', [emergency.invite_code, 'Unexpected']), /invite_invalid/);
    assert.equal(await rpc(member, 'binder_is_member', [r]), true, 'pausing does not expel existing members');
    const rotatedWhilePaused = await rpc(admin, 'binder_rotate_invite', [r]);
    await assert.rejects(rpc(outsider, 'binder_join_room', [rotatedWhilePaused, 'Unexpected']), /invite_invalid/);
    await rpc(admin, 'binder_remove_member', [r, member]);
    assert.equal(await rpc(admin, 'binder_get_invite_status', [r]), false, 'removal must not resume invitations');
    await db.exec(migration);
    assert.equal(await rpc(admin, 'binder_get_invite_status', [r]), false, 'migration rerun preserves paused state');
    const resumed = await rpc(admin, 'binder_set_invites_enabled', [r, true]);
    assert.equal(resumed.enabled, true);
    assert.notEqual(resumed.invite_code, emergency.invite_code);
    assert.notEqual(resumed.invite_code, rotatedWhilePaused);
    for (const code of [emergency.invite_code, rotatedWhilePaused]) {
      await assert.rejects(rpc(outsider, 'binder_join_room', [code, 'Old code']), /invite_invalid/);
    }
    await assert.rejects(rpc(member, 'binder_join_room', [resumed.invite_code, 'Removed member']), /membership_removed/);
    assert.equal(await rpc(outsider, 'binder_join_room', [resumed.invite_code, 'Invited member']), r);
  });

  await t.test('explicit legacy admin can view old photos; rerun cannot reassign legacy photo ownership', async () => {
    await db.query("insert into public.binder_members(room_id,user_id,display_name,role) values ('legacy-room',$1,'Legacy admin','admin')", [admin]);
    assert.equal(await rpc(admin, 'binder_can_access_photo', ['old-photo.jpg']), true);
    assert.equal(await rpc(otherAdmin, 'binder_can_access_photo', ['old-photo.jpg']), false);
    // A room member must not gain access by referencing another room's old URL.
    await as(otherAdmin, 'update public.people set photo_urls=$1 where id=$2', ['["https://example.supabase.co/storage/v1/object/public/photos/old-photo.jpg"]', 'person-b']);
    await db.exec(migration);
    assert.equal(await rpc(otherAdmin, 'binder_can_access_photo', ['old-photo.jpg']), false);
    assert.equal(await rpc(member, 'binder_is_member', [room]), false);
  });
  await t.test('fictional material is separate, room-scoped and inaccessible after removal', async () => {
    const r = (await rpc(admin, 'binder_create_room', ['Fiction room', 'Admin']));
    await rpc(member, 'binder_join_room', [r.invite_code, 'Author']);
    await rpc(freshUser, 'binder_join_room', [r.invite_code, 'Reader']);
    const rows = await as(member, 'insert into public.binder_fictional_episodes(room_id,text,tags) values ($1,$2,$3) returning id', [r.room_id, 'Explicitly made up episode', ['club']]);
    const id = rows[0].id;
    assert.equal((await as(freshUser, 'select * from public.binder_fictional_episodes')).length, 1);
    assert.deepEqual(await as(outsider, 'select * from public.binder_fictional_episodes'), []);
    await assert.rejects(as(member, 'insert into public.binder_fictional_episodes(room_id,text,created_by) values ($1,$2,$3)', [r.room_id, 'Forged author', admin]), /row-level security/);
    await as(freshUser, 'delete from public.binder_fictional_episodes where id=$1', [id]);
    assert.equal((await as(admin, 'select * from public.binder_fictional_episodes where id=$1', [id])).length, 1);
    await rpc(admin, 'binder_remove_member', [r.room_id, member]);
    assert.deepEqual(await as(member, 'select * from public.binder_fictional_episodes'), []);
    await assert.rejects(as(member, 'insert into public.binder_fictional_episodes(room_id,text) values ($1,$2)', [r.room_id, 'Blocked story']), /row-level security/);
    await as(admin, 'delete from public.binder_fictional_episodes where id=$1', [id]);
    assert.deepEqual(await as(admin, 'select * from public.binder_fictional_episodes where id=$1', [id]), []);
  });
  await db.close();
});
