-- Preserve existing hashes and membership. Current codes are readable only by active admins.
begin;
create extension if not exists pgcrypto with schema extensions;
create table if not exists binder_private.invite_key (
  singleton boolean primary key default true check (singleton),
  secret text not null
);
alter table binder_private.invite_key enable row level security;
revoke all on binder_private.invite_key from public, anon, authenticated;
insert into binder_private.invite_key(singleton, secret)
  values (true, gen_random_uuid()::text || gen_random_uuid()::text)
  on conflict (singleton) do nothing;
alter table binder_private.invites add column if not exists code_cipher bytea;

create or replace function public.binder_create_room(p_name text, p_display_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_room text := gen_random_uuid()::text;
  v_code text := replace(gen_random_uuid()::text, '-', ''); v_secret text;
begin
  if auth.uid() is null then raise exception 'sign_in_required'; end if;
  if nullif(btrim(p_name), '') is null or nullif(btrim(p_display_name), '') is null then
    raise exception 'name_required';
  end if;
  select secret into strict v_secret from binder_private.invite_key where singleton;
  insert into public.binder_rooms(id, name) values (v_room, btrim(p_name));
  insert into public.binder_members(room_id, user_id, display_name, role)
    values (v_room, auth.uid(), btrim(p_display_name), 'admin');
  insert into binder_private.invites(room_id, code_hash, code_cipher)
    values (v_room, encode(sha256(convert_to(v_code, 'UTF8')), 'hex'),
      extensions.pgp_sym_encrypt(v_code, v_secret, 'cipher-algo=aes256'));
  return jsonb_build_object('room_id', v_room, 'invite_code', v_code);
end;
$$;

create or replace function public.binder_rotate_invite(p_room text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_code text := replace(gen_random_uuid()::text, '-', ''); v_secret text;
begin
  if not public.binder_is_admin(p_room) then raise exception 'admin_required'; end if;
  select secret into strict v_secret from binder_private.invite_key where singleton;
  insert into binder_private.invites(room_id, code_hash, code_cipher)
    values (p_room, encode(sha256(convert_to(v_code, 'UTF8')), 'hex'),
      extensions.pgp_sym_encrypt(v_code, v_secret, 'cipher-algo=aes256'))
    on conflict (room_id) do update set code_hash = excluded.code_hash,
      code_cipher = excluded.code_cipher;
  return v_code;
end;
$$;

create or replace function public.binder_get_current_invite(p_room text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_enabled boolean; v_cipher bytea; v_hash text; v_code text; v_secret text;
begin
  if not public.binder_is_admin(p_room) then raise exception 'admin_required'; end if;
  select enabled, code_cipher, code_hash into v_enabled, v_cipher, v_hash
    from binder_private.invites where room_id = p_room;
  if v_enabled and v_cipher is not null then
    select secret into strict v_secret from binder_private.invite_key where singleton;
    v_code := extensions.pgp_sym_decrypt(v_cipher, v_secret);
    if encode(sha256(convert_to(v_code, 'UTF8')), 'hex') <> v_hash then v_code := null; end if;
  end if;
  return jsonb_build_object('enabled', coalesce(v_enabled, false), 'invite_code', v_code);
end;
$$;
revoke all on function public.binder_get_current_invite(text) from public, anon;
grant execute on function public.binder_get_current_invite(text) to authenticated;
commit;
