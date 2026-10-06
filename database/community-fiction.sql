-- Apply after community-quiz.sql and community-members.sql.
-- Explicitly fictional quiz material, never a profile episode or an inferred fact.
begin;
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
commit;
