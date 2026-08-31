'use strict';
/**
 * 各SNSとの接続（OAuth の行き帰り）。
 *
 *   ①「連携する」を押す          → GET /api/connect?network=youtube
 *                                   → 許可画面（Google など）へ送り出す
 *   ② 本人が「許可」を押す        → 相手が code を持たせて戻してくる
 *                                   → GET /api/connect?network=youtube&code=...
 *                                   → code をリフレッシュトークンに引き換えて DB に保存
 *
 * リダイレクト先は「今アクセスされているURL」から組み立てる。
 * 環境ごとにURLを書き分けなくて済み、設定ミスの余地を減らせる。
 */

const auth = require('../lib/auth');
const db = require('../lib/db');
const google = require('../lib/google');

module.exports = async function handler(req, res) {
  if (!auth.guard(req, res)) return;

  const network = (req.query && req.query.network) || '';
  const code = req.query && req.query.code;
  const error = req.query && req.query.error;

  if (error) return back(res, `連携をキャンセルしました（${error}）`);

  try {
    if (network === 'youtube') return await youtube(req, res, code);

    return res.status(400).json({
      error: `${network || '(未指定)'} の連携にはまだ対応していません。`,
      hint: 'いまは YouTube のみです。TikTok と X は実装中です。',
    });
  } catch (err) {
    return back(res, err.message + (err.hint ? '｜' + err.hint : ''));
  }
};

async function youtube(req, res, code) {
  const redirectUri = selfUrl(req, 'youtube');

  // ① まだ code が無い ＝ これから許可画面へ送り出す場面
  if (!code) {
    res.writeHead(302, { Location: google.authUrl(redirectUri) });
    return res.end();
  }

  // ② 戻ってきた
  const token = await google.exchangeCode(code, redirectUri);

  if (!token.refresh_token) {
    // access_type=offline と prompt=consent を付けているので普通は来ないが、
    // 一度許可済みのアカウントだと省略されることがある。
    throw hint(
      'Google から「今後も使ってよい」という引換券が返りませんでした。',
      'Google アカウントのセキュリティ設定から、このアプリのアクセスを一度削除して、もう一度連携してください。'
    );
  }

  await db.saveToken('youtube', {
    refresh_token: token.refresh_token,
    access_token: token.access_token || null,
    expires_at: new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString(),
  });

  return back(res, 'YouTube と接続しました');
}

/** いまアクセスされているアドレスから、自分自身のURLを組み立てる。 */
function selfUrl(req, network) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}/api/connect?network=${network}`;
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
