/*
 * 入れたときの元（AIなどで予定を入れたときの元の入力。worker/src/import-sources.js、2026-11-14）を画面で確かめる。
 * - メモ・予約やチケットの画像から予定を入れると、import-blocks に元（文字・画像のid）が付いて送られる
 * - 元から入れた予定に「入れたときの元を見る」が出て、押すと元のカード（文字・画像・ここから入れた予定）が開く
 * - 旅行の画面の「入れたときの元」から一覧を開ける／元を消すと予定のリンクも消える
 * 実行: node test/import-sources.smoke.js   （要 playwright）。SHOT=dir を付けるとスクショを残す
 */
const path = require('path');
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg' };
const SHOT = process.env.SHOT || '';

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

(async () => {
  const { server, port } = await startServer();
  const BASE = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'ja-JP', deviceScaleFactor: SHOT ? 2 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());

  const TEST_USER = { email: 'tester@example.com', name: 'テスト太郎', accountId: '123456', token: 't'.repeat(64) };
  await page.addInitScript((user) => {
    localStorage.setItem('tabilog:user', JSON.stringify(user));
    localStorage.setItem('tabilog.tutorialDone', '1');
    localStorage.setItem('tabilog.tutorialTripDone', '1');
  }, TEST_USER);
  await page.route(/\/api\/accounts\/ensure$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ accountId: TEST_USER.accountId, email: TEST_USER.email, name: TEST_USER.name, memoRemainingThisPeriod: 3, voiceRemainingThisPeriod: 3, ticketCredits: 0 })
  }));
  await page.route('**/', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace('<meta name="tabilog-api-endpoint" content="https://tabilog-api.hiroya-apps.workers.dev">', '<meta name="tabilog-api-endpoint" content="/api">');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });

  // サーバーのかわり：予定と元をここに持つ
  const trip = { id: 'trip_1', title: 'シンガポール', startDate: '2026-08-28', endDate: '2026-08-29', companions: [] };
  let blocks = [], sources = [], n = 0;
  const sent = [];
  const photoBytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'photo-gps-1.jpg'));
  await page.route(/\/api\/trips$/, (route) => route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ...trip, coverPhotoId: '', createdAt: 'now', updatedAt: 'now' }) }));
  await page.route(/\/api\/trips\/trip_1$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ trip, blocks, days: [], members: [] }) }));
  await page.route(/\/api\/photos$/, (route) => {
    n++;
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'photo_' + String(n).padStart(32, '0') + '.jpg' }) });
  });
  await page.route(/\/api\/photos\/photo_/, (route) => route.fulfill({ status: 200, contentType: 'image/jpeg', body: photoBytes }));
  await page.route(/\/api\/trips\/trip_1\/import-blocks$/, (route) => {
    const body = JSON.parse(route.request().postData());
    sent.push(body);
    let source = null;
    if (body.source) {
      source = { id: 'src_' + (sources.length + 1), tripId: 'trip_1', branchId: '', kind: body.source.kind, text: body.source.text || '', notes: body.source.notes || '', photoIds: body.source.photoIds || [], author: body.author, createdAt: new Date(Date.UTC(2026, 10, 14, 11, 30 + sources.length)).toISOString() };
      sources.unshift(source);
    }
    const made = body.items.map((it, i) => ({ id: 'b' + blocks.length + '_' + i, tripId: 'trip_1', date: it.date, time: it.time, label: it.label, category: it.category, transport: '', moveMinutes: 0, manualOrder: null, tzOverride: '', branchId: '', videoExclude: false, sourceId: source ? source.id : '', createdAt: 'x' + blocks.length + i, updatedAt: 'x', entries: [] }));
    blocks = blocks.concat(made);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ blocks: made, errors: [], source }) });
  });
  await page.route(/\/api\/trips\/trip_1\/import-sources$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sources }) }));
  await page.route(/\/api\/import-sources\/([^/]+)$/, (route) => {
    const id = route.request().url().split('/').pop();
    sources = sources.filter((s) => s.id !== id);
    blocks.forEach((b) => { if (b.sourceId === id) b.sourceId = ''; });
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route(/\/api\/places\/nearby/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ places: [] }) }));
  const base = { transport: '', place: '', placeGuessed: false, fromPlace: '', toPlace: '', company: '', routeNumber: '', departTime: '', arriveTime: '', arriveDate: '', warnings: [], timeEstimated: false, nightIndex: 0, costItems: [], note: '' };
  await page.route(/\/api\/trips\/([^/]+)\/screenshot-scan$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: [{ ...base, id: 's1', category: 'transport', date: '2026-08-28', time: '09:00', label: 'シンガポール航空 SQ637', sourceImage: 0 }], unreadable: [], dropped: 0 })
  }));

  await page.goto(BASE);
  await page.click('#btnNewTrip');
  await page.fill('#ntTitle', 'シンガポール');
  await page.fill('#ntStart', '2026-08-28');
  await page.fill('#ntEnd', '2026-08-29');
  await page.click('#btnCreateTrip');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  check('元が無いうちは「入れたときの元」ボタンは出ない', await page.isHidden('#btnOpenImportSources'));

  // ---- メモ（決まった形。AIを使わない）から ----
  await page.click('.block-add-bulk');
  await page.click('.block-add-voice');
  await page.waitForSelector('.screen[data-screen="voiceEntryForm"].active');
  await page.click('#veTabMemo');
  const memo = '10時 マーライオン\n友だちのおすすめ。朝のほうが空いている\n13時 ラオパサ\nサテを食べる';
  await page.fill('#textMemoInput', memo);
  await page.click('#btnCreateTextEntries');
  await page.waitForSelector('.screen[data-screen="importConfirm"].active');
  await page.click('#btnSsSave');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  check('メモの取り込みで元（メモの文）が送られる', sent[0] && sent[0].source && sent[0].source.kind === 'memo' && sent[0].source.text === memo, JSON.stringify(sent[0] && sent[0].source));
  await page.waitForSelector('.block-source-link');
  check('元から入れた予定に「入れたときの元を見る」が出る', (await page.$$('.block-source-link')).length === 2);
  check('「入れたときの元」ボタンが出る', await page.isVisible('#btnOpenImportSources'));

  // ---- 予約・チケットの画像から ----
  await page.click('.block-add-bulk');
  await page.click('.block-add-screenshot');
  await page.waitForSelector('.screen[data-screen="screenshotImport"].active');
  await page.setInputFiles('#ssFileInput', [path.join(__dirname, 'fixtures', 'photo-gps-1.jpg'), path.join(__dirname, 'fixtures', 'photo-gps-2.jpg')]);
  await page.waitForFunction(() => document.querySelectorAll('#ssThumbs .ss-thumb').length === 2);
  await page.click('#btnSsScan');
  await page.waitForSelector('.screen[data-screen="importConfirm"].active');
  await page.click('#btnSsSave');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  check('画像の取り込みで元の画像（2枚）が送られる', sent[1] && sent[1].source && sent[1].source.kind === 'screenshot' && sent[1].source.photoIds.length === 2, JSON.stringify(sent[1] && sent[1].source));
  check('画像は記録（アルバム）には入らない', blocks.every((b) => !b.entries.length));

  // ---- 予定から元を開く ----
  await page.waitForSelector('.block-source-link');
  await page.click('.block-source-link >> nth=0');
  await page.waitForSelector('.screen[data-screen="importSources"].active');
  await page.waitForSelector('.isrc-card');
  const cards = await page.$$eval('.isrc-card', (els) => els.map((e) => ({
    focus: e.classList.contains('is-focus'), kind: e.querySelector('.isrc-kind').textContent,
    text: (e.querySelector('.isrc-text') || {}).textContent || '', imgs: e.querySelectorAll('.isrc-img').length,
    made: Array.from(e.querySelectorAll('.isrc-block')).map((b) => b.textContent)
  })));
  check('元が新しい順に2枚', cards.length === 2 && cards[0].kind === '予約・チケットの画像' && cards[1].kind === 'メモ', JSON.stringify(cards));
  check('画像の元は画像2枚と、ここから入れた予定', cards[0].imgs === 2 && cards[0].made.length === 1 && /SQ637/.test(cards[0].made[0]), JSON.stringify(cards[0]));
  check('メモの元は元の文と、ここから入れた予定2件', cards[1].text === memo && cards[1].made.length === 2, JSON.stringify(cards[1]));
  check('開いた予定の元が目立つ', cards.filter((c) => c.focus).length === 1);
  if (SHOT) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOT, 'sources.png') });
  }
  await page.click('.isrc-img >> nth=1');
  check('画像を押すと大きく見られる', await page.isVisible('#photoLightbox'));
  await page.click('#btnCloseLightbox');

  // ---- 予定のボタンで、その日へ戻る ----
  await page.click('.isrc-card >> nth=1 >> .isrc-block >> nth=0');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  if (SHOT) {
    const el = await page.$('.block');
    await el.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOT, 'timeline.png') });
  }

  // ---- 消す ----
  await page.click('#btnOpenImportSources');
  await page.waitForSelector('.isrc-card');
  await page.click('.isrc-card >> nth=0 >> .isrc-delete');
  await page.waitForFunction(() => document.querySelectorAll('.isrc-card').length === 1);
  check('消すと一覧から消える', (await page.$$('.isrc-card')).length === 1);
  await page.click('.screen[data-screen="importSources"] [data-back="tripDetail"]');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  check('ページでエラーが出ていない', errors.length === 0, errors.join(' / '));
  console.log(`import-sources.smoke: ${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
