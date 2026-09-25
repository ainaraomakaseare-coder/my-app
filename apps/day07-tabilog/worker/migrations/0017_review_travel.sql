-- v18：紹介文（docs/adr/0007）のため、評価（★）に人ごとのレビュー項目（◎〇△×・金額・立地など）を、
-- 記録に移動の情報（区間・会社・出発/到着・金額）を、それぞれJSONで持たせる。列を足すだけなので既存データには影響しない。
-- **wrangler deployより先に**本番環境で1回だけ実行すること（逆順だと評価・記録の保存がSQLエラーになる）。
ALTER TABLE ratings ADD COLUMN review TEXT NOT NULL DEFAULT '{}';
ALTER TABLE entries ADD COLUMN travel TEXT NOT NULL DEFAULT '{}';
