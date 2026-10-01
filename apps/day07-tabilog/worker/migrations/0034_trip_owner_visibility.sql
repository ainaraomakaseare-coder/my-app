-- v34（2026-10-01）：旅行の持ち主と公開範囲（docs/adr/0010 ステップ1）。
-- owner_account_id：旅行を作ったアカウント（accounts.account_id）。空文字は「まだ持ち主がいない」（今ある旅行はすべて空文字）。
--   空の旅行は、最初に参加したアカウント（trip_members）が「持ち主になる」まで、公開範囲を変えられない。
-- visibility：'members'（一緒に行った人だけ）｜'close_friends'（親しい友人）｜'followers'（フォロワー）｜'public'（全体）。
--   初期値は'members'。今ある旅行も含め、勝手に公開されることはない。
-- public_id：公開の画面（?p=...）用の別ID。初めて公開したときにサーバーが作る（空文字は未公開）。
--   旅行のURL（trip.id＝編集できる招待リンク）は公開の画面に一切出さない。
--
-- 実行方法（wrangler deployより先に。--fileは認証エラーになる環境があるので、1文ずつ--commandで）：
--   npx wrangler d1 execute tabilog-db --remote --command "ALTER TABLE trips ADD COLUMN owner_account_id TEXT NOT NULL DEFAULT '';"
--   npx wrangler d1 execute tabilog-db --remote --command "ALTER TABLE trips ADD COLUMN visibility TEXT NOT NULL DEFAULT 'members';"
--   npx wrangler d1 execute tabilog-db --remote --command "ALTER TABLE trips ADD COLUMN public_id TEXT NOT NULL DEFAULT '';"
--   npx wrangler d1 execute tabilog-db --remote --command "CREATE INDEX IF NOT EXISTS idx_trips_public_id ON trips(public_id);"
--   npx wrangler d1 execute tabilog-db --remote --command "CREATE INDEX IF NOT EXISTS idx_trips_owner ON trips(owner_account_id);"
--
-- ALTER TABLEは1回だけ（2回目は「duplicate column name」エラーになるが害はない）。
-- 実行前にWorkerをデプロイしても壊れない作りにしてある（列が無ければ、全部の旅行を「一緒に行った人だけ」として動く）。
ALTER TABLE trips ADD COLUMN owner_account_id TEXT NOT NULL DEFAULT '';
ALTER TABLE trips ADD COLUMN visibility TEXT NOT NULL DEFAULT 'members';
ALTER TABLE trips ADD COLUMN public_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_trips_public_id ON trips(public_id);
CREATE INDEX IF NOT EXISTS idx_trips_owner ON trips(owner_account_id);
