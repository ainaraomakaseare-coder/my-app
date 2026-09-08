'use strict';
/**
 * lib/google.js（YouTubeのOAuth）を確かめる。
 *
 * ★ ここで守りたいこと。
 *   「毎日（頻繁に）YouTubeとの連携が切れる」という相談を受けて調べたところ、
 *   コード自体には問題が無く、Google Cloud Console の OAuth同意画面が
 *   「テスト中」のままだとリフレッシュトークンが7日で強制的に切れる
 *   仕様に行き当たった。コードでは防げないので、invalid_grant が出たときに
 *   その原因（本番に公開すれば直る）へ気づけるヒントを返すようにした。
 *   ここではヒントの中身がちゃんと出ることだけを確かめる。
 *
 *   node test/google.test.js
 */
const assert = require('assert');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['ok', name]); }
  catch (err) { results.push(['NG', name + ' → ' + err.message]); }
}

function withFetch(reply) {
  const real = global.fetch;
  global.fetch = async () => ({
    ok: false,
    async json() { return reply; },
  });
  return () => { global.fetch = real; };
}

process.env.GOOGLE_CLIENT_ID = 'id';
process.env.GOOGLE_CLIENT_SECRET = 'secret';
const google = require('../lib/google.js');

(async () => {
  await check('invalid_grant は「テスト中の同意画面」に気づけるヒントを返す', async () => {
    const restore = withFetch({ error: 'invalid_grant' });
    try {
      await google.refresh('dummy');
      assert.fail('例外が飛ぶはず');
    } catch (e) {
      assert.ok(/テスト中/.test(e.hint), 'テスト中の同意画面に触れていない: ' + e.hint);
      assert.ok(/本番/.test(e.hint), '本番に公開する直し方が書かれていない: ' + e.hint);
      assert.ok(/7日/.test(e.hint), '7日で切れる仕様に触れていない: ' + e.hint);
    } finally { restore(); }
  });

  await check('invalid_grant 以外は、クライアントID／シークレットのヒントのまま', async () => {
    const restore = withFetch({ error: 'invalid_client' });
    try {
      await google.refresh('dummy');
      assert.fail('例外が飛ぶはず');
    } catch (e) {
      assert.ok(/クライアントID/.test(e.hint), 'クライアントIDのヒントが無い: ' + e.hint);
      assert.ok(!/テスト中/.test(e.hint), '関係の無いエラーにまでテスト中の話を出している');
    } finally { restore(); }
  });

  const ng = results.filter((r) => r[0] === 'NG');
  for (const [state, name] of results) console.log(`  ${state === 'ok' ? '✓' : '✗'} ${name}`);
  console.log(`\n  ${results.length - ng.length} / ${results.length} 件成功`);
  if (ng.length) process.exit(1);
})();
