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
eq('formatCostItemAmount: rateが無い外貨は「¥0」ではなく「レート未設定」と出す', T.formatCostItemAmount({ amount: 12.5, currency: 'USD' }), 'US$12.50（レート未設定）');
eq('formatCostItemAmount: rateが0以下（不正値）も未設定と同じ扱い', T.formatCostItemAmount({ amount: 12.5, currency: 'USD', rate: 0 }), 'US$12.50（レート未設定）');
eq('costItemHasRate: 円はcurrencyが無くても対象外（判定はfalse）', T.costItemHasRate({ amount: 1200 }), false);
eq('costItemHasRate: 外貨でrateがあればtrue', T.costItemHasRate({ amount: 25, currency: 'USD', rate: 149.46 }), true);
eq('costItemHasRate: 外貨でrateが無ければfalse', T.costItemHasRate({ amount: 25, currency: 'USD' }), false);
eq('costItemHasRate: itemが無ければfalse', T.costItemHasRate(null), false);

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

/* ---- 宿泊先の名前：地図の場所の名前（entries[0].mapPlaceName）を、一般的な見出しより優先する（2026-09-29） ---- */
eq('primaryLodgingName: 見出しが一般的な文言（「ホテルに帰宅」）だけでも、地図の場所の名前があればそちらを使う',
  T.primaryLodgingName([{ category: 'lodging', label: 'ホテルに帰宅', entries: [{ mapPlaceName: 'ホテルニューオータニ' }] }]),
  'ホテルニューオータニ');
eq('primaryLodgingName: 「ホテルニューオータニ」のような実在の名前は一般的な文言として外さない',
  T.primaryLodgingName([{ category: 'lodging', label: 'ホテルニューオータニ' }]), 'ホテルニューオータニ');
eq('primaryLodgingName: 最初のBlockが一般的な文言で地図の名前も無ければ、あとのBlockの地図の名前を使う',
  T.primaryLodgingName([
    { category: 'lodging', label: 'ホテルへ', date: '2024-08-10' },
    { category: 'lodging', label: '宿に戻る', date: '2024-08-11', entries: [{ mapPlaceName: '民宿さくら' }] }
  ]), '民宿さくら');
eq('primaryLodgingName: すべて一般的な文言で地図の名前も無ければ、これまでどおり最初の見出しをそのまま出す',
  T.primaryLodgingName([
    { category: 'lodging', label: 'ホテルへ', date: '2024-08-10' },
    { category: 'lodging', label: '宿に戻る', date: '2024-08-11' }
  ]), 'ホテルへ');
eq('lodgingByNight: 地図の場所の名前を、一般的な文言の見出しより優先する',
  T.lodgingByNight({ startDate: '2024-08-10', endDate: '2024-08-12' }, [
    { category: 'lodging', label: 'ホテルへ', date: '2024-08-10', entries: [{ mapPlaceName: 'ゲストハウス山田' }] },
    { category: 'lodging', label: '宿に戻る', date: '2024-08-11' }
  ])[0].label, 'ゲストハウス山田');

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
// 以前は同じ日の後のBlockの見出しをそのまま採用していたが、それだと「宿に戻る」のような一般的な
// 文言（音声入力で行動ごとにBlockが分かれたもの）が、先に付いていた宿の名前を消してしまっていた。
// 一般的な文言では上書きしない（2026-09-29、Core.isGenericLodgingLabel）。
eq('lodgingByNight: 同じ日の後のBlockが「宿に戻る」のような一般的な見出しでも、先の宿の名前を消さない', nightsSame[0].label, '温泉宿の慶山に到着する');

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

/* ---- planHistoryRemoval（履歴から消す：索引と隠しリストの計算） ---- */
var ph = T.planHistoryRemoval([{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['x'], ['a', 'c', 'zzz']);
eq('planHistoryRemoval: 選んだ旅行が索引から消える', ph.trips.map(function (t) { return t.id; }), ['b']);
eq('planHistoryRemoval: 消した旅行が隠しリストに足される（索引に無いidは足さない）', ph.hidden, ['x', 'a', 'c']);
eq('planHistoryRemoval: removedIdsは実際に消した分だけ', ph.removedIds, ['a', 'c']);
eq('planHistoryRemoval: 隠しリストに重複しない', T.planHistoryRemoval([{ id: 'a' }], ['a'], ['a']).hidden, ['a']);
eq('planHistoryRemoval: 空の選択は何も変えない', T.planHistoryRemoval([{ id: 'a' }], [], []).trips.length, 1);

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

/* ---- 記録フォーム：「場所名で検索」で選んだ候補の名前を保存用に決める（placeSelectionName。2026-09-29） ---- */
eq('placeSelectionName: 候補があればその名前', T.placeSelectionName({ name: 'ホテルニューオータニ', lat: 35.1, lng: 139.1 }, 'ホテル'),
  'ホテルニューオータニ');
eq('placeSelectionName: 候補が無ければ検索文字列をそのまま名前にする（Googleマップで検索）',
  T.placeSelectionName(null, 'すし屋 銀座'), 'すし屋 銀座');
eq('placeSelectionName: 検索文字列が座標そのもの（lat,lng）なら名前として保存しない',
  T.placeSelectionName(null, '35.681236, 139.767125'), '');
eq('placeSelectionName: 候補も検索文字列も無ければ空文字', T.placeSelectionName(null, ''), '');
eq('placeSelectionName: 候補の名前が空文字・空白だけのときは検索文字列にフォールバックする',
  T.placeSelectionName({ name: '  ', lat: 35.1, lng: 139.1 }, 'すし屋 銀座'), 'すし屋 銀座');

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
eq('replayStops: 「動画に出さない」（videoExclude）の印を地点に引き継ぐ', T.replayStops(rpTrip, [{ id: 'x', date: '2026-04-01', time: '10:00', label: '秘密', videoExclude: true, entries: [] }, { id: 'y', date: '2026-04-01', time: '11:00', label: '普通', entries: [] }]).map(function (s) { return s.videoExclude; }), [true, false]);
eq('replayStops: 日付のない予定は含めない', rpStops.map(function (s) { return s.blockId; }), ['a', 'b', 'c', 'd']);
eq('replayStops: 何日目か', rpStops.map(function (s) { return s.dayNumber; }), [1, 1, 1, 2]);
eq('replayStops: 時刻なしの予定は直前の時刻の30分後と推定する', rpStops.map(function (s) { return s.minute; }), [600, 720, 750, 540]);
eq('replayStops: 推定時刻かどうか', rpStops.map(function (s) { return s.estimated; }), [false, false, true, false]);
eq('replayStops: 飛行機の到着でなければ、翌日に時刻ありの予定があっても日をまたいで見積もらず、ふつうに+30分のまま', rpStops[2].estimateSource, 'default');
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
var stArriveB = T.replayStateAt(tl, tl.stops[1].r + T.REPLAY_ARRIVAL_SETTLE_SEC + 0.01);
eq('replayStateAt: 区間で着いた予定は、カメラが落ち着くまで待ってから吹き出しが出る（2026-09-30）', stArriveB.captionIndex, 1);
eq('replayStateAt: 区間で着いて0.5秒ではまだ吹き出しを出さない（カメラが寄せ直している間）',
  T.replayStateAt(tl, tl.stops[1].r + 0.5 + 0.01).captionIndex, -1);
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
var tzZones = T.assignBlockZones(tzBlocks, { dep: 'Asia/Tokyo', arr: 'Pacific/Honolulu' }, 'Asia/Tokyo');
T.applyBlockZones(tzBlocks, tzZones);
eq('applyBlockZones: 予定ごとの時差', [tzBlocks[0]._offset, tzBlocks[1]._offset], [540, -600]);
eq('sortBlocks: 時差が分かれば世界共通の時刻の順（発→着）', T.sortBlocks(tzBlocks).map(function (b) { return b.id; }), ['dep', 'arr']);

// 改訂（2026-09-29、オーナー方針）：時差は地図の場所（自分の地図）だけで決める。移動の予定も例外ではなく、
// 自分の地図＝出発地としてそのまま使う（以前は「移動の予定は直前の予定の時差で読み、自分の地図は無視する」
// 仕組みだったが、地図を信じない動きだったため撤去した）。地図の無い予定は直前の予定を引き継ぐ
eq('assignBlockZones: 移動の予定も自分の地図（出発地）をそのまま使う。地図が無ければ直前の予定を引き継ぐ',
  T.assignBlockZones([
    { id: 'a', date: '2026-12-12', time: '15:00', category: 'sightseeing' },
    { id: 'b', date: '2026-12-12', time: '20:00', category: 'transport' },
    { id: 'c', date: '2026-12-13', time: '09:00', category: 'food' }
  ], { a: 'Asia/Tokyo', b: 'Europe/London' }, 'Asia/Tokyo'),
  { a: 'Asia/Tokyo', b: 'Europe/London', c: 'Europe/London' });

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

// 日ボタンで押した日にきちんと飛ぶか（不具合の再現・修正確認、2026-09-29）。どの日dでも
// replayDayStarts()[d]へシークしたら、その時点の状態のdayNumberは押した日と同じでなければならない。
// 以前はここが2つの理由でずれていた：
// 1) 日の境目を「到着の仮地点（arrival）」も含めて決めていたため、飛行機の到着見積もりで
//    実際より先の日付になった通過点（まだ前日の予定が続く途中）が、次の日の最初として選ばれていた
//    （実データ：trip_4e6c13ab396540b3b207108efb4c6f54の2日目がロサンゼルス到着の通過点になっていた）。
// 2) 日の最初の予定の少し手前（REPLAY_JUMP_LEAD_SEC）へシークする仕様のせいで、シーク直後は
//    まだその予定に「着いて」おらず、dayNumberが前日のまま計算されていた（これはarrivalが絡まない
//    普通の日の境目でも起きていた）。
(function () {
  function jd(query, dayIndex, dayNumber, minute, extra) {
    return Object.assign({
      blockId: query, date: '2026-06-2' + (dayIndex + 6), dayIndex: dayIndex, dayNumber: dayNumber,
      minute: minute, label: query, captions: [], photos: [], transport: '', query: query,
      offset: dayIndex === 0 ? 540 : -420, estimated: false, estimateSource: ''
    }, extra || {});
  }
  // 1日目の羽田→LAのフライトの「到着」通過点だけが2日目扱いになり、そのあとにまだ1日目の
  // 残りの予定（q3・q4）が続く、実データと同じ形の並び
  var jdStops = [
    jd('q0', 0, 1, 600), jd('q1', 0, 1, 660), jd('q2arrive', 1, 2, 30, { arrival: true }),
    jd('q3', 0, 1, 690), jd('q4', 0, 1, 750),
    jd('q5', 1, 2, 480), jd('q6', 1, 2, 600),
    jd('q7', 2, 3, 480)
  ];
  var jdCoords = {};
  jdStops.forEach(function (s, i) { jdCoords[s.query] = { lat: 30 + i, lng: 130 + i }; });
  var jdTl = T.buildReplayTimeline(jdStops, jdCoords);
  var jdDays = T.replayDayStarts(jdTl);
  eq('replayDayStarts: 到着の仮地点（arrival）は日の境目の基準にしない。2日目は本当の2日目の最初の予定', jdDays.map(function (d) { return d.dayNumber; }), [1, 2, 3]);
  jdDays.forEach(function (d) {
    eq('日ボタン：' + d.dayNumber + '日目へシークすると、その時点はちゃんと' + d.dayNumber + '日目', T.replayStateAt(jdTl, d.r).dayNumber, d.dayNumber);
  });
})();

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
eq('replayStops: 移動時間があるときの見積もりは変わらない（moveMinutes優先、上のstep1）', mvStops[2].estimateSource, 'move');

/* ---- 地図でふりかえる：時刻の無い到着の見積もり（羽田→ハワイ、2026-09-29） ---- */
// 移動時間の入力が無い飛行機の予定で、時刻の無い到着を「直前の30分後」にしてしまい、
// 7〜8時間かかる長距離便でも着いた扱いになっていた不具合の修正（docs/adr/0008）。
var haneda = { lat: 35.55, lng: 139.78 }, honolulu = { lat: 21.32, lng: -157.92 };
// 1. あとに時刻の分かっている予定があれば、その30分前と見積もる（次の日にまたいでもよい）
var hiBlocksWithNext = [
  { id: 'h1', date: '2026-06-01', time: '21:55', category: 'transport', transport: 'plane', label: '羽田発', entries: [{ mapUrl: 'https://maps.app.goo.gl/haneda' }] },
  { id: 'h2', date: '2026-06-01', time: '', category: 'sightseeing', label: 'ホノルル着', entries: [{ mapUrl: 'https://maps.app.goo.gl/honolulu' }] },
  { id: 'h3', date: '2026-06-02', time: '11:00', category: 'sightseeing', label: 'ワイキキ', entries: [{ mapUrl: 'https://maps.app.goo.gl/waikiki' }] }
];
var hiStopsWithNext = T.replayStops({ startDate: '2026-06-01', endDate: '2026-06-02' }, hiBlocksWithNext);
eq('replayStops: 時刻の無い到着は、あとの予定（11:00）の30分前と見積もる（日をまたいでもよい）',
  { date: hiStopsWithNext[1].date, minute: hiStopsWithNext[1].minute, src: hiStopsWithNext[1].estimateSource },
  { date: '2026-06-02', minute: 10 * 60 + 30, src: 'next' });
// 2. あとに時刻の分かっている予定が無ければ、座標が分かった時点（buildReplayTimeline）で
//    飛行機の所要時間（距離÷850km/h＋離着陸などの余裕60分）から見積もり直す
var hiBlocksNoNext = [
  { id: 'h1', date: '2026-06-01', time: '21:55', category: 'transport', transport: 'plane', label: '羽田発', entries: [{ mapUrl: 'https://maps.app.goo.gl/haneda' }], _offset: 9 * 60 },
  { id: 'h2', date: '2026-06-01', time: '', category: 'sightseeing', label: 'ホノルル着', entries: [{ mapUrl: 'https://maps.app.goo.gl/honolulu' }], _offset: -10 * 60 }
];
var hiStopsNoNext = T.replayStops({ startDate: '2026-06-01', endDate: '2026-06-01' }, hiBlocksNoNext);
eq('replayStops: あとの予定も移動時間も無ければ、座標が無いこの時点ではまだ直前+30分のまま（見積もりし直すのはbuildReplayTimeline）',
  { minute: hiStopsNoNext[1].minute, src: hiStopsNoNext[1].estimateSource }, { minute: 21 * 60 + 55 + 30, src: 'default' });
var hiTlNoNext = T.buildReplayTimeline(hiStopsNoNext, {
  'https://maps.app.goo.gl/haneda': haneda, 'https://maps.app.goo.gl/honolulu': honolulu
});
var hnlArrive = hiTlNoNext.stops[1];
ok('buildReplayTimeline: 座標が分かれば、飛行機の所要時間（7時間40分以上、羽田→ホノルルの距離÷850km/h＋60分）で見積もり直す',
  (hnlArrive.t - hiTlNoNext.stops[0].t) >= 7 * 60 + 40);
eq('buildReplayTimeline: 到着の現地時間（HST）に変換する。日付はそのまま（21:55羽田＋約8時間15分→現地11:10）',
  { date: hnlArrive.date, minute: hnlArrive.minute }, { date: '2026-06-01', minute: 11 * 60 + 10 });

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

/* ---- 時差：地図の無い予定は直前の予定を引き継ぐ（行ったり来たり防止。2026-09-29改訂で「その日の場所」は廃止） ---- */
// 10:00 成田（地図・東京）→12:00 LA到着（地図・LA）→15:00 ホテルで休憩（地図なし）→18:00 夕食（地図・LA）
var flipFlopBlocks = [
  { id: 'narita', date: '2026-08-01', time: '10:00', category: 'transport', label: '成田から出発', entries: [] },
  { id: 'laArr', date: '2026-08-01', time: '12:00', category: 'sightseeing', label: 'LA到着', entries: [] },
  { id: 'hotel', date: '2026-08-01', time: '15:00', category: 'lodging', label: 'ホテルで休憩', entries: [] },
  { id: 'dinner', date: '2026-08-01', time: '18:00', category: 'food', label: '夕食', entries: [] }
];
var flipFlopZones = T.assignBlockZones(flipFlopBlocks,
  { narita: 'Asia/Tokyo', laArr: 'America/Los_Angeles', dinner: 'America/Los_Angeles' },
  'Asia/Tokyo');
eq('assignBlockZones: 地図の無い予定は直前の予定のタイムゾーンを引き継ぐ',
  flipFlopZones, { narita: 'Asia/Tokyo', laArr: 'America/Los_Angeles', hotel: 'America/Los_Angeles', dinner: 'America/Los_Angeles' });
T.applyBlockZones(flipFlopBlocks, flipFlopZones);
var flipFlopSorted = T.sortBlocks(flipFlopBlocks);
var flipFlopChanges = 0;
for (var ffi = 1; ffi < flipFlopSorted.length; ffi++) {
  if (flipFlopSorted[ffi]._offset !== flipFlopSorted[ffi - 1]._offset) flipFlopChanges++;
}
eq('assignBlockZones: 「ここから現地時間」の切り替えは1回だけ（3回に増えない）', flipFlopChanges, 1);

// 翌日最初の予定に地図が無ければ、同じかたまりの時差のまま（「その日の場所」という概念自体を廃止した。2026-09-29）
var nextDayZones = T.assignBlockZones([
  { id: 'd1a', date: '2026-01-01', time: '20:00', category: 'food' },
  { id: 'd2a', date: '2026-01-02', time: '09:00', category: 'food' }
], { d1a: 'Asia/Tokyo' }, 'Asia/Tokyo');
eq('assignBlockZones: 移動の予定が無ければ、翌日の地図の無い予定も同じかたまりの時差',
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
var tzLocZones = T.assignBlockZones(tzLocBlocks, { dep: 'Asia/Tokyo', arr: 'Pacific/Honolulu' }, 'Asia/Tokyo');
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

// 2026-09-29改訂：日付変更線をまたぐ日の並びを、予定を入れた順・見出しの文言・「その日の場所」から
// 推測して直す仕組み（`laDepartureOrder`・`laNy`が使っていたcombo探索）は削除した。移動の予定の
// 自分の地図はそのまま出発地として使う（テストは上の「移動の予定も自分の地図をそのまま使う」に統合）。
// 順序があいまいなときは、地図（到着地の地図＝byArrive）か、手直しシート（tzOverride）で直す。

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
// 山の上の登山電車：線路の道のりが下の町（ツェルマット）まで行って終わっていたら使わない（スイス旅3日目）
var gorner = { lat: 45.9837, lng: 7.7853 }, riffelberg = { lat: 45.9935, lng: 7.7545 };
eq('railPathEndsOk: 端が到着地から3km以上離れた線路の道のりは使わない',
  T.railPathEndsOk([[45.9837, 7.7853], [45.99, 7.76], [46.0240, 7.7480]], gorner, riffelberg), false);
eq('railPathEndsOk: 端が駅の近く（数百m）なら使う',
  T.railPathEndsOk([[45.9840, 7.7850], [45.99, 7.765], [45.9930, 7.7530]], gorner, riffelberg), true);
eq('railPathEndsOk: 長い区間は、直線距離の2割までずれてよい（最大1.2km）',
  T.railPathEndsOk([[35.681, 139.767], [35.1709, 136.8815 + 0.011]], { lat: 35.681, lng: 139.767 }, { lat: 35.1709, lng: 136.8815 }), true);
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
var trip4Z = T.assignBlockZones(trip4, trip4Own, 'Asia/Tokyo');
eq('時差：出発前・成田出発は日本（旅の最初、地図の無い予定は最初に地図が出てくる予定の時差）', [trip4Z.home, trip4Z.nrt], ['Asia/Tokyo', 'Asia/Tokyo']);
eq('時差：各予定は自分の地図をそのまま使う（香港・ニューヨーク）', [trip4Z.hkA, trip4Z.hkH, trip4Z.hkD, trip4Z.nyA, trip4Z.nyH], ['Asia/Hong_Kong', 'Asia/Hong_Kong', 'Asia/Hong_Kong', 'America/New_York', 'America/New_York']);
// 改訂（2026-09-29、オーナー方針）：チャイナタウンの地図がたまたま韓国と判定されても、それが今この予定の
// 地図なのでそのまま使う（「1つだけ前後と違う地図は判定違いとみなして無視する」仕組みは、マップを信じない
// 動きだったため撤去した。間違っていれば、地図そのものを直すか、時差の区切りを手で直す）
eq('時差：チャイナタウンの地図が韓国と判定されたら、韓国の時差になる（前後に合わせて無視したりしない）', trip4Z.ct, 'Asia/Seoul');
eq('時差：ニューヨーク出発はニューヨーク、「リオに到着」からリオ', [trip4Z.nyD, trip4Z.rioA, trip4Z.rioH], ['America/New_York', 'America/Sao_Paulo', 'America/Sao_Paulo']);
var trip4Sorted = T.sortBlocks(T.applyBlockZones(trip4.map(function (b) { return Object.assign({}, b); }), trip4Z));
var trip4Changes = [];
for (var t4 = 1; t4 < trip4Sorted.length; t4++) if (trip4Sorted[t4]._offset !== trip4Sorted[t4 - 1]._offset) trip4Changes.push(trip4Sorted[t4].id);
// 同じ日（3/3）の中でも、ct（韓国、時差+9）は世界共通の時刻で比べるとts（ニューヨーク、時差-5）より
// 前に来るため、並びはts→ct→bwではなくct→ts→bwになる（sortBlocksが現地時間ではなく世界共通の時刻で
// 比べるため）。区切りは地図（時差）が変わるたびに出るので、ct（NY→韓国）とts（韓国→NYに戻る）の
// 2か所で出る
eq('時差：「ここから現地時間」は地図が変わるたびに出る（香港・ニューヨーク・チャイナタウン(韓国、時差の関係でtsより前に並ぶ)・NYに戻る・リオ）', trip4Changes, ['hkA', 'nyA', 'ct', 'ts', 'rioA']);

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
var trip5Z = T.assignBlockZones(trip5, trip5Own, 'Asia/Tokyo');
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
var saZ = T.assignBlockZones(sa, { rio: 'America/Sao_Paulo', igu: 'America/Argentina/Cordoba', bue: 'America/Argentina/Buenos_Aires', cal: 'America/Argentina/Rio_Gallegos' }, 'Asia/Tokyo');
eq('時差：イグアス・ブエノスアイレス・エル・カラファテはそれぞれの土地のタイムゾーンになる', [saZ.igu, saZ.bue, saZ.cal], ['America/Argentina/Cordoba', 'America/Argentina/Buenos_Aires', 'America/Argentina/Rio_Gallegos']);
var saSorted = T.sortBlocks(T.applyBlockZones(sa.map(function (b) { return Object.assign({}, b); }), saZ));
eq('時差：リオ→イグアス→ブエノスアイレス→エル・カラファテはどこもUTC-3なので「ここから現地時間」は出ない',
  saSorted.filter(function (b, i) { return i > 0 && b._offset !== saSorted[i - 1]._offset; }).length, 0);

/* ---- 時差：見出しの文言からは絶対に推測しない（docs/adr/0009改訂、2026-09-29。オーナー方針：
   「勝手に推測するのはやめてほしい（ラスベガスのニューヨークニューヨークというホテルをニューヨークと
   判断されたらややこしい）」） ---- */
(function () {
  var LV = 'America/Los_Angeles';
  // ラスベガスのホテル「ニューヨークニューヨーク」。地図はラスベガス（太平洋時間）
  var vegasBlocks = [
    { id: 'checkin', date: '2026-05-01', time: '15:00', category: 'lodging', label: 'ニューヨークニューヨークにチェックイン' },
    { id: 'dinner', date: '2026-05-01', time: '20:00', category: 'food', label: 'ホテル内のレストラン' }
  ];
  var vegasZ = T.assignBlockZones(vegasBlocks, { checkin: LV }, 'Asia/Tokyo');
  eq('assignBlockZones: 「ニューヨークニューヨーク」ホテル（地図はラスベガス）は、見出しに関わらずロサンゼルス時間のまま',
    [vegasZ.checkin, vegasZ.dinner], [LV, LV]);

  // 見出しに「到着」「〜へ」「フライト」などの言葉があっても、地図が無い予定のタイムゾーンは変わらない
  // （直前の予定を引き継ぐだけ。見出しの文言はassignBlockZonesが一切見ないことを確認する）
  var labelOnlyBlocks = [
    { id: 'a', date: '2026-05-02', time: '10:00', category: 'sightseeing', label: '観光' },
    { id: 'b', date: '2026-05-02', time: '12:00', category: 'transport', label: 'ニューヨークへのフライトで出発、到着' }
  ];
  var labelOnlyZ = T.assignBlockZones(labelOnlyBlocks, { a: LV }, 'Asia/Tokyo');
  eq('assignBlockZones: 地図の無い予定は、見出しに「到着」「〜へ」「フライト」があっても直前の時差のまま',
    labelOnlyZ.b, LV);
})();

/* ---- 時差の区切りを手で直す（block.tzOverride。docs/adr/0009改訂、2026-09-29） ---- */
(function () {
  var TK = 'Asia/Tokyo', LA = 'America/Los_Angeles', PA = 'Europe/Paris';
  var base = [
    { id: 'a', date: '2026-05-01', time: '10:00', category: 'sightseeing' },
    { id: 'b', date: '2026-05-01', time: '15:00', category: 'sightseeing' }
  ];
  // 自動では地図どおりロサンゼルス（前後で時差の区切りが出る）
  var autoZ = T.assignBlockZones([base[0], Object.assign({}, base[1])], { a: TK, b: LA }, TK);
  eq('assignBlockZones: 自動では地図どおり時差が変わる', autoZ.b, LA);

  // 'inherit'：この予定だけ直前と同じ時間にする（区切りが消える）
  var inheritBlocks = [base[0], Object.assign({}, base[1], { tzOverride: 'inherit' })];
  var inheritZ = T.assignBlockZones(inheritBlocks, { a: TK, b: LA }, TK);
  eq("assignBlockZones: tzOverride='inherit'なら地図があっても直前の予定と同じ時差になる（区切りが消える）", inheritZ.b, TK);
  var inheritApplied = T.applyBlockZones(inheritBlocks.map(function (b) { return Object.assign({}, b); }), inheritZ);
  eq('tzOverride=inherit：区切りの元になる_offsetが直前と同じになる（renderTimelineでは区切りが出ない）',
    inheritApplied[0]._offset, inheritApplied[1]._offset);

  // IANA名：地図に関わらずその場所の時間として読む
  var customBlocks = [base[0], Object.assign({}, base[1], { tzOverride: PA })];
  var customZ = T.assignBlockZones(customBlocks, { a: TK, b: LA }, TK);
  eq('assignBlockZones: tzOverrideにIANA名を入れると、地図に関わらずその時差になる', customZ.b, PA);

  // 手で直した予定のあと、地図の無い予定はその手直しを引き継ぐ（自動の連鎖と同じ扱い）
  var chainBlocks = [
    base[0],
    Object.assign({}, base[1], { tzOverride: PA }),
    { id: 'c', date: '2026-05-01', time: '18:00', category: 'food' }
  ];
  var chainZ = T.assignBlockZones(chainBlocks, { a: TK, b: LA }, TK);
  eq('assignBlockZones: 手で直した予定のあと、地図の無い予定はその手直しを引き継ぐ', chainZ.c, PA);
})();

// 2026-09-29改訂で削除：この36通りのテストは、日付変更線をまたぐ日の並びを「予定を入れた順」
// 「見出しの種類（到着タブ）」「その日の場所」を組み合わせて推測するcombo探索（削除した
// `orderZonesByCandidates`）を固定するものだった。地図だけで決める新しい方式では、移動の予定の
// 自分の地図がそのまま出発地になるので（`z.fl`は`own.fl`があればそれ、無ければ直前を引き継ぐだけ）、
// この「フライトの地図が到着地でも出発地として扱う」という推測は行わない。

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
  var z = T.assignBlockZones(bs, { hnd: TK }, TK, { fl: LA });
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

  // 移動の到着地点（fl#arrive）は、地図上の点・区間の到着先としては使うが、吹き出し（エピソード・写真）も
  // 到着の一時停止も出さず、乗り物がそのまま通り過ぎるだけにする（オーナーの指示、2026-09-29）
  var arriveCoords = { hnd: TK }; // 上のzと同じ組み立て（フライトは日本時間、到着はLA）
  var zArr = T.assignBlockZones(bs, arriveCoords, TK, { fl: LA });
  var bsArr = T.applyBlockZones(bs.map(function (b) { return Object.assign({}, b); }), zArr);
  var stArr = T.replayStops({ startDate: '2026-06-26', endDate: '2026-06-27' }, bsArr);
  var arrTl = T.buildReplayTimeline(stArr, {
    'https://www.google.com/maps/search/?api=1&query=33.94,-118.40': { lat: 33.94, lng: -118.40 }
  });
  var arriveIdx = stArr.map(function (s) { return s.blockId; }).indexOf('fl#arrive');
  ok('到着地点はarrival:trueで、地図上の点になる', arrTl.stops[arriveIdx].arrival === true && arrTl.stops[arriveIdx].located === true);
  eq('到着地点は吹き出しの一時停止をせず、着いた瞬間にそのまま通り過ぎる（rCaptionStart・rDwellEndが着いた瞬間rと同じ）',
    [arrTl.stops[arriveIdx].rCaptionStart, arrTl.stops[arriveIdx].rDwellEnd], [arrTl.stops[arriveIdx].r, arrTl.stops[arriveIdx].r]);
  ok('到着地点の吹き出し（captionIndex）は、再生のどの時点でも出ない',
    !arrTl.keyframes.some(function (k) { return T.replayStateAt(arrTl, k.r).captionIndex === arriveIdx; }));
})();

// 2026-09-29改訂で削除：上と同じ理由（`isGroundMove`・`isPlaneMove`・見出しの文言を使った
// 出発／到着の推測を撤去したため、「フライトの地図が行き先でも出発地として扱う」36通り・
// 12通りの固定テストは前提ごと成り立たない）。この日の並び自体は、下の「実データ」テストと
// 「ワールドカップ・大谷観戦旅」の回帰テストで、地図だけを渡す形で確認する。

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
  var z = T.assignBlockZones(bs, { lax: LA, eq: TK, fl: TK, kiku: LA }, TK, { fl: LA });
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
    var z = T.assignBlockZones(bs, own, TK);
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

// 2026-09-29改訂で削除：種類「到着」の予定を、出発の地図・入れた順によらず必ず到着地として読む
// 推測（36通り固定）は、`fl`（自分の地図が無い・LAの場合もある移動の予定）の扱いを、直前や見出しの
// 手がかりから決めていたcombo探索に依っていた。新しい方式では`fl`は自分の地図（あれば）か、直前の
// 予定を引き継ぐだけなので、この前提は成り立たない。「到着」というカテゴリ自体の扱い
// （評価の対象にしない・ラベル表示）は変えていないので、その2点だけ残す。
eq('到着の予定は評価の対象にしない（移動と同じ）', T.reviewKindForCategory ? T.reviewKindForCategory('arrival') : '', '');
eq('categoryLabel：到着', T.categoryLabel('arrival'), '到着');

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

/* ---- 実データ（ワールドカップ旅1日目、trip_4e6c13ab396540b3b207108efb4c6f54、2026-09-29）：
   手で並べ直した日（manualOrder）で、LAXの到着時刻を直したら「ロサンゼルスへのフライト」が
   現地時間（ロサンゼルス）側に移ってしまっていた。
   根本原因は2つ：
   ① walkDayが移動の予定のあとの「いまいる場所」を、自分の地図（＝出発地）のままにしていた。
      到着地の地図（byArrive）がある移動のあとは、以降の予定（地図の無いファンゾーンなど）は
      到着地を引き継ぐべきなのに出発地のままだったため、_offset（時差）が食い違い、
      segmentZonesの並べ替えが壊れていた。
   ② 車の移動（ユニオンステーション。出発地・到着地とも地図があり、たまたま同じ時差）が、
      「出発地の地図＝到着地の地図なら行き先の地図とみなし、いまいる場所（日本）で読む」という
      飛行機向けの判定にそのまま巻き込まれ、まだロサンゼルスに着く前として読まれていた。
   （fix、2026-09-29） ---- */
(function () {
  var TK = 'Asia/Tokyo', LA = 'America/Los_Angeles';
  function wcBlocks() {
    return [
      { id: 'eq', date: '2026-06-26', time: '18:30', category: 'other', label: '羽田空港の地震', manualOrder: 0 },
      { id: 'fl', date: '2026-06-26', time: '20:00', category: 'transport', transport: '', label: 'ロサンゼルスへのフライト', manualOrder: 1,
        entries: [{ travel: { arrive: '18:00', arriveMapUrl: 'https://maps/lax', arriveLat: 33.942153, arriveLng: -118.4036052 } }] },
      { id: 'lax', date: '2026-06-26', time: '18:50', category: 'arrival', transport: '', label: 'ロサンゼルス国際空港', manualOrder: 2 },
      { id: 'uni', date: '2026-06-26', time: '19:30', category: 'transport', transport: 'car', label: 'ユニオンステーション', manualOrder: 3,
        entries: [{ travel: { arriveMapUrl: 'https://maps/union', arriveLat: 34.0560307, arriveLng: -118.2347682 } }] },
      { id: 'fan', date: '2026-06-26', time: '21:00', category: 'sightseeing', label: 'ファンゾーン', manualOrder: 4 },
      { id: 'inn', date: '2026-06-26', time: '21:30', category: 'food', label: 'In-N-Out Burger', manualOrder: 5 },
      { id: 'kiku', date: '2026-06-26', time: '22:00', category: 'lodging', label: '菊の家', manualOrder: 6 }
    ];
  }
  var byBlock = { eq: TK, fl: TK, lax: LA, uni: LA, kiku: LA };
  var byArrive = { fl: LA, uni: LA };

  function checkZonesAndDivider(bs, label) {
    var z = T.assignBlockZones(bs, byBlock, TK, byArrive);
    var sorted = T.sortBlocks(T.applyBlockZones(bs.map(function (b) { return Object.assign({}, b); }), z));
    var ids = sorted.map(function (b) { return b.id; });
    var flIdx = ids.indexOf('fl'), laxIdx = ids.indexOf('lax');
    eq('実データ：並び（手で並べた順） ' + label, ids, ['eq', 'fl', 'lax', 'uni', 'fan', 'inn', 'kiku']);
    eq('実データ：フライトは日本時間 ' + label, sorted[flIdx]._tz, TK);
    eq('実データ：LAXは現地時間 ' + label, sorted[laxIdx]._tz, LA);
    // 「ここから現地時間」の区切りは、フライトとLAXの間（フライトのoffsetとLAXのoffsetが違う場所）に来る
    ok('実データ：区切りはフライトとLAXの間 ' + label, sorted[flIdx]._offset !== sorted[laxIdx]._offset && laxIdx === flIdx + 1);
  }

  // 元のLAX到着時刻（18:50）
  checkZonesAndDivider(wcBlocks(), 'LAX18:50');

  // LAXの到着時刻を直しても（オーナーが実際に行った操作）、フライトの時差は変わらない
  ['19:00', '19:29', '19:31', '20:00', '20:30'].forEach(function (laxTime) {
    var bs = wcBlocks();
    bs.filter(function (b) { return b.id === 'lax'; })[0].time = laxTime;
    checkZonesAndDivider(bs, 'LAX' + laxTime);
  });
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
    var z = T.assignBlockZones(bs, { hnd: TK, fl: TK, lax: LA, kiku: LA }, dev, {});
    eq('端末が' + dev + 'でも、羽田→フライト（日本）→LA到着→菊の家', T.sortBlocks(T.applyBlockZones(bs.map(function (b) { return Object.assign({}, b); }), z)).map(function (b) { return b.id; }), ['hnd', 'fl', 'lax', 'kiku']);
  });
})();

/* ---- 自分のAIで整理（JSON貼り付け）：parseImportedBlocksJson（docs/adr/0015） ---- */
(function () {
  var oneDayTrip = { startDate: '2026-04-01', endDate: '2026-04-01' };
  var multiDayTrip = { startDate: '2026-04-01', endDate: '2026-04-03' };

  // ```json ... ``` で囲まれていても読み取れる
  var fenced = T.parseImportedBlocksJson(
    '前置きの説明です。\n```json\n{"blocks":[{"time":"10:00","label":"東京駅","category":"transport","entry":{"episode":"新幹線で移動した"}}]}\n```\nよろしくお願いします。',
    oneDayTrip
  );
  eq('parseImportedBlocksJson: コードフェンス付きでも読める', [fenced.errors.length, fenced.blocks.length, fenced.blocks[0] && fenced.blocks[0].label], [0, 1, '東京駅']);

  // 一番外側の配列だけを渡された（{blocks:...}で包まれていない）
  var bare = T.parseImportedBlocksJson('[{"label":"清水寺","category":"sightseeing","time":"","entry":{"episode":"拝観した"}}]', oneDayTrip);
  eq('parseImportedBlocksJson: bareな配列も受け付ける', [bare.errors.length, bare.blocks.length, bare.blocks[0].label], [0, 1, '清水寺']);

  // 前後に説明文（プロース）が付いていても、外側のJSONだけ取り出す
  var withProse = T.parseImportedBlocksJson(
    'はい、JSONにまとめました：\n\n{"blocks":[{"label":"ホテル到着","category":"lodging","entry":{"episode":"チェックインした"}}]}\n\n何か他にありますか？',
    oneDayTrip
  );
  eq('parseImportedBlocksJson: 前後にプロースがあっても読める', [withProse.errors.length, withProse.blocks.length, withProse.blocks[0].label], [0, 1, 'ホテル到着']);

  // 不明なcategoryは'other'にフォールバックし、警告を出す
  var badCategory = T.parseImportedBlocksJson('{"blocks":[{"label":"謎の予定","category":"nazo","entry":{"episode":""}}]}', oneDayTrip);
  eq('parseImportedBlocksJson: 不明なcategoryはotherにフォールバック', badCategory.blocks[0].category, 'other');
  ok('parseImportedBlocksJson: categoryフォールバックの警告がある', badCategory.warnings.length === 1);

  // 複数日の旅行で、旅行期間外のdateはエラーとして省かれる（他の正しい項目は取り込まれる）
  var badDateMulti = T.parseImportedBlocksJson(
    '{"blocks":[' +
      '{"date":"2026-04-02","label":"良い予定","category":"sightseeing","entry":{"episode":""}},' +
      '{"date":"2026-05-01","label":"期間外の予定","category":"sightseeing","entry":{"episode":""}}' +
    ']}',
    multiDayTrip
  );
  eq('parseImportedBlocksJson: 複数日でdateが旅行期間内なら取り込む', [badDateMulti.blocks[0].label, badDateMulti.blocks[0].date], ['良い予定', '2026-04-02']);
  eq('parseImportedBlocksJson: dateが期間外でも書かれた日付のまま取り込み、期間外の数を返す（黙って直さない）', [badDateMulti.blocks.length, badDateMulti.blocks[1].date, badDateMulti.errors.length, badDateMulti.outOfRange], [2, '2026-05-01', 0, 1]);
  var badFormat = T.parseImportedBlocksJson('{"blocks":[{"date":"2026-02-30","label":"存在しない日","category":"other","entry":{"episode":""}},{"date":"5/16","label":"形式違い","category":"other","entry":{"episode":""}}]}', multiDayTrip);
  eq('parseImportedBlocksJson: 読めない日付は複数日ならエラー', [badFormat.blocks.length, badFormat.errors.length], [0, 2]);
  var oneDayOut = T.parseImportedBlocksJson('{"blocks":[{"date":"2026-05-16","label":"別の日","category":"other","entry":{"episode":""}}]}', oneDayTrip);
  eq('parseImportedBlocksJson: 1日の旅行でも、書かれた日付が日程の外ならそのまま残す', [oneDayOut.blocks[0].date, oneDayOut.outOfRange], ['2026-05-16', 1]);

  // 複数日で、dateが無い項目もエラー
  var missingDateMulti = T.parseImportedBlocksJson('{"blocks":[{"label":"日付なし","category":"sightseeing","entry":{"episode":""}}]}', multiDayTrip);
  eq('parseImportedBlocksJson: 複数日でdateが無ければエラー', [missingDateMulti.blocks.length, missingDateMulti.errors.length], [0, 1]);

  // 海外通貨のcostItemはcurrency付きでそのまま残る
  var foreignCost = T.parseImportedBlocksJson(
    '{"blocks":[{"label":"お土産","category":"other","entry":{"episode":"","costItems":[{"label":"置物","amount":12.5,"currency":"usd"},{"label":"入場料","amount":800}]}}]}',
    oneDayTrip
  );
  eq('parseImportedBlocksJson: 海外通貨のcostItemはcurrency（大文字化）付きで残る', foreignCost.blocks[0].entry.costItems,
    [{ label: '置物', amount: 12.5, currency: 'USD' }, { label: '入場料', amount: 800 }]);

  // 空文字・ゴミ文字列（JSONが見つからない）はエラー
  var empty = T.parseImportedBlocksJson('', oneDayTrip);
  ok('parseImportedBlocksJson: 空文字はエラー', empty.errors.length === 1 && empty.blocks.length === 0);
  var garbage = T.parseImportedBlocksJson('これは予定の話し合いのメモで、JSONではありません。', oneDayTrip);
  ok('parseImportedBlocksJson: JSONが無ければエラー', garbage.errors.length === 1 && garbage.blocks.length === 0);
})();

/* ---- 行ったことある旅先（canonicalVisitedCountryName / buildCountryIsoIndex / visitedPlaceTrips） ---- */
(function () {
  eq('canonicalVisitedCountryName: 正式名称を短くする', T.canonicalVisitedCountryName('アメリカ合衆国'), 'アメリカ');
  eq('canonicalVisitedCountryName: 別名も同じ国名にまとめる', T.canonicalVisitedCountryName('大韓民国'), '韓国');
  eq('canonicalVisitedCountryName: 英語表記もまとめる', T.canonicalVisitedCountryName('United States of America'), 'アメリカ');
  eq('canonicalVisitedCountryName: すでに正規化済みならそのまま', T.canonicalVisitedCountryName('ブラジル'), 'ブラジル');
  eq('canonicalVisitedCountryName: KEEP_AS_ISはそのまま（共和国止まりで別の国と衝突するため）', T.canonicalVisitedCountryName('ドミニカ共和国'), 'ドミニカ共和国');
  eq('canonicalVisitedCountryName: 表に無い「〜共和国」は接尾辞だけ落とす', T.canonicalVisitedCountryName('ケニア共和国'), 'ケニア');
  eq('canonicalVisitedCountryName: 空文字は空文字', T.canonicalVisitedCountryName(''), '');
  eq('canonicalVisitedCountryName: nullは空文字', T.canonicalVisitedCountryName(null), '');
  // 中国はIntl.DisplayNamesの実行環境によって返り値が揺れる（iOS Safari・古いICUなど）ため、
  // 「中華人民共和国」「中国本土」どちらが来ても「中国」にまとまることを確認する（2026-09-29〜）。
  eq('canonicalVisitedCountryName: 中国（正式名称）', T.canonicalVisitedCountryName('中華人民共和国'), '中国');
  eq('canonicalVisitedCountryName: 中国（エンジンによっては「中国本土」で返る）', T.canonicalVisitedCountryName('中国本土'), '中国');

  var alpha2Table = { '392': 'JP', '840': 'US', '076': 'BR', '032': 'AR', '410': 'KR', '156': 'CN' };
  var idx = T.buildCountryIsoIndex(['392', '840', '076', '032', '410', '156', '999'], alpha2Table);
  eq('buildCountryIsoIndex: 日本', idx.idToName['392'], '日本');
  eq('buildCountryIsoIndex: アメリカ（Intl.DisplayNamesの生名から正規化）', idx.idToName['840'], 'アメリカ');
  eq('buildCountryIsoIndex: ブラジル', idx.idToName['076'], 'ブラジル');
  eq('buildCountryIsoIndex: アルゼンチン', idx.idToName['032'], 'アルゼンチン');
  eq('buildCountryIsoIndex: 韓国', idx.idToName['410'], '韓国');
  // 中国はDisplayNamesの生の返り値に関わらずalpha2（CN）から決め打ちで「中国」になり、地図が塗られ
  // 国旗も引ける（VISITED_ALPHA2_NAME_FALLBACK。中国が地図で塗られず国旗も出ない不具合の再発防止）。
  eq('buildCountryIsoIndex: 中国（DisplayNamesの揺れに関わらずCNから決め打ち）', idx.idToName['156'], '中国');
  eq('buildCountryIsoIndex: nameToIdから中国のidも逆引きできる（地図が塗れる）', idx.nameToId['中国'], '156');
  eq('flagEmojiForAlpha2: 中国の国旗が引ける', T.flagEmojiForAlpha2(alpha2Table[idx.nameToId['中国']]), '🇨🇳');
  eq('buildCountryIsoIndex: nameToIdは逆引きできる', idx.nameToId['アメリカ'], '840');
  eq('buildCountryIsoIndex: alpha2が無いidは対応表に入らない', idx.idToName['999'] === undefined, true);
  eq('buildCountryIsoIndex: alpha2Tableが無いidも無視される（存在しないid）', T.buildCountryIsoIndex(['000'], alpha2Table).idToName['000'] === undefined, true);
  eq('buildCountryIsoIndex: idsが空でも空の対応表を返す', T.buildCountryIsoIndex([], alpha2Table), { idToName: {}, nameToId: {} });

  eq('visitedPlaceTrips: 数えている旅行だけ拾う（tripId・年つき）', T.visitedPlaceTrips({
    sources: [
      { tripId: 't1', tripTitle: '沖縄旅行', dates: ['2026-05-01'], transit: false, excluded: false },
      { tripId: 't2', tripTitle: '乗り継ぎだけの旅', dates: ['2026-06-01'], transit: true, excluded: false },
      { tripId: 't3', tripTitle: '外した旅行', dates: ['2026-07-01'], transit: false, excluded: true }
    ]
  }), [{ tripId: 't1', tripTitle: '沖縄旅行', years: ['2026'] }]);
  eq('visitedPlaceTrips: 同じ旅行（tripId）が複数回出ても重複しない', T.visitedPlaceTrips({
    sources: [
      { tripId: 't1', tripTitle: '家族旅行', dates: ['2026-01-01'], transit: false, excluded: false },
      { tripId: 't1', tripTitle: '家族旅行', dates: ['2026-01-02'], transit: false, excluded: false }
    ]
  }), [{ tripId: 't1', tripTitle: '家族旅行', years: ['2026'] }]);
  eq('visitedPlaceTrips: 無題の旅はタイトルを補う', T.visitedPlaceTrips({
    sources: [{ tripId: 't1', tripTitle: '', dates: [], transit: false, excluded: false }]
  }), [{ tripId: 't1', tripTitle: '（無題の旅）', years: [] }]);
  eq('visitedPlaceTrips: sourcesが無ければ空配列', T.visitedPlaceTrips({}), []);
  eq('visitedPlaceTrips: 複数の年にまたがる旅行は年を全部拾う', T.visitedPlaceTrips({
    sources: [{ tripId: 't1', tripTitle: '年またぎ旅行', dates: ['2026-12-31', '2027-01-01'], transit: false, excluded: false }]
  }), [{ tripId: 't1', tripTitle: '年またぎ旅行', years: ['2026', '2027'] }]);

  eq('visitedYearsFromDates: 日付から年だけ重複なく拾う', T.visitedYearsFromDates(['2026-01-01', '2026-05-05', '2027-01-01']), ['2026', '2027']);
  eq('visitedYearsFromDates: 日付が無ければ空配列', T.visitedYearsFromDates([]), []);
  eq('visitedYearsFromDates: undefinedでも空配列', T.visitedYearsFromDates(undefined), []);

  eq('visitedTripLabel: 年があれば（）で付ける', T.visitedTripLabel({ tripTitle: '大阪旅行', years: ['2026'] }), '大阪旅行（2026）');
  eq('visitedTripLabel: 複数年は・でつなぐ', T.visitedTripLabel({ tripTitle: '年またぎ旅行', years: ['2026', '2027'] }), '年またぎ旅行（2026・2027）');
  eq('visitedTripLabel: 年が無ければ省く', T.visitedTripLabel({ tripTitle: '旧データの旅行', years: [] }), '旧データの旅行');
})();

/* ---- 行ったことある旅先（地方・大陸のグループ分け／国旗絵文字／達成率、2026-09-28〜） ---- */
(function () {
  // regionForPrefecture
  eq('regionForPrefecture: 北海道', T.regionForPrefecture('北海道'), '北海道');
  eq('regionForPrefecture: 東北（宮城県）', T.regionForPrefecture('宮城県'), '東北');
  eq('regionForPrefecture: 関東（東京都）', T.regionForPrefecture('東京都'), '関東');
  eq('regionForPrefecture: 中部（愛知県）', T.regionForPrefecture('愛知県'), '中部');
  eq('regionForPrefecture: 近畿（京都府）', T.regionForPrefecture('京都府'), '近畿');
  eq('regionForPrefecture: 中国（広島県）', T.regionForPrefecture('広島県'), '中国');
  eq('regionForPrefecture: 四国（香川県）', T.regionForPrefecture('香川県'), '四国');
  eq('regionForPrefecture: 九州・沖縄（沖縄県）', T.regionForPrefecture('沖縄県'), '九州・沖縄');
  eq('regionForPrefecture: 九州・沖縄（鹿児島県）', T.regionForPrefecture('鹿児島県'), '九州・沖縄');
  eq('regionForPrefecture: 知らない名前はnull', T.regionForPrefecture('架空県'), null);
  eq('regionForPrefecture: 空文字はnull', T.regionForPrefecture(''), null);
  eq('VISITED_REGION_ORDER: 8地方が北海道から順に並ぶ', T.VISITED_REGION_ORDER,
    ['北海道', '東北', '関東', '中部', '近畿', '中国', '四国', '九州・沖縄']);

  // continentForAlpha2
  eq('continentForAlpha2: 日本はアジア', T.continentForAlpha2('JP'), 'アジア');
  eq('continentForAlpha2: アメリカは北米', T.continentForAlpha2('US'), '北米');
  eq('continentForAlpha2: ブラジルは南米', T.continentForAlpha2('BR'), '南米');
  eq('continentForAlpha2: フランスはヨーロッパ', T.continentForAlpha2('FR'), 'ヨーロッパ');
  eq('continentForAlpha2: エジプトはアフリカ', T.continentForAlpha2('EG'), 'アフリカ');
  eq('continentForAlpha2: オーストラリアはオセアニア', T.continentForAlpha2('AU'), 'オセアニア');
  eq('continentForAlpha2: 小文字でも判定できる', T.continentForAlpha2('jp'), 'アジア');
  eq('continentForAlpha2: 知らないコードはnull', T.continentForAlpha2('ZZ'), null);
  eq('continentForAlpha2: 空文字はnull', T.continentForAlpha2(''), null);
  eq('continentForAlpha2: undefinedはnull', T.continentForAlpha2(undefined), null);

  // flagEmojiForAlpha2
  eq('flagEmojiForAlpha2: 日本は🇯🇵', T.flagEmojiForAlpha2('JP'), '🇯🇵');
  eq('flagEmojiForAlpha2: アメリカは🇺🇸', T.flagEmojiForAlpha2('US'), '🇺🇸');
  eq('flagEmojiForAlpha2: 小文字でも組み立てられる', T.flagEmojiForAlpha2('jp'), '🇯🇵');
  eq('flagEmojiForAlpha2: 不正な長さは空文字', T.flagEmojiForAlpha2('JPN'), '');
  eq('flagEmojiForAlpha2: 数字は空文字', T.flagEmojiForAlpha2('J1'), '');
  eq('flagEmojiForAlpha2: 空文字は空文字', T.flagEmojiForAlpha2(''), '');
  eq('flagEmojiForAlpha2: undefinedは空文字', T.flagEmojiForAlpha2(undefined), '');

  // EXTRA_COUNTRY_ALPHA2_BY_NAME（2026-09-28〜）：香港・マカオはworld-atlasに図形が無く地図からは
  // alpha2が引けないので、一覧で「その他」に落ちない・国旗が出るよう決め打ちで足してある
  eq('EXTRA_COUNTRY_ALPHA2_BY_NAME: 香港はHK', T.EXTRA_COUNTRY_ALPHA2_BY_NAME['香港'], 'HK');
  eq('EXTRA_COUNTRY_ALPHA2_BY_NAME: マカオはMO', T.EXTRA_COUNTRY_ALPHA2_BY_NAME['マカオ'], 'MO');
  eq('continentForAlpha2: 香港(HK)はアジア', T.continentForAlpha2(T.EXTRA_COUNTRY_ALPHA2_BY_NAME['香港']), 'アジア');
  eq('continentForAlpha2: マカオ(MO)はアジア', T.continentForAlpha2(T.EXTRA_COUNTRY_ALPHA2_BY_NAME['マカオ']), 'アジア');
  eq('flagEmojiForAlpha2: 香港は🇭🇰', T.flagEmojiForAlpha2(T.EXTRA_COUNTRY_ALPHA2_BY_NAME['香港']), '🇭🇰');
  eq('flagEmojiForAlpha2: マカオは🇲🇴', T.flagEmojiForAlpha2(T.EXTRA_COUNTRY_ALPHA2_BY_NAME['マカオ']), '🇲🇴');

  // visitedPercentage
  eq('visitedPercentage: 2/47は四捨五入で4%', T.visitedPercentage(2, 47), 4);
  eq('visitedPercentage: 0/47は0%', T.visitedPercentage(0, 47), 0);
  eq('visitedPercentage: 47/47は100%', T.visitedPercentage(47, 47), 100);
  eq('visitedPercentage: 3/193は2%（四捨五入）', T.visitedPercentage(3, 193), 2);
  eq('visitedPercentage: totalが0なら0%', T.visitedPercentage(5, 0), 0);
  eq('visitedPercentage: totalが負なら0%', T.visitedPercentage(5, -1), 0);

  // groupVisitedByOrder
  var byLetter = T.groupVisitedByOrder(
    [{ name: 'b' }, { name: 'a' }, { name: 'c' }, { name: 'x' }],
    function (x) { return x.name === 'x' ? null : (x.name <= 'a' ? 'A' : 'B'); },
    ['A', 'B']
  );
  eq('groupVisitedByOrder: orderの順にグループ化する', byLetter.map(function (g) { return g.group; }), ['A', 'B', 'その他']);
  eq('groupVisitedByOrder: 各グループの中身は元の順番を保つ', byLetter[1].items.map(function (x) { return x.name; }), ['b', 'c']);
  eq('groupVisitedByOrder: orderに無いキーは「その他」にまとまる', byLetter[2].items.map(function (x) { return x.name; }), ['x']);
  eq('groupVisitedByOrder: 空配列は空配列', T.groupVisitedByOrder([], function () { return 'A'; }, ['A']), []);
  eq('groupVisitedByOrder: 中身が無いグループは出てこない', T.groupVisitedByOrder(
    [{ name: 'a' }], function () { return 'A'; }, ['A', 'B']
  ).map(function (g) { return g.group; }), ['A']);
})();

/* ---- 「ワールドカップ、大谷観戦旅」で見つかった不具合の回帰テスト（2026-09-29） ---- */
(function () {
  // 1. 日付変更線をまたぐ移動日の並び：羽田18:30→LAX18:50着（移動の予定・地図あり）→
  //    羽田20:00発のフライト（地図は出発地）→ユニオンステーション20:20着。
  //    LAXの予定は自分の地図（ロサンゼルス）を持っているのに、直前の予定（羽田・日本時間）の
  //    時差をそのまま引き継いでしまうと、18:50JST（世界共通時刻ではフライトの20:00JSTより前）に
  //    なり、「LAXに着く前にフライトが出発する」という順になってしまっていた。
  var wcBlocks = [
    { id: 'haneda', date: '2026-06-26', time: '18:30', category: 'other', label: '羽田空港の地震', createdAt: '1' },
    { id: 'lax', date: '2026-06-26', time: '18:50', category: 'transport', transport: '', label: 'ロサンゼルス国際空港', createdAt: '2' },
    { id: 'flight', date: '2026-06-26', time: '20:00', category: 'transport', transport: '', label: 'ロサンゼルスへのフライト', createdAt: '3' },
    { id: 'union', date: '2026-06-26', time: '20:20', category: 'transport', transport: '', label: 'ユニオンステーション', createdAt: '4' }
  ];
  var wcByBlock = { haneda: 'Asia/Tokyo', lax: 'America/Los_Angeles', flight: 'Asia/Tokyo', union: 'America/Los_Angeles' };
  var wcZones = T.assignBlockZones(wcBlocks.map(function (b) { return Object.assign({}, b); }), wcByBlock, 'Asia/Tokyo', {});
  var wcCopies = wcBlocks.map(function (b) { return Object.assign({}, b); });
  T.applyBlockZones(wcCopies, wcZones);
  eq('assignBlockZones: LAX到着はJSTではなく自分の地図（ロサンゼルス）の時差になる', wcCopies[1]._offset, -420);
  eq('sortBlocks: 羽田→フライト→LAX到着→ユニオンの順（LAXがフライトより前に来ない）',
    T.sortBlocks(wcCopies).map(function (b) { return b.id; }), ['haneda', 'flight', 'lax', 'union']);

  // 2. 前後の記録から800km以上離れたピン（違う場所のピンが残っている）は、地図に出さず
  //    吹き出し（キャプション）だけにする。ヒューストン滞在中の1件だけ、ロサンゼルスの自宅の
  //    ピンが残っていた実例。
  var houston1 = { lat: 29.7369, lng: -95.4681 }; // マリオット（ヒューストン、正しいピン）
  var wrongLA = { lat: 33.9794, lng: -118.4092 }; // ロサンゼルスの自宅（間違って残っていたピン）
  var houston2 = { lat: 29.9487, lng: -95.3300 }; // 熱中症のあった場所（ヒューストン）
  ok('isFarMapOutlier: 前後どうしは近い（300km未満）のに真ん中だけ800km以上離れていれば外れ値',
    T.isFarMapOutlier(houston1, wrongLA, houston2));
  ok('isFarMapOutlier: 前後もいっしょに遠く離れる本物の長距離移動は外れ値にしない',
    !T.isFarMapOutlier(houston1, { lat: 36.1166, lng: -115.1704 }, { lat: 36.0831, lng: -115.1482 }));
  var outlierStops = T.replayStops({ startDate: '2026-06-28', endDate: '2026-06-29' }, [
    { id: 'o1', date: '2026-06-28', time: '13:00', category: 'lodging', label: 'マリオット', entries: [{ mapUrl: 'https://maps.app.goo.gl/houston1' }] },
    { id: 'o2', date: '2026-06-28', time: '14:00', category: 'food', label: 'Truth BBQ', entries: [{ mapUrl: 'https://maps.app.goo.gl/houston2' }] },
    { id: 'o3', date: '2026-06-28', time: '22:30', category: 'lodging', label: 'マリオット', entries: [{ mapUrl: 'https://maps.app.goo.gl/wrongpin' }] },
    { id: 'o4', date: '2026-06-29', time: '09:00', category: 'food', label: 'First Watch', entries: [{ mapUrl: 'https://maps.app.goo.gl/houston3' }] }
  ]);
  var outlierTl = T.buildReplayTimeline(outlierStops, {
    'https://maps.app.goo.gl/houston1': { lat: 29.7369, lng: -95.4681 },
    'https://maps.app.goo.gl/houston2': { lat: 29.7691, lng: -95.3976 },
    'https://maps.app.goo.gl/wrongpin': { lat: 33.9794, lng: -118.4092 },
    'https://maps.app.goo.gl/houston3': { lat: 29.7749, lng: -95.3883 }
  });
  eq('buildReplayTimeline: 前後から遠い間違ったピンは地図の地点にしない（located=false）',
    outlierTl.stops.map(function (s) { return s.located; }), [true, true, false, true]);
  ok('buildReplayTimeline: 外れ値と分かった地点にはoutlierの印が付く', outlierTl.stops[2].outlier === true);
  eq('buildReplayTimeline: 外れ値でもキャプション（label）はそのまま残す', outlierTl.stops[2].label, 'マリオット');

  // findFarMapOutlierBlockIds：旅行詳細画面の注意書き用（Blockのentries[0]のmapLat/mapLngで判定）
  var outlierBlocks = [
    { id: 'p1', date: '2026-06-28', time: '13:00', category: 'lodging', label: 'マリオット', entries: [{ mapLat: 29.7369, mapLng: -95.4681 }] },
    { id: 'p2', date: '2026-06-28', time: '14:00', category: 'food', label: 'Truth BBQ', entries: [{ mapLat: 29.7691, mapLng: -95.3976 }] },
    { id: 'p3', date: '2026-06-28', time: '22:30', category: 'lodging', label: 'マリオット', entries: [{ mapLat: 33.9794, mapLng: -118.4092 }] },
    { id: 'p4', date: '2026-06-29', time: '09:00', category: 'food', label: 'First Watch', entries: [{ mapLat: 29.7749, mapLng: -95.3883 }] }
  ];
  eq('findFarMapOutlierBlockIds: 真ん中の間違ったピンのBlockだけが対象になる', T.findFarMapOutlierBlockIds(outlierBlocks), { p3: true });

  // assignBlockZones: 前後から遠く離れた地図（ピン違い）は時差の手がかりにしない＝地図が無いのと同じに
  // 扱い、前の予定の時差を引き継ぐ（「ここから現地時間」の区切りを出さない）。実例：ヒューストン滞在中の
  // 22:30 マリオットにロサンゼルスの自宅のピンが間違って残っていた（docs/adr/0009、2026-09-29）
  var CHI = 'America/Chicago', OWN_LA = 'America/Los_Angeles';
  var houstonDayBlocks = [
    { id: 'arrive', date: '2026-06-28', time: '11:12', category: 'transport', label: 'ヒューストン到着', entries: [{ mapLat: 29.646, mapLng: -95.277 }] },
    { id: 'hotel1', date: '2026-06-28', time: '13:00', category: 'lodging', label: 'マリオット', entries: [{ mapLat: 29.737, mapLng: -95.468 }] },
    { id: 'bbq', date: '2026-06-28', time: '14:00', category: 'food', label: 'Truth BBQ', entries: [{ mapLat: 29.769, mapLng: -95.398 }] },
    { id: 'evening1', date: '2026-06-28', time: '19:00', category: 'other', label: '夕方の予定1', entries: [{}] },
    { id: 'evening2', date: '2026-06-28', time: '20:00', category: 'other', label: '夕方の予定2', entries: [{}] },
    { id: 'hotel2', date: '2026-06-28', time: '22:30', category: 'lodging', label: 'マリオット', entries: [{ mapLat: 33.979, mapLng: -118.409 }] },
    { id: 'breakfast', date: '2026-06-29', time: '09:00', category: 'food', label: 'First Watch', entries: [{ mapLat: 29.7749, mapLng: -95.3883 }] }
  ];
  var houstonDayByBlock = { arrive: CHI, hotel1: CHI, bbq: CHI, hotel2: OWN_LA, breakfast: CHI };
  var houstonDayZones = T.assignBlockZones(houstonDayBlocks, houstonDayByBlock, 'Asia/Tokyo');
  eq('assignBlockZones: 前後から遠く離れた地図（間違ったピン）は、その地図の時差を採らず前の予定の時差を引き継ぐ',
    houstonDayZones.hotel2, CHI);
  eq('assignBlockZones: 22:30の予定まで含め、全体がヒューストンの時差のまま変わらない',
    houstonDayBlocks.map(function (b) { return houstonDayZones[b.id]; }),
    [CHI, CHI, CHI, CHI, CHI, CHI, CHI]);
})();

/* ---- 時刻の無い宿泊（lodging）は、その日の最後（寝る前）に置く（2026-09-29） ---- */
(function () {
  // 時刻ありのBlockは常に時刻順が先頭グループなので、時刻なしのlodgingは自然にそのあとに来る
  // （sortBlocksの既存の並べ方、docs/adr/0003）。ラスベガス→朝までポーカー(06:00)→WSOP(10:00)→
  // ロサンゼルスへの移動(16:00)→シェラトン（時刻なし・宿泊）の実例で確認する。
  var nightBlocks = [
    { id: 'poker', date: '2026-06-30', time: '06:00', category: 'other', label: '朝までポーカー', createdAt: '1' },
    { id: 'wsop', date: '2026-06-30', time: '10:00', category: 'other', label: 'WSOPトーナメント', createdAt: '2' },
    { id: 'move', date: '2026-06-30', time: '16:00', category: 'transport', label: 'ロサンゼルスへの移動', createdAt: '3' },
    { id: 'sheraton', date: '2026-06-30', time: '', category: 'lodging', label: 'シェラトン', createdAt: '4' }
  ];
  eq('sortBlocks: 時刻なしの宿泊は、その日の時刻ありの予定がすべて終わったあと（末尾）に来る',
    T.sortBlocks(nightBlocks).map(function (b) { return b.id; }), ['poker', 'wsop', 'move', 'sheraton']);
  // 時刻なしのlodgingが「作成順が先」でも、時刻ありグループより前には割り込まないことも確認する
  var nightBlocksCreatedFirst = nightBlocks.map(function (b) {
    return b.id === 'sheraton' ? Object.assign({}, b, { createdAt: '0' }) : b;
  });
  eq('sortBlocks: 時刻なしの宿泊を先に登録していても、時刻ありの予定より前には来ない',
    T.sortBlocks(nightBlocksCreatedFirst).map(function (b) { return b.id; }), ['poker', 'wsop', 'move', 'sheraton']);
})();

/* ---- 地図でふりかえる：同じ場所が続く予定・ごく近い予定は移動（leg）にせず、地図が揺れないようにする
   （2026-09-29、docs/adr/0008。乗り継ぎ空港や、同じピンを指す予定が続くときに座標がわずかにずれて登録
   されていても、実際には動いていないので移動を作らない） ---- */
(function () {
  var stayStops = T.replayStops({ startDate: '2026-06-26', endDate: '2026-06-26' }, [
    { id: 'a', date: '2026-06-26', time: '18:30', category: 'other', label: '地震', createdAt: '1',
      entries: [{ mapUrl: 'https://www.google.com/maps/search/?api=1&query=35.5482964%2C139.7779951', mapLat: 35.5482964, mapLng: 139.7779951 }] },
    // 200m弱しか離れていない（完全に同じ座標ではない）「ほぼ同じ場所」の予定。これまでは座標が
    // 1ビットでも違えば移動（leg）になっていた
    { id: 'b', date: '2026-06-26', time: '18:50', category: 'transport', label: 'すぐ近くの記録', createdAt: '2',
      entries: [{ mapUrl: 'https://www.google.com/maps/search/?api=1&query=35.5498%2C139.7779951', mapLat: 35.5498, mapLng: 139.7779951 }] },
    // 完全に同じ座標（従来から移動にならない）
    { id: 'c', date: '2026-06-26', time: '19:00', category: 'other', label: '完全に同じ座標', createdAt: '3',
      entries: [{ mapUrl: 'https://www.google.com/maps/search/?api=1&query=35.5498%2C139.7779951', mapLat: 35.5498, mapLng: 139.7779951 }] },
    // 遠く離れた本当の移動（比較のため）
    { id: 'd', date: '2026-06-26', time: '20:00', category: 'transport', transport: 'car', label: '遠くの目的地', createdAt: '4',
      entries: [{ mapUrl: 'https://www.google.com/maps/search/?api=1&query=35.6%2C139.9', mapLat: 35.6, mapLng: 139.9 }] }
  ]);
  var stayCoords = {};
  stayStops.forEach(function (s) { if (s.query) stayCoords[s.query] = { lat: s.knownLat, lng: s.knownLng }; });
  var stayTl = T.buildReplayTimeline(stayStops, stayCoords);
  eq('buildReplayTimeline: 全部の予定が地図上の地点になる', stayTl.stops.map(function (s) { return s.located; }), [true, true, true, true]);
  eq('buildReplayTimeline: 300m未満しか離れていない・完全に同じ座標の予定どうしは移動（leg）にしない。遠い移動だけが残る',
    stayTl.legs.map(function (l) { return [l.from, l.to]; }), [[2, 3]]);
})();

/* ---- 地図でふりかえる：カメラを動かす必要があるかどうかの判定（Core.cameraMoveNeeded、純粋関数）
   （2026-09-29、docs/adr/0008） ---- */
(function () {
  ok('cameraMoveNeeded: 中心も縮尺もまったく同じなら動かさない',
    !T.cameraMoveNeeded({ lat: 35.5, lng: 139.7, zoom: 12 }, { lat: 35.5, lng: 139.7, zoom: 12 }));
  ok('cameraMoveNeeded: ごくわずかな誤差（許容範囲内）は「同じ」とみなす',
    !T.cameraMoveNeeded({ lat: 35.5, lng: 139.7, zoom: 12 }, { lat: 35.5001, lng: 139.7001, zoom: 12.1 }));
  ok('cameraMoveNeeded: 中心が離れていれば動かす',
    T.cameraMoveNeeded({ lat: 35.5, lng: 139.7, zoom: 12 }, { lat: 36.5, lng: 139.7, zoom: 12 }));
  ok('cameraMoveNeeded: 中心は同じでも縮尺が大きく違えば動かす',
    T.cameraMoveNeeded({ lat: 35.5, lng: 139.7, zoom: 5 }, { lat: 35.5, lng: 139.7, zoom: 15 }));
  ok('cameraMoveNeeded: 今の場所が分からなければ（初回など）動かす', T.cameraMoveNeeded(null, { lat: 35.5, lng: 139.7, zoom: 12 }));
})();

/* ---- 地図でふりかえる：吹き出し・写真は「乗り物が着いて、カメラが落ち着いてから」出す（2026-09-30） ---- */
(function () {
  // 場所の分かる予定・場所の分からない出来事・近すぎて区間を作らない予定・到着の仮地点が混ざった1日
  var mk = function (id, time, label, url, extra) {
    return Object.assign({ id: id, date: '2026-05-01', time: time, label: label, entries: url ? [{ mapUrl: url }] : [], transport: '' }, extra || {});
  };
  var coords = {
    'https://maps.app.goo.gl/a': { lat: 35.00, lng: 135.00 },
    'https://maps.app.goo.gl/b': { lat: 35.20, lng: 135.30 },
    'https://maps.app.goo.gl/b2': { lat: 35.2005, lng: 135.3005 },   // bの約70m先＝区間を作らない
    'https://maps.app.goo.gl/c': { lat: 34.70, lng: 135.50 }
  };
  var blocks = [
    mk('a', '09:00', 'A出発', 'https://maps.app.goo.gl/a'),
    mk('e1', '09:30', '出来事1（場所なし）', ''),
    mk('b', '10:30', 'B到着', 'https://maps.app.goo.gl/b', { transport: 'car' }),
    mk('b2', '10:40', 'Bのすぐ近く', 'https://maps.app.goo.gl/b2'),
    mk('e2', '11:00', '出来事2（場所なし）', ''),
    mk('c', '12:30', 'C到着', 'https://maps.app.goo.gl/c', { transport: 'train' })
  ];
  var stops = T.replayStops({ startDate: '2026-05-01', endDate: '2026-05-01' }, blocks);
  var tl2 = T.buildReplayTimeline(stops, coords);
  ok('前提：近すぎる予定（b→b2）は区間を作らず、a→b と b→c の2区間になる', tl2.legs.length === 2);
  var violations = [], shown = 0, hiddenDuringLeg = 0;
  for (var r = 0; r <= tl2.totalReal; r += 0.01) {
    var s2 = T.replayStateAt(tl2, r);
    var about = T.replayAboutToMove(tl2, r);
    if (!T.replayCaptionVisible(s2, { aboutToMove: about })) { if (s2.icon && s2.captionIndex >= 0) hiddenDuringLeg++; continue; }
    shown++;
    var cs = tl2.stops[s2.captionIndex];
    if (s2.icon) violations.push('乗り物が移動中なのに吹き出し r=' + r.toFixed(2));
    var leg = tl2.legs.filter(function (l) { return l.to === s2.captionIndex; })[0];
    if (leg && r < leg.r1 + T.REPLAY_ARRIVAL_SETTLE_SEC - 1e-6) violations.push('区間で着いてカメラが落ち着く前に吹き出し ' + cs.label + ' r=' + r.toFixed(2));
    if (about) violations.push('出発の直前なのに吹き出し r=' + r.toFixed(2));
    if (cs.arrival) violations.push('到着の仮地点に吹き出し');
  }
  eq('吹き出しは、乗り物が着いてカメラが落ち着いたあと・出発の前のあいだだけ（違反なし）', violations.slice(0, 3), []);
  ok('吹き出しは実際に出る（全部が隠れてはいない）', shown > 50);
  eq('乗り物が移動中の吹き出しは、そもそも出ない設計（隠すべきコマが無い）', hiddenDuringLeg, 0);
  // 各区間：出発の1.15秒前には吹き出しが消え、着いてから1.1秒後に次の吹き出しが出る
  tl2.legs.forEach(function (l, k) {
    var before = T.replayStateAt(tl2, l.r0 - 0.5);
    eq('区間' + k + '：出発の0.5秒前は吹き出しを出さない', T.replayCaptionVisible(before, { aboutToMove: T.replayAboutToMove(tl2, l.r0 - 0.5) }), false);
    var justArrived = T.replayStateAt(tl2, l.r1 + 0.3);
    eq('区間' + k + '：着いて0.3秒（カメラが動いている最中）は、吹き出しを出す状態ではない',
      T.replayCaptionVisible(justArrived, {}) && justArrived.captionIndex === l.to, false);
    var settled = T.replayStateAt(tl2, l.r1 + T.REPLAY_ARRIVAL_SETTLE_SEC + 0.05);
    eq('区間' + k + '：カメラが落ち着いたら着いた地点の吹き出しを出す', [settled.captionIndex, T.replayCaptionVisible(settled, {})], [l.to, true]);
    eq('区間' + k + '：カメラが動いている間（flags.cameraMoving）は出さない', T.replayCaptionVisible(settled, { cameraMoving: true }), false);
  });
  var lastLegStop = tl2.stops[tl2.legs[0].to];
  ok('着いた地点の吹き出しは、着いてカメラが落ち着いた後から、次の出発の前まで続く',
    lastLegStop.rCaptionStart - lastLegStop.r >= T.REPLAY_ARRIVAL_SETTLE_SEC - 1e-9 && lastLegStop.rDwellEnd > lastLegStop.rCaptionStart);
  eq('区間を作らない（近すぎる）予定の吹き出しは、これまでどおり短い一呼吸（0.5秒）で出る',
    (function () { var i = tl2.stops.findIndex(function (s) { return s.blockId === 'b2'; }); return +(tl2.stops[i].rCaptionStart - tl2.stops[i].r).toFixed(3); })(), 0.5);
})();

/* ---- 地図でふりかえる：カメラを1本の制御で動かす判断（Core.cameraMoveDecision、2026-09-30） ---- */
(function () {
  var view = { lat: 35.5, lng: 139.7, zoom: 15 };
  // ズーム15・幅375pxの画面は約 375*4.77m*cos(35.5) ≒ 1.46km 幅。その6%＝約87m
  eq('cameraMoveDecision: 画面幅に比べてわずかなずれ（約50m・ズーム15）は動かさない',
    T.cameraMoveDecision(view, { lat: 35.5004, lng: 139.7, zoom: 15 }, { viewWidthPx: 375 }), 'skip');
  eq('cameraMoveDecision: 画面幅の1/4ほどずれたら動かす',
    T.cameraMoveDecision(view, { lat: 35.5033, lng: 139.7, zoom: 15 }, { viewWidthPx: 375 }), 'go');
  eq('cameraMoveDecision: 縮尺は半段未満の差なら同じ（zoomSnap=1）',
    T.cameraMoveDecision(view, { lat: 35.5, lng: 139.7, zoom: 15.4 }, { viewWidthPx: 375 }), 'skip');
  eq('cameraMoveDecision: 縮尺が1段違えば動かす',
    T.cameraMoveDecision(view, { lat: 35.5, lng: 139.7, zoom: 14 }, { viewWidthPx: 375 }), 'go');
  eq('cameraMoveDecision: 対象がもう画面に収まっていて縮尺差が1段以内なら動かさない（続く短い区間で寄せ直さない）',
    T.cameraMoveDecision(view, { lat: 35.503, lng: 139.7, zoom: 14 }, { viewWidthPx: 375, alreadyVisible: true }), 'skip');
  eq('cameraMoveDecision: 収まっていても縮尺差が2段以上なら動かす',
    T.cameraMoveDecision(view, { lat: 35.5, lng: 139.7, zoom: 12 }, { viewWidthPx: 375, alreadyVisible: true }), 'go');
  eq('cameraMoveDecision: アニメ中に急ぎでない移動が来たら「あとで」（始め直さない）',
    T.cameraMoveDecision(view, { lat: 36.5, lng: 139.7, zoom: 12 }, { viewWidthPx: 375, flying: true }), 'defer');
  eq('cameraMoveDecision: アニメ中でも、移動の直前（急ぎ）なら始め直す',
    T.cameraMoveDecision(view, { lat: 36.5, lng: 139.7, zoom: 12 }, { viewWidthPx: 375, flying: true, urgent: true }), 'go');
  eq('cameraMoveDecision: アニメ中でも、行き先がほぼ同じなら何もしない（同じ先へ何度も始めない）',
    T.cameraMoveDecision(view, { lat: 35.5001, lng: 139.7, zoom: 15 }, { viewWidthPx: 375, flying: true, urgent: true }), 'skip');
  eq('cameraMoveDecision: 今の見え方が分からなければ動かす', T.cameraMoveDecision(null, view, {}), 'go');
  eq('cameraMoveDecision: 画面幅が分からないときは従来のcameraMoveNeededと同じ基準（50m）',
    [T.cameraMoveDecision(view, { lat: 35.5001, lng: 139.7, zoom: 15 }), T.cameraMoveDecision(view, { lat: 35.51, lng: 139.7, zoom: 15 })], ['skip', 'go']);
})();

/* ---- Blockの並べ替えドラッグ（initBlockDragReorder）で使う純粋関数
   （Core.blockDragTargetIndex / Core.blockDragShifts、2026-09-29〜、長押しでの並べ替えを直した際に追加） ---- */
(function () {
  // otherCentersより上（小さい値）にあるものは何もカウントせず、下にあるものだけ数える
  eq('blockDragTargetIndex: 全員より上ならインデックス0', T.blockDragTargetIndex(0, [100, 200, 300]), 0);
  eq('blockDragTargetIndex: 全員より下なら人数ぶん全部数える', T.blockDragTargetIndex(1000, [100, 200, 300]), 3);
  eq('blockDragTargetIndex: 途中の位置なら、それより上にいる人数になる', T.blockDragTargetIndex(250, [100, 200, 300]), 2);
  eq('blockDragTargetIndex: 他のBlockが無ければ常に0', T.blockDragTargetIndex(999, []), 0);

  // gapIndex（元々あった位置）より上に動かすときは、間にいたBlockが下にずれる
  eq('blockDragShifts: 先頭へ動かすと、元の位置より前の全員が下にずれる',
    T.blockDragShifts(4, 0, 2, 80), [80, 80, 0, 0]);
  // gapIndexより下に動かすときは、間にいたBlockが上にずれる
  eq('blockDragShifts: 末尾へ動かすと、元の位置より後の全員が上にずれる',
    T.blockDragShifts(4, 4, 2, 80), [0, 0, -80, -80]);
  // 動いていなければ誰もずれない
  eq('blockDragShifts: 元の位置のままなら誰もずれない',
    T.blockDragShifts(4, 2, 2, 80), [0, 0, 0, 0]);
  // 1つ隣に動かすだけなら、間の1人だけがずれる
  eq('blockDragShifts: 1つ前に動かすと、間の1人だけ下にずれる',
    T.blockDragShifts(4, 1, 2, 80), [0, 80, 0, 0]);
})();

/* ---- 横スワイプの向き判定（Core.decideSwipe、2026-09-29〜。「行ったことある旅先」の
   国内⇄海外・マイログのカテゴリの横スワイプで共通に使う。地図の上から始めても軽く効くように、
   タップ（動きが小さい）とスワイプ（40px以上、または短くても素早いflick）を区別する） ---- */
(function () {
  eq('decideSwipe: 動きがほぼ無ければ何もしない（タップ）', T.decideSwipe(2, 1, 120), null);
  eq('decideSwipe: 40px未満の遅い動きはタップの揺れとみなす', T.decideSwipe(25, 2, 300), null);
  eq('decideSwipe: 40px以上の左スワイプはleft', T.decideSwipe(-45, 3, 250), 'left');
  eq('decideSwipe: 40px以上の右スワイプはright', T.decideSwipe(45, 3, 250), 'right');
  eq('decideSwipe: 20px以上でも素早く弾けばflickとしてleft', T.decideSwipe(-25, 2, 50), 'left');
  eq('decideSwipe: 20px未満はflickでも判定しない', T.decideSwipe(-15, 1, 20), null);
  eq('decideSwipe: 縦の動きの方が大きければ横スワイプにしない', T.decideSwipe(30, 40, 200), null);
  eq('decideSwipe: dtが0（同一フレーム）でも距離だけで判定できる', T.decideSwipe(50, 0, 0), 'right');
})();

/* ---- 動画でシェア（地図でふりかえるを縦動画にする。docs/adr/0020）：メルカトル投影・カメラ・時間割・絵コンテ ---- */
(function () {
  var near = function (a, b, eps) { return Math.abs(a - b) < (eps || 1e-6); };

  // 投影
  var o = T.mercatorWorld(0, 0);
  ok('mercatorWorld: 赤道・本初子午線は世界の真ん中', near(o.x, 0.5) && near(o.y, 0.5));
  ok('mercatorWorld: 経度180は右端', near(T.mercatorWorld(0, 180).x, 1));
  ok('mercatorWorld: 北は上（yが小さい）', T.mercatorWorld(60, 0).y < 0.5);
  var tk = T.mercatorWorld(35.6895, 139.6917);
  var back = T.mercatorLatLng(tk.x, tk.y);
  ok('mercatorLatLng: 往復して元に戻る', near(back.lat, 35.6895, 1e-6) && near(back.lng, 139.6917, 1e-6));
  ok('mercatorWorld: 極端な緯度でも有限（85.05度で丸める）', isFinite(T.mercatorWorld(90, 0).y));
  ok('mercatorWorld: 日付変更線を越えた経度（±360）も連続', T.mercatorWorld(0, 190).x > 1);
  eq('videoWorldScale: ズーム0は256px、1つ上がるごとに2倍', [T.videoWorldScale(0), T.videoWorldScale(3)], [256, 2048]);

  // 全体が入るズームと中心
  var pad = { top: 230, right: 80, bottom: 420, left: 80 };
  var pts = [[35.0, 135.0], [36.0, 140.0]];
  var fv = T.videoFitView(pts, 720, 1280, pad, 2, 13);
  var p0 = T.videoProject(fv, 720, 1280, 35.0, 135.0), p1 = T.videoProject(fv, 720, 1280, 36.0, 140.0);
  ok('videoFitView: 点が余白の内側に収まる',
    Math.min(p0.x, p1.x) >= pad.left - 0.5 && Math.max(p0.x, p1.x) <= 720 - pad.right + 0.5 &&
    Math.min(p0.y, p1.y) >= pad.top - 0.5 && Math.max(p0.y, p1.y) <= 1280 - pad.bottom + 0.5);
  var cxs = (p0.x + p1.x) / 2, cys = (p0.y + p1.y) / 2;
  ok('videoFitView: 点の中心が余白を除いた領域の真ん中に来る', near(cxs, 360, 0.5) && near(cys, 230 + (1280 - 230 - 420) / 2, 0.5));
  eq('videoFitView: 1点だけなら最大ズーム', T.videoFitView([[35, 135]], 720, 1280, pad, 2, 13).zoom, 13);
  eq('videoFitView: 世界規模でも最小ズームより小さくならない', T.videoFitView([[-60, -170], [60, 170]], 720, 1280, pad, 2, 13).zoom, 2);
  eq('videoFitView: 点が無ければ最小ズーム', T.videoFitView([], 720, 1280, pad, 2, 13).zoom, 2);

  // タイル
  var vt = T.videoViewTiles({ x: 0.5, y: 0.5, zoom: 3 }, 720, 1280);
  eq('videoViewTiles: ズームは四捨五入した整数', vt.z, 3);
  ok('videoViewTiles: 画面の中心のタイル（4,4）を含む', vt.list.some(function (t) { return t.x === 4 && t.y === 4; }));
  ok('videoViewTiles: 画面いっぱいを覆う（左上のタイルは画面の左上より外）', vt.list.every(function (t) { return t.px < 720 && t.py < 1280 && t.px + vt.size > 0 && t.py + vt.size > 0; }));
  var wrap = T.videoViewTiles({ x: 0.999, y: 0.5, zoom: 3 }, 720, 1280);
  ok('videoViewTiles: 東の端を越えたタイルは西へ折り返す（番号は0〜7）', wrap.list.every(function (t) { return t.x >= 0 && t.x < 8; }) && wrap.list.some(function (t) { return t.x === 0; }));
  var fracZoom = T.videoViewTiles({ x: 0.5, y: 0.5, zoom: 3.4 }, 720, 1280);
  ok('videoViewTiles: 小数のズームはタイルの大きさで吸収する', fracZoom.z === 3 && near(fracZoom.size, 256 * Math.pow(2, 0.4), 1e-6));
  ok('videoViewTiles: 北の端の外（y<0）のタイルは出さない', T.videoViewTiles({ x: 0.5, y: 0.0, zoom: 2 }, 720, 1280).list.every(function (t) { return t.y >= 0; }));

  // 間引き・時間割
  eq('videoPickEvenly: 少なければ全部', T.videoPickEvenly(3, 7), [0, 1, 2]);
  eq('videoPickEvenly: 多ければ端を含めて均等に', T.videoPickEvenly(13, 3), [0, 6, 12]);
  eq('videoPickEvenly: 1つだけなら先頭', T.videoPickEvenly(10, 1), [0]);
  eq('videoPickEvenly: 0件', T.videoPickEvenly(0, 7), []);
  ok('videoPickEvenly: 上限を超えない・重複しない', (function () { var r = T.videoPickEvenly(100, 7); return r.length === 7 && r[0] === 0 && r[6] === 99; })());
  var sch = T.videoSchedule([{ dwell: 1, moveWeight: 1 }, { dwell: 0, moveWeight: 3 }, { dwell: 1, moveWeight: 1 }, { dwell: 1, moveWeight: 0 }], 11.5);
  ok('videoSchedule: 着く・出る時刻が単調に増える', sch.arrive.every(function (a, i) { return sch.leave[i] >= a && (i === 0 || a >= sch.leave[i - 1]); }));
  ok('videoSchedule: 最後の地点を出る時刻が全体の秒数（から余白を引いた値）に収まる', sch.leave[3] <= 11.5 - 0.7 + 1e-9 && sch.leave[3] > 11.5 - 0.7 - 1e-6);
  ok('videoSchedule: 移動の重さに比例（重さ3は重さ1の3倍）', near((sch.arrive[2] - sch.leave[1]) / (sch.arrive[1] - sch.leave[0]), 3, 1e-6));
  var many = T.videoSchedule([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function () { return { dwell: 2, moveWeight: 1 }; }), 11.5);
  ok('videoSchedule: 止まる時間が長すぎるときは全体の55%までに縮める（旅の長さによらず秒数は変わらない）', many.leave[9] <= 11.5 - 0.7 + 1e-9);
  eq('videoSchedule: 地点が無ければ空', T.videoSchedule([], 11.5), { arrive: [], leave: [] });
  ok('videoSchedule: 移動の重さがすべて0でも時間が進む', (function () { var r = T.videoSchedule([{ dwell: 0, moveWeight: 0 }, { dwell: 0, moveWeight: 0 }], 11.5); return r.arrive[1] > r.leave[0]; })());

  // 日付・折り返し・形式
  eq('videoDateRange: 同じ月', T.videoDateRange('2025-09-11', '2025-09-18'), '2025.9.11〜9.18');
  eq('videoDateRange: 月をまたぐ', T.videoDateRange('2025-09-28', '2025-10-02'), '2025.9.28〜10.2');
  eq('videoDateRange: 年をまたぐ', T.videoDateRange('2025-12-28', '2026-01-03'), '2025.12.28〜2026.1.3');
  eq('videoDateRange: 1日だけ', T.videoDateRange('2025-09-11', '2025-09-11'), '2025.9.11');
  eq('videoDateRange: 終わりが無ければ開始日だけ', T.videoDateRange('2025-09-11', ''), '2025.9.11');
  eq('videoDateRange: 開始日が無ければ空', T.videoDateRange('', '2025-09-11'), '');
  var meas = function (s) { return s.length * 10; };
  eq('videoWrapLines: 収まるなら1行', T.videoWrapLines('スイス旅行', 100, meas, 3), ['スイス旅行']);
  eq('videoWrapLines: 日本語は幅で折り返す', T.videoWrapLines('スイス・ベルギー旅行', 60, meas, 3), ['スイス・ベル', 'ギー旅行']);
  eq('videoWrapLines: 英数字の単語は途中で切らない', T.videoWrapLines('Summer Trip 2025', 120, meas, 3), ['Summer Trip', '2025']);
  var clipped = T.videoWrapLines('あいうえおかきくけこさしすせそたちつてと', 50, meas, 2);
  ok('videoWrapLines: 行数を超えたら最後を…で終え、幅に収まる', clipped.length === 2 && /…$/.test(clipped[1]) && clipped.every(function (l) { return meas(l) <= 50; }));
  eq('videoWrapLines: 空なら空', T.videoWrapLines('  ', 100, meas, 3), []);
  eq('pickVideoMimeType: mp4(avc1)があれば最優先', T.pickVideoMimeType(function () { return true; }).mime, 'video/mp4;codecs=avc1');
  eq('pickVideoMimeType: avc1が無くてmp4だけなら',
    T.pickVideoMimeType(function (m) { return m === 'video/mp4' || m.indexOf('webm') >= 0; }).mime, 'video/mp4');
  var wm = T.pickVideoMimeType(function (m) { return m.indexOf('video/webm') === 0; });
  ok('pickVideoMimeType: webmしか無ければwebm（isMp4=false）', wm.ext === 'webm' && wm.isMp4 === false && wm.type === 'video/webm');
  eq('pickVideoMimeType: 何も無ければnull', T.pickVideoMimeType(function () { return false; }), null);
  eq('pickVideoMimeType: isTypeSupportedが例外を投げても落ちない', T.pickVideoMimeType(function () { throw new Error('x'); }), null);

  // 絵コンテ：地図でふりかえるの時間割（tl）から作る
  function mkStop(label, lat, lng, extra) {
    return Object.assign({ label: label, lat: lat, lng: lng, located: true, dayNumber: 1, photos: [], captions: ['エピソード本文は動画に出さない'] }, extra || {});
  }
  function mkTl(stops) {
    var legs = [];
    for (var i = 1; i < stops.length; i++) legs.push({ from: i - 1, to: i, transport: 'car', path: [[stops[i - 1].lat, stops[i - 1].lng], [stops[i].lat, stops[i].lng]] });
    return { stops: stops, legs: legs, keyframes: [{ t: 0, r: 0 }], totalReal: 10 };
  }
  var tl3 = mkTl([mkStop('成田空港', 35.77, 140.39, { minute: 480 }), mkStop('浅草寺', 35.71, 139.79, { dayNumber: 1, minute: 720 }), mkStop('京都駅', 34.98, 135.76, { dayNumber: 2, minute: 600 })]);
  var st = T.buildVideoStory(tl3, { title: 'テスト旅行', dateText: '2025.9.11〜9.13' });
  ok('buildVideoStory: 3地点から絵コンテができる', st && st.wps.length === 3 && st.segs.length === 2);
  eq('buildVideoStory: 2日の旅行は全体で30秒（導入1.5＋道のり26.5＋締め2）', [st.introSec, st.routeSec, st.outroSec, st.total], [1.5, 26.5, 2, 30]);
  eq('buildVideoStory: 1日目が8:00〜12:00（4時間）なので2つ、2日目は1つで、地名は3つ出る', st.wps.map(function (w) { return w.caption && w.caption.label; }), ['成田空港', '浅草寺', '京都駅']);
  ok('buildVideoStory: 動画にはエピソード本文・費用などを持ち込まない', JSON.stringify(st).indexOf('エピソード本文') === -1);
  eq('buildVideoStory: 2日目があれば日の表示を出す（maxDay）', st.maxDay, 2);
  eq('buildVideoStory: 写真オプションOFFなら写真は無い', st.hasPhotos, false);
  eq('buildVideoStory: 座標が1つだけならnull（動画にできない）', T.buildVideoStory(mkTl([mkStop('a', 35, 139)]), {}), null);
  eq('buildVideoStory: 座標が分からない地点だけならnull', T.buildVideoStory({ stops: [{ located: false, label: 'x' }], legs: [] }, {}), null);
  var tlOut = mkTl([mkStop('A', 35, 139), mkStop('B(外れ値)', 10, 10, { located: false, outlier: true }), mkStop('C', 35.1, 139.1)]);
  tlOut.legs = [{ from: 0, to: 2, transport: 'car', path: [[35, 139], [35.05, 139.05], [35.1, 139.1]] }];
  var stOut = T.buildVideoStory(tlOut, {});
  eq('buildVideoStory: 場所が分からない・外れ値の地点は入れない', stOut.wps.map(function (w) { return w.stopIndex; }), [0, 2]);
  eq('buildVideoStory: 座標が分かる地点どうしの区間の道のり（leg.path）を使う', stOut.segs[0].path.length, 3);
  var tlArr = mkTl([mkStop('羽田', 35.55, 139.78), mkStop('到着', 21.3, -157.9, { arrival: true }), mkStop('ワイキキ', 21.28, -157.83)]);
  eq('buildVideoStory: 到着の仮地点は地名を出さない（replayも出さない）', T.buildVideoStory(tlArr, {}).wps.map(function (w) { return !!w.caption; }), [true, false, true]);
  var tlNoLabel = mkTl([mkStop('', 35, 139), mkStop('B', 35.2, 139.2)]);
  eq('buildVideoStory: 見出しが空の地点は地名を出さない', T.buildVideoStory(tlNoLabel, {}).wps.map(function (w) { return !!w.caption; }), [false, true]);
  var tlSame = mkTl([mkStop('宿', 35, 139), mkStop('宿', 35.001, 139.001), mkStop('駅', 35.2, 139.2)]);
  eq('buildVideoStory: 同じ地名が続くときは1回だけ', T.buildVideoStory(tlSame, {}).wps.map(function (w) { return !!w.caption; }), [true, false, true]);
  // 保存した動画（IndexedDB）のキー・入れ替え
  eq('videoSaveKey: 旅行ID＋写真あり/なしで別のキー', [T.videoSaveKey('t1', false), T.videoSaveKey('t1', true)], ['t1:n', 't1:p']);
  eq('videoEvictKeys: 上限以内なら何も消さない', T.videoEvictKeys([{ key: 'a', createdAt: 1 }, { key: 'b', createdAt: 2 }], 5), []);
  eq('videoEvictKeys: 上限を超えたら作った日時の古いものから消す', T.videoEvictKeys([{ key: 'a', createdAt: 3 }, { key: 'b', createdAt: 1 }, { key: 'c', createdAt: 2 }, { key: 'd', createdAt: 4 }], 2), ['c', 'b']);
  eq('videoEvictKeys: 上限の既定は' + T.VIDEO_SAVE_MAX + '本', T.videoEvictKeys([1, 2, 3, 4, 5, 6].map(function (n) { return { key: 'k' + n, createdAt: n }; })), ['k1']);
  eq('videoMadeAtText: 月/日 時:分（分は2桁）', T.videoMadeAtText(new Date(2026, 8, 30, 14, 5).getTime()), '9/30 14:05');
  eq('videoMadeAtText: 不正な値は空', T.videoMadeAtText(NaN), '');
  // 「動画に出さない」予定（videoExclude）：地名・写真・ピンは出さないが、道のりはその場所を通る
  var tlEx = mkTl([mkStop('A', 35, 139), mkStop('秘密の場所', 35.1, 139.1, { videoExclude: true, photos: ['secret.jpg'] }), mkStop('C', 35.2, 139.2)]);
  var stEx = T.buildVideoStory(tlEx, { photos: true });
  eq('buildVideoStory: 動画に出さない予定も地点（道のりの通過点）には残る', stEx.wps.map(function (w) { return w.stopIndex; }), [0, 1, 2]);
  eq('buildVideoStory: 動画に出さない予定の地名は出さない', stEx.wps.map(function (w) { return !!w.caption; }), [true, false, true]);
  eq('buildVideoStory: 動画に出さない予定の地名・写真IDは絵コンテのどこにも入らない', JSON.stringify(stEx).indexOf('秘密') === -1 && JSON.stringify(stEx).indexOf('secret.jpg') === -1, true);
  eq('buildVideoStory: 動画に出さない予定の写真は「写真あり」にも数えない', stEx.hasPhotos, false);
  eq('buildVideoStory: 動画に出さない予定は隠す印（hidden）が付く', stEx.wps.map(function (w) { return w.hidden; }), [false, true, false]);
  eq('buildVideoStory: 動画に出さない予定の前後にも道のりはつながっている（区間は2つ）', stEx.segs.length, 2);
  var frEx = T.videoFrameAt(stEx, stEx.introSec + stEx.routeSec - 0.5);
  eq('videoFrameAt: 動画に出さない予定のピンは最後まで出ない', frEx.pins.map(function (p) { return p.pop > 0; }), [true, false, true]);
  // 写真
  var tlPh = mkTl([mkStop('A', 35, 139, { photos: ['photo_a.jpg', 'photo_a2.jpg'] }), mkStop('', 35.1, 139.1, { photos: ['clip.mp4', 'photo_b.png'] }), mkStop('C', 35.2, 139.2, { photos: ['clip2.mov'] })]);
  var stPhOff = T.buildVideoStory(tlPh, { photos: false });
  eq('buildVideoStory: 写真OFFなら写真IDを持ち込まない', JSON.stringify(stPhOff).indexOf('photo_') === -1, true);
  eq('buildVideoStory: 写真OFFでは見出しの無い地点は出さない', stPhOff.wps.map(function (w) { return !!w.caption; }), [true, false, true]);
  var stPh = T.buildVideoStory(tlPh, { photos: true });
  eq('buildVideoStory: 写真ONでは各地点の最初の写真（動画は除く）。写真のある出来事を優先するので写真の無い3つ目は間引かれる', stPh.wps.map(function (w) { return w.caption && w.caption.photo; }), ['photo_a.jpg', 'photo_b.png', null]);
  eq('buildVideoStory: 写真ONなら見出しが空でも写真つきの地点は出す', stPh.wps[1].caption.label, '');
  eq('buildVideoStory: 写真があればhasPhotos', stPh.hasPhotos, true);
  // 多い旅行：地名の上限・時間の収まり
  var big = [];
  for (var bi = 0; bi < 60; bi++) big.push(mkStop('場所' + bi, 35 + bi * 0.01, 139 + bi * 0.01, { dayNumber: 1 + Math.floor(bi / 10) }));
  var stBig = T.buildVideoStory(mkTl(big), {});
  var capCount = stBig.wps.filter(function (w) { return w.caption; }).length;
  eq('buildVideoStory: 60地点・6日は全体45秒に収める（道のり41.5秒）', stBig.routeSec, 41.5);
  var bigPer = stBig.routeSec / 6;
  eq('buildVideoStory: 1日約6.9秒に収まる数（0.9秒×4=3.6秒≦6.9秒×55%）まで、1日4つ×6日=24', capCount, 24);
  ok('buildVideoStory: 60地点でも最後の地点を出る時刻が道のりの秒数に収まる', stBig.wps[59].leave <= stBig.routeSec + 1e-9);
  ok('buildVideoStory: 各日の窓の中に、その日の地点への到着が収まる', stBig.wps.every(function (w) { var d = w.dayNumber - 1; return w.arrive >= d * bigPer - 1e-9 && w.arrive <= (d + 1) * bigPer + 1e-9; }));
  ok('buildVideoStory: 各地名を0.85秒以上は見せる', stBig.wps.every(function (w) { return !w.caption || w.leave - w.arrive >= 0.85; }));
  ok('buildVideoStory: カメラの動きは時刻順で、重ならない', stBig.cameraMoves.every(function (m, i) { return m.dur > 0 && (i === 0 || m.t >= stBig.cameraMoves[i - 1].t + stBig.cameraMoves[i - 1].dur - 1e-9); }));
  ok('buildVideoStory: 1区間の線の点は間引かれる', (function () {
    var longPath = []; for (var q = 0; q < 2000; q++) longPath.push([35 + q * 0.0001, 139 + q * 0.0001]);
    var t2 = mkTl([mkStop('a', 35, 139), mkStop('b', 35.2, 139.2)]); t2.legs[0].path = longPath;
    return T.buildVideoStory(t2, {}).segs[0].path.length <= 300;
  })());
  eq('buildVideoStory: 道のりが無い（leg無し）区間は2点の直線', (function () {
    var t2 = mkTl([mkStop('a', 35, 139), mkStop('b', 35.2, 139.2)]); t2.legs = [];
    return T.buildVideoStory(t2, {}).segs[0].path.length;
  })(), 2);

  // 各時刻の絵
  var f0 = T.videoFrameAt(st, 0), fMid = T.videoFrameAt(st, 1.5 + 4), fEnd = T.videoFrameAt(st, st.total);
  eq('videoFrameAt: 始まりは導入（暗幕あり・ピンはまだ無い）', [f0.phase, f0.introAlpha > 0.9, f0.pins.every(function (p) { return p.pop === 0; })], ['intro', true, true]);
  ok('videoFrameAt: 導入の文字は少しずつ出る', T.videoFrameAt(st, 0.1).introTextAlpha < 1 && T.videoFrameAt(st, 0.5).introTextAlpha === 1);
  eq('videoFrameAt: 導入が終わると暗幕は無い', T.videoFrameAt(st, 1.5).introAlpha, 0);
  eq('videoFrameAt: 途中は道のり', fMid.phase, 'route');
  eq('videoFrameAt: 終わりは締め（暗幕あり）', [fEnd.phase, fEnd.outroAlpha], ['outro', 1]);
  ok('videoFrameAt: 最後にはすべての区間が描き終わり、ピンがすべて立つ', fEnd.segs.every(function (s) { return s.f === 1; }) && fEnd.pins.every(function (p) { return p.pop === 1; }));
  ok('videoFrameAt: 移動中は先頭の位置が2地点の間にある', (function () {
    for (var t = 1.6; t < st.total - 3; t += 0.05) {
      var f = T.videoFrameAt(st, t);
      if (f.head) return f.head.lat > 34.9 && f.head.lat < 35.8;
    }
    return false;
  })());
  ok('videoFrameAt: 区間の進み具合は時間とともに増えるだけ', (function () {
    var last = 0;
    for (var t = 1.5; t <= st.total - 2; t += 0.1) { var f = T.videoFrameAt(st, t).segs[0].f; if (f < last - 1e-9) return false; last = f; }
    return true;
  })());
  ok('videoFrameAt: 最初の地点に着くと地名の吹き出しが出る', (function () {
    var f = T.videoFrameAt(st, 1.5 + st.wps[0].arrive + 0.5);
    return !!f.caption && f.caption.label === '成田空港' && f.caption.alpha > 0.9;
  })());
  ok('videoFrameAt: 吹き出しは出る・消えるときにフェードする', T.videoFrameAt(st, 1.5 + st.wps[0].arrive + 0.05).caption.alpha < 1);
  eq('videoFrameAt: 日は今いる地点の日（最後は2日目）', T.videoFrameAt(st, st.total).day, 2);
  eq('videoFrameAt: 1日だけの旅行では日を出さない', T.videoFrameAt(T.buildVideoStory(mkTl([mkStop('a', 35, 139), mkStop('b', 35.2, 139.2)]), {}), 5).showDay, false);
  ok('videoFrameAt: 範囲外の時刻でも落ちない', !!T.videoFrameAt(st, -5) && !!T.videoFrameAt(st, 999));
  // カメラ：全区間で、立っているピンが画面に入っている
  ok('videoCameraAt: 導入は最初の地点（縮尺13）、最後は全体', (function () {
    var a = T.videoCameraAt(st, 0), b = T.videoCameraAt(st, st.total);
    return near(a.zoom, 13) && near(b.x, st.overview.x) && near(b.y, st.overview.y) && near(b.zoom, st.overview.zoom);
  })());
  ok('videoCameraAt: 道のりの間、移動中の先頭は画面（余白を含む）の中に入っている', (function () {
    for (var t = 1.5; t < st.total - 2; t += 0.05) {
      var f = T.videoFrameAt(st, t);
      if (!f.head) continue;
      var p = T.videoProject(f.camera, 720, 1280, f.head.lat, f.head.lng);
      if (p.x < 0 || p.x > 720 || p.y < 0 || p.y > 1280) return false;
    }
    return true;
  })());
  ok('videoCameraAt: 大きな旅行でも先頭はいつも画面の中', (function () {
    for (var t = 1.5; t < stBig.total - 2; t += 0.1) {
      var f = T.videoFrameAt(stBig, t);
      if (!f.head) continue;
      var p = T.videoProject(f.camera, 720, 1280, f.head.lat, f.head.lng);
      if (p.x < 0 || p.x > 720 || p.y < 0 || p.y > 1280) return false;
    }
    return true;
  })());
  // 必要なタイル
  var tiles = T.videoTilesNeeded(st);
  ok('videoTilesNeeded: タイルが重複しない', (function () { var seen = {}; return tiles.every(function (t) { var k = t.z + '/' + t.x + '/' + t.y; if (seen[k]) return false; seen[k] = 1; return true; }); })());
  ok('videoTilesNeeded: 必要なタイルの数が現実的（400枚以内）', tiles.length > 0 && tiles.length <= 400);
  ok('videoTilesNeeded: ズームの上限（15）を超えない', tiles.every(function (t) { return t.z <= 15; }));
  // 日付変更線をまたぐ旅（経度が±360されている）でも絵コンテができる
  var tlDate = mkTl([mkStop('羽田', 35.55, 139.78), mkStop('ロサンゼルス', 33.94, -118.4 + 360)]);
  var stDate = T.buildVideoStory(tlDate, {});
  ok('buildVideoStory: 日付変更線をまたぐ旅でも全体が画面に収まる', (function () {
    var v = stDate.overview, a = T.videoProject(v, 720, 1280, 35.55, 139.78), b = T.videoProject(v, 720, 1280, 33.94, 241.6);
    return a.x >= 0 && a.x <= 720 && b.x >= 0 && b.x <= 720;
  })());
})();

/* ---- 動画でシェア：長さは旅の日数で決める／地名は2時間に1つ・写真優先／旅行名は1行（2026-09-30） ---- */
(function () {
  function near(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); }
  // 長さ
  var totals = [1, 2, 3, 4, 8, 13, 14, 20, 30].map(function (d) { return T.videoDurationPlan(d).total; });
  eq('videoDurationPlan: 日帰り・2日・3日は全体で30秒', totals.slice(0, 3), [30, 30, 30]);
  eq('videoDurationPlan: 4日（3泊）は道のり40秒＋導入・締め3.5秒', [T.videoDurationPlan(4).routeSec, T.videoDurationPlan(4).total], [40, 43.5]);
  eq('videoDurationPlan: 8日は道のり41.5秒（1日約5.2秒）', T.videoDurationPlan(8).routeSec, 41.5);
  eq('videoDurationPlan: 5日以上は全体45秒に収める（5日は1日8.3秒）', [T.videoDurationPlan(5).total, T.videoDurationPlan(5).perDay], [45, 8.3]);
  ok('videoDurationPlan: 5日以上は全体を45秒に収め、1日ぶんは均等に縮む', [5, 8, 14, 20, 30, 100].every(function (d) { var p = T.videoDurationPlan(d); return near(p.total, 45) && near(p.perDay * d, p.routeSec) && p.perDay < 10; }));
  eq('videoDurationPlan: 20日は1日2.075秒', T.videoDurationPlan(20).perDay, 2.075);
  eq('videoDurationPlan: 日数が不正でも1日として扱う', T.videoDurationPlan(0).total, 30);
  eq('videoTileLimit: 30秒までは800枚', [T.videoTileLimit(15), T.videoTileLimit(30)], [800, 800]);
  eq('videoTileLimit: 長いほど増える（45秒で1250枚）', [T.videoTileLimit(43.5), T.videoTileLimit(45)], [1205, 1250]);
  // 地名の数：2時間に1つ
  eq('videoCaptionCount: 8:00〜22:00（14時間）は7つ', T.videoCaptionCount(14 * 60, 30), 7);
  eq('videoCaptionCount: 短い日でも最低1つ', T.videoCaptionCount(30, 10), 1);
  eq('videoCaptionCount: 1日10秒なら止まる時間は55%まで＝0.9秒×6つまで', T.videoCaptionCount(14 * 60, 10), 6);
  eq('videoCaptionCount: 1日約26秒なら7つ入る', T.videoCaptionCount(14 * 60, 26.5), 7);
  // 出来事の選び方：写真優先、残りは時間で均等
  eq('videoPickEvents: 少なければ全部', T.videoPickEvents([{ minute: 0 }, { minute: 60 }], 5), [0, 1]);
  eq('videoPickEvents: 写真のある出来事を優先', T.videoPickEvents([{ minute: 0 }, { minute: 60, hasImage: true }, { minute: 120 }, { minute: 180, hasImage: true }, { minute: 240 }], 2), [1, 3]);
  eq('videoPickEvents: 写真の方が多ければ、写真の中から均等に', T.videoPickEvents([0, 1, 2, 3, 4].map(function (i) { return { minute: i * 60, hasImage: true }; }), 3), [0, 2, 4]);
  eq('videoPickEvents: 写真が足りないぶんは、時間が離れたものを選ぶ（写真は9:00、残り1つは端の21:00）',
    T.videoPickEvents([{ minute: 540, hasImage: true }, { minute: 600 }, { minute: 780 }, { minute: 1260 }], 2), [0, 3]);
  eq('videoPickEvents: 写真が無ければ先頭から時間で均等（8時・15時・22時）',
    T.videoPickEvents([480, 540, 900, 1000, 1320].map(function (m) { return { minute: m }; }), 3), [0, 2, 4]);
  // 絵コンテ：1日あたりの地名数と写真優先
  function stop(label, day, minute, extra) {
    return Object.assign({ label: label, lat: 35 + day * 0.1 + minute / 100000, lng: 139 + minute / 5000, located: true, dayNumber: day, minute: minute, photos: [] }, extra || {});
  }
  function tlOf(stops) {
    var legs = [];
    for (var i = 1; i < stops.length; i++) legs.push({ from: i - 1, to: i, transport: 'car', path: [[stops[i - 1].lat, stops[i - 1].lng], [stops[i].lat, stops[i].lng]] });
    return { stops: stops, legs: legs, keyframes: [{ t: 0, r: 0 }], totalReal: 10 };
  }
  var d1 = []; // 8:00〜22:00、2時間おきに8つ、1日だけ
  for (var h = 8; h <= 22; h += 2) d1.push(stop('場所' + h, 1, h * 60));
  var s1 = T.buildVideoStory(tlOf(d1), {});
  eq('buildVideoStory: 日帰りは30秒', s1.total, 30);
  eq('buildVideoStory: 8:00〜22:00の日は7つ（14時間÷2時間）', s1.wps.filter(function (w) { return w.caption; }).length, 7);
  ok('buildVideoStory: 各地名は0.9秒以上見せる', s1.wps.every(function (w) { return !w.caption || w.capEnd - w.arrive >= 0.9 - 1e-9; }));
  ok('buildVideoStory: 時刻順のまま', s1.wps.every(function (w, i) { return i === 0 || w.arrive >= s1.wps[i - 1].leave - 1e-9; }));
  // 写真のある出来事を優先（写真を入れる設定がOFFでも）
  var d2 = d1.map(function (s, i) { return i === 1 || i === 5 ? Object.assign({}, s, { photos: ['photo_' + i + '.jpg'] }) : s; });
  var s2 = T.buildVideoStory(tlOf(d2), { photos: false });
  var labels2 = s2.wps.filter(function (w) { return w.caption; }).map(function (w) { return w.caption.label; });
  ok('buildVideoStory: 写真OFFでも、写真のある出来事（10時・18時）を優先して残す', labels2.indexOf('場所10') !== -1 && labels2.indexOf('場所18') !== -1);
  eq('buildVideoStory: 写真OFFなら写真IDは入らない', JSON.stringify(s2).indexOf('photo_') === -1, true);
  var s2p = T.buildVideoStory(tlOf(d2), { photos: true });
  eq('buildVideoStory: 写真ONなら写真が入る', s2p.wps.filter(function (w) { return w.caption && w.caption.photo; }).length, 2);
  // 複数日：日ごとに窓。4日（3泊）は1日10秒、5日以上は全体45秒に収めて日ごとに等分
  var days = [];
  for (var dd = 1; dd <= 8; dd++) { days.push(stop('朝' + dd, dd, 8 * 60)); days.push(stop('昼' + dd, dd, 12 * 60)); days.push(stop('夜' + dd, dd, 20 * 60)); }
  var s8 = T.buildVideoStory(tlOf(days), {});
  eq('buildVideoStory: 8日は道のり41.5秒・全体45秒', [s8.routeSec, s8.total, s8.days], [41.5, 45, 8]);
  var per8 = s8.routeSec / 8;
  eq('buildVideoStory: 8:00〜20:00（12時間）の日は6つのはずが3地点しか無いので3つ×8日', s8.wps.filter(function (w) { return w.caption; }).length, 24);
  ok('buildVideoStory: 各日の到着は、その日の窓の中', s8.wps.every(function (w) { var d = w.dayNumber - 1; return w.arrive >= d * per8 - 1e-9 && w.arrive <= (d + 1) * per8 + 1e-9; }));
  ok('buildVideoStory: 何日目かは1日ぶんの秒数ごとに変わる', [0, 1, 2, 5, 7].every(function (d) { return T.videoFrameAt(s8, s8.introSec + d * per8 + 0.5).day === d + 1; }));
  ok('buildVideoStory: 日をまたぐ移動は次の日の窓のはじめに始まって窓の中で終わる', (function () {
    var seg = s8.segs[2]; // 1日目の夜→2日目の朝
    return near(seg.moveStart, per8 + 0.3, 1e-6) && seg.moveEnd > per8 + 0.3 && seg.moveEnd < per8 * 2;
  })());
  ok('buildVideoStory: 前の日の最後の地点が延びても、地名の表示は延びない（capEnd）', s8.wps.every(function (w) { return !w.caption || w.capEnd <= w.leave + 1e-9; }));
  // 20泊（21日）：全体45秒
  var long21 = [];
  for (var l = 1; l <= 21; l++) { long21.push(stop('朝' + l, l, 480)); long21.push(stop('夜' + l, l, 1200)); }
  var sl = T.buildVideoStory(tlOf(long21), {});
  ok('buildVideoStory: 21日でも全体は45秒', near(sl.total, 45) && sl.wps[sl.wps.length - 1].leave <= sl.routeSec);
  // 旅行名を1行に
  var m2 = function (s, size) { return s.length * size; }; // 1文字あたりsizepx
  eq('videoFitTitle: 収まるなら最大サイズで1行', T.videoFitTitle('スイス旅行', 600, m2, { maxSize: 68, minSize: 40 }), { size: 68, lines: ['スイス旅行'] });
  var f1 = T.videoFitTitle('ブラジル・アルゼンチン', 600, m2, { maxSize: 68, minSize: 40 });
  ok('videoFitTitle: 長い旅行名は縮めて1行（幅に収まる最大のサイズ）', f1.lines.length === 1 && f1.size === 54 && m2(f1.lines[0], f1.size) <= 600 && m2(f1.lines[0], 56) > 600);
  var f2 = T.videoFitTitle('ブラジル・アルゼンチン・チリ・ペルー周遊の旅', 600, m2, { maxSize: 68, minSize: 40 });
  eq('videoFitTitle: 最小サイズでも入らなければ「・」で折り返す', f2, { size: 40, lines: ['ブラジル・アルゼンチン・チリ・', 'ペルー周遊の旅'] });
  var f3 = T.videoFitTitle('Brazil Argentina Trip', 600, m2, { maxSize: 68, minSize: 40 });
  ok('videoFitTitle: 英語は空白で折り返し、単語を切らない', f3.lines.length === 2 && f3.lines.join(' ') === 'Brazil Argentina Trip');
  var f4 = T.videoFitTitle('あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよ', 600, m2, { maxSize: 68, minSize: 40 });
  ok('videoFitTitle: 切れ目が無くて入らないときは2行・最後は…で幅に収まる', f4.lines.length === 2 && /…$/.test(f4.lines[1]) && f4.lines.every(function (l) { return m2(l, 40) <= 600; }));
  var f5 = T.videoFitTitle('アルゼンチン・ブラジル・チリ・ペルー・ボリビア・パラグアイ・ウルグアイ・コロンビア・エクアドル', 600, m2, { maxSize: 68, minSize: 40 });
  ok('videoFitTitle: 2行に入らなければ2行目を…で終える', f5.lines.length === 2 && /…$/.test(f5.lines[1]) && f5.lines.every(function (l) { return m2(l, 40) <= 600; }));
  eq('videoFitTitle: 空なら行なし', T.videoFitTitle('  ', 600, m2, {}).lines, []);
})();

/* ---- 移動の予定の唯一のピンが到着地のとき、その予定は前の時差のまま（2026-09-30） ---- */
(function () {
  var LA = 'America/Los_Angeles', CH = 'America/Chicago', TK = 'Asia/Tokyo';
  var LAXP = { mapLat: 33.94, mapLng: -118.40 }, HOUP = { mapLat: 29.65, mapLng: -95.28 };
  function houstonDay() {
    return [
      { id: 'lax', date: '2026-06-28', time: '04:00', category: 'transport', label: 'ロサンゼルス国際空港', createdAt: '1', entries: [Object.assign({}, LAXP)] },
      { id: 'fl', date: '2026-06-28', time: '05:45', category: 'transport', label: 'ヒューストンへのフライト', createdAt: '2', entries: [Object.assign({}, HOUP)] },
      { id: 'arr', date: '2026-06-28', time: '11:12', category: 'transport', label: 'ヒューストン到着', createdAt: '3', entries: [Object.assign({}, HOUP)] }
    ];
  }
  var by = { lax: LA, fl: CH, arr: CH };
  var z = T.assignBlockZones(houstonDay(), by, TK);
  eq('到着地だけのフライト: 出発時刻は前の時差（ロサンゼルス）、到着から新しい時差', [z.lax, z.fl, z.arr], [LA, LA, CH]);
  var cp = houstonDay(); T.applyBlockZones(cp, z);
  eq('到着地だけのフライト: 並びは出発→到着のまま（フライトが空港より前に来ない）', T.sortBlocks(cp).map(function (b) { return b.id; }), ['lax', 'fl', 'arr']);
  eq('到着地だけのフライト: 時差の区切りはフライトのあと（到着の前）だけ', cp.map(function (b) { return b._offset; }), [-420, -420, -300]);

  // 出発地のピン（ロサンゼルス）のフライトは今までどおり。到着は別のピン
  var dep = houstonDay(); dep[1].entries = [Object.assign({}, LAXP)];
  var z2 = T.assignBlockZones(dep, { lax: LA, fl: LA, arr: CH }, TK);
  eq('出発地のピンのフライトは変わらない', [z2.lax, z2.fl, z2.arr], [LA, LA, CH]);

  // 旅の最初の予定なら、前の時差が無いので自分のピンをそのまま使う
  var first = houstonDay().slice(1);
  var z3 = T.assignBlockZones(first, { fl: CH, arr: CH }, TK);
  eq('旅の最初の予定は自分のピンの時差', [z3.fl, z3.arr], [CH, CH]);

  // 手で直した時差は今までどおり最優先
  var ov = houstonDay(); ov[1].tzOverride = CH;
  eq('tzOverrideのIANA名が優先', T.assignBlockZones(ov, by, TK).fl, CH);
  var ih = houstonDay(); ih[1].tzOverride = 'inherit';
  eq("tzOverride='inherit'は前と同じ", T.assignBlockZones(ih, by, TK).fl, LA);

  // 次の予定のピンが別の場所（ホテルなど）なら、到着地とは判断できないので今までどおり自分のピンの時差
  var elsewhere = houstonDay(); elsewhere[2].entries = [{ mapLat: 29.98, mapLng: -95.34 }];
  var z4 = T.assignBlockZones(elsewhere, by, TK);
  eq('次の予定が別の場所のピンなら、自分のピンの時差のまま（推測しない）', [z4.fl, z4.arr], [CH, CH]);

  // 前後から遠く離れたピン（違う場所）は、今までどおり無視される
  var out = [
    { id: 'a', date: '2026-06-28', time: '09:00', category: 'other', label: 'a', createdAt: '1', entries: [Object.assign({}, HOUP)] },
    { id: 'fl', date: '2026-06-28', time: '10:00', category: 'transport', label: 'b', createdAt: '2', entries: [Object.assign({}, LAXP)] },
    { id: 'c', date: '2026-06-28', time: '11:00', category: 'other', label: 'c', createdAt: '3', entries: [{ mapLat: 29.7, mapLng: -95.3 }] }
  ];
  eq('遠く離れたピンは無視', T.assignBlockZones(out, { a: CH, fl: LA, c: CH }, TK).fl, CH);

  // 時刻も矛盾しない別のピンの移動（着いた先の地図を入れた移動の予定）は、今までどおり
  var sep = [
    { id: 'h', date: '2026-06-26', time: '18:30', category: 'other', label: 'h', createdAt: '1', entries: [{ mapLat: 35.55, mapLng: 139.78 }] },
    { id: 'lax', date: '2026-06-26', time: '18:50', category: 'transport', label: 'LAX', createdAt: '2', entries: [Object.assign({}, LAXP)] }
  ];
  eq('時刻が合う別のピンの移動は自分のピンの時差', T.assignBlockZones(sep, { h: TK, lax: LA }, TK).lax, LA);
})();

/* ---- ログインし直しが必要かの判定（REQUIRE_SESSION後、2026-09-30） ---- */
eq('needsFreshLogin: tokenの無い保存済みユーザーは再ログインが必要', T.needsFreshLogin({ email: 'a@b.c', name: 'x' }), true);
eq('needsFreshLogin: 空文字のtokenも再ログインが必要', T.needsFreshLogin({ email: 'a@b.c', token: '' }), true);
eq('needsFreshLogin: tokenがあれば不要', T.needsFreshLogin({ email: 'a@b.c', token: 'abc' }), false);
eq('needsFreshLogin: 未ログイン（null）はログイン画面へ行くだけなので対象外', T.needsFreshLogin(null), false);
eq('isLoginRequiredError: login_requiredのエラー', T.isLoginRequiredError(new Error('login_required')), true);
eq('isLoginRequiredError: 別のエラーは対象外（通信失敗など）', T.isLoginRequiredError(new Error('http_500')), false);
eq('isLoginRequiredError: nullでも落ちない', T.isLoginRequiredError(null), false);

/* ---- スクショから予定を作る：確認画面の純粋関数（docs/adr/0022） ---- */
(function () {
  var trip = { startDate: '2026-10-03', endDate: '2026-10-05' };
  var items = [
    { date: '2026-10-04', time: '', label: '夕食', category: 'food', costItems: [] },
    { date: '2026-10-03', time: '12:05', label: 'ホテル', category: 'lodging', costItems: [] },
    { date: '2026-10-03', time: '09:30', label: '羽田→那覇', category: 'transport', transport: 'plane', fromPlace: '羽田空港', toPlace: '那覇空港', company: '日本航空', routeNumber: 'JAL903', arriveTime: '12:05', mapUrl: 'https://www.google.com/maps/search/?api=1&query=1%2C2', mapPlaceName: '羽田空港', mapLat: 1, mapLng: 2, arriveMapUrl: 'https://www.google.com/maps/search/?api=1&query=3%2C4', arriveLat: 3, arriveLng: 4, costItems: [{ label: '運賃', amount: 18700 }] },
    { date: '2026-10-04', time: '14:00', label: '試合', category: 'sightseeing', costItems: [] }
  ];
  var g = T.groupScreenshotItemsByDay(items);
  eq('スクショ: 日ごとにまとめる', g.map(function (x) { return x.date; }), ['2026-10-03', '2026-10-04']);
  eq('スクショ: 日の中は時刻順', g[0].items.map(function (x) { return x.label; }), ['羽田→那覇', 'ホテル']);
  eq('スクショ: 時刻なしは最後', g[1].items.map(function (x) { return x.label; }), ['試合', '夕食']);
  eq('スクショ: 元の位置を_indexに持つ', g[0].items.map(function (x) { return x._index; }), [2, 1]);
  eq('スクショ: 空でも落ちない', T.groupScreenshotItemsByDay(null), []);

  var p = T.screenshotItemsToSavePayload(items, trip);
  eq('スクショ: 送る件数', p.items.length, 4);
  var t = p.items[2];
  eq('スクショ: 移動は区間・便名・出発到着・到着地の地図を持つ', [t.from, t.to, t.company, t.depart, t.arrive, t.arriveLat, t.mapLat], ['羽田空港', '那覇空港', '日本航空 JAL903', '09:30', '12:05', 3, 1]);
  eq('スクショ: 費用', t.costItems, [{ label: '運賃', amount: 18700 }]);
  eq('スクショ: 移動以外は移動の項目を持たない', p.items[0].from, undefined);

  var bad = [
    { use: false, date: '2026-10-03', label: '除外', category: 'other' },
    { date: '2026-10-09', label: '日程の外', category: 'other' },
    { date: '', label: '日付なし', category: 'other' },
    { date: '2026-10-03', label: '  ', category: 'other' },
    { date: '2026-10-03', label: '外貨', category: 'other', time: '25:00', costItems: [{ label: 'A', amount: 5, currency: 'USD', rate: 150 }, { label: 'B', amount: -1 }] }
  ];
  var r = T.screenshotItemsToSavePayload(bad, trip);
  eq('スクショ: 通るのは1件（除外・日程外・日付なし・見出しなしは送らない）', r.items.length, 1);
  eq('スクショ: エラーの理由（除外は数えない）', r.errors.map(function (e) { return e.reason; }), ['日付が旅行の日程の外です', '日付を入れてください', '見出しが空です']);
  eq('スクショ: 不正な時刻は空・負の金額は送らない・レートは持ち越す', [r.items[0].time, r.items[0].costItems], ['', [{ label: 'A', amount: 5, currency: 'USD', rate: 150 }]]);
  eq('スクショ: 日程未設定の旅行なら日付は何でも通る', T.screenshotItemsToSavePayload([{ date: '2030-01-01', label: 'x', category: 'other' }], {}).items.length, 1);
})();

/* ---- 音声・メモも同じ確認画面で保存する（docs/adr/0022 2026-09-30追記） ---- */
(function () {
  // メモの文章から金額を拾う（円・¥・$・ドルなどの印があるものだけ）
  var c = T.parseCostsFromLine('ランチ 天丼1,500円、お土産 ￥2000、タクシー $12、コーヒー€3.5');
  eq('メモ: 1,500円・￥2000・$12・€3.5を費用にする', c.costs, [
    { label: '天丼', amount: 1500 }, { label: 'お土産', amount: 2000 },
    { label: 'タクシー', amount: 12, currency: 'USD' }, { label: 'コーヒー', amount: 3.5, currency: 'EUR' }
  ]);
  eq('メモ: 金額の部分を取り除いた文章', T.parseCostsFromLine('天丼1,500円').rest, '天丼');
  eq('メモ: 印のない数字（10時・3人・2日目）は費用にしない', T.parseCostsFromLine('10時に3人で2日目の予定 12:30').costs, []);
  eq('メモ: 12ドルは外貨（USD）', T.parseCostsFromLine('入場料 12ドル').costs, [{ label: '入場料', amount: 12, currency: 'USD' }]);
  eq('メモ: 金額の前に言葉が無ければfallbackの見出し', T.parseCostsFromLine('¥800', 'カフェ').costs, [{ label: 'カフェ', amount: 800 }]);
  eq('メモ: 0円・巨額は拾わない', T.parseCostsFromLine('0円 99999999円').costs, []);

  // 決まった形のメモ → 確認画面の候補
  var dates = ['2026-10-03', '2026-10-04'];
  var parsed = T.parseMemo('10時 浅草寺\n12時 ランチ 天丼1,500円\n混んでいた\n入場料 ￥800\n14時 スカイツリー https://maps.app.goo.gl/abc\n15時 お店 https://tabelog.com/x\n10/4\n9時 朝ごはん', dates, '2026-10-03');
  eq('メモ: 決まった形として読める', parsed.ok, true);
  var items = T.memoBlocksToProposals(parsed.blocks);
  eq('メモ: 候補の件数・時刻', items.map(function (i) { return i.time; }), ['10:00', '12:00', '14:00', '15:00', '09:00']);
  eq('メモ: 日付（「10/4」の行で変わる）', items.map(function (i) { return i.date; }), ['2026-10-03', '2026-10-03', '2026-10-03', '2026-10-03', '2026-10-04']);
  eq('メモ: 金額は書いてある分だけ（ほかは空のまま）', items.map(function (i) { return i.costItems.length; }), [0, 2, 0, 0, 0]);
  eq('メモ: 見出しから金額を取り除く', items[1].label, 'ランチ 天丼');
  eq('メモ: GoogleマップのURLは地図、そのほかのURLはお店のURL', [items[2].mapUrl, items[3].mapUrl, items[3].shopUrl], ['https://maps.app.goo.gl/abc', undefined, 'https://tabelog.com/x']);
  eq('メモ: 場所は勝手に探さない（place空・座標なし）', [items[0].place, items[0].mapUrl, items[0].mapLat], ['', undefined, undefined]);
  eq('メモ: 確認画面の候補の形（スクショと同じ項目）', ['category', 'transport', 'fromPlace', 'toPlace', 'costItems', 'note', 'warnings'].every(function (k) { return k in items[0]; }), true);
  // 自分のAIのJSON：costItemsはそのまま使い、文章から拾い直さない
  var j = T.memoBlocksToProposals([{ date: '2026-10-03', time: '10:00', label: '昼食 500円', category: 'food', entry: { episode: 'x 300円', costItems: [{ label: '定食', amount: 900, currency: 'USD', rate: 150 }] } }], { extractCosts: false });
  eq('JSON: costItemsをそのまま使う（レートも持ち越す）', [j[0].label, j[0].costItems], ['昼食 500円', [{ label: '定食', amount: 900, currency: 'USD', rate: 150 }]]);

  // 保存の形：お店のURL・費用・地図
  var payload = T.screenshotItemsToSavePayload(items, { startDate: '2026-10-03', endDate: '2026-10-04' });
  eq('メモ: 保存の形（費用・お店のURL）', [payload.errors.length, payload.items[1].costItems, payload.items[3].shopUrl, payload.items[2].mapUrl], [0, [{ label: '天丼', amount: 1500 }, { label: '入場料', amount: 800 }], 'https://tabelog.com/x', 'https://maps.app.goo.gl/abc']);
  eq('費用を追加しただけ（金額が空）の行は送らない', T.screenshotItemsToSavePayload([{ date: '2026-10-03', label: 'x', category: 'food', costItems: [{ label: '費用', amount: undefined }] }], {}).items[0].costItems, []);

  // 自分だけの道への取り込み先
  var A = '111111', B = '222222';
  var branches = [
    { id: 'b1', accountId: A, date: '2026-10-03', endDate: '2026-10-04', startTime: '20:00', endTime: '12:00', title: '夜行' },
    { id: 'b2', accountId: B, date: '2026-10-05', endDate: '2026-10-05', startTime: '10:00', endTime: '15:00', title: '' }
  ];
  eq('取り込み先: 自分の道を見ていて、日が自分の別行動の中ならその別行動', T.importTargetBranch(branches, A, A, '2026-10-04').id, 'b1');
  eq('取り込み先: 別行動の始まりの日も対象', T.importTargetBranch(branches, A, A, '2026-10-03').id, 'b1');
  eq('取り込み先: 別行動の外の日はみんなの予定（null）', T.importTargetBranch(branches, A, A, '2026-10-05'), null);
  eq('取り込み先: みんなの表示（viewAccountId空）ならnull', T.importTargetBranch(branches, '', A, '2026-10-04'), null);
  eq('取り込み先: 他人の道を見ているならnull', T.importTargetBranch(branches, B, A, '2026-10-05'), null);
  eq('取り込み先: ログインしていない（自分のidが空）ならnull', T.importTargetBranch(branches, A, '', '2026-10-04'), null);

  // 別行動に入れる候補の検証（サーバーのvalidateBranchBlockPlacementと同じ規則）
  var br = branches[0];
  var bp = T.screenshotItemsToSavePayload([
    { date: '2026-10-03', time: '19:00', label: '始まる前', category: 'food' },
    { date: '2026-10-03', time: '21:00', label: '夜', category: 'food' },
    { date: '2026-10-04', time: '09:00', label: '朝', category: 'food' },
    { date: '2026-10-04', time: '12:30', label: '終わった後', category: 'food' },
    { date: '2026-10-04', time: '', label: '時刻なし', category: 'food' },
    { date: '2026-10-05', time: '', label: '日の外', category: 'food' }
  ], { startDate: '2026-10-03', endDate: '2026-10-06' }, br);
  eq('別行動: 時間帯の中と時刻なしだけ送る', bp.items.map(function (i) { return i.label; }), ['夜', '朝', '時刻なし']);
  eq('別行動: 外れた理由（日付・時刻）', bp.errors.map(function (e) { return e.reason; }), ['時刻が別行動の時間帯（20:00〜12:00）の外です', '時刻が別行動の時間帯（20:00〜12:00）の外です', '日付が別行動の日程の外です']);
})();

/* ---- 自分だけの道（別行動の分岐。docs/adr/0021） ---- */
(function () {
  var A = '111111', B = '222222';
  var shared = [
    { id: 's1', date: '2026-10-01', time: '09:00', label: '朝ごはん', category: 'food', createdAt: '1', entries: [], branchId: '' },
    { id: 's2', date: '2026-10-01', time: '14:00', label: '海で遊ぶ', category: 'sightseeing', createdAt: '2', entries: [], branchId: '' },
    { id: 's3', date: '2026-10-01', time: '16:59', label: '海のかたづけ', category: 'other', createdAt: '3', entries: [], branchId: '' },
    { id: 's4', date: '2026-10-01', time: '17:00', label: '夕食', category: 'food', createdAt: '4', entries: [], branchId: '' },
    { id: 's5', date: '2026-10-01', time: '', label: 'お土産メモ', category: 'other', createdAt: '5', entries: [], branchId: '' },
    { id: 's6', date: '2026-10-02', time: '15:00', label: '2日目の予定', category: 'other', createdAt: '6', entries: [], branchId: '' }
  ];
  var branches = [
    { id: 'br1', accountId: A, name: 'アリス', date: '2026-10-01', startTime: '14:00', endTime: '17:00', title: '' },
    { id: 'br2', accountId: B, name: 'ボブ', date: '2026-10-01', startTime: '15:00', endTime: '16:00', title: '釣り' }
  ];
  var bb = [
    { id: 'b1', date: '2026-10-01', time: '14:30', label: '美術館', category: 'sightseeing', createdAt: '10', entries: [], branchId: 'br1' },
    { id: 'b2', date: '2026-10-01', time: '16:00', label: 'カフェ', category: 'food', createdAt: '11', entries: [], branchId: 'br1' },
    { id: 'b3', date: '2026-10-01', time: '', label: '帰り道の寄り道', category: 'other', createdAt: '12', entries: [], branchId: 'br1' },
    { id: 'b4', date: '2026-10-01', time: '15:10', label: '桟橋', category: 'sightseeing', createdAt: '13', entries: [], branchId: 'br2' }
  ];
  var ids = function (list) { return list.map(function (b) { return b.id; }); };

  eq('canUseBranches: いまはログインしていれば誰でも使える', T.canUseBranches({ email: 'a@b.c' }), true);
  eq('canUseBranches: DBにプランが入っていても関係なく使える（有料プランの販売は停止中）', T.canUseBranches({ plan: 'premium_plus' }), true);

  eq('blocksInBranchWindow: 開始時刻ちょうどを含み、終了時刻ちょうどは含まない',
    ids(T.blocksInBranchWindow(shared, branches[0])), ['s2', 's3']);
  eq('blocksInBranchWindow: 時刻なしの予定は入れない', ids(T.blocksInBranchWindow(shared, branches[0])).indexOf('s5'), -1);
  eq('blocksInBranchWindow: 別の日の予定は入れない', ids(T.blocksInBranchWindow(shared, { date: '2026-10-02', startTime: '00:00', endTime: '23:59' })), ['s6']);

  eq('visibleBlocksForView: みんな＝みんなの予定だけ（今までと同じ）', ids(T.visibleBlocksForView(shared, bb, branches, '')), ids(shared));
  eq('visibleBlocksForView: アリス＝14〜17時のみんなの予定が消えて、アリスの分岐の予定が入る',
    ids(T.visibleBlocksForView(shared, bb, branches, A)).sort(), ['b1', 'b2', 'b3', 's1', 's4', 's5', 's6']);
  eq('visibleBlocksForView: ボブ＝15〜16時だけ入れ替わる',
    ids(T.visibleBlocksForView(shared, bb, branches, B)).sort(), ['b4', 's1', 's2', 's3', 's4', 's5', 's6']);
  eq('visibleBlocksForView: 分岐を持たない人を選ぶとみんなと同じ', ids(T.visibleBlocksForView(shared, bb, branches, '999999')), ids(shared));
  eq('visibleBlocksForView: 元の配列は変えない', shared.length + '/' + bb.length, '6/4');

  eq('resolveViewAccountId: 分岐がある人はそのまま', T.resolveViewAccountId(A, branches), A);
  eq('resolveViewAccountId: 分岐が無くなった人はみんなに戻す', T.resolveViewAccountId('999999', branches), '');
  eq('resolveViewAccountId: 空はみんな', T.resolveViewAccountId('', branches), '');

  eq('branchViewOptions: 分岐を持つ人ごとに1つ（名前は参加者から、なければ分岐の名前）',
    T.branchViewOptions(branches, [{ accountId: A, name: 'あーちゃん' }]), [
      { accountId: A, name: 'あーちゃん', count: 1 },
      { accountId: B, name: 'ボブ', count: 1 }
    ]);
  eq('branchViewOptions: 分岐が無ければ空（切り替えを出さない）', T.branchViewOptions([], []), []);
  eq('branchViewOptions: 同じ人の複数の分岐は1つにまとめて数える',
    T.branchViewOptions(branches.concat([{ id: 'br3', accountId: A, name: 'アリス', date: '2026-10-02', startTime: '10:00', endTime: '11:00' }]), [])[0].count, 2);

  // 1日ぶんのタイムライン
  var kinds = function (items) {
    return items.map(function (it) { return it.type === 'block' ? it.block.id : it.type + ':' + it.branch.id; });
  };
  eq('dayTimelineItems: みんな＝カードが開始時刻の位置に入る（時刻なしは末尾）',
    kinds(T.dayTimelineItems(shared, bb, branches, '', '2026-10-01')),
    ['s1', 'card:br1', 's2', 'card:br2', 's3', 's4', 's5']);
  eq('dayTimelineItems: アリス＝自分の分岐は帯＋分岐の予定、ボブの分岐はカード、14〜17時のみんなの予定は隠れる',
    kinds(T.dayTimelineItems(shared, bb, branches, A, '2026-10-01')),
    ['s1', 'band:br1', 'b3', 'b1', 'card:br2', 'b2', 's4', 's5']);
  eq('dayTimelineItems: ボブ＝アリスの分岐はカード、自分の窓のぶんだけ入れ替わる',
    kinds(T.dayTimelineItems(shared, bb, branches, B, '2026-10-01')),
    ['s1', 'card:br1', 's2', 'band:br2', 'b4', 's3', 's4', 's5']);
  eq('dayTimelineItems: 分岐の無い日は今までどおり', kinds(T.dayTimelineItems(shared, bb, branches, A, '2026-10-02')), ['s6']);
  eq('dayTimelineItems: 分岐が1つも無い旅行は今までどおり', kinds(T.dayTimelineItems(shared, [], [], '', '2026-10-01')), ids(T.sortBlocks(shared.filter(function (b) { return b.date === '2026-10-01'; }))));
  eq('dayTimelineItems: 帯には自分の分岐か（own）が付く', T.dayTimelineItems(shared, bb, branches, A, '2026-10-01').filter(function (i) { return i.type === 'band'; })[0].own, true);
  eq('dayTimelineItems: 予定が1件も無い日でも、分岐のカードは出る',
    kinds(T.dayTimelineItems([], [], [{ id: 'brX', accountId: A, name: 'アリス', date: '2026-10-05', startTime: '10:00', endTime: '11:00' }], '', '2026-10-05')), ['card:brX']);

  eq('branchCardText: 予定の見出しを→でつなぐ', T.branchCardText(branches[0], bb), 'アリス：14:00〜17:00 別行動（美術館→カフェ→帰り道の寄り道）');
  eq('branchCardText: タイトルがあればそれを使う', T.branchCardText(branches[1], bb), 'ボブ：15:00〜16:00 別行動（釣り）');
  eq('branchCardText: 予定が無くタイトルも無ければ括弧なし', T.branchCardText({ id: 'z', name: 'ボブ', startTime: '09:00', endTime: '10:00' }, []), 'ボブ：09:00〜10:00 別行動');
  eq('branchCardText: 名前が無いときは「だれか」', T.branchCardText({ id: 'z', name: '', startTime: '09:00', endTime: '10:00', title: 'x' }, []), 'だれか：09:00〜10:00 別行動（x）');
  eq('branchCardText: 予定が多いときは3つまで＋…', T.branchCardText({ id: 'br9', name: 'あ', startTime: '09:00', endTime: '20:00' },
    ['一', '二', '三', '四'].map(function (l, i) { return { id: 'q' + i, branchId: 'br9', date: '2026-10-01', time: '1' + i + ':00', label: l }; })),
    'あ：09:00〜20:00 別行動（一→二→三…）');

  // 入力チェック（サーバー worker/src/branches.js と同じ規則）
  eq('validateBranch: 正しい入力', T.validateBranch({ date: '2026-10-01', startTime: '09:00', endTime: '10:00' }, [], A), '');
  eq('validateBranch: 終わりが始まり以前', T.validateBranch({ date: '2026-10-01', startTime: '10:00', endTime: '10:00' }, [], A), 'end_before_start');
  eq('validateBranch: 時刻が空', T.validateBranch({ date: '2026-10-01', startTime: '', endTime: '10:00' }, [], A), 'invalid_time');
  eq('validateBranch: 自分の分岐と重なる', T.validateBranch({ date: '2026-10-01', startTime: '16:00', endTime: '18:00' }, branches, A), 'overlap');
  eq('validateBranch: 他の人の分岐とは重なってよい', T.validateBranch({ date: '2026-10-01', startTime: '15:00', endTime: '15:30' }, [branches[1]], A), '');
  eq('validateBranch: 隣り合うだけならよい', T.validateBranch({ date: '2026-10-01', startTime: '17:00', endTime: '18:00' }, branches, A), '');
  eq('validateBranch: 自分自身は除く', T.validateBranch({ date: '2026-10-01', startTime: '13:00', endTime: '17:30' }, branches, A, 'br1'), '');
  eq('branchErrorText: overlapは日本語の案内', /重なって/.test(T.branchErrorText('overlap')), true);
  eq('branchErrorText: 知らない理由でも空にならない', T.branchErrorText('mystery').length > 0, true);

  // 地図でふりかえる・動画：選んだ人の道の予定で再生地点を作る
  (function () {
    var trip2 = { startDate: '2026-10-01', endDate: '2026-10-01' };
    var mk = function (id, time, label, url, branchId) {
      return { id: id, date: '2026-10-01', time: time, label: label, category: 'sightseeing', createdAt: id, branchId: branchId || '',
        entries: [{ id: 'e' + id, mapUrl: url, episode: label + 'の話', photoIds: [], costItems: [] }] };
    };
    var sh = [mk('s1', '09:00', '朝', 'https://maps.app.goo.gl/a'), mk('s2', '14:00', '海', 'https://maps.app.goo.gl/b'), mk('s4', '18:00', '夕食', 'https://maps.app.goo.gl/c')];
    var bk = [mk('b1', '14:30', '美術館', 'https://maps.app.goo.gl/d', 'br1')];
    var brs = [{ id: 'br1', accountId: 'A', name: 'a', date: '2026-10-01', startTime: '14:00', endTime: '17:00' }];
    var stopIds = function (v) { return T.replayStops(trip2, T.visibleBlocksForView(sh, bk, brs, v)).map(function (s) { return s.blockId; }); };
    eq('replayStops: みんなの道は今までどおり', stopIds(''), ['s1', 's2', 's4']);
    eq('replayStops: 人の道では、別行動の時間帯がその人の予定の地点になる', stopIds('A'), ['s1', 'b1', 's4']);
  })();

  // ---- 日をまたぐ別行動（6/27 14:00〜6/28 12:00） ----
  (function () {
    var C = 'ccc';
    var sh = [
      { id: 'm1', date: '2026-06-27', time: '10:00', label: '朝', category: 'other', createdAt: '1', entries: [], branchId: '' },
      { id: 'm2', date: '2026-06-27', time: '15:00', label: '午後', category: 'other', createdAt: '2', entries: [], branchId: '' },
      { id: 'm3', date: '2026-06-28', time: '08:00', label: '朝食', category: 'food', createdAt: '3', entries: [], branchId: '' },
      { id: 'm4', date: '2026-06-28', time: '11:59', label: '出発前', category: 'other', createdAt: '4', entries: [], branchId: '' },
      { id: 'm5', date: '2026-06-28', time: '12:00', label: '合流', category: 'other', createdAt: '5', entries: [], branchId: '' },
      { id: 'm6', date: '2026-06-28', time: '', label: 'メモ', category: 'other', createdAt: '6', entries: [], branchId: '' },
      { id: 'm7', date: '2026-06-29', time: '09:00', label: '3日目', category: 'other', createdAt: '7', entries: [], branchId: '' }
    ];
    var br = { id: 'bm', accountId: C, name: 'ひろや', date: '2026-06-27', endDate: '2026-06-28', startTime: '14:00', endTime: '12:00', title: '' };
    var brSingle = { id: 'bs', accountId: A, name: 'アリス', date: '2026-06-29', startTime: '08:00', endTime: '10:00', title: '' };
    var bk = [
      { id: 'x1', date: '2026-06-27', time: '16:00', label: '温泉', category: 'other', createdAt: '20', entries: [], branchId: 'bm' },
      { id: 'x2', date: '2026-06-28', time: '07:00', label: '朝市', category: 'food', createdAt: '21', entries: [], branchId: 'bm' },
      { id: 'x3', date: '2026-06-28', time: '', label: '土産', category: 'other', createdAt: '22', entries: [], branchId: 'bm' }
    ];
    var ids2 = function (list) { return list.map(function (b) { return b.id; }); };
    var kinds2 = function (items) {
      return items.map(function (it) { return it.type === 'block' ? it.block.id : it.type + (it.continued ? '*' : '') + ':' + it.branch.id; });
    };

    eq('branchEndDate: 空なら開始日', [T.branchEndDate(brSingle), T.branchEndDate(br)], ['2026-06-29', '2026-06-28']);
    eq('isMultiDayBranch', [T.isMultiDayBranch(brSingle), T.isMultiDayBranch(br), T.isMultiDayBranch(Object.assign({}, brSingle, { endDate: '2026-06-29' }))], [false, true, false]);
    eq('branchDates: 日をまたぐと始まり〜終わりの日', T.branchDates(br), ['2026-06-27', '2026-06-28']);
    eq('branchDates: 3日', T.branchDates({ date: '2026-06-30', endDate: '2026-07-02' }), ['2026-06-30', '2026-07-01', '2026-07-02']);
    eq('branchDates: 1日', T.branchDates(brSingle), ['2026-06-29']);
    eq('branchWindowOn: 始まりの日は開始から', T.branchWindowOn(br, '2026-06-27'), { start: 840, end: 1440 });
    eq('branchWindowOn: 終わりの日は終了まで', T.branchWindowOn(br, '2026-06-28'), { start: 0, end: 720 });
    eq('branchWindowOn: 途中の日は1日中', T.branchWindowOn({ date: '2026-06-27', endDate: '2026-06-29', startTime: '14:00', endTime: '12:00' }, '2026-06-28'), { start: 0, end: 1440 });
    eq('branchWindowOn: かかっていない日はnull', [T.branchWindowOn(br, '2026-06-26'), T.branchWindowOn(br, '2026-06-29')], [null, null]);

    eq('blocksInBranchWindow: 日またぎ：始まりの日は開始後、終わりの日は終了前（12:00ちょうどは含まない）・時刻なしは入れない',
      ids2(T.blocksInBranchWindow(sh, br)), ['m2', 'm3', 'm4']);
    eq('visibleBlocksForView: 日またぎの人の道：各日の窓の中のみんなの予定が外れ、その人の予定が入る',
      ids2(T.visibleBlocksForView(sh, bk, [br], C)).sort(), ['m1', 'm5', 'm6', 'm7', 'x1', 'x2', 'x3']);
    eq('visibleBlocksForView: 別の人の道は変わらない', ids2(T.visibleBlocksForView(sh, bk, [br], A)), ids2(sh));
    eq('visibleBlocksForView: みんなの道は今までどおり', ids2(T.visibleBlocksForView(sh, bk, [br], '')), ids2(sh));

    // タイムライン
    eq('dayTimelineItems: みんなの表示・始まりの日はカード（開始の位置）',
      kinds2(T.dayTimelineItems(sh, bk, [br], '', '2026-06-27')), ['m1', 'card:bm', 'm2']);
    eq('dayTimelineItems: みんなの表示・2日目はその日の先頭に「別行動中」カード',
      kinds2(T.dayTimelineItems(sh, bk, [br], '', '2026-06-28')), ['card*:bm', 'm3', 'm4', 'm5', 'm6']);
    eq('dayTimelineItems: みんなの表示・分岐がかからない日は出ない', kinds2(T.dayTimelineItems(sh, bk, [br], '', '2026-06-29')), ['m7']);
    eq('dayTimelineItems: その人の道・始まりの日は開始からその人の予定に置き換わる',
      kinds2(T.dayTimelineItems(sh, bk, [br], C, '2026-06-27')), ['m1', 'band:bm', 'x1']);
    eq('dayTimelineItems: その人の道・2日目は先頭の帯（時刻なしの予定が続く）、終了前のみんなの予定は外れ、終了後は残る',
      kinds2(T.dayTimelineItems(sh, bk, [br], C, '2026-06-28')), ['band*:bm', 'x3', 'x2', 'm5', 'm6']);
    eq('dayTimelineItems: 別の人の道では、日またぎはカードのまま',
      kinds2(T.dayTimelineItems(sh, bk, [br], A, '2026-06-28')), ['card*:bm', 'm3', 'm4', 'm5', 'm6']);
    eq('dayTimelineItems: 1日の分岐は今までどおり（continuedなし）',
      kinds2(T.dayTimelineItems(sh, [], [brSingle], '', '2026-06-29')), ['card:bs', 'm7']);
    eq('dayTimelineItems: 帯のcontinued・own', (function () {
      var b = T.dayTimelineItems(sh, bk, [br], C, '2026-06-28')[0];
      return [b.type, b.continued, b.own];
    })(), ['band', true, true]);

    // 文言
    eq('branchRangeText: 1日は時刻だけ', T.branchRangeText(brSingle), '08:00〜10:00');
    eq('branchRangeText: 日またぎは月/日つき', T.branchRangeText(br), '6/27 14:00〜6/28 12:00');
    eq('branchCardText: 日またぎの開始日のカード（予定なし）', T.branchCardText(br, []), 'ひろや：6/27 14:00〜6/28 12:00 別行動');
    eq('branchCardText: 日またぎ＋予定の見出し', T.branchCardText(br, bk), 'ひろや：6/27 14:00〜6/28 12:00 別行動（温泉→朝市→土産）');
    eq('branchContinuedText: 2日目以降の小さなカード', T.branchContinuedText(br), 'ひろや：別行動中（〜6/28 12:00）');
    eq('branchUntilText', T.branchUntilText(br), '〜6/28 12:00');

    // 入力チェック（サーバーと同じ規則）
    var vb = function (o, others, exclude, trip) { return T.validateBranch(o, others || [], C, exclude, trip); };
    eq('validateBranch: 日またぎ（終わり時刻が前でも、終わりの日が後ならOK）', vb({ date: '2026-06-27', endDate: '2026-06-28', startTime: '14:00', endTime: '12:00' }), '');
    eq('validateBranch: 終わりの日が始まりより前', vb({ date: '2026-06-28', endDate: '2026-06-27', startTime: '09:00', endTime: '10:00' }), 'end_before_start');
    eq('validateBranch: 同じ日で終わり<始まり', vb({ date: '2026-06-27', endDate: '2026-06-27', startTime: '14:00', endTime: '12:00' }), 'end_before_start');
    eq('validateBranch: endDate省略は1日', vb({ date: '2026-06-27', startTime: '09:00', endTime: '10:00' }), '');
    eq('validateBranch: 日またぎと重なる（途中の日）', vb({ date: '2026-06-28', startTime: '01:00', endTime: '02:00' }, [br]), 'overlap');
    eq('validateBranch: 日またぎの終了ちょうどから始めるのはOK', vb({ date: '2026-06-28', startTime: '12:00', endTime: '13:00' }, [br]), '');
    eq('validateBranch: 日またぎ自身は除く', vb({ date: '2026-06-27', endDate: '2026-06-28', startTime: '13:00', endTime: '12:00' }, [br], 'bm'), '');
    eq('validateBranch: 別の人の日またぎとは重なってよい', T.validateBranch({ date: '2026-06-28', startTime: '01:00', endTime: '02:00' }, [br], A), '');
    eq('validateBranch: 旅行の日程の外（終わりの日）', vb({ date: '2026-06-27', endDate: '2026-06-29', startTime: '14:00', endTime: '12:00' }, [], undefined, { startDate: '2026-06-27', endDate: '2026-06-28' }), 'date_out_of_range');
    eq('validateBranch: 旅行の日程の中', vb({ date: '2026-06-27', endDate: '2026-06-28', startTime: '14:00', endTime: '12:00' }, [], undefined, { startDate: '2026-06-27', endDate: '2026-06-28' }), '');
    eq('validateBranch: 日程が空の旅行は範囲を見ない', vb({ date: '2026-06-27', endDate: '2026-06-29', startTime: '14:00', endTime: '12:00' }, [], undefined, { startDate: '', endDate: '' }), '');
    eq('branchErrorText: 日またぎ関連の案内', ['date_out_of_range', 'date_out_of_branch', 'time_out_of_branch', 'branch_multiday_not_ready'].every(function (k) { return T.branchErrorText(k).indexOf('保存に失敗') < 0; }), true);

    // 別行動の中の予定の置き場所（サーバーと同じ規則）
    eq('validateBranchBlock: 始まりの日の開始前はNG・開始ちょうどはOK', [T.validateBranchBlock(br, '2026-06-27', '13:59'), T.validateBranchBlock(br, '2026-06-27', '14:00')], ['time_out_of_branch', '']);
    eq('validateBranchBlock: 終わりの日の終了ちょうどはOK・後はNG', [T.validateBranchBlock(br, '2026-06-28', '12:00'), T.validateBranchBlock(br, '2026-06-28', '12:01')], ['', 'time_out_of_branch']);
    eq('validateBranchBlock: 範囲外の日・時刻なし', [T.validateBranchBlock(br, '2026-06-29', '10:00'), T.validateBranchBlock(br, '2026-06-26', ''), T.validateBranchBlock(br, '2026-06-28', '')], ['date_out_of_branch', 'date_out_of_branch', '']);

    // 地図でふりかえる・動画：日をまたぐ窓に従う
    var trip3 = { startDate: '2026-06-27', endDate: '2026-06-29' };
    var geo = function (b) { b.entries = [{ id: 'e' + b.id, mapUrl: 'https://maps.app.goo.gl/' + b.id, episode: b.label + 'の話', photoIds: [], costItems: [] }]; return b; };
    var shG = sh.map(function (b) { return geo(Object.assign({}, b)); }), bkG = bk.map(function (b) { return geo(Object.assign({}, b)); });
    var stopIds2 = function (v) { return T.replayStops(trip3, T.visibleBlocksForView(shG, bkG, [br], v)).map(function (s) { return s.blockId; }); };
    eq('replayStops: みんなの道は今までどおり', stopIds2('').filter(function (i) { return i !== 'm6'; }), ['m1', 'm2', 'm3', 'm4', 'm5', 'm7']);
    eq('replayStops: 日またぎの人の道は2日にわたってその人の予定になる', stopIds2(C).filter(function (i) { return i !== 'm6' && i !== 'x3'; }), ['m1', 'x1', 'x2', 'm5', 'm7']);
  })();

  // 費用：分岐の予定も精算・合計に入る（みんなの予定と同じ式）
  var costed = [
    { id: 'c1', date: '2026-10-01', entries: [{ costItems: [{ label: 'ランチ', amount: 1000 }] }], branchId: '' },
    { id: 'c2', date: '2026-10-01', entries: [{ costItems: [{ label: '入館料', amount: 500 }] }], branchId: 'br1' }
  ];
  eq('分岐の予定の費用も合計に入る（合わせて渡したとき）', T.tripTotalCost(costed), 1500);
})();

/* ---- 動画でシェア：カメラは「地図でふりかえる」と同じ規則（Leaflet の fitBounds／flyTo と同じ計算。2026-09-30） ---- */
(function () {
  function near(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); }
  var PAD = { top: 230, right: 80, bottom: 420, left: 80 };
  // cameraFitView（Leafletの_getBoundsCenterZoomと同じ）
  eq('cameraFitView: 点が1つだけなら上限の縮尺', T.cameraFitView([[47.37, 8.54]], 720, 1280, PAD, { maxZoom: 13 }).zoom, 13);
  eq('cameraFitView: 点が無ければ下限', T.cameraFitView([], 720, 1280, PAD, { minZoom: 2 }).zoom, 2);
  var zf = T.cameraFitView([[47.0, 8.0], [46.0, 9.5]], 720, 1280, PAD, { maxZoom: 15 });
  ok('cameraFitView: 縮尺は整数刻み（Leafletのzoomsnap=1）', zf.zoom === Math.floor(zf.zoom));
  var zc = T.cameraFitView([[47.0, 8.0], [46.0, 9.5]], 720, 1280, PAD, { maxZoom: 15, snap: 0 });
  ok('cameraFitView: 刻まなければ連続。刻んだ縮尺はそれ以下で、1段未満しか違わない', zc.zoom >= zf.zoom && zc.zoom - zf.zoom < 1);
  ok('cameraFitView: 刻んだ縮尺でも、点は余白の内側に収まる', [[47.0, 8.0], [46.0, 9.5]].every(function (p) {
    var q = T.videoProject(zf, 720, 1280, p[0], p[1]);
    return q.x >= 80 - 1e-6 && q.x <= 640 + 1e-6 && q.y >= 230 - 1e-6 && q.y <= 860 + 1e-6;
  }));
  ok('cameraFitView: 刻まないときは videoFitView と同じ', (function () {
    var a = T.cameraFitView([[47.0, 8.0], [46.0, 9.5]], 720, 1280, PAD, { minZoom: 2, maxZoom: 15, snap: 0 }), b = T.videoFitView([[47.0, 8.0], [46.0, 9.5]], 720, 1280, PAD, 2, 15);
    return near(a.x, b.x) && near(a.y, b.y) && near(a.zoom, b.zoom);
  })());
  eq('cameraFitView: 上限より寄らない', T.cameraFitView([[47.0, 8.0], [47.001, 8.001]], 720, 1280, PAD, { maxZoom: 15 }).zoom, 15);
  eq('cameraFitView: 世界規模でも下限より引かない', T.cameraFitView([[-60, -170], [60, 170]], 720, 1280, PAD, { minZoom: 2, maxZoom: 15 }).zoom, 2);
  ok('cameraFitView: 1点は余白を除いた領域の真ん中に来る', (function () {
    var v = T.cameraFitView([[47.37, 8.54]], 720, 1280, PAD, { maxZoom: 13 }), q = T.videoProject(v, 720, 1280, 47.37, 8.54);
    return near(q.x, 360, 0.01) && near(q.y, 230 + (1280 - 230 - 420) / 2, 0.01);
  })());
  // ふりかえりの画面（幅390・高さ800）と余白でも、点が余白の内側に入る
  ok('cameraFitView: 画面の大きさ・余白が違っても収まる（ふりかえりの画面）', (function () {
    var pad2 = { left: 36, top: 110, right: 36, bottom: 200 }, pts2 = [[35.68, 139.76], [34.7, 135.5]];
    var v = T.cameraFitView(pts2, 390, 800, pad2, { maxZoom: 15 });
    return pts2.every(function (p) { var q = T.videoProject(v, 390, 800, p[0], p[1]); return q.x >= 36 - 1e-6 && q.x <= 354 + 1e-6 && q.y >= 110 - 1e-6 && q.y <= 600 + 1e-6; });
  })());
  // cameraFlyAt（Leafletのflyto）
  var A = { x: 0.5, y: 0.3, zoom: 12 }, B = { x: 0.5004, y: 0.3002, zoom: 12 }, FAR = { x: 0.9, y: 0.4, zoom: 12 };
  eq('cameraFlyAt: 始まりは出発の見え方、終わりは目的地', [T.cameraFlyAt(A, FAR, 0, 1280), T.cameraFlyAt(A, FAR, 1, 1280)], [{ x: 0.5, y: 0.3, zoom: 12 }, { x: 0.9, y: 0.4, zoom: 12 }]);
  ok('cameraFlyAt: 終わりのすぐ手前は目的地にほぼ一致（式が正しく閉じる）', [[A, B], [A, FAR], [{ x: 0.5, y: 0.3, zoom: 3 }, { x: 0.52, y: 0.31, zoom: 12 }], [{ x: 0.5, y: 0.3, zoom: 12 }, { x: 0.5, y: 0.3, zoom: 4 }]].every(function (p) {
    var c = T.cameraFlyAt(p[0], p[1], 0.9999, 1280);
    return near(c.x, p[1].x, 1e-4) && near(c.y, p[1].y, 1e-4) && near(c.zoom, p[1].zoom, 0.02);
  }));
  ok('cameraFlyAt: 遠くへ同じ縮尺で移るときは、いったん引いてから寄る', (function () {
    var minZ = 99;
    for (var u = 0.02; u < 1; u += 0.02) minZ = Math.min(minZ, T.cameraFlyAt(A, FAR, u, 1280).zoom);
    return minZ < 12 - 2;
  })());
  ok('cameraFlyAt: 近くへ移るときは（ほとんど）引かない', (function () {
    var minZ = 99;
    for (var u = 0.02; u < 1; u += 0.02) minZ = Math.min(minZ, T.cameraFlyAt(A, B, u, 1280).zoom);
    return minZ > 11.5;
  })());
  ok('cameraFlyAt: 引いた見え方から同じ場所へ寄るときは、縮尺が増えるだけ（行き過ぎない）', (function () {
    var last = 2, from = { x: 0.5, y: 0.3, zoom: 2 }, to = { x: 0.5, y: 0.3, zoom: 12 };
    for (var u = 0.02; u <= 1; u += 0.02) { var z = T.cameraFlyAt(from, to, u, 1280).zoom; if (z < last - 1e-9 || z > 12 + 1e-9) return false; last = z; }
    return true;
  })());
  ok('cameraFlyAt: 中心は目的地へ向かって進む（行き過ぎない）', (function () {
    var last = 0.5;
    for (var u = 0.02; u <= 1; u += 0.02) { var x = T.cameraFlyAt(A, FAR, u, 1280).x; if (x < last - 1e-9 || x > 0.9 + 1e-9) return false; last = x; }
    return true;
  })());
  eq('cameraFlyAt: 出発と目的地が同じなら動かない', T.cameraFlyAt(A, A, 0.5, 1280), { x: 0.5, y: 0.3, zoom: 12 });

  // 動画のカメラ：スイス・ベルギー旅行に似た合成データ（8日）
  function stop(label, lat, lng, day, minute, extra) {
    return Object.assign({ label: label, lat: lat, lng: lng, located: true, dayNumber: day, minute: minute, photos: [], captions: [] }, extra || {});
  }
  var swiss = [
    stop('羽田空港出発', 35.55, 139.78, 1, 120), stop('仁川国際空港', 37.46, 126.44, 1, 300), stop('チューリッヒ空港', 47.46, 8.55, 1, 840),
    stop('チューリッヒ駅', 47.378, 8.54, 1, 960), stop('ルツェルン', 47.05, 8.31, 1, 1080), stop('グリンデルヴァルトのホテル', 46.62, 8.04, 1, 1260),
    stop('ユングフラウヨッホ', 46.548, 7.985, 2, 540), stop('チーズフォンデュ', 46.626, 8.033, 2, 1080), stop('ツェルマットへの移動', 46.63, 8.03, 2, 1200),
    stop('ツェルマット駅', 46.02, 7.747, 2, 1320), stop('日本人橋', 46.03, 7.75, 3, 540), stop('マッターホルン周辺', 46.0, 7.74, 3, 720),
    stop('リッフェルホテル', 45.999, 7.77, 3, 1020), stop('ツェルマット下山', 46.02, 7.747, 4, 600), stop('ジュネーブ駅', 46.21, 6.142, 4, 900),
    stop('ジュネーブ市内', 46.2, 6.15, 5, 600), stop('ジュネーブ空港', 46.238, 6.109, 5, 900), stop('ブリュッセル', 50.845, 4.36, 7, 600),
    stop('上海', 31.14, 121.8, 8, 600)
  ];
  var swissTl = { stops: swiss, keyframes: [{ t: 0, r: 0 }], totalReal: 10, legs: [] };
  for (var si = 1; si < swiss.length; si++) {
    var sa = swiss[si - 1], sb = swiss[si], far = T.distanceKm(sa, sb) > 500;
    swissTl.legs.push({ from: si - 1, to: si, transport: far ? 'plane' : 'rail', path: [[sa.lat, sa.lng], [sb.lat, sb.lng]] });
  }
  var sw = T.buildVideoStory(swissTl, { photos: false });
  var swMoves = sw.cameraMoves;
  ok('動画のカメラ: 最初は最初の地点を縮尺13で', near(sw.cameraStart.zoom, 13) && (function () {
    var q = T.videoProject(sw.cameraStart, 720, 1280, 35.55, 139.78); return near(q.x, 360, 0.5);
  })());
  ok('動画のカメラ: 動きは時刻順で重ならず、動画の外へはみ出さない', swMoves.length > 0 && swMoves.every(function (m, i) {
    return m.dur >= 0.3 - 1e-9 && m.dur <= 0.8 + 1e-9 && m.t >= -1e-9 && m.t + m.dur <= sw.total + 1e-9 && (i === 0 || m.t >= swMoves[i - 1].t + swMoves[i - 1].dur - 1e-9);
  }));
  ok('動画のカメラ: 止まっているときの縮尺は整数（最後の全体は除く。世界規模は下限2.33）で、2.33〜15以内', swMoves.slice(0, -1).every(function (m) { return (m.to.zoom === Math.round(m.to.zoom) || near(m.to.zoom, 2.33)) && m.to.zoom <= 15 && m.to.zoom >= 2.33 - 1e-9; }));
  ok('動画のカメラ: 世界規模まで引いても、地図の外（上下）は映らない', (function () {
    for (var t = 0; t <= sw.total; t += 0.05) {
      var c = T.videoCameraAt(sw, t), half = 640 / T.videoWorldScale(c.zoom);
      if (c.y - half < -1e-9 || c.y + half > 1 + 1e-9) return false;
    }
    return true;
  })());
  ok('動画のカメラ: 飛行機の区間は、その区間が入るだけ引く（世界まで引かない）', (function () {
    var c = T.videoCameraAt(sw, sw.introSec + sw.segs[1].moveStart + 0.05); // 仁川→チューリッヒ（約8,800km）
    return c.zoom >= 2 && c.zoom <= 3;
  })());
  ok('動画のカメラ: 羽田→仁川（約1,200km）は仁川→チューリッヒより寄る', (function () {
    var c1 = T.videoCameraAt(sw, sw.introSec + sw.segs[0].moveStart + 0.05), c2 = T.videoCameraAt(sw, sw.introSec + sw.segs[1].moveStart + 0.05);
    return c1.zoom > c2.zoom;
  })());
  ok('動画のカメラ: 飛行機で引いたあと、着いた地点へ12まで寄せ直す', (function () {
    var c = T.videoCameraAt(sw, sw.introSec + sw.wps[2].arrive + 1.0 + 0.05); // チューリッヒ空港に着いて、寄せ直し（0.2秒後から0.8秒）が終わったころ
    return c.zoom >= 12 - 0.05;
  })());
  ok('動画のカメラ: 区間の動き出しには、その区間の両端が余白の内側に入っている（近い区間は、まとめた見え方の中）', sw.segs.every(function (sg, k) {
    var c = T.videoCameraAt(sw, sw.introSec + sg.moveStart + 0.05);
    return [sw.wps[k], sw.wps[k + 1]].every(function (w) {
      var q = T.videoProject(c, 720, 1280, w.lat, w.lng);
      return q.x >= 80 - 1 && q.x <= 640 + 1 && q.y >= 230 - 1 && q.y <= 860 + 1;
    }) || T.distanceKm(sw.wps[k], sw.wps[k + 1]) < 60;
  }));
  ok('動画のカメラ: 着いた地点へ寄せ直す間は、吹き出しを出さない（落ち着いてから）', sw.wps.every(function (w) {
    return !w.caption || typeof w.capStart !== 'number' || (w.capStart >= w.arrive - 1e-9 && w.capStart <= w.capEnd - 0.6 + 1e-9);
  }));
  ok('動画のカメラ: 最後は全体に引く', (function () {
    var c = T.videoCameraAt(sw, sw.total);
    return near(c.zoom, sw.overview.zoom, 1e-6) && near(c.x, sw.overview.x, 1e-6);
  })());
  ok('動画のカメラ: 全期間の縮尺が2.33〜15に収まる', (function () {
    for (var t = 0; t <= sw.total; t += 0.05) { var c = T.videoCameraAt(sw, t); if (!(c.zoom >= 2.33 - 1e-9 && c.zoom <= 15 + 1e-9)) return false; }
    return true;
  })());
  // 寄る上限を下げたとき（タイルが多すぎるとき）は、全体を引くのではなく上限だけが下がる
  var sw12 = T.buildVideoStory(swissTl, { photos: false, maxZoom: 12 });
  ok('動画のカメラ: maxZoomを下げると、止まっているときの縮尺の上限だけが下がる（広い区間はそのまま）', sw12.cameraMoves.slice(0, -1).every(function (m) { return m.to.zoom <= 12; }) &&
    T.videoCameraAt(sw12, sw12.introSec + sw12.segs[1].moveStart + 0.05).zoom === T.videoCameraAt(sw, sw.introSec + sw.segs[1].moveStart + 0.05).zoom);
  // タイル
  var swTiles = T.videoTilesNeeded(sw), swTiles12 = T.videoTilesNeeded(sw12);
  ok('動画のタイル: 8日・19地点のスイス・ベルギー旅行でも上限（' + T.videoTileLimit(sw.total) + '枚）に収まる', swTiles.length > 0 && swTiles.length <= T.videoTileLimit(sw.total));
  ok('動画のタイル: 寄る上限を下げるとタイルが減る', swTiles12.length < swTiles.length);
  ok('動画のタイル: 拡大縮小は0.7〜2倍に収まる', (function () {
    for (var t = 0; t <= sw.total; t += 0.03) {
      var c = T.videoCameraAt(sw, t), vt = T.videoViewTiles(c, 720, 1280);
      if (vt.size / 256 > 2 + 1e-6 || vt.size / 256 < 0.7 - 1e-6) return false;
    }
    return true;
  })());
  ok('動画のタイル: 30fpsのどのコマも、必要なタイルは集めたタイルに含まれる', (function () {
    var have = {}; swTiles.forEach(function (t) { have[t.z + '/' + t.x + '/' + t.y] = 1; });
    for (var t = 0; t <= sw.total; t += 1 / 30) {
      var vt = T.videoViewTiles(T.videoCameraAt(sw, t), 720, 1280);
      if (!vt.list.every(function (q) { return have[vt.z + '/' + q.x + '/' + q.y]; })) return false;
    }
    return true;
  })());
  eq('videoViewTiles: 動いている間（fly）は縮尺を切り捨て、止まっているときは四捨五入', [T.videoViewTiles({ x: 0.5, y: 0.5, zoom: 7.9, fly: true }, 720, 1280).z, T.videoViewTiles({ x: 0.5, y: 0.5, zoom: 7.9 }, 720, 1280).z], [7, 8]);
  ok('videoViewTiles: 余白を付けるとタイルが増える', T.videoViewTiles({ x: 0.5, y: 0.5, zoom: 8 }, 720, 1280, 200).list.length > T.videoViewTiles({ x: 0.5, y: 0.5, zoom: 8 }, 720, 1280).list.length);
  // 動画に出さない地点：着いた地点へ寄せ直さない（引いたまま。その場所を映さない）
  var swHidden = swiss.map(function (s, i) { return i === 2 ? Object.assign({}, s, { videoExclude: true }) : s; });
  var swH = T.buildVideoStory({ stops: swHidden, keyframes: [{ t: 0, r: 0 }], totalReal: 10, legs: swissTl.legs }, {});
  var onHidden = function (st) {
    return st.cameraMoves.filter(function (m) { var q = T.videoProject(m.to, 720, 1280, 47.46, 8.55); return m.to.zoom >= 12 && Math.abs(q.x - 360) < 1 && Math.abs(q.y - 545) < 1; }).length;
  };
  eq('動画のカメラ: 動画に出さない地点へは寄せ直さない（出す地点ならチューリッヒ空港へ寄せ直す）', [onHidden(sw), onHidden(swH)], [1, 0]);
  // ふりかえりと共有する値
  eq('ふりかえりと動画で共有するカメラの値', [T.REPLAY_CAMERA_LEAD_SEC, T.REPLAY_TINY_LEG_KM, T.REPLAY_LEG_MAX_ZOOM, T.REPLAY_ZOOMED_OUT, T.REPLAY_ARRIVAL_MIN_ZOOM, T.REPLAY_START_ZOOM], [0.9, 0.4, 15, 10, 12, 13]);
})();

/* ---- 日程の外の日付の候補（docs/adr/0022 2026-09-30追記） ---- */
(function () {
  var trip = { startDate: '2024-12-11', endDate: '2024-12-13' };
  var choices = ['2024-12-11', '2024-12-12', '2024-12-13'];
  var item = function (date, extra) { return Object.assign({ date: date, label: 'x' }, extra || {}); };
  var may = [item('2024-05-16'), item('2024-05-17'), item('2024-05-18')];

  eq('proposalDateStatus: 全部外', (function () { var s = T.proposalDateStatus(may, choices); return [s.outside, s.inside, s.min, s.max]; })(), [3, 0, '2024-05-16', '2024-05-18']);
  eq('proposalDateStatus: 一部だけ外', (function () { var s = T.proposalDateStatus([item('2024-12-12'), item('2024-12-14')], choices); return [s.outside, s.inside]; })(), [1, 1]);
  eq('proposalDateStatus: use===falseの候補は数えない', T.proposalDateStatus([item('2024-05-16', { use: false })], choices).outside, 0);
  eq('proposalDateStatus: 選べる日が無い（日程未設定）なら外は無し', T.proposalDateStatus(may, []).outside, 0);

  var replace = T.planTripRangeFit(may, trip, false);
  eq('planTripRangeFit: 全部外で予定が無ければ置き換え', [replace.mode, replace.startDate, replace.endDate, replace.days, replace.oldDays], ['replace', '2024-05-16', '2024-05-18', 3, 3]);
  var extendBlocks = T.planTripRangeFit(may, trip, true);
  eq('planTripRangeFit: 全部外でも今の予定があれば広げる（今の予定を見えなくしない）', [extendBlocks.mode, extendBlocks.startDate, extendBlocks.endDate], ['extend', '2024-05-16', '2024-12-13']);
  var extendSome = T.planTripRangeFit([item('2024-12-12'), item('2024-12-15')], trip, false);
  eq('planTripRangeFit: 一部だけ外なら両方を含むよう広げる（後ろ）', [extendSome.mode, extendSome.startDate, extendSome.endDate, extendSome.days], ['extend', '2024-12-11', '2024-12-15', 5]);
  eq('planTripRangeFit: 前にはみ出す場合も広げる', (function () { var p = T.planTripRangeFit([item('2024-12-12'), item('2024-12-09')], trip, false); return [p.startDate, p.endDate]; })(), ['2024-12-09', '2024-12-13']);
  eq('planTripRangeFit: 全部日程の中ならnull', T.planTripRangeFit([item('2024-12-12')], trip, false), null);
  eq('planTripRangeFit: 旅行に日程が無ければnull', T.planTripRangeFit(may, { startDate: '', endDate: '' }, false), null);
  eq('planTripRangeFit: 終了日が無い旅行は開始日だけの1日として扱う', T.planTripRangeFit([item('2024-12-12')], { startDate: '2024-12-11', endDate: '' }, false).endDate, '2024-12-12');

  var sh = T.planProposalShift(may, choices);
  eq('planProposalShift: 最初の予定を旅行の1日目に（日数・重なりなし）', [sh.days, sh.from, sh.to, sh.overflow, sh.newMax], [209, '2024-05-16', '2024-12-11', false, '2024-12-13']);
  eq('planProposalShift: 最後が日程の終わりを越えるならoverflow', (function () { var p = T.planProposalShift([item('2024-05-16'), item('2024-05-20')], choices); return [p.overflow, p.newMax]; })(), [true, '2024-12-15']);
  eq('planProposalShift: 日程の外が無ければnull', T.planProposalShift([item('2024-12-12')], choices), null);
  eq('planProposalShift: 前へずらす（負の日数）', T.planProposalShift([item('2025-03-01')], choices).days, -80);
  var moved = T.shiftProposalDates([item('2024-01-30', { arriveDate: '2024-01-31' }), item('2024-02-28'), item('2024-03-01'), item('')], 2);
  eq('shiftProposalDates: 月またぎ・うるう年（2月29日あり）を日付として計算する', moved.map(function (x) { return x.date; }), ['2024-02-01', '2024-03-01', '2024-03-03', '']);
  eq('shiftProposalDates: arriveDateも同じだけずれる', moved[0].arriveDate, '2024-02-02');
  eq('shiftProposalDates: 年またぎ', T.shiftProposalDates([item('2024-12-30')], 5)[0].date, '2025-01-04');
  eq('shiftProposalDates: 負の日数', T.shiftProposalDates([item('2024-03-01')], -1)[0].date, '2024-02-29');
  var mayCopy = may.map(function (x) { return Object.assign({}, x); });
  T.shiftProposalDates(mayCopy, sh.days);
  eq('shift後は全部日程の中になる', T.proposalDateStatus(mayCopy, choices).outside, 0);

  // プロンプト：書かれた日付は日程の外でも変えない
  var prompt = T.buildAiImportPrompt(trip);
  ok('buildAiImportPrompt: 書かれた日付をそのまま使い、日程に合わせて変えないよう伝える', prompt.indexOf('書かれたとおりにdateへ入れ') !== -1 && prompt.indexOf('日程に合わせて変えてはいけません') !== -1);
  ok('buildAiImportPrompt: 日付が無い予定だけ旅行の日程の日を使う', prompt.indexOf('日付が書かれていない予定だけ') !== -1 && prompt.indexOf('2024-12-11が1日目') !== -1);
  ok('buildAiImportPrompt: 「日程のいずれか」と限る古い言い回しは無い', prompt.indexOf('のいずれか。') === -1 || prompt.indexOf('いずれかに') === -1);
})();

/* ---- 地図に図形が無い小さな国も大陸に入れる（2026-09-30：シンガポールが「その他」になっていた） ---- */
(function () {
  eq('alpha2ForCountryName: シンガポール→SG→アジア', [T.alpha2ForCountryName('シンガポール'), T.continentForAlpha2(T.alpha2ForCountryName('シンガポール'))], ['SG', 'アジア']);
  eq('alpha2ForCountryName: モルディブ・マルタも引ける', [T.continentForAlpha2(T.alpha2ForCountryName('モルディブ')), T.continentForAlpha2(T.alpha2ForCountryName('マルタ'))], ['アジア', 'ヨーロッパ']);
  eq('alpha2ForCountryName: 香港は決め打ちのまま', T.alpha2ForCountryName('香港'), 'HK');
  eq('alpha2ForCountryName: 知らない名前はnull', T.alpha2ForCountryName('存在しない国'), null);
})();

/* ---- 地図でふりかえる：区間の途中の時計は次の予定の時刻を超えない・逆戻りしない（2026-09-30。シンガポール旅の実データより） ---- */
(function () {
  // 最後の予定に着くまで（そのあとの滞在で時計が進むぶんは含めない）を細かく見る
  function sampleClock(tl) {
    var end = tl.stops[tl.stops.length - 1].r, out = [];
    for (var i = 0; i <= 400; i++) out.push(T.replayStateAt(tl, end * i / 400));
    return out;
  }
  function hhmmToMin(h) { var p = h.split(':'); return Number(p[0]) * 60 + Number(p[1]); }
  function nonDecreasing(a) { return a.every(function (c, i) { return i === 0 || c >= a[i - 1]; }); }
  var sgTrip = { startDate: '2026-05-16', endDate: '2026-05-18' };
  var sgBlocks = [
    { id: 'go', date: '2026-05-18', time: '11:15', category: 'transport', transport: 'car', moveMinutes: 50, label: 'チャンギ空港へ',
      entries: [{ mapUrl: 'https://x/mbs', travel: { to: 'チャンギ空港', arriveMapUrl: 'https://x/changi' } }] },
    { id: 'dep', date: '2026-05-18', time: '11:35', category: 'transport', transport: 'plane', label: 'シンガポール出発', entries: [{ mapUrl: 'https://x/changi' }] }
  ];
  var sgCoords = { 'https://x/mbs': { lat: 1.2834, lng: 103.8607 }, 'https://x/changi': { lat: 1.3644, lng: 103.9915 } };
  var sgStops = T.replayStops(sgTrip, sgBlocks);
  var arrive = sgStops.filter(function (s) { return s.arrival; })[0];
  ok('前提：見積もりの到着（11:15＋50分＝12:05）が、次の予定（11:35）より後になる', arrive && arrive.minute === 12 * 60 + 5);
  var sgTl = T.buildReplayTimeline(sgStops, sgCoords);
  var clocks = sampleClock(sgTl).map(function (s) { return hhmmToMin(s.hhmm); });
  ok('移動中の時計は11:35を超えない（以前は12:13まで進んでから11:35へ戻っていた）', Math.max.apply(null, clocks) <= 11 * 60 + 35);
  ok('移動中の時計は11:15から11:35まで進み、逆戻りしない', nonDecreasing(clocks) && clocks[0] <= 11 * 60 + 15);
  ok('出発の予定（11:35）に着いたときの時計はちょうど11:35', T.replayStateAt(sgTl, sgTl.stops[sgTl.stops.length - 1].r).hhmm === '11:35');
  var mid = sgTl.legs[0];
  var midClock = hhmmToMin(T.replayStateAt(sgTl, (mid.r0 + mid.r1) / 2).hhmm);
  ok('区間の半ばの時計は、出発と到着の時刻のあいだ（11:25〜11:35）', midClock >= 11 * 60 + 25 && midClock <= 11 * 60 + 35);

  // 同じ時刻の予定・時刻が前後した予定は、時計を止める（逆戻りさせない）
  var sameStops = T.replayStops({ startDate: '2026-05-17', endDate: '2026-05-17' }, [
    { id: 'w', date: '2026-05-17', time: '20:30', category: 'food', label: 'ウルフギャング', entries: [{ mapUrl: 'https://x/w' }] },
    { id: 'h', date: '2026-05-17', time: '20:30', category: 'lodging', transport: 'car', label: 'ホテル帰着', entries: [{ mapUrl: 'https://x/h' }] },
    { id: 'z', date: '2026-05-17', time: '20:10', category: 'other', transport: 'car', label: '時刻が前後した予定', entries: [{ mapUrl: 'https://x/z' }] },
    { id: 'y', date: '2026-05-17', time: '21:00', category: 'other', transport: 'car', label: '最後', entries: [{ mapUrl: 'https://x/y' }] }
  ]);
  var sameTl = T.buildReplayTimeline(sameStops, { 'https://x/w': { lat: 1.28, lng: 103.86 }, 'https://x/h': { lat: 1.29, lng: 103.86 }, 'https://x/z': { lat: 1.30, lng: 103.85 }, 'https://x/y': { lat: 1.31, lng: 103.84 } });
  ok('同じ時刻・前後した時刻の予定があっても、時計は逆戻りしない', nonDecreasing(sampleClock(sameTl).map(function (s) { return s.t; })));
  ok('タイムラインの時刻（stop.t）も逆戻りしない', nonDecreasing(sameTl.stops.map(function (s) { return s.t; })));

  // 日をまたぐ：23:30の移動（所要120分の見積もり）→翌日0:10の予定。時計は0時をまたいで進み、0:10を超えない
  var midnightStops = T.replayStops({ startDate: '2026-05-17', endDate: '2026-05-18' }, [
    { id: 'm1', date: '2026-05-17', time: '23:30', category: 'transport', transport: 'car', moveMinutes: 120, label: '深夜の移動', entries: [{ mapUrl: 'https://x/a', travel: { arriveMapUrl: 'https://x/b' } }] },
    { id: 'm2', date: '2026-05-18', time: '00:10', category: 'other', label: '到着後', entries: [{ mapUrl: 'https://x/b' }] }
  ]);
  var mnTl = T.buildReplayTimeline(midnightStops, { 'https://x/a': { lat: 1.28, lng: 103.86 }, 'https://x/b': { lat: 1.36, lng: 103.99 } });
  var mnT = sampleClock(mnTl).map(function (s) { return s.t; });
  ok('日またぎでも時計は逆戻りせず、次の予定（翌0:10）を超えない', nonDecreasing(mnT) && Math.max.apply(null, mnT) <= 1440 + 10);

  // 時差：出発地と到着地の時差が違っても、世界共通の時刻（t）は逆戻りしない
  var zoneStops = [
    { blockId: 'a', date: '2026-05-16', dayIndex: 0, dayNumber: 1, minute: 20 * 60, offset: 540, label: '出発', captions: [], photos: [], transport: '', query: 'q1' },
    { blockId: 'a#arrive', date: '2026-05-16', dayIndex: 0, dayNumber: 1, minute: 20 * 60 + 30, estimated: true, offset: 480, arrival: true, label: '到着', captions: [], photos: [], transport: 'car', query: 'q2' },
    { blockId: 'b', date: '2026-05-16', dayIndex: 0, dayNumber: 1, minute: 19 * 60 + 40, offset: 480, label: '現地の予定', captions: [], photos: [], transport: 'car', query: 'q3' }
  ];
  var zoneTl = T.buildReplayTimeline(zoneStops, { q1: { lat: 35, lng: 139 }, q2: { lat: 35.1, lng: 139.1 }, q3: { lat: 35.2, lng: 139.2 } });
  ok('時差があっても世界共通の時刻は逆戻りしない', nonDecreasing(sampleClock(zoneTl).map(function (s) { return s.t; })));
})();

/* ---- 地図でふりかえる：シークしたとき、道のり（青い線）は再生位置だけで決まる（replayRouteFractions） ---- */
(function () {
  var routeTl = { legs: [{ r0: 2, r1: 4 }, { r0: 6, r1: 10 }, { r0: 10, r1: 10 }, { r0: 12, r1: 14 }] };
  eq('replayRouteFractions: はじめは全区間0（何も描かない）', T.replayRouteFractions(routeTl, 0), [0, 0, 0, 0]);
  eq('replayRouteFractions: 走り終えた区間は1、いまの区間は進んだ割合、先の区間は0', T.replayRouteFractions(routeTl, 8), [1, 0.5, 0, 0]);
  eq('replayRouteFractions: 戻ると、先の区間はまた0になる（8→3）', T.replayRouteFractions(routeTl, 3), [0.5, 0, 0, 0]);
  eq('replayRouteFractions: 区間の境目ちょうど', T.replayRouteFractions(routeTl, 4), [1, 0, 0, 0]);
  eq('replayRouteFractions: 長さ0の区間はrに達したら1', T.replayRouteFractions(routeTl, 10), [1, 1, 1, 0]);
  eq('replayRouteFractions: 終わりでは全部1', T.replayRouteFractions(routeTl, 99), [1, 1, 1, 1]);
  // どの順番でシークしても、同じrなら同じ結果（描き方の途中経過に依らない）
  var seen = {};
  [9, 1, 13, 5, 7, 0, 13, 3, 9, 1].forEach(function (r) {
    var got = JSON.stringify(T.replayRouteFractions(routeTl, r));
    if (seen[r] === undefined) seen[r] = got; else eq('replayRouteFractions: 同じrは何度シークしても同じ結果（r=' + r + '）', got, seen[r]);
  });
  eq('replayRouteFractions: 区間が無くても落ちない', T.replayRouteFractions({ legs: [] }, 5), []);
})();

/* ---- 公開範囲・フォロー・プロフィール（docs/adr/0010。サーバー側のコピーは worker/src/visibility.js） ---- */
(function () {
  var vis = ['members', 'close_friends', 'followers', 'public'];
  function row(o) { return vis.map(function (v) { return T.canViewByVisibility(Object.assign({ visibility: v }, o)); }); }
  eq('公開範囲の判定: 持ち主はどの範囲でも見られる', row({ isOwner: true }), [true, true, true, true]);
  eq('公開範囲の判定: 関係のない人は全体向けだけ', row({}), [false, false, false, true]);
  eq('公開範囲の判定: フォロワーはフォロワー向け・全体向け', row({ isFollower: true }), [false, false, true, true]);
  eq('公開範囲の判定: 親しい友人はフォロワー向けにも見える', row({ isFollower: true, isCloseFriend: true }), [false, true, true, true]);
  eq('公開範囲の判定: 持ち主にブロックされた人は全体向けだけ', row({ isFollower: true, isCloseFriend: true, blockedByOwner: true }), [false, false, false, true]);
  eq('公開範囲の判定: 持ち主をブロックした人は何も見ない', row({ isFollower: true, blockedByViewer: true }), [false, false, false, false]);
  eq('公開範囲の判定: 知らない値は一緒に行った人だけ扱い', T.canViewByVisibility({ visibility: 'x', isFollower: true }), false);
  eq('normalizeVisibility / visibilityLabel', [T.normalizeVisibility('x'), T.normalizeVisibility('followers'), T.visibilityLabel('close_friends'), T.visibilityLabel(undefined)], ['members', 'followers', '親しい友人', '一緒に行った人だけ']);
  eq('公開範囲は4つ・初期値（先頭）は一緒に行った人だけ', T.VISIBILITY_OPTIONS.map(function (o) { return o.key; }), ['members', 'close_friends', 'followers', 'public']);

  // 2026-10-01：SNSなし。いま選べるのは「一緒に行った人だけ」と「リンクを知っている人（見るだけ）」の2つ
  eq('公開範囲の選択肢（いま選べるもの）は2つ・初期値は一緒に行った人だけ', T.VISIBILITY_CHOICES.map(function (o) { return o.key + ':' + o.label; }), ['members:一緒に行った人だけ', 'public:リンクを知っている人（見るだけ）']);
  eq('見るだけのリンクを入り切りできるのは、アカウントで参加している人だけ', [T.publicLinkStatus([{ accountId: '111111' }], ''), T.publicLinkStatus([{ accountId: '111111' }], '111111'), T.publicLinkStatus([{ accountId: '111111' }], '222222'), T.publicLinkStatus([], '111111')], ['login', 'ok', 'not_member', 'not_member']);

  eq('フォロー: 通常の相手はすぐフォロー中', T.nextFollowStatus('none', 'follow', { targetPrivate: false }), 'approved');
  eq('フォロー: 承認制の相手は承認待ち', T.nextFollowStatus('none', 'follow', { targetPrivate: true }), 'pending');
  eq('フォロー: 申請中に押し直しても承認待ちのまま', T.nextFollowStatus('pending', 'follow', { targetPrivate: true }), 'pending');
  eq('フォロー: やめる・申請の取り消しは常にnone', ['none', 'pending', 'approved'].map(function (s) { return T.nextFollowStatus(s, 'unfollow'); }), ['none', 'none', 'none']);
  eq('フォロー: 承認は承認待ちだけ', ['none', 'pending', 'approved'].map(function (s) { return T.nextFollowStatus(s, 'approve'); }), [null, 'approved', 'approved']);
  eq('フォロー: 断るは承認待ちだけ（フォロー中は外すを使う）', ['none', 'pending', 'approved'].map(function (s) { return T.nextFollowStatus(s, 'decline'); }), ['none', 'none', null]);
  eq('フォロー: 外すはフォロー中だけ', ['none', 'pending', 'approved'].map(function (s) { return T.nextFollowStatus(s, 'remove'); }), ['none', null, 'none']);
  eq('フォロー: 知らない操作はnull', T.nextFollowStatus('approved', 'block'), null);
  eq('フォローボタン: 自分には出ない', T.followButtonInfo('self', false), null);
  eq('フォローボタン: 通常', [T.followButtonInfo('none', false).label, T.followButtonInfo('none', false).action], ['フォローする', 'follow']);
  eq('フォローボタン: 承認制の相手', T.followButtonInfo('none', true).label, 'フォローをリクエスト');
  eq('フォローボタン: リクエスト済みは取り消し', [T.followButtonInfo('requested', true).label, T.followButtonInfo('requested', true).action], ['リクエスト済み', 'unfollow']);
  eq('フォローボタン: フォロー中はやめる（確認つき）', [T.followButtonInfo('following', false).label, T.followButtonInfo('following', false).action, !!T.followButtonInfo('following', false).confirm], ['フォロー中', 'unfollow', true]);

  var members = [{ accountId: '222222', joinedAt: '2026-09-02T00:00:00Z' }, { accountId: '111111', joinedAt: '2026-09-01T00:00:00Z' }];
  eq('持ち主の立場: 未ログイン', T.tripOwnerStatus({ ownerAccountId: '' }, members, ''), 'login');
  eq('持ち主の立場: 自分が持ち主', T.tripOwnerStatus({ ownerAccountId: '111111' }, members, '111111'), 'owner');
  eq('持ち主の立場: ほかの人が持ち主', T.tripOwnerStatus({ ownerAccountId: '111111' }, members, '222222'), 'other');
  eq('持ち主の立場: 持ち主がいなくて、自分が最初の参加者なら持ち主になれる', T.tripOwnerStatus({ ownerAccountId: '' }, members, '111111'), 'claimable');
  eq('持ち主の立場: 最初の参加者でなければなれない', T.tripOwnerStatus({ ownerAccountId: '' }, members, '222222'), 'unclaimable');
  eq('持ち主の立場: 参加していなければなれない', T.tripOwnerStatus({ ownerAccountId: '' }, [], '333333'), 'unclaimable');

  function vrow(o) { return ['public', 'followers', 'none', 'junk'].map(function (v) { return T.canViewVisited(Object.assign({ visibility: v }, o)); }); }
  eq('旅先の公開範囲: 本人はいつでも見られる', vrow({ isSelf: true }), [true, true, true, true]);
  eq('旅先の公開範囲: 関係のない人は「全体」だけ', vrow({}), [true, false, false, false]);
  eq('旅先の公開範囲: フォロワーは「全体」「フォロワー」（知らない値はフォロワー扱い）', vrow({ isFollower: true }), [true, true, false, true]);
  eq('旅先の公開範囲: ブロックしている・されている人には何も見せない', [vrow({ isFollower: true, blockedByOwner: true }), vrow({ isFollower: true, blockedByViewer: true })], [[false, false, false, false], [false, false, false, false]]);
  eq('旅先の公開範囲: 初期値はフォロワー・選択肢は3つ', [T.normalizeVisitedVisibility(undefined), T.normalizeVisitedVisibility('x'), T.VISITED_VISIBILITY_OPTIONS.map(function (o) { return o.label; })], ['followers', 'followers', ['全体', 'フォロワー', '出さない']]);
  eq('ひとこと: 160字までは通る', [T.bioError(''), T.bioError('あ'.repeat(160)), T.bioError('あ'.repeat(161)) !== ''], ['', '', true]);
  eq('公開画面のIDをURLから取る', [T.getPublicIdFromSearch('?p=pub_' + 'a'.repeat(32)), T.getPublicIdFromSearch('?trip=abc&p=pub_' + 'b'.repeat(32)), T.getPublicIdFromSearch('?p=trip_abc'), T.getPublicIdFromSearch('?p=pub_zz')], ['pub_' + 'a'.repeat(32), 'pub_' + 'b'.repeat(32), '', '']);
  eq('プロフィールのIDをURLから取る', [T.getProfileIdFromSearch('?u=123456'), T.getProfileIdFromSearch('?u=12345'), T.getProfileIdFromSearch('?u=123456789'), T.getProfileIdFromSearch('')], ['123456', '', '', '']);
  eq('旅行のURL（?trip=）は公開画面・プロフィールのURLとは取り違えない', [T.getTripIdFromSearch('?p=pub_' + 'a'.repeat(32)), T.getProfileIdFromSearch('?trip=trip_x')], ['', '']);
  eq('リンクの組み立て', [T.buildPublicUrl('https://x.example', '/app/', 'pub_abc'), T.buildProfileUrl('https://x.example', '/app/', '123456')], ['https://x.example/app/?p=pub_abc', 'https://x.example/app/?u=123456']);
  eq('頭文字', [T.nameInitial('たろう'), T.nameInitial('abc'), T.nameInitial('  '), T.nameInitial('')], ['た', 'A', '？', '？']);
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
