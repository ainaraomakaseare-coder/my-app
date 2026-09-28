'use strict';
/**
 * Threads への投稿とトークンの延長を、通信せずに確かめる。
 *
 * ★ 守りたいのは4つ。
 *   1. コンテナ → 準備待ち → 公開 の3段階を1分ずつ進める（Instagram と同じ作法）
 *   2. 公開したのに記録前に落ちても、二度は公開しない
 *   3. トークンは切れる前に自動で延ばす（60日ごとの貼り直しを残さない）
 *   4. 案件つきの投稿は、本文にリンクを入れずプロフィール欄へ誘導する（A8.net の案内）
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
const rules = require('../lib/draft-rules');

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

  // ★ A8.net は Threads を掲載できる SNS として認めている。ただし本文への
  //   リンク掲載は控え、プロフィール欄のリンクを使うよう案内している。
  await check('案件つきの投稿も Threads に出せる（A8.net の掲載対象）', () => {
    assert.strictEqual(scope.checkTarget({ hasAffiliateLink: true }, { network: 'threads', label: 'T' }), null);
  });

  await check('X は引き続き、案件つきの投稿を出せない', () => {
    const issue = scope.checkTarget({ hasAffiliateLink: true }, { network: 'x', label: 'X' });
    assert.ok(issue && issue.code === 'affiliate-not-allowed');
  });

  // ★ Threads は文字が主役で、リプライが続く投稿ほど広がる。X 用の本文（画像に添える前提）
  //   の使い回しをやめ、Threads 専用に書かせた thText を使う。
  await check('Threads 専用の本文（thText）があれば、X 用ではなくそちらを使う', () => {
    const t = rules.threadsText({ xText: 'X用', thText: '面接で落ちる人の共通点\n\n・…\n\nどれか当てはまった？', hashtags: ['面接対策', '転職'] }, false);
    assert.ok(t.startsWith('面接で落ちる人の共通点'), t);
    assert.ok(!t.includes('X用'));
  });

  await check('古い文案（thText なし）は、X 用の本文で代える', () => {
    const t = rules.threadsText({ xText: '面接で落ちる6つ', hashtags: ['面接対策'] }, false);
    assert.ok(t.startsWith('面接で落ちる6つ'), t);
  });

  await check('話題タグは1つだけ（いちばん具体的な先頭のタグ）', () => {
    const t = rules.threadsText({ thText: '本文です。どれか当てはまった？', hashtags: ['面接対策', '転職', '第二新卒'] }, false);
    assert.strictEqual((t.match(/#/g) || []).length, 1, t);
    assert.ok(/#面接対策$/.test(t), t);
  });

  await check('案件つきは、リンクを抜いて【PR】付きでプロフィールへ誘導する（話題タグの枠は使わない）', () => {
    const t = rules.threadsText({ thText: '面接で落ちる6つ。3番が意外 https://px.a8.net/abc', hashtags: ['面接対策', '転職'] }, true);
    assert.ok(!/https?:\/\//.test(t), 'リンクが残っている: ' + t);
    assert.ok(t.includes(rules.THREADS_PR_CTA), '【PR】付きの誘導が無い: ' + t);
    assert.ok(/#面接対策$/.test(t), '話題タグが無い: ' + t);
    assert.ok(!t.includes('#PR'), 'PR で話題タグの枠を使っている');
    assert.deepStrictEqual(rules.threadsProblems(t, true), []);
  });

  await check('AI には Threads 専用の本文を必ず書かせる（構造化出力の required）', () => {
    const gen = require('../lib/draft-generate');
    assert.ok(gen.SCHEMA.required.includes('thText'), 'thText が required に無い');
    assert.ok(/thText/.test(gen.SYSTEM_PROMPT) && /問いかけ/.test(gen.SYSTEM_PROMPT), 'Threads の書き方を指示していない');
  });

  await check('案件つきの回は、thText にもリンクとPR表記を書かないよう伝える', () => {
    const gen = require('../lib/draft-generate');
    const msg = gen.buildUserMessage({ title: '面接', hasAffiliateLink: true });
    assert.ok(/thText/.test(msg), msg);
  });

  await check('Threads 本文が長すぎたら作り直させる', () => {
    const d = { thText: 'あ'.repeat(rules.THREADS_BODY_MAX + 1) };
    assert.ok(rules.findingsOf(d, 'threads-too-long').length === 1);
  });

  await check('Threads 本文にリンクがあれば作り直させる', () => {
    assert.ok(rules.findingsOf({ thText: '詳しくは https://example.com へ。どう思う？' }, 'threads-link').length === 1);
  });

  await check('Threads 本文の一人称の体験も、他の本文と同じく止める', () => {
    const f = rules.validateDraft({ thText: '正直、私も転職して年収が上がりました。どう思う？' })
      .filter((x) => x.field === 'thText' && x.severity === 'error');
    assert.ok(f.length > 0, '一人称の体験を通している');
  });

  await check('案件つきで本文にリンクがあれば止める', () => {
    const p = rules.threadsProblems('6つのポイント https://px.a8.net/abc #PR', true);
    assert.ok(p.some((m) => /リンク/.test(m)));
  });

  await check('案件つきでPR表記が無ければ止める', () => {
    const p = rules.threadsProblems('6つのポイント。詳しくはプロフィールから', true);
    assert.ok(p.some((m) => /PR表記/.test(m)));
  });

  await check('案件なしなら、リンクがあっても止めない（企画の投稿）', () => {
    assert.deepStrictEqual(rules.threadsProblems('作ったアプリ https://example.com', false), []);
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
