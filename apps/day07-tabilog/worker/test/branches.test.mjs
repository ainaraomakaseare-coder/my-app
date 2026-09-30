/*
 * 分岐（自分だけの道）の入力チェック・権限判定の単体テスト（docs/adr/0021）。
 * 実行: node worker/test/branches.test.mjs
 */
import assert from "node:assert/strict";
import { hhmmToMinutes, timeRangesOverlap, validateBranchInput, canEditBranchBlock, canMoveEntryBetween } from "../src/branches.js";

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

console.log(`branches: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
