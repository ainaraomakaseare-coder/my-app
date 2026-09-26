-- v20：記録の地図URLの座標をD1に持たせ、「地図でふりかえる」を開くたびにNominatim・ウィキペディア等へ
-- 探しに行かなくてよいようにする（毎回re-geocodeしていたのを1回だけにする、2026-09-26）。
-- map_geocoded_url：その座標がどのmap_urlに対するものかを覚えておく（正解のURL）。編集でmap_urlが
-- 変われば、map_geocoded_urlと一致しなくなり、APIは古い座標を返さず、裏で探し直す（entries.map_urlの
-- 値そのものを信頼せず、必ずこの一致チェックを通す。列を足すだけなので既存データには影響しない。
-- **wrangler deployより先に**本番環境で1回だけ実行すること（逆順だと記録の保存がSQLエラーになる）。
ALTER TABLE entries ADD COLUMN map_lat REAL;
ALTER TABLE entries ADD COLUMN map_lng REAL;
ALTER TABLE entries ADD COLUMN map_geocoded_url TEXT;
ALTER TABLE entries ADD COLUMN map_geocoded_at TEXT;
