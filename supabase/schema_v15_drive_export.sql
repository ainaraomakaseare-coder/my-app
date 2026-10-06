-- ============================================================================
-- 投稿卓 NEO / v15 … 分析用の数字を、毎週 Google ドライブへ書き出す
--
-- ★ 何が変わるか
--   これまで月曜の朝に「のび」の「自分の投稿を分析用にコピー」を押して
--   Claude に貼っていた数字を、投稿卓が自分で Google ドライブへ置くようにする。
--   Claude はドライブから読むので、貼る作業が無くなる。
--
-- ★ ここに置くもの
--   Google ドライブへ書き込むための引換券（リフレッシュトークン）と、
--   書き出し先のフォルダID。SNSの連携とは別物なので sns_accounts には入れない
--   （入れると投稿先の一覧に「ドライブ」が混ざる）。
--
-- ★ 何度流しても壊れません。
-- ============================================================================

create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table app_settings enable row level security;   -- 許可ルールを作らない＝サーバー専用
