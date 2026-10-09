begin;
create or replace function binder_private.guard_display_name()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then return new; end if;
  if not public.binder_can_post() then raise exception 'terms_required'; end if;
  if new.display_name ~* '(死ね|殺してやる|レイプ|児童ポルノ|nigger)' then raise exception 'content_not_allowed'; end if;
  return new;
end;
$$;
revoke all on function binder_private.guard_display_name() from public, anon, authenticated;
create trigger binder_member_name_safety before insert or update of display_name on public.binder_members for each row execute function binder_private.guard_display_name();
create trigger binder_score_name_safety before insert or update on public.quiz_scores for each row execute function binder_private.guard_display_name();
create policy binder_photo_insert_safety on storage.objects as restrictive for insert to authenticated
  with check(bucket_id<>'photos' or (public.binder_room_has_admin(split_part(name,'/',1)) and public.binder_can_post()));
commit;
