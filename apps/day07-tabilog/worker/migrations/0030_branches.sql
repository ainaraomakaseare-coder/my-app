-- v30（2026-09-30）：自分だけの道（別行動の分岐）。docs/adr/0021-personal-branches.md
-- branches：「この人が、この日のこの時間帯だけ、みんなと別行動した」という区間。
--   account_id が持ち主（accounts.account_id）。持ち主だけが変更・削除できる（Worker側で守る）。
-- blocks.branch_id：空文字なら今までどおりの「みんなの予定」。branches.id が入っていれば、その分岐の中の予定。
--
-- end_date：別行動が日をまたぐときの終わりの日（空文字＝date と同じ＝1日の別行動。2026-09-30に追加、0032参照）。
--
-- 実行方法（wrangler deployより先に。--fileは認証エラーになる環境があるので、1文ずつ--commandで）：
--   npx wrangler d1 execute tabilog-db --remote --command "CREATE TABLE IF NOT EXISTS branches (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, account_id TEXT NOT NULL, date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, end_date TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);"
--   npx wrangler d1 execute tabilog-db --remote --command "CREATE INDEX IF NOT EXISTS idx_branches_trip ON branches(trip_id);"
--   npx wrangler d1 execute tabilog-db --remote --command "ALTER TABLE blocks ADD COLUMN branch_id TEXT NOT NULL DEFAULT '';"
--
-- ALTER TABLE blocks は1回だけ（2回目は「duplicate column name」エラーになるが害はない）。
-- 実行前にWorkerをデプロイしても壊れない作りにしてある（テーブル／列が無ければ「別行動なし」として動く）。
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  end_date TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_branches_trip ON branches(trip_id);
ALTER TABLE blocks ADD COLUMN branch_id TEXT NOT NULL DEFAULT '';
