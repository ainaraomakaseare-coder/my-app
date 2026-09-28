/*
 * 香港・マカオを「中国」と分けて数えるための、座標だけを見る純粋関数（2026-09-28〜）。
 *
 * オーナー報告：ブラジル旅行（trip_4fc221e877b24b95aa8c4f1f1b39c824）の香港経由の乗り継ぎ
 * （香港の空港～香港島あたり）が、entries.map_country・day_infos.country どちらにも「中国」として
 * 保存されていた（reverseGeocodeがNominatimの address.country をそのまま使っていたため。
 * 現在はindex.jsのresolveNominatimCountry()でcountry_code・ISO3166-2から香港・マカオを
 * 分けて新規保存するようにしたが、すでに保存済みのデータはそのままでは直らない）。
 * このモジュールは、すでに「中国」として保存されている座標を集計の時点で見直すためのもの
 * （DBの値は書き換えない。worker/src/visited-places.js の集計にだけ使う）。
 *
 * 香港・マカオは、世界地図（world-atlas 110m）にはどちらも独立した図形が無い（香港特別行政区は
 * 「中国」の図形に含まれる）ため、この分離をしても地図上は「中国」の塗りのままになるが、一覧
 * （アジア）には香港・マカオとして別に出る。これは110mの解像度の限界で、今回は対応しない。
 *
 * 境界値の注意（bboxは大まかな矩形なので、行政区分の境界そのものではない）：
 * - 深圳（22.54, 114.06）は香港のbboxの北端に近く、単純な矩形だと香港に誤判定してしまうため、
 *   香港のbboxの緯度上限を22.515に切り詰めている（香港本土の北端・沙頭角あたりより少し南）。
 * - 珠海（22.27, 113.57）はマカオの少し北西だが、マカオのbbox（緯度22.10〜22.22）の外なので
 *   矩形のままで中国のまま判定できる（マカオのbboxの経度範囲がそもそも香港と重ならないので、
 *   重なりの心配もない：マカオは113.61より西、香港は113.82より東）。
 */

// 香港のbbox（本土・空港・離島を含み、深圳を除くよう緯度上限を切り詰めている）
const HONG_KONG_BBOX = { latMin: 22.13, latMax: 22.515, lngMin: 113.82, lngMax: 114.45 };
// マカオのbbox（マカオ半島・タイパ・コロアン。珠海より南）
const MACAU_BBOX = { latMin: 22.10, latMax: 22.22, lngMin: 113.52, lngMax: 113.61 };

function inBbox(lat, lng, box) {
  return typeof lat === "number" && typeof lng === "number" &&
    lat >= box.latMin && lat <= box.latMax && lng >= box.lngMin && lng <= box.lngMax;
}

/*
 * country: すでに保存されている国名（canonicalCountry適用後を想定。「中国」のときだけ見直す）
 * lat, lng: その場所の座標
 * 返り値: 上書き後の国名（該当しなければcountryをそのまま返す）
 */
export function overrideCountryByCoords(country, lat, lng) {
  if (country !== "中国") return country;
  if (inBbox(lat, lng, MACAU_BBOX)) return "マカオ";
  if (inBbox(lat, lng, HONG_KONG_BBOX)) return "香港";
  return country;
}
