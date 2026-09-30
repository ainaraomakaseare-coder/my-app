/*
 * 分岐（自分だけの道）の入力チェック・権限判定の単体テスト（docs/adr/0021）。
 * 実行: node worker/test/branches.test.mjs
 */
import assert from "node:assert/strict";
import { hhmmToMinutes, timeRangesOverlap, validateBranchInput, validateBranchBlockPlacement, dateToDays, branchEndDateOf, canEditBranchBlock, canMoveEntryBetween } from "../src/branches.js";

let pass = 0, fail = 0;
function check(label, got, want) {
  try { assert.deepEqual(got, want); pass++; } catch {
    fail++;
    console.log("NG  " + label);
    console.log("    got  " + JSON.stringify(got));
    console.log("    want " + JSON.stringify(want));
  }
}

const ok = { date: "2026-10-01", startTime: "14:00", endTime: "17:00", title: "美術館" };

check("hhmmToMinutes", [hhmmToMinutes("00:00"), hhmmToMinutes("14:30"), hhmmToMinutes("24:00"), hhmmToMinutes("9:00"), hhmmToMinutes(null)], [0, 870, null, null, null]);
check("重なる", timeRangesOverlap("14:00", "17:00", "16:00", "18:00"), true);
check("包む", timeRangesOverlap("14:00", "17:00", "15:00", "16:00"), true);
check("隣り合うだけは重ならない", timeRangesOverlap("14:00", "15:00", "15:00", "16:00"), false);
check("離れている", timeRangesOverlap("09:00", "10:00", "15:00", "16:00"), false);

check("正しい入力", validateBranchInput(ok, []), "");
check("タイトル省略OK", validateBranchInput({ date: "2026-10-01", startTime: "09:00", endTime: "10:00" }, []), "");
check("日付なし", validateBranchInput({ ...ok, date: "" }, []), "invalid_date");
check("時刻の形式違い", validateBranchInput({ ...ok, startTime: "2pm" }, []), "invalid_time");
check("終わりが始まりと同じ", validateBranchInput({ ...ok, endTime: "14:00" }, []), "end_before_start");
check("終わりが始まりより前（日またぎは不可）", validateBranchInput({ ...ok, startTime: "22:00", endTime: "01:00" }, []), "end_before_start");
check("タイトルが長すぎる", validateBranchInput({ ...ok, title: "あ".repeat(101) }, []), "invalid_title");
check("入力がオブジェクトでない", validateBranchInput(null, []), "invalid_input");

const mine = [{ id: "br_1", date: "2026-10-01", start_time: "15:00", end_time: "16:00" }];
check("同じ人の分岐と重なる（DB行の形）", validateBranchInput(ok, mine), "overlap");
check("同じ人でも別の日なら重ならない", validateBranchInput({ ...ok, date: "2026-10-02" }, mine), "");
check("自分自身は除く（更新）", validateBranchInput(ok, mine, "br_1"), "");
check("画面側の形（startTime）でも比べられる", validateBranchInput(ok, [{ id: "x", date: "2026-10-01", startTime: "16:30", endTime: "18:00" }]), "overlap");
check("隣り合う分岐は作れる", validateBranchInput({ ...ok, startTime: "16:00", endTime: "17:00" }, mine), "");

check("みんなの予定は誰でも触れる", canEditBranchBlock("", "", ""), true);
check("持ち主は触れる", canEditBranchBlock("br_1", "111111", "111111"), true);
check("他の人は触れない", canEditBranchBlock("br_1", "111111", "222222"), false);
check("ログインしていないと触れない", canEditBranchBlock("br_1", "111111", ""), false);
check("持ち主が分からないときは触れない", canEditBranchBlock("br_1", "", "111111"), false);

check("同じ分岐の中は移せる", canMoveEntryBetween("br_1", "br_1"), true);
check("みんなの予定どうしは移せる", canMoveEntryBetween("", undefined), true);
check("分岐をまたぐ移動は不可", canMoveEntryBetween("br_1", ""), false);
check("別の分岐へも不可", canMoveEntryBetween("br_1", "br_2"), false);

// ---------- 日をまたぐ別行動 ----------
const multi = { date: "2026-06-27", endDate: "2026-06-28", startTime: "14:00", endTime: "12:00", title: "一泊" };
check("dateToDays: 実在しない日はnull", [dateToDays("2026-02-30"), dateToDays("2026-06-27") + 1 === dateToDays("2026-06-28"), dateToDays("x")], [null, true, null]);
check("branchEndDateOf: 空・無しは開始日、あれば終わりの日（DB行でも）", [
  branchEndDateOf({ date: "2026-06-27" }), branchEndDateOf({ date: "2026-06-27", end_date: "" }), branchEndDateOf({ date: "2026-06-27", end_date: "2026-06-28" }), branchEndDateOf(multi),
], ["2026-06-27", "2026-06-27", "2026-06-28", "2026-06-28"]);
check("日またぎは終わりの時刻が始まりより前でもよい", validateBranchInput(multi, []), "");
check("endDateが空なら1日として扱う（終わり<始まりはNG）", validateBranchInput({ ...multi, endDate: "" }, []), "end_before_start");
check("終わりの日が始まりの日より前", validateBranchInput({ ...multi, endDate: "2026-06-26" }, []), "end_before_start");
check("終わりの日の形式違い", validateBranchInput({ ...multi, endDate: "6/28" }, []), "invalid_date");
check("実在しない日付", validateBranchInput({ ...multi, date: "2026-02-30" }, []), "invalid_date");
check("同じ日で終わり=始まりはNG", validateBranchInput({ ...multi, endDate: "2026-06-27", endTime: "14:00" }, []), "end_before_start");
const tripRange = { tripStart: "2026-06-27", tripEnd: "2026-06-28" };
check("旅行の日程の中", validateBranchInput(multi, [], undefined, tripRange), "");
check("終わりの日が日程の外", validateBranchInput({ ...multi, endDate: "2026-06-29" }, [], undefined, tripRange), "date_out_of_range");
check("始まりの日が日程の外", validateBranchInput({ ...multi, date: "2026-06-26" }, [], undefined, tripRange), "date_out_of_range");
check("日程が空なら範囲は見ない", validateBranchInput({ ...multi, endDate: "2030-01-01" }, [], undefined, { tripStart: "", tripEnd: "" }), "");
const mineMulti = [{ id: "br_m", date: "2026-06-27", end_date: "2026-06-28", start_time: "14:00", end_time: "12:00" }];
check("日またぎと重なる（途中の日）", validateBranchInput({ date: "2026-06-28", startTime: "01:00", endTime: "02:00" }, mineMulti), "overlap");
check("日またぎと重なる（始まりの日の開始後）", validateBranchInput({ date: "2026-06-27", startTime: "20:00", endTime: "23:00" }, mineMulti), "overlap");
check("日またぎと重ならない（開始前）", validateBranchInput({ date: "2026-06-27", startTime: "09:00", endTime: "14:00" }, mineMulti), "");
check("日またぎと重ならない（終了ちょうどから）", validateBranchInput({ date: "2026-06-28", startTime: "12:00", endTime: "13:00" }, mineMulti), "");
check("日またぎ2つで、片方の終わりがもう片方の始まりを越える", validateBranchInput({ date: "2026-06-28", endDate: "2026-06-29", startTime: "11:00", endTime: "10:00" }, mineMulti), "overlap");
check("自分自身は除ける", validateBranchInput(multi, mineMulti, "br_m"), "");
check("camelCaseの相手でも重なりを見る", validateBranchInput({ date: "2026-06-28", startTime: "01:00", endTime: "02:00" }, [{ id: "x", date: "2026-06-27", endDate: "2026-06-28", startTime: "14:00", endTime: "12:00" }]), "overlap");

const mb = { date: "2026-06-27", end_date: "2026-06-29", start_time: "14:00", end_time: "12:00" };
check("予定：始まりの日の開始前はNG", validateBranchBlockPlacement(mb, "2026-06-27", "13:59"), "time_out_of_branch");
check("予定：始まりの日の開始ちょうどはOK", validateBranchBlockPlacement(mb, "2026-06-27", "14:00"), "");
check("予定：途中の日は1日中OK", [validateBranchBlockPlacement(mb, "2026-06-28", "00:00"), validateBranchBlockPlacement(mb, "2026-06-28", "23:59")], ["", ""]);
check("予定：終わりの日の終了ちょうどはOK、後はNG", [validateBranchBlockPlacement(mb, "2026-06-29", "12:00"), validateBranchBlockPlacement(mb, "2026-06-29", "12:01")], ["", "time_out_of_branch"]);
check("予定：範囲外の日", [validateBranchBlockPlacement(mb, "2026-06-26", ""), validateBranchBlockPlacement(mb, "2026-06-30", ""), validateBranchBlockPlacement(mb, "", "")], ["date_out_of_branch", "date_out_of_branch", "date_out_of_branch"]);
check("予定：時刻なしは時刻を見ない", validateBranchBlockPlacement(mb, "2026-06-27", ""), "");
check("予定：1日の別行動（end_date空）は従来どおり", [
  validateBranchBlockPlacement({ date: "2026-10-01", end_date: "", start_time: "14:00", end_time: "17:00" }, "2026-10-01", "15:00"),
  validateBranchBlockPlacement({ date: "2026-10-01", end_date: "", start_time: "14:00", end_time: "17:00" }, "2026-10-01", "17:30"),
  validateBranchBlockPlacement({ date: "2026-10-01", start_time: "14:00", end_time: "17:00" }, "2026-10-02", "15:00"),
], ["", "time_out_of_branch", "date_out_of_branch"]);

console.log(`branches: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
