/*
 * 実ブラウザ（iPhoneくらいの画面）で、記録の登録（写真の撮影日時・場所の自動入力）・入力チェック・
 * 一覧の検索/絞り込み/並べ替え/写真表示・お店ごとの集計・詳細・編集・削除・再読み込み後の保存・
 * 書き出し/読み込みの流れを確かめる。
 * 実行: node test/ui.smoke.js [スクリーンショットの保存先フォルダ]
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || '';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log('NG  ' + label + (extra !== undefined ? '\n    ' + extra : '')); }
}

(async () => {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
    if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
    res.end(fs.readFileSync(p));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const URL = 'http://127.0.0.1:' + server.address().port + '/';

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ja-JP', acceptDownloads: true });
  // 近くのお店（旅の足跡のWorker）は本物を呼ばずに決まった答えを返す
  const nearbyCalls = [];
  await ctx.route('https://tabilog-api.hiroya-apps.workers.dev/**', route => {
    nearbyCalls.push(route.request().url());
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ found: true, places: [{ name: 'ココイチ 渋谷店', types: ['restaurant'] }, { name: '一蘭 渋谷店', types: ['ramen_restaurant'] }] }) });
  });
  // 住所から位置を調べる（国土地理院）も本物を呼ばない
  await ctx.route('https://msearch.gsi.go.jp/**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '[]' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  const shot = async name => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); };

  await page.goto(URL);
  check('はじめは空の案内', (await page.textContent('#records')).includes('まだ記録がありません'));

  // ---- 1件目：写真から日時と場所が入る ----
  await page.click('.fab'); await page.waitForSelector('#screen-edit:not([hidden])');
  check('登録画面が開く', await page.textContent('#edit-title') === '記録する');
  await page.setInputFiles('#photo-input', path.join(__dirname, 'fixtures', 'curry.jpg'));
  await page.waitForSelector('.photo-item img[src^="blob:"]');
  check('写真の撮影日が入る', await page.inputValue('#f-date') === '2026-10-27', await page.inputValue('#f-date'));
  check('写真の撮影時刻が入る', await page.inputValue('#f-time') === '19:05');
  check('時刻から「夜」', await page.textContent('#f-meal .chip.on') === '夜');
  check('写真の撮影場所', (await page.textContent('#f-loc-state')).includes('写真の撮影場所'));
  check('ブラウザでは「撮る」は出さない', await page.isHidden('#photo-camera'));
  await page.waitForSelector('#f-shops [data-shop]');
  check('近くのお店を位置で探す', /kind=food/.test(nearbyCalls[0] || '') && /lat=35\.658333&lng=139\.7/.test(nearbyCalls[0] || ''), nearbyCalls[0]);
  check('お店の候補', (await page.$$eval('#f-shops [data-shop]', b => b.map(x => x.textContent))).join('/') === 'ココイチ 渋谷店/一蘭 渋谷店');
  await page.click('#f-shops [data-shop="ココイチ 渋谷店"]');
  check('候補をタップで店名', await page.inputValue('#f-place') === 'ココイチ 渋谷店');
  check('選んだ候補に印', await page.getAttribute('#f-shops [data-shop="ココイチ 渋谷店"]', 'class') === 'chip on');
  await shot('shops');
  await page.fill('#f-name', 'カツカレー');
  await page.fill('#f-price', '1,200');
  await page.click('#f-rating [data-star="4"]');
  await page.fill('#f-memo', 'ロースカツ、辛さ3');
  await shot('edit');
  await page.click('#save-btn');
  await page.waitForSelector('#screen-list:not([hidden])');
  check('一覧に出る', (await page.textContent('#records')).includes('カツカレー'));
  check('一覧に値段', (await page.textContent('#records')).includes('¥1,200'));
  check('一覧の写真', await page.$eval('.rec img.thumb', i => i.complete && i.naturalWidth > 0).catch(() => false));

  // ---- 入力チェック ----
  await page.click('.fab'); await page.waitForSelector('#screen-edit:not([hidden])');
  await page.click('#save-btn');
  check('名前も写真もないと保存できない', (await page.textContent('#form-error')).includes('料理の名前か写真'));
  await page.fill('#f-name', 'カレーうどん');
  await page.fill('#f-price', 'たかい');
  await page.click('#save-btn');
  check('値段が数字でないと保存できない', (await page.textContent('#form-error')).includes('値段は数字'));
  // ---- 2件目・3件目 ----
  await page.fill('#f-price', '900');
  await page.fill('#f-date', '2026-10-20');
  // 時刻の初期値は今の時刻なので、時間帯が実行する時間で変わらないよう決めておく
  await page.fill('#f-time', '18:30');
  await page.dispatchEvent('#f-time', 'change');
  await page.fill('#f-place', 'ココイチ  渋谷店 ');
  await page.click('#f-rating [data-star="2"]');
  await page.click('#save-btn');
  await page.waitForSelector('#screen-list:not([hidden])');
  await page.click('.fab'); await page.waitForSelector('#screen-edit:not([hidden])');
  await page.fill('#f-name', '塩パン');
  await page.fill('#f-date', '2026-09-10');
  await page.fill('#f-time', '08:00');
  await page.dispatchEvent('#f-time', 'change');
  check('朝の時刻で「朝」', await page.textContent('#f-meal .chip.on') === '朝');
  await page.click('#save-btn');
  await page.waitForSelector('#screen-list:not([hidden])');

  const names = async () => page.$$eval('#records .rec-name', els => els.map(e => e.textContent));
  check('新しい順', JSON.stringify(await names()) === JSON.stringify(['カツカレー', 'カレーうどん', '塩パン']), await names());
  check('月の見出し', JSON.stringify(await page.$$eval('.month-head h2', e => e.map(x => x.textContent))) === '["2026年10月","2026年9月"]');
  check('月の合計', (await page.textContent('.month-head span')).includes('¥2,100'));
  await shot('list');

  await page.fill('#q', 'カレー');
  check('検索', (await names()).length === 2);
  await page.fill('#q', '');
  await page.click('#filter-chips [data-f="r4"]');
  check('★4以上', JSON.stringify(await names()) === '["カツカレー"]');
  await page.click('#filter-chips [data-f="r4"]');
  await page.click('#filter-chips [data-v="breakfast"]');
  check('朝で絞り込み', JSON.stringify(await names()) === '["塩パン"]');
  await page.click('#filter-chips [data-v="breakfast"]');
  await page.selectOption('#sort', 'priceLow');
  check('安い順（値段なしは最後）', JSON.stringify(await names()) === '["カレーうどん","カツカレー","塩パン"]', await names());
  await page.selectOption('#sort', 'new');
  await page.click('#view-toggle');
  check('写真で並べる', (await page.$$('.grid a')).length === 3);
  await shot('grid');
  await page.click('#view-toggle');

  // ---- お店 ----
  await page.click('.seg-btn[data-tab="places"]');
  const placeText = await page.textContent('#places');
  check('お店ごと（空白の違いはまとめる）', (await page.$$('.place')).length === 1 && placeText.includes('2回') && placeText.includes('★3.0'), placeText);
  await shot('places');
  await page.click('.place');
  check('お店から記録を絞り込み', (await names()).length === 2 && await page.inputValue('#q') === 'ココイチ 渋谷店');
  await page.fill('#q', ''); await page.dispatchEvent('#q', 'input');

  // ---- 詳細・編集 ----
  await page.click('.rec >> text=カツカレー');
  await page.waitForSelector('#screen-detail:not([hidden])');
  await page.waitForFunction(() => { const i = document.querySelector('.detail-photos img'); return i && i.complete && i.naturalWidth > 0; });
  check('詳細の地図リンク（写真の位置）', (await page.getAttribute('.map-link', 'href')).includes('35.658333,139.7'));
  check('同じお店のほかの記録', (await page.textContent('.same-place')).includes('カレーうどん'));
  check('メモ', (await page.textContent('#detail')).includes('辛さ3'));
  await shot('detail');
  await page.click('#detail-edit'); await page.waitForSelector('#screen-edit:not([hidden])');
  check('編集に元の値', await page.inputValue('#f-price') === '1200');
  await page.fill('#f-price', '1350');
  await page.click('#save-btn');
  await page.waitForSelector('#screen-detail:not([hidden])');
  check('編集が反映', (await page.textContent('#detail')).includes('¥1,350'));

  // ---- 再読み込みしても残る ----
  await page.goto(URL);
  check('再読み込み後も3件', (await names()).length === 3);
  await page.waitForFunction(() => { const i = document.querySelector('.rec img.thumb'); return i && i.complete && i.naturalWidth > 0; });

  // ---- 書き出し → 削除 → 読み込み ----
  await page.goto(URL + '#/settings');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
  const file = await dl.path();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('書き出しに3件と写真1枚', data.records.length === 3 && Object.keys(data.photos).length === 1);
  await page.goto(URL);
  await page.click('.rec >> text=カツカレー');
  await page.click('#detail-edit'); await page.waitForSelector('#screen-edit:not([hidden])');
  await page.click('#delete-btn');
  await page.waitForSelector('#screen-list:not([hidden])');
  check('削除', (await names()).length === 2, await names());
  const photoCount = () => page.evaluate(() => new Promise(r => { const q = indexedDB.open('gohan-ashiato-photos'); q.onsuccess = () => { const c = q.result.transaction('photos').objectStore('photos').count(); c.onsuccess = () => r(c.result); }; }));
  check('削除で写真も消える', await photoCount() === 0);
  await page.goto(URL + '#/settings');
  await page.setInputFiles('#import-input', file);
  await page.waitForFunction(() => document.getElementById('backup-status').textContent.includes('読み込みました'));
  check('読み込み（追加1件）', (await page.textContent('#backup-status')).includes('追加1件'));
  await page.goto(URL);
  check('読み込み後3件', (await names()).length === 3);
  await page.waitForFunction(() => { const i = document.querySelector('.rec img.thumb'); return i && i.complete && i.naturalWidth > 0; });

  // ---- 編集をやめたら足した写真は残らない ----
  await page.click('.fab'); await page.waitForSelector('#screen-edit:not([hidden])');
  await page.setInputFiles('#photo-input', path.join(__dirname, 'fixtures', 'curry.jpg'));
  await page.waitForSelector('.photo-item img[src^="blob:"]');
  await page.click('#edit-cancel');
  await page.waitForSelector('#screen-list:not([hidden])');
  await page.waitForTimeout(200);
  check('やめたら写真を消す', await photoCount() === 1);


  // ---- 行きたい場所・テレビの店：一覧と地図、テレビの店から行きたいに足す、行った記録をつける ----
  const sctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ja-JP', geolocation: { latitude: 35.6812, longitude: 139.7671 }, permissions: ['geolocation'] });
  const apiCalls = [];
  await sctx.route('https://tabilog-api.hiroya-apps.workers.dev/**', route => {
    const u = new globalThis.URL(route.request().url());
    apiCalls.push(u.pathname + u.search);
    const body = u.pathname === '/places/search' ? { places: [{ name: '神田まつや', address: '東京都千代田区', placeId: 'ChIJ_test_place_id_1' }] }
      : u.pathname === '/places/details' ? { found: true, name: '神田まつや', address: '東京都千代田区神田須田町1-13', lat: 35.6957, lng: 139.7703 }
      : { found: true, places: [{ name: 'らぁめん千寿 御徒町店', types: ['restaurant'] }] };
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  const gsiCalls = [];
  await sctx.route('https://msearch.gsi.go.jp/**', route => {
    gsiCalls.push(decodeURIComponent(route.request().url()));
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify([{ geometry: { coordinates: [139.7745, 35.7078], type: 'Point' }, properties: { title: '東京都台東区上野四丁目' } }]) });
  });
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await sctx.route('https://tile.openstreetmap.org/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  // テレビの店は、本物のリスト（数百店）ではなく1店だけのリストで確かめる
  await sctx.route(URL + 'tv-shops.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: fs.readFileSync(path.join(__dirname, 'fixtures', 'tv-shops.json')) }));
  const sp = await sctx.newPage();
  sp.on('pageerror', e => errors.push('spots: ' + e.message));
  sp.on('dialog', d => d.accept());
  const sshot = async name => { if (SHOTS) await sp.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); };
  await sp.goto(URL);
  await sp.click('.seg-btn[data-tab="wants"]');
  check('行きたい: はじめは案内', (await sp.textContent('#wants')).includes('行きたいお店や場所'));

  await sp.click('.seg-btn[data-tab="tv"]');
  await sp.waitForSelector('#tv .spot');
  check('テレビ: 同梱のお店が出る', (await sp.textContent('#tv')).includes('らぁめん千寿 御徒町店'));
  check('テレビ: 番組で絞り込むチップ', (await sp.textContent('#tv-chips')).includes('かまいまち'));
  await sp.waitForFunction(() => !document.querySelector('#tv .badge.nopos'));
  check('テレビ: 住所から位置を調べる（建物名は外す）', gsiCalls.length === 1 && gsiCalls[0].endsWith('上野4-2-5'), gsiCalls.join(','));
  await sp.click('#tab-tv [data-near]');
  await sp.waitForSelector('#tv .spot-dist');
  check('テレビ: 近い順で距離が出る', /km$/.test(await sp.textContent('#tv .spot-dist')), await sp.textContent('#tv .spot-dist'));
  await sp.click('[data-mapview="tv"]');
  await sp.waitForSelector('#tv-map .leaflet-interactive');
  check('テレビ: 地図にピン（お店＋現在地）', await sp.locator('#tv-map path.leaflet-interactive').count() === 2);
  await sshot('31-tv-map');

  await sp.click('#tv .spot');
  await sp.waitForSelector('#screen-spot:not([hidden])');
  const spotText = await sp.textContent('#spot');
  check('テレビの店の詳細: 番組・放送日・リンク', spotText.includes('かまいまち') && spotText.includes('10月29日') && spotText.includes('お店の公式サイト'));
  check('テレビの店の詳細: 編集ボタンは出さない', await sp.isHidden('#spot-edit'));
  await sp.click('#spot-want');
  await sp.waitForFunction(() => document.getElementById('spot-want').textContent.includes('入っています'));
  await sshot('32-tv-detail');

  // 行った記録をつける → お店と位置が入る → 保存すると詳細に戻り「行った」
  await sp.click('#spot .primary-btn');
  await sp.waitForSelector('#screen-edit:not([hidden])');
  check('記録: お店の名前が入る', await sp.inputValue('#f-place') === 'らぁめん千寿 御徒町店');
  check('記録: 位置も入る', (await sp.textContent('#f-loc-state')).includes('位置を記録済み'));
  await sp.fill('#f-name', '特製味そらぁめん');
  await sp.click('#save-btn');
  await sp.waitForSelector('#screen-spot:not([hidden])');
  check('記録: 保存したらお店の詳細に戻り、行った記録が出る', (await sp.textContent('#spot')).includes('行った記録（1回）'));

  // 行きたい場所を自分で探して足す
  await sp.goto(URL + '#/w/new');
  await sp.waitForSelector('#screen-want-edit:not([hidden])');
  await sp.click('#want-form button[type=submit]');
  check('行きたい: 名前は必須', (await sp.textContent('#want-error')).includes('名前'));
  await sp.fill('#w-search', 'まつや 神田');
  await sp.click('#w-search-btn');
  await sp.waitForSelector('#w-candidates [data-cand]');
  await sp.click('#w-candidates [data-cand]');
  await sp.waitForFunction(() => document.getElementById('w-loc-state').textContent.includes('探したお店の位置'));
  check('行きたい: 候補を選ぶと名前・住所・位置', await sp.inputValue('#w-name') === '神田まつや' && (await sp.inputValue('#w-address')).includes('須田町'));
  check('行きたい: 検索と詳細は同じセッション', apiCalls.some(c => c.startsWith('/places/search?q=')) && apiCalls.some(c => c.startsWith('/places/details?id=ChIJ_test_place_id_1&session=')));
  await sp.fill('#w-program', 'そばの番組');
  await sp.fill('#w-memo', '天ぷらそば');
  await sp.click('#want-form button[type=submit]');
  await sp.waitForSelector('#screen-list:not([hidden])');
  check('行きたい: 足したら行きたいタブ', await sp.isVisible('#tab-wants'));
  const wantsText = await sp.textContent('#wants');
  check('行きたい: 自分で足した場所とテレビの店が並ぶ', wantsText.includes('神田まつや') && wantsText.includes('らぁめん千寿'));
  check('行きたい: 行ったお店に印', (await sp.locator('#wants .spot:has-text("らぁめん千寿") .badge.went').count()) === 1);
  await sp.click('#wants-chips [data-spot-f="notyet"]');
  check('行きたい: まだ行ってないだけ', (await sp.locator('#wants .spot').count()) === 1 && (await sp.textContent('#wants')).includes('神田まつや'));
  await sp.click('#wants-chips [data-spot-f="notyet"]');
  await sp.click('[data-mapview="wants"]');
  await sp.waitForSelector('#wants-map .leaflet-interactive');
  check('行きたい: 地図に2か所＋現在地（近い順はタブをまたいで続く）', await sp.locator('#wants-map path.leaflet-interactive').count() === 3);
  await sshot('33-wants-map');

  // 詳細 → 直す → 外す
  await sp.click('#wants .spot:has-text("神田まつや")');
  await sp.waitForSelector('#screen-spot:not([hidden])');
  check('行きたいの詳細: メモとテレビ', (await sp.textContent('#spot')).includes('天ぷらそば') && (await sp.textContent('#spot')).includes('そばの番組'));
  await sp.click('#spot-edit');
  await sp.waitForSelector('#screen-want-edit:not([hidden])');
  check('直す: 前の内容が入っている', await sp.inputValue('#w-memo') === '天ぷらそば');

  // 書き出しに行きたい場所も入る
  await sp.goto(URL + '#/settings');
  const [sdl] = await Promise.all([sp.waitForEvent('download'), sp.click('#export-btn')]);
  check('書き出しに行きたい場所2件', JSON.parse(fs.readFileSync(await sdl.path(), 'utf8')).wants.length === 2);
  await sp.goto(URL + '#/w/' + encodeURIComponent((await sp.evaluate(() => JSON.parse(localStorage.getItem('gohan-ashiato.wants.v1')).find(w => w.name === '神田まつや').id))) + '/edit');
  await sp.waitForSelector('#screen-want-edit:not([hidden])');
  await sp.click('#want-delete');
  await sp.waitForSelector('#screen-list:not([hidden])');
  check('外す', (await sp.evaluate(() => JSON.parse(localStorage.getItem('gohan-ashiato.wants.v1')).length)) === 1);
  await sctx.close();


  // ---- iPhoneアプリ（Capacitor）：Cameraプラグインのexifから日時と位置、書き出しは共有メニュー ----
  const nctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ja-JP' });
  await nctx.route('https://tabilog-api.hiroya-apps.workers.dev/**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"found":true,"places":[{"name":"松屋","types":["restaurant"]}]}' }));
  // 住所から位置を調べる（国土地理院）も本物を呼ばない
  await nctx.route('https://msearch.gsi.go.jp/**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '[]' }));
  // アプリはWeb版（GitHub Pages）のテレビの店のリストを先に読む
  await nctx.route('https://ainaraomakaseare-coder.github.io/**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ shops: [{ id: 'remote-1', name: 'ネットから来た店', address: '東京都千代田区丸の内1-9-1', lat: 35.68, lng: 139.76, appearances: [{ program: '新しい番組', aired: '2026-11-01' }] }] }) }));
  await nctx.addInitScript(() => {
    window.__shared = [];
    window.Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        Camera: {
          pickImages: async () => ({ photos: [{ webPath: '/test/fixtures/curry.jpg', exif: { DateTimeOriginal: '2026:10:01 12:15:00', GPS: { Latitude: 34.7, LatitudeRef: 'N', Longitude: 135.5, LongitudeRef: 'E' } } }] }),
          getPhoto: async () => { throw new Error('User cancelled photos app'); }
        },
        Filesystem: { writeFile: async o => { window.__written = o; return { uri: 'file:///cache/' + o.path }; } },
        Share: { share: async o => { window.__shared.push(o); return {}; } }
      }
    };
  });
  const np = await nctx.newPage();
  np.on('pageerror', e => errors.push('native: ' + e.message));
  await np.goto(URL + '#/new');
  await np.waitForSelector('#screen-edit:not([hidden])');
  check('アプリでは「撮る」を出す', await np.isVisible('#photo-camera'));
  await np.click('#photo-pick');
  await np.waitForSelector('.photo-item img[src^="blob:"]');
  check('アプリ: exifの撮影日時', await np.inputValue('#f-date') === '2026-10-01' && await np.inputValue('#f-time') === '12:15');
  check('アプリ: exifの位置', (await np.textContent('#f-loc-state')).includes('写真の撮影場所'));
  await np.waitForSelector('#f-shops [data-shop]');
  await np.click('#f-shops [data-shop]');
  await np.click('#save-btn');
  await np.waitForSelector('#screen-list:not([hidden])');
  check('アプリ: 保存', (await np.textContent('#records')).includes('松屋'));
  await np.click('.seg-btn[data-tab="tv"]');
  await np.waitForSelector('#tv .spot');
  check('アプリ: テレビの店はネットのリストを読む', (await np.textContent('#tv')).includes('ネットから来た店') && !(await np.textContent('#tv')).includes('らぁめん千寿'));
  check('アプリ: 読めたリストを端末に覚える', await np.evaluate(() => !!localStorage.getItem('gohan-ashiato.tvshops.v1')));
  await np.goto(URL + '#/settings');
  await np.click('#export-btn');
  await np.waitForFunction(() => window.__shared.length === 1);
  const written = await np.evaluate(() => window.__written);
  check('アプリ: 書き出しはファイル→共有', written.directory === 'CACHE' && JSON.parse(written.data).records.length === 1 && (await np.evaluate(() => window.__shared[0].files[0])).endsWith('.json'));
  await nctx.close();

  check('JSのエラーなし', errors.length === 0, errors.join('\n'));
  await browser.close();
  server.close();
  console.log((fail ? 'FAILED ' : 'OK ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
