/*
 * ログイン（クライアント側のみの簡易実装）・評価・マイログを検証する。
 * 実際のGoogle/Appleとの通信はせず、window.google.accounts.id / window.AppleID をテスト用に
 * 差し替え、ログインボタンが押されたのと同じ形でコールバックを直接呼び出す。
 * 閲覧・記録の追加はログイン不要、評価とマイログだけログイン必須、という前提を確認する。
 * 実行: node test/auth.smoke.js   （要 playwright）
 */
const path = require('path');
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; }
  else { console.log('  NG  ' + name + (extra ? '  -> ' + extra : '')); fail++; }
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
      const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function launch() {
  try { return await chromium.launch(); }
  catch (e) {
    const fallback = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(fallback)) return chromium.launch({ executablePath: fallback });
    throw e;
  }
}

function fakeJwt(payload) {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return b64url({ alg: 'none' }) + '.' + b64url(payload) + '.fakesignature';
}

// フェイクAPI（メモリ上のミニDB）を1つのcontextに対して用意する。
// trips/blocks/entriesに加えて、ratings（entryId -> {email: rating}）を持つ。
function installFakeApi(page) {
  let tripSeq = 0, blockSeq = 0, entrySeq = 0;
  const trips = {};
  const blocks = {};
  const entriesByBlock = {};
  const ratingsByEntry = {}; // entryId -> { email: {raterEmail, raterName, score} }

  function entryWithRatings(e) {
    return Object.assign({}, e, { ratings: Object.values(ratingsByEntry[e.id] || {}) });
  }

  return Promise.all([
    page.route(/\/api\/trips$/, async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fulfill({ status: 404, body: '{}' });
      const data = JSON.parse(req.postData());
      const id = 'trip_' + (++tripSeq);
      trips[id] = { id, title: data.title, startDate: data.startDate || '', endDate: data.endDate || '', companions: data.companions || [], coverPhotoId: '', createdAt: 'now', updatedAt: 'now' };
      route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(trips[id]) });
    }),
    page.route(/\/api\/trips\/([^/]+)$/, async (route) => {
      const id = decodeURIComponent(route.request().url().match(/\/api\/trips\/([^/]+)$/)[1]);
      const t = trips[id];
      if (!t) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
      const tripBlocks = Object.values(blocks).filter((b) => b.tripId === id)
        .map((b) => ({ ...b, entries: (entriesByBlock[b.id] || []).map(entryWithRatings) }));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ trip: t, blocks: tripBlocks }) });
    }),
    page.route(/\/api\/trips\/([^/]+)\/blocks$/, async (route) => {
      const tripId = decodeURIComponent(route.request().url().match(/\/api\/trips\/([^/]+)\/blocks$/)[1]);
      const data = JSON.parse(route.request().postData());
      const id = 'blk_' + (++blockSeq);
      blocks[id] = Object.assign({ id, tripId, createdAt: 'now', updatedAt: 'now' }, data);
      entriesByBlock[id] = [];
      route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ...blocks[id], entries: [] }) });
    }),
    page.route(/\/api\/blocks\/([^/]+)\/entries$/, async (route) => {
      const blockId = decodeURIComponent(route.request().url().match(/\/api\/blocks\/([^/]+)\/entries$/)[1]);
      const data = JSON.parse(route.request().postData());
      const id = 'ent_' + (++entrySeq);
      const e = Object.assign({ id, blockId, createdAt: 'now', updatedAt: 'now' }, data);
      entriesByBlock[blockId].push(e);
      route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(entryWithRatings(e)) });
    }),
    page.route(/\/api\/entries\/([^/]+)\/rating$/, async (route) => {
      const req = route.request();
      const entryId = decodeURIComponent(req.url().match(/\/api\/entries\/([^/]+)\/rating$/)[1]);
      const data = JSON.parse(req.postData() || '{}');
      const email = (data.raterEmail || '').toLowerCase();
      ratingsByEntry[entryId] = ratingsByEntry[entryId] || {};
      if (req.method() === 'PUT') {
        ratingsByEntry[entryId][email] = { raterEmail: email, raterName: data.raterName || '', score: data.score };
      } else if (req.method() === 'DELETE') {
        delete ratingsByEntry[entryId][email];
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ratings: Object.values(ratingsByEntry[entryId]) }) });
    }),
    page.route(/\/api\/mylog(\?.*)?$/, async (route) => {
      const url = new URL(route.request().url());
      const email = (url.searchParams.get('email') || '').toLowerCase();
      const items = [];
      Object.keys(entriesByBlock).forEach((blockId) => {
        const block = blocks[blockId];
        entriesByBlock[blockId].forEach((e) => {
          const r = (ratingsByEntry[e.id] || {})[email];
          if (r) {
            items.push({
              entryId: e.id, blockId: block.id, tripId: block.tripId, tripTitle: trips[block.tripId].title,
              category: block.category, label: block.label, date: block.date, episode: e.episode || '',
              photoId: (e.photoIds || [])[0] || '', score: r.score, ratedAt: 'now'
            });
          }
        });
      });
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items }) });
    })
  ]);
}

(async () => {
  const { server, port } = await startServer();
  const BASE = `http://127.0.0.1:${port}/`;
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());

  // window.google.accounts.id をテスト用のダミーに差し替える
  await page.addInitScript(() => {
    window.google = {
      accounts: {
        id: {
          initialize: (opts) => { window.__gisCallback = opts.callback; },
          renderButton: (el) => { el.textContent = 'FAKE_GOOGLE_BUTTON'; }
        }
      }
    };
  });

  // index.htmlのmetaタグを、テスト用のAPIとダミーのGoogleクライアントIDに書き換える
  await page.route('**/', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body
      .replace('<meta name="tabilog-api-endpoint" content="https://tabilog-api.hiroya-apps.workers.dev">', '<meta name="tabilog-api-endpoint" content="/api">')
      .replace('<meta name="tabilog-google-client-id" content="">', '<meta name="tabilog-google-client-id" content="fake-client-id.apps.googleusercontent.com">');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });

  await installFakeApi(page);

  await page.goto(BASE);

  // ---- 閲覧・記録の追加はログイン不要（Google Client IDを設定していても） ----
  check('Google Client IDを設定していても、最初はホーム画面が出る（ログイン画面ではない）', await page.isVisible('.screen[data-screen="home"].active'));
  check('ログインしていない人には「ログインする」案内が出る', !(await page.isHidden('#loginPromptRow')));
  check('ログインしていない人にはアカウント欄は出ない', await page.isHidden('#accountRow'));

  await page.click('#btnNewTrip');
  await page.fill('#ntTitle', '未ログイン旅行');
  await page.click('#btnCreateTrip');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  check('ログインなしでも旅行を作れる', true);

  await page.click('.block-add');
  await page.waitForSelector('.screen[data-screen="blockForm"].active');
  await page.fill('#blkLabel', 'テスト予定');
  await page.click('#btnSaveBlock');
  await page.waitForSelector('.screen[data-screen="entryForm"].active');
  check('ログインなしのとき、記録した人は自動入力されない', (await page.inputValue('#entAuthor')) === '');
  check('新規の記録には評価欄が出ない（保存前はまだ評価できない）', await page.isHidden('#entRatingField'));

  await page.click('#btnSaveEntry');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');

  // ---- 評価欄からログインへ（entryForm経由でログインし、entryFormへ戻ってくる） ----
  await page.click('.entry-card >> nth=0 >> .entry-author');
  await page.waitForSelector('.screen[data-screen="entryForm"].active');
  check('保存済みの記録を開くと、ログインなしでも評価欄自体は見える', await page.isVisible('#entRatingField'));
  check('ログインなしのとき、評価欄には「ログインして評価する」案内が出る', await page.isVisible('#btnRatingLogin'));
  await page.click('#btnRatingLogin');
  await page.waitForSelector('.screen[data-screen="login"].active');
  check('評価からのログインは、Appleと同様ログイン画面へ行く', true);

  const credential = fakeJwt({ name: 'テスト太郎', email: 'test-taro@example.com' });
  await page.evaluate((cred) => window.__gisCallback({ credential: cred }), credential);

  await page.waitForSelector('.screen[data-screen="entryForm"].active');
  check('評価からログインすると、元のentryFormへ戻ってくる', true);
  check('ログイン後は★ボタンが表示される', await page.isVisible('.star-btn'));

  // ---- ★を付ける ----
  await page.click('.star-btn[data-score="4"]');
  await page.waitForFunction(() => {
    const btn = document.querySelector('.star-btn[data-score="4"]');
    return btn && btn.classList.contains('on');
  });
  check('★4を付けると選択状態になる', true);

  await page.click('.screen.active [data-back="tripDetail"]');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  check('旅行詳細の記録カードに平均評価が表示される', (await page.textContent('.entry-rating')).indexOf('★ 4.0') !== -1);

  // ---- アカウント欄・マイログ ----
  await page.click('.screen.active [data-back="home"]');
  await page.waitForSelector('.screen[data-screen="home"].active');
  check('ログイン後はホームでアカウント欄が出る', !(await page.isHidden('#accountRow')));
  check('ログイン後はログイン案内が消える', await page.isHidden('#loginPromptRow'));
  check('アカウント名が表示される', (await page.textContent('#accountName')) === 'テスト太郎');

  await page.click('#btnOpenMyLog');
  await page.waitForSelector('.screen[data-screen="mylog"].active');
  // テストで作った予定は「観光」カテゴリ（＝アクティビティーログ）なので、そのタブに切り替えて確認する
  await page.click('.mylog-tab[data-cat="sightseeing"]');
  await page.waitForSelector('.mylog-row');
  check('マイログの一覧に、さきほど評価した記録が出る', (await page.textContent('.mylog-row .mylog-score')) === '★4');

  // ---- ログアウト ----
  await page.click('.screen.active [data-back="home"]').catch(() => {});
  await page.waitForSelector('.screen[data-screen="home"].active');
  await page.click('#btnLogout');
  check('ログアウトしてもホーム画面のまま（ログイン画面には飛ばない）', await page.isVisible('.screen[data-screen="home"].active'));
  check('ログアウトすると再び「ログインする」案内が出る', !(await page.isHidden('#loginPromptRow')));

  check('ページ内エラーが発生していない', errors.length === 0, errors.join(' / '));

  // ---- Appleでサインイン（別ページで、Apple Client IDだけ設定した状態を検証） ----
  const applePage = await ctx.newPage();
  const appleErrors = [];
  applePage.on('pageerror', (e) => appleErrors.push(e.message));
  await applePage.addInitScript(() => {
    window.AppleID = {
      auth: {
        init: (opts) => { window.__appleInitOpts = opts; },
        signIn: () => Promise.resolve({
          authorization: { id_token: 'x.' + btoa('{}') + '.y' },
          user: { name: { firstName: 'アップル', lastName: '花子' }, email: 'apple-hanako@example.com' }
        })
      }
    };
  });
  await applePage.route('**/', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body
      .replace('<meta name="tabilog-api-endpoint" content="https://tabilog-api.hiroya-apps.workers.dev">', '<meta name="tabilog-api-endpoint" content="/api">')
      .replace('<meta name="tabilog-apple-client-id" content="">', '<meta name="tabilog-apple-client-id" content="com.hiroyaapps.tabilog.web">');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });
  await installFakeApi(applePage);
  await applePage.goto(BASE);
  check('Apple Client ID設定時も、最初はホーム画面が出る', await applePage.isVisible('.screen[data-screen="home"].active'));
  await applePage.click('#btnOpenLogin');
  await applePage.waitForSelector('.screen[data-screen="login"].active');
  check('Apple Client ID設定時はAppleボタンが表示される', await applePage.isVisible('#appleSignInButton'));
  await applePage.click('#appleSignInButton');
  await applePage.waitForSelector('.screen[data-screen="home"].active');
  check('Appleログイン後は氏名が表示される', (await applePage.textContent('#accountName')) === 'アップル 花子');
  check('Appleログイン側でエラーが発生していない', appleErrors.length === 0, appleErrors.join(' / '));

  await browser.close();
  server.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
