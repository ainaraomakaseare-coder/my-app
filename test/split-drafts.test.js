'use strict';
/**
 * AI の投稿案をまとめて貼ったときの振り分けを確かめる。
 * 見本は、実際に貼られた DAY31（次の一本 横浜）の投稿案。
 */

const assert = require('assert');
const { split, xLength, headingOf } = require('../public/split-drafts.js');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); failed++; }
}

const DAY31 = `## Instagram

映画の時間、映画館ごとに調べ直すの面倒じゃない？🎬

30日で30アプリ、終わったけどもう1本。
番外編DAY31は「次の一本 横浜」を作りました！

#30日で30アプリ #DAY31 #AI初心者 #個人開発 #横浜 #映画好き

## TikTok

映画を探している間に、上映が始まる問題😂🎬

#30日で30アプリ #DAY31 #AI開発 #横浜 #映画

## YouTube Shorts

**タイトル**
映画館ごとに調べるの面倒！横浜の上映まとめ検索を作った【番外編DAY31】

**概要欄**
30日で30アプリ、終わったけどもう1本！

【今回の記録】
人間：約1時間

#Shorts #30日で30アプリ #DAY31 #個人開発 #映画

## X

映画の時間、映画館ごとに調べるの面倒🎬

番外編DAY31は「次の一本 横浜」！
映画・場所・時間から、横浜周辺5館の上映情報をまとめて確認する自分用ツールです。

人間約1h／AI約1h、追加費用0円。
最新情報は公式サイトで確認。

次に欲しいアプリ、教えてください！

#30日で30アプリ #個人開発

## Threads

30日で30アプリ、終わったはずなのに、また作りました😂

皆さんは、普段どんな「地味に面倒」を感じていますか？`;

console.log('\n振り分け');
const out = split(DAY31);

check('5つのSNSを全部見つける', () => {
  assert.deepStrictEqual(out.found, ['instagram', 'tiktok', 'youtube', 'x', 'threads']);
});

check('Instagram の本文は、見出しを含まず、段落の区切りとハッシュタグを残す', () => {
  assert.ok(out.instagram.startsWith('映画の時間、映画館ごとに調べ直すの面倒じゃない？🎬'));
  assert.ok(out.instagram.includes('\n\n30日で30アプリ、終わったけどもう1本。'));
  assert.ok(out.instagram.endsWith('#映画好き'));
  assert.ok(!out.instagram.includes('## '));
});

check('YouTube はタイトルと概要欄に分ける（** は落とす）', () => {
  assert.strictEqual(out.youtubeTitle, '映画館ごとに調べるの面倒！横浜の上映まとめ検索を作った【番外編DAY31】');
  assert.ok(out.youtubeDescription.startsWith('30日で30アプリ、終わったけどもう1本！'));
  assert.ok(out.youtubeDescription.endsWith('#映画'));
  assert.ok(!out.youtubeDescription.includes('**'));
});

check('概要欄の中の【今回の記録】は、見出しと間違えずに本文として残す', () => {
  assert.ok(out.youtubeDescription.includes('【今回の記録】\n人間：約1時間'));
});

check('X と Threads も取れる', () => {
  assert.ok(out.x.startsWith('映画の時間、映画館ごとに調べるの面倒🎬'));
  assert.ok(out.threads.endsWith('感じていますか？'));
});

check('貼った文章は1文字も書き換えない', () => {
  assert.ok(DAY31.includes(out.instagram));
  assert.ok(DAY31.includes(out.x));
  assert.ok(DAY31.includes(out.threads));
});

console.log('\n見出しの揺れ');

check('いろいろな書き方の見出しを拾う', () => {
  for (const [line, net] of [
    ['## Instagram', 'instagram'], ['【インスタ】', 'instagram'], ['■ TikTok', 'tiktok'],
    ['### YouTube Shorts', 'youtube'], ['X', 'x'], ['## X（Twitter）', 'x'],
    ['Threads：', 'threads'], ['【スレッズ】', 'threads'], ['## Instagram（リール）', 'instagram'],
  ]) assert.strictEqual(headingOf(line), net, line);
});

check('本文の行は見出しにしない', () => {
  for (const line of ['X でも話題に', '【今回の記録】', 'Instagram で見てね', '#30日で30アプリ']) {
    assert.strictEqual(headingOf(line), null, line);
  }
});

check('YouTube に小見出しが無ければ、1行目をタイトルにする', () => {
  const r = split('## YouTube\nタイトルの行\n\n説明の1行目\n説明の2行目');
  assert.strictEqual(r.youtubeTitle, 'タイトルの行');
  assert.strictEqual(r.youtubeDescription, '説明の1行目\n説明の2行目');
});

check('「タイトル：〜」と同じ行に書いた形も読める', () => {
  const r = split('## YouTube\nタイトル：同じ行のタイトル\n概要欄：\n本文');
  assert.strictEqual(r.youtubeTitle, '同じ行のタイトル');
  assert.strictEqual(r.youtubeDescription, '本文');
});

console.log('\nX の文字数');

check('日本語は1文字＝2で数える（140文字で上限）', () => {
  assert.strictEqual(xLength('あ'.repeat(140)), 280);
  assert.strictEqual(xLength('abc'), 3);
});

check('URL は長さによらず23', () => {
  assert.strictEqual(xLength('https://example.com/very/long/path/that/goes/on'), 23);
});

check('今回の X の投稿案は、X の上限（280）に収まっているか数えられる', () => {
  const n = xLength(out.x);
  assert.ok(n > 0);
  console.log(`      （DAY31 の X 案は ${n}／280）`);
});

console.log(`\n${passed} 件成功 / ${failed} 件失敗`);
if (failed) process.exit(1);
