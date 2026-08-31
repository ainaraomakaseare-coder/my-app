'use strict';
/**
 * YouTube への動画アップロード。
 *
 * ★ 今日いちばん大事な前提：
 *   2020年7月28日以降に作られた API プロジェクトは、Google の監査を通るまで
 *   API でアップロードした動画が「非公開」に固定される。
 *   コードで public を指定しても YouTube 側で非公開に戻される。
 *   なので最初から privacyStatus は 'private' を明示して送る。
 *   （嘘の指定をして「なぜか非公開になる」と悩むより、正直に書いたほうがよい）
 *   公開は YouTube Studio でタップ1回。
 *
 * ★ アップロードは「再開可能アップロード」で行う。
 *   1. 置き場所（セッションURL）を作ってもらう
 *   2. そこへ動画の中身を送る
 *
 *   1 と 2 を別々の分に分けているのは、二重アップロードを防ぐため。
 *   セッションURLを DB に保存してから中身を送るので、途中で落ちても
 *   次回は「そのセッションがどこまで受け取ったか」を聞いてから再開できる。
 *   いきなり作り直すと、同じ動画が2本上がる。
 */

const google = require('../google');

const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';

async function step({ post, target, account, db }) {
  if (post.media_kind !== 'video') {
    throw hint('YouTube には動画が必要です。', '画像だけの投稿では YouTube を選べません。');
  }
  if (!post.media_path) throw hint('動画が添付されていません。', '動画をアップロードしてから予約してください。');

  const token = await google.accessTokenFor(account, db);

  // --- (1) 置き場所を作ってもらう -------------------------------------------
  if (!target.external_id) {
    const title = (post.yt_title || post.title || '無題').slice(0, 100);
    const description = (post.yt_description || post.body_common || '').slice(0, 5000);

    const meta = {
      snippet: { title, description, categoryId: '22' },
      status: {
        // 監査前は非公開にしかできない。実態に合わせて正直に指定する。
        privacyStatus: 'private',
        selfDeclaredMadeForKids: false,
      },
    };

    const res = await fetch(`${UPLOAD}?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': post.media_kind === 'video' ? 'video/*' : 'image/*',
        'X-Upload-Content-Length': String(post.media_bytes || 0),
      },
      body: JSON.stringify(meta),
    });

    if (!res.ok) throw await apiError(res);

    const session = res.headers.get('location');
    if (!session) throw hint('YouTube が置き場所を返しませんでした。', '少し待って再実行してください。');

    // ★ 中身を送る前に、必ず保存して終わる。ここが二重アップロード防止の要。
    return {
      wait: true,
      stage: 'session_created',
      externalId: session,
      seconds: 2,
      note: 'YouTube に置き場所を作りました（次で動画を送ります）',
    };
  }

  // --- (2) 中身を送る／続きから送る -----------------------------------------
  const media = await db.download(post.media_path);
  const total = media.length;

  // まず「どこまで受け取った？」と聞く。すでに完了していれば、送り直さない。
  const probe = await fetch(target.external_id, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Range': `bytes */${total}` },
  });

  if (probe.status === 200 || probe.status === 201) {
    const json = await probe.json().catch(() => ({}));
    return finished(json);
  }

  let offset = 0;
  if (probe.status === 308) {
    const range = probe.headers.get('range');           // 例 "bytes=0-12345"
    if (range) offset = Number(range.split('-')[1]) + 1;
  } else if (probe.status === 404 || probe.status === 410) {
    // セッションが失効した。作り直すしかない。
    throw hint(
      'YouTube のアップロード用の置き場所が期限切れになりました。',
      'もう一度「再実行」を押してください。最初からやり直します。'
    );
  }

  const res = await fetch(target.external_id, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Length': String(total - offset),
      'Content-Range': `bytes ${offset}-${total - 1}/${total}`,
    },
    body: media.subarray(offset),
  });

  if (res.status === 308) {
    // まだ全部は受け取っていない。次の分で続きから送る。
    return { wait: true, stage: 'session_created', seconds: 10, note: '動画を送信中…' };
  }
  if (!res.ok) throw await apiError(res);

  return finished(await res.json().catch(() => ({})));
}

function finished(json) {
  const id = json.id;
  if (!id) throw hint('YouTube が動画IDを返しませんでした。', 'YouTube Studio を確認してください。');
  return {
    done: true,
    externalId: id,
    permalink: `https://youtu.be/${id}`,
  };
}

async function apiError(res) {
  const text = await res.text().catch(() => '');
  let json = {};
  try { json = JSON.parse(text); } catch (_) {}
  const err = (json.error && json.error.errors && json.error.errors[0]) || {};
  const reason = err.reason || '';

  if (reason === 'quotaExceeded' || res.status === 403 && /quota/i.test(text)) {
    return hint(
      'YouTube API の1日の利用枠を使い切りました。',
      'アップロード1回で1600ユニット、既定は1日10,000ユニット（およそ6本）です。日付が変わるまで待ってください。'
    );
  }
  if (reason === 'youtubeSignupRequired') {
    return hint(
      'このGoogleアカウントに YouTube チャンネルがありません。',
      'YouTube でチャンネルを作成してから、連携し直してください。'
    );
  }
  if (res.status === 401) {
    return hint('YouTube の認証が切れています。', '「連携設定」から接続し直してください。');
  }
  if (reason === 'uploadLimitExceeded') {
    return hint('このチャンネルの1日のアップロード上限に達しました。', '時間をあけて再実行してください。');
  }
  return hint(
    `YouTube が ${res.status} を返しました。`,
    (err.message || text || '').slice(0, 300)
  );
}

function hint(message, h) {
  const e = new Error(message);
  e.hint = h;
  return e;
}

module.exports = { step };
