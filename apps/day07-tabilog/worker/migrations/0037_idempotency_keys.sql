-- v37（2026-10-07）：電波がないときの送信待ち（オフライン対応）が、同じ作成を二重に送ってしまっても
-- 二重に作らないための「冪等性キー」の置き場。詳しい説明は src/idempotency.js。
-- key：クライアントが付ける Idempotency-Key ／ response：前回の返事（{status, body}のJSON）／ created_at：7日より古いものは約1%の確率で消す。
--
-- 実行方法（wrangler deployより先に。--fileは認証エラーになる環境があるので--commandで）：
--   npx wrangler d1 execute tabilog-db --remote --command "CREATE TABLE IF NOT EXISTS idempotency_keys (key TEXT PRIMARY KEY, response TEXT, created_at TEXT);"
--
-- 先にデプロイしてしまっても、既存の機能は動く（キーを無視して今までどおり作る）。
CREATE TABLE IF NOT EXISTS idempotency_keys (key TEXT PRIMARY KEY, response TEXT, created_at TEXT);
