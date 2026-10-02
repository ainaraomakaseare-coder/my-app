'use strict';
/**
 * 本文のあとに付ける「返信」を、通信せずに確かめる（X と Threads）。
 *
 * ★ 守りたいのは3つ。
 *   1. 返信が無い投稿は、いままでと1手も変わらない
 *   2. 本文の投稿IDを残してから返信に進む（同じ分に続けて送らない）
 *   3. 返信でつまずいて再実行しても、本文は二度と出さない
 */

const assert = require('assert');
const fs = require('fs');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); failed++; }
}

process.env.THREADS_APP_ID = 'app';
process.env.THREADS_APP_SECRET = 'secret';

const xNet = require('../lib/networks/x');
const thNet = require('../lib/networks/threads');

const DAY = 24 * 60 * 60 * 1000;
const soon = new Date(Date.now() + 50 * DAY).toISOString();
const xAccount = { id: 'x1', network: 'x', access_token: 'T', refresh_token: 'R', expires_at: soon, meta: {} };
const thAccount = { id: 't1', network: 'threads', external_id: '123', access_token: 'T', expires_at: soon, meta: {} };

/** API の偽物。URL の一部 → 返事 の表で答え、呼ばれた順を記録する。 */
function fakeApi(table) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    let body = null;
    if (opts && typeof opts.body === 'string') {
      try { body = JSON.parse(opts.body); } catch (_) { body = Object.fromEntries(new URLSearchParams(opts.body)); }
    } else if (opts && opts.body) {
      body = Object.fromEntries(new URLSearchParams(opts.body));
    }
    calls.push({ url: u, method: (opts && opts.method) || 'GET', body });
    const key = Object.keys(table).find((k) => u.includes(k));
    const r = key ? table[key] : { status: 404, json: { error: { message: 'not found' } } };
    const text = JSON.stringify(r.json);
    return { ok: (r.status || 200) < 400, status: r.status || 200, text: async () => text, json: async () => r.json };
  };
  return calls;
}

function fakeDb(row) {
  const updates = [];
  return {
    updates,
    getAccount: async () => Object.assign({}, row),
    updateAccount: async (id, patch) => Object.assign(row, patch),
    updateById: async (table, id, patch) => { updates.push({ table, id, patch }); },
  };
}

const LINK = '▼紹介ページ\nhttps://example.com/lp/';

(async () => {
  const realFetch = global.fetch;

  console.log('\nX の返信');

  await check('返信が無ければ、いままでどおり1手で完了する', async () => {
    const calls = fakeApi({ '/2/tweets': { json: { data: { id: '100' } } } });
    const out = await xNet.step({ post: { x_text: '本文' }, target: {}, account: xAccount, db: fakeDb(xAccount) });
    assert.ok(out.done);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].body.reply, undefined);
  });

  await check('返信があれば、本文を出した分では返信を送らず、本文のIDを残して待つ', async () => {
    const calls = fakeApi({ '/2/tweets': { json: { data: { id: '100' } } } });
    const out = await xNet.step({ post: { x_text: '本文', reply_text: LINK }, target: {}, account: xAccount, db: fakeDb(xAccount) });
    assert.ok(out.wait && !out.done);
    assert.strictEqual(out.stage, xNet.REPLY_STAGE);
    assert.strictEqual(out.externalId, '100');
    assert.strictEqual(calls.length, 1, '同じ分に返信まで送っている');
  });

  await check('次の分に、本文への返信として1本だけ送って完了する', async () => {
    const calls = fakeApi({ '/2/tweets': { json: { data: { id: '200' } } } });
    const out = await xNet.step({
      post: { x_text: '本文', reply_text: LINK },
      target: { stage: xNet.REPLY_STAGE, external_id: '100' }, account: xAccount, db: fakeDb(xAccount),
    });
    assert.ok(out.done);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].body.text, LINK);
    assert.deepStrictEqual(calls[0].body.reply, { in_reply_to_tweet_id: '100' });
    // 記録に残るのは本文のID。返信のIDは別に持つ。
    assert.strictEqual(out.externalId, '100');
    assert.strictEqual(out.replyId, '200');
    assert.strictEqual(out.permalink, 'https://x.com/i/status/100');
  });

  await check('動画つきでも、返信の段階では本文もメディアも送り直さない', async () => {
    const calls = fakeApi({ '/2/tweets': { json: { data: { id: '200' } } } });
    await xNet.step({
      post: { x_text: '本文', reply_text: LINK, media_path: 'a.mp4', media_kind: 'video' },
      target: { stage: xNet.REPLY_STAGE, external_id: '100' }, account: xAccount, db: fakeDb(xAccount),
    });
    assert.strictEqual(calls.length, 1);
    assert.ok(!calls.some((c) => c.url.includes('/media/')));
    assert.strictEqual(calls[0].body.media, undefined);
  });

  await check('返信がもう付いていれば、送らずに完了する', async () => {
    const calls = fakeApi({});
    const out = await xNet.step({
      post: { x_text: '本文', reply_text: LINK },
      target: { stage: xNet.REPLY_STAGE, external_id: '100', reply_external_id: '200' }, account: xAccount, db: fakeDb(xAccount),
    });
    assert.ok(out.done);
    assert.strictEqual(calls.length, 0);
  });

  await check('重複で断られたら（付いたのに記録前に落ちていた）、完了にする', async () => {
    fakeApi({ '/2/tweets': { status: 403, json: { detail: 'You are not allowed to create a Tweet with duplicate content.' } } });
    const out = await xNet.step({
      post: { x_text: '本文', reply_text: LINK },
      target: { stage: xNet.REPLY_STAGE, external_id: '100' }, account: xAccount, db: fakeDb(xAccount),
    });
    assert.ok(out.done);
  });

  await check('返信の失敗は「本文は投稿済み」と分かる言い方で止める', async () => {
    fakeApi({ '/2/tweets': { status: 429, json: {} } });
    await assert.rejects(
      xNet.step({
        post: { x_text: '本文', reply_text: LINK },
        target: { stage: xNet.REPLY_STAGE, external_id: '100' }, account: xAccount, db: fakeDb(xAccount),
      }),
      (e) => /本文は投稿済み/.test(e.message) && /返信だけをやり直します/.test(e.hint)
    );
  });

  console.log('\nThreads の返信');

  const published = {
    '/C1?': { json: { status: 'FINISHED' } },
    'threads_publish': { json: { id: 'M1' } },
    '/M1?': { json: { permalink: 'https://www.threads.net/@hiroya/post/abc' } },
  };

  await check('返信が無ければ、公開した分で完了する（いままでどおり）', async () => {
    fakeApi(published);
    const out = await thNet.step({ post: { th_text: '本文' }, target: { external_id: 'C1', stage: 'container_created' }, account: thAccount, db: fakeDb(thAccount) });
    assert.ok(out.done);
    assert.strictEqual(out.externalId, 'M1');
  });

  await check('返信があれば、公開した分では完了にせず、本文の投稿IDを残して待つ', async () => {
    const calls = fakeApi(published);
    const out = await thNet.step({ post: { th_text: '本文', reply_text: LINK }, target: { external_id: 'C1', stage: 'container_created' }, account: thAccount, db: fakeDb(thAccount) });
    assert.ok(out.wait && !out.done);
    assert.strictEqual(out.stage, thNet.NEEDS_REPLY);
    assert.strictEqual(out.externalId, 'M1');
    assert.ok(!calls.some((c) => c.body && c.body.reply_to_id), '同じ分に返信まで作っている');
  });

  await check('次の分に、reply_to_id を付けた文字だけのコンテナを作る', async () => {
    const calls = fakeApi({ '/123/threads': { json: { id: 'R1' } } });
    const out = await thNet.step({ post: { th_text: '本文', reply_text: LINK }, target: { external_id: 'M1', stage: thNet.NEEDS_REPLY }, account: thAccount, db: fakeDb(thAccount) });
    assert.ok(out.wait);
    assert.strictEqual(out.stage, thNet.REPLY_CREATED);
    assert.strictEqual(out.replyId, 'R1');
    assert.strictEqual(out.externalId, undefined, '本文の投稿IDを書き換えてはいけない');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].body.reply_to_id, 'M1');
    assert.strictEqual(calls[0].body.media_type, 'TEXT');
    assert.strictEqual(calls[0].body.text, LINK);
  });

  await check('返信の準備が終わったら公開し、本文のURLで完了する', async () => {
    const calls = fakeApi({
      '/R1?': { json: { status: 'FINISHED' } },
      'threads_publish': { json: { id: 'RM1' } },
      '/M1?': { json: { permalink: 'https://www.threads.net/@hiroya/post/abc' } },
    });
    const out = await thNet.step({
      post: { th_text: '本文', reply_text: LINK },
      target: { external_id: 'M1', reply_external_id: 'R1', stage: thNet.REPLY_CREATED }, account: thAccount, db: fakeDb(thAccount),
    });
    assert.ok(out.done);
    assert.strictEqual(out.externalId, 'M1');
    assert.strictEqual(out.replyId, 'RM1');
    assert.strictEqual(out.permalink, 'https://www.threads.net/@hiroya/post/abc');
    const pub = calls.filter((c) => c.url.includes('threads_publish'));
    assert.strictEqual(pub.length, 1);
    assert.strictEqual(pub[0].body.creation_id, 'R1', '本文のコンテナをもう一度公開している');
  });

  await check('返信が公開済みなら、二度は公開しない（記録前に落ちた場合）', async () => {
    const calls = fakeApi({ '/R1?': { json: { status: 'PUBLISHED' } }, '/M1?': { json: { permalink: 'p' } } });
    const out = await thNet.step({
      post: { th_text: '本文', reply_text: LINK },
      target: { external_id: 'M1', reply_external_id: 'R1', stage: thNet.REPLY_CREATED }, account: thAccount, db: fakeDb(thAccount),
    });
    assert.ok(out.done);
    assert.ok(!calls.some((c) => c.url.includes('threads_publish')));
  });

  await check('返信の準備に失敗したら、作り直す段階に戻して「本文は投稿済み」と伝える', async () => {
    fakeApi({ '/R1?': { json: { status: 'ERROR', error_message: 'bad' } } });
    const db = fakeDb(thAccount);
    await assert.rejects(
      thNet.step({
        post: { th_text: '本文', reply_text: LINK },
        target: { id: 'tg1', external_id: 'M1', reply_external_id: 'R1', stage: thNet.REPLY_CREATED }, account: thAccount, db,
      }),
      (e) => /本文は投稿済み/.test(e.message)
    );
    assert.deepStrictEqual(db.updates, [{ table: 'post_targets', id: 'tg1', patch: { stage: thNet.NEEDS_REPLY } }]);
  });

  console.log('\n保存と移行');

  await check('schema_v14 に、返信の文と返信のIDの列がある（何度流してもよい書き方）', () => {
    const sql = fs.readFileSync(__dirname + '/../supabase/schema_v14_reply.sql', 'utf8');
    assert.ok(/alter table posts add column if not exists reply_text/.test(sql));
    assert.ok(/alter table post_targets add column if not exists reply_external_id/.test(sql));
  });

  await check('案件つきの投稿には返信を付けられない（api/posts.js で断る）', () => {
    const src = fs.readFileSync(__dirname + '/../api/posts.js', 'utf8');
    assert.ok(/案件リンクを含む投稿には、返信を付けられません/.test(src));
  });

  await check('画面に返信の欄があり、保存する中身に入る', () => {
    const html = fs.readFileSync(__dirname + '/../public/index.html', 'utf8');
    assert.ok(html.includes('<textarea id="rp"'));
    assert.ok(html.includes("reply_text: $('rp').value"));
  });

  global.fetch = realFetch;
  console.log(`\n${passed} 件成功 / ${failed} 件失敗`);
  if (failed) process.exit(1);
})();
