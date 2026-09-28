/*
 * マイログの「訪れた都道府県・国」の集計（src/visited-places.js）の単体テスト。
 * 実行: node worker/test/visited-places.test.mjs
 */
import assert from "node:assert/strict";
import { canonicalCountry, canonicalPrefecture, isTransitBlock, aggregateVisitedPlaces } from "../src/visited-places.js";

let pass = 0, fail = 0;
function check(label, got, want) {
  try { assert.deepEqual(got, want); pass++; }
  catch (e) { fail++; console.error("FAIL:", label, "\n  got: ", JSON.stringify(got), "\n  want:", JSON.stringify(want)); }
}

// 国名の表記ゆれ
check("アメリカ合衆国→アメリカ", canonicalCountry("アメリカ合衆国"), "アメリカ");
check("アメリカ→アメリカ", canonicalCountry("アメリカ"), "アメリカ");
check("米国→アメリカ", canonicalCountry("米国"), "アメリカ");
check("United States→アメリカ", canonicalCountry(" United States "), "アメリカ");
check("中華人民共和国→中国", canonicalCountry("中華人民共和国"), "中国");
check("大韓民国→韓国", canonicalCountry("大韓民国"), "韓国");
check("ブラジル連邦共和国→ブラジル", canonicalCountry("ブラジル連邦共和国"), "ブラジル");
check("表に無い〜共和国は短くする", canonicalCountry("チェコ共和国"), "チェコ");
check("ドミニカ共和国はそのまま", canonicalCountry("ドミニカ共和国"), "ドミニカ共和国");
check("空", canonicalCountry(""), "");
check("日本国→日本", canonicalCountry("日本国"), "日本");

// 都道府県
check("東京→東京都", canonicalPrefecture("東京"), "東京都");
check("東京都→東京都", canonicalPrefecture("東京都"), "東京都");
check("大阪→大阪府", canonicalPrefecture("大阪"), "大阪府");
check("北海→そのまま", canonicalPrefecture("北海"), "北海");

// 乗り継ぎの予定
check("移動は乗り継ぎ扱い", isTransitBlock({ category: "transport", label: "LAX→JFK" }), true);
check("到着も", isTransitBlock({ category: "arrival", label: "着いた" }), true);
check("空港の食事も", isTransitBlock({ category: "food", label: "北京首都空港でラーメン" }), true);
check("宿泊は空港でも違う", isTransitBlock({ category: "lodging", label: "空港ホテル" }), false);
check("観光はちがう", isTransitBlock({ category: "sightseeing", label: "自由の女神" }), false);

// 集計
const trips = { t1: "ブラジル・アルゼンチン", t2: "LA" };
const days = [
  { tripId: "t1", date: "2026-01-01", admin1: "", country: "中華人民共和国", lat: 40.08, lon: 116.58 }, // 北京で乗り継ぎ
  { tripId: "t1", date: "2026-01-02", admin1: "New York", country: "アメリカ合衆国", lat: 40.7, lon: -74.0 },
  { tripId: "t1", date: "2026-01-03", admin1: "", country: "ブラジル", lat: -25.6, lon: -54.4 },
  { tripId: "t1", date: "2026-01-04", admin1: "", country: "エチオピア", lat: 8.97, lon: 38.79 }, // 空港の地図から入った
  { tripId: "t2", date: "2026-02-01", admin1: "California", country: "アメリカ", lat: 34.0, lon: -118.2 },
  { tripId: "t2", date: "2026-02-05", admin1: "東京", country: "日本", lat: 35.5, lon: 139.8 },
];
const blocks = [
  { id: "b1", tripId: "t1", date: "2026-01-01", category: "transport", label: "北京で乗り継ぎ" },
  { id: "b2", tripId: "t1", date: "2026-01-02", category: "sightseeing", label: "タイムズスクエア" },
  { id: "b3", tripId: "t1", date: "2026-01-03", category: "sightseeing", label: "イグアスの滝" },
  { id: "b4a", tripId: "t1", date: "2026-01-04", category: "other", label: "アディスアベバ空港" },
  { id: "b4b", tripId: "t1", date: "2026-01-04", category: "sightseeing", label: "ブエノスアイレス" },
  { id: "b5", tripId: "t2", date: "2026-02-01", category: "food", label: "In-N-Out" },
];
const coords = { b4a: [{ lat: 8.97, lng: 38.79 }], b4b: [{ lat: -34.6, lng: -58.4 }] };
const r = aggregateVisitedPlaces({ days, blocks, coords, trips });
check("行った国（表記ゆれをまとめ、乗り継ぎは外す）", r.countries, ["アメリカ", "ブラジル"]);
check("都道府県", r.prefectures, ["東京都"]);
const china = r.details.countries.find((c) => c.name === "中国");
check("中国は乗り継ぎ", china.status, "transit");
check("エチオピアは空港の地図から入ったので乗り継ぎ", r.details.countries.find((c) => c.name === "エチオピア").status, "transit");
const us = r.details.countries.find((c) => c.name === "アメリカ");
check("アメリカの出どころは2つの旅", us.sources.map((s) => [s.tripTitle, s.dates]), [["ブラジル・アルゼンチン", ["2026-01-02"]], ["LA", ["2026-02-01"]]]);

// 旅行ごとの一覧（tripPlaces）：乗り継ぎだけの中国・エチオピアは含まれない
check("t1の訪れた場所", r.tripPlaces.find((t) => t.tripId === "t1").countries, [{ name: "アメリカ", excluded: false }, { name: "ブラジル", excluded: false }]);
check("t2の訪れた場所（国）", r.tripPlaces.find((t) => t.tripId === "t2").countries, [{ name: "アメリカ", excluded: false }]);
check("t2の訪れた場所（都道府県）", r.tripPlaces.find((t) => t.tripId === "t2").prefectures, [{ name: "東京都", excluded: false }]);

// 本人が旅行ごとに外す・戻す（2026-09-28〜）：t1のアメリカだけ外す→t1には残らないがt2のアメリカ・総計には影響しない
const r2 = aggregateVisitedPlaces({ days, blocks, coords, trips, tripOverrides: [
  { tripId: "t1", kind: "country", name: "アメリカ合衆国" },
] });
check("t1だけ外しても総計のアメリカは残る（t2でまだ数えている）", r2.countries, ["アメリカ", "ブラジル"]);
check("t1のアメリカはexcluded:trueで残る（消えない・戻せる）", r2.tripPlaces.find((t) => t.tripId === "t1").countries, [{ name: "アメリカ", excluded: true }, { name: "ブラジル", excluded: false }]);
check("t2のアメリカはそのまま", r2.tripPlaces.find((t) => t.tripId === "t2").countries, [{ name: "アメリカ", excluded: false }]);
const usAfterOneExclude = r2.details.countries.find((c) => c.name === "アメリカ");
check("片方だけ外しても全体のstatusはvisibleのまま", usAfterOneExclude.status, "visible");

// 出てくる全部の旅行で外すと、総計から落ちる
const r3exclude = aggregateVisitedPlaces({ days, blocks, coords, trips, tripOverrides: [
  { tripId: "t1", kind: "country", name: "アメリカ合衆国" },
  { tripId: "t2", kind: "country", name: "アメリカ" },
] });
check("両方の旅行で外すと総計から落ちる", r3exclude.countries, ["ブラジル"]);
check("status はexcluded", r3exclude.details.countries.find((c) => c.name === "アメリカ").status, "excluded");

// 戻す＝overrideを外す操作なので、外す前の結果に戻る
const restored = aggregateVisitedPlaces({ days, blocks, coords, trips, tripOverrides: [] });
check("戻すと外す前と同じ結果になる", restored.countries, r.countries);

// 地図の無い日（場所だけ）は数える
const r3 = aggregateVisitedPlaces({ days: [{ tripId: "t2", date: "2026-02-09", admin1: "", country: "カナダ", lat: 49, lon: -123 }], blocks: [], trips });
check("予定の無い日は数える", r3.countries, ["カナダ"]);

console.log(`visited-places: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
