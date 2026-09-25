-- ============================================================================
-- 投稿卓 NEO / v11 … 企画（シリーズ）の「書き方の型」と「数字の記録」
--
-- ★ 何が変わるか
--   運用アカウント（チャンネル）ごとに、企画の型を持てるようにする。
--     ・30日で30アプリ … DAY の数え方、毎回入れる項目（アプリ名・作業時間・費用…）
--     ・半年で100万    … 目標金額・期限、毎日の売上の記録
--   投稿案は AI に書かせるが、数字（DAY・累計・残り日数・達成率）は
--   AI に書かせず、ここに記録した値から投稿卓が計算して差し込む。
--
-- ★ 型は jsonb で持つ。形は lib/series.js の normalizeSeries() が決める。
--   企画ごとに入れる項目が違うので、列を決め打ちにしない。
--
-- ★ 売上の記録は1日1行。同じ日にもう一度入れたら上書き（足し算しない）。
--   足し算にすると、入れ直したときに二重に数えて累計が膨らむ。
--   「稼いだ額」を盛らないことが、この企画の信用そのものなので。
--
-- ★ 何度流しても壊れません。
-- ============================================================================

alter table account_groups add column if not exists series jsonb;

comment on column account_groups.series is
  '企画の型（名前・書き方・毎回入れる項目・開始日・目標金額と期限）。null なら企画なし。';

create table if not exists series_logs (
  id           bigserial primary key,
  group_id     uuid not null references account_groups(id) on delete cascade,
  happened_on  date not null,               -- 日本時間の日付
  amount_yen   bigint not null default 0,   -- その日の売上（円）。0 も記録として意味がある
  note         text not null default '',    -- 何で稼いだか（任意）
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (group_id, happened_on)
);

create index if not exists series_logs_group_idx on series_logs (group_id, happened_on desc);

alter table series_logs enable row level security;   -- 許可ルールを作らない＝サーバー専用
