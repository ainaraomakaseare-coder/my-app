// App Store用スクリーンショットの素の画面（raw-*.png）を撮る。サイズは iPhone 6.1/6.3インチ（1179×2556）
// 使い方: NODE_PATH=<playwrightのnode_modules> node food-photos.cjs && node store-raw.cjs && node store-frame.cjs
// サンプルの記録は「書き出しファイル」の形で作り、アプリの「ファイルから読み込む」で入れる。
// 近くのお店の候補はWorkerに問い合わせず、架空の店名を返すようにしてある。
const path = require('path'), http = require('http'), fs = require('fs');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..', '..', 'gohan-ashiato');
const WORK = path.join(__dirname, 'work');
const PHOTOS = path.join(WORK, 'photos');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const NOW = new Date('2026-10-29T20:30:00+09:00');

// 架空のお店と記録（位置は横浜・東京あたり）
const R = [
  ['ramen', '味噌ラーメン', '2026-10-28', '19:40', 'dinner', '麺処 こがね', 35.4660, 139.6220, 980, 5, 'スープが濃厚。次は辛味噌にしたい'],
  ['karaage', '唐揚げ定食', '2026-10-27', '12:15', 'lunch', '定食屋 ひなた', 35.4580, 139.6310, 850, 4, 'ご飯おかわり無料'],
  ['curry', 'スパイスカレー', '2026-10-25', '12:50', 'lunch', 'カレー食堂 ルウ', 35.4440, 139.6380, 1200, 5, 'あいがけにして正解'],
  ['pancake', 'ふわふわパンケーキ', '2026-10-24', '15:30', 'snack', '喫茶 こもれび', 35.4510, 139.6290, 1100, 4, ''],
  ['salmon', 'サーモンいくら丼', '2026-10-22', '12:05', 'lunch', '港の食堂', 35.4530, 139.6420, 1350, 4, ''],
  ['pizza', 'マルゲリータ', '2026-10-19', '19:10', 'dinner', 'ピッツェリア ソーレ', 35.6590, 139.7000, 1600, 5, '生地がもちもち'],
  ['omurice', 'オムライス', '2026-10-17', '19:30', 'dinner', '自宅', null, null, null, 4, '卵3個で作った'],
  ['gyoza', '焼き餃子', '2026-10-14', '18:45', 'dinner', '餃子の福来', 35.4430, 139.6460, 600, 4, ''],
  ['yakitori', '焼き鳥盛り合わせ', '2026-10-10', '19:20', 'dinner', '炭火やきとり とり吉', 35.4650, 139.6200, 1800, 5, 'つくねが絶品'],
  ['curry', 'チキンカレー', '2026-10-06', '12:30', 'lunch', 'カレー食堂 ルウ', 35.4440, 139.6380, 1000, 4, ''],
  ['ramen', '醤油ラーメン', '2026-10-03', '13:00', 'lunch', '麺処 こがね', 35.4660, 139.6220, 900, 4, ''],
  ['karaage', '唐揚げ定食', '2026-09-28', '12:20', 'lunch', '定食屋 ひなた', 35.4580, 139.6310, 850, 4, ''],
  ['pancake', 'ベリーパンケーキ', '2026-09-23', '15:00', 'snack', '喫茶 こもれび', 35.4510, 139.6290, 1250, 5, ''],
];
const SHOPS = ['麺処 こがね', '中華そば 灯', 'らーめん 一福', '定食屋 ひなた', '喫茶 こもれび', 'カレー食堂 ルウ'];

function backup() {
  const photos = {}, records = R.map((r, i) => {
    const [img, name, date, time, meal, place, lat, lng, price, rating, memo] = r;
    const pid = 'p_' + img;
    if (!photos[pid]) photos[pid] = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(PHOTOS, img + '.jpg')).toString('base64');
    const at = new Date(date + 'T' + time + ':00+09:00').toISOString();
    return { id: 'r_sample' + i, date, time, meal, name, place, lat, lng, price, rating, memo, photoIds: [pid], createdAt: at, updatedAt: at };
  });
  return { app: 'gohan-ashiato', version: 1, exportedAt: NOW.toISOString(), records, photos };
}

(async () => {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(fs.readFileSync(file));
  });
  const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--lang=ja-JP'] });
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, locale: 'ja-JP', timezoneId: 'Asia/Tokyo',
    geolocation: { latitude: 35.4660, longitude: 139.6220 }, permissions: ['geolocation'], isMobile: true, hasTouch: true,
  });
  await ctx.route('https://tabilog-api.hiroya-apps.workers.dev/**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ places: SHOPS.map(name => ({ name })) }) }));
  const page = await ctx.newPage();
  await page.clock.install({ time: NOW });
  const base = `http://127.0.0.1:${port}/`;
  const shot = name => page.screenshot({ path: path.join(WORK, name + '.png') });
  const go = async hash => { await page.evaluate(h => { location.hash = h; }, hash); await page.waitForTimeout(500); };

  await page.goto(base);
  // Chromeだけに出る入力欄のアイコン（日付・時刻・候補の▼）はiPhoneには無いので隠す
  await page.addStyleTag({ content: 'input::-webkit-calendar-picker-indicator{display:none!important}' });
  await page.waitForTimeout(500);
  // サンプルの記録を読み込む
  const bk = path.join(WORK, 'sample-backup.json');
  fs.writeFileSync(bk, JSON.stringify(backup()));
  await go('#/settings');
  await page.setInputFiles('#import-input', bk);
  await page.waitForTimeout(1500);
  await page.reload(); await page.waitForTimeout(800);
  await page.addStyleTag({ content: 'input::-webkit-calendar-picker-indicator{display:none!important}' });

  // 1. 一覧
  await go('#/'); await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(600);
  await shot('raw-1-list');
  // 2. 写真で並べる
  await page.click('#view-toggle'); await page.waitForTimeout(800);
  await shot('raw-2-grid');
  await page.click('#view-toggle'); await page.waitForTimeout(300);
  // 3. 詳細
  await go('#/r/r_sample0'); await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(800);
  await shot('raw-3-detail');
  // 4. 記録する（写真を選ぶ→現在地→近くのお店の候補）
  await go('#/new'); await page.waitForTimeout(500);
  await page.setInputFiles('#photo-input', path.join(PHOTOS, 'ramen.jpg'));
  await page.waitForTimeout(1200);
  await page.fill('#f-name', '味噌ラーメン');
  await page.click('#f-locate'); await page.waitForTimeout(1200);
  await page.click('#f-shops [data-shop="麺処 こがね"]'); await page.waitForTimeout(200);
  await page.fill('#f-price', '980');
  await page.click('#f-rating [data-star="5"]');
  // Chromeの日付・時刻欄は米国式（10/29/2026 08:30 PM）で出るため、iPhoneと同じ表示に置き換える（撮影用の見た目だけ）
  await page.evaluate(() => {
    const d = document.getElementById('f-date'), t = document.getElementById('f-time');
    const dv = d.value.replace(/-/g, '/'), tv = t.value;
    d.type = 'text'; d.value = dv; t.type = 'text'; t.value = tv;
    document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0);
  });
  await page.waitForTimeout(400);
  await shot('raw-4-edit');
  await go('#/'); await page.waitForTimeout(300);
  // 5. お店
  await page.reload(); await page.waitForTimeout(800);
  await page.click('[data-tab="places"]'); await page.waitForTimeout(600);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('raw-5-places');

  await browser.close(); server.close();
  console.log('done');
})().catch(e => { console.error(e); process.exit(1); });
