'use strict';
/**
 * 投稿が終わった動画・画像を、Supabase の置き場（バケット media）から消す。
 *
 * ★ なぜ要るのか
 *   これまで動画は投稿が済んでも置き場に残り続け、無料枠（1GB）を超えた
 *   （2026-10-07 に Supabase から「1.11GB、11/6 までに減らして」と通知）。
 *   毎日の動画は1本10〜15MB あるので、放っておくと毎月数百MBずつ増える。
 *
 * ★ 消してよい条件（全部そろったときだけ）
 *   1. 同じファイルを使っている投稿が全部、投稿先を1つ以上持っている（下書きは消さない）
 *   2. その投稿先が全部「済み」（success・skipped・handed）。
 *      queued・processing・failed・manual が1つでも残っていれば消さない
 *      （失敗の出し直し・手渡し前の動画の取り出しに要る）
 *   3. いちばん新しい投稿から GRACE_DAYS 日たっている
 *      （公開後に TikTok・YouTube の手作業で動画を取り出すことがあるため）
 *   ★ 同じ動画を複数の投稿で使い回すことがある（DAY1 の事故：1つ消したら共有の
 *     動画も消え、残りの予約が「動画が見つからない」で止まった）。だから
 *     ファイル単位で、それを使う全部の投稿を見てから決める。
 *
 * ★ 消したら posts.media_path を空にする。画面と出し直しが「無いファイル」を探しに行かないように。
 */

const GRACE_DAYS = 3;
const DONE = ['success', 'skipped', 'handed'];

/**
 * 消してよいファイルを選ぶ（DBを触らない、純粋な判断だけ）。
 * posts: [{ id, media_path, scheduled_at, created_at, targets: [{ status, posted_at }] }]
 */
function pickDeletable(posts, now = new Date()) {
  const byPath = new Map();
  for (const p of posts || []) {
    if (!p || !p.media_path) continue;
    if (!byPath.has(p.media_path)) byPath.set(p.media_path, []);
    byPath.get(p.media_path).push(p);
  }
  const limit = now.getTime() - GRACE_DAYS * 86400000;
  const out = [];
  for (const [path, users] of byPath) {
    let ok = true;
    let latest = 0;
    for (const p of users) {
      const ts = p.targets || [];
      if (!ts.length) { ok = false; break; }
      if (!ts.every((t) => DONE.includes(t.status))) { ok = false; break; }
      for (const t of ts) latest = Math.max(latest, time(t.posted_at));
      latest = Math.max(latest, time(p.scheduled_at), time(p.created_at));
    }
    if (ok && latest && latest < limit) out.push({ path, postIds: users.map((p) => p.id) });
  }
  return out;
}

const time = (s) => (s ? new Date(s).getTime() || 0 : 0);

/** 実行する。dry なら選ぶだけで消さない。 */
async function run(db, { dry = false, now = new Date() } = {}) {
  const posts = (await db.rest('posts', {
    query: {
      select: 'id,media_path,scheduled_at,created_at,post_targets(status,posted_at)',
      media_path: 'not.is.null',
      limit: '1000',
    },
  })) || [];
  const shaped = posts.map((p) => Object.assign({}, p, { targets: p.post_targets || [] }));
  const picks = pickDeletable(shaped, now);
  if (dry) return { dry: true, files: picks.map((x) => x.path), count: picks.length };

  const done = [];
  for (const x of picks) {
    await db.removeFile(x.path);
    await db.rest('posts', {
      method: 'PATCH',
      query: { id: `in.(${x.postIds.join(',')})` },
      body: { media_path: null },
      prefer: 'return=minimal',
    });
    done.push(x.path);
  }
  return { removed: done.length, files: done };
}

module.exports = { GRACE_DAYS, DONE, pickDeletable, run };
