'use strict';
/**
 * 投稿が終わった動画を置き場から消す（lib/media-cleanup.js）。
 *
 * ★ 守りたいのは「消してはいけない動画を消さない」こと。
 *   - 下書き・予約中・失敗（出し直しに要る）・手渡し前の動画は消さない
 *   - 同じ動画を別の投稿が使っていて、そちらが終わっていなければ消さない（DAY1の事故）
 *   - 投稿してすぐは消さない（手作業で取り出すことがある）
 *
 *   node test/media-cleanup.test.js
 */
const assert = require('assert');
const mc = require('../lib/media-cleanup');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['ok', name]); }
  catch (err) { results.push(['NG', name + ' → ' + err.message]); }
}

const NOW = new Date('2026-10-07T00:00:00Z');
const OLD = '2026-10-01T10:00:00Z';
const NEW = '2026-10-06T10:00:00Z';
const post = (id, path, statuses, at = OLD) => ({
  id, media_path: path, scheduled_at: at, created_at: at,
  targets: statuses.map((s) => ({ status: s, posted_at: s === 'success' ? at : null })),
});

(async () => {
  await check('全部の投稿先が済んで3日たった動画だけを選ぶ', () => {
    const picks = mc.pickDeletable([
      post('a', 'day1.mp4', ['success', 'success', 'handed']),
      post('b', 'day6.mp4', ['success', 'success'], NEW),          // 投稿してすぐ
      post('c', 'day2.mp4', ['success', 'failed']),                 // 失敗が残る
      post('d', 'day3.mp4', ['success', 'manual']),                 // 手渡し前
      post('e', 'day4.mp4', ['queued']),                            // 予約中
      post('f', 'draft.mp4', []),                                   // 下書き
      post('g', 'skip.mp4', ['success', 'skipped']),
    ], NOW);
    assert.deepStrictEqual(picks.map((p) => p.path).sort(), ['day1.mp4', 'skip.mp4']);
  });

  await check('同じ動画を使う別の投稿が終わっていなければ消さない（DAY1の事故）', () => {
    const picks = mc.pickDeletable([
      post('a', 'shared.mp4', ['success']),
      post('b', 'shared.mp4', ['queued']),
    ], NOW);
    assert.deepStrictEqual(picks, []);
    const both = mc.pickDeletable([
      post('a', 'shared.mp4', ['success']),
      post('b', 'shared.mp4', ['success']),
    ], NOW);
    assert.deepStrictEqual(both, [{ path: 'shared.mp4', postIds: ['a', 'b'] }]);
  });

  await check('消したら投稿の media_path を空にする。dry=1 なら何も消さない', async () => {
    const calls = [];
    const db = {
      rest: async (table, opt = {}) => {
        calls.push([table, opt.method || 'GET', opt.query && opt.query.id, opt.body]);
        if (!opt.method) {
          return [{ id: 'a', media_path: 'day1.mp4', scheduled_at: OLD, created_at: OLD, post_targets: [{ status: 'success', posted_at: OLD }] }];
        }
        return null;
      },
      removeFile: async (p) => calls.push(['remove', p]),
    };
    const dry = await mc.run(db, { dry: true, now: NOW });
    assert.deepStrictEqual(dry.files, ['day1.mp4']);
    assert.ok(!calls.some((c) => c[0] === 'remove'), 'dry なのに消した');
    const out = await mc.run(db, { now: NOW });
    assert.strictEqual(out.removed, 1);
    assert.ok(calls.some((c) => c[0] === 'remove' && c[1] === 'day1.mp4'));
    assert.ok(calls.some((c) => c[0] === 'posts' && c[1] === 'PATCH' && c[2] === 'in.(a)' && c[3].media_path === null));
  });

  await check('毎日の cron が登録されていて、cron の鍵が無いと動かない', async () => {
    const v = require('../vercel.json');
    assert.ok((v.crons || []).some((c) => c.path === '/api/insights?cleanup=media'), 'cron が無い');
    process.env.CRON_SECRET = 'x';
    const handler = require('../api/insights');
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json() { return this; }, setHeader() {} };
    await handler({ method: 'GET', query: { cleanup: 'media' }, headers: {} }, res);
    assert.strictEqual(res.statusCode, 401);
  });

  for (const [s, n] of results) console.log((s === 'ok' ? '  ✓ ' : '  ✗ ') + n);
  const ng = results.filter((r) => r[0] !== 'ok').length;
  console.log(`\n  ${results.length - ng} / ${results.length} 件成功`);
  if (ng) process.exit(1);
})();
