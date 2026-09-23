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
  const ctx = await browser.newContext({ viewport: { width: 420, height: 2400 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let nextPromptAnswer = null;
  page.on('dialog', (d) => {
    if (d.type() === 'prompt' && nextPromptAnswer !== null) {
      const answer = nextPromptAnswer;
      nextPromptAnswer = null;
      d.accept(answer);
    } else {
      d.accept();
    }
  });

  // ---- フェイクAPI（メモリ上のミニDB） ----
  let tripSeq = 0, blockSeq = 0, entrySeq = 0, photoSeq = 0;
  const trips = {};
  const blocks = {};   // id -> block（entriesは持たず、entriesByBlockで別管理）
  const entriesByBlock = {};
  const dayInfosByTrip = {}; // tripId -> { date: {date, place, weatherCode, tempMax, tempMin, isForecast} }

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
      const t = { id, title: data.title, startDate: data.startDate || '', endDate: data.endDate || '', companions: data.companions || [], coverPhotoId: data.coverPhotoId || '', createdAt: 'now', updatedAt: 'now' };
      trips[id] = t;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(t) });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });

  await page.route(/\/api\/trips\/([^/]+)$/, async (route) => {
    const req = route.request();
    const id = decodeURIComponent(req.url().match(/\/api\/trips\/([^/]+)$/)[1]);
    const t = trips[id];
    if (!t) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
    if (req.method() === 'PATCH') {
      const data = JSON.parse(req.postData());
      trips[id] = Object.assign({}, t, data);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(trips[id]) });
    }
    const tripBlocks = Object.values(blocks).filter((b) => b.tripId === id)
      .map((b) => ({ ...b, entries: entriesByBlock[b.id] || [] }));
    const days = Object.values(dayInfosByTrip[id] || {});
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ trip: t, blocks: tripBlocks, days }) });
  });

  await page.route(/\/api\/trips\/([^/]+)\/days\/([^/]+)$/, async (route) => {
    const req = route.request();
    const m = req.url().match(/\/api\/trips\/([^/]+)\/days\/([^/]+)$/);
    const tripId = decodeURIComponent(m[1]);
    const date = decodeURIComponent(m[2]);
    dayInfosByTrip[tripId] = dayInfosByTrip[tripId] || {};
    if (req.method() === 'PUT') {
      const data = JSON.parse(req.postData());
      // 実際のOpen-Meteoは呼ばず、フェイクの天気を返す
      const info = { date, place: data.place, weatherCode: 1, tempMax: 30, tempMin: 25, isForecast: false };
      dayInfosByTrip[tripId][date] = info;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(info) });
    }
    if (req.method() === 'DELETE') {
      delete dayInfosByTrip[tripId][date];
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    return route.fulfill({ status: 404, body: '{}' });
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

  await page.route(/\/api\/trips\/([^/]+)\/days\/([^/]+)\/blocks\/reorder$/, async (route) => {
    const data = JSON.parse(route.request().postData());
    let seq = 0;
    (data.blockIds || []).forEach((id) => {
      if (blocks[id]) blocks[id].createdAt = 'order_' + String(seq++).padStart(3, '0');
    });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
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

  // ---- 新しい旅を作る（サムネイル画像つき） ----
  const tmpCoverPhoto = path.join(require('os').tmpdir(), 'tabilog-test-cover.png');
  fs.writeFileSync(tmpCoverPhoto, TINY_PNG);
  await page.click('#btnNewTrip');
  await page.fill('#ntTitle', '沖縄 家族旅行');
  await page.fill('#ntStart', '2024-08-10');
  await page.fill('#ntEnd', '2024-08-11');
  await page.fill('#ntCompanions', '父、母、妹');
  await page.setInputFiles('#ntCoverPhoto', tmpCoverPhoto);
  await page.waitForSelector('#ntCoverPhotoPreview .ph img');
  check('新規作成フォームでサムネイル画像のプレビューが出る', true);
  await page.click('#btnCreateTrip');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  check('旅行タイトルが表示される', (await page.textContent('#tripTitle')) === '沖縄 家族旅行');
  check('日タブが2日ぶんできる (1泊2日)', (await page.$$('.day-tab')).length === 2);
  check('旅行詳細画面にサムネイル画像が表示される', !(await page.isHidden('#tripCoverPhoto')));

  await page.click('.screen.active [data-back="home"]');
  await page.waitForSelector('.screen[data-screen="home"].active');
  check('ホーム画面の旅行カードにもサムネイル画像が出る（写真を大きく見せるカード）', (await page.$$('.trip-card-photo')).length === 1);
  await page.click('.trip-card');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');

  // ---- 旅行のタイトル・日程・参加者・サムネイル画像を編集する ----
  await page.click('#btnEditTrip');
  await page.waitForSelector('.screen[data-screen="tripEditForm"].active');
  check('編集フォームに今のタイトルが入っている', (await page.inputValue('#teTitle')) === '沖縄 家族旅行');
  check('編集フォームに今の参加者が入っている', (await page.inputValue('#teCompanions')) === '父、母、妹');
  check('編集フォームに今のサムネイル画像のプレビューが出る', (await page.$$('#teCoverPhotoPreview .ph img')).length === 1);
  await page.fill('#teTitle', '沖縄 家族旅行（3泊に延長）');
  await page.fill('#teEnd', '2024-08-13');
  await page.fill('#teCompanions', '父、母、妹、祖母');
  await page.click('#teCoverPhotoPreview .ph button');
  check('編集フォームでサムネイル画像を削除できる', (await page.$$('#teCoverPhotoPreview .ph')).length === 0);
  await page.click('#btnSaveTripEdit');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  check('編集したタイトルが反映される', (await page.textContent('#tripTitle')) === '沖縄 家族旅行（3泊に延長）');
  check('編集した参加者が反映される', (await page.textContent('#tripCompanions')).includes('祖母'));
  check('日程を延ばすと日タブが増える', (await page.$$('.day-tab')).length === 4);
  check('サムネイル画像を削除すると旅行詳細から消える', await page.isHidden('#tripCoverPhoto'));

  // ---- 日ごとの場所・天気 ----
  check('場所未設定のときは「場所を設定」ボタンが出る', (await page.textContent('#dayWeather')).includes('場所を設定'));
  nextPromptAnswer = '那覇市';
  await page.click('#dayWeather');
  await page.waitForFunction(() => {
    const el = document.querySelector('#dayWeather');
    return el && el.classList.contains('has-weather');
  });
  check('場所を設定すると天気・気温が表示される', (await page.textContent('#dayWeather')).includes('那覇市') && (await page.textContent('#dayWeather')).includes('℃'));

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

  // ---- 立て替え（払った人・割る人を選ぶ割り勘機能） ----
  await page.click('#btnAddCostItem');
  await rows.nth(1).locator('input[type="text"]').fill('駐車場代');
  await rows.nth(1).locator('input[type="number"]').fill('3000');
  await rows.nth(1).locator('.cost-payer-toggle').click();
  const payerPanel = page.locator('.cost-payer-row');
  await payerPanel.locator('[data-role="payer"] .chip-option:has-text("父")').click();
  await payerPanel.locator('.cost-split-even').click();
  check('参加者全員で均等割りを押すと全員の割る人チップがonになる', (await payerPanel.locator('[data-role="split"] .chip-option.on').count()) === 4);
  check('立て替えボタンに払った人の名前が反映される', (await rows.nth(1).locator('.cost-payer-toggle').textContent()) === '父が立替');
  await rows.nth(1).locator('[aria-label="削除"]').click();
  check('削除すると費用の行が1件に戻る', (await page.locator('.cost-item-row').count()) === 1);

  await page.fill('#entAuthor', '父');
  const tmpPhoto = path.join(require('os').tmpdir(), 'tabilog-test.png');
  fs.writeFileSync(tmpPhoto, TINY_PNG);
  await page.setInputFiles('#entPhoto', tmpPhoto);
  await page.waitForSelector('#entPhotoPreview .ph img');

  // ---- アップロード前の写真を90度回す ----
  const srcBeforeRotate = await page.getAttribute('#entPhotoPreview .ph img', 'src');
  await page.click('#entPhotoPreview .ph-rotate');
  await page.waitForFunction((prev) => {
    const img = document.querySelector('#entPhotoPreview .ph img');
    return img && img.getAttribute('src') !== prev;
  }, srcBeforeRotate);
  check('アップロード前の写真を回すと、プレビュー画像が更新される', true);

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
  check('詳細は一覧のカードには出さない（記録を開いたときだけ見える）', (await page.$$('.entry-detail')).length === 0);
  check('動画が表示される', (await page.$$('.entry-videos video')).length === 1);
  check('費用の合計が表示される', (await page.textContent('.cost-line.total')).includes('¥600'));

  // ---- 写真をタップすると拡大表示になる（編集画面には行かない） ----
  await page.click('.entry-photo');
  check('写真をタップすると拡大表示（ライトボックス）が開く', !(await page.isHidden('#photoLightbox')));
  check('拡大表示のままentryFormには行かない', await page.isVisible('.screen[data-screen="tripDetail"].active'));
  await page.click('#btnCloseLightbox');
  check('閉じるボタンで拡大表示が閉じる', await page.isHidden('#photoLightbox'));

  // ---- 保存済みの写真も90度回せる ----
  await page.click('.entry-card >> nth=0 >> .entry-author');
  await page.waitForSelector('.screen[data-screen="entryForm"].active');
  const savedSrcBeforeRotate = await page.getAttribute('#entPhotoPreview .ph img', 'src');
  await page.click('#entPhotoPreview .ph-rotate');
  await page.waitForFunction((prev) => {
    const img = document.querySelector('#entPhotoPreview .ph img');
    return img && img.getAttribute('src') !== prev;
  }, savedSrcBeforeRotate);
  check('保存済みの写真も回すとプレビューが更新される（再アップロードして差し替え）', true);
  await page.click('.screen.active [data-back="tripDetail"]');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');

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

  // ---- Blockの並べ替え（ドラッグ、時刻未設定のBlockだけ持ち手が出る） ----
  await page.click('.block-add >> text=予定を追加');
  await page.waitForSelector('.screen[data-screen="blockForm"].active');
  await page.fill('#blkLabel', 'テスト2つ目の予定');
  await page.click('#btnSaveBlock');
  await page.waitForSelector('.screen[data-screen="entryForm"].active');
  await page.click('.screen.active [data-back="tripDetail"]');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  check('新しい予定が2件目としてタイムラインに追加される', (await page.textContent('.block-label >> nth=1')) === 'テスト2つ目の予定');
  check('時刻未設定のBlockにだけ並べ替えの持ち手が出る（時刻ありの1件目には出ない）', (await page.$$('.block-drag-handle')).length === 1);

  const handle2 = page.locator('.block').nth(1).locator('.block-drag-handle');
  const handleBox = await handle2.boundingBox();
  const block0Box = await page.locator('.block').nth(0).boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, block0Box.y + 5, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const first = document.querySelector('.block-label');
    return first && first.textContent === 'テスト2つ目の予定';
  });
  check('ドラッグして持ち上げると、2件目だったBlockが1件目になる', true);

  // ---- 編集 ----
  await page.click('.entry-card >> nth=0 >> .entry-author');
  await page.waitForSelector('.screen[data-screen="entryForm"].active');
  check('編集画面のタイトルになる', (await page.textContent('#entFormTitle')) === '記録を編集');
  check('削除ボタンが出る', await page.isVisible('#btnDeleteEntry'));
  check('一覧には出ない詳細も、記録を開けば保存されたままの内容が見える', (await page.inputValue('#entDetail')) === '朝早く行くと空いていて写真が撮りやすい。');
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

  // ---- サーバー側で消えた（見つからない）旅行は、ホーム画面の一覧からも消える ----
  await page.click('.screen.active [data-back="home"]');
  await page.waitForSelector('.screen[data-screen="home"].active');
  await page.evaluate(() => {
    var list = JSON.parse(localStorage.getItem('tabilog:my-trips') || '[]');
    list.unshift({ id: 'trip_ghost', title: '消えた旅行', startDate: '', endDate: '', companions: [] });
    localStorage.setItem('tabilog:my-trips', JSON.stringify(list));
  });
  await page.reload();
  await page.waitForSelector('.screen[data-screen="home"].active');
  check('サーバーに無い旅行もいったんは一覧に出る', (await page.textContent('#tripList')).includes('消えた旅行'));
  await page.click('.trip-card:has-text("消えた旅行")');
  await page.waitForFunction(() => !(document.querySelector('#tripList') || {}).textContent.includes('消えた旅行'));
  check('見つからない旅行を開くと一覧から消える', !(await page.textContent('#tripList')).includes('消えた旅行'));

  check('ページ内エラーが発生していない', errors.length === 0, errors.join(' / '));

  await browser.close();
  server.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
