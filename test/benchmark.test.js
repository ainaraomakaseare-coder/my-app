'use strict';
/**
 * lib/benchmark.js（①収集の型と点検）と scripts/benchmark-intake.js（取り込み）を確かめる。
 *
 * ★ 守りたいのは3つ。
 *   1. 嘘の数字（0 と null の混同、見えない数字の捏造）を通さない
 *   2. 取り違えた URL（違うSNSのもの）を通さない
 *   3. 取り込みを何度やっても増殖せず、新しいほうだけが残る
 *
 *   node test/benchmark.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const benchmark = require('../lib/benchmark');
const intake = require('../scripts/benchmark-intake');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); failed++; }
}

const baseItem = (over) => Object.assign({
  platform: 'tiktok',
  genre: 'career',
  url: 'https://www.tiktok.com/@career_sample/video/7345612398712345678',
  account: { name: '元人事のキャリア相談室', handle: '@career_sample', followers: 8200, followers_source: 'screen' },
  posted_at: '2026-09-10',
  collected_at: '2026-09-28',
  metrics: { views: 210000, likes: 9800, comments: 320, saves: 1500, shares: null },
  metrics_source: 'screen',
  content: { format: 'talking', first_line: '第二新卒で辞めるとき、伝え方で損してる人が多い', hook: 'その退職理由、面接で聞かれたら詰みます', duration_sec: 42, cta: '保存して' },
  demand: { comment_questions: ['円満退職ってどこまで気にすべき?'] },
}, over || {});

// ---- parseCount ----
check('parseCount: カンマ区切り・万・億・K/M を整数にする', () => {
  assert.strictEqual(benchmark.parseCount('1,234'), 1234);
  assert.strictEqual(benchmark.parseCount('1.2万'), 12000);
  assert.strictEqual(benchmark.parseCount('12万'), 120000);
  assert.strictEqual(benchmark.parseCount('3.4K'), 3400);
  assert.strictEqual(benchmark.parseCount('3.4k'), 3400);
  assert.strictEqual(benchmark.parseCount('1.1M'), 1100000);
  assert.strictEqual(benchmark.parseCount('2億'), 200000000);
  assert.strictEqual(benchmark.parseCount('500'), 500);
  assert.strictEqual(benchmark.parseCount(500), 500);
});

check('parseCount: 見えない・読めないものは null（0 にしない）', () => {
  assert.strictEqual(benchmark.parseCount(''), null);
  assert.strictEqual(benchmark.parseCount(null), null);
  assert.strictEqual(benchmark.parseCount(undefined), null);
  assert.strictEqual(benchmark.parseCount('-'), null);
  assert.strictEqual(benchmark.parseCount('非公開'), null);
  assert.strictEqual(benchmark.parseCount('hidden'), null);
  assert.strictEqual(benchmark.parseCount('なぞ'), null);
});

// ---- checkItem ----
// ★ 収集の指示文の見本（架空の投稿）が、実データとして返ってくることがある。
check('checkItem: 指示文の見本（example_user）がそのまま来たら落とす', () => {
  const r = benchmark.checkItem(baseItem({ url: 'https://www.tiktok.com/@example_user/video/7345612398712345678' }));
  assert.ok(r.errors.some((e) => /見本/.test(e)), r.errors.join(' / '));
  const doc = require('fs').readFileSync(__dirname + '/../docs/research/CHROME_COLLECT.md', 'utf8');
  assert.ok(doc.includes('@example_user'), '見本の URL が指示文と揃っていない');
  assert.ok(/この見本は出力に含めない/.test(doc), '見本を出力に含めないよう書いていない');
});

check('checkItem: 通る例は通る', () => {
  const r = benchmark.checkItem(baseItem());
  assert.deepStrictEqual(r.errors, []);
});

check('checkItem: metrics_source が無いと落ちる', () => {
  const item = baseItem({ metrics_source: undefined });
  const r = benchmark.checkItem(item);
  assert.ok(r.errors.some((e) => e.includes('metrics_source')), r.errors.join(' / '));
});

check('checkItem: 違うSNSのURLは落ちる', () => {
  const item = baseItem({ url: 'https://www.instagram.com/p/abc123/' });
  const r = benchmark.checkItem(item);
  assert.ok(r.errors.some((e) => e.includes('url') && e.includes('tiktok')), r.errors.join(' / '));
});

check('checkItem: 数字が無い（null）のはよいが、"1.2万" のような文字列は落ちる', () => {
  const okNull = baseItem({ metrics: { views: null, likes: 9800, comments: null, saves: null, shares: null } });
  assert.deepStrictEqual(benchmark.checkItem(okNull).errors, []);

  const asString = baseItem({ metrics: { views: '1.2万', likes: 9800, comments: null, saves: null, shares: null } });
  const r = benchmark.checkItem(asString);
  assert.ok(r.errors.some((e) => e.includes('metrics.views')), r.errors.join(' / '));
});

check('checkItem: posted_at が collected_at より後は落ちる', () => {
  const item = baseItem({ posted_at: '2026-10-01', collected_at: '2026-09-28' });
  const r = benchmark.checkItem(item);
  assert.ok(r.errors.some((e) => e.includes('posted_at')), r.errors.join(' / '));
});

check('checkItem: 30日より前の投稿は warning（エラーではない）', () => {
  const item = baseItem({ posted_at: '2026-08-01', collected_at: '2026-09-28' });
  const r = benchmark.checkItem(item);
  assert.deepStrictEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes('日より前')), r.warnings.join(' / '));
});

check('checkItem: のび率が10倍未満は warning', () => {
  const item = baseItem({ metrics: { views: 1000, likes: 9800, comments: null, saves: null, shares: null } });
  const r = benchmark.checkItem(item);
  assert.deepStrictEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes('のび率')), r.warnings.join(' / '));
});

check('growthRatio: フォロワー数が分からなければ null', () => {
  const item = baseItem({ account: { name: 'x', followers: null } });
  assert.strictEqual(benchmark.growthRatio(item), null);
});

// ---- keyOf ----
check('keyOf: YouTube の shorts / watch?v= / youtu.be は同じ投稿として扱う', () => {
  const a = benchmark.keyOf({ url: 'https://www.youtube.com/shorts/abc123' });
  const b = benchmark.keyOf({ url: 'https://www.youtube.com/watch?v=abc123' });
  const c = benchmark.keyOf({ url: 'https://youtu.be/abc123' });
  assert.strictEqual(a, b);
  assert.strictEqual(b, c);
});

check('keyOf: TikTok は末尾のスラッシュやクエリの違いを無視する', () => {
  const a = benchmark.keyOf({ url: 'https://www.tiktok.com/@u/video/123' });
  const b = benchmark.keyOf({ url: 'https://www.tiktok.com/@u/video/123/' });
  const c = benchmark.keyOf({ url: 'https://www.tiktok.com/@u/video/123?is_from_webapp=1' });
  assert.strictEqual(a, b);
  assert.strictEqual(a, c);
});

// ---- checkAll ----
check('checkAll: 同じ投稿の重複は落とす', () => {
  const items = [baseItem(), baseItem({ collected_at: '2026-09-29' })];
  const r = benchmark.checkAll(items);
  assert.strictEqual(r.accepted.length, 1);
  assert.strictEqual(r.rejected.length, 1);
  assert.ok(r.rejected[0].errors.some((e) => e.includes('もう入っている')));
});

// ---- intake（取り込みスクリプト） ----
check('intake: ```json フェンスを剥がして読める', () => {
  const text = '```json\n' + JSON.stringify([baseItem()]) + '\n```';
  const { records } = intake.parseInput(text);
  assert.strictEqual(records.length, 1);
});

check('intake: { genre, collected_at, items } 形式（アプリのエクスポート）を読める', () => {
  const wrapped = { genre: 'career', collected_at: '2026-09-20', items: [baseItem()] };
  const { records, wrapperGenre, wrapperDate } = intake.parseInput(JSON.stringify(wrapped));
  assert.strictEqual(records.length, 1);
  assert.strictEqual(wrapperGenre, 'career');
  assert.strictEqual(wrapperDate, '2026-09-20');
});

check('intake: 数字が文字列（"1.2万"）でも正規化してから点検する', () => {
  const item = baseItem({ metrics: { views: '1.2万', likes: 9800, comments: null, saves: null, shares: null } });
  const result = intake.intake([item], null, { date: '2026-09-28' });
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0].metrics.views, 12000);
});

check('intake: 既存ファイルとマージ。同じ投稿は collected_at が新しいほうを残す', () => {
  const oldItem = baseItem({ collected_at: '2026-09-01', metrics: { views: 1000, likes: null, comments: null, saves: null, shares: null } });
  const existing = { genre: 'career', date: '2026-09-01', items: [oldItem] };
  const newItem = baseItem({ collected_at: '2026-09-28' });
  const result = intake.intake([newItem], existing, { date: '2026-09-28' });
  assert.strictEqual(result.items.length, 1, '重複が増殖している');
  assert.strictEqual(result.items[0].collected_at, '2026-09-28');
  assert.strictEqual(result.items[0].metrics.views, 210000);
});

check('intake: genre が違うレコードは別ジャンルに分かれる', () => {
  const aiItem = baseItem({ genre: 'ai', url: 'https://www.tiktok.com/@another/video/999999' });
  const careerItem = baseItem();
  const plans = intake.planIntake(JSON.stringify([aiItem, careerItem]), {}, () => null);
  assert.ok(plans.ai, 'ai ジャンルが無い');
  assert.ok(plans.career, 'career ジャンルが無い');
  assert.strictEqual(plans.ai.items.length, 1);
  assert.strictEqual(plans.career.items.length, 1);
});

check('intake: ratio の降順に並ぶ。のび率が出せないもの（null）は最後', () => {
  const high = baseItem({ url: 'https://www.tiktok.com/@a/video/1', metrics: { views: 500000, likes: null, comments: null, saves: null, shares: null } });
  const low = baseItem({ url: 'https://www.tiktok.com/@b/video/2', metrics: { views: 10000, likes: null, comments: null, saves: null, shares: null } });
  const unknown = baseItem({ url: 'https://www.tiktok.com/@c/video/3', account: { name: 'c', followers: null } });
  const result = intake.intake([low, high, unknown], null, { date: '2026-09-28' });
  assert.strictEqual(result.items.length, 3);
  assert.strictEqual(result.items[0].url, high.url);
  assert.strictEqual(result.items[1].url, low.url);
  assert.strictEqual(result.items[2].url, unknown.url);
  assert.strictEqual(result.items[2].ratio, null);
});

// ---- CLI 実運用に近い形（一時ディレクトリで、research/ には書かない） ----
check('CLI: 通る例で --dry-run すると受理1件になる（research/ には書き込まない）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-intake-'));
  const file = path.join(tmp, 'sample.json');
  fs.writeFileSync(file, JSON.stringify([baseItem()]));
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'benchmark-intake.js'), file, '--dry-run'], { encoding: 'utf8' });
  assert.ok(out.includes('受理 1 件'), out);
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'research', 'career')), '--dry-run なのに research/ に書き込んでしまった');
  fs.rmSync(tmp, { recursive: true, force: true });
});

console.log(`\n${passed} 件成功 / ${failed} 件失敗`);
if (failed) process.exit(1);
