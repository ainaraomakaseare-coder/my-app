'use strict';
/**
 * ①収集の取り込み。Claude in Chrome が返した JSON（や、YouTube 自動収集の
 * エクスポート）を、lib/benchmark.js の点検にかけて research/<genre>/<date>.json
 * にまとめる。
 *
 *   node scripts/benchmark-intake.js <file.json | -> [--genre ai|career] [--date YYYY-MM-DD] [--dry-run]
 *
 * ★ 何度流しても壊れない。
 *   同じ投稿（keyOf が同じ）が既存ファイルにもあれば、collected_at が新しい
 *   ほうだけを残す。取り込み直しで増殖したり、古い数字で上書きされたりしない。
 *
 * ★ ここは「本物だけを通す」最後の関門（CLAUDE.md 決めごと1）。
 *   数字を作ったり、足りない項目を埋めたりはしない。落ちたものは理由を出す。
 */

const fs = require('fs');
const path = require('path');
const benchmark = require('../lib/benchmark');
const { checkAll, growthRatio, keyOf, parseCount, GENRES, GROWING_RATIO } = benchmark;

const RESEARCH_DIR = path.join(__dirname, '..', 'research');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 日本時間の「今日」（サーバーがUTCで動いてもズレない）。 */
function jstToday(now) {
  const d = now || new Date();
  const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
  return p.format(d); // sv-SE は YYYY-MM-DD で出る
}

/**
 * ```json ... ``` のフェンスで包まれていたら剥がす。
 * 素の JSON 配列／オブジェクトならそのまま返す。
 */
function stripFence(raw) {
  const text = String(raw == null ? '' : raw).trim();
  const m = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1].trim() : text;
}

/**
 * 入力テキストを records の配列に開く。
 *   - JSON 配列ならそのまま
 *   - { genre, collected_at, items } 形式（アプリの YouTube エクスポート）なら items を使う
 */
function parseInput(raw) {
  const text = stripFence(raw);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error('JSON として読めない: ' + e.message);
  }
  if (Array.isArray(parsed)) {
    return { records: parsed, wrapperGenre: null, wrapperDate: null };
  }
  if (parsed && Array.isArray(parsed.items)) {
    return {
      records: parsed.items,
      wrapperGenre: parsed.genre || null,
      wrapperDate: DATE_RE.test(String(parsed.collected_at || '')) ? parsed.collected_at : null,
    };
  }
  throw new Error('JSON配列か、{ items: [...] } の形にしてください');
}

/**
 * 数字が文字列で来ていたら parseCount で整数に戻す。
 * 足りない項目を作ったり、出どころ（*_source）を書き換えたりはしない。
 */
function normalizeItem(item) {
  const it = Object.assign({}, item);
  if (it.metrics && typeof it.metrics === 'object') {
    const m = Object.assign({}, it.metrics);
    for (const k of Object.keys(m)) {
      if (typeof m[k] === 'string') m[k] = parseCount(m[k]);
    }
    it.metrics = m;
  }
  if (it.account && typeof it.account === 'object') {
    const acc = Object.assign({}, it.account);
    if (typeof acc.followers === 'string') acc.followers = parseCount(acc.followers);
    it.account = acc;
  }
  return it;
}

/** genre が無いレコードだけ、フォールバック（--genre や wrapper の genre）で埋める。 */
function fillMissingGenre(item, fallbackGenre) {
  if (item && item.genre) return item;
  if (!fallbackGenre) return item;
  return Object.assign({}, item, { genre: fallbackGenre });
}

/** genre ごとに分ける。genre が無い／未知のものは '' にまとめる（あとで rejected になる）。 */
function groupByGenre(records) {
  const groups = {};
  for (const r of records || []) {
    const g = (r && GENRES[r.genre]) ? r.genre : '';
    (groups[g] = groups[g] || []).push(r);
  }
  return groups;
}

/** レコードの中で最初に見つかる正しい collected_at。 */
function firstValidDate(records) {
  for (const r of records || []) {
    if (r && DATE_RE.test(String(r.collected_at || ''))) return r.collected_at;
  }
  return null;
}

/** 既存の items と、新しく受理した items をマージ。同じ投稿は collected_at が新しいほうを残す。 */
function mergeItems(existingItems, acceptedList) {
  const map = new Map();
  for (const it of existingItems || []) map.set(keyOf(it), it);
  for (const a of acceptedList || []) {
    const item = a.item || a;
    const key = keyOf(item);
    const prev = map.get(key);
    if (!prev || String(item.collected_at || '') >= String(prev.collected_at || '')) {
      map.set(key, item);
    }
  }
  return Array.from(map.values());
}

/** ratio 降順。null（フォロワー数などが分からずのび率が出せない）は最後。 */
function sortItems(items) {
  return items
    .map((it) => Object.assign({}, it, { ratio: growthRatio(it) }))
    .sort((a, b) => {
      if (a.ratio === null && b.ratio === null) return 0;
      if (a.ratio === null) return 1;
      if (b.ratio === null) return -1;
      return b.ratio - a.ratio;
    });
}

/**
 * 1ジャンルぶんの取り込み。純粋関数（ファイルは触らない）。
 * @param records 正規化前でも後でもよい、そのジャンルの生レコード配列
 * @param existing 既存ファイルの中身 { genre, date, items } か null
 * @param opts { date }
 */
function intake(records, existing, opts) {
  opts = opts || {};
  const normalized = (records || []).map(normalizeItem);
  const result = checkAll(normalized);
  const merged = mergeItems((existing && existing.items) || [], result.accepted);
  const items = sortItems(merged);
  const genre = (existing && existing.genre) || (records && records[0] && records[0].genre) || opts.genre || '';
  const date = opts.date || (existing && existing.date) || jstToday();
  return { genre, date, items, accepted: result.accepted, rejected: result.rejected, summary: result.summary };
}

/**
 * 入力テキスト全体を、ジャンルごとの取り込み計画に開く。
 * loadExisting(genre, date) は任意の依存注入（テストでは in-memory、CLI では fs）。
 */
function planIntake(raw, opts, loadExisting) {
  opts = opts || {};
  loadExisting = loadExisting || (() => null);
  const { records, wrapperGenre, wrapperDate } = parseInput(raw);
  const filled = records.map((r) => fillMissingGenre(r, opts.genre || wrapperGenre));
  const groups = groupByGenre(filled);
  const plans = {};
  for (const genre of Object.keys(groups)) {
    const recs = groups[genre];
    const date = opts.date || firstValidDate(recs) || wrapperDate || jstToday();
    const existing = genre ? loadExisting(genre, date) : null;
    plans[genre || '（genre不明）'] = intake(recs, existing, { genre, date });
  }
  return plans;
}

function filePathFor(genre, date) {
  return path.join(RESEARCH_DIR, genre, `${date}.json`);
}

function loadExistingFromDisk(genre, date) {
  const p = filePathFor(genre, date);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeToDisk(genre, date, items) {
  const p = filePathFor(genre, date);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body = { genre, date, items };
  fs.writeFileSync(p, JSON.stringify(body, null, 2) + '\n');
  return p;
}

function parseArgs(argv) {
  const opts = { dryRun: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--genre') opts.genre = argv[++i];
    else if (a === '--date') opts.date = argv[++i];
    else rest.push(a);
  }
  opts.input = rest[0];
  return opts;
}

function readInput(input) {
  if (input === '-' || !input) return fs.readFileSync(0, 'utf8');
  return fs.readFileSync(input, 'utf8');
}

function printSummary(genreLabel, plan, dryRun) {
  console.log(`\n[${genreLabel}] ${plan.date}`);
  console.log(`  受理 ${plan.summary.accepted} 件 / 却下 ${plan.summary.rejected} 件`);
  const platforms = Object.keys(plan.summary.byPlatform);
  if (platforms.length) {
    console.log('  内訳: ' + platforms.map((p) => `${p} ${plan.summary.byPlatform[p]}`).join(' / '));
  }
  console.log(`  伸びている（のび率 ${GROWING_RATIO}倍以上・${benchmark.MIN_VIEWS}再生以上）: ${plan.summary.growing} 件`);
  const warned = plan.accepted.filter((a) => a.warnings && a.warnings.length).length;
  if (warned) console.log(`  注意（warnings）あり: ${warned} 件`);
  if (plan.rejected.length) {
    console.log('  却下の内訳:');
    for (const r of plan.rejected) {
      console.log(`    - ${(r.item && r.item.url) || '(url不明)'} → ${r.errors.join(' / ')}`);
    }
  }
  if (!dryRun) console.log(`  → 書き込み先: research/${plan.genre}/${plan.date}.json（${plan.items.length} 件）`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.input) {
    console.error('使い方: node scripts/benchmark-intake.js <file.json | -> [--genre ai|career] [--date YYYY-MM-DD] [--dry-run]');
    process.exit(1);
    return;
  }
  let raw;
  try {
    raw = readInput(opts.input);
  } catch (e) {
    console.error('読み込めなかった: ' + e.message);
    process.exit(1);
    return;
  }

  let plans;
  try {
    plans = planIntake(raw, { genre: opts.genre, date: opts.date }, loadExistingFromDisk);
  } catch (e) {
    console.error('取り込めなかった: ' + e.message);
    process.exit(1);
    return;
  }

  let totalAccepted = 0;
  for (const label of Object.keys(plans)) {
    const plan = plans[label];
    totalAccepted += plan.summary.accepted;
    printSummary(label, plan, opts.dryRun);
    if (!opts.dryRun && GENRES[plan.genre]) {
      writeToDisk(plan.genre, plan.date, plan.items);
    } else if (!opts.dryRun && !GENRES[plan.genre]) {
      console.log('  → genre が分からないので書き込まない');
    }
  }

  console.log('');
  if (totalAccepted === 0) {
    console.error('1件も受理できなかった。');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  stripFence, parseInput, normalizeItem, fillMissingGenre, groupByGenre,
  firstValidDate, mergeItems, sortItems, intake, planIntake,
  filePathFor, jstToday,
};
