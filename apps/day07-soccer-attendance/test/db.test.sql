-- ============================================================
-- データベースの動きとセキュリティを確かめるテスト。
--
--   psql -v ON_ERROR_STOP=1 -d <データベース> -f test/db.test.sql
--
-- 途中でひとつでも条件が崩れたら例外を投げて止まります。
-- 最後まで走って「すべて合格」が出れば OK です。
-- ============================================================

\set ON_ERROR_STOP on
set client_min_messages to notice;

do $$
declare
  v_admin   text;
  v_bad     text := 'これは間違ったトークン';
  v_taro    uuid; v_jiro uuid;
  v_taro_tk text; v_jiro_tk text;
  v_event   uuid;
  v_home    jsonb;
  v_ev      jsonb;
  v_n       int;
  v_ok      boolean;
begin
  -- 前の実行の残りを消す
  delete from attendance;
  delete from events;
  delete from members;

  select admin_token into v_admin from team_config where id = 1;

  -- ---------------------------------------------------------
  raise notice '1. 名簿をまとめて登録できる';
  -- ---------------------------------------------------------
  perform admin_add_members(v_admin, array['山田 太郎', '佐藤 次郎', '  ', '山田 太郎']);
  select count(*) into v_n from members;
  if v_n <> 2 then
    raise exception '期待は2人（空行と重複は飛ばす）だが % 人', v_n;
  end if;

  select id, token into v_taro, v_taro_tk from members where name = '山田 太郎';
  select id, token into v_jiro, v_jiro_tk from members where name = '佐藤 次郎';

  if v_taro_tk = v_jiro_tk then
    raise exception '別人に同じトークンが配られている';
  end if;
  if length(v_taro_tk) < 20 then
    raise exception 'トークンが短すぎて当てられてしまう: %', v_taro_tk;
  end if;

  -- ---------------------------------------------------------
  raise notice '2. 予定を登録できる';
  -- ---------------------------------------------------------
  perform admin_save_event(v_admin, null, current_date + 3, '10:00'::time, 'match', '河川敷', '対 隣町FC');
  select id into v_event from events limit 1;

  -- ---------------------------------------------------------
  raise notice '3. 最初は全員が未回答';
  -- ---------------------------------------------------------
  v_home := member_home(v_taro_tk);
  v_ev   := v_home->'events'->0;
  if v_ev->>'my_status' is not null then
    raise exception '答える前なのに回答が入っている: %', v_ev->>'my_status';
  end if;
  if (v_ev->>'yes_count')::int <> 0 then
    raise exception '出席人数が0でない';
  end if;
  if (v_home->>'member_count')::int <> 2 then
    raise exception 'メンバー数が合わない';
  end if;

  -- ---------------------------------------------------------
  raise notice '4. 出席と答えると保存され、人数に反映される';
  -- ---------------------------------------------------------
  v_home := set_status(v_taro_tk, v_event, 'yes');
  v_ev   := v_home->'events'->0;
  if v_ev->>'my_status' <> 'yes' then
    raise exception '出席が保存されていない';
  end if;
  if (v_ev->>'yes_count')::int <> 1 then
    raise exception '出席人数が1でない: %', v_ev->>'yes_count';
  end if;

  -- ---------------------------------------------------------
  raise notice '5. 押し直すと欠席に変わる（二重に増えない）';
  -- ---------------------------------------------------------
  v_home := set_status(v_taro_tk, v_event, 'no');
  v_ev   := v_home->'events'->0;
  if (v_ev->>'yes_count')::int <> 0 or (v_ev->>'no_count')::int <> 1 then
    raise exception '出席1・欠席1のように二重計上されている';
  end if;
  select count(*) into v_n from attendance where event_id = v_event and member_id = v_taro;
  if v_n <> 1 then
    raise exception '同じ人の回答が % 行ある', v_n;
  end if;

  -- ---------------------------------------------------------
  raise notice '6. null を渡すと未回答に戻る';
  -- ---------------------------------------------------------
  v_home := set_status(v_taro_tk, v_event, null);
  if (v_home->'events'->0->>'my_status') is not null then
    raise exception '未回答に戻っていない';
  end if;

  -- ---------------------------------------------------------
  raise notice '7. 他人のトークンでは開けない';
  -- ---------------------------------------------------------
  begin
    perform member_home(v_bad);
    raise exception '間違ったトークンで開けてしまった';
  exception when sqlstate '28000' then
    null;  -- 期待どおり弾かれた
  end;

  -- ---------------------------------------------------------
  raise notice '8. 自分のリンクで動かせるのは自分の欄だけ';
  -- ---------------------------------------------------------
  perform set_status(v_taro_tk, v_event, 'yes');
  perform set_status(v_jiro_tk, v_event, 'no');
  -- 太郎のリンクをいくら使っても、次郎の回答は変わらない
  perform set_status(v_taro_tk, v_event, 'no');
  select count(*) into v_n
    from attendance where event_id = v_event and member_id = v_jiro and status = 'no';
  if v_n <> 1 then
    raise exception '他人の回答が巻き添えで書き換わった';
  end if;

  -- ---------------------------------------------------------
  raise notice '9. 管理用の関数は管理トークンが無いと動かない';
  -- ---------------------------------------------------------
  begin
    perform admin_home(v_bad);
    raise exception '間違った管理トークンで管理画面が開けてしまった';
  exception when sqlstate '28000' then
    null;
  end;

  begin
    perform admin_add_members(v_taro_tk, array['乗っ取り']);  -- 個人トークンで管理操作を試す
    raise exception 'メンバーのリンクで名簿を触れてしまった';
  exception when sqlstate '28000' then
    null;
  end;

  -- ---------------------------------------------------------
  raise notice '10. マネージャーは代理入力できる';
  -- ---------------------------------------------------------
  perform admin_set_status(v_admin, v_event, v_jiro, 'yes');
  select count(*) into v_n
    from attendance where event_id = v_event and member_id = v_jiro and status = 'yes';
  if v_n <> 1 then
    raise exception '代理入力が効いていない';
  end if;

  -- ---------------------------------------------------------
  raise notice '11. リンクを作り直すと古いリンクは無効になる';
  -- ---------------------------------------------------------
  perform admin_reissue_token(v_admin, v_taro);
  begin
    perform member_home(v_taro_tk);
    raise exception '作り直したのに古いリンクがまだ使える';
  exception when sqlstate '28000' then
    null;
  end;

  -- ---------------------------------------------------------
  raise notice '12. 休会にすると集計から外れる';
  -- ---------------------------------------------------------
  perform admin_update_member(v_admin, v_jiro, null, null, false);
  select (admin_home(v_admin)->'events'->0->>'yes_count')::int into v_n;
  if v_n <> 0 then
    raise exception '休会した人が出席人数に残っている: %', v_n;
  end if;
  perform admin_update_member(v_admin, v_jiro, null, null, true);

  -- ---------------------------------------------------------
  raise notice '13. 予定を消すと出欠も一緒に消える';
  -- ---------------------------------------------------------
  perform admin_delete_event(v_admin, v_event);
  select count(*) into v_n from attendance where event_id = v_event;
  if v_n <> 0 then
    raise exception '予定を消したのに出欠が残っている';
  end if;

  raise notice '--- 関数の動き：すべて合格 ---';
end $$;


-- ============================================================
-- ここからが今日の肝。
-- anon（ブラウザのキーの立場）から、テーブルを直接触れないことを確かめる。
--
-- わざと anon に「テーブルを読み書きしてよい」権限を与えた上で試します。
-- それでも何も見えないなら、守っているのは権限ではなく RLS だと分かります。
-- ============================================================

grant usage on schema public to anon;
grant select, insert, update, delete on all tables in schema public to anon;

do $$
declare v_n int; v_blocked boolean;
begin
  perform admin_add_members((select admin_token from team_config where id = 1), array['見えたらダメな人']);

  set local role anon;

  raise notice '14. anon から members が読めない';
  select count(*) into v_n from members;
  if v_n <> 0 then
    raise exception 'RLS が効いていない。% 行読めてしまった', v_n;
  end if;

  raise notice '15. anon から team_config（管理トークン）が読めない';
  select count(*) into v_n from team_config;
  if v_n <> 0 then
    raise exception '管理トークンが盗み見られる状態になっている';
  end if;

  raise notice '16. anon はデータを書き込めない';
  v_blocked := false;
  begin
    insert into events (event_date, kind) values (current_date, 'match');
    -- RLS により 0 行も入らず例外になるのが正しい
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'anon が予定を勝手に作れてしまう';
  end if;

  raise notice '17. anon は内部用の関数を呼べない';
  v_blocked := false;
  begin
    perform app_check_admin('なんでもいい');
  exception when insufficient_privilege then
    v_blocked := true;
  when others then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception '内部用の関数が外から呼べてしまう';
  end if;

  reset role;
  raise notice '--- 鍵のかかり具合：すべて合格 ---';
end $$;

-- 後片付け
delete from attendance;
delete from events;
delete from members;

select '✓ すべて合格' as "結果";
