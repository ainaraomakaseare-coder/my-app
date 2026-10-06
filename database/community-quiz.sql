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
