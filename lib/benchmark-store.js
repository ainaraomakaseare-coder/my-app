'use strict';
/**
 * 分析部隊①収集で集めた記録（lib/benchmark.js の型）を DB にためる。
 *
 * ★ ここまでは会話にJSONを貼って手でコピーしていた（docs/research/README.md）。
 *   一気通貫にするため、点検（benchmark.checkAll）を通った記録をそのまま
 *   保存し、②分析・③企画のもと（research_runs）を積めるようにする。
 *
 * ★ 同じ投稿は上書き（何度取り込んでも増殖しない）。
 *   item_key は lib/benchmark.js の keyOf() と同じ規則。metrics-store.js の
 *   「1日1行」と同じ考え方で、genre + item_key を一意にしてある。
 */

const benchmark = require('./benchmark');
const { jstToday, shiftDays } = require('./metrics-store');

/**
 * 点検済みの記録（.ratio 付き）をまとめて保存する。
 * @param items benchmark.checkAll の accepted[].item（または同じ形の配列）
 */
async function saveItems(db, items) {
  const rows = (items || []).map((item) => ({
    genre: item.genre,
    platform: item.platform,
    item_key: benchmark.keyOf(item),
    url: item.url,
    record: item,
    ratio: numOrNull(item.ratio),
    collected_at: item.collected_at,
    updated_at: new Date().toISOString(),
  }));
  if (!rows.length) return { saved: 0 };

  const saved = await db.rest('benchmark_items', {
    method: 'POST',
    query: { on_conflict: 'genre,item_key' },
    body: rows,
    prefer: 'resolution=merge-duplicates,return=representation',
  });
  return { saved: Array.isArray(saved) ? saved.length : rows.length };
}

/** 数字でなければ null（undefined を送ると既定値で埋まるため。lib/metrics-store.js と同じ考え方）。 */
function numOrNull(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/**
 * 直近 days 日ぶんの記録。のび率（ratio）の高い順。
 * ★ 全部読み込むと、続けるほど重くなる（lib/metrics-store.js accountHistory と同じ理由）。
 */
async function listItems(db, genre, options) {
  const { days = 30, now = new Date() } = options || {};
  const since = shiftDays(jstToday(now), -days);
  const rows = (await db.rest('benchmark_items', {
    query: {
      select: 'record,ratio',
      genre: `eq.${genre}`,
      collected_at: `gte.${since}`,
      order: 'ratio.desc.nullslast',
    },
  })) || [];
  return rows.map((r) => Object.assign({}, r.record, { ratio: r.ratio }));
}

/** 集めた数の内訳。画面や分析の入口で「いま何件あるか」を見るのに使う。 */
async function countItems(db, genre, options) {
  const items = await listItems(db, genre, options);
  const byPlatform = {};
  let latestCollectedAt = null;
  for (const it of items) {
    byPlatform[it.platform] = (byPlatform[it.platform] || 0) + 1;
    if (it.collected_at && (!latestCollectedAt || it.collected_at > latestCollectedAt)) {
      latestCollectedAt = it.collected_at;
    }
  }
  return { total: items.length, byPlatform, latestCollectedAt };
}

// ---------------------------------------------------------------------------
// research_runs … 1回ぶんの「事実→分析→企画」
// ---------------------------------------------------------------------------

async function createRun(db, genre) {
  const created = await db.rest('research_runs', {
    method: 'POST',
    body: { genre, status: 'running' },
    prefer: 'return=representation',
  });
  return Array.isArray(created) ? created[0] : created;
}

async function updateRun(db, id, patch) {
  const updated = await db.rest('research_runs', {
    method: 'PATCH',
    query: { id: `eq.${id}` },
    body: Object.assign({}, patch, { updated_at: new Date().toISOString() }),
    prefer: 'return=representation',
  });
  return Array.isArray(updated) ? updated[0] : updated;
}

async function latestRun(db, genre) {
  const rows = (await db.rest('research_runs', {
    query: { select: '*', genre: `eq.${genre}`, order: 'created_at.desc', limit: '1' },
  })) || [];
  return rows[0] || null;
}

async function getRun(db, id) {
  const rows = (await db.rest('research_runs', { query: { select: '*', id: `eq.${id}` } })) || [];
  return rows[0] || null;
}

module.exports = { saveItems, listItems, countItems, createRun, updateRun, latestRun, getRun };
