'use strict';
/**
 * Supabase と話す部分。
 *
 * Supabase は「PostgREST」という仕組みで、テーブルをそのまま HTTP で読み書きできる。
 * つまり専用ライブラリを入れなくても fetch だけで足りる。DAY8 と同じく npm install 不要。
 *
 * ここで使うのは service_role（secret）キー。全権限があるので、
 * このファイルが動くのはサーバー側だけ。ブラウザには絶対に渡さない。
 */

const URL_BASE = () => must('SUPABASE_URL').replace(/\/+$/, '');
const KEY = () => must('SUPABASE_SERVICE_KEY');

function must(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `環境変数 ${name} が設定されていません。Vercel の Settings → Environment Variables を確認してください。`
    );
  }
  return v;
}

/** 認証ヘッダー。トークンそのものはログに出さないので、ここでしか触らない。 */
function headers(extra = {}) {
  const key = KEY();
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

/**
 * テーブルへの問い合わせ。
 *   rest('posts', { query: { select: '*', order: 'created_at.desc' } })
 *   rest('posts', { method: 'POST', body: {...}, prefer: 'return=representation' })
 */
async function rest(table, { method = 'GET', query = {}, body, prefer } = {}) {
  const url = new global.URL(`${URL_BASE()}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const h = headers({ 'Content-Type': 'application/json' });
  if (prefer) h.Prefer = prefer;

  const res = await fetch(url, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    // エラー本文に鍵は含まれないが、念のため URL は出さない
    throw new DbError(`Supabase が ${res.status} を返しました: ${text.slice(0, 300)}`, res.status);
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return text; }
}

/** SQL で作った関数を呼ぶ（claim_due_targets など）。 */
async function rpc(fn, args = {}) {
  const res = await fetch(`${URL_BASE()}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new DbError(`RPC ${fn} が失敗しました: ${text.slice(0, 300)}`, res.status);
  return text ? JSON.parse(text) : null;
}

class DbError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// ---------------------------------------------------------------------------
// よく使う操作に名前をつけておく
// ---------------------------------------------------------------------------

const selectPosts = (query) => rest('posts', { query });
const insert = (table, row) => rest(table, { method: 'POST', body: row, prefer: 'return=representation' });

/** id を指定して1行だけ更新する。 */
async function updateById(table, id, patch) {
  const rows = await rest(table, {
    method: 'PATCH',
    query: { id: `eq.${id}` },
    body: patch,
    prefer: 'return=representation',
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

const deleteById = (table, id) => rest(table, { method: 'DELETE', query: { id: `eq.${id}` } });

/** 履歴を1行足す。失敗しても本処理は止めない（記録のために投稿を落とさない）。 */
async function logEvent(postId, network, event, detail) {
  try {
    await insert('post_events', {
      post_id: postId,
      network: network || null,
      event,
      detail: detail ? String(detail).slice(0, 2000) : null,
    });
  } catch (_) { /* 記録の失敗で投稿処理を止めない */ }
}

// ---------------------------------------------------------------------------
// Storage（動画・画像の置き場）
// ---------------------------------------------------------------------------

const BUCKET = 'media';

/** ファイルを置く。path は '2026/09/ab12cd.mp4' のような形。 */
async function upload(path, buffer, contentType) {
  const res = await fetch(`${URL_BASE()}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': contentType || 'application/octet-stream', 'x-upsert': 'true' }),
    body: buffer,
  });
  if (!res.ok) {
    throw new DbError(`ファイルの保存に失敗しました: ${(await res.text()).slice(0, 300)}`, res.status);
  }
  return path;
}

/**
 * ★ Instagram に渡すための「期限つきURL」を作る。
 *
 * バケットは非公開のままにして、投稿の瞬間だけ 2 時間だけ有効な URL を発行する。
 * ずっと公開しておくより安全で、URL が漏れても時間が経てば無効になる。
 */
async function signedUrl(path, expiresIn = 2 * 60 * 60) {
  const json = await (async () => {
    const res = await fetch(`${URL_BASE()}/storage/v1/object/sign/${BUCKET}/${path}`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn }),
    });
    if (!res.ok) {
      throw new DbError(`公開URLの発行に失敗しました: ${(await res.text()).slice(0, 300)}`, res.status);
    }
    return res.json();
  })();
  // 返ってくるのは '/object/sign/media/...' のような相対パス
  return `${URL_BASE()}/storage/v1${json.signedURL || json.signedUrl}`;
}

/** YouTube / X / TikTok はファイル本体を送るので、中身を取り出す必要がある。 */
async function download(path) {
  const res = await fetch(`${URL_BASE()}/storage/v1/object/${BUCKET}/${path}`, { headers: headers() });
  if (!res.ok) {
    throw new DbError(`ファイルの読み出しに失敗しました: ${res.status}`, res.status);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function removeFile(path) {
  try {
    await fetch(`${URL_BASE()}/storage/v1/object/${BUCKET}/${path}`, { method: 'DELETE', headers: headers() });
  } catch (_) { /* 消せなくても致命的ではない */ }
}

// ---------------------------------------------------------------------------
// SNS のトークン
// ---------------------------------------------------------------------------

async function getToken(network) {
  const rows = await rest('sns_tokens', { query: { select: '*', network: `eq.${network}` } });
  return (rows && rows[0]) || null;
}

async function saveToken(network, patch) {
  return rest('sns_tokens', {
    method: 'POST',
    body: { network, ...patch, updated_at: new Date().toISOString() },
    prefer: 'resolution=merge-duplicates,return=representation',
  });
}

module.exports = {
  rest, rpc, insert, updateById, deleteById, selectPosts, logEvent,
  upload, signedUrl, download, removeFile, BUCKET,
  getToken, saveToken, DbError,
};
