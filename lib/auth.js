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

/** API の入口で使う。false が返ったら、呼び出し側はそこで終わる。 */
function guard(req, res) {
  if (isLoggedIn(req)) return true;
  res.status(401).json({ error: 'ログインしてください。' });
  return false;
}

module.exports = { checkPassword, issue, cookieHeader, clearHeader, isLoggedIn, guard, COOKIE };
