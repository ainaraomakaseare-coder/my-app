/*
 * 輸入ブラックジャックの勝敗判定と手札のバリデーションを
 * index.html から直接読み出して検証する。
 * 実行: node test/bj.rules.test.js
 */
var fs = require("fs"), path = require("path"), vm = require("vm");

var html = fs.readFileSync(path.join(__dirname, ".." , "index.html"), "utf8");
var js = html.split("<script>")[1].split("</scr" + "ipt>")[0];
var END = "var RULES_END = true;";
var src = js.slice(js.indexOf("var GOAL = 21;"), js.indexOf(END) + END.length);
var box = {};
vm.runInNewContext(src, box);

var judge = box.judge, total = box.total, cmp = box.compareByCard;
var canConfirm = box.canConfirm, selErr = box.selectionError, buildDeck = box.buildDeck;

var pass = 0, fail = 0;
function eq(label, got, want){
  if(JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log("NG  " + label + "\n    got  " + JSON.stringify(got) + "\n    want " + JSON.stringify(want)); }
}
function j(a, b){ var v = judge(a, b); return [v.winner, v.type]; }

/* ---- 札の構成 ---- */
var red = buildDeck("RED"), black = buildDeck("BLACK");
eq("赤は二十枚", red.length, 20);
eq("黒は二十枚", black.length, 20);
eq("四十枚に重複はない",
   new Set(red.concat(black).map(function(c){ return c.id; })).size, 40);
eq("赤は 1〜10 が二枚ずつ",
   [1,2,3,4,5,6,7,8,9,10].map(function(n){
     return red.filter(function(c){ return c.n === n; }).length;
   }), [2,2,2,2,2,2,2,2,2,2]);
eq("赤のスートは ♥ ♦ だけ",
   Array.from(new Set(red.map(function(c){ return c.suit; }))).sort(), ["DIAMOND","HEART"]);
eq("黒のスートは ♠ ♣ だけ",
   Array.from(new Set(black.map(function(c){ return c.suit; }))).sort(), ["CLUB","SPADE"]);
eq("赤と黒の数字の構成はまったく同じ",
   red.map(function(c){ return c.n; }).sort(function(a,b){ return a-b; }),
   black.map(function(c){ return c.n; }).sort(function(a,b){ return a-b; }));
eq("A は 1 として数える", total([1,2,3,4]), 10);

/* ---- 双方21以下 ---- */
eq("20 対 19 は 20 の勝ち",            j([4,5,5,6], [3,4,5,7]), [0, "sum"]);
eq("19 対 20 は後手の勝ち",            j([3,4,5,7], [4,5,5,6]), [1, "sum"]);
eq("21 ちょうどは 20 に勝つ",          j([10,9,1,1], [4,5,5,6]), [0, "sum"]);

/* ---- 片方だけバースト ---- */
eq("23 対 18 はバーストした方の負け",  j([10,9,3,1], [10,5,2,1]), [1, "burst"]);
eq("18 対 23 は先手の勝ち",            j([10,5,2,1], [10,9,3,1]), [0, "burst"]);
eq("22 は 1 でもバースト",             j([10,10,1,1], [1,1,1,1]), [1, "burst"]);

/* ---- 両者バースト（21との差が小さい方の勝ち） ---- */
eq("22 対 25 は 22 の勝ち",            j([10,10,1,1], [10,10,4,1]), [0, "closer"]);
eq("25 対 22 は後手の勝ち",            j([10,10,4,1], [10,10,1,1]), [1, "closer"]);

/* ---- 同点はカード比較（バーストしていても向きは同じ） ---- */
eq("21 同士なら最大札の大きい方",      j([10,9,1,1], [8,7,5,1]), [0, "cards"]);
eq("最大札が同じなら二番目",           j([10,8,2,1], [10,7,3,1]), [0, "cards"]);
eq("三番目まで同じなら四番目",         j([10,6,4,1], [10,6,3,2]), [0, "cards"]);
eq("両者バーストで合計も同じならカード比較",
   j([10,10,2,1], [9,8,5,1]), [0, "cards"]);
eq("バースト時も比較は反転しない",     j([9,8,5,1], [10,10,2,1]), [1, "cards"]);
eq("四枚とも同じなら引き分け",         j([10,9,1,1], [1,9,1,10]), [-1, "draw"]);
eq("並び順は勝敗に関係しない",         j([1,10,1,9], [9,1,10,1]), [-1, "draw"]);

/* ---- カード比較そのもの ---- */
eq("compareByCard は並び順に依存しない", [cmp([3,9,1,8], [8,1,9,3]), cmp([9,8,3,1], [8,9,1,3])], [0, 0]);
eq("compareByCard は強い方に 1",         cmp([10,1,1,1], [9,9,9,1]), 1);

/* ---- 手札選択のバリデーション ---- */
eq("四枚 21 は確定できる",       canConfirm([10,9,1,1]), true);
eq("四枚 22 は確定できない",     canConfirm([10,10,1,1]), false);
eq("三枚では確定できない",       canConfirm([10,9,1]), false);
eq("五枚では確定できない",       canConfirm([5,4,3,2,1]), false);
eq("四枚 22 で超過の警告",       selErr([10,10,1,1]), "合計が21を超えています");
eq("三枚のうちは警告しない",     selErr([10,10,1]), "");
eq("五枚は枚数の警告",           selErr([5,4,3,2,1]), "四枚を超えて選べません");

/* ---- 四枚 21 以下で組める最強手は 10・9・A・A ---- */
var hands = [];
(function walk(start, cur){
  if(cur.length === 4){ if(total(cur) <= 21) hands.push(cur.slice()); return; }
  for(var n = start; n <= 10; n++){
    if(cur.filter(function(x){ return x === n; }).length >= 2) continue;  /* 同じ数字は二枚まで */
    cur.push(n); walk(n, cur); cur.pop();
  }
})(1, []);
eq("四枚 21 以下の組み合わせが存在する", hands.length > 0, true);
var best = hands.reduce(function(a, b){ return judge(a, b).winner === 0 ? a : b; });
eq("最強手は 10・9・A・A", best.slice().sort(function(x,y){ return y-x; }), [10,9,1,1]);
eq("最強手はちょうど 21", total(best), 21);

/* ---- 総当たりで判定が矛盾しないこと ---- */
var sample = hands.filter(function(_, i){ return i % 7 === 0; });
var bad = 0;
sample.forEach(function(a){
  sample.forEach(function(b){
    var x = judge(a, b), y = judge(b, a);
    if(x.winner === -1){ if(y.winner !== -1) bad++; return; }
    if(y.winner === -1 || x.winner === y.winner) bad++;
    if(x.type !== y.type) bad++;
  });
});
eq("先手後手を入れ替えても判定は裏返るだけ（" + sample.length + " 手を総当たり）", bad, 0);

/* ---- バーストを含む総当たりでも引き分けは完全一致のときだけ ---- */
var wild = [[10,10,10,10],[10,10,9,9],[10,9,1,1],[1,1,1,1],[10,10,1,1],[9,8,5,1],[10,10,2,1]];
var drawPairs = 0;
wild.forEach(function(a){
  wild.forEach(function(b){
    if(judge(a, b).winner === -1){
      drawPairs++;
      var sa = a.slice().sort(), sb = b.slice().sort();
      eq("引き分けは四枚一致のときだけ " + JSON.stringify(a) + " " + JSON.stringify(b),
         JSON.stringify(sa), JSON.stringify(sb));
    }
  });
});
eq("引き分けは自分自身との比較 " + wild.length + " 組だけ", drawPairs, wild.length);

console.log("\n" + pass + " 件 通過 / " + fail + " 件 失敗");
process.exit(fail ? 1 : 0);
