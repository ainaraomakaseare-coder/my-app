/*
 * 勝敗判定・集計・選手分析のロジックを index.html から直接読み出して検証する。
 * 実行: node test/logic.test.js
 */
var fs = require("fs"), path = require("path"), vm = require("vm");

var html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
var js = html.split("<script>")[1].split("</script>")[0];
var src = js.slice(js.indexOf("var LOGIC_MARK_START"), js.indexOf("var LOGIC_MARK_END = 1;") + "var LOGIC_MARK_END = 1;".length);
var box = {};
vm.runInNewContext(src, box);

var pass = 0, fail = 0;
function eq(label, got, want){
  if(JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log("NG  " + label + "\n    got  " + JSON.stringify(got) + "\n    want " + JSON.stringify(want)); }
}

/* ---- 勝敗判定 ---- */
eq("5-3 は勝ち", box.computeResult(5, 3), "win");
eq("2-4 は負け", box.computeResult(2, 4), "lose");
eq("3-3 は引き分け", box.computeResult(3, 3), "draw");
eq("スコア未入力は null", box.computeResult(null, null), null);
eq("片方だけ未入力は null", box.computeResult(5, ""), null);
eq("文字列でも数値として判定", box.computeResult("5", "3"), "win");

/* ---- 年度抽出 ---- */
eq("日付から年を取る", box.yearOf("2025-04-12"), 2025);
eq("空文字は null", box.yearOf(""), null);

/* ---- シーズン成績集計 ---- */
var games = [
  box.normalizeGame({id:"a", date:"2025-04-01", opponent:"巨人", score:{bay:5, opp:3}}),
  box.normalizeGame({id:"b", date:"2025-04-05", opponent:"阪神", score:{bay:1, opp:2}}),
  box.normalizeGame({id:"c", date:"2025-05-01", opponent:"広島", score:{bay:4, opp:4}}),
  box.normalizeGame({id:"d", date:"2024-09-01", opponent:"中日", result:"win"}),
];
var stats2025 = box.seasonStats(games, 2025);
eq("2025年は3試合", stats2025.played, 3);
eq("2025年は1勝1敗1分", [stats2025.win, stats2025.lose, stats2025.draw], [1, 1, 1]);
eq("勝率は勝敗のみで計算", stats2025.winRate, 0.5);

var statsAll = box.seasonStats(games, null);
eq("全期間は4試合", statsAll.played, 4);
eq("resultだけ手入力した試合も数える", statsAll.win, 2);

eq("年の一覧は新しい順", box.listYears(games), [2025, 2024]);

/* ---- 選手分析の集計 ---- */
var playerGames = [
  box.normalizeGame({id:"a", date:"2025-04-01", opponent:"巨人", mvpPlayer:"牧秀悟", mvpNote:"満塁弾",
    notablePlayers:[{name:"佐野恵太", note:"2安打"}]}),
  box.normalizeGame({id:"b", date:"2025-04-05", opponent:"阪神", mvpPlayer:"牧秀悟", mvpNote:"猛打賞",
    notablePlayers:[{name:"宮﨑敏郎", note:"3安打"}]}),
  box.normalizeGame({id:"c", date:"2025-05-01", opponent:"広島", notablePlayers:[{name:"佐野恵太", note:"本塁打"}]}),
];
var tally = box.playerTally(playerGames, null);
eq("MVP2回の選手が1位", tally[0].name, "牧秀悟");
eq("MVPは2ptで計算される", tally[0].score, 4);
eq("活躍2回の選手のポイント", tally.filter(function(p){ return p.name === "佐野恵太"; })[0].score, 2);
eq("MVP回数と活躍回数が別集計", [tally[0].mvpCount, tally[0].notableCount], [2, 0]);
eq("試合ごとのメモが残る", tally[0].games.map(function(g){ return g.note; }), ["満塁弾", "猛打賞"]);
eq("年で絞り込める", box.playerTally(playerGames, 2024).length, 0);

console.log("\n" + pass + " 件 通過 / " + fail + " 件 失敗");
process.exit(fail ? 1 : 0);
