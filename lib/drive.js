'use strict';
/**
 * Google ドライブへの書き出し。分析用の数字を毎週ここへ置く（lib/analysis-export.js）。
 *
 * ★ なぜドライブなのか
 *   分析をする Claude（クラウド）は、投稿卓にも Supabase にも直接は届かない。
 *   Google ドライブなら Claude のコネクタで読める。数字は公開リポジトリには置けないので、
 *   本人のドライブの中に置くのがいちばん安全で、追加のお金もかからない。
 *
 * ★ 権限は drive.file だけ
 *   「このアプリが作ったファイルだけ触れる」権限。本人のほかのファイルは読めないし消せない。
 *   引換券は app_settings（v15）に置く。SNS の連携とは別物なので sns_accounts には入れない。
 *
 * ★ 同じ名前のファイルは上書きする
 *   同じ週に2回書き出しても、ドライブに同じファイルが2つ並ばないように。
 */

const google = require('./google');

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SETTING_KEY = 'drive_export';
const FOLDER_NAME = '投稿卓_分析データ';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

// ---------------------------------------------------------------- 設定の読み書き

async function loadSetting(db) {
  const rows = await db.rest('app_settings', { query: { select: 'value', key: `eq.${SETTING_KEY}` } });
  return (rows && rows[0] && rows[0].value) || null;
}

async function saveSetting(db, value) {
  await db.rest('app_settings', {
    method: 'POST',
    query: { on_conflict: 'key' },
    body: { key: SETTING_KEY, value, updated_at: new Date().toISOString() },
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
  return value;
}

/** 連携設定に出す用。引換券そのものは返さない。 */
async function status(db) {
  let s = null;
  try { s = await loadSetting(db); } catch (e) {
    // v15 を流していないと表が無い。そのときは「未設定」として扱い、直し方を添える。
    return { connected: false, error: 'Supabase に v15（app_settings）がまだありません。', hint: 'supabase/schema_v15_drive_export.sql を SQL Editor で流してください。' };
  }
  if (!s || !s.refresh_token) return { connected: false };
  return {
    connected: true,
    email: s.email || null,
    folder_id: s.folder_id || null,
    last_export: s.last_export || null,
    auth_error: s.auth_error || null,
  };
}

// ---------------------------------------------------------------- 連携

/** 戻ってきた code を引換券にして保存する。 */
async function saveFromCode(db, code, redirectUri) {
  const token = await google.exchangeCode(code, redirectUri);
  if (!token.refresh_token) {
    const e = new Error('Google から「今後も使ってよい」という引換券が返りませんでした。');
    e.hint = 'Google アカウントのセキュリティ設定でこのアプリのアクセスを一度削除してから、もう一度つないでください。';
    throw e;
  }
  const prev = (await loadSetting(db).catch(() => null)) || {};
  const value = {
    refresh_token: token.refresh_token,
    access_token: token.access_token || null,
    expires_at: new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString(),
    // 前に作ったフォルダは引き継ぐ。drive.file は「このアプリが作ったもの」しか見えないので、
    // 同じアプリで繋ぎ直すなら前のフォルダにそのまま書ける。
    folder_id: prev.folder_id || null,
    email: await whoAmI(token.access_token).catch(() => null),
    last_export: prev.last_export || null,
  };
  await saveSetting(db, value);
  return value;
}

async function whoAmI(accessToken) {
  const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json().catch(() => ({}));
  return (json.user && json.user.emailAddress) || null;
}

/** 使える入場券を返す。切れていれば取り直して保存する。 */
async function accessToken(db, setting) {
  if (!setting || !setting.refresh_token) {
    const e = new Error('Google ドライブとつながっていません。');
    e.hint = '投稿卓の「連携設定」→「Google ドライブ（分析の書き出し）をつなぐ」を押してください。';
    throw e;
  }
  const left = setting.expires_at ? new Date(setting.expires_at).getTime() - Date.now() : 0;
  if (setting.access_token && left > 120_000) return setting.access_token;

  let fresh;
  try {
    fresh = await google.refresh(setting.refresh_token);
  } catch (e) {
    // 切れた理由を連携設定の画面に残す。記録の失敗で本来のエラーを隠さない。
    setting.auth_error = { at: new Date().toISOString(), message: String(e.message || e).slice(0, 300) };
    await saveSetting(db, setting).catch(() => {});
    throw e;
  }
  setting.access_token = fresh.access_token;
  setting.expires_at = new Date(Date.now() + (fresh.expires_in || 3600) * 1000).toISOString();
  delete setting.auth_error;
  await saveSetting(db, setting);
  return setting.access_token;
}

// ---------------------------------------------------------------- ドライブの操作

async function call(url, opts) {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json.error && json.error.message) || `HTTP ${res.status}`;
    const e = new Error(`Google ドライブ：${msg}`);
    if (/has not been used|is disabled/i.test(msg)) {
      e.hint = 'Google Cloud（toukoutaku-neo）で「Google Drive API」を有効にしてください。';
    }
    e.status = res.status;
    throw e;
  }
  return json;
}

const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** 書き出し先のフォルダ。無ければマイドライブの直下に作る。 */
async function ensureFolder(db, setting, token) {
  if (setting.folder_id) {
    const f = await call(`${API}/${setting.folder_id}?fields=id,trashed`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
    if (f && !f.trashed) return setting.folder_id;
  }
  const made = await call(`${API}?fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  setting.folder_id = made.id;
  await saveSetting(db, setting);
  return made.id;
}

/** JSON を1ファイル置く。同じ名前があれば中身を差し替える。 */
async function putJson(token, folderId, name, data) {
  const text = JSON.stringify(data, null, 2);
  const found = await call(
    `${API}?fields=files(id)&q=${encodeURIComponent(`name = '${q(name)}' and '${q(folderId)}' in parents and trashed = false`)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const hit = found.files && found.files[0];
  if (hit) {
    await call(`${UPLOAD}/${hit.id}?uploadType=media&fields=id`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: text,
    });
    return { name, id: hit.id, replaced: true };
  }
  const boundary = 'toukoutaku' + Date.now().toString(36);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name, parents: [folderId], mimeType: 'application/json' }) +
    `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    text + `\r\n--${boundary}--`;
  const made = await call(`${UPLOAD}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return { name, id: made.id, replaced: false };
}

/**
 * まとめて書き出す。files は [{ name, data }]。
 * 最後に書き出した日時を残して、連携設定に出す。
 */
async function writeFiles(db, files) {
  const setting = await loadSetting(db);
  const token = await accessToken(db, setting);
  const folderId = await ensureFolder(db, setting, token);
  const done = [];
  for (const f of files) done.push(await putJson(token, folderId, f.name, f.data));
  setting.last_export = { at: new Date().toISOString(), files: done.map((d) => d.name) };
  await saveSetting(db, setting);
  return { folder_id: folderId, files: done };
}

module.exports = {
  SCOPE, SETTING_KEY, FOLDER_NAME,
  loadSetting, saveSetting, status, saveFromCode, accessToken, ensureFolder, putJson, writeFiles,
};
