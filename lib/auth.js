'use strict';
/**
 * ログイン。
 *
 * DAY8 は 127.0.0.1（自分のPCの中）だけで動いていたので、鍵は要らなかった。
 * クラウドに置く＝世界中からURLを叩ける、ということなので、
 * これが無いと「URLを知った人が誰でもあなたの Instagram に投稿できる」状態になる。
 *
 * 仕組みは素朴に：
 *   合言葉が合っていたら、「いつまで有効か」に署名をつけた紙をブラウザに持たせる。
 *   署名は SESSION_SECRET でしか作れないので、中身を書き換えても見破れる。
 */

const crypto = require('crypto');

const COOKIE = 'td_session';
const DAYS = 30;

const password = () => process.env.APP_PASSWORD || '';
const secret = () => process.env.SESSION_SECRET || process.env.APP_PASSWORD || '';

/** 長さや中身から正解を推測されないよう、時間のかかり方を揃えて比べる。 */
function equals(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('base64url');
}

/** 合言葉が合っているか。 */
function checkPassword(given) {
  const expected = password();
  if (!expected) return false;
  return equals(given || '', expected);
}

/** ブラウザに持たせる紙を作る。 */
function issue() {
  const expiresAt = Date.now() + DAYS * 24 * 60 * 60 * 1000;
  const body = String(expiresAt);
  return `${body}.${sign(body)}`;
}

function cookieHeader(token) {
  // HttpOnly  … JavaScript から読めない（盗まれにくい）
  // Secure    … https のときしか送らない
  // SameSite  … 他所のサイトから勝手に呼ばれても付いていかない
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DAYS * 24 * 60 * 60}`;
}

const clearHeader = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** 持っている紙が本物で、まだ期限内か。 */
function isLoggedIn(req) {
  if (!password()) return false;               // 合言葉未設定なら誰も入れない（開けっ放しにしない）
  const raw = (req.headers.cookie || '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(COOKIE + '='));
  if (!raw) return false;

  const token = raw.slice(COOKIE.length + 1);
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;

  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!equals(mac, sign(body))) return false;  // 署名が合わない＝作り物

  return Number(body) > Date.now();            // 期限切れ
}

/**
 * 予約コマンド（scripts/schedule-post.js）用の合鍵。
 *
 * ★ ブラウザのページの中で JS を走らせずに、PC から1コマンドで予約するための鍵。
 *   合言葉そのものを PC に置くのは避けたいので、別の環境変数 POST_CLI_TOKEN にする。
 *   32文字未満は推測されやすいので、設定されていても使えないことにする。
 *   未設定なら常に false（鍵が無いのに通ってしまう事故を作らない）。
 */
function hasCliToken(req) {
  const token = process.env.POST_CLI_TOKEN || '';
  if (token.length < 32) return false;
  const given = (req.headers && req.headers.authorization) || '';
  return equals(given, `Bearer ${token}`);
}

/**
 * API の入口で使う。false が返ったら、呼び出し側はそこで終わる。
 *
 * ★ 合鍵が通るのは、呼び出し側が { allowToken: true } と書いた入口だけ。
 *   既定では通さない。合鍵で使える範囲を、予約に要るものだけに絞るため。
 */
function guard(req, res, opts) {
  if (isLoggedIn(req)) return true;
  if (opts && opts.allowToken && hasCliToken(req)) return true;
  res.status(401).json({ error: 'ログインしてください。' });
  return false;
}

module.exports = { checkPassword, issue, cookieHeader, clearHeader, isLoggedIn, hasCliToken, guard, COOKIE };
