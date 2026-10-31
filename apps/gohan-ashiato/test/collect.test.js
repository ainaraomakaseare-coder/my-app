/*
 * テレビの店を集めるスクリプト（scripts/collect-tv-shops.mjs）の解析部分のテスト。
 * 番組の公式ページの形を写した断片（test/fixtures/tvsites/）で確かめる。通信はしない。
 * 実行: node test/collect.test.js
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const FX = path.join(__dirname, 'fixtures', 'tvsites');
const read = f => fs.readFileSync(path.join(FX, f), 'utf8');

let pass = 0, fail = 0;
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) pass++;
  else { fail++; console.log('NG  ' + label + '\n    got:  ' + a + '\n    want: ' + b); }
}

(async () => {
  const C = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'collect-tv-shops.mjs')).href);

  // ---- 酒場放浪記の店リスト ----
  const list = C.parseSakabaList(read('sakaba_shop_list.xml'));
  eq('酒場: 件数', list.length, 4);
  eq('酒場: 1件目', [list[1].num, list[1].aired, list[1].station, list[1].name, list[1].link, list[1].closed], [1325, '2026-10-26', '田原町', '居酒屋よろこんで', '1325.html', false]);
  eq('酒場: 特別編のエリア', list[2].area, '特別編');
  eq('酒場: 閉店', list[3].closed, true);
  eq('酒場: 店名のかっこの中のかっこ', list[3].name, '居酒屋 若柳（わかやぎ）');

  // ---- 酒場放浪記の店のページ：本命の店の住所だけ（立ち寄りの店の住所は取らない） ----
  eq('酒場: 住所', C.parseSakabaShop(read('sakaba_shop_1325.html')).address, '東京都台東区寿4-10-3');
  eq('おんな酒場: 説明に「立ち寄り」があっても住所を取る', C.parseSakabaShop(read('onnasakaba_shop_628.html')).address, '神奈川県横浜市港北区大倉山3-29-7');
  eq('酒場: 住所の無いページ', C.parseSakabaShop('<h2 id="shop-name">x</h2><p class="shop-notice">').address, '');

  // ---- 町中華 ----
  const mc = C.parseMachichukaList(read('machichuka_shop.xml'));
  eq('町中華: 件数と日付', mc.map(o => o.oaDate), ['2019-04-01', '2026-10-26']);
  eq('町中華: リンクと題', [mc[1].link, mc[1].title], ['/machichuka/store/0430-02/', '#430 「大三元」（千歳船橋編）']);
  eq('町中華: 店のページ', C.parseMachichukaStore(read('machichuka_store_0430-02.html')),
    { name: '大三元', address: '東京都世田谷区船橋1-39-10', aired: '2026-10-26', area: '千歳船橋' });

  // ---- ぶらり途中下車の旅 ----
  const br = C.parseBurariArticles(read('burari_articles.js'));
  eq('ぶらり: 所番地のある記事だけ・同じ回の別記事は重ねない', br.map(e => e.name), ['国立新美術館', '四代目 たかまつ さくらうどん', '香蔵〜出汁と麹と九州の食材〜', '草山 歩さん']);
  const ud = br[1];
  eq('ぶらり: 店の中身', [ud.aired, ud.station, ud.address, ud.homepage, ud.url],
    ['2026-10-10', '東銀座駅', '東京都中央区銀座3-14-3', 'https://sakuraudon.com/', 'https://www.ntv.co.jp/burari/articles/22778f2krrqv8pltr10.html']);
  eq('ぶらり: 説明', ud.desc, '（テスト用：讃岐うどんの店）');
  eq('ぶらり: 飲食店の判定', br.map(C.classifyBurari), ['no', 'food', 'unsure', 'no']);
  eq('ぶらり: 店名に飲食の言葉があっても施設なら確認待ち', C.classifyBurari({ name: 'カフェはれま・塩竈まちかど博物館', desc: '旅館の1階のカフェ' }), 'unsure');
  eq('ぶらり: 説明が空なら確認待ち', C.classifyBurari({ name: 'Cafe Windy', desc: '' }), 'unsure');
  eq('ぶらり: 雑貨店は足さない', C.classifyBurari({ name: 'yukino shop', desc: 'パグのイラストの雑貨店' }), 'no');
  eq('ぶらり: 壊れたデータ', (() => { try { C.parseBurariArticles('var articles = [{'); return 'ok'; } catch (e) { return 'throw'; } })(), 'throw');

  // ---- robots.txt ----
  const rb = C.parseRobots('User-agent: Googlebot\nDisallow: /mv/\nUser-agent: *\nDisallow: /search\nAllow: /search/ok\n\nUser-agent: anthropic-ai\nUser-agent: gohan-ashiato-tvshops\nDisallow: /\n');
  eq('robots: 自分の名前のグループで全部禁止', C.robotsAllows(rb, '/burari/'), false);
  const rb2 = C.parseRobots('User-agent: *\nDisallow: /search\nAllow: /search/ok\nDisallow: /*.json$\n');
  eq('robots: 禁止されていない', C.robotsAllows(rb2, '/burari/articles.js'), true);
  eq('robots: 前方一致で禁止', C.robotsAllows(rb2, '/search?q=1'), false);
  eq('robots: 長い Allow が勝つ', C.robotsAllows(rb2, '/search/ok/1'), true);
  eq('robots: * と $', [C.robotsAllows(rb2, '/a/b.json'), C.robotsAllows(rb2, '/a/b.json?x')], [false, true]);
  eq('robots: 空', C.robotsAllows(C.parseRobots(''), '/x'), true);
  eq('robots: ほかの名前のグループは関係ない', C.robotsAllows(C.parseRobots('User-agent: ClaudeBot\nDisallow: /\n'), '/x'), true);

  // ---- 国土地理院 ----
  eq('地理院: 問い合わせの住所は建物名の前まで', C.geoQuery('東京都台東区上野4-2-5 美野里ビル1F'), '東京都台東区上野4-2-5');
  eq('地理院: 全角の空白とかっこ', C.geoQuery('横浜市西区西平沼町6-1　tvk ecom park内'), '横浜市西区西平沼町6-1');
  const gsi = [{ geometry: { coordinates: [139.792755, 35.708664] }, properties: { title: '東京都台東区寿四丁目１０番３号' } }];
  eq('地理院: 位置', C.pickGeo(gsi, '東京都台東区寿4-10-3'), { lat: 35.708664, lng: 139.792755 });
  eq('地理院: 市区町村が違う候補は使わない', C.pickGeo(gsi, '東京都品川区旗の台4-7-3'), null);
  eq('地理院: 郡は候補に無くてよい', C.pickGeo([{ geometry: { coordinates: [133, 35] }, properties: { title: '島根県奥出雲町横田' } }], '島根県仁多郡奥出雲町横田1029-8'), { lat: 35, lng: 133 });
  eq('地理院: 見つからない', C.pickGeo([], '東京都台東区寿4-10-3'), null);

  // ---- まとめ方 ----
  const data = { shops: [{ id: 'sakaba-1325', name: '居酒屋よろこんで', address: '東京都台東区寿4-10-3', appearances: [{ program: '吉田類の酒場放浪記', aired: '2026-10-26', url: 'https://a/1' }], sources: ['https://a/1'], links: [] }] };
  eq('最新の放送日', C.latestAired(data), { '吉田類の酒場放浪記': '2026-10-26' });
  const r = C.mergeShops(data, [
    { id: 'machichuka-x', name: '居酒屋 よろこんで', address: '東京都台東区寿４丁目10-3', appearances: [{ program: '町中華で飲ろうぜ', aired: '2026-11-02', url: 'https://b/1' }], sources: ['https://b/1'], links: [] },
    { id: 'sakaba-1325', name: '別の店', address: '東京都台東区寿1-1-1', appearances: [{ program: '吉田類の酒場放浪記', aired: '2026-11-09', url: 'https://a/2' }], sources: ['https://a/2'], links: [] },
    { id: 'sakaba-1325', name: '居酒屋よろこんで', address: '東京都台東区寿4-10-3', appearances: [{ program: '吉田類の酒場放浪記', aired: '2026-10-26', url: 'https://a/1' }], sources: ['https://a/1'], links: [] }
  ], '2026-11-10');
  eq('まとめ: 同じ店（表記ゆれ）は放送回を足す', data.shops[0].appearances.map(a => a.aired), ['2026-11-02', '2026-10-26']);
  eq('まとめ: 既存の店の名前と住所は変えない', [data.shops[0].name, data.shops[0].address], ['居酒屋よろこんで', '東京都台東区寿4-10-3']);
  eq('まとめ: 新しい店は id が重ならない', r.added.map(s => s.id), ['sakaba-1325-2']);
  eq('まとめ: 同じ放送回は足さない', r.appended.length, 1);
  eq('まとめ: 新しい店の形', Object.keys(r.added[0]), ['id', 'name', 'address', 'station', 'genre', 'lat', 'lng', 'links', 'appearances', 'sources', 'checkedAt']);

  // ---- 出力 ----
  const md = C.report({ perProgram: [{ program: '吉田類の酒場放浪記', added: 0, appended: 0, pending: 0 }], added: [], appended: [], pending: [], log: { blocked: ['https://x/'], failed: [], errors: [] }, dryRun: true, since: { '吉田類の酒場放浪記': '2026-10-26' } });
  eq('出力: 追加0件', /新しい店 0件/.test(md), true);
  eq('出力: robots で止めたページ', /robots\.txt で禁止のため読んでいない：https:\/\/x\//.test(md), true);

  console.log((fail ? 'NG ' : 'OK ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
