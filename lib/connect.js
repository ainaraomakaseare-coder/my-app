'use strict';
/**
 * 各SNSとの接続。
 *
 * ★ 投稿先の単位は「SNS」ではなく「アカウント」。
 *   同じ Instagram でも、企画用とアフィリエイト用を別々に繋げる。
 *
 *   GET    /api/connect                        … 繋がっているアカウントの一覧
 *   GET    /api/connect/youtube?group=…        … 許可画面へ送り出す
 *   GET    /api/connect/youtube?code=…         … 戻ってきたので引換券を保存
 *   POST   /api/connect/instagram              … 発行済みトークンを受け取る
 *   PATCH  /api/connect?id=…                   … 呼び名・所属する運用アカウントを変える
 *   DELETE /api/connect?id=…                   … その連携を解除
 *
 * ★ 新しく繋いだ連携は、必ずどこかの運用アカウントに入れる。
 *   所属が空のままだと、DB側の見張り（assert_target_matches_group）は
 *   「どちらかが未設定なら止めない」ので素通りしてしまう。
 *   つまり繋いだばかりの連携先だけが、誤爆を止められない状態になる。
 *   OAuth は外部サイトへ出て戻ってくるので、行きに預けたクッキーで持ち回す。
 */

const crypto = require('crypto');
const auth = require('./auth');
const db = require('./db');
const google = require('./google');
const xauth = require('./x');
const tiktok = require('./tiktok');
const ig = require('./instagram');

const PKCE_COOKIE = 'td_pkce';
const GROUP_COOKIE = 'td_group';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async function handler(req, res) {
  if (!auth.guard(req, res)) return;

  const q = req.query || {};
  const network = q.network || '';
  const code = q.code;
  const error = q.error;

  try {
    if (req.method === 'DELETE') return res.status(200).json(await disconnect(q.id));
    if (req.method === 'PATCH')  return res.status(200).json(await editAccount(req, q.id));
    if (!network)                return res.status(200).json({ accounts: await db.listAccounts() });
    if (error)                   return back(res, `連携を中止しました（${error}）`);

    // 行きがけに、どの運用アカウントへ入れるかを預けておく。
    if (!code) rememberGroup(res, q.group);

    if (req.method === 'POST' && network === 'instagram') return res.status(200).json(await instagram(req));

    if (network === 'youtube') return await oauthYoutube(req, res, code);
    if (network === 'tiktok')  return await oauthTiktok(req, res, code);
    if (network === 'x')       return await oauthX(req, res, code);

    return res.status(400).json({ error: `${network} には対応していません。` });
  } catch (err) {
    const message = err.message + (err.hint ? '｜' + err.hint : '');
    if (req.method === 'POST' || req.method === 'DELETE' || req.method === 'PATCH') {
      return res.status(400).json({ error: err.message, hint: err.hint });
    }
    return back(res, message);
  }
};

// ---------------------------------------------------------------- 管理

async function disconnect(id) {
  if (!id) throw hint('どの連携を解除するか指定されていません。');
  await db.deleteAccount(id);
  return { disconnected: id };
}

/**
 * 呼び名と、所属する運用アカウントを変える。
 *
 * ★ 所属を移すのは、見た目より危ない操作。
 *   DB側の見張りは post_targets と posts を書き換えたときにしか動かないので、
 *   連携先の所属だけを変えると、すでに出来ている投稿先が食い違ったまま残る。
 *   移す前に、その連携先を使っている投稿を見て、食い違うなら断る。
 */
async function editAccount(req, id) {
  if (!id) throw hint('どの連携か指定されていません。');
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

  const patch = {};
  if (body.label !== undefined) patch.label = (body.label || '').slice(0, 40);

  if (body.group_id !== undefined) {
    const wanted = body.group_id || null;
    if (wanted && !UUID.test(String(wanted))) throw hint('運用アカウントの指定が正しくありません。');
    if (wanted) {
      const groups = await db.listGroups();
      if (!groups.some((g) => g.id === wanted)) throw hint('その運用アカウントは見つかりません。');
      const conflict = await db.accountGroupConflict(id, wanted);
      if (conflict) {
        throw hint(
          `この連携先は「${conflict}」の投稿先になっています。別の運用アカウントへは移せません。`,
          '先にその投稿から投稿先を外すか、投稿ごと同じ運用アカウントへ移してください。'
        );
      }
    }
    patch.group_id = wanted;
  }

  if (!Object.keys(patch).length) throw hint('変えるものがありません。');

  const account = await db.updateAccount(id, patch);
  return { account: { id: account.id, label: account.label, group_id: account.group_id } };
}

// ---------------------------------------------------------------- 運用アカウントの持ち回し

/** Set-Cookie は複数枚になることがあるので、上書きではなく足していく。 */
function addCookie(res, value) {
  const prev = res.getHeader ? res.getHeader('Set-Cookie') : null;
  const list = prev ? (Array.isArray(prev) ? prev.slice() : [prev]) : [];
  list.push(value);
  res.setHeader('Set-Cookie', list);
}

const groupCookie = (value, maxAge) =>
  `${GROUP_COOKIE}=${value}; Path=/api/connect; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/** 行き。許可画面へ出る前に預ける。15分で捨てる。 */
function rememberGroup(res, groupId) {
  if (!groupId || !UUID.test(String(groupId))) return;
  addCookie(res, groupCookie(groupId, 900));
}

/** 帰り。取り出したらすぐ消す。 */
function takeGroup(req, res) {
  const v = readCookie(req, GROUP_COOKIE);
  addCookie(res, groupCookie('', 0));
  return v && UUID.test(v) ? v : null;
}

/**
 * 預かった値が、まだ実在する運用アカウントか確かめる。
 *
 * ★ 消された運用アカウントの id をそのまま入れると外部キーに弾かれ、
 *   連携そのものが失敗する。せっかく取れたトークンを捨てることになるので、
 *   見つからないときは所属なしで通し、あとから画面で選んでもらう。
 *
 * ★ 運用アカウントが1つしか無いなら、指定が無くてもそこへ入れる。
 *   迷いようがないうえ、空のままだと見張りが効かないため。
 */
async function resolveGroup(wanted) {
  let all = [];
  try { all = await db.listGroups(); } catch (_) { return null; }
  if (wanted && all.some((g) => g.id === wanted)) return wanted;
  return all.length === 1 ? all[0].id : null;
}

/** 所属が決まっているときだけ書き込む。再連携で所属を消さないため。 */
const grp = (id) => (id ? { group_id: id } : {});

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

  // チャンネル名を取っておく。複数チャンネルを繋いだとき、画面で見分けるため。
  const name = await safe(() => channelName(token.access_token), 'YouTube');
  const groupId = await resolveGroup(takeGroup(req, res));

  await db.upsertAccount({
    network: 'youtube',
    account_name: name,
    label: name,
    ...grp(groupId),
    refresh_token: token.refresh_token,
    access_token: token.access_token || null,
    expires_at: new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString(),
  });
  return back(res, `YouTube「${name}」と接続しました`);
}

async function channelName(accessToken) {
  const res = await fetch(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const json = await res.json();
  const item = json.items && json.items[0];
  if (!item) throw new Error('チャンネルが見つかりません');
  return item.snippet.title;
}

// ---------------------------------------------------------------- TikTok

async function oauthTiktok(req, res, code) {
  const redirectUri = selfUrl(req, 'tiktok');
  if (!code) return go(res, tiktok.authUrl(redirectUri, crypto.randomBytes(8).toString('hex')));

  const token = await tiktok.exchangeCode(code, redirectUri);
  const name = await safe(() => tiktokName(token.access_token), 'TikTok');
  const groupId = await resolveGroup(takeGroup(req, res));

  await db.upsertAccount({
    network: 'tiktok',
    account_name: name,
    label: name,
    ...grp(groupId),
    refresh_token: token.refresh_token,
    access_token: token.access_token,
    expires_at: new Date(Date.now() + (token.expires_in || 86400) * 1000).toISOString(),
  });
  return back(res, `TikTok「${name}」と接続しました（審査前のため、投稿は自分のみ表示になります）`);
}

async function tiktokName(accessToken) {
  const res = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=display_name', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json();
  const name = json.data && json.data.user && json.data.user.display_name;
  if (!name) throw new Error('表示名が取れません');
  return name;
}

// ---------------------------------------------------------------- X

async function oauthX(req, res, code) {
  const redirectUri = selfUrl(req, 'x');

  if (!code) {
    // PKCE の合言葉は、戻ってくるまでブラウザに預けておく。
    const { verifier, challenge } = xauth.makeVerifier();
    addCookie(res,
      `${PKCE_COOKIE}=${verifier}; Path=/api/connect; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    return go(res, xauth.authUrl(redirectUri, challenge));
  }

  const verifier = readCookie(req, PKCE_COOKIE);
  if (!verifier) {
    throw hint('認証の途中経過が見つかりませんでした。', '時間が経ちすぎた可能性があります。もう一度「接続する」から始めてください。');
  }

  const token = await xauth.exchangeCode(code, redirectUri, verifier);
  const name = await safe(() => xName(token.access_token), 'X');
  const groupId = await resolveGroup(takeGroup(req, res));

  await db.upsertAccount({
    network: 'x',
    account_name: name,
    label: name,
    ...grp(groupId),
    refresh_token: token.refresh_token,
    access_token: token.access_token,
    expires_at: new Date(Date.now() + (token.expires_in || 7200) * 1000).toISOString(),
  });
  addCookie(res, `${PKCE_COOKIE}=; Path=/api/connect; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return back(res, `X「${name}」と接続しました`);
}

async function xName(accessToken) {
  const res = await fetch('https://api.x.com/2/users/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json();
  const u = json.data && json.data.username;
  if (!u) throw new Error('ユーザー名が取れません');
  return '@' + u;
}

// ---------------------------------------------------------------- Instagram

/**
 * Instagram は OAuth の往復をせず、Meta の管理画面で発行したトークンを貼る方式。
 * DAY8 と同じ。短期トークンなら60日の長期トークンへ交換を試みる。
 */
async function instagram(req) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const given = (body.token || '').trim();
  if (!given) throw hint('トークンが空です。', 'Meta の管理画面の Generate token で発行した文字列を貼ってください。');

  let token = given;
  let expiresAt = null;
  let exchangeNote = '交換しませんでした';

  try {
    const long = await ig.exchangeForLongLived(given);
    if (long.access_token) {
      token = long.access_token;
      expiresAt = new Date(Date.now() + (long.expires_in || 60 * 24 * 3600) * 1000).toISOString();
      exchangeNote = '長期トークンへ交換しました';
    }
  } catch (e) {
    exchangeNote = '交換できませんでした（' + e.message + '）';
  }

  // ここで初めて本物か確かめる。失敗したときは切り分けの材料を添える。
  let who;
  try {
    who = await ig.me(token);
  } catch (e) {
    const raw = (e.raw && e.raw.error) || {};
    e.hint = [
      e.hint, '', '— 診断 —',
      '貼られた値の先頭：' + given.slice(0, 4) + '（Instagram のトークンは IGAA で始まります）',
      '貼られた値の文字数：' + given.length,
      'トークンの交換：' + exchangeNote,
      'Meta のエラーコード：' + (raw.code ?? '不明') +
        (raw.error_subcode ? '（詳細 ' + raw.error_subcode + '）' : ''),
      'Meta の原文：' + (raw.message || '（なし）'),
    ].join('\n');
    throw e;
  }

  const name = who.username ? '@' + who.username : 'Instagram';
  const groupId = await resolveGroup(body.group_id || null);
  const account = await db.upsertAccount({
    network: 'instagram',
    account_name: name,
    label: (body.label || '').slice(0, 40) || name,
    ...grp(groupId),
    access_token: token,
    expires_at: expiresAt,
  });

  return {
    connected: true,
    account: name,
    id: account.id,
    expiresAt,
    // ★ トークンそのものは絶対に返さない。先頭6文字だけ。
    token: mask(token),
  };
}

const mask = (s) => (s ? s.slice(0, 6) + '…(' + s.length + '文字)' : null);

// ---------------------------------------------------------------- 共通

/** 名前が取れなくても連携そのものは成立させる。名前は見分けのための飾り。 */
async function safe(fn, fallback) {
  try { return (await fn()) || fallback; } catch (_) { return fallback; }
}

/**
 * 自分自身のコールバックURL。
 * クエリを付けないのは、Google・TikTok・X が登録時にクエリ付きURLを弾くことがあるため。
 */
function selfUrl(req, network) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}/api/connect/${network}`;
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
