/*
 * ドラマ検定の、通信にも DOM にも依らない部分を index.html から
 * そのまま切り出して検証する。
 * 実行: node test/quiz.test.js
 */
var fs = require("fs"), path = require("path"), vm = require("vm");

var html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
var js = html.split("<script>")[1].split("</script>")[0];
/* PURE-BEGIN の注釈を閉じた直後から、PURE-END の注釈が開く手前まで */
var from = js.indexOf("*/", js.indexOf("PURE-BEGIN")) + 2;
var to = js.lastIndexOf("/*", js.indexOf("PURE-END"));
var box = {};
vm.runInNewContext(js.slice(from, to), box);

var pass = 0, fail = 0;
function eq(label, got, want){
  if(JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log("NG  " + label + "\n    got  " + JSON.stringify(got) + "\n    want " + JSON.stringify(want)); }
}
function ok(label, cond, extra){
  if(cond) pass++;
  else { fail++; console.log("NG  " + label + (extra !== undefined ? "\n    " + extra : "")); }
}

/* ---- 文字列の掃除 ---- */
eq("脚注を落とす", box.cleanText("TBS系列[1]"), "TBS系列");
eq("要出典も落とす", box.cleanText("全11話[要出典]"), "全11話");
eq("全角空白と改行を詰める", box.cleanText("野木　亜紀子\n  脚本"), "野木 亜紀子 脚本");
eq("空は空のまま", box.cleanText(null), "");

/* ---- 名前の分割 ---- */
eq("読点で割る", box.splitNames("新垣結衣、星野源、大谷亮平"), ["新垣結衣","星野源","大谷亮平"]);
eq("中黒でも割る", box.splitNames("土井裕泰・金子文紀"), ["土井裕泰","金子文紀"]);
eq("括弧の補足を落とす", box.splitNames("石田ゆり子（第1話）"), ["石田ゆり子"]);
eq("末尾のほかを落とす", box.splitNames("新垣結衣、星野源 ほか"), ["新垣結衣","星野源"]);
eq("一文字は拾わない", box.splitNames("A、新垣結衣"), ["新垣結衣"]);

/* ---- 数字の読み取り ---- */
eq("全11話から11", box.readCount("全11話"), 11);
eq("全角の話数", box.readCount("１１回"), 11);
eq("話数がなければ null", box.readCount("未定"), null);
eq("放送期間から開始日", box.readDate("2016年10月11日 - 12月20日"), {y:2016,m:10,d:11});
eq("年月だけでも読む", box.readDate("2013年4月"), {y:2013,m:4,d:null});
eq("年だけでも読む", box.readDate("1979年"), {y:1979,m:null,d:null});
eq("視聴率", box.readRating("10.2%"), 10.2);
eq("全角の視聴率", box.readRating("１０．２％"), 10.2);
eq("視聴率がなければ null", box.readRating("―"), null);

/* ---- 人名かどうかの見分け ---- */
eq("人名は通す", box.looksLikeName("八津弘幸"), true);
eq("年つきの見出しは落とす", box.looksLikeName("2013年版"), false);
eq("ローマ数字つきの題は落とす", box.looksLikeName("半沢直樹II"), false);
eq("エピソード見出しは落とす", box.looksLikeName("エピソードゼロ"), false);
eq("シーズン見出しは落とす", box.looksLikeName("シーズン2"), false);
eq("括弧つきは落とす", box.looksLikeName("八津弘幸（脚本）"), false);
eq("長すぎるものは落とす", box.looksLikeName("あいうえおかきくけこさしすせそたち"), false);

/* 半沢直樹の脚本欄。版の見出しが人名の並びに混ざっている */
eq("見出しを除いて脚本家だけ拾う",
   box.personNames("2013年版\n八津弘幸\n半沢直樹II\nエピソードゼロ\n槌谷健、李正美、丑尾健太郎\n2020年版\n丑尾健太郎、金沢知樹"),
   ["八津弘幸","槌谷健","李正美","丑尾健太郎","金沢知樹"]);
eq("同じ人は一度だけ", box.personNames("李正美、李正美"), ["李正美"]);

/* ---- 放送局の名寄せ ---- */
eq("系列を落とす", box.normStation("TBS系列"), "TBS");
eq("フジテレビ系列", box.normStation("フジテレビ系列"), "フジテレビ");
eq("NHK総合テレビジョン", box.normStation("NHK総合テレビジョン"), "NHK");
eq("日テレの略称", box.normStation("日テレ"), "日本テレビ");
eq("カンテレの略称", box.normStation("カンテレ"), "関西テレビ");
eq("見知らぬ局は空にする", box.normStation("テレビ朝鮮"), "");
eq("韓国の局も空にする", box.normStation("KBS2"), "");
eq("MBCをMBSと取り違えない", box.normStation("MBC"), "");
eq("空は空のまま", box.normStation(""), "");

/* ---- infobox の種類の見分け ---- */
var BOX_MANGA = {"作者":"神尾葉子","出版社":"集英社","掲載誌":"マーガレット","巻数":"全37巻"};
var BOX_ANIME = {"アニメーション制作":"東映動画","シリーズ構成":"富田祐弘","キャラクターデザイン":"山室直儀",
                 "放送局":"テレビ朝日","放送期間":"1996年9月8日 - 1997年8月31日","話数":"全51話"};
var BOX_DRAMA = {"脚本":"サタケミキオ","演出":"石井康晴","出演者":"井上真央、松本潤、小栗旬",
                 "放送局":"TBS系列","放送期間":"2005年10月21日 - 12月16日","回数":"全9話"};
var BOX_KOREA = {"出演者":"ク・ヘソン、イ・ミンホ","放送局":"KBS2",
                 "放送期間":"2009年1月5日 - 3月31日","回数":"全25話"};
eq("漫画の箱", box.boxKind(BOX_MANGA), "book");
eq("アニメの箱", box.boxKind(BOX_ANIME), "anime");
eq("実写ドラマの箱", box.boxKind(BOX_DRAMA), "live");

/* 花より男子。漫画・アニメ・ドラマ・韓国版が1本の記事に同居する */
eq("漫画とアニメを避けて実写ドラマの箱を選ぶ",
   box.pickInfobox([BOX_MANGA, BOX_ANIME, BOX_DRAMA, BOX_KOREA])["放送局"], "TBS系列");
eq("実写しか無ければ日本の局の箱を選ぶ",
   box.pickInfobox([BOX_KOREA, BOX_DRAMA])["放送局"], "TBS系列");
eq("箱が無ければ空", box.pickInfobox([]), {});

/* プロポーズ大作戦。フジ版に「放送局」行が無く、韓国版に有る形。
   箱をまたいで値を拾うと、フジ版の出演者に韓国版の局が混ざる。 */
var FUJI = {"ジャンル":"テレビドラマ","脚本":"金子ありさ","出演者":"山下智久、長澤まさみ、榮倉奈々",
            "放送チャンネル":"フジテレビ系列","放送期間":"2007年4月16日 - 6月25日","回数":"全11話"};
var CHOSUN = {"放送局":"テレビ朝鮮","放送期間":"2012年2月20日 - 4月10日","出演者":"ユ・スンホ"};
eq("箱をまたいで値を混ぜない",
   box.fromInfobox(box.pickInfobox([FUJI, CHOSUN])).station, "フジテレビ");
eq("混ざった出演者を持ち込まない",
   box.fromInfobox(box.pickInfobox([FUJI, CHOSUN])).cast[0], "山下智久");

/* ---- infobox の整形 ---- */
var INFO = {
  "ジャンル":"テレビドラマ",
  "脚本":"野木亜紀子",
  "演出":"金子文紀、土井裕泰、石井康晴",
  "出演者":"新垣結衣、星野源、大谷亮平、藤井隆、古田新太、石田ゆり子",
  "音楽":"末廣健一郎",
  "主題歌":"星野源「恋」",
  "原作":"海野つなみ",
  "放送局":"TBS系列",
  "放送期間":"2016年10月11日 - 12月20日",
  "回数":"全11話"
};
var w = box.fromInfobox(INFO);
eq("放送局を主要局名に寄せる", w.station, "TBS");
eq("脚本", w.writers, ["野木亜紀子"]);
eq("演出は複数", w.directors, ["金子文紀","土井裕泰","石井康晴"]);
eq("出演者", w.cast.length, 6);
eq("話数", w.count, 11);
eq("開始日", w.start, {y:2016,m:10,d:11});
eq("ラベルが無ければ空", box.fromInfobox({}).writers, []);

/* ---- 各話表の整形 ---- */
var ROWS = [
  {no:"第2話", date:"2016年10月18日", subtitle:"仕事とプライド", rating:"11.5%"},
  {no:"第1話", date:"2016年10月11日", subtitle:"私を雇ってください！", rating:"10.2%"},
  {no:"第1話", date:"2016年10月11日", subtitle:"重複した行", rating:"10.2%"},
  {no:"平均", date:"", subtitle:"", rating:"13.6%"},
  {no:"第3話", date:"2016年10月25日", subtitle:"「好き」の値段", rating:"12.5%"}
];
var eps = box.tidyEpisodes(ROWS);
eq("話数順に並ぶ", eps.map(function(e){ return e.no; }), [1,2,3]);
eq("重複した話は落ちる", eps.length, 3);
eq("鉤括弧を外す", eps[0].subtitle, "私を雇ってください！");
eq("視聴率を数値で持つ", eps[2].rating, 12.5);

/* ---- 作品としてのまとめ ---- */
var WORK = box.makeWork("逃げるは恥だが役に立つ", "https://ja.wikipedia.org/wiki/x", INFO, ROWS);
eq("年代の帯", WORK.era, "2010");
eq("各話も持つ", WORK.episodes.length, 3);
eq("1979年なら1990より前の帯", box.makeWork("x","u",{"放送期間":"1979年"},[]).era, "1990");
eq("話数が無ければ各話の数で補う",
   box.makeWork("x","u",{"放送局":"TBS"}, ROWS).count, 3);

/* ---- 出題 ---- */
/* 各話とサブタイトル、登場人物まで揃った作品を組む */
var SUBS = ["私を雇ってください！","仕事とプライド","「好き」の値段","恋に落ちる方程式",
            "ムズキュン！最高の日","契約結婚の代償","嘘つきな私たち","本当の気持ち",
            "この恋に名前をつけるなら","夫婦を続ける理由","逃げるは恥だが役に立つ"];
var MANY = SUBS.map(function(t, i){
  return { no:"第" + (i + 1) + "話", date:"2016年10月" + (11 + i) + "日",
           subtitle:t, rating:(10.2 + i * 0.6).toFixed(1) + "%" };
});
var CHARS = [
  {role:"森山みくり", actor:"新垣結衣"}, {role:"津崎平匡", actor:"星野源"},
  {role:"風見涼太", actor:"大谷亮平"},   {role:"沼田頼綱", actor:"古田新太"},
  {role:"土屋百合", actor:"石田ゆり子"}, {role:"梅原ナツキ", actor:"藤井隆"}
];
var FULL = box.makeWork("逃げるは恥だが役に立つ", "https://ja.wikipedia.org/wiki/x", INFO, MANY, CHARS);

eq("登場人物を持つ", FULL.characters.length, 6);
eq("鉤括弧で始まる題を壊さない", FULL.episodes[2].subtitle, "「好き」の値段");
eq("題を包む鉤括弧は外す", FULL.episodes[0].subtitle, "私を雇ってください！");

var quiz = box.buildQuiz(FULL, 12345);
eq("10問そろう", quiz.length, 10);
eq("材料が揃えば全問が中身の問題",
   quiz.filter(function(q){ return q.tier === "content"; }).length, 10);
eq("スタッフを問う設問は出さない",
   quiz.filter(function(q){ return /脚本|演出|音楽|原作|プロデューサー/.test(q.text); }).length, 0);

var levels = quiz.map(function(q){ return q.level; });
eq("易しい順に並ぶ", levels.slice().sort(), levels);
eq("基本が3問", levels.filter(function(l){ return l === 1; }).length, 3);
eq("制作が4問", levels.filter(function(l){ return l === 2; }).length, 4);
eq("各話が3問", levels.filter(function(l){ return l === 3; }).length, 3);

var ids = quiz.map(function(q){ return q.id; });
eq("同じ設問を二度出さない", ids.length, new Set(ids).size);
eq("設問文も重複しない", quiz.length, new Set(quiz.map(function(q){ return q.text; })).size);

/* 生成された問題そのものの健全性 */
quiz.forEach(function(q){
  ok(q.id + ": 選択肢は4つ", q.choices.length === 4, JSON.stringify(q.choices));
  ok(q.id + ": 正解の番号が範囲内", q.answer >= 0 && q.answer < 4, q.answer);
  ok(q.id + ": 選択肢が重複しない", new Set(q.choices).size === 4, JSON.stringify(q.choices));
  ok(q.id + ": 選択肢が空でない", q.choices.every(function(c){ return c && c.length; }));
  ok(q.id + ": 解説がある", !!q.why && q.why.length > 3, q.why);
});

/* 役名と俳優の対応が、材料どおりになっているか */
function roleOf(name){
  var hit = CHARS.filter(function(c){ return c.actor === name; })[0];
  return hit ? hit.role : null;
}
quiz.forEach(function(q){
  var m = q.text.match(/で (.+?) を演じたのは？$/);
  if(m) ok("役 " + m[1] + " の正解が合っている",
           roleOf(q.choices[q.answer]) === m[1], q.choices[q.answer]);
  var m2 = q.text.match(/で (.+?) が演じたのは？$/);
  if(m2) ok("俳優 " + m2[1] + " の正解が合っている",
            roleOf(m2[1]) === q.choices[q.answer], q.choices[q.answer]);
});

/* サブタイトルの正解が実際の話数と合っているか */
quiz.forEach(function(q){
  var m = q.text.match(/第(\d+)話のサブタイトルは？$/);
  if(m) eq("第" + m[1] + "話の題", q.choices[q.answer], SUBS[+m[1] - 1]);
});

/* 40通り試して、どの種でも壊れないこと */
for(var seed = 1; seed <= 40; seed++){
  var g = box.buildQuiz(FULL, seed * 7919);
  ok("種" + seed + ": 10問そろう", g.length === 10, g.length);
  ok("種" + seed + ": 設問が重複しない",
     new Set(g.map(function(q){ return q.text; })).size === 10);
  ok("種" + seed + ": 全問が中身の問題",
     g.every(function(q){ return q.tier === "content"; }));
  g.forEach(function(q){
    ok("種" + seed + ": 選択肢が4つで重複しない",
       q.choices.length === 4 && new Set(q.choices).size === 4, JSON.stringify(q.choices));
  });
}

/* 同じ種なら同じ問題 */
eq("種が同じなら同じ出題",
   box.buildQuiz(FULL, 777).map(function(q){ return q.text + "/" + q.answer; }),
   box.buildQuiz(FULL, 777).map(function(q){ return q.text + "/" + q.answer; }));
ok("種が違えば出題も変わる",
   JSON.stringify(box.buildQuiz(FULL, 1).map(function(q){ return q.text; }))
   !== JSON.stringify(box.buildQuiz(FULL, 99999).map(function(q){ return q.text; })));

/* 登場人物が取れない作品では、事実の問題で数を補う */
var NOCHAR = box.makeWork("登場人物の無いドラマ", "u", INFO, MANY, []);
var nq = box.buildQuiz(NOCHAR, 5);
ok("人物が無くても10問そろう", nq.length === 10, nq.length);
ok("サブタイトルの問題は残る",
   nq.filter(function(q){ return q.tier === "content"; }).length >= 5,
   nq.filter(function(q){ return q.tier === "content"; }).length);

/* 半沢直樹のようにサブタイトルが無い作品 */
var NOSUB = box.makeWork("半沢直樹", "u",
  {"放送局":"TBS系列","放送期間":"2013年7月7日 - 9月22日","回数":"全10話",
   "出演者":"堺雅人、上戸彩、及川光博、片岡愛之助"},
  [1,2,3,4,5,6,7,8,9,10].map(function(n){
    return { no:"第" + n + "話", date:"2013年7月" + n + "日", subtitle:"", rating:(19 + n) + "%" };
  }),
  [{role:"半沢直樹",actor:"堺雅人"},{role:"花",actor:"上戸彩"},
   {role:"渡真利忍",actor:"及川光博"},{role:"黒崎駿一",actor:"片岡愛之助"}]);
var sq = box.buildQuiz(NOSUB, 9);
ok("サブタイトルが無くても出題できる", sq.length >= 5, sq.length);
ok("空のサブタイトルを問題にしない",
   sq.every(function(q){ return !/サブタイトル/.test(q.text) && !/^「」/.test(q.text); }),
   sq.map(function(q){ return q.text; }).join(" / "));
ok("役名の問題は出る",
   sq.some(function(q){ return /演じたのは？$/.test(q.text); }));

/* 主人公の役名が作品名と同じでも落とさない。続編の見出しだけ落とす */
eq("作品名と同じ役名は残す", NOSUB.characters.map(function(c){ return c.role; }).indexOf("半沢直樹") >= 0, true);
eq("続編の見出しは人物欄から落とす",
   box.makeWork("半沢直樹","u",{"脚本":"八津弘幸、半沢直樹II"},[],[]).writers, ["八津弘幸"]);

/* 材料が乏しい作品でも落ちない */
var THIN = box.makeWork("情報の少ないドラマ", "u", { "放送局":"NHK", "放送期間":"2001年4月1日" }, [], []);
var thinQuiz = box.buildQuiz(THIN, 5);
ok("材料が乏しくても落ちない", Array.isArray(thinQuiz), thinQuiz && thinQuiz.length);
ok("作れる問題だけに絞られる", thinQuiz.length < 10, thinQuiz.length);
thinQuiz.forEach(function(q){
  ok("乏しい作品でも選択肢は4つ", q.choices.length === 4, JSON.stringify(q.choices));
});
eq("何も無ければ0問", box.buildQuiz(box.makeWork("空","u",{},[],[]), 3).length, 0);

/* 見知らぬ局では局の問題を出さない */
var ODD = box.makeWork("海外版", "u",
  {"放送局":"テレビ朝鮮","放送期間":"2012年2月20日","回数":"全20話"}, [], []);
ok("名寄せできない局は出題しない",
   box.buildQuiz(ODD, 3).every(function(q){ return !/放送したのは/.test(q.text); }));

/* ---- 採点 ---- */
var Q = [{level:1,answer:0},{level:1,answer:1},{level:2,answer:2},{level:3,answer:3}];
eq("全問正解で満点", box.grade(Q, [0,1,2,3]).score, 1 + 1 + 2 + 3);
eq("満点の値", box.grade(Q, [0,1,2,3]).full, 7);
eq("全問不正解で0点", box.grade(Q, [1,0,0,0]).score, 0);
eq("難問だけ当てると重い", box.grade(Q, [1,0,0,3]).score, 3);
eq("易問だけだと軽い", box.grade(Q, [0,1,0,0]).score, 2);
eq("正解数は重みと別に数える", box.grade(Q, [0,1,0,0]).hits, 2);
eq("層ごとの内訳", box.grade(Q, [0,1,2,0]).per[2], {got:2, full:2});
eq("出題が無ければ割合は0", box.grade([], []).ratio, 0);

/* ---- 称号 ---- */
eq("満点は制作陣", box.rankOf(1).name, "制作陣");
eq("9割はガチ勢", box.rankOf(0.9).name, "ガチ勢");
eq("7割ちょうどはリアタイ勢", box.rankOf(0.7).name, "リアタイ勢");
eq("5割は見てた人", box.rankOf(0.5).name, "見てた人");
eq("3割はうろ覚え", box.rankOf(0.3).name, "うろ覚え");
eq("0点はにわか", box.rankOf(0).name, "にわか");
ok("称号にはひとこと添える", box.rankOf(0.6).blurb.length > 5);

console.log((fail ? "FAIL" : "PASS") + "  " + pass + " 件通過" + (fail ? " / " + fail + " 件失敗" : ""));
process.exit(fail ? 1 : 0);
