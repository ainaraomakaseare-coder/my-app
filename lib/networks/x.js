'use strict';
/**
 * X への投稿。
 *
 * ★ お金がかかる唯一のSNS（1投稿 約2.3円、リンク付きは約30円）。
 *   だからこそ「同じものを2回送らない」ことが他より重い。
 *
 * メディアがある場合は4手：
 *   INIT（枠を取る）→ APPEND（5MB未満ずつ送る）→ FINALIZE（閉じる）→ 変換待ち
 *   そのあとで、media_id を付けて投稿する。
 */

const x = require('../x');

const API = 'https://api.x.com';
const CHUNK = 4 * 1024 * 1024;   // 5MB未満という決まりがあるので4MBにする

async function step({ post, target, db }) {
  const token = await x.accessTokenFor(db);
  const text = (post.x_text || post.body_common || '').slice(0, 280);

  if (!text && !post.media_path) {
    throw hint('X に送る本文がありません。', 'X用の本文か共通本文を入れてください。');
  }

  // --- メディアなし：そのまま投稿 -------------------------------------------
  if (!post.media_path) return await tweet(token, text, null);

  // --- (1) メディアを送る ---------------------------------------------------
  if (!target.external_id) {
    const media = await db.download(post.media_path);
    const isVideo = post.media_kind === 'video';

    const init = await call(token, '/2/media/upload/initialize', 'POST', {
      media_type: isVideo ? 'video/mp4' : 'image/jpeg',
      total_bytes: media.length,
      media_category: isVideo ? 'tweet_video' : 'tweet_image',
    });
    const mediaId = (init.data && init.data.id) || init.media_id_string || init.id;
    if (!mediaId) throw hint('X がメディアIDを返しませんでした。', '少し待って再実行してください。');

    // 5MB未満ずつ、順番に送る
    for (let i = 0, offset = 0; offset < media.length; i++, offset += CHUNK) {
      const slice = media.subarray(offset, Math.min(offset + CHUNK, media.length));
      const form = new FormData();
      form.append('media', new Blob([slice]));
      form.append('segment_index', String(i));

      const res = await fetch(`${API}/2/media/upload/${mediaId}/append`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      if (!res.ok) throw await apiError(res, 'メディアの送信');
    }

    await call(token, `/2/media/upload/${mediaId}/finalize`, 'POST');

    // ★ 投稿はまだしない。media_id を保存してから次の分で投稿する。
    //   お金がかかる操作なので、状態を確実に残してから踏み込む。
    return {
      wait: true,
      stage: 'media_uploaded',
      externalId: mediaId,
      seconds: post.media_kind === 'video' ? 15 : 2,
      note: 'X にメディアを送りました（変換を待っています）',
    };
  }

  // --- (2) 変換が終わったか見て、投稿する -----------------------------------
  if (post.media_kind === 'video') {
    const st = await call(token, `/2/media/upload?command=STATUS&media_id=${target.external_id}`, 'GET');
    const info = (st.data && st.data.processing_info) || st.processing_info;
    if (info) {
      if (info.state === 'failed') {
        throw hint('X 側で動画の変換に失敗しました。', (info.error && info.error.message) || 'MP4（H.264 + AAC）で書き出してください。');
      }
      if (info.state !== 'succeeded') {
        return { wait: true, stage: 'media_uploaded', seconds: Math.max(5, info.check_after_secs || 10), note: '変換待ち…' };
      }
    }
  }

  return await tweet(token, text, target.external_id);
}

async function tweet(token, text, mediaId) {
  const body = { text };
  if (mediaId) body.media = { media_ids: [String(mediaId)] };

  const json = await call(token, '/2/tweets', 'POST', body);
  const id = json.data && json.data.id;
  if (!id) throw hint('X が投稿IDを返しませんでした。', 'X のタイムラインを確認してから再実行してください。');

  return { done: true, externalId: id, permalink: `https://x.com/i/status/${id}` };
}

async function call(token, path, method, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await apiError(res, path);
  return res.json().catch(() => ({}));
}

async function apiError(res, where) {
  const text = await res.text().catch(() => '');

  if (res.status === 401) {
    return hint('X の認証が切れています。', '「連携設定」から接続し直してください。');
  }
  if (res.status === 403 && /media/i.test(where + text)) {
    return hint(
      'X のメディアアップロードが権限不足で拒否されました。',
      'アプリの権限に media.write が入っているか確認してください。tweet.write だけではメディアを送れません。入れ直したあと、連携をやり直す必要があります。'
    );
  }
  if (res.status === 402 || /payment|insufficient|credit/i.test(text)) {
    return hint(
      'X の残高が足りません。',
      'X の開発者ポータルでチャージしてください。残高が0になると停止するだけで、追加請求は発生しません。'
    );
  }
  if (res.status === 429) {
    return hint('X の利用制限に達しました。', '時間をあけてから再実行してください。');
  }
  return hint(`X が ${res.status} を返しました。`, text.slice(0, 300));
}

function hint(message, h) {
  const e = new Error(message);
  e.hint = h;
  return e;
}

module.exports = { step };
