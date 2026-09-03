'use strict';
/**
 * 集めた数字を書き留める。
 *
 * ★ 1日1行。同じ日に2回取り込んでも増えない。
 *   worker の「2回実行しても二度送らない」と同じ考え方で、
 *   取り込みは何度やり直しても壊れないようにする。
 *   途中で制限時間に切られたら、もう一度呼べばよい状態にしておきたい。
 *
 * ★ 取れなかったことも書く。
 *   ok=false の行を残す。空欄と「取りに行ったが断られた」は別物で、
 *   後者は権限を直せば取れる。区別できないと原因を追えない。
 *
 * ★ ok=true なのに error が入っていることがある。
 *   アカウントには辿り着けたが、フォロワー数だけ返ってこなかった、など。
 *   これを「失敗」に丸めると、他の数字まで捨てることになる。
 */

const JST = 'Asia/Tokyo';

/**
 * 日本時間の「今日」。
 *
 * ★ サーバーはUTCで動く。取り込みは毎晩なので、UTCの日付を使うと
 *   21時台〜翌9時のぶんが前日扱いになって、日付が1つずれる。
 */
function jstToday(now) {
  const d = now || new Date();
  const p = new Intl.DateTimeFormat('sv-SE', {
    timeZone: JST, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return p.format(d);   // sv-SE は YYYY-MM-DD で出る
}

/** upsert（同じ日なら上書き）。PostgREST は Prefer: resolution=merge-duplicates で行う。 */
async function upsert(db, table, row, onConflict) {
  return db.rest(table, {
    method: 'POST',
    query: { on_conflict: onConflict },
    body: [row],
    prefer: 'resolution=merge-duplicates,return=representation',
  });
}

/**
 * アカウントの数字を1件書く。
 * result は lib/insights.js の accountStats が返したもの。
 */
async function saveAccount(db, accountId, result, takenOn) {
  const m = (result && result.metrics) || {};
  return upsert(db, 'account_metrics', {
    account_id: accountId,
    taken_on: takenOn,
    taken_at: new Date().toISOString(),
    ok: result ? result.ok !== false : false,
    // ★ ok:true でも error は残す。「一部だけ取れなかった」を捨てないため。
    error: (result && result.error) || null,
    followers: pick(m.followers),
    views: pick(m.views),
    likes: pick(m.likes),
    posts: pick(m.posts),
  }, 'account_id,taken_on');
}

/**
 * 投稿ごとの数字をまとめて書く。
 * byTargetId は { '<post_targets.id>': {views, likes, comments, shares} }。
 */
async function saveTargets(db, byTargetId, takenOn) {
  const rows = Object.entries(byTargetId || {}).map(([id, m]) => ({
    post_target_id: id,
    taken_on: takenOn,
    taken_at: new Date().toISOString(),
    ok: true,
    views: pick(m.views),
    likes: pick(m.likes),
    comments: pick(m.comments),
    shares: pick(m.shares),
  }));
  if (!rows.length) return [];
  return db.rest('target_metrics', {
    method: 'POST',
    query: { on_conflict: 'post_target_id,taken_on' },
    body: rows,
    prefer: 'resolution=merge-duplicates,return=representation',
  });
}

/** TikTok の動画一覧。アプリの投稿とは結びつかないので、別の表に置く。 */
async function saveTiktokVideos(db, accountId, videos, takenOn) {
  const rows = (videos || []).map((v) => ({
    account_id: accountId,
    video_id: String(v.id),
    taken_on: takenOn,
    taken_at: new Date().toISOString(),
    title: v.title || null,
    posted_at: v.createdAt || null,
    views: pick(v.views),
    likes: pick(v.likes),
    comments: pick(v.comments),
    shares: pick(v.shares),
  }));
  if (!rows.length) return [];
  return db.rest('tiktok_videos', {
    method: 'POST',
    query: { on_conflict: 'account_id,video_id,taken_on' },
    body: rows,
    prefer: 'resolution=merge-duplicates,return=representation',
  });
}

/** 数字でなければ null。undefined を送ると列が消えるのではなく既定値で埋まるため。 */
function pick(v) {
  return typeof v === 'number' && isFinite(v) ? Math.round(v) : null;
}

// ---------------------------------------------------------------------------
// 読み出し
// ---------------------------------------------------------------------------

/**
 * 直近 days 日ぶんのアカウントの数字。
 * ★ 古いものまで全部引くと、続けるほど重くなる。画面が使うぶんだけ。
 */
async function accountHistory(db, accountIds, days) {
  if (!accountIds || !accountIds.length) return [];
  const since = shiftDays(jstToday(), -(days || 30));
  return (await db.rest('account_metrics', {
    query: {
      select: 'account_id,taken_on,ok,error,followers,views,likes,posts',
      account_id: `in.(${accountIds.join(',')})`,
      taken_on: `gte.${since}`,
      order: 'taken_on.asc',
    },
  })) || [];
}

/** 投稿ごとの、いちばん新しい数字だけ。 */
async function latestTargetMetrics(db, targetIds) {
  if (!targetIds || !targetIds.length) return {};
  const rows = (await db.rest('target_metrics', {
    query: {
      select: 'post_target_id,taken_on,views,likes,comments,shares',
      post_target_id: `in.(${targetIds.join(',')})`,
      order: 'taken_on.asc',
    },
  })) || [];
  // ★ 昇順で入れていくので、最後に入ったものが最新になる。
  const out = {};
  for (const r of rows) out[r.post_target_id] = r;
  return out;
}

/** TikTok の動画。いちばん新しい取り込み日のぶんだけ。 */
async function latestTiktokVideos(db, accountId) {
  const rows = (await db.rest('tiktok_videos', {
    query: {
      select: 'video_id,taken_on,title,posted_at,views,likes,comments,shares',
      account_id: `eq.${accountId}`,
      order: 'taken_on.desc',
      limit: 200,
    },
  })) || [];
  if (!rows.length) return [];
  const newest = rows[0].taken_on;
  return rows.filter((r) => r.taken_on === newest);
}

function shiftDays(ymd, delta) {
  const t = new Date(ymd + 'T00:00:00+09:00').getTime() + delta * 86400000;
  return jstToday(new Date(t));
}

module.exports = {
  jstToday, shiftDays,
  saveAccount, saveTargets, saveTiktokVideos,
  accountHistory, latestTargetMetrics, latestTiktokVideos,
};
