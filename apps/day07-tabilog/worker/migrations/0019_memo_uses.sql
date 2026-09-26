-- v20：メモをAIで整理した回数（音声入力とは別の枠）を数える列。無料でも月10回まで（MEMO_MONTHLY_LIMIT）。
-- 列を足すだけなので既存データには影響しない。**wrangler deployより先に**本番環境で1回だけ実行すること
-- （逆順だと、アカウントの確認・メモの整理がSQLエラーになる）。
ALTER TABLE accounts ADD COLUMN memo_uses_this_period INTEGER NOT NULL DEFAULT 0;
