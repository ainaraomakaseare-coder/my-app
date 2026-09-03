'use strict';
/**
 * SNS から「数字」（フォロワー数・再生数など）を読むだけの窓口。
 *
 * ★ ここは読むだけ。DBへの保存や、どのアカウントを対象にするかの判断は
 *   呼び出す側（cron など）の仕事。lib/insights.js は「1アカウント分」
 *   「1投稿ぶん」を渡されたら、素直に数字を持って帰るだけにする。
 *
 * ★ 1つのSNSがコケても他を巻き込まない。
 *   YouTube と Instagram と TikTok を1回のバッチで順に処理するはずなので、
 *   ここで throw すると Instagram の失敗が YouTube の分まで止めてしまう。
 *   だから必ず { ok:false, error, hint, raw } を返す。呼び出す側は
 *   ok を見て、false なら account_metrics / target_metrics に
 *   ok=false の行として素直に残せばよい（数字が0件なのと、断られたのは別物）。
 *
 * ★ raw を必ず持ち帰る。
 *   「本当は取れるはずなのに null になっている」を後から見分けるための
 *   唯一の手がかりが生レスポンス。捨てると診断できなくなる。
 */

const google = require('./google');
const tiktok = require('./tiktok');
const ig = require('./instagram');

// ---------------------------------------------------------------------------
// 共通の小道具
// ---------------------------------------------------------------------------

/** 配列を size 件ずつに割る（YouTube の videos.list は id を50件までしか渡せない）。 */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 数字らしきものを Number にする。無ければ null。
 * ★ YouTube の statistics は数字も文字列（"12345"）で返ってくる。
 *   Number() を通さずに JSON へ保存すると "12345" という文字列のまま入る。
 */
function numOrNull(v) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/** レスポンス本文をなるべく落とさずに読む。JSONでなくても raw.raw に文字列で残す。 */
async function safeJson(res) {
  const text = await res.text().catch(() => '');
  try { return JSON.parse(text); } catch (_) { return { raw: text }; }
}

/**
 * 予期しない例外（トークン取得の失敗など）を、投げっぱなしにせず
 * この関数の戻り値の形に変換する最後の受け皿。
 */
function failFrom(e) {
  return {
    ok: false,
    error: (e && e.message) || '原因不明のエラーです。',
    hint: (e && e.hint) || undefined,
    raw: (e && e.raw) || null,
  };
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

const YT = 'https://www.googleapis.com/youtube/v3';

/** lib/networks/youtube.js の apiError() と同じ翻訳を、throw せずに返す版。 */
function youtubeError(res, raw) {
  const err = (raw && raw.error && raw.error.errors && raw.error.errors[0]) || {};
  const reason = err.reason || '';

  if (res.status === 401) {
    return { ok: false, error: 'YouTube の認証が切れています。', hint: '「連携設定」から接続し直してください。', raw };
  }
  if (reason === 'quotaExceeded' || (res.status === 403 && /quota/i.test(JSON.stringify(raw)))) {
    return {
      ok: false,
      error: 'YouTube API の1日の利用枠を使い切りました。',
      hint: '日付が変わるまで待ってください。',
      raw,
    };
  }
  if (reason === 'youtubeSignupRequired') {
    return {
      ok: false,
      error: 'このGoogleアカウントに YouTube チャンネルがありません。',
      hint: 'YouTube でチャンネルを作成してから、連携し直してください。',
      raw,
    };
  }
  return {
    ok: false,
    error: `YouTube が ${res.status} を返しました。`,
    hint: (err.message || JSON.stringify(raw)).slice(0, 300),
    raw,
  };
}

async function ytAccountStats(account, db) {
  try {
    const token = await google.accessTokenFor(account, db);
    const res = await fetch(`${YT}/channels?part=statistics&mine=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const raw = await safeJson(res);
    if (!res.ok) return youtubeError(res, raw);

    const stats = (raw.items && raw.items[0] && raw.items[0].statistics) || {};
    return {
      ok: true,
      metrics: {
        // ★ hiddenSubscriberCount が true のチャンネルは subscriberCount が無い。
        //   これはエラーではなく本人の設定なので null で正しい。
        followers: numOrNull(stats.subscriberCount),
        views: numOrNull(stats.viewCount),
        likes: null,   // YouTube はチャンネル単位の「いいね総数」を提供していない
        posts: numOrNull(stats.videoCount),
      },
      raw,
    };
  } catch (e) {
    return failFrom(e);
  }
}

async function ytPostStats(account, targets, db) {
  try {
    // external_id(videoId) → post_targets.id の対応表。
    const idToTargetId = {};
    for (const t of targets || []) {
      if (t.external_id && (!t.network || t.network === 'youtube')) idToTargetId[t.external_id] = t.id;
    }
    const videoIds = Object.keys(idToTargetId);
    const byTargetId = {};
    const rawChunks = [];

    if (videoIds.length) {
      const token = await google.accessTokenFor(account, db);
      // ★ videos.list の id は50件までしか渡せない。多いときは分けて呼ぶ。
      for (const ids of chunk(videoIds, 50)) {
        const res = await fetch(`${YT}/videos?part=statistics&id=${ids.join(',')}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const raw = await safeJson(res);
        rawChunks.push(raw);
        if (!res.ok) {
          const failed = youtubeError(res, raw);
          failed.raw = rawChunks;
          return failed;
        }
        for (const item of raw.items || []) {
          const s = item.statistics || {};
          const targetId = idToTargetId[item.id];
          if (!targetId) continue;
          byTargetId[targetId] = {
            views: numOrNull(s.viewCount),
            likes: numOrNull(s.likeCount),
            comments: numOrNull(s.commentCount),   // コメント欄を閉じていると無い
            shares: null,                          // YouTube API に共有数は無い
          };
        }
      }
    }
    return { ok: true, byTargetId, raw: rawChunks };
  } catch (e) {
    return failFrom(e);
  }
}

// ---------------------------------------------------------------------------
// Instagram
//
// ★ 重要：followers_count と like_count が現在の権限で取れるかは未検証。
//   取れなかったときに黙って null にするのではなく、Meta が返した生の文言を
//   error/hint にそのまま乗せる。これが今回いちばん大事な仕事。
// ---------------------------------------------------------------------------

/**
 * 期待したフィールドが取れなかったときの理由を組み立てる。
 *   ケースA：Graph API がそのフィールドだけエラーオブジェクトを埋め込んで返した
 *           （{ followers_count: { error: {...} } } の形）
 *   ケースB：フィールドがレスポンスに丸ごと無かった（権限が足りない等、理由不明）
 * どちらも「Meta の原文」を残すため、raw をそのまま文字列にして含める。
 */
function igFieldTrouble(field, raw) {
  const val = raw ? raw[field] : undefined;
  if (val && typeof val === 'object' && val.error) {
    const [msg, hint] = ig.translate({ error: val.error });
    return { error: `Instagram が ${field} を返しませんでした：${msg}`, hint };
  }
  return {
    error: `Instagram が ${field} を返しませんでした（Meta の原文: ${JSON.stringify(raw).slice(0, 300)}）。`,
    hint: 'このアクセストークンの権限では取得できない可能性があります。Meta の管理画面で instagram_business_basic 等の権限を確認してください。',
  };
}

async function igAccountStats(account) {
  try {
    const token = account && account.access_token;
    if (!token) {
      return {
        ok: false,
        error: 'Instagram のアクセストークンが登録されていません。',
        hint: 'アプリの「連携設定」からトークンを登録してください。',
        raw: null,
      };
    }

    const V = ig.VERSION;
    let raw;
    try {
      raw = await ig.call(`/${V}/me`, { fields: 'user_id,username,followers_count,media_count' }, 'GET', token);
    } catch (e) {
      // ★ 呼び出しそのもの（トークン失効など）が失敗したケース。ig.js が既に
      //   日本語のmessage/hintを作ってくれているので、そのまま乗せる。
      return { ok: false, error: e.message, hint: e.hint, raw: e.raw || null };
    }

    const metrics = { followers: null, views: null, likes: null, posts: null };
    let trouble = null;

    if (typeof raw.followers_count === 'number') {
      metrics.followers = raw.followers_count;
    } else {
      trouble = igFieldTrouble('followers_count', raw);
    }
    if (typeof raw.media_count === 'number') {
      metrics.posts = raw.media_count;
    }

    const result = { ok: true, metrics, raw };
    // ★ 一部のフィールドが取れなかったことは「握りつぶさない」。
    //   全体としては成功（アカウントには辿り着けた）なので ok:true のまま、
    //   error/hint に「取れなかった理由」を添えて返す。
    if (trouble) Object.assign(result, trouble);
    return result;
  } catch (e) {
    return failFrom(e);
  }
}

async function igPostStats(account, targets) {
  try {
    const token = account && account.access_token;
    if (!token) {
      return {
        ok: false,
        error: 'Instagram のアクセストークンが登録されていません。',
        hint: 'アプリの「連携設定」からトークンを登録してください。',
        raw: null,
      };
    }

    const V = ig.VERSION;
    const list = (targets || []).filter((t) => t.external_id && (!t.network || t.network === 'instagram'));
    const byTargetId = {};
    const raw = {};

    for (const t of list) {
      try {
        const info = await ig.call(`/${V}/${t.external_id}`, { fields: 'like_count,comments_count' }, 'GET', token);
        raw[t.id] = info;

        const row = {
          views: null,   // Instagram のこのフィールドには再生数が無い
          likes: typeof info.like_count === 'number' ? info.like_count : null,
          comments: typeof info.comments_count === 'number' ? info.comments_count : null,
          shares: null,
        };
        if (typeof info.like_count !== 'number') {
          Object.assign(row, igFieldTrouble('like_count', info));
        }
        byTargetId[t.id] = row;
      } catch (e) {
        // ★ この投稿だけ失敗しても、他の投稿の取り込みは止めない。
        raw[t.id] = e.raw || null;
        byTargetId[t.id] = { views: null, likes: null, comments: null, shares: null, error: e.message, hint: e.hint };
      }
    }
    return { ok: true, byTargetId, raw };
  } catch (e) {
    return failFrom(e);
  }
}

// ---------------------------------------------------------------------------
// TikTok
// ---------------------------------------------------------------------------

const TT = 'https://open.tiktokapis.com/v2';

/** lib/networks/tiktok.js の call() と同じ翻訳を、throw せずに返す版。 */
function tiktokError(res, err, raw) {
  const code = (err && err.code) || '';
  if (res.status === 401 || code === 'access_token_invalid') {
    return { ok: false, error: 'TikTok の認証が切れています。', hint: '「連携設定」から接続し直してください。', raw };
  }
  if (code === 'scope_not_authorized') {
    return {
      ok: false,
      error: 'TikTok の権限が足りません。',
      hint: 'アプリの権限に user.info.stats / video.list が入っているか確認し、連携をやり直してください。',
      raw,
    };
  }
  return {
    ok: false,
    error: `TikTok が ${code || res.status} を返しました。`,
    hint: ((err && err.message) || '').slice(0, 300),
    raw,
  };
}

async function ttAccountStats(account, db) {
  try {
    const token = await tiktok.accessTokenFor(account, db);
    const res = await fetch(`${TT}/user/info/?fields=follower_count,likes_count,video_count`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const raw = await safeJson(res);
    const err = raw && raw.error;
    if (!res.ok || (err && err.code && err.code !== 'ok')) return tiktokError(res, err, raw);

    const user = (raw.data && raw.data.user) || {};
    return {
      ok: true,
      metrics: {
        followers: numOrNull(user.follower_count),
        views: null,   // アカウント単位の総再生数は TikTok の一般公開APIには無い
        likes: numOrNull(user.likes_count),
        posts: numOrNull(user.video_count),
      },
      raw,
    };
  } catch (e) {
    return failFrom(e);
  }
}

/**
 * ★ postStats は対応しない。
 *   TikTok は下書き経由でしか投稿できず、アプリが持っているのは publish_id
 *   （下書きの整理番号）だけ。本人が手でアプリから公開した後の動画IDは
 *   返ってこないので、「このアプリの投稿＝この動画」を結びつけられない。
 *   supabase/schema_v8_insights.sql の tiktok_videos が別表なのも同じ理由。
 */
async function ttPostStats() {
  return {
    ok: false,
    error: 'TikTok は下書き経由で公開するため、アプリの投稿と動画を結びつけられません。',
    hint: '代わりに recentVideos() で直近の動画一覧を取得し、タイトルや時刻で手元で見比べてください。',
    raw: null,
  };
}

/** TikTok 側にある動画の一覧（アプリの投稿との紐付けはできない）。 */
async function recentVideos(account, db) {
  try {
    const token = await tiktok.accessTokenFor(account, db);
    const fields = 'id,title,view_count,like_count,comment_count,share_count,create_time';
    const res = await fetch(`${TT}/video/list/?fields=${fields}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({ max_count: 20 }),
    });
    const raw = await safeJson(res);
    const err = raw && raw.error;
    if (!res.ok || (err && err.code && err.code !== 'ok')) return tiktokError(res, err, raw);

    const list = (raw.data && raw.data.videos) || [];
    const videos = list.map((v) => ({
      id: v.id,
      title: v.title || null,
      views: numOrNull(v.view_count),
      likes: numOrNull(v.like_count),
      comments: numOrNull(v.comment_count),
      shares: numOrNull(v.share_count),
      createdAt: v.create_time ? new Date(v.create_time * 1000).toISOString() : null,
    }));
    return { ok: true, videos, raw };
  } catch (e) {
    return failFrom(e);
  }
}

// ---------------------------------------------------------------------------
// 振り分け（呼び出す側はSNSの違いを意識しなくていい窓口）
// ---------------------------------------------------------------------------

async function accountStats(account, db) {
  if (!account) return { ok: false, error: 'アカウントが指定されていません。', hint: undefined, raw: null };
  switch (account.network) {
    case 'youtube': return ytAccountStats(account, db);
    case 'instagram': return igAccountStats(account, db);
    case 'tiktok': return ttAccountStats(account, db);
    default:
      return {
        ok: false,
        error: `「${account.network}」の数字の取得には対応していません。`,
        hint: '対応しているのは YouTube・Instagram・TikTok です（X は読み取りAPIが有料のため対象外にしています）。',
        raw: null,
      };
  }
}

async function postStats(account, targets, db) {
  if (!account) return { ok: false, error: 'アカウントが指定されていません。', hint: undefined, raw: null };
  switch (account.network) {
    case 'youtube': return ytPostStats(account, targets, db);
    case 'instagram': return igPostStats(account, targets, db);
    case 'tiktok': return ttPostStats(account, targets, db);
    default:
      return {
        ok: false,
        error: `「${account.network}」の投稿ごとの数字の取得には対応していません。`,
        hint: '対応しているのは YouTube・Instagram です。',
        raw: null,
      };
  }
}

module.exports = { accountStats, postStats, recentVideos };
