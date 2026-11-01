/*
 * 旅行の「共有」で作るリンクに、紹介カード（サムネ）の中身から作った &v=… が付くことを実ブラウザで確かめる。
 * LINEは一度読んだURLのサムネを覚えているため、カバー写真などを変えたらURLも変わる必要がある（2026-11-01）。
 * 実行: node test/share-link-version.smoke.js   （要 playwright）
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

const TRIP = { id: 'trip_s1', title: 'テスト旅行', startDate: '2026-10-01', endDate: '2026-10-02', companions: [], coverPhotoId: '', tripType: '', settleUnit: 1 };

// 旅行を開いて「共有」を押し、共有シートに渡された本文のURLを返す
async function shareUrl(browser, BASE, trip, openPath) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 1200 }, locale: 'ja-JP' });
  const page = await ctx.newPage();
  await page.addInitScript((t) => {
    localStorage.setItem('tabilog.tutorialDone', '1');
    localStorage.setItem('tabilog.tutorialTripDone', '1');
    localStorage.setItem('tabilog:my-trips', JSON.stringify([{ id: t.id, title: t.title, startDate: t.startDate, endDate: t.endDate }]));
    window.__shared = [];
    navigator.share = function (d) { window.__shared.push(d); return Promise.resolve(); };
  }, trip);
  await page.route(/127\.0\.0\.1:\d+\/(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace(/<meta name="tabilog-api-endpoint" content="[^"]*">/, '<meta name="tabilog-api-endpoint" content="/api">');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });
  await page.route(/\/api\//, async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/trips/' + trip.id) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ trip, blocks: [], days: [], members: [] }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(BASE + (openPath || ''));
  if (!openPath) await page.click('text=' + trip.title);
  await page.waitForSelector('#btnInvite', { state: 'visible', timeout: 10000 });
  await page.click('#btnInvite');
  await page.waitForTimeout(300);
  const shared = await page.evaluate(() => window.__shared);
  await ctx.close();
  const text = (shared[0] && shared[0].text) || '';
  const m = /https?:\/\/\S+/.exec(text);
  return m ? m[0] : '';
}

(async () => {
  const { server, port } = await startServer();
  const BASE = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();

  const u1 = await shareUrl(browser, BASE, TRIP);
  check('共有URLに旅行IDと&v=が付く', /\?trip=trip_s1&v=[0-9a-z]+$/.test(u1), u1);
  const u1b = await shareUrl(browser, BASE, TRIP);
  check('中身が同じならURLも同じ', u1 === u1b, u1 + ' / ' + u1b);
  const u2 = await shareUrl(browser, BASE, { ...TRIP, coverPhotoId: 'photo_cover.jpg' });
  check('カバー写真を設定するとURLが変わる（LINEが新しいサムネを読む）', u2 && u2 !== u1, u1 + ' / ' + u2);
  const u3 = await shareUrl(browser, BASE, TRIP, '?trip=trip_s1&v=old');
  check('古い&v=付きのリンクから開いても旅行が開き、共有すると今のURLになる', u3 === u1, u3);

  await browser.close();
  server.close();
  console.log(`share-link-version: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
