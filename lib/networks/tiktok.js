'use strict';
/**
 * TikTok への投稿。
 *
 * ★ 審査を通るまでは、投稿は SELF_ONLY（自分だけに見える）に固定される。
 *   YouTube の「非公開でアップロードされる」とまったく同じ構図。
 *   TikTok アプリ側で公開範囲を変えれば人に見せられる。
 *
 * ★ ファイルの送り方
 *   URLを渡す方式（PULL_FROM_URL）は、そのドメインの所有権をDNSで証明しろと
 *   要求される。vercel.app は自分のドメインではないので証明できない。
 *   なので中身を直接送る FILE_UPLOAD を使う。
 *   1かたまり 5MB〜64MB という決まりがあり、こちらの上限は50MBなので、
 *   常に「まるごと1かたまり」で送れば条件を満たす。
 */

const tiktok = require('../tiktok');

const API = 'https://open.tiktokapis.com/v2';

async function step({ post, target, db }) {
  if (post.media_kind !== 'video') {
    throw hint('TikTok には動画が必要です。', '画像だけの投稿では TikTok を選べません。');
  }
  if (!post.media_path) throw hint('動画が添付されていません。', '動画をアップロードしてから予約してください。');

  const token = await tiktok.accessTokenFor(db);

  // --- (1) 枠を取って、動画を送る -------------------------------------------
  if (!target.external_id) {
    // TikTok の決まりで、投稿の前に本人の設定を確認することになっている
    const who = await call(token, '/post/publish/creator_info/query/', {});
    const allowed = (who.data && who.data.privacy_level_options) || [];

    // 審査前は SELF_ONLY しか選べない。選べるものの中から安全側を選ぶ。
    const privacy = allowed.includes('SELF_ONLY')
      ? 'SELF_ONLY'
      : (allowed[0] || 'SELF_ONLY');

    const media = await db.download(post.media_path);
    const title = (post.tt_caption || post.body_common || post.title || '').slice(0, 2200);

    const init = await call(token, '/post/publish/video/init/', {
      post_info: {
        title,
        privacy_level: privacy,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: media.length,
        chunk_size: media.length,   // まるごと1かたまり
        total_chunk_count: 1,
      },
    });

    const publishId = init.data && init.data.publish_id;
    const uploadUrl = init.data && init.data.upload_url;
    if (!publishId || !uploadUrl) {
      throw hint('TikTok が置き場所を返しませんでした。', '少し待って再実行してください。');
    }

    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(media.length),
        'Content-Range': `bytes 0-${media.length - 1}/${media.length}`,
      },
      body: media,
    });
    if (!put.ok) {
      throw hint(`TikTok への動画の送信に失敗しました（${put.status}）。`, (await put.text().catch(() => '')).slice(0, 300));
    }

    return {
      wait: true,
      stage: 'uploaded',
      externalId: publishId,
      seconds: 15,
      note: `TikTok に動画を送りました（公開範囲：${privacy === 'SELF_ONLY' ? '自分のみ／審査前のため' : privacy}）`,
    };
  }

  // --- (2) 処理が終わったか見に行く -----------------------------------------
  const st = await call(token, '/post/publish/status/fetch/', { publish_id: target.external_id });
  const status = (st.data && st.data.status) || '';

  if (status === 'FAILED') {
    const reason = (st.data && st.data.fail_reason) || '';
    throw hint('TikTok 側で動画の処理に失敗しました。', reason || 'MP4（H.264 + AAC）の縦型で書き出してください。');
  }
  if (status !== 'PUBLISH_COMPLETE') {
    return { wait: true, stage: 'uploaded', seconds: 15, note: `TikTok 処理中（${status || '確認中'}）` };
  }

  const ids = (st.data && st.data.publicaly_available_post_id) || [];
  return {
    done: true,
    externalId: target.external_id,
    permalink: ids.length ? `https://www.tiktok.com/video/${ids[0]}` : null,
  };
}

async function call(token, path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));

  const err = json.error || {};
  const code = err.code || '';

  if (res.status === 401 || code === 'access_token_invalid') {
    throw hint('TikTok の認証が切れています。', '「連携設定」から接続し直してください。');
  }
  if (code === 'scope_not_authorized') {
    throw hint(
      'TikTok の権限が足りません。',
      'アプリの権限に video.publish が入っているか確認し、連携をやり直してください。'
    );
  }
  if (code === 'spam_risk_too_many_posts' || code === 'spam_risk_user_banned_from_posting') {
    throw hint('TikTok 側で投稿が制限されています。', '時間をあけてから再実行してください。');
  }
  if (!res.ok || (code && code !== 'ok')) {
    throw hint(`TikTok が ${code || res.status} を返しました。`, (err.message || '').slice(0, 300));
  }
  return json;
}

function hint(message, h) {
  const e = new Error(message);
  e.hint = h;
  return e;
}

module.exports = { step };
