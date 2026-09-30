/*
 * 自分だけの道（別行動の分岐）の、入力チェックと「誰が触れるか」の判定（docs/adr/0021）。
 * Workers専用のグローバルを使わない純粋な関数だけを置き、nodeでそのままテストできる
 * （worker/test/branches.test.mjs）。D1へのアクセスは index.js 側に置く。
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// "HH:MM" を、その日の0時からの分に直す。形式が違えば null。
export function hhmmToMinutes(hhmm) {
  if (typeof hhmm !== "string" || !TIME_RE.test(hhmm)) return null;
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

// 2つの時間帯 [aStart, aEnd) と [bStart, bEnd) が重なるか。ぴったり隣り合う（14:00-15:00と15:00-16:00）のは重ならない。
export function timeRangesOverlap(aStart, aEnd, bStart, bEnd) {
  const as = hhmmToMinutes(aStart), ae = hhmmToMinutes(aEnd), bs = hhmmToMinutes(bStart), be = hhmmToMinutes(bEnd);
  if (as === null || ae === null || bs === null || be === null) return false;
  return as < be && bs < ae;
}

/**
 * 分岐の入力を確かめる。問題なければ空文字、あればエラーの理由（英字）を返す。
 * input: { date, startTime, endTime, title }
 * others: 同じ人・同じ旅行の、ほかの分岐（{ id, date, start_time, end_time } または { id, date, startTime, endTime }）。
 *         更新のときは自分自身を除いて渡す（excludeIdでも除ける）。
 */
export function validateBranchInput(input, others, excludeId) {
  if (!input || typeof input !== "object") return "invalid_input";
  if (typeof input.date !== "string" || !DATE_RE.test(input.date)) return "invalid_date";
  const s = hhmmToMinutes(input.startTime), e = hhmmToMinutes(input.endTime);
  if (s === null || e === null) return "invalid_time";
  // 日をまたがない（同じ日の中で、終わりは始まりより後）
  if (e <= s) return "end_before_start";
  if (input.title !== undefined && input.title !== null && (typeof input.title !== "string" || input.title.length > 100)) {
    return "invalid_title";
  }
  for (const o of others || []) {
    if (!o || o.id === excludeId || o.date !== input.date) continue;
    const os = o.startTime !== undefined ? o.startTime : o.start_time;
    const oe = o.endTime !== undefined ? o.endTime : o.end_time;
    if (timeRangesOverlap(input.startTime, input.endTime, os, oe)) return "overlap";
  }
  return "";
}

// 分岐の中の予定を触ってよいのは、その分岐の持ち手だけ。分岐に属さない（branchIdが空の）予定は今までどおり誰でも。
export function canEditBranchBlock(blockBranchId, branchOwnerAccountId, sessionAccountId) {
  if (!blockBranchId) return true;
  return !!sessionAccountId && !!branchOwnerAccountId && sessionAccountId === branchOwnerAccountId;
}

// 別の予定へ記録を移せるのは、同じ分岐の中どうし（みんなの予定どうしも含む）だけ。
export function canMoveEntryBetween(fromBranchId, toBranchId) {
  return (fromBranchId || "") === (toBranchId || "");
}
