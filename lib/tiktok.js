'use strict';
/**
 * TikTok の OAuth。
 *
 * ★ サンドボックスが既定の環境。審査前でも本物の TikTok に対して
 *   OAuth からアップロードまで一通り動く。ただし投稿は SELF_ONLY
 *   （自分だけに見える）に固定される。YouTube と同じ構図。
 */

const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';

// 自分の動画を投稿するのに必要な最小限
const SCOPES = ['user.info.basic', 'video.publish'];

const clientKey = () => need('TIKTOK_CLIENT_KEY');
const clientSecret = () => need('TIKTOK_CLIENT_SECRET');

function need(name) {
  const v = process.env[name];
  if (!v) {
    const e = new Error(`${name} が設定されていません。`);
    e.hint = 'Vercel の Settings → Environment Variables に追加して、再デプロイしてください。';
    throw e;
  }
  return v;
}

function authUrl(redirectUri, state) {
  const q = new URLSearchParams({
    client_key: clientKey(),
    scope: SCOPES.join(','),
    response_type: 'code',
    redirect_uri: redirectUri,
    state: state || '',
  });
  return `${AUTH_URL}?${q}`;
}

async function exchangeCode(code, redirectUri) {
  return post({
    client_key: clientKey(),
    client_secret: clientSecret(),
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
}

async function refresh(refreshToken) {
  return post({
    client_key: clientKey(),
    client_secret: clientSecret(),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}

async function post(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = new Error(`TikTok の認証に失敗しました：${json.error || res.status} ${json.error_description || ''}`.trim());
    e.hint = 'クライアントキーとシークレット、リダイレクトURIが登録どおりか確認してください。';
    throw e;
  }
  return json;
}

async function accessTokenFor(account, db) {
  const row = account;
  if (!row || !row.refresh_token) {
    const e = new Error('TikTok との連携が済んでいません。');
    e.hint = 'アプリの「連携設定」から TikTok を接続してください。';
    throw e;
  }
  if (row.access_token && row.expires_at && new Date(row.expires_at).getTime() - Date.now() > 120_000) {
    return row.access_token;
  }
  const fresh = await refresh(row.refresh_token);
  await db.updateAccount(row.id, {
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token || row.refresh_token,
    expires_at: new Date(Date.now() + (fresh.expires_in || 86400) * 1000).toISOString(),
  });
  return fresh.access_token;
}

module.exports = { authUrl, exchangeCode, refresh, accessTokenFor, SCOPES };
