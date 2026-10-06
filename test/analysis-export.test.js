'use strict';
/**
 * 分析用の数字を Google ドライブへ書き出す仕組み（lib/analysis-export.js・lib/drive.js）。
 *
 * ★ ここで守りたいのは4つ。
 *   1. 書き出す形が、画面の「分析用にコピー」と同じ（分析の道具がそのまま読める）
 *   2. 同じ週に2回書き出しても、ドライブに同じファイルが並ばない（上書き）
 *   3. 書き出しの入口は cron の鍵が無いと動かない
 *   4. TikTok Studio の数字は、数字でないもの（「1.2万」など）を止める
 *
 *   node test/analysis-export.test.js
 */
const assert = require('assert');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['ok', name]); }
  catch (err) { results.push(['NG', name + ' → ' + err.message]); }
}

process.env.GOOGLE_CLIENT_ID = 'cid';
process.env.GOOGLE_CLIENT_SECRET = 'csecret';
process.env.CRON_SECRET = 'cron-secret-123';

const ex = require('../lib/analysis-export');
const drive = require('../lib/drive');

/** app_settings だけを持つ Supabase の代わり。 */
function fakeDb(groups, setting) {
  const s = { setting: setting || null, groups: groups || [] };
  return {
    s,
    listGroups: async () => s.groups,
    rest: async (table, opt = {}) => {
      assert.strictEqual(table, 'app_settings');
      if (opt.method === 'POST') { s.setting = JSON.parse(JSON.stringify(opt.body.value)); return null; }
      return s.setting ? [{ value: JSON.parse(JSON.stringify(s.setting)) }] : [];
    },
  };
}

/** Google の代わり。ドライブのファイルを名前で持つ。 */
function fakeGoogle() {
  const g = { files: new Map(), folders: [], refreshed: 0, seq: 0 };
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const ok = (json) => ({ ok: true, status: 200, json: async () => json });
    if (u.hostname === 'oauth2.googleapis.com') {
      g.refreshed++;
      return ok({ access_token: 'at-new', expires_in: 3600 });
    }
    if (u.pathname === '/drive/v3/files' && opts.method === 'POST') {
      const id = 'folder' + (++g.seq);
      g.folders.push(id);
      return ok({ id });
    }
    if (u.pathname.startsWith('/drive/v3/files/')) {
      const id = u.pathname.split('/').pop();
      return g.folders.includes(id) ? ok({ id, trashed: false })
        : { ok: false, status: 404, json: async () => ({ error: { message: 'File not found' } }) };
    }
    if (u.pathname === '/drive/v3/files') {
      const m = u.searchParams.get('q').match(/name = '([^']+)'/);
      const hit = g.files.get(m[1]);
      return ok({ files: hit ? [{ id: hit.id }] : [] });
    }
    if (u.pathname === '/upload/drive/v3/files' && opts.method === 'POST') {
      const meta = JSON.parse(opts.body.split('\r\n\r\n')[1].split('\r\n--')[0]);
      const content = opts.body.split('\r\n\r\n')[2].split('\r\n--')[0];
      const id = 'file' + (++g.seq);
      g.files.set(meta.name, { id, parents: meta.parents, content });
      return ok({ id });
    }
    if (u.pathname.startsWith('/upload/drive/v3/files/') && opts.method === 'PATCH') {
      const id = u.pathname.split('/').pop();
      for (const f of g.files.values()) if (f.id === id) f.content = opts.body;
      return ok({ id });
    }
    throw new Error('想定外の呼び出し ' + url);
  };
  return g;
}

const CONNECTED = { refresh_token: 'rt', access_token: 'at-old', expires_at: new Date(0).toISOString() };

const READ = {
  accounts: [{ network: 'tiktok', label: 'ひろや', latest: { followers: 120 } }, { network: 'x', account_name: 'x1', latest: null }],
  posts: [{ network: 'youtube', title: 'DAY6', permalink: 'https://y/1', postedAt: '2026-10-06T10:00:00Z', metrics: { views: 300, likes: 4 } }],
  tiktokVideos: [{ video_id: '7', title: 'DAY6', views: 900 }],
};

(async () => {
  await check('運用アカウント名 → 分析の決めごとどおりの短い名前', () => {
    assert.strictEqual(ex.shortName('ひろや｜AI初心者30日30アプリ'), 'AI紹介');
    assert.strictEqual(ex.shortName('転職のホンネまとめ'), '転職');
    assert.strictEqual(ex.shortName('ひろや｜断れない人のための言い方メモ'), 'ひろや_断れない人のための言い方メモ');
    assert.strictEqual(ex.shortName(''), 'その他');
  });

  await check('書き出す形が、画面の「分析用にコピー」と同じ項目を持つ', () => {
    const snap = ex.ownSnapshot(READ, { label: 'G' }, '2026-10-12');
    assert.strictEqual(snap.group, 'G', '運用アカウントの名前は label 列');
    assert.deepStrictEqual(snap.accounts, [
      { network: 'tiktok', label: 'ひろや', followers: 120 },
      { network: 'x', label: 'x1', followers: null },
    ]);
    assert.deepStrictEqual(snap.posts[0], {
      network: 'youtube', title: 'DAY6', url: 'https://y/1', posted_at: '2026-10-06T10:00:00Z',
      metrics: { views: 300, likes: 4, comments: null },
    });
    assert.strictEqual(snap.tiktok_videos.length, 1);
    // 画面側の関数にも同じ項目があること（片方だけ変えると分析の道具が読めなくなる）
    const html = require('fs').readFileSync(__dirname + '/../public/index.html', 'utf8');
    const body = html.slice(html.indexOf('function buildOwnSnapshot'), html.indexOf("$('ownCopyBtn').onclick"));
    for (const k of ['own:', 'collected_at:', 'accounts:', 'posts:', 'tiktok_videos:', 'followers:', 'posted_at:']) {
      assert.ok(body.includes(k), '画面に ' + k + ' が無い');
    }
  });

  await check('運用アカウントごとに own_<日付>_<名前>.json を置き、連携の無い束は飛ばす', async () => {
    const g = fakeGoogle();
    const db = fakeDb([{ id: 'g1', label: 'ひろや｜AI初心者30日30アプリ' }, { id: 'g2', label: '転職のホンネまとめ' }, { id: 'g3', label: '空' }],
      Object.assign({}, CONNECTED));
    const read = async (id) => (id === 'g3' ? { accounts: [] } : READ);
    const out = await ex.exportOwn({ db, read, now: new Date('2026-10-11T23:00:00Z') });
    assert.deepStrictEqual(out.files.map((f) => f.name), ['own_2026-10-12_AI紹介.json', 'own_2026-10-12_転職.json']);
    assert.strictEqual(g.folders.length, 1, 'フォルダは1つ');
    assert.strictEqual(g.refreshed, 1, '切れた入場券は取り直す');
    assert.strictEqual(db.s.setting.folder_id, g.folders[0], 'フォルダIDを覚える');
    assert.ok(db.s.setting.last_export.files.length === 2);
    const saved = JSON.parse(g.files.get('own_2026-10-12_AI紹介.json').content);
    assert.strictEqual(saved.collected_at, '2026-10-12');
  });

  await check('同じ週に2回書き出しても、ファイルは増えずに上書きされる', async () => {
    const g = fakeGoogle();
    const db = fakeDb([{ id: 'g1', label: '転職のホンネまとめ' }], Object.assign({}, CONNECTED));
    const now = new Date('2026-10-11T23:00:00Z');
    await ex.exportOwn({ db, read: async () => READ, now });
    const second = await ex.exportOwn({ db, read: async () => READ, now });
    assert.strictEqual(g.files.size, 1);
    assert.strictEqual(second.files[0].replaced, true);
    assert.strictEqual(g.folders.length, 1, '2回目は前のフォルダを使う');
  });

  await check('ドライブとつながっていなければ、直し方つきで止まる', async () => {
    fakeGoogle();
    const db = fakeDb([{ id: 'g1', label: '転職' }], null);
    await assert.rejects(() => ex.exportOwn({ db, read: async () => READ }), (e) => /つながっていません/.test(e.message) && /連携設定/.test(e.hint));
  });

  await check('TikTok Studio の数字：「1.2万」のような文字は止め、null は通す', async () => {
    const good = [{ account: 'AI紹介', posted_on: '2026-10-06', first_line: 'x', views: 1200, drop_sec: null }];
    assert.strictEqual(ex.checkStudioRows(good), good);
    assert.throws(() => ex.checkStudioRows([{ posted_on: '2026-10-06', views: '1.2万' }]), /views/);
    assert.throws(() => ex.checkStudioRows([{ posted_on: '10/6', views: 1 }]), /posted_on/);
    assert.throws(() => ex.checkStudioRows({ rows: [] }), /配列/);
    const g = fakeGoogle();
    const db = fakeDb([], Object.assign({}, CONNECTED));
    const out = await ex.exportStudio({ db, rows: good, now: new Date('2026-10-11T23:30:00Z') });
    assert.strictEqual(out.files[0].name, 'tiktok_2026-10-12.json');
    assert.deepStrictEqual(JSON.parse(g.files.get('tiktok_2026-10-12.json').content), good);
  });

  await check('書き出しの入口は cron の鍵が無いと 401', async () => {
    const handler = require('../api/insights');
    const res = fakeRes();
    await handler({ method: 'GET', query: { export: 'drive' }, headers: {} }, res);
    assert.strictEqual(res.statusCode, 401);
    const res2 = fakeRes();
    await handler({ method: 'POST', query: { export: 'tiktok-studio' }, headers: { authorization: 'Bearer nope' }, body: [] }, res2);
    assert.strictEqual(res2.statusCode, 401);
  });

  await check('Vercel の cron が月曜の朝（日本時間）に書き出しを呼ぶ', () => {
    const v = require('../vercel.json');
    const c = (v.crons || []).find((x) => x.path === '/api/insights?export=drive');
    assert.ok(c, 'cron が無い');
    assert.strictEqual(c.schedule, '0 23 * * 0', '日曜23時UTC＝月曜8時JST');
  });

  await check('ドライブの連携は drive.file だけを求め、YouTube と同じ戻り先を使う', () => {
    const google = require('../lib/google');
    const u = new URL(google.authUrl('https://example.com/api/connect/youtube', 'drive', drive.SCOPE));
    assert.strictEqual(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
    assert.strictEqual(u.searchParams.get('access_type'), 'offline');
    // YouTube は今までどおり
    const y = new URL(google.authUrl('https://example.com/api/connect/youtube'));
    assert.ok(y.searchParams.get('scope').includes('youtube.upload'));
  });

  for (const [s, n] of results) console.log((s === 'ok' ? '  ✓ ' : '  ✗ ') + n);
  const ng = results.filter((r) => r[0] !== 'ok').length;
  console.log(`\n  ${results.length - ng} / ${results.length} 件成功`);
  if (ng) process.exit(1);
})();

function fakeRes() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); }, end() {},
  };
}
