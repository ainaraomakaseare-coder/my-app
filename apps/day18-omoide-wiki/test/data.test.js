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

/* ---- 生い立ち・経歴（history）カテゴリ ---- */
ok('CATEGORY_ORDER に history が含まれる', W.CATEGORY_ORDER.indexOf('history') !== -1);
ok('person用のhistory質問がある', W.QUESTIONS.person.history.length > 0);
ok('group用のhistory質問がある', W.QUESTIONS.group.history.length > 0);
eq('新規Wikiにhistory配列がある', W.newWiki('person', 'テスト', '').history, []);

/* ---- buildInterviewQueue: 既に答えた固定質問は繰り返さない ---- */
var freshQueue = W.buildInterviewQueue('person');
var totalQuestions = freshQueue.length;
var wikiWithAnswers = W.newWiki('person', 'テスト2', '');
var firstQ = W.QUESTIONS.person.history[0];
var secondQ = W.QUESTIONS.person.favorites[0];
wikiWithAnswers.history.push(W.newEntry('東京都出身です', '本人', firstQ.text, firstQ.key));
wikiWithAnswers.favorites.push(W.newEntry('カレーが好きです', '本人', secondQ.text, secondQ.key));
var filteredQueue = W.buildInterviewQueue('person', wikiWithAnswers);
eq('既に答えた分だけ質問数が減る', filteredQueue.length, totalQuestions - 2);
ok('既に答えた質問はキューに残らない', !filteredQueue.some(function (q) { return q.question === firstQ.text || q.question === secondQ.text; }));
eq('wikiを渡さない場合は今まで通り全問出る（後方互換）', W.buildInterviewQueue('person').length, totalQuestions);

/* ---- 質問の言い回しを変えても、既に答えた質問は繰り返し聞かれない ---- */
var wikiLegacyText = W.newWiki('person', 'テスト3', '');
// questionKeyが無い古い形式の記録（key導入前に保存されたもの）でも、本文が一致すれば弾かれる
wikiLegacyText.history.push(W.newEntry('東京都です', '本人', W.QUESTIONS.person.history[0].text));
eq('questionKeyが無くても本文一致で重複を防ぐ（後方互換）', W.buildInterviewQueue('person', wikiLegacyText).length, totalQuestions - 1);

var wikiKeyOnly = W.newWiki('person', 'テスト4', '');
// 質問の言い回しを変えた後でも、questionKeyさえ一致すれば重複しない（本文は昔のまま保存されている想定）
wikiKeyOnly.history.push(W.newEntry('東京都です', '本人', '（昔の言い回しの質問文）', W.QUESTIONS.person.history[0].key));
eq('questionKeyが一致すれば、質問文が変わっても重複しない', W.buildInterviewQueue('person', wikiKeyOnly).length, totalQuestions - 1);

var wikiLegacyBirthPlace = W.newWiki('person', 'テスト4b', '');
// questionKey導入より前の、実際に使われていた旧文言そのままの回答（questionKeyは無い）
wikiLegacyBirthPlace.history.push(W.newEntry(
  '神奈川県横浜市',
  '本人',
  '生まれはどこですか？（都道府県・市区町村、当時の様子も分かれば教えてください）'
));
eq('言い回しを変える前に答えた既知の旧文言も、答え済みとして扱う', W.buildInterviewQueue('person', wikiLegacyBirthPlace).length, totalQuestions - 1);

/* ---- normalizeWiki（古いバージョンのWikiを読み込んだときの後方互換） ---- */
var oldWiki = { id: 'w_old', type: 'person', title: '古いWiki', episodes: [] };
delete oldWiki.history;
var normalized = W.normalizeWiki(oldWiki);
ok('historyが無いWikiを読み込んでも空配列が補われる', Array.isArray(normalized.history) && normalized.history.length === 0);
ok('infoboxが無くても空配列が補われる', Array.isArray(normalized.infobox));
ok('contributorsが無くても空配列が補われる', Array.isArray(normalized.contributors));

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

/* ---- skippedKeys: 明示的にとばした質問は、答えていなくても二度と出さない ---- */
var wikiSkipped = W.newWiki('person', 'テスト5', '');
wikiSkipped.skippedKeys.push(W.QUESTIONS.person.history[0].key);
eq('スキップした質問はキューから除かれる（答えていなくても）', W.buildInterviewQueue('person', wikiSkipped).length, totalQuestions - 1);

/* ---- askedQuestionTexts: 記録が増えても「すでに聞いた質問」をAIに正確に伝えるため ---- */
var askedWiki = W.newWiki('person', 'テスト8', '');
askedWiki.history.push(W.newEntry('回答A', '', '質問1'));
askedWiki.history.push(W.newEntry('回答B', '', '質問2'));
askedWiki.history.push(W.newEntry('回答C', '', '質問1')); // 同じ質問文は重複させない
eq('質問文を重複なく、聞いた順に返す', W.askedQuestionTexts(askedWiki, 'history'), ['質問1', '質問2']);
eq('記録が無いカテゴリは空配列', W.askedQuestionTexts(askedWiki, 'skills'), []);

/* ---- tripParticipants: 旅行・イベントの「だれがいたか」を重複なく集める ---- */
var tripEpisodes = [
  W.newEpisode({ body: 'A', author: '鈴木', participants: ['田中', '佐藤'], trip: '沖縄旅行' }),
  W.newEpisode({ body: 'B', author: '田中', participants: ['鈴木'], trip: '沖縄旅行' })
];
eq('書いた人・その場にいた人を重複なく順番通りに集める',
   W.tripParticipants(tripEpisodes), ['鈴木', '田中', '佐藤']);
eq('エピソードが無ければ空配列', W.tripParticipants([]), []);

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

/* ---- 旅行（Trip）はエピソードの親エンティティ：findOrCreateTrip / groupEpisodesByTrip ---- */
var tripWiki = W.newWiki('person', 'テスト6', '');
var okinawaId = W.findOrCreateTrip(tripWiki, '沖縄旅行');
var gasshukuId = W.findOrCreateTrip(tripWiki, '夏合宿');
eq('同じ旅行名でfindOrCreateTripを呼ぶと同じidが返る（重複作成しない）', W.findOrCreateTrip(tripWiki, '沖縄旅行'), okinawaId);
eq('空文字を渡すと旅行は作らず空文字を返す', W.findOrCreateTrip(tripWiki, '  '), '');
eq('作った旅行の数だけwiki.tripsに増える', tripWiki.trips.length, 2);

var epA1 = W.newEpisode({ title: '1日目', body: '出発', tripId: okinawaId });
var epA2 = W.newEpisode({ title: '2日目', body: '海', tripId: okinawaId });
var epB1 = W.newEpisode({ title: '合宿1', body: '練習', tripId: gasshukuId });
var epC1 = W.newEpisode({ title: '普段の話', body: '雑談' }); // 旅行未設定
epA1.createdAt = epA1.updatedAt = '2024-01-01T00:00:00Z';
epA2.createdAt = epA2.updatedAt = '2024-01-02T00:00:00Z';
epB1.createdAt = epB1.updatedAt = '2024-03-01T00:00:00Z';
epC1.createdAt = epC1.updatedAt = '2024-02-01T00:00:00Z';
tripWiki.episodes = [epA1, epB1, epC1, epA2];

var grouped = W.groupEpisodesByTrip(tripWiki);
eq('旅行ごとに分かれる（グループ数）', grouped.length, 3);
eq('直近の更新がある旅行が先に来る（夏合宿が最新）', grouped[0].trip, '夏合宿');
eq('旅行名なしは最後にまとまる', grouped[grouped.length - 1].trip, '');
eq('同じ旅行の中では新しい順', grouped[1].episodes.map(function (e) { return e.id; }), [epA2.id, epA1.id]);

var emptyTripWiki = W.newWiki('person', 'テスト7', '');
W.findOrCreateTrip(emptyTripWiki, '来月の旅行（まだエピソード無し）');
eq('エピソードが1件も無い旅行も一覧に含まれる', W.groupEpisodesByTrip(emptyTripWiki).length, 1);

/* ---- normalizeWiki: 旧形式（episode.tripが自由記述文字列）を旅行エンティティに変換する ---- */
var legacyWiki = {
  id: 'w_legacy', type: 'person', title: '古いWiki',
  episodes: [
    { id: 'e1', body: 'A', trip: '沖縄旅行', createdAt: '2024-01-01T00:00:00Z' },
    { id: 'e2', body: 'B', trip: '沖縄旅行', createdAt: '2024-01-02T00:00:00Z' },
    { id: 'e3', body: 'C', createdAt: '2024-01-03T00:00:00Z' }
  ]
};
var migrated = W.normalizeWiki(legacyWiki);
eq('同じ旅行名の文字列は1つの旅行エンティティにまとまる', migrated.trips.length, 1);
ok('旅行名からtripIdへ変換される', migrated.episodes[0].tripId === migrated.trips[0].id && migrated.episodes[1].tripId === migrated.trips[0].id);
eq('旅行名が無いエピソードのtripIdは空文字', migrated.episodes[2].tripId, '');
ok('古いtripフィールドは削除される', migrated.episodes.every(function (e) { return !('trip' in e); }));

console.log('\n' + pass + ' 件 通過 / ' + fail + ' 件 失敗');
process.exit(fail ? 1 : 0);
