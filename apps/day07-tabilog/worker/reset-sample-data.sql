-- 動作確認で作ったサンプルデータを、旅行・予定・記録・評価・日ごとの天気ぜんぶ含めて
-- 空にするためのスクリプト。テーブルの定義自体は変えない（schema.sqlとは別物）。
-- 実行後は元に戻せないので注意。
DELETE FROM ratings;
DELETE FROM day_infos;
DELETE FROM entries;
DELETE FROM blocks;
DELETE FROM trips;
