'use strict';
/**
 * 予約コマンド用の合鍵（POST_CLI_TOKEN）が、狭い範囲でしか通らないことを確かめる。
 *
 * ★ 守りたいのは3つ。
 *   1. 鍵が未設定・短い・違うときは絶対に通らない
 *   2. allowToken を書いた入口以外では、正しい鍵でも通らない
 *   3. posts.js では「一覧」と「予約の新規作成」だけ。更新・削除・操作は Cookie だけ
 */

const assert = require('assert');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); failed++; }
}

const TOKEN = 'a'.repeat(40);
process.env.APP_PASSWORD = 'pw-for-test';
process.env.SESSION_SECRET = 'secret-for-test';
delete process.env.POST_CLI_TOKEN;

const auth = require('../lib/auth');

const bearer = (t) => ({ headers: { authorization: `Bearer ${t}` } });
function fakeRes() {
  return {
    code: null, body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

(async () => {
  console.log('\nhasCliToken / guard');

  await check('環境変数が未設定なら、何を送っても false', () => {
    delete process.env.POST_CLI_TOKEN;
    assert.strictEqual(auth.hasCliToken(bearer(TOKEN)), false);
    assert.strictEqual(auth.hasCliToken(bearer('')), false);
    assert.strictEqual(auth.hasCliToken({ headers: {} }), false);
  });

  await check('32文字未満の鍵は、合っていても false', () => {
    process.env.POST_CLI_TOKEN = 'short-token';
    assert.strictEqual(auth.hasCliToken(bearer('short-token')), false);
    process.env.POST_CLI_TOKEN = 'b'.repeat(31);
    assert.strictEqual(auth.hasCliToken(bearer('b'.repeat(31))), false);
  });

  await check('違う鍵・Bearer の無い鍵は false', () => {
    process.env.POST_CLI_TOKEN = TOKEN;
    assert.strictEqual(auth.hasCliToken(bearer('c'.repeat(40))), false);
    assert.strictEqual(auth.hasCliToken({ headers: { authorization: TOKEN } }), false);
    assert.strictEqual(auth.hasCliToken({ headers: { authorization: `bearer ${TOKEN}` } }), false);
  });

  await check('正しい鍵なら true', () => {
    process.env.POST_CLI_TOKEN = TOKEN;
    assert.strictEqual(auth.hasCliToken(bearer(TOKEN)), true);
  });

  await check('guard: 正しい鍵は allowToken のときだけ通る', () => {
    process.env.POST_CLI_TOKEN = TOKEN;
    const r1 = fakeRes();
    assert.strictEqual(auth.guard(bearer(TOKEN), r1, { allowToken: true }), true);
    const r2 = fakeRes();
    assert.strictEqual(auth.guard(bearer(TOKEN), r2, { allowToken: false }), false);
    assert.strictEqual(r2.code, 401);
  });

  await check('guard: opts 無し（今までの呼び方）は鍵を通さない', () => {
    process.env.POST_CLI_TOKEN = TOKEN;
    const res = fakeRes();
    assert.strictEqual(auth.guard(bearer(TOKEN), res), false);
    assert.strictEqual(res.code, 401);
  });

  await check('guard: Cookie のログインは今までどおり通る', () => {
    const req = { headers: { cookie: `${auth.COOKIE}=${auth.issue()}` } };
    assert.strictEqual(auth.guard(req, fakeRes()), true);
    assert.strictEqual(auth.guard(req, fakeRes(), { allowToken: true }), true);
  });

  // ---------------------------------------------------------------- posts.js
  console.log('\napi/posts.js の入口');

  const dbPath = require.resolve('../lib/db.js');
  const dbCalls = [];
  const stubDb = {
    rest: async () => [],
    listAccounts: async () => [],
    listGroups: async () => [],
    updateById: async () => { dbCalls.push('updateById'); },
    deleteById: async () => { dbCalls.push('deleteById'); },
    insert: async () => { dbCalls.push('insert'); return {}; },
    logEvent: async () => {},
    removeFile: async () => {},
  };
  require.cache[dbPath] = { exports: stubDb, loaded: true, id: dbPath, filename: dbPath, paths: [] };
  delete require.cache[require.resolve('../api/posts.js')];
  const posts = require('../api/posts.js');
  process.env.POST_CLI_TOKEN = TOKEN;

  const call = async (method, query, body) => {
    const res = fakeRes();
    await posts({ method, query: query || {}, body, headers: bearer(TOKEN).headers }, res);
    return res;
  };

  await check('鍵 + DELETE は 401（DB に触れない）', async () => {
    const res = await call('DELETE', { id: 'x' });
    assert.strictEqual(res.code, 401);
    assert.deepStrictEqual(dbCalls, []);
  });

  await check('鍵 + PATCH は 401', async () => {
    const res = await call('PATCH', { id: 'x' }, { status: 'scheduled' });
    assert.strictEqual(res.code, 401);
  });

  await check('鍵 + POST（action 付き）は 401', async () => {
    for (const action of ['retry', 'run-now', 'handed', 'unhand']) {
      const res = await call('POST', { id: 'x', action });
      assert.strictEqual(res.code, 401, action);
    }
    assert.deepStrictEqual(dbCalls, []);
  });

  await check('鍵 + GET は通る（一覧が返る）', async () => {
    const res = await call('GET');
    assert.strictEqual(res.code, 200);
    assert.ok('posts' in res.body);
  });

  await check('鍵 + POST（新規）でも、scheduled 以外は 400 で断る', async () => {
    const res = await call('POST', {}, { status: 'draft', title: 't' });
    assert.strictEqual(res.code, 400);
    assert.ok(/予約/.test(res.body.error));
    assert.deepStrictEqual(dbCalls, []);
  });

  await check('鍵 + POST（scheduled）は status の点検を通り、次の点検（投稿先）へ進む', async () => {
    const res = await call('POST', {}, { status: 'scheduled', title: 't' });
    assert.strictEqual(res.code, 400);
    assert.ok(!/予約」の投稿しか/.test(res.body.error), res.body.error);
  });

  await check('鍵なし・Cookie なしは GET も 401', async () => {
    const res = fakeRes();
    await posts({ method: 'GET', query: {}, headers: {} }, res);
    assert.strictEqual(res.code, 401);
  });

  await check('Cookie でログインしていれば、DELETE も今までどおり通る', async () => {
    const res = fakeRes();
    await posts({ method: 'DELETE', query: { id: 'x' }, headers: { cookie: `${auth.COOKIE}=${auth.issue()}` } }, res);
    assert.strictEqual(res.code, 200);
  });

  await check('Cookie でログインしていれば、draft の作成も今までどおり通る', async () => {
    const res = fakeRes();
    await posts({ method: 'POST', query: {}, body: { status: 'draft', title: 't' },
      headers: { cookie: `${auth.COOKIE}=${auth.issue()}` } }, res);
    assert.strictEqual(res.code, 200);
  });

  console.log(`\n${passed} 通過 / ${failed} 失敗`);
  process.exit(failed ? 1 : 0);
})();
