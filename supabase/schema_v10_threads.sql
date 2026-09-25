-- ============================================================================
-- 投稿卓 NEO / v10 … Threads を投稿先に足す
--
-- ★ 何が変わるか
--   連携先・投稿先の SNS に 'threads' を足し、Threads 用の本文の列を足す。
--
-- ★ Threads は「叩いた瞬間に公開される」側
--   Instagram・X と同じく、API に下書きが無い。
--   だから publishing_networks() に入れ、運用アカウントで自動投稿を
--   許可していなければ順番待ちに入れない（手渡しにする）。
--   lib/handoff.js の PUBLISHING_NETWORKS と同じ中身にそろえること。
--
-- ★ 案件リンクについて
--   A8.net は Threads の投稿本文への掲載を控えるよう案内している
--   （iOS アプリでリンクが正しく開かないため）。lib/account-scope.js の
--   AFFILIATE_NETWORKS に入れないことで、案件リンクを含む投稿は出せなくしてある。
--
-- ★ 何度流しても壊れません。
-- ============================================================================

-- 1. SNS 名の縛りに threads を足す
--    ★ 縛りは create table の中で名前を付けずに作ったので、名前は Postgres 任せ。
--      既定なら <表>_network_check だが、違っていると古い縛りが残って
--      threads が永久に入らない。network 列を見ている check を名前によらず全部外す。
do $$
declare r record;
begin
  for r in
    select c.conrelid::regclass::text as tbl, c.conname
      from pg_constraint c
     where c.contype = 'c'
       and c.conrelid in ('sns_accounts'::regclass, 'post_targets'::regclass)
       and pg_get_constraintdef(c.oid) ilike '%network%'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

alter table sns_accounts drop constraint if exists sns_accounts_network_check;
alter table sns_accounts add constraint sns_accounts_network_check
  check (network in ('instagram','youtube','x','tiktok','threads'));

alter table post_targets drop constraint if exists post_targets_network_check;
alter table post_targets add constraint post_targets_network_check
  check (network in ('instagram','youtube','x','tiktok','threads'));

-- 2. 自動投稿してよい SNS の選択肢にも足す
alter table account_groups drop constraint if exists account_groups_auto_networks_check;
alter table account_groups add constraint account_groups_auto_networks_check
  check (auto_publish_networks <@ array['instagram','youtube','x','tiktok','threads']);

-- 3. 叩いた瞬間に公開される SNS。lib/handoff.js の PUBLISHING_NETWORKS と同じ。
create or replace function publishing_networks() returns text[]
language sql immutable as $$ select array['instagram','x','threads'] $$;

-- 4. Threads 用の本文（500文字まで。長さは api/posts.js で見る）
alter table posts add column if not exists th_text text default '';
