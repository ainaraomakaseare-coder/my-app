-- v28：Apple / Google / LINE のサーバー側ソーシャルログイン（2026-09-30、docs/adr/0019）。
-- 追加するのは新しいテーブルだけ（CREATE TABLE IF NOT EXISTS）。既存のテーブルには触れない。
--
-- 実行のしかた：このオーナーの環境では `wrangler d1 execute --file` が失敗するため、
-- 次のように文を1つずつ --command で流す（README.mdの「ソーシャルログインの準備」参照）。
--   npx wrangler d1 execute tabilog-db --remote --command "<下のCREATE文を1つ>"
--
-- ① どのプロバイダーの誰（subject）が、どのメールアドレスのアカウントか。
--    アカウントはこれまでどおりメールアドレスをキーにしたまま、ここで結びつける。
CREATE TABLE IF NOT EXISTS auth_identities (provider TEXT NOT NULL, subject TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (provider, subject));
CREATE INDEX IF NOT EXISTS idx_auth_identities_email ON auth_identities(email);

-- ② ログイン開始〜プロバイダーから戻るまでの間だけ持つ state（CSRF対策）・nonce・PKCE。10分で失効、使い捨て。
CREATE TABLE IF NOT EXISTS auth_states (state TEXT PRIMARY KEY, provider TEXT NOT NULL, return_to TEXT NOT NULL, req_id TEXT NOT NULL DEFAULT '', nonce TEXT NOT NULL, code_verifier TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL, created_at TEXT NOT NULL);

-- ③ セッションと交換するための使い捨てコード（DBにはハッシュだけ。5分で失効）。
--    kind='session'：ログイン成功。email/nameが入る。
--    kind='link'：メールが分からなかったので、メールOTPで一度確認して結びつける待ち（provider/subjectが入る）。
CREATE TABLE IF NOT EXISTS auth_codes (code_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL, created_at TEXT NOT NULL);

-- ④ iOSアプリ用：ブラウザで終わったログインの結果を、アプリが一度だけ取りに来るための置き場（5分で失効、読んだら消す）。
CREATE TABLE IF NOT EXISTS auth_native_results (req_id TEXT PRIMARY KEY, kind TEXT NOT NULL, code TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL);
