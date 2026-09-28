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
// オーナー報告（2026-09-28）：スイス・ベルギー旅行のベルギーが「行ったことある旅先」の総計から漏れていた
check("ベルギー王国→ベルギー", canonicalCountry("ベルギー王国"), "ベルギー");
check("Belgium→ベルギー", canonicalCountry("Belgium"), "ベルギー");
check("Belgique→ベルギー", canonicalCountry("Belgique"), "ベルギー");
check("België→ベルギー", canonicalCountry("België"), "ベルギー");
check("スイス連邦→スイス", canonicalCountry("スイス連邦"), "スイス");
check("Switzerland→スイス", canonicalCountry("Switzerland"), "スイス");
check("Schweiz→スイス", canonicalCountry("Schweiz"), "スイス");
check("Suisse→スイス", canonicalCountry("Suisse"), "スイス");
check("Svizzera→スイス", canonicalCountry("Svizzera"), "スイス");

// 都道府県
check("東京→東京都", canonicalPrefecture("東京"), "東京都");
check("東京都→東京都", canonicalPrefecture("東京都"), "東京都");
check("大阪→大阪府", canonicalPrefecture("大阪"), "大阪府");
check("北海→そのまま", canonicalPrefecture("北海"), "北海");

// 乗り継ぎの予定（2026-09-28〜：category==='transport'だけを乗り継ぎとする。ラベルに「空港」「到着」
// などの語を含むだけの観光・食事の予定まで乗り継ぎ扱いにしてしまい、実際に訪れた場所が集計から落ちる
// 誤判定を生んでいたため、判定をcategoryだけに絞った）
check("移動は乗り継ぎ扱い", isTransitBlock({ category: "transport", label: "LAX→JFK" }), true);
check("到着は乗り継ぎではない（着いた場所の予定として数える）", isTransitBlock({ category: "arrival", label: "着いた" }), false);
check("空港の食事も乗り継ぎではない（ラベルだけでは判定しない）", isTransitBlock({ category: "food", label: "北京首都空港でラーメン" }), false);
check("宿泊は空港でも違う", isTransitBlock({ category: "lodging", label: "空港ホテル" }), false);
check("観光はちがう", isTransitBlock({ category: "sightseeing", label: "自由の女神" }), false);

// 集計
const trips = { t1: "ブラジル・アルゼンチン", t2: "LA" };
const days = [
  { tripId: "t1", date: "2026-01-01", admin1: "", country: "中華人民共和国", lat: 40.08, lon: 116.58 }, // 北京で乗り継ぎ
  { tripId: "t1", date: "2026-01-02", admin1: "New York", country: "アメリカ合衆国", lat: 40.7, lon: -74.0 },
  { tripId: "t1", date: "2026-01-03", admin1: "", country: "ブラジル", lat: -25.6, lon: -54.4 },
  { tripId: "t1", date: "2026-01-04", admin1: "", country: "エチオピア", lat: 8.97, lon: 38.79 }, // 移動（乗り継ぎ）の地図から入った
  { tripId: "t2", date: "2026-02-01", admin1: "California", country: "アメリカ", lat: 34.0, lon: -118.2 },
  { tripId: "t2", date: "2026-02-05", admin1: "東京", country: "日本", lat: 35.5, lon: 139.8 },
];
const blocks = [
  { id: "b1", tripId: "t1", date: "2026-01-01", category: "transport", label: "北京で乗り継ぎ" },
  { id: "b2", tripId: "t1", date: "2026-01-02", category: "sightseeing", label: "タイムズスクエア" },
  { id: "b3", tripId: "t1", date: "2026-01-03", category: "sightseeing", label: "イグアスの滝" },
  { id: "b4a", tripId: "t1", date: "2026-01-04", category: "transport", label: "アディスアベバ空港で乗り継ぎ" },
  { id: "b4b", tripId: "t1", date: "2026-01-04", category: "sightseeing", label: "ブエノスアイレス" },
  { id: "b5", tripId: "t2", date: "2026-02-01", category: "food", label: "In-N-Out" },
];
const coords = { b4a: [{ lat: 8.97, lng: 38.79 }], b4b: [{ lat: -34.6, lng: -58.4 }] };
// t1の出発日・帰着日（2026-09-28〜：前後の日と違う国でも、出発・帰着日ならそのまま乗り継ぎ扱いにする
// ためtripBoundsが要る。北京（01-01・初日）・エチオピア（01-04・最終日）はどちらも境界日）
const tripBounds = { t1: { startDate: "2026-01-01", endDate: "2026-01-04" }, t2: { startDate: "2026-02-01", endDate: "2026-02-05" } };
const r = aggregateVisitedPlaces({ days, blocks, coords, trips, tripBounds });
check("行った国（表記ゆれをまとめ、乗り継ぎは外す）", r.countries, ["アメリカ", "ブラジル"]);
check("都道府県", r.prefectures, ["東京都"]);
const china = r.details.countries.find((c) => c.name === "中国");
check("中国は乗り継ぎ", china.status, "transit");
check("エチオピアは移動（乗り継ぎ）の地図から入ったので乗り継ぎ", r.details.countries.find((c) => c.name === "エチオピア").status, "transit");
const us = r.details.countries.find((c) => c.name === "アメリカ");
check("アメリカの出どころは2つの旅", us.sources.map((s) => [s.tripTitle, s.dates]), [["ブラジル・アルゼンチン", ["2026-01-02"]], ["LA", ["2026-02-01"]]]);

// 旅行ごとの一覧（tripPlaces）：乗り継ぎだけの中国・エチオピアは含まれない
check("t1の訪れた場所", r.tripPlaces.find((t) => t.tripId === "t1").countries, [{ name: "アメリカ", excluded: false }, { name: "ブラジル", excluded: false }]);
check("t2の訪れた場所（国）", r.tripPlaces.find((t) => t.tripId === "t2").countries, [{ name: "アメリカ", excluded: false }]);
check("t2の訪れた場所（都道府県）", r.tripPlaces.find((t) => t.tripId === "t2").prefectures, [{ name: "東京都", excluded: false }]);

// 本人が旅行ごとに外す・戻す（2026-09-28〜）：t1のアメリカだけ外す→t1には残らないがt2のアメリカ・総計には影響しない
const r2 = aggregateVisitedPlaces({ days, blocks, coords, trips, tripBounds, tripOverrides: [
  { tripId: "t1", kind: "country", name: "アメリカ合衆国" },
] });
check("t1だけ外しても総計のアメリカは残る（t2でまだ数えている）", r2.countries, ["アメリカ", "ブラジル"]);
check("t1のアメリカはexcluded:trueで残る（消えない・戻せる）", r2.tripPlaces.find((t) => t.tripId === "t1").countries, [{ name: "アメリカ", excluded: true }, { name: "ブラジル", excluded: false }]);
check("t2のアメリカはそのまま", r2.tripPlaces.find((t) => t.tripId === "t2").countries, [{ name: "アメリカ", excluded: false }]);
const usAfterOneExclude = r2.details.countries.find((c) => c.name === "アメリカ");
check("片方だけ外しても全体のstatusはvisibleのまま", usAfterOneExclude.status, "visible");

// 出てくる全部の旅行で外すと、総計から落ちる
const r3exclude = aggregateVisitedPlaces({ days, blocks, coords, trips, tripBounds, tripOverrides: [
  { tripId: "t1", kind: "country", name: "アメリカ合衆国" },
  { tripId: "t2", kind: "country", name: "アメリカ" },
] });
check("両方の旅行で外すと総計から落ちる", r3exclude.countries, ["ブラジル"]);
check("status はexcluded", r3exclude.details.countries.find((c) => c.name === "アメリカ").status, "excluded");

// 戻す＝overrideを外す操作なので、外す前の結果に戻る
const restored = aggregateVisitedPlaces({ days, blocks, coords, trips, tripBounds, tripOverrides: [] });
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

// 大阪旅行（オーナー報告の再現）：同じ日・別の日にまたがる複数の都道府県（食事・観光・「到着」ラベルの
// 予定）が、乗り継ぎ扱いにならずに全部残ること（2026-09-28、isTransitBlockをcategory==='transport'だけに
// 絞った直し方の確認）。getVisitedPlacesが各記録の地図の座標をreverseGeocodeした結果として渡す
// day（transitはそのentryが属するblockのisTransitBlockで確定済み）を模している。
const osakaDays = [
  { tripId: "osaka", date: "2026-09-20", admin1: "大阪府", country: "日本", lat: 34.6656, lon: 135.4325, transit: false }, // USJ
  { tripId: "osaka", date: "2026-09-20", admin1: "兵庫県", country: "日本", lat: 34.693, lon: 135.192, transit: false }, // 神戸牛ランチ（food）
  { tripId: "osaka", date: "2026-09-20", admin1: "兵庫県", country: "日本", lat: 34.691, lon: 135.191, transit: false }, // 三宮フリータイム（sightseeing）
  { tripId: "osaka", date: "2026-09-20", admin1: "兵庫県", country: "日本", lat: 34.721, lon: 135.362, transit: false }, // 横浜vs阪神＠甲子園（sightseeing）
  { tripId: "osaka", date: "2026-09-21", admin1: "兵庫県", country: "日本", lat: 34.721, lon: 135.362, transit: false }, // 横浜阪神（sightseeing）
  { tripId: "osaka", date: "2026-09-21", admin1: "神奈川県", country: "日本", lat: 35.507, lon: 139.617, transit: false }, // 新横浜駅到着（other、ラベルに「到着」を含むが乗り継ぎではない）
  { tripId: "osaka", date: "2026-09-21", admin1: "神奈川県", country: "日本", lat: 35.453, lon: 139.643, transit: true }, // みなとみらい発（transport＝乗り継ぎ）
];
const rOsaka = aggregateVisitedPlaces({ days: osakaDays, blocks: [], trips: { osaka: "大阪旅行" } });
check("大阪旅行：大阪府・兵庫県・神奈川県が全部残る（食事・観光・到着ラベルの予定は乗り継ぎにならない）",
  rOsaka.prefectures, ["神奈川県", "大阪府", "兵庫県"]);
check("大阪旅行の旅行ごとの一覧も総計と同じ3つ",
  rOsaka.tripPlaces.find((t) => t.tripId === "osaka").prefectures.map((p) => p.name).sort((a, b) => a.localeCompare(b, "ja")),
  rOsaka.prefectures);

// ブラジル・アルゼンチン旅行（オーナー報告の再現）：マイログのチップ（tripPlaces）には
// 「アメリカ・アルゼンチン・ブラジル」と出るのに、「行ったことある旅先」の総計・世界地図では
// 「2か国（アメリカ・ブラジル）」だけでアルゼンチンが抜けていた、という食い違い。総計（countries）を
// tripPlacesの和集合として作るようにしたので（aggregateVisitedPlaces参照）、この2つが食い違うことは
// 構造的に無くなっているはずであることを確認する（イグアスの滝：ブラジル側の観光のあと、乗り継ぎの
// バスでアルゼンチン側の国境を越え、アルゼンチン側でも観光した、という想定）。
const argentinaDays = [
  { tripId: "arg", date: "2026-04-01", admin1: "", country: "ブラジル", lat: -25.6, lon: -54.4, transit: false }, // イグアスの滝（ブラジル側）
  { tripId: "arg", date: "2026-04-02", admin1: "", country: "アルゼンチン", lat: -25.68, lon: -54.44, transit: true }, // 国境バス（transport）
  { tripId: "arg", date: "2026-04-02", admin1: "", country: "アルゼンチン", lat: -25.7, lon: -54.47, transit: false }, // イグアスの滝（アルゼンチン側、観光）
  { tripId: "us", date: "2026-05-01", admin1: "California", country: "アメリカ", lat: 34.0, lon: -118.2, transit: false },
];
const rArg = aggregateVisitedPlaces({ days: argentinaDays, blocks: [], trips: { arg: "ブラジル・アルゼンチン", us: "LA" } });
check("総計にアルゼンチンが出る（tripPlacesと食い違わない）", rArg.countries, ["アメリカ", "アルゼンチン", "ブラジル"]);
check("tripPlacesにもアルゼンチンが出る", rArg.tripPlaces.find((t) => t.tripId === "arg").countries.map((c) => c.name).sort((a, b) => a.localeCompare(b, "ja")), ["アルゼンチン", "ブラジル"]);
check("総計はtripPlaces（除外されていないもの）の和集合と一致する", rArg.countries, Array.from(new Set(
  rArg.tripPlaces.flatMap((t) => t.countries.filter((c) => !c.excluded).map((c) => c.name))
)).sort((a, b) => a.localeCompare(b, "ja")));

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

// ==== 実際の3つの旅行の形（2026-09-28、フォローアップ修正の確認）====
// getVisitedPlacesが渡す形（mapVisits＝各entryの座標から求めた場所、transitはそのentryのBlockの
// categoryで確定済み／day_infosの補完＝filterFallbackDayRowsを通した後）を模している。

// 1) スイス・ベルギー旅行（trip_a031672093364d19b2f7f74a1922afa1）：ベルギーの唯一の地図点
// （2025-09-17「ブリュッセル出発」）が移動の予定（category=transport）から入っているため、
// そのままではtransit:trueになる。前の日（2025-09-15、ジュネーブ＝スイス）と国が違い、
// 旅行の帰着日（2025-09-18）でもないので、ベルギーに泊まった日として数える。
const swissBounds = { swiss: { startDate: "2025-09-11", endDate: "2025-09-18" } };
const swissMapVisits = [
  { tripId: "swiss", date: "2025-09-11", admin1: "ベルン州", country: "スイス", lat: 47.4617, lon: 8.5509, transit: false }, // チューリッヒ到着
  { tripId: "swiss", date: "2025-09-15", admin1: "ジュネーヴ州", country: "スイス", lat: 46.2074, lon: 6.1559, transit: false }, // ジュネーブ市内
  { tripId: "swiss", date: "2025-09-17", admin1: "Vlaams-Brabant", country: "ベルギー", lat: 50.9002, lon: 4.4859, transit: true }, // ブリュッセル出発（transport）
];
// day_infosの補完（09-12〜14：ツェルマット／ヴァレー州・スイス。mapVisitsに無い日だけ残る）
const swissDayInfos = [
  { tripId: "swiss", date: "2025-09-12", admin1: "ヴァレー州", country: "スイス", lat: 46.02, lon: 7.75 },
  { tripId: "swiss", date: "2025-09-13", admin1: "ヴァレー州", country: "スイス", lat: 45.99, lon: 7.75 },
  { tripId: "swiss", date: "2025-09-14", admin1: "ヴァレー州", country: "スイス", lat: 46.02, lon: 7.75 },
];
const swissFallback = filterFallbackDayRows(
  swissDayInfos,
  swissMapVisits.map((v) => ({ tripId: v.tripId, date: v.date, lat: v.lat, lng: v.lon }))
);
const rSwiss = aggregateVisitedPlaces({
  days: swissMapVisits.concat(swissFallback), blocks: [], trips: { swiss: "スイス・ベルギー旅行" }, tripBounds: swissBounds,
});
check("スイス・ベルギー旅行：総計にベルギーが出る（唯一の地図点が乗り継ぎの予定でも、前日と違う国・帰着日でもないので数える）",
  rSwiss.countries, ["スイス", "ベルギー"]);
check("ベルギーのstatusはvisible（乗り継ぎ扱いのまま落ちない）", rSwiss.details.countries.find((c) => c.name === "ベルギー").status, "visible");

// 2) ブラジル・アルゼンチン旅行（trip_4fc221e877b24b95aa8c4f1f1b39c824）：出発日（2024-02-10）・
// 帰着日（2024-02-19）はどちらも成田（千葉県）で、乗り継ぎの予定しか無い＝旅行の境界日なので、
// 前後の日と国が違っても「行った」に数えない（千葉県が毎回の旅行の行き帰りで紛れ込むのを防ぐ）。
const brazilBounds = { brazil: { startDate: "2024-02-10", endDate: "2024-02-19" } };
const brazilDays = [
  { tripId: "brazil", date: "2024-02-10", admin1: "千葉県", country: "日本", transit: true }, // 成田空港出発（出発日）
  { tripId: "brazil", date: "2024-02-11", admin1: "リオデジャネイロ州", country: "ブラジル", transit: false },
  { tripId: "brazil", date: "2024-02-12", admin1: "リオ デ ジャネイロ", country: "ブラジル", transit: false },
  { tripId: "brazil", date: "2024-02-16", admin1: "サンタクルス州", country: "アルゼンチン", transit: false },
  { tripId: "brazil", date: "2024-02-19", admin1: "千葉県", country: "日本", transit: true }, // 成田空港到着（帰着日）
];
const rBrazil = aggregateVisitedPlaces({ days: brazilDays, blocks: [], trips: { brazil: "ブラジル・アルゼンチン" }, tripBounds: brazilBounds });
check("ブラジル旅行：出発・帰着日の千葉県は数えない（乗り継ぎの空港のまま）", rBrazil.prefectures.includes("千葉県"), false);
check("ブラジル旅行：ブラジル・アルゼンチンは数える", rBrazil.countries, ["アルゼンチン", "ブラジル"]);

// 3) 同じブラジル旅行：2024-02-14「ブエノスアイレス到着」の記録は地図URLが壊れていた
// （query=undefined,undefined）ため、getVisitedPlaces側でmapVisits・day_infos補完のどちらにも
// 使わない（hasBrokenMapQuery、geo-decode.test.mjs参照）。ここでは、そのentryを一切含めずに渡した
// ときに、同じ日の別の地図点（氷河ツアー＝パタゴニア・アルゼンチン、正しい座標）だけで正しく
// アルゼンチンとして数えられ、day_infosの誤った記録（過去にその壊れたentryの座標から自動で入った
// 「エチオピア」）はmapVisitsに置き換えられて捨てられることを確認する（filterFallbackDayRows）。
const brazilDay14MapVisits = [
  // 氷河ツアー（正しい座標、アルゼンチン・パタゴニア）。壊れたentry（ブエノスアイレス到着）は
  // hasBrokenMapQueryで弾かれ、そもそもmapVisitsに入ってこない想定なのでここには含めない
  { tripId: "brazil", date: "2024-02-14", admin1: "サンタクルス州", country: "アルゼンチン", lat: -50.4967, lon: -73.1377, transit: false },
];
const brazilDay14DayInfosFallbackCandidate = [
  // day_infosには、壊れたentryの座標から過去に自動で入ってしまった誤った記録（エチオピア）が
  // まだ残っている想定。mapVisitsが同じ日を正しく持っているので、filterFallbackDayRowsで丸ごと無視される
  { tripId: "brazil", date: "2024-02-14", admin1: "アディスアベバ", country: "エチオピア", lat: 9.0143, lon: 38.7255 },
];
const brazilDay14Fallback = filterFallbackDayRows(
  brazilDay14DayInfosFallbackCandidate,
  brazilDay14MapVisits.map((v) => ({ tripId: v.tripId, date: v.date, lat: v.lat, lng: v.lon }))
);
check("壊れたentryの座標由来のday_infos行（エチオピア）は、同じ日の正しいmapVisitsがあるので無視される",
  brazilDay14Fallback.length, 0);
const rBrazilDay14 = aggregateVisitedPlaces({
  days: brazilDay14MapVisits.concat(brazilDay14Fallback), blocks: [], trips: { brazil: "ブラジル・アルゼンチン" }, tripBounds: brazilBounds,
});
check("エチオピアは出てこない（壊れた地図URLのentryを除いたので、そもそも入力に無い）",
  rBrazilDay14.countries.includes("エチオピア"), false);
check("2024-02-14はアルゼンチンとして数えられる", rBrazilDay14.countries, ["アルゼンチン"]);

console.log(`visited-places: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
