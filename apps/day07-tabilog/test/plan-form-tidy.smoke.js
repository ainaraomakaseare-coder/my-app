/*
 * 【必須テスト】予定の画面と「まとめて予定を作る」の文字を減らして見やすくしたことを確かめる（2026-11-13）。
 *   - 「動画でシェアに出さない」の長い説明は最初は隠れていて、横の「？」をタップすると出る
 *   - 「？」をタップしてもチェックは切り替わらない
 *   - 「まとめて予定を作る」の全体の説明・AIの回数の説明は「？」の中。各ボタンの例は1行の短い文
 *   - 記録がある予定の「別の記録を追加」は控えめな見た目（is-more）
 * 実行: node test/plan-form-tidy.smoke.js   （要 playwright）
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
  const args = [];
  try { return await chromium.launch({ args }); }
  catch (e) {
    const fallback = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(fallback)) return chromium.launch({ executablePath: fallback, args });
    throw e;
  }
}

const TEST_USER = { email: 'tester@example.com', name: 'テスト太郎', accountId: '123456' };


async function setup(browser, BASE) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'ja-JP', hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.addInitScript((user) => {
    localStorage.setItem('tabilog:user', JSON.stringify(user));
    localStorage.setItem('tabilog.tutorialDone', '1');
    localStorage.setItem('tabilog.tutorialTripDone', '1');
  }, TEST_USER);
  await page.route(/\/api\/accounts\/ensure$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ accountId: TEST_USER.accountId, email: TEST_USER.email, name: TEST_USER.name, memoRemainingThisPeriod: 5, voiceRemainingThisPeriod: 5, ticketCredits: 0 })
  }));
  await page.route('**/', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace('<meta name="tabilog-api-endpoint" content="https://tabilog-api.hiroya-apps.workers.dev">', '<meta name="tabilog-api-endpoint" content="/api">');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });
  await page.route(/\/api\/trips$/, (route) => {
    const data = JSON.parse(route.request().postData());
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'trip_1', title: data.title, startDate: data.startDate, endDate: data.endDate, companions: [], coverPhotoId: '', createdAt: 'now', updatedAt: 'now' }) });
  });
  const blocks = [], entries = [], photos = [];
  await page.route(/\/api\/photos$/, (route) => {
    const id = 'photo_' + (photos.length + 1) + '.jpg';
    photos.push(id);
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id }) });
  });
  await page.route(/\/api\/photos\/.+/, (route) => route.fulfill({ status: 200, contentType: 'image/jpeg', body: fs.readFileSync(path.join(__dirname, 'fixtures', 'photo-gps-1.jpg')) }));
  await page.route(/\/api\/trips\/trip_1\/blocks$/, (route) => {
    const data = JSON.parse(route.request().postData() || '{}');
    const b = { ...data, id: 'blk_' + (blocks.length + 1), tripId: 'trip_1', createdAt: 'now', updatedAt: 'now' };
    blocks.push(b);
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ...b, entries: [] }) });
  });
  await page.route(/\/api\/blocks\/([^/]+)\/entries$/, (route) => {
    const blockId = route.request().url().match(/\/blocks\/([^/]+)\/entries$/)[1];
    const data = JSON.parse(route.request().postData() || '{}');
    const e = { ...data, id: 'ent_' + (entries.length + 1), blockId, ratings: [], createdAt: 'now', updatedAt: 'now' };
    entries.push(e);
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(e) });
  });
  await page.route(/\/api\/trips\/([^/]+)$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ trip: { id: 'trip_1', title: '沖縄', startDate: '2026-08-28', endDate: '2026-08-29', companions: [] },
      blocks: blocks.map((b) => ({ ...b, entries: entries.filter((e) => e.blockId === b.id) })), days: [], members: [] })
  }));

  await page.goto(BASE);
  await page.click('#btnNewTrip');
  await page.fill('#ntTitle', '沖縄');
  await page.fill('#ntStart', '2026-08-28');
  await page.fill('#ntEnd', '2026-08-29');
  await page.click('#btnCreateTrip');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  return { ctx, page, errors, blocks, entries, photos };
}

async function openNewBlock(page) {
  await page.click('.block-add');
  await page.waitForSelector('.screen[data-screen="blockForm"].active');
}

(async () => {
  const { server, port } = await startServer();
  const browser = await launch();
  const { page, errors } = await setup(browser, `http://127.0.0.1:${port}/`);
  const fx = path.join(__dirname, 'fixtures', 'photo-gps-1.jpg');

  // ---- 予定の画面：動画でシェアに出さないの説明は「？」の中 ----
  await openNewBlock(page);
  check('「動画でシェアに出さない」のチェックが出る', await page.isVisible('#blkVideoExclude'));
  check('説明は最初は隠れている', !(await page.isVisible('#blkVideoExcludeInfo')));
  await page.click('#blkVideoExcludeRow .info-btn');
  check('「？」をタップすると説明が出る', await page.isVisible('#blkVideoExcludeInfo'));
  check('説明の文', /地名・写真・ピンが出ません/.test(await page.textContent('#blkVideoExcludeInfo')));
  check('「？」をタップしてもチェックは入らない', !(await page.isChecked('#blkVideoExclude')));
  await page.click('#blkLabel');
  check('ほかをタップすると説明が閉じる', !(await page.isVisible('#blkVideoExcludeInfo')));
  await page.click('#blkVideoExcludeRow label');
  check('文字をタップするとチェックが入る', await page.isChecked('#blkVideoExclude'));
  await page.click('#blkVideoExcludeRow label');

  // ---- 写真つきで保存 → 「別の記録を追加」は控えめ ----
  await page.fill('#blkLabel', '首里城');
  const ev = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
  await page.click('#entPhotoPicker');
  const ch = await ev; if (ch) await ch.setFiles(fx);
  await page.waitForFunction(() => document.querySelectorAll('#entPhotoPreview img').length === 1, null, { timeout: 5000 }).catch(() => {});
  await page.click('#btnSaveBlock');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  await page.waitForTimeout(300);
  const addBtns = await page.$$eval('#timeline .entry-add', (els) => els.map((e) => ({ t: e.textContent, more: e.classList.contains('is-more') })));
  check('記録がある予定は「別の記録を追加」が控えめ', addBtns.length === 1 && /別の記録を追加/.test(addBtns[0].t) && addBtns[0].more, JSON.stringify(addBtns));
  check('控えめなボタンは灰色（予定を追加の緑とちがう色）', await page.$eval('#timeline .entry-add.is-more', (e) => getComputedStyle(e).color !== getComputedStyle(document.querySelector('.block-add')).color));

  // ---- まとめて予定を作る ----
  await page.click('.block-add-bulk');
  await page.waitForSelector('#bulkAddSheet:not([hidden])');
  check('見出しは「まとめて予定を作る」', (await page.textContent('#bulkAddSheetTitle')) === 'まとめて予定を作る');
  check('全体の説明は最初は隠れている', !(await page.isVisible('#bulkAddInfo')));
  check('5つの入れ方が並ぶ', (await page.$$('#bulkAddSheet .add-more-item')).length === 5);
  const examples = await page.$$eval('#bulkAddSheet .add-more-example', (els) => els.map((e) => e.textContent));
  check('例は短い（25文字以内）', examples.every((t) => t.length <= 25), JSON.stringify(examples));
  check('例が1行に収まる', await page.$$eval('#bulkAddSheet .add-more-example', (els) => els.every((e) => e.getBoundingClientRect().height < parseFloat(getComputedStyle(e).lineHeight) * 1.5)));
  await page.click('#bulkAddSheet .info-btn');
  check('「？」で説明が出る', await page.isVisible('#bulkAddInfo'));
  const info = await page.textContent('#bulkAddInfo');
  check('説明に確認画面とAIの回数が書いてある', /確認画面で直せます/.test(info) && /月5回/.test(info), info);
  await page.click('#bulkAddSheet .info-btn');
  check('もう一度「？」で閉じる', !(await page.isVisible('#bulkAddInfo')));
  await page.click('#bulkAddSheet .sheet-close');
  await page.click('.block-add-bulk');
  check('開き直してもタイトルと「？」がある', (await page.textContent('#bulkAddSheetTitle')) === 'まとめて予定を作る' && await page.isVisible('#bulkAddSheet .info-btn'));

  check('ページエラーなし', errors.length === 0, errors.join(' / '));
  console.log('plan-form-tidy.smoke: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close(); server.close();
  process.exit(fail ? 1 : 0);
})();
