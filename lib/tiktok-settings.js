'use strict';
/**
 * TikTok 直接投稿の「投稿ごとの設定」を点検する。
 *
 * ★ 直接投稿（video.publish）には、TikTok が決めた画面の決まりがある。
 *   https://developers.tiktok.com/doc/content-sharing-guidelines
 *
 *     ・公開範囲は本人が選ぶ。既定値を置かない
 *     ・コメント／デュエット／スティッチは、どれも最初は外しておく
 *     ・商用コンテンツの申告は最初は OFF。ON にしたら「自分のブランド」
 *       「ブランドコンテンツ」のどちらか（または両方）を選ぶ
 *     ・ブランドコンテンツは「自分のみ」に出せない
 *     ・本人の同意を得てから送る
 *
 *   画面だけで守ると、画面を通らない保存（古い画面、手で叩いたAPI）で破れる。
 *   だから保存の入口（api/posts.js）でも、送る直前（lib/networks/tiktok.js）でも、
 *   同じこの関数を通す。
 *
 * ★ このアプリ独自の決まりをもう1つ足している。
 *   案件リンク（A8.net など）を含む投稿は、報酬を受けて他社の商品を紹介する
 *   ものなので「ブランドコンテンツ」の申告を必須にする。ステマ規制（PR表記）と
 *   同じ理由。既定で ON にはしない（TikTok の決まり）。本人に入れてもらい、
 *   入っていなければ保存を断る。
 */

const PRIVACY_LEVELS = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];

const PRIVACY_LABEL = {
  PUBLIC_TO_EVERYONE: '全員',
  MUTUAL_FOLLOW_FRIENDS: '相互フォローの友達',
  FOLLOWER_OF_CREATOR: 'フォロワー',
  SELF_ONLY: '自分のみ',
};

/** 画面から来た値を、決まった形に揃える。知らないキーは捨てる。 */
function normalize(input) {
  if (!input || typeof input !== 'object') return null;
  const b = (v) => v === true;
  return {
    privacy_level: typeof input.privacy_level === 'string' ? input.privacy_level : '',
    allow_comment: b(input.allow_comment),
    allow_duet: b(input.allow_duet),
    allow_stitch: b(input.allow_stitch),
    commercial: b(input.commercial),
    your_brand: b(input.your_brand),
    branded_content: b(input.branded_content),
    is_aigc: b(input.is_aigc),
    consent: b(input.consent),
  };
}

/**
 * 設定の食い違いを、日本語の理由の配列で返す。空なら通してよい。
 *
 * @param s              normalize() 済みの設定
 * @param opts.hasAffiliateLink  案件リンクを含む投稿か
 * @param opts.privacyOptions    creator_info が返した選べる公開範囲（送る直前だけ渡す）
 */
function problems(s, opts = {}) {
  const out = [];
  if (!s) return ['TikTok の投稿設定がありません。'];

  if (!s.privacy_level) {
    out.push('TikTok の公開範囲を選んでください。');
  } else if (!PRIVACY_LEVELS.includes(s.privacy_level)) {
    out.push('TikTok の公開範囲が正しくありません。');
  } else if (Array.isArray(opts.privacyOptions) && !opts.privacyOptions.includes(s.privacy_level)) {
    out.push(`このTikTokアカウントでは「${PRIVACY_LABEL[s.privacy_level]}」を選べません。公開範囲を選び直してください。`);
  }

  if (s.commercial && !s.your_brand && !s.branded_content) {
    out.push('商用コンテンツを申告する場合は、「自分のブランド」か「ブランドコンテンツ」を選んでください。');
  }
  if (!s.commercial && (s.your_brand || s.branded_content)) {
    out.push('商用コンテンツの申告が OFF のまま、種類だけが選ばれています。');
  }
  if (s.branded_content && s.privacy_level === 'SELF_ONLY') {
    out.push('ブランドコンテンツの公開範囲は「自分のみ」にできません。');
  }
  if (opts.hasAffiliateLink && !(s.commercial && s.branded_content)) {
    out.push('案件リンクを含む投稿は、TikTok でも「ブランドコンテンツ」の申告が必要です（ステマ規制）。');
  }
  if (!s.consent) {
    out.push('TikTok の規約への同意（投稿設定の一番下）にチェックを入れてください。');
  }
  return out;
}

/** 設定を、TikTok の post_info の形にする。 */
function toPostInfo(s, title) {
  return {
    title: title || '',
    privacy_level: s.privacy_level,
    disable_comment: !s.allow_comment,
    disable_duet: !s.allow_duet,
    disable_stitch: !s.allow_stitch,
    brand_content_toggle: !!(s.commercial && s.branded_content),
    brand_organic_toggle: !!(s.commercial && s.your_brand),
    is_aigc: !!s.is_aigc,
  };
}

/**
 * TikTok に表示されるラベルと、同意文。TikTok が文言まで指定している。
 * 画面はこれをそのまま出す。
 */
function disclosure(s) {
  const brand = !!(s && s.commercial && s.your_brand);
  const branded = !!(s && s.commercial && s.branded_content);
  const label = branded
    ? "Your photo/video will be labeled as 'Paid partnership'"
    : brand
    ? "Your photo/video will be labeled as 'Promotional content'"
    : '';
  const consent = branded
    ? "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation"
    : "By posting, you agree to TikTok's Music Usage Confirmation";
  return { label, consent };
}

module.exports = { PRIVACY_LEVELS, PRIVACY_LABEL, normalize, problems, toPostInfo, disclosure };
