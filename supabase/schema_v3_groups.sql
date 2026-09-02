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
