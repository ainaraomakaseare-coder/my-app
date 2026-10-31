/*
 * 【必須テスト】記録を追加の「写真を追加する」1つのボタンから、カメラで撮る・アルバムから選ぶ・ファイルを選択の
 * どれでも選べることを確かめる（2026-10-31）。以前、iPhoneアプリでは写真ライブラリへ直接行き、カメラで撮れなかった。
 *   - スマホのブラウザ／Androidアプリ／パソコン：「動画を追加する」と同じふつうのファイル選択（capture無し）を開く。
 *     端末がカメラ・アルバム・ファイルの選択肢を出す
 *   - iPhoneアプリ（Capacitorをまねる）：アプリの中のメニューで3つを出す。アルバムはネイティブの写真選びで、
 *     撮影場所が記録の地図に入る
 * リリース前に必ず通すこと（docs/release-checklist.md）。実機での確認もそちらに書いてある。
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
          pickImages: () => {
            window.__pickImagesCalls++;
            return Promise.resolve({ photos: [{ webPath: '/test/fixtures/photo-gps-1.jpg', format: 'jpeg', exif: { GPS: { Latitude: 26.2172, LatitudeRef: 'N', Longitude: 127.7195, LongitudeRef: 'E' } } }] });
          }
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

  const cases = [
    { name: 'スマホ', touch: true },
    { name: 'iPhoneアプリ', touch: true, platform: 'ios' },
    { name: 'Androidアプリ', touch: true, platform: 'android' },
    { name: 'パソコン', touch: false }
  ];
  for (const c of cases) {
    const { ctx, page, errors } = await openEntryForm(browser, BASE, c);
    const T = (s) => `[${c.name}] ${s}`;
    const photoCount = () => page.$$eval('#entPhotoPreview img', (els) => els.length);
    const waitPhotos = (n) => page.waitForFunction((n) => document.querySelectorAll('#entPhotoPreview img').length === n, n, { timeout: 5000 }).catch(() => {});
    check(T('写真のボタンは「写真を追加する」ひとつだけ'), (await page.locator('.screen[data-screen="entryForm"] .photo-picker:visible').count()) === 2 && (await page.textContent('#entPhotoPicker')).trim() === '写真を追加する');
    // 写真の入力は、動画の入力と同じ作り（capture無し＝カメラに固定しない、複数選べる）
    const attrs = await page.evaluate(() => ['entPhoto', 'entVideo'].map((id) => {
      const el = document.getElementById(id);
      return { capture: el.hasAttribute('capture'), multiple: el.multiple, accept: el.accept };
    }));
    check(T('写真の入力はcapture無しで複数選べる（動画の入力と同じ）'), !attrs[0].capture && attrs[0].accept === 'image/*' && attrs[0].multiple && attrs[1].multiple && !attrs[1].capture, JSON.stringify(attrs));

    if (c.platform !== 'ios') {
      const chooser = await chooserOf(page, '#entPhotoPicker');
      check(T('「写真を追加する」でふつうのファイル選択（端末がカメラ・アルバム・ファイルを出す）が開く'), !!chooser && chooser.isMultiple() && (await chooser.element().evaluate((el) => el.id)) === 'entPhoto');
      check(T('アプリの中のメニューは出さない'), await page.isHidden('#entPhotoMenu'));
      if (chooser) await chooser.setFiles(fx);
      await waitPhotos(1);
      check(T('選んだ（撮った）写真が記録に入る'), (await photoCount()) === 1);
    } else {
      // iPhoneアプリ：アプリの中のメニューで3つを出す
      await page.click('#entPhotoPicker');
      const labels = (await page.locator('#entPhotoMenu button:visible').allTextContents()).map((t) => t.trim());
      check(T('「写真を追加する」でカメラ・アルバム・ファイルのメニューが出る'), ['カメラで撮る', 'アルバムから選ぶ', 'ファイルを選択'].every((l) => labels.includes(l)), labels.join(','));
      check(T('押しただけではアルバムへ直接行かない'), (await page.evaluate(() => window.__pickImagesCalls)) === 0);
      // アルバムから選ぶ（ネイティブの写真選び。撮影場所が地図に入る）
      await page.click('#btnEntPhotoMenuAlbum');
      await waitPhotos(1);
      check(T('「アルバムから選ぶ」は写真ライブラリ（ネイティブの写真選び）を開き、写真が入る'), (await page.evaluate(() => window.__pickImagesCalls)) === 1 && (await photoCount()) === 1);
      await page.waitForFunction(() => document.querySelector('#entMapUrl').value, null, { timeout: 5000 }).catch(() => {});
      check(T('アルバムの写真の撮影場所が記録の地図に入る'), /26\.21|127\.71/.test(await page.inputValue('#entMapUrl')), await page.inputValue('#entMapUrl'));
      // カメラで撮る
      await page.click('#entPhotoPicker');
      const shot = await chooserOf(page, '#btnEntPhotoMenuCamera');
      check(T('「カメラで撮る」でカメラ（capture付きの入力）が開く'), !!shot && (await shot.element().evaluate((el) => el.id + ':' + el.getAttribute('capture'))) === 'entPhotoShot:environment');
      check(T('選んだらメニューは閉じる'), await page.isHidden('#entPhotoMenu'));
      if (shot) await shot.setFiles(fx);
      await waitPhotos(2);
      check(T('撮った写真が記録に入る'), (await photoCount()) === 2);
      // ファイルを選択
      await page.click('#entPhotoPicker');
      const file = await chooserOf(page, '#btnEntPhotoMenuFile');
      check(T('「ファイルを選択」でふつうのファイル選択が開く'), !!file && file.isMultiple() && (await file.element().evaluate((el) => el.id)) === 'entPhoto');
      if (file) await file.setFiles(fx);
      await waitPhotos(3);
      check(T('選んだファイルが記録に入る'), (await photoCount()) === 3);
      // キャンセル・外側タップで閉じる
      await page.click('#entPhotoPicker');
      await page.click('#btnEntPhotoMenuCancel');
      check(T('キャンセルで閉じる'), await page.isHidden('#entPhotoMenu'));
    }
    check(T('ページでエラーが出ていない'), errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  console.log(`entry-photo-camera.smoke: ${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
