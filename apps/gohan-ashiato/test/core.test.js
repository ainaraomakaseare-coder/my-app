/*
 * ごはんの足跡の計算部分（core.js）のテスト。
 * 実行: node test/core.test.js
 */
const C = require('../core.js');

let pass = 0, fail = 0;
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) pass++;
  else { fail++; console.log('NG  ' + label + '\n    got:  ' + a + '\n    want: ' + b); }
}

// ---- 値段 ----
eq('値段: 数字', C.parsePrice('1200'), 1200);
eq('値段: カンマと円', C.parsePrice('1,200円'), 1200);
eq('値段: ¥と全角', C.parsePrice('¥１５００'), 1500);
eq('値段: 空', C.parsePrice(''), null);
eq('値段: 文字', C.parsePrice('たくさん'), null);
eq('値段: 0円', C.parsePrice('0'), 0);
eq('値段: マイナス', C.parsePrice('-5'), null);
eq('値段: 大きすぎ', C.parsePrice('99999999'), null);
eq('値段の表示', C.formatYen(12345), '¥12,345');

// ---- 時間帯 ----
eq('7時は朝', C.guessMeal('07:30'), 'breakfast');
eq('12時は昼', C.guessMeal('12:00'), 'lunch');
eq('15時はおやつ', C.guessMeal('15:10'), 'snack');
eq('19時は夜', C.guessMeal('19:00'), 'dinner');
eq('深夜2時は夜', C.guessMeal('02:00'), 'dinner');
eq('時刻なし', C.guessMeal(''), '');

// ---- 正規化・入力チェック ----
const now = new Date('2026-10-28T10:00:00Z');
const r1 = C.normalizeRecord({ date: '2026-10-28', time: '12:30', name: ' ラーメン ', place: '一蘭', price: '980円', rating: '4', meal: 'lunch', lat: 35.1, lng: 139.2 }, now);
eq('正規化: 名前の空白', r1.name, 'ラーメン');
eq('正規化: 値段', r1.price, 980);
eq('正規化: 評価', r1.rating, 4);
eq('正規化: 位置', [r1.lat, r1.lng], [35.1, 139.2]);
eq('正規化: 作成日時', r1.createdAt, '2026-10-28T10:00:00.000Z');
const bad = C.normalizeRecord({ date: '2026-02-30', time: '25:00', rating: 9, meal: 'x', lat: 0, lng: 0 }, now);
eq('正規化: ありえない日付・時刻・評価・区分・0,0', [bad.date, bad.time, bad.rating, bad.meal, bad.lat], ['', '', 0, '', null]);
eq('チェック: OK', C.validateRecord(r1, '980円'), []);
eq('チェック: 日付と名前がない', C.validateRecord(bad), ['日付を入れてください', '料理の名前か写真のどちらかを入れてください']);
eq('チェック: 写真だけでもOK', C.validateRecord(C.normalizeRecord({ date: '2026-10-01', photoIds: ['p1'] })), []);
eq('チェック: 値段が読めない', C.validateRecord(C.normalizeRecord({ date: '2026-10-01', name: 'x', price: 'abc' }), 'abc'), ['値段は数字で入れてください']);

// ---- 並べ替え・絞り込み ----
const list = [
  { id: 'a', date: '2026-10-01', time: '12:00', name: 'カレー', place: 'ココイチ', memo: '', price: 900, rating: 3, meal: 'lunch', createdAt: '1' },
  { id: 'b', date: '2026-10-01', time: '19:00', name: '焼肉', place: '叙々苑', memo: '記念日', price: 8000, rating: 5, meal: 'dinner', createdAt: '2' },
  { id: 'c', date: '2026-09-20', time: '', name: 'パン', place: '', memo: '', price: null, rating: 0, meal: 'breakfast', createdAt: '3' },
  { id: 'd', date: '2026-10-05', time: '', name: 'カレーうどん', place: 'ココイチ ', memo: '', price: 1100, rating: 4, meal: 'lunch', createdAt: '4' }
];
const ids = a => a.map(r => r.id);
eq('新しい順（時刻なしは同じ日の後ろ）', ids(C.sortRecords(list, 'new')), ['d', 'b', 'a', 'c']);
eq('古い順', ids(C.sortRecords(list, 'old')), ['c', 'a', 'b', 'd']);
eq('評価順（評価なしは最後）', ids(C.sortRecords(list, 'rating')), ['b', 'd', 'a', 'c']);
eq('高い順（値段なしは最後）', ids(C.sortRecords(list, 'priceHigh')), ['b', 'd', 'a', 'c']);
eq('安い順（値段なしは最後）', ids(C.sortRecords(list, 'priceLow')), ['a', 'd', 'b', 'c']);
eq('元の配列は変えない', ids(list), ['a', 'b', 'c', 'd']);
eq('検索: カレー', ids(C.filterRecords(list, { q: 'カレー' })), ['a', 'd']);
eq('検索: 2語', ids(C.filterRecords(list, { q: 'カレー うどん' })), ['d']);
eq('検索: メモ', ids(C.filterRecords(list, { q: '記念日' })), ['b']);
eq('★4以上', ids(C.filterRecords(list, { minRating: 4 })), ['b', 'd']);
eq('区分: 昼', ids(C.filterRecords(list, { meal: 'lunch' })), ['a', 'd']);
eq('月: 9月', ids(C.filterRecords(list, { month: '2026-09' })), ['c']);

// ---- 集計 ----
eq('集計', C.summarize(list), { count: 4, total: 10000, priced: 3, avgRating: 4 });
eq('集計: 空', C.summarize([]), { count: 0, total: 0, priced: 0, avgRating: 0 });
const groups = C.groupByMonth(C.sortRecords(list, 'new'));
eq('月ごと: 見出し', groups.map(g => g.label), ['2026年10月', '2026年9月']);
eq('月ごと: 10月の合計', groups[0].summary.total, 10000);
const ps = C.placeStats(list);
eq('お店: よく行く順・表記ゆれ', ps.map(p => [p.place, p.count, p.total, p.avgRating, p.last]), [['ココイチ', 2, 2000, 3.5, '2026-10-05'], ['叙々苑', 1, 8000, 5, '2026-10-01']]);

// ---- 地図・日付表示 ----
eq('地図: 位置', C.mapsUrl({ lat: 35.5, lng: 139.5, place: 'x' }), 'https://www.google.com/maps/search/?api=1&query=35.5,139.5');
eq('地図: 名前', C.mapsUrl({ lat: null, lng: null, place: '一蘭 渋谷' }), 'https://www.google.com/maps/search/?api=1&query=%E4%B8%80%E8%98%AD%20%E6%B8%8B%E8%B0%B7');
eq('地図: なし', C.mapsUrl({ lat: null, lng: null, place: '' }), '');
eq('日付表示', C.formatDateJa('2026-10-28'), '10月28日(水)');

// ---- 書き出し・読み込み ----
const backup = { app: 'gohan-ashiato', version: 1, records: [r1, { date: 'bad' }], photos: { p1: 'data:image/jpeg;base64,AAAA', p2: 'javascript:alert(1)' } };
const parsed = C.parseBackup(JSON.stringify(backup));
eq('読み込み: 日付のない記録は捨てる', parsed.records.length, 1);
eq('読み込み: 画像以外は捨てる', Object.keys(parsed.photos), ['p1']);
let threw = false;
try { C.parseBackup('{"records":[]}'); } catch (e) { threw = true; }
eq('読み込み: ほかのファイルは断る', threw, true);
const cur = [{ id: 'x', updatedAt: '2026-10-01' }, { id: 'y', updatedAt: '2026-10-05' }];
const merged = C.mergeRecords(cur, [{ id: 'x', updatedAt: '2026-10-02', v: 2 }, { id: 'y', updatedAt: '2026-10-01', v: 2 }, { id: 'z', updatedAt: '2026-10-01' }]);
eq('まぜる: 件数', [merged.added, merged.updated, merged.records.length], [1, 1, 3]);
eq('まぜる: 新しいほうを残す', merged.records.map(r => r.v || 1), [2, 1, 1]);

// ---- Exif ----
eq('Exif日時', C.exifDateTime('2026:10:20 14:23:11'), '2026-10-20T14:23');
eq('Exif日時: 0000', C.exifDateTime('0000:00:00 00:00:00'), '');

eq('iPhoneアプリのexif.GPS', C.exifGps({ Latitude: 35.68, LatitudeRef: 'N', Longitude: 139.76, LongitudeRef: 'E' }), { lat: 35.68, lng: 139.76 });
eq('iPhoneアプリのexif.GPS: 南・西', C.exifGps({ Latitude: 33.9, LatitudeRef: 'S', Longitude: 151.2, LongitudeRef: 'W' }), { lat: -33.9, lng: -151.2 });
eq('iPhoneアプリのexif.GPS: なし', C.exifGps(undefined), null);

// 撮影日時とGPS（北緯35.5度・東経139.75度）入りの小さなJPEGを組み立てる
function makeExifJpeg() {
  const entries0 = 2, exifEntries = 1, gpsEntries = 4;
  const ifd0 = 8, ifd0Size = 2 + entries0 * 12 + 4;
  const exifIfd = ifd0 + ifd0Size, exifSize = 2 + exifEntries * 12 + 4;
  const gpsIfd = exifIfd + exifSize, gpsSize = 2 + gpsEntries * 12 + 4;
  const dateOff = gpsIfd + gpsSize, latOff = dateOff + 20, lngOff = latOff + 24;
  const tiff = Buffer.alloc(lngOff + 24);
  tiff.write('II', 0); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(ifd0, 4);
  function entry(at, tag, type, count, value) { tiff.writeUInt16LE(tag, at); tiff.writeUInt16LE(type, at + 2); tiff.writeUInt32LE(count, at + 4); tiff.writeUInt32LE(value, at + 8); }
  tiff.writeUInt16LE(entries0, ifd0);
  entry(ifd0 + 2, 0x8769, 4, 1, exifIfd);
  entry(ifd0 + 14, 0x8825, 4, 1, gpsIfd);
  tiff.writeUInt16LE(exifEntries, exifIfd);
  entry(exifIfd + 2, 0x9003, 2, 20, dateOff);
  tiff.write('2026:10:27 19:05:00\0', dateOff, 'latin1');
  tiff.writeUInt16LE(gpsEntries, gpsIfd);
  entry(gpsIfd + 2, 1, 2, 2, 'N'.charCodeAt(0));
  entry(gpsIfd + 14, 2, 5, 3, latOff);
  entry(gpsIfd + 26, 3, 2, 2, 'E'.charCodeAt(0));
  entry(gpsIfd + 38, 4, 5, 3, lngOff);
  [[35, 1], [30, 1], [0, 1]].forEach(([n, d], i) => { tiff.writeUInt32LE(n, latOff + i * 8); tiff.writeUInt32LE(d, latOff + i * 8 + 4); });
  [[139, 1], [45, 1], [0, 1]].forEach(([n, d], i) => { tiff.writeUInt32LE(n, lngOff + i * 8); tiff.writeUInt32LE(d, lngOff + i * 8 + 4); });
  const app1 = Buffer.concat([Buffer.from([0xFF, 0xE1, 0, 0]), Buffer.from('Exif\0\0', 'latin1'), tiff]);
  app1.writeUInt16BE(app1.length - 2, 2);
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), app1, Buffer.from([0xFF, 0xDA, 0, 2, 0xFF, 0xD9])]);
}
const jpg = makeExifJpeg();
const ab = jpg.buffer.slice(jpg.byteOffset, jpg.byteOffset + jpg.length);
eq('JPEGのExif', C.jpegExif(ab), { gps: { lat: 35.5, lng: 139.75 }, takenAt: '2026-10-27T19:05' });
eq('JPEGでないファイル', C.jpegExif(new Uint8Array([1, 2, 3, 4]).buffer), { gps: null, takenAt: '' });

// ---- 行きたい場所 ----
const w1 = C.normalizeWant({ name: ' らぁめん千寿 ', lat: 35.7, lng: 139.77, tv: { program: 'かまいまち', aired: '2026-10-29' } }, new Date('2026-10-29T12:00:00Z'));
eq('行きたい: 名前の空白を取る', w1.name, 'らぁめん千寿');
eq('行きたい: 位置', [w1.lat, w1.lng], [35.7, 139.77]);
eq('行きたい: テレビの情報', w1.tv, { program: 'かまいまち', aired: '2026-10-29' });
eq('行きたい: idがつく', /^w_/.test(w1.id), true);
eq('行きたい: テレビの情報が空ならnull', C.normalizeWant({ name: 'a', tv: { program: ' ', aired: 'x' } }).tv, null);
eq('行きたい: 名前は必須', C.validateWant(C.normalizeWant({ name: '' })), ['お店・場所の名前を入れてください']);
eq('行きたい: 名前があれば保存できる', C.validateWant(w1), []);

// ---- テレビの店のリスト ----
const shops = C.parseTvShops({ shops: [
  { id: 'a', name: 'A店', address: '東京都台東区上野4-2-5', appearances: [{ program: '番組X', aired: '2026-01-02', url: 'https://example.com/x' }, { program: '番組Y', aired: '2026-03-04', url: 'http://insecure' }] },
  { id: 'b', name: 'B店', lat: 35.0, lng: 139.0, appearances: [{ program: '番組X', aired: '2025-12-01' }], links: [{ label: '公式', url: 'https://b.example' }, { label: 'x', url: 'javascript:alert(1)' }] },
  { id: 'a', name: '同じid', appearances: [{ program: 'Z' }] },
  { id: 'c', name: '出演なし', appearances: [] },
  { name: 'idなし', appearances: [{ program: 'Z' }] }
] });
eq('テレビの店: 使えるものだけ・同じidは最初だけ', shops.map(s => s.id), ['a', 'b']);
eq('テレビの店: 出演は新しい順', shops[0].appearances.map(a => a.program), ['番組Y', '番組X']);
eq('テレビの店: httpsでないURLは捨てる', shops[0].appearances[0].url, '');
eq('テレビの店: 最後の放送日', shops[0].lastAired, '2026-03-04');
eq('テレビの店: 危ないリンクは捨てる', shops[1].links, [{ label: '公式', url: 'https://b.example' }]);
eq('テレビの店: 位置が無ければnull', [shops[0].lat, shops[1].lat], [null, 35]);
eq('番組ごとの数', C.tvPrograms(shops), [{ program: '番組X', count: 2 }, { program: '番組Y', count: 1 }]);
const real = C.parseTvShops(require('fs').readFileSync(require('path').join(__dirname, '..', 'tv-shops.json'), 'utf8'));
eq('同梱のリストが読める', real.length >= 1 && real.every(s => s.appearances.length && s.address), true);

// ---- 距離・近い順 ----
eq('距離: 東京駅→御徒町駅 約3km', Math.round(C.distanceM({ lat: 35.6812, lng: 139.7671 }, { lat: 35.7075, lng: 139.7747 }) / 100), 30);
eq('距離: 位置なし', C.distanceM({ lat: 35, lng: 139 }, { lat: null, lng: null }), null);
eq('距離の表示', [C.formatDistance(850), C.formatDistance(2345), C.formatDistance(23456)], ['850m', '2.3km', '23km']);
eq('近い順（位置なしは後ろ）', C.sortByDistance([{ n: 'far', lat: 35.1, lng: 139 }, { n: 'none', lat: null }, { n: 'near', lat: 35.01, lng: 139 }], { lat: 35, lng: 139 }).map(x => x.n), ['near', 'far', 'none']);

// ---- 行ったかどうか ----
const recs = [
  C.normalizeRecord({ id: 'r1', date: '2026-10-30', name: '味噌', place: 'らぁめん千寿' }),
  C.normalizeRecord({ id: 'r2', date: '2026-10-30', name: 'カレー', place: 'ココイチ' }),
  C.normalizeRecord({ id: 'r3', date: '2026-10-30', name: '名無し', lat: 35.70001, lng: 139.77001 }),
  C.normalizeRecord({ id: 'r4', date: '2026-10-30', name: '隣の店', place: '別の店', lat: 35.70001, lng: 139.77001 })
];
eq('名前の比べ方: 全角半角と空白', C.nameKey('ＡＢＣ　食堂'), 'abc食堂');
eq('行った: 名前が含まれる・名前なしで近い記録', C.visitsOf({ name: 'らぁめん千寿 御徒町店', lat: 35.7, lng: 139.77 }, recs).map(r => r.id), ['r1', 'r3']);
eq('行った: 違う名前は近くても数えない', C.visitsOf({ name: 'ココイチ 渋谷店', lat: null, lng: null }, recs).map(r => r.id), ['r2']);
eq('行った: 1文字の名前では比べない', C.visitsOf({ name: 'ら', lat: null, lng: null }, recs).length, 0);

// ---- 書き出しファイルの行きたい場所 ----
const bk = C.parseBackup({ app: 'gohan-ashiato', records: [], wants: [{ id: 'w1', name: 'X', updatedAt: '2026-01-01T00:00:00Z' }, { name: '' }] });
eq('書き出し: 行きたい場所も読む', bk.wants.map(w => [w.id, w.updatedAt]), [['w1', '2026-01-01T00:00:00Z']]);
eq('書き出し: 行きたい場所が無い古いファイル', C.parseBackup({ app: 'gohan-ashiato', records: [] }).wants, []);

console.log((fail ? 'FAILED ' : 'OK ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
