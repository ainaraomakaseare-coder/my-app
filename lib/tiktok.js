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

// ★ サンドボックスで使えるのは video.upload（下書き送信）まで。
//   video.publish（直接投稿）は審査を通ったアプリにしか提供されない。
//
// ★ 後ろの2つは数字を読むためのもの。
//     user.info.stats … フォロワー数・いいね総数
//     video.list      … 動画ごとの再生数・いいね数
//   ここに足すだけでは効かない。TikTok の管理画面（アプリ側とサンドボックス側の
//   両方）でも同じ権限を有効にし、そのうえで繋ぎ直す必要がある。
//   古い引換券には古い権限しか入っていないため。
const SCOPES = ['user.info.basic', 'video.upload', 'user.info.stats', 'video.list'];

// ★ 直接投稿（video.publish）は、TikTok の管理画面で Direct Post を有効にして
//   からでないと、許可画面そのものがエラーになる。だから環境変数で明示的に
//   オンにしたときだけ頼む。オンにしていない人の連携を壊さないため。
//     TIKTOK_DIRECT_POST=1 → video.publish も頼む
const directEnabled = () => process.env.TIKTOK_DIRECT_POST === '1';
const scopes = () => (directEnabled() ? SCOPES.concat('video.publish') : SCOPES);

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
    scope: scopes().join(','),
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
    // 更新のたびに、いま実際に持っている権限を書き直す。
    ...(fresh.scope ? { meta: withScopes(row.meta, fresh.scope) } : {}),
  });
  return fresh.access_token;
}

// ---------------------------------------------------------------- 権限

/** TikTok は許可した権限を "a,b,c" の1本の文字列で返す。 */
function parseScopes(scope) {
  return String(scope || '').split(/[,\s]+/).filter(Boolean);
}

/** meta に権限を書き足した新しい meta を返す（他のキーは残す）。 */
function withScopes(meta, scope) {
  return Object.assign({}, meta || {}, { scopes: parseScopes(scope) });
}

/**
 * このアカウントで直接投稿できるか。
 *
 * ★ 「頼んだ権限」ではなく「実際にもらえた権限」で決める。
 *   許可画面で本人が外すことも、TikTok 側で付かないこともある。
 *   連携したときの返事（scope）を meta.scopes に残してあるので、それを見る。
 */
function canDirectPost(account) {
  const s = account && account.meta && account.meta.scopes;
  return Array.isArray(s) && s.includes('video.publish');
}

// ---------------------------------------------------------------- 投稿者の情報

/**
 * 直接投稿の直前に必ず取る、投稿者の情報。
 * 公開範囲の選択肢、コメント等が閉じられているか、動画の長さの上限が入っている。
 *
 * ★ TikTok の決まりで、投稿画面を出すたびに最新を取ることになっている。
 *   ここでは形を揃えて返すだけ。失敗は日本語にして投げる。
 */
async function creatorInfo(accessToken) {
  const res = await fetch('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: '{}',
  });
  const json = await res.json().catch(() => ({}));
  const code = (json.error && json.error.code) || '';

  if (res.status === 401 || code === 'access_token_invalid') {
    throw hintErr('TikTok の認証が切れています。', '「連携設定」から接続し直してください。');
  }
  if (code === 'scope_not_authorized') {
    throw hintErr('このTikTok連携には直接投稿の権限がありません。',
      'TikTok の管理画面で Direct Post を有効にし、Vercel に TIKTOK_DIRECT_POST=1 を入れて再デプロイしてから、連携をやり直してください。');
  }
  if (code === 'spam_risk_too_many_posts') {
    throw hintErr('TikTok の1日の投稿数の上限に達しています。', '明日以降に予約し直してください。');
  }
  if (code === 'spam_risk_user_banned_from_posting') {
    throw hintErr('このTikTokアカウントは、いま投稿が制限されています。', 'TikTok アプリで状態を確認してください。');
  }
  if (code === 'reached_active_user_cap') {
    throw hintErr('このアプリの1日の利用者数の上限に達しました（審査前は24時間で5人まで）。', '時間をあけてください。');
  }
  if (!res.ok || (code && code !== 'ok')) {
    throw hintErr(`TikTok が ${code || res.status} を返しました。`, ((json.error && json.error.message) || '').slice(0, 300));
  }

  const d = json.data || {};
  return {
    nickname: d.creator_nickname || '',
    username: d.creator_username || '',
    avatarUrl: d.creator_avatar_url || '',
    privacyOptions: Array.isArray(d.privacy_level_options) ? d.privacy_level_options : [],
    commentDisabled: !!d.comment_disabled,
    duetDisabled: !!d.duet_disabled,
    stitchDisabled: !!d.stitch_disabled,
    maxDurationSec: typeof d.max_video_post_duration_sec === 'number' ? d.max_video_post_duration_sec : null,
  };
}

function hintErr(message, h) {
  const e = new Error(message);
  e.hint = h;
  return e;
}

module.exports = {
  authUrl, exchangeCode, refresh, accessTokenFor, SCOPES,
  directEnabled, parseScopes, withScopes, canDirectPost, creatorInfo,
};
