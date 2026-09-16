-- ============================================================
-- DAY7 サッカー出欠管理：データベースの設計図
--
-- Supabase の SQL Editor にこのファイルの中身を丸ごと貼って
-- 「Run」を押してください。何度貼っても壊れないように書いてあります。
--
-- 【この設計のいちばん大事な考え方】
--   テーブルには誰も直接触れません。
--   RLS（行レベルセキュリティ）を全テーブルで ON にして、
--   許可ルールをひとつも書いていません。＝ anon キーでは何も読めない・書けない。
--   読み書きはすべて、下の方にある「関数」だけを窓口にして通します。
--   関数はトークン（個人リンクに埋まっている合言葉）を必ず確かめます。
--   だから、リンクを持っている本人は自分の欄しか動かせません。
-- ============================================================


-- ============================================================
-- 1. テーブル
-- ============================================================

-- チームの設定。1行だけ入る。
create table if not exists team_config (
  id          int  primary key default 1,
  team_name   text not null default 'わがチーム',
  admin_token text not null,
  constraint team_config_single_row check (id = 1)
);

-- メンバー名簿。token が「その人だけの合言葉」。
create table if not exists members (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  number     text,                                  -- 背番号。文字列にしておくと "7" も "GK" も入る
  token      text not null unique,
  active     boolean not null default true,         -- false にすると休会（過去の記録は残る）
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- 試合・練習の予定。
create table if not exists events (
  id         uuid primary key default gen_random_uuid(),
  event_date date not null,
  start_time time,                                  -- 未定なら空でよい
  kind       text not null default 'practice' check (kind in ('match','practice')),
  place      text,
  note       text,                                  -- 対戦相手・持ち物など
  created_at timestamptz not null default now()
);

-- 出欠の回答。
-- 「未回答」は行が無い状態で表します。行を消せば未回答に戻ります。
create table if not exists attendance (
  event_id   uuid not null references events(id)  on delete cascade,
  member_id  uuid not null references members(id) on delete cascade,
  status     text not null check (status in ('yes','no')),
  updated_at timestamptz not null default now(),
  primary key (event_id, member_id)
);

create index if not exists attendance_event_idx on attendance(event_id);
create index if not exists events_date_idx      on events(event_date);


-- ============================================================
-- 2. 鍵を全部かける（RLS）
--
-- enable した上でポリシーを1つも書かない＝ anon キーからは何も見えない。
-- ここを忘れると、リンクを知らない人でも全データを読み書きできてしまいます。
-- 今日いちばん大事な4行です。
-- ============================================================

alter table team_config enable row level security;
alter table members     enable row level security;
alter table events      enable row level security;
alter table attendance  enable row level security;


-- ============================================================
-- 3. 最初の1行（チーム設定）を作る
--    admin_token は管理用リンクに入る合言葉。ここで自動生成します。
-- ============================================================

insert into team_config (id, team_name, admin_token)
values (1, 'わがチーム', replace(gen_random_uuid()::text, '-', ''))
on conflict (id) do nothing;


-- ============================================================
-- 4. 窓口になる関数
--
--  security definer = 「関数の持ち主の権限で動く」。だから RLS を越えてテーブルを読める。
--  set search_path  = 関数が変なテーブルを掴まされないようにする安全対策。おまじないと思ってOK。
-- ============================================================

-- ---- 内部用：トークンからメンバーを引く。無ければエラー ----
create or replace function app_member_of(p_token text)
returns members
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_member members;
begin
  select * into v_member from members where token = p_token and active;
  if not found then
    raise exception 'リンクが正しくありません' using errcode = '28000';
  end if;
  return v_member;
end;
$$;

-- ---- 内部用：管理トークンの確認 ----
create or replace function app_check_admin(p_admin text)
returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from team_config where id = 1 and admin_token = p_admin) then
    raise exception '管理用リンクが正しくありません' using errcode = '28000';
  end if;
end;
$$;

-- ---- 内部用：予定1件を集計つきの JSON にする ----
create or replace function app_event_json(p_event events, p_member_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id',         p_event.id,
    'date',       p_event.event_date,
    'start_time', p_event.start_time,
    'kind',       p_event.kind,
    'place',      p_event.place,
    'note',       p_event.note,
    'my_status',  (select a.status from attendance a
                    where a.event_id = p_event.id and a.member_id = p_member_id),
    'yes_count',  (select count(*) from attendance a join members m on m.id = a.member_id
                    where a.event_id = p_event.id and a.status = 'yes' and m.active),
    'no_count',   (select count(*) from attendance a join members m on m.id = a.member_id
                    where a.event_id = p_event.id and a.status = 'no'  and m.active)
  );
$$;


-- ============================================================
-- 4-1. メンバー用の関数
-- ============================================================

-- 個人リンクを開いたときに呼ぶ。自分の情報と予定一覧が返る。
create or replace function member_home(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_member members;
  v_today  date := (now() at time zone 'Asia/Tokyo')::date;
begin
  v_member := app_member_of(p_token);

  return jsonb_build_object(
    'team',         (select team_name from team_config where id = 1),
    'me',           jsonb_build_object('id', v_member.id, 'name', v_member.name, 'number', v_member.number),
    'member_count', (select count(*) from members where active),
    'events', coalesce((
      select jsonb_agg(app_event_json(e, v_member.id) order by e.event_date, e.start_time nulls last)
      from events e
      where e.event_date >= v_today
    ), '[]'::jsonb),
    'past', coalesce((
      select jsonb_agg(app_event_json(e, v_member.id) order by e.event_date desc)
      from events e
      where e.event_date < v_today
    ), '[]'::jsonb)
  );
end;
$$;

-- 出席・欠席を答える。p_status に null を渡すと未回答に戻る。
create or replace function set_status(p_token text, p_event_id uuid, p_status text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_member members;
begin
  v_member := app_member_of(p_token);

  if p_status is null then
    delete from attendance where event_id = p_event_id and member_id = v_member.id;
  elsif p_status in ('yes','no') then
    insert into attendance (event_id, member_id, status, updated_at)
    values (p_event_id, v_member.id, p_status, now())
    on conflict (event_id, member_id)
      do update set status = excluded.status, updated_at = now();
  else
    raise exception '出欠の値が不正です';
  end if;

  return member_home(p_token);
end;
$$;

-- 予定を開いたときに「誰が出席で誰が未回答か」を見る。
create or replace function event_detail(p_token text, p_event_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform app_member_of(p_token);

  return jsonb_build_object(
    'roster', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'name', m.name, 'number', m.number,
               'status', (select a.status from attendance a
                           where a.event_id = p_event_id and a.member_id = m.id))
             order by m.sort_order, m.name)
      from members m where m.active
    ), '[]'::jsonb)
  );
end;
$$;


-- ============================================================
-- 4-2. 管理用の関数（すべて管理トークンを確かめる）
-- ============================================================

create or replace function admin_home(p_admin text)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  perform app_check_admin(p_admin);

  return jsonb_build_object(
    'team', (select team_name from team_config where id = 1),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'name', m.name, 'number', m.number,
               'active', m.active, 'token', m.token, 'sort_order', m.sort_order)
             order by m.sort_order, m.name)
      from members m
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id, 'date', e.event_date, 'start_time', e.start_time,
               'kind', e.kind, 'place', e.place, 'note', e.note,
               'yes_count', (select count(*) from attendance a join members m on m.id = a.member_id
                              where a.event_id = e.id and a.status = 'yes' and m.active),
               'no_count',  (select count(*) from attendance a join members m on m.id = a.member_id
                              where a.event_id = e.id and a.status = 'no'  and m.active),
               'answers',   (select coalesce(jsonb_object_agg(a.member_id, a.status), '{}'::jsonb)
                              from attendance a where a.event_id = e.id))
             order by e.event_date desc, e.start_time nulls last)
      from events e
      where e.event_date >= v_today - 90
    ), '[]'::jsonb)
  );
end;
$$;

-- 名簿の一括登録。スプレッドシートから名前を貼り付けて使う。
-- 同じ名前が既にいる場合は飛ばす。
create or replace function admin_add_members(p_admin text, p_names text[])
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_name  text;
  v_next  int;
  v_added int := 0;
begin
  perform app_check_admin(p_admin);
  select coalesce(max(sort_order), 0) into v_next from members;

  foreach v_name in array p_names loop
    v_name := btrim(v_name);
    continue when v_name = '';
    continue when exists (select 1 from members m where m.name = v_name);

    v_next := v_next + 1;
    insert into members (name, token, sort_order)
    values (v_name, replace(gen_random_uuid()::text, '-', ''), v_next);
    v_added := v_added + 1;
  end loop;

  return jsonb_build_object('added', v_added) || admin_home(p_admin);
end;
$$;

create or replace function admin_update_member(
  p_admin text, p_member_id uuid, p_name text, p_number text, p_active boolean)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform app_check_admin(p_admin);
  update members
     set name   = coalesce(nullif(btrim(p_name), ''), name),
         number = nullif(btrim(coalesce(p_number, '')), ''),
         active = coalesce(p_active, active)
   where id = p_member_id;
  return admin_home(p_admin);
end;
$$;

-- 個人リンクが流出したとき用。合言葉を作り直すと、古いリンクは無効になる。
create or replace function admin_reissue_token(p_admin text, p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform app_check_admin(p_admin);
  update members set token = replace(gen_random_uuid()::text, '-', '') where id = p_member_id;
  return admin_home(p_admin);
end;
$$;

create or replace function admin_save_event(
  p_admin text, p_event_id uuid, p_date date, p_time time,
  p_kind text, p_place text, p_note text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform app_check_admin(p_admin);

  if p_kind not in ('match','practice') then
    raise exception '種別は match か practice です';
  end if;

  if p_event_id is null then
    insert into events (event_date, start_time, kind, place, note)
    values (p_date, p_time, p_kind, nullif(btrim(coalesce(p_place,'')),''), nullif(btrim(coalesce(p_note,'')),''));
  else
    update events
       set event_date = p_date, start_time = p_time, kind = p_kind,
           place = nullif(btrim(coalesce(p_place,'')),''),
           note  = nullif(btrim(coalesce(p_note,'')),'')
     where id = p_event_id;
  end if;

  return admin_home(p_admin);
end;
$$;

create or replace function admin_delete_event(p_admin text, p_event_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform app_check_admin(p_admin);
  delete from events where id = p_event_id;   -- 出欠も一緒に消える（on delete cascade）
  return admin_home(p_admin);
end;
$$;

-- マネージャーによる代理入力。LINEで個別に返事が来たとき用。
create or replace function admin_set_status(
  p_admin text, p_event_id uuid, p_member_id uuid, p_status text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform app_check_admin(p_admin);

  if p_status is null then
    delete from attendance where event_id = p_event_id and member_id = p_member_id;
  elsif p_status in ('yes','no') then
    insert into attendance (event_id, member_id, status, updated_at)
    values (p_event_id, p_member_id, p_status, now())
    on conflict (event_id, member_id)
      do update set status = excluded.status, updated_at = now();
  else
    raise exception '出欠の値が不正です';
  end if;

  return admin_home(p_admin);
end;
$$;

create or replace function admin_rename_team(p_admin text, p_name text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform app_check_admin(p_admin);
  update team_config set team_name = coalesce(nullif(btrim(p_name),''), team_name) where id = 1;
  return admin_home(p_admin);
end;
$$;


-- ============================================================
-- 5. 内部用の関数は外から呼べないようにする
-- ============================================================

revoke execute on function app_member_of(text)        from anon, authenticated;
revoke execute on function app_check_admin(text)      from anon, authenticated;
revoke execute on function app_event_json(events,uuid) from anon, authenticated;


-- ============================================================
-- 6. 管理用リンクの合言葉を確認する
--    ここに出た文字列が、あなただけの管理画面の鍵です。
--    admin.html#<この文字列> で管理画面が開きます。人に見せないでください。
-- ============================================================

select admin_token as "管理用トークン（admin.html# のうしろに貼る）" from team_config where id = 1;
