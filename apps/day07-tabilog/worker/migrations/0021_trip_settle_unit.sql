-- v21：精算（割り勘）の丸め単位（1｜10｜100円、Walicaのように選べるようにする、2026-09-27）。
-- 旅行メンバー全員で共有する設定なので、trips本体に持たせる。既存の旅行は1円のまま変わらない
-- （DEFAULT 1）。列を足すだけなので既存データには影響しない。**wrangler deployより先に**
-- 本番環境で1回だけ実行すること（逆順だと、精算の設定保存がSQLエラーになる）。
ALTER TABLE trips ADD COLUMN settle_unit INTEGER NOT NULL DEFAULT 1;
