-- v16：セッション（ログインの本人確認。docs/adr/0005）。メールOTPの確認に成功したときに発行する
-- トークンのSHA-256ハッシュだけを置く（トークンそのものは置かない）。新しいテーブルを足すだけなので
-- 既存データには影響しない。wrangler deployより先に、本番環境でこのCREATE TABLE/INDEXを実行すること。
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_email ON sessions(email);

-- v17：いいね・コメント（友達同士のSNS機能。docs/adr/0006）。旅行（target_type='trip'）と
-- 記録（target_type='entry'）の両方が対象。書いた人はメールアドレスではなくaccount_idで持つ
-- （名前はaccountsから引く。他人にメールアドレスを見せない）。trip_idは一覧をまとめて引くため・
-- 旅行を消したときにまとめて消すために持つ。新しいテーブルを足すだけなので既存データには影響しない。
CREATE TABLE IF NOT EXISTS likes (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(target_type, target_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_likes_trip ON likes(trip_id);
CREATE INDEX IF NOT EXISTS idx_likes_account ON likes(account_id);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_trip ON comments(trip_id);
CREATE INDEX IF NOT EXISTS idx_comments_account ON comments(account_id);

-- ブロック：blockerには、blockedのコメントが見えなくなる（Appleの審査ガイドライン1.2の要件）。
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_account_id TEXT NOT NULL,
  blocked_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_account_id, blocked_account_id)
);

-- 通報：通報した本人にはそのコメントが見えなくなり、運営者にメールで知らせる（ガイドライン1.2）。
CREATE TABLE IF NOT EXISTS comment_reports (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL,
  reporter_account_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(comment_id, reporter_account_id)
);
