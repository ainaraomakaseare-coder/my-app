'use strict';
/**
 * TikTok への投稿。送り方は2つある。
 *
 *   直接投稿（video.publish）… 本文も公開範囲も一緒に送り、そのまま公開される
 *   下書き送信（video.upload）… TikTokアプリの下書きに届き、本人が公開する
 *
 * ★ どちらで送るかは、投稿のたびにここで決める。
 *     ・その連携が video.publish を実際に持っている（lib/tiktok.js の canDirectPost）
 *     ・その投稿に、本人が選んだ投稿設定（posts.tt_settings）がある
 *   両方そろったときだけ直接投稿。どちらかが欠けたら、いままでどおり下書き送信。
 *   投稿設定は TikTok の決まりで「本人が明示的に選ぶ」ものなので、
 *   こちらで勝手に埋めて直接投稿にすることはしない。
 *
 * ★ 審査前（未監査）のアプリの直接投稿は、非公開アカウントにしか出せない。
 *   公開アカウントに送ると unaudited_client_can_only_post_to_private_accounts が返る。
 *   このときは止めずに下書き送信へ切り替える。動画を送る前（init の時点）で
 *   断られるので、二重に送ることはない。
 *
 * ★ ファイルの送り方
 *   URLを渡す方式はドメインの所有権証明が要る（Supabase のURLは証明できない）。
 *   中身を直接送る FILE_UPLOAD を使う。1かたまり 5MB〜64MB という決まりが
 *   あり、こちらの上限は50MBなので、常に「まるごと1かたまり」で条件を満たす。
 *
 * ★ 下書き送信では、キャプションを一緒に送れない（TikTok側の仕様）。
 *   本文は公開するときにアプリで入力する。直接投稿ではこの手間は無い。
 */

const tiktok = require('../tiktok');
const settings = require('../tiktok-settings');

const API = 'https://open.tiktokapis.com/v2';

// どこまで進んだか（post_targets.stage）。送り方もここで見分ける。
const STAGE_INBOX = 'uploaded';
const STAGE_DIRECT = 'uploaded_direct';

async function step({ post, target, account, db }) {
  if (post.media_kind !== 'video') {
    throw hint('TikTok には動画が必要です。', '画像だけの投稿では TikTok を選べません。');
  }
  if (!post.media_path) throw hint('動画が添付されていません。', '動画をアップロードしてから予約してください。');

  const token = await tiktok.accessTokenFor(account, db);

  // --- (1) 枠を取って、動画を送る -------------------------------------------
  if (!target.external_id) {
    const s = settings.normalize(post.tt_settings);
    const media = await db.download(post.media_path);

    if (tiktok.canDirectPost(account) && s && s.privacy_level) {
      const sent = await sendDirect({ token, post, s, media });
      if (sent) return sent;
      // null は「審査前なので直接投稿できない」。下書き送信に回す。
      return await sendInbox({ token, post, media,
        prefix: '審査前のアプリは公開アカウントに直接投稿できないため、下書きに送りました。' });
    }
    return await sendInbox({ token, post, media, prefix: '' });
  }

  // --- (2) 届いたか見に行く -------------------------------------------------
  const st = await call(token, '/post/publish/status/fetch/', { publish_id: target.external_id });
  const status = (st.data && st.data.status) || '';
  const direct = target.stage === STAGE_DIRECT;

  if (status === 'FAILED') {
    throw hint('TikTok 側で動画の処理に失敗しました。', failReason((st.data && st.data.fail_reason) || ''));
  }

  if (direct && status === 'PUBLISH_COMPLETE') {
    // ★ 動画IDは「全員に公開され、審査も通った」ときだけ返る。
    //   これが取れると、あとで数字（のび）とこの投稿を結びつけられる。
    const ids = (st.data && st.data.publicaly_available_post_id) || [];
    const videoId = ids.length ? String(ids[0]) : null;
    let permalink = null;
    if (videoId) {
      const who = await tiktok.creatorInfo(token).catch(() => null);
      permalink = who && who.username
        ? `https://www.tiktok.com/@${who.username}/video/${videoId}`
        : null;
    }
    return { done: true, externalId: videoId || target.external_id, permalink };
  }

  // 下書きとして届いたら完了。
  if (!direct && (status === 'SEND_TO_USER_INBOX' || status === 'PUBLISH_COMPLETE')) {
    // 下書きにはURLが無い。TikTokアプリで開いてもらう。
    // stage は画面が「本文を貼る手間が残っているか」を見分けるのに使う（lib/handoff.js）。
    return { done: true, stage: 'published_inbox', externalId: target.external_id, permalink: null };
  }

  return {
    wait: true,
    stage: target.stage || STAGE_INBOX,
    seconds: 15,
    note: `TikTok 処理中（${status || '確認中'}）`,
  };
}

// ---------------------------------------------------------------- 直接投稿

/**
 * 直接投稿の init と送信。
 * 審査前で断られたときだけ null を返す（呼ぶ側が下書き送信に切り替える）。
 */
async function sendDirect({ token, post, s, media }) {
  // ★ 送る直前にも投稿者の情報を取り直す。予約したあとで公開範囲の選択肢や
  //   動画の長さの上限が変わっていることがある（TikTok の決まりでもある）。
  const creator = await tiktok.creatorInfo(token);

  const issues = settings.problems(s, {
    hasAffiliateLink: !!post.has_affiliate_link,
    privacyOptions: creator.privacyOptions,
  });
  if (issues.length) throw hint(issues[0], '投稿を開いて、TikTok の投稿設定を直してから再実行してください。');

  const seconds = mp4DurationSec(media);
  if (creator.maxDurationSec && seconds && seconds > creator.maxDurationSec) {
    throw hint(
      `動画が長すぎます（${Math.ceil(seconds)}秒／このアカウントの上限${creator.maxDurationSec}秒）。`,
      '短くした動画に差し替えてください。'
    );
  }

  // 閉じられている操作は、選ばれていても送らない。
  const eff = Object.assign({}, s, {
    allow_comment: s.allow_comment && !creator.commentDisabled,
    allow_duet: s.allow_duet && !creator.duetDisabled,
    allow_stitch: s.allow_stitch && !creator.stitchDisabled,
  });
  const caption = (post.tt_caption || post.body_common || '').trim();

  let init;
  try {
    init = await call(token, '/post/publish/video/init/', {
      post_info: settings.toPostInfo(eff, caption),
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: media.length,
        chunk_size: media.length,   // まるごと1かたまり
        total_chunk_count: 1,
      },
    });
  } catch (e) {
    if (e.code === 'unaudited_client_can_only_post_to_private_accounts') return null;
    throw e;
  }

  const publishId = await upload(init, media);
  return {
    wait: true,
    stage: STAGE_DIRECT,
    externalId: publishId,
    seconds: 15,
    note: `TikTok に直接投稿しました（公開範囲：${settings.PRIVACY_LABEL[s.privacy_level]}）。` +
      '公開されてプロフィールに出るまで数分かかることがあります。',
  };
}

// ---------------------------------------------------------------- 下書き送信

async function sendInbox({ token, post, media, prefix }) {
  const init = await call(token, '/post/publish/inbox/video/init/', {
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: media.length,
      chunk_size: media.length,   // まるごと1かたまり
      total_chunk_count: 1,
    },
  });
  const publishId = await upload(init, media);

  const caption = (post.tt_caption || post.body_common || '').trim();
  return {
    wait: true,
    stage: STAGE_INBOX,
    externalId: publishId,
    seconds: 15,
    note: prefix + (caption
      ? 'TikTok に動画を送りました。公開時に使う本文：' + caption.slice(0, 500)
      : 'TikTok に動画を送りました（下書きに届きます）'),
  };
}

// ---------------------------------------------------------------- 共通

/** init の返事から置き場所を取り出し、動画をまるごと送る。publish_id を返す。 */
async function upload(init, media) {
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
  return publishId;
}

/** TikTok の fail_reason を、次の一手に言い換える。 */
function failReason(reason) {
  const known = {
    frame_rate_check_failed: 'フレームレートが崩れています。動画を作っている間はタブを表示したままにして、作り直してください。',
    duration_check_failed: '動画の長さが TikTok の条件に合いません。',
    file_format_check_failed: 'MP4（H.264 + AAC）の縦型で書き出してください。',
    picture_size_check_failed: '画面サイズが TikTok の条件に合いません。縦型（1080×1920 など）で書き出してください。',
    spam_risk_too_many_posts: 'TikTok の1日の投稿数の上限です。明日以降に再実行してください。',
    spam_risk_text: '本文が TikTok にスパムと判定されました。本文を見直してください。',
    spam_risk: 'TikTok にスパムと判定されました。時間をあけて、内容を見直してください。',
    auth_removed: 'TikTok 側でこのアプリの許可が外されています。連携をやり直してください。',
    publish_cancelled: '公開が取り消されました。',
  };
  return known[reason] || (reason ? `理由：${reason}` : 'MP4（H.264 + AAC）の縦型で書き出してください。');
}

/**
 * MP4 の長さ（秒）を、ファイルの中の mvhd 箱から読む。読めなければ null。
 *
 * ★ サーバーに ffmpeg は無く、npm も増やさない決まりなので、ここだけ自前で読む。
 *   読めないときは長さの確認を飛ばす（TikTok 側でも弾かれるので実害は小さい）。
 */
function mp4DurationSec(buf) {
  if (!buf || typeof buf.indexOf !== 'function') return null;
  const at = buf.indexOf('mvhd');
  if (at < 0 || at + 32 > buf.length) return null;
  const version = buf[at + 4];
  let timescale, duration;
  if (version === 1) {
    if (at + 40 > buf.length) return null;
    timescale = buf.readUInt32BE(at + 24);
    duration = Number(buf.readBigUInt64BE(at + 28));
  } else {
    timescale = buf.readUInt32BE(at + 16);
    duration = buf.readUInt32BE(at + 20);
  }
  if (!timescale || !duration) return null;
  return duration / timescale;
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
  const json = parseKeepingIds(await res.text().catch(() => ''));

  const err = json.error || {};
  const code = err.code || '';
  const withCode = (e) => { e.code = code; return e; };

  if (res.status === 401 || code === 'access_token_invalid') {
    throw withCode(hint('TikTok の認証が切れています。', '「連携設定」から接続し直してください。'));
  }
  if (code === 'scope_not_authorized') {
    throw withCode(hint(
      'TikTok の権限が足りません。',
      'TikTok の管理画面で必要な権限（video.upload、直接投稿なら video.publish）が有効か確認し、連携をやり直してください。'
    ));
  }
  if (code === 'unaudited_client_can_only_post_to_private_accounts') {
    throw withCode(hint(
      'このアプリは審査前なので、公開アカウントへは直接投稿できません。',
      'TikTok の審査（Content Posting API の監査）を通すと直接投稿できるようになります。'
    ));
  }
  if (code === 'privacy_level_option_mismatch') {
    throw withCode(hint('選んだ公開範囲は、このTikTokアカウントでは使えません。', '投稿を開いて、公開範囲を選び直してください。'));
  }
  if (code === 'spam_risk_too_many_posts' || code === 'spam_risk_user_banned_from_posting') {
    throw withCode(hint('TikTok 側で投稿が制限されています。', '時間をあけてから再実行してください。'));
  }
  if (!res.ok || (code && code !== 'ok')) {
    throw withCode(hint(`TikTok が ${code || res.status} を返しました。`, (err.message || '').slice(0, 300)));
  }
  return json;
}

/**
 * JSON を読む。ただし動画ID（publicaly_available_post_id）は文字列のまま残す。
 *
 * ★ TikTok の動画IDは19桁の整数で、JSON に数値のまま入ってくる。
 *   JavaScript の数値は16桁ほどしか正確に持てないので、JSON.parse すると
 *   末尾が丸められて「別の動画のID」になる。読む前に文字列へ包んでおく。
 */
function parseKeepingIds(text) {
  const safe = String(text || '').replace(
    /("publicaly_available_post_id"\s*:\s*\[)([^\]]*)\]/,
    (_, head, list) => head + list.replace(/(\d{10,})/g, '"$1"') + ']'
  );
  try { return JSON.parse(safe); } catch (_) { return {}; }
}

function hint(message, h) {
  const e = new Error(message);
  e.hint = h;
  return e;
}

module.exports = { step, mp4DurationSec, parseKeepingIds, STAGE_DIRECT, STAGE_INBOX };
