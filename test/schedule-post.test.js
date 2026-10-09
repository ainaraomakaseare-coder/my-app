'use strict';
/**
 * 予約コマンド（scripts/schedule-post.js）の、通信を使わない部分を確かめる。
 */

const assert = require('assert');
const cli = require('../scripts/schedule-post.js');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); failed++; }
}

const G = '6765a825-5031-46f4-9384-13c842750428';

(async () => {
  console.log('\n引数');

  await check('--to は複数指定でき、重複は1つにまとめる', () => {
    const o = cli.parseArgs(['--to', 'x', '--to', 'threads', '--to', 'x', '--text-file', 'a.txt', '--now']);
    assert.deepStrictEqual(o.to, ['x', 'threads']);
    assert.strictEqual(o.now, true);
    assert.strictEqual(o.textFile, 'a.txt');
  });

  await check('--at と --now の両方、どちらも無い、は断る', () => {
    assert.throws(() => cli.parseArgs(['--to', 'x', '--text-file', 'a', '--now', '--at', '2030-01-01T10:00']), /同時/);
    assert.throws(() => cli.parseArgs(['--to', 'x', '--text-file', 'a']), /--at か --now/);
  });

  await check('知らない投稿先・知らない指定・値なしは断る', () => {
    assert.throws(() => cli.parseArgs(['--to', 'line', '--text-file', 'a', '--now']), /使えるのは/);
    assert.throws(() => cli.parseArgs(['--foo']), /知らない指定/);
    assert.throws(() => cli.parseArgs(['--to']), /値がありません/);
  });

  await check('YouTube は --title が無いと断る', () => {
    assert.throws(() => cli.parseArgs(['--to', 'youtube', '--text-file', 'a', '--now']), /--title/);
  });

  console.log('\n時刻');

  await check('--now: 2分以上先の、次のちょうど分（日本時間）', () => {
    // 2026-10-09 08:00:30 UTC = 17:00:30 JST → +2分 = 17:02:30 → 17:03
    assert.strictEqual(cli.nextMinute(Date.parse('2026-10-09T08:00:30Z')), '2026-10-09T17:03');
    // ちょうど分なら、そのまま2分後
    assert.strictEqual(cli.nextMinute(Date.parse('2026-10-09T08:00:00Z')), '2026-10-09T17:02');
  });

  await check('--now: 日付をまたぐ（UTC 15:00 以降は日本では翌日）', () => {
    assert.strictEqual(cli.nextMinute(Date.parse('2026-10-09T14:59:10Z')), '2026-10-10T00:02');
  });

  await check('--at: 過去・形の違い・存在しない日時は断る', () => {
    const now = Date.parse('2026-10-09T08:00:00Z');   // 17:00 JST
    assert.throws(() => cli.validateAt('2026-10-09T16:59', now), /過去/);
    assert.throws(() => cli.validateAt('2026-10-09T17:00', now), /過去/);
    assert.throws(() => cli.validateAt('2026-10-09 18:00', now), /形/);
    assert.throws(() => cli.validateAt('2026-02-31T18:00', now), /正しくありません/);
    assert.strictEqual(cli.validateAt('2026-10-09T17:30', now), '2026-10-09T17:30');
  });

  console.log('\n本文');

  await check('BOM と末尾の空白を落とす', () => {
    assert.strictEqual(cli.cleanText('﻿こんにちは\n\n  '), 'こんにちは');
  });

  await check('X は日本語1文字＝2で280まで。Threads は500文字まで', () => {
    assert.deepStrictEqual(cli.lengthProblems('あ'.repeat(140), ['x']), []);
    assert.ok(cli.lengthProblems('あ'.repeat(141), ['x'])[0].includes('X の本文'));
    assert.deepStrictEqual(cli.lengthProblems('あ'.repeat(141), ['threads']), []);
    assert.ok(cli.lengthProblems('あ'.repeat(501), ['threads'])[0].includes('Threads'));
  });

  console.log('\n運用アカウントと投稿先');

  await check('--group: UUID はそのまま、名前は部分一致で1件だけ', () => {
    const groups = [{ id: 'g1', label: 'アフィリ用' }, { id: 'g2', label: '企画用' }];
    assert.strictEqual(cli.resolveGroup(null, groups), G);
    assert.strictEqual(cli.resolveGroup('企画', groups), 'g2');
    assert.throws(() => cli.resolveGroup('用', groups), /複数/);
    assert.throws(() => cli.resolveGroup('存在しない', groups), /ありません/);
  });

  const accounts = [
    { id: 'ax', network: 'x', group_id: G, label: 'X本番' },
    { id: 'at', network: 'threads', group_id: G },
    { id: 'ax2', network: 'x', group_id: 'other' },
    { id: 'ai1', network: 'instagram', group_id: G },
    { id: 'ai2', network: 'instagram', group_id: G },
  ];

  await check('投稿先: 運用アカウントが合う1件を選ぶ。0件・複数は断る', () => {
    assert.deepStrictEqual(cli.pickAccounts(['x', 'threads'], accounts, G).map((a) => a.id), ['ax', 'at']);
    assert.throws(() => cli.pickAccounts(['tiktok'], accounts, G), /つながっていません/);
    assert.throws(() => cli.pickAccounts(['instagram'], accounts, G), /複数/);
  });

  console.log('\n重複');

  const at = Date.parse('2026-10-10T08:00:00Z');
  const posts = [
    { id: 'p1', status: 'scheduled', scheduled_at: '2026-10-10T20:00:00Z', x_text: '同じ本文' },
    { id: 'p2', status: 'draft', scheduled_at: '2026-10-10T08:00:00Z', x_text: '同じ本文' },
    { id: 'p3', status: 'done', scheduled_at: '2026-10-12T08:00:00Z', x_text: '同じ本文' },
    { id: 'p4', status: 'done', scheduled_at: '2026-10-10T09:00:00Z', x_text: '別の本文' },
    { id: 'p5', status: 'done', scheduled_at: '2026-10-10T09:00:00Z', th_text: '同じ本文\n' },
  ];

  await check('±24時間以内・予約か投稿済みで、同じ本文だけ拾う', () => {
    const d = cli.findDuplicates(posts, { text: '同じ本文', networks: ['x'], scheduledMs: at });
    assert.deepStrictEqual(d.map((p) => p.id), ['p1']);
  });

  await check('Threads を選んでいれば th_text も見る（末尾の改行は無視）', () => {
    const d = cli.findDuplicates(posts, { text: '同じ本文', networks: ['threads'], scheduledMs: at });
    assert.deepStrictEqual(d.map((p) => p.id), ['p5']);
  });

  console.log('\n送る中身');

  await check('投稿の本体: 投稿先・本文・予約の形', () => {
    const b = cli.buildBody({
      text: '本文', networks: ['x', 'threads'], title: 'T', whenJst: '2026-10-09T17:30',
      groupId: G, accountIds: ['ax', 'at'], media: { path: 'a/b.jpg', kind: 'image', bytes: 10 },
    });
    assert.strictEqual(b.status, 'scheduled');
    assert.deepStrictEqual(b.targets, ['ax', 'at']);
    assert.strictEqual(b.x_text, '本文');
    assert.strictEqual(b.th_text, '本文');
    assert.strictEqual(b.body_common, '本文');
    assert.strictEqual(b.ig_caption, '本文');
    assert.strictEqual(b.yt_title, '');
    assert.strictEqual(b.scheduled_at_jst, '2026-10-09T17:30');
    assert.strictEqual(b.media_path, 'a/b.jpg');
    assert.strictEqual(b.has_affiliate_link, false);
    assert.strictEqual(b.reply_text, '');
    assert.strictEqual(b.tt_settings, null);
  });

  await check('X を選ばなければ x_text は空。YouTube は title と本文を入れる。画像なしは null', () => {
    const b = cli.buildBody({
      text: '説明', networks: ['youtube'], title: '題', whenJst: '2026-10-09T17:30',
      groupId: G, accountIds: ['ay'], media: null,
    });
    assert.strictEqual(b.x_text, '');
    assert.strictEqual(b.th_text, '');
    assert.strictEqual(b.yt_title, '題');
    assert.strictEqual(b.yt_description, '説明');
    assert.strictEqual(b.media_path, null);
  });

  console.log(`\n${passed} 通過 / ${failed} 失敗`);
  process.exit(failed ? 1 : 0);
})();
