-- v19：移動の予定に「移動時間」（分）を持たせる。予定の種類が「移動」のときだけ、移動手段と一緒に入力する。
-- 列を足すだけなので既存データには影響しない。**wrangler deployより先に**本番環境で1回だけ実行すること
-- （逆順だと予定の作成・保存がSQLエラーになる）。
ALTER TABLE blocks ADD COLUMN move_minutes INTEGER NOT NULL DEFAULT 0;
