/*
 * 【必須テスト】記録を追加の写真欄で「カメラで撮る」を選べることを確かめる（2026-10-31）。
 * 以前、iPhoneアプリで「写真を追加する」を押すとアルバムへ直接行き、カメラを選べなかった。
 * リリース前に必ず通すこと（docs/release-checklist.md）。
 *   - スマホのブラウザ：「カメラで撮る」と「アルバムから選ぶ」が並び、カメラ側はcapture付きの入力を開く
 *   - iPhoneアプリ（Capacitorをまねる）：アルバムはネイティブの写真選び、カメラはcapture付きの入力
 *   - Androidアプリ（Capacitorをまねる）：カメラが出る
 *   - パソコン：カメラは出さず、これまでどおり「写真を追加する」
 * 実行: node test/entry-photo-camera.smoke.js   （要 playwright）
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

async function openEntryForm(browser, BASE, opts) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'ja-JP', hasTouch: !!opts.touch, isMobile: !!opts.touch });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.addInitScript(({ user, platform }) => {
    localStorage.setItem('tabilog:user', JSON.stringify(user));
    localStorage.setItem('tabilog.tutorialDone', '1');
    localStorage.setItem('tabilog.tutorialTripDone', '1');
    if (platform) {
      // Capacitorアプリの中をまねる（写真プラグインはiPhoneだけ）
      window.__pickImagesCalls = 0;
      window.Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => platform,
        Plugins: platform === 'ios' ? { Camera: {
          checkPermissions: () => Promise.resolve({ photos: 'granted' }),
          pickImages: () => { window.__pickImagesCalls++; return Promise.reject(new Error('User cancelled photos app')); }
        } } : {}
      };
      // 通信はCapacitorHttpを通るので、ふつうのfetchに渡してフェイクのAPIへ届ける
      window.Capacitor.Plugins.CapacitorHttp = {
        request: (o) => fetch(o.url, { method: o.method, headers: o.headers, body: o.data !== undefined ? JSON.stringify(o.data) : undefined })
          .then((r) => r.text().then((t) => { let data = t; try { data = JSON.parse(t); } catch (e) {} return { status: r.status, data }; }))
      };
    }
  }, { user: TEST_USER, platform: opts.platform || '' });
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
  const blocks = [];
  await page.route(/\/api\/trips\/trip_1\/blocks$/, (route) => {
    const data = JSON.parse(route.request().postData() || '{}');
    const b = { ...data, id: 'blk_' + (blocks.length + 1), tripId: 'trip_1', createdAt: 'now', updatedAt: 'now' };
    blocks.push(b);
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ...b, entries: [] }) });
  });
  await page.route(/\/api\/trips\/([^/]+)$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ trip: { id: 'trip_1', title: '沖縄', startDate: '2026-08-28', endDate: '2026-08-29', companions: [] }, blocks: blocks.map((b) => ({ ...b, entries: [] })), days: [], members: [] })
  }));

  await page.goto(BASE);
  await page.click('#btnNewTrip');
  await page.fill('#ntTitle', '沖縄');
  await page.fill('#ntStart', '2026-08-28');
  await page.fill('#ntEnd', '2026-08-29');
  await page.click('#btnCreateTrip');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  await page.click('.block-add');
  await page.waitForSelector('.screen[data-screen="blockForm"].active');
  await page.fill('#blkLabel', '首里城公園');
  await page.click('#btnSaveBlock');
  // 保存後のトーストの「記録を追加」から記録フォームを開く
  await page.click('.toast-action-btn');
  await page.waitForSelector('.screen[data-screen="entryForm"].active');
  return { ctx, page, errors };
}

async function chooserOf(page, selector) {
  const ev = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
  await page.click(selector);
  return ev;
}

(async () => {
  const { server, port } = await startServer();
  const BASE = `http://127.0.0.1:${port}/`;
  const browser = await launch();
  const fx = path.join(__dirname, 'fixtures', 'photo-gps-1.jpg');

  // ---- スマホのブラウザ ----
  {
    const { ctx, page, errors } = await openEntryForm(browser, BASE, { touch: true });
    check('[スマホ] 「カメラで撮る」が出る', await page.isVisible('#entPhotoShotPicker'));
    check('[スマホ] もう一方は「アルバムから選ぶ」', (await page.textContent('#entPhotoPickerLabel')) === 'アルバムから選ぶ');
    check('[スマホ] カメラ用の入力はcapture付き', (await page.getAttribute('#entPhotoShot', 'capture')) === 'environment');
    const shot = await chooserOf(page, '#entPhotoShotPicker');
    check('[スマホ] 「カメラで撮る」でカメラ用の入力が開く', !!shot && (await shot.element().evaluate((el) => el.id)) === 'entPhotoShot');
    if (shot) await shot.setFiles(fx);
    await page.waitForFunction(() => document.querySelectorAll('#entPhotoPreview img').length === 1, null, { timeout: 5000 }).catch(() => {});
    check('[スマホ] 撮った写真が記録に入る', (await page.$$('#entPhotoPreview img')).length === 1);
    const album = await chooserOf(page, '#entPhotoPicker');
    check('[スマホ] 「アルバムから選ぶ」は複数選べる入力', !!album && album.isMultiple() && (await album.element().evaluate((el) => el.id)) === 'entPhoto');
    check('[スマホ] ページでエラーが出ていない', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  // ---- iPhoneアプリ ----
  {
    const { ctx, page, errors } = await openEntryForm(browser, BASE, { touch: true, platform: 'ios' });
    check('[iPhoneアプリ] 「カメラで撮る」が出る', await page.isVisible('#entPhotoShotPicker'));
    check('[iPhoneアプリ] 写真のボタンは「カメラで撮る」「アルバムから選ぶ」の2つだけ（「ファイルから選ぶ」の小さいボタンは出さない）', (await page.locator('.screen[data-screen="entryForm"] .field:has(#entPhoto) button:visible, .screen[data-screen="entryForm"] .field:has(#entPhoto) .photo-picker:visible').count()) === 2);
    const shot = await chooserOf(page, '#entPhotoShotPicker');
    check('[iPhoneアプリ] 「カメラで撮る」はアルバムでなくカメラ用の入力を開く', !!shot && (await shot.element().evaluate((el) => el.id)) === 'entPhotoShot' && (await page.evaluate(() => window.__pickImagesCalls)) === 0);
    await page.click('#entPhotoPicker');
    await page.waitForTimeout(200);
    check('[iPhoneアプリ] 「アルバムから選ぶ」は写真ライブラリ（場所が読める選び方）', (await page.evaluate(() => window.__pickImagesCalls)) === 1);
    check('[iPhoneアプリ] ページでエラーが出ていない', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  // ---- Androidアプリ ----
  {
    const { ctx, page, errors } = await openEntryForm(browser, BASE, { touch: true, platform: 'android' });
    check('[Androidアプリ] 「カメラで撮る」が出る', await page.isVisible('#entPhotoShotPicker'));
    const shot = await chooserOf(page, '#entPhotoShotPicker');
    check('[Androidアプリ] 「カメラで撮る」でカメラ用の入力が開く', !!shot && (await shot.element().evaluate((el) => el.id)) === 'entPhotoShot');
    check('[Androidアプリ] ページでエラーが出ていない', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  // ---- パソコン ----
  {
    const { ctx, page, errors } = await openEntryForm(browser, BASE, { touch: false });
    check('[パソコン] 「カメラで撮る」は出さない', await page.isHidden('#entPhotoShotPicker'));
    check('[パソコン] 「写真を追加する」のまま', (await page.textContent('#entPhotoPickerLabel')) === '写真を追加する');
    const album = await chooserOf(page, '#entPhotoPicker');
    check('[パソコン] 「写真を追加する」でファイル選択が開く', !!album && album.isMultiple());
    check('[パソコン] ページでエラーが出ていない', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  console.log(`entry-photo-camera.smoke: ${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
