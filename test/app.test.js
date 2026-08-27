'use strict';
/**
 * ネットワークに出ずに、アプリの骨組みが正しく動くかを確かめる。
 * Instagram への通信部分だけ偽物に差し替えて、その手前まで全部通す。
 *
 *   node test/app.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'postdesk-'));
process.env.DATA_DIR = TMP;
process.env.PORT = '39301';
process.env.MEDIA_PORT = '39302';
process.env.IG_ACCESS_TOKEN = 'test-token-xxxxxxxxxxxxxxxxxxxx';

const ig = require('../lib/instagram');
const calls = [];
ig.publish = async (args) => {           // 本物のAPIは叩かない
  calls.push(args);
  if (args.mediaUrl.includes('boom')) {
    throw new ig.InstagramError('わざと失敗させた', 'テスト用');
  }
  return { containerId: 'c1', mediaId: 'm1', permalink: 'https://instagram.com/p/test' };
};

const server = require('../server.js');
const BASE = 'http://127.0.0.1:39301';
const MEDIA = 'http://127.0.0.1:39302';

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['ok', name]); }
  catch (err) { results.push(['NG', name + ' → ' + err.message]); }
}
const json = async (path, options) => {
  const res = await fetch(BASE + path, options);
  return { status: res.status, body: await res.json() };
};
const post = (path, body) => json(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

(async () => {
  await new Promise((r) => setTimeout(r, 250));

  let id;

  await check('空の状態を返せる', async () => {
    const { body } = await json('/api/state');
    assert.deepStrictEqual(body.posts, []);
    assert.strictEqual(body.settings.hasToken, true);
  });

  await check('トークンは画面に丸ごと出さない', async () => {
    const { body } = await json('/api/state');
    const text = JSON.stringify(body);
    assert.ok(!text.includes(process.env.IG_ACCESS_TOKEN), 'トークンが漏れている');
    assert.ok(body.settings.tokenPreview.startsWith('test-t'));
  });

  await check('投稿を作れる', async () => {
    const { body } = await post('/api/posts', {
      body: 'はじめての投稿', targets: ['instagram', 'x'], status: 'draft',
    });
    id = body.post.id;
    assert.strictEqual(body.post.status, 'draft');
    assert.deepStrictEqual(body.post.targets, ['instagram', 'x']);
  });

  await check('知らないSNSは捨てられる', async () => {
    const { body } = await post('/api/posts', { body: 'x', targets: ['instagram', 'mixi'] });
    assert.deepStrictEqual(body.post.targets, ['instagram']);
    await fetch(BASE + '/api/posts/' + body.post.id, { method: 'DELETE' });
  });

  await check('日時なしで予定にはできない', async () => {
    const { status, body } = await post('/api/posts', { id, body: 'x', targets: ['instagram'], status: 'scheduled' });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes('予定日時'));
  });

  await check('メディアを保存できる', async () => {
    const res = await fetch(BASE + '/api/media?name=' + encodeURIComponent('reel.mp4'), {
      method: 'POST', body: Buffer.from('fake-video-bytes'),
    });
    const body = await res.json();
    assert.strictEqual(body.media.kind, 'video');
    assert.ok(fs.existsSync(path.join(TMP, 'media', body.media.file)));
    const saved = await post('/api/posts', {
      id, body: 'リールの本文', targets: ['instagram'], status: 'draft', media: body.media,
    });
    assert.ok(saved.body.post.media);
  });

  await check('扱えない拡張子は断る', async () => {
    const res = await fetch(BASE + '/api/media?name=danger.exe', { method: 'POST', body: Buffer.from('x') });
    assert.strictEqual(res.status, 400);
  });

  await check('公開URLが未設定なら投稿せず理由を返す', async () => {
    const { status, body } = await post('/api/publish/' + id, {});
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes('公開URL'));
  });

  await check('httpのURLは受け付けない', async () => {
    const { status } = await post('/api/settings', { publicBaseUrl: 'http://example.com' });
    assert.strictEqual(status, 400);
  });

  await check('公開URLを保存できる', async () => {
    const { body } = await post('/api/settings', { publicBaseUrl: 'https://tunnel.example.com/' });
    assert.strictEqual(body.settings.publicBaseUrl, 'https://tunnel.example.com');
  });

  await check('Instagram へ投稿できる', async () => {
    const { status, body } = await post('/api/publish/' + id, {});
    assert.strictEqual(status, 200);
    assert.strictEqual(body.post.status, 'posted');
    assert.strictEqual(body.post.results.instagram.permalink, 'https://instagram.com/p/test');
    assert.ok(calls[0].mediaUrl.startsWith('https://tunnel.example.com/media/'));
    assert.strictEqual(calls[0].kind, 'video');
    assert.strictEqual(calls[0].caption, 'リールの本文');
  });

  await check('失敗したら失敗として残る', async () => {
    const made = await post('/api/posts', {
      body: 'こわれる', targets: ['instagram'], status: 'draft',
      media: { file: 'boom.mp4', originalName: 'boom.mp4', kind: 'video', size: 1 },
    });
    const { status } = await post('/api/publish/' + made.body.post.id, {});
    assert.strictEqual(status, 502);
    const { body } = await json('/api/state');
    const p = body.posts.find((x) => x.id === made.body.post.id);
    assert.strictEqual(p.status, 'failed');
    assert.ok(p.history.some((h) => h.event === 'publish:error'));
  });

  await check('予約の時刻が来たら自動で投稿する', async () => {
    const made = await post('/api/posts', {
      body: '予約ぶん', targets: ['instagram'], status: 'scheduled', autoPost: true,
      scheduledAt: new Date(Date.now() - 60_000).toISOString(),
      media: { file: 'ok.mp4', originalName: 'ok.mp4', kind: 'video', size: 1 },
    });
    await server.runScheduler();
    const { body } = await json('/api/state');
    const p = body.posts.find((x) => x.id === made.body.post.id);
    assert.strictEqual(p.status, 'posted');
  });

  await check('まだ時刻が来ていない予約は投稿しない', async () => {
    const made = await post('/api/posts', {
      body: 'まだ先', targets: ['instagram'], status: 'scheduled', autoPost: true,
      scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
      media: { file: 'ok.mp4', originalName: 'ok.mp4', kind: 'video', size: 1 },
    });
    await server.runScheduler();
    const { body } = await json('/api/state');
    assert.strictEqual(body.posts.find((x) => x.id === made.body.post.id).status, 'scheduled');
  });

  await check('自動投稿オフの予約は勝手に送らない', async () => {
    const made = await post('/api/posts', {
      body: '手動でやる', targets: ['instagram'], status: 'scheduled', autoPost: false,
      scheduledAt: new Date(Date.now() - 60_000).toISOString(),
      media: { file: 'ok.mp4', originalName: 'ok.mp4', kind: 'video', size: 1 },
    });
    await server.runScheduler();
    const { body } = await json('/api/state');
    assert.strictEqual(body.posts.find((x) => x.id === made.body.post.id).status, 'scheduled');
  });

  await check('メディアサーバーは /media 以外を出さない', async () => {
    const res = await fetch(MEDIA + '/api/state');
    assert.strictEqual(res.status, 404);
  });

  await check('メディアサーバーは書き込みを受け付けない', async () => {
    const res = await fetch(MEDIA + '/media/x.mp4', { method: 'POST' });
    assert.strictEqual(res.status, 405);
  });

  await check('.. でフォルダの外を読めない', async () => {
    const res = await fetch(MEDIA + '/media/' + encodeURIComponent('../posts.json'));
    assert.strictEqual(res.status, 404);
  });

  await check('削除するとメディアの実体も消える', async () => {
    const { body } = await json('/api/state');
    const target = body.posts.find((p) => p.body === 'リールの本文');
    const file = path.join(TMP, 'media', target.media.file);
    assert.ok(fs.existsSync(file));
    await fetch(BASE + '/api/posts/' + target.id, { method: 'DELETE' });
    assert.ok(!fs.existsSync(file));
  });

  const bad = results.filter((r) => r[0] === 'NG');
  for (const [mark, name] of results) console.log(`  ${mark === 'ok' ? '✓' : '✗'} ${name}`);
  console.log(`\n  ${results.length - bad.length} / ${results.length} 件成功`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(bad.length ? 1 : 0);
})();
