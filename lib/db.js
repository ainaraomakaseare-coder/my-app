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

/**
 * SUPABASE_URL を、何を貼られても使える形に整える。
 *
 * 貼り間違えが多いところなので、アプリ側で吸収する。
 *   https://xxx.supabase.co/          → 末尾のスラッシュ
 *   https://xxx.supabase.co/rest/v1   → Connect画面のURLを貼った場合（一番多い）
 *   前後の空白・改行                   → コピペで混入
 *
 * URL として解釈して origin（プロトコル＋ホスト）だけを取り出せば、
 * 後ろに何が付いていても正しい土台になる。
 */
function URL_BASE() {
  const raw = must('SUPABASE_URL').trim();
  let origin;
  try {
    origin = new global.URL(raw).origin;
  } catch (_) {
    const e = new Error('SUPABASE_URL が URL の形になっていません。');
    e.hint = 'https://〇〇.supabase.co の形で設定してください（いまの値の先頭は「' +
             raw.slice(0, 12) + '…」です）。';
    throw e;
  }
  return origin;
}
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
  if (!res.ok) throw new DbError(rpcError(fn, text, res.status), res.status);
  return text ? JSON.parse(text) : null;
}

/** PostgREST のエラー番号を、原因と直し方が分かる日本語にする。 */
function rpcError(fn, text, status) {
  let code = '';
  try { code = (JSON.parse(text) || {}).code || ''; } catch (_) {}

  if (code === 'PGRST202') {
    return `データベースに ${fn} という関数がありません。` +
           'supabase/schema.sql を SQL Editor で実行したか確認してください。';
  }
  if (code === 'PGRST125') {
    return 'SUPABASE_URL の形が正しくありません。' +
           'https://〇〇.supabase.co だけを設定してください（/rest/v1 は付けない）。';
  }
  if (status === 401 || code === 'PGRST301') {
    return 'SUPABASE_SERVICE_KEY が違います。' +
           'anon（publishable）ではなく service_role（secret）のキーを設定してください。';
  }
  return `${fn} の呼び出しに失敗しました: ${text.slice(0, 300)}`;
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
// 連携アカウント
//
// 同じSNSに複数のアカウントを繋げる（企画用・アフィリエイト用など）ので、
// トークンは「SNSごと」ではなく「アカウントごと」に持つ。
// ---------------------------------------------------------------------------

/**
 * 画面に出す一覧。
 *
 * ★ トークンそのものは絶対に返さない。
 *   ただし「引換券を持っているか」だけは画面に伝える必要がある。
 *   持っていれば入場券は自動で取り直せるので、1時間先の期限を
 *   警告として出してはいけない（利用者が切れたと勘違いする）。
 */
async function listAccounts() {
  const rows = (await rest('sns_accounts', {
    query: {
      select: 'id,network,label,account_name,group_id,expires_at,updated_at,refresh_token',
      order: 'network.asc,created_at.asc',
    },
  })) || [];

  return rows.map(({ refresh_token, ...a }) => ({ ...a, auto_refresh: !!refresh_token }));
}

/** 運用アカウント（運用ライン）の一覧。画面のタブに出す。 */
async function listGroups() {
  return (await rest('account_groups', {
    query: { select: 'id,label,validation_profile,auto_publish_networks', order: 'created_at.asc' },
  })) || [];
}

async function insertGroup(row) {
  const created = await rest('account_groups', {
    method: 'POST', body: row, prefer: 'return=representation',
  });
  return Array.isArray(created) ? created[0] : created;
}

const updateGroup = (id, patch) => updateById('account_groups', id, patch);
const deleteGroup = (id) => deleteById('account_groups', id);

/**
 * その運用アカウントに何がぶら下がっているか。
 * 消してよいかの判断に使う（lib/groups.js）。
 */
async function countGroupRefs(id) {
  const [accounts, posts] = await Promise.all([
    rest('sns_accounts', { query: { select: 'id', group_id: `eq.${id}` } }),
    rest('posts', { query: { select: 'id', group_id: `eq.${id}` } }),
  ]);
  return { accounts: (accounts || []).length, posts: (posts || []).length };
}

/**
 * この連携先を別の運用アカウントへ移してよいか。
 *
 * ★ DB側の見張りは post_targets と posts を書き換えたときにしか動かない。
 *   連携先の所属だけをこっそり変えると、すでに出来ている投稿先が
 *   食い違ったまま残ってしまう。ここで先に見る。
 *   戻り値は食い違っている投稿の管理用タイトル（無ければ null）。
 */
async function accountGroupConflict(accountId, groupId) {
  if (!groupId) return null;
  const rows = (await rest('post_targets', {
    query: { select: 'post_id,posts(group_id,title)', account_id: `eq.${accountId}` },
  })) || [];
  const hit = rows.find((r) => r.posts && r.posts.group_id && r.posts.group_id !== groupId);
  return hit ? (hit.posts.title || '（名前なし）') : null;
}

/** 投稿処理が使う。トークンを含む1件。 */
async function getAccount(id) {
  const rows = await rest('sns_accounts', { query: { select: '*', id: `eq.${id}` } });
  return (rows && rows[0]) || null;
}

/**
 * 連携したときの保存。
 * 同じSNSの同じアカウント名なら上書きし、違えば増やす。
 * 「接続し直す」で行が二重に増えないようにするため。
 */
async function upsertAccount({ network, account_name, ...rest_ }) {
  const found = account_name
    ? await rest('sns_accounts', {
        query: { select: 'id', network: `eq.${network}`, account_name: `eq.${account_name}` },
      })
    : null;

  const patch = { ...rest_, account_name, updated_at: new Date().toISOString() };

  if (found && found[0]) return updateById('sns_accounts', found[0].id, patch);

  const created = await rest('sns_accounts', {
    method: 'POST',
    body: { network, ...patch },
    prefer: 'return=representation',
  });
  return Array.isArray(created) ? created[0] : created;
}

const updateAccount = (id, patch) =>
  updateById('sns_accounts', id, { ...patch, updated_at: new Date().toISOString() });

const deleteAccount = (id) => deleteById('sns_accounts', id);

module.exports = {
  rest, rpc, insert, updateById, deleteById, selectPosts, logEvent,
  upload, signedUrl, download, removeFile, BUCKET,
  listAccounts, getAccount, upsertAccount, updateAccount, deleteAccount, DbError,
  listGroups, insertGroup, updateGroup, deleteGroup, countGroupRefs, accountGroupConflict,
};

// ---------------------------------------------------------------------------
// ブラウザから直接アップロードするための「許可証」
//
// ★ Vercel のサーバーは1リクエスト 4.5MB までしか受け取れない。
//   動画をサーバー経由で送ると、それだけで失敗する。
//   そこでサーバーは「ここに置いていい」という期限つきの許可証だけを出し、
//   動画そのものはブラウザから Supabase へ直接送る。
// ---------------------------------------------------------------------------
async function signedUploadUrl(path) {
  const res = await fetch(`${URL_BASE()}/storage/v1/object/upload/sign/${BUCKET}/${path}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new DbError(`アップロード許可証の発行に失敗しました: ${(await res.text()).slice(0, 300)}`, res.status);
  }
  const json = await res.json();
  return { uploadUrl: `${URL_BASE()}/storage/v1${json.url}`, path };
}

module.exports.signedUploadUrl = signedUploadUrl;
