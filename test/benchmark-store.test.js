'use strict';
/**
 * lib/benchmark-store.js（集めた記録をDBにためる・読み出す部分）を確かめる。
 *
 * Supabase には出られないので、db.rest を偽物に差し替えて
 * 「何をどう問い合わせようとしたか」を見る（test/groups.test.js と同じやり方）。
 *
 *   node test/benchmark-store.test.js
 */
const assert = require('assert');
const store = require('../lib/benchmark-store');
const benchmark = require('../lib/benchmark');
const metricsStore = require('../lib/metrics-store');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); failed++; }
}

/** 呼ばれた内容を覚えておく偽の db。 */
function fakeDb(handler) {
  const calls = [];
  return {
    calls,
    rest: async (table, opt) => {
      calls.push({ table, opt });
      return handler ? handler(table, opt) : null;
    },
  };
}

const item = (over) => Object.assign({
  genre: 'ai', platform: 'youtube',
  url: 'https://www.youtube.com/shorts/abc123',
  account: { name: 'A', followers: 1000 },
  metrics: { views: 50000, likes: 1000 },
  content: { format: 'talking', first_line: '題名', hook: 'hook', duration_sec: 30, cta: null, topic: '' },
  collected_at: '2026-09-20',
  ratio: 50,
}, over);

(async () => {
  // ------------------------------------------------------------- saveItems
  await check('saveItems: 1回のリクエストで upsert する（on_conflict・merge-duplicates）', async () => {
    const db = fakeDb((table, opt) => opt.body);
    const items = [item()];
    const res = await store.saveItems(db, items);

    assert.strictEqual(res.saved, 1);
    assert.strictEqual(db.calls.length, 1, '複数回に分けて投げている');
    const { table, opt } = db.calls[0];
    assert.strictEqual(table, 'benchmark_items');
    assert.strictEqual(opt.method, 'POST');
    assert.strictEqual(opt.query.on_conflict, 'genre,item_key');
    assert.strictEqual(opt.prefer, 'resolution=merge-duplicates,return=representation');
  });

  await check('saveItems: item_key は benchmark.keyOf と同じ規則', async () => {
    const db = fakeDb((table, opt) => opt.body);
    const items = [
      item({ url: 'https://www.youtube.com/shorts/xyz789' }),
      item({ url: 'https://www.tiktok.com/@a/video/111', platform: 'tiktok', genre: 'career' }),
    ];
    await store.saveItems(db, items);
    const rows = db.calls[0].opt.body;
    assert.strictEqual(rows[0].item_key, benchmark.keyOf(items[0]));
    assert.strictEqual(rows[1].item_key, benchmark.keyOf(items[1]));
    assert.strictEqual(rows[0].item_key, 'youtube:xyz789');
  });

  await check('saveItems: record にはもとの記録を丸ごと、ratio と collected_at も列に持つ', async () => {
    const db = fakeDb((table, opt) => opt.body);
    const it = item({ ratio: 12.5, collected_at: '2026-09-15' });
    await store.saveItems(db, [it]);
    const row = db.calls[0].opt.body[0];
    assert.deepStrictEqual(row.record, it);
    assert.strictEqual(row.ratio, 12.5);
    assert.strictEqual(row.collected_at, '2026-09-15');
    assert.strictEqual(row.genre, 'ai');
    assert.strictEqual(row.platform, 'youtube');
    assert.strictEqual(row.url, it.url);
    assert.ok(row.updated_at, 'updated_at が無い');
  });

  await check('saveItems: ratio が無いもの（null）もそのまま保存する', async () => {
    const db = fakeDb((table, opt) => opt.body);
    await store.saveItems(db, [item({ ratio: null })]);
    assert.strictEqual(db.calls[0].opt.body[0].ratio, null);
  });

  await check('saveItems: 空配列なら何も投げない', async () => {
    const db = fakeDb((table, opt) => opt.body);
    const res = await store.saveItems(db, []);
    assert.strictEqual(res.saved, 0);
    assert.strictEqual(db.calls.length, 0);
  });

  // ------------------------------------------------------------- listItems
  await check('listItems: genre と JSTの日付で絞り込み、ratio降順で並べる', async () => {
    const rows = [
      { record: { url: 'a', platform: 'youtube', genre: 'career' }, ratio: 50 },
      { record: { url: 'b', platform: 'tiktok', genre: 'career' }, ratio: 10 },
    ];
    const db = fakeDb(() => rows);
    const now = new Date('2026-09-28T00:00:00Z');
    const items = await store.listItems(db, 'career', { days: 30, now });

    assert.strictEqual(db.calls.length, 1);
    const q = db.calls[0].opt.query;
    assert.strictEqual(q.genre, 'eq.career');
    assert.strictEqual(q.order, 'ratio.desc.nullslast');
    const expectedSince = metricsStore.shiftDays(metricsStore.jstToday(now), -30);
    assert.strictEqual(q.collected_at, `gte.${expectedSince}`);

    // record に ratio がくっついて返ってくる
    assert.deepStrictEqual(items[0], { url: 'a', platform: 'youtube', genre: 'career', ratio: 50 });
    assert.deepStrictEqual(items[1], { url: 'b', platform: 'tiktok', genre: 'career', ratio: 10 });
  });

  await check('listItems: 既定は直近30日', async () => {
    const db = fakeDb(() => []);
    const now = new Date('2026-09-28T00:00:00Z');
    await store.listItems(db, 'ai', { now });
    const expectedSince = metricsStore.shiftDays(metricsStore.jstToday(now), -30);
    assert.strictEqual(db.calls[0].opt.query.collected_at, `gte.${expectedSince}`);
  });

  // ------------------------------------------------------------- countItems
  await check('countItems: 件数・SNS内訳・いちばん新しい確認日', async () => {
    const rows = [
      { record: { url: 'a', platform: 'youtube', collected_at: '2026-09-10' }, ratio: 50 },
      { record: { url: 'b', platform: 'youtube', collected_at: '2026-09-20' }, ratio: 10 },
      { record: { url: 'c', platform: 'tiktok', collected_at: '2026-09-05' }, ratio: null },
    ];
    const db = fakeDb(() => rows);
    const counts = await store.countItems(db, 'ai', { now: new Date('2026-09-28T00:00:00Z') });
    assert.strictEqual(counts.total, 3);
    assert.deepStrictEqual(counts.byPlatform, { youtube: 2, tiktok: 1 });
    assert.strictEqual(counts.latestCollectedAt, '2026-09-20');
  });

  await check('countItems: 何も無ければゼロで返す', async () => {
    const db = fakeDb(() => []);
    const counts = await store.countItems(db, 'ai', {});
    assert.strictEqual(counts.total, 0);
    assert.deepStrictEqual(counts.byPlatform, {});
    assert.strictEqual(counts.latestCollectedAt, null);
  });

  // ------------------------------------------------------------- research_runs
  await check('createRun: running で1行作る', async () => {
    const db = fakeDb((table, opt) => [{ id: 'r1', genre: 'ai', status: 'running' }]);
    const run = await store.createRun(db, 'ai');
    assert.strictEqual(db.calls[0].table, 'research_runs');
    assert.strictEqual(db.calls[0].opt.method, 'POST');
    assert.deepStrictEqual(db.calls[0].opt.body, { genre: 'ai', status: 'running' });
    assert.strictEqual(run.id, 'r1');
  });

  await check('updateRun: id で1行更新し、updated_at を付ける', async () => {
    const db = fakeDb((table, opt) => [{ id: 'r1', status: 'done', facts: { n: 1 } }]);
    const run = await store.updateRun(db, 'r1', { status: 'done', facts: { n: 1 } });
    const { opt } = db.calls[0];
    assert.strictEqual(opt.method, 'PATCH');
    assert.strictEqual(opt.query.id, 'eq.r1');
    assert.strictEqual(opt.body.status, 'done');
    assert.ok(opt.body.updated_at);
    assert.strictEqual(run.status, 'done');
  });

  await check('latestRun: そのジャンルでいちばん新しい1件', async () => {
    const db = fakeDb(() => [{ id: 'r2', genre: 'career', status: 'done' }]);
    const run = await store.latestRun(db, 'career');
    const { opt } = db.calls[0];
    assert.strictEqual(opt.query.genre, 'eq.career');
    assert.strictEqual(opt.query.order, 'created_at.desc');
    assert.strictEqual(opt.query.limit, '1');
    assert.strictEqual(run.id, 'r2');
  });

  await check('latestRun: 無ければ null', async () => {
    const db = fakeDb(() => []);
    const run = await store.latestRun(db, 'career');
    assert.strictEqual(run, null);
  });

  await check('getRun: idで1件', async () => {
    const db = fakeDb(() => [{ id: 'r3' }]);
    const run = await store.getRun(db, 'r3');
    assert.strictEqual(db.calls[0].opt.query.id, 'eq.r3');
    assert.strictEqual(run.id, 'r3');
  });

  console.log(`\n${passed} 件成功 / ${failed} 件失敗`);
  if (failed) process.exit(1);
})();
