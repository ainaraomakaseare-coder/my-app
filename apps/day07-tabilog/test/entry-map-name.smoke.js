/*
 * 記録の「地図」リンクが、場所の名前が分かるときは「📍 名前」になり、分からないときは「地図」のままかを
 * 実ブラウザで確かめる（どちらもリンク先は記録の地図URLのまま）。
 * 実行: node test/entry-map-name.smoke.js   （要 playwright。SHOT=ファイル名 でスクショも撮る）
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

const TRIP = { id: 'trip_m1', title: '京都旅行', startDate: '2026-10-01', endDate: '2026-10-01', companions: [], coverPhotoId: '', tripType: '', settleUnit: 1 };
const URL_SAVED = 'https://maps.google.com/?q=34.99485,135.78504';
const URL_QUERY = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('伏見稲荷大社');
const URL_SHORT = 'https://maps.app.goo.gl/abcd1234';
const entry = (id, episode, mapUrl, mapPlaceName) => ({ id, blockId: 'b_' + id, episode, mapUrl, mapPlaceName, author: 'ひろや', photoIds: [], videoIds: [], costItems: [], ratings: [] });
const BLOCKS = [
  { id: 'b_e1', tripId: TRIP.id, date: '2026-10-01', time: '09:00', label: '清水寺', category: 'sightseeing', entries: [entry('e1', '朝の清水の舞台', URL_SAVED, '清水寺')] },
  { id: 'b_e2', tripId: TRIP.id, date: '2026-10-01', time: '11:00', label: '伏見稲荷', category: 'sightseeing', entries: [entry('e2', '千本鳥居を歩いた', URL_QUERY, '')] },
  { id: 'b_e3', tripId: TRIP.id, date: '2026-10-01', time: '13:00', label: 'お昼ごはん', category: 'food', entries: [entry('e3', '友だちが送ってくれたお店', URL_SHORT, '')] }
];

(async () => {
  const { server, port } = await startServer();
  const BASE = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1400 }, locale: 'ja-JP', deviceScaleFactor: process.env.SHOT ? 2 : 1 });
  const page = await ctx.newPage();
  await page.addInitScript((o) => {
    localStorage.setItem('tabilog.tutorialDone', '1');
    localStorage.setItem('tabilog.tutorialTripDone', '1');
    localStorage.setItem('tabilog:my-trips', JSON.stringify([{ id: o.id, title: o.title, startDate: o.startDate, endDate: o.endDate }]));
  }, TRIP);
  await page.route('**/', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace(/<meta name="tabilog-api-endpoint" content="[^"]*">/, '<meta name="tabilog-api-endpoint" content="/api">');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });
  await page.route(/tile\.openstreetmap|maps\.google|googleapis/, (route) => route.abort());
  await page.route(/\/api\//, async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/trips/' + TRIP.id) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ trip: TRIP, blocks: BLOCKS, days: [], members: [] }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(BASE);
  await page.click('text=' + TRIP.title);
  await page.waitForSelector('.entry-meta a', { state: 'visible' });
  const links = await page.$$eval('.entry-meta a', (as) => as.map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') })));
  check('保存された名前：「📍 清水寺」で、リンク先は地図URL', links.some((l) => l.text === '📍清水寺' && l.href === URL_SAVED), JSON.stringify(links));
  check('検索URLの名前：「📍 伏見稲荷大社」', links.some((l) => l.text === '📍伏見稲荷大社' && l.href === URL_QUERY), JSON.stringify(links));
  check('名前が分からない短縮URL：「地図」のまま', links.some((l) => l.text === '地図' && l.href === URL_SHORT), JSON.stringify(links));
  if (process.env.SHOT) {
    const tl = page.locator('#timeline');
    await tl.scrollIntoViewIfNeeded();
    await tl.screenshot({ path: process.env.SHOT });
  }
  await browser.close();
  server.close();
  console.log(`entry-map-name: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
