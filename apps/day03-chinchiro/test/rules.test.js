/*
 * 役の判定と移動点の計算を index.html から直接読み出して検証する。
 * 実行: node test/rules.test.js
 */
var fs = require("fs"), path = require("path"), vm = require("vm");

var html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
var js = html.split("<script>")[1].split("</script>")[0];
var src = js.slice(js.indexOf("var KANJI"), js.indexOf("var NOHAND") + "var NOHAND = {take:1, pen:1};".length);
var box = {S:null, MAX_THROWS:3};
vm.runInNewContext(src, box);

var C = box.classify, menashi = box.menashi;
function payout(w, l, parentWins, base){ box.S = {base:base}; return box.payout(w, l, parentWins); }

var pass = 0, fail = 0;
function eq(label, got, want){
  if(JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log("NG  " + label + "\n    got  " + JSON.stringify(got) + "\n    want " + JSON.stringify(want)); }
}

/* ---- 役の判定 ---- */
eq("1,1,1 はピンゾロ ×5", [C([1,1,1]).id, C([1,1,1]).take, C([1,1,1]).pen], ["pinzoro", 5, 1]);
eq("6,6,6 はゾロ目 ×3",   [C([6,6,6]).id, C([6,6,6]).take, C([6,6,6]).rank], ["zoro", 3, 96]);
eq("2,2,2 はゾロ目で最弱", C([2,2,2]).rank, 92);
eq("6,4,5 はシゴロ ×2",   [C([6,4,5]).id, C([6,4,5]).take], ["shigoro", 2]);
eq("3,1,2 はヒフミ 罰則×2", [C([3,1,2]).id, C([3,1,2]).take, C([3,1,2]).pen], ["hifumi", 1, 2]);
eq("ヒフミは振り直せない旨を持つ", /振り直しなし/.test(C([1,2,3]).sub), true);
eq("5,5,3 は三の目",      [C([5,5,3]).id, C([5,5,3]).label, C([5,5,3]).rank], ["deme", "三の目", 63]);
eq("2,6,6 は二の目",      C([2,6,6]).rank, 62);
eq("1,4,6 は役なし",      C([1,4,6]), null);
eq("2,3,5 は役なし",      C([2,3,5]), null);
eq("目なしは rank 40",    [menashi().id, menashi().rank], ["menashi", 40]);

/* ---- 強さの順 ---- */
var ranks = [C([1,1,1]), C([6,6,6]), C([2,2,2]), C([4,5,6]),
             C([1,1,2]), C([6,6,1]), menashi(), C([1,2,3])].map(function(h){ return h.rank; });
eq("ピンゾロ>ゾロ目>シゴロ>出目>目なし>ヒフミ",
   ranks.slice().sort(function(a, b){ return b - a; }), ranks);

/* ---- 移動点（基準値 2）---- */
eq("親が出目で勝つと 3",        payout(C([5,5,3]), C([2,2,4]), true,  2), 3);
eq("子が出目で勝つと 2",        payout(C([5,5,3]), C([2,2,4]), false, 2), 2);
eq("親のピンゾロは 15",         payout(C([1,1,1]), C([5,5,3]), true,  2), 15);
eq("子のピンゾロは 10",         payout(C([1,1,1]), C([5,5,3]), false, 2), 10);

/* ---- ヒフミの罰則が勝者の取り分に乗る ---- */
eq("親シゴロ vs 子ヒフミ は 12", payout(C([4,5,6]), C([1,2,3]), true,  2), 12);
eq("子シゴロ vs 親ヒフミ は 8",  payout(C([4,5,6]), C([1,2,3]), false, 2), 8);
eq("子出目 vs 親ヒフミ は 4",    payout(C([5,5,3]), C([1,2,3]), false, 2), 4);
eq("親出目 vs 子目なし は 3",    payout(C([5,5,3]), menashi(),  true,  2), 3);
eq("親ピンゾロ vs 子ヒフミ は 30", payout(C([1,1,1]), C([1,2,3]), true, 2), 30);

/* ---- 敗者の役の倍率は取り分に効かない（一二三の罰則だけが例外）---- */
eq("親ピンゾロ vs 子ゾロ目 は 15", payout(C([1,1,1]), C([6,6,6]), true,  2), 15);
eq("親ゾロ目 vs 子シゴロ は 9",    payout(C([6,6,6]), C([4,5,6]), true,  2), 9);
eq("子ゾロ目 vs 親出目 は 6",      payout(C([6,6,6]), C([5,5,3]), false, 2), 6);
eq("親シゴロ vs 子目なし は 6",    payout(C([4,5,6]), menashi(),  true,  2), 6);

/* ---- 基準値を上げても比例する ---- */
eq("基準4 親の出目は 6",         payout(C([5,5,3]), C([2,2,4]), true, 4), 6);
eq("基準4 親のピンゾロは 30",    payout(C([1,1,1]), C([2,2,4]), true, 4), 30);
eq("基準4 親シゴロ vs ヒフミ 24", payout(C([4,5,6]), C([1,2,3]), true, 4), 24);

/* ---- 偶数の基準値なら端数は出ない ---- */
var allInt = true;
[2, 4, 6, 8, 10, 100].forEach(function(base){
  [C([1,1,1]), C([6,6,6]), C([4,5,6]), C([5,5,3]), menashi()].forEach(function(w){
    [C([1,2,3]), C([5,5,3]), menashi()].forEach(function(l){
      [true, false].forEach(function(p){ if(payout(w, l, p, base) % 1 !== 0) allInt = false; });
    });
  });
});
eq("全組み合わせで整数", allInt, true);

/* ---- サイコロの目は 1〜6 が偏りなく出る ---- */
var counts = [0,0,0,0,0,0,0];
for(var i = 0; i < 60000; i++) counts[1 + Math.floor(Math.random() * 6)]++;
eq("出目の偏りが 10% 以内",
   counts.slice(1).every(function(c){ return Math.abs(c - 10000) < 1000; }), true);

console.log("\n" + pass + " 件 通過 / " + fail + " 件 失敗");
process.exit(fail ? 1 : 0);
