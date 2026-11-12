/*
 * 【必須テスト】新しい予定を追加する画面で、写真・動画・場所まで入れられることを確かめる（2026-11-12）。
 * 「予定を入れてから記録を入れるのが二度手間」という声から、予定の画面に記録の写真・動画・地図の欄を出し、
 * 入れたものを予定の最初の記録として一緒に保存するようにした。リリース前に必ず通すこと（docs/release-checklist.md）。
 *   - 新しい予定の画面に写真・動画・場所の欄が出る（スマホは「カメラで撮る」「アルバムから選ぶ」も並ぶ）
 *   - 位置情報つきの写真を選ぶと、場所の欄に撮影場所が入る
 *   - 保存すると、予定と一緒に写真・場所つきの記録が1件できる
 *   - 何も入れなければ、これまでどおり予定だけ（記録は作らない）
 *   - 続けて「記録を追加」を開くと、欄は記録の画面に戻っていて空になっている
 *   - 既存の予定の編集では出さない
 * 実行: node test/plan-media.smoke.js   （要 playwright）
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
  const args = [];
  try { return await chromium.launch({ args }); }
  catch (e) {
    const fallback = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(fallback)) return chromium.launch({ executablePath: fallback, args });
    throw e;
  }
}

const TEST_USER = { email: 'tester@example.com', name: 'テスト太郎', accountId: '123456' };


async function setup(browser, BASE) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'ja-JP', hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.addInitScript((user) => {
    localStorage.setItem('tabilog:user', JSON.stringify(user));
    localStorage.setItem('tabilog.tutorialDone', '1');
    localStorage.setItem('tabilog.tutorialTripDone', '1');
  }, TEST_USER);
  await page.route(/\/api\/accounts\/ensure$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ accountId: TEST_USER.accountId, email: TEST_USER.email, name: TEST_USER.name, memoRemainingThisPeriod: 5, voiceRemainingThisPeriod: 5, ticketCredits: 0 })
  }));
  await page.route('**/', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace('<meta name="tabilog-api-endpoint" content="https://tabilog-api.hiroya-apps.workers.dev">', '<meta name="tabilog-api-endpoint" content="/api">');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });
  await page.route(/\/api\/trips$/, (route) => {
    const data = JSON.parse(route.request().postData());
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'trip_1', title: data.title, startDate: data.startDate, endDate: data.endDate, companions: [], coverPhotoId: '', createdAt: 'now', updatedAt: 'now' }) });
  });
  const blocks = [], entries = [], photos = [];
  await page.route(/\/api\/photos$/, (route) => {
    const id = 'photo_' + (photos.length + 1) + '.jpg';
    photos.push(id);
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id }) });
  });
  await page.route(/\/api\/photos\/.+/, (route) => route.fulfill({ status: 200, contentType: 'image/jpeg', body: fs.readFileSync(path.join(__dirname, 'fixtures', 'photo-gps-1.jpg')) }));
  await page.route(/\/api\/trips\/trip_1\/blocks$/, (route) => {
    const data = JSON.parse(route.request().postData() || '{}');
    const b = { ...data, id: 'blk_' + (blocks.length + 1), tripId: 'trip_1', createdAt: 'now', updatedAt: 'now' };
    blocks.push(b);
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ...b, entries: [] }) });
  });
  await page.route(/\/api\/blocks\/([^/]+)\/entries$/, (route) => {
    const blockId = route.request().url().match(/\/blocks\/([^/]+)\/entries$/)[1];
    const data = JSON.parse(route.request().postData() || '{}');
    const e = { ...data, id: 'ent_' + (entries.length + 1), blockId, ratings: [], createdAt: 'now', updatedAt: 'now' };
    entries.push(e);
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(e) });
  });
  await page.route(/\/api\/trips\/([^/]+)$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ trip: { id: 'trip_1', title: '沖縄', startDate: '2026-08-28', endDate: '2026-08-29', companions: [] },
      blocks: blocks.map((b) => ({ ...b, entries: entries.filter((e) => e.blockId === b.id) })), days: [], members: [] })
  }));

  await page.goto(BASE);
  await page.click('#btnNewTrip');
  await page.fill('#ntTitle', '沖縄');
  await page.fill('#ntStart', '2026-08-28');
  await page.fill('#ntEnd', '2026-08-29');
  await page.click('#btnCreateTrip');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  return { ctx, page, errors, blocks, entries, photos };
}

async function openNewBlock(page) {
  await page.click('.block-add');
  await page.waitForSelector('.screen[data-screen="blockForm"].active');
}

(async () => {
  const { server, port } = await startServer();
  const BASE = `http://127.0.0.1:${port}/`;
  const browser = await launch();
  const fx = path.join(__dirname, 'fixtures', 'photo-gps-1.jpg');
  const { ctx, page, errors, blocks, entries, photos } = await setup(browser, BASE);
  const inBlock = (sel) => page.isVisible('.screen[data-screen="blockForm"] ' + sel);

  // ---- 写真と場所を入れて予定を保存 ----
  await openNewBlock(page);
  check('新しい予定の画面に写真の欄が出る', await inBlock('#entPhotoPicker'));
  check('「カメラで撮る」も並ぶ（スマホ）', await inBlock('#entPhotoShotPicker'));
  check('動画の欄が出る', await inBlock('#entVideoPicker'));
  check('場所の欄が出る（現在地を入れる・場所名で検索）', (await inBlock('#btnCurrentLocation')) && (await inBlock('#entPlaceSearch')));
  check('場所の欄の名前は「場所（任意）」', (await page.textContent('#entMapLabel')) === '場所（任意）');
  await page.fill('#blkLabel', '首里城公園');
  const ev = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
  await page.click('#entPhotoPicker');
  const chooser = await ev;
  if (chooser) await chooser.setFiles(fx);
  await page.waitForFunction(() => document.querySelectorAll('#entPhotoPreview img').length === 1, null, { timeout: 5000 }).catch(() => {});
  check('選んだ写真が予定の画面に入る', (await page.$$('.screen[data-screen="blockForm"] #entPhotoPreview img')).length === 1);
  await page.waitForFunction(() => document.querySelector('#entMapUrl').value !== '', null, { timeout: 5000 }).catch(() => {});
  const mapUrl = await page.inputValue('#entMapUrl');
  check('写真の撮影場所が場所の欄に入る', /maps/.test(mapUrl), mapUrl);
  await page.click('#btnSaveBlock');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  await page.waitForTimeout(300);
  check('予定が1件できる', blocks.length === 1);
  check('写真・場所つきの記録が1件できる', entries.length === 1 && entries[0].blockId === 'blk_1');
  check('記録に写真が入る（アップロード済みのid）', entries[0] && entries[0].photoIds.length === 1 && entries[0].photoIds[0] === photos[0], JSON.stringify(entries[0] && entries[0].photoIds));
  check('記録に場所が入る', entries[0] && entries[0].mapUrl === mapUrl);
  check('記録した人はログイン中の人', entries[0] && entries[0].author === TEST_USER.name);
  check('トーストは「予定と写真・場所を保存しました」', /予定と写真・場所を保存しました/.test(await page.textContent('#toast')));
  check('タイムラインに写真が出る', (await page.innerHTML('#timeline')).indexOf(photos[0]) >= 0);

  // ---- 続けてトーストの「記録を追加」 ----
  await page.click('.toast-action-btn');
  await page.waitForSelector('.screen[data-screen="entryForm"].active');
  check('記録の画面に写真の欄が戻っている', await page.isVisible('.screen[data-screen="entryForm"] #entPhotoPicker'));
  check('記録の画面に場所の欄が戻っている', await page.isVisible('.screen[data-screen="entryForm"] #btnCurrentLocation'));
  check('欄の並びは写真→動画→時間', await page.evaluate(() => {
    const a = document.getElementById('entPhotoField'), b = document.getElementById('entVideoField'), c = document.getElementById('entTimeField');
    return a.nextElementSibling === b && b.nextElementSibling === c;
  }));
  check('地図の欄は到着地の欄の前', await page.evaluate(() => document.getElementById('entMapField').nextElementSibling === document.getElementById('entArriveField')));
  check('新しい記録の写真は空', (await page.$$('#entPhotoPreview img')).length === 0);
  check('新しい記録の地図は空', (await page.inputValue('#entMapUrl')) === '');
  check('地図の欄の名前は記録の画面のもの', (await page.textContent('#entMapLabel')) === '地図のURL（任意）');
  await page.click('.screen[data-screen="entryForm"] .close-btn');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');

  // ---- 何も入れない予定は、これまでどおり予定だけ ----
  await openNewBlock(page);
  check('もう一度開くと写真は空', (await page.$$('.screen[data-screen="blockForm"] #entPhotoPreview img')).length === 0);
  check('もう一度開くと場所は空', (await page.inputValue('#entMapUrl')) === '');
  await page.fill('#blkLabel', '国際通り');
  await page.click('#btnSaveBlock');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  await page.waitForTimeout(300);
  check('予定が2件になる', blocks.length === 2);
  check('何も入れなければ記録は作らない', entries.length === 1);
  check('トーストは「予定を保存しました」', /^予定を保存しました/.test(await page.textContent('#toast')));

  // ---- 予定の見出しで場所を検索 ----
  await page.route(/\/api\/places\/search/, (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ places: [{ name: '美ら海水族館', address: '沖縄県本部町', lat: 26.694, lng: 127.878 }] }) }));
  await openNewBlock(page);
  await page.fill('#blkLabel', '美ら海水族館');
  await page.click('#btnPlaceSearch');
  await page.waitForFunction(() => document.querySelector('#entMapUrl').value !== '', null, { timeout: 5000 }).catch(() => {});
  check('検索欄が空なら予定の見出しで探す', (await page.inputValue('#entPlaceSearch')) === '美ら海水族館' && /26\.694/.test(await page.inputValue('#entMapUrl')), await page.inputValue('#entMapUrl'));
  await page.click('#btnSaveBlock');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  await page.waitForTimeout(300);
  check('場所だけでも記録ができる', entries.length === 2 && entries[1].blockId === 'blk_3' && entries[1].mapPlaceName === '美ら海水族館', JSON.stringify(entries[1]));

  // ---- 既存の予定の編集では出さない ----
  await page.click('#timeline .block-head >> nth=0');
  await page.waitForSelector('.screen[data-screen="blockForm"].active');
  check('既存の予定の編集では写真・場所の欄を出さない', (await page.textContent('#blkFormTitle')) === '予定を編集' && await page.isHidden('#blkMediaSlot'));

  check('ページでエラーが出ていない', errors.length === 0, errors.join(' / '));
  await ctx.close();
  console.log(`plan-media.smoke: ${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
