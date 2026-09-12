-- たびログ D1 スキーマ（v2：大項目 blocks / 小項目 entries の2階層）。
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
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  block_id TEXT NOT NULL,
  episode TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  photo_ids TEXT NOT NULL DEFAULT '[]',
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
