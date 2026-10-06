-- community-quiz.sql / community-members.sql の後に実行。
-- 既存の所有者・コミュニティ単位のRLSを引き継ぐ。
-- 過去の合計成績をレベルへ推測配分せず、新規回答から記録する。
alter table public.quiz_scores
  add column if not exists level_scores jsonb not null default '{}'::jsonb
  check (jsonb_typeof(level_scores) = 'object');
