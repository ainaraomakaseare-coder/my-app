/*
 * 飛行機の記録で、所要時間が出発地・到着地の時差を考えて出ることを確かめる（2026-11-12）。
 * シンガポール17:35発→羽田翌1:00着（旅の最後の便で、次の予定が無い）が、時差を見ずに
 * 「7時間25分」と出ていた（正しくは6時間25分）。
 * 実行: node test/flight-timezone.smoke.js   （要 playwright）
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

const HOTEL = { id: 'blk_hotel', tripId: 'trip_1', date: '2026-11-12', time: '10:00', label: 'ホテルをチェックアウト', category: 'lodging', transport: '', createdAt: '1',
  entries: [{ id: 'ent_hotel', blockId: 'blk_hotel', author: 'テスト太郎', comment: '', mapUrl: 'https://www.google.com/maps/search/?api=1&query=1.2834,103.8607', mapLat: 1.2834, mapLng: 103.8607, photoIds: [], ratings: [], costItems: [] }] };
function flight(travel) {
  return { id: 'blk_fl', tripId: 'trip_1', date: '2026-11-12', time: '17:35', label: 'シンガポール→羽田 TR804', category: 'transport', transport: 'plane', createdAt: '2',
    entries: [{ id: 'ent_fl', blockId: 'blk_fl', author: 'テスト太郎', comment: '', mapUrl: '', photoIds: [], ratings: [], costItems: [], travel }] };
}

async function openTrip(browser, BASE, blocks) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
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
  const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(/\/api\//, (route) => json(route, {}));
  await page.route(/\/api\/accounts\/ensure$/, (route) => json(route, { accountId: TEST_USER.accountId, email: TEST_USER.email, name: TEST_USER.name, memoRemainingThisPeriod: 5, voiceRemainingThisPeriod: 5, ticketCredits: 0 }));
  await page.route(/\/api\/timezone/, (route) => {
    const lng = Number(new URL(route.request().url()).searchParams.get('lng'));
    json(route, { timezone: lng > 120 ? 'Asia/Tokyo' : 'Asia/Singapore' });
  });
  await page.route((u) => u.pathname === '/', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace(/<meta name="tabilog-api-endpoint" content="[^"]*">/, '<meta name="tabilog-api-endpoint" content="/api">');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });
  await page.route(/\/api\/trips\/trip_1$/, (route) => json(route, {
    trip: { id: 'trip_1', title: 'シンガポール', startDate: '2026-11-09', endDate: '2026-11-12', companions: [] }, blocks, days: [], members: []
  }));
  await page.goto(BASE + '?trip=trip_1');
  return { page, ctx, errors };
}

// 旅の最後の日（4日目）を開く
async function openLastDay(page) {
  await page.waitForSelector('text=4日目');
  await page.click('text=4日目');
  await page.waitForSelector('[data-entry-id="ent_fl"]');
}

async function durationOf(page) {
  await page.click('.entry-card[data-entry-id="ent_fl"], [data-entry-id="ent_fl"]');
  await page.waitForSelector('.screen[data-screen="entryForm"].active');
  await page.waitForFunction(() => /所要時間/.test(document.querySelector('#entTravelDuration').textContent), null, { timeout: 5000 }).catch(() => {});
  return page.textContent('#entTravelDuration');
}

(async () => {
  const { server, port } = await startServer();
  const BASE = `http://127.0.0.1:${port}/`;
  const browser = await launch();

  // 1) 到着地・出発地が空港の名前（地図なし）で、旅の最後の便
  let s = await openTrip(browser, BASE, [HOTEL, flight({ from: 'シンガポール・チャンギ空港', to: '羽田空港 (HND)', company: 'Scoot TR804', depart: '17:35', arrive: '01:00' })]);
  await openLastDay(s.page);
  let text = await durationOf(s.page);
  check('空港の名前から時差を考えて6時間25分', /6時間25分/.test(text), text);
  check('時差+1時間と、到着は翌日が出る', /時差\+1時間/.test(text) && /翌日/.test(text), text);
  // 到着地の欄を時差の無い空港に書き換えると出し直す
  // （「移動の情報」は折りたたまれているので、欄に直接入れる）
  await s.page.evaluate(() => { const el = document.querySelector('#entTravelTo'); el.value = 'チャンギ空港'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  text = await s.page.textContent('#entTravelDuration');
  check('到着地を書き換えると所要時間を出し直す', /7時間25分/.test(text) && !/時差/.test(text), text);
  check('ページでエラーが出ていない（空港の名前）', s.errors.length === 0, s.errors.join(' / '));
  await s.ctx.close();

  // 2) 空港の名前は無く、到着地の地図（座標）だけ
  s = await openTrip(browser, BASE, [HOTEL, flight({ from: '', to: '', depart: '17:35', arrive: '01:00',
    arriveMapUrl: 'https://www.google.com/maps/search/?api=1&query=35.5494,139.7798', arriveLat: 35.5494, arriveLng: 139.7798 })]);
  await openLastDay(s.page);
  // 裏で時差を調べ終わるまで待つ
  await s.page.waitForFunction(() => { try { return Object.keys(JSON.parse(localStorage.getItem('tabilog:tz-cache') || '{}')).length >= 2; } catch (e) { return false; } }, null, { timeout: 15000 }).catch(() => {});
  await s.page.waitForTimeout(500);
  text = await durationOf(s.page);
  check('到着地の地図の時差を使って6時間25分（次の予定が無くても）', /6時間25分/.test(text), text);
  check('ページでエラーが出ていない（到着地の地図）', s.errors.length === 0, s.errors.join(' / '));
  await s.ctx.close();

  console.log(`flight-timezone.smoke: ${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
