-- ============================================================================
-- 投稿卓 NEO / v13 … 分析部隊①収集で集めた記録を、DBにためる（一気通貫）
--
-- ★ 何のためか
--   これまでは「①収集 → JSONを会話に貼る → ②分析」の間に手のコピペが挟まっていた
--   （docs/research/README.md）。ここからは、集めた記録を DB に保存し、
--   点検（lib/benchmark.js）を通った後の事実だけを一気に取り出せるようにする。
--
-- ★ benchmark_items … 1本ぶんの記録
--   record 列に lib/benchmark.js の型そのもの（ratio 込み）を jsonb で丸ごと持つ。
--   列を決め打ちにすると、集める項目が増えるたびに移行が要る。
--   同じ投稿（genre + item_key）は上書き（何度取り込んでも増殖しない）。
--   item_key は lib/benchmark.js の keyOf() と同じ規則（URL の揺れを吸収した鍵）。
--
-- ★ research_runs … 1回ぶんの「事実→分析→企画」の記録
--   facts（機械が出した事実）・analysis（②の結果）・plan（③の結果）を積んでいく。
--   途中で失敗しても error を残して追える（CLAUDE.md の「嘘を書かない」＝
--   出どころの分からない数字を混ぜないための土台）。
--
-- ★ 何度流しても壊れません。RLS は許可ルールを作らない＝サーバー専用（schema_v8 と同じ）。
-- ============================================================================

create table if not exists benchmark_items (
  id            uuid primary key default gen_random_uuid(),

  genre         text not null check (genre in ('ai', 'career')),
  platform      text not null check (platform in ('youtube', 'tiktok', 'x', 'instagram', 'threads')),

  -- lib/benchmark.js keyOf() と同じ鍵。同じ投稿の重複取り込みを防ぐ。
  item_key      text not null,
  url           text not null,

  -- lib/benchmark.js の型そのもの（checkAll を通って ratio が付いた後のもの）。
  record        jsonb not null,
  ratio         numeric,

  -- 確かめた日（JST）。「直近◯日」で絞り込むのに使う。
  collected_at  date not null,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (genre, item_key)
);

create index if not exists benchmark_items_genre_day_idx on benchmark_items (genre, collected_at desc);

alter table benchmark_items enable row level security;   -- 許可ルールを作らない＝サーバー専用

-- ----------------------------------------------------------------------------
-- ②分析・③企画の1回ぶんの記録
--
--   ★ facts は lib/benchmark-facts.js が機械で計算した事実（捏造の余地が無い）。
--     analysis・plan は、それを元に別の仕組み（LLM）が書いた結果を後から積む列。
--     ここではまだ作らない（別の担当）ので null のままでよい。
-- ----------------------------------------------------------------------------
create table if not exists research_runs (
  id           uuid primary key default gen_random_uuid(),

  genre        text not null check (genre in ('ai', 'career')),
  status       text not null default 'running' check (status in ('running', 'done', 'failed')),

  facts        jsonb,
  analysis     jsonb,
  plan         jsonb,
  error        text,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists research_runs_genre_day_idx on research_runs (genre, created_at desc);

alter table research_runs enable row level security;   -- 許可ルールを作らない＝サーバー専用
