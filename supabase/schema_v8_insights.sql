-- ============================================================================
-- 投稿卓 NEO / v8 … 数字を毎日ためて、伸びを見えるようにする
--
-- ★ なぜ「ためる」必要があるのか
--   どのSNSのAPIも「いまのフォロワー数」しか返さない。履歴はくれない。
--   毎日こちらで書き留めておかないと、あとから「伸びたのか」は分からない。
--   始めた日より前のことは、永久に分からない。だから早く始めるほどよい。
--
-- ★ 1日1行にする
--   同じ日に2回取り込んでも行が増えないよう、日付で一意にする。
--   取り込みは何度やり直しても壊れない（後の値で上書きされる）。
--   これは worker の「2回実行しても二度送らない」と同じ考え方。
--
-- ★ 数字は jsonb に入れる
--   SNSごとに取れるものが違い、権限が変わると増えたり減ったりする。
--   列を決め打ちにすると、そのたびに移行ファイルが要る。
--   「フォロワー」のように全SNSで共通のものだけ列にして、残りは jsonb。
--
-- ★ 取れなかったことも記録する
--   ok=false の行を残す。空欄と「取りに行ったが断られた」は別物で、
--   後者は権限を直せば取れる。区別できないと、原因を追えない。
--
-- ★ 何度流しても壊れません。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. アカウントの数字（フォロワーなど）
-- ----------------------------------------------------------------------------
create table if not exists account_metrics (
  id          bigserial primary key,
  account_id  uuid not null references sns_accounts(id) on delete cascade,

  -- ★ 日本時間の日付。UTCで持つと、21時台の取り込みが前日扱いになる。
  taken_on    date not null,
  taken_at    timestamptz not null default now(),

  ok          boolean not null default true,
  error       text,

  followers   int,
  views       bigint,
  likes       bigint,
  posts       int,

  extra       jsonb not null default '{}'::jsonb,

  unique (account_id, taken_on)
);

create index if not exists account_metrics_day_idx on account_metrics (taken_on desc);

alter table account_metrics enable row level security;   -- 許可ルールを作らない＝サーバー専用

-- ----------------------------------------------------------------------------
-- 2. 投稿ごとの数字
--
--    ★ post_targets にぶら下げる。「どの投稿の、どのSNS分か」が1行で決まる。
--      posts にぶら下げると、Instagram と YouTube の再生数が混ざる。
-- ----------------------------------------------------------------------------
create table if not exists target_metrics (
  id              bigserial primary key,
  post_target_id  uuid not null references post_targets(id) on delete cascade,

  taken_on        date not null,
  taken_at        timestamptz not null default now(),

  ok              boolean not null default true,
  error           text,

  views           bigint,
  likes           bigint,
  comments        int,
  shares          int,

  extra           jsonb not null default '{}'::jsonb,

  unique (post_target_id, taken_on)
);

create index if not exists target_metrics_day_idx on target_metrics (taken_on desc);

alter table target_metrics enable row level security;

-- ----------------------------------------------------------------------------
-- 3. TikTok の動画（アプリの投稿とは結びつかないもの）
--
--    ★ なぜ別の表なのか
--      TikTok は下書きに送って、本人が後から手で公開する。
--      アプリが持っているのは publish_id（下書きの整理番号）だけで、
--      公開された動画のIDは返ってこない。つまり
--      「アプリのこの投稿＝TikTokのこの動画」が言えない。
--
--      無理に時刻や本文で推測して結びつけると、間違った組み合わせで
--      「この台本が伸びた」と読んでしまう。それは数字を見る意味を壊す。
--      だから結びつけず、TikTok側の一覧としてそのまま置く。
-- ----------------------------------------------------------------------------
create table if not exists tiktok_videos (
  id           bigserial primary key,
  account_id   uuid not null references sns_accounts(id) on delete cascade,
  video_id     text not null,

  taken_on     date not null,
  taken_at     timestamptz not null default now(),

  title        text,
  posted_at    timestamptz,

  views        bigint,
  likes        bigint,
  comments     int,
  shares       int,

  unique (account_id, video_id, taken_on)
);

create index if not exists tiktok_videos_day_idx on tiktok_videos (account_id, taken_on desc);

alter table tiktok_videos enable row level security;

-- ----------------------------------------------------------------------------
-- 4. 日本時間の「今日」
--
--    ★ 取り込みは毎晩1回。サーバーはUTCで動くので、
--      JSTの日付を出す口をDB側にも用意しておく。
--      呼ぶ側がうっかりUTCの日付を使うと、23時台の取り込みだけ翌日になる。
-- ----------------------------------------------------------------------------
create or replace function jst_today()
returns date language sql stable as $$
  select (now() at time zone 'Asia/Tokyo')::date;
$$;
