'use strict';
const env = require('./env');

const API = 'https://graph.instagram.com';
const VERSION = process.env.IG_API_VERSION || 'v23.0';

/** APIが返したエラーを、原因と次の一手が分かる日本語にして持ち運ぶ。 */
class InstagramError extends Error {
  constructor(message, hint, raw) {
    super(message);
    this.hint = hint;
    this.raw = raw;
  }
}

/**
 * Metaのエラーは英語で番号だけのことが多い。よく出るものを翻訳して、
 * 「次に何をすればいいか」まで書いて返す。
 */
function translate(raw) {
  const e = (raw && raw.error) || {};
  const code = e.code;
  const sub = e.error_subcode;
  const msg = e.message || 'Instagram から理由の分からない返事が来ました。';

  if (code === 190) {
    return ['アクセストークンが無効か、有効期限が切れています。',
      'Meta の管理画面でトークンを発行し直し、設定画面に貼り直してください。短期トークンは1時間で切れます。'];
  }
  if (code === 10 || code === 200 || sub === 2207050) {
    return ['このトークンには投稿する権限がありません。',
      'Meta アプリの権限に instagram_business_content_publish が入っているか、自分が Instagram Tester として承認済みかを確認してください。'];
  }
  if (sub === 2207052 || /account.*not.*(professional|business)/i.test(msg)) {
    return ['Instagram がプロアカウント（ビジネス／クリエイター）になっていません。',
      'Instagram アプリ → 設定 → アカウントの種類とツール から切り替えてください。'];
  }
  if (sub === 2207003 || /could not (be )?(fetch|download)/i.test(msg)) {
    return ['Instagram があなたのメディアファイルを取得できませんでした。',
      '公開URL（Cloudflare トンネル）が今も開いているか、設定画面のURLが最新かを確認してください。ブラウザでそのURLを開いて画像/動画が表示されれば正しい状態です。'];
  }
  if (sub === 2207026 || /media type|format|aspect ratio/i.test(msg)) {
    return ['メディアの形式が Instagram の条件を満たしていません。',
      'リールは MP4（H.264 + AAC）、縦横比 9:16 前後、3秒〜15分。画像は JPEG で 8MB 以下が目安です。'];
  }
  if (sub === 2207042 || /rate limit|too many/i.test(msg)) {
    return ['短時間に投稿しすぎです（24時間で100件まで）。',
      '時間をあけてから再実行してください。'];
  }
  return [msg, 'Meta のエラーコード ' + (code ?? '不明') + (sub ? '（詳細 ' + sub + '）' : '') + ' です。'];
}

async function call(pathname, params = {}, method = 'GET', explicitToken) {
  // クラウドではトークンを DB から渡す。ローカルで動かすときは .env を見る。
  const token = explicitToken || process.env.IG_ACCESS_TOKEN;
  if (!token) {
    throw new InstagramError(
      'アクセストークンが設定されていません。',
      '画面の「Instagram 連携」からトークンを登録してください。'
    );
  }
  return raw(pathname, { ...params, access_token: token }, method);
}

/** トークンを引数で渡したいとき（交換前の短期トークンなど）はこちら。 */
async function raw(pathname, params, method = 'GET') {
  const url = new URL(API + pathname);
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) form.set(k, String(v));

  let res;
  try {
    if (method === 'GET') {
      url.search = form.toString();
      res = await fetch(url, { method: 'GET' });
    } else {
      res = await fetch(url, { method, body: form });
    }
  } catch (err) {
    throw new InstagramError(
      'Instagram に接続できませんでした。',
      'ネットワークが繋がっているか確認してください。（' + err.message + '）'
    );
  }

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }

  if (!res.ok) {
    const [message, hint] = translate(json);
    throw new InstagramError(message, hint, json);
  }
  return json;
}

/** つながっているアカウントを聞く。接続確認はこれ1本で足りる。 */
async function me(token) {
  return call(`/${VERSION}/me`, { fields: 'user_id,username,account_type,media_count' }, 'GET', token);
}

/**
 * 1時間で切れる短期トークンを、60日もつ長期トークンに交換する。
 * OAuth の「短期→長期」はここで実際に起きている。
 */
async function exchangeForLongLived(shortToken) {
  const secret = process.env.IG_APP_SECRET;
  if (!secret) {
    throw new InstagramError(
      'アプリシークレット（IG_APP_SECRET）が .env にありません。',
      'Meta の管理画面 → アプリ設定 → ベーシック から Instagram App Secret をコピーして .env に書いてください。'
    );
  }
  return raw('/access_token', {
    grant_type: 'ig_exchange_token',
    client_secret: secret,
    access_token: shortToken,
  });
}

/** 長期トークンの期限を今日から60日に延ばす。24時間以上使ったトークンにのみ有効。 */
async function refreshLongLived() {
  return call('/refresh_access_token', { grant_type: 'ig_refresh_token' });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Instagram への投稿は2段構え。
 *   1. コンテナを作る（Instagram がURLからメディアを取りに来て、変換する）
 *   2. 変換が終わったら公開する
 * 動画は 1 に時間がかかるので、終わるまで様子を見に行く。
 */
async function publish({ mediaUrl, caption, kind, onProgress = () => {} }) {
  const isVideo = kind === 'video';
  const params = isVideo
    ? { media_type: 'REELS', video_url: mediaUrl, caption }
    : { image_url: mediaUrl, caption };

  onProgress(isVideo ? 'リールのコンテナを作成中…' : '画像のコンテナを作成中…');
  const container = await call(`/${VERSION}/me/media`, params, 'POST');

  onProgress('Instagram がメディアを取得・変換しています…');
  await waitUntilReady(container.id, onProgress);

  onProgress('公開しています…');
  const published = await call(`/${VERSION}/me/media_publish`, { creation_id: container.id }, 'POST');

  let permalink = null;
  try {
    const info = await call(`/${VERSION}/${published.id}`, { fields: 'permalink' });
    permalink = info.permalink || null;
  } catch (_) { /* 公開自体は済んでいるのでURLが取れなくても失敗にはしない */ }

  return { containerId: container.id, mediaId: published.id, permalink };
}

async function waitUntilReady(containerId, onProgress, timeoutMs = 5 * 60 * 1000) {
  const started = Date.now();
  let waited = 0;
  while (Date.now() - started < timeoutMs) {
    const info = await call(`/${VERSION}/${containerId}`, { fields: 'status_code,status' });
    const code = info.status_code;
    if (code === 'FINISHED') return info;
    if (code === 'ERROR' || code === 'EXPIRED') {
      throw new InstagramError(
        'Instagram 側でメディアの処理に失敗しました。',
        info.status || 'ファイル形式が条件を満たしていない可能性が高いです。リールは MP4（H.264 + AAC）が必要です。',
        info
      );
    }
    waited += 3;
    onProgress(`変換待ち… ${waited}秒経過（動画は1分前後かかることがあります）`);
    await sleep(3000);
  }
  throw new InstagramError(
    '5分待ちましたが Instagram の処理が終わりませんでした。',
    'ファイルサイズを小さくして試してください。'
  );
}

module.exports = { call, raw, me, publish, exchangeForLongLived, refreshLongLived, InstagramError, translate, VERSION };
