'use strict';
/**
 * 数字の取り込みと、読み出し。
 *
 *   POST /api/insights            … 毎晩1回。数字を集めてDBに書く（cronの鍵で守る）
 *   GET  /api/insights?group=…    … 画面が読む。数字と、気づいたこと
 *   GET  /api/insights?probe=…    … 接続テスト。SNSが何を返したかをそのまま見せる
 *   GET  /api/insights?apps=1     … App Store のダウンロード数（lib/appstore.js）
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
const benchmark = require('../lib/benchmark');
const benchmarkYoutube = require('../lib/benchmark-youtube');
const benchmarkStore = require('../lib/benchmark-store');
const benchmarkIntake = require('../scripts/benchmark-intake');
const appstore = require('../lib/appstore');

// Vercel の制限時間より手前で自分から切り上げる。
const TIME_BUDGET_MS = 45_000;

// 取り込みの本文はこれより大きければ断る（貼り間違いで巨大な本文が来ても詰まらないように）。
const MAX_INTAKE_BYTES = 1_000_000;

module.exports = async function handler(req, res) {
  try {
    const q = req.query || {};

    // ★ 利用者が手やClaude in Chromeで集めた記録を貼り込む入口。
    //   cronの鍵ではなく、いつものログインで守る。POSTだが collect() より先に見る。
    if (req.method === 'POST' && String(q.benchmark || '') === 'intake') {
      if (!auth.guard(req, res)) return;
      return res.status(200).json(await intakeBenchmark(req, q));
    }
    if (req.method === 'POST') return await collect(req, res);
    if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

    if (!auth.guard(req, res)) return;
    if (q.probe) return res.status(200).json(await probe(String(q.probe)));
    if (q.apps) return res.status(200).json(await appstore.downloads());
    if (q.benchmark === 'youtube') return res.status(200).json(await collectYoutubeBenchmark(q));
    if (q.benchmark === 'status') return res.status(200).json(await benchmarkStatus(q));
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

// ---------------------------------------------------------------- のび（YouTube 自動収集）

/**
 * 「のび」タブの「伸びている動画を集める（YouTube）」ボタン。
 * ★ ここは入口の作法（genre の点検・アカウント選び）だけ。
 *   実際の収集（API呼び出し・点検）は lib/benchmark-youtube.js の仕事。
 */
async function collectYoutubeBenchmark(q) {
  const genre = String(q.genre || '');
  if (!benchmark.GENRES[genre]) {
    const e = new Error(`genre は ${Object.keys(benchmark.GENRES).join(' / ')} のどれか`);
    e.userError = true;
    throw e;
  }
  const account = await pickYoutubeAccount(q.group ? String(q.group) : null);
  if (!account) {
    const e = new Error('YouTube が繋がっていません。連携設定で繋いでください。');
    e.userError = true;
    throw e;
  }
  const result = await benchmarkYoutube.collect(genre, { account, db });
  // 失敗（ok:false）のときは保存するものが無い。そのまま理由を返す。
  if (!result || result.ok === false || !Array.isArray(result.items)) return result;
  // ★ 集めるだけでなく、そのままDBにためる（分析まで一気通貫にするため）。
  //   既存の項目は増やさず、returnの形はいままでどおり（画面が壊れないように）。
  const saved = await benchmarkStore.saveItems(db, result.items);
  return Object.assign({}, result, { saved: saved.saved });
}

// ---------------------------------------------------------------- のび（貼り込みでの取り込み）

/**
 * Claude in Chrome / YouTube 以外の記録を、貼り込みで取り込む。
 *
 * ★ 点検の規則は scripts/benchmark-intake.js（会話側での取り込み）とまったく同じにする。
 *   ここだけ別のルールで甘くしたり厳しくしたりしない。
 */
async function intakeBenchmark(req, q) {
  const text = bodyText(req.body);
  if (Buffer.byteLength(text, 'utf8') > MAX_INTAKE_BYTES) {
    const e = new Error('本文が大きすぎます（1MBまでにしてください）。');
    e.userError = true;
    throw e;
  }

  let plans;
  try {
    plans = benchmarkIntake.planIntake(text, { genre: q.genre ? String(q.genre) : undefined }, () => null);
  } catch (e) {
    const err = new Error('取り込めませんでした: ' + e.message);
    err.userError = true;
    throw err;
  }

  const acceptedItems = [];
  const rejected = [];
  for (const label of Object.keys(plans)) {
    const plan = plans[label];
    for (const a of plan.accepted) acceptedItems.push(a.item);
    for (const r of plan.rejected) rejected.push({ url: (r.item && r.item.url) || null, errors: r.errors });
  }

  const saved = await benchmarkStore.saveItems(db, acceptedItems);
  const byPlatform = {};
  for (const it of acceptedItems) byPlatform[it.platform] = (byPlatform[it.platform] || 0) + 1;
  const growing = acceptedItems.filter((it) => benchmark.isGrowing(it)).length;

  return {
    accepted: acceptedItems.length,
    rejected,
    summary: {
      accepted: acceptedItems.length, rejected: rejected.length, growing, byPlatform,
      saved: saved.saved,
    },
  };
}

/** req.body を、点検にかけられる文字列に戻す。 */
function bodyText(body) {
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (typeof body === 'string') return body;
  if (body === undefined || body === null) return '';
  // 画面は貼った文字を { text } で送る。中身の文字を取り出して、同じ規則で読む。
  if (typeof body.text === 'string' && !Array.isArray(body)) return body.text;
  return JSON.stringify(body);
}

/** いま何件たまっているか、直近の分析はどこまで進んだか。 */
async function benchmarkStatus(q) {
  const genre = String(q.genre || '');
  if (!benchmark.GENRES[genre]) {
    const e = new Error(`genre は ${Object.keys(benchmark.GENRES).join(' / ')} のどれか`);
    e.userError = true;
    throw e;
  }
  const [counts, latestRun] = await Promise.all([
    benchmarkStore.countItems(db, genre),
    benchmarkStore.latestRun(db, genre),
  ]);
  return { counts, latestRun };
}

/** 連携済みの YouTube アカウントを選ぶ。いま見ている運用アカウントのものを優先し、無ければ最初の1つ。 */
async function pickYoutubeAccount(groupId) {
  const all = await db.listAccounts();
  const candidates = all.filter((a) => a.network === 'youtube');
  if (!candidates.length) return null;
  const picked = (groupId && candidates.find((a) => a.group_id === groupId)) || candidates[0];
  // ★ listAccounts() はトークンを隠している。API を呼ぶには getAccount() で取り直す。
  return db.getAccount(picked.id);
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
