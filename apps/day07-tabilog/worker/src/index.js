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

function cors(origin, allowed) {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "");
  const ok = origin === allowed || local;
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

function validCostItems(x) {
  if (x === undefined) return true;
  if (!Array.isArray(x) || x.length > 30) return false;
  return x.every((it) =>
    it && typeof it === "object"
    && isStr(it.label, 60)
    && Number.isInteger(it.amount) && it.amount >= 0 && it.amount <= 1000000
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
  const { results: blockRows } = await env.DB.prepare(
    "SELECT * FROM blocks WHERE trip_id = ? ORDER BY date ASC, time ASC, created_at ASC"
  )
    .bind(id)
    .all();
  const { results: entryRows } = blockRows.length
    ? await env.DB.prepare(
        `SELECT * FROM entries WHERE block_id IN (${blockRows.map(() => "?").join(",")}) ORDER BY created_at ASC`
      )
        .bind(...blockRows.map((b) => b.id))
        .all()
    : { results: [] };
  const entryIds = entryRows.map((r) => r.id);
  const ratingsByEntry = {};
  if (entryIds.length) {
    const { results: ratingRows } = await env.DB.prepare(
      `SELECT * FROM ratings WHERE entry_id IN (${entryIds.map(() => "?").join(",")})`
    )
      .bind(...entryIds)
      .all();
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

/* ---------- entries（小項目） ---------- */

function validEntryInput(x) {
  if (!x || typeof x !== "object") return false;
  if (!optStr(x.episode, 4000)) return false;
  if (!optStr(x.comment, 300)) return false;
  if (!optStr(x.detail, 4000)) return false;
  if (!validCostItems(x.costItems)) return false;
  if (!optStr(x.waitTime, 50)) return false;
  if (!optUrl(x.mapUrl, 500)) return false;
  if (!optUrl(x.shopUrl, 500)) return false;
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
    mapUrl: row.map_url,
    shopUrl: row.shop_url,
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
    map_url: data.mapUrl || "",
    shop_url: data.shopUrl || "",
    author: (data.author || "").trim(),
    created_at: t,
    updated_at: t,
  };
  await env.DB.prepare(
    `INSERT INTO entries (id, block_id, episode, comment, detail, photo_ids, video_ids, cost_items, wait_time, map_url, shop_url, author, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      row.id, row.block_id, row.episode, row.comment, row.detail, row.photo_ids, row.video_ids,
      row.cost_items, row.wait_time, row.map_url, row.shop_url, row.author, row.created_at, row.updated_at
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
    `UPDATE entries SET episode=?, comment=?, detail=?, photo_ids=?, video_ids=?, cost_items=?, wait_time=?, map_url=?, shop_url=?, author=?, updated_at=? WHERE id=?`
  )
    .bind(
      (merged.episode || "").trim(), (merged.comment || "").trim(), (merged.detail || "").trim(),
      JSON.stringify(merged.photoIds || []), JSON.stringify(merged.videoIds || []),
      JSON.stringify(merged.costItems || []), (merged.waitTime || "").trim(),
      merged.mapUrl || "", merged.shopUrl || "", (merged.author || "").trim(), t, id
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

/* ---------- ratings（評価） ----------
 * ログイン必須の機能。rater_email はクライアントが送ってきた値をそのまま信用する
 * （サーバー側でトークン検証はしない、このアプリ全体と同じ簡易的な仕組み）。
 * 1つのentryに、raterEmailごとに1件だけ評価を持てる（UNIQUE制約でupsert）。
 */

function validRatingInput(x) {
  if (!x || typeof x !== "object") return false;
  if (!isStr(x.raterEmail, 200) || x.raterEmail.trim().length < 3) return false;
  if (!optStr(x.raterName, 100)) return false;
  if (!Number.isInteger(x.score) || x.score < 1 || x.score > 5) return false;
  return true;
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
  const t = nowIso();
  if (existing) {
    await env.DB.prepare("UPDATE ratings SET score=?, rater_name=?, updated_at=? WHERE id=?")
      .bind(data.score, name, t, existing.id)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO ratings (id, entry_id, rater_email, rater_name, score, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
    )
      .bind(uid("rat"), entryId, email, name, data.score, t, t)
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
  if (account) {
    const { results: tripRows } = await env.DB.prepare(
      `SELECT t.* FROM trip_members m JOIN trips t ON t.id = m.trip_id
       WHERE m.account_id = ? ORDER BY t.start_date DESC, t.created_at DESC`
    )
      .bind(account.account_id)
      .all();
    trips = tripRows.map(rowToTrip);
  }

  return json({ items, trips }, 200, headers);
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
    weatherCode: row.weather_code,
    tempMax: row.temp_max,
    tempMin: row.temp_min,
    precipSum: row.precip_sum,
    isForecast: !!row.is_forecast,
    fetchedAt: row.fetched_at,
  };
}

async function geocodePlace(place) {
  const url = "https://geocoding-api.open-meteo.com/v1/search?count=1&language=ja&format=json&name=" + encodeURIComponent(place);
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const first = data && data.results && data.results[0];
  if (!first) return null;
  return { lat: first.latitude, lon: first.longitude };
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
    weather_code: weather ? weather.weatherCode : null,
    temp_max: weather ? weather.tempMax : null,
    temp_min: weather ? weather.tempMin : null,
    precip_sum: weather ? weather.precipSum : null,
    is_forecast: weather && weather.isForecast ? 1 : 0,
    fetched_at: weather ? t : "",
  };
  if (existing) {
    await env.DB.prepare(
      "UPDATE day_infos SET place=?, lat=?, lon=?, weather_code=?, temp_max=?, temp_min=?, precip_sum=?, is_forecast=?, fetched_at=?, updated_at=? WHERE id=?"
    )
      .bind(row.place, row.lat, row.lon, row.weather_code, row.temp_max, row.temp_min, row.precip_sum, row.is_forecast, row.fetched_at, t, id)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO day_infos (id, trip_id, date, place, lat, lon, weather_code, temp_max, temp_min, precip_sum, is_forecast, fetched_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )
      .bind(id, tripId, date, row.place, row.lat, row.lon, row.weather_code, row.temp_max, row.temp_min, row.precip_sum, row.is_forecast, row.fetched_at, t, t)
      .run();
  }
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

function rowToAccount(row) {
  return { accountId: row.account_id, email: row.email, name: row.name };
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
      await env.DB.prepare(
        "INSERT INTO accounts (email, account_id, name, created_at, updated_at) VALUES (?,?,?,?,?)"
      )
        .bind(email, accountId, name || "", t, t)
        .run();
      return { email, account_id: accountId, name: name || "", created_at: t, updated_at: t };
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
  const account = await getOrCreateAccount(env, email, name);
  return json(rowToAccount(account), 200, headers);
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
const MAX_VOICE_AUDIO_BYTES = 15 * 1024 * 1024; // 数分の音声を想定した上限
const VOICE_AUDIO_FORMATS = { "audio/webm": "webm", "audio/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg" };

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
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

function voicePrompt(notes) {
  return [
    "あなたは旅行記録アプリのアシスタントです。旅行者がその日の出来事をまとめて話した音声を聞いて、",
    "予定（Block）とその記録（Entry）の配列に分割してください。",
    "",
    "ルール：",
    "- 話された順番のとおりに配列を並べること",
    "- 1つの出来事・場所ごとに1つのBlockを作ること",
    "- categoryは次のいずれか一つ: sightseeing（観光）, food（食事）, lodging（宿泊）, transport（移動）, other（その他）",
    "- labelは短い見出し（例：「ダイヤモンドヘッドに登る」）にすること",
    "- entry.episodeには、話した内容をもとにした2〜3文程度の説明を書くこと（話していないことを推測で付け加えない）",
    "- 評価・費用など、話されていない情報は絶対に作らないこと",
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
            entry: {
              type: "object",
              properties: {
                episode: { type: "string" },
                mapUrl: { type: "string" },
                shopUrl: { type: "string" },
              },
              required: ["episode", "mapUrl", "shopUrl"],
              additionalProperties: false,
            },
          },
          required: ["label", "category", "entry"],
          additionalProperties: false,
        },
      },
    },
    required: ["blocks"],
    additionalProperties: false,
  };
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

async function createBlocksFromVoice(tripId, date, request, env, headers) {
  if (!env.OPENAI_API_KEY) return json({ error: "server_not_configured" }, 503, headers);
  if (!DATE_RE.test(date)) return json({ error: "invalid_date" }, 400, headers);
  const trip = await env.DB.prepare("SELECT id FROM trips WHERE id = ?").bind(tripId).first();
  if (!trip) return json({ error: "trip_not_found" }, 404, headers);

  if (env.AI_RATE_LIMITER) {
    const actor = request.headers.get("cf-connecting-ip") || "anonymous";
    const limited = await env.AI_RATE_LIMITER.limit({ key: actor });
    if (!limited.success) return json({ error: "rate_limited" }, 429, headers);
  }

  const contentType = (request.headers.get("content-type") || "").split(";")[0].trim();
  const format = VOICE_AUDIO_FORMATS[contentType];
  if (!format) return json({ error: "unsupported_type" }, 415, headers);

  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0 || buf.byteLength > MAX_VOICE_AUDIO_BYTES) return json({ error: "invalid_size" }, 413, headers);

  const meta = decodeVoiceMeta(request.headers.get("x-voice-meta"));
  const notes = optStr(meta.notes, 4000) && meta.notes ? String(meta.notes).trim() : "";
  const author = optStr(meta.author, 50) && meta.author ? String(meta.author).trim() : "";

  const audioBase64 = arrayBufferToBase64(buf);

  const upstream = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5.6-sol",
      input: [{
        role: "user",
        content: [
          { type: "input_audio", input_audio: { data: audioBase64, format } },
          { type: "input_text", text: voicePrompt(notes) },
        ],
      }],
      reasoning: { effort: "medium" },
      max_output_tokens: 2000,
      store: false,
      text: { format: { type: "json_schema", name: "voice_blocks", strict: true, schema: voiceBlocksSchema() } },
    }),
  });
  if (!upstream.ok) {
    console.error(JSON.stringify({ event: "openai_error", status: upstream.status }));
    return json({ error: "upstream_error" }, 502, headers);
  }
  const response = await upstream.json();
  let parsed;
  try { parsed = JSON.parse(outputText(response)); }
  catch { return json({ error: "invalid_model_output" }, 502, headers); }
  if (!parsed || !Array.isArray(parsed.blocks)) return json({ error: "invalid_model_output" }, 502, headers);

  const created = [];
  const baseTime = Date.now();
  for (let i = 0; i < parsed.blocks.length; i++) {
    const b = parsed.blocks[i];
    if (!b || typeof b !== "object") continue;
    const label = isStr(b.label, 200) ? b.label.trim() : "";
    if (!label) continue;
    const category = CATEGORIES.includes(b.category) ? b.category : "sightseeing";
    const t = new Date(baseTime + i * 10).toISOString(); // 話した順番で安定して並ぶよう少しずつずらす

    const blockRow = { id: uid("blk"), trip_id: tripId, date, time: "", label, category, created_at: t, updated_at: t };
    await env.DB.prepare(
      "INSERT INTO blocks (id, trip_id, date, time, label, category, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
    )
      .bind(blockRow.id, blockRow.trip_id, blockRow.date, blockRow.time, blockRow.label, blockRow.category, blockRow.created_at, blockRow.updated_at)
      .run();

    const entryData = (b.entry && typeof b.entry === "object") ? b.entry : {};
    const episode = isStr(entryData.episode, 4000) ? entryData.episode.trim() : "";
    const mapUrl = optUrl(entryData.mapUrl, 500) ? (entryData.mapUrl || "") : "";
    const shopUrl = optUrl(entryData.shopUrl, 500) ? (entryData.shopUrl || "") : "";
    const entryRow = {
      id: uid("ent"), block_id: blockRow.id, episode, comment: "", detail: "",
      photo_ids: "[]", video_ids: "[]", cost_items: "[]", wait_time: "",
      map_url: mapUrl, shop_url: shopUrl, author, created_at: t, updated_at: t,
    };
    await env.DB.prepare(
      `INSERT INTO entries (id, block_id, episode, comment, detail, photo_ids, video_ids, cost_items, wait_time, map_url, shop_url, author, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(
        entryRow.id, entryRow.block_id, entryRow.episode, entryRow.comment, entryRow.detail, entryRow.photo_ids,
        entryRow.video_ids, entryRow.cost_items, entryRow.wait_time, entryRow.map_url, entryRow.shop_url,
        entryRow.author, entryRow.created_at, entryRow.updated_at
      )
      .run();

    created.push({ ...rowToBlock(blockRow), entries: [rowToEntry(entryRow)] });
  }

  await env.DB.prepare("UPDATE trips SET updated_at = ? WHERE id = ?").bind(nowIso(), tripId).run();
  return json({ blocks: created }, 200, headers);
}

/* ---------- photos / videos (R2) ---------- */

const MAX_PHOTO_BYTES = 2 * 1024 * 1024; // 圧縮後を想定した上限。無料枠(R2 10GB)を長く保つため。
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 動画は圧縮しないので大きめの上限にしている。

const IMAGE_EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
const VIDEO_EXT = { "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm" };

async function uploadPhoto(request, env, headers) {
  const contentType = request.headers.get("content-type") || "image/jpeg";
  const isImage = Object.prototype.hasOwnProperty.call(IMAGE_EXT, contentType);
  const isVideo = Object.prototype.hasOwnProperty.call(VIDEO_EXT, contentType);
  if (!isImage && !isVideo) {
    return json({ error: "unsupported_type" }, 415, headers);
  }
  const buf = await request.arrayBuffer();
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
    if (origin !== env.ALLOWED_ORIGIN && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && path.indexOf("/photos/") !== 0) {
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

    if (method === "POST" && (m = path.match(/^\/blocks\/([^/]+)\/entries$/))) return createEntry(m[1], request, env, headers);
    if (method === "PATCH" && (m = path.match(/^\/entries\/([^/]+)$/))) return updateEntry(m[1], request, env, headers);
    if (method === "DELETE" && (m = path.match(/^\/entries\/([^/]+)$/))) return deleteEntry(m[1], env, headers);

    if (method === "PUT" && (m = path.match(/^\/entries\/([^/]+)\/rating$/))) return setRating(m[1], request, env, headers);
    if (method === "DELETE" && (m = path.match(/^\/entries\/([^/]+)\/rating$/))) return deleteRating(m[1], request, env, headers);
    if (method === "GET" && path === "/mylog") {
      return getMyLog((url.searchParams.get("email") || "").trim().toLowerCase(), env, headers);
    }

    if (method === "PUT" && (m = path.match(/^\/trips\/([^/]+)\/days\/([^/]+)$/))) return setDayPlace(m[1], m[2], request, env, headers);
    if (method === "DELETE" && (m = path.match(/^\/trips\/([^/]+)\/days\/([^/]+)$/))) return deleteDayPlace(m[1], m[2], env, headers);

    if (method === "POST" && path === "/auth/email/send") return sendEmailOtp(request, env, headers);
    if (method === "POST" && path === "/auth/email/verify") return verifyEmailOtp(request, env, headers);

    if (method === "POST" && path === "/accounts/ensure") return ensureAccount(request, env, headers);
    if (method === "POST" && (m = path.match(/^\/trips\/([^/]+)\/join$/))) return joinTrip(m[1], request, env, headers);

    if (method === "POST" && (m = path.match(/^\/trips\/([^/]+)\/days\/([^/]+)\/voice-entries$/))) {
      return createBlocksFromVoice(m[1], m[2], request, env, headers);
    }

    if (method === "POST" && path === "/photos") return uploadPhoto(request, env, headers);
    if (method === "GET" && (m = path.match(/^\/photos\/([^/]+)$/))) return getPhoto(m[1], env, headers);

    return json({ error: "not_found" }, 404, headers);
  },
};
