-- v35（2026-10-01）：プロフィール・フォロー・親しい友人（docs/adr/0010 ステップ2）。
-- accounts.bio：ひとこと（160字まで）／avatar_photo_id：アイコン（R2の写真ID。空文字なら頭文字）／
--   is_private：承認制（1ならフォローは申請→承認。0なら申請なしでフォローできる）。
-- follows：follower_id が followee_id をフォローしている。status は 'pending'（承認待ち）｜'approved'（フォロー中）。
-- close_friends：owner_account_id が friend_account_id を親しい友人に入れている（相手はフォロワーの中から選ぶ）。
-- profile_reports：プロフィールの通報（Appleのガイドライン1.2）。運営者にもメールで知らせる。
-- 既存のuser_blocks（コメントのブロック）を、フォロー・プロフィールのブロックとしても使う。
--
-- 実行方法（wrangler deployより先に。1文ずつ--commandで）：
--   npx wrangler d1 execute tabilog-db --remote --command "ALTER TABLE accounts ADD COLUMN bio TEXT NOT NULL DEFAULT '';"
--   npx wrangler d1 execute tabilog-db --remote --command "ALTER TABLE accounts ADD COLUMN avatar_photo_id TEXT NOT NULL DEFAULT '';"
--   npx wrangler d1 execute tabilog-db --remote --command "ALTER TABLE accounts ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;"
--   npx wrangler d1 execute tabilog-db --remote --command "CREATE TABLE IF NOT EXISTS follows (follower_id TEXT NOT NULL, followee_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'approved', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (follower_id, followee_id));"
--   npx wrangler d1 execute tabilog-db --remote --command "CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id, status);"
--   npx wrangler d1 execute tabilog-db --remote --command "CREATE TABLE IF NOT EXISTS close_friends (owner_account_id TEXT NOT NULL, friend_account_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (owner_account_id, friend_account_id));"
--   npx wrangler d1 execute tabilog-db --remote --command "CREATE TABLE IF NOT EXISTS profile_reports (id TEXT PRIMARY KEY, reported_account_id TEXT NOT NULL, reporter_account_id TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE (reported_account_id, reporter_account_id));"
--
-- ALTER TABLEは1回だけ（2回目は「duplicate column name」エラーになるが害はない）。
-- 実行前にWorkerをデプロイしても壊れない作りにしてある（テーブル・列が無ければ「フォローなし・ひとことなし」として動く）。
ALTER TABLE accounts ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN avatar_photo_id TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL,
  followee_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id, status);
CREATE TABLE IF NOT EXISTS close_friends (
  owner_account_id TEXT NOT NULL,
  friend_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_account_id, friend_account_id)
);
CREATE TABLE IF NOT EXISTS profile_reports (
  id TEXT PRIMARY KEY,
  reported_account_id TEXT NOT NULL,
  reporter_account_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (reported_account_id, reporter_account_id)
);
