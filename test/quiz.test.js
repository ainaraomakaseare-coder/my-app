/*
 * ドラマ検定の、通信にも DOM にも依らない部分を drama/index.html から
 * そのまま切り出して検証する。
 * 実行: node test/quiz.test.js
 */
var fs = require("fs"), path = require("path"), vm = require("vm");

var html = fs.readFileSync(path.join(__dirname, "..", "drama", "index.html"), "utf8");
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
/* 各話を多めに与えて、難問まで作れる作品にする */
var MANY = [];
for(var i = 1; i <= 11; i++){
  MANY.push({ no:"第" + i + "話", date:"2016年10月" + (4 + i) + "日",
              subtitle:"第" + i + "話のサブタイトル", rating:(9 + i * 0.4).toFixed(1) + "%" });
}
var FULL = box.makeWork("逃げるは恥だが役に立つ", "https://ja.wikipedia.org/wiki/x", INFO, MANY);
var quiz = box.buildQuiz(FULL, 12345);

eq("10問そろう", quiz.length, 10);

var levels = quiz.map(function(q){ return q.level; });
eq("易しい順に並ぶ", levels.slice().sort(), levels);
eq("基本が3問", levels.filter(function(l){ return l === 1; }).length, 3);
eq("制作が4問", levels.filter(function(l){ return l === 2; }).length, 4);
eq("各話が3問", levels.filter(function(l){ return l === 3; }).length, 3);

var ids = quiz.map(function(q){ return q.id; });
eq("同じテンプレは使い回さない", ids.length, new Set(ids).size);
ok("出演者を問う設問は1問だけ",
   ids.filter(function(id){ return id === "cast1" || id === "cast2"; }).length <= 1, ids.join(","));

/* 種を変えても、同系統が二重に出ることはない */
for(var s = 1; s <= 40; s++){
  var g = box.buildQuiz(FULL, s * 7919).map(function(q){ return q.id; });
  ok("種" + s + ": 出演者の設問は重ならない",
     g.filter(function(id){ return id === "cast1" || id === "cast2"; }).length <= 1, g.join(","));
}

/* 生成された問題そのものの健全性。ここが崩れると出題が成り立たない */
quiz.forEach(function(q){
  ok(q.id + ": 選択肢は4つ", q.choices.length === 4, JSON.stringify(q.choices));
  ok(q.id + ": 正解の番号が範囲内", q.answer >= 0 && q.answer < 4, q.answer);
  ok(q.id + ": 選択肢が重複しない", new Set(q.choices).size === 4, JSON.stringify(q.choices));
  ok(q.id + ": 選択肢が空でない", q.choices.every(function(c){ return c && c.length; }));
  ok(q.id + ": 設問に作品名が入る", /逃げるは恥だが役に立つ|サブタイトル/.test(q.text), q.text);
  ok(q.id + ": 解説がある", !!q.why && q.why.length > 3, q.why);
});

/* 正解が本当に正しいかを、材料から突き合わせる */
function find(id){ return quiz.filter(function(q){ return q.id === id; })[0]; }
var qs = find("station");
if(qs) eq("放送局の正解はTBS", qs.choices[qs.answer], "TBS");
var qy = find("year");
if(qy) eq("放送年の正解は2016年", qy.choices[qy.answer], "2016年");
var qc = find("count");
if(qc) eq("話数の正解は11話", qc.choices[qc.answer], "11話");
var qw = find("writer");
if(qw) eq("脚本の正解は野木亜紀子", qw.choices[qw.answer], "野木亜紀子");
var qn = find("notcast");
if(qn) ok("出ていない人の正解は出演者に無い", FULL.cast.indexOf(qn.choices[qn.answer]) < 0, qn.choices[qn.answer]);
var qt = find("toprating");
if(qt) eq("最高視聴率は最終話", qt.choices[qt.answer], "第11話");

/* 同じ種なら同じ問題。結果を再現できる */
eq("種が同じなら同じ出題",
   box.buildQuiz(FULL, 777).map(function(q){ return q.id + "/" + q.answer; }),
   box.buildQuiz(FULL, 777).map(function(q){ return q.id + "/" + q.answer; }));
ok("種が違えば出題も変わる",
   JSON.stringify(box.buildQuiz(FULL, 1).map(function(q){ return q.id; }))
   !== JSON.stringify(box.buildQuiz(FULL, 99999).map(function(q){ return q.id; })));

/* 材料が乏しい作品でも、落ちずに作れるぶんだけ返す */
var THIN = box.makeWork("情報の少ないドラマ", "u", { "放送局":"NHK", "放送期間":"2001年4月1日" }, []);
var thinQuiz = box.buildQuiz(THIN, 5);
ok("材料が乏しくても落ちない", Array.isArray(thinQuiz), thinQuiz && thinQuiz.length);
ok("作れる問題だけに絞られる", thinQuiz.length < 10, thinQuiz.length);
thinQuiz.forEach(function(q){
  ok("乏しい作品でも選択肢は4つ", q.choices.length === 4, JSON.stringify(q.choices));
});
eq("何も無ければ0問", box.buildQuiz(box.makeWork("空","u",{},[]), 3).length, 0);

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
