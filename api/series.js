'use strict';
/**
 * 企画（シリーズ）の数字と投稿案。
 *
 *   GET    /api/series?group=…&on=YYYY-MM-DD  … 企画の型・計算した数字・売上の記録
 *   POST   /api/series?action=log            … 売上を記録（1日1行。同じ日は上書き）
 *   DELETE /api/series?group=…&date=…        … 売上の記録を消す
 *   POST   /api/series?action=generate       … 投稿案（と動画台本）を作る
 *
 * 企画の型そのものの保存は /api/groups（運用アカウントの設定）で行う。
 */

const auth = require('../lib/auth');
const db = require('../lib/db');
const series = require('../lib/series');
const gen = require('../lib/series-generate');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = async function handler(req, res) {
  if (!auth.guard(req, res)) return;
  try {
    const q = req.query || {};
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

    if (req.method === 'GET') return res.status(200).json(await read(q.group, q.on));
    if (req.method === 'POST' && q.action === 'log') return res.status(200).json(await log(body));
    if (req.method === 'POST' && q.action === 'generate') return res.status(200).json(await generate(body));
    if (req.method === 'DELETE') return res.status(200).json(await unlog(q.group, q.date));
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    const status = err.userError ? 400 : 500;
    return res.status(status).json({ error: err.message, hint: err.hint });
  }
};

async function groupOf(id) {
  if (!id || !UUID.test(String(id))) throw series.bad('どの運用アカウントか指定されていません。');
  const g = (await db.listGroups()).find((x) => x.id === id);
  if (!g) throw series.bad('その運用アカウントは見つかりません。');
  return g;
}

const logsOf = async (groupId) => (await db.rest('series_logs', {
  query: { select: 'happened_on,amount_yen,note', group_id: `eq.${groupId}`, order: 'happened_on.desc', limit: 400 },
})) || [];

async function read(groupId, on) {
  const g = await groupOf(groupId);
  const s = g.series || null;
  const onDate = on && DATE.test(on) ? on : series.jstToday();
  const logs = s && s.goalYen ? await logsOf(g.id) : [];
  return { series: s, stats: s ? series.stats(s, logs, onDate) : null, logs: logs.slice(0, 60) };
}

async function log(body) {
  const g = await groupOf(body.group_id);
  if (!g.series || !g.series.goalYen) throw series.bad('この運用アカウントには目標金額が設定されていません。');
  const date = String(body.date || '');
  if (!DATE.test(date)) throw series.bad('日付は YYYY-MM-DD で入れてください。');
  const amount = Number(body.amount_yen);
  // ★ 売上の記録なので0円以上の整数だけ。マイナス（経費）は別の話なので混ぜない。
  if (!Number.isInteger(amount) || amount < 0) throw series.bad('売上は0円以上の整数で入れてください。');

  const rows = await db.rest('series_logs', {
    method: 'POST',
    query: { on_conflict: 'group_id,happened_on' },
    body: [{ group_id: g.id, happened_on: date, amount_yen: amount,
             note: String(body.note || '').slice(0, 300), updated_at: new Date().toISOString() }],
    prefer: 'resolution=merge-duplicates,return=representation',
  });
  return { saved: rows && rows[0], ...(await read(g.id, date)) };
}

async function unlog(groupId, date) {
  const g = await groupOf(groupId);
  if (!DATE.test(String(date || ''))) throw series.bad('日付が正しくありません。');
  await db.rest('series_logs', { method: 'DELETE', query: { group_id: `eq.${g.id}`, happened_on: `eq.${date}` } });
  return await read(g.id);
}

async function generate(body) {
  const g = await groupOf(body.group_id);
  if (!g.series) throw series.bad('この運用アカウントには企画の型がありません。', '運用アカウントの管理で「企画の型」を作ってください。');
  const onDate = body.on_date && DATE.test(body.on_date) ? body.on_date : series.jstToday();
  const inputs = {};
  for (const f of g.series.fields || []) inputs[f] = String((body.inputs || {})[f] || '').slice(0, 300);

  return await gen.generate({
    series: g.series,
    logs: g.series.goalYen ? await logsOf(g.id) : [],
    onDate,
    inputs,
    note: String(body.note || '').slice(0, 2000),
    hasAffiliateLink: !!body.has_affiliate_link,
  });
}
