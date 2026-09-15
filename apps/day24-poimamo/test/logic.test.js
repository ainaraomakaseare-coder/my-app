/*
 * 失効判定・並び替え・入力チェック・AI結果の取り込みロジックを
 * index.html から直接読み出して検証する。
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
function ok(label, cond, extra){
  if(cond) pass++;
  else { fail++; console.log("NG  " + label + (extra !== undefined ? "\n    " + extra : "")); }
}

/* ---- daysUntil / urgencyOf ---- */
eq("同じ日は0日", box.daysUntil("2026-04-10", "2026-04-10"), 0);
eq("翌日は1日", box.daysUntil("2026-04-11", "2026-04-10"), 1);
eq("過去の日付は負の数", box.daysUntil("2026-04-01", "2026-04-10"), -9);
eq("失効日なしはnull", box.daysUntil("", "2026-04-10"), null);

eq("失効日なしはnone", box.urgencyOf({ expiryDate: "" }, "2026-04-10"), "none");
eq("失効済みはexpired", box.urgencyOf({ expiryDate: "2026-04-01" }, "2026-04-10"), "expired");
eq("7日後はdanger", box.urgencyOf({ expiryDate: "2026-04-17" }, "2026-04-10"), "danger");
eq("8日後はwarning", box.urgencyOf({ expiryDate: "2026-04-18" }, "2026-04-10"), "warning");
eq("30日後はwarning", box.urgencyOf({ expiryDate: "2026-05-10" }, "2026-04-10"), "warning");
eq("31日後はok", box.urgencyOf({ expiryDate: "2026-05-11" }, "2026-04-10"), "ok");

/* ---- sortEntries ---- */
var entries = [
  { id: "a", expiryDate: "2026-05-01", createdAt: "2026-01-01" },
  { id: "b", expiryDate: "2026-04-01", createdAt: "2026-01-02" },
  { id: "c", expiryDate: "", createdAt: "2026-01-03" },
  { id: "d", expiryDate: "", createdAt: "2026-01-04" },
];
var sorted = box.sortEntries(entries, "2026-04-10").map(function(e){ return e.id; });
eq("失効日が近い順、失効日なしは最後（新しい順）", sorted, ["b", "a", "d", "c"]);

/* ---- summarize ---- */
var sumEntries = [
  { balance: 100, expiryDate: "2026-04-01" },  // expired
  { balance: 200, expiryDate: "2026-04-15" },  // danger
  { balance: 300, expiryDate: "2026-06-01" },  // ok
  { balance: 50, expiryDate: "" },             // none
];
var summary = box.summarize(sumEntries, "2026-04-10");
eq("失効済み件数", summary.expiredCount, 1);
eq("30日以内件数", summary.soonCount, 1);
eq("合計ポイント", summary.totalBalance, 650);

/* ---- displayProgram ---- */
eq("既知サービスはそのまま", box.displayProgram({ program: "楽天ポイント" }), "楽天ポイント");
eq("その他はカスタム名", box.displayProgram({ program: "その他", customProgramName: "スタバカード" }), "スタバカード");
eq("その他で未入力ならその他", box.displayProgram({ program: "その他", customProgramName: "" }), "その他");

/* ---- validateEntry ---- */
ok("正常な期間限定は valid", box.validateEntry({ program: "楽天ポイント", pointType: "期間限定", balance: "100", expiryDate: "2026-04-01" }).valid);
ok("正常な通常ポイント（失効日なし）は valid", box.validateEntry({ program: "楽天ポイント", pointType: "通常", balance: "100", expiryDate: "" }).valid);
ok("期間限定で失効日なしはエラー", !box.validateEntry({ program: "楽天ポイント", pointType: "期間限定", balance: "100", expiryDate: "" }).valid);
ok("その他でカスタム名なしはエラー", !box.validateEntry({ program: "その他", pointType: "通常", balance: "100" }).valid);
ok("残高が負はエラー", !box.validateEntry({ program: "楽天ポイント", pointType: "通常", balance: "-1" }).valid);
ok("残高が空はエラー", !box.validateEntry({ program: "楽天ポイント", pointType: "通常", balance: "" }).valid);
ok("日付形式が不正はエラー", !box.validateEntry({ program: "楽天ポイント", pointType: "期間限定", balance: "1", expiryDate: "2026/04/01" }).valid);

/* ---- normalizeEntry ---- */
var n1 = box.normalizeEntry({ program: " 楽天ポイント ", pointType: "期間限定", balance: "12.7", expiryDate: "2026-04-01", memo: " 覚え書き " }, null, "2026-01-01T00:00:00.000Z");
eq("トリムされる", n1.program, "楽天ポイント");
eq("残高は四捨五入", n1.balance, 13);
eq("メモもトリム", n1.memo, "覚え書き");
ok("idが発行される", typeof n1.id === "string" && n1.id.length > 0);
eq("createdAtがnow", n1.createdAt, "2026-01-01T00:00:00.000Z");

var existing = { id: "keep-id", createdAt: "2020-01-01T00:00:00.000Z" };
var n2 = box.normalizeEntry({ program: "Vポイント", pointType: "通常", balance: "5" }, existing, "2026-02-01T00:00:00.000Z");
eq("既存のidを保持", n2.id, "keep-id");
eq("既存のcreatedAtを保持", n2.createdAt, "2020-01-01T00:00:00.000Z");
eq("updatedAtは更新される", n2.updatedAt, "2026-02-01T00:00:00.000Z");

/* ---- parseJapaneseDate ---- */
eq("和暦っぽい表記をISOに", box.parseJapaneseDate("2026年3月31日"), "2026-03-31");
eq("スラッシュ区切りもISOに", box.parseJapaneseDate("2026/3/31"), "2026-03-31");
eq("読めない文字列はnull", box.parseJapaneseDate("失効日不明"), null);
eq("空はnull", box.parseJapaneseDate(""), null);

/* ---- mapAiResult ---- */
var mapped1 = box.mapAiResult({ program: "楽天ポイント", pointType: "期間限定", balance: 1234, expiryDate: "2026-03-31", confidence: "high" });
eq("既知サービスはそのまま反映", mapped1.program, "楽天ポイント");
eq("残高が反映される", mapped1.balance, 1234);
eq("失効日が反映される", mapped1.expiryDate, "2026-03-31");

var mapped2 = box.mapAiResult({ program: "謎のポイント", pointType: "通常", balance: null, expiryDate: "2026年4月1日", confidence: "low" });
eq("未知サービスはその他扱い", mapped2.program, "その他");
eq("元の名前がカスタム名に入る", mapped2.customProgramName, "謎のポイント");
eq("balanceがnullなら空文字", mapped2.balance, "");
eq("和暦っぽい日付もISOに変換", mapped2.expiryDate, "2026-04-01");

eq("AI結果がnullならnull", box.mapAiResult(null), null);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
