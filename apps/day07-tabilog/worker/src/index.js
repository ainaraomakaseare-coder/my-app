/*
 * 旅の足跡 API Worker。
 * 旅行（trip）と、その中の「大項目（block：いつ・どこで・何をする時間か）」
 * 「小項目（entry：そのときの一人ひとりの記録。別行動なら同じblockに複数ぶら下がる）」
 * をD1に、写真の実体はR2に保存する。
 * 旅行の閲覧・記録の追加はログイン不要。旅行のURL（trip id）を知っている人だけが
 * 読み書きできる「リンクを知っていれば入れる」方式（Googleドキュメントの共有リンクに近い）。
 * 家族・少人数グループでの利用を想定しており、不特定多数への公開は想定していない。
 * 「音声でまとめて記録する」機能だけ、唯一OpenAIを呼び出す（他の機能はAI不使用）。
 */

const CATEGORIES = ["sightseeing", "food", "lodging", "transport", "other"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const URL_RE = /^https?:\/\/\S+$/;

function isAllowedOrigin(origin, allowed) {
  if (origin === allowed) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "")) return true;
  // iOSアプリ（Capacitor）内のWebViewは、ページを https://... ではなく
  // capacitor://localhost から読み込んでいるため、そのOriginも許可する。
  if (origin === "capacitor://localhost") return true;
  // CapacitorHttpプラグイン経由（WebViewを介さずネイティブ側がHTTPリクエストを
  // 送る方式）だとOriginヘッダー自体が付かないため、それも許可する。
  if (!origin) return true;
  return false;
}

function cors(origin, allowed) {
  const ok = isAllowedOrigin(origin, allowed);
  return {
    "access-control-allow-origin": ok ? origin : allowed,
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, x-voice-meta",
    "vary": "Origin",
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function uid(prefix) {
  return prefix + "_" + crypto.randomUUID().replace(/-/g, "");
}

function nowIso() {
  return new Date().toISOString();
}

function isStr(x, max) {
  return typeof x === "string" && x.length <= max;
}

function optStr(x, max) {
  return x === undefined || x === null || isStr(x, max);
}

function optUrl(x, max) {
  return x === undefined || x === null || x === "" || (isStr(x, max) && URL_RE.test(x));
}

// paidBy（実際に払った人。省略時はEntryのauthorとみなす）・splitAmong（割り勘の対象者。
// 省略時はpaidBy本人だけとみなし＝割り勘なしの個人費用という、これまでどおりの意味になる）は
// どちらも任意項目。既存データ（この2つを持たない古いcostItems）との後方互換のため。
function validCostItems(x) {
  if (x === undefined) return true;
  if (!Array.isArray(x) || x.length > 30) return false;
  return x.every((it) =>
    it && typeof it === "object"
    && isStr(it.label, 60)
    && Number.isInteger(it.amount) && it.amount >= 0 && it.amount <= 1000000
    && optStr(it.paidBy, 50)
    && (it.splitAmong === undefined || (Array.isArray(it.splitAmong) && it.splitAmong.length <= 20 && it.splitAmong.every((n) => typeof n === "string" && n.length <= 50)))
  );
}

/* ---------- trips ---------- */

function validTripInput(x) {
  if (!x || typeof x !== "object") return false;
  if (!isStr(x.title, 200) || x.title.trim().length < 1) return false;
  if (x.startDate !== undefined && x.startDate !== "" && !DATE_RE.test(x.startDate)) return false;
  if (x.endDate !== undefined && x.endDate !== "" && !DATE_RE.test(x.endDate)) return false;
  if (x.companions !== undefined) {
    if (!Array.isArray(x.companions) || x.companions.length > 20) return false;
    if (!x.companions.every((c) => typeof c === "string" && c.length <= 50)) return false;
  }
  if (!optStr(x.coverPhotoId, 300)) return false;
  if (!optStr(x.tripType, 50)) return false;
  return true;
}

function rowToTrip(row) {
  return {
    id: row.id,
    title: row.title,
    startDate: row.start_date,
    endDate: row.end_date,
    companions: JSON.parse(row.companions || "[]"),
    tripType: row.trip_type || "",
    coverPhotoId: row.cover_photo_id || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createTrip(request, env, headers) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  if (!validTripInput(data)) return json({ error: "invalid_input" }, 400, headers);
  const t = nowIso();
  const trip = {
    id: uid("trip"),
    title: data.title.trim(),
    start_date: data.startDate || "",
    end_date: data.endDate || "",
    companions: JSON.stringify(data.companions || []),
    cover_photo_id: data.coverPhotoId || "",
    trip_type: data.tripType || "",
    created_at: t,
    updated_at: t,
  };
  await env.DB.prepare(
    "INSERT INTO trips (id, title, start_date, end_date, companions, cover_photo_id, trip_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(trip.id, trip.title, trip.start_date, trip.end_date, trip.companions, trip.cover_photo_id, trip.trip_type, trip.created_at, trip.updated_at)
    .run();
  return json(rowToTrip(trip), 201, headers);
}

// D1（SQLite）は1クエリでまとめて使えるバインドパラメータの数に上限があり（実測で100前後）、
// WHERE x IN (...) に一度に大量のIDを入れると「D1_ERROR: too many SQL variables」で
// 落ちる。「複数日をまとめて記録する」（DAY30〜）で一度に何十件ものBlock/Entryが作られると
// 実際にこれで旅行の読み込みが失敗する事故が起きたため、IDが多いときは上限より少ない
// チャンクに分けて複数回クエリし、結果をまとめて返すようにする。sqlBeforeIn/sqlAfterInの
// 間にIN句のプレースホルダーが入る（バインドはID以外に無い呼び出し専用、他の条件は
// リテラルで書く）。
const D1_MAX_IN_PARAMS = 90;

async function selectWhereIn(env, sqlBeforeIn, ids, sqlAfterIn) {
  const all = [];
  for (let i = 0; i < ids.length; i += D1_MAX_IN_PARAMS) {
    const chunk = ids.slice(i, i + D1_MAX_IN_PARAMS);
    const { results } = await env.DB.prepare(sqlBeforeIn + chunk.map(() => "?").join(",") + sqlAfterIn)
      .bind(...chunk)
      .all();
    all.push(...results);
  }
  return all;
}

async function getTrip(id, env, headers) {
  const tripRow = await env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(id).first();
  if (!tripRow) return json({ error: "not_found" }, 404, headers);
  const { results: blockRows } = await env.DB.prepare(
    "SELECT * FROM blocks WHERE trip_id = ? ORDER BY date ASC, time ASC, created_at ASC"
  )
    .bind(id)
    .all();
  const entryRows = blockRows.length
    ? await selectWhereIn(env, "SELECT * FROM entries WHERE block_id IN (", blockRows.map((b) => b.id), ") ORDER BY created_at ASC")
    : [];
  const entryIds = entryRows.map((r) => r.id);
  const ratingsByEntry = {};
  if (entryIds.length) {
    const ratingRows = await selectWhereIn(env, "SELECT * FROM ratings WHERE entry_id IN (", entryIds, ")");
    ratingRows.forEach((row) => {
      (ratingsByEntry[row.entry_id] = ratingsByEntry[row.entry_id] || []).push(rowToRating(row));
    });
  }
  const entriesByBlock = {};
  entryRows.forEach((row) => {
    const entry = rowToEntry(row);
    entry.ratings = ratingsByEntry[row.id] || [];
    (entriesByBlock[row.block_id] = entriesByBlock[row.block_id] || []).push(entry);
  });
  const blocks = blockRows.map((row) => ({ ...rowToBlock(row), entries: entriesByBlock[row.id] || [] }));
  const { results: dayRows } = await env.DB.prepare("SELECT * FROM day_infos WHERE trip_id = ?").bind(id).all();
  const days = dayRows.map(rowToDayInfo);
  const { results: memberRows } = await env.DB.prepare("SELECT * FROM trip_members WHERE trip_id = ?").bind(id).all();
  const members = memberRows.map(rowToMember);
  return json({ trip: rowToTrip(tripRow), blocks, days, members }, 200, headers);
}

async function updateTrip(id, request, env, headers) {
  const existing = await env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(id).first();
  if (!existing) return json({ error: "not_found" }, 404, headers);
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  if (!validTripInput({ ...rowToTrip(existing), ...data, title: data.title ?? existing.title })) {
    return json({ error: "invalid_input" }, 400, headers);
  }
  const next = {
    title: data.title !== undefined ? String(data.title).trim() : existing.title,
    start_date: data.startDate !== undefined ? data.startDate : existing.start_date,
    end_date: data.endDate !== undefined ? data.endDate : existing.end_date,
    companions: data.companions !== undefined ? JSON.stringify(data.companions) : existing.companions,
    cover_photo_id: data.coverPhotoId !== undefined ? String(data.coverPhotoId) : existing.cover_photo_id,
    trip_type: data.tripType !== undefined ? String(data.tripType) : existing.trip_type,
    updated_at: nowIso(),
  };
  await env.DB.prepare(
    "UPDATE trips SET title=?, start_date=?, end_date=?, companions=?, cover_photo_id=?, trip_type=?, updated_at=? WHERE id=?"
  )
    .bind(next.title, next.start_date, next.end_date, next.companions, next.cover_photo_id, next.trip_type, next.updated_at, id)
    .run();
  const updated = await env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(id).first();
  return json(rowToTrip(updated), 200, headers);
}

async function deleteTrip(id, env, headers) {
  const { results: blockRows } = await env.DB.prepare("SELECT id FROM blocks WHERE trip_id = ?").bind(id).all();
  for (const b of blockRows) {
    const { results: entryRows } = await env.DB.prepare("SELECT id FROM entries WHERE block_id = ?").bind(b.id).all();
    for (const e of entryRows) {
      await env.DB.prepare("DELETE FROM ratings WHERE entry_id = ?").bind(e.id).run();
    }
    await env.DB.prepare("DELETE FROM entries WHERE block_id = ?").bind(b.id).run();
  }
  await env.DB.prepare("DELETE FROM blocks WHERE trip_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM day_infos WHERE trip_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM trip_members WHERE trip_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM trips WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, headers);
}

/* ---------- blocks（大項目） ---------- */

function validBlockInput(x) {
  if (!x || typeof x !== "object") return false;
  if (x.date !== undefined && x.date !== "" && !DATE_RE.test(x.date)) return false;
  if (x.time !== undefined && x.time !== "" && !TIME_RE.test(x.time)) return false;
  if (!optStr(x.label, 200)) return false;
  if (x.category !== undefined && !CATEGORIES.includes(x.category)) return false;
  return true;
}

function rowToBlock(row) {
  return {
    id: row.id,
    tripId: row.trip_id,
    date: row.date,
    time: row.time,
    label: row.label,
    category: row.category,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createBlock(tripId, request, env, headers) {
  const trip = await env.DB.prepare("SELECT id FROM trips WHERE id = ?").bind(tripId).first();
  if (!trip) return json({ error: "trip_not_found" }, 404, headers);
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  if (!validBlockInput(data)) return json({ error: "invalid_input" }, 400, headers);
  const t = nowIso();
  const row = {
    id: uid("blk"),
    trip_id: tripId,
    date: data.date || "",
    time: data.time || "",
    label: (data.label || "").trim(),
    category: data.category || "sightseeing",
    created_at: t,
    updated_at: t,
  };
  await env.DB.prepare(
    "INSERT INTO blocks (id, trip_id, date, time, label, category, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
  )
    .bind(row.id, row.trip_id, row.date, row.time, row.label, row.category, row.created_at, row.updated_at)
    .run();
  await env.DB.prepare("UPDATE trips SET updated_at = ? WHERE id = ?").bind(t, tripId).run();
  return json({ ...rowToBlock(row), entries: [] }, 201, headers);
}

async function updateBlock(id, request, env, headers) {
  const existing = await env.DB.prepare("SELECT * FROM blocks WHERE id = ?").bind(id).first();
  if (!existing) return json({ error: "not_found" }, 404, headers);
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  if (!validBlockInput(data)) return json({ error: "invalid_input" }, 400, headers);
  const cur = rowToBlock(existing);
  const merged = { ...cur, ...data };
  const t = nowIso();
  await env.DB.prepare(
    "UPDATE blocks SET date=?, time=?, label=?, category=?, updated_at=? WHERE id=?"
  )
    .bind(merged.date || "", merged.time || "", (merged.label || "").trim(), merged.category || "sightseeing", t, id)
    .run();
  const updated = await env.DB.prepare("SELECT * FROM blocks WHERE id = ?").bind(id).first();
  return json(rowToBlock(updated), 200, headers);
}

async function deleteBlock(id, env, headers) {
  const { results: entryRows } = await env.DB.prepare("SELECT id FROM entries WHERE block_id = ?").bind(id).all();
  for (const e of entryRows) {
    await env.DB.prepare("DELETE FROM ratings WHERE entry_id = ?").bind(e.id).run();
  }
  await env.DB.prepare("DELETE FROM entries WHERE block_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM blocks WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, headers);
}

// 時刻未設定のBlockは、ドラッグ操作で並び順を自由に入れ替えられる（時刻が入っているBlockは
// 常にその時刻の位置で固定なので対象外。フロント側でも時刻ありBlockには持ち手を出していない）。
// 並び順そのものはcreated_atで表現しており（sortBlocksが時刻未設定同士はcreated_at順に
// 並べるため）、ドラッグ後の見た目どおりの順番になるよう、その日のBlock全部のcreated_atを
// 新しい順番で振り直す。
async function reorderBlocks(tripId, date, request, env, headers) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  if (!data || !Array.isArray(data.blockIds) || !data.blockIds.length || data.blockIds.length > 200) {
    return json({ error: "invalid_input" }, 400, headers);
  }
  if (!data.blockIds.every((id) => isStr(id, 100))) return json({ error: "invalid_input" }, 400, headers);

  const { results: rows } = await env.DB.prepare("SELECT id FROM blocks WHERE trip_id = ? AND date = ?")
    .bind(tripId, date)
    .all();
  const validIds = new Set(rows.map((r) => r.id));
  const baseTime = Date.now();
  let i = 0;
  for (const blockId of data.blockIds) {
    if (!validIds.has(blockId)) continue;
    const t = new Date(baseTime + i * 10).toISOString();
    await env.DB.prepare("UPDATE blocks SET created_at=?, updated_at=? WHERE id=?").bind(t, t, blockId).run();
    i++;
  }
  await env.DB.prepare("UPDATE trips SET updated_at = ? WHERE id = ?").bind(nowIso(), tripId).run();
  return json({ ok: true }, 200, headers);
}

/* ---------- entries（小項目） ---------- */

function validEntryInput(x) {
  if (!x || typeof x !== "object") return false;
  if (!optStr(x.episode, 4000)) return false;
  if (!optStr(x.comment, 300)) return false;
  if (!optStr(x.detail, 4000)) return false;
  if (!validCostItems(x.costItems)) return false;
  if (!optStr(x.waitTime, 50)) return false;
  if (x.time !== undefined && x.time !== "" && !TIME_RE.test(x.time)) return false;
  if (!optUrl(x.mapUrl, 500)) return false;
  if (!optUrl(x.shopUrl, 500)) return false;
  if (!optUrl(x.otherUrl, 500)) return false;
  if (!optStr(x.author, 50)) return false;
  if (x.photoIds !== undefined) {
    if (!Array.isArray(x.photoIds) || x.photoIds.length > 20) return false;
    if (!x.photoIds.every((p) => typeof p === "string" && p.length <= 80)) return false;
  }
  if (x.videoIds !== undefined) {
    if (!Array.isArray(x.videoIds) || x.videoIds.length > 10) return false;
    if (!x.videoIds.every((p) => typeof p === "string" && p.length <= 80)) return false;
  }
  return true;
}

function rowToEntry(row) {
  return {
    id: row.id,
    blockId: row.block_id,
    episode: row.episode,
    comment: row.comment,
    detail: row.detail,
    photoIds: JSON.parse(row.photo_ids || "[]"),
    videoIds: JSON.parse(row.video_ids || "[]"),
    costItems: JSON.parse(row.cost_items || "[]"),
    waitTime: row.wait_time,
    time: row.time,
    mapUrl: row.map_url,
    shopUrl: row.shop_url,
    otherUrl: row.other_url,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createEntry(blockId, request, env, headers) {
  const block = await env.DB.prepare("SELECT id FROM blocks WHERE id = ?").bind(blockId).first();
  if (!block) return json({ error: "block_not_found" }, 404, headers);
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  if (!validEntryInput(data)) return json({ error: "invalid_input" }, 400, headers);
  const t = nowIso();
  const row = {
    id: uid("ent"),
    block_id: blockId,
    episode: (data.episode || "").trim(),
    comment: (data.comment || "").trim(),
    detail: (data.detail || "").trim(),
    photo_ids: JSON.stringify(data.photoIds || []),
    video_ids: JSON.stringify(data.videoIds || []),
    cost_items: JSON.stringify(data.costItems || []),
    wait_time: (data.waitTime || "").trim(),
    time: data.time || "",
    map_url: data.mapUrl || "",
    shop_url: data.shopUrl || "",
    other_url: data.otherUrl || "",
    author: (data.author || "").trim(),
    created_at: t,
    updated_at: t,
  };
  await env.DB.prepare(
    `INSERT INTO entries (id, block_id, episode, comment, detail, photo_ids, video_ids, cost_items, wait_time, time, map_url, shop_url, other_url, author, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      row.id, row.block_id, row.episode, row.comment, row.detail, row.photo_ids, row.video_ids,
      row.cost_items, row.wait_time, row.time, row.map_url, row.shop_url, row.other_url, row.author, row.created_at, row.updated_at
    )
    .run();
  return json(rowToEntry(row), 201, headers);
}

async function updateEntry(id, request, env, headers) {
  const existing = await env.DB.prepare("SELECT * FROM entries WHERE id = ?").bind(id).first();
  if (!existing) return json({ error: "not_found" }, 404, headers);
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  if (!validEntryInput(data)) return json({ error: "invalid_input" }, 400, headers);
  const cur = rowToEntry(existing);
  const merged = { ...cur, ...data };
  const t = nowIso();
  await env.DB.prepare(
    `UPDATE entries SET episode=?, comment=?, detail=?, photo_ids=?, video_ids=?, cost_items=?, wait_time=?, time=?, map_url=?, shop_url=?, other_url=?, author=?, updated_at=? WHERE id=?`
  )
    .bind(
      (merged.episode || "").trim(), (merged.comment || "").trim(), (merged.detail || "").trim(),
      JSON.stringify(merged.photoIds || []), JSON.stringify(merged.videoIds || []),
      JSON.stringify(merged.costItems || []), (merged.waitTime || "").trim(), merged.time || "",
      merged.mapUrl || "", merged.shopUrl || "", merged.otherUrl || "", (merged.author || "").trim(), t, id
    )
    .run();
  const updated = await env.DB.prepare("SELECT * FROM entries WHERE id = ?").bind(id).first();
  return json(rowToEntry(updated), 200, headers);
}

async function deleteEntry(id, env, headers) {
  await env.DB.prepare("DELETE FROM ratings WHERE entry_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM entries WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, headers);
}

// 記録(entry)を、別の予定(block)にぶら下げ直す（音声入力で「予定」になってしまったものを
// 別の予定の「記録」として移す用途）。移動先は同じ日の予定に限る（サーバー側でも検証する）。
async function moveEntry(id, request, env, headers) {
  const entry = await env.DB.prepare("SELECT * FROM entries WHERE id = ?").bind(id).first();
  if (!entry) return json({ error: "not_found" }, 404, headers);
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  if (!isStr(data.blockId, 100)) return json({ error: "invalid_input" }, 400, headers);

  const currentBlock = await env.DB.prepare("SELECT trip_id, date FROM blocks WHERE id = ?").bind(entry.block_id).first();
  const targetBlock = await env.DB.prepare("SELECT id, trip_id, date FROM blocks WHERE id = ?").bind(data.blockId).first();
  if (!currentBlock || !targetBlock) return json({ error: "block_not_found" }, 404, headers);
  if (targetBlock.trip_id !== currentBlock.trip_id || targetBlock.date !== currentBlock.date) {
    return json({ error: "different_day" }, 400, headers);
  }

  const t = nowIso();
  await env.DB.prepare("UPDATE entries SET block_id=?, updated_at=? WHERE id=?").bind(data.blockId, t, id).run();
  const updated = await env.DB.prepare("SELECT * FROM entries WHERE id = ?").bind(id).first();
  return json(rowToEntry(updated), 200, headers);
}

/* ---------- ratings（評価） ----------
 * ログイン必須の機能。rater_email はクライアントが送ってきた値をそのまま信用する
 * （サーバー側でトークン検証はしない、このアプリ全体と同じ簡易的な仕組み）。
 * 1つのentryに、raterEmailごとに1件だけ評価を持てる（UNIQUE制約でupsert）。
 */

function validRatingInput(x) {
  if (!x || typeof x !== "object") return false;
  if (!isStr(x.raterEmail, 200) || x.raterEmail.trim().length < 3) return false;
  if (!optStr(x.raterName, 100)) return false;
  // 基本は★1〜5の整数だが、0.1刻みの細かい評価も許可する（例: 3.7）
  if (typeof x.score !== "number" || !isFinite(x.score)) return false;
  if (x.score < 1 || x.score > 5) return false;
  return true;
}

// 0.1刻みに丸める（浮動小数点の誤差でDBの値がバラつかないように）
function roundScore(score) {
  return Math.round(score * 10) / 10;
}

function rowToRating(row) {
  return {
    id: row.id,
    entryId: row.entry_id,
    raterEmail: row.rater_email,
    raterName: row.rater_name,
    score: row.score,
    updatedAt: row.updated_at,
  };
}

async function setRating(entryId, request, env, headers) {
  const entry = await env.DB.prepare("SELECT id FROM entries WHERE id = ?").bind(entryId).first();
  if (!entry) return json({ error: "entry_not_found" }, 404, headers);
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  if (!validRatingInput(data)) return json({ error: "invalid_input" }, 400, headers);
  const email = data.raterEmail.trim().toLowerCase();
  const name = (data.raterName || "").trim();
  const existing = await env.DB.prepare("SELECT id FROM ratings WHERE entry_id = ? AND rater_email = ?")
    .bind(entryId, email)
    .first();
  const score = roundScore(data.score);
  const t = nowIso();
  if (existing) {
    await env.DB.prepare("UPDATE ratings SET score=?, rater_name=?, updated_at=? WHERE id=?")
      .bind(score, name, t, existing.id)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO ratings (id, entry_id, rater_email, rater_name, score, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
    )
      .bind(uid("rat"), entryId, email, name, score, t, t)
      .run();
  }
  const { results } = await env.DB.prepare("SELECT * FROM ratings WHERE entry_id = ?").bind(entryId).all();
  return json({ ratings: results.map(rowToRating) }, 200, headers);
}

async function deleteRating(entryId, request, env, headers) {
  let data;
  try {
    data = await request.json();
  } catch {
    data = {};
  }
  const email = (data.raterEmail || "").trim().toLowerCase();
  if (!email) return json({ error: "invalid_input" }, 400, headers);
  await env.DB.prepare("DELETE FROM ratings WHERE entry_id = ? AND rater_email = ?").bind(entryId, email).run();
  const { results } = await env.DB.prepare("SELECT * FROM ratings WHERE entry_id = ?").bind(entryId).all();
  return json({ ratings: results.map(rowToRating) }, 200, headers);
}

/* ---------- マイログ：ログイン中の本人が付けた評価を、旅行をまたいで一覧する ---------- */

async function getMyLog(email, env, headers) {
  if (!email) return json({ error: "invalid_input" }, 400, headers);
  const { results } = await env.DB.prepare(
    `SELECT r.score AS score, r.updated_at AS rated_at,
            e.id AS entry_id, e.episode AS episode, e.photo_ids AS photo_ids,
            b.id AS block_id, b.date AS date, b.label AS label, b.category AS category,
            t.id AS trip_id, t.title AS trip_title
     FROM ratings r
     JOIN entries e ON e.id = r.entry_id
     JOIN blocks b ON b.id = e.block_id
     JOIN trips t ON t.id = b.trip_id
     WHERE r.rater_email = ?
     ORDER BY r.updated_at DESC`
  )
    .bind(email)
    .all();
  const items = results.map((row) => {
    let photoId = "";
    try {
      photoId = (JSON.parse(row.photo_ids || "[]"))[0] || "";
    } catch {
      photoId = "";
    }
    return {
      entryId: row.entry_id,
      blockId: row.block_id,
      tripId: row.trip_id,
      tripTitle: row.trip_title,
      category: row.category,
      label: row.label,
      date: row.date,
      episode: row.episode,
      photoId,
      score: row.score,
      ratedAt: row.rated_at,
    };
  });

  const account = await env.DB.prepare("SELECT account_id FROM accounts WHERE email = ?").bind(email).first();
  let trips = [];
  let places = { prefectures: [], countries: [] };
  if (account) {
    const { results: tripRows } = await env.DB.prepare(
      `SELECT t.* FROM trip_members m JOIN trips t ON t.id = m.trip_id
       WHERE m.account_id = ? ORDER BY t.start_date DESC, t.created_at DESC`
    )
      .bind(account.account_id)
      .all();
    trips = tripRows.map(rowToTrip);
    places = await getVisitedPlaces(env, trips.map((t) => t.id));
  }

  return json({ items, trips, places }, 200, headers);
}

// 参加した旅行（trips）にまたがる「日ごとの場所」（day_infos.admin1/country、天気取得のついでに
// 保存したもの）から、訪れた都道府県・国を重複なく集計する。都道府県は country が「日本」の
// 行だけを対象にする（海外のadmin1＝州などを都道府県として混ぜないため）。
async function getVisitedPlaces(env, tripIds) {
  if (!tripIds.length) return { prefectures: [], countries: [] };
  const results = await selectWhereIn(
    env, "SELECT DISTINCT admin1, country FROM day_infos WHERE trip_id IN (", tripIds, ") AND (admin1 != '' OR country != '')"
  );
  const prefectures = new Set();
  const countries = new Set();
  results.forEach((row) => {
    if (row.country === "日本" && row.admin1) prefectures.add(row.admin1);
    else if (row.country && row.country !== "日本") countries.add(row.country);
  });
  return {
    prefectures: Array.from(prefectures).sort(),
    countries: Array.from(countries).sort(),
  };
}

/* ---------- 日ごとの天気（day_infos） ----------
 * 大項目（block）は1日に複数あるため、天気は「旅行×日付」の単位で持つ。
 * 地名→緯度経度はOpen-Meteoのジオコーディング、天気・気温もOpen-Meteo
 * （どちらも無料・APIキー不要）から取得する。日付が今日より前なら実況
 * （archive-api）、今日以降なら予報（forecast api）を使う。
 */

function rowToDayInfo(row) {
  return {
    date: row.date,
    place: row.place,
    lat: row.lat,
    lon: row.lon,
    admin1: row.admin1 || "",
    country: row.country || "",
    weatherCode: row.weather_code,
    tempMax: row.temp_max,
    tempMin: row.temp_min,
    precipSum: row.precip_sum,
    isForecast: !!row.is_forecast,
    fetchedAt: row.fetched_at,
    voiceTranscript: row.voice_transcript || "",
    weatherManual: !!row.weather_manual,
  };
}

// 手動で選べる天気の種類。weatherLabel()の表示区分（快晴／晴れ／曇り／霧／霧雨／雨／雪／
// にわか雨／にわか雪／雷雨）それぞれの代表的なWMOコードだけを許可する。
const MANUAL_WEATHER_CODES = [0, 1, 3, 45, 51, 61, 71, 80, 85, 95];

async function geocodePlace(place) {
  const url = "https://geocoding-api.open-meteo.com/v1/search?count=1&language=ja&format=json&name=" + encodeURIComponent(place);
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const first = data && data.results && data.results[0];
  if (!first) return null;
  // admin1（都道府県・州など）・country（国）は、天気取得と同じこのジオコーディング結果から
  // ついでに取れる。「訪れた都道府県・国」の集計（v13）専用に別の入力・別のAPI呼び出しは要らない。
  return { lat: first.latitude, lon: first.longitude, admin1: first.admin1 || "", country: first.country || "" };
}

async function fetchDailyWeather(lat, lon, date) {
  const isPast = date < nowIso().slice(0, 10);
  const base = isPast ? "https://archive-api.open-meteo.com/v1/archive" : "https://api.open-meteo.com/v1/forecast";
  const url = base
    + "?latitude=" + encodeURIComponent(lat)
    + "&longitude=" + encodeURIComponent(lon)
    + "&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum"
    + "&timezone=auto&start_date=" + date + "&end_date=" + date;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const daily = data && data.daily;
  if (!daily || !daily.time || daily.time.indexOf(date) === -1) return null;
  const idx = daily.time.indexOf(date);
  return {
    weatherCode: daily.weathercode ? daily.weathercode[idx] : null,
    tempMax: daily.temperature_2m_max ? daily.temperature_2m_max[idx] : null,
    tempMin: daily.temperature_2m_min ? daily.temperature_2m_min[idx] : null,
    precipSum: daily.precipitation_sum ? daily.precipitation_sum[idx] : null,
    isForecast: !isPast,
  };
}

async function setDayPlace(tripId, date, request, env, headers) {
  if (!DATE_RE.test(date)) return json({ error: "invalid_date" }, 400, headers);
  const trip = await env.DB.prepare("SELECT id FROM trips WHERE id = ?").bind(tripId).first();
  if (!trip) return json({ error: "trip_not_found" }, 404, headers);
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  if (!isStr(data.place, 100) || !data.place.trim()) return json({ error: "invalid_input" }, 400, headers);
  const place = data.place.trim();

  const geo = await geocodePlace(place);
  if (!geo) return json({ error: "place_not_found" }, 422, headers);
  const weather = await fetchDailyWeather(geo.lat, geo.lon, date);

  const t = nowIso();
  const id = tripId + "_" + date;
  const existing = await env.DB.prepare("SELECT id FROM day_infos WHERE id = ?").bind(id).first();
  const row = {
    place,
    lat: geo.lat,
    lon: geo.lon,
    admin1: geo.admin1,
    country: geo.country,
    weather_code: weather ? weather.weatherCode : null,
    temp_max: weather ? weather.tempMax : null,
    temp_min: weather ? weather.tempMin : null,
    precip_sum: weather ? weather.precipSum : null,
    is_forecast: weather && weather.isForecast ? 1 : 0,
    fetched_at: weather ? t : "",
  };
  if (existing) {
    // 場所を入力し直すのは「自動取得をやり直したい」という意思表示なので、
    // 手動修正フラグ（weather_manual）はここでリセットする。
    await env.DB.prepare(
      "UPDATE day_infos SET place=?, lat=?, lon=?, admin1=?, country=?, weather_code=?, temp_max=?, temp_min=?, precip_sum=?, is_forecast=?, fetched_at=?, weather_manual=0, updated_at=? WHERE id=?"
    )
      .bind(row.place, row.lat, row.lon, row.admin1, row.country, row.weather_code, row.temp_max, row.temp_min, row.precip_sum, row.is_forecast, row.fetched_at, t, id)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO day_infos (id, trip_id, date, place, lat, lon, admin1, country, weather_code, temp_max, temp_min, precip_sum, is_forecast, fetched_at, weather_manual, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)"
    )
      .bind(id, tripId, date, row.place, row.lat, row.lon, row.admin1, row.country, row.weather_code, row.temp_max, row.temp_min, row.precip_sum, row.is_forecast, row.fetched_at, t, t)
      .run();
  }
  const updated = await env.DB.prepare("SELECT * FROM day_infos WHERE id = ?").bind(id).first();
  return json(rowToDayInfo(updated), 200, headers);
}

// 自動取得した天気が実際と違うときに、本人が手動で修正するためのエンドポイント。
// 場所（place）は変えず、天気アイコン・気温だけを上書きする。降水量（precip_sum）は
// 手動入力では持たないためクリアする（weatherLabel()の「1mm以下なら曇り扱い」判定は
// precipSumがnumberのときだけ働くので、nullなら選んだ天気コードの表示がそのまま出る）。
async function setDayWeatherManual(tripId, date, request, env, headers) {
  if (!DATE_RE.test(date)) return json({ error: "invalid_date" }, 400, headers);
  const id = tripId + "_" + date;
  const existing = await env.DB.prepare("SELECT id FROM day_infos WHERE id = ?").bind(id).first();
  if (!existing) return json({ error: "day_not_found" }, 404, headers);
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  if (!Number.isInteger(data.weatherCode) || MANUAL_WEATHER_CODES.indexOf(data.weatherCode) === -1) {
    return json({ error: "invalid_input" }, 400, headers);
  }
  const tempMax = typeof data.tempMax === "number" && isFinite(data.tempMax) && data.tempMax >= -80 && data.tempMax <= 80 ? data.tempMax : null;
  const tempMin = typeof data.tempMin === "number" && isFinite(data.tempMin) && data.tempMin >= -80 && data.tempMin <= 80 ? data.tempMin : null;
  const t = nowIso();
  await env.DB.prepare(
    "UPDATE day_infos SET weather_code=?, temp_max=?, temp_min=?, precip_sum=NULL, is_forecast=0, weather_manual=1, fetched_at=?, updated_at=? WHERE id=?"
  )
    .bind(data.weatherCode, tempMax, tempMin, t, t, id)
    .run();
  const updated = await env.DB.prepare("SELECT * FROM day_infos WHERE id = ?").bind(id).first();
  return json(rowToDayInfo(updated), 200, headers);
}

async function deleteDayPlace(tripId, date, env, headers) {
  await env.DB.prepare("DELETE FROM day_infos WHERE id = ?").bind(tripId + "_" + date).run();
  return json({ ok: true }, 200, headers);
}

/* ---------- メールでのログイン（OTP） ----------
 * 実際にメールでコードを送って確認する、唯一「本当に本人確認できる」ログイン方法
 * （Google/Appleはクライアント側で完結する簡易的な仕組みのままだが、こちらはサーバー
 * 側でメールの持ち主であることを検証する）。メール送信にはResendを使う。
 * RESEND_API_KEYはWorkerのsecretとして設定する（コードに直接書かない）。
 */

const OTP_EXPIRES_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_SECONDS = 60;

function generateOtpCode() {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(bytes[0] % 1000000).padStart(6, "0");
}

function isValidEmailFormat(email) {
  return typeof email === "string" && email.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sendOtpEmail(env, email, code) {
  if (!env.RESEND_API_KEY) return { ok: false, error: "email_not_configured" };
  const from = env.RESEND_FROM || "旅の足跡 <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: "Bearer " + env.RESEND_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "旅の足跡：ログインコード",
      text: "旅の足跡のログインコードです。\n\n" + code + "\n\n"
        + OTP_EXPIRES_MINUTES + "分以内に入力してください。心当たりがない場合はこのメールを無視してください。",
    }),
  });
  if (!res.ok) return { ok: false, error: "send_failed" };
  return { ok: true };
}

async function sendEmailOtp(request, env, headers) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  if (!isValidEmailFormat(data.email)) return json({ error: "invalid_email" }, 400, headers);
  if (!optStr(data.name, 100)) return json({ error: "invalid_input" }, 400, headers);
  const email = data.email.trim().toLowerCase();
  const name = (data.name || "").trim();

  const existing = await env.DB.prepare("SELECT created_at FROM email_otps WHERE email = ?").bind(email).first();
  if (existing) {
    const elapsedSec = (Date.now() - new Date(existing.created_at).getTime()) / 1000;
    if (elapsedSec < OTP_RESEND_COOLDOWN_SECONDS) {
      return json({ error: "too_soon", retryAfterSeconds: Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - elapsedSec) }, 429, headers);
    }
  }

  const code = generateOtpCode();
  const t = nowIso();
  const expiresAt = new Date(Date.now() + OTP_EXPIRES_MINUTES * 60000).toISOString();

  const sendResult = await sendOtpEmail(env, email, code);
  if (!sendResult.ok) return json({ error: sendResult.error }, 502, headers);

  await env.DB.prepare(
    "INSERT INTO email_otps (email, code, name, attempts, expires_at, created_at) VALUES (?,?,?,0,?,?) "
    + "ON CONFLICT(email) DO UPDATE SET code=excluded.code, name=excluded.name, attempts=0, expires_at=excluded.expires_at, created_at=excluded.created_at"
  )
    .bind(email, code, name, expiresAt, t)
    .run();

  return json({ ok: true }, 200, headers);
}

async function verifyEmailOtp(request, env, headers) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  if (!isValidEmailFormat(data.email) || !isStr(data.code, 6)) return json({ error: "invalid_input" }, 400, headers);
  const email = data.email.trim().toLowerCase();
  const code = (data.code || "").trim();

  const row = await env.DB.prepare("SELECT * FROM email_otps WHERE email = ?").bind(email).first();
  if (!row) return json({ error: "not_found" }, 404, headers);
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await env.DB.prepare("DELETE FROM email_otps WHERE email = ?").bind(email).run();
    return json({ error: "expired" }, 410, headers);
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    await env.DB.prepare("DELETE FROM email_otps WHERE email = ?").bind(email).run();
    return json({ error: "too_many_attempts" }, 429, headers);
  }
  if (row.code !== code) {
    await env.DB.prepare("UPDATE email_otps SET attempts = attempts + 1 WHERE email = ?").bind(email).run();
    return json({ error: "wrong_code" }, 401, headers);
  }
  await env.DB.prepare("DELETE FROM email_otps WHERE email = ?").bind(email).run();
  return json({ email, name: row.name }, 200, headers);
}

/* ---------- アカウント・参加者（アカウント参加者） ----------
 * ログイン（Google/Apple/メールOTP）が一度でも成功したメールアドレスに対し、
 * サーバー側に永続的な「アカウント」を作る。account_idは6桁の数字（自動採番）で、
 * 参加者一覧などで生のメールアドレスを晒さずその人を指し示すために使う。
 * 「参加する」を押すと、Trip×account_idの組でtrip_membersに1件登録される
 * （ゲスト参加者＝trips.companionsのテキストとは別物。既存データには触れない）。
 */

function generateAccountId() {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(100000 + (bytes[0] % 900000));
}

// 月間の音声入力の上限（docs/adr/0004）。free（無料）は月2回まで
// （新規登録時にticket_creditsへ3回分のボーナスを付与するため、登録した最初の月だけ実質5回）。
var PLAN_MONTHLY_LIMIT = { free: 2, basic: 10, premium_plus: 50 };

function currentPeriodStart() {
  var now = new Date();
  return now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0") + "-01";
}

// 暦月が変わっていたら利用回数をリセットする（Stripeの実際の請求日とは同期させない簡易な実装）。
async function resetPeriodIfNeeded(env, row) {
  var period = currentPeriodStart();
  if (row.plan_period_start === period) return row;
  await env.DB.prepare("UPDATE accounts SET plan_period_start=?, voice_uses_this_period=0, updated_at=? WHERE email=?")
    .bind(period, nowIso(), row.email)
    .run();
  return { ...row, plan_period_start: period, voice_uses_this_period: 0 };
}

function rowToAccount(row) {
  var limit = PLAN_MONTHLY_LIMIT[row.plan] || 0;
  return {
    accountId: row.account_id,
    email: row.email,
    name: row.name,
    plan: row.plan || "free",
    voiceUsesThisPeriod: row.voice_uses_this_period || 0,
    voiceMonthlyLimit: limit,
    voiceRemainingThisPeriod: Math.max(0, limit - (row.voice_uses_this_period || 0)),
    ticketCredits: row.ticket_credits || 0,
  };
}

function rowToMember(row) {
  return { accountId: row.account_id, name: row.name, joinedAt: row.joined_at };
}

async function getOrCreateAccount(env, email, name) {
  const existing = await env.DB.prepare("SELECT * FROM accounts WHERE email = ?").bind(email).first();
  const t = nowIso();
  if (existing) {
    if (name && name !== existing.name) {
      await env.DB.prepare("UPDATE accounts SET name=?, updated_at=? WHERE email=?").bind(name, t, email).run();
      return { ...existing, name, updated_at: t };
    }
    return existing;
  }
  for (let i = 0; i < 10; i++) {
    const accountId = generateAccountId();
    try {
      // 新規登録の特典として、回数券(ticket_credits)に3回分のボーナスを付与する
      // （無料プランの月間上限を使い切った後に消費されるため、登録した最初の月だけ実質5回になる。
      // 機能の良さを知ってもらうための特典なので、本物の初回登録だけに限定したい。
      // deleteAccount()はこの行をDELETEせず空にするだけなので、削除→再登録では
      // このINSERT分岐に来ず、特典を再び得ることはできない。docs/adr/0004参照）。
      const welcomeTicketCredits = 3;
      await env.DB.prepare(
        "INSERT INTO accounts (email, account_id, name, ticket_credits, created_at, updated_at) VALUES (?,?,?,?,?,?)"
      )
        .bind(email, accountId, name || "", welcomeTicketCredits, t, t)
        .run();
      return { email, account_id: accountId, name: name || "", ticket_credits: welcomeTicketCredits, created_at: t, updated_at: t };
    } catch (e) {
      const msg = String((e && e.message) || "");
      if (msg.indexOf("UNIQUE") === -1) throw e;
      if (msg.indexOf("accounts.email") !== -1) {
        const row = await env.DB.prepare("SELECT * FROM accounts WHERE email = ?").bind(email).first();
        if (row) return row;
      }
      // account_idの衝突（極めて稀）：ループして採番し直す
    }
  }
  throw new Error("account_id_generation_failed");
}

async function ensureAccount(request, env, headers) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  if (!isValidEmailFormat(data.email)) return json({ error: "invalid_email" }, 400, headers);
  if (!optStr(data.name, 100)) return json({ error: "invalid_input" }, 400, headers);
  const email = data.email.trim().toLowerCase();
  const name = (data.name || "").trim();
  const account = await resetPeriodIfNeeded(env, await getOrCreateAccount(env, email, name));
  return json(rowToAccount(account), 200, headers);
}

// アカウント削除（Appleのガイドライン5.1.1(v)対応：アカウント作成機能があるアプリは
// アプリ内から自分でアカウントを削除できる必要がある）。
// 消えるのはアカウント本体（名前・プラン・回数券・参加した旅行への紐付け）で、
// 旅行の記録自体は家族と共有しているものなので削除しない。
// 有料プランの契約中だった場合は、二重請求を避けるためStripeの定期購入も解約する。
//
// accountsの行自体はemailをキーにしたまま残し、個人情報だけ空にする（完全にDELETEしない）。
// これは「削除→登録し直す」を繰り返して新規登録特典（回数券3回分）を無限に得られてしまう
// 抜け道を防ぐため（getOrCreateAccountはemailの行が既に存在する場合は特典を付与しない）。
async function deleteAccount(request, env, headers) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  if (!isValidEmailFormat(data.email)) return json({ error: "invalid_email" }, 400, headers);
  const email = data.email.trim().toLowerCase();

  const account = await env.DB.prepare("SELECT * FROM accounts WHERE email = ?").bind(email).first();
  if (!account) return json({ error: "not_found" }, 404, headers);

  if (account.stripe_subscription_id && env.STRIPE_SECRET_KEY) {
    const upstream = await fetch(`${STRIPE_API_BASE}/subscriptions/${account.stripe_subscription_id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    if (!upstream.ok) {
      const errorBody = await upstream.text().catch(() => "");
      console.error(JSON.stringify({ event: "stripe_error", status: upstream.status, body: errorBody.slice(0, 500) }));
      return json({ error: "subscription_cancel_failed" }, 502, headers);
    }
  }

  await env.DB.prepare("DELETE FROM ratings WHERE rater_email = ?").bind(email).run();
  await env.DB.prepare("DELETE FROM trip_members WHERE account_id = ?").bind(account.account_id).run();
  // plan_period_start・voice_uses_this_periodはあえて触らない。ここでリセットすると
  // 「削除→再登録」を繰り返すだけで無料プランの月間上限(2回)が毎回復活してしまう
  // （新規登録特典の抜け道と同じ構図）。月が変わったときのリセットはresetPeriodIfNeeded()に
  // 任せる。
  await env.DB.prepare(
    `UPDATE accounts SET name='', plan='free', ticket_credits=0,
     stripe_customer_id='', stripe_subscription_id='', updated_at=? WHERE email=?`
  )
    .bind(nowIso(), email)
    .run();
  return json({ ok: true }, 200, headers);
}

/* ---------- Stripe（音声入力の有料プラン。docs/adr/0004） ----------
 * npm SDKは使わず、OpenAI連携と同じくfetch()で直接REST APIを呼ぶ。
 * StripeのAPIはJSONではなくapplication/x-www-form-urlencodedを受け取る。
 */
const STRIPE_API_BASE = "https://api.stripe.com/v1";
const PLAN_PRICE_IDS = {
  basic: "price_1UFbTgDKb5ecGXW9mdabWbFs",
  premium_plus: "price_1UFbUiDKb5ecGXW9OG7jYfQu",
};

// StripeのAPIが期待するbracket記法（line_items[0][price]など）にネストしたオブジェクト・配列を変換する
function stripeFormBody(params) {
  const pairs = [];
  function walk(prefix, value) {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    } else if (typeof value === "object") {
      Object.keys(value).forEach((k) => walk(prefix ? `${prefix}[${k}]` : k, value[k]));
    } else {
      pairs.push(encodeURIComponent(prefix) + "=" + encodeURIComponent(value));
    }
  }
  Object.keys(params).forEach((k) => walk(k, params[k]));
  return pairs.join("&");
}

async function createCheckoutSession(request, env, headers) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "server_not_configured" }, 503, headers);
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  if (!isValidEmailFormat(data.email)) return json({ error: "invalid_email" }, 400, headers);
  const priceId = PLAN_PRICE_IDS[data.plan];
  if (!priceId) return json({ error: "invalid_plan" }, 400, headers);
  if (!optStr(data.successUrl, 500) || !data.successUrl) return json({ error: "invalid_input" }, 400, headers);
  if (!optStr(data.cancelUrl, 500) || !data.cancelUrl) return json({ error: "invalid_input" }, 400, headers);
  const email = data.email.trim().toLowerCase();

  // Checkout StudioでUI上固定された値（fixed_by_ui）は、そのまま使う
  const body = stripeFormBody({
    mode: "subscription",
    ui_mode: "hosted_page",
    success_url: data.successUrl,
    cancel_url: data.cancelUrl,
    customer_email: email,
    client_reference_id: email,
    billing_address_collection: "auto",
    payment_method_collection: "always",
    phone_number_collection: { enabled: false },
    // Stripeアカウントの「Managed Payments」機能がデフォルトで有効になっており、
    // automatic_tax[enabled]=falseを明示すると"must be true when Managed Payments
    // is enabled"というエラーになる（managed_payments[enabled]=falseを併用しても
    // 変わらなかった）。Stripe側のエラーメッセージが提示するもう一つの回避策として、
    // automatic_taxパラメータ自体を渡さない（税計算については何も指定しない）。
    managed_payments: { enabled: false },
    allow_promotion_codes: false,
    submit_type: "auto",
    line_items: [{ price: priceId, quantity: 1 }],
    // Webhookでline_itemsを別途取得しなくて済むよう、どのプランを買ったかをmetadataに残しておく
    metadata: { plan: data.plan },
  });

  const upstream = await fetch(`${STRIPE_API_BASE}/checkout/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!upstream.ok) {
    const errorBody = await upstream.text().catch(() => "");
    console.error(JSON.stringify({ event: "stripe_error", status: upstream.status, body: errorBody.slice(0, 500) }));
    return json({ error: "upstream_error" }, 502, headers);
  }
  const session = await upstream.json();
  return json({ url: session.url }, 200, headers);
}

// Stripeのカスタマーポータル（支払い方法の変更・請求書の確認・解約ができるStripe提供のページ）
// を開くためのセッションを作る。解約そのものはこのポータル側の操作で行われ、
// 実際のプラン変更はStripeのWebhook（handleStripeWebhook）経由で反映される。
async function createPortalSession(request, env, headers) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "server_not_configured" }, 503, headers);
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  if (!isValidEmailFormat(data.email)) return json({ error: "invalid_email" }, 400, headers);
  if (!optStr(data.returnUrl, 500) || !data.returnUrl) return json({ error: "invalid_input" }, 400, headers);
  const email = data.email.trim().toLowerCase();

  const account = await env.DB.prepare("SELECT stripe_customer_id FROM accounts WHERE email = ?").bind(email).first();
  if (!account || !account.stripe_customer_id) return json({ error: "no_subscription" }, 404, headers);

  const body = stripeFormBody({
    customer: account.stripe_customer_id,
    return_url: data.returnUrl,
  });
  const upstream = await fetch(`${STRIPE_API_BASE}/billing_portal/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!upstream.ok) {
    const errorBody = await upstream.text().catch(() => "");
    console.error(JSON.stringify({ event: "stripe_error", status: upstream.status, body: errorBody.slice(0, 500) }));
    return json({ error: "upstream_error" }, 502, headers);
  }
  const session = await upstream.json();
  return json({ url: session.url }, 200, headers);
}

// Stripeの署名（stripe-signatureヘッダー）を検証する。https://docs.stripe.com/webhooks#verify-official-libraries
// npm SDKを使わないため、Web Crypto APIのHMAC-SHA256で自前で検証する。
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = {};
  sigHeader.split(",").forEach((kv) => {
    const i = kv.indexOf("=");
    if (i === -1) return;
    parts[kv.slice(0, i)] = kv.slice(i + 1);
  });
  if (!parts.t || !parts.v1) return false;
  // 5分より古いタイムスタンプは、リプレイ攻撃を避けるため拒否する
  const age = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (!isFinite(age) || age > 300) return false;

  const signedPayload = `${parts.t}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expected = Array.from(new Uint8Array(sigBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

async function handleStripeWebhook(request, env, headers) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: "server_not_configured" }, 503, headers);
  const rawBody = await request.text();
  const valid = await verifyStripeSignature(rawBody, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return json({ error: "invalid_signature" }, 400, headers);

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const email = String(session.client_reference_id || session.customer_email || "").trim().toLowerCase();
    const plan = session.metadata && session.metadata.plan;
    if (email && PLAN_PRICE_IDS[plan]) {
      const t = nowIso();
      await env.DB.prepare(
        `UPDATE accounts SET plan=?, plan_period_start=?, voice_uses_this_period=0,
         stripe_customer_id=?, stripe_subscription_id=?, updated_at=? WHERE email=?`
      )
        .bind(plan, currentPeriodStart(), session.customer || "", session.subscription || "", t, email)
        .run();
    }
  } else if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    const customerId = subscription.customer;
    if (customerId) {
      await env.DB.prepare("UPDATE accounts SET plan='free', updated_at=? WHERE stripe_customer_id=?")
        .bind(nowIso(), customerId)
        .run();
    }
  }

  return json({ received: true }, 200, headers);
}

async function joinTrip(tripId, request, env, headers) {
  const trip = await env.DB.prepare("SELECT id FROM trips WHERE id = ?").bind(tripId).first();
  if (!trip) return json({ error: "trip_not_found" }, 404, headers);
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  if (!isValidEmailFormat(data.email)) return json({ error: "invalid_email" }, 400, headers);
  if (!optStr(data.name, 100)) return json({ error: "invalid_input" }, 400, headers);
  const email = data.email.trim().toLowerCase();
  const name = (data.name || "").trim();
  const account = await getOrCreateAccount(env, email, name);
  const accountId = account.account_id;

  const existing = await env.DB.prepare("SELECT id FROM trip_members WHERE trip_id = ? AND account_id = ?")
    .bind(tripId, accountId)
    .first();
  if (!existing) {
    await env.DB.prepare(
      "INSERT INTO trip_members (id, trip_id, account_id, name, joined_at) VALUES (?,?,?,?,?)"
    )
      .bind(uid("mem"), tripId, accountId, account.name, nowIso())
      .run();
  }
  const { results } = await env.DB.prepare("SELECT * FROM trip_members WHERE trip_id = ?").bind(tripId).all();
  return json({ members: results.map(rowToMember), accountId }, 200, headers);
}

/* ---------- 音声からの記録作成（このアプリで唯一AIを呼び出す機能） ----------
 * その日にあったことをまとめて話した音声（＋任意でURL・店名の雑多なメモ）を
 * OpenAIに渡し、話した順番どおりに複数のBlock（予定）・Entry（記録）へ分割して
 * その場で保存する。日付・時間帯はAIに判定させず、常に指定された日付に固定する
 * （時刻は空のまま、作成順で並ぶ）。評価・費用などAIに推測させると事実と異なり
 * やすい項目は対象外（docs/adr/0002参照）。保存前の確認画面は挟まない。
 */

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const MAX_VOICE_AUDIO_BYTES = 15 * 1024 * 1024; // 数分の音声を想定した上限
const VOICE_AUDIO_FORMATS = { "audio/webm": "webm", "audio/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg" };

// 使っているモデルは音声を直接聞く方式（audio input）に対応していなかったため、
// 先にWhisper（音声認識専用API）で文字起こしし、そのテキストを元に予定・記録へ
// 分割する2段階にしている。文字起こし自体もその日のDayInfoに保存する。
async function transcribeAudio(env, buf, contentType, format) {
  const form = new FormData();
  form.append("file", new Blob([buf], { type: contentType }), "audio." + format);
  form.append("model", "whisper-1");
  form.append("language", "ja");
  const res = await fetch(OPENAI_TRANSCRIPTION_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    console.error(JSON.stringify({ event: "openai_transcribe_error", status: res.status, body: errorBody.slice(0, 500) }));
    return null;
  }
  const data = await res.json();
  return typeof data.text === "string" ? data.text.trim() : null;
}

function outputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output || []) {
    if (item.type !== "message") continue;
    for (const part of item.content || []) {
      if (part.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  return "";
}

function voicePrompt(transcript, notes) {
  return [
    "あなたは旅行記録アプリのアシスタントです。旅行者がその日の出来事をまとめて話した音声の文字起こしを読んで、",
    "予定（Block）とその記録（Entry）の配列に分割してください。",
    "",
    "文字起こし:",
    transcript,
    "",
    "ルール：",
    "- 話された順番のとおりに配列を並べること",
    "- 1つの出来事・場所ごとに1つのBlockを作ること",
    "- categoryは次のいずれか一つ: sightseeing（観光）, food（食事）, lodging（宿泊）, transport（移動）, other（その他）",
    "- labelは短い見出し（例：「ダイヤモンドヘッドに登る」）にすること。体言止め（名詞で終える）を基本とし、「〜する」「〜した」のような文にはしないこと",
    "- categoryがlodging（宿泊）のときは、labelを宿泊施設名だけにすること（例：「ふふ奈良に到着する」ではなく「ふふ奈良」）",
    "- entry.episodeには、話した内容をもとにした2〜3文程度の説明を書くこと（話していないことを推測で付け加えない）",
    "- block.timeは、「10時に着いた」「18時ごろ」のように具体的な時刻が話されたときだけ24時間表記のHH:MM（例：「10:00」）で入れ、話されていなければ空文字にすること。時刻を推測で作らないこと",
    "- entry.costItemsは、「入場料800円」「一人5000円で3人だから15000円」のように具体的な金額が話されたときだけ、内訳（品目名と金額）を1件以上の配列で入れること。金額が話されていなければ空配列のままにすること。合計しか話されていなければ、品目名を「合計」などとして1件で入れてよい。金額を推測で作らないこと",
    "- 評価など、話されていない情報は絶対に作らないこと",
    notes
      ? "- 次のメモ（URLや店名が雑多に書かれている）の中に、Blockの内容と対応しそうなものがあれば、entry.mapUrlまたはentry.shopUrlに入れること。対応するものが無ければ空文字のままにすること。\n\nメモ:\n" + notes
      : "- entry.mapUrl・entry.shopUrlは、音声内で明確なURLが無ければ空文字にすること",
  ].join("\n");
}

// 複数日ぶんをまとめて話す／書くときに使うプロンプト（DAY30〜）。「1日目は〜、次の日は〜」
// のような表現から、AI自身にその出来事が何日目のことかも判定させ、Blockごとにdate
// （YYYY-MM-DD）を付けてもらう。1日固定のvoicePromptと違い、日の判定を誤るリスクがあるため、
// 「複数日をまとめて記録する」という別の入り口を明示的に選んだときだけ使う。
function multiDayPrompt(transcript, notes, dates) {
  const dayList = dates.map(function (d, i) { return (i + 1) + "日目：" + d; }).join("\n");
  return [
    "あなたは旅行記録アプリのアシスタントです。旅行者が複数日にわたる出来事をまとめて話した（または書いた）内容を読んで、",
    "予定（Block）とその記録（Entry）の配列に分割してください。この旅行の日程は次のとおりです。",
    "",
    dayList,
    "",
    "文字起こし・メモ:",
    transcript,
    "",
    "ルール：",
    "- 話された／書かれた順番のとおりに配列を並べること",
    "- 1つの出来事・場所ごとに1つのBlockを作ること",
    "- 各Blockのdateには、その出来事があった日を上記の日程からYYYY-MM-DD形式で選んで入れること。「1日目」「次の日」「2日目の朝」のような表現から判断し、はっきりしなければ直前のBlockと同じ日にすること。最初のBlockで日が全く分からなければ1日目の日付にすること",
    "- categoryは次のいずれか一つ: sightseeing（観光）, food（食事）, lodging（宿泊）, transport（移動）, other（その他）",
    "- labelは短い見出し（例：「ダイヤモンドヘッドに登る」）にすること。体言止め（名詞で終える）を基本とし、「〜する」「〜した」のような文にはしないこと",
    "- categoryがlodging（宿泊）のときは、labelを宿泊施設名だけにすること（例：「ふふ奈良に到着する」ではなく「ふふ奈良」）",
    "- entry.episodeには、話した／書かれた内容をもとにした2〜3文程度の説明を書くこと（話していないことを推測で付け加えない）",
    "- block.timeは、「10時に着いた」「18時ごろ」のように具体的な時刻が話されたときだけ24時間表記のHH:MM（例：「10:00」）で入れ、話されていなければ空文字にすること。時刻を推測で作らないこと",
    "- entry.costItemsは、「入場料800円」「一人5000円で3人だから15000円」のように具体的な金額が話されたときだけ、内訳（品目名と金額）を1件以上の配列で入れること。金額が話されていなければ空配列のままにすること。合計しか話されていなければ、品目名を「合計」などとして1件で入れてよい。金額を推測で作らないこと",
    "- 評価など、話されていない情報は絶対に作らないこと",
    notes
      ? "- 次のメモ（URLや店名が雑多に書かれている）の中に、Blockの内容と対応しそうなものがあれば、entry.mapUrlまたはentry.shopUrlに入れること。対応するものが無ければ空文字のままにすること。\n\nメモ:\n" + notes
      : "- entry.mapUrl・entry.shopUrlは、音声内で明確なURLが無ければ空文字にすること",
  ].join("\n");
}

function voiceBlocksSchema() {
  return {
    type: "object",
    properties: {
      blocks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            category: { type: "string", enum: CATEGORIES },
            time: { type: "string" },
            entry: {
              type: "object",
              properties: {
                episode: { type: "string" },
                mapUrl: { type: "string" },
                shopUrl: { type: "string" },
                costItems: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      amount: { type: "integer" },
                    },
                    required: ["label", "amount"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["episode", "mapUrl", "shopUrl", "costItems"],
              additionalProperties: false,
            },
          },
          required: ["label", "category", "time", "entry"],
          additionalProperties: false,
        },
      },
    },
    required: ["blocks"],
    additionalProperties: false,
  };
}

// voiceBlocksSchemaに、Blockごとの日付（date）を必須項目として追加しただけのもの。
function multiDayBlocksSchema() {
  const schema = voiceBlocksSchema();
  const itemSchema = schema.properties.blocks.items;
  itemSchema.properties.date = { type: "string" };
  itemSchema.required = ["date", "label", "category", "time", "entry"];
  return schema;
}

// 旅行の開始日〜終了日を1日ずつのYYYY-MM-DD配列にする（「1日目」「2日目」…とAIに教えるため）。
// 異常に長い日程を渡されてもAIへのリクエストが際限なく膨らまないよう、60日で打ち切る。
function tripDateList(startDate, endDate) {
  if (!DATE_RE.test(startDate)) return [];
  if (!DATE_RE.test(endDate)) return [startDate];
  const start = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  if (end.getTime() < start.getTime()) return [startDate];
  const dates = [];
  const cur = new Date(start.getTime());
  while (cur.getTime() <= end.getTime() && dates.length < 60) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function decodeVoiceMeta(header) {
  if (!header) return {};
  try {
    var json = decodeURIComponent(escape(atob(header)));
    var meta = JSON.parse(json);
    return meta && typeof meta === "object" ? meta : {};
  } catch {
    return {};
  }
}

// 音声入力を使う権利があるか確認する（docs/adr/0004）。実際の消費（回数を減らす）は
// AI呼び出しが成功した後に行う（失敗した録音でユーザーの枠を消費しないため）。
async function checkVoiceQuota(env, email) {
  if (!isValidEmailFormat(email)) return { ok: false, reason: "login_required" };
  const normalized = email.trim().toLowerCase();
  const account = await env.DB.prepare("SELECT * FROM accounts WHERE email = ?").bind(normalized).first();
  if (!account) return { ok: false, reason: "login_required" };
  const reset = await resetPeriodIfNeeded(env, account);
  const limit = PLAN_MONTHLY_LIMIT[reset.plan] || 0;
  if (reset.voice_uses_this_period < limit) return { ok: true, via: "plan", email: normalized };
  if ((reset.ticket_credits || 0) > 0) return { ok: true, via: "ticket", email: normalized };
  return { ok: false, reason: reset.plan === "free" ? "premium_required" : "quota_exceeded" };
}

async function consumeVoiceQuota(env, email, via) {
  const t = nowIso();
  if (via === "ticket") {
    await env.DB.prepare("UPDATE accounts SET ticket_credits = MAX(0, ticket_credits - 1), updated_at=? WHERE email=?").bind(t, email).run();
  } else {
    await env.DB.prepare("UPDATE accounts SET voice_uses_this_period = voice_uses_this_period + 1, updated_at=? WHERE email=?").bind(t, email).run();
  }
}

// 文字起こし（音声入力）または直接入力されたメモ・スケジュールのテキストを、AIで
// 予定（Block）とその記録（Entry）の配列に整理してもらう。音声入力・メモ入力の共通処理。
// datesを渡すと「複数日をまとめて記録する」用のプロンプト・スキーマ（Blockごとにdateも
// 判定させる）に切り替わる（DAY30〜、渡さなければ今までどおり1日固定のまま）。
async function organizeTextIntoBlocks(env, text, notes, dates) {
  const multiDay = Array.isArray(dates) && dates.length > 1;
  const upstream = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5.6-sol",
      input: multiDay ? multiDayPrompt(text, notes, dates) : voicePrompt(text, notes),
      reasoning: { effort: "medium" },
      // 複数日モードは1回のレスポンスに何日ぶんものBlock/Entryが収まるため、1日固定より
      // ずっと大きな出力になる（reasoningトークンもこの上限を共有する）。3000では
      // 5日分程度の入力で出力が尻切れになりJSON.parseに失敗することが実際にあったため、
      // 十分な余裕を持たせている（DAY30、実機での不具合報告を受けて調整）。
      max_output_tokens: multiDay ? 12000 : 2000,
      store: false,
      text: {
        format: {
          type: "json_schema", name: multiDay ? "voice_blocks_multi_day" : "voice_blocks", strict: true,
          schema: multiDay ? multiDayBlocksSchema() : voiceBlocksSchema(),
        },
      },
    }),
  });
  if (!upstream.ok) {
    const errorBody = await upstream.text().catch(() => "");
    console.error(JSON.stringify({ event: "openai_error", status: upstream.status, body: errorBody.slice(0, 500) }));
    return { error: "upstream_error" };
  }
  const response = await upstream.json();
  let parsed;
  try { parsed = JSON.parse(outputText(response)); }
  catch {
    console.error(JSON.stringify({
      event: "voice_blocks_parse_error", multiDay, status: response.status,
      incompleteReason: response.incomplete_details && response.incomplete_details.reason,
      outputTextLength: outputText(response).length,
    }));
    return { error: "invalid_model_output" };
  }
  if (!parsed || !Array.isArray(parsed.blocks)) return { error: "invalid_model_output" };
  return { blocks: parsed.blocks };
}

// organizeTextIntoBlocksが返したBlock配列を、実際にDBへ保存する（Block本体とその記録の両方）。
// dateOrDatesは、1日固定の呼び出しなら文字列（今までどおり全件その日付）、「複数日をまとめて
// 記録する」からの呼び出しなら配列（旅行の日程の一覧）を渡す。配列のときは、AIが付けた
// Blockごとのdateがその一覧に含まれるものだけを信用し、それ以外（無い・範囲外）は
// 一覧の最初の日にフォールバックする（AIの出力を無条件には信用しない）。
async function saveOrganizedBlocks(env, tripId, dateOrDates, blocksData, author) {
  const multiDay = Array.isArray(dateOrDates);
  const validDates = multiDay ? new Set(dateOrDates) : null;
  const fallbackDate = multiDay ? (dateOrDates[0] || "") : dateOrDates;
  const created = [];
  const baseTime = Date.now();
  for (let i = 0; i < blocksData.length; i++) {
    const b = blocksData[i];
    if (!b || typeof b !== "object") continue;
    const label = isStr(b.label, 200) ? b.label.trim() : "";
    if (!label) continue;
    const date = multiDay ? (isStr(b.date, 10) && validDates.has(b.date) ? b.date : fallbackDate) : dateOrDates;
    if (!date) continue;
    const category = CATEGORIES.includes(b.category) ? b.category : "sightseeing";
    const time = isStr(b.time, 5) && TIME_RE.test(b.time) ? b.time : "";
    const t = new Date(baseTime + i * 10).toISOString(); // 話した順番で安定して並ぶよう少しずつずらす

    const blockRow = { id: uid("blk"), trip_id: tripId, date, time, label, category, created_at: t, updated_at: t };
    const entryData = (b.entry && typeof b.entry === "object") ? b.entry : {};
    const episode = isStr(entryData.episode, 4000) ? entryData.episode.trim() : "";
    const mapUrl = optUrl(entryData.mapUrl, 500) ? (entryData.mapUrl || "") : "";
    const shopUrl = optUrl(entryData.shopUrl, 500) ? (entryData.shopUrl || "") : "";
    const entryRow = {
      id: uid("ent"), block_id: blockRow.id, episode, comment: "", detail: "",
      photo_ids: "[]", video_ids: "[]", cost_items: "[]", wait_time: "",
      map_url: mapUrl, shop_url: shopUrl, author, created_at: t, updated_at: t,
    };
    // Block本体とその記録（entry）を1つのバッチ（D1のトランザクション）にまとめる。
    // 別々のrun()にすると、Blockの保存だけ成功して記録の保存だけ失敗した場合に
    // 「予定はあるのに記録が空」という気づきにくい中途半端な状態が残ってしまうため
    // （2026-09-15、実際にこの状態で複数件の記録が失われる事故があった）。
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO blocks (id, trip_id, date, time, label, category, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
      ).bind(blockRow.id, blockRow.trip_id, blockRow.date, blockRow.time, blockRow.label, blockRow.category, blockRow.created_at, blockRow.updated_at),
      env.DB.prepare(
        `INSERT INTO entries (id, block_id, episode, comment, detail, photo_ids, video_ids, cost_items, wait_time, map_url, shop_url, author, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        entryRow.id, entryRow.block_id, entryRow.episode, entryRow.comment, entryRow.detail, entryRow.photo_ids,
        entryRow.video_ids, entryRow.cost_items, entryRow.wait_time, entryRow.map_url, entryRow.shop_url,
        entryRow.author, entryRow.created_at, entryRow.updated_at
      ),
    ]);

    created.push({ ...rowToBlock(blockRow), entries: [rowToEntry(entryRow)] });
  }
  return created;
}

async function createBlocksFromVoice(tripId, date, request, env, headers) {
  if (!env.OPENAI_API_KEY) return json({ error: "server_not_configured" }, 503, headers);
  if (!DATE_RE.test(date)) return json({ error: "invalid_date" }, 400, headers);
  const trip = await env.DB.prepare("SELECT id FROM trips WHERE id = ?").bind(tripId).first();
  if (!trip) return json({ error: "trip_not_found" }, 404, headers);

  const { buf, contentType, getHeader } = await readBinaryBody(request);
  const format = VOICE_AUDIO_FORMATS[contentType];
  if (!format) return json({ error: "unsupported_type" }, 415, headers);

  if (buf.byteLength === 0 || buf.byteLength > MAX_VOICE_AUDIO_BYTES) return json({ error: "invalid_size" }, 413, headers);

  const meta = decodeVoiceMeta(getHeader("x-voice-meta"));
  const notes = optStr(meta.notes, 4000) && meta.notes ? String(meta.notes).trim() : "";
  const author = optStr(meta.author, 50) && meta.author ? String(meta.author).trim() : "";
  const email = optStr(meta.email, 200) && meta.email ? String(meta.email).trim() : "";

  // プラン・回数券の確認（docs/adr/0004）。有料プランの範囲外なら、高くつくAI呼び出しの前に断る
  const quota = await checkVoiceQuota(env, email);
  if (!quota.ok) return json({ error: quota.reason }, 403, headers);

  if (env.AI_RATE_LIMITER) {
    const actor = request.headers.get("cf-connecting-ip") || "anonymous";
    const limited = await env.AI_RATE_LIMITER.limit({ key: actor });
    if (!limited.success) return json({ error: "rate_limited" }, 429, headers);
  }

  const transcript = await transcribeAudio(env, buf, contentType, format);
  if (!transcript) return json({ error: "transcription_failed" }, 502, headers);
  if (!transcript.length) return json({ error: "empty_transcript" }, 422, headers);

  const result = await organizeTextIntoBlocks(env, transcript, notes);
  if (result.error) return json({ error: result.error }, 502, headers);
  const created = await saveOrganizedBlocks(env, tripId, date, result.blocks, author);

  await saveVoiceTranscript(env, tripId, date, transcript);
  await env.DB.prepare("UPDATE trips SET updated_at = ? WHERE id = ?").bind(nowIso(), tripId).run();
  await consumeVoiceQuota(env, quota.email, quota.via);
  return json({ blocks: created, transcript }, 200, headers);
}

// メモ・スケジュールのテキストを直接貼り付けて整理してもらう版（音声入力の文字起こし版と
// 中身はほぼ同じで、録音・Whisperでの文字起こしが無いだけ。利用回数の枠は音声入力と共有する
// （docs/adr/0004）。
const MAX_TEXT_MEMO_CHARS = 4000;

async function createBlocksFromText(tripId, date, request, env, headers) {
  if (!env.OPENAI_API_KEY) return json({ error: "server_not_configured" }, 503, headers);
  if (!DATE_RE.test(date)) return json({ error: "invalid_date" }, 400, headers);
  const trip = await env.DB.prepare("SELECT id FROM trips WHERE id = ?").bind(tripId).first();
  if (!trip) return json({ error: "trip_not_found" }, 404, headers);

  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  const text = isStr(data.text, MAX_TEXT_MEMO_CHARS) ? data.text.trim() : "";
  if (!text) return json({ error: "empty_text" }, 422, headers);
  const notes = optStr(data.notes, 4000) && data.notes ? String(data.notes).trim() : "";
  const author = optStr(data.author, 50) && data.author ? String(data.author).trim() : "";
  const email = optStr(data.email, 200) && data.email ? String(data.email).trim() : "";

  const quota = await checkVoiceQuota(env, email);
  if (!quota.ok) return json({ error: quota.reason }, 403, headers);

  if (env.AI_RATE_LIMITER) {
    const actor = request.headers.get("cf-connecting-ip") || "anonymous";
    const limited = await env.AI_RATE_LIMITER.limit({ key: actor });
    if (!limited.success) return json({ error: "rate_limited" }, 429, headers);
  }

  const result = await organizeTextIntoBlocks(env, text, notes);
  if (result.error) return json({ error: result.error }, 502, headers);
  const created = await saveOrganizedBlocks(env, tripId, date, result.blocks, author);

  await saveVoiceTranscript(env, tripId, date, text);
  await env.DB.prepare("UPDATE trips SET updated_at = ? WHERE id = ?").bind(nowIso(), tripId).run();
  await consumeVoiceQuota(env, quota.email, quota.via);
  return json({ blocks: created, transcript: text }, 200, headers);
}

// 「複数日をまとめて記録する」（DAY30〜）：createBlocksFromVoice/createBlocksFromTextと
// 違って特定の日タブに紐づかない（日付ではなく旅行そのものに対する呼び出し）ため、
// 旅行の開始日〜終了日をtripDateListで求め、AI自身にBlockごとの日も判定させる。
// 文字起こしの保存（saveVoiceTranscript）はどの日の下に出すべきか一意に決まらないため、
// 複数日モードでは行わない（1日固定のときだけの機能のまま）。
const MAX_MULTI_DAY_TEXT_CHARS = 8000;

async function createBlocksFromVoiceMultiDay(tripId, request, env, headers) {
  if (!env.OPENAI_API_KEY) return json({ error: "server_not_configured" }, 503, headers);
  const trip = await env.DB.prepare("SELECT start_date, end_date FROM trips WHERE id = ?").bind(tripId).first();
  if (!trip) return json({ error: "trip_not_found" }, 404, headers);
  const dates = tripDateList(trip.start_date, trip.end_date);
  if (dates.length < 2) return json({ error: "trip_dates_required" }, 400, headers);

  const { buf, contentType, getHeader } = await readBinaryBody(request);
  const format = VOICE_AUDIO_FORMATS[contentType];
  if (!format) return json({ error: "unsupported_type" }, 415, headers);

  if (buf.byteLength === 0 || buf.byteLength > MAX_VOICE_AUDIO_BYTES) return json({ error: "invalid_size" }, 413, headers);

  const meta = decodeVoiceMeta(getHeader("x-voice-meta"));
  const notes = optStr(meta.notes, 4000) && meta.notes ? String(meta.notes).trim() : "";
  const author = optStr(meta.author, 50) && meta.author ? String(meta.author).trim() : "";
  const email = optStr(meta.email, 200) && meta.email ? String(meta.email).trim() : "";

  const quota = await checkVoiceQuota(env, email);
  if (!quota.ok) return json({ error: quota.reason }, 403, headers);

  if (env.AI_RATE_LIMITER) {
    const actor = request.headers.get("cf-connecting-ip") || "anonymous";
    const limited = await env.AI_RATE_LIMITER.limit({ key: actor });
    if (!limited.success) return json({ error: "rate_limited" }, 429, headers);
  }

  const transcript = await transcribeAudio(env, buf, contentType, format);
  if (!transcript) return json({ error: "transcription_failed" }, 502, headers);
  if (!transcript.length) return json({ error: "empty_transcript" }, 422, headers);

  const result = await organizeTextIntoBlocks(env, transcript, notes, dates);
  if (result.error) return json({ error: result.error }, 502, headers);
  const created = await saveOrganizedBlocks(env, tripId, dates, result.blocks, author);

  await env.DB.prepare("UPDATE trips SET updated_at = ? WHERE id = ?").bind(nowIso(), tripId).run();
  await consumeVoiceQuota(env, quota.email, quota.via);
  return json({ blocks: created, transcript }, 200, headers);
}

async function createBlocksFromTextMultiDay(tripId, request, env, headers) {
  if (!env.OPENAI_API_KEY) return json({ error: "server_not_configured" }, 503, headers);
  const trip = await env.DB.prepare("SELECT start_date, end_date FROM trips WHERE id = ?").bind(tripId).first();
  if (!trip) return json({ error: "trip_not_found" }, 404, headers);
  const dates = tripDateList(trip.start_date, trip.end_date);
  if (dates.length < 2) return json({ error: "trip_dates_required" }, 400, headers);

  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  const text = isStr(data.text, MAX_MULTI_DAY_TEXT_CHARS) ? data.text.trim() : "";
  if (!text) return json({ error: "empty_text" }, 422, headers);
  const notes = optStr(data.notes, 4000) && data.notes ? String(data.notes).trim() : "";
  const author = optStr(data.author, 50) && data.author ? String(data.author).trim() : "";
  const email = optStr(data.email, 200) && data.email ? String(data.email).trim() : "";

  const quota = await checkVoiceQuota(env, email);
  if (!quota.ok) return json({ error: quota.reason }, 403, headers);

  if (env.AI_RATE_LIMITER) {
    const actor = request.headers.get("cf-connecting-ip") || "anonymous";
    const limited = await env.AI_RATE_LIMITER.limit({ key: actor });
    if (!limited.success) return json({ error: "rate_limited" }, 429, headers);
  }

  const result = await organizeTextIntoBlocks(env, text, notes, dates);
  if (result.error) return json({ error: result.error }, 502, headers);
  const created = await saveOrganizedBlocks(env, tripId, dates, result.blocks, author);

  await env.DB.prepare("UPDATE trips SET updated_at = ? WHERE id = ?").bind(nowIso(), tripId).run();
  await consumeVoiceQuota(env, quota.email, quota.via);
  return json({ blocks: created, transcript: text }, 200, headers);
}

// ---------- レシート読み取り（AI/Vision） ----------
// レシート・領収書の写真をAIに読み取らせ、費用明細（品目名・金額）の候補を返すだけの
// エンドポイント。何も保存はせず、返した内訳は記録編集画面の費用明細欄にそのまま追加され、
// 本人が確認・修正してから「保存」を押すまでは確定しない（レシート内容の読み取り誤りが
// そのままDBに残らないようにするため）。利用回数は音声入力・テキストメモと同じ枠を消費する。
const MAX_RECEIPT_IMAGE_BYTES = 6 * 1024 * 1024; // 圧縮後を想定した上限（クライアント側で圧縮してから送る）

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function receiptPrompt() {
  return [
    "あなたは旅行記録アプリのアシスタントです。添付されたレシート・領収書の写真を読み取り、",
    "費用の内訳（品目名と金額）を配列で返してください。",
    "",
    "ルール：",
    "- 各品目の金額は、税込みの実際の支払額を整数円で入れること",
    "- 個々の品目を読み分けられない場合は、「合計」などの品目名で1件にまとめてよい",
    "- 割引・値引きの行がある場合は、金額をマイナスにして1件の品目として入れること",
    "- レシートに書かれていない品目や金額を推測で作らないこと。写真が不鮮明で読み取れない場合は、読み取れた範囲だけを返すこと",
    "- 店名・日付など、品目名と金額以外の情報は含めないこと",
  ].join("\n");
}

function receiptItemsSchema() {
  return {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            amount: { type: "integer" },
          },
          required: ["label", "amount"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  };
}

async function scanReceipt(request, env, headers) {
  if (!env.OPENAI_API_KEY) return json({ error: "server_not_configured" }, 503, headers);
  const { buf, contentType, getHeader } = await readBinaryBody(request);
  if (!Object.prototype.hasOwnProperty.call(IMAGE_EXT, contentType)) return json({ error: "unsupported_type" }, 415, headers);
  if (buf.byteLength === 0 || buf.byteLength > MAX_RECEIPT_IMAGE_BYTES) return json({ error: "invalid_size" }, 413, headers);

  const meta = decodeVoiceMeta(getHeader("x-receipt-meta"));
  const email = optStr(meta.email, 200) && meta.email ? String(meta.email).trim() : "";

  // プラン・回数券の確認（音声入力・テキストメモと同じ枠。docs/adr/0004）
  const quota = await checkVoiceQuota(env, email);
  if (!quota.ok) return json({ error: quota.reason }, 403, headers);

  if (env.AI_RATE_LIMITER) {
    const actor = request.headers.get("cf-connecting-ip") || "anonymous";
    const limited = await env.AI_RATE_LIMITER.limit({ key: actor });
    if (!limited.success) return json({ error: "rate_limited" }, 429, headers);
  }

  const base64 = arrayBufferToBase64(buf);
  const upstream = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5.6-sol",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: receiptPrompt() },
            { type: "input_image", image_url: `data:${contentType};base64,${base64}` },
          ],
        },
      ],
      reasoning: { effort: "medium" },
      max_output_tokens: 1500,
      store: false,
      text: { format: { type: "json_schema", name: "receipt_items", strict: true, schema: receiptItemsSchema() } },
    }),
  });
  if (!upstream.ok) {
    const errorBody = await upstream.text().catch(() => "");
    console.error(JSON.stringify({ event: "openai_receipt_error", status: upstream.status, body: errorBody.slice(0, 500) }));
    return json({ error: "upstream_error" }, 502, headers);
  }
  const response = await upstream.json();
  let parsed;
  try {
    parsed = JSON.parse(outputText(response));
  } catch {
    return json({ error: "invalid_model_output" }, 502, headers);
  }
  if (!parsed || !Array.isArray(parsed.items)) return json({ error: "invalid_model_output" }, 502, headers);

  await consumeVoiceQuota(env, quota.email, quota.via);
  return json({ items: parsed.items }, 200, headers);
}

// ---------- 一時的な復旧処理（2026-09-15、entriesテーブルが誤って消えた事故対応） ----------
// 保存済みの文字起こし（day_infos.voice_transcript）をもう一度AIに読ませて予定＋記録を
// 作り直し、「記録が0件の既存Block」に記録を差し戻す。新しいBlockは作らない
// （既存のBlockとタイトル・カテゴリ・並び順は無事なため）。
// AIは同じ内容でも毎回少し違う言い回しでlabelを作る（例：「新宿集合」→「新宿に集合する」）ため
// label文字列の一致では対応づけられない。文字起こし1回分（segment）は話した順番どおりに
// Blockを作っているはずなので、代わりに「そのsegmentで作られた件数ぶん、未記録Blockを
// 古い順（＝話した順）から取って、順番で対応づける」方式にする。
// 使い終わったら/admin/recover-entriesルートごと削除する。
async function recoverEntriesForDay(env, tripId, date) {
  const dayInfo = await env.DB.prepare("SELECT voice_transcript FROM day_infos WHERE id = ?").bind(tripId + "_" + date).first();
  if (!dayInfo || !dayInfo.voice_transcript) return { date, matched: [], unmatched: [], error: "no_transcript" };

  const { results: blockRows } = await env.DB.prepare(
    "SELECT * FROM blocks WHERE trip_id = ? AND date = ? ORDER BY created_at ASC"
  ).bind(tripId, date).all();
  const existingEntryRows = blockRows.length
    ? await selectWhereIn(env, "SELECT block_id FROM entries WHERE block_id IN (", blockRows.map((b) => b.id), ")")
    : [];
  const blocksWithEntries = new Set(existingEntryRows.map((r) => r.block_id));
  const pool = blockRows.filter((b) => !blocksWithEntries.has(b.id));

  const segments = dayInfo.voice_transcript.split(/\n\n---\n\n/).map((s) => s.trim()).filter(Boolean);
  const matched = [];
  const unmatched = [];
  let poolIndex = 0;

  for (const segment of segments) {
    const upstream = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || "gpt-5.6-sol",
        input: voicePrompt(segment, ""),
        reasoning: { effort: "medium" },
        max_output_tokens: 2000,
        store: false,
        text: { format: { type: "json_schema", name: "voice_blocks", strict: true, schema: voiceBlocksSchema() } },
      }),
    });
    if (!upstream.ok) { unmatched.push({ reason: "upstream_error", segment: segment.slice(0, 80) }); continue; }
    const response = await upstream.json();
    let parsed;
    try { parsed = JSON.parse(outputText(response)); } catch { parsed = null; }
    if (!parsed || !Array.isArray(parsed.blocks)) { unmatched.push({ reason: "invalid_model_output", segment: segment.slice(0, 80) }); continue; }

    const items = parsed.blocks.filter((b) => b && typeof b === "object" && isStr(b.label, 200) && b.label.trim());
    const slice = pool.slice(poolIndex, poolIndex + items.length);

    for (let i = 0; i < slice.length; i++) {
      const target = slice[i];
      const b = items[i];
      const entryData = (b.entry && typeof b.entry === "object") ? b.entry : {};
      const episode = isStr(entryData.episode, 4000) ? entryData.episode.trim() : "";
      const mapUrl = optUrl(entryData.mapUrl, 500) ? (entryData.mapUrl || "") : "";
      const shopUrl = optUrl(entryData.shopUrl, 500) ? (entryData.shopUrl || "") : "";
      const costItems = Array.isArray(entryData.costItems)
        ? entryData.costItems.filter((c) => c && isStr(c.label, 100) && Number.isFinite(c.amount) && c.amount >= 0)
          .map((c) => ({ label: c.label.trim(), amount: c.amount }))
        : [];
      const t = nowIso();
      await env.DB.prepare(
        `INSERT INTO entries (id, block_id, episode, comment, detail, photo_ids, video_ids, cost_items, wait_time, map_url, shop_url, author, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
        .bind(uid("ent"), target.id, episode, "", "", "[]", "[]", JSON.stringify(costItems), "", mapUrl, shopUrl, "", t, t)
        .run();
      matched.push({ blockId: target.id, blockLabel: target.label, regeneratedLabel: b.label.trim(), episode });
    }
    for (let i = slice.length; i < items.length; i++) {
      unmatched.push({ reason: "no_block_left", label: items[i].label.trim() });
    }
    poolIndex += slice.length;
  }

  return { date, matched, unmatched, stillEmpty: pool.slice(poolIndex).map((b) => ({ blockId: b.id, label: b.label })) };
}

async function handleRecoverEntries(request, env, headers) {
  if (!env.RECOVERY_ADMIN_KEY || request.headers.get("x-recovery-key") !== env.RECOVERY_ADMIN_KEY) {
    return json({ error: "forbidden" }, 403, headers);
  }
  if (!env.OPENAI_API_KEY) return json({ error: "server_not_configured" }, 503, headers);
  let data;
  try { data = await request.json(); } catch { return json({ error: "invalid_json" }, 400, headers); }
  const tripId = optStr(data.tripId, 100) ? data.tripId : "";
  if (!tripId) return json({ error: "invalid_input" }, 400, headers);
  const trip = await env.DB.prepare("SELECT id FROM trips WHERE id = ?").bind(tripId).first();
  if (!trip) return json({ error: "trip_not_found" }, 404, headers);
  const dates = Array.isArray(data.dates) ? data.dates.filter((d) => DATE_RE.test(d)) : [];
  if (!dates.length) return json({ error: "invalid_input" }, 400, headers);

  const results = [];
  for (const date of dates) {
    results.push(await recoverEntriesForDay(env, tripId, date));
  }
  return json({ tripId, results }, 200, headers);
}

// 文字起こしをその日のDayInfoに保存する。同じ日に複数回話した場合は追記する
// （天気・場所とは独立したフィールドなので、DayInfoが無ければ最小限の行を作る）。
async function saveVoiceTranscript(env, tripId, date, transcript) {
  const id = tripId + "_" + date;
  const t = nowIso();
  const existing = await env.DB.prepare("SELECT voice_transcript FROM day_infos WHERE id = ?").bind(id).first();
  if (existing) {
    const merged = existing.voice_transcript ? existing.voice_transcript + "\n\n---\n\n" + transcript : transcript;
    await env.DB.prepare("UPDATE day_infos SET voice_transcript=?, updated_at=? WHERE id=?").bind(merged, t, id).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO day_infos (id, trip_id, date, place, is_forecast, fetched_at, voice_transcript, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
    )
      .bind(id, tripId, date, "", 0, "", transcript, t, t)
      .run();
  }
}

/* ---------- photos / videos (R2) ---------- */

const MAX_PHOTO_BYTES = 2 * 1024 * 1024; // 圧縮後を想定した上限。無料枠(R2 10GB)を長く保つため。
const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 動画は圧縮しないので大きめの上限にしている。

const IMAGE_EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
const VIDEO_EXT = { "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm" };

// 生のバイナリPOST(ブラウザ版)、またはiOSアプリ(CapacitorHttp)から送られてくる
// JSON({dataBase64, contentType, headers})のどちらでも同じように扱えるようにする。
// iOSアプリ内ではWKWebViewのfetchでバイナリボディを直接送るとクロスオリジンPOSTが
// 失敗する既知の制約があるため、アプリ側はbase64化してJSONで送ってくる。
async function readBinaryBody(request) {
  const requestContentType = (request.headers.get("content-type") || "").split(";")[0].trim();
  if (requestContentType === "application/json") {
    const data = await request.json();
    const binary = atob(String(data.dataBase64 || ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const sentHeaders = (data.headers && typeof data.headers === "object") ? data.headers : {};
    return {
      buf: bytes.buffer,
      contentType: String(data.contentType || "").split(";")[0].trim(),
      getHeader: (name) => sentHeaders[name] ?? sentHeaders[name.toLowerCase()] ?? null,
    };
  }
  return {
    buf: await request.arrayBuffer(),
    contentType: requestContentType,
    getHeader: (name) => request.headers.get(name),
  };
}

async function uploadPhoto(request, env, headers) {
  const { buf, contentType } = await readBinaryBody(request);
  const isImage = Object.prototype.hasOwnProperty.call(IMAGE_EXT, contentType);
  const isVideo = Object.prototype.hasOwnProperty.call(VIDEO_EXT, contentType);
  if (!isImage && !isVideo) {
    return json({ error: "unsupported_type" }, 415, headers);
  }
  const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_PHOTO_BYTES;
  if (buf.byteLength === 0 || buf.byteLength > maxBytes) {
    return json({ error: "invalid_size" }, 413, headers);
  }
  const id = uid("photo") + (isVideo ? VIDEO_EXT[contentType] : IMAGE_EXT[contentType]);
  await env.PHOTOS_BUCKET.put(id, buf, { httpMetadata: { contentType } });
  return json({ id, url: `/photos/${id}` }, 201, headers);
}

async function getPhoto(id, env, headers) {
  const obj = await env.PHOTOS_BUCKET.get(id);
  if (!obj) return new Response("not found", { status: 404, headers });
  return new Response(obj.body, {
    status: 200,
    headers: {
      ...headers,
      "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

/* ---------- routing ---------- */

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("origin") || "";
    const headers = cors(origin, env.ALLOWED_ORIGIN);
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers });
    // Webhookはブラウザ（Origin付き）ではなくStripeのサーバーから直接叩かれるため対象外。
    // 代わりにstripe-signatureヘッダーの検証（handleStripeWebhook内）で認証する。
    // /admin/recover-entriesも同様にブラウザ以外（curl）から叩くため対象外
    // （代わりにx-recovery-keyヘッダーの検証で認証する。一時的な復旧処理のみ）。
    if (
      !isAllowedOrigin(origin, env.ALLOWED_ORIGIN) &&
      path.indexOf("/photos/") !== 0 &&
      path !== "/billing/webhook" &&
      path !== "/admin/recover-entries"
    ) {
      return json({ error: "origin_not_allowed" }, 403, headers);
    }

    const write = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
    if (write && env.WRITE_RATE_LIMITER) {
      const actor = request.headers.get("cf-connecting-ip") || "anonymous";
      const limited = await env.WRITE_RATE_LIMITER.limit({ key: actor });
      if (!limited.success) return json({ error: "rate_limited" }, 429, headers);
    }

    let m;
    if (method === "POST" && path === "/trips") return createTrip(request, env, headers);
    if (method === "GET" && (m = path.match(/^\/trips\/([^/]+)$/))) return getTrip(m[1], env, headers);
    if (method === "PATCH" && (m = path.match(/^\/trips\/([^/]+)$/))) return updateTrip(m[1], request, env, headers);
    if (method === "DELETE" && (m = path.match(/^\/trips\/([^/]+)$/))) return deleteTrip(m[1], env, headers);

    if (method === "POST" && (m = path.match(/^\/trips\/([^/]+)\/blocks$/))) return createBlock(m[1], request, env, headers);
    if (method === "PATCH" && (m = path.match(/^\/blocks\/([^/]+)$/))) return updateBlock(m[1], request, env, headers);
    if (method === "DELETE" && (m = path.match(/^\/blocks\/([^/]+)$/))) return deleteBlock(m[1], env, headers);
    if (method === "PATCH" && (m = path.match(/^\/trips\/([^/]+)\/days\/([^/]+)\/blocks\/reorder$/))) {
      return reorderBlocks(m[1], m[2], request, env, headers);
    }

    if (method === "POST" && (m = path.match(/^\/blocks\/([^/]+)\/entries$/))) return createEntry(m[1], request, env, headers);
    if (method === "PATCH" && (m = path.match(/^\/entries\/([^/]+)$/))) return updateEntry(m[1], request, env, headers);
    if (method === "PATCH" && (m = path.match(/^\/entries\/([^/]+)\/move$/))) return moveEntry(m[1], request, env, headers);
    if (method === "DELETE" && (m = path.match(/^\/entries\/([^/]+)$/))) return deleteEntry(m[1], env, headers);

    if (method === "PUT" && (m = path.match(/^\/entries\/([^/]+)\/rating$/))) return setRating(m[1], request, env, headers);
    if (method === "DELETE" && (m = path.match(/^\/entries\/([^/]+)\/rating$/))) return deleteRating(m[1], request, env, headers);
    if (method === "GET" && path === "/mylog") {
      return getMyLog((url.searchParams.get("email") || "").trim().toLowerCase(), env, headers);
    }

    if (method === "PUT" && (m = path.match(/^\/trips\/([^/]+)\/days\/([^/]+)$/))) return setDayPlace(m[1], m[2], request, env, headers);
    if (method === "DELETE" && (m = path.match(/^\/trips\/([^/]+)\/days\/([^/]+)$/))) return deleteDayPlace(m[1], m[2], env, headers);
    if (method === "PATCH" && (m = path.match(/^\/trips\/([^/]+)\/days\/([^/]+)\/weather$/))) return setDayWeatherManual(m[1], m[2], request, env, headers);

    if (method === "POST" && path === "/auth/email/send") return sendEmailOtp(request, env, headers);
    if (method === "POST" && path === "/auth/email/verify") return verifyEmailOtp(request, env, headers);

    if (method === "POST" && path === "/accounts/ensure") return ensureAccount(request, env, headers);
    if (method === "POST" && path === "/accounts/delete") return deleteAccount(request, env, headers);
    if (method === "POST" && (m = path.match(/^\/trips\/([^/]+)\/join$/))) return joinTrip(m[1], request, env, headers);

    if (method === "POST" && path === "/billing/checkout") return createCheckoutSession(request, env, headers);
    if (method === "POST" && path === "/billing/portal") return createPortalSession(request, env, headers);
    if (method === "POST" && path === "/billing/webhook") return handleStripeWebhook(request, env, headers);

    if (method === "POST" && path === "/admin/recover-entries") return handleRecoverEntries(request, env, headers);

    if (method === "POST" && (m = path.match(/^\/trips\/([^/]+)\/days\/([^/]+)\/voice-entries$/))) {
      return createBlocksFromVoice(m[1], m[2], request, env, headers);
    }
    if (method === "POST" && (m = path.match(/^\/trips\/([^/]+)\/days\/([^/]+)\/text-entries$/))) {
      return createBlocksFromText(m[1], m[2], request, env, headers);
    }
    // 「複数日をまとめて記録する」：特定の日タブではなく旅行そのものに対して呼ぶ（DAY30〜）
    if (method === "POST" && (m = path.match(/^\/trips\/([^/]+)\/voice-entries$/))) {
      return createBlocksFromVoiceMultiDay(m[1], request, env, headers);
    }
    if (method === "POST" && (m = path.match(/^\/trips\/([^/]+)\/text-entries$/))) {
      return createBlocksFromTextMultiDay(m[1], request, env, headers);
    }

    if (method === "POST" && path === "/photos") return uploadPhoto(request, env, headers);
    if (method === "GET" && (m = path.match(/^\/photos\/([^/]+)$/))) return getPhoto(m[1], env, headers);

    if (method === "POST" && path === "/receipts/scan") return scanReceipt(request, env, headers);

    return json({ error: "not_found" }, 404, headers);
  },
};
