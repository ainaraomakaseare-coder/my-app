'use strict';
/**
 * クラウド版の要になる部分を、ネットワークに出ずに確かめる。
 *
 * この開発環境からは Supabase にも各SNSにも通信できないので、
 * DB と SNS を偽物に差し替えて「呼ぶ手前まで」の正しさを保証する。
 * DAY8 と同じ分担。
 */

const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); failed++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

// ---------------------------------------------------------------------------
console.log('\n時刻（日本時間 → UTC）');

const posts = require('../api/posts.js');

test('日本時間の20時は、UTCの11時として保存される', () => {
  assert.strictEqual(posts.jstToUtc('2026-09-01T20:00'), '2026-09-01T11:00:00.000Z');
});

test('日付をまたぐ時刻も正しくずれる（JST 9/1 5:00 → UTC 8/31 20:00）', () => {
  assert.strictEqual(posts.jstToUtc('2026-09-01T05:00'), '2026-08-31T20:00:00.000Z');
});

test('空欄は「予約なし」として扱う', () => {
  assert.strictEqual(posts.jstToUtc(''), null);
});

test('読めない形式は、その場で断る', () => {
  assert.throws(() => posts.jstToUtc('9月1日の夜'));
});

// ---------------------------------------------------------------------------
console.log('\nログイン');

process.env.APP_PASSWORD = 'test-password-for-unit-test';
process.env.SESSION_SECRET = 'test-session-secret';
const auth = require('../lib/auth.js');

const withCookie = (v) => ({ headers: { cookie: `td_session=${v}` } });

test('正しい合言葉だけを通す', () => {
  assert.ok(auth.checkPassword('test-password-for-unit-test'));
  assert.ok(!auth.checkPassword('test-password-for-unit-tesT'));
  assert.ok(!auth.checkPassword(''));
});

test('発行した紙は本物として通る', () => {
  assert.ok(auth.isLoggedIn(withCookie(auth.issue())));
});

test('中身を書き換えた紙は見破る', () => {
  const token = auth.issue();
  const [body, mac] = token.split('.');
  const forged = `${Number(body) + 999999999}.${mac}`;   // 期限だけ延ばす細工
  assert.ok(!auth.isLoggedIn(withCookie(forged)));
});

test('署名のない紙は通さない', () => {
  assert.ok(!auth.isLoggedIn(withCookie(String(Date.now() + 100000))));
});

test('期限切れの紙は通さない', () => {
  const crypto = require('crypto');
  const past = String(Date.now() - 1000);
  const mac = crypto.createHmac('sha256', 'test-session-secret').update(past).digest('base64url');
  assert.ok(!auth.isLoggedIn(withCookie(`${past}.${mac}`)));
});

test('Cookie が無ければ入れない', () => {
  assert.ok(!auth.isLoggedIn({ headers: {} }));
});

// ---------------------------------------------------------------------------
console.log('\n予約実行（二重投稿・部分失敗・再試行）');

// --- DB の偽物 -------------------------------------------------------------
function fakeDb(state) {
  return {
    async rpc(fn) {
      if (fn === 'requeue_stuck_targets') return 0;
      if (fn === 'claim_due_targets') {
        // ★ 本物の SQL と同じ振る舞い：queued の行だけを取り、取った瞬間に
        //   processing へ変える。だから2回呼んでも同じ行は返らない。
        const got = state.targets.filter((t) => t.status === 'queued');
        got.forEach((t) => { t.status = 'processing'; t.attempt += 1; });
        return got.map((t) => ({ ...t }));
      }
      return null;
    },
    async rest(table, opt) {
      if (table === 'posts') return [state.post];
      return [];
    },
    async updateById(table, id, patch) {
      const row = state.targets.find((t) => t.id === id);
      Object.assign(row, patch);
      return row;
    },
    async insert() { return [{}]; },
    async logEvent(postId, network, event, detail) {
      state.events.push({ network, event, detail });
    },
    async signedUrl() { return 'https://example.test/signed'; },
    async download() { return Buffer.alloc(10); },
    async getToken() { return { access_token: 'dummy' }; },
    async saveToken() {},
  };
}

function setup() {
  return {
    post: { id: 'p1', media_path: 'a.mp4', media_kind: 'video', ig_caption: 'あ', body_common: 'あ' },
    targets: [
      { id: 't-ig', post_id: 'p1', network: 'instagram', status: 'queued', attempt: 0, external_id: null, stage: null },
      { id: 't-x',  post_id: 'p1', network: 'x',         status: 'queued', attempt: 0, external_id: null, stage: null },
    ],
    events: [],
  };
}

/** 通信部分を差し替えた worker を読み込む。 */
function loadWorker(state, behaviour) {
  for (const k of Object.keys(require.cache)) {
    if (/lib[\/\\](db|networks)|api[\/\\]worker/.test(k)) delete require.cache[k];
  }
  require.cache[require.resolve('../lib/db.js')] = { exports: fakeDb(state), loaded: true, id: 'db' };
  for (const net of ['instagram', 'youtube', 'x', 'tiktok']) {
    require.cache[require.resolve(`../lib/networks/${net}.js`)] = {
      exports: { step: behaviour[net] || (async () => ({ done: true, externalId: 'x1', permalink: null })) },
      loaded: true, id: net,
    };
  }
  return require('../api/worker.js');
}

function fakeRes() {
  return {
    code: null, body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const CRON = { headers: { 'x-cron-key': 'unit-test-cron-key' } };
process.env.CRON_SECRET = 'unit-test-cron-key';

(async () => {
  await testAsync('鍵が違う呼び出しは 401 で断る', async () => {
    const state = setup();
    const worker = loadWorker(state, {});
    const res = fakeRes();
    await worker({ headers: { 'x-cron-key': 'wrong' }, query: {} }, res);
    assert.strictEqual(res.code, 401);
  });

  await testAsync('時間が来た投稿は、SNSごとに処理される', async () => {
    const state = setup();
    const worker = loadWorker(state, {});
    const res = fakeRes();
    await worker({ ...CRON, query: {} }, res);
    assert.strictEqual(res.code, 200);
    assert.strictEqual(state.targets.filter((t) => t.status === 'success').length, 2);
  });

  await testAsync('★ 2回続けて実行しても、同じSNSへ二度は送らない', async () => {
    const state = setup();
    let calls = 0;
    const count = async () => { calls++; return { done: true, externalId: 'x1' }; };
    const worker = loadWorker(state, { instagram: count, x: count });

    await worker({ ...CRON, query: {} }, fakeRes());
    await worker({ ...CRON, query: {} }, fakeRes());   // 直後にもう一度叩く

    assert.strictEqual(calls, 2, `2回のはずが ${calls} 回呼ばれた`);
  });

  await testAsync('★ 一方が失敗しても、もう一方の成功は保たれる（一部成功）', async () => {
    const state = setup();
    const worker = loadWorker(state, {
      x: async () => { throw new Error('残高が足りません'); },
    });
    await worker({ ...CRON, query: {} }, fakeRes());

    const ig = state.targets.find((t) => t.network === 'instagram');
    const x  = state.targets.find((t) => t.network === 'x');
    assert.strictEqual(ig.status, 'success', 'Instagram は成功のままであるべき');
    assert.strictEqual(x.status, 'queued', 'X は再試行待ちになるべき');
    assert.ok(x.next_attempt_at, '次に試す時刻が入っているべき');
  });

  await testAsync('★ 3回失敗したら自動再試行をやめ、手動を待つ', async () => {
    const state = setup();
    state.targets = [state.targets[1]];              // X だけにする
    const worker = loadWorker(state, {
      x: async () => { throw new Error('だめでした'); },
    });

    for (let i = 0; i < 3; i++) {
      state.targets[0].status = 'queued';
      state.targets[0].next_attempt_at = null;
      await worker({ ...CRON, query: {} }, fakeRes());
    }
    assert.strictEqual(state.targets[0].status, 'failed');
    assert.strictEqual(state.targets[0].attempt, 3);
  });

  await testAsync('★ 変換待ちは失敗回数に数えない（待つだけで諦めない）', async () => {
    const state = setup();
    state.targets = [state.targets[0]];              // Instagram だけ
    const worker = loadWorker(state, {
      instagram: async () => ({ wait: true, stage: 'container_created', externalId: 'c1', seconds: 20 }),
    });

    for (let i = 0; i < 5; i++) {
      state.targets[0].status = 'queued';
      await worker({ ...CRON, query: {} }, fakeRes());
    }
    assert.strictEqual(state.targets[0].attempt, 0, '待っただけで失敗回数が増えてはいけない');
    assert.strictEqual(state.targets[0].external_id, 'c1', '途中経過が残っているべき');
  });

  await testAsync('失敗の理由と次の一手が、履歴に日本語で残る', async () => {
    const state = setup();
    const worker = loadWorker(state, {
      x: async () => {
        const e = new Error('X の残高が足りません。');
        e.hint = '開発者ポータルでチャージしてください。';
        throw e;
      },
    });
    await worker({ ...CRON, query: {} }, fakeRes());
    const log = state.events.find((e) => e.network === 'x');
    assert.ok(/残高/.test(log.detail), '理由が残っていない');
    assert.ok(/チャージ/.test(log.detail), '次の一手が残っていない');
  });

  console.log(`\n  ${passed} / ${passed + failed} 件成功\n`);
  process.exit(failed ? 1 : 0);
})();
