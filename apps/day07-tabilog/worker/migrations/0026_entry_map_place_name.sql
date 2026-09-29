-- v26：記録の地図の座標を求めるとき（backgroundGeocodeEntry・/geocode?entry=）に、その場所の
-- 人が読める名前（地図URL自体の /maps/place/<名前>/ ・query=<名前>、無ければGoogle Places の
-- displayName）も一緒に1回だけ求めて保存する（2026-09-29）。
-- 宿泊の見出し（block.label）が「ホテルに帰宅」のような一般的な文言だけのとき、旅行詳細の
-- 「宿泊先」表示にこの名前を代わりに使うため（Core.primaryLodgingName／lodgingByNight）。
ALTER TABLE entries ADD COLUMN map_place_name TEXT;
