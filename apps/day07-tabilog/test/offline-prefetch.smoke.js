/*
 * 一覧の旅行を、電波があるうちに端末へ保存しておく（2026-11-12）を実ブラウザで確かめる。
 * - ホームを出すと、まだ開いていない旅行も裏で読んで覚える → 電波が無くてもその旅行を開ける
 * - 少し前に保存した旅行は、ホームに戻るたびに読み直さない
 * - 履歴から消した旅行は保存しない
 * 実行: node test/offline-prefetch.smoke.js   （要 playwright）
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

function trip(id, title) {
  return { id, title, startDate: '2026-10-01', endDate: '2026-10-02', companions: [], coverPhotoId: '', tripType: '', settleUnit: 1 };
}
const TRIPS = { t1: trip('t1', '北海道の旅'), t2: trip('t2', '沖縄の旅'), t3: trip('t3', '消した旅') };
const LABELS = { t1: '札幌時計台', t2: '首里城', t3: '消した予定' };

(async () => {
  const { server, port } = await startServer();
  const BASE = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ja-JP' });
  const page = await ctx.newPage();
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.addInitScript(() => {
    localStorage.setItem('tabilog.tutorialDone', '1');
    localStorage.setItem('tabilog.tutorialTripDone', '1');
    if (!localStorage.getItem('tabilog:my-trips')) {
      localStorage.setItem('tabilog:my-trips', JSON.stringify([
        { id: 't1', title: '北海道の旅', startDate: '2026-10-01', endDate: '2026-10-02' },
        { id: 't2', title: '沖縄の旅', startDate: '2026-10-01', endDate: '2026-10-02' }
      ]));
      localStorage.setItem('tabilog:hidden-trips', JSON.stringify(['t3']));
    }
  });
  let offline = false;
  const gets = {};
  await page.route('**/', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace(/<meta name="tabilog-api-endpoint" content="[^"]*">/, '<meta name="tabilog-api-endpoint" content="/api">');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });
  await page.route(/\/api\//, async (route) => {
    if (offline) return route.abort('internetdisconnected');
    const p = new URL(route.request().url()).pathname;
    const m = /^\/api\/trips\/([^/]+)$/.exec(p);
    if (m && TRIPS[m[1]]) {
      gets[m[1]] = (gets[m[1]] || 0) + 1;
      const id = m[1];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        trip: TRIPS[id], days: [], members: [],
        blocks: [{ id: 'b_' + id, tripId: id, date: '2026-10-01', time: '', label: LABELS[id], category: 'sightseeing', sortOrder: 1, entries: [] }]
      }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto(BASE);
  await page.waitForTimeout(3500); // ホームを出して少し待つと、裏で保存する
  check('一覧の旅行を開かなくても読んでおく', gets.t1 === 1 && gets.t2 === 1, JSON.stringify(gets));
  check('履歴から消した旅行は読まない', !gets.t3, JSON.stringify(gets));

  // ホームに戻っても、少し前に保存した旅行は読み直さない
  await page.click('text=北海道の旅');
  await page.waitForSelector('#timeline .block-label');
  await page.click('[data-screen="tripDetail"] .back-btn');
  await page.waitForTimeout(3500);
  check('少し前に保存した旅行は読み直さない', gets.t2 === 1, JSON.stringify(gets));

  // 電波を切って、一度も開いていない旅行を開く
  offline = true;
  await ctx.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.click('text=沖縄の旅');
  await page.waitForTimeout(1200);
  const screen = await page.evaluate(() => document.querySelector('.screen.active').dataset.screen);
  const labels = await page.$$eval('#timeline .block-label', (els) => els.map((e) => e.textContent));
  check('電波が無くても、開いたことのない旅行が開ける', screen === 'tripDetail' && labels.includes('首里城'), screen + ' ' + JSON.stringify(labels) + ' ' + JSON.stringify(dialogs));
  check('オフラインで前回の内容を出していると分かる', (await page.textContent('#syncPill')).includes('オフラインです'));
  check('「開けませんでした」は出ない', !dialogs.some((d) => d.includes('開けませんでした')), JSON.stringify(dialogs));

  await browser.close();
  server.close();
  console.log(`offline-prefetch: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
