'use strict';
/**
 * 「投稿手前で止める」が本当に止まっているかを確かめる。
 *
 * ここが緩むと、案件の投稿が黙って公開される。テストの中でいちばん重い。
 *
 *   node test/handoff.test.js
 */
const assert = require('assert');
const handoff = require('../lib/handoff');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['ok', name]); }
  catch (err) { results.push(['NG', name + ' → ' + err.message]); }
}

// 案件側。Instagram は自動投稿してよい。X は課金され、A8の掲載対象外なので手渡し。
const G_AFFI = { id: 'g1', label: '転職キュレーション', validation_profile: 'curator',
                 auto_publish_networks: ['instagram'] };
// 何も許していない運用ライン（作った直後の状態）
const G_STOP = { id: 'g3', label: '止める', validation_profile: 'curator',
                 auto_publish_networks: [] };
const G_HIRO = { id: 'g2', label: 'ひろや', validation_profile: 'personal',
                 auto_publish_networks: ['instagram', 'x'] };

const acct = (network, id, group) =>
  ({ id: id || network, network, label: 'アフィリ用', group_id: group || 'g1' });

const post = (over) => Object.assign({
  id: 'p1',
  title: '転職活動がバレにくい進め方',
  media_kind: 'video',
  media_path: '2026/09/a.mp4',
  ig_caption: '第二新卒の口コミを集めた結果です',
  tt_caption: '第二新卒の口コミを集めた結果です',
  x_text: '6つ、答え合わせ。',
  rows: [1, 2, 3, 4, 5, 6].map((n) => ({ question: 'q' + n, answer: 'a' + n })),
}, over || {});

(async () => {
  // ---------------------------------------------------------------- 分類
  await check('Instagram と X は、叩いた瞬間に公開されるSNSとして扱う', () => {
    assert.ok(handoff.isPublishing('instagram'));
    assert.ok(handoff.isPublishing('x'));
  });

  await check('TikTok と YouTube は下書きで止まるので、公開系ではない', () => {
    assert.ok(!handoff.isPublishing('tiktok'));
    assert.ok(!handoff.isPublishing('youtube'));
  });

  // ★ ここが本丸。許していないSNSは順番待ちに入れない。
  await check('何も許していない運用アカウントでは、Instagram と X は手渡しになる', () => {
    assert.strictEqual(handoff.statusForTarget(G_STOP, 'instagram'), 'manual');
    assert.strictEqual(handoff.statusForTarget(G_STOP, 'x'), 'manual');
  });

  // ★ Instagram だけ許す、が言えることが今回の要点。
  await check('Instagram だけ許した運用アカウントでは、X は手渡しのまま', () => {
    assert.strictEqual(handoff.statusForTarget(G_AFFI, 'instagram'), 'queued');
    assert.strictEqual(handoff.statusForTarget(G_AFFI, 'x'), 'manual');
  });

  await check('何も許していなくても、TikTok と YouTube は順番待ちに入る', () => {
    // この2つは下書き・非公開までしか進まないので、送ってよい。
    assert.strictEqual(handoff.statusForTarget(G_STOP, 'tiktok'), 'queued');
    assert.strictEqual(handoff.statusForTarget(G_STOP, 'youtube'), 'queued');
  });

  await check('いままでどおりの運用アカウントは、全部そのまま順番待ちに入る', () => {
    for (const n of ['instagram', 'x', 'tiktok', 'youtube']) {
      assert.strictEqual(handoff.statusForTarget(G_HIRO, n), 'queued');
    }
  });

  // ★ 列を足した直後や、旧データを壊さないための既定。
  await check('運用アカウントが分からないときは、いままでどおり通す', () => {
    assert.strictEqual(handoff.statusForTarget(null, 'instagram'), 'queued');
    assert.strictEqual(handoff.statusForTarget({ id: 'g9' }, 'instagram'), 'queued');
    assert.ok(handoff.autoPublishesTo(null, 'x'));
    assert.ok(handoff.autoPublishesTo({}, 'x'));
    assert.ok(handoff.autoPublishesTo(G_AFFI, 'instagram'));
    assert.ok(!handoff.autoPublishesTo(G_AFFI, 'x'));
  });

  await check('予約できない投稿先だけを挙げる', () => {
    const chosen = [acct('instagram'), acct('tiktok'), acct('x')];
    assert.deepStrictEqual(handoff.manualOnly(G_STOP, chosen).map((a) => a.network),
                           ['instagram', 'x']);
    assert.deepStrictEqual(handoff.manualOnly(G_AFFI, chosen).map((a) => a.network), ['x']);
    assert.deepStrictEqual(handoff.manualOnly(G_HIRO, chosen), []);
  });

  // ---------------------------------------------------------------- 手順
  await check('許していない Instagram は「手渡し」で、動画と本文を渡す', () => {
    const [h] = handoff.planFor(post(), [acct('instagram')], G_STOP, []);
    assert.strictEqual(h.mode, 'hand');
    assert.deepStrictEqual(h.needs.map((n) => n.key), ['video', 'igCaption']);
    assert.ok(h.needs.every((n) => n.ready));
    assert.ok(/下書きのAPIがありません/.test(h.stops));
  });

  await check('X は画像2枚と本文を渡す（動画ではない）', () => {
    const [h] = handoff.planFor(post(), [acct('x')], G_AFFI, []);
    assert.deepStrictEqual(h.needs.map((n) => n.key), ['posterBefore', 'posterAfter', 'xText']);
  });

  await check('TikTok は API で下書きまで送れる', () => {
    const [h] = handoff.planFor(post(), [acct('tiktok')], G_AFFI, []);
    assert.strictEqual(h.mode, 'api');
    assert.ok(/下書き/.test(h.stops));
  });

  await check('許した Instagram は手渡しではないと分かる', () => {
    const [h] = handoff.planFor(post(), [acct('instagram')], G_AFFI, []);
    assert.strictEqual(h.mode, 'api-publish');
  });

  // ★ 同じ運用アカウントの中で、Instagram と X の扱いが分かれること。
  await check('同じ運用アカウントでも、X は手渡しのまま出る', () => {
    const plan = handoff.planFor(post(), [acct('instagram'), acct('x')], G_AFFI, []);
    assert.deepStrictEqual(plan.map((h) => [h.network, h.mode]),
                           [['instagram', 'api-publish'], ['x', 'hand']]);
  });

  // ★ 素材が足りないまま「渡せます」と出すと、空のファイルを掴ませてしまう。
  await check('動画が無ければ、動画のボタンは押せないと分かる', () => {
    const [h] = handoff.planFor(post({ media_path: null }), [acct('instagram')], G_STOP, []);
    assert.ok(!h.ready);
    assert.deepStrictEqual(h.missing, ['動画を保存']);
  });

  await check('本文が空なら、そのボタンも押せないと分かる', () => {
    const [h] = handoff.planFor(post({ x_text: '   ' }), [acct('x')], G_AFFI, []);
    assert.ok(!h.ready);
    assert.deepStrictEqual(h.missing, ['X の本文をコピー']);
  });

  await check('6行が残っていない投稿では、画像を作れないと分かる', () => {
    const [h] = handoff.planFor(post({ rows: [] }), [acct('x')], G_AFFI, []);
    assert.deepStrictEqual(h.missing, ['画像（空欄）を保存', '画像（答え）を保存']);
  });

  await check('いまの状態をそのまま持ってくる', () => {
    const [h] = handoff.planFor(
      post(), [acct('instagram', 'a9')], G_STOP,
      [{ account_id: 'a9', status: 'handed' }]);
    assert.strictEqual(h.status, 'handed');
  });

  await check('投稿先が選ばれていなければ、手順も空', () => {
    assert.deepStrictEqual(handoff.planFor(post(), [], G_AFFI, []), []);
  });

  // ---------------------------------------------------------------- 取り決めの一致
  // ★ SQL 側（schema_v4_handoff.sql）と同じ値でなければ、片方だけ緩む。
  await check('公開系SNSの一覧が、SQL の publishing_networks() と一致する', () => {
    const sql = require('fs').readFileSync(__dirname + '/../supabase/schema_v5_per_network.sql', 'utf8');
    const m = sql.match(/select array\[([^\]]+)\]\s*\$\$/);
    assert.ok(m, 'publishing_networks() が見つからない');
    const inSql = m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    assert.deepStrictEqual(inSql, handoff.PUBLISHING_NETWORKS);
  });

  await check('自動処理の勘定から外す状態が、SQL と一致する', () => {
    const sql = require('fs').readFileSync(__dirname + '/../supabase/schema_v4_handoff.sql', 'utf8');
    assert.ok(sql.includes("status not in ('manual','handed')"), 'recalc から外れていない');
    assert.deepStrictEqual(handoff.OFF_PIPELINE, ['manual', 'handed']);
  });

  await check('新しい状態が、check 制約に入っている', () => {
    const sql = require('fs').readFileSync(__dirname + '/../supabase/schema_v4_handoff.sql', 'utf8');
    for (const st of handoff.OFF_PIPELINE) {
      assert.ok(new RegExp(`'${st}'`).test(sql), st + ' が制約に無い');
    }
  });

  // ---------------------------------------------------------------- 保存の入り口
  const fakeRes = () => ({
    code: null, body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  });

  process.env.APP_PASSWORD = 'test-password-for-unit-test';
  process.env.SESSION_SECRET = 'test-session-secret';
  const auth = require('../lib/auth.js');

  /** db を偽物にして api/posts.js を読み直す。 */
  function loadPosts(state) {
    const dbPath = require.resolve('../lib/db.js');
    delete require.cache[dbPath];
    delete require.cache[require.resolve('../api/posts.js')];
    const wrote = [];
    require.cache[dbPath] = {
      exports: {
        listAccounts: async () => state.accounts,
        listGroups: async () => state.groups,
        rest: async (table, opt) => {
          if (opt && opt.method) { wrote.push([table, opt.method, opt.body]); return []; }
          return [];
        },
        insert: async (table, row) => { wrote.push([table, 'POST', row]); return [Object.assign({ id: 'p1' }, row)]; },
        updateById: async (t, id, row) => Object.assign({ id }, row),
        deleteById: async () => {},
        logEvent: async () => {},
      },
      loaded: true, id: dbPath, filename: dbPath, paths: [],
    };
    return { handler: require('../api/posts.js'), wrote };
  }

  const body = (over) => Object.assign({
    title: 'テスト', group_id: 'g1', targets: ['instagram', 'tiktok'],
    media_path: '2026/09/a.mp4', media_kind: 'video',
  }, over || {});

  // 何も許していない運用ライン（g3）に属する連携先で試す
  const state = {
    accounts: [acct('instagram', null, 'g3'), acct('tiktok', null, 'g3'), acct('x', null, 'g3')],
    groups: [G_STOP, G_HIRO],
  };
  const stateAffi = {
    accounts: [acct('instagram'), acct('tiktok'), acct('x')],
    groups: [G_AFFI],
  };

  await check('許していないときは、Instagram を含む予約投稿を断る', async () => {
    const { handler } = loadPosts(state);
    const res = fakeRes();
    await handler({
      method: 'POST', query: {}, headers: { cookie: 'td_session=' + auth.issue() },
      body: body({ status: 'scheduled', scheduled_at_jst: '2026-09-10T20:00', group_id: 'g3' }),
    }, res);
    assert.strictEqual(res.code, 400);
    assert.ok(/即公開/.test(res.body.error), res.body.error);
  });

  // ★ 今回の要点。Instagram は通り、X だけが断られる。
  await check('Instagram を許した運用アカウントでは、Instagram の予約は通る', async () => {
    const { handler, wrote } = loadPosts(stateAffi);
    const res = fakeRes();
    await handler({
      method: 'POST', query: {}, headers: { cookie: 'td_session=' + auth.issue() },
      body: body({ status: 'scheduled', scheduled_at_jst: '2026-09-10T20:00' }),
    }, res);
    assert.strictEqual(res.code, 200, JSON.stringify(res.body));
    const targets = wrote.filter((w) => w[0] === 'post_targets').map((w) => [w[2].network, w[2].status]);
    assert.deepStrictEqual(targets, [['instagram', 'queued'], ['tiktok', 'queued']]);
  });

  await check('同じ運用アカウントでも、X を足した予約は断る', async () => {
    const { handler } = loadPosts(stateAffi);
    const res = fakeRes();
    await handler({
      method: 'POST', query: {}, headers: { cookie: 'td_session=' + auth.issue() },
      body: body({ status: 'scheduled', scheduled_at_jst: '2026-09-10T20:00',
                   targets: ['instagram', 'x'] }),
    }, res);
    assert.strictEqual(res.code, 400);
    assert.ok(/X（アフィリ用）/.test(res.body.error), res.body.error);
    assert.ok(!/Instagram/.test(res.body.error), 'Instagram まで断っている');
  });

  await check('下書きとしてなら保存でき、Instagram の行は手渡しで作られる', async () => {
    const { handler, wrote } = loadPosts(state);
    const res = fakeRes();
    await handler({
      method: 'POST', query: {}, headers: { cookie: 'td_session=' + auth.issue() },
      body: body({ status: 'draft', group_id: 'g3' }),
    }, res);
    assert.strictEqual(res.code, 200);
    const targets = wrote.filter((w) => w[0] === 'post_targets').map((w) => [w[2].network, w[2].status]);
    assert.deepStrictEqual(targets, [['instagram', 'manual'], ['tiktok', 'queued']]);
  });

  await check('ひろや側では、いままでどおり予約できる', async () => {
    const s2 = {
      groups: [G_HIRO],
      accounts: [Object.assign(acct('instagram'), { group_id: 'g2' })],
    };
    const { handler, wrote } = loadPosts(s2);
    const res = fakeRes();
    await handler({
      method: 'POST', query: {}, headers: { cookie: 'td_session=' + auth.issue() },
      body: body({ status: 'scheduled', scheduled_at_jst: '2026-09-10T20:00', group_id: 'g2', targets: ['instagram'] }),
    }, res);
    assert.strictEqual(res.code, 200);
    const targets = wrote.filter((w) => w[0] === 'post_targets').map((w) => [w[2].network, w[2].status]);
    assert.deepStrictEqual(targets, [['instagram', 'queued']]);
  });

  await check('文案そのものも一緒に保存する（画像の作り直しに要る）', async () => {
    const { handler, wrote } = loadPosts(state);
    const res = fakeRes();
    const draft = { kicker: 'k', title: 't', rows: [] };
    await handler({
      method: 'POST', query: {}, headers: { cookie: 'td_session=' + auth.issue() },
      body: body({ status: 'draft', draft, group_id: 'g3' }),
    }, res);
    const row = wrote.find((w) => w[0] === 'posts');
    assert.deepStrictEqual(row[2].draft, draft);
  });

  const bad = results.filter((r) => r[0] === 'NG');
  for (const [mark, name] of results) console.log(`  ${mark === 'ok' ? '✓' : '✗'} ${name}`);
  console.log(`\n  ${results.length - bad.length} / ${results.length} 件成功`);
  process.exit(bad.length ? 1 : 0);
})();
