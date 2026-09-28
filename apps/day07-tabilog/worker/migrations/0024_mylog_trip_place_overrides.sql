-- v24：マイログの「訪れた都道府県・国」を旅行ごとに外す・戻すための表（2026-09-28）。
-- v23のmylog_place_overrides（アカウント全体でhide/show）は、片方の旅行だけから外したくても
-- 全部の旅行から消えてしまう不具合があったため、この表に置き換える（v23の表・エンドポイントは
-- 残すが、集計では使わない。docs/adr/0016参照）。
-- name は表記ゆれをまとめたあとの名前（アメリカ等）。外すことしかできない（hide専用、modeは無い）。
CREATE TABLE IF NOT EXISTS mylog_trip_place_overrides (
  account_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, trip_id, kind, name)
);
