/*
 * 日付計算・並べ替え・グループ分けなど、純粋な関数だけを検証する。
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
var epsNoTripDates = [{ date: '2024-08-12' }, { date: '2024-08-10' }, { date: '2024-08-10' }];
eq('allDatesForTrip: 日程未設定ならエピソードの日付から重複なく作る', T.allDatesForTrip(tripNoDates, epsNoTripDates),
  ['2024-08-10', '2024-08-12']);

var epsWithUndated = [{ date: '2024-08-10' }, { date: '' }];
eq('allDatesForTrip: 日付未設定のエピソードは末尾にまとめる', T.allDatesForTrip(trip, epsWithUndated),
  ['2024-08-10', '2024-08-11', '2024-08-12', '2024-08-13', '']);

/* ---- sortEpisodes / groupEpisodesByDate ---- */
var eps = [
  { id: 'a', date: '2024-08-11', time: '09:00', createdAt: '2' },
  { id: 'b', date: '2024-08-10', time: '19:00', createdAt: '1' },
  { id: 'c', date: '2024-08-10', time: '10:00', createdAt: '3' }
];
eq('sortEpisodes: 日付→時間の順に並ぶ', T.sortEpisodes(eps).map(function (e) { return e.id; }), ['c', 'b', 'a']);

var grouped = T.groupEpisodesByDate(eps);
eq('groupEpisodesByDate: 日付ごとにまとまる', Object.keys(grouped).sort(), ['2024-08-10', '2024-08-11']);
eq('groupEpisodesByDate: 同じ日は時間順', grouped['2024-08-10'].map(function (e) { return e.id; }), ['c', 'b']);

/* ---- 別行動タグ ---- */
var epsTagged = [
  { id: '1', groupTag: '' },
  { id: '2', groupTag: '父・妹チーム' },
  { id: '3', groupTag: '父・妹チーム' },
  { id: '4', groupTag: '母・わたしチーム' }
];
eq('distinctGroupTags: 空文字は除いて重複なく出す', T.distinctGroupTags(epsTagged), ['父・妹チーム', '母・わたしチーム']);
eq('filterEpisodesByGroupTag: 空文字(全員)は全件', T.filterEpisodesByGroupTag(epsTagged, '').length, 4);
eq('filterEpisodesByGroupTag: タグ指定でそのチームだけ', T.filterEpisodesByGroupTag(epsTagged, '父・妹チーム').map(function (e) { return e.id; }), ['2', '3']);

/* ---- 費用の合計・宿泊先 ---- */
var epsCost = [{ cost: 1200 }, { cost: 4800 }, { cost: null }, {}];
eq('tripTotalCost: costがある分だけ合計する', T.tripTotalCost(epsCost), 6000);

var epsLodging = [
  { category: 'lodging', placeName: 'オーシャンビューホテル那覇' },
  { category: 'food', placeName: '国際通りの食堂' },
  { category: 'lodging', placeName: 'オーシャンビューホテル那覇' }
];
eq('primaryLodgingName: lodgingカテゴリの場所名を重複なく', T.primaryLodgingName(epsLodging), 'オーシャンビューホテル那覇');
eq('primaryLodgingName: lodgingが無ければ空文字', T.primaryLodgingName([{ category: 'food', placeName: 'x' }]), '');

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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
