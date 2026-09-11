/*
 * データの変換・マージ（複数人のJSONを1つに合体する部分）を検証する。
 * ブラウザ操作は含まない。実行: node test/data.test.js
 */
var path = require('path');

global.window = {};
require(path.join(__dirname, '..', 'app.js'));
var W = global.window.OmoideWiki;

var pass = 0, fail = 0;
function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log('NG  ' + label + '\n    got  ' + JSON.stringify(got) + '\n    want ' + JSON.stringify(want)); }
}
function ok(label, cond) { eq(label, !!cond, true); }

/* ---- uid ---- */
ok('uid は prefix で始まる', W.uid('w').indexOf('w_') === 0);
ok('uid は毎回ちがう', W.uid('e') !== W.uid('e'));

/* ---- infobox の変換 ---- */
eq('parseInfoboxText: ラベルと値を分ける',
   W.parseInfoboxText('生年月日: 1960年4月1日\n出身：大阪府\n\n所属:'),
   [{ label: '生年月日', value: '1960年4月1日' }, { label: '出身', value: '大阪府' }, { label: '所属', value: '' }]);
eq('infoboxToText: 元に戻せる',
   W.infoboxToText([{ label: 'A', value: '1' }, { label: 'B', value: '2' }]), 'A: 1\nB: 2');

/* ---- タグ ---- */
eq('parseTags: 全角カンマ・半角カンマ・空白の混在', W.parseTags('旅行, 合宿、 笑える話 ,'), ['旅行', '合宿', '笑える話']);

/* ---- 質問バンク ---- */
ok('person の質問数と group の質問数はどちらも0でない', W.buildInterviewQueue('person').length > 0 && W.buildInterviewQueue('group').length > 0);
eq('質問キューの件数はカテゴリ合計と一致',
   W.buildInterviewQueue('person').length,
   W.CATEGORY_ORDER.reduce(function (sum, c) { return sum + W.QUESTIONS.person[c].length; }, 0));

/* ---- mergeEntryArrays ---- */
var a = [{ id: '1', text: 'A', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' }];
var b = [
  { id: '1', text: 'A-updated', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-02-01T00:00:00Z' },
  { id: '2', text: 'B', createdAt: '2024-01-02T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z' }
];
var merged = W.mergeEntryArrays(a, b);
eq('同じidは新しいupdatedAtの方を採用', merged.filter(function (x) { return x.id === '1'; })[0].text, 'A-updated');
eq('新しいidは追加される', merged.length, 2);
eq('createdAt昇順に並ぶ', merged.map(function (x) { return x.id; }), ['1', '2']);

/* ---- mergeWiki ---- */
var w1 = W.newWiki('person', '山田太郎', '');
w1.overview = '';
w1.contributors = ['花子'];
w1.episodes = [W.newEpisode({ title: 'エピソードA', body: '本文A', author: '花子' })];

var w2 = JSON.parse(JSON.stringify(w1));
w2.id = w1.id; // 同一Wikiの別コピーという想定
w2.subtitle = '別の人が書いた一言';
w2.overview = '別の人が書いた概要';
w2.contributors = ['太郎'];
w2.episodes = [W.newEpisode({ title: 'エピソードB', body: '本文B', author: '太郎' })];

var mw = W.mergeWiki(w1, w2);
eq('既存のsubtitleが空なら相手の値を採用', mw.subtitle, '別の人が書いた一言');
eq('既存のoverviewが空なら相手の値を採用', mw.overview, '別の人が書いた概要');
eq('episodesは両方合わさって2件になる', mw.episodes.length, 2);
eq('contributorsは重複なく合体する', mw.contributors.sort(), ['太郎', '花子'].sort());

/* 既存の値がある場合は勝手に上書きしない */
var w3 = W.newWiki('person', '鈴木一郎', '既存の一言');
var w4 = W.newWiki('person', '鈴木一郎', '相手の一言');
w4.id = w3.id;
var mw2 = W.mergeWiki(w3, w4);
eq('既存のsubtitleがあれば保持する', mw2.subtitle, '既存の一言');

/* ---- mergeImport ---- */
var store = W.emptyStore();
var g1 = W.newWiki('group', 'テニスサークルOASIS', '');
store.wikis[g1.id] = g1;

var incomingNew = W.newWiki('person', '佐藤花子', '');
var incomingSame = JSON.parse(JSON.stringify(g1));
incomingSame.episodes = [W.newEpisode({ title: '合宿の話', body: '雨だった', author: '田中' })];

var result = W.mergeImport(store, [incomingNew, incomingSame]);
eq('新規Wikiは追加件数としてカウント', result.added, 1);
eq('既存Wikiはマージ件数としてカウント', result.merged, 1);
eq('マージ後、既存Wikiにエピソードが増えている', result.store.wikis[g1.id].episodes.length, 1);
eq('Wikiの数は合計2件', Object.keys(result.store.wikis).length, 2);

/* ---- parseImportPayload ---- */
eq('配列形式を読める', W.parseImportPayload(JSON.stringify([g1])).length, 1);
eq('{wikis:[...]}形式を読める', W.parseImportPayload(JSON.stringify(W.exportPayload([g1]))).length, 1);
eq('単体のWikiオブジェクトも読める', W.parseImportPayload(JSON.stringify(g1)).length, 1);
var threw = false;
try { W.parseImportPayload(JSON.stringify({ foo: 'bar' })); } catch (e) { threw = true; }
ok('関係ないJSONはエラーになる', threw);

console.log('\n' + pass + ' 件 通過 / ' + fail + ' 件 失敗');
process.exit(fail ? 1 : 0);
