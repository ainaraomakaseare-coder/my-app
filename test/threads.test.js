'use strict';
/**
 * Threads への投稿とトークンの延長を、通信せずに確かめる。
 *
 * ★ 守りたいのは4つ。
 *   1. コンテナ → 準備待ち → 公開 の3段階を1分ずつ進める（Instagram と同じ作法）
 *   2. 公開したのに記録前に落ちても、二度は公開しない
 *   3. トークンは切れる前に自動で延ばす（60日ごとの貼り直しを残さない）
 *   4. 案件リンクを含む投稿は Threads に出せない（A8.net の案内）
 */

const assert = require('assert');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); failed++; }
}

process.env.THREADS_APP_ID = 'app';
process.env.THREADS_APP_SECRET = 'secret';

const threads = require('../lib/threads');
const net = require('../lib/networks/threads');
const scope = require('../lib/account-scope');
const handoff = require('../lib/handoff');

const DAY = 24 * 60 * 60 * 1000;
const inDays = (d) => new Date(Date.now() + d * DAY).toISOString();

/** Threads の API の偽物。path の一部 → 返事 の表で答え、呼ばれた順を記録する。 */
function fakeApi(table) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts && opts.body ? Object.fromEntries(new URLSearchParams(opts.body)) : null;
    calls.push({ url: u, method: (opts && opts.method) || 'GET', body });
    const key = Object.keys(table).find((k) => u.includes(k));
    const r = key ? table[key] : { status: 404, json: { error: { message: 'not found' } } };
    const text = JSON.stringify(r.json);
    return { ok: (r.status || 200) < 400, status: r.status || 200, text: async () => text };
  };
  return calls;
}

function fakeDb(row) {
  const state = { row: Object.assign({}, row) };
  return {
    state,
    getAccount: async () => Object.assign({}, state.row),
    updateAccount: async (id, patch) => { Object.assign(state.row, patch); return state.row; },
    signedUrl: async () => 'https://storage.example/signed.mp4',
  };
}

const account = { id: 'acc', network: 'threads', external_id: '123', access_token: 'T', expires_at: inDays(50), meta: {} };

(async () => {
  const realFetch = global.fetch;

  console.log('\n投稿の3段階');

  await check('(1) 文字だけの投稿は TEXT でコンテナを作る', async () => {
    const calls = fakeApi({ '/123/threads': { json: { id: 'C1' } } });
    const out = await net.step({ post: { body_common: 'こんにちは' }, target: {}, account, db: fakeDb(account) });
    assert.strictEqual(out.stage, 'container_created');
    assert.strictEqual(out.externalId, 'C1');
    assert.strictEqual(calls[0].body.media_type, 'TEXT');
    assert.strictEqual(calls[0].body.text, 'こんにちは');
  });

  await check('(1) 動画つきは VIDEO と署名付きURLを渡す（Threads 用の本文を優先）', async () => {
    const calls = fakeApi({ '/123/threads': { json: { id: 'C2' } } });
    await net.step({
      post: { body_common: '共通', th_text: 'スレッズ用', media_path: 'a.mp4', media_kind: 'video' },
      target: {}, account, db: fakeDb(account),
    });
    assert.strictEqual(calls[0].body.media_type, 'VIDEO');
    assert.strictEqual(calls[0].body.video_url, 'https://storage.example/signed.mp4');
    assert.strictEqual(calls[0].body.text, 'スレッズ用');
  });

  await check('(2) 準備中なら公開せずに待つ', async () => {
    const calls = fakeApi({ '/C1?': { json: { status: 'IN_PROGRESS' } } });
    const out = await net.step({ post: { body_common: 'x' }, target: { external_id: 'C1', stage: 'container_created' }, account, db: fakeDb(account) });
    assert.ok(out.wait);
    assert.ok(!calls.some((c) => c.url.includes('threads_publish')));
  });

  await check('(3) 準備が終わったら公開し、URLを持ち帰る', async () => {
    fakeApi({
      '/C1?': { json: { status: 'FINISHED' } },
      'threads_publish': { json: { id: 'M1' } },
      '/M1?': { json: { permalink: 'https://www.threads.net/@hiroya/post/abc' } },
    });
    const out = await net.step({ post: { body_common: 'x' }, target: { external_id: 'C1', stage: 'container_created' }, account, db: fakeDb(account) });
    assert.ok(out.done);
    assert.strictEqual(out.externalId, 'M1');
    assert.strictEqual(out.permalink, 'https://www.threads.net/@hiroya/post/abc');
  });

  await check('公開済みのコンテナは、もう一度公開しない（記録前に落ちた場合）', async () => {
    const calls = fakeApi({ '/C1?': { json: { status: 'PUBLISHED' } } });
    const out = await net.step({ post: { body_common: 'x' }, target: { external_id: 'C1', stage: 'container_created' }, account, db: fakeDb(account) });
    assert.ok(out.done);
    assert.ok(!calls.some((c) => c.url.includes('threads_publish')));
  });

  await check('500文字を超える本文は、送らずに止める', async () => {
    const calls = fakeApi({});
    await assert.rejects(() => net.step({ post: { body_common: 'あ'.repeat(501) }, target: {}, account, db: fakeDb(account) }), /長すぎます/);
    assert.strictEqual(calls.length, 0);
  });

  console.log('\nトークンの延長');

  await check('残りが7日を切ったら延ばして、新しい期限を保存する', async () => {
    const acc = Object.assign({}, account, { expires_at: inDays(3), meta: { issued_at: inDays(-57) } });
    const db = fakeDb(acc);
    fakeApi({ 'refresh_access_token': { json: { access_token: 'T2', expires_in: 5184000 } } });
    assert.strictEqual(await threads.accessTokenFor(Object.assign({}, acc), db), 'T2');
    assert.ok(new Date(db.state.row.expires_at).getTime() > Date.now() + 50 * DAY);
  });

  await check('まだ余裕があれば延ばさない', async () => {
    const calls = fakeApi({});
    assert.strictEqual(await threads.accessTokenFor(Object.assign({}, account), fakeDb(account)), 'T');
    assert.strictEqual(calls.length, 0);
  });

  await check('延ばすのに失敗しても、まだ切れていなければ今のトークンで続ける', async () => {
    const acc = Object.assign({}, account, { expires_at: inDays(2) });
    fakeApi({ 'refresh_access_token': { status: 400, json: { error: { code: 1, message: 'too early' } } } });
    assert.strictEqual(await threads.accessTokenFor(Object.assign({}, acc), fakeDb(acc)), 'T');
  });

  await check('本当に切れていて延ばせなければ、理由を残して止める', async () => {
    const acc = Object.assign({}, account, { expires_at: inDays(-1) });
    const db = fakeDb(acc);
    fakeApi({ 'refresh_access_token': { status: 400, json: { error: { code: 190, message: 'expired' } } } });
    await assert.rejects(() => threads.accessTokenFor(Object.assign({}, acc), db), /無効/);
    assert.ok(db.state.row.meta.auth_error);
  });

  await check('連携：code を長期トークンまで引き換える', async () => {
    fakeApi({
      '/oauth/access_token': { json: { access_token: 'short', user_id: 123 } },
      '/access_token?': { json: { access_token: 'long', expires_in: 5184000 } },
    });
    const t = await threads.exchangeCode('code', 'https://x/api/connect/threads');
    assert.strictEqual(t.access_token, 'long');
    assert.strictEqual(t.user_id, '123');
  });

  console.log('\n決まりごと');

  await check('案件リンクを含む投稿は Threads に出せない（A8.net の案内）', () => {
    const issue = scope.checkTarget({ hasAffiliateLink: true }, { network: 'threads', label: 'T' });
    assert.ok(issue && issue.code === 'affiliate-not-allowed');
  });

  await check('Threads は即公開のSNS。自動投稿を許していなければ手渡しにする', () => {
    assert.ok(handoff.isPublishing('threads'));
    assert.strictEqual(handoff.statusForTarget({ auto_publish_networks: [] }, 'threads'), 'manual');
    assert.strictEqual(handoff.statusForTarget({ auto_publish_networks: ['threads'] }, 'threads'), 'queued');
  });

  global.fetch = realFetch;
  console.log(`\n${passed} 件成功 / ${failed} 件失敗`);
  if (failed) process.exit(1);
})();
