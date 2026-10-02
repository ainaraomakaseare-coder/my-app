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
 *
 * ★ 返信（post.reply_text）があるときは、本文が出たあとの分で、自分の投稿への
 *   返信として付ける。本文の投稿IDを保存してから返信に進むので、返信でつまずいて
 *   再実行しても、本文が二重に出ることはない。
 */

const x = require('../x');

const API = 'https://api.x.com';
const CHUNK = 4 * 1024 * 1024;   // 5MB未満という決まりがあるので4MBにする

/** 本文は投稿済みで、返信だけが残っている段階。 */
const REPLY_STAGE = 'posted_needs_reply';

async function step({ post, target, account, db }) {
  const token = await x.accessTokenFor(account, db);
  const text = (post.x_text || post.body_common || '').slice(0, 280);
  const replyText = String(post.reply_text || '').trim();

  // --- 返信だけが残っている：本文にはもう触らない -----------------------------
  if (target.stage === REPLY_STAGE) return await reply(token, replyText, target);

  if (!text && !post.media_path) {
    throw hint('X に送る本文がありません。', 'X用の本文か共通本文を入れてください。');
  }

  // --- メディアなし：そのまま投稿 -------------------------------------------
  if (!post.media_path) return thenReply(await tweet(token, text, null), replyText);

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

  return thenReply(await tweet(token, text, target.external_id), replyText);
}

/**
 * 本文が出た直後。返信があれば、完了にせず「返信待ち」として本文の投稿IDを残す。
 * ★ ここで返信まで続けて送らない。本文のIDを DB に書く前に落ちると、
 *   次の分に本文からやり直して二重投稿になるため。
 */
function thenReply(posted, replyText) {
  if (!replyText) return posted;
  return {
    wait: true, stage: REPLY_STAGE, externalId: posted.externalId, seconds: 5,
    note: 'X に投稿しました（このあと返信を付けます）',
  };
}

/** 自分の投稿に返信を付けて、完了にする。target.external_id は本文の投稿ID。 */
async function reply(token, replyText, target) {
  const mainId = target.external_id;
  const done = { done: true, externalId: mainId, permalink: `https://x.com/i/status/${mainId}` };
  // 返信を消して保存し直した／もう付いている。どちらも送らずに終える。
  if (!replyText || target.reply_external_id) return done;

  try {
    const sent = await tweet(token, replyText, null, mainId);
    return { ...done, replyId: sent.externalId };
  } catch (e) {
    // 同じ文の重複で断られた＝前の回で付いたのに、記録する前に落ちていた。
    if (/duplicate/i.test(e.hint || '')) return done;
    e.message = '本文は投稿済みです。返信だけ付けられませんでした。' + e.message;
    e.hint = (e.hint ? e.hint + ' ' : '') + '再実行すると返信だけをやり直します（本文は二重に出ません）。';
    throw e;
  }
}

async function tweet(token, text, mediaId, replyTo) {
  const body = { text };
  if (mediaId) body.media = { media_ids: [String(mediaId)] };
  if (replyTo) body.reply = { in_reply_to_tweet_id: String(replyTo) };

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

module.exports = { step, REPLY_STAGE };
