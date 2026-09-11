/*
 * 実ブラウザでの画面の流れを確認する（旅行作成→詳細を開く→エピソード追加→編集→削除）。
 * このアプリは保存先がサーバー（Worker）のため、実際のAPIは呼ばず、
 * page.route でフェイクのAPIをその場で用意して検証する。
 * 実行: node test/ui.smoke.js   （要 playwright）
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

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

(async () => {
  const { server, port } = await startServer();
  const BASE = `http://127.0.0.1:${port}/`;
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());

  // ---- フェイクAPI（メモリ上のミニDB） ----
  let tripSeq = 0, epSeq = 0, photoSeq = 0;
  const trips = {};
  const episodes = {};

  // index.htmlの tabilog-api-endpoint を "/api" に書き換えて、同じオリジンの相対パスで
  // フェイクAPIへ向かわせる（実物のWorkerには一切依存しない）。
  await page.route('**/', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace('<meta name="tabilog-api-endpoint" content="">', '<meta name="tabilog-api-endpoint" content="/api">');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });

  await page.route('**/api/trips', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const data = JSON.parse(req.postData());
      const id = 'trip_' + (++tripSeq);
      const t = { id, title: data.title, startDate: data.startDate || '', endDate: data.endDate || '', companions: data.companions || [], coverPhotoId: '', createdAt: 'now', updatedAt: 'now' };
      trips[id] = t;
      episodes[id] = [];
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(t) });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });

  await page.route(/\/api\/trips\/([^/]+)$/, async (route) => {
    const id = decodeURIComponent(route.request().url().match(/\/api\/trips\/([^/]+)$/)[1]);
    const t = trips[id];
    if (!t) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ trip: t, episodes: episodes[id] }) });
  });

  await page.route(/\/api\/trips\/([^/]+)\/episodes$/, async (route) => {
    const req = route.request();
    const tripId = decodeURIComponent(req.url().match(/\/api\/trips\/([^/]+)\/episodes$/)[1]);
    const data = JSON.parse(req.postData());
    const id = 'ep_' + (++epSeq);
    const ep = Object.assign({ id, tripId, createdAt: 'now', updatedAt: 'now' }, data);
    episodes[tripId].push(ep);
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(ep) });
  });

  await page.route(/\/api\/episodes\/([^/]+)$/, async (route) => {
    const req = route.request();
    const id = decodeURIComponent(req.url().match(/\/api\/episodes\/([^/]+)$/)[1]);
    let found = null;
    for (const tripId in episodes) {
      const idx = episodes[tripId].findIndex((e) => e.id === id);
      if (idx !== -1) { found = { tripId, idx }; break; }
    }
    if (!found) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
    if (req.method() === 'PATCH') {
      const data = JSON.parse(req.postData());
      episodes[found.tripId][found.idx] = Object.assign({}, episodes[found.tripId][found.idx], data);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(episodes[found.tripId][found.idx]) });
    }
    if (req.method() === 'DELETE') {
      episodes[found.tripId].splice(found.idx, 1);
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });

  await page.route('**/api/photos', async (route) => {
    const id = 'photo_' + (++photoSeq) + '.jpg';
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id, url: '/api/photos/' + id }) });
  });
  await page.route(/\/api\/photos\/.+$/, async (route) => {
    return route.fulfill({ status: 200, contentType: 'image/png', body: TINY_PNG });
  });

  await page.goto(BASE);

  // ---- 新しい旅を作る ----
  await page.click('#btnNewTrip');
  await page.fill('#ntTitle', '沖縄 家族旅行');
  await page.fill('#ntStart', '2024-08-10');
  await page.fill('#ntEnd', '2024-08-11');
  await page.fill('#ntCompanions', '父、母、妹');
  await page.click('#btnCreateTrip');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  check('旅行タイトルが表示される', (await page.textContent('#tripTitle')) === '沖縄 家族旅行');
  check('参加者が表示される', (await page.textContent('#tripCompanions')) === '父・母・妹 と一緒');
  check('日タブが2日ぶんできる (1泊2日)', (await page.$$('.day-tab')).length === 2);

  // ---- エピソードを追加（写真つき） ----
  await page.click('.tl-add');
  await page.waitForSelector('.screen[data-screen="episodeForm"].active');
  await page.fill('#epPlace', '首里城公園');
  await page.fill('#epTime', '15:00');
  await page.fill('#epNote', '世界遺産で家族写真。');
  await page.fill('#epCost', '1200');
  await page.click('.cat-chip[data-cat="sightseeing"]');
  await page.click('#epRatingPicker button:nth-child(4)');
  const tmpPhoto = path.join(require('os').tmpdir(), 'tabilog-test.png');
  fs.writeFileSync(tmpPhoto, TINY_PNG);
  await page.setInputFiles('#epPhoto', tmpPhoto);
  await page.waitForSelector('.photo-preview .ph img');
  await page.click('#btnSaveEpisode');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');

  check('タイムラインに1件追加される', (await page.$$('.tl-item')).length === 1);
  check('場所名が表示される', (await page.textContent('.tl-title')) === '首里城公園');
  check('費用が¥1,200と表示される', (await page.textContent('.tl-price')) === '¥1,200');
  check('写真がタイムラインに表示される', (await page.$('.tl-photo img, .tl-photo[style*="background-image"]')) !== null || (await page.$eval('.tl-photo', (el) => el.style.backgroundImage)).length > 0);

  // ---- 編集して評価を変える ----
  await page.click('.tl-card');
  await page.waitForSelector('.screen[data-screen="episodeForm"].active');
  check('編集画面のタイトルになる', (await page.textContent('#epFormTitle')) === 'この記録を編集');
  check('削除ボタンが出る', await page.isVisible('#btnDeleteEpisode'));
  await page.click('#epRatingPicker button:nth-child(5)');
  await page.click('#btnSaveEpisode');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  check('星の数が5つぶん表示される', (await page.$$('.tl-stars svg')).length === 5);

  // ---- 別行動タグでの絞り込み ----
  await page.click('.tl-add');
  await page.waitForSelector('.screen[data-screen="episodeForm"].active');
  await page.fill('#epPlace', '寿司屋');
  await page.fill('#epGroupTag', '父・妹チーム');
  await page.click('#btnSaveEpisode');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  check('別行動チームのチップが出る', (await page.textContent('#groupFilter')).includes('父・妹チーム'));
  await page.click('.gf-chip:has-text("父・妹チーム")');
  check('絞り込むとそのチームの記録だけになる', (await page.$$('.tl-item')).length === 1);
  await page.click('.gf-chip:has-text("全員")');
  check('全員に戻すと両方見える', (await page.$$('.tl-item')).length === 2);

  // ---- 削除 ----
  await page.click('.tl-item >> nth=0');
  await page.waitForSelector('.screen[data-screen="episodeForm"].active');
  await page.click('#btnDeleteEpisode');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  check('削除後は1件になる', (await page.$$('.tl-item')).length === 1);

  check('ページ内エラーが発生していない', errors.length === 0, errors.join(' / '));

  await browser.close();
  server.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
