/*
 * マイログの「訪れた都道府県・国」の集計（2026-09-27〜）。DB・fetchを使わない純粋関数だけを置き、
 * nodeでそのまま単体テストできるようにしている（worker/test/visited-places.test.mjs）。
 *
 * 元データは day_infos（日ごとの場所。その日の最初の地図の位置から自動で入れている）。
 * そのままだと次のことが起きていた：
 * - 同じ国が別の名前で出る（Nominatimは「アメリカ合衆国」、Open-Meteoは「アメリカ」など）
 *   → canonicalCountry で1つの名前にまとめる
 * - 乗り継ぎで空港にいただけの国が数えられる（中国など）
 *   → その日の場所が「移動の予定」（空港・乗り継ぎ）の地図から入ったものなら数えない
 * - それでも間違っている場所は、本人が旅行ごとに外せる（mylog_trip_place_overrides。2026-09-28〜）。
 *   例：東京都を含む2つの旅行のうち片方だけから東京都を外す、といった旅行単位の操作。
 *   総計（prefectures/countries）は「その場所が出てくる全部の旅行で外されている」ときだけ落ちる
 *   （どれか1つの旅行で数えていれば、総計には残る）。
 *   旧版（mylog_place_overrides、アカウント全体でhide/show）は、片方の旅行だけから外したくても
 *   全部の旅行から消えてしまう不具合があったため廃止。テーブル・APIは残すが、この集計では使わない
 *   （docs/adr/0016）。
 * - day_infos（1日1か所）は、2026-09-28〜、記録の地図の座標から直接求めた場所（mapVisits。1日に
 *   複数でも良い・より正確）が無い日だけの補完にした。オーナー報告（大阪旅行に大阪府が出ない）の
 *   原因が、day_infosの誤った座標（フロリダ）だったため。filterFallbackDayRows参照。
 */

import { distanceKm } from "./geo-decode.js";

// [まとめた後の名前, ...別名]。完全一致（前後の空白を除き、NFKC正規化したあと）で引く
const COUNTRY_ALIASES = [
  ["日本", "日本国", "Japan", "にほん", "にっぽん"],
  ["アメリカ", "アメリカ合衆国", "米国", "アメリカ合衆国（米国）", "United States", "United States of America", "USA", "U.S.A.", "US", "U.S.", "Estados Unidos"],
  ["中国", "中華人民共和国", "China", "People's Republic of China", "中国大陸"],
  ["台湾", "中華民国", "中華民國", "臺灣", "Taiwan"],
  ["香港", "中華人民共和国香港特別行政区", "香港特別行政区", "Hong Kong"],
  ["マカオ", "中華人民共和国マカオ特別行政区", "マカオ特別行政区", "澳門", "Macao", "Macau"],
  ["韓国", "大韓民国", "South Korea", "Korea", "Republic of Korea", "한국", "대한민국"],
  ["北朝鮮", "朝鮮民主主義人民共和国", "North Korea"],
  ["イギリス", "英国", "グレートブリテン及び北アイルランド連合王国", "連合王国", "United Kingdom", "UK", "Great Britain"],
  ["ロシア", "ロシア連邦", "Russia"],
  ["ドイツ", "ドイツ連邦共和国", "Germany", "Deutschland"],
  ["フランス", "フランス共和国", "France"],
  ["イタリア", "イタリア共和国", "Italy", "Italia"],
  ["スペイン", "スペイン王国", "Spain", "España"],
  ["ポルトガル", "ポルトガル共和国", "Portugal"],
  ["オランダ", "オランダ王国", "Netherlands", "Nederland"],
  ["スイス", "スイス連邦", "Switzerland"],
  ["オーストリア", "オーストリア共和国", "Austria"],
  ["ブラジル", "ブラジル連邦共和国", "Brazil", "Brasil"],
  ["アルゼンチン", "アルゼンチン共和国", "Argentina"],
  ["メキシコ", "メキシコ合衆国", "Mexico", "México"],
  ["カナダ", "Canada"],
  ["ペルー", "ペルー共和国", "Peru", "Perú"],
  ["チリ", "チリ共和国", "Chile"],
  ["オーストラリア", "オーストラリア連邦", "Australia"],
  ["ニュージーランド", "New Zealand"],
  ["タイ", "タイ王国", "Thailand", "ประเทศไทย"],
  ["ベトナム", "ベトナム社会主義共和国", "Vietnam", "Viet Nam", "Việt Nam"],
  ["フィリピン", "フィリピン共和国", "Philippines"],
  ["インドネシア", "インドネシア共和国", "Indonesia"],
  ["マレーシア", "Malaysia"],
  ["シンガポール", "シンガポール共和国", "Singapore"],
  ["インド", "インド共和国", "India"],
  ["エチオピア", "エチオピア連邦民主共和国", "Ethiopia"],
  ["アラブ首長国連邦", "UAE", "United Arab Emirates"],
  ["トルコ", "トルコ共和国", "Türkiye", "Turkey"],
  ["エジプト", "エジプト・アラブ共和国", "Egypt"],
  ["カタール", "カタール国", "Qatar"],
];

// 「〜共和国」などを落とすと別の国と同じ名前になってしまうもの（表にも無ければ、このまま使う）
const KEEP_AS_IS = new Set(["ドミニカ共和国", "ドミニカ国", "コンゴ共和国", "コンゴ民主共和国", "中央アフリカ共和国"]);
const FORMAL_SUFFIX_RE = /(連邦民主共和国|社会主義共和国|連邦共和国|人民共和国|共和国|合衆国|王国|連邦)$/;

const ALIAS_MAP = new Map();
COUNTRY_ALIASES.forEach((names) => {
  names.forEach((n) => ALIAS_MAP.set(aliasKey(n), names[0]));
});

function aliasKey(s) {
  return String(s || "").normalize("NFKC").trim().toLowerCase();
}

export function canonicalCountry(name) {
  const raw = String(name || "").normalize("NFKC").trim();
  if (!raw) return "";
  const hit = ALIAS_MAP.get(aliasKey(raw));
  if (hit) return hit;
  if (KEEP_AS_IS.has(raw)) return raw;
  const short = raw.replace(FORMAL_SUFFIX_RE, "");
  if (short && short !== raw && short.length >= 2) return ALIAS_MAP.get(aliasKey(short)) || short;
  return raw;
}

export const JP_PREFECTURES = ["北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県","茨城県","栃木県","群馬県","埼玉県","千葉県","東京都","神奈川県","新潟県","富山県","石川県","福井県","山梨県","長野県","岐阜県","静岡県","愛知県","三重県","滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県","鳥取県","島根県","岡山県","広島県","山口県","徳島県","香川県","愛媛県","高知県","福岡県","佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県"];

// 「東京」「東京都」を同じ都道府県にする（都道府県名として分からないものはそのまま）
export function canonicalPrefecture(name) {
  const raw = String(name || "").normalize("NFKC").trim();
  if (!raw) return "";
  if (JP_PREFECTURES.includes(raw)) return raw;
  const hit = JP_PREFECTURES.find((p) => p.slice(0, -1) === raw && p !== "北海道");
  return hit || raw;
}

// 乗り継ぎ・空港の予定か（その日の場所がこの予定の地図から入っていたら、その国は「行った」に数えない）
const TRANSIT_LABEL_RE = /(空港|乗り継ぎ|乗継|乗りつぎ|トランジット|経由|乗り換え|乗換|airport|transit|layover|connection)/i;
export function isTransitBlock(block) {
  if (!block) return false;
  if (block.category === "lodging") return false;
  if (block.category === "transport" || block.category === "arrival") return true;
  return TRANSIT_LABEL_RE.test(String(block.label || ""));
}

const NEAR = 0.0005; // 自動で入れた場所は、予定の地図の座標そのもの

/*
 * days:    [{ tripId, date, admin1, country, lat, lon }]
 * blocks:  [{ id, tripId, date, category, label }]
 * coords:  { [blockId]: [{ lat, lng }] }  予定の地図の座標（記録ごと）
 * trips:   { [tripId]: title }
 * tripOverrides: [{ tripId, kind: 'country'|'prefecture', name }]  その旅行から外した場所（外すことだけができる）
 *
 * 返り値:
 *   { prefectures: string[], countries: string[], details: { prefectures, countries }, tripPlaces }
 *   prefectures/countries は画面に「行った」と出すもの・総計（古いアプリもこれだけを読む）。
 *     ある場所が出てくる全部の旅行で外されていれば、ここから落ちる。
 *   details の各要素: { name, status: 'visible'|'excluded'|'transit', sources: [{ tripId, tripTitle, dates, transit, excluded }] }
 *     status='excluded' は「行った記録はあるが、出てくる旅行すべてで外されている」。
 *   tripPlaces: [{ tripId, tripTitle, prefectures: [{name, excluded}], countries: [{name, excluded}] }]
 *     旅行ごとの一覧（乗り継ぎだけの日しか無い場所は含めない。外した場所も excluded:true で残す）。
 */
export function aggregateVisitedPlaces({ days = [], blocks = [], coords = {}, trips = {}, tripOverrides = [] } = {}) {
  const blocksByDay = new Map();
  blocks.forEach((b) => {
    const k = b.tripId + "|" + b.date;
    if (!blocksByDay.has(k)) blocksByDay.set(k, []);
    blocksByDay.get(k).push(b);
  });

  const isTransitDay = (d) => {
    // 記録の地図の座標から直接入れた場所（2026-09-28〜）は、どのBlockから来たかがすでに分かって
    // いるので、呼び出し側でtransitを確定させて渡してくる。その場合はここでの当てずっぽうな
    // 座標マッチングをしない（bool以外＝未確定のときだけ、従来どおりday_infos由来として調べる）
    if (typeof d.transit === "boolean") return d.transit;
    const list = blocksByDay.get(d.tripId + "|" + d.date) || [];
    if (!list.length) return false;
    // その日の予定が全部、移動・空港なら、その日は乗り継ぎ（移動だけ）の日
    if (list.every(isTransitBlock)) return true;
    if (typeof d.lat !== "number" || typeof d.lon !== "number") return false;
    // 日ごとの場所がどの予定の地図から入ったか（座標が一致するもの）。見つからなければ数える
    const matched = list.filter((b) => (coords[b.id] || []).some((c) =>
      Math.abs(c.lat - d.lat) < NEAR && Math.abs(c.lng - d.lon) < NEAR));
    return matched.length > 0 && matched.every(isTransitBlock);
  };

  const groups = { prefecture: new Map(), country: new Map() };
  const add = (kind, name, d, transit) => {
    if (!name) return;
    const g = groups[kind];
    if (!g.has(name)) g.set(name, new Map());
    const byTrip = g.get(name);
    if (!byTrip.has(d.tripId)) byTrip.set(d.tripId, { tripId: d.tripId, tripTitle: trips[d.tripId] || "", dates: new Set(), transitDates: new Set() });
    const s = byTrip.get(d.tripId);
    (transit ? s.transitDates : s.dates).add(d.date);
  };

  days.forEach((d) => {
    const country = canonicalCountry(d.country);
    const transit = isTransitDay(d);
    if (country === "日本") add("prefecture", canonicalPrefecture(d.admin1), d, transit);
    else if (country) add("country", country, d, transit);
  });

  const excludedKeys = new Set(tripOverrides.map((o) => {
    const name = o.kind === "country" ? canonicalCountry(o.name) : canonicalPrefecture(o.name);
    return o.tripId + "|" + o.kind + "|" + name;
  }));
  const isExcluded = (kind, tripId, name) => excludedKeys.has(tripId + "|" + kind + "|" + name);

  const build = (kind) => Array.from(groups[kind].entries()).map(([name, byTrip]) => {
    const sources = Array.from(byTrip.values()).map((s) => ({
      tripId: s.tripId,
      tripTitle: s.tripTitle,
      dates: Array.from(new Set([...s.dates, ...s.transitDates])).sort(),
      transit: s.dates.size === 0,
      excluded: isExcluded(kind, s.tripId, name),
    }));
    const counted = sources.some((s) => !s.transit && !s.excluded);
    const hasVisit = sources.some((s) => !s.transit);
    const status = counted ? "visible" : hasVisit ? "excluded" : "transit";
    return { name, status, sources };
  }).sort((a, b) => a.name.localeCompare(b.name, "ja"));

  const details = { prefectures: build("prefecture"), countries: build("country") };
  const visible = (list) => list.filter((x) => x.status === "visible").map((x) => x.name);

  // 旅行ごとの一覧（乗り継ぎだけの日しか無いものは含めない）
  const tripIdOrder = Object.keys(trips);
  const seenTripIds = new Set();
  ["prefecture", "country"].forEach((kind) => {
    groups[kind].forEach((byTrip) => byTrip.forEach((_, tripId) => seenTripIds.add(tripId)));
  });
  const extraTripIds = Array.from(seenTripIds).filter((id) => !tripIdOrder.includes(id)).sort();
  const allTripIds = tripIdOrder.filter((id) => seenTripIds.has(id)).concat(extraTripIds);
  const placesForTrip = (kind, tripId) => (kind === "country" ? details.countries : details.prefectures)
    .filter((x) => x.sources.some((s) => s.tripId === tripId && !s.transit))
    .map((x) => ({ name: x.name, excluded: x.sources.find((s) => s.tripId === tripId).excluded }));
  const tripPlaces = allTripIds.map((tripId) => ({
    tripId,
    tripTitle: trips[tripId] || "",
    prefectures: placesForTrip("prefecture", tripId),
    countries: placesForTrip("country", tripId),
  }));

  return { prefectures: visible(details.prefectures), countries: visible(details.countries), details, tripPlaces };
}

// 2点間の距離（km）。地図の座標のマッチング（geocodeMapUrlのnear guardなど）で使っているのと同じ
// ハーバサインの実装を再利用する（geo-decode.js）。day_infosの古い場所（手入力・以前の自動配置）が
// 明らかに別大陸の値になっている（大阪旅行なのにフロリダ、など）ときに弾くために使う。
export const haversineKm = distanceKm;

export const DAY_FALLBACK_MAX_KM = 1000;

/*
 * day_infos（1日1か所、手入力・旧自動配置）は、記録の地図の座標から直接求めた場所
 * （mapVisits、2026-09-28〜。より正確で、1日に複数の場所も持てる）が無い日だけの
 * 補完として使う。オーナー報告（大阪旅行に大阪府が出ない）の原因は、2026-09-19の
 * day_infos行が実際には無関係なフロリダの座標（過去の誤った自動配置）を持っていたこと。
 * 同じ日にmapVisitsがあればそのday_infos行は丸ごと無視し、無くてもmapVisitsから
 * 1000km以上離れていれば無視する（無関係な座標を信用しないため）。
 *
 * dayRows:   [{ tripId, date, admin1, country, lat, lon }]  day_infosの生データ
 * mapVisits: [{ tripId, date, lat, lng }]  記録の地図から求めた、位置が分かっている点
 * 返り値: 残すdayRowsだけの配列（フィルタするだけで、中身は変えない）
 */
export function filterFallbackDayRows(dayRows, mapVisits, maxKm = DAY_FALLBACK_MAX_KM) {
  const byTripDates = new Map(); // tripId -> Set(date)  mapVisitsがある日
  const byTripPoints = new Map(); // tripId -> [{lat,lng}]  mapVisitsの位置（距離チェック用）
  (mapVisits || []).forEach((v) => {
    if (!byTripDates.has(v.tripId)) byTripDates.set(v.tripId, new Set());
    byTripDates.get(v.tripId).add(v.date);
    if (typeof v.lat === "number" && typeof v.lng === "number") {
      if (!byTripPoints.has(v.tripId)) byTripPoints.set(v.tripId, []);
      byTripPoints.get(v.tripId).push({ lat: v.lat, lng: v.lng });
    }
  });

  return (dayRows || []).filter((d) => {
    if (!d.admin1 && !d.country) return false; // 何も分からない行は補完のしようがない
    const datesWithMapVisit = byTripDates.get(d.tripId);
    if (datesWithMapVisit && datesWithMapVisit.has(d.date)) return false; // その日はmapVisitsに任せる
    const points = byTripPoints.get(d.tripId);
    if (points && points.length && typeof d.lat === "number" && typeof d.lon === "number") {
      const near = points.some((p) => haversineKm({ lat: d.lat, lng: d.lon }, p) <= maxKm);
      if (!near) return false; // 同じ旅行のどのmapVisitsからも1000km以上離れている＝信用しない
    }
    return true;
  });
}
