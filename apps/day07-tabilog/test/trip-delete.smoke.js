/*
 * 旅行の編集画面の「この旅行を削除する」を実ブラウザで確かめる。
 * ログインしていない／ほかにアカウント参加者がいる→送らずに案内だけ、
 * 自分ひとり→確認のあとDELETE /trips/:idを送り、ホームへ戻って一覧からも消える。
 * 実行: node test/trip-delete.smoke.js   （要 playwright）
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

const ME = { name: 'アリス', email: 'alice@example.com', accountId: '111111', token: 'a'.repeat(64) };
const TRIP = { id: 'trip_t1', title: 'テスト旅行', startDate: '2026-10-01', endDate: '2026-10-02', companions: [], coverPhotoId: '', tripType: '', settleUnit: 1 };

async function run(browser, BASE, opts) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 1600 }, locale: 'ja-JP' });
  const page = await ctx.newPage();
  const dialogs = [];
  const deletes = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.addInitScript((o) => {
    localStorage.setItem('tabilog.tutorialDone', '1');
    localStorage.setItem('tabilog.tutorialTripDone', '1');
    localStorage.setItem('tabilog:my-trips', JSON.stringify([{ id: o.trip.id, title: o.trip.title, startDate: o.trip.startDate, endDate: o.trip.endDate }]));
    if (o.user) localStorage.setItem('tabilog:user', JSON.stringify(o.user));
  }, { trip: TRIP, user: opts.user || null });
  await page.route('**/', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace(/<meta name="tabilog-api-endpoint" content="[^"]*">/, '<meta name="tabilog-api-endpoint" content="/api">');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });
  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === '/api/trips/' + TRIP.id && req.method() === 'DELETE') {
      deletes.push(req.headers().authorization || '');
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    if (p === '/api/trips/' + TRIP.id) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ trip: TRIP, blocks: [], days: [], members: opts.members }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(BASE);
  await page.click('text=' + TRIP.title);
  await page.waitForSelector('#btnEditTrip', { state: 'visible' });
  await page.click('#btnEditTrip');
  await page.waitForSelector('#btnDeleteTrip', { state: 'visible' });
  if (process.env.SHOT) await page.locator('#btnSaveTripEdit').evaluate((el) => el.closest('.wrap').scrollIntoView(false)).then(() => page.screenshot({ path: process.env.SHOT, clip: { x: 0, y: 0, width: 420, height: 1600 } }));
  await page.click('#btnDeleteTrip');
  await page.waitForTimeout(600);
  const myTrips = await page.evaluate(() => JSON.parse(localStorage.getItem('tabilog:my-trips') || '[]').map((t) => t.id));
  const hidden = await page.evaluate(() => JSON.parse(localStorage.getItem('tabilog:hidden-trips') || '[]'));
  const screen = await page.evaluate(() => { const s = document.querySelector('.screen.active, .screen:not([hidden])'); return s ? s.getAttribute('data-screen') : ''; });
  await ctx.close();
  return { dialogs, deletes, myTrips, hidden, screen };
}

(async () => {
  const { server, port } = await startServer();
  const BASE = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();
  const meMember = { accountId: ME.accountId, name: ME.name };

  let r = await run(browser, BASE, { user: null, members: [] });
  check('未ログイン：ログインの案内が出る', r.dialogs.some((m) => m.includes('ログインしてください')), JSON.stringify(r.dialogs));
  check('未ログイン：削除は送らない', r.deletes.length === 0);

  r = await run(browser, BASE, { user: ME, members: [] });
  check('参加していない：参加の案内が出る', r.dialogs.some((m) => m.includes('「参加する」を押した人だけ')), JSON.stringify(r.dialogs));
  check('参加していない：削除は送らない', r.deletes.length === 0);

  r = await run(browser, BASE, { user: ME, members: [meMember, { accountId: '222222', name: 'ボブ' }] });
  check('ほかに参加者：消せない案内が出る', r.dialogs.some((m) => m.includes('ほかに1人')), JSON.stringify(r.dialogs));
  check('ほかに参加者：削除は送らない', r.deletes.length === 0);
  check('ほかに参加者：一覧には残る', r.myTrips.includes(TRIP.id));

  r = await run(browser, BASE, { user: ME, members: [meMember] });
  check('自分ひとり：確認が出る', r.dialogs.some((m) => m.includes('「テスト旅行」を削除しますか？') && m.includes('元に戻せません')), JSON.stringify(r.dialogs));
  check('自分ひとり：DELETEをログインのトークンつきで送る', r.deletes.length === 1 && r.deletes[0] === 'Bearer ' + ME.token, JSON.stringify(r.deletes));
  check('自分ひとり：一覧から消え、隠しリストにも残らない', !r.myTrips.includes(TRIP.id) && !r.hidden.includes(TRIP.id), JSON.stringify(r));

  await browser.close();
  server.close();
  console.log(`trip-delete: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
