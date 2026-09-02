'use strict';
/**
 * 「投稿手前まで」進めるための、SNSごとの渡し方。
 *
 * ★ この機能の出発点は、SNSの調べ直しで分かったこの違い。
 *
 *   下書きで止められる          叩いた瞬間に公開される
 *   ─────────────────           ─────────────────────
 *   TikTok  … 受信箱（下書き）  Instagram … media_publish
 *   YouTube … 非公開で上がる    X         … /2/tweets
 *
 *   Instagram と X には「下書き」という着地点が API に存在しない。
 *   つまりこの2つを投稿手前で止める方法は「APIを呼ばないこと」しかない。
 *   代わりに素材（動画・画像・本文）を手元に渡し、本人がアプリから出す。
 *
 * ★ 止めるかどうかは「運用アカウント × SNS」で決める。
 *   Instagram は無料で案件リンクも載せられるので自動投稿してよい、
 *   けれど X は1投稿ごとに課金され、そもそもA8の掲載対象外なので手渡し、
 *   ということが言える必要がある。だから真偽値ひとつでは足りない。
 */

/** 叩いた瞬間に公開されてしまうSNS。schema_v5 の publishing_networks() と同じ。 */
const PUBLISHING_NETWORKS = ['instagram', 'x'];

/**
 * 渡し方の一覧。
 *   mode 'api'  … APIで下書き／非公開まで進める。公開は本人がアプリで押す
 *   mode 'hand' … APIを使わない。素材を手元に渡す
 *   needs       … 本人が受け取るもの（画面のボタンはこれを見て並べる）
 */
const DELIVERY = {
  tiktok: {
    mode: 'api',
    action: 'TikTokの下書きに送る',
    stops: 'TikTokアプリの「下書き」に届きます。公開はアプリで押してください。',
    needs: ['ttCaption'],
    note: '下書き方式では本文を一緒に送れません（TikTok側の仕様）。公開するときにアプリで貼ってください。',
  },
  youtube: {
    mode: 'api',
    action: 'YouTubeへ非公開で上げる',
    stops: '非公開のまま上がります。公開は YouTube Studio で押してください。',
    needs: [],
    note: 'タイトルと説明文は動画と一緒に送られます。',
  },
  instagram: {
    mode: 'hand',
    action: '動画と本文を受け取る',
    stops: 'Instagram には下書きのAPIがありません。動画を保存して、アプリから投稿してください。',
    needs: ['video', 'igCaption'],
    note: 'APIで送れるのは「公開」だけなので、ここでは使いません。',
  },
  x: {
    mode: 'hand',
    action: '画像2枚と本文を受け取る',
    stops: 'X は API で送ると即公開になります。画像と本文を保存して、ご自身で投稿してください。',
    needs: ['posterBefore', 'posterAfter', 'xText'],
    note: 'X は動画ではなく、空欄と答えの画像2枚を出す運用です。A8.net の掲載対象外なので案件リンクは載せられません。',
  },
};

/** 受け取るものの名前。画面のボタンの文言になる。 */
const ASSET_LABEL = {
  video: '動画を保存',
  posterBefore: '画像（空欄）を保存',
  posterAfter: '画像（答え）を保存',
  igCaption: 'Instagram の本文をコピー',
  ttCaption: 'TikTok の本文をコピー',
  xText: 'X の本文をコピー',
};

/** その素材が、この投稿から取り出せるか。 */
const ASSET_READY = {
  video: (p) => p.media_kind === 'video' && !!p.media_path,
  posterBefore: (p) => Array.isArray(p.rows) ? p.rows.length > 0 : true,
  posterAfter: (p) => Array.isArray(p.rows) ? p.rows.length > 0 : true,
  igCaption: (p) => !!(p.ig_caption || '').trim(),
  ttCaption: (p) => !!(p.tt_caption || '').trim(),
  xText: (p) => !!(p.x_text || '').trim(),
};

const isPublishing = (network) => PUBLISHING_NETWORKS.includes(network);
const deliveryFor = (network) => DELIVERY[network] || null;

/**
 * その運用アカウントで、このSNSへ自動投稿してよいか。
 *
 * ★ SNSごとに決める。まとめて1つの真偽値にすると、Instagram を許した瞬間に
 *   X も許すことになる。この2つは事情が違う（X は課金され、案件リンクも
 *   載せられない）ので、片方だけ許せなければ設定として使えない。
 *
 * ★ 分からないときは true（いままでどおり）。
 *   ここを安全側に倒すと、列を足した直後に動いている予約投稿が全部止まる。
 *   止める判断は、運用アカウントで明示的に設定されたときだけ。
 */
function autoPublishesTo(group, network) {
  if (!group || !Array.isArray(group.auto_publish_networks)) return true;
  return group.auto_publish_networks.includes(network);
}

/**
 * この投稿先を、順番待ちに入れてよいか。
 * 入れてよければ 'queued'、手渡しにすべきなら 'manual'。
 *
 * TikTok と YouTube は、許可のあるなしに関わらず下書き・非公開までしか
 * 進まないので、常に順番待ちに入れてよい。
 */
function statusForTarget(group, network) {
  if (!isPublishing(network)) return 'queued';
  return autoPublishesTo(group, network) ? 'queued' : 'manual';
}

/** 予約しようとしている投稿先のうち、手渡しにしかできないもの。 */
function manualOnly(group, accounts) {
  return (accounts || []).filter(
    (a) => a && isPublishing(a.network) && !autoPublishesTo(group, a.network));
}

/**
 * 受け渡しの手順を組み立てる。画面はこれをそのまま並べるだけ。
 *
 * targets は post_targets の行（status を持つ）。無ければ未設定として扱う。
 */
function planFor(post, accounts, group, targets) {
  const byAccount = new Map((targets || []).map((t) => [t.account_id, t]));

  return (accounts || []).map((a) => {
    const d = DELIVERY[a.network];
    const t = byAccount.get(a.id) || null;

    // 許可のあるSNSは、公開系でも API で出してよい。
    const mode = d && d.mode === 'hand' && autoPublishesTo(group, a.network)
      ? 'api-publish' : (d ? d.mode : 'hand');

    const needs = (d ? d.needs : []).map((key) => ({
      key,
      label: ASSET_LABEL[key],
      ready: ASSET_READY[key] ? ASSET_READY[key](post) : true,
    }));

    return {
      accountId: a.id,
      network: a.network,
      name: a.label || a.account_name || a.network,
      mode,
      action: d ? d.action : '手元に渡す',
      stops: d ? d.stops : '',
      note: d ? d.note : '',
      needs,
      status: t ? t.status : null,
      ready: needs.every((n) => n.ready),
      missing: needs.filter((n) => !n.ready).map((n) => n.label),
    };
  });
}

/** 手渡しが終わった投稿先の、次の状態。 */
const HANDED = 'handed';
const MANUAL = 'manual';

/** 自動処理の勘定に入れない状態。schema_v4 の recalc_post_status と同じ。 */
const OFF_PIPELINE = [MANUAL, HANDED];

module.exports = {
  PUBLISHING_NETWORKS, DELIVERY, ASSET_LABEL, ASSET_READY,
  MANUAL, HANDED, OFF_PIPELINE,
  isPublishing, deliveryFor, autoPublishesTo, statusForTarget, manualOnly, planFor,
};
