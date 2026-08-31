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
