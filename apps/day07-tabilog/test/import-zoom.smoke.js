/*
 * 取り込みの確認で、小さい画像をタップして大きく見られることを確かめる
 * （予約・チケットの画像から／撮った写真から、2026-10-26）。
 * 実行: node test/import-zoom.smoke.js   （要 playwright）
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

(async () => {
  const { server, port } = await startServer();
  const BASE = `http://127.0.0.1:${port}/`;
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'ja-JP' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());

  const TEST_USER = { email: 'tester@example.com', name: 'テスト太郎', accountId: '123456' };
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
  await page.route(/\/api\/trips\/([^/]+)$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ trip: { id: 'trip_1', title: 'シンガポール', startDate: '2026-08-28', endDate: '2026-08-29', companions: [] }, blocks: [], days: [], members: [] })
  }));
  await page.route(/\/api\/places\/nearby/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ places: [] }) }));
  const base = { transport: '', place: '', placeGuessed: false, fromPlace: '', toPlace: '', company: '', routeNumber: '', departTime: '', arriveTime: '', arriveDate: '', warnings: [], timeEstimated: false, nightIndex: 0, costItems: [], note: '' };
  await page.route(/\/api\/trips\/([^/]+)\/screenshot-scan$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: [{ ...base, id: 's1', category: 'transport', date: '2026-08-28', time: '09:00', label: '飛行機', sourceImage: 1 }], unreadable: [{ image: 0, message: '予定が見つかりませんでした' }], dropped: 0 })
  }));

  const visibleCount = () => page.evaluate(() => {
    const t = document.querySelector('#mvTrack');
    const m = /translateX\((-?\d+)%\)/.exec(t.style.transform || '');
    return { open: !document.querySelector('#photoLightbox').hidden, slides: t.querySelectorAll('.mv-slide').length, index: m ? -Number(m[1]) / 100 : 0, save: !document.querySelector('#btnSaveLightboxPhoto').hidden, src: (t.querySelector('.mv-slide[data-i="' + (m ? -Number(m[1]) / 100 : 0) + '"] img') || {}).src || '' };
  });

  await page.goto(BASE);
  await page.click('#btnNewTrip');
  await page.fill('#ntTitle', 'シンガポール');
  await page.fill('#ntStart', '2026-08-28');
  await page.fill('#ntEnd', '2026-08-29');
  await page.click('#btnCreateTrip');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');

  // ---- 予約・チケットの画像から ----
  await page.click('.block-add-bulk');
  await page.click('.block-add-screenshot');
  await page.waitForSelector('.screen[data-screen="screenshotImport"].active');
  const fx = (n) => path.join(__dirname, 'fixtures', 'photo-gps-' + n + '.jpg');
  await page.setInputFiles('#ssFileInput', [fx(1), fx(2)]);
  await page.waitForFunction(() => document.querySelectorAll('#ssThumbs .ss-thumb').length === 2);
  await page.click('#ssThumbs .ss-thumb >> nth=1');
  let v = await visibleCount();
  check('選んだ画像をタップすると大きく表示される（2枚目から）', v.open && v.slides === 2 && v.index === 1 && v.src.startsWith('blob:'), JSON.stringify(v));
  check('端末の画像なので「保存」ボタンは出ない', !v.save);
  await page.click('#btnCloseLightbox');
  check('閉じると選んだ画像はそのまま', (await page.$$('#ssThumbs .ss-thumb')).length === 2 && await page.isHidden('#photoLightbox'));

  await page.click('#btnSsScan');
  await page.waitForSelector('.screen[data-screen="importConfirm"].active');
  await page.click('.ss-card .ss-thumb');
  v = await visibleCount();
  check('確認画面で候補の元の画像をタップすると大きく表示される', v.open && v.slides === 2 && v.index === 1, JSON.stringify(v));
  await page.click('#btnCloseLightbox');
  await page.click('.ss-unreadable-row .ss-thumb');
  v = await visibleCount();
  check('読み取れなかった画像もタップで大きく表示される', v.open && v.index === 0, JSON.stringify(v));
  await page.click('#btnCloseLightbox');
  check('拡大を閉じても確認画面のまま', await page.isVisible('.screen[data-screen="importConfirm"].active'));
  await page.click('#btnSsCancel');
  await page.waitForSelector('.screen[data-screen="screenshotImport"].active');
  await page.click('.screen[data-screen="screenshotImport"] [data-back="tripDetail"]');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');

  // ---- 撮った写真から ----
  await page.click('.block-add-bulk');
  const chooser = page.waitForEvent('filechooser');
  await page.click('.block-add-photos');
  await (await chooser).setFiles([fx(1), fx(2), fx(3)]);
  await page.waitForSelector('.screen[data-screen="importConfirm"].active');
  await page.waitForSelector('.ss-photo-strip img');
  await page.click('.ss-photo-strip img >> nth=2');
  v = await visibleCount();
  check('写真から旅程の確認画面で、写真をタップすると大きく表示される（押した写真から）', v.open && v.slides === 3 && v.index === 2 && v.src.startsWith('blob:'), JSON.stringify(v));
  check('写真から旅程でも「保存」ボタンは出ない', !v.save);
  await page.click('#lightboxPrev');
  v = await visibleCount();
  check('前の写真へ移れる', v.index === 1, JSON.stringify(v));
  await page.keyboard.press('Escape');
  check('Escで閉じる', await page.isHidden('#photoLightbox'));

  check('ページでエラーが出ていない', errors.length === 0, errors.join(' / '));
  console.log(`import-zoom.smoke: ${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
