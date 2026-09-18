/*
 * 失効判定・グルーピング・入力チェック・AI複数内訳の取り込みロジックを
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

/* ---- badgeLetterFor ---- */
eq("既知サービスは決め打ちの略称", box.badgeLetterFor({ program: "ANAマイレージ", key: "ANAマイレージ" }), "ANA");
eq("その他は名前の先頭2文字", box.badgeLetterFor({ program: "その他", key: "スタバカード" }), "スタ");

/* ---- グルーピング：1サービスが複数の内訳（lot）を持てる ---- */
var lots = [
  { id: "a", program: "楽天ポイント", customProgramName: "", pointType: "期間限定", balance: 100, expiryDate: "2026-08-30", createdAt: "2026-01-01" },
  { id: "b", program: "楽天ポイント", customProgramName: "", pointType: "期間限定", balance: 10, expiryDate: "2026-09-30", createdAt: "2026-01-02" },
  { id: "c", program: "楽天ポイント", customProgramName: "", pointType: "通常", balance: 1000, expiryDate: "", createdAt: "2026-01-03" },
  { id: "d", program: "Vポイント", customProgramName: "", pointType: "期間限定", balance: 500, expiryDate: "2026-08-01", createdAt: "2026-01-04" },
];
var groups = box.groupLots(lots);
eq("2サービスにグルーピングされる", groups.map(function(g){ return g.key; }), ["楽天ポイント", "Vポイント"]);
eq("楽天ポイントは3件の内訳を持つ", groups[0].lots.length, 3);
eq("楽天ポイントの合計残高", box.groupTotalBalance(groups[0]), 1110);
eq("楽天ポイントの直近失効ロットは8/30の100pt", box.groupNearestExpiryLot(groups[0]).id, "a");
eq("楽天ポイントの緊急度は最も近い失効日で決まる", box.groupUrgency(groups[0], "2026-08-25"), "danger");
eq("Vポイントの合計残高", box.groupTotalBalance(groups[1]), 500);

var gsummary = box.summarizeGroup(groups[0], "2026-08-25");
eq("楽天ポイント内訳の失効間近件数（8/30分の1件）", gsummary.soonCount, 1);
eq("楽天ポイント内訳の失効済み件数", gsummary.expiredCount, 0);

/* ---- sortGroups：失効日が近いサービスが先頭 ---- */
var sortedGroups = box.sortGroups(groups).map(function(g){ return g.key; });
eq("Vポイント（8/1）が楽天ポイント（8/30が最短）より先", sortedGroups, ["Vポイント", "楽天ポイント"]);

var noDateGroups = box.groupLots([
  { id: "x", program: "Amazonポイント", customProgramName: "", pointType: "通常", balance: 10, expiryDate: "" },
  { id: "y", program: "dポイント", customProgramName: "", pointType: "期間限定", balance: 20, expiryDate: "2026-09-01" },
]);
eq("失効日ありが失効日なしより先", box.sortGroups(noDateGroups).map(function(g){ return g.key; }), ["dポイント", "Amazonポイント"]);

/* ---- replaceGroupLots：サービス単位での置き換え ---- */
var newLots = [
  { id: "n1", program: "楽天ポイント", customProgramName: "", pointType: "通常", balance: 999, expiryDate: "" },
];
var replaced = box.replaceGroupLots(lots, "楽天ポイント", newLots);
eq("置き換え後は楽天ポイントの内訳が新しいものだけになる", replaced.filter(function(l){ return box.displayProgram(l) === "楽天ポイント"; }).map(function(l){ return l.id; }), ["n1"]);
eq("他サービス（Vポイント）は影響を受けない", replaced.filter(function(l){ return box.displayProgram(l) === "Vポイント"; }).length, 1);

/* ---- validateLotRow / validateLotRows ---- */
ok("期間限定＋失効日ありはvalid", box.validateLotRow({ pointType: "期間限定", balance: "100", expiryDate: "2026-08-30" }).valid);
ok("期間限定で失効日なしはエラー", !box.validateLotRow({ pointType: "期間限定", balance: "100", expiryDate: "" }).valid);
ok("通常は失効日なしでもvalid", box.validateLotRow({ pointType: "通常", balance: "100", expiryDate: "" }).valid);
ok("残高が空はエラー", !box.validateLotRow({ pointType: "通常", balance: "", expiryDate: "" }).valid);

var rowsResult = box.validateLotRows([
  { pointType: "期間限定", balance: "100", expiryDate: "2026-08-30" },
  { pointType: "期間限定", balance: "10", expiryDate: "2026-09-30" },
  { pointType: "通常", balance: "1000", expiryDate: "" },
]);
ok("3行とも正しければvalid", rowsResult.valid);
eq("空配列はエラー", box.validateLotRows([]).valid, false);

var badRows = box.validateLotRows([{ pointType: "期間限定", balance: "", expiryDate: "" }]);
ok("不正な行があればinvalid", !badRows.valid);
ok("firstErrorMessageがエラー文言を返す", box.firstErrorMessage(badRows.rowErrors[0]).length > 0);
eq("valid行はfirstErrorMessageが空文字", box.firstErrorMessage({ valid: true, errors: {} }), "");

/* ---- buildLotsFromRows ---- */
var built = box.buildLotsFromRows(
  [
    { pointType: "期間限定", balance: "100", expiryDate: "2026-08-30" },
    { pointType: "期間限定", balance: "10", expiryDate: "2026-09-30" },
    { pointType: "通常", balance: "1000", expiryDate: "" },
  ],
  "楽天ポイント", "", "screenshot", "2026-01-01T00:00:00.000Z"
);
eq("3件のロットが作られる", built.length, 3);
ok("それぞれに新しいidが振られる", built.every(function(l){ return typeof l.id === "string" && l.id.length > 0; }));
eq("すべて同じプログラム名になる", built.map(function(l){ return l.program; }), ["楽天ポイント", "楽天ポイント", "楽天ポイント"]);
eq("sourceがscreenshotになる", built[0].source, "screenshot");
eq("合計残高は1110", built.reduce(function(s,l){ return s + l.balance; }, 0), 1110);

/* ---- sanitizeAiLots / mapAiResult（AIの複数内訳レスポンスの取り込み） ---- */
var ai1 = {
  program: "楽天ポイント",
  lots: [
    { pointType: "期間限定", balance: 100, expiryDate: "2026-08-30" },
    { pointType: "期間限定", balance: 10, expiryDate: "2026年9月30日" },
    { pointType: "通常", balance: 1000, expiryDate: null },
  ],
  confidence: "high",
};
var sanitized1 = box.sanitizeAiLots(ai1);
eq("既知サービスはそのまま", sanitized1.program, "楽天ポイント");
eq("3件の内訳が取り込まれる", sanitized1.lots.length, 3);
eq("和暦っぽい日付もISOに変換される", sanitized1.lots[1].expiryDate, "2026-09-30");
eq("通常ポイントの失効日は空文字", sanitized1.lots[2].expiryDate, "");
eq("残高がそのまま反映される", sanitized1.lots.map(function(l){ return l.balance; }), [100, 10, 1000]);

var ai2 = { program: "謎のポイント", lots: [{ pointType: "通常", balance: null, expiryDate: "" }], confidence: "low" };
var sanitized2 = box.sanitizeAiLots(ai2);
eq("未知サービスはその他扱い", sanitized2.program, "その他");
eq("元の名前がカスタム名に入る", sanitized2.customProgramName, "謎のポイント");
eq("balanceがnullなら空文字", sanitized2.lots[0].balance, "");

eq("lotsが配列でなければnull", box.sanitizeAiLots({ program: "楽天ポイント", confidence: "high" }), null);
eq("AI結果自体がnullならnull", box.sanitizeAiLots(null), null);

/* ---- addDaysToDateStr / icsEscape / buildIcsContent（カレンダー登録） ---- */
eq("翌日になる", box.addDaysToDateStr("2026-08-30", 1), "2026-08-31");
eq("月をまたぐ", box.addDaysToDateStr("2026-08-31", 1), "2026-09-01");
eq("年をまたぐ", box.addDaysToDateStr("2026-12-31", 1), "2027-01-01");

eq("カンマをエスケープ", box.icsEscape("a,b"), "a\\,b");
eq("セミコロンをエスケープ", box.icsEscape("a;b"), "a\\;b");
eq("改行をエスケープ", box.icsEscape("a\nb"), "a\\nb");
eq("バックスラッシュをエスケープ", box.icsEscape("a\\b"), "a\\\\b");

var icsLot = { id: "lot1", balance: 100, expiryDate: "2026-08-30" };
var ics = box.buildIcsContent(icsLot, "楽天ポイント", "2026-08-01T00:00:00.000Z");
ok("VCALENDARで始まる", ics.indexOf("BEGIN:VCALENDAR") === 0);
ok("VEVENTを含む", ics.indexOf("BEGIN:VEVENT") !== -1);
ok("UIDにlotのidが入る", ics.indexOf("UID:lot1@poimamo") !== -1);
ok("DTSTARTが失効日", ics.indexOf("DTSTART;VALUE=DATE:20260830") !== -1);
ok("DTENDは失効日の翌日", ics.indexOf("DTEND;VALUE=DATE:20260831") !== -1);
ok("3日前にリマインドするVALARM", ics.indexOf("TRIGGER:-P3D") !== -1);
ok("サービス名と残高がSUMMARYに入る", ics.indexOf("楽天ポイント") !== -1 && ics.indexOf("100pt") !== -1);
ok("CRLFで終端する行がある", ics.indexOf("\r\n") !== -1);

/* 月だけの失効内訳を省略せず、月末を暦から計算する。 */
var months = box.sanitizeAiLots({program:"楽天ポイント", lots:[
  {pointType:"期間限定",balance:100,expiryDate:null,expiryMonth:"2026-07"},
  {pointType:"期間限定",balance:200,expiryDate:null,expiryMonth:"2026-08"},
  {pointType:"期間限定",balance:30,expiryDate:null,expiryMonth:"07"}
]}).lots;
eq("月別の3行を保持", months.length, 3);
eq("7月と8月の残高を保持", months.map(function(l){return l.balance;}), [100,200,30]);
eq("7月の末日", months[0].expiryDate, "2026-07-31");
eq("8月の末日", months[1].expiryDate, "2026-08-31");
eq("年不明は推測しない", months[2].expiryDate, "");
ok("年不明でも7月という情報を保持", months[2].memo.includes("7月失効"));
ok("年不明のまま保存できない", !box.validateLotRow(months[2]).valid);
eq("閏年2月", box.expiryMonthInfo("2028-02").date, "2028-02-29");
eq("平年2月", box.expiryMonthInfo("2027-02").date, "2027-02-28");
eq("30日までの月", box.expiryMonthInfo("2026-04").date, "2026-04-30");
eq("12月", box.expiryMonthInfo("2026-12").date, "2026-12-31");
["2026-00","2026-13","7月",{},null].forEach(function(v){eq("不正な月を拒否 "+JSON.stringify(v),box.expiryMonthInfo(v),null);});
eq("明記された日は月末に上書きしない",box.sanitizeLotFields({pointType:"期間限定",balance:10,expiryDate:"2026-07-15",expiryMonth:"2026-07"}).expiryDate,"2026-07-15");
ok("保存時も読み取った月のメモを保持",box.buildLotsFromRows([months[0]],"楽天ポイント","","screenshot")[0].memo.includes("7月失効"));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
