-- v29（2026-09-30）：Sign in with Appleのrefresh_tokenを保存する列（docs/adr/0019）。
-- アカウント削除時にAppleのトークン取り消しAPI（/auth/revoke）へ渡すために使う（App Store 5.1.1(v)）。
-- Appleのログインでだけ入り、Google/LINEは空のまま。
--
-- 実行方法（wrangler deployより先に。--fileは認証エラーになる環境があるので--commandで）：
--   npx wrangler d1 execute tabilog-db --remote --command "ALTER TABLE auth_identities ADD COLUMN refresh_token TEXT NOT NULL DEFAULT '';"
--
-- 1回だけ実行する（2回目は「duplicate column name」エラーになるが、害はない）。
ALTER TABLE auth_identities ADD COLUMN refresh_token TEXT NOT NULL DEFAULT '';
