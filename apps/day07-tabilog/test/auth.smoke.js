/*
 * Googleログイン（クライアント側のみの簡易実装）を検証する。
 * 実際のGoogleとの通信はせず、window.google.accounts.id をテスト用に差し替え、
 * ログインボタンが押されたのと同じ形でコールバックを直接呼び出す。
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

(async () => {
  const { server, port } = await startServer();
  const BASE = `http://127.0.0.1:${port}/`;
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

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

  let tripSeq = 0, blockSeq = 0;
  const trips = {}, blocks = {};
  await page.route(/\/api\/trips$/, async (route) => {
    const data = JSON.parse(route.request().postData());
    const id = 'trip_' + (++tripSeq);
    trips[id] = { id, title: data.title, startDate: '', endDate: '', companions: [] };
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(trips[id]) });
  });
  await page.route(/\/api\/trips\/([^/]+)$/, async (route) => {
    const id = route.request().url().match(/\/api\/trips\/([^/]+)$/)[1];
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ trip: trips[id], blocks: [] }) });
  });
  await page.route(/\/api\/trips\/([^/]+)\/blocks$/, async (route) => {
    const tripId = route.request().url().match(/\/api\/trips\/([^/]+)\/blocks$/)[1];
    const data = JSON.parse(route.request().postData());
    const id = 'blk_' + (++blockSeq);
    blocks[id] = { id, tripId, ...data };
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ...blocks[id], entries: [] }) });
  });

  await page.goto(BASE);

  check('Google Client ID設定時は最初にログイン画面が出る', await page.isVisible('.screen[data-screen="login"].active'));
  check('Googleのログインボタンが描画される', (await page.textContent('#googleSignInButton')) === 'FAKE_GOOGLE_BUTTON');

  // ログインボタンが押されたのと同じ形で、Googleからの応答をシミュレートする
  const credential = fakeJwt({ name: 'テスト太郎', email: 'test-taro@example.com' });
  await page.evaluate((cred) => window.__gisCallback({ credential: cred }), credential);

  await page.waitForSelector('.screen[data-screen="home"].active');
  check('ログイン後はホーム画面が出る', true);
  check('アカウント名が表示される', (await page.textContent('#accountName')) === 'テスト太郎');
  check('アカウント欄が表示状態になる', !(await page.isHidden('#accountRow')));

  // 新しい記録の「記録した人」に、ログイン中のユーザー名が自動で入る
  await page.click('#btnNewTrip');
  await page.fill('#ntTitle', 'ログインテスト旅行');
  await page.click('#btnCreateTrip');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  await page.click('.block-add');
  await page.waitForSelector('.screen[data-screen="blockForm"].active');
  await page.fill('#blkLabel', 'テスト予定');
  await page.click('#btnSaveBlock');
  await page.waitForSelector('.screen[data-screen="entryForm"].active');
  check('記録した人にログイン中のユーザー名が自動で入る', (await page.inputValue('#entAuthor')) === 'テスト太郎');

  // ログアウトすると再びログイン画面に戻る
  await page.click('.screen.active [data-back="tripDetail"]');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  await page.click('.screen.active [data-back="home"]');
  await page.waitForSelector('.screen[data-screen="home"].active');
  await page.click('#btnLogout');
  check('ログアウトするとログイン画面に戻る', await page.isVisible('.screen[data-screen="login"].active'));

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
  await applePage.goto(BASE);
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
