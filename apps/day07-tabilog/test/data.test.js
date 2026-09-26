/*
 * 日付計算・並べ替え・グループ分け・費用の合計など、純粋な関数だけを検証する。
 * ブラウザ操作は含まない。実行: node test/data.test.js
 */
var path = require('path');

global.window = {};
require(path.join(__dirname, '..', 'app.js'));
var T = global.window.TabiLog;

var pass = 0, fail = 0;
function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log('NG  ' + label + '\n    got  ' + JSON.stringify(got) + '\n    want ' + JSON.stringify(want)); }
}
function ok(label, cond) { eq(label, !!cond, true); }

/* ---- formatYen ---- */
eq('formatYen: 千円区切り', T.formatYen(12345), '¥12,345');
eq('formatYen: 0円も表示する', T.formatYen(0), '¥0');
eq('formatYen: nullは空文字', T.formatYen(null), '');

/* ---- dateDiffDays / dayLabel ---- */
eq('dateDiffDays: 3日後', T.dateDiffDays('2024-08-10', '2024-08-13'), 3);
eq('dateDiffDays: 不正な日付はnull', T.dateDiffDays('2024-08-10', 'abc'), null);

var trip = { startDate: '2024-08-10', endDate: '2024-08-13' };
eq('dayLabel: 開始日と同じなら1日目', T.dayLabel(trip, '2024-08-10'), '1日目');
eq('dayLabel: 3日後なら4日目', T.dayLabel(trip, '2024-08-13'), '4日目');
eq('dayLabel: 日付未設定', T.dayLabel(trip, ''), '日付未設定');

/* ---- tripNights ---- */
eq('tripNights: 3泊4日', T.tripNights(trip), '3泊4日');
eq('tripNights: 日帰り', T.tripNights({ startDate: '2024-08-10', endDate: '2024-08-10' }), '日帰り');
eq('tripNights: 日程未設定なら空文字', T.tripNights({ startDate: '', endDate: '' }), '');

/* ---- allDatesForTrip ---- */
eq('allDatesForTrip: 開始・終了日から全日程を作る', T.allDatesForTrip(trip, []),
  ['2024-08-10', '2024-08-11', '2024-08-12', '2024-08-13']);

var tripNoDates = { startDate: '', endDate: '' };
var blocksNoTripDates = [{ date: '2024-08-12' }, { date: '2024-08-10' }, { date: '2024-08-10' }];
eq('allDatesForTrip: 日程未設定ならblockの日付から重複なく作る', T.allDatesForTrip(tripNoDates, blocksNoTripDates),
  ['2024-08-10', '2024-08-12']);

var blocksWithUndated = [{ date: '2024-08-10' }, { date: '' }];
eq('allDatesForTrip: 日付未設定のblockは末尾にまとめる', T.allDatesForTrip(trip, blocksWithUndated),
  ['2024-08-10', '2024-08-11', '2024-08-12', '2024-08-13', '']);

/* ---- sortBlocks / groupBlocksByDate ---- */
var blocks = [
  { id: 'a', date: '2024-08-11', time: '09:00', createdAt: '2' },
  { id: 'b', date: '2024-08-10', time: '19:00', createdAt: '1' },
  { id: 'c', date: '2024-08-10', time: '10:00', createdAt: '3' }
];
eq('sortBlocks: 日付→時間の順に並ぶ', T.sortBlocks(blocks).map(function (b) { return b.id; }), ['c', 'b', 'a']);

var grouped = T.groupBlocksByDate(blocks);
eq('groupBlocksByDate: 日付ごとにまとまる', Object.keys(grouped).sort(), ['2024-08-10', '2024-08-11']);
eq('groupBlocksByDate: 同じ日は時間順', grouped['2024-08-10'].map(function (b) { return b.id; }), ['c', 'b']);

// 音声入力のように、一部のBlockだけ時刻が分かっていて残りは未設定（空文字）のことがある。
// 未設定を「00:00より前」として先頭に押し出さず、作成順（＝話した順）のままにする
var blocksMixedTime = [
  { id: 'x', date: '2024-08-10', time: '10:00', createdAt: '1' },
  { id: 'y', date: '2024-08-10', time: '', createdAt: '2' },
  { id: 'z', date: '2024-08-10', time: '', createdAt: '3' }
];
eq('sortBlocks: 時刻不明のBlockは時刻順に割り込まず、作成順（話した順）のまま', T.sortBlocks(blocksMixedTime).map(function (b) { return b.id; }), ['x', 'y', 'z']);

/* ---- 費用（小項目の明細→合計、大項目・旅行全体の合計） ---- */
eq('entryCostTotal: 明細を合計する', T.entryCostTotal({ costItems: [{ label: 'そば', amount: 800 }, { label: '飲み物', amount: 400 }] }), 1200);
eq('entryCostTotal: 明細が無ければ0', T.entryCostTotal({ costItems: [] }), 0);
eq('entryCostTotal: entry自体が無くても0', T.entryCostTotal(null), 0);

var blockWithEntries = {
  entries: [
    { costItems: [{ label: 'a', amount: 600 }] },
    { costItems: [{ label: 'b', amount: 900 }] }
  ]
};
eq('blockCostTotal: 複数の小項目（別行動）を合計する', T.blockCostTotal(blockWithEntries), 1500);

var blocksForTripTotal = [
  { entries: [{ costItems: [{ label: 'a', amount: 1000 }] }] },
  { entries: [{ costItems: [{ label: 'b', amount: 2000 }] }, { costItems: [{ label: 'c', amount: 500 }] }] }
];
eq('tripTotalCost: 旅行全体の合計', T.tripTotalCost(blocksForTripTotal), 3500);

/* ---- 割り勘（貸し借り・精算） ---- */
var tripForBalance = { companions: ['父', '母', '私'] };
var blocksForBalance = [
  { date: '2024-08-10', label: '夕食', entries: [{ costItems: [
    { label: '夕食', amount: 3000, paidBy: '父', splitAmong: ['父', '母', '私'] }
  ] }] },
  { date: '2024-08-11', label: '入場料', entries: [{ costItems: [
    { label: '入場料', amount: 1000, paidBy: '私' } // splitAmong省略＝自分だけの個人費用
  ] }] }
];
var balance = T.tripBalances(tripForBalance, blocksForBalance);
eq('tripBalances: 払った人はプラス、割った人はマイナス', balance['父'], 2000);
eq('tripBalances: 3等分された分だけマイナス', balance['母'], -1000);
eq('tripBalances: splitAmong省略の費用は貸し借りゼロ（自分で払って自分で使った扱い）', balance['私'], -1000 /* 夕食の自分の割 */ + 0 /* 個人費用は貸し借りなし */);

eq('tripBalances: paidByが無い費用行は集計しない（古いデータとの後方互換）',
  T.tripBalances({ companions: ['a', 'b'] }, [{ entries: [{ costItems: [{ label: 'x', amount: 500 }] }] }]),
  { a: 0, b: 0 });

var plan = T.settlementPlan({ '父': 2000, '母': -1000, '私': -1000 });
eq('settlementPlan: 送金回数が最小になるよう精算する', plan.length, 2);
eq('settlementPlan: 合計金額は残高の絶対値と一致する', plan.reduce(function (s, p) { return s + p.amount; }, 0), 2000);
plan.forEach(function (p) { ok('settlementPlan: 宛先は必ず貸している人（父）', p.to === '父'); });

eq('settlementPlan: 全員ゼロなら精算不要', T.settlementPlan({ a: 0, b: 0 }), []);

var expenses = T.tripExpenseList(blocksForBalance);
eq('tripExpenseList: paidByがある費用行だけを新しい日付順で一覧する', expenses.map(function (e) { return e.label; }), ['入場料', '夕食']);
eq('tripExpenseList: splitAmong省略時はpaidBy本人だけとして補う', expenses[0].splitAmong, ['私']);

/* ---- 宿泊先 ---- */
var blocksLodging = [
  { category: 'lodging', label: 'オーシャンビューホテル那覇' },
  { category: 'food', label: '国際通りの食堂' },
  { category: 'lodging', label: 'オーシャンビューホテル那覇' }
];
eq('primaryLodgingName: lodgingカテゴリの最初の見出しを使う', T.primaryLodgingName(blocksLodging), 'オーシャンビューホテル那覇');
eq('primaryLodgingName: lodgingが無ければ空文字', T.primaryLodgingName([{ category: 'food', label: 'x' }]), '');

var blocksLodgingDifferentLabels = [
  { category: 'lodging', label: '温泉宿の慶山に到着する' },
  { category: 'lodging', label: '宿に戻る' }
];
eq(
  'primaryLodgingName: 同じ宿でも見出しが違う複数Blockを繋げず、最初の1件だけにする（音声入力で複数Blockができるケース）',
  T.primaryLodgingName(blocksLodgingDifferentLabels),
  '温泉宿の慶山に到着する'
);

/* ---- lodgingByNight（何泊目にどこへ泊まったか） ---- */
var tripForNights = { startDate: '2024-08-10', endDate: '2024-08-17' }; // 7泊8日
var blocksTwoLodgings = [
  { category: 'lodging', label: 'Aホテル', date: '2024-08-10', createdAt: '1' },
  { category: 'lodging', label: 'Bホテル', date: '2024-08-16', createdAt: '2' }
];
var nights = T.lodgingByNight(tripForNights, blocksTwoLodgings);
eq('lodgingByNight: 7泊8日で宿が1回変わるので2グループに分かれる', nights.length, 2);
eq('lodgingByNight: 1〜6泊目はAホテル', [nights[0].label, nights[0].from, nights[0].to], ['Aホテル', 1, 6]);
eq('lodgingByNight: 7泊目はBホテル', [nights[1].label, nights[1].from, nights[1].to], ['Bホテル', 7, 7]);

eq('lodgingByNight: 日帰り（日程1日）なら「泊」は無い', T.lodgingByNight({ startDate: '2024-08-10', endDate: '2024-08-10' }, []), []);
eq('lodgingByNight: 日程未設定・Blockも無ければ空配列', T.lodgingByNight({ startDate: '', endDate: '' }, []), []);

var blocksSameLodgingTwice = [
  { category: 'lodging', label: '温泉宿の慶山に到着する', date: '2024-08-10', createdAt: '1' },
  { category: 'lodging', label: '宿に戻る', date: '2024-08-10', createdAt: '2' },
  { category: 'lodging', label: '温泉宿の慶山', date: '2024-08-12', createdAt: '3' }
];
var nightsSame = T.lodgingByNight({ startDate: '2024-08-10', endDate: '2024-08-13' }, blocksSameLodgingTwice);
eq('lodgingByNight: 同じ日に複数Blockがあれば後のBlockの見出しを採用', nightsSame[0].label, '宿に戻る');

/* ---- costBreakdownByPerson（総費用を払った人ごとに内訳） ---- */
var blocksForBreakdown = [
  { entries: [
    { author: '私', costItems: [{ label: 'お土産', amount: 1000 }] }, // paidByが無い＝個人費用としてauthorに計上
    { author: '私', costItems: [{ label: '夕食', amount: 3000, paidBy: '父', splitAmong: ['父', '母', '私'] }] }
  ] }
];
var breakdown = T.costBreakdownByPerson(blocksForBreakdown);
eq('costBreakdownByPerson: paidByが無い費用はauthorに計上', breakdown['私'], 1000);
eq('costBreakdownByPerson: paidByがある費用は全額payerに計上（割った額ではない）', breakdown['父'], 3000);
eq('costBreakdownByPerson: 登場しない人は含まれない', breakdown['母'], undefined);

/* ---- parseTags / URL ---- */
eq('parseTags: 読点区切りで空要素は除く', T.parseTags('父、母、、妹'), ['父', '母', '妹']);
eq('getTripIdFromSearch: ?tripを取り出す', T.getTripIdFromSearch('?trip=trip_abc123'), 'trip_abc123');
eq('getTripIdFromSearch: 無ければ空文字', T.getTripIdFromSearch(''), '');
eq('buildShareUrl: 共有URLを組み立てる', T.buildShareUrl('https://example.com', '/index.html', 'trip_abc'), 'https://example.com/index.html?trip=trip_abc');

/* ---- upsertTripIndexEntry（ローカルの「開いたことのある旅行」索引） ---- */
var idx = [];
idx = T.upsertTripIndexEntry(idx, { id: 't1', title: 'A' });
idx = T.upsertTripIndexEntry(idx, { id: 't2', title: 'B' });
eq('upsertTripIndexEntry: 新しい順に並ぶ', idx.map(function (t) { return t.id; }), ['t2', 't1']);
idx = T.upsertTripIndexEntry(idx, { id: 't1', title: 'A(更新)' });
eq('upsertTripIndexEntry: 既存分は先頭へ移動し重複しない', idx.map(function (t) { return t.id; }), ['t1', 't2']);
eq('upsertTripIndexEntry: 更新後の内容になる', idx[0].title, 'A(更新)');

/* ---- removeTripIndexEntry（サーバー側で削除済みの旅行を索引からも消す） ---- */
var idx2 = T.removeTripIndexEntry(idx, 't1');
eq('removeTripIndexEntry: 指定したidが消える', idx2.map(function (t) { return t.id; }), ['t2']);
eq('removeTripIndexEntry: 無い id を渡しても変わらない', T.removeTripIndexEntry(idx, 'nope').map(function (t) { return t.id; }), ['t1', 't2']);

/* ---- filterTrips / tripFilterOptions（ホーム画面の旅行一覧の絞り込み） ---- */
var tripsForFilter = [
  { id: 't1', companions: ['父', '母'], startDate: '2024-08-10', tripType: '家族' },
  { id: 't2', companions: ['サークルの先輩'], startDate: '2025-03-01', tripType: 'サークルの友達' },
  { id: 't3', companions: ['父'], startDate: '2024-01-05', tripType: '家族' },
  { id: 't4', companions: [], startDate: '', tripType: '' }
];
eq('filterTrips: 絞り込み無しなら全件', T.filterTrips(tripsForFilter, {}).map(function (t) { return t.id; }), ['t1', 't2', 't3', 't4']);
eq('filterTrips: 誰と一緒かで絞る', T.filterTrips(tripsForFilter, { companion: '父' }).map(function (t) { return t.id; }), ['t1', 't3']);
eq('filterTrips: 年で絞る', T.filterTrips(tripsForFilter, { year: '2024' }).map(function (t) { return t.id; }), ['t1', 't3']);
eq('filterTrips: 旅行区分で絞る', T.filterTrips(tripsForFilter, { tripType: 'サークルの友達' }).map(function (t) { return t.id; }), ['t2']);
eq('filterTrips: 複数条件はAND', T.filterTrips(tripsForFilter, { companion: '父', year: '2024' }).map(function (t) { return t.id; }), ['t1', 't3']);
eq('filterTrips: 一致するものが無ければ空配列', T.filterTrips(tripsForFilter, { tripType: 'ハネムーン' }), []);

/* ---- sortTrips（ホーム画面の旅行一覧の並び替え） ---- */
eq('sortTrips: 空文字は元の順のまま（最近開いた順）', T.sortTrips(tripsForFilter, '').map(function (t) { return t.id; }), ['t1', 't2', 't3', 't4']);
eq('sortTrips: date_desc は日程が新しい順・未設定は末尾', T.sortTrips(tripsForFilter, 'date_desc').map(function (t) { return t.id; }), ['t2', 't1', 't3', 't4']);
eq('sortTrips: date_asc は日程が古い順・未設定は末尾', T.sortTrips(tripsForFilter, 'date_asc').map(function (t) { return t.id; }), ['t3', 't1', 't2', 't4']);

var opts = T.tripFilterOptions(tripsForFilter);
eq('tripFilterOptions: 誰と一緒かの選択肢（重複なし）', opts.companions, ['サークルの先輩', '母', '父']);
eq('tripFilterOptions: 年の選択肢（新しい年が先）', opts.years, ['2025', '2024']);
eq('tripFilterOptions: 旅行区分の選択肢（重複なし）', opts.tripTypes, ['サークルの友達', '家族']);

/* ---- 評価（ratingSummary / myRatingScore / sortMyLogItems） ---- */
eq('ratingSummary: 平均と件数を出す', T.ratingSummary([{ score: 4 }, { score: 2 }]), { avg: 3, count: 2 });
eq('ratingSummary: 評価が無ければ0件', T.ratingSummary([]), { avg: 0, count: 0 });
eq('ratingSummary: ratings自体が無くても0件', T.ratingSummary(undefined), { avg: 0, count: 0 });

var ratings = [{ raterEmail: 'a@example.com', score: 5 }, { raterEmail: 'B@Example.com', score: 3 }];
eq('myRatingScore: メールアドレスで自分の評価を取り出す', T.myRatingScore(ratings, 'a@example.com'), 5);
eq('myRatingScore: 大文字小文字を区別しない', T.myRatingScore(ratings, 'b@example.com'), 3);
eq('myRatingScore: 自分の評価が無ければ0', T.myRatingScore(ratings, 'c@example.com'), 0);
eq('myRatingScore: メールアドレスが無ければ0', T.myRatingScore(ratings, ''), 0);

var myLogItems = [
  { entryId: '1', score: 3, ratedAt: '2024-08-10T10:00:00Z' },
  { entryId: '2', score: 5, ratedAt: '2024-08-09T10:00:00Z' },
  { entryId: '3', score: 5, ratedAt: '2024-08-12T10:00:00Z' }
];
eq('sortMyLogItems: 評価が高い順（同点なら新しい順）', T.sortMyLogItems(myLogItems, 'score').map(function (i) { return i.entryId; }), ['3', '2', '1']);
eq('sortMyLogItems: 新しい順', T.sortMyLogItems(myLogItems, 'date').map(function (i) { return i.entryId; }), ['3', '1', '2']);

/* ---- weatherLabel（WMO天気コード→日本語） ---- */
eq('weatherLabel: 0は快晴', T.weatherLabel(0), '快晴');
eq('weatherLabel: 1・2は晴れ', T.weatherLabel(1), '晴れ');
eq('weatherLabel: 3は曇り', T.weatherLabel(3), '曇り');
eq('weatherLabel: 61〜67は雨', T.weatherLabel(63), '雨');
eq('weatherLabel: 71〜77は雪', T.weatherLabel(73), '雪');
eq('weatherLabel: 95以上は雷雨', T.weatherLabel(96), '雷雨');
eq('weatherLabel: nullは空文字', T.weatherLabel(null), '');

/* ---- weatherLabel: 降水量1mm以下は曇り扱い ---- */
eq('weatherLabel: 雨コードでも降水量1mm以下なら曇り', T.weatherLabel(63, 0.5), '曇り');
eq('weatherLabel: 降水量ちょうど1mmも曇り', T.weatherLabel(63, 1), '曇り');
eq('weatherLabel: 降水量が1mmを超えれば雨のまま', T.weatherLabel(63, 5), '雨');
eq('weatherLabel: にわか雨コードでも同様に曇り扱い', T.weatherLabel(80, 0.2), '曇り');
eq('weatherLabel: 雷雨は降水量が少なくても雷雨のまま', T.weatherLabel(96, 0.2), '雷雨');
eq('weatherLabel: 降水量が渡されなければ従来どおり', T.weatherLabel(63), '雨');

/* ---- 地図でふりかえる：予定の場所は記録の地図URLだけから決める（replayPlaceQuery） ---- */
eq('replayPlaceQuery: Googleマップの共有リンクをそのまま返す（展開・座標の読み取りはWorker側）',
  T.replayPlaceQuery({ label: 'ランチ', entries: [{ mapUrl: ' https://maps.app.goo.gl/PzmSEdBvWvfK1AW87?g_st=ic ' }] }), 'https://maps.app.goo.gl/PzmSEdBvWvfK1AW87?g_st=ic');
eq('replayPlaceQuery: 地図の入った最初の記録を使う',
  T.replayPlaceQuery({ label: 'ランチ', entries: [{ mapUrl: '' }, { mapUrl: 'https://www.google.com/maps/search/?api=1&query=x' }] }), 'https://www.google.com/maps/search/?api=1&query=x');
eq('replayPlaceQuery: 地図が無ければ見出しが地名でも空（移動の目的地にしない）', T.replayPlaceQuery({ label: '那覇空港に到着', entries: [] }), '');
eq('replayPlaceQuery: 「小西遅刻」のような出来事も空', T.replayPlaceQuery({ label: '小西遅刻', entries: [{ episode: '寝坊' }] }), '');
eq('replayPlaceQuery: URLでない文字列は使わない', T.replayPlaceQuery({ label: '新宿', entries: [{ mapUrl: '新宿駅' }] }), '');
eq('replayPlaceQuery: query=undefined,undefinedのように壊れたリンクは地図が無いのと同じに扱う（見出しからも探させない）',
  T.replayPlaceQuery({ label: 'ユニバーサル', entries: [{ mapUrl: 'https://www.google.com/maps/search/?api=1&query=undefined,undefined' }] }), '');
eq('replayPlaceQuery: q=nullのように壊れたリンクも同様',
  T.replayPlaceQuery({ label: '空港', entries: [{ mapUrl: 'https://www.google.com/maps?q=null' }] }), '');
eq('replayPlaceQuery: 壊れたリンクの記録の後ろに正しい地図があれば、そちらを使う',
  T.replayPlaceQuery({ label: 'A', entries: [{ mapUrl: 'https://www.google.com/maps/search/?api=1&query=undefined,undefined' }, { mapUrl: 'https://maps.app.goo.gl/ok' }] }), 'https://maps.app.goo.gl/ok');

/* ---- 地図でふりかえる：座標入りの記録を直接使い、無ければサーバーに保存させる（replayPlaceEntry、Part A） ---- */
eq('replayPlaceEntry: 地図が無ければnull', T.replayPlaceEntry({ label: '那覇空港に到着', entries: [] }), null);
eq('replayPlaceEntry: サーバーがすでに座標を求めてある記録はlat/lngを持つ',
  T.replayPlaceEntry({ entries: [{ id: 'ent_1', mapUrl: 'https://maps.app.goo.gl/x', mapLat: 35.1, mapLng: 139.1 }] }),
  { url: 'https://maps.app.goo.gl/x', entryId: 'ent_1', lat: 35.1, lng: 139.1 });
eq('replayPlaceEntry: 座標がまだ無い記録はlat/lngがnull（idは返す）',
  T.replayPlaceEntry({ entries: [{ id: 'ent_2', mapUrl: 'https://maps.app.goo.gl/y' }] }),
  { url: 'https://maps.app.goo.gl/y', entryId: 'ent_2', lat: null, lng: null });
eq('replayPlaceEntry: mapLat/mapLngが数値でなければ無視する（NaN・文字列など）',
  T.replayPlaceEntry({ entries: [{ id: 'ent_3', mapUrl: 'https://maps.app.goo.gl/z', mapLat: 'x', mapLng: null }] }),
  { url: 'https://maps.app.goo.gl/z', entryId: 'ent_3', lat: null, lng: null });

/* ---- 地図でふりかえる：再生する地点の並び（replayStops） ---- */
var rpTrip = { startDate: '2026-04-01', endDate: '2026-04-02' };
var rpBlocks = [
  { id: 'a', date: '2026-04-01', time: '10:00', label: '新宿', transport: '', entries: [{ episode: '小西遅刻', mapUrl: 'https://maps.app.goo.gl/shinjuku' }, { comment: '松藤寝坊' }] },
  { id: 'b', date: '2026-04-01', time: '12:00', label: '山梨', transport: 'train', entries: [{ mapUrl: 'https://maps.app.goo.gl/yamanashi' }] },
  { id: 'c', date: '2026-04-01', time: '', label: 'ほうとう屋で夕食', transport: 'walk', entries: [], createdAt: '1' },
  { id: 'd', date: '2026-04-02', time: '09:00', label: '河口湖', transport: 'bus', entries: [{ mapUrl: 'https://maps.app.goo.gl/kawaguchiko' }] },
  { id: 'e', date: '', time: '', label: '日付なし', transport: '', entries: [] }
];
var rpStops = T.replayStops(rpTrip, rpBlocks);
eq('replayStops: 日付のない予定は含めない', rpStops.map(function (s) { return s.blockId; }), ['a', 'b', 'c', 'd']);
eq('replayStops: 何日目か', rpStops.map(function (s) { return s.dayNumber; }), [1, 1, 1, 2]);
eq('replayStops: 時刻なしの予定は直前の時刻の30分後と推定する', rpStops.map(function (s) { return s.minute; }), [600, 720, 750, 540]);
eq('replayStops: 推定時刻かどうか', rpStops.map(function (s) { return s.estimated; }), [false, false, true, false]);
eq('replayStops: 記録のエピソード・ひとことを吹き出しにする', rpStops[0].captions, ['小西遅刻', '松藤寝坊']);
eq('replayStops: 移動手段を引き継ぐ', rpStops.map(function (s) { return s.transport; }), ['', 'train', 'walk', 'bus']);
eq('replayStops: 記録のid・サーバー座標をentryId/knownLat/knownLngへ引き継ぐ（Part A、座標未設定はnull）',
  rpStops.map(function (s) { return { entryId: s.entryId, knownLat: s.knownLat, knownLng: s.knownLng }; }),
  [{ entryId: '', knownLat: null, knownLng: null }, { entryId: '', knownLat: null, knownLng: null },
   { entryId: '', knownLat: null, knownLng: null }, { entryId: '', knownLat: null, knownLng: null }]);
{
  var rpStopsWithCoords = T.replayStops(rpTrip, [
    { id: 'a', date: '2026-04-01', time: '10:00', label: '新宿', transport: '', entries: [{ id: 'ent_9', mapUrl: 'https://maps.app.goo.gl/shinjuku', mapLat: 35.69, mapLng: 139.7 }] }
  ]);
  eq('replayStops: entry.mapLat/mapLngがあればknownLat/knownLngに入る', { knownLat: rpStopsWithCoords[0].knownLat, knownLng: rpStopsWithCoords[0].knownLng }, { knownLat: 35.69, knownLng: 139.7 });
  eq('replayStops: entryIdもそのまま入る', rpStopsWithCoords[0].entryId, 'ent_9');
}
eq('replayStops: 時刻が1つも無い日は9時から1時間おき',
  T.replayStops(rpTrip, [{ id: 'x', date: '2026-04-01', time: '', label: 'A', entries: [], createdAt: '1' }, { id: 'y', date: '2026-04-01', time: '', label: 'B', entries: [], createdAt: '2' }]).map(function (s) { return s.minute; }),
  [540, 600]);

/* ---- 地図でふりかえる：再生の時間割（buildReplayTimeline / replayStateAt） ---- */
var rpCoords = { 'https://maps.app.goo.gl/shinjuku': { lat: 35.69, lng: 139.70 }, 'https://maps.app.goo.gl/yamanashi': { lat: 35.66, lng: 138.57 }, 'https://maps.app.goo.gl/kawaguchiko': { lat: 35.50, lng: 138.76 } };
var tl = T.buildReplayTimeline(rpStops, rpCoords);
eq('buildReplayTimeline: 場所が分かった予定だけ地図上の地点になる', tl.stops.map(function (s) { return s.located; }), [true, true, false, true]);
eq('buildReplayTimeline: 移動手段があり両端の場所が分かる区間だけ移動する',
  tl.legs.map(function (l) { return [tl.stops[l.from].blockId, tl.stops[l.to].blockId, l.transport]; }),
  [['a', 'b', 'train'], ['b', 'd', 'bus']]);
ok('buildReplayTimeline: 再生時間（秒）は時刻に沿って単調に増える', tl.keyframes.every(function (k, i) {
  return i === 0 || (k.t >= tl.keyframes[i - 1].t && k.r >= tl.keyframes[i - 1].r);
}));
ok('buildReplayTimeline: 空き時間を早送りするので2日分でも2分以内に収まる', tl.totalReal > 10 && tl.totalReal < 120);
var st0 = T.replayStateAt(tl, 0);
eq('replayStateAt: 最初は1日目・最初の予定の少し前の時刻', [st0.dayNumber, st0.hhmm], [1, '09:55']);
var legAB = tl.legs[0];
var stMid = T.replayStateAt(tl, (legAB.r0 + legAB.r1) / 2);
ok('replayStateAt: 移動中は電車のアイコンが新宿と山梨の間にいる', stMid.icon && stMid.icon.transport === 'train' &&
  stMid.icon.lng < 139.70 && stMid.icon.lng > 138.57);
var stArriveB = T.replayStateAt(tl, tl.stops[1].r + 0.01);
eq('replayStateAt: 到着した予定の吹き出しが出る', stArriveB.captionIndex, 1);
eq('replayStateAt: 到着したら時計はその予定の時刻', stArriveB.hhmm, '12:00');
var stEnd = T.replayStateAt(tl, tl.totalReal);
eq('replayStateAt: 最後は2日目', stEnd.dayNumber, 2);
eq('replayStateAt: 最後にいる場所は最後の地点', [stEnd.here.lat, stEnd.here.lng], [35.50, 138.76]);
var lateTl = T.buildReplayTimeline(T.replayStops({ startDate: '2026-04-01', endDate: '2026-04-01' },
  [{ id: 'z', date: '2026-04-01', time: '23:55', label: '新宿', entries: [{ mapUrl: 'https://maps.app.goo.gl/shinjuku' }] }]), { 'https://maps.app.goo.gl/shinjuku': { lat: 35.69, lng: 139.70 } });
var lateEnd = T.replayStateAt(lateTl, lateTl.totalReal);
eq('replayStateAt: 最後の予定が深夜でも、最後の時計は翌日にはみ出さない', [lateEnd.dayNumber, lateEnd.hhmm], [1, '23:59']);
ok('arcLatLng: 飛行機は直線より外側にふくらむ', (function () {
  var mid = T.arcLatLng({ lat: 35, lng: 139 }, { lat: 35, lng: 130 }, 0.5, true);
  return Math.abs(mid.lat - 35) > 0.3;
})());
eq('arcLatLng: 弧でなければ直線の中点', T.arcLatLng({ lat: 30, lng: 130 }, { lat: 40, lng: 140 }, 0.5, false), { lat: 35, lng: 135 });

/* ---- 紹介文（ホテログ・レクログ・飯ログ。docs/adr/0007） ---- */
eq('reviewKindForCategory: 宿泊→ホテログ・食事→飯ログ・観光とその他→レクログ・移動→なし',
  ['lodging', 'food', 'sightseeing', 'other', 'transport'].map(T.reviewKindForCategory), ['hotel', 'food', 'activity', 'activity', '']);
eq('reviewLevelLabel: 4.5以上／4.0以上／3.5以上／3.0以上／3.0未満',
  [4.5, 4.4, 4.0, 3.9, 3.5, 3.0, 2.9].map(function (s) { return T.reviewLevelLabel('hotel', s); }),
  ['絶対また泊まりたい', 'また泊まりたい', 'また泊まりたい', 'また泊まってもいい', 'また泊まってもいい', '機会があれば泊まる', 'もう泊まらない']);
eq('reviewLevelLabel: 種類ごとに言葉が変わる', [T.reviewLevelLabel('activity', 4.7), T.reviewLevelLabel('food', 4.0)], ['2回目もまた行きたい', 'また行きたい']);
eq('isReviewPublic: 3.0ちょうどは出す・3.0未満は出さない', [3.0, 2.9, 4.2].map(T.isReviewPublic), [true, false, true]);
eq('travelDurationText: 出発・到着から所要時間', T.travelDurationText('10:00', '12:30'), '2時間30分');
eq('travelDurationText: 日をまたぐ夜行便', T.travelDurationText('22:00', '06:15'), '8時間15分');
eq('travelDurationText: 時刻が片方なければ空', T.travelDurationText('10:00', ''), '');

var rvHotelBlock = { id: 'h', date: '2026-04-01', time: '15:00', category: 'lodging', label: 'THE TOWER HOTEL', entries: [] };
var rvHotelEntry = { id: 'he', costItems: [{ label: '宿泊', amount: 51582 }], ratings: [
  { raterEmail: 'me@example.com', score: 3.9, review: { price: '〇', units: 2, location: '△', access: '最寄り駅まで徒歩10分以上', value: '◎', hospitality: '〇', amenity: '△', other: 'ベッドがふかふか' } },
  { raterEmail: 'friend@example.com', score: 2.0, review: {} }
] };
var hotelText = T.reviewLogText(rvHotelBlock, rvHotelEntry, T.findMyRating(rvHotelEntry.ratings, 'me@example.com'));
ok('reviewLogText: 見出しに種類と★、★の横に評価の言葉', hotelText.indexOf('🏨 ホテログ ⭐3.9（また泊まってもいい）\nTHE TOWER HOTEL') === 0);
ok('reviewLogText: 価格は1泊あたりと合計（費用の明細から）', hotelText.indexOf('価格：〇（1泊あたり25,791円／2泊合計51,582円）') !== -1);
ok('reviewLogText: 立地は行き方を添える', hotelText.indexOf('立地：△（最寄り駅まで徒歩10分以上）') !== -1);
ok('reviewLogText: 最後に「→ 評価の言葉」の行は付けない', hotelText.indexOf('→') === -1);
ok('reviewLogText: 入れていない項目は出さない', hotelText.indexOf('清潔さ') === -1);
eq('reviewLogText: 3.0未満（友達の2.0）は出さない', T.reviewLogText(rvHotelBlock, rvHotelEntry, T.findMyRating(rvHotelEntry.ratings, 'friend@example.com')), '');
eq('reviewLogText: 評価していなければ出さない', T.reviewLogText(rvHotelBlock, rvHotelEntry, null), '');

var rvFoodBlock = { id: 'f', date: '2026-04-01', time: '12:00', category: 'food', label: 'ほうとう不動', entries: [] };
var rvFoodEntry = { id: 'fe', waitTime: '20分', costItems: [{ label: 'ほうとう', amount: 1500 }, { label: '馬刺し', amount: 800 }],
  ratings: [{ raterEmail: 'me@example.com', score: 4.6, review: { taste: '◎', reservation: '不要' } }] };
var foodText = T.reviewLogText(rvFoodBlock, rvFoodEntry, rvFoodEntry.ratings[0]);
ok('reviewLogText(飯): メニューは費用の明細から金額つきで', foodText.indexOf('メニュー：ほうとう 1,500円／馬刺し 800円') !== -1);
ok('reviewLogText(飯): 美味しさ・予約・待ち時間', foodText.indexOf('美味しさ：◎') !== -1 && foodText.indexOf('予約：不要') !== -1 && foodText.indexOf('待ち時間：20分') !== -1);

var rvMoveBlock = { id: 'm', date: '2026-04-01', time: '08:00', category: 'transport', transport: 'plane', label: 'ロンドンへ', entries: [] };
var rvMoveEntry = { id: 'me', costItems: [], travel: { from: 'ローマ', to: 'ロンドン', company: 'ブエリング航空', depart: '08:00', arrive: '09:45', amount: 21840 } };
eq('travelLogText: 移動は★なしで区間・会社・時刻・料金',
  T.travelLogText(rvMoveBlock, rvMoveEntry),
  '✈️ 移動｜飛行機\nローマ→ロンドン\n会社：ブエリング航空\n08:00発 → 09:45着（1時間45分）\n料金：21,840円');
eq('travelLogText: 情報が何もなければ出さない', T.travelLogText({ category: 'transport', transport: '', label: '' }, { costItems: [] }), '');

rvHotelBlock.entries = [rvHotelEntry]; rvFoodBlock.entries = [rvFoodEntry]; rvMoveBlock.entries = [rvMoveEntry];
var rvBlocks = [rvHotelBlock, rvFoodBlock, rvMoveBlock];
eq('tripCostByGroup: 移動・ホテル・食事と観光に分ける（移動は明細が無ければtravelの金額）', T.tripCostByGroup(rvBlocks), { transport: 21840, lodging: 51582, other: 2300 });
eq('tripPlaceNames: 海外があれば国', T.tripPlaceNames([{ country: 'イタリア', admin1: 'ラツィオ州' }, { country: 'イギリス' }, { country: 'イタリア' }]), ['イタリア', 'イギリス']);
eq('tripPlaceNames: 国内だけなら都道府県', T.tripPlaceNames([{ country: '日本', admin1: '山梨県' }, { country: '日本', admin1: '東京都' }]), ['山梨県', '東京都']);

var post = T.buildTripPostText({ title: '山梨旅', startDate: '2026-04-01', endDate: '2026-04-02' }, rvBlocks,
  [{ country: '日本', admin1: '山梨県' }], 'me@example.com');
ok('buildTripPostText: 表紙に日程・泊数・行き先', post.indexOf('【山梨旅】\n2026 4/1〜4/2（1泊2日）\n山梨県 1泊2日の総額公開！') === 0);
ok('buildTripPostText: 評価の目安は既定では付けない', post.indexOf('目安') === -1 && post.indexOf('評価の基準') === -1);
var postWithLegend = T.buildTripPostText({ title: '山梨旅', startDate: '2026-04-01', endDate: '2026-04-02' }, rvBlocks, [{ country: '日本', admin1: '山梨県' }], 'me@example.com', { legend: true });
ok('buildTripPostText: 選んだときは、使った種類の目安だけを最後（ハッシュタグの前）に付ける', postWithLegend.indexOf('※⭐の目安') > postWithLegend.indexOf('💰') && postWithLegend.indexOf('ホテログ　4.5〜') !== -1 && postWithLegend.indexOf('レクログ　') === -1);
ok('buildTripPostText: 時刻順（移動8時→飯12時→ホテル15時）',
  post.indexOf('✈️ 移動') < post.indexOf('🍴 飯ログ') && post.indexOf('🍴 飯ログ') < post.indexOf('🏨 ホテログ'));
ok('buildTripPostText: 最後に総額と内訳', post.indexOf('💰 合計金額は75,722円\n移動 21,840円\nホテル 51,582円\n食事と観光 2,300円') !== -1);
ok('buildTripPostText: 友達のアカウントで作ると、3.0未満のホテルは入らない',
  T.buildTripPostText({ title: 'x' }, rvBlocks, [], 'friend@example.com').indexOf('ホテログ') === -1);

/* ---- 地図でふりかえる：道のりに沿って進む（docs/adr/0008） ---- */
eq('routeProfileFor: 車・タクシー・バスは車道、徒歩・自転車はそれぞれ、電車・飛行機はルート検索しない',
  ['car', 'taxi', 'bus', 'walk', 'bicycle', 'train', 'plane', ''].map(T.routeProfileFor), ['car', 'car', 'car', 'foot', 'bike', '', '', '']);
var rtPath = [[35.0, 139.0], [35.0, 139.1], [35.1, 139.1]];
var rtHalf = T.pathAt(rtPath, 0.5);
ok('pathAt: 半分の位置は、長さで見た道のりの真ん中（1本目の終わり付近）', Math.abs(rtHalf.point.lng - 139.1) < 0.01 && Math.abs(rtHalf.point.lat - 35.0) < 0.01);
eq('pathAt: 半分までの折れ線は、通った角を含む', rtHalf.prefix.length >= 2, true);
eq('pathAt: 0は出発地、1は到着地', [T.pathAt(rtPath, 0).point, T.pathAt(rtPath, 1).point], [{ lat: 35.0, lng: 139.0 }, { lat: 35.1, lng: 139.1 }]);
var rtTl = T.buildReplayTimeline(rpStops, rpCoords);
rtTl.legs[0].path = [[35.69, 139.70], [35.69, 138.57], [35.66, 138.57]];
var rtMid = T.replayStateAt(rtTl, (rtTl.legs[0].r0 + rtTl.legs[0].r1) / 2);
ok('replayStateAt: 道のりがある移動は、直線ではなく道のりの上を進む（途中で西へ大きく回る）', Math.abs(rtMid.icon.lat - 35.69) < 0.02 && rtMid.icon.lng < 139.2);

/* ---- 地図でふりかえる：吹き出しは全文、長いほど長く見せる ---- */
var capLong = 'あ'.repeat(60);
var capStops = T.replayStops({ startDate: '2026-04-01', endDate: '2026-04-01' }, [
  { id: 'x1', date: '2026-04-01', time: '10:00', label: 'A', entries: [{ episode: capLong }] },
  { id: 'x2', date: '2026-04-01', time: '10:01', label: 'B', entries: [{ episode: '短い' }] },
  { id: 'x3', date: '2026-04-01', time: '10:02', label: 'C', entries: [] }]);
eq('replayStops: 吹き出しは40文字で切らず全文', capStops[0].captions[0].length, 60);
var capTl = T.buildReplayTimeline(capStops, {});
ok('buildReplayTimeline: 長い吹き出し（60文字）は、短いものより長く見せる（1秒12文字の目安）',
  capTl.stops[0].rDwellEnd - capTl.stops[0].r > capTl.stops[1].rDwellEnd - capTl.stops[1].r + 1.5);

/* ---- 時差（docs/adr/0009） ---- */
eq('tzOffsetMinutes: 日本は+9時間', T.tzOffsetMinutes('Asia/Tokyo', '2026-12-12', '20:00'), 540);
eq('tzOffsetMinutes: ロンドンは冬は+0・夏は+1（サマータイム）',
  [T.tzOffsetMinutes('Europe/London', '2026-12-12', '10:00'), T.tzOffsetMinutes('Europe/London', '2026-07-01', '10:00')], [0, 60]);
eq('tzOffsetMinutes: ハワイは-10時間', T.tzOffsetMinutes('Pacific/Honolulu', '2026-12-12', '10:00'), -600);
eq('tzOffsetMinutes: タイムゾーンが無ければnull', T.tzOffsetMinutes('', '2026-12-12', '10:00'), null);

// 日本20:00発 → ハワイ同じ日の10:00着（日付変更線をまたぐ）。現地時間のままだと着が先に並んでしまっていた
var tzBlocks = [
  { id: 'dep', date: '2026-12-12', time: '20:00', category: 'transport', transport: 'plane', label: '羽田から出発', entries: [] },
  { id: 'arr', date: '2026-12-12', time: '10:00', category: 'sightseeing', transport: 'plane', label: 'ホノルル到着', entries: [] }
];
eq('sortBlocks: 時差が分からないうちは現地時間の順（着が先に来てしまう）', T.sortBlocks(tzBlocks).map(function (b) { return b.id; }), ['arr', 'dep']);
var tzZones = T.assignBlockZones(tzBlocks, { dep: 'Asia/Tokyo', arr: 'Pacific/Honolulu' }, {}, 'Asia/Tokyo');
T.applyBlockZones(tzBlocks, tzZones);
eq('applyBlockZones: 予定ごとの時差', [tzBlocks[0]._offset, tzBlocks[1]._offset], [540, -600]);
eq('sortBlocks: 時差が分かれば世界共通の時刻の順（発→着）', T.sortBlocks(tzBlocks).map(function (b) { return b.id; }), ['dep', 'arr']);

eq('assignBlockZones: 移動の予定は出発地（直前の予定）の時差で読み、次の予定へは到着地を引き継ぐ',
  T.assignBlockZones([
    { id: 'a', date: '2026-12-12', time: '15:00', category: 'sightseeing' },
    { id: 'b', date: '2026-12-12', time: '20:00', category: 'transport' },
    { id: 'c', date: '2026-12-13', time: '09:00', category: 'food' }
  ], { a: 'Asia/Tokyo', b: 'Europe/London' }, {}, 'Asia/Tokyo'),
  { a: 'Asia/Tokyo', b: 'Asia/Tokyo', c: 'Europe/London' });
eq('assignBlockZones: 予定に場所が無ければ、その日の場所の時差', T.assignBlockZones([{ id: 'x', date: '2026-12-14', time: '10:00', category: 'food' }], {}, { '2026-12-14': 'Europe/Paris' }, 'Asia/Tokyo'), { x: 'Europe/Paris' });

eq('travelDuration: 日本20:00発→ロンドン翌01:00着（冬・時差-9時間）は14時間、到着は翌日', T.travelDuration('20:00', '01:00', 540, 0), { minutes: 840, dayShift: 1 });
eq('travelDuration: 日本20:00発→ハワイ同日10:00着は9時間、到着は同じ日付', T.travelDuration('20:00', '10:00', 540, -600), { minutes: 540, dayShift: 0 });
eq('travelDuration: 時差が分からなければ今までどおり', T.travelDuration('22:00', '06:15'), { minutes: 495, dayShift: 1 });
eq('travelLogText: 時差と「翌」を出す',
  T.travelLogText({ category: 'transport', transport: 'plane', label: 'ロンドンへ', _offset: 540 }, { costItems: [], travel: { from: '羽田', to: 'ヒースロー', depart: '20:00', arrive: '01:00' } }, 0).split('\n')[2],
  '20:00発 → 翌01:00着（14時間・時差-9時間）');
eq('offsetDiffText', [T.offsetDiffText(-540), T.offsetDiffText(60), T.offsetDiffText(330)], ['-9時間', '+1時間', '+5時間30分']);

// 地図でふりかえる：着の方が現地時間では早くても、時間軸では発の後。時計は現地時間
var tzStops = T.replayStops({ startDate: '2026-12-12', endDate: '2026-12-12' }, tzBlocks);
var tzTl = T.buildReplayTimeline(tzStops, {});
ok('buildReplayTimeline: 時差を考えた時間軸で、着(10:00ハワイ)は発(20:00日本)の後', tzTl.stops[1].t > tzTl.stops[0].t);
var tzAtArr = T.replayStateAt(tzTl, tzTl.stops[1].r + 0.01);
eq('replayStateAt: 着いたら時計は現地時間（10:00）、時差は-19時間', [tzAtArr.hhmm, tzAtArr.offsetDiff], ['10:00', -1140]);
eq('replayStateAt: 出発のときの時計は日本時間', T.replayStateAt(tzTl, tzTl.stops[0].r + 0.01).hhmm, '20:00');

/* ---- 地図でふりかえる：日ごとのジャンプ・前後の予定 ---- */
var jumpDays = T.replayDayStarts(tl);
eq('replayDayStarts: 日ごとに1つ、1日目は最初から', jumpDays.map(function (d) { return [d.dayNumber, d.r === 0]; }), [[1, true], [2, false]]);
ok('replayDayStarts: 2日目は2日目の最初の予定の少し前', jumpDays[1].r < tl.stops[3].r && jumpDays[1].r > tl.stops[2].r);
ok('replayNeighborStop: 次の予定は今より後で一番近い予定', T.replayNeighborStop(tl, 0, 1) > 0 && T.replayNeighborStop(tl, 0, 1) <= tl.stops[1].r);
eq('replayNeighborStop: 最初より前は0', T.replayNeighborStop(tl, 0.1, -1), 0);
eq('replayNeighborStop: 最後の予定の後は終わりまで', T.replayNeighborStop(tl, tl.totalReal, 1), tl.totalReal);

eq('minutesText', [T.minutesText(840), T.minutesText(90), T.minutesText(45)], ['14時間', '1時間30分', '45分']);
/* ---- 移動の予定：移動手段・移動時間（その予定から次の場所へ） ---- */
var mvBlocks = [
  { id: 'm1', date: '2026-04-01', time: '09:00', category: 'sightseeing', label: '羽田空港', entries: [{ mapUrl: 'https://maps.app.goo.gl/haneda' }] },
  { id: 'm2', date: '2026-04-01', time: '10:00', category: 'transport', transport: 'plane', moveMinutes: 90, label: '那覇へ', entries: [] },
  { id: 'm3', date: '2026-04-01', time: '', category: 'sightseeing', label: '那覇空港', entries: [{ mapUrl: 'https://maps.app.goo.gl/naha' }], createdAt: '1' },
  { id: 'm4', date: '2026-04-01', time: '', category: 'food', label: '首里そば', entries: [{ mapUrl: 'https://maps.app.goo.gl/soba' }], createdAt: '2' }
];
var mvStops = T.replayStops({ startDate: '2026-04-01', endDate: '2026-04-01' }, mvBlocks);
eq('replayStops: 移動の予定の移動手段は、次の場所への移動になる（移動の予定自身には付けない）', mvStops.map(function (s) { return s.transport; }), ['', '', 'plane', '']);
eq('replayStops: 時刻の無い次の予定は、移動時間の分だけ後と見積もる（10:00＋90分）', mvStops[2].minute, 11 * 60 + 30);
eq('travelLogText: 出発・到着が無くても移動時間があれば出す',
  T.travelLogText({ category: 'transport', transport: 'plane', moveMinutes: 90, label: '那覇へ' }, { costItems: [] }).split(String.fromCharCode(10)).slice(-1)[0], '所要時間：約1時間30分');

/* ---- メモをAIなしで分ける（parseMemo） ---- */
var memoDates = ['2026-04-01', '2026-04-02'];
var memo1 = T.parseMemo('10時 新宿\n小西遅刻\n松藤寝坊\n12時山梨\nほうとう食べた', memoDates, '2026-04-01');
eq('parseMemo: 時刻の行が予定、下の行が記録', memo1.blocks.map(function (b) { return [b.time, b.label, b.entry.episode]; }),
  [['10:00', '新宿', '小西遅刻\n松藤寝坊'], ['12:00', '山梨', 'ほうとう食べた']]);
eq('parseMemo: 決まった形ならok', memo1.ok, true);
eq('parseMemo: 全角・10時半・10時30分・区切り',
  T.parseMemo('１０：１５ 羽田\n10時半 出発\n11時05分に到着', memoDates, '2026-04-01').blocks.map(function (b) { return b.time + ' ' + b.label; }),
  ['10:15 羽田', '10:30 出発', '11:05 到着']);
eq('parseMemo: 1行に並んだ予定も分ける（／と空白）',
  T.parseMemo('10時 那覇空港集合／12時 沖縄そば https://maps.app.goo.gl/abc 15時 首里城公園', memoDates, '2026-04-01').blocks.map(function (b) { return [b.label, b.entry.mapUrl, b.category]; }),
  [['那覇空港集合', '', 'sightseeing'], ['沖縄そば', 'https://maps.app.goo.gl/abc', 'food'], ['首里城公園', '', 'sightseeing']]);
eq('parseMemo: 「2日目」「4/2」で日付が変わる',
  T.parseMemo('1日目\n10:00 A\n2日目\n9:00 B\n4/1（水）\n20:00 C', memoDates, '2026-04-01').blocks.map(function (b) { return b.date + ' ' + b.label; }),
  ['2026-04-01 A', '2026-04-02 B', '2026-04-01 C']);
eq('parseMemo: 最初の予定より前に文章があれば、決まった形ではない（AIへ）', T.parseMemo('今日は楽しかった\n10時 新宿', memoDates, '2026-04-01').ok, false);
eq('parseMemo: 時刻の行が無ければ、決まった形ではない', T.parseMemo('朝から那覇空港に集合して、そのあとそばを食べた', memoDates, '2026-04-01').ok, false);
eq('parseMemo: 種類の推定（ホテル・移動）', T.parseMemo('15時 ホテルにチェックイン\n8時 那覇へ', memoDates).blocks.map(function (b) { return b.category; }), ['lodging', 'transport']);
eq('parseMemo: 箇条書きの「・」は外す', T.parseMemo('10時 新宿\n・集合した', memoDates).blocks[0].entry.episode, '集合した');
eq('parseMemo: 25時のような時刻は予定にしない', T.parseMemo('25時 どこか', memoDates).ok, false);

/* ---- 地図でふりかえる：写真（Reliveのように） ---- */
var phStops = T.replayStops({ startDate: '2026-04-01', endDate: '2026-04-01' }, [
  { id: 'p1', date: '2026-04-01', time: '10:00', label: 'A', entries: [{ episode: '短い', photoIds: ['x1', 'x2'] }, { photoIds: ['x3'] }] },
  { id: 'p2', date: '2026-04-01', time: '10:01', label: 'B', entries: [{ episode: '短い' }] },
  { id: 'p3', date: '2026-04-01', time: '10:02', label: 'C', entries: [] }]);
eq('replayStops: 予定の記録の写真を地点に持たせる', [phStops[0].photos, phStops[1].photos], [['x1', 'x2', 'x3'], []]);
var phTl = T.buildReplayTimeline(phStops, {});
ok('buildReplayTimeline: 写真がある地点は長めに見せる（写真3枚×1.4秒。写真なしも最低2.5秒あるので差は約2秒）',
  phTl.stops[0].rDwellEnd - phTl.stops[0].r > phTl.stops[1].rDwellEnd - phTl.stops[1].r + 1.5);

/* ---- 地図でふりかえる：移動手段が無い移動は車（遠ければ飛行機） ---- */
var carStops = T.replayStops({ startDate: '2026-04-01', endDate: '2026-04-01' }, [
  { id: 'c1', date: '2026-04-01', time: '09:00', label: '新宿', entries: [{ mapUrl: 'https://x/shinjuku' }] },
  { id: 'c2', date: '2026-04-01', time: '11:00', label: '河口湖', entries: [{ mapUrl: 'https://x/kawaguchi' }] },
  { id: 'c3', date: '2026-04-01', time: '18:00', label: '那覇', entries: [{ mapUrl: 'https://x/naha' }] }]);
var carTl = T.buildReplayTimeline(carStops, { 'https://x/shinjuku': { lat: 35.69, lng: 139.70 }, 'https://x/kawaguchi': { lat: 35.50, lng: 138.76 }, 'https://x/naha': { lat: 26.21, lng: 127.68 } });
eq('buildReplayTimeline: 移動手段が無くても移動にする。近ければ車、遠ければ（400km超）飛行機', carTl.legs.map(function (l) { return l.transport; }), ['car', 'plane']);
ok('distanceKm: 新宿→那覇はおよそ1550km', Math.abs(T.distanceKm({ lat: 35.69, lng: 139.70 }, { lat: 26.21, lng: 127.68 }) - 1550) < 60);

/* ---- 紹介文：ひとこと・URL ---- */
var exText = T.reviewLogText({ category: 'food', label: '首里そば' }, { comment: 'また来たい', mapUrl: 'https://maps.app.goo.gl/x', shopUrl: 'https://shop.example', costItems: [] }, { score: 4.2, review: {} });
ok('reviewLogText: ひとこととURLを添える', exText.indexOf('ひとこと：「また来たい」') !== -1 && exText.indexOf('📍 https://maps.app.goo.gl/x') !== -1 && exText.indexOf('🔗 https://shop.example') !== -1);
ok('travelLogText: 移動にもURLを添える', T.travelLogText({ category: 'transport', transport: 'train', label: '京都へ' }, { costItems: [], travel: { from: '東京', to: '京都' }, otherUrl: 'https://jr.example' }).indexOf('🔗 https://jr.example') !== -1);

/* ---- 地図でふりかえる：移動は2秒・写真は1枚2.5秒 ---- */
var flyTl = T.buildReplayTimeline(T.replayStops({ startDate: '2026-04-01', endDate: '2026-04-02' }, [
  { id: 'h', date: '2026-04-01', time: '10:00', label: '香港', entries: [{ mapUrl: 'https://m/hk', photoIds: ['p1', 'p2', 'p3', 'p4'] }] },
  { id: 'n', date: '2026-04-02', time: '06:00', label: 'ニューヨーク', transport: 'plane', entries: [{ mapUrl: 'https://m/ny' }] }]),
  { 'https://m/hk': { lat: 22.3, lng: 114.2 }, 'https://m/ny': { lat: 40.7, lng: -74.0 } });
ok('buildReplayTimeline: 長いフライトも移動は2秒', Math.abs(flyTl.legs[0].r1 - flyTl.legs[0].r0 - 2) < 0.01);
ok('buildReplayTimeline: 写真4枚なら吹き出しを10秒以上見せる', flyTl.stops[0].rDwellEnd - flyTl.stops[0].r > 9.99);

/* ---- 時差：地図の無い予定は直前の予定を引き継ぐ（行ったり来たり防止） ---- */
// 10:00 成田（地図・東京）→12:00 LA到着（地図・LA）→15:00 ホテルで休憩（地図なし）→18:00 夕食（地図・LA）
// その日の場所（byDate）は東京。地図の無い15:00が東京に巻き戻らず、LAを引き継ぐことを確認する
var flipFlopBlocks = [
  { id: 'narita', date: '2026-08-01', time: '10:00', category: 'transport', label: '成田から出発', entries: [] },
  { id: 'laArr', date: '2026-08-01', time: '12:00', category: 'sightseeing', label: 'LA到着', entries: [] },
  { id: 'hotel', date: '2026-08-01', time: '15:00', category: 'lodging', label: 'ホテルで休憩', entries: [] },
  { id: 'dinner', date: '2026-08-01', time: '18:00', category: 'food', label: '夕食', entries: [] }
];
var flipFlopZones = T.assignBlockZones(flipFlopBlocks,
  { narita: 'Asia/Tokyo', laArr: 'America/Los_Angeles', dinner: 'America/Los_Angeles' },
  { '2026-08-01': 'Asia/Tokyo' }, 'Asia/Tokyo');
eq('assignBlockZones: 地図の無い予定は直前の予定のタイムゾーンを引き継ぐ（その日の場所には戻らない）',
  flipFlopZones, { narita: 'Asia/Tokyo', laArr: 'America/Los_Angeles', hotel: 'America/Los_Angeles', dinner: 'America/Los_Angeles' });
T.applyBlockZones(flipFlopBlocks, flipFlopZones);
var flipFlopSorted = T.sortBlocks(flipFlopBlocks);
var flipFlopChanges = 0;
for (var ffi = 1; ffi < flipFlopSorted.length; ffi++) {
  if (flipFlopSorted[ffi]._offset !== flipFlopSorted[ffi - 1]._offset) flipFlopChanges++;
}
eq('assignBlockZones: 「ここから現地時間」の切り替えは1回だけ（3回に増えない）', flipFlopChanges, 1);

// 翌日最初の予定に地図が無ければ、前日最後の予定ではなく「その日の場所」を使う
var nextDayZones = T.assignBlockZones([
  { id: 'd1a', date: '2026-01-01', time: '20:00', category: 'food' },
  { id: 'd2a', date: '2026-01-02', time: '09:00', category: 'food' }
], { d1a: 'Asia/Tokyo' }, { '2026-01-02': 'America/Los_Angeles' }, 'Asia/Tokyo');
eq('assignBlockZones: 翌日最初の地図の無い予定は前日を引き継がず、その日の場所を使う',
  nextDayZones, { d1a: 'Asia/Tokyo', d2a: 'America/Los_Angeles' });

/* ---- 地図でふりかえる：飛行機の道のり（アイコンと線を同じ弧にする。docs/adr/0008） ---- */
var flyLeg = flyTl.legs[0];
ok('buildReplayTimeline: 飛行機の区間は道のりが届くのを待たず、弧の道のりをCore側で先に作る',
  flyLeg.path && flyLeg.path.length > 2);
var flyMidR = flyLeg.r0 + (flyLeg.r1 - flyLeg.r0) * 0.5;
var flyIcon = T.replayStateAt(flyTl, flyMidR).icon;
var flyLinePoint = T.pathAt(flyLeg.path, 0.5).point;
ok('replayStateAt: 飛行機のアイコンは、線と同じ道のり（弧）の同じ点をたどる（アイコンと線がずれない）',
  Math.abs(flyIcon.lat - flyLinePoint.lat) < 1e-6 && Math.abs(flyIcon.lng - flyLinePoint.lng) < 1e-6);

// 日付変更線をまたぐ移動（ハワイ→東京）でも、経度が連続する短い方の回り方をたどる（逆回りの長い弧にならない）
var wrapPath = T.planeArcPath({ lat: 21.3, lng: -157.86 }, { lat: 35.68, lng: 139.77 }, 8);
var wrapLngChange = wrapPath[wrapPath.length - 1][1] - wrapPath[0][1];
ok('planeArcPath: 日付変更線をまたぐ移動は、経度の変化が短い方（180度以内）の回り方になる', Math.abs(wrapLngChange) <= 180 + 1e-6);
ok('planeArcPath: 経度が1点ごとに大きく飛ばず、連続して変わる', wrapPath.every(function (p, i) {
  return i === 0 || Math.abs(p[1] - wrapPath[i - 1][1]) < 30;
}));

/* ---- 地図でふりかえる：時差バナーは着陸時だけ（飛行中・出発時には出さない） ---- */
// 日本20:00発 → ハワイ同日10:00着（tzBlocksと同じ移動）に、地図でふりかえる用の座標を持たせて実際に飛ばす
var tzLocBlocks = [
  { id: 'dep', date: '2026-12-12', time: '20:00', category: 'transport', transport: 'plane', label: '羽田から出発', entries: [{ mapUrl: 'https://x/haneda' }] },
  { id: 'arr', date: '2026-12-12', time: '10:00', category: 'sightseeing', transport: 'plane', label: 'ホノルル到着', entries: [{ mapUrl: 'https://x/honolulu' }] }
];
var tzLocZones = T.assignBlockZones(tzLocBlocks, { dep: 'Asia/Tokyo', arr: 'Pacific/Honolulu' }, {}, 'Asia/Tokyo');
T.applyBlockZones(tzLocBlocks, tzLocZones);
var tzLocStops = T.replayStops({ startDate: '2026-12-12', endDate: '2026-12-12' }, tzLocBlocks);
var tzLocTl = T.buildReplayTimeline(tzLocStops, { 'https://x/haneda': { lat: 35.55, lng: 139.78 }, 'https://x/honolulu': { lat: 21.32, lng: -157.92 } });
var tzMid = T.replayStateAt(tzLocTl, (tzLocTl.legs[0].r0 + tzLocTl.legs[0].r1) / 2);
eq('replayStateAt: 飛行中は時差がまだ発地のまま（到着まで時差バナーを出さない）', tzMid.offsetDiff, 0);
var tzJustBefore = T.replayStateAt(tzLocTl, tzLocTl.legs[0].r1 - 0.001);
eq('replayStateAt: 着陸の直前もまだ発地の時差のまま', tzJustBefore.offsetDiff, 0);
var tzJustAfter = T.replayStateAt(tzLocTl, tzLocTl.legs[0].r1 + 0.001);
eq('replayStateAt: 着陸した瞬間に時差バナーの元になる値が変わる（-19時間）', tzJustAfter.offsetDiff, -1140);

/* ---- 地図でふりかえる：ルート検索が無い移動手段でも、区間の間ずっと道のりをたどりきる ---- */
var trainSamples = [0.1, 0.5, 0.9].map(function (frac) {
  var r = legAB.r0 + (legAB.r1 - legAB.r0) * frac;
  return T.replayStateAt(tl, r).icon;
});
ok('replayStateAt: OSRMのルートが無い移動手段（電車など）でも、区間の間ずっと座標が求まる（途中で経路が消えない）',
  trainSamples.every(function (ic) { return ic && isFinite(ic.lat) && isFinite(ic.lng); }));

/* ---- 地図でふりかえる：OSRMの大回り判定（歩行者専用の目的地への迂回対策。docs/adr/0008） ---- */
eq('isRouteDetourTooLong: 直線の2.5倍以内・+1.5km以内なら大回りではない', T.isRouteDetourTooLong(1, 2.4), false);
eq('isRouteDetourTooLong: 2.5倍を超えて+1.5km以上長ければ大回り', T.isRouteDetourTooLong(1, 5), true);
eq('isRouteDetourTooLong: 長距離では2.5倍未満なら（高速道路の迂回など）大回り扱いしない', T.isRouteDetourTooLong(100, 200), false);
eq('isRouteDetourTooLong: 直線距離が0・不正な値なら大回り扱いしない', [T.isRouteDetourTooLong(0, 5), T.isRouteDetourTooLong(NaN, 5)], [false, false]);
// 判定は直線2km未満の近距離だけに絞る（コルコバードの丘のように、直線は数kmでも山道で実際に大回りに
// なる道路ルートは正しい経路なので、直線に戻さない。2026-09-26）
eq('isRouteDetourTooLong: 直線3km・道のり12kmの山道は、直線2km以上なので大回り扱いしない', T.isRouteDetourTooLong(3, 12), false);
eq('isRouteDetourTooLong: 直線2km（境界）は大回り扱いしない', T.isRouteDetourTooLong(2, 10), false);
eq('isRouteDetourTooLong: 直線2km未満なら、これまでどおり2.5倍・+1.5km超えで大回り', T.isRouteDetourTooLong(1.9, 5), true);

/* ---- 地図でふりかえる：移動手段が無く、とても近い移動（1.5km未満）は徒歩とみなす ---- */
// リオデジャネイロ大聖堂→セラロン階段（約1km）。車で調べると歩行者専用の階段まで大回りすることがあるため、
// 移動手段が未設定の短い移動は最初から徒歩で調べる（isRouteDetourTooLongの大回り判定と合わせて対策）
var walkStops = T.replayStops({ startDate: '2026-04-01', endDate: '2026-04-01' }, [
  { id: 'w1', date: '2026-04-01', time: '13:00', label: 'リオデジャネイロ大聖堂', entries: [{ mapUrl: 'https://x/cathedral' }] },
  { id: 'w2', date: '2026-04-01', time: '13:30', label: 'セラロン階段', entries: [{ mapUrl: 'https://x/selaron' }] }
]);
var walkTl = T.buildReplayTimeline(walkStops, {
  'https://x/cathedral': { lat: -22.9105, lng: -43.1774 }, 'https://x/selaron': { lat: -22.9147, lng: -43.1808 }
});
eq('buildReplayTimeline: 移動手段が無く、とても近い移動（1.5km未満）は徒歩とみなす', walkTl.legs.map(function (l) { return l.transport; }), ['walk']);

/* ---- 地図でふりかえる：Worker「/geocode」に渡す「近く」は、飛行機をまたいだ先の場所を選ばない（docs/adr/0008） ---- */
// ブラジル・アルゼンチン旅行：成田空港出発（飛行機）→香港到着→ニューヨーク到着→リオデジャネイロ到着→
// リオのホテル（座標が先に分かっている）→コルコバードの丘。座標が分かっているのはリオのホテル以降だけ。
var naritaStops = [
  { date: '2024-02-10', transport: 'plane', coords: null },   // 0: 成田空港出発（この区間自体が飛行機）
  { date: '2024-02-10', transport: undefined, coords: null }, // 1: 香港到着
  { date: '2024-02-10', transport: undefined, coords: null }, // 2: ニューヨーク到着
  { date: '2024-02-11', transport: undefined, coords: null }, // 3: リオデジャネイロ到着
  { date: '2024-02-11', transport: undefined, coords: { lat: -22.97, lng: -43.19 } }, // 4: リオのホテル
  { date: '2024-02-11', transport: undefined, coords: { lat: -22.95, lng: -43.21 } }  // 5: コルコバードの丘
];
eq('geocodeNearIndexes: 成田空港出発は、間に飛行機の区間があるので18000km先のリオのホテルを近くにしない',
  T.geocodeNearIndexes(naritaStops, 0), []);
eq('geocodeNearIndexes: リオのホテル→コルコバードの丘は、同じ日付・間に飛行機が無いので近くに使う',
  T.geocodeNearIndexes(naritaStops, 5), [{ lat: -22.97, lng: -43.19 }]);
// 同じ日のロサンゼルスの2地点は、飛行機をまたいでいないので前の場所を近くとして使う
var laStops = [
  { date: '2024-02-20', transport: undefined, coords: { lat: 34.05, lng: -118.24 } }, // 0: ロサンゼルスの1地点目
  { date: '2024-02-20', transport: undefined, coords: null }                          // 1: 同じ日の2地点目（探したい場所）
];
eq('geocodeNearIndexes: 同じ日のロサンゼルスの2地点目は、同じ日の前の場所を近くにする',
  T.geocodeNearIndexes(laStops, 1), [{ lat: 34.05, lng: -118.24 }]);

/* ---- tripScheduleShift（日程を変えたら予定もずらす） ---- */
var laBlocks = [{ date: '2026-07-03' }, { date: '2026-07-05' }, { date: '2026-07-10' }, { date: '' }];
eq('addDaysToDate: 月をまたいで7日前', T.addDaysToDate('2026-07-03', -7), '2026-06-26');
eq('tripScheduleShift: 開始日を7/3→6/26に変えたら、予定も7日前にずらす',
  T.tripScheduleShift({ startDate: '2026-07-03', endDate: '2026-07-10' }, '2026-06-26', '2026-07-03', laBlocks),
  { days: -7, reason: 'start', count: 3, firstFrom: '2026-07-03', firstTo: '2026-06-26' });
eq('tripScheduleShift: 開始日を変えたら、1日目が空の旅行でも日と日の間隔を保つ（最初の予定7/5→6/28）',
  T.tripScheduleShift({ startDate: '2026-07-03', endDate: '2026-07-10' }, '2026-06-26', '2026-07-03', [{ date: '2026-07-05' }]).firstTo, '2026-06-28');
eq('tripScheduleShift: 開始日だけ先に変えて予定が日程の外に残った旅行は、最初の予定を1日目にそろえる',
  T.tripScheduleShift({ startDate: '2026-06-26', endDate: '2026-07-03' }, '2026-06-26', '2026-07-03', laBlocks),
  { days: -7, reason: 'blocks', count: 3, firstFrom: '2026-07-03', firstTo: '2026-06-26' });
eq('tripScheduleShift: 予定が日程の中に収まっていれば、1日目が空でも何もしない',
  T.tripScheduleShift({ startDate: '2026-07-01', endDate: '2026-07-10' }, '2026-07-01', '2026-07-10', laBlocks), null);
eq('tripScheduleShift: 終了日だけ変えたときは何もしない',
  T.tripScheduleShift({ startDate: '2026-07-03', endDate: '2026-07-10' }, '2026-07-03', '2026-07-12', laBlocks), null);
eq('tripScheduleShift: 日付のある予定が無ければ何もしない',
  T.tripScheduleShift({ startDate: '2026-07-03', endDate: '2026-07-10' }, '2026-06-26', '2026-07-03', [{ date: '' }]), null);
eq('tripScheduleShift: 開始日を空にしたときは何もしない',
  T.tripScheduleShift({ startDate: '2026-07-03', endDate: '2026-07-10' }, '', '', laBlocks), null);
eq('tripScheduleShift: もともと開始日が無かった旅行に開始日を入れ、予定がその前にあるなら1日目にそろえる',
  T.tripScheduleShift({ startDate: '', endDate: '' }, '2026-07-05', '', laBlocks).days, 2);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
