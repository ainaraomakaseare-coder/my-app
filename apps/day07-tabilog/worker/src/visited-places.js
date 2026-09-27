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
 * - それでも間違っている国は、本人が外せる（mylog_place_overrides の mode='hide'）。
 *   乗り継ぎと判定した国を、逆に数えることもできる（mode='show'）
 */

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
 * overrides: [{ kind: 'country'|'prefecture', name, mode: 'hide'|'show' }]
 *
 * 返り値: { prefectures: string[], countries: string[], details: { prefectures, countries } }
 *   prefectures/countries は画面に「行った」と出すもの（古いアプリもこれだけを読む）。
 *   details の各要素: { name, status: 'visible'|'hidden'|'transit', sources: [{ tripId, tripTitle, dates, transit }] }
 */
export function aggregateVisitedPlaces({ days = [], blocks = [], coords = {}, trips = {}, overrides = [] } = {}) {
  const blocksByDay = new Map();
  blocks.forEach((b) => {
    const k = b.tripId + "|" + b.date;
    if (!blocksByDay.has(k)) blocksByDay.set(k, []);
    blocksByDay.get(k).push(b);
  });

  const isTransitDay = (d) => {
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

  const mode = { prefecture: new Map(), country: new Map() };
  overrides.forEach((o) => {
    if (mode[o.kind]) mode[o.kind].set(o.kind === "country" ? canonicalCountry(o.name) : canonicalPrefecture(o.name), o.mode);
  });

  const build = (kind) => Array.from(groups[kind].entries()).map(([name, byTrip]) => {
    const sources = Array.from(byTrip.values()).map((s) => ({
      tripId: s.tripId,
      tripTitle: s.tripTitle,
      dates: Array.from(new Set([...s.dates, ...s.transitDates])).sort(),
      transit: s.dates.size === 0,
    }));
    const counted = sources.some((s) => !s.transit);
    const m = mode[kind].get(name);
    const status = m === "hide" ? "hidden" : counted || m === "show" ? "visible" : "transit";
    return { name, status, sources };
  }).sort((a, b) => a.name.localeCompare(b.name, "ja"));

  const details = { prefectures: build("prefecture"), countries: build("country") };
  const visible = (list) => list.filter((x) => x.status === "visible").map((x) => x.name);
  return { prefectures: visible(details.prefectures), countries: visible(details.countries), details };
}
