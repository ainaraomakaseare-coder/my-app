'use strict';
/**
 * public/entry-paste.js（Claude が整理した記録を「この日の記録」に貼る）を確かめる。
 *
 * ★ 守りたいのは3つ。
 *   1. 前後に説明文があっても、【投稿卓の記録】のブロックだけを読む
 *   2. 企画に無い売上の内訳や読めない数字は、黙って捨てず注意として出す（数字を盛らない）
 *   3. 読んだ記録はサーバーの normalizeEntry をそのまま通る
 *
 *   node test/entry-paste.test.js
 */
const assert = require('assert');
const fs = require('fs');
const { parse, num } = require('../public/entry-paste');
const series = require('../lib/series');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); failed++; }
}

const CATS = ['アプリ課金', 'アフィリエイト', 'note'];
const PASTED = `今日の記録を整理しました。

【投稿卓の記録】
{"date":"2026-10-01",
 "income":{"アプリ課金":0,"アフィリエイト":0,"note":1480},
 "expenses":[{"item":"ドメイン代","yen":1500}],
 "tasks":[{"name":"LP作成","humanMin":30,"aiMin":15}],
 "services":[{"name":"家計簿アプリ","earn":"月額課金"}],
 "accounts":["A8.net","note"],
 "learnings":"LPは先に見出しだけ決めると速い"}

保存は画面で押してください。`;

check('前後の説明文を無視してブロックを読む', () => {
  const out = parse(PASTED, CATS);
  assert.strictEqual(out.date, '2026-10-01');
  assert.deepStrictEqual(out.entry.income, { アプリ課金: 0, アフィリエイト: 0, note: 1480 });
  assert.deepStrictEqual(out.entry.tasks, [{ name: 'LP作成', humanMin: 30, aiMin: 15 }]);
  assert.deepStrictEqual(out.entry.accounts, ['A8.net', 'note']);
  assert.deepStrictEqual(out.warnings, []);
});

check('API に送る形（{date, entry}）も読む', () => {
  const out = parse(JSON.stringify({ date: '2026-10-02', entry: { learnings: 'x', income: { note: 500 } } }), CATS);
  assert.strictEqual(out.date, '2026-10-02');
  assert.strictEqual(out.entry.learnings, 'x');
  assert.strictEqual(out.entry.income.note, 500);
});

check('企画に無い売上の内訳は入れずに注意を出す', () => {
  const out = parse('{"income":{"ココナラ":3000,"note":100}}', CATS);
  assert.deepStrictEqual(out.entry.income, { note: 100 });
  assert.ok(out.warnings.some((w) => w.includes('ココナラ')));
});

check('読めない数字は 0 にせず注意を出す（売上）', () => {
  const out = parse('{"income":{"note":"たくさん"}}', CATS);
  assert.ok(!('note' in out.entry.income));
  assert.ok(out.warnings.some((w) => w.includes('たくさん')));
});

check('"1,480円" や全角数字は数にする', () => {
  assert.strictEqual(num('1,480円'), 1480);
  assert.strictEqual(num('１４８０'), 1480);
  assert.strictEqual(num('30分'), 30);
  assert.strictEqual(num(''), 0);
  assert.strictEqual(num('abc'), null);
});

check('日付が無い・読めないときは null（画面の日付のまま）', () => {
  assert.strictEqual(parse('{"learnings":"a"}', CATS).date, null);
  const out = parse('{"date":"10月1日"}', CATS);
  assert.strictEqual(out.date, null);
  assert.ok(out.warnings.length);
});

check('ブロックが無い・壊れているときは分かる言葉で止める', () => {
  assert.throws(() => parse('今日は何もしてない', CATS), /見つかりません/);
  assert.throws(() => parse('{"income":{', CATS), /見つかりません|読めません/);
  assert.throws(() => parse('{"a":1,}', CATS), /読めません/);
});

check('読んだ記録は normalizeEntry をそのまま通る', () => {
  const s = series.normalizeSeries({ name: '100万', goalYen: 1000000, incomeCategories: CATS.join('\n'), startDate: '2026-10-01', endDate: '2027-03-31' });
  const out = parse(PASTED, s.incomeCategories);
  const e = series.normalizeEntry(out.entry, s);
  assert.strictEqual(e.income.note, 1480);
  assert.strictEqual(e.expenses[0].yen, 1500);
  assert.strictEqual(e.services[0].name, '家計簿アプリ');
});

check('index.html が entry-paste.js を読み、貼る欄がある', () => {
  const html = fs.readFileSync(__dirname + '/../public/index.html', 'utf8');
  assert.ok(html.includes('<script src="/entry-paste.js'));
  assert.ok(html.includes('id="entryPaste"'));
  assert.ok(html.includes('EntryPaste.parse('));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
