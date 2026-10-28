-- 招待コードを、管理者だけでなく参加中のメンバー全員が見て共有できるようにする。
-- 発行し直し・参加受付の停止/再開・退出は、これまでどおり管理者だけ。
-- 事前に community-invite-display.sql を実行してあること。
begin;
create or replace function public.binder_get_current_invite(p_room text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_enabled boolean; v_cipher bytea; v_hash text; v_code text; v_secret text;
begin
  if not public.binder_is_member(p_room) then raise exception 'membership_required'; end if;
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
