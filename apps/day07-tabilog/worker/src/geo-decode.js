/*
 * GoogleマップのURLに座標も店名も入っていない（「Googleの内部番号」だけの）とき用の座標デコーダ。
 * 「共有」→「短縮リンク」で送られたGoogleマップのリンクを展開すると、店名も座標も無く、
 *   https://www.google.com/maps/place//data=!4m2!3m1!1s0x94f6923125f5f069:0x707c2dd60b7bd4d?...
 *   https://maps.google.com?ftid=0x80c2c64160adbc4b:0x527217f541ae2569&...
 * のような「!1s0x…:0x…」「ftid=0x…:0x…」だけが残ることがある（例：ユニオンステーション、ステーキの夕食）。
 * このコロンの前の16進数（例：0x80c2c64160adbc4b）は、その場所のS2セルIDになっていることが多く、
 * ここから大まかな座標（数百m程度）が求まる。Workers専用のグローバルを使わない純粋関数なので、
 * nodeでそのまま単体テストできる（worker/test/geo-decode.test.mjs）。
 *
 * S2セルID→緯度経度のアルゴリズムは https://s2geometry.io/ の公開仕様（Hilbert曲線の面・象限展開）どおり。
 */

const POS_TO_IJ = [[0, 1, 3, 2], [0, 2, 3, 1], [3, 2, 0, 1], [3, 1, 0, 2]];
const POS_TO_ORIENT = [1, 0, 0, 3];

function s2ToLatLng(hex) {
  let id;
  try {
    id = BigInt(hex);
  } catch {
    return null;
  }
  if (id <= 0n) return null;
  const face = Number(id >> 61n);
  if (face < 0 || face > 5) return null;
  let orient = face & 1;
  let i = 0, j = 0;
  for (let k = 0; k < 30; k++) {
    const pos = Number((id >> BigInt(59 - 2 * k)) & 3n);
    const ij = POS_TO_IJ[orient][pos];
    i = i * 2 + (ij >> 1);
    j = j * 2 + (ij & 1);
    orient ^= POS_TO_ORIENT[pos];
  }
  const st = (x) => (x + 0.5) / 2 ** 30;
  const uv = (s) => (s >= 0.5 ? (4 * s * s - 1) / 3 : (1 - 4 * (1 - s) * (1 - s)) / 3);
  const u = uv(st(i)), v = uv(st(j));
  const xyzByFace = [
    [1, u, v],
    [-u, 1, v],
    [-u, -v, 1],
    [-1, -v, -u],
    [v, -1, -u],
    [v, u, -1],
  ];
  const [x, y, z] = xyzByFace[face];
  const lat = (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI;
  const lng = (Math.atan2(y, x) * 180) / Math.PI;
  if (!isFinite(lat) || !isFinite(lng)) return null;
  return { lat, lng };
}

// URLの中の「!1s0x…:0x…」（場所ページ）か「ftid=0x…:0x…」（内部リンク）から、コロンの前（S2セルID）を取り出す。
const FEATURE_ID_RE = /(?:!1s|[?&]ftid=)(0x[0-9a-f]+):0x[0-9a-f]+/i;
function extractFeatureS2(href) {
  const m = FEATURE_ID_RE.exec(href || "");
  return m ? m[1] : null;
}

// ---- 場所の候補を絞り込むための純粋な補助関数（node で単体テストできる。test/geo-decode.test.mjs） ----
// 「山梨」「ユニバーサル」「赤レンガ倉庫」のような同じ名前の場所が複数（国内外・同名の別施設）
// あるとき、その旅行のほかの場所（前後の予定・ほかの日の場所）に近い候補を選ぶための共通ロジック。
// 2点間のおおよその距離（km、Haversine。index.jsのgetRoute等と同じ式）。
function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// 候補（{lat,lng,...}の配列）の中から、nears（旅行のほかの場所。複数可）のどれかにいちばん近いものを選ぶ。
// nearsが無い・空ならnull（呼び出し側で、これまでどおりの選び方にフォールバックする）。
function nearestCandidate(points, nears) {
  if (!Array.isArray(points) || !points.length || !Array.isArray(nears) || !nears.length) return null;
  let best = null, bestDist = Infinity;
  for (const p of points) {
    if (!isFinite(p.lat) || !isFinite(p.lng)) continue;
    let d = Infinity;
    for (const n of nears) { const nd = distanceKm(n, p); if (nd < d) d = nd; }
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

// Nominatimの検索結果（配列、jsonv2）から使える候補を選ぶ。nearsがあれば、そのどれかにいちばん近い候補
// （「赤レンガ倉庫」で敦賀と横浜が同じくらいの重要度で並んだときに横浜を選ぶ、など）。
// 無ければ、これまでどおり重要度（importance、有名さの目安）がいちばん高いもの。
function pickNominatimCandidate(list, nears) {
  if (!Array.isArray(list)) return null;
  const valid = [];
  for (const c of list) {
    const lat = parseFloat(c.lat), lng = parseFloat(c.lon);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    valid.push({ lat, lng, importance: Number(c.importance) || 0 });
  }
  if (!valid.length) return null;
  const near = nearestCandidate(valid, nears);
  if (near) return near;
  let best = null;
  for (const c of valid) if (!best || c.importance > best.importance) best = c;
  return best;
}

// ウィキペディアの題名を、表記ゆれ（濁点・空白・かっこ・「国際」の有無など）を吸収した比較用の文字列にする。
function normPlaceName(s, keepParen) {
  let t = String(s || "").normalize("NFKC");
  if (!keepParen) t = t.replace(/\s*[(（][^)）]*[)）]\s*$/, "");
  return t.replace(/ヴァ/g, "バ").replace(/ヴィ/g, "ビ").replace(/ヴェ/g, "ベ").replace(/ヴォ/g, "ボ").replace(/ヴ/g, "ブ")
    .replace(/国際/g, "") // 「ロサンゼルス空港」→「ロサンゼルス国際空港」
    .replace(/[\s・･\-‐ー_「」()（）=＝]/g, "").toLowerCase();
}

// 名前と記事の題名の合い方：3＝同じ、2＝題名が名前を含む、0＝合わない。
// 「名前が題名を含む」（「フラミンゴ ラスベガス」と「ラスベガス」）は町全体の座標になってしまうので使わない。
function placeNameRank(query, title) {
  const q = normPlaceName(query), t = normPlaceName(title), tp = normPlaceName(title, true);
  if (!q || !t) return 0;
  if (q === t || q === tp) return 3;
  if (q.length >= 3 && t.includes(q)) return 2;
  return 0;
}

// 名前が記事の題名と合ったウィキペディアの候補（{title,lat,lng,rank}の配列）から、いちばん確からしいものを選ぶ。
// 題名がそのまま合った候補（rank 3）があれば距離を見ずに常にそれを優先し、部分一致（rank 2）どうしが
// 並んだときだけ、nearsがあればいちばん近いものを選ぶ（「敦賀赤レンガ倉庫」と「横浜赤レンガ倉庫」から
// 横浜を選ぶ、など）。nearsが無ければ、これまでどおり（検索結果の並び順で）先頭。
function pickWikiHit(hits, nears) {
  if (!Array.isArray(hits) || !hits.length) return null;
  const maxRank = Math.max(...hits.map((h) => h.rank || 0));
  const top = hits.filter((h) => (h.rank || 0) === maxRank);
  return nearestCandidate(top, nears) || top[0];
}

// Open-Meteoのジオコーディング結果（配列、人口の多い順などAPIが返した順）から選ぶ。
// nearsがあればいちばん近いもの（「ユニバーサル」でユニバーサル・オーランド・リゾートしか
// 無いようでも、ほかの候補が近ければそちらを選ぶ）。無ければ先頭（従来どおり）。
function pickGeoNamesCandidate(results, nears) {
  if (!Array.isArray(results) || !results.length) return null;
  const pts = results.map((r) => ({ lat: r.latitude, lng: r.longitude, ref: r }));
  const near = nearestCandidate(pts, nears);
  return near ? near.ref : results[0];
}

export {
  s2ToLatLng, extractFeatureS2,
  distanceKm, nearestCandidate, pickNominatimCandidate, normPlaceName, placeNameRank, pickWikiHit, pickGeoNamesCandidate,
};
