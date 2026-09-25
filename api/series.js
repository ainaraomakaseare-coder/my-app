'use strict';
/**
 * 企画（シリーズ）の記録と投稿案。
 *
 *   GET    /api/series?group=…&on=YYYY-MM-DD  … 企画の型・計算した数字・その日の記録・最近の記録
 *   POST   /api/series?action=entry          … 1日分の記録を保存（同じ日は上書き）
 *   DELETE /api/series?group=…&date=…        … 1日分の記録を消す
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
    if (req.method === 'POST' && q.action === 'entry') return res.status(200).json(await save(body));
    if (req.method === 'POST' && q.action === 'generate') return res.status(200).json(await generate(body));
    if (req.method === 'DELETE') return res.status(200).json(await remove(q.group, q.date));
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
  if (!g.series) throw series.bad('この運用アカウントには企画の型がありません。', '運用アカウントの管理で「企画の型」を作ってください。');
  return g;
}

const entriesOf = async (groupId) => (await db.rest('series_entries', {
  query: { select: 'happened_on,entry', group_id: `eq.${groupId}`, order: 'happened_on.desc', limit: 400 },
})) || [];

const onOr = (d) => (d && DATE.test(d) ? d : series.jstToday());

async function read(groupId, on) {
  const g = await groupOf(groupId);
  const onDate = onOr(on);
  const entries = await entriesOf(g.id);
  const today = entries.find((r) => r.happened_on === onDate);
  return {
    series: g.series,
    stats: series.stats(g.series, entries, onDate),
    entry: today ? today.entry : null,
    // 一覧に出す分だけ。数字（その日の売上など）はここで足しておく
    recent: entries.slice(0, 30).map((r) => ({
      happened_on: r.happened_on,
      revenue: Object.values((r.entry && r.entry.income) || {}).reduce((a, b) => a + Number(b || 0), 0),
      expenses: ((r.entry && r.entry.expenses) || []).reduce((a, x) => a + Number(x.yen || 0), 0),
      tasks: ((r.entry && r.entry.tasks) || []).map((t) => t.name),
    })),
  };
}

async function save(body) {
  const g = await groupOf(body.group_id);
  const date = String(body.date || '');
  if (!DATE.test(date)) throw series.bad('日付は YYYY-MM-DD で入れてください。');
  const entry = series.normalizeEntry(body.entry, g.series);

  await db.rest('series_entries', {
    method: 'POST',
    query: { on_conflict: 'group_id,happened_on' },
    body: [{ group_id: g.id, happened_on: date, entry, updated_at: new Date().toISOString() }],
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
  return await read(g.id, date);
}

async function remove(groupId, date) {
  const g = await groupOf(groupId);
  if (!DATE.test(String(date || ''))) throw series.bad('日付が正しくありません。');
  await db.rest('series_entries', { method: 'DELETE', query: { group_id: `eq.${g.id}`, happened_on: `eq.${date}` } });
  return await read(g.id, date);
}

async function generate(body) {
  const g = await groupOf(body.group_id);
  const onDate = onOr(body.on_date);
  const inputs = {};
  for (const f of g.series.fields || []) inputs[f] = String((body.inputs || {})[f] || '').slice(0, 300);

  return await gen.generate({
    series: g.series,
    entries: await entriesOf(g.id),
    onDate,
    inputs,
    note: String(body.note || '').slice(0, 2000),
    hasAffiliateLink: !!body.has_affiliate_link,
  });
}
