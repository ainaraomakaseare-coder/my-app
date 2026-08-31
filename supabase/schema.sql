-- ============================================================================
-- 投稿卓 NEO — Supabase スキーマ
--   Supabase の SQL Editor に、このファイルを丸ごと貼り付けて Run するだけ。
--   何度実行しても壊れないように書いてあります（作り直したくなったら再実行可）。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 投稿そのもの
-- ----------------------------------------------------------------------------
create table if not exists posts (
  id             uuid primary key default gen_random_uuid(),
  title          text not null default '',        -- 管理用のタイトル（自分が見分けるため）
  body_common    text default '',                 -- 共通本文
  ig_caption     text default '',                 -- Instagram 用本文
  yt_title       text default '',                 -- YouTube 用タイトル
  yt_description text default '',                 -- YouTube 用説明文
  x_text         text default '',                 -- X 用本文
  tt_caption     text default '',                 -- TikTok 用本文
  media_path     text,                            -- Storage 上の場所（例 '2026/09/ab12.mp4'）
  media_kind     text check (media_kind in ('video','image')),
  media_bytes    bigint,

  -- ★ timestamptz は PostgreSQL が必ず UTC で保存する型。
  --    「日本時間 9/1 20:00」→ '2026-09-01T11:00:00Z' として入る。
  --    これを使うことがタイムゾーンずれ防止の答え。timestamp（tzなし）は使わない。
  scheduled_at   timestamptz,

  status         text not null default 'draft'
                 check (status in ('draft','scheduled','processing','done','partial','failed')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2. SNS ごとの状態（1投稿 × 投稿先の数だけ行ができる）
--    「一部成功」と「失敗したSNSだけ再実行」は、この表が別れていないと表現できない。
-- ----------------------------------------------------------------------------
create table if not exists post_targets (
  id              uuid primary key default gen_random_uuid(),
  post_id         uuid not null references posts(id) on delete cascade,
  network         text not null check (network in ('instagram','youtube','x','tiktok')),
  status          text not null default 'queued'
                  check (status in ('queued','processing','success','failed','skipped')),

  attempt         int  not null default 0,   -- 何回試したか（3回で自動再試行を止める）
  next_attempt_at timestamptz,               -- 次に試してよい時刻（再試行の待ち時間）
  claimed_at      timestamptz,               -- 処理を取った時刻（固まった行の検出用）

  -- ★ 途中で落ちても作り直さないための記録。
  --    Instagram のコンテナID / YouTube の videoId / TikTok の publish_id など。
  external_id     text,
  stage           text,                      -- 'container_created' など、どこまで進んだか
  permalink       text,                      -- 出来上がった投稿のURL
  last_error      text,
  posted_at       timestamptz,

  -- ★ 二重投稿を物理的に防ぐ土台。同じ投稿×同じSNSの行は2つ作れない。
  unique (post_id, network)
);

create index if not exists post_targets_due_idx
  on post_targets (status, next_attempt_at);

-- ----------------------------------------------------------------------------
-- 3. 履歴（いつ何が起きたか。画面の「履歴」はこれを読む）
-- ----------------------------------------------------------------------------
create table if not exists post_events (
  id      bigserial primary key,
  post_id uuid references posts(id) on delete cascade,
  network text,
  at      timestamptz not null default now(),
  event   text not null,
  detail  text
);

create index if not exists post_events_post_idx on post_events (post_id, at desc);

-- ----------------------------------------------------------------------------
-- 4. SNS のトークン置き場
--    OAuth のトークンは自動で更新されるので、コードから書き換えられる場所に置く。
--    RLS を有効にしてポリシーを1つも作らない ＝ サービスロールキーを持つ
--    サーバーからしか読めない、が成立する（一番きつい設定）。
-- ----------------------------------------------------------------------------
create table if not exists sns_tokens (
  network       text primary key check (network in ('instagram','youtube','x','tiktok')),
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  account_name  text,                        -- @ユーザー名など、画面に出す用
  meta          jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 5. 鍵をかける（全テーブル）
--    ポリシーを作らないので、ブラウザから anon キーで触っても1行も見えない。
--    サーバー（Vercel）がサービスロールキーで触るときだけ通る。
-- ----------------------------------------------------------------------------
alter table posts        enable row level security;
alter table post_targets enable row level security;
alter table post_events  enable row level security;
alter table sns_tokens   enable row level security;

-- ----------------------------------------------------------------------------
-- 6. 投稿全体のステータスを、SNSごとの状態から自動で計算する
--    全部成功→done ／ 成功と失敗が混在→partial（一部成功） ／ 全部失敗→failed
--    アプリ側で計算すると書き忘れ・競合が起きるので、DBに任せる。
-- ----------------------------------------------------------------------------
create or replace function recalc_post_status() returns trigger
language plpgsql as $$
declare
  v_post uuid := coalesce(new.post_id, old.post_id);
  n_total int; n_success int; n_failed int; n_open int;
begin
  select count(*),
         count(*) filter (where status = 'success'),
         count(*) filter (where status = 'failed'),
         count(*) filter (where status in ('queued','processing'))
    into n_total, n_success, n_failed, n_open
    from post_targets where post_id = v_post;

  if n_total = 0 then
    return null;
  end if;

  update posts set
    status = case
      when n_open > 0 and (n_success > 0 or n_failed > 0) then 'processing'
      when n_open > 0                                     then posts.status
      when n_success = n_total                            then 'done'
      when n_failed  = n_total                            then 'failed'
      else 'partial'
    end,
    updated_at = now()
  where id = v_post;

  return null;
end $$;

drop trigger if exists post_targets_rollup on post_targets;
create trigger post_targets_rollup
  after insert or update of status or delete on post_targets
  for each row execute function recalc_post_status();

-- ----------------------------------------------------------------------------
-- 7. ★ 二重投稿を防ぐ心臓部
--    「時間になった仕事を取ってくる」と「取ったことを記録する」を1文でやる。
--    2つの処理が同時に来ても、PostgreSQL が1行ずつ順番に処理するので、
--    勝てるのは必ず片方だけ。SKIP LOCKED で、負けた側は待たずに次へ進む。
-- ----------------------------------------------------------------------------
create or replace function claim_due_targets(p_limit int default 3)
returns setof post_targets
language sql
set search_path = public
as $$
  with due as (
    select t.id
      from post_targets t
      join posts p on p.id = t.post_id
     where t.status = 'queued'
       and p.scheduled_at is not null
       and p.scheduled_at <= now()          -- 両辺 UTC なので比較が正しい
       and p.status in ('scheduled','processing','partial','failed')
       and (t.next_attempt_at is null or t.next_attempt_at <= now())
       and t.attempt < 3                    -- 3回失敗したら自動では触らない
     order by p.scheduled_at asc
     limit p_limit
     for update of t skip locked
  )
  update post_targets t
     set status     = 'processing',
         claimed_at = now(),
         attempt    = t.attempt + 1
    from due
   where t.id = due.id
  returning t.*;
$$;

-- ----------------------------------------------------------------------------
-- 8. 固まった行を助け出す
--    processing のまま長時間動かない ＝ 処理の途中で落ちた、とみなして queued に戻す。
--    attempt は増えたままなので、無限には繰り返さない。
-- ----------------------------------------------------------------------------
create or replace function requeue_stuck_targets(p_minutes int default 10)
returns int
language sql
set search_path = public
as $$
  with fixed as (
    update post_targets
       set status = 'queued', next_attempt_at = now()
     where status = 'processing'
       and claimed_at < now() - make_interval(mins => p_minutes)
    returning 1
  )
  select count(*)::int from fixed;
$$;
