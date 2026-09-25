'use strict';
/**
 * 連携の「切れた理由」を残す。YouTube と TikTok で共通。
 *
 * ★ なぜ要るのか
 *   「1日で切れる」と感じても、切れた理由（許可の取り消し、期限切れ、
 *   テスト中の7日制限、引換券の使い回し…）は SNS の返事の中にしか無い。
 *   投稿の失敗としてしか出ないと、どの連携の、何が原因かを後から追えない。
 *   取り直しに失敗したら sns_accounts.meta.auth_error に残し、
 *   連携設定の画面に出す。取り直しに成功したら消す。
 */

/** 失敗を記録する。記録そのものの失敗では本来のエラーを隠さない。 */
async function noteAuthError(row, db, e) {
  if (!db || typeof db.updateAccount !== 'function' || !row || !row.id) return;
  const meta = Object.assign({}, row.meta || {}, {
    auth_error: { at: new Date().toISOString(), message: String((e && e.message) || e).slice(0, 300) },
  });
  await db.updateAccount(row.id, { meta }).catch(() => {});
  row.meta = meta;
}

/** 失敗の記録を消した meta を返す（他のキーは残す）。 */
function clearAuthError(meta) {
  const m = Object.assign({}, meta || {});
  delete m.auth_error;
  return m;
}

/**
 * 取り直す前に、DB の最新の行を読み直して手元の行に重ねる。
 *
 * ★ 同じアカウントを1回の処理で何度も使う（毎晩の数字の取り込み）と、
 *   最初の呼び出しで取り直した結果を、手元の古い行が知らないまま2回目に進む。
 *   TikTok は取り直すたびに引換券を新しくすることがあるので、古い券を出すと断られうる。
 */
async function reload(row, db) {
  if (!db || typeof db.getAccount !== 'function' || !row || !row.id) return row;
  const latest = await db.getAccount(row.id).catch(() => null);
  if (latest) Object.assign(row, latest);
  return row;
}

/** 入場券が、あと2分以上使えるか。 */
const usable = (r) =>
  !!(r && r.access_token && r.expires_at && new Date(r.expires_at).getTime() - Date.now() > 120_000);

module.exports = { noteAuthError, clearAuthError, reload, usable };
