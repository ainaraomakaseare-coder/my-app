-- v31（2026-09-30）：予定を「動画でシェアに出さない」にする印（docs/adr/0020）。
-- 1なら、動画では地名・写真・ピンを出さない（道のりはその場所を通る）。地図でふりかえる（replay）には影響しない。
-- メンバー全員に共通の設定。
--
-- 実行方法（wrangler deployより先に。--fileは認証エラーになる環境があるので--commandで）：
--   npx wrangler d1 execute tabilog-db --remote --command "ALTER TABLE blocks ADD COLUMN video_exclude INTEGER NOT NULL DEFAULT 0;"
--
-- 1回だけ実行する（2回目は「duplicate column name」エラーになるが、害はない）。
-- 先にデプロイしてしまっても、この列が無いだけなら動く（印が保存されず、全部の予定が動画に出る）。
ALTER TABLE blocks ADD COLUMN video_exclude INTEGER NOT NULL DEFAULT 0;
