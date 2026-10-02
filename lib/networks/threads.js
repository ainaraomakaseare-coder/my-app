'use strict';
/**
 * Threads への投稿。
 *
 * 流れは Instagram とほぼ同じ3段階。1分に1手ずつ進める：
 *   (1) コンテナを作る（本文と、あれば画像／動画のURLを渡す）
 *   (2) Threads 側の準備が終わるのを待つ（status が FINISHED になるまで）
 *   (3) 公開する → 投稿のURLを取る
 *
 * ★ ファイルは渡さず「公開URL」を渡すと Threads が取りに来る。
 *   Instagram と同じく、Supabase の2時間だけ有効な署名付きURLを渡す。
 *
 * ★ Threads は叩いた瞬間に公開される（下書きの API が無い）。
 *   だから lib/handoff.js の PUBLISHING_NETWORKS に入っていて、
 *   運用アカウントで自動投稿を許可したときだけ、ここまで来る。
 *
 * ★ 本文は500文字まで。画像・動画は無くてもよい（文字だけの投稿ができる）。
 *
 * ★ 返信（post.reply_text）があるときは、公開のあとに同じ3段階をもう一度、
 *   reply_to_id を付けて進める。本文の投稿IDは external_id に、返信のコンテナは
 *   reply_external_id に持つので、返信でつまずいても本文は二度と公開しない。
 */

const threads = require('../threads');

const V = threads.VERSION;
const MAX_TEXT = 500;

/** 本文は公開済みで、返信が残っている段階（コンテナを作る前／作ったあと）。 */
const NEEDS_REPLY = 'published_needs_reply';
const REPLY_CREATED = 'reply_created';

async function step({ post, target, account, db }) {
  const token = await threads.accessTokenFor(account, db);
  const userId = account.external_id || 'me';
  const text = (post.th_text || post.body_common || '').trim();
  const replyText = String(post.reply_text || '').trim();

  // --- 返信だけが残っている：本文にはもう触らない -----------------------------
  if (target.stage === NEEDS_REPLY || target.stage === REPLY_CREATED) {
    return await reply({ replyText, target, token, userId, db });
  }

  if (!text && !post.media_path) {
    throw hint('Threads に送る本文がありません。', 'Threads 用の本文か共通本文を入れてください。');
  }
  if (text.length > MAX_TEXT) {
    throw hint(`Threads の本文が長すぎます（${text.length}文字／上限${MAX_TEXT}文字）。`, 'Threads 用の本文を短くしてください。');
  }

  // --- (1) コンテナを作る ---------------------------------------------------
  if (!target.external_id) {
    const params = { text, access_token: token };
    if (post.media_path) {
      // 公開URLは、この瞬間から2時間だけ有効。ずっと公開はしない。
      const url = await db.signedUrl(post.media_path, 2 * 60 * 60);
      if (post.media_kind === 'video') Object.assign(params, { media_type: 'VIDEO', video_url: url });
      else Object.assign(params, { media_type: 'IMAGE', image_url: url });
    } else {
      params.media_type = 'TEXT';
    }

    const made = await threads.send('POST', `/${V}/${userId}/threads`, params);
    if (!made.id) throw hint('Threads が受付番号を返しませんでした。', '少し待って再実行してください。');

    // ★ Threads は「平均30秒待ってから公開」と案内している。文字だけでも同じ。
    return {
      wait: true, stage: 'container_created', externalId: String(made.id),
      seconds: 30, note: 'Threads に投稿を渡しました（準備が終わりしだい公開します）',
    };
  }

  // --- (2) 準備が終わったか見る ---------------------------------------------
  if (target.stage === 'container_created') {
    const st = await threads.send('GET', `/${V}/${target.external_id}`, {
      fields: 'status,error_message', access_token: token,
    });
    if (st.status === 'ERROR' || st.status === 'EXPIRED') {
      throw hint(
        `Threads 側で準備に失敗しました（${st.status}）。`,
        st.error_message || '画像は JPEG／PNG、動画は MP4（H.264）で、5分以内・1GB以下にしてください。'
      );
    }
    // 公開までは済んだのに、記録する前に落ちていた。もう一度公開しには行かない。
    // ★ このときは公開後の投稿IDが分からないので、返信は付けない（手で付ける）。
    if (st.status === 'PUBLISHED') {
      return { done: true, externalId: target.external_id, permalink: null };
    }
    if (st.status !== 'FINISHED') {
      return { wait: true, stage: 'container_created', seconds: 20, note: `Threads 準備中（${st.status || '確認中'}）` };
    }

    // --- (3) 公開する -------------------------------------------------------
    // ★ 公開したのに記録する前に落ちても、次の1分ではコンテナが PUBLISHED に
    //   なっているので、上で完了扱いにして二度は公開しない。
    const pub = await threads.send('POST', `/${V}/${userId}/threads_publish`, {
      creation_id: target.external_id, access_token: token,
    });
    if (replyText) {
      return {
        wait: true, stage: NEEDS_REPLY, externalId: String(pub.id), seconds: 10,
        note: 'Threads に投稿しました（このあと返信を付けます）',
      };
    }
    return await finish(String(pub.id), token);
  }

  // stage が想定外（古い行など）。コンテナの番号しか無いので、公開を試みる。
  const pub = await threads.send('POST', `/${V}/${userId}/threads_publish`, {
    creation_id: target.external_id, access_token: token,
  });
  return await finish(String(pub.id), token);
}

/**
 * 自分の投稿に返信を付ける。target.external_id は公開済みの本文の投稿ID。
 * 本文と同じく、コンテナを作る → 準備を待つ → 公開する、を1分ずつ進める。
 */
async function reply({ replyText, target, token, userId, db }) {
  const mainId = target.external_id;
  // 返信を消して保存し直した。送らずに終える。
  if (!replyText) return await finish(mainId, token);

  if (target.stage === NEEDS_REPLY || !target.reply_external_id) {
    const made = await threads.send('POST', `/${V}/${userId}/threads`, {
      media_type: 'TEXT', text: replyText, reply_to_id: mainId, access_token: token,
    });
    if (!made.id) throw replyFailed(hint('Threads が受付番号を返しませんでした。', '少し待って再実行してください。'));
    return { wait: true, stage: REPLY_CREATED, replyId: String(made.id), seconds: 30, note: 'Threads に返信を渡しました' };
  }

  const st = await threads.send('GET', `/${V}/${target.reply_external_id}`, {
    fields: 'status,error_message', access_token: token,
  });
  if (st.status === 'ERROR' || st.status === 'EXPIRED') {
    // 使えなくなったコンテナを待ち続けないよう、作り直す段階に戻してから止める。
    await db.updateById('post_targets', target.id, { stage: NEEDS_REPLY });
    throw replyFailed(hint(`Threads 側で返信の準備に失敗しました（${st.status}）。`, st.error_message || ''));
  }
  // 返信の公開までは済んだのに、記録する前に落ちていた。二度は公開しない。
  if (st.status === 'PUBLISHED') return await finish(mainId, token);
  if (st.status !== 'FINISHED') {
    return { wait: true, stage: REPLY_CREATED, seconds: 20, note: `Threads 返信の準備中（${st.status || '確認中'}）` };
  }

  let pub;
  try {
    pub = await threads.send('POST', `/${V}/${userId}/threads_publish`, {
      creation_id: target.reply_external_id, access_token: token,
    });
  } catch (e) { throw replyFailed(e); }
  return { ...(await finish(mainId, token)), replyId: String(pub.id) };
}

/** 返信だけの失敗だと分かるように言い添える。本文は出ているので、慌てて出し直さないため。 */
function replyFailed(e) {
  e.message = '本文は投稿済みです。返信だけ付けられませんでした。' + e.message;
  e.hint = (e.hint ? e.hint + ' ' : '') + '再実行すると返信だけをやり直します（本文は二重に出ません）。';
  return e;
}

/** 公開済みの投稿のURLを取って、完了として返す。URLが取れなくても投稿は成功。 */
async function finish(mediaId, token) {
  let permalink = null;
  try {
    const got = await threads.send('GET', `/${V}/${mediaId}`, { fields: 'permalink', access_token: token });
    permalink = got.permalink || null;
  } catch (_) { /* URL は後から見られる。投稿の成否には関わらない */ }
  return { done: true, externalId: mediaId, permalink };
}

function hint(message, h) {
  const e = new Error(message);
  e.hint = h;
  return e;
}

module.exports = { step, MAX_TEXT, NEEDS_REPLY, REPLY_CREATED };
