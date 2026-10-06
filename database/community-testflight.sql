begin;
-- おもいでバインダー: 共有項目とコミュニティランキング
-- Supabase SQL Editorで一度だけ実行してください。既存のpeople行は従来どおり全項目共有になります。

alter table public.people
  add column if not exists visibility jsonb not null default
    '{"name":true,"nickname":true,"photo":true,"tags":true,"hobbies":true,"history":true,"episodes":true}'::jsonb;

create table if not exists public.quiz_scores (
  room_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null default 'メンバー' check (char_length(display_name) between 1 and 24),
  known_people text[] not null default '{}',
  correct_count integer not null default 0 check (correct_count >= 0),
  answer_count integer not null default 0 check (answer_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

alter table public.quiz_scores enable row level security;

drop policy if exists "quiz scores are readable by signed-in users" on public.quiz_scores;
create policy "quiz scores are readable by signed-in users"
  on public.quiz_scores for select to authenticated using (true);

drop policy if exists "players can create their own score" on public.quiz_scores;
create policy "players can create their own score"
  on public.quiz_scores for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "players can update their own score" on public.quiz_scores;
create policy "players can update their own score"
  on public.quiz_scores for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update on public.quiz_scores to authenticated;

-- このアプリの現行room_idはクライアントが合言葉から計算し、各クエリで絞り込む方式です。
-- 下記RLSはスコア所有者の書き込みを制限しますが、room単位の認可は既存のpeople/tag_notesと同じく
-- クライアントのroom_idフィルターに依存します。機微情報や本番の非公開名簿には使わないでください。

-- Apply AFTER community-quiz.sql. This is a coordinated app/database migration.
-- Existing rooms stay locked until a trusted operator assigns an admin (README).
-- All objects in the app's shared `photos` bucket become private.

create schema if not exists binder_private;
revoke all on schema binder_private from public, anon, authenticated;

create table if not exists public.binder_rooms (
  id text primary key,
  name text not null check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now()
);
create table if not exists public.binder_members (
  room_id text not null references public.binder_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 24),
  role text not null default 'member' check (role in ('admin', 'member')),
  status text not null default 'active' check (status in ('active', 'removed')),
  joined_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key (room_id, user_id)
);
create index if not exists binder_members_user on public.binder_members(user_id, status);
create table if not exists binder_private.invites (
  room_id text primary key references public.binder_rooms(id) on delete cascade,
  code_hash text unique not null
);
alter table binder_private.invites add column if not exists enabled boolean not null default true;
create table if not exists binder_private.legacy_photos (
  path text not null,
  room_id text not null references public.binder_rooms(id) on delete cascade,
  primary key (path, room_id)
);
create table if not exists binder_private.migrations (id text primary key);
revoke all on all tables in schema binder_private from public, anon, authenticated;

-- Pre-register old room IDs without making the first visitor an administrator.
insert into public.binder_rooms(id, name)
select distinct room_id, 'おもいでコミュニティ' from public.people where room_id is not null
on conflict do nothing;
insert into public.binder_rooms(id, name)
select distinct room_id, 'おもいでコミュニティ' from public.tag_notes where room_id is not null
on conflict do nothing;
insert into public.binder_rooms(id, name)
select distinct room_id, 'おもいでコミュニティ' from public.quiz_scores where room_id is not null
on conflict do nothing;

-- Previous filenames were UUID_safeName, with no directory. Freeze their room
-- association during migration; clients cannot claim an unrelated old photo.
do $$ begin
if not exists (select 1 from binder_private.migrations where id = 'legacy-photo-ownership') then
insert into binder_private.legacy_photos(path, room_id)
select distinct split_part(split_part(u.url, '/object/public/photos/', 2), '?', 1), p.room_id
from public.people p
cross join lateral jsonb_array_elements_text(coalesce(to_jsonb(p.photo_urls), '[]'::jsonb)) as u(url)
where p.room_id is not null and u.url like '%/object/public/photos/%'
on conflict do nothing;
insert into binder_private.migrations(id) values ('legacy-photo-ownership');
end if;
end $$;

create or replace function public.binder_is_member(p_room text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.binder_members
    where room_id = p_room and user_id = auth.uid() and status = 'active');
$$;
create or replace function public.binder_is_admin(p_room text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.binder_members
    where room_id = p_room and user_id = auth.uid() and status = 'active' and role = 'admin');
$$;

alter table public.binder_rooms enable row level security;
alter table public.binder_members enable row level security;
revoke all on public.binder_rooms, public.binder_members from public, anon, authenticated;
grant select on public.binder_rooms, public.binder_members to authenticated;
drop policy if exists binder_rooms_read on public.binder_rooms;
create policy binder_rooms_read on public.binder_rooms for select to authenticated
  using (public.binder_is_member(id));
drop policy if exists binder_members_read on public.binder_members;
create policy binder_members_read on public.binder_members for select to authenticated
  using (user_id = auth.uid() or public.binder_is_admin(room_id));

create or replace function public.binder_create_room(p_name text, p_display_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_room text := gen_random_uuid()::text;
  v_code text := replace(gen_random_uuid()::text, '-', '');
begin
  if auth.uid() is null then raise exception 'sign_in_required'; end if;
  if nullif(btrim(p_name), '') is null or nullif(btrim(p_display_name), '') is null then
    raise exception 'name_required';
  end if;
  insert into public.binder_rooms(id, name) values (v_room, btrim(p_name));
  insert into public.binder_members(room_id, user_id, display_name, role)
    values (v_room, auth.uid(), btrim(p_display_name), 'admin');
  insert into binder_private.invites(room_id, code_hash)
    values (v_room, encode(sha256(convert_to(v_code, 'UTF8')), 'hex'));
  return jsonb_build_object('room_id', v_room, 'invite_code', v_code);
end;
$$;

create or replace function public.binder_join_room(p_code text, p_display_name text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_room text; v_status text;
begin
  if auth.uid() is null then raise exception 'sign_in_required'; end if;
  if nullif(btrim(p_display_name), '') is null then raise exception 'name_required'; end if;
  -- Same lock used by rotation/removal: a concurrent join cannot consume a stale invite.
  select room_id into v_room from binder_private.invites
    where enabled and code_hash = encode(sha256(convert_to(lower(btrim(p_code)), 'UTF8')), 'hex') for update;
  if v_room is null then raise exception 'invite_invalid'; end if;
  select status into v_status from public.binder_members where room_id = v_room and user_id = auth.uid();
  if v_status = 'removed' then raise exception 'membership_removed'; end if;
  insert into public.binder_members(room_id, user_id, display_name)
    values (v_room, auth.uid(), btrim(p_display_name))
    on conflict (room_id, user_id) do update set display_name = excluded.display_name;
  return v_room;
end;
$$;

create or replace function public.binder_rotate_invite(p_room text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_code text := replace(gen_random_uuid()::text, '-', '');
begin
  if not public.binder_is_admin(p_room) then raise exception 'admin_required'; end if;
  insert into binder_private.invites(room_id, code_hash)
    values (p_room, encode(sha256(convert_to(v_code, 'UTF8')), 'hex'))
    on conflict (room_id) do update set code_hash = excluded.code_hash;
  return v_code;
end;
$$;

create or replace function public.binder_remove_member(p_room text, p_user uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_code text; v_role text; v_status text;
begin
  if not public.binder_is_admin(p_room) then raise exception 'admin_required'; end if;
  if p_user = auth.uid() then raise exception 'cannot_remove_self'; end if;
  -- Lock invite first (same order as join), then the membership row.
  v_code := public.binder_rotate_invite(p_room);
  select role, status into v_role, v_status from public.binder_members
    where room_id = p_room and user_id = p_user for update;
  if v_role is null then raise exception 'member_not_found'; end if;
  if v_role = 'admin' then raise exception 'cannot_remove_admin'; end if;
  if v_status <> 'active' then raise exception 'already_removed'; end if;
  update public.binder_members set status = 'removed', removed_at = now()
    where room_id = p_room and user_id = p_user;
  delete from public.quiz_scores where room_id = p_room and user_id = p_user;
  return v_code;
end;
$$;

create or replace function public.binder_get_invite_status(p_room text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not public.binder_is_admin(p_room) then raise exception 'admin_required'; end if;
  return exists (select 1 from binder_private.invites where room_id = p_room and enabled);
end;
$$;

create or replace function public.binder_set_invites_enabled(p_room text, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  if not public.binder_is_admin(p_room) then raise exception 'admin_required'; end if;
  if p_enabled is null then raise exception 'enabled_required'; end if;
  -- Both pause and resume revoke the previous code. Rotation locks the invite
  -- row, serializing this transaction with joins and other admin operations.
  v_code := public.binder_rotate_invite(p_room);
  update binder_private.invites set enabled = p_enabled where room_id = p_room;
  return jsonb_build_object('enabled', p_enabled, 'invite_code', case when p_enabled then v_code else null end);
end;
$$;

create or replace function public.binder_set_display_name(p_room text, p_name text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.binder_is_member(p_room) then raise exception 'membership_required'; end if;
  if nullif(btrim(p_name), '') is null then raise exception 'name_required'; end if;
  update public.binder_members set display_name = btrim(p_name)
    where room_id = p_room and user_id = auth.uid();
end;
$$;

-- Mandatory room check is RESTRICTIVE, so older USING(true) policies cannot bypass it.
do $$
declare t text;
begin
  foreach t in array array['people', 'tag_notes', 'quiz_scores'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists binder_room_boundary on public.%I', t);
    execute format('create policy binder_room_boundary on public.%I as restrictive for all to public using (public.binder_is_member(room_id)) with check (public.binder_is_member(room_id))', t);
    execute format('drop policy if exists binder_room_access on public.%I', t);
    if t <> 'quiz_scores' then
      execute format('create policy binder_room_access on public.%I for all to authenticated using (public.binder_is_member(room_id)) with check (public.binder_is_member(room_id))', t);
    end if;
  end loop;
end;
$$;
-- Keep score ownership even if an old permissive write policy exists.
drop policy if exists binder_score_insert on public.quiz_scores;
create policy binder_score_insert on public.quiz_scores as restrictive for insert to public
  with check (user_id = auth.uid());
drop policy if exists binder_score_update on public.quiz_scores;
create policy binder_score_update on public.quiz_scores as restrictive for update to public
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke delete on public.quiz_scores from authenticated;

create or replace function public.binder_can_access_photo(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.binder_is_member(split_part(p_path, '/', 1)) or exists (
    select 1 from binder_private.legacy_photos
    where path = p_path and public.binder_is_member(room_id)
  );
$$;

-- Existing public URLs stop working. The new client uses authenticated downloads.
update storage.buckets set public = false where id = 'photos';
drop policy if exists binder_photo_boundary on storage.objects;
create policy binder_photo_boundary on storage.objects as restrictive for all to public
  using (bucket_id <> 'photos' or public.binder_can_access_photo(name))
  with check (bucket_id <> 'photos' or (public.binder_is_member(split_part(name, '/', 1)) and split_part(name, '/', 2) = auth.uid()::text));
drop policy if exists binder_photo_read on storage.objects;
create policy binder_photo_read on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.binder_can_access_photo(name));
drop policy if exists binder_photo_upload on storage.objects;
create policy binder_photo_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.binder_is_member(split_part(name, '/', 1)) and split_part(name, '/', 2) = auth.uid()::text);
drop policy if exists binder_photo_delete on storage.objects;
create policy binder_photo_delete on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.binder_can_access_photo(name));

-- No anonymous PUBLIC execution of security-definer RPCs.
revoke all on function public.binder_is_member(text), public.binder_is_admin(text),
  public.binder_create_room(text,text), public.binder_join_room(text,text),
  public.binder_rotate_invite(text), public.binder_remove_member(text,uuid),
  public.binder_get_invite_status(text), public.binder_set_invites_enabled(text,boolean),
  public.binder_set_display_name(text,text), public.binder_can_access_photo(text)
  from public, anon, authenticated;
grant execute on function public.binder_is_member(text), public.binder_is_admin(text),
  public.binder_create_room(text,text), public.binder_join_room(text,text),
  public.binder_rotate_invite(text), public.binder_remove_member(text,uuid),
  public.binder_get_invite_status(text), public.binder_set_invites_enabled(text,boolean),
  public.binder_set_display_name(text,text), public.binder_can_access_photo(text)
  to authenticated;
-- Policies on unrelated storage buckets must still be evaluable by anon.
grant execute on function public.binder_is_member(text), public.binder_can_access_photo(text) to anon;


-- Apply after community-quiz.sql and community-members.sql.
-- Explicitly fictional quiz material, never a profile episode or an inferred fact.

create table if not exists public.binder_fictional_episodes (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references public.binder_rooms(id) on delete cascade,
  text text not null check (char_length(btrim(text)) between 2 and 2000),
  tags text[] not null default '{}',
  created_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists binder_fiction_room on public.binder_fictional_episodes(room_id);
alter table public.binder_fictional_episodes enable row level security;
revoke all on public.binder_fictional_episodes from public, anon, authenticated;
grant select, insert, delete on public.binder_fictional_episodes to authenticated;
drop policy if exists binder_fiction_boundary on public.binder_fictional_episodes;
create policy binder_fiction_boundary on public.binder_fictional_episodes as restrictive for all to public
  using (public.binder_is_member(room_id)) with check (public.binder_is_member(room_id));
drop policy if exists binder_fiction_read on public.binder_fictional_episodes;
create policy binder_fiction_read on public.binder_fictional_episodes for select to authenticated using (true);
drop policy if exists binder_fiction_add on public.binder_fictional_episodes;
create policy binder_fiction_add on public.binder_fictional_episodes for insert to authenticated with check (created_by = auth.uid());
drop policy if exists binder_fiction_delete on public.binder_fictional_episodes;
create policy binder_fiction_delete on public.binder_fictional_episodes for delete to authenticated
  using (created_by = auth.uid() or public.binder_is_admin(room_id));

-- community-quiz.sql / community-members.sql の後に実行。
-- 既存の所有者・コミュニティ単位のRLSを引き継ぐ。
-- 過去の合計成績をレベルへ推測配分せず、新規回答から記録する。
alter table public.quiz_scores
  add column if not exists level_scores jsonb not null default '{}'::jsonb
  check (jsonb_typeof(level_scores) = 'object');

commit;
