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
ok('reviewLogText: 見出しに種類と★', hotelText.indexOf('🏨 ホテログ ⭐3.9\nTHE TOWER HOTEL') === 0);
ok('reviewLogText: 価格は1泊あたりと合計（費用の明細から）', hotelText.indexOf('価格：〇（1泊あたり25,791円／2泊合計51,582円）') !== -1);
ok('reviewLogText: 立地は行き方を添える', hotelText.indexOf('立地：△（最寄り駅まで徒歩10分以上）') !== -1);
ok('reviewLogText: 評価の言葉で締める', /→ また泊まってもいい$/.test(hotelText));
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
ok('buildTripPostText: 使った種類の評価の基準だけ出す', post.indexOf('ホテログ：4.5〜') !== -1 && post.indexOf('飯ログ：4.5〜') !== -1 && post.indexOf('レクログ：') === -1);
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
eq('tzOffsetMinutes: ハワイは−10時間', T.tzOffsetMinutes('Pacific/Honolulu', '2026-12-12', '10:00'), -600);
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

eq('travelDuration: 日本20:00発→ロンドン翌01:00着（冬・時差−9時間）は14時間、到着は翌日', T.travelDuration('20:00', '01:00', 540, 0), { minutes: 840, dayShift: 1 });
eq('travelDuration: 日本20:00発→ハワイ同日10:00着は9時間、到着は同じ日付', T.travelDuration('20:00', '10:00', 540, -600), { minutes: 540, dayShift: 0 });
eq('travelDuration: 時差が分からなければ今までどおり', T.travelDuration('22:00', '06:15'), { minutes: 495, dayShift: 1 });
eq('travelLogText: 時差と「翌」を出す',
  T.travelLogText({ category: 'transport', transport: 'plane', label: 'ロンドンへ', _offset: 540 }, { costItems: [], travel: { from: '羽田', to: 'ヒースロー', depart: '20:00', arrive: '01:00' } }, 0).split('\n')[2],
  '20:00発 → 翌01:00着（14時間・時差−9時間）');
eq('offsetDiffText', [T.offsetDiffText(-540), T.offsetDiffText(60), T.offsetDiffText(330)], ['−9時間', '+1時間', '+5時間30分']);

// 地図でふりかえる：着の方が現地時間では早くても、時間軸では発の後。時計は現地時間
var tzStops = T.replayStops({ startDate: '2026-12-12', endDate: '2026-12-12' }, tzBlocks);
var tzTl = T.buildReplayTimeline(tzStops, {});
ok('buildReplayTimeline: 時差を考えた時間軸で、着(10:00ハワイ)は発(20:00日本)の後', tzTl.stops[1].t > tzTl.stops[0].t);
var tzAtArr = T.replayStateAt(tzTl, tzTl.stops[1].r + 0.01);
eq('replayStateAt: 着いたら時計は現地時間（10:00）、時差は−19時間', [tzAtArr.hhmm, tzAtArr.offsetDiff], ['10:00', -1140]);
eq('replayStateAt: 出発のときの時計は日本時間', T.replayStateAt(tzTl, tzTl.stops[0].r + 0.01).hhmm, '20:00');

/* ---- 地図でふりかえる：日ごとのジャンプ・前後の予定 ---- */
var jumpDays = T.replayDayStarts(tl);
eq('replayDayStarts: 日ごとに1つ、1日目は最初から', jumpDays.map(function (d) { return [d.dayNumber, d.r === 0]; }), [[1, true], [2, false]]);
ok('replayDayStarts: 2日目は2日目の最初の予定の少し前', jumpDays[1].r < tl.stops[3].r && jumpDays[1].r > tl.stops[2].r);
ok('replayNeighborStop: 次の予定は今より後で一番近い予定', T.replayNeighborStop(tl, 0, 1) > 0 && T.replayNeighborStop(tl, 0, 1) <= tl.stops[1].r);
eq('replayNeighborStop: 最初より前は0', T.replayNeighborStop(tl, 0.1, -1), 0);
eq('replayNeighborStop: 最後の予定の後は終わりまで', T.replayNeighborStop(tl, tl.totalReal, 1), tl.totalReal);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
