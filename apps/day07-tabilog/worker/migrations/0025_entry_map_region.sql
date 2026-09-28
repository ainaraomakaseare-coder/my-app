-- v25：記録の地図の座標（entries.map_lat/map_lng）から求めた都道府県・国を、座標と一緒にD1へ
-- 持たせておく（2026-09-28）。今までは/mylogのたびにresolveMapPointPlacesで座標→地名の逆ジオコーディング
-- をやり直しており、旅行の地点数が多いとNominatim呼び出し＋Cache API（match/put）だけで
-- Workers Free（1呼び出し50サブリクエストまで）を超え、GET /mylogが
-- 「Too many subrequests by single Worker invocation.」で丸ごと落ちる本番障害になった。
-- 座標を求めるとき（backgroundGeocodeEntry・/geocode?entry=）に1回だけ逆ジオコーディングして
-- ここへ保存し、/mylogは基本的にこの列を読むだけにする（未解決の古い行だけ、1リクエストにつき
-- 最大3地点まで小分けに解決する。worker/src/index.jsのgetVisitedPlaces参照）。
ALTER TABLE entries ADD COLUMN map_admin1 TEXT;
ALTER TABLE entries ADD COLUMN map_country TEXT;
