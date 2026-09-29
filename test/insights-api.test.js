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
    if (table === 'benchmark_items') return `${row.genre}|${row.item_key}`;
    return `${row.account_id}|${row.video_id}|${row.taken_on}`;
  };

  return {
    listAccounts: async () => s.accounts.map(({ access_token, refresh_token, ...a }) => a),
    getAccount: async (id) => s.accounts.find((a) => a.id === id) || null,
    rest: async (table, opt) => {
      s.calls.push([table, (opt && opt.method) || 'GET']);
      // ★ research_runs は id で1行を探す形なので、他の表とは別扱い（PK が genre+item_key ではない）。
      if (table === 'research_runs') {
        s.rows.research_runs = s.rows.research_runs || [];
        if (opt && opt.method === 'POST') {
          const row = Object.assign({ id: `run${s.rows.research_runs.length + 1}` }, opt.body);
          s.rows.research_runs.push(row);
          return [row];
        }
        if (opt && opt.method === 'PATCH') {
          const id = String(opt.query.id || '').replace(/^eq\./, '');
          const row = s.rows.research_runs.find((r) => r.id === id);
          if (row) Object.assign(row, opt.body);
          return row ? [row] : [];
        }
        return s.rows.research_runs.slice().sort((a, b) => (a.id < b.id ? 1 : -1));
      }
      if (opt && opt.method === 'POST') {
        const bag = (s.rows[table] = s.rows[table] || new Map());
        for (const row of opt.body) bag.set(key(table, row), row);
        return opt.body;
      }
      if (table === 'post_targets') return s.targets;
      if (table === 'account_metrics') return [...(s.rows.account_metrics || new Map()).values()];
      if (table === 'target_metrics') return [...(s.rows.target_metrics || new Map()).values()];
      if (table === 'tiktok_videos') return [...(s.rows.tiktok_videos || new Map()).values()];
      if (table === 'benchmark_items') return [...(s.rows.benchmark_items || new Map()).values()];
      return [];
    },
    _state: s,
  };
}

/**
 * 差し替えたうえで api/insights.js を読み直す。
 * extra.auth … lib/auth.js の差し替え（省略時は常にログイン済み扱い）
 * extra.benchmarkYoutube … lib/benchmark-youtube.js の差し替え
 */
function load(db, insights, extra) {
  extra = extra || {};
  const stubs = {
    '../lib/db.js': db,
    '../lib/insights.js': insights,
    '../lib/auth.js': extra.auth || { guard: () => true },
  };
  if (extra.benchmarkYoutube) stubs['../lib/benchmark-youtube.js'] = extra.benchmarkYoutube;
  for (const k of Object.keys(require.cache)) {
    if (k.includes('api/insights.js') || k.includes('lib/metrics-store.js') ||
        k.includes('lib/benchmark-store.js')) delete require.cache[k];
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

  // ------------------------------------------------------------- のび（YouTube自動収集）
  const YT_ITEM = {
    platform: 'youtube', genre: 'ai',
    url: 'https://www.youtube.com/shorts/vid1',
    account: { name: 'ch', followers: 500, followers_source: 'api' },
    metrics: { views: 20000, likes: 300, comments: 10, saves: null, shares: null },
    metrics_source: 'api',
    content: { first_line: 'title', hook: '', duration_sec: 40, format: 'unknown', topic: 'AI 初心者', cta: null, hashtags: [] },
    posted_at: '2026-09-01', collected_at: '2026-09-28',
    ratio: 40,
  };

  await check('のび（YouTube）で集めたら、受理した記録をDBにも保存する', async () => {
    const db = fakeDb({ accounts: [{ id: A1, network: 'youtube', label: 'ひろや', group_id: G1, access_token: 'a' }] });
    const api = load(db, {}, {
      benchmarkYoutube: {
        collect: async () => ({
          genre: 'ai', collected_at: '2026-09-28', queries: [], items: [YT_ITEM],
          summary: { accepted: 1, rejected: 0, growing: 1, byPlatform: { youtube: 1 } }, rejected: [], quota: 5,
        }),
      },
    });
    const res = fakeRes();
    await api(req({ method: 'GET', query: { benchmark: 'youtube', genre: 'ai' } }), res);

    assert.strictEqual(res.code, 200);
    assert.strictEqual(res.body.saved, 1);
    assert.strictEqual(res.body.items.length, 1, 'いままでどおり items も返っている（画面を壊さない）');
    assert.strictEqual(res.body.summary.accepted, 1, 'いままでどおり summary も返っている');
    const row = [...db._state.rows.benchmark_items.values()][0];
    assert.strictEqual(row.item_key, 'youtube:vid1');
    assert.strictEqual(row.genre, 'ai');
    assert.strictEqual(row.ratio, 40);
  });

  // ------------------------------------------------------------- status（集めた件数・直近のラン）
  await check('status は、集めた件数の内訳と直近の分析ランを返す', async () => {
    const db = fakeDb({});
    db._state.rows.benchmark_items = new Map([
      ['ai|k1', { genre: 'ai', platform: 'youtube', item_key: 'k1', ratio: 12,
                  record: { url: 'u1', platform: 'youtube', collected_at: '2026-09-20' } }],
      ['ai|k2', { genre: 'ai', platform: 'tiktok', item_key: 'k2', ratio: 5,
                  record: { url: 'u2', platform: 'tiktok', collected_at: '2026-09-25' } }],
    ]);
    db._state.rows.research_runs = [{ id: 'run1', genre: 'ai', status: 'done', created_at: '2026-09-20T00:00:00Z' }];
    const api = load(db, {});
    const res = fakeRes();
    await api(req({ method: 'GET', query: { benchmark: 'status', genre: 'ai' } }), res);

    assert.strictEqual(res.code, 200);
    assert.strictEqual(res.body.counts.total, 2);
    assert.deepStrictEqual(res.body.counts.byPlatform, { youtube: 1, tiktok: 1 });
    assert.strictEqual(res.body.counts.latestCollectedAt, '2026-09-25');
    assert.strictEqual(res.body.latestRun.id, 'run1');
  });

  await check('status はジャンルが無ければ400で断る', async () => {
    const api = load(fakeDb({}), {});
    const res = fakeRes();
    await api(req({ method: 'GET', query: { benchmark: 'status' } }), res);
    assert.strictEqual(res.code, 400);
  });

  // ------------------------------------------------------------- intake（貼り込みでの取り込み）
  const VALID_RECORD = {
    platform: 'tiktok', genre: 'career',
    url: 'https://www.tiktok.com/@abc/video/123456',
    account: { name: 'abc', followers: 2000, followers_source: 'screen' },
    posted_at: '2026-09-20', collected_at: '2026-09-28',
    metrics: { views: 40000, likes: 900, comments: 20, saves: 50, shares: null },
    metrics_source: 'screen',
    content: { format: 'talking', first_line: '転職の話', hook: '損する前に見て', duration_sec: 30, cta: '保存して', topic: '転職' },
    demand: { comment_questions: [] },
  };
  const INVALID_RECORD = { platform: 'tiktok', genre: 'career', url: 'https://example.com/notmatching' };

  await check('取り込み（intake）はログインが要る（cronの鍵ではない）', async () => {
    // ★ 他のテストが lib/auth.js を偽物に差し替えたままかもしれないので、本物を取り直す。
    delete require.cache[require.resolve('../lib/auth')];
    const realAuth = require('../lib/auth');
    const db = fakeDb({});
    const api = load(db, {}, { auth: realAuth });
    const res = fakeRes();
    // APP_PASSWORD 未設定なのでログイン済みにはなれない → 401
    await api({ method: 'POST', query: { benchmark: 'intake' }, headers: {}, body: [] }, res);
    assert.strictEqual(res.code, 401);
  });

  await check('POST は benchmark=intake のときだけログイン扱い。他はcron専用のまま', async () => {
    const db = fakeDb({ accounts: [] });
    const api = load(db, {});
    const res = fakeRes();
    // cron の鍵を付けずに叩く。intake 以外なら、これまでどおり弾かれる。
    await api({ method: 'POST', query: { benchmark: 'youtube' }, headers: {}, body: {} }, res);
    assert.strictEqual(res.code, 401);
  });

  await check('```json フェンス付きの本文を読み、受理したものだけ保存する', async () => {
    const db = fakeDb({});
    const api = load(db, {});
    const res = fakeRes();
    const body = '```json\n' + JSON.stringify([VALID_RECORD, INVALID_RECORD], null, 2) + '\n```';
    await api({ method: 'POST', query: { benchmark: 'intake' }, headers: {}, body }, res);

    assert.strictEqual(res.code, 200);
    assert.strictEqual(res.body.accepted, 1);
    assert.strictEqual(res.body.rejected.length, 1);
    assert.strictEqual(res.body.rejected[0].url, INVALID_RECORD.url);
    assert.ok(res.body.rejected[0].errors.length, '却下の理由が無い');
    assert.strictEqual(res.body.summary.saved, 1);

    const rows = [...db._state.rows.benchmark_items.values()];
    assert.strictEqual(rows.length, 1, '受理したものだけ保存している');
    assert.strictEqual(rows[0].genre, 'career');
  });

  await check('genre クエリで、記録に無い genre を埋める', async () => {
    const db = fakeDb({});
    const api = load(db, {});
    const res = fakeRes();
    const noGenre = Object.assign({}, VALID_RECORD);
    delete noGenre.genre;
    await api({ method: 'POST', query: { benchmark: 'intake', genre: 'career' }, headers: {}, body: [noGenre] }, res);
    assert.strictEqual(res.code, 200);
    assert.strictEqual(res.body.accepted, 1);
  });

  await check('取り込みの本文が大きすぎたら断る（貼り間違い対策）', async () => {
    const db = fakeDb({});
    const api = load(db, {});
    const res = fakeRes();
    const huge = '[' + '"a",'.repeat(400000) + '"a"]'; // 1MBよりだいぶ大きい
    await api({ method: 'POST', query: { benchmark: 'intake' }, headers: {}, body: huge }, res);
    assert.strictEqual(res.code, 400);
    assert.ok(/大きすぎ/.test(res.body.error));
    assert.strictEqual(db._state.calls.length, 0, '大きすぎる本文はDBに触れる前に断っている');
  });

  // ★ 画面は貼った文字を { text } で送る。
  await check('画面から { text } で送った貼り付けも、同じ規則で読む', async () => {
    const db = fakeDb({});
    const api = load(db, {});
    const res = fakeRes();
    const text = '```json\n' + JSON.stringify([VALID_RECORD]) + '\n```';
    await api({ method: 'POST', query: { benchmark: 'intake' }, headers: {}, body: { text } }, res);
    assert.strictEqual(res.code, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.accepted, 1);
  });

  await check('YouTube の収集が失敗したら、保存せずに理由をそのまま返す', async () => {
    const db = fakeDb({ accounts: [{ id: A1, network: 'youtube', label: 'ひろや', group_id: G1, access_token: 'a' }] });
    const api = load(db, {}, {
      benchmarkYoutube: { collect: async () => ({ ok: false, error: 'YouTube API の1日の利用枠を使い切りました。', hint: '日付が変わるまで待ってください。' }) },
    });
    const res = fakeRes();
    await api(req({ method: 'GET', query: { benchmark: 'youtube', genre: 'ai' } }), res);
    assert.strictEqual(res.code, 200);
    assert.strictEqual(res.body.ok, false);
    assert.ok(/利用枠/.test(res.body.error));
    assert.ok(!db._state.rows.benchmark_items || db._state.rows.benchmark_items.size === 0, '失敗なのに保存している');
  });

  // ------------------------------------------------------------- まとめ
  const ng = results.filter((r) => r[0] === 'NG');
  for (const [state, name] of results) console.log(`  ${state === 'ok' ? '✓' : '✗'} ${name}`);
  console.log(`\n  ${results.length - ng.length} / ${results.length} 件成功`);
  if (ng.length) process.exit(1);
})();
