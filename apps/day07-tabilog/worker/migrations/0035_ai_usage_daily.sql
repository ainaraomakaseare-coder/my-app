-- v35（2026-10-06）：運営者向けの「AIの使用状況」。外部のAI・有料APIを呼んだ回数を、日・機能・サービスごとに数える。
-- day：UTCの日付（YYYY-MM-DD）。feature：voice | memo | multiday | screenshot | receipt | places | route | other。
-- provider：workers_ai | openai | openai_whisper | google_vision | google_vision_images（画像の枚数）| google_places | google_routes。
-- 利用者の個人情報は入らない（回数だけ）。
--
-- 実行方法（wrangler deployより先に。--fileは認証エラーになる環境があるので--commandで）：
--   npx wrangler d1 execute tabilog-db --remote --command "CREATE TABLE IF NOT EXISTS ai_usage_daily (day TEXT NOT NULL, feature TEXT NOT NULL, provider TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, feature, provider));"
--
-- 先にデプロイしてしまっても動く（テーブルが無い間は記録されず、ログにai_usage_errorが出る）。
CREATE TABLE IF NOT EXISTS ai_usage_daily (day TEXT NOT NULL, feature TEXT NOT NULL, provider TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, feature, provider));
