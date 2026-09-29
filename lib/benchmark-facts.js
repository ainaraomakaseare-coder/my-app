'use strict';
/**
 * 集めた記録（lib/benchmark.js の型、checkAll を通ったもの）から、
 * 「事実」だけを機械で計算する。
 *
 * ★ 分析部隊の②③（trend-analyst・plan-from-analysis）はこの先で LLM を使うが、
 *   ここは LLM を呼ばない・ファイルも読み書きしない、ただの計算。
 *   CLAUDE.md の決めごと1（嘘を書かない）を守るいちばん固い場所にするため、
 *   出す数字はぜんぶ入力から足し算・数え上げで出す。書いていない数字は出さない。
 *
 * ★ 「伸びている」の分け方は lib/benchmark.js と同じ（ratio >= GROWING_RATIO）。
 *   作り（型・長さ・冒頭・呼びかけ・シリーズ物か）を、伸びている群とそれ以外で
 *   比べられるように、集計はいつも growing / rest の2群に分ける。
 */

const benchmark = require('./benchmark');

// ---------------------------------------------------------------------------
// 冒頭（hook）の型。正規表現そのもの（source）を facts に出すので、
// 「何を数えたか」が結果を見るだけで分かる。
// ---------------------------------------------------------------------------
const HOOK_RULES = {
  数字: /[0-9０-９]|[一二三四五六七八九十]+(?:つ|個|選)/,
  問いかけ: /[?？]$|知ってる|ですか|って何|どっち/,
  '否定・警告': /するな|しないで|やめ|NG|危険|注意|損|ダメ|後悔|失敗/,
  呼びかけ: /な人|の人へ|必見|さんへ|方へ/,
  結論先出し: /^(?:結論|答えは|正解は)|だけでいい|これだけ/,
};

/** hook の文字列が、上のどの型に当てはまるか（複数可）。空文字は [] を返す（'空' の扱いは呼び出し側）。 */
function hookTypes(text) {
  const t = String(text || '');
  if (!t.trim()) return [];
  const out = [];
  for (const name of Object.keys(HOOK_RULES)) {
    if (HOOK_RULES[name].test(t)) out.push(name);
  }
  return out;
}

/** 最後の呼びかけ（content.cta）の型。 */
function ctaType(text) {
  const t = String(text || '').trim();
  if (!t) return 'なし';
  if (t.includes('保存')) return '保存';
  if (t.includes('フォロー')) return 'フォロー';
  if (/プロフ|リンク/.test(t)) return 'プロフ';
  if (t.includes('コメント')) return 'コメント';
  return 'その他';
}

/** 動画・投稿の長さ（秒）を、比べやすい区分に丸める。 */
function durationBucket(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '不明';
  if (sec <= 15) return '〜15秒';
  if (sec <= 30) return '〜30秒';
  if (sec <= 60) return '〜60秒';
  return '60秒超';
}

// DAY14 / Day3 / 第3回 / #5 / 12日目 / パート2 / Part2 のような「連載物」らしさ。
const SERIES_RE = /DAY\d|Day\d|第\d+|#\d+|\d+日目|パート\d|Part\d/i;

/** 題名・1行目がシリーズ物（連載）らしいかどうか。 */
function isSeries(text) {
  return SERIES_RE.test(String(text || ''));
}

// ---------------------------------------------------------------------------
// 小さな算数
// ---------------------------------------------------------------------------

function median(nums) {
  if (!nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 線形補間の百分位数（p は 0〜100）。 */
function percentile(nums, p) {
  if (!nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/** 記録が持っている ratio。無ければ growthRatio で出し直す（新しくは決めない）。 */
function ratioOf(item) {
  return typeof item.ratio === 'number' ? item.ratio : benchmark.growthRatio(item);
}

// のび率と再生数の両方で決める（lib/benchmark.js の isGrowing と同じ線）。
function isGrowing(item) {
  return benchmark.isGrowing(Object.assign({}, item, { ratio: ratioOf(item) }));
}

/** content.topic が空なら「その他」にまとめる。 */
function topicLabel(item) {
  const t = item && item.content && item.content.topic;
  return t && String(t).trim() ? String(t).trim() : 'その他';
}

/** 質問の文字を、比べられる形にそろえる（空白の揺れ・? と？の違いを吸収）。 */
function normalizeQuestion(text) {
  return String(text || '')
    .trim()
    .replace(/[ 　]+/g, ' ')
    .replace(/[?？]+$/g, '')
    .trim();
}

function countBy(items, keyFn) {
  const out = {};
  for (const item of items) {
    const k = keyFn(item);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/**
 * hooks 用。1件が複数の型に当てはまるので、押し並べて数える。
 *
 * ★ 冒頭（hook）が空なら、題名（first_line）で判定する。
 *   YouTube は API から冒頭2秒が見えず、全部「空」になっていた（本番の1回目）。
 *   Shorts の題名は画面の1行目と同じことが多いので代わりに使い、どちらで判定したかを basis に残す。
 */
function hookTextOf(item) {
  const c = item.content || {};
  const hook = String(c.hook || '').trim();
  if (hook) return { text: hook, basis: 'hook' };
  const line = String(c.first_line || '').trim();
  if (line) return { text: line, basis: 'first_line' };
  return { text: '', basis: null };
}

function countHooks(items) {
  const out = {};
  for (const item of items) {
    const { text } = hookTextOf(item);
    if (!text) {
      out['空'] = (out['空'] || 0) + 1;
      continue;
    }
    for (const t of hookTypes(text)) out[t] = (out[t] || 0) + 1;
  }
  return out;
}

function countHookBasis(items) {
  const out = { hook: 0, first_line: 0 };
  for (const item of items) {
    const { basis } = hookTextOf(item);
    if (basis) out[basis]++;
  }
  return out;
}

const GROUP_LABEL = { growing: '伸びている', rest: '伸びていない' };

/**
 * 事実だけを計算する。LLM を呼ばない・I/O をしない・入力を書き換えない。
 *
 * @param items lib/benchmark.js の checkAll を通った記録の配列（.ratio 付き）
 * @param own   public/index.html の「自分の投稿を分析用にコピー」と同じ形、または null
 * @param opts  { genre, now }
 */
function facts(items, own, opts) {
  opts = opts || {};
  const list = (items || []).slice();
  const genre = opts.genre || (list[0] && list[0].genre) || '';
  const now = opts.now || new Date();

  const growingItems = list.filter(isGrowing);
  const restItems = list.filter((it) => !isGrowing(it));

  // ---- n ----
  const byPlatform = countBy(list, (it) => it.platform);
  const n = { total: list.length, growing: growingItems.length, byPlatform };

  // ---- ratio ----
  const ratios = list.map(ratioOf).filter((r) => r !== null);
  const ratio = {
    median: median(ratios),
    p75: percentile(ratios, 75),
    max: ratios.length ? Math.max(...ratios) : null,
  };

  // ---- formats / durations / hooks / ctas / series（growing vs rest）----
  const formats = {
    growing: countBy(growingItems, (it) => (it.content && it.content.format) || 'unknown'),
    rest: countBy(restItems, (it) => (it.content && it.content.format) || 'unknown'),
  };
  const durations = {
    growing: countBy(growingItems, (it) => durationBucket(it.content && it.content.duration_sec)),
    rest: countBy(restItems, (it) => durationBucket(it.content && it.content.duration_sec)),
  };
  const hooks = {
    rules: Object.fromEntries(Object.keys(HOOK_RULES).map((k) => [k, HOOK_RULES[k].source])),
    growing: countHooks(growingItems),
    rest: countHooks(restItems),
    // 冒頭そのもので判定した件数と、題名で代わりに判定した件数。
    basis: countHookBasis(growingItems.concat(restItems)),
  };
  const ctas = {
    growing: countBy(growingItems, (it) => ctaType(it.content && it.content.cta)),
    rest: countBy(restItems, (it) => ctaType(it.content && it.content.cta)),
  };
  const seriesRuleText = SERIES_RE.source;
  const series = {
    growing: growingItems.filter((it) => isSeries(it.content && it.content.first_line)).length,
    rest: restItems.filter((it) => isSeries(it.content && it.content.first_line)).length,
    rule: seriesRuleText,
  };

  // ---- topics ----
  const topicGroups = new Map();
  for (const item of list) {
    const label = topicLabel(item);
    if (!topicGroups.has(label)) topicGroups.set(label, []);
    topicGroups.get(label).push(item);
  }
  const topics = Array.from(topicGroups.entries()).map(([topic, group]) => {
    const growing = group.filter(isGrowing).length;
    const questions = group.filter((it) => hasQuestions(it)).length;
    const groupRatios = group.map(ratioOf).filter((r) => r !== null);
    const sampleUrls = group
      .slice()
      .sort((a, b) => rankByRatioDesc(a, b))
      .slice(0, 3)
      .map((it) => it.url);
    return {
      topic,
      total: group.length,
      growing,
      questions,
      medianRatio: median(groupRatios),
      sampleUrls,
    };
  }).sort((a, b) => (b.growing - a.growing) || (b.total - a.total) || a.topic.localeCompare(b.topic, 'ja'));

  // ---- openings（需要はあるのに、供給が少ない話題）----
  const openings = topics
    .filter((t) => (t.growing >= 2 && t.total <= 6) || (t.questions >= 3 && t.total <= 6))
    .map((t) => ({
      topic: t.topic,
      reason: `「${t.topic}」は全体で${t.total}件しか集まっていないのに、伸びているものが${t.growing}件、コメントの質問がある投稿が${t.questions}件ある。供給より需要が大きい。`,
    }));

  // ---- top（ratio 上位15。足りなければ views で埋める）----
  const withRatio = list.filter((it) => ratioOf(it) !== null)
    .slice()
    .sort((a, b) => rankByRatioDesc(a, b));
  const withoutRatio = list.filter((it) => ratioOf(it) === null)
    .slice()
    .sort((a, b) => viewsOf(b) - viewsOf(a));
  const topItems = withRatio.slice(0, 15)
    .concat(withoutRatio.slice(0, Math.max(0, 15 - Math.min(15, withRatio.length))));
  const top = topItems.map((it) => ({
    url: it.url,
    platform: it.platform,
    account: (it.account && (it.account.name || it.account.handle)) || '',
    followers: (it.account && numOrNull(it.account.followers)) ?? null,
    views: (it.metrics && numOrNull(it.metrics.views)) ?? null,
    likes: (it.metrics && numOrNull(it.metrics.likes)) ?? null,
    ratio: ratioOf(it),
    format: (it.content && it.content.format) || 'unknown',
    hook: (it.content && it.content.hook) || '',
    first_line: (it.content && it.content.first_line) || '',
    duration_sec: (it.content && it.content.duration_sec) ?? null,
    cta: (it.content && it.content.cta) ?? null,
    topic: topicLabel(it),
  }));

  // ---- questions（コメントの質問をまとめる）----
  const qMap = new Map(); // normalized -> { text, count, urls }
  for (const item of list) {
    const qs = (item.demand && Array.isArray(item.demand.comment_questions))
      ? item.demand.comment_questions : [];
    for (const raw of qs) {
      const norm = normalizeQuestion(raw);
      if (!norm) continue;
      if (!qMap.has(norm)) qMap.set(norm, { text: norm, count: 0, urls: [] });
      const entry = qMap.get(norm);
      entry.count += 1;
      if (!entry.urls.includes(item.url)) entry.urls.push(item.url);
    }
  }
  const questions = Array.from(qMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // ---- own ----
  const ownOut = own ? buildOwn(own) : null;

  // ---- caveats ----
  const caveats = [];
  if (n.total < 20) caveats.push('集めた数が少ないので傾向は参考程度');
  if (growingItems.length && growingItems.length < 5) {
    caveats.push(`${GROUP_LABEL.growing} は5件未満なので比較しない`);
  }
  if (restItems.length && restItems.length < 5) {
    caveats.push(`${GROUP_LABEL.rest} は5件未満なので比較しない`);
  }
  if (!ownOut) caveats.push('自分の投稿の記録が無い（比較の相手がいない）');
  caveats.push('他人の完走率・視聴時間は見えない');

  return {
    genre,
    generated_at: now.toISOString(),
    n, ratio, formats, durations, hooks, ctas, series,
    topics, openings, top, questions,
    own: ownOut,
    caveats,
  };
}

function hasQuestions(item) {
  const qs = item.demand && item.demand.comment_questions;
  return Array.isArray(qs) && qs.length > 0;
}

function viewsOf(item) {
  const v = item.metrics && item.metrics.views;
  return Number.isInteger(v) ? v : -1;
}

/** ratio 降順（同着は views の多い順）で並べるための比較。 */
function rankByRatioDesc(a, b) {
  const ra = ratioOf(a);
  const rb = ratioOf(b);
  if (ra === null && rb === null) return viewsOf(b) - viewsOf(a);
  if (ra === null) return 1;
  if (rb === null) return -1;
  if (rb !== ra) return rb - ra;
  return viewsOf(b) - viewsOf(a);
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * own（public/index.html ownCopyBtn が作る形）を facts.own の形にまとめる。
 * ★ metrics が null の投稿は「見えなかった」ので、中央値の計算に入れない。
 */
function buildOwn(own) {
  const posts = Array.isArray(own.posts) ? own.posts : [];
  const withMetricsposts = posts.filter((p) => p.metrics && typeof p.metrics.views === 'number');
  const views = withMetricsposts.map((p) => p.metrics.views);
  const titles = posts
    .slice()
    .sort((a, b) => String(b.posted_at || '').localeCompare(String(a.posted_at || '')))
    .slice(0, 20)
    .map((p) => p.title);
  return {
    accounts: (Array.isArray(own.accounts) ? own.accounts : []).map((a) => ({
      network: a.network, label: a.label, followers: numOrNull(a.followers),
    })),
    posts: posts.length,
    withMetrics: withMetricsposts.length,
    medianViews: median(views),
    format: own.own_format || null,
    titles,
  };
}

module.exports = {
  facts, hookTypes, ctaType, durationBucket, isSeries,
  HOOK_RULES, SERIES_RE,
};
