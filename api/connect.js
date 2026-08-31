'use strict';
/**
 * 各SNSとの接続。
 *
 *   GET  /api/connect                      … いまの接続状況を返す
 *   GET  /api/connect?network=youtube      … 許可画面へ送り出す
 *   GET  /api/connect?network=youtube&code=… … 戻ってきたので引換券を保存
 *   POST /api/connect?network=instagram    … 発行済みトークンを受け取る
 *   DELETE /api/connect?network=x          … 連携を解除
 *
 * リダイレクト先は「今アクセスされているURL」から組み立てる。
 * 環境ごとに書き分けなくて済み、設定ミスの余地が減る。
 */

const crypto = require('crypto');
const auth = require('../lib/auth');
const db = require('../lib/db');
const google = require('../lib/google');
const xauth = require('../lib/x');
const tiktok = require('../lib/tiktok');
const ig = require('../lib/instagram');

const PKCE_COOKIE = 'td_pkce';

module.exports = async function handler(req, res) {
  if (!auth.guard(req, res)) return;

  const network = (req.query && req.query.network) || '';
  const code = req.query && req.query.code;
  const error = req.query && req.query.error;

  try {
    if (!network) return res.status(200).json(await status());
    if (req.method === 'DELETE') return res.status(200).json(await disconnect(network));
    if (error) return back(res, `連携を中止しました（${error}）`);

    if (req.method === 'POST' && network === 'instagram') return res.status(200).json(await instagram(req));

    if (network === 'youtube') return await oauthYoutube(req, res, code);
    if (network === 'tiktok')  return await oauthTiktok(req, res, code);
    if (network === 'x')       return await oauthX(req, res, code);

    return res.status(400).json({ error: `${network} には対応していません。` });
  } catch (err) {
    const message = err.message + (err.hint ? '｜' + err.hint : '');
    if (req.method === 'POST') return res.status(400).json({ error: err.message, hint: err.hint });
    return back(res, message);
  }
};

// ---------------------------------------------------------------- 状況

async function status() {
  const rows = (await db.rest('sns_tokens', { query: { select: 'network,account_name,expires_at,updated_at' } })) || [];
  const byNetwork = {};
  for (const r of rows) {
    byNetwork[r.network] = {
      connected: true,
      account: r.account_name || null,
      expiresAt: r.expires_at || null,
      // 期限が7日以内なら画面で警告を出せるようにする
      expiringSoon: r.expires_at
        ? new Date(r.expires_at).getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000
        : false,
    };
  }
  for (const n of ['instagram', 'youtube', 'x', 'tiktok']) {
    if (!byNetwork[n]) byNetwork[n] = { connected: false };
  }
  return byNetwork;
}

async function disconnect(network) {
  await db.rest('sns_tokens', { method: 'DELETE', query: { network: `eq.${network}` } });
  return { disconnected: network };
}

// ---------------------------------------------------------------- YouTube

async function oauthYoutube(req, res, code) {
  const redirectUri = selfUrl(req, 'youtube');
  if (!code) return go(res, google.authUrl(redirectUri));

  const token = await google.exchangeCode(code, redirectUri);
  if (!token.refresh_token) {
    throw hint(
      'Google から「今後も使ってよい」という引換券が返りませんでした。',
      'Google アカウントのセキュリティ設定でこのアプリのアクセスを一度削除してから、もう一度連携してください。'
    );
  }
  await db.saveToken('youtube', {
    refresh_token: token.refresh_token,
    access_token: token.access_token || null,
    expires_at: new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString(),
    account_name: 'YouTube',
  });
  return back(res, 'YouTube と接続しました');
}

// ---------------------------------------------------------------- TikTok

async function oauthTiktok(req, res, code) {
  const redirectUri = selfUrl(req, 'tiktok');
  if (!code) return go(res, tiktok.authUrl(redirectUri, crypto.randomBytes(8).toString('hex')));

  const token = await tiktok.exchangeCode(code, redirectUri);
  await db.saveToken('tiktok', {
    refresh_token: token.refresh_token,
    access_token: token.access_token,
    expires_at: new Date(Date.now() + (token.expires_in || 86400) * 1000).toISOString(),
    account_name: 'TikTok',
  });
  return back(res, 'TikTok と接続しました（審査前のため、投稿は自分のみ表示になります）');
}

// ---------------------------------------------------------------- X

async function oauthX(req, res, code) {
  const redirectUri = selfUrl(req, 'x');

  if (!code) {
    // PKCE の合言葉は、戻ってくるまでブラウザに預けておく。
    // DB に置くと、既存のトークン行を壊さないための配慮が余計に要る。
    const { verifier, challenge } = xauth.makeVerifier();
    res.setHeader('Set-Cookie',
      `${PKCE_COOKIE}=${verifier}; Path=/api/connect; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    return go(res, xauth.authUrl(redirectUri, challenge));
  }

  const verifier = readCookie(req, PKCE_COOKIE);
  if (!verifier) {
    throw hint('認証の途中経過が見つかりませんでした。', '時間が経ちすぎた可能性があります。もう一度「接続する」から始めてください。');
  }

  const token = await xauth.exchangeCode(code, redirectUri, verifier);
  await db.saveToken('x', {
    refresh_token: token.refresh_token,
    access_token: token.access_token,
    expires_at: new Date(Date.now() + (token.expires_in || 7200) * 1000).toISOString(),
    account_name: 'X',
  });
  res.setHeader('Set-Cookie', `${PKCE_COOKIE}=; Path=/api/connect; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return back(res, 'X と接続しました');
}

// ---------------------------------------------------------------- Instagram

/**
 * Instagram は OAuth の往復をせず、Meta の管理画面で発行したトークンを貼る方式。
 * DAY8 と同じ。1時間で切れる短期トークンを、60日もつ長期トークンへ交換する。
 */
async function instagram(req) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const given = (body.token || '').trim();
  if (!given) throw hint('トークンが空です。', 'Meta の管理画面の Generate token で発行した文字列を貼ってください。');

  let token = given;
  let expiresAt = null;

  // 交換に失敗しても、そのトークン自体は使えることがあるので致命的にはしない
  try {
    const long = await ig.exchangeForLongLived(given);
    if (long.access_token) {
      token = long.access_token;
      expiresAt = new Date(Date.now() + (long.expires_in || 60 * 24 * 3600) * 1000).toISOString();
    }
  } catch (_) { /* 短期トークンのまま進む */ }

  const who = await ig.me(token);   // ここで初めて本物か確かめる

  await db.saveToken('instagram', {
    access_token: token,
    expires_at: expiresAt,
    account_name: who.username ? '@' + who.username : 'Instagram',
  });

  return {
    connected: true,
    account: who.username ? '@' + who.username : null,
    expiresAt,
    // ★ トークンそのものは絶対に返さない。先頭6文字だけ。
    token: mask(token),
  };
}

const mask = (s) => (s ? s.slice(0, 6) + '…(' + s.length + '文字)' : null);

// ---------------------------------------------------------------- 共通

function selfUrl(req, network) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}/api/connect?network=${network}`;
}

function readCookie(req, name) {
  const hit = (req.headers.cookie || '').split(';').map((s) => s.trim())
    .find((s) => s.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : null;
}

function go(res, url) {
  res.writeHead(302, { Location: url });
  return res.end();
}

/** 画面に戻す。結果はURLに載せる（トークンは絶対に載せない）。 */
function back(res, message) {
  res.writeHead(302, { Location: '/?connected=' + encodeURIComponent(message) });
  return res.end();
}

function hint(message, h) {
  const e = new Error(message);
  e.hint = h;
  return e;
}
