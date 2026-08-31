'use strict';
/**
 * 投稿の作成・一覧・更新・削除・再実行。
 *
 * ★ 時刻の扱いがこのファイルの肝。
 *   画面からは「2026-09-01T20:00」という日本時間の文字列が来る。
 *   これを +09:00 と明示して UTC に直してから保存する。
 *   ブラウザの時計やサーバーの地域に一切依存させない。
 */

const auth = require('../lib/auth');
const db = require('../lib/db');

const NETWORKS = ['instagram', 'youtube', 'x', 'tiktok'];

// 画面から来るのは「SNS名」ではなく「連携アカウントのid」。
// 同じSNSに企画用とアフィリエイト用を繋げるようにしたため。

// 各SNSの文字数上限
const LIMITS = { ig_caption: 2200, yt_title: 100, yt_description: 5000, x_text: 280, tt_caption: 2200 };

module.exports = async function handler(req, res) {
  if (!auth.guard(req, res)) return;

  try {
    const id = req.query && req.query.id;
    const action = req.query && req.query.action;

    if (req.method === 'GET')    return res.status(200).json(await list());
    if (req.method === 'POST' && action) return res.status(200).json(await act(id, action));
    if (req.method === 'POST')   return res.status(200).json(await save(req, null));
    if (req.method === 'PATCH')  return res.status(200).json(await save(req, id));
    if (req.method === 'DELETE') return res.status(200).json(await remove(id));
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    const status = err.status === 400 ? 400 : err.userError ? 400 : 500;
    return res.status(status).json({ error: err.message, hint: err.hint });
  }
};

// ---------------------------------------------------------------------------

async function list() {
  // 投稿と、SNSごとの状態と、履歴をまとめて1回で取る
  const [posts, accounts] = await Promise.all([
    db.rest('posts', {
      query: {
        select: '*,post_targets(*),post_events(at,network,event,detail)',
        order: 'created_at.desc',
        limit: 100,
      },
    }),
    db.listAccounts(),
  ]);
  return { posts: posts || [], accounts, now: new Date().toISOString() };
}

async function save(req, id) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

  // 実在する連携アカウントだけを投稿先として受け付ける
  const accounts = await db.listAccounts();
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const targets = (Array.isArray(body.targets) ? body.targets : []).filter((id) => byId.has(id));
  const scheduledAt = jstToUtc(body.scheduled_at_jst);
  const wantsSchedule = body.status === 'scheduled';

  if (wantsSchedule && !scheduledAt) {
    throw bad('「投稿予約」にするには予定日時が必要です。');
  }
  if (wantsSchedule && targets.length === 0) {
    throw bad('投稿先のアカウントを1つ以上選んでください。');
  }
  const needsMedia = targets.some((id) =>
    ['instagram', 'youtube', 'tiktok'].includes(byId.get(id).network));
  if (wantsSchedule && needsMedia && !body.media_path) {
    throw bad('Instagram・YouTube・TikTok には画像か動画が必要です。');
  }
  for (const [key, max] of Object.entries(LIMITS)) {
    if (body[key] && String(body[key]).length > max) {
      throw bad(`${labelOf(key)}が長すぎます（${String(body[key]).length}文字／上限${max}文字）。`);
    }
  }

  const row = {
    title: (body.title || '').slice(0, 200),
    body_common: body.body_common || '',
    ig_caption: body.ig_caption || '',
    yt_title: body.yt_title || '',
    yt_description: body.yt_description || '',
    x_text: body.x_text || '',
    tt_caption: body.tt_caption || '',
    media_path: body.media_path || null,
    media_kind: body.media_kind || null,
    media_bytes: body.media_bytes || null,
    scheduled_at: scheduledAt,
    status: wantsSchedule ? 'scheduled' : 'draft',
    updated_at: new Date().toISOString(),
  };

  let post;
  if (id) {
    post = await db.updateById('posts', id, row);
  } else {
    const created = await db.insert('posts', row);
    post = Array.isArray(created) ? created[0] : created;
  }

  await syncTargets(post.id, targets, byId);
  const names = targets.map((t) => nameOf(byId.get(t))).join(' / ');
  await db.logEvent(
    post.id, null, id ? 'updated' : 'created',
    wantsSchedule ? `${formatJst(scheduledAt)} に ${names} へ投稿予定` : '下書きとして保存'
  );

  return { post };
}

/**
 * 選んだ投稿先に合わせて post_targets の行を作る／消す。
 *
 * ★ すでに成功している行は絶対に触らない。
 *   触ると、再実行したときに同じSNSへ二重投稿してしまう。
 */
async function syncTargets(postId, targets, byId) {
  const existing = (await db.rest('post_targets', { query: { select: '*', post_id: `eq.${postId}` } })) || [];

  for (const accountId of targets) {
    if (!existing.some((t) => t.account_id === accountId)) {
      await db.insert('post_targets', {
        post_id: postId,
        account_id: accountId,
        network: byId.get(accountId).network,
        status: 'queued',
      });
    }
  }
  for (const row of existing) {
    if (!targets.includes(row.account_id) && row.status !== 'success') {
      await db.deleteById('post_targets', row.id);
    }
  }
}

/** 画面やログに出す、アカウントの呼び名。 */
function nameOf(a) {
  if (!a) return '不明なアカウント';
  const net = { instagram: 'Instagram', youtube: 'YouTube', x: 'X', tiktok: 'TikTok' }[a.network] || a.network;
  const who = a.label || a.account_name;
  return who ? `${net}（${who}）` : net;
}

async function act(id, action) {
  if (!id) throw bad('投稿が指定されていません。');

  if (action === 'retry') {
    // ★ 失敗した行だけを戻す。成功した行はそのまま。
    const rows = await db.rest('post_targets', {
      method: 'PATCH',
      query: { post_id: `eq.${id}`, status: 'eq.failed' },
      body: { status: 'queued', attempt: 0, next_attempt_at: new Date().toISOString(), last_error: null },
      prefer: 'return=representation',
    });
    const names = (rows || []).map((r) => r.network);
    await db.logEvent(id, null, 'retry', names.length ? `${names.join(' / ')} を再実行します` : '再実行する対象がありません');
    return { retried: names };
  }

  if (action === 'run-now') {
    await db.updateById('posts', id, { scheduled_at: new Date().toISOString(), status: 'scheduled' });
    await db.logEvent(id, null, 'run-now', '今すぐ投稿するよう予定を変更しました');
    return { ok: true };
  }

  throw bad('知らない操作です。');
}

async function remove(id) {
  if (!id) throw bad('投稿が指定されていません。');
  const posts = await db.rest('posts', { query: { select: 'media_path', id: `eq.${id}` } });
  await db.deleteById('posts', id);
  if (posts && posts[0] && posts[0].media_path) await db.removeFile(posts[0].media_path);
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// 時刻
// ---------------------------------------------------------------------------

/**
 * 「2026-09-01T20:00」(日本時間) を UTC の ISO 文字列に直す。
 * +09:00 を自分で書き足すのが要点。ブラウザやサーバーの地域設定に頼らない。
 */
function jstToUtc(input) {
  if (!input) return null;
  const m = String(input).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) throw bad('予定日時の形式が読み取れませんでした。');
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00`;
  const d = new Date(iso);
  if (isNaN(d.getTime())) throw bad('予定日時が正しくありません。');
  return d.toISOString();
}

function formatJst(isoUtc) {
  if (!isoUtc) return '';
  return new Date(isoUtc).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

function labelOf(key) {
  return {
    ig_caption: 'Instagram の本文', yt_title: 'YouTube のタイトル',
    yt_description: 'YouTube の説明文', x_text: 'X の本文', tt_caption: 'TikTok の本文',
  }[key] || key;
}

function bad(message) {
  const e = new Error(message);
  e.userError = true;
  return e;
}

module.exports.jstToUtc = jstToUtc;
