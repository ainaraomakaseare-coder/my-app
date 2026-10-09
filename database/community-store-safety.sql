begin;
create table if not exists binder_private.account_deletions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  photo_paths text[] not null default '{}',
  requested_at timestamptz not null default now()
);
alter table binder_private.account_deletions enable row level security;
revoke all on binder_private.account_deletions from public, anon, authenticated;

create or replace function public.binder_is_member(p_room text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.binder_members m where m.room_id=p_room
    and m.user_id=auth.uid() and m.status='active')
    and not exists(select 1 from binder_private.account_deletions d where d.user_id=auth.uid());
$$;
create or replace function public.binder_is_admin(p_room text)
returns boolean language sql stable security definer set search_path='' as $$
  select public.binder_is_member(p_room) and exists(select 1 from public.binder_members m
    where m.room_id=p_room and m.user_id=auth.uid() and m.status='active' and m.role='admin');
$$;
create or replace function public.binder_room_has_admin(p_room text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.binder_members m where m.room_id=p_room
    and m.status='active' and m.role='admin'
    and not exists(select 1 from binder_private.account_deletions d where d.user_id=m.user_id));
$$;
revoke all on function public.binder_room_has_admin(text) from public, anon;
grant execute on function public.binder_room_has_admin(text) to authenticated;

create table if not exists public.binder_terms (
  user_id uuid primary key references auth.users(id) on delete cascade,
  version text not null check(version='2026-10-07'),
  accepted_at timestamptz not null default now()
);
alter table public.binder_terms enable row level security;
revoke all on public.binder_terms from public, anon, authenticated;
grant select, insert on public.binder_terms to authenticated;
create policy binder_terms_own on public.binder_terms for select to authenticated using(user_id=auth.uid());
create policy binder_terms_accept on public.binder_terms for insert to authenticated with check(user_id=auth.uid());

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

alter table public.people add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table public.people add column if not exists updated_by uuid references auth.users(id) on delete set null;
alter table public.people add column if not exists content_authors jsonb not null default '{}';
alter table public.tag_notes add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table public.tag_notes add column if not exists updated_by uuid references auth.users(id) on delete set null;
alter table public.tag_notes add column if not exists content_authors jsonb not null default '{}';
alter table public.binder_fictional_episodes add column if not exists updated_by uuid references auth.users(id) on delete set null;

create table if not exists public.binder_reports (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references public.binder_rooms(id) on delete cascade,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  person_id uuid references public.people(id) on delete cascade,
  target_user_id uuid references auth.users(id) on delete set null,
  reason text not null check(char_length(reason) between 1 and 1000),
  status text not null default 'open' check(status in ('open','resolved')),
  created_at timestamptz not null default now()
);
alter table public.binder_reports enable row level security;
revoke all on public.binder_reports from public, anon, authenticated;
grant select, insert on public.binder_reports to authenticated;
grant update(status) on public.binder_reports to authenticated;
create policy binder_reports_read on public.binder_reports for select to authenticated
  using (public.binder_is_member(room_id) and (reporter_id=auth.uid() or public.binder_is_admin(room_id)));
create policy binder_reports_insert on public.binder_reports for insert to authenticated
  with check(reporter_id=auth.uid() and status='open' and public.binder_is_member(room_id)
    and (person_id is null or exists(select 1 from public.people p where p.id=person_id and p.room_id=binder_reports.room_id))
    and (target_user_id is null or exists(select 1 from public.people p where p.id=person_id and p.room_id=binder_reports.room_id
      and target_user_id in (p.created_by,p.updated_by))));
create policy binder_reports_resolve on public.binder_reports for update to authenticated
  using(public.binder_is_admin(room_id)) with check(public.binder_is_admin(room_id));

create table if not exists public.binder_blocks (
  user_id uuid not null references auth.users(id) on delete cascade,
  blocked_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_id,blocked_user_id), check(user_id<>blocked_user_id)
);
alter table public.binder_blocks enable row level security;
revoke all on public.binder_blocks from public, anon, authenticated;
grant select, insert, delete on public.binder_blocks to authenticated;
create policy binder_blocks_own on public.binder_blocks for all to authenticated
  using(user_id=auth.uid()) with check(user_id=auth.uid());

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
create trigger binder_people_authors before insert or update on public.people for each row execute function binder_private.track_content();
create trigger binder_notes_authors before insert or update on public.tag_notes for each row execute function binder_private.track_content();
create trigger binder_fiction_authors before insert or update on public.binder_fictional_episodes for each row execute function binder_private.track_content();

create policy binder_people_delete_safety on public.people as restrictive for delete to authenticated
 using(public.binder_room_has_admin(room_id) and public.binder_can_post());
create policy binder_notes_delete_safety on public.tag_notes as restrictive for delete to authenticated
 using(public.binder_room_has_admin(room_id) and public.binder_can_post());
create policy binder_fiction_delete_safety on public.binder_fictional_episodes as restrictive for delete to authenticated
 using(public.binder_room_has_admin(room_id) and public.binder_can_post());

-- The service role is held only by the authenticated account-deletion Edge Function.
create or replace function public.binder_begin_account_deletion(p_user uuid)
returns text[] language plpgsql security definer set search_path='' as $$
declare paths text[];
begin
  if not exists(select 1 from auth.users where id=p_user) then raise exception 'account_not_found'; end if;
  insert into binder_private.account_deletions(user_id) values(p_user) on conflict do nothing;
  select coalesce(array_agg(name),'{}') into paths from storage.objects where bucket_id='photos'
    and (owner=p_user or owner_id=p_user::text or split_part(name,'/',2)=p_user::text);
  update binder_private.account_deletions set photo_paths=photo_paths || paths where user_id=p_user;
  return paths;
end;
$$;
create or replace function public.binder_finish_account_deletion(p_user uuid)
returns void language plpgsql security definer set search_path='' as $$
declare owned_paths text[];
begin
  select photo_paths into owned_paths from binder_private.account_deletions where user_id=p_user for update;
  if not found then raise exception 'deletion_not_started'; end if;
  if exists(select 1 from storage.objects where owner=p_user or owner_id=p_user::text
    or (bucket_id='photos' and split_part(name,'/',2)=p_user::text)) then raise exception 'photo_cleanup_incomplete'; end if;
  delete from public.people where created_by=p_user;
  update public.people set
    name=case when content_authors->>'name'=p_user::text then '削除済み' else name end,
    nickname=case when content_authors->>'nickname'=p_user::text then '' else nickname end,
    tags=case when content_authors->>'tags'=p_user::text then '{}' else tags end,
    hobbies=case when content_authors->>'hobbies'=p_user::text then '{}' else hobbies end,
    photo_urls=case when content_authors->>'photo_urls'=p_user::text then '{}' else
      array(select u from unnest(photo_urls) u where not exists(select 1 from unnest(owned_paths) p where right(u,length('/photos/'||p))='/photos/'||p)) end,
    history=case when content_authors->>'history'=p_user::text then '[]'::jsonb else history end,
    episodes=coalesce((select jsonb_agg(e.value) from jsonb_array_elements(coalesce(episodes,'[]')) e
      where coalesce(e.value->>'createdBy','')<>p_user::text and coalesce(e.value->>'updatedBy','')<>p_user::text),'[]'),
    content_authors=coalesce((select jsonb_object_agg(a.key,a.value) from jsonb_each_text(content_authors) a where a.value<>p_user::text),'{}'),
    updated_by=case when updated_by=p_user then null else updated_by end
    where updated_by=p_user or exists(select 1 from jsonb_each_text(content_authors) a where a.value=p_user::text)
      or episodes::text like '%'||p_user::text||'%'
      or exists(select 1 from unnest(photo_urls) u, unnest(owned_paths) p where right(u,length('/photos/'||p))='/photos/'||p);
  delete from public.tag_notes where content_authors->>'tag_name'=p_user::text;
  update public.tag_notes set episodes=coalesce((select jsonb_agg(e.value) from jsonb_array_elements(coalesce(episodes,'[]')) e
    where coalesce(e.value->>'createdBy','')<>p_user::text and coalesce(e.value->>'updatedBy','')<>p_user::text),'[]')
    ,content_authors=coalesce((select jsonb_object_agg(a.key,a.value) from jsonb_each_text(content_authors) a where a.value<>p_user::text),'{}'),
    updated_by=case when updated_by=p_user then null else updated_by end
    where updated_by=p_user or episodes::text like '%'||p_user::text||'%'
      or exists(select 1 from jsonb_each_text(content_authors) a where a.value=p_user::text);
  delete from public.binder_fictional_episodes where created_by=p_user or updated_by=p_user;
  update binder_private.invites i set enabled=false where exists(select 1 from public.binder_members m where m.room_id=i.room_id and m.user_id=p_user and m.role='admin')
    and not exists(select 1 from public.binder_members m where m.room_id=i.room_id and m.user_id<>p_user and m.role='admin' and m.status='active');
  -- Auth Admin API performs the hard deletion only after this cleanup succeeds.
end;
$$;
revoke all on function public.binder_begin_account_deletion(uuid),public.binder_finish_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.binder_begin_account_deletion(uuid),public.binder_finish_account_deletion(uuid) to service_role;
commit;
