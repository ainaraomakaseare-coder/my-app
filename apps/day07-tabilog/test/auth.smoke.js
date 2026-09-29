/*
 * ログイン（メールOTP・Apple/Google/LINEのサーバー側フロー）・評価・マイログを検証する。
 * 実際のプロバイダーとの通信はしない。Workerの /auth/providers・/auth/<provider>/start・/auth/exchange を
 * フェイクAPIで差し替え、start が「#auth=<コード>付きで戻る」リダイレクトを返したのと同じ状況を再現する。
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
    accountsByEmail: {}, membersByTrip: {},
    providers: [], exchangeByCode: {}, lastVerifyBody: null
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
    page.route(/\/api\/auth\/providers$/, async (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ providers: state.providers || [] }) });
    }),
    page.route(/\/api\/auth\/exchange$/, async (route) => {
      const data = JSON.parse(route.request().postData());
      const res = (state.exchangeByCode || {})[data.code];
      if (!res) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"invalid_code"}' });
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
    }),
    page.route(/\/api\/auth\/email\/verify$/, async (route) => {
      const data = JSON.parse(route.request().postData());
      state.lastVerifyBody = data;
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

  // index.htmlのmetaタグを、テスト用のAPIに書き換える
  await page.route('**/', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace('<meta name="tabilog-api-endpoint" content="https://tabilog-api.hiroya-apps.workers.dev">', '<meta name="tabilog-api-endpoint" content="/api">');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });

  const sharedApiState = await installFakeApi(page);

  await page.goto(BASE);

  // ---- 閲覧・記録の追加はログイン不要 ----
  check('最初はホーム画面が出る（ログイン画面ではない）', await page.isVisible('.screen[data-screen="home"].active'));
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
  check('評価からのログインは、ログイン画面へ行く', true);

  // メールの確認コードでログインする（フェイクAPIのコードは常に123456）
  await page.fill('#loginName', 'テスト太郎');
  await page.fill('#loginEmail', 'test-taro@example.com');
  await page.click('#btnSendOtp');
  await page.waitForSelector('#emailOtpForm:not([hidden])');
  await page.fill('#loginOtpCode', '123456');
  await page.click('#btnVerifyOtp');

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

  // ---- Apple・Google・LINEでログイン（サーバー側フロー。別コンテキスト＝別ブラウザ） ----
  // フェイクの /auth/<provider>/start は、本物のWorkerと同じく「ログイン後に #auth=<コード> を付けて
  // returnのページへ戻すリダイレクト」を返す。コードはフェイクの /auth/exchange がセッションに交換する。
  const socialCtx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const socialPage = await socialCtx.newPage();
  const socialErrors = [];
  socialPage.on('pageerror', (e) => socialErrors.push(e.message));
  await socialPage.route('**/', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace('<meta name="tabilog-api-endpoint" content="https://tabilog-api.hiroya-apps.workers.dev">', '<meta name="tabilog-api-endpoint" content="/api">');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });
  const socialState = await installFakeApi(socialPage);
  socialState.providers = ['apple', 'google', 'line'];
  const CODE_OK = 'a'.repeat(64);
  const CODE_LINK = 'b'.repeat(64);
  socialState.exchangeByCode[CODE_OK] = { email: 'apple-hanako@example.com', name: 'アップル 花子', token: 't'.repeat(64), provider: 'apple' };
  socialState.exchangeByCode[CODE_LINK] = { needEmail: true, provider: 'line', name: 'ライン太郎' };
  const startUrls = [];
  await socialPage.route(/\/api\/auth\/(apple|google|line)\/start/, async (route) => {
    const u = new URL(route.request().url());
    startUrls.push(u);
    const back = u.searchParams.get('return');
    const code = u.pathname.indexOf('/line/') !== -1 ? CODE_LINK : CODE_OK;
    route.fulfill({ status: 302, headers: { location: back + '#auth=' + code } });
  });
  await socialPage.goto(BASE);
  await socialPage.click('#btnOpenLogin');
  await socialPage.waitForSelector('.screen[data-screen="login"].active');
  await socialPage.waitForSelector('.social-btn[data-provider="line"]:not([hidden])');
  const order = await socialPage.$$eval('.social-btn:not([hidden])', (els) => els.map((e) => e.dataset.provider));
  check('ボタンの順番はApple・Google・LINE', order.join(',') === 'apple,google,line', order.join(','));
  check('ソーシャルボタンがあるときは区切り線を表示する', await socialPage.isVisible('#emailLoginDivider'));
  await socialPage.click('.social-btn[data-provider="apple"]');
  await socialPage.waitForSelector('#accountName:not(:empty)');
  check('Appleログイン後は氏名が表示される', (await socialPage.textContent('#accountName')) === 'アップル 花子');
  check('startにreturnとして自分のページのURLを渡している', startUrls.length === 1 && startUrls[0].searchParams.get('return') === BASE, startUrls.map(String).join(' '));
  check('戻ってきたあと、URLのハッシュ（コード）は消えている', (await socialPage.evaluate(() => location.hash)) === '');
  check('ログイン後はログイン案内が消える', await socialPage.isHidden('#loginPromptRow'));
  const stored = await socialPage.evaluate(() => JSON.parse(localStorage.getItem('tabilog:user')));
  check('セッショントークンが端末に保存される', stored && stored.token === 't'.repeat(64) && stored.provider === 'apple');

  // LINE：メールを受け取れなかった場合 → メールOTPで一度だけ確認して結びつける
  await socialPage.click('#btnLogout');
  await socialPage.click('#btnOpenLogin');
  await socialPage.waitForSelector('.social-btn[data-provider="line"]:not([hidden])');
  await socialPage.click('.social-btn[data-provider="line"]');
  await socialPage.waitForSelector('.screen[data-screen="login"].active');
  await socialPage.waitForSelector('#loginLinkNote:not([hidden])');
  check('メール確認が必要なときは説明が出る', (await socialPage.textContent('#loginLinkNote')).includes('メールアドレスを受け取れなかった'));
  check('メール確認中はソーシャルボタンを出さない', await socialPage.isHidden('#socialLogin'));
  check('プロバイダーの表示名が名前欄に入る', (await socialPage.inputValue('#loginName')) === 'ライン太郎');
  await socialPage.fill('#loginEmail', 'line-taro@example.com');
  await socialPage.click('#btnSendOtp');
  await socialPage.waitForSelector('#emailOtpForm:not([hidden])');
  await socialPage.fill('#loginOtpCode', '123456');
  await socialPage.click('#btnVerifyOtp');
  await socialPage.waitForSelector('.screen[data-screen="home"].active');
  check('確認コードの検証にlinkコードが渡る', socialState.lastVerifyBody && socialState.lastVerifyBody.link === CODE_LINK, JSON.stringify(socialState.lastVerifyBody));
  check('LINEログイン（メール確認後）は氏名が表示される', (await socialPage.textContent('#accountName')) === 'ライン太郎');
  check('ソーシャルログイン側でエラーが発生していない', socialErrors.length === 0, socialErrors.join(' / '));
  await socialCtx.close();

  // ---- メールでログイン（Google/AppleどちらのClient IDも未設定のまま。素のindex.html） ----
  // 別コンテキスト＝別ブラウザ扱いにして、前段のログインのlocalStorageを引き継がないようにする
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
  check('プロバイダーが1つも設定されていなくても、ホーム画面には「ログインする」案内が出る（メールでのログインは常に使える）', !(await emailPage.isHidden('#loginPromptRow')));
  await emailPage.click('#btnOpenLogin');
  await emailPage.waitForSelector('.screen[data-screen="login"].active');
  check('プロバイダー未設定のときはGoogleボタンが表示されない', await emailPage.isHidden('.social-btn[data-provider="google"]'));
  check('プロバイダー未設定のときはAppleボタンが表示されない', await emailPage.isHidden('.social-btn[data-provider="apple"]'));
  check('プロバイダー未設定のときはLINEボタンが表示されない', await emailPage.isHidden('.social-btn[data-provider="line"]'));
  check('プロバイダー未設定のときは区切り線を表示しない（メールしか選択肢が無いため）', await emailPage.isHidden('#emailLoginDivider'));
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
  check('メールでログイン済みなら、プロバイダー未設定でも★ボタンが使える', await emailPage.isVisible('.star-btn'));
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
