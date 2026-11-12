/*
 * 旅行の画面を下に引っぱって最新にする（2026-11-12）を実ブラウザ（タッチ）で確かめる。
 * - ほかの人が足した予定が、開き直さずに同じ画面に出る（選んでいる日もそのまま）
 * - まだ送れていない自分の変更があるあいだは、サーバーの内容で上書きしない（書いたものが消えない）
 * - 送れるようになったら、送ってから最新にする
 * - 少しだけ引っぱって離したときは読み直さない
 * 実行: node test/pull-refresh.smoke.js   （要 playwright）
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

const TRIP = { id: 'trip_p1', title: '引っぱりテスト旅行', startDate: '2026-10-01', endDate: '2026-10-03', companions: [], coverPhotoId: '', tripType: '', settleUnit: 1 };
function block(id, date, label, sort) {
  return { id, tripId: TRIP.id, date, time: '', label, category: 'sightseeing', sortOrder: sort, entries: [] };
}

async function pull(page, cdp, dy) {
  const x = 210, y0 = 300;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + (dy * i) / 10 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function labels(page) {
  return page.$$eval('#timeline .block-label', (els) => els.map((e) => e.textContent));
}

(async () => {
  const { server, port } = await startServer();
  const BASE = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'ja-JP', hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.addInitScript((o) => {
    localStorage.setItem('tabilog.tutorialDone', '1');
    localStorage.setItem('tabilog.tutorialTripDone', '1');
    localStorage.setItem('tabilog:my-trips', JSON.stringify([{ id: o.trip.id, title: o.trip.title, startDate: o.trip.startDate, endDate: o.trip.endDate }]));
  }, { trip: TRIP });

  // サーバーの中身（テストの途中で「ほかの人が足した」状態に変える）
  const server1 = { blocks: [block('b1', '2026-10-01', '浅草寺', 1), block('b2', '2026-10-02', 'スカイツリー', 1)] };
  let tripGets = 0, patchMode = 'abort', patches = [];
  await page.route('**/', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace(/<meta name="tabilog-api-endpoint" content="[^"]*">/, '<meta name="tabilog-api-endpoint" content="/api">');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });
  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === '/api/trips/' + TRIP.id && req.method() === 'GET') {
      tripGets++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ trip: TRIP, blocks: server1.blocks, days: [], members: [] }) });
    }
    if (p.startsWith('/api/blocks/') && req.method() === 'PATCH') {
      if (patchMode === 'abort') return route.abort('internetdisconnected');
      const body = JSON.parse(req.postData() || '{}');
      patches.push(body);
      const id = p.split('/').pop();
      server1.blocks = server1.blocks.map((b) => (b.id === id ? Object.assign({}, b, body) : b));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(server1.blocks.find((b) => b.id === id)) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto(BASE);
  await page.click('text=' + TRIP.title);
  await page.waitForSelector('#timeline .block-label');
  const cdp = await ctx.newCDPSession(page);

  // 2日目を選んでおく
  await page.click('.day-tab:nth-child(2), [data-date="2026-10-02"]').catch(() => {});
  await page.waitForTimeout(200);
  const selectedBefore = await page.evaluate(() => (document.querySelector('.day-tab.active, .day-tab[aria-selected="true"], .day-tab.on') || {}).textContent || '');

  // 1) ほかの人が2日目に予定を足した → 引っぱると同じ画面に出る
  server1.blocks = server1.blocks.concat([block('b3', '2026-10-02', 'ほかの人の予定', 2)]);
  const g0 = tripGets;
  await page.evaluate(() => window.scrollTo(0, 0));
  await pull(page, cdp, 40); // 少しだけ（表示上20px）
  await page.waitForTimeout(400);
  check('少し引っぱっただけでは読み直さない', tripGets === g0, 'gets=' + (tripGets - g0));

  await pull(page, cdp, 220);
  await page.waitForTimeout(150);
  const shownWhileLoading = await page.evaluate(() => { const el = document.getElementById('pullRefresh'); return !!el && !el.hidden; });
  check('引っぱると「読み込み中」の表示が出る', shownWhileLoading);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await page.waitForTimeout(900);
  check('引っぱって離すと読み直す', tripGets === g0 + 1, 'gets=' + (tripGets - g0));
  let ls = await labels(page);
  check('ほかの人が足した予定が、開き直さずに出る', ls.includes('ほかの人の予定'), JSON.stringify(ls));
  check('旅行の画面のまま', await page.evaluate(() => document.querySelector('.screen.active').dataset.screen) === 'tripDetail');
  const selectedAfter = await page.evaluate(() => (document.querySelector('.day-tab.active, .day-tab[aria-selected="true"], .day-tab.on') || {}).textContent || '');
  check('選んでいた日はそのまま', selectedAfter === selectedBefore, selectedBefore + ' / ' + selectedAfter);
  check('「最新の内容にしました」が出る', (await page.textContent('#toast')).includes('最新の内容にしました'));

  // 2) 自分の書きかけ（送信待ち）があるときは上書きしない
  await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('tabilog-offline', 1);
    req.onsuccess = () => {
      const tx = req.result.transaction('kv', 'readwrite');
      tx.objectStore('kv').put([{ id: 'op-1', tripId: 'trip_p1', method: 'PATCH', path: '/blocks/b2', body: { label: '自分の書きかけ' }, createdAt: new Date().toISOString(), attempts: 0 }], 'queue');
      tx.oncomplete = resolve; tx.onerror = reject;
    };
    req.onerror = reject;
  }));
  await page.goto(BASE); // 読み込み直して、送信待ちを覚えから読む（URLに旅行が付くと上のrouteに当たらないので一覧から開く）
  await page.click('text=' + TRIP.title);
  await page.waitForSelector('#timeline .block-label');
  await page.click('[data-date="2026-10-02"]').catch(() => {});
  await page.waitForTimeout(300);
  ls = await labels(page);
  check('（準備）送信待ちの変更が画面に出ている', ls.includes('自分の書きかけ'), JSON.stringify(ls));
  server1.blocks = server1.blocks.concat([block('b4', '2026-10-02', 'さらにほかの人の予定', 3)]);
  const g1 = tripGets;
  await page.evaluate(() => window.scrollTo(0, 0));
  await pull(page, cdp, 220);
  await page.waitForTimeout(1200);
  ls = await labels(page);
  check('送れないうちは自分の書きかけが消えない', ls.includes('自分の書きかけ'), JSON.stringify(ls));
  check('送れないうちはサーバーの内容で読み直さない', tripGets === g1, 'gets=' + (tripGets - g1));
  check('まだ送れていない変更がある、と出る', (await page.textContent('#toast')).includes('まだ送れていない変更があります'));

  // 3) 送れるようになったら、送ってから最新にする
  patchMode = 'ok';
  await page.evaluate(() => window.scrollTo(0, 0));
  await pull(page, cdp, 220);
  await page.waitForTimeout(1500);
  ls = await labels(page);
  check('書きかけをサーバーへ送った', patches.length === 1 && patches[0].label === '自分の書きかけ', JSON.stringify(patches));
  check('送ったあと、自分の変更とほかの人の予定の両方が出る', ls.includes('自分の書きかけ') && ls.includes('さらにほかの人の予定'), JSON.stringify(ls));

  // 4) 電波が無いときは案内だけ
  await ctx.setOffline(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await pull(page, cdp, 220);
  await page.waitForTimeout(700);
  check('電波が無いときは案内が出る', (await page.textContent('#toast')).includes('電波が無いため更新できません'));
  ls = await labels(page);
  check('電波が無くても画面の中身はそのまま', ls.includes('さらにほかの人の予定'), JSON.stringify(ls));
  await ctx.setOffline(false);

  await browser.close();
  server.close();
  console.log(`pull-refresh: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
