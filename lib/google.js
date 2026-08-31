'use strict';
/**
 * Google の OAuth。YouTube へのアップロードに使う。
 *
 * OAuth の考え方（初心者向けの言い方）：
 *   - リフレッシュトークン … 「今後もこのアプリに許可します」という permanent な引換券。
 *                            一度しか発行されないので、取れたらすぐ DB に保存する。
 *   - アクセストークン    … 引換券と交換してもらう、1時間で切れる入場券。
 *                            毎回これを取り直して API を呼ぶ。
 *
 * だから DB に置くのはリフレッシュトークンで、アクセストークンは使い捨て。
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

// 動画のアップロードに必要な権限と、チャンネル名を読むための権限。
// 名前が無いと、複数チャンネルを繋いだときに画面で見分けられない。
const SCOPE = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
].join(' ');

const clientId = () => need('GOOGLE_CLIENT_ID');
const clientSecret = () => need('GOOGLE_CLIENT_SECRET');

function need(name) {
  const v = process.env[name];
  if (!v) {
    const e = new Error(`${name} が設定されていません。`);
    e.hint = 'Vercel の Settings → Environment Variables に追加して、再デプロイしてください。';
    throw e;
  }
  return v;
}

/** 許可を求める画面のURL。ここへ本人を送る。 */
function authUrl(redirectUri, state) {
  const q = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    // ★ この2つが無いとリフレッシュトークンが返ってこない。OAuth 最頻出のつまずき。
    access_type: 'offline',
    prompt: 'consent',
    state: state || '',
  });
  return `${AUTH_URL}?${q}`;
}

/** 戻ってきた code を、リフレッシュトークンに引き換える。 */
async function exchangeCode(code, redirectUri) {
  return post({
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
}

/** 引換券から、1時間有効な入場券をもらう。 */
async function refresh(refreshToken) {
  return post({
    refresh_token: refreshToken,
    client_id: clientId(),
    client_secret: clientSecret(),
    grant_type: 'refresh_token',
  });
}

async function post(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(translate(json));
    e.hint = 'Google Cloud のクライアントIDとシークレット、リダイレクトURIが一致しているか確認してください。';
    throw e;
  }
  return json;
}

function translate(json) {
  const err = json.error || '';
  if (err === 'invalid_grant') {
    return 'Google の認証が無効になっています（許可の取り消し、または期限切れ）。連携し直してください。';
  }
  if (err === 'redirect_uri_mismatch') {
    return 'リダイレクトURIが Google Cloud の登録と一致していません。';
  }
  if (err === 'invalid_client') {
    return 'クライアントIDかシークレットが違います。';
  }
  return `Google の認証に失敗しました：${err || ' 理由不明'} ${json.error_description || ''}`.trim();
}

/**
 * DB に持っている入場券がまだ使えるならそれを、切れていれば取り直して返す。
 */
async function accessTokenFor(account, db) {
  if (!account || !account.refresh_token) {
    const e = new Error('Google との連携が済んでいません。');
    e.hint = 'アプリの「連携設定」から YouTube を接続してください。';
    throw e;
  }
  // 期限まで2分を切っていたら取り直す
  if (account.access_token && account.expires_at &&
      new Date(account.expires_at).getTime() - Date.now() > 120_000) {
    return account.access_token;
  }
  const fresh = await refresh(account.refresh_token);
  const expiresAt = new Date(Date.now() + (fresh.expires_in || 3600) * 1000).toISOString();
  await db.updateAccount(account.id, { access_token: fresh.access_token, expires_at: expiresAt });
  return fresh.access_token;
}

module.exports = { authUrl, exchangeCode, refresh, accessTokenFor, SCOPE };
