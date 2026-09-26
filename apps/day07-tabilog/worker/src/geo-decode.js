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

export { s2ToLatLng, extractFeatureS2 };
