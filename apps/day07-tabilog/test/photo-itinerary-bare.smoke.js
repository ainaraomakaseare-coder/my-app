/*
 * 写真から旅程を作るとき、撮影時刻も撮影場所も無い写真（LINEで届いた写真など）も捨てずに、
 * 見ている日に時刻・場所が空欄の予定（枠）として入ることを確かめる（2026-11-12）。
 * 実行: node test/photo-itinerary-bare.smoke.js   （要 playwright）
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
  const errors = [], dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

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
    body: JSON.stringify({ trip: { id: 'trip_1', title: '京都', startDate: '2026-10-20', endDate: '2026-10-22', companions: [] }, blocks: [], days: [], members: [] })
  }));
  await page.route(/\/api\/places\/nearby/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ found: false }) }));
  let saved = null;
  await page.route(/\/api\/trips\/([^/]+)\/import-blocks$/, (route) => {
    saved = JSON.parse(route.request().postData());
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ blocks: [] }) });
  });

  await page.goto(BASE);
  await page.click('#btnNewTrip');
  await page.fill('#ntTitle', '京都');
  await page.fill('#ntStart', '2026-10-20');
  await page.fill('#ntEnd', '2026-10-22');
  await page.click('#btnCreateTrip');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  // 2日目のタブを見ている状態で、撮影時刻も撮影場所も無い写真を選ぶ
  await page.click('.day-tab >> nth=1');

  const fx = (name) => path.join(__dirname, 'fixtures', name);
  await page.click('.block-add-bulk');
  const chooser = page.waitForEvent('filechooser');
  await page.click('.block-add-photos');
  await (await chooser).setFiles([fx('photo-noinfo-1.jpg'), fx('photo-noinfo-2.jpg')]);
  await page.waitForSelector('.screen[data-screen="importConfirm"].active', { timeout: 15000 }).catch(() => {});
  check('情報の無い写真だけでも、止まらずに確認画面が出る', await page.isVisible('.screen[data-screen="importConfirm"].active'), dialogs.join(' / '));
  check('情報の無い写真は1枚ずつ予定の枠になる', (await page.$$('.ss-card')).length === 2);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true }); // 見た目の確認用（任意）
  const save = await page.$('#btnSsSave');
  check('「この内容で追加」をそのまま押せる', !!save && !(await save.isDisabled()));
  if (save) await save.click();
  for (let i = 0; i < 50 && !saved; i++) await page.waitForTimeout(100);
  check('見ている日（2日目）に、時刻と場所が空のまま追加される', !!saved && saved.items.length === 2 &&
    saved.items.every((it) => it.date === '2026-10-21' && it.time === '' && !it.mapUrl), JSON.stringify(saved && saved.items));

  check('ページでエラーが出ていない', errors.length === 0, errors.join(' / '));
  console.log(`photo-itinerary-bare.smoke: ${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
