// App Store 用のスクリーンショット（6.5インチ 1284x2778）を作る。
// Web版（apps/gohan-ashiato）をiPhoneの画面サイズで開き、ダミーの記録を読み込んでから撮る。
// 写真は dishes.cjs で描いた料理の絵、お店の名前はすべて架空。
//
// 使い方（リポジトリのルートで）:
//   node apps/gohan-ashiato-ios/store/make-screenshots.mjs [日本語フォントのフォルダ]
// フォントのフォルダには noto-sans-jp-japanese-{400,700,800}-normal.woff2（@fontsource/noto-sans-jp）を置く。
// 省略するとChromiumの既定の日本語フォントで撮る。playwright が require できること。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { svg } = require('./dishes.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../../gohan-ashiato');
const OUT = path.resolve(HERE, '../store-screenshots');
const FONTS = process.argv[2] ? path.resolve(process.argv[2]) : '';
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'gohan-shots-'));
const W = 1284, H = 2778;

// ---- ダミーの記録（架空のお店）----
const SHOPS = {
  koga: ['麺屋 こがね 渋谷店', 35.6595, 139.7005], mame: ['カレーの店 まめ', 35.6620, 139.6980], kaji: ['寿司 かじ', 35.6702, 139.7027],
  hiyo: ['珈琲 ひより', 35.6645, 139.7120], ten: ['餃子の天平', 35.6930, 139.7034], tori: ['焼鳥 とりまる', 35.6581, 139.7017],
  home: ['自宅', null, null], kome: ['定食 こめや', 35.6890, 139.6917], tama: ['洋食 たまご亭', 35.6612, 139.7075],
  bb: ['BURGER BASE', 35.6467, 139.7101], cha: ['甘味処 ちゃのは', 35.6716, 139.7650], pas: ['トラットリア ソーレ', 35.6633, 139.7290],
  pan: ['パンケーキ工房 そら', 35.6680, 139.7090],
};
const RECORDS = [
  ['2026-10-28', '19:40', 'drink', '焼き鳥5本とビール', 'tori', 2380, 4, 'yakitori', 'ねぎま最高。つくねは次回たれで'],
  ['2026-10-28', '08:10', 'breakfast', '焼き魚定食', 'kome', 780, 4, 'teishoku', '朝定。さばが脂のってた'],
  ['2026-10-27', '12:30', 'lunch', '味噌ラーメン', 'koga', 950, 5, 'ramen', '今年いちばん。味玉トッピング必須'],
  ['2026-10-26', '15:00', 'snack', '抹茶パフェ', 'cha', 1280, 5, 'parfait', '白玉がもちもち'],
  ['2026-10-25', '18:50', 'dinner', 'カツカレー', 'mame', 1200, 4, 'curry', 'ロースカツ、辛さ3'],
  ['2026-10-24', '12:10', 'lunch', 'オムライス', 'tama', 1100, 4, 'omurice', 'ふわとろ。ケチャップ派'],
  ['2026-10-23', '10:00', 'snack', 'カフェラテ', 'hiyo', 580, 3, 'latte', 'ラテアートがきれい'],
  ['2026-10-22', '19:20', 'dinner', '焼き餃子', 'ten', 450, 4, 'gyoza', '羽根つき。酢こしょうで'],
  ['2026-10-20', '13:00', 'lunch', 'トマトのパスタ', 'pas', 1350, 3, 'pasta', ''],
  ['2026-10-18', '11:30', 'lunch', 'チーズバーガー', 'bb', 1480, 4, 'burger', 'ポテト多め'],
  ['2026-10-16', '20:00', 'dinner', 'にぎり6貫', 'kaji', 2600, 5, 'sushi', '中トロが溶けた'],
  ['2026-10-14', '09:00', 'breakfast', 'パンケーキ', 'pan', 1300, 4, 'pancake', '並ばずに入れた'],
  ['2026-10-12', '12:40', 'lunch', '味噌ラーメン', 'koga', 950, 5, 'ramen', '2回目。やっぱりうまい'],
  ['2026-10-10', '19:00', 'dinner', 'おうちカレー', 'home', 400, 3, 'curry', '作りおき'],
  ['2026-10-07', '15:30', 'snack', 'カフェラテ', 'hiyo', 580, 4, 'latte', ''],
  ['2026-10-04', '18:30', 'drink', '焼き鳥とハイボール', 'tori', 2100, 4, 'yakitori', ''],
  ['2026-10-02', '12:00', 'lunch', '焼き魚定食', 'kome', 880, 3, 'teishoku', ''],
  ['2026-09-28', '19:30', 'dinner', 'にぎり6貫', 'kaji', 2600, 4, 'sushi', '誕生日'],
  ['2026-09-24', '12:20', 'lunch', 'カツカレー', 'mame', 1200, 4, 'curry', ''],
  ['2026-09-20', '14:30', 'snack', '抹茶パフェ', 'cha', 1280, 4, 'parfait', ''],
  ['2026-09-15', '12:30', 'lunch', '味噌ラーメン', 'koga', 900, 4, 'ramen', '初めて行った'],
  ['2026-09-09', '19:10', 'dinner', 'オムライス', 'tama', 1100, 3, 'omurice', ''],
];

const CAPTIONS = {
  list: ['毎日のごはんを', '<b>1本の一覧</b>に', '月ごとの件数・合計・平均評価もひと目で'],
  add: ['<b>写真を選ぶだけ</b>で', '日時と場所が入る', '近くのお店の候補からタップで選べる'],
  grid: ['<b>写真で並べて</b>', '見返す', '★4以上や時間帯で絞り込みも'],
  places: ['よく行くお店が', '<b>ひと目でわかる</b>', 'お店ごとの回数・平均評価・合計'],
  detail: ['写真を大きく', '<b>地図</b>でお店へ', '記録は端末の中だけに保存'],
};

const fontCss = FONTS ? [400, 700, 800].map(w => `@font-face{font-family:'Noto Sans JP';font-weight:${w};src:url(/__fonts/noto-sans-jp-japanese-${w}-normal.woff2) format('woff2')}`).join('') + ":root{--font-body:'Noto Sans JP',sans-serif !important}" : '';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  let p;
  if (u.startsWith('/__fonts/') && FONTS) p = path.join(FONTS, u.slice(9));
  else if (u.startsWith('/__tmp/')) p = path.join(TMP, u.slice(7));
  else p = path.join(WEB, u.replace(/\/$/, '/index.html'));
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(p);
  // iPhoneアプリと同じく「撮る」ボタンを出す（Web版のブラウザでは隠している）
  if (u === '/style.css') body = Buffer.concat([body, Buffer.from(fontCss + '#photo-camera{display:flex !important}::-webkit-scrollbar{display:none}')]);
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL = `http://127.0.0.1:${server.address().port}/`;
// 日付・時刻の入力欄を日本の形（2026/10/29・12:18）で出すため、言語を日本語にして起動する
const browser = await chromium.launch({ args: ['--lang=ja-JP'], env: { ...process.env, LANG: 'ja_JP.UTF-8', LANGUAGE: 'ja' } });

try {
  // 1. 料理の絵を JPEG に
  const painter = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
  const photos = {};
  for (const name of new Set(RECORDS.map(r => r[7]))) {
    await painter.setContent(`<body style="margin:0">${svg(name)}</body>`);
    const buf = await painter.screenshot({ type: 'jpeg', quality: 88 });
    fs.writeFileSync(path.join(TMP, name + '.jpg'), buf);
    photos['p_demo_' + name] = 'data:image/jpeg;base64,' + buf.toString('base64');
  }
  await painter.close();
  const records = RECORDS.map(([date, time, meal, name, s, price, rating, photo, memo], i) => {
    const [place, lat, lng] = SHOPS[s];
    const t = new Date(`${date}T${time}:00+09:00`).toISOString();
    return { id: 'r_demo_' + String(i).padStart(2, '0'), date, time, meal, name, place, lat, lng, price, rating, memo, photoIds: ['p_demo_' + photo], createdAt: t, updatedAt: t };
  });
  fs.writeFileSync(path.join(TMP, 'demo.json'), JSON.stringify({ app: 'gohan-ashiato', version: 1, records, photos }));

  // 2. iPhone の画面サイズでアプリを開き、ダミーの記録を読み込む
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  await ctx.route('https://tabilog-api.hiroya-apps.workers.dev/**', route => route.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ found: true, places: [{ name: '麺屋 こがね 渋谷店' }, { name: 'カレーの店 まめ' }, { name: '珈琲 ひより' }] }),
  }));
  const page = await ctx.newPage();
  page.on('pageerror', e => { throw e; });
  await page.clock.setFixedTime(new Date('2026-10-29T12:30:00+09:00'));
  await page.goto(URL + '#/settings');
  await page.setInputFiles('#import-input', path.join(TMP, 'demo.json'));
  await page.waitForFunction(() => /読み込みました/.test(document.getElementById('backup-status').textContent));
  await page.goto(URL + '#/');
  await page.reload();
  await page.waitForSelector('.rec img.thumb');
  await page.evaluate(() => document.fonts.ready);
  const shot = async name => {
    await page.waitForTimeout(400);
    await page.evaluate(() => Promise.all([...document.images].filter(i => !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; }))));
    await page.screenshot({ path: path.join(TMP, name + '.png') });
  };

  await shot('list');

  await page.click('#view-toggle');
  await shot('grid');
  await page.click('#view-toggle');

  await page.click('.seg-btn[data-tab="places"]');
  await shot('places');
  await page.click('.seg-btn[data-tab="records"]');

  await page.click('.rec >> text=抹茶パフェ');
  await page.waitForSelector('#screen-detail:not([hidden])');
  await shot('detail');

  // 記録する：写真（撮影日時・場所入り）を選んで、近くのお店の候補を出す
  await page.goto(URL + '#/new');
  await page.waitForSelector('#screen-edit:not([hidden])');
  const exifJpeg = withExif(fs.readFileSync(path.join(TMP, 'ramen.jpg')));
  fs.writeFileSync(path.join(TMP, 'ramen-exif.jpg'), exifJpeg);
  await page.setInputFiles('#photo-input', path.join(TMP, 'ramen-exif.jpg'));
  await page.waitForSelector('#f-shops [data-shop]');
  await page.click('#f-shops [data-shop="麺屋 こがね 渋谷店"]');
  await page.fill('#f-name', '味噌ラーメン');
  await page.fill('#f-price', '950');
  await page.evaluate(() => document.activeElement.blur());
  await shot('add');
  await ctx.close();

  // 3. 見出しをつけて 1284x2778 にする
  const comp = await browser.newPage({ viewport: { width: W, height: H } });
  fs.mkdirSync(OUT, { recursive: true });
  const order = ['list', 'add', 'grid', 'places', 'detail'];
  for (const [i, name] of order.entries()) {
    const [l1, l2, sub] = CAPTIONS[name];
    const file = `gohan-iphone-${String(i + 1).padStart(2, '0')}-${name}.png`;
    fs.writeFileSync(path.join(TMP, 'comp.html'), `<!doctype html><meta charset=utf-8><style>${fontCss.replace(/url\(\/__fonts\//g, 'url(/__fonts/')}
      *{margin:0;box-sizing:border-box}html,body{width:${W}px;height:${H}px;overflow:hidden}
      body{font-family:'Noto Sans JP',sans-serif;font-feature-settings:"palt";color:#1C1E21;
        background:radial-gradient(1100px 900px at 90% 0%,#FFD5BC 0,transparent 70%),radial-gradient(1000px 1000px at 0% 100%,#FFE6C6 0,transparent 70%),linear-gradient(#FFF6EF,#FFECE0)}
      .cap{position:absolute;top:150px;left:0;right:0;text-align:center}
      .t{font-weight:800;font-size:96px;line-height:1.22;letter-spacing:.01em}.t b{color:#E8602A}
      .s{margin-top:28px;font-weight:700;font-size:44px;color:#6B5A50}
      .phone{position:absolute;left:50%;top:640px;transform:translateX(-50%);padding:22px;border-radius:118px;background:#1C1E21;box-shadow:0 50px 100px rgba(140,60,10,.28)}
      .phone img{display:block;width:1000px;height:2164px;border-radius:96px;object-fit:cover;object-position:top}
    </style><div class=cap><div class=t>${l1}<br>${l2}</div><div class=s>${sub}</div></div>
    <div class=phone><img src="/__tmp/${name}.png"></div>`);
    await comp.goto(URL + '__tmp/comp.html');
    await comp.evaluate(() => Promise.all([document.fonts.ready, ...[...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = r; }))]));
    await comp.screenshot({ path: path.join(OUT, file) });
    console.log('wrote', path.relative(process.cwd(), path.join(OUT, file)));
  }
} finally {
  await browser.close();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

// 撮影日時（2026-10-29 12:18）と撮影場所（渋谷あたり）の Exif を JPEG に足す
function withExif(jpeg) {
  const le16 = n => Buffer.from([n & 255, n >> 8]);
  const le32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const entry = (tag, type, count, value) => Buffer.concat([le16(tag), le16(type), le32(count), value.length === 4 ? value : Buffer.concat([value, Buffer.alloc(4 - value.length)])]);
  const rational = parts => Buffer.concat(parts.flatMap(([n, d]) => [le32(n), le32(d)]));
  const date = Buffer.from('2026:10:29 12:18:00\0');
  // TIFF: header(8) + IFD0(2+2*12+4) + ExifIFD(2+12+4) + GPS IFD(2+4*12+4) + data
  const ifd0 = 8, exif = ifd0 + 2 + 2 * 12 + 4, gps = exif + 2 + 12 + 4, data = gps + 2 + 4 * 12 + 4;
  const latOff = data, lngOff = data + 24, dateOff = data + 48;
  const tiff = Buffer.concat([
    Buffer.from('II*\0'), le32(ifd0),
    le16(2), entry(0x8769, 4, 1, le32(exif)), entry(0x8825, 4, 1, le32(gps)), le32(0),
    le16(1), entry(0x9003, 2, date.length, le32(dateOff)), le32(0),
    le16(4), entry(1, 2, 2, Buffer.from('N\0')), entry(2, 5, 3, le32(latOff)), entry(3, 2, 2, Buffer.from('E\0')), entry(4, 5, 3, le32(lngOff)), le32(0),
    rational([[35, 1], [39, 1], [3000, 100]]), rational([[139, 1], [42, 1], [0, 100]]), date,
  ]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(tiff.length + 8) >> 8, (tiff.length + 8) & 255]), Buffer.from('Exif\0\0'), tiff]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}
