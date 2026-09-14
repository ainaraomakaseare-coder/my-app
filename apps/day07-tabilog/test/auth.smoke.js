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
// shared を渡すと、そのオブジェクトを複数ページ間で使い回す（＝同じアカウントのデータを
// 「別の端末（＝別のbrowser context、localStorageは共有しない）」から見る状況を再現できる）
async function installFakeApi(page, shared) {
  const state = shared || {
    tripSeq: 0, blockSeq: 0, entrySeq: 0, accountSeq: 0,
    trips: {}, blocks: {}, entriesByBlock: {}, ratingsByEntry: {}, otpsByEmail: {},
    accountsByEmail: {}, membersByTrip: {}
  };
  const trips = state.trips;
  const blocks = state.blocks;
  const entriesByBlock = state.entriesByBlock;
  const ratingsByEntry = state.ratingsByEntry;
  const otpsByEmail = state.otpsByEmail;
  const accountsByEmail = state.accountsByEmail;
  const membersByTrip = state.membersByTrip;
  function nextTripId() { return 'trip_' + (++state.tripSeq); }
  function nextBlockId() { return 'blk_' + (++state.blockSeq); }
  function nextEntryId() { return 'ent_' + (++state.entrySeq); }

  function getOrCreateAccount(email, name) {
    var e = (email || '').toLowerCase();
    if (!accountsByEmail[e]) accountsByEmail[e] = { accountId: String(100000 + (++state.accountSeq)), name: name || '' };
    else if (name) accountsByEmail[e].name = name;
    return accountsByEmail[e];
  }

  function entryWithRatings(e) {
    return Object.assign({}, e, { ratings: Object.values(ratingsByEntry[e.id] || {}) });
  }

  await Promise.all([
    page.route(/\/api\/trips$/, async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fulfill({ status: 404, body: '{}' });
      const data = JSON.parse(req.postData());
      const id = nextTripId();
      trips[id] = { id, title: data.title, startDate: data.startDate || '', endDate: data.endDate || '', companions: data.companions || [], coverPhotoId: '', createdAt: 'now', updatedAt: 'now' };
      route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(trips[id]) });
    }),
    page.route(/\/api\/trips\/([^/]+)$/, async (route) => {
      const id = decodeURIComponent(route.request().url().match(/\/api\/trips\/([^/]+)$/)[1]);
      const t = trips[id];
      if (!t) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
      const tripBlocks = Object.values(blocks).filter((b) => b.tripId === id)
        .map((b) => ({ ...b, entries: (entriesByBlock[b.id] || []).map(entryWithRatings) }));
      const members = membersByTrip[id] || [];
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ trip: t, blocks: tripBlocks, members }) });
    }),
    page.route(/\/api\/accounts\/ensure$/, async (route) => {
      const data = JSON.parse(route.request().postData());
      const account = getOrCreateAccount(data.email, data.name);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accountId: account.accountId, email: (data.email || '').toLowerCase(), name: account.name }) });
    }),
    page.route(/\/api\/trips\/([^/]+)\/join$/, async (route) => {
      const tripId = decodeURIComponent(route.request().url().match(/\/api\/trips\/([^/]+)\/join$/)[1]);
      const data = JSON.parse(route.request().postData());
      const account = getOrCreateAccount(data.email, data.name);
      membersByTrip[tripId] = membersByTrip[tripId] || [];
      if (!membersByTrip[tripId].some((m) => m.accountId === account.accountId)) {
        membersByTrip[tripId].push({ accountId: account.accountId, name: account.name, joinedAt: 'now' });
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ members: membersByTrip[tripId], accountId: account.accountId }) });
    }),
    page.route(/\/api\/trips\/([^/]+)\/blocks$/, async (route) => {
      const tripId = decodeURIComponent(route.request().url().match(/\/api\/trips\/([^/]+)\/blocks$/)[1]);
      const data = JSON.parse(route.request().postData());
      const id = nextBlockId();
      blocks[id] = Object.assign({ id, tripId, createdAt: 'now', updatedAt: 'now' }, data);
      entriesByBlock[id] = [];
      route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ...blocks[id], entries: [] }) });
    }),
    page.route(/\/api\/blocks\/([^/]+)\/entries$/, async (route) => {
      const blockId = decodeURIComponent(route.request().url().match(/\/api\/blocks\/([^/]+)\/entries$/)[1]);
      const data = JSON.parse(route.request().postData());
      const id = nextEntryId();
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
      const account = accountsByEmail[email];
      const joinedTrips = account
        ? Object.keys(membersByTrip)
            .filter((tripId) => membersByTrip[tripId].some((m) => m.accountId === account.accountId))
            .map((tripId) => trips[tripId])
        : [];
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items, trips: joinedTrips }) });
    }),
    page.route(/\/api\/auth\/email\/send$/, async (route) => {
      const data = JSON.parse(route.request().postData());
      otpsByEmail[data.email.toLowerCase()] = { code: '123456', name: data.name || '' };
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }),
    page.route(/\/api\/auth\/email\/verify$/, async (route) => {
      const data = JSON.parse(route.request().postData());
      const email = data.email.toLowerCase();
      const otp = otpsByEmail[email];
      if (!otp) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
      if (otp.code !== data.code) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"wrong_code"}' });
      delete otpsByEmail[email];
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ email, name: otp.name }) });
    })
  ]);
  return state;
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

  const sharedApiState = await installFakeApi(page);

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

  // ---- 参加する（未ログインなら、押すとログイン画面に行く） ----
  check('ログイン前は「参加する」ボタンが見える', (await page.textContent('#btnJoinTrip')) === '参加する');
  await page.click('#btnJoinTrip');
  await page.waitForSelector('.screen[data-screen="login"].active');
  check('未ログインで「参加する」を押すとログイン画面に行く', true);
  await page.click('#btnLoginBack');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');

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

  // ---- 参加する（ログイン中：アカウント参加者として旅行に紐付く） ----
  await page.click('#btnJoinTrip');
  await page.waitForFunction(() => (document.querySelector('#btnJoinTrip') || {}).textContent === '参加済み');
  check('参加すると「参加済み」になる', true);
  check('参加すると自分の名前がアカウント参加者欄に出る', (await page.textContent('#tripMembers')).includes('テスト太郎'));

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
  check('マイログの「参加した旅行一覧」に、参加した旅行が出る', (await page.textContent('#mylogTripList')).includes('未ログイン旅行'));

  // ---- 別の端末（localStorageを共有しない新しいcontext）で同じアカウントにログインすると、
  //      この端末では一度も開いていない「参加した旅行」もホーム画面に出る ----
  const otherDeviceCtx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const otherDevicePage = await otherDeviceCtx.newPage();
  const otherDeviceErrors = [];
  otherDevicePage.on('pageerror', (e) => otherDeviceErrors.push(e.message));
  otherDevicePage.on('dialog', (d) => d.accept());
  await otherDevicePage.route('**/', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace('<meta name="tabilog-api-endpoint" content="https://tabilog-api.hiroya-apps.workers.dev">', '<meta name="tabilog-api-endpoint" content="/api">');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });
  await installFakeApi(otherDevicePage, sharedApiState);
  await otherDevicePage.goto(BASE);
  check('別端末の初回アクセスでは、ホームの旅行一覧はまだ空（ローカル索引は端末ごとのため）', (await otherDevicePage.textContent('#tripList')).includes('まだ旅行がありません'));

  await otherDevicePage.click('#btnOpenLogin');
  await otherDevicePage.waitForSelector('.screen[data-screen="login"].active');
  await otherDevicePage.fill('#loginName', 'テスト太郎');
  await otherDevicePage.fill('#loginEmail', 'test-taro@example.com');
  await otherDevicePage.click('#btnSendOtp');
  await otherDevicePage.waitForSelector('#emailOtpForm:not([hidden])');
  await otherDevicePage.fill('#loginOtpCode', '123456');
  await otherDevicePage.click('#btnVerifyOtp');
  await otherDevicePage.waitForSelector('.screen[data-screen="home"].active');
  await otherDevicePage.waitForFunction(() => (document.querySelector('#tripList') || {}).textContent.includes('未ログイン旅行'));
  check('別端末で同じアカウントにログインすると、参加済みの旅行がホームの一覧にも出るようになる', true);
  check('別端末側でエラーが発生していない', otherDeviceErrors.length === 0, otherDeviceErrors.join(' / '));
  await otherDeviceCtx.close();

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

  // ---- メールでログイン（Google/AppleどちらのClient IDも未設定のまま。素のindex.html） ----
  // 別コンテキスト＝別ブラウザ扱いにして、前段のGoogle/AppleログインのlocalStorageを引き継がないようにする
  const emailCtx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const emailPage = await emailCtx.newPage();
  const emailErrors = [];
  emailPage.on('pageerror', (e) => emailErrors.push(e.message));
  await emailPage.route('**/', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace('<meta name="tabilog-api-endpoint" content="https://tabilog-api.hiroya-apps.workers.dev">', '<meta name="tabilog-api-endpoint" content="/api">');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });
  await installFakeApi(emailPage);
  await emailPage.goto(BASE);
  check('Google/AppleのClient IDが未設定でも、ホーム画面には「ログインする」案内が出る（メールでのログインは常に使える）', !(await emailPage.isHidden('#loginPromptRow')));
  await emailPage.click('#btnOpenLogin');
  await emailPage.waitForSelector('.screen[data-screen="login"].active');
  check('Client ID未設定のときはGoogleボタンが表示されない', await emailPage.isHidden('#googleSignInButton') || (await emailPage.textContent('#googleSignInButton')) === '');
  check('Client ID未設定のときはAppleボタンが表示されない', await emailPage.isHidden('#appleSignInButton'));
  check('Client ID未設定のときは区切り線を表示しない（メールしか選択肢が無いため）', await emailPage.isHidden('#emailLoginDivider'));
  check('メールでのログインフォームは常に表示される', await emailPage.isVisible('#emailLoginForm'));

  await emailPage.fill('#loginName', 'メール花子');
  await emailPage.fill('#loginEmail', 'hanako-email@example.com');
  await emailPage.click('#btnSendOtp');
  await emailPage.waitForSelector('#emailOtpForm:not([hidden])');
  check('コード送信後は確認コード入力欄が出る', await emailPage.isVisible('#loginOtpCode'));
  await emailPage.fill('#loginOtpCode', '000000');
  await emailPage.click('#btnVerifyOtp');
  await emailPage.waitForFunction(() => (document.querySelector('#loginStatus') || {}).textContent.includes('正しくありません'));
  check('間違ったコードでは弾かれる', true);
  await emailPage.fill('#loginOtpCode', '123456');
  await emailPage.click('#btnVerifyOtp');
  await emailPage.waitForSelector('.screen[data-screen="home"].active');
  check('正しいコードでログインすると氏名が表示される', (await emailPage.textContent('#accountName')) === 'メール花子');

  await emailPage.click('#btnNewTrip');
  await emailPage.fill('#ntTitle', 'メールログインテスト旅行');
  await emailPage.click('#btnCreateTrip');
  await emailPage.waitForSelector('.screen[data-screen="tripDetail"].active');
  await emailPage.click('.block-add');
  await emailPage.waitForSelector('.screen[data-screen="blockForm"].active');
  await emailPage.fill('#blkLabel', 'メールテスト予定');
  await emailPage.click('#btnSaveBlock');
  await emailPage.waitForSelector('.screen[data-screen="entryForm"].active');
  check('メールでログイン中は、記録した人が自動入力される', (await emailPage.inputValue('#entAuthor')) === 'メール花子');
  await emailPage.click('#btnSaveEntry');
  await emailPage.waitForSelector('.screen[data-screen="tripDetail"].active');
  await emailPage.click('.entry-card >> nth=0 >> .entry-author');
  await emailPage.waitForSelector('.screen[data-screen="entryForm"].active');
  check('メールでログイン済みなら、Client ID未設定でも★ボタンが使える', await emailPage.isVisible('.star-btn'));
  await emailPage.click('.star-btn[data-score="3"]');
  await emailPage.waitForFunction(() => {
    const btn = document.querySelector('.star-btn[data-score="3"]');
    return btn && btn.classList.contains('on');
  });
  check('メールアカウントでも★を付けられる', true);
  check('メールログイン側でエラーが発生していない', emailErrors.length === 0, emailErrors.join(' / '));

  await browser.close();
  server.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
