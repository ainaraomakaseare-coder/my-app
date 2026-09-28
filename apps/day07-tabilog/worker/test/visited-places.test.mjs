/*
 * マイログの「訪れた都道府県・国」の集計（src/visited-places.js）の単体テスト。
 * 実行: node worker/test/visited-places.test.mjs
 */
import assert from "node:assert/strict";
import { canonicalCountry, canonicalPrefecture, isTransitBlock, aggregateVisitedPlaces, haversineKm, filterFallbackDayRows } from "../src/visited-places.js";

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

// 記録の地図の座標から直接入れた場所（mapVisits）：transitはisTransitDayの当てずっぽうを介さず、
// 呼び出し側が確定させて渡す（2026-09-28〜）
const rMap = aggregateVisitedPlaces({
  days: [
    { tripId: "t3", date: "2026-03-01", admin1: "大阪府", country: "日本", lat: 34.6656, lon: 135.4325, transit: false },
    { tripId: "t3", date: "2026-03-01", admin1: "兵庫県", country: "日本", lat: 34.8, lon: 135.2, transit: false },
    { tripId: "t3", date: "2026-03-02", admin1: "千葉県", country: "日本", lat: 35.77, lon: 140.39, transit: true }, // 空港を経由しただけ
  ],
  blocks: [],
  trips: { t3: "大阪旅行" },
});
check("mapVisitsは1日に複数の場所を持てる", rMap.prefectures, ["大阪府", "兵庫県"]);
check("mapVisitsのtransit:trueはブロック照合なしでも乗り継ぎ扱いになり、総計には出ない", rMap.prefectures.includes("千葉県"), false);
check("ただしdetailsにはtransitとして残る", rMap.details.prefectures.find((p) => p.name === "千葉県").status, "transit");

// haversineKm：おおよその実距離で確認（新大阪〜東京駅は直線で約400km、大阪〜オーランドは1万km超）
check("新大阪〜東京は概ね400km前後", Math.round(haversineKm({ lat: 34.7335, lng: 135.5003 }, { lat: 35.6812, lng: 139.7671 }) / 50) * 50, 400);
check("大阪〜オーランドは1000kmよりずっと遠い", haversineKm({ lat: 34.6656, lng: 135.4325 }, { lat: 28.4744, lng: -81.4683 }) > 1000, true);
check("同じ地点は0km", haversineKm({ lat: 35, lng: 135 }, { lat: 35, lng: 135 }), 0);

// filterFallbackDayRows：day_infos（1日1か所の古い仕組み）は、mapVisitsが無い日の補完としてだけ使う
// （オーナー報告：大阪旅行の2026-09-19のday_infos行が、過去の誤った自動配置でフロリダの座標になっていた）
const dayRowsOsakaTrip = [
  // 2026-09-19：day_infosは間違ってフロリダ（ユニバーサル・オーランド）を指しているが、
  // 同じ日にmapVisits（実際のUSJ・大阪）があるので、この行はまるごと無視されるべき
  { tripId: "trip1", date: "2026-09-19", admin1: "", country: "アメリカ", lat: 28.4744, lon: -81.4683 },
  // 2026-09-20・21：甲子園（実在の座標だが、admin1/countryが空＝reverse-geocodeされていない）
  { tripId: "trip1", date: "2026-09-20", admin1: "", country: "", lat: 34.70894, lon: 135.34692 },
  { tripId: "trip1", date: "2026-09-21", admin1: "", country: "", lat: 34.70894, lon: 135.34692 },
  // 2026-09-22：mapVisitsの無い日で、admin1/countryが入っている・大阪から近い→残す
  { tripId: "trip1", date: "2026-09-22", admin1: "兵庫県", country: "日本", lat: 34.8, lon: 135.2 },
  // 2026-09-23：mapVisitsの無い日だが、旅行のどの地図点からも1000km以上離れている→無視する
  { tripId: "trip1", date: "2026-09-23", admin1: "", country: "アメリカ", lat: 40.7, lon: -74.0 },
];
const mapVisitsOsakaTrip = [
  { tripId: "trip1", date: "2026-09-19", lat: 34.6656, lng: 135.4325 }, // USJ
  { tripId: "trip1", date: "2026-09-19", lat: 34.7335, lng: 135.5003 }, // 新大阪
];
const filtered = filterFallbackDayRows(dayRowsOsakaTrip, mapVisitsOsakaTrip);
check("mapVisitsで既に分かっている日のday_infos行（フロリダの誤り）は無視される", filtered.some((d) => d.date === "2026-09-19"), false);
check("admin1・countryが空の行は無視される", filtered.some((d) => d.date === "2026-09-20" || d.date === "2026-09-21"), false);
check("mapVisitsの無い日で、近く・情報ありなら残す", filtered.some((d) => d.date === "2026-09-22"), true);
check("mapVisitsのどの点からも1000km以上離れた行は無視される", filtered.some((d) => d.date === "2026-09-23"), false);
check("残るのは2026-09-22だけ", filtered.map((d) => d.date), ["2026-09-22"]);

// 旅行をまたいでは影響しない（trip2にはmapVisitsが無いので、trip2のday_infosはそのまま残る）
const filteredMultiTrip = filterFallbackDayRows(
  [{ tripId: "trip2", date: "2026-09-19", admin1: "東京都", country: "日本", lat: 35.68, lon: 139.77 }],
  mapVisitsOsakaTrip
);
check("別の旅行のday_infosはtrip1のmapVisitsに影響されない", filteredMultiTrip.length, 1);

console.log(`visited-places: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
