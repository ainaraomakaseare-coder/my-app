'use strict';
/**
 * Instagram への投稿（DAY8 のコードを流用）。
 *
 * Instagram だけ他の3つと根本的に違う点：
 *   ファイル本体を受け取らず、「インターネット上の公開URL」を渡すと
 *   Meta 側が取りに来る。
 *
 * DAY8 ではこのために自分のPCへ Cloudflare トンネルを開いていた。
 * クラウドに移った今は、Supabase Storage の
 * 「2時間だけ有効な署名付きURL」を渡せば済む。
 * ──毎回URLを貼り直す作業が丸ごと消えた、というのが今日の進化。
 *
 * 3段階を1分ずつに分けて進める：
 *   (1) コンテナを作る → (2) 変換の完了を待つ → (3) 公開する
 */

const ig = require('../instagram');

async function step({ post, target, db }) {
  const row = await db.getToken('instagram');
  const token = row && row.access_token;
  if (!token) {
    throw hint(
      'Instagram のアクセストークンが登録されていません。',
      'アプリの「連携設定」からトークンを登録してください。'
    );
  }
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    throw hint(
      'Instagram のアクセストークンの有効期限が切れています。',
      'Meta の管理画面でトークンを発行し直し、連携設定から登録してください。'
    );
  }
  if (!post.media_path) {
    throw hint('Instagram には画像か動画が必要です。', 'メディアを添付してから再実行してください。');
  }

  const V = ig.VERSION;

  // --- (1) まだ何も始めていない：コンテナを作る -----------------------------
  if (!target.external_id) {
    // 公開URLは、この瞬間から2時間だけ有効。ずっと公開はしない。
    const mediaUrl = await db.signedUrl(post.media_path, 2 * 60 * 60);
    const caption = (post.ig_caption || post.body_common || '').slice(0, 2200);
    const isVideo = post.media_kind === 'video';

    const params = isVideo
      ? { media_type: 'REELS', video_url: mediaUrl, caption }
      : { image_url: mediaUrl, caption };

    const container = await ig.call(`/${V}/me/media`, params, 'POST', token);

    // ★ 作った直後に ID を保存する。ここで落ちても、次回は作り直さずに続きから。
    return {
      wait: true,
      stage: 'container_created',
      externalId: container.id,
      seconds: isVideo ? 20 : 5,
      note: isVideo ? 'リールのコンテナを作成。Instagram が変換中です' : '画像のコンテナを作成しました',
    };
  }

  // --- (2) 変換が終わったか見に行く -----------------------------------------
  if (target.stage === 'container_created') {
    const info = await ig.call(
      `/${V}/${target.external_id}`, { fields: 'status_code,status' }, 'GET', token
    );

    if (info.status_code === 'ERROR' || info.status_code === 'EXPIRED') {
      throw hint(
        'Instagram 側でメディアの処理に失敗しました。',
        info.status ||
          'リールは MP4（H.264 + AAC）、縦横比 9:16 前後、3秒〜15分。画像は JPEG 8MB 以下が目安です。'
      );
    }
    if (info.status_code !== 'FINISHED') {
      return { wait: true, stage: 'container_created', seconds: 20, note: '変換待ち…' };
    }
    // 変換が終わった。次の分で公開する。
    return { wait: true, stage: 'ready', seconds: 1, note: '変換が完了しました' };
  }

  // --- (3) 公開する ---------------------------------------------------------
  const published = await ig.call(
    `/${V}/me/media_publish`, { creation_id: target.external_id }, 'POST', token
  );

  let permalink = null;
  try {
    const info = await ig.call(`/${V}/${published.id}`, { fields: 'permalink' }, 'GET', token);
    permalink = info.permalink || null;
  } catch (_) {
    // 公開自体は済んでいる。URLが取れないだけで失敗扱いにはしない。
  }

  return { done: true, externalId: published.id, permalink };
}

function hint(message, h) {
  const e = new Error(message);
  e.hint = h;
  return e;
}

module.exports = { step };
