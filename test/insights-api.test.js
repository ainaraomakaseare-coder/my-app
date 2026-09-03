'use strict';
/**
 * 取り込みの入口を確かめる。
 *
 * ★ ここで守りたいのは3つ。
 *   1. 1つのSNSが失敗しても、他の取り込みが止まらない
 *      （1件のせいで、その日のぶんが丸ごと消えるのがいちばん困る）
 *   2. 同じ日に2回叩いても、行が増えない
 *   3. 取れなかったことも、理由つきで書き留める
 *
 *   node test/insights-api.test.js
 */
const assert = require('assert');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['ok', name]); }
  catch (err) { results.push(['NG', name + ' → ' + err.message]); }
}

const A1 = '11111111-1111-1111-1111-111111111111';
const A2 = '22222222-2222-2222-2222-222222222222';
const G1 = '99999999-9999-9999-9999-999999999999';

/** Supabase の代わり。書き込みは「表」に積んで、同じ鍵なら上書きする。 */
function fakeDb(state) {
  const s = Object.assign({ accounts: [], targets: [], rows: {} }, state);
  s.calls = [];

  const key = (table, row) => {
    if (table === 'account_metrics') return `${row.account_id}|${row.taken_on}`;
    if (table === 'target_metrics') return `${row.post_target_id}|${row.taken_on}`;
    return `${row.account_id}|${row.video_id}|${row.taken_on}`;
  };

  return {
    listAccounts: async () => s.accounts.map(({ access_token, refresh_token, ...a }) => a),
    getAccount: async (id) => s.accounts.find((a) => a.id === id) || null,
    rest: async (table, opt) => {
      s.calls.push([table, (opt && opt.method) || 'GET']);
      if (opt && opt.method === 'POST') {
        const bag = (s.rows[table] = s.rows[table] || new Map());
        for (const row of opt.body) bag.set(key(table, row), row);
        return opt.body;
      }
      if (table === 'post_targets') return s.targets;
      if (table === 'account_metrics') return [...(s.rows.account_metrics || new Map()).values()];
      if (table === 'target_metrics') return [...(s.rows.target_metrics || new Map()).values()];
      if (table === 'tiktok_videos') return [...(s.rows.tiktok_videos || new Map()).values()];
      return [];
    },
    _state: s,
  };
}

/** 差し替えたうえで api/insights.js を読み直す。 */
function load(db, insights) {
  const stubs = {
    '../lib/db.js': db,
    '../lib/insights.js': insights,
    '../lib/auth.js': { guard: () => true },
  };
  for (const k of Object.keys(require.cache)) {
    if (k.includes('api/insights.js') || k.includes('lib/metrics-store.js')) delete require.cache[k];
  }
  for (const [m, exports] of Object.entries(stubs)) {
    const abs = require.resolve(m);
    delete require.cache[abs];
    require.cache[abs] = { exports, loaded: true, id: abs, filename: abs, paths: [] };
  }
  delete require.cache[require.resolve('../api/insights.js')];
  return require('../api/insights.js');
}

function fakeRes() {
  return {
    code: 0, body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const req = (over) => Object.assign(
  { method: 'POST', query: {}, headers: { 'x-cron-key': 'secret' } }, over);

(async () => {
  process.env.CRON_SECRET = 'secret';

  const twoAccounts = [
    { id: A1, network: 'youtube', label: 'ひろや', group_id: G1, access_token: 'a' },
    { id: A2, network: 'instagram', label: '転職', group_id: G1, access_token: 'b' },
  ];

  // ★ いちばん大事な性質。1件の失敗で全部が止まると、その日のぶんが消える。
  await check('1つのSNSが失敗しても、もう一方は取り込まれる', async () => {
    const db = fakeDb({ accounts: twoAccounts });
    const api = load(db, {
      accountStats: async (a) => (a.network === 'instagram'
        ? { ok: false, error: '権限がありません', raw: {} }
        : { ok: true, metrics: { followers: 120, views: 5000, likes: null, posts: 12 }, raw: {} }),
      postStats: async () => ({ ok: false, error: 'なし' }),
      recentVideos: async () => ({ ok: false, error: 'なし' }),
    });
    const res = fakeRes();
    await api(req(), res);

    assert.strictEqual(res.code, 200);
    const rows = [...db._state.rows.account_metrics.values()];
    assert.strictEqual(rows.length, 2, '2件とも書けていない');
    assert.strictEqual(rows.find((r) => r.account_id === A1).followers, 120);

    const bad = rows.find((r) => r.account_id === A2);
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.error, '権限がありません', '理由を書き留めていない');
  });

  await check('同じ日に2回叩いても、行は増えない', async () => {
    const db = fakeDb({ accounts: [twoAccounts[0]] });
    const api = load(db, {
      accountStats: async () => ({ ok: true, metrics: { followers: 130 }, raw: {} }),
      postStats: async () => ({ ok: false }), recentVideos: async () => ({ ok: false }),
    });
    await api(req(), fakeRes());
    await api(req(), fakeRes());
    assert.strictEqual(db._state.rows.account_metrics.size, 1);
    assert.strictEqual([...db._state.rows.account_metrics.values()][0].followers, 130);
  });

  // ★ ok:true なのに error がある形（アカウントには届いたが一項目だけ欠けた）を、
  //   「失敗」に丸めると、取れた数字まで捨てることになる。
  await check('一部だけ取れなかった場合も、取れた数字は残す', async () => {
    const db = fakeDb({ accounts: [twoAccounts[1]] });
    const api = load(db, {
      accountStats: async () => ({
        ok: true, metrics: { followers: null, posts: 12 },
        error: 'Instagram が followers_count を返しませんでした', raw: {},
      }),
      postStats: async () => ({ ok: false }), recentVideos: async () => ({ ok: false }),
    });
    await api(req(), fakeRes());
    const row = [...db._state.rows.account_metrics.values()][0];
    assert.strictEqual(row.ok, true, '失敗に丸めている');
    assert.strictEqual(row.posts, 12, '取れた数字を捨てている');
    assert.strictEqual(row.followers, null);
    assert.ok(/followers_count/.test(row.error), '欠けた理由を残していない');
  });

  await check('公開済みの投稿だけ、数字を取りに行く', async () => {
    const db = fakeDb({
      accounts: [twoAccounts[0]],
      targets: [{ id: 't1', network: 'youtube', external_id: 'v1', status: 'success' }],
    });
    let asked = null;
    const api = load(db, {
      accountStats: async () => ({ ok: true, metrics: {}, raw: {} }),
      postStats: async (a, targets) => {
        asked = targets;
        return { ok: true, byTargetId: { t1: { views: 500, likes: 20 } }, raw: {} };
      },
      recentVideos: async () => ({ ok: false }),
    });
    await api(req(), fakeRes());
    assert.strictEqual(asked.length, 1);
    const row = [...db._state.rows.target_metrics.values()][0];
    assert.strictEqual(row.views, 500);
    assert.strictEqual(row.post_target_id, 't1');

    // 問い合わせの条件に「成功したものだけ」が入っているか
    const q = db._state.calls.filter(([t]) => t === 'post_targets');
    assert.ok(q.length, 'post_targets を見ていない');
  });

  await check('TikTok の動画は、別の表に書く', async () => {
    const db = fakeDb({ accounts: [{ id: A1, network: 'tiktok', label: '転職', access_token: 'a' }] });
    const api = load(db, {
      accountStats: async () => ({ ok: true, metrics: { followers: 50 }, raw: {} }),
      postStats: async () => ({ ok: false, error: '結びつけられません' }),
      recentVideos: async () => ({ ok: true, videos: [
        { id: 'v1', title: '面接', views: 900, likes: 30, comments: 2, shares: 1 },
      ], raw: {} }),
    });
    const res = fakeRes();
    await api(req(), res);
    const row = [...db._state.rows.tiktok_videos.values()][0];
    assert.strictEqual(row.video_id, 'v1');
    assert.strictEqual(row.views, 900);
    // 投稿ごとの表には入っていないこと（結びつけないという約束）
    assert.ok(!db._state.rows.target_metrics, 'アプリの投稿に結びつけてしまっている');
  });

  // ------------------------------------------------------------- 入口の守り
  await check('鍵が違えば401で、切り分けの材料を返す', async () => {
    const db = fakeDb({ accounts: [] });
    const api = load(db, {});
    const res = fakeRes();
    await api(req({ headers: { 'x-cron-key': 'ちがう' } }), res);
    assert.strictEqual(res.code, 401);
    assert.ok(res.body.診断, '診断が無いと、打ち間違いかヘッダー未送信かが分からない');
  });

  await check('鍵が設定されていなければ、そう言う', async () => {
    delete process.env.CRON_SECRET;
    const api = load(fakeDb({ accounts: [] }), {});
    const res = fakeRes();
    await api(req(), res);
    assert.strictEqual(res.code, 500);
    assert.ok(/CRON_SECRET/.test(res.body.error));
    process.env.CRON_SECRET = 'secret';
  });

  // ------------------------------------------------------------- 読み出し
  await check('チャンネルを指定すると、そのぶんだけ返る', async () => {
    const db = fakeDb({
      accounts: [
        { id: A1, network: 'youtube', label: 'ひろや', group_id: G1 },
        { id: A2, network: 'instagram', label: 'べつ', group_id: 'other' },
      ],
      targets: [],
    });
    const api = load(db, { accountStats: async () => ({ ok: true }), postStats: async () => ({ ok: false }),
                           recentVideos: async () => ({ ok: false }) });
    const res = fakeRes();
    await api(req({ method: 'GET', query: { group: G1 } }), res);
    assert.strictEqual(res.code, 200);
    assert.strictEqual(res.body.accounts.length, 1);
    assert.strictEqual(res.body.accounts[0].id, A1);
    assert.ok(Array.isArray(res.body.observations), '気づいたことが付いてこない');
  });

  await check('接続テストは、SNSの生の返事をそのまま見せる', async () => {
    const db = fakeDb({ accounts: [{ id: A1, network: 'instagram', label: '転職', access_token: 'b' }] });
    const api = load(db, {
      accountStats: async () => ({
        ok: true, metrics: { followers: null }, error: '返ってきません',
        raw: { user_id: '1', username: 'x' },
      }),
      postStats: async () => ({ ok: false, error: 'なし' }),
      recentVideos: async () => ({ ok: false }),
    });
    const res = fakeRes();
    await api(req({ method: 'GET', query: { probe: A1 } }), res);
    assert.strictEqual(res.code, 200);
    assert.ok(/username/.test(res.body.accountStats.raw), '生の返事を隠している');
    assert.strictEqual(res.body.accountStats.error, '返ってきません');
  });

  await check('無い連携先を指定したら、400で断る', async () => {
    const api = load(fakeDb({ accounts: [] }), {});
    const res = fakeRes();
    await api(req({ method: 'GET', query: { probe: A1 } }), res);
    assert.strictEqual(res.code, 400);
    assert.ok(/見つかりません/.test(res.body.error));
  });

  // ------------------------------------------------------------- まとめ
  const ng = results.filter((r) => r[0] === 'NG');
  for (const [state, name] of results) console.log(`  ${state === 'ok' ? '✓' : '✗'} ${name}`);
  console.log(`\n  ${results.length - ng.length} / ${results.length} 件成功`);
  if (ng.length) process.exit(1);
})();
