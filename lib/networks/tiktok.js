'use strict';
/**
 * TikTok への投稿。
 *
 * ★ 審査前のアプリに提供されるのは「下書き送信」だけ。
 *   直接投稿（video.publish）は審査を通ったアプリにしか使えない。
 *   だからここは inbox（下書き）方式で書いてある。
 *
 *   アプリに登録 → 指定時刻にクラウドが送信 → TikTokアプリの下書きに届く
 *   → 本人がアプリを開いて公開する
 *
 *   YouTube の「非公開でアップロード → Studio で公開」と同じ構図。
 *   違いは、TikTok は下書きなので、そのまま公開投稿にできること。
 *
 * ★ ファイルの送り方
 *   URLを渡す方式はドメインの所有権証明が要るうえ、下書き方式では使えない。
 *   中身を直接送る FILE_UPLOAD を使う。1かたまり 5MB〜64MB という決まりが
 *   あり、こちらの上限は50MBなので、常に「まるごと1かたまり」で条件を満たす。
 *
 * ★ 本文について
 *   下書き方式では、キャプションを一緒に送れない（TikTok側の仕様）。
 *   本文はアプリで公開するときに入力する。アプリに登録した TikTok 用の
 *   本文は、履歴に残して手元でコピーできるようにしておく。
 */

const tiktok = require('../tiktok');

const API = 'https://open.tiktokapis.com/v2';

async function step({ post, target, account, db }) {
  if (post.media_kind !== 'video') {
    throw hint('TikTok には動画が必要です。', '画像だけの投稿では TikTok を選べません。');
  }
  if (!post.media_path) throw hint('動画が添付されていません。', '動画をアップロードしてから予約してください。');

  const token = await tiktok.accessTokenFor(account, db);

  // --- (1) 枠を取って、動画を送る -------------------------------------------
  if (!target.external_id) {
    const media = await db.download(post.media_path);

    const init = await call(token, '/post/publish/inbox/video/init/', {
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
      throw hint(
        `TikTok への動画の送信に失敗しました（${put.status}）。`,
        (await put.text().catch(() => '')).slice(0, 300)
      );
    }

    const caption = (post.tt_caption || post.body_common || '').trim();
    return {
      wait: true,
      stage: 'uploaded',
      externalId: publishId,
      seconds: 15,
      note: caption
        ? 'TikTok に動画を送りました。公開時に使う本文：' + caption.slice(0, 500)
        : 'TikTok に動画を送りました（下書きに届きます）',
    };
  }

  // --- (2) 届いたか見に行く -------------------------------------------------
  const st = await call(token, '/post/publish/status/fetch/', { publish_id: target.external_id });
  const status = (st.data && st.data.status) || '';

  if (status === 'FAILED') {
    const reason = (st.data && st.data.fail_reason) || '';
    throw hint('TikTok 側で動画の処理に失敗しました。', reason || 'MP4（H.264 + AAC）の縦型で書き出してください。');
  }

  // 下書きとして届いたら完了。SELF_ONLY で公開される直接投稿とは終着点が違う。
  if (status === 'SEND_TO_USER_INBOX' || status === 'PUBLISH_COMPLETE') {
    return {
      done: true,
      externalId: target.external_id,
      // 下書きにはURLが無い。TikTokアプリで開いてもらう。
      permalink: null,
    };
  }

  return { wait: true, stage: 'uploaded', seconds: 15, note: `TikTok 処理中（${status || '確認中'}）` };
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
      'アプリの権限に video.upload が入っているか確認し、連携をやり直してください。'
    );
  }
  if (code === 'unaudited_client_can_only_post_to_private_accounts') {
    throw hint(
      'このアプリは審査前なので、下書き送信しかできません。',
      'アプリ側の設定は下書き方式になっています。TikTok の権限設定を確認してください。'
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
