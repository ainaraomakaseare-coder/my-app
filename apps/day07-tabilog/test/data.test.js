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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
