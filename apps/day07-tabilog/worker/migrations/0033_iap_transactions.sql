-- v33（2026-09-30）：回数券のアプリ内課金（RevenueCat）。docs/adr/0004の「回数券のアプリ内課金」の節
-- iap_transactions：RevenueCatのWebhookで処理済みの取引。transaction_idが主キーなので、同じ取引の再送で回数が二重に増えない。
--
--   npx wrangler d1 execute tabilog-db --remote --file=migrations/0033_iap_transactions.sql
CREATE TABLE IF NOT EXISTS iap_transactions (transaction_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, product_id TEXT NOT NULL, credits INTEGER NOT NULL, environment TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_iap_transactions_account ON iap_transactions(account_id);
