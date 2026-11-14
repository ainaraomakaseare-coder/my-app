-- v38（2026-11-14）：取り込みの元（AIなどで予定を入れたときの元の入力）。詳しい説明は src/import-sources.js。
-- 音声の文字起こし・貼り付けたメモ・自分のAIの答え・スクショ画像（R2のキー）を1回の取り込みにつき1行残し、
-- そのとき作った予定の blocks.source_id にこの行のidを入れる。「何でこの予定を入れたっけ」を予定から見返せる。
-- スクショ画像は記録（entries.photo_ids）には入れないので、アルバムには出ない。
--
-- 実行方法（wrangler deployより先に。--fileは認証エラーになる環境があるので--commandで、1行ずつ）：
--   npx wrangler d1 execute tabilog-db --remote --command "CREATE TABLE IF NOT EXISTS import_sources (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, branch_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', photo_ids TEXT NOT NULL DEFAULT '[]', author TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);"
--   npx wrangler d1 execute tabilog-db --remote --command "CREATE INDEX IF NOT EXISTS idx_import_sources_trip ON import_sources(trip_id);"
--   npx wrangler d1 execute tabilog-db --remote --command "ALTER TABLE blocks ADD COLUMN source_id TEXT NOT NULL DEFAULT '';"
--
-- 先にデプロイしてしまっても、取り込みは今までどおり動く（元を残さずに予定だけ保存する）。
CREATE TABLE IF NOT EXISTS import_sources (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, branch_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', photo_ids TEXT NOT NULL DEFAULT '[]', author TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_import_sources_trip ON import_sources(trip_id);
ALTER TABLE blocks ADD COLUMN source_id TEXT NOT NULL DEFAULT '';
