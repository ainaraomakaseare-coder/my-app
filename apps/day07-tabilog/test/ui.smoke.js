/*
 * 実ブラウザでの画面の流れを確認する
 * （旅行作成→予定（大項目）追加→記録（小項目）追加→編集→別行動の記録追加→削除）。
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
  let tripSeq = 0, blockSeq = 0, entrySeq = 0, photoSeq = 0;
  const trips = {};
  const blocks = {};   // id -> block（entriesは持たず、entriesByBlockで別管理）
  const entriesByBlock = {};

  await page.route('**/', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace('<meta name="tabilog-api-endpoint" content="https://tabilog-api.hiroya-apps.workers.dev">', '<meta name="tabilog-api-endpoint" content="/api">');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });

  await page.route('**/api/trips', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const data = JSON.parse(req.postData());
      const id = 'trip_' + (++tripSeq);
      const t = { id, title: data.title, startDate: data.startDate || '', endDate: data.endDate || '', companions: data.companions || [], coverPhotoId: '', createdAt: 'now', updatedAt: 'now' };
      trips[id] = t;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(t) });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });

  await page.route(/\/api\/trips\/([^/]+)$/, async (route) => {
    const id = decodeURIComponent(route.request().url().match(/\/api\/trips\/([^/]+)$/)[1]);
    const t = trips[id];
    if (!t) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
    const tripBlocks = Object.values(blocks).filter((b) => b.tripId === id)
      .map((b) => ({ ...b, entries: entriesByBlock[b.id] || [] }));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ trip: t, blocks: tripBlocks }) });
  });

  await page.route(/\/api\/trips\/([^/]+)\/blocks$/, async (route) => {
    const req = route.request();
    const tripId = decodeURIComponent(req.url().match(/\/api\/trips\/([^/]+)\/blocks$/)[1]);
    const data = JSON.parse(req.postData());
    const id = 'blk_' + (++blockSeq);
    const b = Object.assign({ id, tripId, createdAt: 'now', updatedAt: 'now' }, data);
    blocks[id] = b;
    entriesByBlock[id] = [];
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ...b, entries: [] }) });
  });

  await page.route(/\/api\/blocks\/([^/]+)$/, async (route) => {
    const req = route.request();
    const id = decodeURIComponent(req.url().match(/\/api\/blocks\/([^/]+)$/)[1]);
    if (!blocks[id]) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
    if (req.method() === 'PATCH') {
      const data = JSON.parse(req.postData());
      blocks[id] = Object.assign({}, blocks[id], data);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(blocks[id]) });
    }
    if (req.method() === 'DELETE') {
      delete entriesByBlock[id];
      delete blocks[id];
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });

  await page.route(/\/api\/blocks\/([^/]+)\/entries$/, async (route) => {
    const req = route.request();
    const blockId = decodeURIComponent(req.url().match(/\/api\/blocks\/([^/]+)\/entries$/)[1]);
    const data = JSON.parse(req.postData());
    const id = 'ent_' + (++entrySeq);
    const e = Object.assign({ id, blockId, createdAt: 'now', updatedAt: 'now' }, data);
    entriesByBlock[blockId].push(e);
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(e) });
  });

  await page.route(/\/api\/entries\/([^/]+)$/, async (route) => {
    const req = route.request();
    const id = decodeURIComponent(req.url().match(/\/api\/entries\/([^/]+)$/)[1]);
    let found = null;
    for (const blockId in entriesByBlock) {
      const idx = entriesByBlock[blockId].findIndex((e) => e.id === id);
      if (idx !== -1) { found = { blockId, idx }; break; }
    }
    if (!found) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
    if (req.method() === 'PATCH') {
      const data = JSON.parse(req.postData());
      entriesByBlock[found.blockId][found.idx] = Object.assign({}, entriesByBlock[found.blockId][found.idx], data);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(entriesByBlock[found.blockId][found.idx]) });
    }
    if (req.method() === 'DELETE') {
      entriesByBlock[found.blockId].splice(found.idx, 1);
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
  check('日タブが2日ぶんできる (1泊2日)', (await page.$$('.day-tab')).length === 2);

  // ---- 予定（大項目）を追加 ----
  await page.click('.block-add');
  await page.waitForSelector('.screen[data-screen="blockForm"].active');
  await page.fill('#blkTime', '15:00');
  await page.fill('#blkLabel', '首里城公園に到着');
  await page.click('.cat-chip[data-cat="sightseeing"]');
  await page.click('#btnSaveBlock');
  // 予定を保存すると、続けて最初の記録（小項目）フォームが開く
  await page.waitForSelector('.screen[data-screen="entryForm"].active');
  check('記録追加フォームのタイトルになる', (await page.textContent('#entFormTitle')) === '記録を追加');

  await page.fill('#entEpisode', '守礼門の前で写真。暑いけど景色は最高。');
  await page.fill('#entComment', '最高だった');
  await page.fill('#entDetail', '朝早く行くと空いていて写真が撮りやすい。');
  await page.click('#btnAddCostItem');
  const rows = page.locator('.cost-item-row');
  await rows.nth(0).locator('input[type="text"]').fill('入場料');
  await rows.nth(0).locator('input[type="number"]').fill('600');
  await page.fill('#entAuthor', '父');
  const tmpPhoto = path.join(require('os').tmpdir(), 'tabilog-test.png');
  fs.writeFileSync(tmpPhoto, TINY_PNG);
  await page.setInputFiles('#entPhoto', tmpPhoto);
  await page.waitForSelector('.photo-preview .ph img');
  const tmpVideo = path.join(require('os').tmpdir(), 'tabilog-test.mp4');
  fs.writeFileSync(tmpVideo, Buffer.from('fake video bytes'));
  await page.setInputFiles('#entVideo', tmpVideo);
  await page.waitForSelector('.video-chip');
  check('動画のプレビューにファイル名が出る', (await page.textContent('.video-chip .name')) === 'tabilog-test.mp4');
  await page.click('#btnSaveEntry');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');

  check('大項目が1件表示される', (await page.$$('.block')).length === 1);
  check('見出しが表示される', (await page.textContent('.block-label')) === '首里城公園に到着');
  check('小項目（記録）が1件表示される', (await page.$$('.entry-card')).length === 1);
  check('エピソードが表示される', (await page.textContent('.entry-episode')) === '守礼門の前で写真。暑いけど景色は最高。');
  check('詳細が表示される', (await page.textContent('.entry-detail')) === '朝早く行くと空いていて写真が撮りやすい。');
  check('動画が表示される', (await page.$$('.entry-videos video')).length === 1);
  check('費用の合計が表示される', (await page.textContent('.cost-line.total')).includes('¥600'));

  // ---- 別行動：同じ大項目にもう1つ記録を追加 ----
  await page.click('.entry-add');
  await page.waitForSelector('.screen[data-screen="entryForm"].active');
  await page.fill('#entEpisode', '近くのカフェでひと休み。かき氷が美味しかった。');
  await page.fill('#entAuthor', 'わたし');
  await page.click('#btnAddCostItem');
  const rows2 = page.locator('.cost-item-row');
  await rows2.nth(0).locator('input[type="text"]').fill('かき氷');
  await rows2.nth(0).locator('input[type="number"]').fill('900');
  await page.click('#btnSaveEntry');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  check('別行動の記録が2件になる', (await page.$$('.entry-card')).length === 2);

  // ---- 編集 ----
  await page.click('.entry-card >> nth=0 >> .entry-author');
  await page.waitForSelector('.screen[data-screen="entryForm"].active');
  check('編集画面のタイトルになる', (await page.textContent('#entFormTitle')) === '記録を編集');
  check('削除ボタンが出る', await page.isVisible('#btnDeleteEntry'));
  await page.fill('#entComment', '書き直した一言');
  await page.click('#btnSaveEntry');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  check('編集した一言が反映される', (await page.textContent('.entry-card >> nth=0 >> .entry-comment')).includes('書き直した一言'));

  // ---- 削除 ----
  await page.click('.entry-card >> nth=0 >> .entry-author');
  await page.waitForSelector('.screen[data-screen="entryForm"].active');
  await page.click('#btnDeleteEntry');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  check('削除後は1件になる', (await page.$$('.entry-card')).length === 1);

  check('ページ内エラーが発生していない', errors.length === 0, errors.join(' / '));

  await browser.close();
  server.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
