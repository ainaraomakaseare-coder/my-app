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
