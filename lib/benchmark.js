'use strict';
/**
 * 「伸びている投稿」を集めて比べるための、1本ぶんの記録の型と点検。
 *
 * 分析部隊は3段に分かれている（docs/research/README.md）。
 *   ① 収集 … YouTube はアプリが API で自動で集める。ほかのSNSは Claude in Chrome で集める
 *   ② 分析 … 集めた記録と自分の投稿を、決まった観点で比べる
 *   ③ 企画 … 分析をもとに次の企画と投稿案を決める
 * ①から②へ渡す前に、ここで点検する。どの部品も同じ型を使う。
 *
 * ★ 嘘の数字を分析に入れない（CLAUDE.md の決めごと1）。
 *   - 数字には必ず出どころ（api / screen）と、確かめた日を付ける
 *   - 見えなかった数字は null。0 や推測で埋めない（0 は「0だった」という意味になる）
 *   - URL は、書いてあるSNSのものだけを受け付ける（取り違えを防ぐ）
 *
 * ★ 「伸びている」は再生数の大きさでは決めない。
 *   フォロワー100万人の人の10万再生と、フォロワー500人の人の10万再生は別物。
 *   いまのアカウントはフォロワー数十人なので、比べる相手は後者。
 *   「再生数 ÷ フォロワー数」（のび率）で見る。
 */

const PLATFORMS = ['youtube', 'tiktok', 'x', 'instagram', 'threads'];

// ジャンル。運用アカウントに対応する。
const GENRES = {
  ai: { label: 'AI（ひろや）' },
  career: { label: '転職（転職のホンネまとめ）' },
};

// 動画・投稿の作りの型。分析でいちばん効く切り口なので、自由記述にしない。
const FORMATS = {
  talking: '顔出しで話す',
  voice: '顔なし・声で解説',
  screen: '画面収録（操作を見せる）',
  text: '文字＋BGM（読ませる）',
  slides: '画像スライド・カルーセル',
  post: '文章だけの投稿',
  other: 'その他',
  unknown: '分からない',
};

const METRICS = ['views', 'likes', 'comments', 'saves', 'shares'];
const SOURCES = ['api', 'screen'];   // api: APIが返した値 / screen: 画面に出ていた値

// URL が本当にそのSNSのものか。
const HOSTS = {
  youtube: /^(www\.|m\.)?(youtube\.com|youtu\.be)$/,
  tiktok: /^(www\.|m\.|vm\.|vt\.)?tiktok\.com$/,
  x: /^(www\.|mobile\.)?(x\.com|twitter\.com)$/,
  instagram: /^(www\.)?instagram\.com$/,
  threads: /^(www\.)?threads\.(net|com)$/,
};

// のび率がこの倍数以上なら「伸びている」。直近の日数も見る。
const GROWING_RATIO = 10;
const RECENT_DAYS = 30;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isCount = (v) => v === null || (Number.isInteger(v) && v >= 0);

/** 再生数 ÷ フォロワー数。どちらかが分からなければ null（推測しない）。 */
function growthRatio(item) {
  const views = item && item.metrics && item.metrics.views;
  const followers = item && item.account && item.account.followers;
  if (!Number.isInteger(views) || !Number.isInteger(followers) || followers <= 0) return null;
  return Math.round((views / followers) * 10) / 10;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

/**
 * 1本を点検する。errors があれば分析に入れない。warnings は入れてよいが目印を付ける。
 */
function checkItem(item) {
  const errors = [];
  const warnings = [];
  const it = item || {};
  const m = it.metrics || {};
  const acc = it.account || {};
  const c = it.content || {};

  if (!PLATFORMS.includes(it.platform)) errors.push(`platform は ${PLATFORMS.join(' / ')} のどれか`);
  if (!GENRES[it.genre]) errors.push(`genre は ${Object.keys(GENRES).join(' / ')} のどれか`);

  let host = '';
  try {
    const u = new URL(String(it.url || ''));
    if (u.protocol !== 'https:') errors.push('url は https で');
    host = u.hostname;
  } catch (e) { errors.push('url が読めない'); }
  // ★ 収集の指示文（docs/research/CHROME_COLLECT.md）の見本がそのまま返ってくることがある。
  //   架空の投稿が分析に混ざらないよう、見本のアカウントは弾く。
  if (/\/@?example_user\b/i.test(String(it.url || ''))) errors.push('指示文の見本（example_user）がそのまま入っている');
  if (host && HOSTS[it.platform] && !HOSTS[it.platform].test(host)) {
    errors.push(`url が ${it.platform} のものではない（${host}）`);
  }

  if (!acc.name && !acc.handle) errors.push('アカウント名（name か handle）が無い');
  if (!isCount(acc.followers === undefined ? null : acc.followers)) errors.push('followers は0以上の整数か null');

  if (!DATE.test(String(it.collected_at || ''))) errors.push('collected_at（確かめた日）は YYYY-MM-DD');
  if (it.posted_at != null && !DATE.test(String(it.posted_at))) errors.push('posted_at は YYYY-MM-DD か null');

  for (const k of METRICS) {
    if (!isCount(m[k] === undefined ? null : m[k])) errors.push(`metrics.${k} は0以上の整数か null（見えなければ null）`);
  }
  const anyMetric = METRICS.some((k) => Number.isInteger(m[k]));
  if (!anyMetric) errors.push('数字が1つも無い（再生かいいねの少なくとも一方が要る）');
  if (anyMetric && !SOURCES.includes(it.metrics_source)) {
    errors.push(`数字の出どころ metrics_source は ${SOURCES.join(' / ')} のどちらか`);
  }
  if ((Number.isInteger(acc.followers)) && !SOURCES.includes(acc.followers_source)) {
    errors.push(`フォロワー数の出どころ account.followers_source は ${SOURCES.join(' / ')} のどちらか`);
  }

  if (!FORMATS[c.format]) errors.push(`content.format は ${Object.keys(FORMATS).join(' / ')} のどれか`);
  if (!String(c.first_line || '').trim()) errors.push('content.first_line（題名か1行目）が無い');
  if (c.duration_sec != null && !(Number.isFinite(c.duration_sec) && c.duration_sec > 0)) {
    errors.push('content.duration_sec は正の数か null');
  }

  if (it.posted_at && it.collected_at && DATE.test(it.posted_at) && DATE.test(it.collected_at)) {
    const age = daysBetween(it.posted_at, it.collected_at);
    if (age < 0) errors.push('posted_at が確かめた日より後');
    else if (age > RECENT_DAYS) warnings.push(`${RECENT_DAYS}日より前の投稿（${age}日前）`);
  }
  const ratio = growthRatio(it);
  if (ratio === null) warnings.push('フォロワー数か再生数が無いので、のび率が出せない');
  else if (ratio < GROWING_RATIO) warnings.push(`のび率が ${ratio} 倍（${GROWING_RATIO} 倍未満）`);
  if (!String(c.hook || '').trim()) warnings.push('冒頭（hook）が空。分析の一番大事な材料');

  return { errors, warnings, ratio };
}

// 見えなかった・隠されていたことを表す文字（0 と混同しない）。
const HIDDEN = new Set(['', '-', '非公開', 'hidden']);

/**
 * 画面に出ている表記を整数に変換する。
 *   '1,234' → 1234 / '1.2万' → 12000 / '3.4K'（'3.4k'）→ 3400
 *   '1.1M' → 1100000 / '2億' → 200000000
 * 読めない・見えない（'', null, '-', '非公開', 'hidden'）は null。
 * ★ 0 を返すのは「0 と表示されていた」ときだけ。分からなければ必ず null。
 */
function parseCount(text) {
  if (text === null || text === undefined) return null;
  if (typeof text === 'number') return Number.isFinite(text) ? Math.round(text) : null;
  const s = String(text).trim();
  if (HIDDEN.has(s)) return null;

  const plain = s.replace(/,/g, '');
  if (/^\d+$/.test(plain)) return parseInt(plain, 10);

  const m = plain.match(/^(\d+(?:\.\d+)?)\s*(万|億|[KkMm])$/);
  if (m) {
    const n = parseFloat(m[1]);
    const unit = m[2];
    const scale = unit === '万' ? 10000
      : unit === '億' ? 100000000
      : (unit === 'K' || unit === 'k') ? 1000
      : 1000000; // M / m
    return Math.round(n * scale);
  }
  return null;
}

/** 同じ投稿かどうかの鍵。URL の後ろの ? や / の違いを無視する。 */
function keyOf(item) {
  try {
    const u = new URL(String(item.url));
    if (/youtu\.be$/.test(u.hostname)) return 'youtube:' + u.pathname.slice(1);
    const v = u.searchParams.get('v');
    if (v) return 'youtube:' + v;
    const shorts = u.pathname.match(/\/shorts\/([^/?#]+)/);
    if (shorts) return 'youtube:' + shorts[1];
    return (u.hostname.replace(/^(www|m|mobile)\./, '') + u.pathname).replace(/\/+$/, '').toLowerCase();
  } catch (e) {
    return String(item && item.url);
  }
}

/**
 * まとめて点検する。重複は後から来たほうを落とす。
 * @returns { accepted: [{ item, ratio, warnings }], rejected: [{ item, errors }], summary }
 */
function checkAll(items) {
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  for (const item of items || []) {
    const r = checkItem(item);
    const key = keyOf(item || {});
    if (!r.errors.length && seen.has(key)) r.errors.push('同じ投稿がもう入っている');
    if (r.errors.length) { rejected.push({ item, errors: r.errors }); continue; }
    seen.add(key);
    accepted.push({ item: Object.assign({}, item, { ratio: r.ratio }), ratio: r.ratio, warnings: r.warnings });
  }
  const growing = accepted.filter((a) => a.ratio !== null && a.ratio >= GROWING_RATIO).length;
  const byPlatform = {};
  for (const a of accepted) byPlatform[a.item.platform] = (byPlatform[a.item.platform] || 0) + 1;
  return { accepted, rejected, summary: { accepted: accepted.length, rejected: rejected.length, growing, byPlatform } };
}

module.exports = {
  PLATFORMS, GENRES, FORMATS, METRICS, SOURCES, GROWING_RATIO, RECENT_DAYS,
  growthRatio, checkItem, checkAll, keyOf, parseCount,
};
