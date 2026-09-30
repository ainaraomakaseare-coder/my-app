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

// "YYYY-MM-DD" が実在する日なら、1970-01-01からの日数。そうでなければ null。
export function dateToDays(date) {
  if (typeof date !== "string" || !DATE_RE.test(date)) return null;
  const ms = Date.parse(date + "T00:00:00Z");
  if (Number.isNaN(ms)) return null;
  if (new Date(ms).toISOString().slice(0, 10) !== date) return null;
  return Math.round(ms / 86400000);
}

// 分岐の終わりの日。end_date（endDate）が空なら開始日と同じ（1日の分岐）。DB行（snake_case）でも入力（camelCase）でも読める。
export function branchEndDateOf(b) {
  const end = b.endDate !== undefined ? b.endDate : b.end_date;
  return end || b.date;
}

// 分岐の始まり・終わりを、1970-01-01 0時からの分（日をまたいで比べられる）にする。読めなければ null。
function branchSpan(b) {
  const sd = dateToDays(b.date), ed = dateToDays(branchEndDateOf(b));
  const st = hhmmToMinutes(b.startTime !== undefined ? b.startTime : b.start_time);
  const et = hhmmToMinutes(b.endTime !== undefined ? b.endTime : b.end_time);
  if (sd === null || ed === null || st === null || et === null) return null;
  return { start: sd * 1440 + st, end: ed * 1440 + et };
}

/**
 * 分岐の入力を確かめる。問題なければ空文字、あればエラーの理由（英字）を返す。
 * input: { date, endDate?, startTime, endTime, title }（endDateが空・省略なら開始日と同じ）
 * others: 同じ人・同じ旅行の、ほかの分岐（DB行 { id, date, end_date, start_time, end_time } または camelCase）。
 *         更新のときは自分自身を除いて渡す（excludeIdでも除ける）。
 * opts.tripStart / opts.tripEnd: 旅行の日程（空・省略なら範囲チェックをしない）。
 */
export function validateBranchInput(input, others, excludeId, opts) {
  if (!input || typeof input !== "object") return "invalid_input";
  if (dateToDays(input.date) === null) return "invalid_date";
  if (input.endDate !== undefined && input.endDate !== null && input.endDate !== "" && dateToDays(input.endDate) === null) return "invalid_date";
  const s = hhmmToMinutes(input.startTime), e = hhmmToMinutes(input.endTime);
  if (s === null || e === null) return "invalid_time";
  // 終わり（終わりの日＋時刻）は始まりより後
  const mine = branchSpan(input);
  if (!mine || mine.end <= mine.start) return "end_before_start";
  // 旅行に日程があるときは、始まりの日も終わりの日もその中
  const o = opts || {};
  const endDate = branchEndDateOf(input);
  if (o.tripStart && (input.date < o.tripStart || endDate < o.tripStart)) return "date_out_of_range";
  if (o.tripEnd && (input.date > o.tripEnd || endDate > o.tripEnd)) return "date_out_of_range";
  if (input.title !== undefined && input.title !== null && (typeof input.title !== "string" || input.title.length > 100)) {
    return "invalid_title";
  }
  for (const other of others || []) {
    if (!other || other.id === excludeId) continue;
    const span = branchSpan(other);
    if (span && mine.start < span.end && span.start < mine.end) return "overlap";
  }
  return "";
}

/**
 * 分岐の中の予定の日付・時刻が、分岐の時間帯に収まっているか。問題なければ空文字。
 * 始まりの日は始まりの時刻以降、途中の日は1日中、終わりの日は終わりの時刻まで（ちょうどは可）。時刻なしの予定は時刻の確認をしない。
 * branch: DB行または camelCase。
 */
export function validateBranchBlockPlacement(branch, date, time) {
  const startDate = branch.date, endDate = branchEndDateOf(branch);
  if (typeof date !== "string" || date < startDate || date > endDate) return "date_out_of_branch";
  if (!time) return "";
  const m = hhmmToMinutes(time);
  if (m === null) return "invalid_time";
  const st = hhmmToMinutes(branch.startTime !== undefined ? branch.startTime : branch.start_time);
  const et = hhmmToMinutes(branch.endTime !== undefined ? branch.endTime : branch.end_time);
  if (date === startDate && m < st) return "time_out_of_branch";
  if (date === endDate && m > et) return "time_out_of_branch";
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
