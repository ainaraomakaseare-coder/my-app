-- v33（2026-10-04）：メールOTPの乱用対策。
-- key：'fail:<メール>'（失敗した確認の回数・1時間）／'send_email:<メール>'（コード送信・1日）／'send_ip:<IP>'（コード送信・1時間）。
-- window_startから窓が過ぎていれば、次のカウントで1に戻る。再送しても失敗回数は戻らない（総当たり対策）。
--
-- 実行方法（wrangler deployより先に。--fileは認証エラーになる環境があるので--commandで）：
--   npx wrangler d1 execute tabilog-db --remote --command "CREATE TABLE IF NOT EXISTS otp_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, window_start TEXT NOT NULL);"
--
-- 先にデプロイしてしまっても動く（テーブルが無い間は上限なしで通り、ログにotp_limit_errorが出る）。
CREATE TABLE IF NOT EXISTS otp_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, window_start TEXT NOT NULL);
