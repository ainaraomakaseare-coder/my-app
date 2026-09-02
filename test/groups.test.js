'use strict';
/**
 * 運用アカウントの出し入れと、新しく繋いだ連携先の所属を確かめる。
 *
 * Supabase には出られないので、lib/db を偽物に差し替えて
 * 「何をどう書き込もうとしたか」を見る。
 *
 *   node test/groups.test.js
 */
const assert = require('assert');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['ok', name]); }
  catch (err) { results.push(['NG', name + ' → ' + err.message]); }
}

const G1 = '11111111-1111-1111-1111-111111111111';
const G2 = '22222222-2222-2222-2222-222222222222';
const A1 = '33333333-3333-3333-3333-333333333333';

/**
 * 偽の db。呼ばれた内容をそのまま覚えておく。
 * state を渡して振る舞いを変える。
 */
function fakeDb(state) {
  const s = Object.assign({
    groups: [], accounts: [], refs: { accounts: 0, posts: 0 }, conflict: null,
  }, state);
  s.wrote = [];
  return {
    listGroups: async () => s.groups,
    listAccounts: async () => s.accounts,
    insertGroup: async (row) => { s.wrote.push(['insert', row]); return Object.assign({ id: 'new' }, row); },
    updateGroup: async (id, patch) => { s.wrote.push(['update', id, patch]); return Object.assign({ id }, patch); },
    deleteGroup: async (id) => { s.wrote.push(['delete', id]); },
    countGroupRefs: async () => s.refs,
    accountGroupConflict: async () => s.conflict,
    updateAccount: async (id, patch) => { s.wrote.push(['account', id, patch]); return Object.assign({ id }, patch); },
    upsertAccount: async (row) => { s.wrote.push(['upsert', row]); return Object.assign({ id: A1 }, row); },
    _state: s,
  };
}

/**
 * 偽物を差し込んだうえで module を読み直す。
 * stubs は { '../lib/google.js': {...} } の形。db は必ず差し替える。
 */
function load(modPath, db, stubs) {
  const all = Object.assign({ '../lib/db.js': db }, stubs || {});
  const paths = Object.keys(all).map((m) => require.resolve(m));
  for (const k of Object.keys(require.cache)) {
    if (paths.includes(k) || k === require.resolve(modPath)) delete require.cache[k];
  }
  for (const [m, exports] of Object.entries(all)) {
    const abs = require.resolve(m);
    require.cache[abs] = { exports, loaded: true, id: abs, filename: abs, paths: [] };
  }
  return require(modPath);
}

(async () => {
  // -------------------------------------------------------------- 入力の点検
  const groups0 = load('../lib/groups.js', fakeDb({}));

  await check('名前が空なら断る', () => {
    assert.throws(() => groups0.normalizeLabel('   '), /名前を入れて/);
  });

  await check('前後の空白は落とす', () => {
    assert.strictEqual(groups0.normalizeLabel('  転職キュレーション  '), '転職キュレーション');
  });

  await check('長すぎる名前は断る', () => {
    assert.throws(() => groups0.normalizeLabel('あ'.repeat(41)), /40文字/);
  });

  // ★ ここが一番大事。迷ったら厳しい方に倒す。
  await check('点検の型が空欄なら curator（きびしい方）にする', () => {
    assert.strictEqual(groups0.normalizeProfile(''), 'curator');
    assert.strictEqual(groups0.normalizeProfile(null), 'curator');
    assert.strictEqual(groups0.normalizeProfile(undefined), 'curator');
  });

  await check('知らない点検の型は、勝手に決めずに断る', () => {
    assert.throws(() => groups0.normalizeProfile('personai'), /知りません/);
  });

  await check('画面の選択肢は curator と personal', () => {
    assert.deepStrictEqual(groups0.profileChoices().map((p) => p.id), ['curator', 'personal']);
  });

  // -------------------------------------------------------------- 追加
  await check('追加すると、名前と点検の型が書き込まれる', async () => {
    const db = fakeDb({});
    const g = load('../lib/groups.js', db);
    await g.create({ label: '転職キュレーション', validation_profile: 'curator' });
    assert.deepStrictEqual(db._state.wrote, [
      ['insert', { label: '転職キュレーション', validation_profile: 'curator' }],
    ]);
  });

  await check('同じ名前は作らせない', async () => {
    const db = fakeDb({ groups: [{ id: G1, label: 'ひろや', validation_profile: 'personal' }] });
    const g = load('../lib/groups.js', db);
    await assert.rejects(() => g.create({ label: 'ひろや' }), /もうあります/);
    assert.strictEqual(db._state.wrote.length, 0);
  });

  // -------------------------------------------------------------- 変更
  await check('名前だけ変えても、点検の型は触らない', async () => {
    const db = fakeDb({ groups: [{ id: G1, label: '旧', validation_profile: 'personal' }] });
    const g = load('../lib/groups.js', db);
    await g.update(G1, { label: '新' });
    assert.deepStrictEqual(db._state.wrote, [['update', G1, { label: '新' }]]);
  });

  await check('点検の型を変えられる', async () => {
    const db = fakeDb({ groups: [{ id: G1, label: 'ひろや', validation_profile: 'personal' }] });
    const g = load('../lib/groups.js', db);
    await g.update(G1, { validation_profile: 'curator' });
    assert.deepStrictEqual(db._state.wrote, [['update', G1, { validation_profile: 'curator' }]]);
  });

  await check('無い運用アカウントは変えられない', async () => {
    const db = fakeDb({ groups: [] });
    const g = load('../lib/groups.js', db);
    await assert.rejects(() => g.update(G1, { label: 'x' }), /見つかりません/);
  });

  await check('id の形が違えば、DBに触る前に断る', async () => {
    const db = fakeDb({});
    const g = load('../lib/groups.js', db);
    await assert.rejects(() => g.update('1; drop table', { label: 'x' }), /指定されていません/);
    await assert.rejects(() => g.remove(''), /指定されていません/);
  });

  // -------------------------------------------------------------- 削除
  // ★ ぶら下がったまま消すと所属が空になり、DB側の見張りが素通りする。
  await check('連携先がぶら下がっていたら消させない', async () => {
    const db = fakeDb({ refs: { accounts: 2, posts: 0 } });
    const g = load('../lib/groups.js', db);
    await assert.rejects(() => g.remove(G1), /連携先が2件/);
    assert.strictEqual(db._state.wrote.length, 0);
  });

  await check('投稿がぶら下がっていたら消させない', async () => {
    const db = fakeDb({ refs: { accounts: 0, posts: 5 } });
    const g = load('../lib/groups.js', db);
    await assert.rejects(() => g.remove(G1), /投稿が5件/);
  });

  await check('何もぶら下がっていなければ消せる', async () => {
    const db = fakeDb({ refs: { accounts: 0, posts: 0 } });
    const g = load('../lib/groups.js', db);
    await g.remove(G1);
    assert.deepStrictEqual(db._state.wrote, [['delete', G1]]);
  });

  // -------------------------------------------------------------- 連携先の所属
  process.env.APP_PASSWORD = 'test-password-for-unit-test';
  process.env.SESSION_SECRET = 'test-session-secret';
  const auth = require('../lib/auth.js');
  const COOKIE = () => 'td_session=' + auth.issue();

  function fakeRes() {
    const headers = {};
    return {
      code: null, body: null, headers, location: null,
      setHeader(k, v) { headers[k] = v; },
      getHeader(k) { return headers[k]; },
      status(c) { this.code = c; return this; },
      json(b) { this.body = b; return this; },
      writeHead(c, h) { this.code = c; if (h && h.Location) this.location = h.Location; return this; },
      end() { return this; },
    };
  }

  const req = (over) => Object.assign(
    { method: 'GET', query: {}, headers: { cookie: COOKIE(), host: 'example.com' } }, over);

  await check('繋ぎに行くとき、運用アカウントをクッキーに預ける', async () => {
    const db = fakeDb({});
    const connect = load('../lib/connect.js', db);
    const res = fakeRes();
    await connect(req({ query: { network: 'x', group: G1 } }), res);
    const cookies = [].concat(res.getHeader('Set-Cookie') || []);
    assert.ok(cookies.some((c) => c.startsWith('td_group=' + G1)), '預けていない');
    // PKCE の合言葉も同時に預ける。上書きし合っていないことを見る。
    assert.ok(cookies.some((c) => c.startsWith('td_pkce=')), 'PKCE が消えた');
  });

  await check('運用アカウントの指定が id の形でなければ預けない', async () => {
    const db = fakeDb({});
    const connect = load('../lib/connect.js', db);
    const res = fakeRes();
    await connect(req({ query: { network: 'x', group: 'いたずら' } }), res);
    const cookies = [].concat(res.getHeader('Set-Cookie') || []);
    assert.ok(!cookies.some((c) => c.startsWith('td_group=い')));
  });

  // ---- 繋いだ直後の所属。YouTube の帰り道で確かめる（Google は偽物に差し替え） ----
  const fakeGoogle = {
    authUrl: () => 'https://accounts.google.com/fake',
    exchangeCode: async () => ({ refresh_token: 'r', access_token: 'a', expires_in: 3600 }),
  };
  const back = (db, cookie) => {
    const connect = load('../lib/connect.js', db, { '../lib/google.js': fakeGoogle });
    const res = fakeRes();
    const r = req({ query: { network: 'youtube', code: 'abc' } });
    if (cookie) r.headers.cookie += '; td_group=' + cookie;
    return connect(r, res).then(() => ({ res, wrote: db._state.wrote }));
  };

  await check('預けた運用アカウントに入れて保存する', async () => {
    const db = fakeDb({ groups: [{ id: G1, label: 'A' }, { id: G2, label: 'B' }] });
    const { wrote } = await back(db, G2);
    assert.strictEqual(wrote[0][0], 'upsert');
    assert.strictEqual(wrote[0][1].group_id, G2);
  });

  // ★ 所属が空のままだと、DB側の見張りは「片方が未設定」で素通りする。
  //   迷いようが無い場面では、こちらで決めてしまう。
  await check('運用アカウントが1つだけなら、預けが無くてもそこへ入れる', async () => {
    const db = fakeDb({ groups: [{ id: G1, label: 'ひろや' }] });
    const { wrote } = await back(db, null);
    assert.strictEqual(wrote[0][1].group_id, G1);
  });

  // ★ 消えた運用アカウントの id を渡すと外部キーで弾かれ、取れたトークンごと失う。
  //   所属なしで通し、あとから画面で選んでもらう。
  await check('預けた運用アカウントが消えていたら、所属なしで通す', async () => {
    const db = fakeDb({ groups: [{ id: G1, label: 'A' }, { id: G2, label: 'B' }] });
    const { wrote } = await back(db, '99999999-9999-9999-9999-999999999999');
    assert.ok(!('group_id' in wrote[0][1]), '知らない所属を書き込んでいる');
  });

  await check('繋ぎ直しても、いまの所属を消さない', async () => {
    // 運用アカウントが2つあり預けも無い＝決められない。ここで group_id を送ると
    // 既存の所属を null で上書きしてしまう。送らないことを確かめる。
    const db = fakeDb({ groups: [{ id: G1, label: 'A' }, { id: G2, label: 'B' }] });
    const { wrote } = await back(db, null);
    assert.ok(!('group_id' in wrote[0][1]));
  });

  await check('帰り道で、預けたクッキーを捨てる', async () => {
    const db = fakeDb({ groups: [{ id: G1, label: 'A' }] });
    const { res } = await back(db, G1);
    const cookies = [].concat(res.getHeader('Set-Cookie') || []);
    assert.ok(cookies.some((c) => /^td_group=;/.test(c) && /Max-Age=0/.test(c)), '捨てていない');
  });

  await check('所属を変えられる', async () => {
    const db = fakeDb({ groups: [{ id: G1, label: 'A' }, { id: G2, label: 'B' }] });
    const connect = load('../lib/connect.js', db);
    const res = fakeRes();
    await connect(req({ method: 'PATCH', query: { id: A1 }, body: { group_id: G2 } }), res);
    assert.strictEqual(res.code, 200);
    assert.deepStrictEqual(db._state.wrote[0], ['account', A1, { group_id: G2 }]);
  });

  await check('無い運用アカウントへは移せない', async () => {
    const db = fakeDb({ groups: [{ id: G1, label: 'A' }] });
    const connect = load('../lib/connect.js', db);
    const res = fakeRes();
    await connect(req({ method: 'PATCH', query: { id: A1 }, body: { group_id: G2 } }), res);
    assert.strictEqual(res.code, 400);
    assert.ok(/見つかりません/.test(res.body.error));
    assert.strictEqual(db._state.wrote.length, 0);
  });

  // ★ DB側の見張りは post_targets と posts を書き換えたときにしか動かない。
  //   連携先の所属だけを変える道は素通りするので、アプリで止める。
  await check('すでに他の運用アカウントの投稿先になっていたら、移させない', async () => {
    const db = fakeDb({
      groups: [{ id: G1, label: 'A' }, { id: G2, label: 'B' }],
      conflict: '転職活動がバレにくい進め方',
    });
    const connect = load('../lib/connect.js', db);
    const res = fakeRes();
    await connect(req({ method: 'PATCH', query: { id: A1 }, body: { group_id: G2 } }), res);
    assert.strictEqual(res.code, 400);
    assert.ok(/転職活動がバレにくい進め方/.test(res.body.error));
    assert.strictEqual(db._state.wrote.length, 0);
  });

  await check('所属を外すときは、食い違いを見に行かない（外すのは安全なので）', async () => {
    const db = fakeDb({ groups: [{ id: G1, label: 'A' }], conflict: 'なにか' });
    const connect = load('../lib/connect.js', db);
    const res = fakeRes();
    await connect(req({ method: 'PATCH', query: { id: A1 }, body: { group_id: null } }), res);
    assert.strictEqual(res.code, 200);
    assert.deepStrictEqual(db._state.wrote[0], ['account', A1, { group_id: null }]);
  });

  await check('呼び名だけ変えたときは、所属を触らない', async () => {
    const db = fakeDb({ groups: [{ id: G1, label: 'A' }] });
    const connect = load('../lib/connect.js', db);
    const res = fakeRes();
    await connect(req({ method: 'PATCH', query: { id: A1 }, body: { label: 'アフィリ用' } }), res);
    assert.deepStrictEqual(db._state.wrote[0], ['account', A1, { label: 'アフィリ用' }]);
  });

  // -------------------------------------------------------------- 入り口
  await check('ログインしていなければ、運用アカウントは触れない', async () => {
    load('../lib/groups.js', fakeDb({}));
    delete require.cache[require.resolve('../api/groups.js')];
    const api = require('../api/groups.js');
    const res = fakeRes();
    await api({ method: 'GET', query: {}, headers: {} }, res);
    assert.strictEqual(res.code, 401);
  });

  await check('知らないメソッドは 405', async () => {
    load('../lib/groups.js', fakeDb({}));
    delete require.cache[require.resolve('../api/groups.js')];
    const api = require('../api/groups.js');
    const res = fakeRes();
    await api({ method: 'PUT', query: {}, headers: { cookie: COOKIE() } }, res);
    assert.strictEqual(res.code, 405);
  });

  await check('入力の誤りは 400 で、理由を日本語で返す', async () => {
    load('../lib/groups.js', fakeDb({}));
    delete require.cache[require.resolve('../api/groups.js')];
    const api = require('../api/groups.js');
    const res = fakeRes();
    await api({ method: 'POST', query: {}, headers: { cookie: COOKIE() }, body: { label: '' } }, res);
    assert.strictEqual(res.code, 400);
    assert.ok(/名前を入れて/.test(res.body.error));
  });

  await check('一覧には点検の型の選択肢も付いてくる', async () => {
    load('../lib/groups.js', fakeDb({ groups: [{ id: G1, label: 'A', validation_profile: 'curator' }] }));
    delete require.cache[require.resolve('../api/groups.js')];
    const api = require('../api/groups.js');
    const res = fakeRes();
    await api({ method: 'GET', query: {}, headers: { cookie: COOKIE() } }, res);
    assert.strictEqual(res.body.groups.length, 1);
    assert.deepStrictEqual(res.body.profiles.map((p) => p.id), ['curator', 'personal']);
  });

  const bad = results.filter((r) => r[0] === 'NG');
  for (const [mark, name] of results) console.log(`  ${mark === 'ok' ? '✓' : '✗'} ${name}`);
  console.log(`\n  ${results.length - bad.length} / ${results.length} 件成功`);
  process.exit(bad.length ? 1 : 0);
})();
