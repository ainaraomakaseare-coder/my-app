begin;
-- Enable only after the version containing the consent screen is distributed.
create table if not exists binder_private.release_settings (
 singleton boolean primary key default true check(singleton), terms_required boolean not null default false
);
insert into binder_private.release_settings(singleton) values(true) on conflict do nothing;
alter table binder_private.release_settings enable row level security;
revoke all on binder_private.release_settings from public, anon, authenticated;
create or replace function public.binder_can_post()
returns boolean language sql stable security definer set search_path='' as $$
 select not (select terms_required from binder_private.release_settings where singleton)
   or exists(select 1 from public.binder_terms where user_id=auth.uid() and version='2026-10-07');
$$;
revoke all on function public.binder_can_post() from public, anon;
grant execute on function public.binder_can_post() to authenticated;

create or replace function binder_private.track_content()
returns trigger language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); doc jsonb:=to_jsonb(new); previous jsonb:='{}';
  authors jsonb:='{}'; key text; item jsonb; prior_item jsonb; items jsonb:='[]';
begin
  if actor is null then return new; end if;
  if not public.binder_can_post() then raise exception 'terms_required'; end if;
  if not public.binder_room_has_admin(new.room_id) then raise exception 'community_read_only'; end if;
  if (doc - 'content_authors')::text ~* '(死ね|殺してやる|レイプ|児童ポルノ|nigger)' then raise exception 'content_not_allowed'; end if;
  if tg_op='UPDATE' then previous:=to_jsonb(old); end if;
  doc:=doc || jsonb_build_object('created_by',case when tg_op='INSERT' then actor::text else previous->>'created_by' end,'updated_by',actor::text);
  if doc ? 'content_authors' then
    authors:=coalesce(previous->'content_authors','{}');
    foreach key in array array['name','nickname','tags','hobbies','photo_urls','history','tag_name','visibility'] loop
      if doc ? key and (tg_op='INSERT' or doc->key is distinct from previous->key) then
        authors:=authors || jsonb_build_object(key,actor::text);
      end if;
    end loop;
    doc:=doc || jsonb_build_object('content_authors',authors);
  end if;
  if doc ? 'episodes' then
    for item in select value from jsonb_array_elements(coalesce(doc->'episodes','[]')) loop
      prior_item:=null;
      if item->>'id' is not null then
        select value into prior_item from jsonb_array_elements(coalesce(previous->'episodes','[]')) where value->>'id'=item->>'id' limit 1;
      end if;
      if prior_item is not null and (item-'createdBy'-'updatedBy')=(prior_item-'createdBy'-'updatedBy') then
        item:=prior_item;
      else
        item:=item || jsonb_build_object('createdBy',coalesce(prior_item->>'createdBy',actor::text),'updatedBy',actor::text);
      end if;
      items:=items || jsonb_build_array(item);
    end loop;
    doc:=doc || jsonb_build_object('episodes',items);
  end if;
  new:=jsonb_populate_record(new,doc);
  return new;
end;
$$;
revoke all on function binder_private.track_content() from public, anon, authenticated;
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
alter policy binder_people_delete_safety on public.people using(public.binder_room_has_admin(room_id) and public.binder_can_post());
alter policy binder_notes_delete_safety on public.tag_notes using(public.binder_room_has_admin(room_id) and public.binder_can_post());
alter policy binder_fiction_delete_safety on public.binder_fictional_episodes using(public.binder_room_has_admin(room_id) and public.binder_can_post());
alter policy binder_photo_insert_safety on storage.objects with check(bucket_id<>'photos' or (public.binder_room_has_admin(split_part(name,'/',1)) and public.binder_can_post()));
commit;