-- 旅の足跡 D1 スキーマ（v2：大項目 blocks / 小項目 entries の2階層）。
-- v1で作った episodes テーブルは廃止し、blocks（いつ・どこで・何をしたか）と
-- entries（そのときの一人ひとりの記録。別行動なら同じblockに複数ぶら下がる）に分ける。
-- 写真の実体はR2に置き、ここには photo_ids（R2のキーのJSON配列）だけを持つ。

DROP TABLE IF EXISTS episodes;

CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_date TEXT NOT NULL DEFAULT '',
  end_date TEXT NOT NULL DEFAULT '',
  companions TEXT NOT NULL DEFAULT '[]',
  cover_photo_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 大項目：いつ・どこで・何をする時間か。「10:00 那覇空港に集合」のような1つの予定。
CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  date TEXT NOT NULL DEFAULT '',
  time TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'sightseeing',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 小項目：その予定のときの、一人ひとり（またはサブグループ）の記録。
-- 別行動した場合は、同じblock_idのentryを複数作ることで表現する。
-- v3で detail（詳細）・video_ids（動画）を追加したため、entriesだけ作り直す
-- （試作段階のため、テーブルごと作り直す方式。tripsやblocksは対象外）。
DROP TABLE IF EXISTS entries;

CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  block_id TEXT NOT NULL,
  episode TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  photo_ids TEXT NOT NULL DEFAULT '[]',
  video_ids TEXT NOT NULL DEFAULT '[]',
  cost_items TEXT NOT NULL DEFAULT '[]',
  wait_time TEXT NOT NULL DEFAULT '',
  map_url TEXT NOT NULL DEFAULT '',
  shop_url TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blocks_trip ON blocks(trip_id);
CREATE INDEX IF NOT EXISTS idx_entries_block ON entries(block_id);

-- v4：評価（★1〜5）を追加。既存のtrips/blocks/entriesは変更しないので、
-- このテーブルとインデックスだけ追加すればよい（DROP TABLEなし＝データは消えない）。
-- 1つのentryに、ログイン済みの人がそれぞれ1件ずつ評価を持てる（rater_emailで一意）。
-- 評価はログイン必須の機能で、rater_emailはクライアントが送ってきた値をそのまま信用する
-- （このアプリ全体と同じ「サーバー側でトークン検証はしない」簡易的な仕組みのため）。
CREATE TABLE IF NOT EXISTS ratings (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  rater_email TEXT NOT NULL,
  rater_name TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(entry_id, rater_email)
);

CREATE INDEX IF NOT EXISTS idx_ratings_entry ON ratings(entry_id);
CREATE INDEX IF NOT EXISTS idx_ratings_rater ON ratings(rater_email);

-- v5：日ごとの天気を追加。既存テーブルは変更しない（DROP TABLEなし＝データは消えない）。
-- 「大項目（block）」は1日に複数あるため、天気は大項目ごとではなく
-- 旅行×日付の単位（1つの旅行の1日に1つ）で持つ。
-- 地名→緯度経度の変換、天気・気温の取得はどちらもOpen-Meteo（無料・APIキー不要）を使う。
-- 日付が今日より前なら実況（archive-api）、今日以降なら予報（forecast api）を取得し、
-- is_forecastで区別する。日付が過ぎたらis_forecast=0の実況値で上書きする想定。
-- precip_sum（降水量mm）はv6で追加。「1mm以下なら曇り扱いにする」判定に使う
-- （天気コードだけだと、ごく僅かな小雨でも「雨」表示になってしまうため）。
CREATE TABLE IF NOT EXISTS day_infos (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  date TEXT NOT NULL,
  place TEXT NOT NULL DEFAULT '',
  lat REAL,
  lon REAL,
  weather_code INTEGER,
  temp_max REAL,
  temp_min REAL,
  precip_sum REAL,
  is_forecast INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(trip_id, date)
);

CREATE INDEX IF NOT EXISTS idx_day_infos_trip ON day_infos(trip_id);

-- v6：day_infosに降水量（precip_sum）を追加。上のCREATE TABLEには最初から含めてあるため、
-- これは「v5時点で作成済みの（precip_sumを持たない）day_infosテーブル」を更新するための
-- 一度きりの文。既にprecip_sum列がある状態でこの行を再実行するとエラーになる点に注意
-- （その場合はこの1行だけ削除してから再実行すればよい。他のCREATE系はすべて再実行安全）。
ALTER TABLE day_infos ADD COLUMN precip_sum REAL;

-- v7：メールでのログインを「その場で入力するだけ」から「実際にメールでコードを送って
-- 確認する（OTP）」方式に変更したため、コードを一時的に保存するテーブルを追加。
-- 1つのメールアドレスにつき有効なコードは常に1つ（送り直すと上書き）。
-- 認証に成功した/期限切れ/試行回数を使い切ったら行ごと削除する（使い捨て）。
CREATE TABLE IF NOT EXISTS email_otps (
  email TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
