'use strict';
/**
 * ★ 今日の心臓部。Supabase Cron が毎分ここを叩く。
 *
 *   毎分 Supabase Cron ──> /api/worker ──> 時間が来た投稿を1件ずつ処理
 *
 * 設計の要点は3つ。
 *
 * 1. 【1分に1手ずつ進める】
 *    Instagram の動画変換は1分近くかかる。1回の呼び出しで終わらせようとすると
 *    サーバーの制限時間に引っかかる。そこで「コンテナを作る」「変換を確かめる」
 *    「公開する」を別々の分に分けて進める。途中経過は DB に書いておく。
 *
 * 2. 【二重投稿を防ぐ】
 *    仕事を取るのは claim_due_targets という SQL 関数1本だけ。
 *    「探す」と「取ったと記録する」が1文で起きるので、2つの処理が同時に来ても
 *    勝てるのは片方だけになる。
 *
 * 3. 【失敗は SNS ごとに閉じる】
 *    post_targets の行は SNS ごとに独立している。X が失敗しても
 *    Instagram の行は success のまま。だから再実行しても二重投稿にならない。
 */

const db = require('../lib/db');

const NETWORKS = {
  instagram: require('../lib/networks/instagram'),
  youtube:   require('../lib/networks/youtube'),
  x:         require('../lib/networks/x'),
  tiktok:    require('../lib/networks/tiktok'),
};

// 1回の呼び出しで扱う件数と、使ってよい時間の上限。
// 制限時間に切られる前に自分で切り上げて、途中経過を DB に残すため。
const MAX_TARGETS = 3;
const TIME_BUDGET_MS = 45_000;

// 失敗したときに次を試すまでの待ち時間（1回目・2回目・3回目）
const BACKOFF_MINUTES = [1, 5, 15];

module.exports = async function handler(req, res) {
  // -------------------------------------------------------------------------
  // 入口を守る。ここが開いていると、誰でも投稿処理を暴発させられる。
  // -------------------------------------------------------------------------
  const expected = process.env.CRON_SECRET;
  const given =
    req.headers['x-cron-key'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
    (req.query && req.query.key);

  if (!expected || !safeEqual(String(given || ''), expected)) {
    // 何が違うかを教えない。総当たりの手がかりを与えないため。
    return res.status(401).json({ error: 'unauthorized' });
  }

  const startedAt = Date.now();
  const report = { checkedAt: new Date().toISOString(), requeued: 0, processed: [] };

  try {
    // 途中で落ちて processing のまま固まった行を queued に戻す。
    // attempt は増えたままなので、無限には繰り返さない。
    report.requeued = await db.rpc('requeue_stuck_targets', { p_minutes: 10 });

    // ★ 仕事を取る。ここが二重投稿を防ぐ一点。
    const claimed = await db.rpc('claim_due_targets', { p_limit: MAX_TARGETS });

    for (const target of claimed || []) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        // 時間切れ。まだ触っていない行は queued に戻して、次の1分に譲る。
        await release(target, '時間切れのため次回に持ち越し');
        report.processed.push({ network: target.network, result: 'deferred' });
        continue;
      }
      report.processed.push(await runOne(target));
    }
  } catch (err) {
    report.error = err.message;
    return res.status(500).json(report);
  }

  return res.status(200).json(report);
};

/** 1つの SNS への1手を進める。 */
async function runOne(target) {
  const handler = NETWORKS[target.network];
  const label = { network: target.network, postId: target.post_id };

  try {
    const posts = await db.rest('posts', { query: { select: '*', id: `eq.${target.post_id}` } });
    const post = posts && posts[0];
    if (!post) throw new Error('投稿が見つかりませんでした（削除された可能性があります）');

    if (!handler) throw new Error(`${target.network} は未対応です`);

    // 各SNSのモジュールは3種類の返事のどれかを返す。
    //   { done: true, ... }  投稿できた
    //   { wait: true, ... }  まだ途中。次の分に続きをやる
    //   throw                失敗
    const out = await handler.step({ post, target, db });

    if (out && out.wait) {
      await continueLater(target, out);
      return { ...label, result: 'waiting', stage: out.stage };
    }

    await db.updateById('post_targets', target.id, {
      status: 'success',
      stage: 'published',
      external_id: out.externalId || target.external_id,
      permalink: out.permalink || null,
      posted_at: new Date().toISOString(),
      last_error: null,
    });
    await db.logEvent(target.post_id, target.network, 'success', out.permalink || '投稿しました');
    return { ...label, result: 'success', permalink: out.permalink || null };

  } catch (err) {
    return await fail(target, err, label);
  }
}

/**
 * まだ途中なので、次の分に続きをやる。
 *
 * ★ ここが地味だが大事な点：
 *   仕事を取ったとき attempt が 1 増えている。でも「待ち」は失敗ではないので、
 *   1 戻しておく。そうしないと変換を待っているだけで3回に達して止まってしまう。
 */
async function continueLater(target, out) {
  const seconds = out.seconds || 30;
  await db.updateById('post_targets', target.id, {
    status: 'queued',
    stage: out.stage || target.stage,
    external_id: out.externalId || target.external_id,
    attempt: Math.max(0, target.attempt - 1),
    next_attempt_at: new Date(Date.now() + seconds * 1000).toISOString(),
  });
  if (out.note) await db.logEvent(target.post_id, target.network, 'progress', out.note);
}

/** 時間切れで手をつけなかった行を、そのまま次回に返す。 */
async function release(target, note) {
  await db.updateById('post_targets', target.id, {
    status: 'queued',
    attempt: Math.max(0, target.attempt - 1),
    next_attempt_at: new Date().toISOString(),
  });
  await db.logEvent(target.post_id, target.network, 'deferred', note);
}

/** 失敗した。3回まではあとで自動で再挑戦し、それ以降は手動の再実行を待つ。 */
async function fail(target, err, label) {
  const message = (err && err.message) || String(err);
  const hint = err && err.hint ? `\n次の一手：${err.hint}` : '';
  const givingUp = target.attempt >= BACKOFF_MINUTES.length;

  const wait = BACKOFF_MINUTES[Math.min(target.attempt, BACKOFF_MINUTES.length - 1)];

  await db.updateById('post_targets', target.id, {
    status: givingUp ? 'failed' : 'queued',
    last_error: (message + hint).slice(0, 2000),
    next_attempt_at: givingUp ? null : new Date(Date.now() + wait * 60_000).toISOString(),
  });
  await db.logEvent(
    target.post_id,
    target.network,
    givingUp ? 'failed' : 'retrying',
    givingUp ? message + hint : `${message}（${wait}分後にもう一度試します）`
  );

  return { ...label, result: givingUp ? 'failed' : 'will-retry', error: message };
}

/** 長さの違いで正解を推測されないよう、時間のかかり方を揃えて比べる。 */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

module.exports.runOne = runOne;
