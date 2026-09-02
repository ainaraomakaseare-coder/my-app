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
