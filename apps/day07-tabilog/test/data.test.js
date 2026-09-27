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

/* ---- costItemJpy / formatCostItemAmount（外貨の費用明細、DAY31〜、docs/adr/0014） ---- */
eq('costItemJpy: currency省略はamountがそのまま円', T.costItemJpy({ amount: 1200 }), 1200);
eq('costItemJpy: currency:JPYもamountがそのまま円', T.costItemJpy({ amount: 1200, currency: 'JPY' }), 1200);
eq('costItemJpy: 外貨はamount×rateを円の整数に丸める', T.costItemJpy({ amount: 25, currency: 'USD', rate: 149.46 }), 3737 /* 25*149.46=3736.5→3737 */);
eq('costItemJpy: rateが無い外貨は0円扱い（未取得・未入力）', T.costItemJpy({ amount: 25, currency: 'USD' }), 0);
eq('costItemJpy: itemが無ければ0', T.costItemJpy(null), 0);
eq('formatCostItemAmount: 円はformatYenと同じ', T.formatCostItemAmount({ amount: 1200 }), '¥1,200');
eq('formatCostItemAmount: 外貨は元の金額と円換算を両方見せる', T.formatCostItemAmount({ amount: 25, currency: 'USD', rate: 149.46 }), 'US$25.00（¥3,737）');
eq('formatCostItemAmount: 記号表が無い通貨（その他）はコードをそのまま出す', T.formatCostItemAmount({ amount: 100, currency: 'ISK', rate: 0.87 }), 'ISK 100.00（¥87）');

/* ---- tripBalances / settlementPlan：外貨が混ざった費用の貸し借り（円換算後で計算する） ---- */
var mixedCurrencyBlocks = [{
  date: '2024-08-10', entries: [{ costItems: [
    { label: 'ホテル', amount: 100, currency: 'USD', rate: 150, paidBy: 'A', splitAmong: ['A', 'B'] }
  ] }]
}];
var mixedBalance = T.tripBalances({ companions: ['A', 'B'] }, mixedCurrencyBlocks);
eq('tripBalances: 外貨（USD100@150→15000円）を払った側はプラス', mixedBalance['A'], 7500);
eq('tripBalances: 外貨（USD100@150→15000円）を割った側はマイナス', mixedBalance['B'], -7500);
var mixedPlan = T.settlementPlan(mixedBalance, 100);
eq('settlementPlan: 外貨換算後の残高から精算方法を作る（100円単位）', mixedPlan, [{ from: 'B', to: 'A', amount: 7500 }]);

/* ---- tripExpenseList：外貨のcurrency・rateも一覧に残す（精算画面の表示用） ---- */
var mixedExpenses = T.tripExpenseList(mixedCurrencyBlocks);
eq('tripExpenseList: currency・rateも保持する', { currency: mixedExpenses[0].currency, rate: mixedExpenses[0].rate }, { currency: 'USD', rate: 150 });

/* ---- costBreakdownByPerson：外貨も円換算して計上する ---- */
eq('costBreakdownByPerson: 外貨はcostItemJpyで計上する', T.costBreakdownByPerson(mixedCurrencyBlocks), { A: 15000 });

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

/* ---- settlementPlan: 精算の端数（丸め）単位（Walicaと実際に突き合わせて検証、2026-09-27） ----
 * 8人・17件の実データ（Walicaの実際のグループ）。ひろが全部立て替え、他の7人が払う側。
 * Walicaの実際の送金額は「各人の厳密な貸し借りを100円単位で丸めた額」と一致し（例：
 * 22,977.5円→23,000円）、受け取る人（ひろ）の合計は153,200円で厳密な153,147.5円とはズレる
 * （各送金を独立に丸めるため）。マッチングを先に丸めてしまうとこの数字と合わなくなるため、
 * 「マッチングは端数のない実残高のまま行い、送金額だけを最後に丸める」実装を検証する。 */
var walicaMembers = ['ひろ', '小西', 'まさ', 'あつ', 'きく', 'さくら', 'こなつ', 'おその'];
var walicaBlocks = [{
  date: '2024-01-01', entries: [{ costItems: [
    { label: 'こーひー', paidBy: 'あつ', amount: 2100, splitAmong: ['あつ', 'こなつ', 'おその'] },
    { label: '薪', paidBy: 'きく', amount: 1000, splitAmong: walicaMembers },
    { label: 'コロッケ', paidBy: 'きく', amount: 500, splitAmong: ['まさ'] },
    { label: 'ラーメン', paidBy: 'あつ', amount: 1200, splitAmong: ['きく'] },
    { label: 'ラーメン', paidBy: 'まさ', amount: 1200, splitAmong: ['小西'] },
    { label: 'ラーメン', paidBy: 'ひろ', amount: 1200, splitAmong: ['小西'] },
    { label: 'モルック負けお茶', paidBy: 'ひろ', amount: 780, splitAmong: ['ひろ', '小西', 'きく', 'こなつ'] },
    { label: 'ラーメンつけ麺', paidBy: 'おその', amount: 10500, splitAmong: walicaMembers },
    { label: '高速', paidBy: 'ひろ', amount: 6800, splitAmong: walicaMembers },
    { label: '山本屋牛串', paidBy: 'きく', amount: 330, splitAmong: ['小西'] },
    { label: '山本屋', paidBy: 'きく', amount: 1980, splitAmong: ['まさ'] },
    { label: '駐車場', paidBy: 'きく', amount: 1000, splitAmong: walicaMembers },
    { label: '山本屋', paidBy: 'ひろ', amount: 2310, splitAmong: ['こなつ'] },
    { label: '山本屋', paidBy: 'ひろ', amount: 2915, splitAmong: ['あつ'] },
    { label: '買い出し', paidBy: 'ひろ', amount: 35000, splitAmong: walicaMembers },
    { label: 'タイムズ', paidBy: 'ひろ', amount: 19000, splitAmong: walicaMembers },
    { label: '宿代', paidBy: 'ひろ', amount: 108000, splitAmong: walicaMembers },
  ] }]
}];
var walicaBalance = T.tripBalances({ companions: walicaMembers }, walicaBlocks);
function planByFrom(plan) {
  var out = {};
  plan.forEach(function (p) { out[p.from] = p.amount; });
  return out;
}
// planByFromはfor...inの列挙順（挿入順）で比較するので、期待値もキーの並びをそろえておく
// （中身の値そのものは順不同で正しい。JSON.stringifyでの比較のため）。
eq('settlementPlan: Walica実データ・単位100円（実際の送金額と一致）', planByFrom(T.settlementPlan(walicaBalance, 100)), {
  'こなつ': 25900, '小西': 25600, 'まさ': 23900, 'あつ': 23000, 'さくら': 22700, 'きく': 19200, 'おその': 12900
});
eq('settlementPlan: Walica実データ・単位1円（.5は0から遠い方へ丸める）', planByFrom(T.settlementPlan(walicaBalance, 1)), {
  'こなつ': 25868, '小西': 25588, 'まさ': 23943, 'あつ': 22978, 'さくら': 22663, 'きく': 19248, 'おその': 12863
});
eq('settlementPlan: Walica実データ・単位10円', planByFrom(T.settlementPlan(walicaBalance, 10)), {
  'こなつ': 25870, '小西': 25590, 'まさ': 23940, 'あつ': 22980, 'さくら': 22660, 'きく': 19250, 'おその': 12860
});
T.settlementPlan(walicaBalance, 100).forEach(function (p) { ok('settlementPlan: Walica・宛先は必ずひろ', p.to === 'ひろ'); });

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

/* ---- manualWeatherDisplay（手動で選ぶ天気アイコン。場所の入力欄の代わりに2026-09-26〜） ---- */
eq('manualWeatherDisplay: 晴れ(1)', T.manualWeatherDisplay(1), { code: 1, icon: '☀️', label: '晴れ' });
eq('manualWeatherDisplay: 晴れ時々くもり(2)', T.manualWeatherDisplay(2), { code: 2, icon: '🌤️', label: '晴れ時々くもり' });
eq('manualWeatherDisplay: くもり(3)', T.manualWeatherDisplay(3), { code: 3, icon: '☁️', label: 'くもり' });
eq('manualWeatherDisplay: 雨(61)', T.manualWeatherDisplay(61), { code: 61, icon: '🌧️', label: '雨' });
eq('manualWeatherDisplay: 雷雨(95)', T.manualWeatherDisplay(95), { code: 95, icon: '⛈️', label: '雷雨' });
eq('manualWeatherDisplay: 雪(71)', T.manualWeatherDisplay(71), { code: 71, icon: '❄️', label: '雪' });
eq('manualWeatherDisplay: nullはnull（選んでいない）', T.manualWeatherDisplay(null), null);
eq('manualWeatherDisplay: undefinedもnull', T.manualWeatherDisplay(undefined), null);
eq('manualWeatherDisplay: 古い快晴(0)は晴れに寄せる', T.manualWeatherDisplay(0), { code: 1, icon: '☀️', label: '晴れ' });
eq('manualWeatherDisplay: 古い霧(45)はくもりに寄せる', T.manualWeatherDisplay(45), { code: 3, icon: '☁️', label: 'くもり' });
eq('manualWeatherDisplay: 古い霧雨(51)は雨に寄せる', T.manualWeatherDisplay(51), { code: 61, icon: '🌧️', label: '雨' });
eq('manualWeatherDisplay: 古いにわか雨(80)は雨に寄せる', T.manualWeatherDisplay(80), { code: 61, icon: '🌧️', label: '雨' });
eq('manualWeatherDisplay: 古いにわか雪(85)は雪に寄せる', T.manualWeatherDisplay(85), { code: 71, icon: '❄️', label: '雪' });
eq('manualWeatherDisplay: 未知のコードはnull', T.manualWeatherDisplay(30), null);

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

/* ---- 記録フォーム：地図のURLはundefined/NaNを絶対に書かない（placeMapUrl。2026-09-27） ---- */
eq('placeMapUrl: 座標が数値で揃っていれば座標のURL', T.placeMapUrl({ lat: 34.7334658, lng: 135.5002547 }, 'ユニバ'),
  'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('34.7334658,135.5002547'));
eq('placeMapUrl: 座標がまだ無い（placeIdだけ）候補は検索文字列のURL', T.placeMapUrl({ placeId: 'abc' }, 'ユニバ'),
  'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('ユニバ'));
eq('placeMapUrl: 候補が無ければ検索文字列のURL', T.placeMapUrl(null, 'ユニバ'),
  'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('ユニバ'));
eq('placeMapUrl: 候補も検索文字列も無ければ空文字（URLを作らない）', T.placeMapUrl(null, ''), '');
ok('placeMapUrl: 座標がNaN・undefinedのときは、URLにundefined/NaNの文字が絶対に入らない', [
  T.placeMapUrl({ lat: NaN, lng: 135 }, 'ユニバ'),
  T.placeMapUrl({ lat: undefined, lng: undefined }, 'ユニバ'),
  T.placeMapUrl({ lat: 34.7, lng: undefined }, '')
].every(function (url) { return url.indexOf('undefined') === -1 && url.indexOf('NaN') === -1; }));

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
var stJustArriveB = T.replayStateAt(tl, tl.stops[1].r + 0.01);
eq('replayStateAt: 着いた直後（一呼吸の間）はまだ吹き出しが出ない', stJustArriveB.captionIndex, -1);
var stArriveB = T.replayStateAt(tl, tl.stops[1].r + 0.5 + 0.01);
eq('replayStateAt: 一呼吸（0.5秒）置いたら到着した予定の吹き出しが出る', stArriveB.captionIndex, 1);
eq('replayStateAt: 到着したら時計はその予定の時刻', stArriveB.hhmm, '12:00');
eq('replayStateAt: 一呼吸の間も時計はその予定の時刻のまま', stJustArriveB.hhmm, '12:00');
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

/* ---- 地図でふりかえる：吹き出しの間、旅の時計はその予定の時刻で止まる（2026-09-27、大阪旅行の実データより） ---- */
// 13:00の予定なのに、吹き出しを見せている途中で13:08まで進んで見えていた不具合の再現テスト
var freezeStops = T.replayStops({ startDate: '2026-04-01', endDate: '2026-04-01' }, [
  { id: 'fz1', date: '2026-04-01', time: '13:00', category: 'transport', transport: 'train', label: '新大阪からユニバへ', entries: [{ mapUrl: 'https://x/usj' }] },
  { id: 'fz2', date: '2026-04-01', time: '13:16', category: 'food', transport: 'car', label: 'たこ焼きを食べる', entries: [{ mapUrl: 'https://x/tako' }] }
]);
var freezeTl = T.buildReplayTimeline(freezeStops, {
  'https://x/usj': { lat: 34.7334658, lng: 135.5002547 }, 'https://x/tako': { lat: 34.6686537, lng: 135.4375962 }
});
var fzStop = freezeTl.stops[0];
ok('buildReplayTimeline: 吹き出しを見せている間（rCaptionStart〜rDwellEndの直前）はどの時点でも旅の時計が予定の時刻のまま',
  [fzStop.rCaptionStart, (fzStop.rCaptionStart + fzStop.rDwellEnd) / 2, fzStop.rDwellEnd - 1e-4].every(function (r) {
    return T.replayStateAt(freezeTl, r).t === fzStop.t;
  }));
eq('replayStateAt: 止まっている間の時計は13:00のまま（以前は8分進んで13:08と表示されていた）',
  T.replayStateAt(freezeTl, (fzStop.rCaptionStart + fzStop.rDwellEnd) / 2).hhmm, '13:00');

/* ---- 地図でふりかえる：地図が壊れている移動の予定でも、移動手段は次の地点へ引き継ぐ（大阪旅行の実データより） ---- */
// 赤レンガ倉庫（地図あり）→新横浜から大阪への移動（電車、地図が壊れている＝地点にならない）
// →新大阪からユニバへ（電車、地図あり）。以前は真ん中の予定が地点にならないと、次の地点自身の
// category==='transport'な予定は「次への移動」の意味だからと無視され、車に化けていた
var inheritStops = T.replayStops({ startDate: '2026-09-19', endDate: '2026-09-19' }, [
  { id: 'akarenga', date: '2026-09-19', time: '10:07', category: 'other', label: 'みなとみらい発', entries: [{ mapUrl: 'https://maps.google.com/?q=赤レンガ倉庫' }] },
  { id: 'move', date: '2026-09-19', time: '10:43', category: 'transport', transport: 'train', moveMinutes: 180, label: '新横浜から大阪への移動', entries: [{ mapUrl: 'https://maps.google.com/?query=undefined%2Cundefined' }] },
  { id: 'usj', date: '2026-09-19', time: '13:00', category: 'transport', transport: 'train', label: '新大阪からユニバへ', entries: [{ mapUrl: 'https://maps.google.com/search/?api=1&query=34.7334658,135.5002547' }] }
]);
eq('replayStops: 地図の壊れた移動の予定も、地点にならないだけで移動手段は引き継ぐ',
  inheritStops.map(function (s) { return s.transport; }), ['', '', 'train']);
var inheritTl = T.buildReplayTimeline(inheritStops, {
  'https://maps.google.com/?q=赤レンガ倉庫': { lat: 35.4545, lng: 139.6425 },
  'https://maps.google.com/search/?api=1&query=34.7334658,135.5002547': { lat: 34.7334658, lng: 135.5002547 }
});
eq('buildReplayTimeline: 途中の予定の地図が壊れていても、区間の移動手段は電車のまま（車に化けない）',
  inheritTl.legs.map(function (l) { return [l.transport, l.assumed]; }), [['train', false]]);

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
eq('routeProfileFor: 車・タクシー・バスは車道、徒歩・自転車はそれぞれ、電車・新幹線・地下鉄は線路（railプロファイル。道路プロファイルではない）、飛行機はルート検索しない',
  ['car', 'taxi', 'bus', 'walk', 'bicycle', 'train', 'shinkansen', 'subway', 'plane', ''].map(T.routeProfileFor),
  ['car', 'car', 'car', 'foot', 'bike', 'rail', 'rail', 'rail', '', '']);
var rtPath = [[35.0, 139.0], [35.0, 139.1], [35.1, 139.1]];
var rtHalf = T.pathAt(rtPath, 0.5);
ok('pathAt: 半分の位置は、長さで見た道のりの真ん中（1本目の終わり付近）', Math.abs(rtHalf.point.lng - 139.1) < 0.01 && Math.abs(rtHalf.point.lat - 35.0) < 0.01);
eq('pathAt: 半分までの折れ線は、通った角を含む', rtHalf.prefix.length >= 2, true);
eq('pathAt: 0は出発地、1は到着地', [T.pathAt(rtPath, 0).point, T.pathAt(rtPath, 1).point], [{ lat: 35.0, lng: 139.0 }, { lat: 35.1, lng: 139.1 }]);
var rtTl = T.buildReplayTimeline(rpStops, rpCoords);
rtTl.legs[0].path = [[35.69, 139.70], [35.69, 138.57], [35.66, 138.57]];
var rtMid = T.replayStateAt(rtTl, (rtTl.legs[0].r0 + rtTl.legs[0].r1) / 2);
ok('replayStateAt: 道のりがある移動は、直線ではなく道のりの上を進む（途中で西へ大きく回る）', Math.abs(rtMid.icon.lat - 35.69) < 0.02 && rtMid.icon.lng < 139.2);

/* ---- 地図でふりかえる：吹き出しは全文（長さで表示時間は変えない・写真の枚数で決まる） ---- */
var capLong = 'あ'.repeat(60);
var capStops = T.replayStops({ startDate: '2026-04-01', endDate: '2026-04-01' }, [
  { id: 'x1', date: '2026-04-01', time: '10:00', label: 'A', entries: [{ episode: capLong }] },
  { id: 'x2', date: '2026-04-01', time: '10:01', label: 'B', entries: [{ episode: '短い' }] },
  { id: 'x3', date: '2026-04-01', time: '10:02', label: 'C', entries: [] }]);
eq('replayStops: 吹き出しは40文字で切らず全文', capStops[0].captions[0].length, 60);
var capTl = T.buildReplayTimeline(capStops, {});
ok('buildReplayTimeline: 長い吹き出し（60文字）でも写真が無ければ短い吹き出しと同じ長さ（3秒）',
  Math.abs((capTl.stops[0].rDwellEnd - capTl.stops[0].r) - (capTl.stops[1].rDwellEnd - capTl.stops[1].r)) < 0.01);

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
ok('buildReplayTimeline: 写真なしの地点は固定3秒（＋着いてからの一呼吸0.5秒）', Math.abs((phTl.stops[1].rDwellEnd - phTl.stops[1].r) - 3.5) < 0.01);
ok('buildReplayTimeline: 写真3枚の地点は1枚2.5秒×3＝7.5秒（＋一呼吸0.5秒）', Math.abs((phTl.stops[0].rDwellEnd - phTl.stops[0].r) - 8.0) < 0.01);

/* ---- 地図でふりかえる：移動手段が無い移動は車（遠ければ飛行機） ---- */
var carStops = T.replayStops({ startDate: '2026-04-01', endDate: '2026-04-01' }, [
  { id: 'c1', date: '2026-04-01', time: '09:00', label: '新宿', entries: [{ mapUrl: 'https://x/shinjuku' }] },
  { id: 'c2', date: '2026-04-01', time: '11:00', label: '河口湖', entries: [{ mapUrl: 'https://x/kawaguchi' }] },
  { id: 'c3', date: '2026-04-01', time: '18:00', label: '那覇', entries: [{ mapUrl: 'https://x/naha' }] }]);
var carTl = T.buildReplayTimeline(carStops, { 'https://x/shinjuku': { lat: 35.69, lng: 139.70 }, 'https://x/kawaguchi': { lat: 35.50, lng: 138.76 }, 'https://x/naha': { lat: 26.21, lng: 127.68 } });
eq('buildReplayTimeline: 移動手段が無くても移動にする。近ければ車、遠ければ（400km超）飛行機', carTl.legs.map(function (l) { return l.transport; }), ['car', 'plane']);
ok('distanceKm: 新宿→那覇はおよそ1550km', Math.abs(T.distanceKm({ lat: 35.69, lng: 139.70 }, { lat: 26.21, lng: 127.68 }) - 1550) < 60);

/* ---- 地図でふりかえる：道のりが届く前から、すべての区間を線でつなぐ（旅は全部必ずつなげる。2026-09-27） ---- */
ok('buildReplayTimeline: 車の区間も、道のりが届く前からやわらかい曲線で最初からつながっている',
  carTl.legs[0].path && carTl.legs[0].path.length > 2);
ok('gentleCurvePath: 直線ではなく少し膨らむ（8%程度）', (function () {
  var p = T.gentleCurvePath({ lat: 35.69, lng: 139.70 }, { lat: 35.50, lng: 138.76 });
  var mid = p[Math.round(p.length / 2)];
  var straightMidLat = (35.69 + 35.50) / 2, straightMidLng = (139.70 + 138.76) / 2;
  return Math.abs(mid[0] - straightMidLat) > 1e-4 || Math.abs(mid[1] - straightMidLng) > 1e-4;
})());
eq('gentleCurvePath: 端点は出発地・到着地のまま', [T.gentleCurvePath({ lat: 35, lng: 139 }, { lat: 36, lng: 140 })[0], T.gentleCurvePath({ lat: 35, lng: 139 }, { lat: 36, lng: 140 }).slice(-1)[0]],
  [[35, 139], [36, 140]]);

/* ---- 地図でふりかえる：長い移動は少し長く見せる（100km以下2秒〜500km以上4秒。2026-09-27） ---- */
eq('legMoveSeconds: 100km以下は2秒・500km以上は4秒・間は比例', [T.legMoveSeconds(50), T.legMoveSeconds(100), T.legMoveSeconds(300), T.legMoveSeconds(500), T.legMoveSeconds(2000)],
  [2, 2, 3, 4, 4]);
ok('buildReplayTimeline: 近い車の区間（100km以下）は移動2秒のまま', Math.abs(carTl.legs[0].r1 - carTl.legs[0].r0 - 2) < 0.01);
ok('buildReplayTimeline: 遠い区間（500km以上、飛行機とみなす）は移動1.8秒（飛行機は全体で約3秒にする。2026-09-27）', Math.abs(carTl.legs[1].r1 - carTl.legs[1].r0 - 1.8) < 0.01);

/* ---- 紹介文：ひとこと・URL ---- */
var exText = T.reviewLogText({ category: 'food', label: '首里そば' }, { comment: 'また来たい', mapUrl: 'https://maps.app.goo.gl/x', shopUrl: 'https://shop.example', costItems: [] }, { score: 4.2, review: {} });
ok('reviewLogText: ひとこととURLを添える', exText.indexOf('ひとこと：「また来たい」') !== -1 && exText.indexOf('📍 https://maps.app.goo.gl/x') !== -1 && exText.indexOf('🔗 https://shop.example') !== -1);
ok('travelLogText: 移動にもURLを添える', T.travelLogText({ category: 'transport', transport: 'train', label: '京都へ' }, { costItems: [], travel: { from: '東京', to: '京都' }, otherUrl: 'https://jr.example' }).indexOf('🔗 https://jr.example') !== -1);

/* ---- 地図でふりかえる：移動は基本2秒・写真は1枚2.5秒（長い移動は少し長く見せる。2026-09-27） ---- */
var flyTl = T.buildReplayTimeline(T.replayStops({ startDate: '2026-04-01', endDate: '2026-04-02' }, [
  { id: 'h', date: '2026-04-01', time: '10:00', label: '香港', entries: [{ mapUrl: 'https://m/hk', photoIds: ['p1', 'p2', 'p3', 'p4'] }] },
  { id: 'n', date: '2026-04-02', time: '06:00', label: 'ニューヨーク', transport: 'plane', entries: [{ mapUrl: 'https://m/ny' }] }]),
  { 'https://m/hk': { lat: 22.3, lng: 114.2 }, 'https://m/ny': { lat: 40.7, lng: -74.0 } });
// 飛行機は距離によらず1.8秒（4秒＋カメラの動き・一呼吸で5秒ほどかかり長いという声より。2026-09-27）
ok('buildReplayTimeline: 長いフライトは移動1.8秒', Math.abs(flyTl.legs[0].r1 - flyTl.legs[0].r0 - 1.8) < 0.01);
var longCarTl = T.buildReplayTimeline(T.replayStops({ startDate: '2026-04-01', endDate: '2026-04-01' }, [
  { id: 'a', date: '2026-04-01', time: '08:00', label: 'LA', entries: [{ mapUrl: 'https://m/la' }] },
  { id: 'b', date: '2026-04-01', time: '18:00', label: 'サンフランシスコ', transport: 'car', entries: [{ mapUrl: 'https://m/sf' }] }]),
  { 'https://m/la': { lat: 34.05, lng: -118.24 }, 'https://m/sf': { lat: 37.77, lng: -122.42 } });
ok('buildReplayTimeline: 車の長い移動（500km超）はこれまでどおり4秒', Math.abs(longCarTl.legs[0].r1 - longCarTl.legs[0].r0 - 4) < 0.01);
// 次へ移動する地点は、カメラが動き出す少し前（REPLAY_CAPTION_HIDE_LEAD_SEC）に吹き出しを消すので、その分を足す
// （見えている時間は1枚2.5秒×4＋一呼吸0.5秒のまま。2026-09-27）
ok('buildReplayTimeline: 写真4枚なら吹き出しは見えている時間で10秒（1枚2.5秒×4、＋一呼吸0.5秒）',
  Math.abs((flyTl.stops[0].rDwellEnd - flyTl.stops[0].r) - (10.5 + T.REPLAY_CAPTION_HIDE_LEAD_SEC)) < 0.01);

/* ---- 地図でふりかえる：吹き出しの秒数は写真の枚数だけで決まる（2026-09-27） ---- */
var capSecStops = T.replayStops({ startDate: '2026-04-01', endDate: '2026-04-01' }, [
  { id: 'nop', date: '2026-04-01', time: '10:00', label: '写真なし', entries: [{ episode: '写真なし' }] },
  { id: 'two', date: '2026-04-01', time: '10:30', label: '写真2枚', entries: [{ photoIds: ['a', 'b'] }] },
  { id: 'six', date: '2026-04-01', time: '11:00', label: '写真6枚', entries: [{ photoIds: ['a', 'b', 'c', 'd', 'e', 'f'] }] }]);
var capSecTl = T.buildReplayTimeline(capSecStops, {});
ok('buildReplayTimeline: 写真なしは約3秒（＋一呼吸0.5秒）', Math.abs((capSecTl.stops[0].rDwellEnd - capSecTl.stops[0].r) - 3.5) < 0.01);
ok('buildReplayTimeline: 写真2枚は約5秒（2.5秒×2、＋一呼吸0.5秒）', Math.abs((capSecTl.stops[1].rDwellEnd - capSecTl.stops[1].r) - 5.5) < 0.01);
ok('buildReplayTimeline: 写真6枚でも4枚分の10秒で頭打ち（＋一呼吸0.5秒）', Math.abs((capSecTl.stops[2].rDwellEnd - capSecTl.stops[2].r) - 10.5) < 0.01);

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
// 2026-09-27の方針変更（時差は移動のところでしか変わらない）：移動の予定が無ければ、翌日の地図の無い予定も
// 同じかたまりの時差のまま。以前は「その日の場所」を使っていたため、その日の場所が日本になっていると
// ニューヨークの予定に「日本との時差ゼロ」が出ていた
eq('assignBlockZones: 移動の予定が無ければ、翌日の地図の無い予定もその日の場所ではなく同じかたまりの時差',
  nextDayZones, { d1a: 'Asia/Tokyo', d2a: 'Asia/Tokyo' });

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
eq('tripScheduleShift: 予定が日程の中に収まっていて、最初の空きが2日までなら何もしない（到着日に予定が無い旅など）',
  T.tripScheduleShift({ startDate: '2026-07-01', endDate: '2026-07-10' }, '2026-07-01', '2026-07-10', laBlocks), null);
eq('tripScheduleShift: 開始日だけ前に動かして最初の7日が空いたままの旅（ワールドカップ旅）は、最初の予定を1日目にそろえる',
  T.tripScheduleShift({ startDate: '2026-06-26', endDate: '2026-07-12' }, '2026-06-26', '2026-07-12', laBlocks),
  { days: -7, reason: 'blocks', count: 3, firstFrom: '2026-07-03', firstTo: '2026-06-26' });
eq('tripScheduleShift: 最初の空きがちょうど3日なら聞く',
  T.tripScheduleShift({ startDate: '2026-06-30', endDate: '2026-07-12' }, '2026-06-30', '2026-07-12', laBlocks).days, -3);
eq('tripScheduleShift: 終了日だけ変えたときは何もしない',
  T.tripScheduleShift({ startDate: '2026-07-03', endDate: '2026-07-10' }, '2026-07-03', '2026-07-12', laBlocks), null);
eq('tripScheduleShift: 日付のある予定が無ければ何もしない',
  T.tripScheduleShift({ startDate: '2026-07-03', endDate: '2026-07-10' }, '2026-06-26', '2026-07-03', [{ date: '' }]), null);
eq('tripScheduleShift: 開始日を空にしたときは何もしない',
  T.tripScheduleShift({ startDate: '2026-07-03', endDate: '2026-07-10' }, '', '', laBlocks), null);
eq('tripScheduleShift: もともと開始日が無かった旅行に開始日を入れ、予定がその前にあるなら1日目にそろえる',
  T.tripScheduleShift({ startDate: '', endDate: '' }, '2026-07-05', '', laBlocks).days, 2);

/* ---- 時差：日付変更線を東へ越える移動日（成田6/26 20:00発 → ロサンゼルス6/26 18:00着） ---- */
// 現地時間の順だと着(18:00)が発(20:00)より前に来て、発もロサンゼルス時間で読まれ、着→発のまま固まっていた（2026-09-26）
function laDepartureOrder(flightZone, arrivalCategory, dayZone) {
  var bs = [
    { createdAt: '1', id: 'f', date: '2026-06-26', time: '20:00', category: 'transport', transport: 'plane', label: '成田から出発' },
    { createdAt: '2', id: 'a', date: '2026-06-26', time: '18:00', category: arrivalCategory, label: 'ロサンゼルス空港に到着' },
    { createdAt: '3', id: 'u', date: '2026-06-26', time: '20:30', category: 'sightseeing', label: 'ユニオンステーション' }
  ];
  var own = { a: 'America/Los_Angeles', u: 'America/Los_Angeles' };
  if (flightZone) own.f = flightZone;
  T.applyBlockZones(bs, T.assignBlockZones(bs, own, dayZone ? { '2026-06-26': dayZone } : {}, 'Asia/Tokyo'));
  return T.sortBlocks(bs).map(function (b) { return b.id + ':' + b._tz; });
}
var laWant = ['f:Asia/Tokyo', 'a:America/Los_Angeles', 'u:America/Los_Angeles'];
eq('assignBlockZones: 成田発(地図はLAX)→LA着は、発を日本時間で読んで発→着の順', laDepartureOrder('America/Los_Angeles', 'sightseeing', 'America/Los_Angeles'), laWant);
eq('assignBlockZones: 成田発(地図は成田)→LA着(移動の予定)も発→着の順', laDepartureOrder('Asia/Tokyo', 'transport', 'America/Los_Angeles'), laWant);
eq('assignBlockZones: 成田発(地図なし)→LA着(移動の予定)も発→着の順', laDepartureOrder('', 'transport', 'Asia/Tokyo'), laWant);
// 同じ日に日付変更線をまたがない移動は、入れた順が逆でも時差を考えた順のまま（前の日から続くタイムゾーンで読む）
var laNy = [
  { createdAt: '0', id: 'p', date: '2026-07-01', time: '19:00', category: 'food' },
  { createdAt: '3', id: 'b', date: '2026-07-02', time: '07:00', category: 'food' },
  { createdAt: '1', id: 'f', date: '2026-07-02', time: '09:00', category: 'transport' },
  { createdAt: '2', id: 'a', date: '2026-07-02', time: '17:30', category: 'sightseeing' }
];
eq('assignBlockZones: LA→ニューヨークの日は、入れた順が逆でも朝食→LA発→NY着',
  T.assignBlockZones(laNy, { p: 'America/Los_Angeles', b: 'America/Los_Angeles', f: 'America/New_York', a: 'America/New_York' }, {}, 'Asia/Tokyo'),
  { p: 'America/Los_Angeles', b: 'America/Los_Angeles', f: 'America/Los_Angeles', a: 'America/New_York' });

/* ---- 日本の電車：線路データから最短経路（新大阪→USJのような区間） ---- */
// 出発地のすぐそば（約100m）に新幹線の線路（北東へ遠ざかり、在来線とつながらない）、
// 少し離れた所（約500m）に在来線（南西へ伸びて到着地の近くを通る）がある。
var railA = { lat: 34.7335, lng: 135.5002 }, railB = { lat: 34.6687, lng: 135.4376 };
var railEls = [
  { type: 'node', id: 1, lat: 34.7344, lon: 135.5003 }, { type: 'node', id: 2, lat: 34.7600, lon: 135.5400 }, // 新幹線
  { type: 'node', id: 10, lat: 34.7380, lon: 135.4990 }, { type: 'node', id: 11, lat: 34.7100, lon: 135.4700 },
  { type: 'node', id: 12, lat: 34.6850, lon: 135.4500 }, { type: 'node', id: 13, lat: 34.6690, lon: 135.4380 }, // 在来線
  { type: 'node', id: 20, lat: 34.7380, lon: 135.4990 }, { type: 'node', id: 21, lat: 34.9000, lon: 135.9000 }, // 遠回りの支線
  { type: 'way', id: 100, nodes: [1, 2] },
  { type: 'way', id: 101, nodes: [10, 11, 12, 13] },
  { type: 'way', id: 102, nodes: [20, 21] }
];
var railPath = T.railPathFromOverpass(railEls, railA, railB);
ok('railPathFromOverpass: すぐそばの新幹線の線路ではなく、在来線から乗って到着地の近くまで線路をたどる', railPath && railPath.length === 6);
eq('railPathFromOverpass: 両端は出発地と到着地、途中は在来線の点の順', railPath && railPath.map(function (p) { return p[0]; }),
  [34.7335, 34.738, 34.71, 34.685, 34.669, 34.6687]);
eq('railPathFromOverpass: 近くに線路が無ければnull（やわらかい曲線のまま）',
  T.railPathFromOverpass([{ type: 'node', id: 1, lat: 35.0, lon: 136.0 }, { type: 'node', id: 2, lat: 35.1, lon: 136.1 }, { type: 'way', id: 9, nodes: [1, 2] }], railA, railB), null);
// 在来線が大きく迂回して、直線距離の3倍を超えるなら使わない
var railDetour = railEls.filter(function (e) { return e.id !== 101; }).concat([
  { type: 'node', id: 30, lat: 34.9500, lon: 135.2000 },
  { type: 'way', id: 103, nodes: [10, 30, 13] }
]);
eq('railPathFromOverpass: 直線距離の3倍を超える遠回りはnull', T.railPathFromOverpass(railDetour, railA, railB), null);
eq('railPathFromOverpass: 30kmより遠い区間は使わない（新幹線など）', T.railPathFromOverpass(railEls, railA, { lat: 35.0116, lng: 135.7681 }), null);
ok('isInJapan: 大阪は日本、ロサンゼルスは日本ではない', T.isInJapan(railA) && !T.isInJapan({ lat: 34.05, lng: -118.24 }));
var bb = T.railBBox(railA, railB);
ok('railBBox: 2地点を含み、少し広げた範囲', bb[0] < railB.lat && bb[1] < railB.lng && bb[2] > railA.lat && bb[3] > railA.lng);
ok('railOverpassQuery: 範囲と線路の種類が入る', T.railOverpassQuery(bb).indexOf(bb.join(',')) > 0 && T.railOverpassQuery(bb).indexOf('subway') > 0);

/* ---- 地図でふりかえる：飛行機が近い区間に付き違う（LAX→ラスベガスの飛行機の予定にラスベガス空港の地図） ---- */
var lasTl = T.buildReplayTimeline(T.replayStops({ startDate: '2026-07-01', endDate: '2026-07-01' }, [
  { id: 'lax', date: '2026-07-01', time: '08:00', label: 'ロサンゼルスのホテル', entries: [{ mapUrl: 'https://m/lax' }] },
  { id: 'fly', date: '2026-07-01', time: '10:00', label: 'ラスベガスへ飛行機', category: 'transport', transport: 'plane', entries: [{ mapUrl: 'https://m/las' }] },
  { id: 'fla', date: '2026-07-01', time: '13:00', label: 'フラミンゴ', category: 'lodging', entries: [{ mapUrl: 'https://m/fla' }] }]),
  { 'https://m/lax': { lat: 34.05, lng: -118.24 }, 'https://m/las': { lat: 36.084, lng: -115.1537 }, 'https://m/fla': { lat: 36.1162, lng: -115.1716 } });
eq('buildReplayTimeline: 飛行機はLA→ラスベガス（約370km）に付き、空港→フラミンゴ（約4km）は車で道をたどる',
  lasTl.legs.map(function (l) { return l.transport; }), ['plane', 'car']);
ok('buildReplayTimeline: 空港→フラミンゴは道のりを調べる手段（車）になる', T.routeProfileFor(lasTl.legs[1].transport) === 'car');

/* ---- 道のりの両端をピンにつなぐ（コルコバードの丘→大聖堂で最初の部分が見えない） ---- */
var corco = { lat: -22.9519, lng: -43.2105 }, cated = { lat: -22.9109, lng: -43.1806 };
var roadPath = [[-22.9530, -43.2080], [-22.9300, -43.1950], [-22.9110, -43.1807]]; // 道路は山頂から約280m離れた所から始まる
var joined = T.joinPathEnds(roadPath, corco, cated);
eq('joinPathEnds: 道路の端がピンから離れていれば、ピンから始まるよう先頭に足す', joined[0], [-22.9519, -43.2105]);
eq('joinPathEnds: 到着側はピンとの差が20m未満ならそのまま（点を足さない）', joined.length, 4);
eq('joinPathEnds: 両端がピンに近ければ変えない', T.joinPathEnds([[1, 2], [3, 4]], { lat: 1, lng: 2 }, { lat: 3, lng: 4 }).length, 2);

/* ---- 時差は「移動」のところでしか変わらない（ブラジル・アルゼンチン旅の形。2026-09-27） ---- */
var trip4 = [
  { id: 'home', date: '2026-03-01', time: '08:00', category: 'other', label: '自宅' },
  { id: 'nrt', date: '2026-03-01', time: '10:00', category: 'transport', transport: 'plane', label: '成田から出発' },
  { id: 'hkA', date: '2026-03-01', time: '14:00', category: 'transport', label: '香港に到着' },
  { id: 'hkH', date: '2026-03-01', time: '16:00', category: 'lodging', label: '香港のホテル' },
  { id: 'hkD', date: '2026-03-02', time: '10:00', category: 'transport', transport: 'plane', label: '香港から出発' },
  { id: 'nyA', date: '2026-03-02', time: '12:00', category: 'transport', label: 'ニューヨークに到着' },
  { id: 'nyH', date: '2026-03-02', time: '15:00', category: 'lodging', label: 'ニューヨークのホテル（地図なし）' },
  { id: 'ts', date: '2026-03-03', time: '09:00', category: 'sightseeing', label: 'タイムズスクエア' },
  { id: 'ct', date: '2026-03-03', time: '10:00', category: 'sightseeing', label: 'チャイナタウン（仁川と判定）' },
  { id: 'bw', date: '2026-03-03', time: '12:00', category: 'sightseeing', label: 'ブロードウェイ' },
  { id: 'nyD', date: '2026-03-04', time: '09:00', category: 'transport', transport: 'plane', label: 'ニューヨークから出発' },
  { id: 'rioA', date: '2026-03-04', time: '20:00', category: 'transport', label: 'リオデジャネイロに到着' },
  { id: 'rioH', date: '2026-03-04', time: '22:00', category: 'lodging', label: 'リオのホテル' }
].map(function (b, i) { b.createdAt = String(100 + i); return b; });
var trip4Own = { nrt: 'Asia/Tokyo', hkA: 'Asia/Hong_Kong', hkH: 'Asia/Hong_Kong', hkD: 'Asia/Hong_Kong', nyA: 'America/New_York',
  ts: 'America/New_York', ct: 'Asia/Seoul', bw: 'America/New_York', nyD: 'America/New_York', rioA: 'America/Sao_Paulo', rioH: 'America/Sao_Paulo' };
// その日の場所がずれている（ニューヨークの日が日本）
var trip4Days = { '2026-03-01': 'Asia/Tokyo', '2026-03-02': 'Asia/Tokyo', '2026-03-03': 'America/New_York', '2026-03-04': 'America/New_York' };
var trip4Z = T.assignBlockZones(trip4, trip4Own, trip4Days, 'Asia/Tokyo');
eq('時差のかたまり：出発前・成田出発は日本', [trip4Z.home, trip4Z.nrt], ['Asia/Tokyo', 'Asia/Tokyo']);
eq('時差のかたまり：「香港に到着」から香港（出発のときではなく到着のときに時差が入る）', [trip4Z.hkA, trip4Z.hkH, trip4Z.hkD], ['Asia/Hong_Kong', 'Asia/Hong_Kong', 'Asia/Hong_Kong']);
eq('時差のかたまり：ニューヨークのホテル（地図なし）は、その日の場所（日本）ではなくニューヨーク', [trip4Z.nyA, trip4Z.nyH], ['America/New_York', 'America/New_York']);
eq('時差のかたまり：チャイナタウン1つだけ韓国と判定されても、ニューヨークのまま', trip4Z.ct, 'America/New_York');
eq('時差のかたまり：ニューヨーク出発はニューヨーク、「リオに到着」からリオ', [trip4Z.nyD, trip4Z.rioA, trip4Z.rioH], ['America/New_York', 'America/Sao_Paulo', 'America/Sao_Paulo']);
var trip4Sorted = T.sortBlocks(T.applyBlockZones(trip4.map(function (b) { return Object.assign({}, b); }), trip4Z));
var trip4Changes = [];
for (var t4 = 1; t4 < trip4Sorted.length; t4++) if (trip4Sorted[t4]._offset !== trip4Sorted[t4 - 1]._offset) trip4Changes.push(trip4Sorted[t4].id);
eq('時差のかたまり：「ここから現地時間」は香港到着・ニューヨーク到着・リオ到着の3か所だけ', trip4Changes, ['hkA', 'nyA', 'rioA']);

/* ---- 時差：出発と到着をどちらも「飛行機」の移動の予定で入れる形（ブラジル・アルゼンチン旅の実際の入れ方） ---- */
var trip5 = [
  { id: 'nrtD', date: '2026-03-01', time: '10:00', category: 'transport', transport: 'plane', label: '成田から出発' },
  { id: 'hkA', date: '2026-03-01', time: '14:00', category: 'transport', transport: 'plane', label: '香港に到着' },
  { id: 'hkH', date: '2026-03-01', time: '16:00', category: 'lodging', label: '香港のホテル' },
  { id: 'hkD', date: '2026-03-02', time: '10:00', category: 'transport', transport: 'plane', label: '香港から出発' },
  { id: 'nyA', date: '2026-03-02', time: '12:00', category: 'transport', transport: 'plane', label: 'ニューヨークに到着' },
  { id: 'nyH', date: '2026-03-02', time: '15:00', category: 'lodging', label: 'ニューヨークのホテル（地図なし）' }
].map(function (b, i) { b.createdAt = String(200 + i); return b; });
var trip5Own = { nrtD: 'Asia/Tokyo', hkA: 'Asia/Hong_Kong', hkH: 'Asia/Hong_Kong', hkD: 'Asia/Hong_Kong', nyA: 'America/New_York' };
var trip5Z = T.assignBlockZones(trip5, trip5Own, { '2026-03-02': 'Asia/Tokyo' }, 'Asia/Tokyo');
eq('時差（到着も飛行機の予定）：到着の予定から現地の時差、出発の予定は出発地の時差',
  ['nrtD', 'hkA', 'hkH', 'hkD', 'nyA', 'nyH'].map(function (id) { return trip5Z[id]; }),
  ['Asia/Tokyo', 'Asia/Hong_Kong', 'Asia/Hong_Kong', 'Asia/Hong_Kong', 'America/New_York', 'America/New_York']);
var trip5Sorted = T.sortBlocks(T.applyBlockZones(trip5.map(function (b) { return Object.assign({}, b); }), trip5Z));
var trip5Changes = [];
for (var t5 = 1; t5 < trip5Sorted.length; t5++) if (trip5Sorted[t5]._offset !== trip5Sorted[t5 - 1]._offset) trip5Changes.push(trip5Sorted[t5].id);
eq('時差（到着も飛行機の予定）：「ここから現地時間」は到着の予定の前（香港に到着・ニューヨークに到着）だけ', trip5Changes, ['hkA', 'nyA']);

var trip5Stops = T.replayStops({ startDate: '2026-03-01', endDate: '2026-03-02' }, trip5Sorted);
eq('地図でふりかえる（到着も飛行機の予定）：香港に到着・ニューヨークに到着の時点で現地の時差（分）になる',
  trip5Stops.filter(function (st) { return st.blockId === 'hkA' || st.blockId === 'nyA' || st.blockId === 'nrtD'; }).map(function (st) { return st.offset; }),
  [540, 480, -300]);

/* ---- 吹き出し：写真1枚・エピソードだけでも3秒は見える（2026-09-27） ---- */
var capTl = T.buildReplayTimeline(T.replayStops({ startDate: '2026-04-01', endDate: '2026-04-01' }, [
  { id: 'p1', date: '2026-04-01', time: '10:00', label: '写真1枚', entries: [{ mapUrl: 'https://m/a', photoIds: ['x'] }] },
  { id: 'ep', date: '2026-04-01', time: '10:05', label: 'エピソードだけ', entries: [{ mapUrl: 'https://m/b', episode: 'たのしかった' }] },
  { id: 'end', date: '2026-04-01', time: '10:10', label: '最後', entries: [{ mapUrl: 'https://m/c' }] }]),
  { 'https://m/a': { lat: 35.0, lng: 135.0 }, 'https://m/b': { lat: 35.01, lng: 135.0 }, 'https://m/c': { lat: 35.02, lng: 135.0 } });
var visibleSec = function (st) { return st.rDwellEnd - st.rCaptionStart - T.REPLAY_CAPTION_HIDE_LEAD_SEC; };
ok('buildReplayTimeline: 写真1枚の地点も、吹き出しが見えている時間は3秒以上', visibleSec(capTl.stops[0]) >= 3 - 1e-6);
ok('buildReplayTimeline: エピソードだけの地点も、吹き出しが見えている時間は3秒以上', visibleSec(capTl.stops[1]) >= 3 - 1e-6);

/* ---- 時差：リオ→イグアス→ブエノスアイレス→エル・カラファテは、国やタイムゾーン名が変わっても時差は同じ（UTC-3） ---- */
var sa = [
  { id: 'rio', date: '2026-03-05', time: '10:00', category: 'sightseeing' },
  { id: 'rioD', date: '2026-03-06', time: '09:00', category: 'transport', transport: 'plane' },
  { id: 'igu', date: '2026-03-06', time: '12:00', category: 'sightseeing' },
  { id: 'iguD', date: '2026-03-07', time: '09:00', category: 'transport', transport: 'plane' },
  { id: 'bue', date: '2026-03-07', time: '12:00', category: 'sightseeing' },
  { id: 'bueD', date: '2026-03-08', time: '09:00', category: 'transport', transport: 'plane' },
  { id: 'cal', date: '2026-03-08', time: '13:00', category: 'sightseeing' }
].map(function (b, i) { b.createdAt = String(300 + i); return b; });
var saZ = T.assignBlockZones(sa, { rio: 'America/Sao_Paulo', igu: 'America/Argentina/Cordoba', bue: 'America/Argentina/Buenos_Aires', cal: 'America/Argentina/Rio_Gallegos' }, {}, 'Asia/Tokyo');
eq('時差：イグアス・ブエノスアイレス・エル・カラファテはそれぞれの土地のタイムゾーンになる', [saZ.igu, saZ.bue, saZ.cal], ['America/Argentina/Cordoba', 'America/Argentina/Buenos_Aires', 'America/Argentina/Rio_Gallegos']);
var saSorted = T.sortBlocks(T.applyBlockZones(sa.map(function (b) { return Object.assign({}, b); }), saZ));
eq('時差：リオ→イグアス→ブエノスアイレス→エル・カラファテはどこもUTC-3なので「ここから現地時間」は出ない',
  saSorted.filter(function (b, i) { return i > 0 && b._offset !== saSorted[i - 1]._offset; }).length, 0);

/* ---- 日付変更線：東京20:00発→ロサンゼルス18:50着（同じ日付）は、予定を入れた順・入れ方によらず発→着の順（2026-09-27） ---- */
(function () {
  var TK = 'Asia/Tokyo', LA = 'America/Los_Angeles', ng = [];
  var orders = { '入れた順': ['hnd', 'fl', 'arr', 'htl', 'd2'], '到着を先に入れた': ['hnd', 'arr', 'fl', 'htl', 'd2'], '逆順で入れた': ['d2', 'htl', 'arr', 'fl', 'hnd'] };
  Object.keys(orders).forEach(function (oname) {
    [null, TK, LA].forEach(function (flMap) {
      [['sightseeing', undefined], ['transport', 'plane']].forEach(function (arrKind) {
        [null, LA].forEach(function (dayZone) {
          var bs = [
            { id: 'hnd', date: '2026-06-26', time: '18:00', category: 'sightseeing', label: '羽田空港' },
            { id: 'fl', date: '2026-06-26', time: '20:00', category: 'transport', transport: 'plane', label: 'ロサンゼルスへのフライト' },
            { id: 'arr', date: '2026-06-26', time: '18:50', category: arrKind[0], transport: arrKind[1], label: 'ロサンゼルス到着' },
            { id: 'htl', date: '2026-06-26', time: '21:00', category: 'lodging', label: 'ホテル' },
            { id: 'd2', date: '2026-06-27', time: '09:00', category: 'sightseeing', label: '翌日' }];
          bs.forEach(function (b) { b.createdAt = String(orders[oname].indexOf(b.id)); });
          var own = { hnd: TK, arr: LA, htl: LA, d2: LA };
          if (flMap) own.fl = flMap;
          var z = T.assignBlockZones(bs, own, dayZone ? { '2026-06-26': dayZone } : {}, TK);
          var got = T.sortBlocks(T.applyBlockZones(bs.map(function (b) { return Object.assign({}, b); }), z)).map(function (b) { return b.id; }).join(',');
          if (got !== 'hnd,fl,arr,htl,d2' || z.fl !== TK || z.arr !== LA) ng.push(oname + '/' + flMap + '/' + arrKind[0] + '/' + dayZone + ' → ' + got);
        });
      });
    });
  });
  eq('日付変更線：入れた順（3通り）×フライトの地図（3通り）×到着の入れ方（2通り）×その日の場所（2通り）の36通りすべてで、羽田→フライト（日本時間）→ロサンゼルス到着の順', ng, []);
})();

/* ---- 移動の予定に「到着地の地図＋到着時刻（現地時間）」を入れると、時差の区切りと地図でふりかえるの到着に使う（2026-09-27） ---- */
(function () {
  var TK = 'Asia/Tokyo', LA = 'America/Los_Angeles';
  var LAX = 'https://www.google.com/maps/search/?api=1&query=33.94,-118.40';
  var bs = [
    { id: 'hnd', date: '2026-06-26', time: '18:00', category: 'sightseeing', label: '羽田空港', createdAt: '1' },
    { id: 'fl', date: '2026-06-26', time: '20:00', category: 'transport', transport: 'plane', label: 'ロサンゼルスへ', createdAt: '2',
      entries: [{ id: 'e1', travel: { to: 'ロサンゼルス空港', arrive: '18:50', arriveMapUrl: LAX, arriveLat: 33.94, arriveLng: -118.40 } }] },
    { id: 'htl', date: '2026-06-26', time: '21:00', category: 'lodging', label: 'ホテル', createdAt: '3' }];
  eq('travelArrival：到着地の地図・座標・時刻・名前を返す', T.travelArrival(bs[1]), { url: LAX, lat: 33.94, lng: -118.40, time: '18:50', label: 'ロサンゼルス空港' });
  eq('travelArrival：移動以外の予定はnull', T.travelArrival(bs[0]), null);
  // ホテルに地図が無くても、到着地の時差（LA）から後ろがLAになる
  var z = T.assignBlockZones(bs, { hnd: TK }, {}, TK, { fl: LA });
  eq('到着地の地図だけで：フライトは日本時間、到着とその後はロサンゼルス', [z.fl, z['fl#arrive'], z.htl], [TK, LA, LA]);
  var zb = T.applyBlockZones(bs.map(function (b) { return Object.assign({}, b); }), z);
  var st = T.replayStops({ startDate: '2026-06-26', endDate: '2026-06-27' }, zb);
  eq('地図でふりかえる：フライトの後に到着の地点が入る', st.map(function (s) { return s.blockId; }), ['hnd', 'fl', 'fl#arrive', 'htl']);
  var a = st[2];
  eq('到着の地点：座標・ラベル・到着時刻（現地）・時差', [a.knownLat, a.knownLng, a.label, a.minute, a.dayIndex, a.offset], [33.94, -118.40, 'ロサンゼルス空港', 18 * 60 + 50, 0, -420]);
  var tl = T.buildReplayTimeline(st, {});
  eq('到着（LA 18:50）は出発（東京 20:00）より後の時刻として並ぶ', tl.stops[2].t > tl.stops[1].t && tl.stops[3].t > tl.stops[2].t, true);
  eq('到着の後の場所へは、飛行機を引き継がない', st[3].transport, '');
  // 逆向き：LA 23:00発→東京 05:00着（現地）は、出発より前にならない日付（翌々日）に置く
  var back = [{ id: 'fb', date: '2026-07-10', time: '23:00', category: 'transport', transport: 'plane', label: '帰国', createdAt: '1', _offset: -420, _arriveOffset: 540,
    entries: [{ id: 'e2', travel: { arrive: '05:00', arriveMapUrl: 'https://www.google.com/maps/search/?api=1&query=35.55,139.78' } }] }];
  var st2 = T.replayStops({ startDate: '2026-07-10', endDate: '2026-07-12' }, back);
  eq('LA 23:00発→東京 05:00着：到着は出発の後の日付（2日目以降）', [st2[1].date, st2[1].minute], ['2026-07-12', 300]);
  // 到着時刻が無ければ、移動時間（無ければ60分）の後と見積もる
  var noTime = [{ id: 'm', date: '2026-04-01', time: '10:00', category: 'transport', transport: 'train', moveMinutes: 90, label: '移動', createdAt: '1',
    entries: [{ id: 'e3', travel: { arriveMapUrl: 'https://www.google.com/maps/search/?api=1&query=34.73,135.50' } }] }];
  var st3 = T.replayStops({ startDate: '2026-04-01', endDate: '2026-04-01' }, noTime);
  eq('到着時刻なし：移動時間90分の後・見積もり扱い・ラベルは「到着」', [st3[1].minute, st3[1].estimated, st3[1].label], [11 * 60 + 30, true, '到着']);
})();

/* ---- ワールドカップ旅1日目（実データの形）：車の移動の予定「ロサンゼルス国際空港」「ユニオンステーション」は、その地図の
   土地の時間。東京の「羽田空港の地震」とロサンゼルスの出来事は、入れた順・フライトの地図・到着地の地図によらず東京→LAの順（2026-09-27） ---- */
(function () {
  var TK = 'Asia/Tokyo', LA = 'America/Los_Angeles', ng = [];
  [null, TK, LA].forEach(function (flMap) {
    [false, true].forEach(function (pre) {
      [false, true].forEach(function (arrive) {
        [['home', 'eq', 'fl', 'lax', 'uni', 'fan'], ['home', 'lax', 'uni', 'fan', 'eq', 'fl'], ['fan', 'uni', 'lax', 'fl', 'eq', 'home']].forEach(function (ord, oi) {
          var bs = [
            pre && { id: 'home', date: '2026-06-26', time: '15:00', category: 'sightseeing', label: '家' },
            { id: 'lax', date: '2026-06-26', time: '18:50', category: 'transport', transport: 'car', label: 'ロサンゼルス国際空港' },
            { id: 'eq', date: '2026-06-26', time: '20:00', category: 'other', label: '羽田空港の地震' },
            { id: 'uni', date: '2026-06-26', time: '20:20', category: 'transport', transport: 'car', label: 'ユニオンステーション' },
            { id: 'fl', date: '2026-06-26', time: '20:00', category: 'transport', transport: 'plane', label: 'ロサンゼルスへのフライト' },
            { id: 'fan', date: '2026-06-26', time: '21:00', category: 'sightseeing', label: 'ファンゾーン' }].filter(Boolean);
          bs.forEach(function (b) { b.createdAt = String(ord.indexOf(b.id)); });
          var own = { lax: LA, eq: TK, uni: LA, fan: LA };
          if (pre) own.home = TK;
          if (flMap) own.fl = flMap;
          var z = T.assignBlockZones(bs, own, {}, TK, arrive ? { fl: LA } : {});
          var got = T.sortBlocks(T.applyBlockZones(bs.map(function (b) { return Object.assign({}, b); }), z)).map(function (b) { return b.id; }).filter(function (id) { return id !== 'home'; }).join(',');
          var zs = [z.eq, z.fl, z.lax, z.uni, z.fan].join(',');
          if (got !== 'eq,fl,lax,uni,fan' || zs !== [TK, TK, LA, LA, LA].join(',')) ng.push(flMap + '/' + pre + '/' + arrive + '/' + oi + ' → ' + got);
        });
      });
    });
  });
  eq('ワールドカップ旅1日目：36通りすべてで 地震・フライト（東京）→ LAX・ユニオンステーション・ファンゾーン（LA）', ng, []);
})();

/* ---- 「ロサンゼルスへのフライト」（地図は行き先のLAX）＋「ロサンゼルス国際空港」（移動・飛行機）の2つの飛行機の予定：
   到着地の地図が無くても、見出しの「〜へ」で出発の予定と分かり、東京→LAの順になる（2026-09-27、ビルド65で直っていなかった形） ---- */
(function () {
  var TK = 'Asia/Tokyo', LA = 'America/Los_Angeles', ng = [];
  [['eq', 'fl', 'lax', 'uni', 'fan'], ['lax', 'uni', 'fan', 'eq', 'fl']].forEach(function (ord, oi) {
    [LA, null].forEach(function (laxMap) {
      [TK, LA, null].forEach(function (day) {
        var bs = [
          { id: 'lax', date: '2026-06-26', time: '18:50', category: 'transport', transport: 'plane', label: 'ロサンゼルス国際空港' },
          { id: 'eq', date: '2026-06-26', time: '20:00', category: 'other', label: '羽田空港の地震' },
          { id: 'uni', date: '2026-06-26', time: '20:20', category: 'transport', transport: '', label: 'ユニオンステーション' },
          { id: 'fl', date: '2026-06-26', time: '20:00', category: 'transport', transport: 'plane', label: 'ロサンゼルスへのフライト' },
          { id: 'fan', date: '2026-06-26', time: '21:00', category: 'sightseeing', label: 'ファンゾーン' }];
        bs.forEach(function (b) { b.createdAt = String(ord.indexOf(b.id)); });
        var own = { eq: TK, fl: LA, uni: LA, fan: LA };
        if (laxMap) own.lax = laxMap;
        var z = T.assignBlockZones(bs, own, day ? { '2026-06-26': day } : {}, TK);
        var got = T.sortBlocks(T.applyBlockZones(bs.map(function (b) { return Object.assign({}, b); }), z)).map(function (b) { return b.id; }).join(',');
        if (got !== 'eq,fl,lax,uni,fan' || z.fl !== TK || z.lax !== LA) ng.push(oi + '/' + laxMap + '/' + day + ' → ' + got);
      });
    });
  });
  eq('「〜へのフライト」は行き先の地図でも出発の予定：東京（地震・フライト）→ LA（空港・ユニオンステーション・ファンゾーン）', ng, []);
})();

/* ---- 実データ（ワールドカップ旅1日目、「時差の並びを調べる」で取得。2026-09-27）：移動手段が空欄の移動の予定が3つ。
   ロサンゼルス国際空港（地図LA）・ユニオンステーション（地図なし）はLA、フライト（地図は羽田・到着地LA 18:00）は日本 ---- */
(function () {
  var TK = 'Asia/Tokyo', LA = 'America/Los_Angeles';
  var arrive = [{ id: 'e', travel: { arrive: '18:00', arriveMapUrl: 'https://www.google.com/maps/search/?api=1&query=33.94,-118.40', arriveLat: 33.94, arriveLng: -118.40 } }];
  var bs = [
    { id: 'lax', date: '2026-06-26', time: '18:50', category: 'transport', transport: '', label: 'ロサンゼルス国際空港', createdAt: '2026-09-23T13:34:00' },
    { id: 'eq', date: '2026-06-26', time: '20:00', category: 'other', label: '羽田空港の地震', createdAt: '2026-09-23T14:01:00' },
    { id: 'uni', date: '2026-06-26', time: '20:20', category: 'transport', transport: '', label: 'ユニオンステーション', createdAt: '2026-09-23T13:34:01' },
    { id: 'fl', date: '2026-06-26', time: '20:00', category: 'transport', transport: '', label: 'ロサンゼルスへのフライト', createdAt: '2026-09-23T14:01:01', entries: arrive },
    { id: 'fan', date: '2026-06-26', time: '21:00', category: 'sightseeing', label: 'ファンゾーン', createdAt: '2026-09-23T14:01:02' },
    { id: 'inn', date: '2026-06-26', time: '21:30', category: 'food', label: 'In-N-Out Burger', createdAt: '2026-09-23T13:34:02' },
    { id: 'kiku', date: '2026-06-26', time: '22:30', category: 'lodging', label: '菊の家', createdAt: '2026-09-23T13:34:03' }];
  var z = T.assignBlockZones(bs, { lax: LA, eq: TK, fl: TK, kiku: LA }, { '2026-06-26': LA }, TK, { fl: LA });
  var order = T.sortBlocks(T.applyBlockZones(bs.map(function (b) { return Object.assign({}, b); }), z)).map(function (b) { return b.id; });
  eq('実データ：羽田の地震・フライト（日本）→ LAX・ユニオンステーション・ファンゾーン・In-N-Out・菊の家（LA）', order, ['eq', 'fl', 'lax', 'uni', 'fan', 'inn', 'kiku']);
  eq('実データ：時差', [z.eq, z.fl, z.lax, z.uni, z.fan, z.inn, z.kiku], [TK, TK, LA, LA, LA, LA, LA]);
  eq('見出しが「〜フライト」なら移動手段が空欄でも飛行機', [(T.isPlaneMove||function(){return true;})({ transport: '', label: 'ロサンゼルスへのフライト' }), (T.isPlaneMove||function(){return false;})({ transport: '', label: 'ロサンゼルス国際空港' }), (T.isPlaneMove||function(){return false;})({ transport: 'car', label: 'フライト後の送迎' })], [true, false, false]);
})();

/* ---- 地図でふりかえる：日付変更線をまたいだら、そのあとの地点の経度を±360度して続ける（香港→ニューヨークで、
   ニューヨークまでの足跡が別の周回に描かれて見えなくなっていた。2026-09-27） ---- */
(function () {
  var stops = [
    { blockId: 'tk', dayIndex: 0, minute: 600, query: 'tk', transport: '' },
    { blockId: 'hk', dayIndex: 0, minute: 900, query: 'hk', transport: 'plane' },
    { blockId: 'ny', dayIndex: 1, minute: 600, query: 'ny', transport: 'plane' },
    { blockId: 'rio', dayIndex: 3, minute: 600, query: 'rio', transport: 'plane' }];
  var tl = T.buildReplayTimeline(stops, { tk: { lat: 35.68, lng: 139.77 }, hk: { lat: 22.31, lng: 113.92 }, ny: { lat: 40.64, lng: -73.78 }, rio: { lat: -22.81, lng: -43.25 } });
  eq('日付変更線：ニューヨーク・リオは経度+360度で続く', tl.stops.map(function (s) { return Math.round(s.lng); }), [140, 114, 286, 317]);
  var hkNy = tl.legs[1];
  var end = hkNy.path[hkNy.path.length - 1];
  eq('日付変更線：香港→ニューヨークの弧の終わりがニューヨークの地点と同じ経度', Math.round(end[1]), 286);
  eq('日付変更線：距離は経度をずらしても変わらない', Math.round(T.distanceKm(tl.stops[2], tl.stops[3])), Math.round(T.distanceKm({ lat: 40.64, lng: -73.78 }, { lat: -22.81, lng: -43.25 })));
  eq('wrapLng：-180〜180度に戻す', [T.wrapLng(286.22), T.wrapLng(-200), T.wrapLng(139.77), T.wrapLng(180)].map(function (x) { return Math.round(x * 100) / 100; }), [-73.78, 160, 139.77, 180]);
})();

/* ---- 実データ（ブラジル・アルゼンチン旅、2024-02-10。2026-09-27）：ニューヨーク到着と出発の間の「英語表現の疑問」は、
   地図があってもなくてもニューヨークの時差（以前は地図なしだとリオの時差で出発より前に並んでいた） ---- */
(function () {
  var TK = 'Asia/Tokyo', HK = 'Asia/Hong_Kong', NY = 'America/New_York', SP = 'America/Sao_Paulo';
  var bs = [
    { id: 'nrt', date: '2024-02-10', time: '10:35', category: 'transport', transport: 'plane', label: '成田空港出発' },
    { id: 'hkA', date: '2024-02-10', time: '15:00', category: 'transport', transport: 'plane', label: '香港到着' },
    { id: 'ear', date: '2024-02-10', time: '16:00', category: 'other', label: 'イヤホンジャック忘れ' },
    { id: 'hkD', date: '2024-02-10', time: '16:20', category: 'transport', transport: 'plane', label: '香港出発' },
    { id: 'nyA', date: '2024-02-10', time: '19:05', category: 'transport', transport: '', label: 'ニューヨーク到着' },
    { id: 'eng', date: '2024-02-10', time: '22:00', category: 'other', label: '英語表現の疑問' },
    { id: 'nyD', date: '2024-02-10', time: '21:55', category: 'transport', transport: '', label: 'ニューヨーク出発' },
    { id: 'rio', date: '2024-02-11', time: '09:00', category: 'lodging', label: 'リオのホテル' }
  ].map(function (b, i) { b.createdAt = String(i); return b; });
  [null, NY].forEach(function (engMap) {
    var own = { nrt: TK, hkA: HK, nyA: NY, rio: SP };
    if (engMap) own.eng = engMap;
    var z = T.assignBlockZones(bs, own, { '2024-02-10': TK, '2024-02-11': SP }, TK);
    var got = T.sortBlocks(T.applyBlockZones(bs.map(function (b) { return Object.assign({}, b); }), z)).map(function (b) { return b.id; });
    eq('実データ（英語表現の疑問、地図' + (engMap ? 'あり' : 'なし') + '）：ニューヨークの時差で、ニューヨーク出発の後', [z.eng, got.join(',')], [NY, 'nrt,hkA,ear,hkD,nyA,nyD,eng,rio']);
  });
})();

/* ---- 宿泊先を手で足す：何泊目からの選択肢（2026-09-27） ---- */
eq('lodgingNightOptions：3泊4日なら1〜3泊目', T.lodgingNightOptions({ startDate: '2026-06-26', endDate: '2026-06-29' }, []),
  [{ date: '2026-06-26', label: '1泊目（6/26）' }, { date: '2026-06-27', label: '2泊目（6/27）' }, { date: '2026-06-28', label: '3泊目（6/28）' }]);
eq('lodgingNightOptions：日帰りはその日', T.lodgingNightOptions({ startDate: '2026-04-01', endDate: '2026-04-01' }, []), [{ date: '2026-04-01', label: '4/1' }]);
eq('lodgingNightOptions：日程なし・予定なしは空', T.lodgingNightOptions({}, []), []);

/* ---- 宿泊先の内訳の行と、その元になった予定（行をタップして直すため。2026-09-27） ---- */
(function () {
  var bs = [
    { id: 'k1', date: '2026-06-26', time: '22:30', category: 'lodging', label: '菊の家' },
    { id: 'k2', date: '2026-06-28', time: '01:00', category: 'lodging', label: '菊の家' },
    { id: 'h', date: '2026-06-28', time: '13:00', category: 'lodging', label: 'コートヤード' },
    { id: 'x', date: '2026-06-27', time: '10:00', category: 'food', label: '昼' }];
  var g = T.lodgingGroupBlocks({ startDate: '2026-06-26', endDate: '2026-06-30' }, bs);
  eq('lodgingGroupBlocks：行（泊）とlodgingByNightが同じまとめ方', g.map(function (x) { return [x.from, x.to, x.label]; }),
    T.lodgingByNight({ startDate: '2026-06-26', endDate: '2026-06-30' }, bs).map(function (x) { return [x.from, x.to, x.label]; }));
  eq('lodgingGroupBlocks：行ごとの元の予定', g.map(function (x) { return x.blockIds; }), [['k1'], ['h']]);
})();

/* ---- 宿泊先の行を直す：泊まり始めを行の途中の夜にしたら、その夜から先だけを新しい宿に（2026-09-27。
   「同上」でまとめた1〜3泊目を「3泊目からマリオット」に直したら、1〜2泊目の宿が3泊目へ移って未定になっていた） ---- */
(function () {
  var k1 = { id: 'k1', date: '2026-06-26', time: '22:30' }, h = { id: 'h', date: '2026-06-28', time: '13:00' };
  eq('lodgingEditPlan：途中の夜に予定があれば、それから先だけ名前を変える（手前は動かさない）',
    T.lodgingEditPlan([k1, h], '2026-06-26', '2026-06-28'), { rename: ['h'], move: null, create: null });
  eq('lodgingEditPlan：途中の夜に予定が無ければ、その夜に予定を足す',
    T.lodgingEditPlan([k1], '2026-06-26', '2026-06-27'), { rename: [], move: null, create: '2026-06-27' });
  eq('lodgingEditPlan：泊まり始めがそのままなら、行の予定すべての名前を変える',
    T.lodgingEditPlan([k1, h], '2026-06-26', '2026-06-26'), { rename: ['k1', 'h'], move: null, create: null });
  eq('lodgingEditPlan：前にずらしたら、最初の予定をその日へ移す',
    T.lodgingEditPlan([h], '2026-06-28', '2026-06-27'), { rename: ['h'], move: { id: 'h', date: '2026-06-27' }, create: null });
})();

/* ---- 泊ごとの宿と、「n泊目〜m泊目をこの宿にする」（2026-09-27） ---- */
(function () {
  var trip = { startDate: '2026-06-26', endDate: '2026-07-05' }; // 9泊
  var bs = [
    { id: 'k1', date: '2026-06-26', time: '22:30', category: 'lodging', label: '菊の家' },
    { id: 'h', date: '2026-06-28', time: '13:00', category: 'lodging', label: 'マリオット' },
    { id: 'p', date: '2026-07-01', time: '', category: 'lodging', label: 'パタゴニア' }];
  eq('lodgingNights：泊ごとの宿', T.lodgingNights(trip, bs).map(function (n) { return n.night + ':' + n.label; }),
    ['1:菊の家', '2:菊の家', '3:マリオット', '4:マリオット', '5:マリオット', '6:パタゴニア', '7:パタゴニア', '8:パタゴニア', '9:パタゴニア']);
  eq('lodgingRangePlan：7泊目だけ別の宿（7泊目に足し、8泊目にパタゴニアを足して戻す）', T.lodgingRangePlan(trip, bs, 7, 7, 'X'),
    { rename: [], create: [{ date: '2026-07-02', label: 'X', mapFrom: null, target: true }, { date: '2026-07-03', label: 'パタゴニア', mapFrom: 'p', target: false }], target: null });
  eq('lodgingRangePlan：7〜9泊目（最後まで）は戻す予定を足さない', T.lodgingRangePlan(trip, bs, 7, 9, 'X').create.length, 1);
  eq('lodgingRangePlan：3〜5泊目の名前を変える（予定を移さない）', T.lodgingRangePlan(trip, bs, 3, 5, 'コートヤード'),
    { rename: ['h'], create: [], target: 'h' });
  eq('lodgingRangePlan：1〜3泊目を菊の家（同上）→ マリオットの予定の名前を変え、4泊目にマリオットを足して戻す', T.lodgingRangePlan(trip, bs, 1, 3, '菊の家'),
    { rename: ['h'], create: [{ date: '2026-06-29', label: 'マリオット', mapFrom: 'h', target: false }], target: 'k1' });
})();

/* ---- 宿泊先カードの短い表し方（2026-09-27） ---- */
eq('lodgingSummary：いちばん長く泊まった宿＋ほか○か所', T.lodgingSummary([{ label: '菊の家', from: 1, to: 2 }, { label: 'マリオット', from: 3, to: 3 }, { label: 'フラミンゴ', from: 4, to: 4 }, { label: '菊の家', from: 7, to: 9 }]), '菊の家 ほか2か所');
eq('lodgingSummary：1か所だけなら名前', T.lodgingSummary([{ label: '菊の家', from: 1, to: 3 }]), '菊の家');
eq('lodgingSummary：未定は数えない・全部未定なら空', [T.lodgingSummary([{ label: '', from: 1, to: 2 }, { label: 'A', from: 3, to: 3 }]), T.lodgingSummary([{ label: '', from: 1, to: 2 }])], ['A', '']);

/* ---- 地図でふりかえるの「何日目」は予定の日付に合わせる（香港16:20発→ニューヨーク19:05着、どちらも1日目。2026-09-27） ---- */
(function () {
  var stops = [
    { blockId: 'hk', dayIndex: 0, dayNumber: 1, minute: 16 * 60 + 20, offset: 480, query: 'hk', transport: '' },
    { blockId: 'ny', dayIndex: 0, dayNumber: 1, minute: 19 * 60 + 5, offset: -300, query: 'ny', transport: 'plane' },
    { blockId: 'rio', dayIndex: 1, dayNumber: 2, minute: 12 * 60, offset: -180, query: 'rio', transport: 'plane' }];
  var tl = T.buildReplayTimeline(stops, { hk: { lat: 22.31, lng: 113.92 }, ny: { lat: 40.64, lng: -73.78 }, rio: { lat: -22.81, lng: -43.25 } });
  var leg = tl.legs[0];
  var mid = T.replayStateAt(tl, leg.r0 + (leg.r1 - leg.r0) * 0.9);
  eq('何日目：香港→ニューヨークの飛行中は1日目（香港の時計が0時を越えても）', mid.dayNumber, 1);
  eq('何日目：ニューヨークに着いたら1日目、リオに着いたら2日目', [T.replayStateAt(tl, tl.stops[1].r + 0.01).dayNumber, T.replayStateAt(tl, tl.stops[2].r + 0.01).dayNumber], [1, 2]);
})();

/* ---- 種類「到着」（移動の「出発｜到着」タブ。2026-09-27）：着いた場所の予定として扱う ---- */
(function () {
  var TK = 'Asia/Tokyo', LA = 'America/Los_Angeles', ng = [];
  [['hnd', 'fl', 'arr', 'htl'], ['arr', 'htl', 'hnd', 'fl'], ['htl', 'arr', 'fl', 'hnd']].forEach(function (ord, oi) {
    [null, LA].forEach(function (flMap) {
      var bs = [
        { id: 'hnd', date: '2026-06-26', time: '18:00', category: 'sightseeing', label: '羽田空港' },
        { id: 'fl', date: '2026-06-26', time: '20:00', category: 'transport', transport: '', label: 'ロサンゼルスへ' },
        { id: 'arr', date: '2026-06-26', time: '18:50', category: 'arrival', transport: 'plane', label: 'ロサンゼルス国際空港' },
        { id: 'htl', date: '2026-06-26', time: '22:30', category: 'lodging', label: '菊の家' }];
      bs.forEach(function (b) { b.createdAt = String(ord.indexOf(b.id)); });
      var own = { hnd: TK, arr: LA, htl: LA };
      if (flMap) own.fl = flMap;
      var z = T.assignBlockZones(bs, own, {}, TK);
      var got = T.sortBlocks(T.applyBlockZones(bs.map(function (b) { return Object.assign({}, b); }), z)).map(function (b) { return b.id; }).join(',');
      if (got !== 'hnd,fl,arr,htl' || z.arr !== LA || z.fl !== TK) ng.push(oi + '/' + flMap + ' → ' + got);
    });
  });
  eq('到着の予定：入れた順・出発の地図によらず、羽田→出発（日本時間）→到着（LA時間）→宿', ng, []);
  eq('到着の予定は評価の対象にしない（移動と同じ）', T.reviewKindForCategory ? T.reviewKindForCategory('arrival') : '', '');
  eq('categoryLabel：到着', T.categoryLabel('arrival'), '到着');
})();

/* ---- 手で決めた並び（時差の区切りがある日。2026-09-27） ---- */
(function () {
  var bs = [
    { id: 'lax', date: '2026-06-26', time: '18:50', manualOrder: 2 },
    { id: 'eq', date: '2026-06-26', time: '20:00', manualOrder: 0 },
    { id: 'fl', date: '2026-06-26', time: '20:00', manualOrder: 1 },
    { id: 'new', date: '2026-06-26', time: '19:00' },        // あとから足した（手の並びなし）
    { id: 'd2', date: '2026-06-27', time: '09:00' },
    { id: 'd2b', date: '2026-06-27', time: '08:00' }];
  eq('sortBlocks：手の並びがある日はその並び、あとから足した予定はふだんの並びで前の予定の後ろ',
    T.sortBlocks(bs).map(function (b) { return b.id; }), ['eq', 'fl', 'lax', 'new', 'd2b', 'd2']);
  eq('dayHasManualOrder', [T.dayHasManualOrder(bs, '2026-06-26'), T.dayHasManualOrder(bs, '2026-06-27')], [true, false]);
  eq('sortBlocks：手の並びが無ければこれまでどおり', T.sortBlocks([{ id: 'b', date: 'x', time: '10:00' }, { id: 'a', date: 'x', time: '09:00' }]).map(function (b) { return b.id; }), ['a', 'b']);
})();

/* ---- 端末のタイムゾーンが旅の地図に出てこない（UTC・海外で入力）とき、最初の移動より前にいた場所を起点にする（2026-09-27） ---- */
(function () {
  var TK = 'Asia/Tokyo', LA = 'America/Los_Angeles';
  var bs = [
    { id: 'hnd', date: '2026-09-01', time: '18:00', category: 'sightseeing', createdAt: '1' },
    { id: 'fl', date: '2026-09-01', time: '20:00', category: 'transport', transport: 'plane', createdAt: '4', label: 'ロサンゼルスへのフライト' },
    { id: 'lax', date: '2026-09-01', time: '18:50', category: 'arrival', transport: 'plane', createdAt: '2' },
    { id: 'kiku', date: '2026-09-01', time: '22:30', category: 'lodging', createdAt: '3' }];
  ['UTC', LA, TK].forEach(function (dev) {
    var z = T.assignBlockZones(bs, { hnd: TK, fl: TK, lax: LA, kiku: LA }, {}, dev, {});
    eq('端末が' + dev + 'でも、羽田→フライト（日本）→LA到着→菊の家', T.sortBlocks(T.applyBlockZones(bs.map(function (b) { return Object.assign({}, b); }), z)).map(function (b) { return b.id; }), ['hnd', 'fl', 'lax', 'kiku']);
  });
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
