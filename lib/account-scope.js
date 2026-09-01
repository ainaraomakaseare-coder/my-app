'use strict';
/**
 * 投稿先の取り違えを、出す直前に止める。
 *
 * いまの画面は投稿先の名前（「Instagram（アフィリ用）」）を出しているので
 * 気づきやすくはなっている。ただしそれは"気づきやすくする"対策であって、
 * "作れなくする"対策ではない。DAY12 の想定壁にも「企画用アカウントに誤爆」が
 * 挙がっているとおり、いつか起きる。
 *
 * ★ いまのスキーマに足りないもの
 *   sns_accounts で「同じSNSに複数アカウント」までは表現できているが、
 *   「この投稿はどの運用ラインのものか」という所属が posts に無い。
 *   post_targets.account_id 経由でしか繋がらないので、1つの投稿が
 *   企画用とアフィリ用の両方に向く状態が作れてしまう。
 *   posts と sns_accounts に group_id を足すのが最小の修正（README参照）。
 */

/**
 * A8.net で広告を載せられる媒体。
 * DAY12_PLAN の調査どおり X は対象外。費用の問題以前に、案件リンクを
 * 載せてはいけない。ここは運用の好みではなく規約なので、定数で持つ。
 */
const AFFILIATE_NETWORKS = ['instagram', 'youtube', 'tiktok', 'pinterest'];

/** 選んだ運用ラインの連携先だけを返す。画面の一覧はこれを通す。 */
function accountsFor(groupId, accounts) {
  return (accounts || []).filter((a) => a.group_id === groupId);
}

/**
 * この投稿を、この連携先へ出してよいか。
 * 出してよければ null。駄目なら { code, message }。
 *
 * 見る順番に意味がある。期限切れは繋ぎ直せば済むが、誤爆と規約違反は
 * 取り返しがつかないので先に見る。
 */
function checkTarget(post, account) {
  if (!account) {
    return { code: 'no-account', message: '投稿先の連携が選ばれていません' };
  }

  const label = account.label || account.account_name || account.network;

  if (post.group_id && account.group_id && post.group_id !== account.group_id) {
    return { code: 'cross-account',
      message: `この投稿は別の運用アカウントのものです。「${label}」には出せません` };
  }

  if (post.hasAffiliateLink && !AFFILIATE_NETWORKS.includes(account.network)) {
    return { code: 'affiliate-not-allowed',
      message: `${account.network} は A8.net の掲載対象外です。案件リンクを含む投稿は出せません` };
  }

  if (account.expires_at && new Date(account.expires_at) < new Date()) {
    return { code: 'expired', message: `「${label}」の連携が切れています。繋ぎ直してください` };
  }

  return null;
}

/** 投稿先をまとめて確かめる。1件でも駄目なら、その理由を全部返す。 */
function checkTargets(post, accounts) {
  return (accounts || [])
    .map((a) => ({ account: a, issue: checkTarget(post, a) }))
    .filter((r) => r.issue)
    .map((r) => Object.assign({ accountId: r.account.id }, r.issue));
}

module.exports = { AFFILIATE_NETWORKS, accountsFor, checkTarget, checkTargets };
