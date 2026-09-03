'use strict';
/**
 * 数字の取り込みと、読み出し。
 *
 *   POST /api/insights            … 毎晩1回。数字を集めてDBに書く（cronの鍵で守る）
 *   GET  /api/insights?group=…    … 画面が読む。数字と、気づいたこと
 *   GET  /api/insights?probe=…    … 接続テスト。SNSが何を返したかをそのまま見せる
 *
 * ★ 1つのSNSが失敗しても、他を巻き込まない。
 *   lib/insights.js が throw せずに ok:false を返すので、ここは素直に
 *   その結果を書き留めるだけでよい。1件の失敗で20件の取り込みが止まると、
 *   その日のぶんが丸ごと消える。
 *
 * ★ 制限時間に切られても、途中まで残る。
 *   1アカウント処理するたびに書き込む。まとめて最後に書くと、
 *   時間切れのときに全部消える。取り込みは1日1回しかないので、
 *   消えるとその日は取り返せない。
 */

const auth = require('../lib/auth');
const db = require('../lib/db');
const insights = require('../lib/insights');
const store = require('../lib/metrics-store');
const advice = require('../lib/advice');
const scope = require('../lib/account-scope');

// Vercel の制限時間より手前で自分から切り上げる。
const TIME_BUDGET_MS = 45_000;

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'POST') return await collect(req, res);
    if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

    if (!auth.guard(req, res)) return;
    const q = req.query || {};
    if (q.probe) return res.status(200).json(await probe(String(q.probe)));
    return res.status(200).json(await read(q.group ? String(q.group) : null));
  } catch (err) {
    const status = err.userError ? 400 : 500;
    return res.status(status).json({ error: err.message, hint: err.hint });
  }
};

// ---------------------------------------------------------------- 取り込み

/**
 * ★ 入口は cron の鍵で守る。ログインの紙は cron には無い。
 *   worker と同じ守り方にしてある（同じ鍵、同じ診断）。
 */
function guardCron(req, res) {
  const expected = process.env.CRON_SECRET;
  const given =
    req.headers['x-cron-key'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
    (req.query && req.query.key);

  if (!expected) {
    res.status(500).json({
      error: 'サーバーに CRON_SECRET が設定されていません。',
      hint: 'Vercel の Settings → Environment Variables に追加して、再デプロイしてください。',
    });
    return false;
  }
  const got = String(given || '');
  if (got.length !== expected.length || got !== expected) {
    res.status(401).json({
      error: 'unauthorized',
      hint: 'x-cron-key の値が CRON_SECRET と一致していません。',
      診断: { 鍵が届いているか: got.length > 0, 届いた文字数: got.length, 期待している文字数: expected.length },
    });
    return false;
  }
  return true;
}

async function collect(req, res) {
  if (!guardCron(req, res)) return;

  const startedAt = Date.now();
  const takenOn = store.jstToday();
  const accounts = await db.listAccounts();
  const done = [];

  for (const summary of accounts) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      done.push({ account: summary.id, skipped: '時間切れ。次の回で取り込みます' });
      continue;
    }

    // ★ トークンを含む行が要る。一覧は隠しているので、ここで取り直す。
    const account = await db.getAccount(summary.id);
    if (!account) continue;

    const one = { account: account.id, network: account.network, label: account.label };

    // --- アカウントの数字 ---
    const stats = await insights.accountStats(account, db);
    await store.saveAccount(db, account.id, stats, takenOn);
    one.ok = stats.ok !== false;
    one.metrics = stats.metrics || null;
    if (stats.error) one.error = stats.error;

    // --- 投稿ごとの数字 ---
    const targets = await publishedTargets(account.id);
    if (targets.length) {
      const per = await insights.postStats(account, targets, db);
      if (per.ok !== false) {
        const saved = await store.saveTargets(db, per.byTargetId, takenOn);
        one.posts = Array.isArray(saved) ? saved.length : 0;
      } else {
        one.postsSkipped = per.error;
      }
    }

    // --- TikTok の動画一覧（アプリの投稿とは結びつかない） ---
    if (account.network === 'tiktok') {
      const vids = await insights.recentVideos(account, db);
      if (vids.ok !== false) {
        await store.saveTiktokVideos(db, account.id, vids.videos, takenOn);
        one.videos = (vids.videos || []).length;
      } else {
        one.videosSkipped = vids.error;
      }
    }

    done.push(one);
  }

  return res.status(200).json({ takenOn, accounts: done.length, done });
}

/**
 * 数字を取りに行ってよい投稿先。
 *
 * ★ success の行だけ。下書き（manual / handed）や失敗した行には数字が付かない。
 *   external_id が無い行も、何を問い合わせればよいか分からないので外す。
 */
async function publishedTargets(accountId) {
  return (await db.rest('post_targets', {
    query: {
      select: 'id,post_id,network,external_id,posted_at',
      account_id: `eq.${accountId}`,
      status: 'eq.success',
      external_id: 'not.is.null',
      order: 'posted_at.desc',
      limit: '200',
    },
  })) || [];
}

// ---------------------------------------------------------------- 接続テスト

/**
 * いま何が取れるかを、そのまま見せる。
 *
 * ★ これがいちばん最初に要る。Instagram が現在の権限で数字を返すかは
 *   確かめられていない。取れる前提で画面を作ると、空欄の理由が分からなくなる。
 *   SNS が返した中身を隠さず出して、権限を直せるようにする。
 */
async function probe(accountId) {
  const account = await db.getAccount(accountId);
  if (!account) {
    const e = new Error('その連携先は見つかりません。');
    e.userError = true;
    throw e;
  }

  const stats = await insights.accountStats(account, db);
  const targets = await publishedTargets(account.id);
  const per = targets.length
    ? await insights.postStats(account, targets.slice(0, 3), db)
    : { ok: false, error: '数字を取れる投稿がまだありません（公開済みのものだけが対象です）' };

  return {
    account: { id: account.id, network: account.network, label: account.label,
               account_name: account.account_name },
    accountStats: {
      ok: stats.ok !== false, metrics: stats.metrics || null,
      error: stats.error || null, hint: stats.hint || null,
      // ★ 生の返事を出す。ここを隠すと、権限の問題か仕様の問題かが切り分けられない。
      raw: trim(stats.raw),
    },
    postStats: {
      ok: per.ok !== false, error: per.error || null, hint: per.hint || null,
      byTargetId: per.byTargetId || null, raw: trim(per.raw),
    },
    checkedPosts: targets.length,
  };
}

/** 生の返事は長くなりがち。画面に出す前に切る（鍵は元から入っていない）。 */
function trim(raw) {
  if (raw === undefined || raw === null) return null;
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return s.length > 2000 ? s.slice(0, 2000) + '…（以下略）' : s;
}

// ---------------------------------------------------------------- 読み出し

const HISTORY_DAYS = 30;

async function read(groupId) {
  const all = await db.listAccounts();
  const accounts = groupId ? scope.accountsFor(groupId, all) : all;
  if (!accounts.length) {
    return { accounts: [], posts: [], tiktokVideos: [], observations: advice.observations({ accounts: [] }) };
  }

  const ids = accounts.map((a) => a.id);
  const history = await store.accountHistory(db, ids, HISTORY_DAYS);

  const byAccount = new Map(ids.map((id) => [id, []]));
  for (const row of history) {
    const list = byAccount.get(row.account_id);
    if (list) list.push(row);
  }

  const withDays = accounts.map((a) => {
    const days = byAccount.get(a.id) || [];
    return Object.assign({}, a, { days, latest: days.length ? days[days.length - 1] : null });
  });

  // --- 投稿ごとの数字 ---
  const { posts, postsByNetwork, stalled } = await postsWithMetrics(accounts);

  // --- TikTok の動画（結びつかない一覧） ---
  let tiktokVideos = [];
  for (const a of accounts) {
    if (a.network !== 'tiktok') continue;
    const vs = await store.latestTiktokVideos(db, a.id);
    tiktokVideos = tiktokVideos.concat(vs.map((v) => Object.assign({ account: a.label || a.account_name }, v)));
  }

  return {
    accounts: withDays,
    posts,
    tiktokVideos,
    observations: advice.observations({ accounts: withDays, postsByNetwork, stalled }),
  };
}

/**
 * 投稿と、その最新の数字。
 * ★ ついでに「手渡しのまま止まっているもの」も拾う。分析より先に効く指摘なので。
 */
async function postsWithMetrics(accounts) {
  const ids = accounts.map((a) => a.id);
  const rows = (await db.rest('post_targets', {
    query: {
      select: 'id,post_id,network,account_id,status,posted_at,permalink,posts(title,scheduled_at)',
      account_id: `in.(${ids.join(',')})`,
      order: 'posted_at.desc',
      limit: '400',
    },
  })) || [];

  const done = rows.filter((r) => r.status === 'success');
  const metrics = await store.latestTargetMetrics(db, done.map((r) => r.id));

  const posts = done.map((r) => ({
    targetId: r.id,
    postId: r.post_id,
    network: r.network,
    title: (r.posts && r.posts.title) || '（題名なし）',
    permalink: r.permalink,
    postedAt: r.posted_at,
    metrics: metrics[r.id] || null,
  }));

  const postsByNetwork = {};
  for (const p of posts) {
    if (!p.metrics) continue;
    (postsByNetwork[p.network] = postsByNetwork[p.network] || []).push({
      title: p.title, views: p.metrics.views, likes: p.metrics.likes,
    });
  }

  const stalled = rows
    .filter((r) => r.status === 'manual' || r.status === 'handed')
    .map((r) => ({ network: r.network, title: (r.posts && r.posts.title) || '（題名なし）' }));

  return { posts, postsByNetwork, stalled };
}
