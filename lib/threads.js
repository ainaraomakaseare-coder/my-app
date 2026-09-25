'use strict';
/**
 * Threads の OAuth とトークン。
 *
 * ★ Instagram と同じ Meta だが、窓口も鍵も別物。
 *   Meta for Developers のアプリに「Threads API にアクセス」のユースケースを足すと、
 *   Threads 用のアプリID／シークレットが別に発行される。それを
 *   THREADS_APP_ID / THREADS_APP_SECRET に入れる（Instagram の IG_APP_SECRET とは別）。
 *
 * ★ トークンは3段階
 *     code → 短期トークン（1時間）→ 長期トークン（60日）
 *   長期トークンは「発行から24時間以上たち、まだ切れていない」うちなら
 *   何度でも60日に延ばせる。引換券（refresh_token）という仕組みは無く、
 *   長期トークンそのものを差し出して延ばす。
 *   だから「切れる7日前を過ぎたら延ばす」を、使うたびと毎晩の取り込みで行う。
 *   これで Instagram のような「60日ごとに貼り直す」手作業は残らない。
 *
 * ★ 審査について
 *   自分のアカウントを「Threads テスター」に入れて承認すれば、審査なしで
 *   自分のアカウントに投稿できる（Instagram のテスター承認と同じ構図）。
 */

const health = require('./token-health');

const AUTH_URL = 'https://threads.net/oauth/authorize';
const GRAPH = 'https://graph.threads.net';
const VERSION = 'v1.0';

// 投稿と、名前・フォロワー数・投稿ごとの数字を読むための権限。
const SCOPES = ['threads_basic', 'threads_content_publish', 'threads_manage_insights'];

// 残りがこれを切ったら延ばす。毎晩の取り込みで必ず一度は通るので、7日あれば余裕がある。
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
// 発行から24時間たたないと延ばせない（Threads の決まり）。
const MIN_AGE_MS = 24 * 60 * 60 * 1000;

const appId = () => need('THREADS_APP_ID');
const appSecret = () => need('THREADS_APP_SECRET');

function need(name) {
  const v = process.env[name];
  if (!v) {
    const e = new Error(`${name} が設定されていません。`);
    e.hint = 'Meta for Developers のアプリで Threads のユースケースを追加し、Threads 用のアプリIDとシークレットを'
      + ' Vercel の Settings → Environment Variables に入れて、再デプロイしてください。';
    throw e;
  }
  return v;
}

function authUrl(redirectUri, state) {
  const q = new URLSearchParams({
    client_id: appId(),
    redirect_uri: redirectUri,
    scope: SCOPES.join(','),
    response_type: 'code',
    state: state || '',
  });
  return `${AUTH_URL}?${q}`;
}

/**
 * 戻ってきた code を、長期トークン（60日）まで一気に引き換える。
 * 返すのは { access_token, user_id, expires_at }。
 */
async function exchangeCode(code, redirectUri) {
  const short = await send('POST', '/oauth/access_token', {
    client_id: appId(),
    client_secret: appSecret(),
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code,
  });
  const long = await send('GET', '/access_token', {
    grant_type: 'th_exchange_token',
    client_secret: appSecret(),
    access_token: short.access_token,
  });
  return {
    access_token: long.access_token,
    user_id: short.user_id ? String(short.user_id) : null,
    expires_at: expiresAt(long.expires_in),
  };
}

/** 長期トークンを、さらに60日延ばす。 */
async function renew(accessToken) {
  const json = await send('GET', '/refresh_access_token', {
    grant_type: 'th_refresh_token',
    access_token: accessToken,
  });
  return { access_token: json.access_token, expires_at: expiresAt(json.expires_in) };
}

const expiresAt = (sec) => new Date(Date.now() + (Number(sec) || 5184000) * 1000).toISOString();

/**
 * 使えるトークンを返す。切れる7日前を過ぎていれば、延ばしてから返す。
 *
 * ★ 延ばすのに失敗しても、まだ切れていなければ今のトークンで続ける。
 *   延ばせないのは「発行から24時間たっていない」ことが多く、それは異常ではない。
 *   本当に切れたときだけ止めて、理由を連携設定に残す（lib/token-health.js）。
 */
async function accessTokenFor(account, db) {
  const row = account;
  if (!row || !row.access_token) {
    const e = new Error('Threads との連携が済んでいません。');
    e.hint = 'アプリの「連携設定」から Threads を接続してください。';
    throw e;
  }
  await health.reload(row, db);

  const left = row.expires_at ? new Date(row.expires_at).getTime() - Date.now() : Infinity;
  const issuedAt = row.meta && row.meta.issued_at ? new Date(row.meta.issued_at).getTime() : 0;
  const oldEnough = Date.now() - issuedAt > MIN_AGE_MS;

  if (left > RENEW_BEFORE_MS) return row.access_token;

  if (left > 0 && !oldEnough) return row.access_token;

  try {
    const fresh = await renew(row.access_token);
    const patch = {
      access_token: fresh.access_token,
      expires_at: fresh.expires_at,
      meta: health.clearAuthError(Object.assign({}, row.meta || {}, { issued_at: new Date().toISOString() })),
    };
    await db.updateAccount(row.id, patch);
    Object.assign(row, patch);
    return row.access_token;
  } catch (e) {
    if (left > 0) return row.access_token;   // まだ使える。次の機会に延ばす
    await health.noteAuthError(row, db, e);
    e.hint = e.hint || 'Threads の連携が切れました。「連携設定」から繋ぎ直してください。';
    throw e;
  }
}

/** 自分の名前とID。連携したときに見分けるため。 */
async function me(accessToken) {
  const json = await send('GET', `/${VERSION}/me`, { fields: 'id,username', access_token: accessToken });
  return { id: json.id ? String(json.id) : null, name: json.username ? '@' + json.username : 'Threads' };
}

/**
 * Threads の API を呼ぶ。失敗は日本語にして投げる。
 * GET はクエリに、POST はフォームで送る（Threads はどちらも受け付ける）。
 */
async function send(method, path, params) {
  const q = new URLSearchParams(params || {});
  const url = method === 'GET' ? `${GRAPH}${path}?${q}` : `${GRAPH}${path}`;
  const res = await fetch(url, method === 'GET' ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: q,
  });
  const text = await res.text().catch(() => '');
  let json;
  try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }

  if (!res.ok || json.error) {
    const err = json.error || {};
    const e = new Error(translate(err, res.status));
    e.hint = hintFor(err);
    e.code = err.code;
    e.raw = json;
    throw e;
  }
  return json;
}

function translate(err, status) {
  if (err.code === 190) return 'Threads のトークンが無効です（期限切れ、または許可の取り消し）。';
  if (err.code === 10 || err.code === 200) return 'Threads の権限が足りません。';
  if (err.code === 4 || err.code === 17 || err.code === 613) return 'Threads の呼び出し回数の上限に達しました。';
  return `Threads が ${err.code || status} を返しました：${(err.message || '').slice(0, 200)}`;
}

function hintFor(err) {
  if (err.code === 190) return '「連携設定」から Threads を繋ぎ直してください。';
  if (err.code === 10 || err.code === 200) {
    return 'Meta のアプリで threads_basic・threads_content_publish が有効か、'
      + '自分のアカウントを Threads テスターに追加して Threads アプリ側で承認したかを確認し、繋ぎ直してください。';
  }
  if (err.code === 4 || err.code === 17 || err.code === 613) return '時間をあけてから再実行してください。';
  return undefined;
}

module.exports = { authUrl, exchangeCode, renew, accessTokenFor, me, send, SCOPES, VERSION };
