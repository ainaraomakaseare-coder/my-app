-- v36（2026-10-06）：マイページの「プロフィール写真」と「旅のベストピクチャー」。
-- avatar_photo_id：プロフィール写真（R2のキー。空なら頭文字のアイコン）。アカウントごとに別アップロードされた1枚。
-- best_photo_ids：ベストピクチャー（旅行の記録の写真のキーのJSON配列、最大6枚）。マイページ（本人だけ）に出る。
--
-- 実行方法（wrangler deployより先に。--fileは認証エラーになる環境があるので--commandで。2つの文を1つずつ）：
--   npx wrangler d1 execute tabilog-db --remote --command "ALTER TABLE accounts ADD COLUMN avatar_photo_id TEXT NOT NULL DEFAULT '';"
--   npx wrangler d1 execute tabilog-db --remote --command "ALTER TABLE accounts ADD COLUMN best_photo_ids TEXT NOT NULL DEFAULT '[]';"
--
-- 先にデプロイしてしまっても、既存の機能は動く（新しい2つの機能だけが、列ができるまで使えない）。
ALTER TABLE accounts ADD COLUMN avatar_photo_id TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN best_photo_ids TEXT NOT NULL DEFAULT '[]';
