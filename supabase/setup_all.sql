-- ============================================================================
-- 投稿卓 NEO — これ1本で全部そろいます
--
--   ★ 使い方
--     このファイルの中身を「全部」コピーして、
--     Supabase の SQL Editor に貼って Run するだけです。
--     ファイル名を貼っても動きません。中身を貼ってください。
--
--   ★ 何度実行しても壊れません。
--     すでに作られているものは飛ばし、足りないものだけ足します。
--     いま動いている投稿・連携・予約は、そのまま残ります。
--
--   ★ 中身は下の5つを順番につないだものです。
--     個別に見たいときは supabase/ の各ファイルをどうぞ。
--
--       1. schema.sql
--       2. schema_v2_accounts.sql
--       3. schema_v3_groups.sql
--       4. schema_v4_handoff.sql
--       5. schema_v5_per_network.sql
-- ============================================================================


-- ############################################################################
-- ## schema.sql
-- ############################################################################

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


-- ############################################################################
-- ## schema_v2_accounts.sql
-- ############################################################################

-- ============================================================================
-- 投稿卓 NEO — 複数アカウント対応（追加分）
--
--   最初の schema.sql は「1つのSNSにつき1アカウント」を前提にしていた。
--   企画用とアフィリエイト用のように、同じSNSで複数のアカウントを
--   使い分けられるようにする。
--
--   ★ いま動いている Instagram の連携は壊さない。
--     既存のトークンは新しい表へ引き継ぎ、既存の予約投稿も
--     そのアカウントを指すように付け替える。
--
--   SQL Editor に貼って Run するだけ。何度実行しても壊れません。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. アカウントの表（sns_tokens の置き換え）
-- ----------------------------------------------------------------------------
create table if not exists sns_accounts (
  id            uuid primary key default gen_random_uuid(),
  network       text not null check (network in ('instagram','youtube','x','tiktok')),

  -- 自分で付ける呼び名。「企画用」「アフィリエイト用」など。画面に出る。
  label         text not null default '',
  -- SNS側から取れた名前。@hiroya_ainara など。
  account_name  text,

  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  meta          jsonb not null default '{}'::jsonb,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists sns_accounts_network_idx on sns_accounts (network);

alter table sns_accounts enable row level security;   -- 許可ルールを作らない＝サーバー専用

-- ----------------------------------------------------------------------------
-- 2. 投稿先を「SNS」から「アカウント」へ
-- ----------------------------------------------------------------------------
alter table post_targets
  add column if not exists account_id uuid references sns_accounts(id) on delete cascade;

-- 旧：1投稿につき1SNS1回まで（＝同じSNSの別アカウントに出せない）
alter table post_targets drop constraint if exists post_targets_post_id_network_key;

-- 新：1投稿につき1アカウント1回まで（＝同じSNSでもアカウントが違えば別扱い）
create unique index if not exists post_targets_post_account_uidx
  on post_targets (post_id, account_id) nulls not distinct;

-- ----------------------------------------------------------------------------
-- 3. いま繋がっている連携を引き継ぐ（Instagram を切らさないため）
-- ----------------------------------------------------------------------------
insert into sns_accounts (network, label, account_name, access_token, refresh_token, expires_at, meta)
select t.network,
       coalesce(t.account_name, t.network),
       t.account_name, t.access_token, t.refresh_token, t.expires_at, t.meta
  from sns_tokens t
 where not exists (select 1 from sns_accounts a where a.network = t.network);

-- 既存の予約投稿を、引き継いだアカウントに向ける
update post_targets t
   set account_id = a.id
  from sns_accounts a
 where t.account_id is null
   and a.network = t.network;

-- ----------------------------------------------------------------------------
-- 4. 仕事を取る関数を、アカウント対応に差し替える
--    やっていることは前と同じ。取得と記録が1文で起きるので二重投稿しない。
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
       and t.account_id is not null          -- 連携の切れた行は拾わない
       and p.scheduled_at is not null
       and p.scheduled_at <= now()
       and p.status in ('scheduled','processing','partial','failed')
       and (t.next_attempt_at is null or t.next_attempt_at <= now())
       and t.attempt < 3
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


-- ############################################################################
-- ## schema_v3_groups.sql
-- ############################################################################

-- ============================================================================
-- 投稿卓 NEO — 運用アカウント（追加分）
--
--   v2 で「同じSNSに複数アカウント」までは表現できた。
--   足りないのは「この投稿はどの運用ラインのものか」という所属。
--   いまは post_targets.account_id 経由でしかアカウントに繋がらないので、
--   1つの投稿が企画用とアフィリ用の両方に向く状態が作れてしまう。
--
--   ★ 画面の名前表示（「Instagram（アフィリ用）」）は"気づきやすくする"対策。
--     ここでやるのは"作れなくする"対策。二重投稿を claim_due_targets で
--     物理的に防いだのと同じ考え方で、DBに任せる。
--
--   ★ いま動いているものは壊さない。
--     列は後から足すだけ。既存の行は既定の運用アカウントへ寄せる。
--     not null にはしない（アプリが group_id を送り始める前に落とさないため）。
--
--   SQL Editor に貼って Run するだけ。何度実行しても壊れません。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 運用アカウント（＝運用ライン）の表
--
--    sns_accounts より1段上。「ひろや」と「転職キュレーション」を分ける。
--    validation_profile は投稿文の点検規則（lib/draft-rules.js）を選ぶ。
--      curator  … 口コミを集めて紹介する立場。一人称の体験は嘘になるので禁止
--      personal … 本人の実践記録。一人称で書くのが正しい
-- ----------------------------------------------------------------------------
create table if not exists account_groups (
  id                 uuid primary key default gen_random_uuid(),
  label              text not null,
  validation_profile text not null default 'curator'
                     check (validation_profile in ('curator','personal')),
  created_at         timestamptz not null default now()
);

alter table account_groups enable row level security;   -- 許可ルールを作らない＝サーバー専用

-- ----------------------------------------------------------------------------
-- 2. 所属を足す
-- ----------------------------------------------------------------------------
alter table sns_accounts add column if not exists group_id uuid references account_groups(id);
alter table posts        add column if not exists group_id uuid references account_groups(id);

-- 案件リンクを含むか。PR表記の要否と、掲載できる媒体の判定に使う。
alter table posts add column if not exists has_affiliate_link boolean not null default false;

create index if not exists sns_accounts_group_idx on sns_accounts (group_id);
create index if not exists posts_group_idx        on posts (group_id);

-- ----------------------------------------------------------------------------
-- 3. いまある行を既定の運用アカウントへ寄せる
--
--    まだ1つも無いときだけ作る。2つ目以降は画面から足す。
-- ----------------------------------------------------------------------------
insert into account_groups (label, validation_profile)
select 'ひろや｜AI初心者30日30アプリ', 'personal'
 where not exists (select 1 from account_groups);

-- 運用アカウントがちょうど1つのときだけ、宙に浮いた行を寄せる。
-- 2つ以上あるときに寄せると、どちらへ入れるべきか決められないため触らない。
do $$
declare v_only uuid;
begin
  select id into v_only from account_groups limit 2;
  if (select count(*) from account_groups) = 1 then
    update sns_accounts set group_id = v_only where group_id is null;
    update posts        set group_id = v_only where group_id is null;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 4. ★ 混ざらないようにする心臓部
--
--    post_targets に行を作る／付け替えるたびに、投稿とアカウントの
--    運用ラインが一致しているかを見る。食い違っていたら書き込ませない。
--
--    あわせて、案件リンクを含む投稿が A8.net の掲載対象外の媒体
--    （X など）へ向かうのも止める。運用の好みではなく規約なので、
--    アプリ側の判断に任せずここに置く。
-- ----------------------------------------------------------------------------

-- A8.net で広告を載せられる媒体。lib/account-scope.js の AFFILIATE_NETWORKS と同じ。
create or replace function affiliate_networks() returns text[]
language sql immutable as $$ select array['instagram','youtube','tiktok','pinterest'] $$;

create or replace function assert_target_matches_group() returns trigger
language plpgsql as $$
declare
  v_post_group uuid;
  v_affiliate  boolean;
  v_acct_group uuid;
  v_network    text;
  v_label      text;
begin
  select p.group_id, coalesce(p.has_affiliate_link, false)
    into v_post_group, v_affiliate
    from posts p where p.id = new.post_id;

  select a.group_id, a.network, coalesce(nullif(a.label, ''), a.account_name, a.network)
    into v_acct_group, v_network, v_label
    from sns_accounts a where a.id = new.account_id;

  -- どちらかが未設定の間は止めない（列を足した直後や、旧データのため）
  if v_post_group is not null and v_acct_group is not null and v_post_group <> v_acct_group then
    raise exception '「%」は別の運用アカウントの連携先です。投稿先を選び直してください', v_label
      using errcode = 'check_violation';
  end if;

  if v_affiliate and v_network is not null and not (v_network = any (affiliate_networks())) then
    raise exception '% は A8.net の掲載対象外です。案件リンクを含む投稿は出せません', v_network
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists post_targets_group_guard on post_targets;
create trigger post_targets_group_guard
  before insert or update of post_id, account_id on post_targets
  for each row execute function assert_target_matches_group();

-- ----------------------------------------------------------------------------
-- 5. 投稿の側を書き換えたときも見る
--
--    投稿先を作ったあとで、投稿の運用アカウントを変える／案件リンクありに
--    切り替える、という道がある。post_targets の引き金だけでは素通りするので、
--    posts の更新でも既存の投稿先と矛盾しないか確かめる。
-- ----------------------------------------------------------------------------
create or replace function assert_post_matches_targets() returns trigger
language plpgsql as $$
declare
  v_bad text;
begin
  if new.group_id is not null then
    select coalesce(nullif(a.label, ''), a.account_name, a.network) into v_bad
      from post_targets t
      join sns_accounts a on a.id = t.account_id
     where t.post_id = new.id
       and a.group_id is not null
       and a.group_id <> new.group_id
     limit 1;
    if v_bad is not null then
      raise exception '投稿先に別の運用アカウント（%）が残っています。先に外してください', v_bad
        using errcode = 'check_violation';
    end if;
  end if;

  if coalesce(new.has_affiliate_link, false) then
    select a.network into v_bad
      from post_targets t
      join sns_accounts a on a.id = t.account_id
     where t.post_id = new.id
       and not (a.network = any (affiliate_networks()))
     limit 1;
    if v_bad is not null then
      raise exception '投稿先に % が残っています。A8.net の掲載対象外なので先に外してください', v_bad
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists posts_group_guard on posts;
create trigger posts_group_guard
  before update of group_id, has_affiliate_link on posts
  for each row execute function assert_post_matches_targets();


-- ############################################################################
-- ## schema_v4_handoff.sql
-- ############################################################################

-- ============================================================================
-- 投稿卓 NEO — 受け渡し（投稿手前で止める）
--
--   ★ SNS は2種類ある。
--     ・下書きで止められるもの … TikTok（アプリの下書きに届く）
--                                YouTube（非公開で上がる）
--     ・叩いた瞬間に公開されるもの … Instagram（media_publish）
--                                    X（/2/tweets）
--
--     後者には「下書き」という着地点が存在しない。だから
--     「投稿手前で止める」ための唯一の方法は、APIを呼ばないこと。
--     これは運用の心がけではなく、仕組みで止めるべきこと。
--
--   ★ ただし、いま動いている運用（ひろや側）は自動投稿してよい。
--     止めるかどうかは運用アカウントごとに決める。
--
--   ★ ここで足した auto_publish（真偽値ひとつ）は、schema_v5_per_network.sql で
--     「SNSごとの配列」に置き換わります。Instagram だけ許して X は手渡し、が
--     言えなかったため。v4 → v5 の順に流せば自動で引き継がれます。
--
--   SQL Editor に貼って Run するだけ。何度実行しても壊れません。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 運用アカウントごとに「自動投稿してよいか」を持つ
--
--    ★ 既定値の付け替えが要点。
--      いまある行には true が入る（今までどおり動く）。
--      そのあと既定値を false に変えるので、これから作る運用アカウントは
--      自動投稿しない側から始まる。安全な方を初期値にしておく。
-- ----------------------------------------------------------------------------
alter table account_groups add column if not exists auto_publish boolean not null default true;
alter table account_groups alter column auto_publish set default false;

comment on column account_groups.auto_publish is
  'false のとき、公開まで行ってしまうSNS（Instagram/X）へは API を出さない。素材を手元に渡す。';

-- ----------------------------------------------------------------------------
-- 2. 投稿に、元になった文案そのものを残す
--
--    ★ これが無いと X 用の画像2枚を作り直せない。
--      投稿の表にあるのは出来上がった本文だけで、動画に描く6行（問いと答え）は
--      どこにも残らない。あとから「空欄の画像」と「答えの画像」を書き出すには
--      構造のまま持っておく必要がある。動画の作り直しにも使える。
-- ----------------------------------------------------------------------------
alter table posts add column if not exists draft jsonb;

comment on column posts.draft is
  '生成した文案そのもの（kicker/title/rows/各SNSの本文）。画像と動画の作り直しに使う。';

-- ----------------------------------------------------------------------------
-- 3. 投稿先の状態に「手渡し」を足す
--
--    manual … これは手で出す。自動処理は絶対に触らない
--    handed … 素材を受け取った。あとは本人がアプリで投稿する
--
--    どちらも 'queued' ではないので、claim_due_targets は拾わない。
--    ＝ワーカーが動いても、この行が投稿されることはない。
-- ----------------------------------------------------------------------------
alter table post_targets drop constraint if exists post_targets_status_check;
alter table post_targets add constraint post_targets_status_check
  check (status in ('queued','processing','success','failed','skipped','manual','handed'));

-- ----------------------------------------------------------------------------
-- 4. 投稿全体の状態を数え直すとき、手渡しの行は勘定に入れない
--
--    ★ 入れたままだと、下書きを保存しただけで「一部成功」になってしまう。
--      （成功でも失敗でも処理中でもない行が残るため）
--      手渡しは自動処理の埒外なので、母数から外すのが正しい。
--      全部が手渡しなら数える対象が無くなり、投稿は下書きのまま残る。
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
    from post_targets
   where post_id = v_post
     and status not in ('manual','handed');   -- ★ 手渡しは数えない

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

-- ----------------------------------------------------------------------------
-- 5. ★ 心臓部。自動投稿しない運用アカウントでは、公開系SNSを順番待ちにさせない
--
--    アプリ側でも同じことを見ているが、ここに置く理由は
--    「二重投稿を claim_due_targets で物理的に防いだ」のと同じ。
--    アプリの書き換えや直接のSQLで抜けられては意味がない。
--
--    順番待ち（queued）にさえならなければ、claim_due_targets は拾えない。
--    ＝ Instagram と X に対して API が出ることは起こり得ない。
-- ----------------------------------------------------------------------------

-- 叩いた瞬間に公開されるSNS。lib/handoff.js の PUBLISHING_NETWORKS と同じ。
create or replace function publishing_networks() returns text[]
language sql immutable as $$ select array['instagram','x'] $$;

create or replace function assert_no_auto_publish() returns trigger
language plpgsql as $$
declare
  v_auto boolean;
begin
  if new.status <> 'queued' then
    return new;                      -- 手渡しや処理済みの行は関係ない
  end if;
  if not (new.network = any (publishing_networks())) then
    return new;                      -- 下書きで止まるSNSは通してよい
  end if;

  select g.auto_publish into v_auto
    from posts p
    join account_groups g on g.id = p.group_id
   where p.id = new.post_id;

  -- 運用アカウントが決まっていないときは、いままでどおり通す
  if v_auto is null or v_auto then
    return new;
  end if;

  raise exception
    '% は API で出すと即公開になります。この運用アカウントは自動投稿しない設定なので、手渡し（manual）にしてください',
    new.network using errcode = 'check_violation';
end $$;

drop trigger if exists post_targets_auto_publish_guard on post_targets;
create trigger post_targets_auto_publish_guard
  before insert or update of status, network, post_id on post_targets
  for each row execute function assert_no_auto_publish();

-- ----------------------------------------------------------------------------
-- 6. 運用アカウントの設定を変えたときも見る
--
--    自動投稿を止める設定に変えたのに、すでに順番待ちの Instagram が
--    残っていては意味がない。先に片付けてもらう。
-- ----------------------------------------------------------------------------
create or replace function assert_group_has_no_queued_publish() returns trigger
language plpgsql as $$
declare v_bad text;
begin
  if new.auto_publish then
    return new;
  end if;

  select t.network into v_bad
    from post_targets t
    join posts p on p.id = t.post_id
   where p.group_id = new.id
     and t.status = 'queued'
     and t.network = any (publishing_networks())
   limit 1;

  if v_bad is not null then
    raise exception '% の投稿がまだ順番待ちです。先に取り消してから、自動投稿を止めてください', v_bad
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists account_groups_auto_publish_guard on account_groups;
create trigger account_groups_auto_publish_guard
  before update of auto_publish on account_groups
  for each row execute function assert_group_has_no_queued_publish();


-- ############################################################################
-- ## schema_v5_per_network.sql
-- ############################################################################

-- ============================================================================
-- 投稿卓 NEO — 自動投稿を「SNSごと」に決められるようにする
--
--   v4 では運用アカウントごとに真偽値ひとつ（auto_publish）で決めていた。
--   だが Instagram と X は、同じ「叩けば公開される」でも事情がまるで違う。
--
--     Instagram … 無料。案件リンクを載せてよい（A8.net の掲載対象）
--     X         … 1投稿ごとに課金される。案件リンクは載せられない
--
--   まとめて切り替えると、Instagram を自動にした瞬間に X も自動になる。
--   片方だけ許す、が言えなければ設定として使えないので、配列で持つ。
--
--   ★ いま動いているものは壊さない。
--     既存の行には今までどおりの値（両方許可）が入る。
--     これから作る運用アカウントは、何も許可しない側から始まる。
--
--   SQL Editor に貼って Run するだけ。何度実行しても壊れません。
--   v4 を流していても、流していなくても、正しい状態になります。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. v4 の見張りを先に外す
--
--    ★ これを忘れると詰まる。
--      v4 の引き金は「before update of auto_publish」と書いてあるので、
--      その列に依存している。先に外さないと列を畳めず、畳めないと
--      引き継ぎのブロックごと巻き戻って、設定が黙って元に戻る。
--      （最初これで、false にしていた運用アカウントが両方許可に戻った）
-- ----------------------------------------------------------------------------
drop trigger if exists account_groups_auto_publish_guard on account_groups;
drop trigger if exists post_targets_auto_publish_guard on post_targets;

-- ----------------------------------------------------------------------------
-- 1. 「このSNSへは自動で投稿してよい」を、SNS名の配列で持つ
--
--    ★ v4 と同じ、既定値の付け替え。
--      いまある行には array['instagram','x'] が入る（v4 以前と同じ動き）。
--      そのあと既定値を空にするので、新しい運用アカウントは何も許可しない。
-- ----------------------------------------------------------------------------
alter table account_groups add column if not exists auto_publish_networks text[]
  not null default array['instagram','x'];
alter table account_groups alter column auto_publish_networks set default '{}';

comment on column account_groups.auto_publish_networks is
  '自動で投稿してよいSNS。ここに無い公開系SNS（Instagram/X）へは API を出さず、素材を手元に渡す。';

-- ----------------------------------------------------------------------------
-- 2. v4 の真偽値からの引き継ぎ
--
--    v4 を流していた場合だけ動く。false だった運用アカウントは
--    「何も許可しない」に移して、列そのものを畳む。
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'account_groups'
       and column_name = 'auto_publish'
  ) then
    execute $q$ update account_groups
                   set auto_publish_networks = '{}'
                 where auto_publish is not true $q$;
    execute 'alter table account_groups drop column auto_publish';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 3. ★ 心臓部。許していないSNSは、順番待ちにさせない
--
--    順番待ち（queued）にさえならなければ claim_due_targets は拾えない。
--    ＝ そのSNSに対して API が出ることは起こり得ない。
--    二重投稿を SKIP LOCKED で物理的に防いだのと同じ考え方で、DBに置く。
-- ----------------------------------------------------------------------------

-- 叩いた瞬間に公開されるSNS。lib/handoff.js の PUBLISHING_NETWORKS と同じ。
create or replace function publishing_networks() returns text[]
language sql immutable as $$ select array['instagram','x'] $$;

create or replace function assert_no_auto_publish() returns trigger
language plpgsql as $$
declare
  v_allowed text[];
  v_found   boolean;
begin
  if new.status <> 'queued' then
    return new;                      -- 手渡しや処理済みの行は関係ない
  end if;
  if not (new.network = any (publishing_networks())) then
    return new;                      -- 下書きで止まるSNS（TikTok/YouTube）は通してよい
  end if;

  select g.auto_publish_networks, true into v_allowed, v_found
    from posts p
    join account_groups g on g.id = p.group_id
   where p.id = new.post_id;

  -- 運用アカウントが決まっていないときは、いままでどおり通す
  if not coalesce(v_found, false) then
    return new;
  end if;
  if new.network = any (coalesce(v_allowed, '{}')) then
    return new;
  end if;

  raise exception
    '% は API で出すと即公開になります。この運用アカウントでは自動投稿を許可していないので、手渡し（manual）にしてください',
    new.network using errcode = 'check_violation';
end $$;

drop trigger if exists post_targets_auto_publish_guard on post_targets;
create trigger post_targets_auto_publish_guard
  before insert or update of status, network, post_id on post_targets
  for each row execute function assert_no_auto_publish();

-- ----------------------------------------------------------------------------
-- 4. 許可を外すときも見る
--
--    許可を外したのに、そのSNSの投稿がまだ順番待ちで残っていては意味がない。
--    先に片付けてもらう。
-- ----------------------------------------------------------------------------
create or replace function assert_group_has_no_queued_publish() returns trigger
language plpgsql as $$
declare v_bad text;
begin
  select t.network into v_bad
    from post_targets t
    join posts p on p.id = t.post_id
   where p.group_id = new.id
     and t.status = 'queued'
     and t.network = any (publishing_networks())
     and not (t.network = any (coalesce(new.auto_publish_networks, '{}')))
   limit 1;

  if v_bad is not null then
    raise exception '% の投稿がまだ順番待ちです。先に取り消してから、許可を外してください', v_bad
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists account_groups_auto_publish_guard on account_groups;
create trigger account_groups_auto_publish_guard
  before update of auto_publish_networks on account_groups
  for each row execute function assert_group_has_no_queued_publish();

-- ----------------------------------------------------------------------------
-- 5. 知らないSNS名を入れさせない
--
--    'instgram' のような打ち間違いが入ると、許可したつもりで許可されていない
--    （あるいはその逆の）状態になる。名前の集合はここで縛る。
-- ----------------------------------------------------------------------------
alter table account_groups drop constraint if exists account_groups_auto_networks_check;
alter table account_groups add constraint account_groups_auto_networks_check
  check (auto_publish_networks <@ array['instagram','youtube','x','tiktok']);
