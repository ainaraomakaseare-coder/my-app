'use strict';
/**
 * X の OAuth 2.0（PKCE）。
 *
 * ★ 権限（スコープ）の落とし穴
 *   投稿とメディアのアップロードは別のAPIで、必要な権限も別。
 *   よく紹介される4つ（tweet.read / tweet.write / users.read / offline.access）だけだと、
 *   テキストは通るのに動画のアップロードで 403 になる。media.write が要る。
 *
 * ★ PKCE
 *   「合言葉を先に自分で作っておいて、後で本人だと証明する」やり方。
 *   送り出すときは合言葉のハッシュだけを渡し、引き換えのときに元の文字列を出す。
 *
 * ★ リフレッシュトークンが毎回変わる
 *   X は更新のたびに新しい引換券を返し、古いものを無効にする。
 *   受け取った新しい券を必ず保存し直さないと、次から入れなくなる。
 */

const crypto = require('crypto');

const AUTH_URL = 'https://x.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';

const SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'];

const clientId = () => need('X_CLIENT_ID');
const clientSecret = () => need('X_CLIENT_SECRET');

function need(name) {
  const v = process.env[name];
  if (!v) {
    const e = new Error(`${name} が設定されていません。`);
    e.hint = 'Vercel の Settings → Environment Variables に追加して、再デプロイしてください。';
    throw e;
  }
  return v;
}

/** PKCE の合言葉と、その要約を作る。 */
function makeVerifier() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function authUrl(redirectUri, challenge, state) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId(),
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    state: state || crypto.randomBytes(8).toString('hex'),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${q}`;
}

/** client_id:client_secret を Basic 認証で送る（機密クライアント）。 */
function basic() {
  return 'Basic ' + Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64');
}

async function exchangeCode(code, redirectUri, verifier) {
  return post({
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
}

async function refresh(refreshToken) {
  return post({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

async function post(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`X の認証に失敗しました：${json.error || res.status} ${json.error_description || ''}`.trim());
    e.hint = 'クライアントID・シークレットと、コールバックURLが登録どおりか確認してください。';
    throw e;
  }
  return json;
}

/**
 * 使える入場券を返す。
 * 更新したときは、新しい引換券も必ず保存する（X は毎回入れ替わるため）。
 */
async function accessTokenFor(account, db) {
  const row = account;
  if (!row || !row.refresh_token) {
    const e = new Error('X との連携が済んでいません。');
    e.hint = 'アプリの「連携設定」から X を接続してください。';
    throw e;
  }
  if (row.access_token && row.expires_at && new Date(row.expires_at).getTime() - Date.now() > 120_000) {
    return row.access_token;
  }
  const fresh = await refresh(row.refresh_token);
  await db.updateAccount(row.id, {
    access_token: fresh.access_token,
    // ★ 新しい引換券で必ず上書きする。忘れると次回から入れなくなる。
    refresh_token: fresh.refresh_token || row.refresh_token,
    expires_at: new Date(Date.now() + (fresh.expires_in || 7200) * 1000).toISOString(),
  });
  return fresh.access_token;
}

module.exports = { makeVerifier, authUrl, exchangeCode, refresh, accessTokenFor, SCOPES };
