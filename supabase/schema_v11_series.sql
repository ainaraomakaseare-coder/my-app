-- ============================================================================
-- 投稿卓 NEO / v11 … 企画（シリーズ）の「書き方の型」と「毎日の記録」
--
-- ★ 何が変わるか
--   運用アカウント（チャンネル）ごとに、企画の型を持てるようにする。
--     ・30日で30アプリ … DAY の数え方、毎回入れる項目（アプリ名…）
--     ・売上目標の企画 … 目標金額・期限・売上の内訳の名前
--   そして毎日の記録（売上の内訳・かかったお金・やった作業と時間・作ったアカウント・
--   公開したサービス・学び）を1日1件で持つ。
--
--   投稿案は AI に書かせるが、数字（DAY・累計・内訳・利益・残り日数・達成率・
--   作業時間）は AI に書かせず、この記録から投稿卓が計算して差し込む。
--
-- ★ 型も記録も jsonb で持つ。形は lib/series.js の normalizeSeries() /
--   normalizeEntry() が決める。企画ごとに入れるものが違うので、列を決め打ちにしない。
--
-- ★ 記録は1日1件。同じ日にもう一度保存したら上書き（足し算しない）。
--   足し算にすると、入れ直したときに二重に数えて累計が膨らむ。
--   「稼いだ額」を盛らないことが、この企画の信用そのものなので。
--
-- ★ 何度流しても壊れません。
-- ============================================================================

alter table account_groups add column if not exists series jsonb;

comment on column account_groups.series is
  '企画の型（名前・書き方・毎回入れる項目・開始日・期限・目標金額・売上の内訳の名前）。null なら企画なし。';

create table if not exists series_entries (
  id           bigserial primary key,
  group_id     uuid not null references account_groups(id) on delete cascade,
  happened_on  date not null,                          -- 日本時間の日付
  entry        jsonb not null default '{}'::jsonb,     -- その日の記録（lib/series.js normalizeEntry）
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (group_id, happened_on)
);

create index if not exists series_entries_group_idx on series_entries (group_id, happened_on desc);

alter table series_entries enable row level security;   -- 許可ルールを作らない＝サーバー専用
