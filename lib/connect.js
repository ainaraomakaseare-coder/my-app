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
    if (error)                   return backErr(res, `連携を中止しました（${error}）`);

    // 行きがけに、どの運用アカウントへ入れるかを預けておく。
    if (!code) rememberGroup(res, q.group);

    if (req.method === 'POST' && network === 'instagram') return res.status(200).json(await instagram(req));

    if (network === 'youtube') return await oauthYoutube(req, res, code);
    if (network === 'tiktok')  return await oauthTiktok(req, res, code);
    if (network === 'x')       return await oauthX(req, res, code);

    return res.status(400).json({ error: `${network} には対応していません。` });
  } catch (err) {
    if (req.method === 'POST' || req.method === 'DELETE' || req.method === 'PATCH') {
      return res.status(400).json({ error: err.message, hint: err.hint });
    }
    return backErr(res, err.message, err.hint);
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

/**
 * 連携先を保存する、唯一の入り口。
 *
 * ★ ここに一本化してあるのは、上書きの判断を1か所に閉じ込めるため。
 *   以前は db 側が「同じSNSで同じ表示名なら同じ連携先」とみなして上書きしていた。
 *   TikTok は表示名が取れないと 'TikTok' に落ちるので、
 *   2つ目のアカウントを繋いだ瞬間に1つ目（別チャンネルのもの）を奪っていた。
 *
 * ★ いまは SNS 側のIDで突き合わせ、
 *   すでに別のチャンネルにぶら下がっているなら、黙って奪わず断る。
 *   繋ぎたいアカウントと違うものにログインしている、という取り違えが
 *   一番ありがちなので、そのまま通すと本人が気づけない。
 */
async function saveAccount({ network, name, externalId, label, groupId, token }) {
  const found = await db.findAccountByIdentity({
    network, external_id: externalId || null, account_name: name,
  });

  if (found && found.group_id && groupId && found.group_id !== groupId) {
    const all = await db.listGroups().catch(() => []);
    const owner = all.find((g) => g.id === found.group_id);
    const wanted = all.find((g) => g.id === groupId);
    throw hint(
      `${NET_LABEL[network] || network}「${found.account_name || found.label}」は、` +
      `すでに「${owner ? owner.label : '別の運用アカウント'}」につながっています。` +
      `「${wanted ? wanted.label : 'こちら'}」には入れられません。`,
      // ★ 段落の途中で改行を入れない。画面の幅は分からないので、折り返しは向こうに任せる。
      [
        '同じアカウントを2つのチャンネルに入れることはできません。',
        '',
        '● 別のアカウントを繋ぐつもりだった場合',
        `いまブラウザで ${NET_LABEL[network] || network} にログインしているアカウントが、繋ぎたいものと違います。` +
        `一度ログアウトするか、シークレットウィンドウで開いてから、もう一度「繋ぐ」を押してください。`,
        '',
        '● こちらへ移したい場合',
        `「${owner ? owner.label : '元の運用アカウント'}」の連携設定で、その連携先の所属を変えてください。`,
      ].join('\n')
    );
  }

  return db.upsertAccount({
    id: found ? found.id : null,
    network,
    account_name: name,
    external_id: externalId || (found && found.external_id) || null,
    // ★ 呼び名は、本人が付け替えたものを上書きしない。
    //   画面で入れてもらったときだけ従い、あとは空のときに名前を入れる。
    ...(label ? { label } : (found && found.label ? {} : { label: name })),
    ...grp(groupId),
    ...token,
  });
}

const NET_LABEL = {
  youtube: 'YouTube', instagram: 'Instagram', x: 'X', tiktok: 'TikTok',
};

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

  // チャンネル名とチャンネルIDを取っておく。名前は見分けるため、IDは取り違えないため。
  const who = await safe(() => channel(token.access_token), 'YouTube');
  const groupId = await resolveGroup(takeGroup(req, res));

  await saveAccount({
    network: 'youtube', name: who.name, externalId: who.id, groupId,
    token: {
      refresh_token: token.refresh_token,
      access_token: token.access_token || null,
      expires_at: new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString(),
    },
  });
  return back(res, `YouTube「${who.name}」と接続しました`);
}

async function channel(accessToken) {
  const res = await fetch(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const json = await res.json();
  const item = json.items && json.items[0];
  if (!item) throw new Error('チャンネルが見つかりません');
  return { name: item.snippet.title, id: item.id };
}

// ---------------------------------------------------------------- TikTok

async function oauthTiktok(req, res, code) {
  const redirectUri = selfUrl(req, 'tiktok');
  if (!code) return go(res, tiktok.authUrl(redirectUri, crypto.randomBytes(8).toString('hex')));

  const token = await tiktok.exchangeCode(code, redirectUri);
  const who = await safe(() => tiktokUser(token.access_token), 'TikTok');
  const groupId = await resolveGroup(takeGroup(req, res));

  // ★ open_id は引換券と一緒に必ず返る。
  //   表示名を取りに行く方は権限しだいで失敗し、そのときは 'TikTok' に落ちる。
  //   名前だけで見分けていると、2つ目のアカウントが1つ目を奪う。IDを主にする。
  const externalId = who.id || token.open_id || null;

  await saveAccount({
    network: 'tiktok', name: who.name, externalId, groupId,
    token: {
      refresh_token: token.refresh_token,
      access_token: token.access_token,
      expires_at: new Date(Date.now() + (token.expires_in || 86400) * 1000).toISOString(),
    },
  });
  return back(res, `TikTok「${who.name}」と接続しました（審査前のため、投稿は自分のみ表示になります）`);
}

async function tiktokUser(accessToken) {
  const res = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json();
  const user = (json.data && json.data.user) || {};
  if (!user.display_name) throw new Error('表示名が取れません');
  return { name: user.display_name, id: user.open_id || null };
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
  const who = await safe(() => xUser(token.access_token), 'X');
  const groupId = await resolveGroup(takeGroup(req, res));

  await saveAccount({
    network: 'x', name: who.name, externalId: who.id, groupId,
    token: {
      refresh_token: token.refresh_token,
      access_token: token.access_token,
      expires_at: new Date(Date.now() + (token.expires_in || 7200) * 1000).toISOString(),
    },
  });
  addCookie(res, `${PKCE_COOKIE}=; Path=/api/connect; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return back(res, `X「${who.name}」と接続しました`);
}

async function xUser(accessToken) {
  const res = await fetch('https://api.x.com/2/users/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json();
  const u = json.data && json.data.username;
  if (!u) throw new Error('ユーザー名が取れません');
  return { name: '@' + u, id: (json.data && json.data.id) || null };
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
  const account = await saveAccount({
    network: 'instagram', name,
    externalId: who.user_id || who.id || null,
    label: (body.label || '').slice(0, 40),
    groupId,
    token: { access_token: token, expires_at: expiresAt },
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

/**
 * 名前が取れなくても連携そのものは成立させる。名前は見分けのための飾り。
 *
 * ★ ただし id は飾りではない。取れなかったら null のまま返す。
 *   ここで適当な値を作ると、別のアカウントと同じ id になりかねない。
 */
async function safe(fn, fallback) {
  try {
    const got = await fn();
    return { name: (got && got.name) || fallback, id: (got && got.id) || null };
  } catch (_) {
    return { name: fallback, id: null };
  }
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

/**
 * 画面に戻す。結果はURLに載せる（トークンは絶対に載せない）。
 *
 * ★ うまくいったのか駄目だったのかを ng=1 で分ける。
 *   同じ見た目で出すと、「別のチャンネルのものを奪いかけた」という
 *   一番読んでほしい断りが、成功の知らせに紛れてしまう。
 */
function back(res, message) {
  return sendBack(res, message, false, null);
}

function backErr(res, message, hint) {
  return sendBack(res, message, true, hint);
}

/**
 * ★ 用件と直し方は、別々の値として渡す。
 *   ひとつの文字列に区切り文字で詰めると、
 *   「ひろや｜AI初心者30日30アプリ」のように
 *   区切り文字を名前に含む運用アカウントで、変なところで切れる。
 */
function sendBack(res, message, ng, hint) {
  const q = new URLSearchParams({ connected: message });
  if (ng) q.set('ng', '1');
  if (hint) q.set('hint', hint);
  res.writeHead(302, { Location: '/?' + q });
  return res.end();
}

function hint(message, h) {
  const e = new Error(message);
  e.hint = h;
  return e;
}
