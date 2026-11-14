/*
 * 取り込みの元（AIなどで予定を入れたときの、元の入力）。2026-11-14〜（migrations/0038）。
 *
 * 音声の文字起こし・貼り付けたメモ・自分のAIの答え・予約やチケットのスクショ画像を、
 * 予定（blocks.source_id）とひもづけて残す。「何でこの予定を入れたっけ」をあとから見返すためのもの。
 * アルバム（記録の写真）とは別：スクショ画像はR2に置くが、記録（entries.photo_ids）には入れない。
 *
 * ここは純粋関数だけ（nodeでそのまま単体テストできる。worker/test/import-sources.test.mjs）。
 * D1・R2を触るのは index.js。
 */

export const IMPORT_SOURCE_KINDS = ["voice", "memo", "json", "screenshot"];
export const IMPORT_SOURCE_MAX_TEXT = 8000; // メモ・文字起こしの上限（MAX_MULTI_DAY_TEXT_CHARSと同じ）
export const IMPORT_SOURCE_MAX_NOTES = 4000;
export const IMPORT_SOURCE_MAX_PHOTOS = 10; // スクショの取り込みは最大10枚（SS_MAX_IMAGESと同じ）
const PHOTO_KEY_RE = /^photo_[0-9a-f]{32}\.(jpg|png|webp)$/;

// クライアントから届いた source（{ kind, text, notes, photoIds }）を確かめて整える。
// 戻り値：残すもの（{ kind, text, notes, photoIds }）か null（残さない）。
// 中身（文字も画像も）が無いもの・形のおかしいものは null にする（予定の保存は止めない）
export function normalizeImportSource(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!IMPORT_SOURCE_KINDS.includes(raw.kind)) return null;
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  const notes = typeof raw.notes === "string" ? raw.notes.trim() : "";
  if (text.length > IMPORT_SOURCE_MAX_TEXT || notes.length > IMPORT_SOURCE_MAX_NOTES) return null;
  let photoIds = [];
  if (raw.photoIds !== undefined) {
    if (!Array.isArray(raw.photoIds) || raw.photoIds.length > IMPORT_SOURCE_MAX_PHOTOS) return null;
    if (!raw.photoIds.every((k) => typeof k === "string" && PHOTO_KEY_RE.test(k))) return null;
    photoIds = [...new Set(raw.photoIds)];
  }
  if (!text && !photoIds.length) return null;
  return { kind: raw.kind, text, notes, photoIds };
}

export function rowToImportSource(row) {
  let photoIds = [];
  try {
    const v = JSON.parse(row.photo_ids || "[]");
    if (Array.isArray(v)) photoIds = v.filter((k) => typeof k === "string");
  } catch { /* 壊れた値は画像なし */ }
  return {
    id: row.id,
    tripId: row.trip_id,
    branchId: row.branch_id || "",
    kind: row.kind,
    text: row.text || "",
    notes: row.notes || "",
    photoIds,
    author: row.author || "",
    createdAt: row.created_at,
  };
}
