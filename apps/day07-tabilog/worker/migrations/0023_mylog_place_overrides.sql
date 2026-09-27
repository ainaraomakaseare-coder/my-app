-- v23：マイログの「訪れた国・都道府県」を本人が外す（mode='hide'）／乗り継ぎと判定されたものを
-- 数える（mode='show'）ための表（2026-09-27）。name は表記ゆれをまとめたあとの名前（アメリカ等）。
-- この表が無くてもマイログの表示は動く（外す操作だけがエラーになる）。
CREATE TABLE IF NOT EXISTS mylog_place_overrides (
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, kind, name)
);
