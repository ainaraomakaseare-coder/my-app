'use strict';
/**
 * 連携が「1日で切れる」への手当てを、通信せずに確かめる。
 *
 *   1. 取り直す前に DB の最新を読む（TikTok は引換券を取り替えることがある）
 *   2. 同じ行を使い回す呼び出しで、2回目に古い券で取り直さない
 *   3. 取り直しに失敗したら理由を残し、成功したら消す
 */

const assert = require('assert');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); failed++; }
}

process.env.TIKTOK_CLIENT_KEY = 'k';
process.env.TIKTOK_CLIENT_SECRET = 's';
process.env.GOOGLE_CLIENT_ID = 'g';
process.env.GOOGLE_CLIENT_SECRET = 'gs';

const tiktok = require('../lib/tiktok');
const google = require('../lib/google');

const past = () => new Date(Date.now() - 1000).toISOString();

/** DB の偽物。行を1つ持ち、書き込みを記録する。 */
function fakeDb(row) {
  const state = { row: Object.assign({}, row), writes: [] };
  return {
    state,
    getAccount: async () => Object.assign({}, state.row),
    updateAccount: async (id, patch) => { state.writes.push(patch); Object.assign(state.row, patch); return state.row; },
  };
}

/** トークンの窓口の偽物。送られた引換券を記録する。 */
function fakeTokenApi(reply) {
  const sent = [];
  global.fetch = async (url, opts) => {
    const body = new URLSearchParams(opts.body);
    sent.push(body.get('refresh_token'));
    const r = typeof reply === 'function' ? reply(body) : reply;
    return { ok: !r.error, status: r.error ? 400 : 200, json: async () => r };
  };
  return sent;
}

(async () => {
  const realFetch = global.fetch;

  console.log('\nTikTok');

  await check('取り直す前に DB の最新の引換券を使う（手元の古い券を出さない）', async () => {
    const db = fakeDb({ id: 'a', refresh_token: 'R2', access_token: 'old', expires_at: past(), meta: {} });
    const stale = { id: 'a', refresh_token: 'R1', access_token: 'old', expires_at: past(), meta: {} };
    const sent = fakeTokenApi({ access_token: 'A3', refresh_token: 'R3', expires_in: 86400, scope: 'user.info.basic' });
    await tiktok.accessTokenFor(stale, db);
    assert.deepStrictEqual(sent, ['R2']);
    assert.strictEqual(db.state.row.refresh_token, 'R3');
  });

  await check('同じ行で2回呼んでも、取り直しは1回だけ', async () => {
    const db = fakeDb({ id: 'a', refresh_token: 'R1', access_token: 'old', expires_at: past(), meta: {} });
    const row = await db.getAccount();
    const sent = fakeTokenApi({ access_token: 'A2', refresh_token: 'R2', expires_in: 86400 });
    assert.strictEqual(await tiktok.accessTokenFor(row, db), 'A2');
    assert.strictEqual(await tiktok.accessTokenFor(row, db), 'A2');
    assert.strictEqual(sent.length, 1);
  });

  await check('取り直しに失敗したら、理由を残してエラーはそのまま返す', async () => {
    const db = fakeDb({ id: 'a', refresh_token: 'R1', access_token: 'old', expires_at: past(), meta: { scopes: ['x'] } });
    fakeTokenApi({ error: 'invalid_grant', error_description: 'Refresh token is invalid' });
    await assert.rejects(() => tiktok.accessTokenFor(Object.assign({}, db.state.row), db), /認証に失敗/);
    assert.ok(/invalid_grant/.test(db.state.row.meta.auth_error.message));
    assert.deepStrictEqual(db.state.row.meta.scopes, ['x'], '権限の記録を消した');
  });

  await check('取り直しに成功したら、失敗の記録は消える', async () => {
    const db = fakeDb({ id: 'a', refresh_token: 'R1', access_token: 'old', expires_at: past(),
      meta: { auth_error: { at: 'x', message: 'y' } } });
    fakeTokenApi({ access_token: 'A2', refresh_token: 'R2', expires_in: 86400 });
    await tiktok.accessTokenFor(Object.assign({}, db.state.row), db);
    assert.strictEqual(db.state.row.meta.auth_error, undefined);
  });

  console.log('\nYouTube');

  await check('取り直しに失敗したら、理由（invalid_grant）を残す', async () => {
    const db = fakeDb({ id: 'y', refresh_token: 'G1', access_token: 'old', expires_at: past(), meta: {} });
    fakeTokenApi({ error: 'invalid_grant' });
    await assert.rejects(() => google.accessTokenFor(Object.assign({}, db.state.row), db));
    assert.ok(db.state.row.meta.auth_error && /無効/.test(db.state.row.meta.auth_error.message));
  });

  await check('ほかの処理がすでに取り直していれば、取り直さない', async () => {
    const future = new Date(Date.now() + 3600e3).toISOString();
    const db = fakeDb({ id: 'y', refresh_token: 'G1', access_token: 'fresh', expires_at: future, meta: {} });
    const sent = fakeTokenApi({ access_token: 'never' });
    const token = await google.accessTokenFor({ id: 'y', refresh_token: 'G1', access_token: 'old', expires_at: past() }, db);
    assert.strictEqual(token, 'fresh');
    assert.strictEqual(sent.length, 0);
  });

  global.fetch = realFetch;
  console.log(`\n${passed} 件成功 / ${failed} 件失敗`);
  if (failed) process.exit(1);
})();
