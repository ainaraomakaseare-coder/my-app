'use strict';
/**
 * 分析用の数字を、毎週 Google ドライブへ書き出す（月曜の朝、Vercel の cron から）。
 *
 * ★ これまで
 *   月曜の朝に本人が「のび」の「自分の投稿を分析用にコピー」を運用アカウントごとに押し、
 *   Claude in Chrome で TikTok Studio の数字を写して、合わせて3回貼っていた。
 * ★ これから
 *   ① 投稿卓の数字 … 運用アカウントごとに own_<日付>_<名前>.json を投稿卓が置く（このファイル）
 *   ② TikTok Studio の数字 … 本人のPCのClaudeが写して送ってくる。tiktok_<日付>.json で置く
 *   分析の Claude はドライブの「投稿卓_分析データ」から読む。貼る作業は無くなる。
 *
 * ★ 中身の形は、画面の「分析用にコピー」（public/index.html の buildOwnSnapshot）と同じ。
 *   分析の道具（weekly_report.py）は両方を同じように読むので、形を変えないこと。
 */

const drive = require('./drive');

/** 日本時間の今日（YYYY-MM-DD）。 */
const jstToday = (now = new Date()) => now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

/**
 * 運用アカウント名 → ファイル名に使う短い名前。
 * 分析の決めごと（own_<日付>_AI紹介.json・own_<日付>_転職.json）に合わせる。
 * 知らない名前は、ファイル名に使えない文字だけ置き換えてそのまま使う（検証用の新しい束など）。
 */
function shortName(groupName) {
  const n = String(groupName || '');
  if (n.includes('転職')) return '転職';
  if (n.includes('AI初心者') || n.includes('30日30アプリ')) return 'AI紹介';
  return n.replace(/[\\/:*?"<>|｜\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'その他';
}

/** 画面の buildOwnSnapshot と同じ形にする。 */
function ownSnapshot(readOut, group, today) {
  const orNull = (v) => (v === undefined ? null : v);
  return {
    own: true,
    group: group ? group.name : null,
    collected_at: today,
    accounts: (readOut.accounts || []).map((a) => ({
      network: a.network, label: a.label || a.account_name || '',
      followers: a.latest ? orNull(a.latest.followers) : null,
    })),
    posts: (readOut.posts || []).map((p) => ({
      network: p.network, title: p.title, url: p.permalink || null, posted_at: p.postedAt || null,
      metrics: p.metrics ? { views: orNull(p.metrics.views), likes: orNull(p.metrics.likes), comments: orNull(p.metrics.comments) } : null,
    })),
    tiktok_videos: readOut.tiktokVideos || [],
  };
}

/**
 * ① 運用アカウントごとに書き出す。
 * read は api/insights.js の画面用の読み出し（運用アカウントの id を渡す）。
 * 連携が1つも無い運用アカウントは飛ばす（空のファイルは分析を迷わせる）。
 */
async function exportOwn({ db, read, now }) {
  const today = jstToday(now);
  const groups = await db.listGroups();
  const files = [];
  const used = new Set();
  for (const g of groups) {
    const out = await read(g.id);
    if (!out.accounts || !out.accounts.length) continue;
    let name = `own_${today}_${shortName(g.name)}.json`;
    // 名前が重なったら、上書きで片方が消えないように番号を付ける。
    for (let i = 2; used.has(name); i++) name = `own_${today}_${shortName(g.name)}_${i}.json`;
    used.add(name);
    files.push({ name, data: ownSnapshot(out, g, today) });
  }
  if (!files.length) return { files: [], note: '連携のある運用アカウントがありません' };
  return drive.writeFiles(db, files);
}

/**
 * ② TikTok Studio の数字を受け取って置く。
 * 形は analysis の chrome_tiktok_studio.txt のとおり（1動画1件の配列）。
 * ★ 数字は作らない。届いたものを点検して、そのまま置く。
 */
function checkStudioRows(rows) {
  if (!Array.isArray(rows)) throw userError('TikTok Studio の数字は配列で送ってください。');
  if (rows.length > 200) throw userError('TikTok Studio の数字が多すぎます（200件まで）。');
  const numOrNull = (v) => v === null || (typeof v === 'number' && isFinite(v));
  const NUMS = ['duration_sec', 'views', 'avg_watch_sec', 'completion_pct', 'drop_sec',
                'new_followers', 'fyp_pct', 'likes', 'comments', 'shares', 'saves'];
  rows.forEach((r, i) => {
    if (!r || typeof r !== 'object') throw userError(`${i + 1}件目が読めません。`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.posted_on || ''))) throw userError(`${i + 1}件目の posted_on が日付になっていません。`);
    for (const k of NUMS) {
      if (r[k] !== undefined && !numOrNull(r[k])) throw userError(`${i + 1}件目の ${k} が数字ではありません（見えない数字は null）。`);
    }
  });
  return rows;
}

async function exportStudio({ db, rows, now }) {
  const today = jstToday(now);
  checkStudioRows(rows);
  return drive.writeFiles(db, [{ name: `tiktok_${today}.json`, data: rows }]);
}

function userError(message) {
  const e = new Error(message);
  e.userError = true;
  return e;
}

module.exports = { jstToday, shortName, ownSnapshot, exportOwn, checkStudioRows, exportStudio };
