/*
 * たびログ API Worker。
 * 旅行（trip）とその中の時間ごとの記録（episode）をD1に、写真の実体はR2に保存する。
 * ログインの仕組みは持たない。旅行のURL（trip id）を知っている人だけが読み書きできる
 * 「リンクを知っていれば入れる」方式（Googleドキュメントの共有リンクに近い）。
 * 家族・少人数グループでの利用を想定しており、不特定多数への公開は想定していない。
 */

const MAX_JSON_BYTES = 20000;
const CATEGORIES = ["sightseeing", "food", "lodging", "transport", "other"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const URL_RE = /^https?:\/\/\S+$/;

function cors(origin, allowed) {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "");
  const ok = origin === allowed || local;
  return {
    "access-control-allow-origin": ok ? origin : allowed,
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
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
  return true;
}

function rowToTrip(row) {
  return {
    id: row.id,
    title: row.title,
    startDate: row.start_date,
    endDate: row.end_date,
    companions: JSON.parse(row.companions || "[]"),
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
    cover_photo_id: "",
    created_at: t,
    updated_at: t,
  };
  await env.DB.prepare(
    "INSERT INTO trips (id, title, start_date, end_date, companions, cover_photo_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(trip.id, trip.title, trip.start_date, trip.end_date, trip.companions, trip.cover_photo_id, trip.created_at, trip.updated_at)
    .run();
  return json(rowToTrip(trip), 201, headers);
}

async function getTrip(id, env, headers) {
  const tripRow = await env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(id).first();
  if (!tripRow) return json({ error: "not_found" }, 404, headers);
  const { results } = await env.DB.prepare(
    "SELECT * FROM episodes WHERE trip_id = ? ORDER BY date ASC, time ASC, created_at ASC"
  )
    .bind(id)
    .all();
  return json(
    { trip: rowToTrip(tripRow), episodes: results.map(rowToEpisode) },
    200,
    headers
  );
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
    updated_at: nowIso(),
  };
  await env.DB.prepare(
    "UPDATE trips SET title=?, start_date=?, end_date=?, companions=?, cover_photo_id=?, updated_at=? WHERE id=?"
  )
    .bind(next.title, next.start_date, next.end_date, next.companions, next.cover_photo_id, next.updated_at, id)
    .run();
  const updated = await env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(id).first();
  return json(rowToTrip(updated), 200, headers);
}

async function deleteTrip(id, env, headers) {
  await env.DB.prepare("DELETE FROM episodes WHERE trip_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM trips WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, headers);
}

/* ---------- episodes ---------- */

function validEpisodeInput(x) {
  if (!x || typeof x !== "object") return false;
  if (x.date !== undefined && x.date !== "" && !DATE_RE.test(x.date)) return false;
  if (x.time !== undefined && x.time !== "" && !TIME_RE.test(x.time)) return false;
  if (!optStr(x.title, 200)) return false;
  if (!optStr(x.note, 4000)) return false;
  if (x.category !== undefined && !CATEGORIES.includes(x.category)) return false;
  if (!optStr(x.placeName, 200)) return false;
  if (!optUrl(x.mapUrl, 500)) return false;
  if (!optUrl(x.infoUrl, 500)) return false;
  if (!optStr(x.bookingSite, 100)) return false;
  if (x.cost !== undefined && x.cost !== null && (!Number.isInteger(x.cost) || x.cost < 0 || x.cost > 10000000)) return false;
  if (x.rating !== undefined && x.rating !== null && (!Number.isInteger(x.rating) || x.rating < 1 || x.rating > 5)) return false;
  if (!optStr(x.groupTag, 50)) return false;
  if (!optStr(x.author, 50)) return false;
  if (x.photoIds !== undefined) {
    if (!Array.isArray(x.photoIds) || x.photoIds.length > 20) return false;
    if (!x.photoIds.every((p) => typeof p === "string" && p.length <= 80)) return false;
  }
  return true;
}

function rowToEpisode(row) {
  return {
    id: row.id,
    tripId: row.trip_id,
    date: row.date,
    time: row.time,
    title: row.title,
    note: row.note,
    category: row.category,
    placeName: row.place_name,
    mapUrl: row.map_url,
    infoUrl: row.info_url,
    bookingSite: row.booking_site,
    cost: row.cost === null || row.cost === undefined ? null : row.cost,
    rating: row.rating === null || row.rating === undefined ? null : row.rating,
    groupTag: row.group_tag,
    author: row.author,
    photoIds: JSON.parse(row.photo_ids || "[]"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createEpisode(tripId, request, env, headers) {
  const trip = await env.DB.prepare("SELECT id FROM trips WHERE id = ?").bind(tripId).first();
  if (!trip) return json({ error: "trip_not_found" }, 404, headers);
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  if (!validEpisodeInput(data)) return json({ error: "invalid_input" }, 400, headers);
  const t = nowIso();
  const row = {
    id: uid("ep"),
    trip_id: tripId,
    date: data.date || "",
    time: data.time || "",
    title: (data.title || "").trim(),
    note: (data.note || "").trim(),
    category: data.category || "sightseeing",
    place_name: (data.placeName || "").trim(),
    map_url: data.mapUrl || "",
    info_url: data.infoUrl || "",
    booking_site: (data.bookingSite || "").trim(),
    cost: data.cost === undefined ? null : data.cost,
    rating: data.rating === undefined ? null : data.rating,
    group_tag: (data.groupTag || "").trim(),
    author: (data.author || "").trim(),
    photo_ids: JSON.stringify(data.photoIds || []),
    created_at: t,
    updated_at: t,
  };
  await env.DB.prepare(
    `INSERT INTO episodes (id, trip_id, date, time, title, note, category, place_name, map_url, info_url, booking_site, cost, rating, group_tag, author, photo_ids, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      row.id, row.trip_id, row.date, row.time, row.title, row.note, row.category, row.place_name,
      row.map_url, row.info_url, row.booking_site, row.cost, row.rating, row.group_tag, row.author,
      row.photo_ids, row.created_at, row.updated_at
    )
    .run();
  await env.DB.prepare("UPDATE trips SET updated_at = ? WHERE id = ?").bind(t, tripId).run();
  return json(rowToEpisode(row), 201, headers);
}

async function updateEpisode(id, request, env, headers) {
  const existing = await env.DB.prepare("SELECT * FROM episodes WHERE id = ?").bind(id).first();
  if (!existing) return json({ error: "not_found" }, 404, headers);
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  if (!validEpisodeInput(data)) return json({ error: "invalid_input" }, 400, headers);
  const cur = rowToEpisode(existing);
  const merged = { ...cur, ...data };
  const t = nowIso();
  await env.DB.prepare(
    `UPDATE episodes SET date=?, time=?, title=?, note=?, category=?, place_name=?, map_url=?, info_url=?, booking_site=?, cost=?, rating=?, group_tag=?, author=?, photo_ids=?, updated_at=? WHERE id=?`
  )
    .bind(
      merged.date || "", merged.time || "", (merged.title || "").trim(), (merged.note || "").trim(),
      merged.category || "sightseeing", (merged.placeName || "").trim(), merged.mapUrl || "", merged.infoUrl || "",
      (merged.bookingSite || "").trim(), merged.cost ?? null, merged.rating ?? null,
      (merged.groupTag || "").trim(), (merged.author || "").trim(), JSON.stringify(merged.photoIds || []), t, id
    )
    .run();
  const updated = await env.DB.prepare("SELECT * FROM episodes WHERE id = ?").bind(id).first();
  return json(rowToEpisode(updated), 200, headers);
}

async function deleteEpisode(id, env, headers) {
  await env.DB.prepare("DELETE FROM episodes WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, headers);
}

/* ---------- photos (R2) ---------- */

const MAX_PHOTO_BYTES = 2 * 1024 * 1024; // 圧縮後を想定した上限。無料枠(R2 10GB)を長く保つため。

async function uploadPhoto(request, env, headers) {
  const contentType = request.headers.get("content-type") || "image/jpeg";
  if (!/^image\/(jpeg|png|webp)$/.test(contentType)) {
    return json({ error: "unsupported_type" }, 415, headers);
  }
  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0 || buf.byteLength > MAX_PHOTO_BYTES) {
    return json({ error: "invalid_size" }, 413, headers);
  }
  const id = uid("photo") + (contentType === "image/png" ? ".png" : contentType === "image/webp" ? ".webp" : ".jpg");
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
    if (origin !== env.ALLOWED_ORIGIN && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && path.indexOf("/photos/") !== 0) {
      return json({ error: "origin_not_allowed" }, 403, headers);
    }

    const write = method === "POST" || method === "PATCH" || method === "DELETE";
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
    if (method === "POST" && (m = path.match(/^\/trips\/([^/]+)\/episodes$/))) return createEpisode(m[1], request, env, headers);
    if (method === "PATCH" && (m = path.match(/^\/episodes\/([^/]+)$/))) return updateEpisode(m[1], request, env, headers);
    if (method === "DELETE" && (m = path.match(/^\/episodes\/([^/]+)$/))) return deleteEpisode(m[1], env, headers);
    if (method === "POST" && path === "/photos") return uploadPhoto(request, env, headers);
    if (method === "GET" && (m = path.match(/^\/photos\/([^/]+)$/))) return getPhoto(m[1], env, headers);

    return json({ error: "not_found" }, 404, headers);
  },
};
