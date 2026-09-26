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

import { parseReceiptText } from "./receipt-parse.js";
import {
  s2ToLatLng, extractFeatureS2,
  distanceKm, nearestCandidate, pickNominatimCandidate, placeNameRank, pickWikiHit,
  isValidEntryId, entryNeedsGeocode,
} from "./geo-decode.js";

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
    "access-control-allow-headers": "content-type, x-voice-meta, authorization",
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

/* ---------- セッション（ログインの本人確認。docs/adr/0005） ----------
 * 以前はクライアントが送ってきたメールアドレスをそのまま信用していたため、他人のメールアドレスを
 * 知っていればアカウント削除・支払い管理・評価ができてしまった。メールOTPの確認に成功したときに
 * セッショントークン（推測できない乱数）を発行し、以後は Authorization: Bearer <token> で送ってもらう。
 * DBにはトークンそのものではなくSHA-256のハッシュだけを置く（DBが漏れてもなりすませない）。
 *
 * 審査中・配布済みの古いiOSアプリはトークンを送らないため、当面は「トークンが無ければ従来どおり
 * 送られてきたメールアドレスを使う」。wrangler.jsoncのvarsで REQUIRE_SESSION を "1" にすると
 * トークン必須になる（古いアプリが使われなくなったら切り替える）。いいね・コメントは最初から必須。
 */
const SESSION_DAYS = 180;

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function issueSession(env, email) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const t = nowIso();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?,?,?,?)")
    .bind(await sha256Hex(token), email, t, expires)
    .run();
  return token;
}

function bearerToken(request) {
  const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(request.headers.get("authorization") || "");
  return m ? m[1].toLowerCase() : "";
}

// トークンが有効なら、その本人のメールアドレス。無い・期限切れなら空文字。
async function sessionEmail(request, env) {
  const token = bearerToken(request);
  if (!token) return "";
  const row = await env.DB.prepare("SELECT email, expires_at FROM sessions WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .first();
  if (!row || new Date(row.expires_at).getTime() < Date.now()) return "";
  return row.email;
}

// 操作する本人のメールアドレスを決める。トークンがあればそれが正（送られてきたメールアドレスと
// 食い違えば拒否）。無ければ、strictでなく移行期間中なら送られてきたメールアドレスを使う。
async function resolveEmail(request, env, claimed, strict) {
  claimed = (claimed || "").trim().toLowerCase();
  const email = await sessionEmail(request, env);
  if (email) return claimed && claimed !== email ? { error: "forbidden", status: 403 } : { email };
  if (strict || env.REQUIRE_SESSION === "1" || !claimed) return { error: "login_required", status: 401 };
  return { email: claimed };
}

async function logout(request, env, headers) {
  const token = bearerToken(request);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  return json({ ok: true }, 200, headers);
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

async function updateTrip(id, request, env, headers, ctx) {
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
  // 日程の変更に合わせて予定（blocks）と日ごとの情報（day_infos）を何日ずらすか（2026-09-26）。
  // 何日ずらすかはクライアント（Core.tripScheduleShift）が決め、本人に確かめてから送ってくる。
  let shiftDays = 0;
  if (data.shiftDays !== undefined) {
    if (!Number.isInteger(data.shiftDays) || data.shiftDays === 0 || Math.abs(data.shiftDays) > MAX_SHIFT_DAYS) {
      return json({ error: "invalid_input" }, 400, headers);
    }
    shiftDays = data.shiftDays;
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
  const tripUpdate = env.DB.prepare(
    "UPDATE trips SET title=?, start_date=?, end_date=?, companions=?, cover_photo_id=?, trip_type=?, updated_at=? WHERE id=?"
  ).bind(next.title, next.start_date, next.end_date, next.companions, next.cover_photo_id, next.trip_type, next.updated_at, id);
  if (shiftDays) {
    // 旅行の更新と日付の移動を1つのbatch（D1では1トランザクション）で行い、途中で止まって
    // 予定の半分だけがずれた状態を残さない。
    await env.DB.batch([tripUpdate, ...shiftTripDateStatements(env, id, shiftDays, next.updated_at)]);
    if (ctx) ctx.waitUntil(refetchShiftedWeather(env, id));
  } else {
    await tripUpdate.run();
  }
  const updated = await env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(id).first();
  const out = rowToTrip(updated);
  if (shiftDays) out.shiftedDays = shiftDays;
  return json(out, 200, headers);
}

const MAX_SHIFT_DAYS = 3660;

// 予定（blocks）と日ごとの情報（day_infos）の日付を、まとめてshiftDays日ずらすSQL文の列。
// day_infosはUNIQUE(trip_id, date)・id＝trip_id+"_"+dateなので、そのまま1文でずらすと途中で
// 別の日の行とぶつかる（7日ずらすと、8日目の行が1日目の行の日付に先に入ろうとする）。いったん
// 全行の日付に"#"を付けて退避してから、正しい日付に入れ直す。
// 自動で取った天気は元の日付のものなので消し（refetchShiftedWeatherで取り直す）、本人が手で
// 直した天気（weather_manual=1）・場所・音声の文字起こしは、その旅の「○日目」についてきた記録として残す。
function shiftTripDateStatements(env, tripId, shiftDays, t) {
  const mod = (shiftDays > 0 ? "+" : "") + shiftDays + " days";
  return [
    env.DB.prepare("UPDATE blocks SET date = date(date, ?), updated_at = ? WHERE trip_id = ? AND date != ''")
      .bind(mod, t, tripId),
    env.DB.prepare("UPDATE day_infos SET date = '#' || date, id = id || '#' WHERE trip_id = ?").bind(tripId),
    env.DB.prepare(
      "UPDATE day_infos SET date = date(substr(date, 2), ?), id = trip_id || '_' || date(substr(date, 2), ?), " +
      "weather_code = CASE WHEN weather_manual = 1 THEN weather_code ELSE NULL END, " +
      "temp_max = CASE WHEN weather_manual = 1 THEN temp_max ELSE NULL END, " +
      "temp_min = CASE WHEN weather_manual = 1 THEN temp_min ELSE NULL END, " +
      "precip_sum = CASE WHEN weather_manual = 1 THEN precip_sum ELSE NULL END, " +
      "is_forecast = CASE WHEN weather_manual = 1 THEN is_forecast ELSE 0 END, " +
      "fetched_at = CASE WHEN weather_manual = 1 THEN fetched_at ELSE '' END, " +
      "updated_at = ? WHERE trip_id = ? AND date LIKE '#%'"
    ).bind(mod, mod, t, tripId),
  ];
}

// 日付をずらした日の天気を、新しい日付で取り直す（保存の返事は待たせない。失敗しても天気が空のままになるだけ）。
async function refetchShiftedWeather(env, tripId) {
  const { results } = await env.DB.prepare(
    "SELECT id, date, lat, lon FROM day_infos WHERE trip_id = ? AND weather_manual = 0 AND fetched_at = '' AND lat IS NOT NULL AND lon IS NOT NULL"
  ).bind(tripId).all();
  for (const row of results) {
    const weather = await fetchDailyWeather(row.lat, row.lon, row.date).catch(() => null);
    if (!weather) continue;
    await env.DB.prepare(
      "UPDATE day_infos SET weather_code=?, temp_max=?, temp_min=?, precip_sum=?, is_forecast=?, fetched_at=?, updated_at=? WHERE id=? AND weather_manual = 0 AND fetched_at = ''"
    ).bind(weather.weatherCode, weather.tempMax, weather.tempMin, weather.precipSum, weather.isForecast ? 1 : 0, nowIso(), nowIso(), row.id).run();
  }
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
  await deleteSocialForTrip(env, id);
  await env.DB.prepare("DELETE FROM trips WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, headers);
}

/* ---------- blocks（大項目） ---------- */

// この予定の場所まで、どうやって移動したか（地図でふりかえる演出で使う。v15）。空文字は「未設定＝演出なし」。
const TRANSPORTS = ["", "plane", "car", "taxi", "walk", "train", "bus", "bicycle"];

function validBlockInput(x) {
  if (!x || typeof x !== "object") return false;
  if (x.date !== undefined && x.date !== "" && !DATE_RE.test(x.date)) return false;
  if (x.time !== undefined && x.time !== "" && !TIME_RE.test(x.time)) return false;
  if (!optStr(x.label, 200)) return false;
  if (x.category !== undefined && !CATEGORIES.includes(x.category)) return false;
  if (x.transport !== undefined && !TRANSPORTS.includes(x.transport)) return false;
  // moveMinutes：移動の予定の移動時間（分）。0は未入力（v19）
  if (x.moveMinutes !== undefined && !(Number.isInteger(x.moveMinutes) && x.moveMinutes >= 0 && x.moveMinutes <= 14400)) return false;
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
    transport: row.transport || "",
    moveMinutes: row.move_minutes || 0,
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
    transport: data.transport || "",
    move_minutes: data.moveMinutes || 0,
    created_at: t,
    updated_at: t,
  };
  await env.DB.prepare(
    "INSERT INTO blocks (id, trip_id, date, time, label, category, transport, move_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  )
    .bind(row.id, row.trip_id, row.date, row.time, row.label, row.category, row.transport, row.move_minutes, row.created_at, row.updated_at)
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
    "UPDATE blocks SET date=?, time=?, label=?, category=?, transport=?, move_minutes=?, updated_at=? WHERE id=?"
  )
    .bind(merged.date || "", merged.time || "", (merged.label || "").trim(), merged.category || "sightseeing", merged.transport || "", merged.moveMinutes || 0, t, id)
    .run();
  const updated = await env.DB.prepare("SELECT * FROM blocks WHERE id = ?").bind(id).first();
  return json(rowToBlock(updated), 200, headers);
}

async function deleteBlock(id, env, headers) {
  const { results: entryRows } = await env.DB.prepare("SELECT id FROM entries WHERE block_id = ?").bind(id).all();
  for (const e of entryRows) {
    await env.DB.prepare("DELETE FROM ratings WHERE entry_id = ?").bind(e.id).run();
    await deleteSocialForTarget(env, "entry", e.id);
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

// 移動の予定の記録に持たせる、紹介文（docs/adr/0007）用の事実情報。★の評価とは違い、誰が見ても同じ
// 内容なので、人ごとのレビューではなく記録そのものに持つ。全部任意。
// from/to：区間（ローマ→ロンドン）、company：会社・便名、depart/arrive：出発・到着時刻（HH:MM）、
// amount：金額（円）。所要時間は出発・到着から計算するので持たない。
function validTravel(x) {
  if (x === undefined) return true;
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  if (!optStr(x.from, 60) || !optStr(x.to, 60) || !optStr(x.company, 60)) return false;
  for (const k of ["depart", "arrive"]) {
    if (x[k] !== undefined && x[k] !== "" && !TIME_RE.test(x[k])) return false;
  }
  if (x.amount !== undefined && x.amount !== null && !(Number.isInteger(x.amount) && x.amount >= 0 && x.amount <= 100000000)) return false;
  return true;
}

function cleanTravel(x) {
  if (!x) return {};
  const out = {};
  for (const k of ["from", "to", "company", "depart", "arrive"]) if (x[k]) out[k] = String(x[k]).trim();
  if (Number.isInteger(x.amount)) out.amount = x.amount;
  return out;
}

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
  if (!validTravel(x.travel)) return false;
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
  const entry = {
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
    travel: parseJsonObject(row.travel),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  // 地図の座標（Part A、2026-09-26〜）：map_geocoded_urlが今のmap_urlと同じときだけ返す。
  // 地図のリンクを編集したら一致しなくなり、クライアントは古い座標を使わず調べ直す
  // （entryNeedsGeocodeが同じ判定をサーバー側の裏の再計算のトリガーにも使っている）。
  if (row.map_url && row.map_geocoded_url === row.map_url && typeof row.map_lat === "number" && typeof row.map_lng === "number") {
    entry.mapLat = row.map_lat;
    entry.mapLng = row.map_lng;
  }
  return entry;
}

// 記録の地図URLの座標を裏で求めてD1に保存する（保存の返事を遅らせないため、呼び出し側はctx.waitUntilで包む）。
// 保存が終わった時点でmap_urlがまだ渡した値と同じときだけ書き込む
// （書いている間に別の値へ編集されていたら、古い座標を新しいURLに紐付けてしまわないよう何もしない）。
// 見出し（block.label）は手がかりに使わない（2026-09-26、geocodeMapUrlの注記のとおり）。
async function backgroundGeocodeEntry(env, entryId, mapUrl) {
  if (!mapUrl) return;
  try {
    const result = await geocodeMapUrl(mapUrl, false, [], env);
    if (!result || result.pending || typeof result.lat !== "number" || typeof result.lng !== "number") return;
    await env.DB.prepare(
      "UPDATE entries SET map_lat=?, map_lng=?, map_geocoded_url=?, map_geocoded_at=? WHERE id=? AND map_url=?"
    ).bind(result.lat, result.lng, mapUrl, nowIso(), entryId, mapUrl).run();
  } catch {
    // 裏の処理なので、失敗しても記録の保存自体には影響させない（次の開くタイミングでまた試す）
  }
}

function parseJsonObject(text) {
  try {
    const v = JSON.parse(text || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

async function createEntry(blockId, request, env, headers, ctx) {
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
    travel: JSON.stringify(cleanTravel(data.travel)),
    created_at: t,
    updated_at: t,
  };
  await env.DB.prepare(
    `INSERT INTO entries (id, block_id, episode, comment, detail, photo_ids, video_ids, cost_items, wait_time, time, map_url, shop_url, other_url, author, travel, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      row.id, row.block_id, row.episode, row.comment, row.detail, row.photo_ids, row.video_ids,
      row.cost_items, row.wait_time, row.time, row.map_url, row.shop_url, row.other_url, row.author, row.travel, row.created_at, row.updated_at
    )
    .run();
  // 地図URLが付いていたら、返事を待たせず裏で座標を求めてD1に保存しておく（Part A、2026-09-26〜。
  // 次に「地図でふりかえる」を開いたときはもう探しに行かなくてよい）。
  const newMapUrl = (row.map_url || "").trim();
  if (ctx && newMapUrl) ctx.waitUntil(backgroundGeocodeEntry(env, row.id, newMapUrl));
  return json(rowToEntry(row), 201, headers);
}

async function updateEntry(id, request, env, headers, ctx) {
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
  const newMapUrl = (merged.mapUrl || "").trim();
  await env.DB.prepare(
    `UPDATE entries SET episode=?, comment=?, detail=?, photo_ids=?, video_ids=?, cost_items=?, wait_time=?, time=?, map_url=?, shop_url=?, other_url=?, author=?, travel=?, updated_at=? WHERE id=?`
  )
    .bind(
      (merged.episode || "").trim(), (merged.comment || "").trim(), (merged.detail || "").trim(),
      JSON.stringify(merged.photoIds || []), JSON.stringify(merged.videoIds || []),
      JSON.stringify(merged.costItems || []), (merged.waitTime || "").trim(), merged.time || "",
      newMapUrl, merged.shopUrl || "", merged.otherUrl || "", (merged.author || "").trim(),
      JSON.stringify(cleanTravel(merged.travel)), t, id
    )
    .run();
  // 地図URLが変わった、またはまだ座標を求めていないときだけ、裏で座標を求め直す（Part A）。
  if (ctx && entryNeedsGeocode(existing.map_url, existing.map_geocoded_url, newMapUrl)) {
    ctx.waitUntil(backgroundGeocodeEntry(env, id, newMapUrl));
  }
  const updated = await env.DB.prepare("SELECT * FROM entries WHERE id = ?").bind(id).first();
  return json(rowToEntry(updated), 200, headers);
}

async function deleteEntry(id, env, headers) {
  await env.DB.prepare("DELETE FROM ratings WHERE entry_id = ?").bind(id).run();
  await deleteSocialForTarget(env, "entry", id);
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

// 評価（★）に添える、人ごとのレビュー項目（紹介文用。docs/adr/0007）。全部任意。
// ◎〇△×の4段階（GRADE）と、選択肢（予約・混雑）、短い文章、金額・数（泊数・回数）。
// どの項目を出すかは予定の種類（宿泊・食事・観光）で画面側が決めるが、サーバーは種類を問わず受け付ける。
const REVIEW_GRADES = ["◎", "〇", "△", "×"];
const REVIEW_GRADE_KEYS = ["price", "location", "value", "hospitality", "amenity", "cleanliness", "breakfast", "taste"];
const REVIEW_CHOICES = { reservation: ["不要", "推奨", "必須"], crowd: ["空いている", "普通", "混んでいる"] };
const REVIEW_TEXT_KEYS = { access: 60, roomType: 60, duration: 30, bestTime: 30, menu: 200, other: 300 };

function validReview(x) {
  if (x === undefined) return true;
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  for (const [k, v] of Object.entries(x)) {
    if (v === "" || v === null) continue;
    if (REVIEW_GRADE_KEYS.includes(k)) { if (!REVIEW_GRADES.includes(v)) return false; }
    else if (REVIEW_CHOICES[k]) { if (!REVIEW_CHOICES[k].includes(v)) return false; }
    else if (REVIEW_TEXT_KEYS[k]) { if (!isStr(v, REVIEW_TEXT_KEYS[k])) return false; }
    else if (k === "amount") { if (!(Number.isInteger(v) && v >= 0 && v <= 100000000)) return false; }
    else if (k === "units") { if (!(Number.isInteger(v) && v >= 1 && v <= 365)) return false; }
    else return false;
  }
  return true;
}

function cleanReview(x) {
  const out = {};
  for (const [k, v] of Object.entries(x || {})) {
    if (v === "" || v === null || v === undefined) continue;
    out[k] = typeof v === "string" ? v.trim() : v;
  }
  return out;
}

function validRatingInput(x) {
  if (!x || typeof x !== "object") return false;
  if (!validReview(x.review)) return false;
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
    review: parseJsonObject(row.review),
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
  const auth = await resolveEmail(request, env, data.raterEmail);
  if (auth.error) return json({ error: auth.error }, auth.status, headers);
  const email = auth.email;
  const name = (data.raterName || "").trim();
  const existing = await env.DB.prepare("SELECT id FROM ratings WHERE entry_id = ? AND rater_email = ?")
    .bind(entryId, email)
    .first();
  const score = roundScore(data.score);
  const t = nowIso();
  // reviewを送ってこない古いアプリからの★だけの更新では、書いてあるレビュー項目を消さない
  const review = data.review === undefined ? null : JSON.stringify(cleanReview(data.review));
  if (existing) {
    if (review === null) {
      await env.DB.prepare("UPDATE ratings SET score=?, rater_name=?, updated_at=? WHERE id=?")
        .bind(score, name, t, existing.id)
        .run();
    } else {
      await env.DB.prepare("UPDATE ratings SET score=?, rater_name=?, review=?, updated_at=? WHERE id=?")
        .bind(score, name, review, t, existing.id)
        .run();
    }
  } else {
    await env.DB.prepare(
      "INSERT INTO ratings (id, entry_id, rater_email, rater_name, score, review, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
    )
      .bind(uid("rat"), entryId, email, name, score, review || "{}", t, t)
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
  const auth = await resolveEmail(request, env, data.raterEmail);
  if (auth.error) return json({ error: auth.error }, auth.status, headers);
  const email = auth.email;
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

// Open-Meteoのジオコーディング（市区町村・行政区分レベル。POI・施設名は持たない）の生の候補一覧。
async function geocodeOpenMeteoCandidates(place) {
  try {
    const url = "https://geocoding-api.open-meteo.com/v1/search?count=10&language=ja&format=json&name=" + encodeURIComponent(place);
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data && data.results) || [];
  } catch {
    return [];
  }
}

// 「地図でふりかえる」用に、予定の地名を緯度経度にする。首里城公園・那覇空港のような日本語の
// 施設名はOpenStreetMapのNominatimの方が見つかりやすいので先に試し、見つからなければ天気と同じ
// Open-Meteo（市区町村レベル）で探す。Nominatimの利用規約（アプリを識別できるUser-Agent・
// 結果のキャッシュ・1秒1回まで）に従い、結果はCache APIに30日置き、連続呼び出しの間隔は
// クライアント側で空ける（cached:falseのときだけ待つ）。
//
// Nominatimの先頭の候補をそのまま使うと、「山梨」が千葉県四街道市の同名の地区になるなど、
// 県・市より小さな同名の地名が選ばれることがあった。海外旅行でも使うので国内に絞ることはせず、
// 世界全体から数件もらって重要度（importance、有名さの目安）が一番高いものを選ぶ
// （ソウル→ソウル駅ではなくソウル特別市）。それでも重要度が低い候補しか無いときは、
// 小さな同名地区の可能性が高いので、人口の多い市区町村を返すOpen-Meteoの結果を優先する
// （「山梨」はNominatimには「山梨県」の名前でしか無く、Open-Meteoなら山梨市が返る）。
// 選び方を変えたとき、古い結果を使い続けないようキャッシュのキーに版（v2）を付けた。
const GEOCODE_CACHE_SECONDS = 60 * 60 * 24 * 30;
// この重要度より低い候補しか無ければOpen-Meteoを優先する（小さな同名地区は0.2未満、
// 駅・観光地・都市は0.4以上になることが多い）。
const GEOCODE_MIN_IMPORTANCE = 0.3;

async function nominatimSearch(q, near, nears) {
  try {
    const view = near ? "&viewbox=" + (near.lng - 3) + "," + (near.lat + 3) + "," + (near.lng + 3) + "," + (near.lat - 3) : "";
    const res = await fetch(
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=ja" + view + "&q=" + encodeURIComponent(q),
      { headers: { "user-agent": "tabilog/1.0 (+https://ainaraomakaseare-coder.github.io/my-app/apps/day07-tabilog/)" } }
    );
    return res.ok ? pickNominatimCandidate(await res.json(), nears) : null;
  } catch {
    return null; // Nominatimが落ちている・遅いときはOpen-Meteoに任せる
  }
}

// nears（旅行のほかの場所）があるときは、そのどれかから近い（GEOCODE_NEAR_KM以内）だけで信用する
// （「赤レンガ倉庫」の横浜側候補のように、重要度が低いだけの正しい候補も拾えるようにするため）。
// 無いときは、これまでどおり重要度で信用できるかを決める（「山梨」の小さな同名地区を弾く）。
function trustNominatim(result, nears) {
  if (!result) return false;
  return (nears && nears.length) ? nearOk(result, nears, GEOCODE_NEAR_KM) : result.importance >= GEOCODE_MIN_IMPORTANCE;
}

// 地名（「新宿」「山梨」など）を緯度経度にする。
async function geocodeText(q, nears) {
  let result = await nominatimSearch(q, nears && nears[0], nears);
  if (!trustNominatim(result, nears)) {
    const g = await geocodePlace(q, nears).catch(() => null);
    if (g) result = { lat: g.lat, lng: g.lon };
  }
  return result;
}

// 「日ごとの場所」（天気取得用の地名入力）を緯度経度・都道府県（州）・国にする。
// 「ユニバーサル」のように略した施設名だと、Open-Meteoの地名データ（自治体・行政区分中心。
// POI・施設は持たない）には目的の場所が無く、同じ名前の海外の地名（ユニバーサル・オーランド・
// リゾート）だけが返ってきて、国内旅行なのに時差が入ってしまうことがあった（2026-09-26、大阪旅行）。
// 「地図でふりかえる」と同じくNominatim（施設名にも強い）を先に試し、旅行のほかの日の場所
// （nears）があれば、Nominatim・Open-Meteoを合わせた候補の中からいちばん近いものを選ぶ
// （近い候補が無いときだけ、これまでどおりNominatimの重要度→Open-Meteoの順で選ぶ）。
// 都道府県・国は、Nominatim経由で決まった座標だけreverseGeocode()で引き直して合わせる
// （Open-Meteo経由は結果にadmin1・countryが最初から入っている）。
async function geocodePlace(place, nears) {
  const near = nears && nears[0];
  const [nom, geoList] = await Promise.all([
    nominatimSearch(place, near, nears),
    geocodeOpenMeteoCandidates(place),
  ]);
  const candidates = [];
  if (trustNominatim(nom, nears)) {
    candidates.push({ lat: nom.lat, lng: nom.lng, admin1: "", country: "", source: "nominatim" });
  }
  geoList.forEach((r) => {
    if (isFinite(r.latitude) && isFinite(r.longitude)) {
      candidates.push({ lat: r.latitude, lng: r.longitude, admin1: r.admin1 || "", country: r.country || "", source: "openmeteo" });
    }
  });
  if (!candidates.length) return null;
  // nearsがあれば、その旅行のほかの場所にいちばん近い候補（Nominatim・Open-Meteoどちらでも）を選ぶ。
  // 無ければ、これまでどおりNominatim（施設名に強い）を優先し、無ければOpen-Meteoの先頭。
  const pick = (nears && nears.length && nearestCandidate(candidates, nears))
    || candidates.find((c) => c.source === "nominatim")
    || candidates[0];
  if (pick.source === "nominatim") {
    const rg = await reverseGeocode(pick.lat, pick.lng).catch(() => null);
    pick.admin1 = (rg && rg.admin1) || "";
    pick.country = (rg && rg.country) || "";
  }
  return { lat: pick.lat, lon: pick.lng, admin1: pick.admin1, country: pick.country };
}

// ---- 記録の「地図」に入っているGoogleマップのURLから場所を得る ----
// 実際の記録の地図はほとんどがGoogleマップの共有リンク（maps.app.goo.gl/…）で、展開すると
// maps.google.com/?q=34.69,135.50（座標）か ?q=〒542-0075 大阪府…ビル 5F 店名（住所）になる。
// 短縮URLの展開で任意のURLへ通信しないよう、GoogleマップのドメインだけをHTTPSで辿る。
const MAP_URL_HOSTS = [
  "maps.app.goo.gl", "goo.gl", "maps.google.com", "www.google.com", "google.com",
  "maps.google.co.jp", "www.google.co.jp", "google.co.jp",
];

async function resolveMapUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  for (let hop = 0; hop < 4; hop++) {
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!MAP_URL_HOSTS.includes(u.hostname)) return null;
    if (u.hostname !== "maps.app.goo.gl" && u.hostname !== "goo.gl") return u;
    u.protocol = "https:";
    const res = await fetch(u.toString(), { redirect: "manual" });
    const loc = res.headers.get("location");
    if (!loc) return null;
    try { u = new URL(loc, u); } catch { return null; }
  }
  return null;
}

function validLatLng(lat, lng) {
  lat = parseFloat(lat); lng = parseFloat(lng);
  return isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

// 展開後のURLから、座標（そのまま使う）か、検索する文字列（店名・住所）を取り出す。
// 精度の高い順：場所ページの!3d…!4d…（そのお店の座標）→ ?q=座標 → /@座標（画面の中心）→
// 場所を示す内部番号（S2セルID。ftid=や!1s0x…:0x…。店名も座標も無い共有リンクで使われる）→ 文字列。
function parseMapUrl(u) {
  const href = u.href;
  let m = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(href);
  if (m && validLatLng(m[1], m[2])) return { coords: validLatLng(m[1], m[2]) };
  const q = (u.searchParams.get("q") || u.searchParams.get("query") || "").trim();
  m = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(q);
  if (m && validLatLng(m[1], m[2])) return { coords: validLatLng(m[1], m[2]) };
  m = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(u.pathname);
  if (m && validLatLng(m[1], m[2])) return { coords: validLatLng(m[1], m[2]) };
  m = /\/maps\/place\/([^/]+)/.exec(u.pathname);
  // 壊れた地図URL（「undefined,undefined」など。クライアント側の不具合で保存されてしまうことがある）を
  // 地名として探さない（エチオピアに飛んだことがある）
  let text = /^(undefined|null|NaN)(\s*,\s*(undefined|null|NaN))?$/i.test(q) ? "" : q;
  if (!text && m) {
    try { text = decodeURIComponent(m[1].replace(/\+/g, " ")); } catch { text = ""; }
  }
  if (!text) {
    // 「ユニオンステーション」「ステーキの夕食」のように、店名も座標も入らない共有リンク
    // （data=!4m2!3m1!1s0x…:0x… や ftid=0x…:0x…）は、コロン前の16進数がその場所のS2セルID
    const s2 = extractFeatureS2(href);
    const pt = s2 ? s2ToLatLng(s2) : null;
    if (pt) { const v = validLatLng(pt.lat, pt.lng); if (v) return { coords: v }; }
  }
  return text ? { text } : null;
}

// 住所つきの文字列はそのままだと見つからないことが多いので、郵便番号（〒・米国ZIP・ブラジルCEP）を
// 外して全角→半角にし、段階的に粗くして探す（実際の記録のリンクで確かめた順）。
// - 日本：「大阪府大阪市中央区難波千日前１２−７ Yes・Namba ビル 5F 店名」→ 全文 → 住所部分 → 番地より前（町名まで）
// - 海外：「店名 - 住所, 市 - 州, 国」「店名, 住所, 市, 州 国」→ 全文 → 店名を外した住所 → 最後の3区切り → 最後の2区切り（市のあたり）
// 店名だけでは探さない（チェーン店だと別の都市の店舗が当たるため）。どれでも見つからなければ
// 見つからない扱いにし、その予定は移動の目的地にしない（国の中心のような大ざっぱな位置に飛ぶよりよい）。
function mapTextCandidates(text) {
  const t = text.normalize("NFKC")
    .replace(/〒\s*\d{3}-\d{4}/g, " ")
    .replace(/\b\d{5}(?:-\d{3,4})?\b/g, " ")
    .replace(/\s+/g, " ").trim();
  const list = [t];
  const jp = /\S*[都道府県]\S*/.exec(t);
  if (jp) {
    list.push(jp[0], jp[0].replace(/\d.*$/, "")); // 最初の数字（番地・丁目）から後ろを落とす
  } else {
    const parts = t.split(/\s+-\s+|,\s*/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) list.push(parts.slice(1).join(", "));
    if (parts.length >= 3) list.push(parts.slice(-3).join(", "), parts.slice(-2).join(", "));
  }
  return [...new Set(list.filter((s) => s && s.length >= 2))].slice(0, 4);
}

// quick=true：Nominatim（1秒に1回まで）を使わないと分からないものは調べず、{ pending: true } を返す。
// アプリは座標がすぐ分かるものを先に全部同時に聞き、pendingだったものだけを1.1秒ずつ空けて聞き直す
// （以前は全部を1.1秒ずつ空けていたので、「地図で場所を探しています」が長かった）。
// ---- 海外の施設を日本語の名前で探す（2026-09-26〜） ----
// 本番の地図リンク57件を調べたら18件で場所が分からなかった。多くは「ドジャースタジアム」「ペトコパーク」
// 「リオデジャネイロ空港」のようなカタカナの施設名で、OpenStreetMap（Nominatim）は海外の施設を日本語名で
// 探すのが苦手なため。日本語版ウィキペディアで、題名（または転送元の題名）が名前と合う記事の座標を使う。
// 「・」空白・かっこ・ヴ/ブなどの違いは同じとみなす。題名が合わない記事は使わない（「ドジャースタジアム」で
// エンゼル・スタジアムが出るような取り違えを防ぐ）。
// normPlaceName・placeNameRankはgeo-decode.jsのpure関数（node単体テストできるよう移動した。
// worker/test/geo-decode.test.mjs）。

const WIKI_UA = { "user-agent": "tabilog/1.0 (+https://ainaraomakaseare-coder.github.io/my-app/apps/day07-tabilog/)" };

// 記事（転送元の題名でもよい）の座標。日本語版の記事に座標が無いとき（「フラミンゴ・ラスベガス」など）は、
// 記事につながったウィキデータの「位置」を使う。返り値は { 題名: {lat,lng} }
async function wikipediaCoords(titles) {
  const res = await fetch("https://ja.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=coordinates|pageprops&ppprop=wikibase_item&coprimary=all&titles=" + encodeURIComponent(titles.join("|")), { headers: WIKI_UA });
  const data = res.ok ? await res.json() : null;
  const q = (data && data.query) || {};
  const from = {}; // 最終的な題名 → 聞いた題名たち
  titles.forEach((t) => { from[t] = [t]; });
  (q.normalized || []).concat(q.redirects || []).forEach((r) => { from[r.to] = (from[r.to] || []).concat(from[r.from] || [r.from]); });
  const out = {}, needData = {};
  Object.values(q.pages || {}).forEach((pg) => {
    const c = pg.coordinates && pg.coordinates[0];
    const pt = c ? validLatLng(c.lat, c.lon) : null;
    if (pt) (from[pg.title] || [pg.title]).forEach((t) => { out[t] = pt; });
    else if (pg.pageprops && pg.pageprops.wikibase_item) needData[pg.pageprops.wikibase_item] = from[pg.title] || [pg.title];
  });
  const ids = Object.keys(needData);
  if (ids.length) {
    const r2 = await fetch("https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims&ids=" + ids.join("|"), { headers: WIKI_UA });
    const d2 = r2.ok ? await r2.json() : null;
    ids.forEach((id) => {
      const e = d2 && d2.entities && d2.entities[id];
      const v = e && e.claims && e.claims.P625 && e.claims.P625[0].mainsnak.datavalue && e.claims.P625[0].mainsnak.datavalue.value;
      const pt = v ? validLatLng(v.latitude, v.longitude) : null;
      if (pt) needData[id].forEach((t) => { if (!out[t]) out[t] = pt; });
    });
  }
  return out;
}

// 日本語版ウィキペディアで、題名（または転送元の題名）が名前と合う記事の座標。
// ①名前そのものの題名・転送（「NRGスタジアム」→「リライアント・スタジアム」）②検索して題名が合う記事
// 部分一致（rank 2）の候補が複数あって同じ順位のとき（「赤レンガ倉庫」で敦賀・横浜の両方が引っかかるなど）
// は、nears（旅行のほかの場所）があればいちばん近いものを選ぶ（pickWikiHit）。完全一致（rank 3）は常に優先。
async function wikipediaPlace(name, nears) {
  try {
    const direct = await wikipediaCoords([name]);
    if (direct[name]) return Object.assign({ title: name }, direct[name]);
    const res = await fetch("https://ja.wikipedia.org/w/api.php?action=query&format=json&list=search&srlimit=10&srprop=redirecttitle&srsearch=" + encodeURIComponent(name), { headers: WIKI_UA });
    const data = res.ok ? await res.json() : null;
    const hits = ((data && data.query && data.query.search) || [])
      .map((h) => ({ title: h.title, rank: Math.max(placeNameRank(name, h.title), h.redirecttitle ? placeNameRank(name, h.redirecttitle) : 0) }))
      .filter((h) => h.rank).sort((a, b) => b.rank - a.rank).slice(0, 5);
    if (!hits.length) return null;
    const cs = await wikipediaCoords(hits.map((h) => h.title));
    const found = hits.filter((h) => cs[h.title]).map((h) => Object.assign({ title: h.title, rank: h.rank }, cs[h.title]));
    const picked = pickWikiHit(found, nears);
    return picked ? { title: picked.title, lat: picked.lat, lng: picked.lng } : null;
  } catch {
    return null;
  }
}

// 「リオデジャネイロ空港」のように「町の名前＋空港」で、空港の正式名と違うとき：
// 町の場所を探し、そのまわり（約40km）でいちばん大きな空港（OpenStreetMapの重要度が最大）を使う
async function cityAirport(text, nears) {
  const m = /^(.+?)(国際)?空港$/.exec(text.replace(/\s+/g, ""));
  if (!m) return null;
  const city = (await wikipediaPlace(m[1], nears)) || (await nominatimSearch(m[1], nears && nears[0], nears));
  if (!city || !nearOk(city, nears, GEOCODE_NAME_KM)) return null;
  const d = 0.4;
  try {
    const res = await fetch(
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=10&bounded=1&q=airport&viewbox=" +
        (city.lng - d) + "," + (city.lat + d) + "," + (city.lng + d) + "," + (city.lat - d),
      { headers: WIKI_UA }
    );
    const list = res.ok ? await res.json() : [];
    const best = (Array.isArray(list) ? list : [])
      .filter((x) => x.category === "aeroway" && x.type === "aerodrome")
      .sort((a, b) => (b.importance || 0) - (a.importance || 0))[0];
    return best ? validLatLng(Number(best.lat), Number(best.lon)) : null;
  } catch {
    return null;
  }
}

// near：同じ旅行の前後の場所（最大2つ）。どれかから km 以内の結果だけを使う
// （「シェラトン」で広島のホテルが出るような、チェーン店・同名の別の場所を防ぐ）。
// 名前全体が記事の題名と合ったときは信頼できるので、国内線の距離（ロサンゼルス→ヒューストンの約2200km）も許す。
const GEOCODE_NEAR_KM = 2000;
const GEOCODE_NAME_KM = 5000;
function nearOk(pt, nears, km) {
  if (!pt || !nears || !nears.length) return !!pt;
  return nears.some((n) => distanceKm(n, pt) <= (km || GEOCODE_NEAR_KM));
}

// Places API (New) の Text Search Essentials（IDのみ。無料・無制限のSKU、docs/adr/0011）→
// Place Details Essentials（座標のみ）の順で、施設名・住所から座標を探す（Part B、2026-09-26〜）。
// Nominatim（1秒1回まで）より先に試すことで、海外の施設名などの初回の準備を速くする。
// 候補が複数返っても、詳細（Place Details）を聞くのは先頭の1件だけ（locationBiasで絞り込み済みのものを
// 信用する。複数件の詳細を聞くと無料枠を余計に消費するため）。GOOGLE_API_KEYが無い・失敗した・0件
// だったときはnullを返し、呼び出し側でこれまでどおりNominatim等の予備チェーンに回す。
async function googleTextSearchPlace(text, nears, env) {
  if (!env || !env.GOOGLE_API_KEY) return null;
  try {
    const body = { textQuery: text, languageCode: "ja", maxResultCount: 5 };
    if (nears && nears.length) {
      body.locationBias = { circle: { center: { latitude: nears[0].lat, longitude: nears[0].lng }, radius: 50000 } };
    }
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "X-Goog-Api-Key": env.GOOGLE_API_KEY, "X-Goog-FieldMask": "places.id", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const places = Array.isArray(data.places) ? data.places : [];
    const id = places[0] && places[0].id;
    if (!id) return null;
    const res2 = await fetch("https://places.googleapis.com/v1/places/" + encodeURIComponent(id) + "?languageCode=ja", {
      headers: { "X-Goog-Api-Key": env.GOOGLE_API_KEY, "X-Goog-FieldMask": "location" },
    });
    if (!res2.ok) return null;
    const data2 = await res2.json();
    return (data2.location && validLatLng(data2.location.latitude, data2.location.longitude)) || null;
  } catch {
    return null;
  }
}

// 名前（施設名・住所）から場所を探す：①（GOOGLE_API_KEYがあれば）Google Text Search→②Nominatim
// （住所の段階的な簡略化つき）→③日本語版ウィキペディア→④「町＋空港」→⑤空白で区切った一部
// （長い順。近くの場所が分かっているときだけ。町の名前だけが合えば町の座標）
async function geocodePlaceName(text, nears, env) {
  if (env && env.GOOGLE_API_KEY) {
    const g = await googleTextSearchPlace(text, nears, env).catch(() => null);
    if (g && nearOk(g, nears)) return g;
  }
  const near = nears && nears[0];
  const pause = () => new Promise((ok) => setTimeout(ok, 1100)); // Nominatimは1秒1回まで
  const candidates = mapTextCandidates(text);
  for (let i = 0; i < candidates.length; i++) {
    if (i > 0) await pause();
    const r = await nominatimSearch(candidates[i], near, nears);
    if (r && nearOk(r, nears)) return r;
  }
  const clean = String(text).normalize("NFKC").replace(/〒\s*\d{3}-\d{4}/g, " ").replace(/\s+/g, " ").trim();
  const w = await wikipediaPlace(clean, nears);
  if (w && nearOk(w, nears, GEOCODE_NAME_KM)) return w;
  await pause();
  const air = await cityAirport(clean, nears);
  if (air) return air;
  if (nears && nears.length) {
    const parts = [...new Set(clean.split(" ").filter((x) => x.length >= 2))].sort((a, b) => b.length - a.length);
    for (const part of parts.slice(0, 3)) {
      if (part === clean) continue;
      const wp = await wikipediaPlace(part, nears);
      if (wp && nearOk(wp, nears)) return wp;
    }
  }
  return null;
}


// env：GOOGLE_API_KEYがあればgeocodePlaceName内でGoogle Text Search（Part B）を先に試す。
//
// 【hint（予定の見出し）を手がかりに使うのをやめた経緯、2026-09-26】以前は、地図のリンクに座標も名前も
// 無い（Googleの内部番号だけの）ときの最後の手がかりとして見出し（hint）から場所を推測していた。
// しかしこれは「リンクの中の情報」ではなく「見出しの文字列だけからの当てずっぽう」で、見出しがありふれた
// 言葉（「ユニバーサル」など）だと無関係な場所（海外の同名施設など）に化けることがあった。ユーザーの方針
// により、「リンクから場所が分からないときは、無理に当てず、前の地点にとどまらせる」ことにした
// （地図でふりかえるの`Core.buildReplayTimeline`は、located=falseの地点をそのまま「場所の分からない
// 出来事」として扱い、直前の地点に居続けるようになっている）。リンクの中の文字列（店名・住所）からの
// 検索（Google Text Search・Nominatim・ウィキペディア）はこれまでどおり使う。
async function geocodeMapUrl(raw, quick, nears, env) {
  const u = await resolveMapUrl(raw).catch(() => null);
  const parsed = u ? parseMapUrl(u) : null;
  if (parsed && parsed.coords) return parsed.coords;
  if (quick) return { pending: true };
  if (parsed && parsed.text) {
    const r = await geocodePlaceName(parsed.text, nears, env);
    if (r) return r;
  }
  return null;
}

// Places API (New) のAutocomplete（docs/adr/0011）。座標は返らないので、選ばれてから
// /places/details（placeDetails）で取る。sessionは検索の開始ごとにクライアントが1つ作って
// 一連の呼び出しに使い回すことで、Autocomplete分は無料枠を消費しない
// （Session Usageの範囲。1検索＝1セッションになるよう、検索し直すたびに新しいsessionを作ってもらう）。
// キーが無い・呼び出しが失敗した・0件だったときはnullを返し、呼び出し側でNominatim等の予備に回す。
async function googleAutocomplete(q, session, env) {
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: { "X-Goog-Api-Key": env.GOOGLE_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ input: q, languageCode: "ja", sessionToken: session || undefined }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
    const places = suggestions
      .map((s) => s && s.placePrediction)
      .filter(Boolean)
      .map((p) => ({
        name: (p.structuredFormat && p.structuredFormat.mainText && p.structuredFormat.mainText.text) || "",
        address: (p.structuredFormat && p.structuredFormat.secondaryText && p.structuredFormat.secondaryText.text) || "",
        placeId: p.placeId || "",
      }))
      .filter((p) => p.name && p.placeId);
    return places.length ? places : null;
  } catch {
    return null;
  }
}

const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,300}$/;

// Autocompleteは座標を返さないので、候補を「選択」したタイミングで呼ぶ（GET /places/details）。
// Place Details Essentials（location・displayName・formattedAddress）だけを聞く。
// Pro以上のフィールド（評価・営業時間など）を足すと無料枠の単価が変わるので、増やさないこと。
async function placeDetails(id, session, env, headers) {
  if (!env.GOOGLE_API_KEY || !PLACE_ID_RE.test(id || "")) return json({ found: false }, 200, headers);
  try {
    const params = new URLSearchParams({ languageCode: "ja" });
    if (session) params.set("sessionToken", session);
    const res = await fetch("https://places.googleapis.com/v1/places/" + encodeURIComponent(id) + "?" + params.toString(), {
      headers: { "X-Goog-Api-Key": env.GOOGLE_API_KEY, "X-Goog-FieldMask": "location,displayName,formattedAddress" },
    });
    if (!res.ok) return json({ found: false }, 200, headers);
    const data = await res.json();
    const pt = data.location && validLatLng(data.location.latitude, data.location.longitude);
    if (!pt) return json({ found: false }, 200, headers);
    return json({
      found: true,
      name: (data.displayName && data.displayName.text) || "",
      address: data.formattedAddress || "",
      lat: pt.lat,
      lng: pt.lng,
    }, 200, headers);
  } catch {
    return json({ found: false }, 200, headers);
  }
}

// q：記録の地図のURL（今のアプリ）か、地名（見出しから推測していた以前のアプリ。審査中・配布済みの
// iOSアプリのために残す）。
// 記録フォームの「場所名で検索」用に、候補を複数返す（先頭が違う場所だったときに選び直せるように）。
// GOOGLE_API_KEYがある間はPlaces API (New)のAutocompleteを先に試す（docs/adr/0011）。失敗・0件の
// ときだけ、これまでどおりNominatim・ウィキペディア・空港の予備に回る。Googleの結果はCache APIに
// 置かない（利用規約が長期間のキャッシュを推奨していないため、無理にキャッシュしない）。
async function searchPlaces(q, headers, ctx, env, session) {
  q = (q || "").trim();
  if (!q || q.length > 100) return json({ error: "invalid_input" }, 400, headers);
  // Googleの候補は座標を持たない（選んでから /places/details で取る）。それを知らない古いアプリ（1.1.0の
  // ビルド47まで・session を送らない）に返すと「query=undefined,undefined」の地図URLが保存されてしまった
  // （2026-09-26、大阪旅行で発生）ので、session を送ってくる新しいアプリにだけGoogleの候補を返す。
  if (env && env.GOOGLE_API_KEY && session) {
    const google = await googleAutocomplete(q, session, env);
    if (google) return json({ places: google }, 200, headers);
  }
  const cache = caches.default;
  const cacheKey = new Request("https://tabilog-places.cache/v4?q=" + encodeURIComponent(q));
  const hit = await cache.match(cacheKey);
  if (hit) return json(await hit.json(), 200, headers);
  let list = [];
  try {
    const res = await fetch(
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&accept-language=ja&q=" + encodeURIComponent(q),
      { headers: { "user-agent": "tabilog/1.0 (+https://ainaraomakaseare-coder.github.io/my-app/apps/day07-tabilog/)" } }
    );
    if (res.ok) list = await res.json();
  } catch {
    list = [];
  }
  list = (Array.isArray(list) ? list : []).slice().sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0));
  // 地図でふりかえると同じく、小さな同名地区しか無い（重要度が低い）ときは、市区町村を返すOpen-Meteoの
  // 候補を先に出す（「山梨」はNominatimだと千葉県・北海道の同名地区ばかりで、山梨県が出てこない）
  let cities = [];
  if (!list.length || (Number(list[0].importance) || 0) < GEOCODE_MIN_IMPORTANCE) {
    try {
      const res = await fetch("https://geocoding-api.open-meteo.com/v1/search?count=5&language=ja&format=json&name=" + encodeURIComponent(q));
      const data = res.ok ? await res.json() : null;
      cities = ((data && data.results) || []).map((r) => ({
        name: r.name,
        address: (r.country === "日本" ? [r.admin1, r.admin2] : [r.country, r.admin1]).filter(Boolean).join(" "),
        lat: r.latitude, lng: r.longitude,
      }));
    } catch {
      cities = [];
    }
  }
  // 海外の施設をカタカナで探したとき（「ドジャースタジアム」など）はNominatimの候補が少ないので、
  // 題名が合うウィキペディアの記事の場所も候補に足す（地図でふりかえると同じ探し方。2026-09-26〜）
  let wiki = [];
  if (list.length < 3) {
    const w = await wikipediaPlace(q);
    if (w) wiki = [{ name: String(w.title || q).replace(/\s*\([^)]*\)$/, ""), address: "ウィキペディアの記事の場所", lat: w.lat, lng: w.lng }];
    // 「リオデジャネイロ空港」のような「町＋空港」は、町のまわりでいちばん大きな空港
    if (!wiki.length && /空港$/.test(q)) {
      await new Promise((ok) => setTimeout(ok, 1100)); // Nominatimは1秒1回まで
      const air = await cityAirport(q.replace(/\s+/g, ""), []);
      if (air) wiki = [{ name: q, address: "町のまわりでいちばん大きな空港", lat: air.lat, lng: air.lng }];
    }
  }
  if (!list.length && !cities.length && !wiki.length) return json({ places: [] }, 200, headers);
  const seen = new Set();
  const places = wiki.concat(cities).concat(list
    .map((r) => {
      const full = String(r.display_name || "");
      const name = String(r.name || full.split(",")[0] || "").trim();
      // display_nameは「番地, 町, 市, 県, 郵便番号, 国」のように細かい順に並ぶので、郵便番号を除き、
      // 大きい方から3つ（県 市 区）を見せる。海外は国名を先頭に添える（日本国内なら国名は省く）。
      const parts = full.split(",").map((x) => x.trim()).filter((x) => x && x !== name && !/^[\d\-\s]{3,10}$/.test(x));
      const country = parts[parts.length - 1] || "";
      const big = parts.slice(0, -1).slice(-3).reverse();
      return {
        name,
        address: (country === "日本" ? big : [country].concat(big)).join(" "),
        lat: parseFloat(r.lat), lng: parseFloat(r.lon),
      };
    }))
    .filter((x) => x.name && isFinite(x.lat) && isFinite(x.lng))
    .filter((x) => { const k = x.name + "|" + x.lat.toFixed(3) + "," + x.lng.toFixed(3); if (seen.has(k)) return false; seen.add(k); return true; });
  const body = { places };
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=" + GEOCODE_CACHE_SECONDS },
  })));
  return json(body, 200, headers);
}

// 「地図でふりかえる」の移動を、直線ではなく実際の道路に沿った道のり（Googleマップの青い線のようなもの）で
// 見せるためのルート検索（docs/adr/0008）。OpenStreetMapのルート検索（FOSSGISが運営する無料のOSRM、
// routing.openstreetmap.de）を使う。共用の無料サービスなので、アプリを識別できるUser-Agentを付け、
// 同じルートはCache APIに30日置いて問い合わせを減らす。遠すぎる移動（1500km超）は調べない。
const ROUTE_PROFILES = {
  car: "routed-car/route/v1/driving",
  foot: "routed-foot/route/v1/foot",
  bike: "routed-bike/route/v1/bike",
};
const ROUTE_MAX_KM = 1500;
const ROUTE_MAX_POINTS = 400;

function parseLatLng(text) {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(text || "");
  return m ? validLatLng(m[1], m[2]) : null;
}

// distanceKmはgeo-decode.jsのpure関数（node単体テストできるよう移動した。worker/test/geo-decode.test.mjs）。

// 場所（緯度・経度）のタイムゾーン名（例：Europe/London）。時差のある旅行で、現地時間の時刻を
// 世界共通の時刻に直して並べるために使う（docs/adr/0009）。天気と同じOpen-Meteo（無料・APIキー不要）の
// timezone=autoで求め、30日キャッシュする。時差そのもの（サマータイム込み）はアプリ側でIntlが計算する。
async function getTimezone(url, headers, ctx) {
  const at = parseLatLng((url.searchParams.get("lat") || "") + "," + (url.searchParams.get("lng") || ""));
  if (!at) return json({ error: "invalid_input" }, 400, headers);
  const key = at.lat.toFixed(2) + "," + at.lng.toFixed(2);
  const cache = caches.default;
  const cacheKey = new Request("https://tabilog-tz.cache/v1?k=" + key);
  const hit = await cache.match(cacheKey);
  if (hit) return json(await hit.json(), 200, headers);
  let body;
  try {
    const res = await fetch("https://api.open-meteo.com/v1/forecast?timezone=auto&forecast_days=1&latitude=" + at.lat + "&longitude=" + at.lng);
    const data = res.ok ? await res.json() : null;
    if (!data || !data.timezone) return json({ error: "timezone_failed" }, 502, headers);
    body = { timezone: String(data.timezone) };
  } catch {
    return json({ error: "timezone_failed" }, 502, headers);
  }
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=" + GEOCODE_CACHE_SECONDS },
  })));
  return json(body, 200, headers);
}

async function getRoute(url, headers, ctx) {
  const profile = url.searchParams.get("profile") || "";
  const from = parseLatLng(url.searchParams.get("from"));
  const to = parseLatLng(url.searchParams.get("to"));
  if (!ROUTE_PROFILES[profile] || !from || !to) return json({ error: "invalid_input" }, 400, headers);
  if (distanceKm(from, to) > ROUTE_MAX_KM) return json({ found: false }, 200, headers);
  const key = [profile, from.lat.toFixed(5), from.lng.toFixed(5), to.lat.toFixed(5), to.lng.toFixed(5)].join(",");
  const cache = caches.default;
  const cacheKey = new Request("https://tabilog-route.cache/v1?k=" + encodeURIComponent(key));
  const hit = await cache.match(cacheKey);
  if (hit) return json(await hit.json(), 200, headers);

  let body = { found: false };
  try {
    const res = await fetch(
      "https://routing.openstreetmap.de/" + ROUTE_PROFILES[profile] + "/" +
        from.lng + "," + from.lat + ";" + to.lng + "," + to.lat + "?overview=full&geometries=geojson",
      { headers: { "user-agent": "tabilog/1.0 (+https://ainaraomakaseare-coder.github.io/my-app/apps/day07-tabilog/)" } }
    );
    const data = res.ok ? await res.json() : null;
    const route = data && data.routes && data.routes[0];
    const coords = route && route.geometry && route.geometry.coordinates;
    if (Array.isArray(coords) && coords.length > 1) {
      // 点が多すぎると重いので間引く（最後の点は必ず残す）
      const step = Math.ceil(coords.length / ROUTE_MAX_POINTS);
      const pts = coords.filter((_, i) => i % step === 0 || i === coords.length - 1)
        .map((c) => [Math.round(c[1] * 1e5) / 1e5, Math.round(c[0] * 1e5) / 1e5]);
      body = { found: true, path: pts, distance: Math.round(route.distance || 0), duration: Math.round(route.duration || 0) };
    }
  } catch {
    return json({ error: "route_failed" }, 502, headers); // 一時的な失敗はキャッシュしない
  }
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=" + GEOCODE_CACHE_SECONDS },
  })));
  return json(body, 200, headers);
}

// near：「緯度,経度;緯度,経度」（同じ旅行の前後の場所）、hint：予定の見出し、
// entry：呼び出し元の記録(entry)のid（Part A、2026-09-26〜）。付いていて、見つかった座標がある
// ときは、そのentryの行のmap_url（=このqと一致するときだけ）に座標を保存し、次回このAPIを
// 呼ばなくてよいようにする（既存データのための後追い保存。entry create/updateの裏処理が対象外の
// ものにも効く）。他人の行を書き換えられないよう、entry idの形式検証＋map_url一致の両方を見る。
async function geocodeForReplay(q, headers, ctx, quick, nearParam, hintParam, entryParam, env) {
  q = (q || "").trim();
  const isUrl = /^https?:\/\//i.test(q);
  if (!q || q.length > (isUrl ? 2000 : 100)) return json({ error: "invalid_input" }, 400, headers);
  const nears = String(nearParam || "").split(";").map(parseLatLng).filter(Boolean).slice(0, 2);
  // hintParam（予定の見出し）は古いクライアントのために受け取るだけで、もう使わない
  // （2026-09-26、下のgeocodeMapUrlの注記のとおり見出しからの当てずっぽうをやめたため）。
  const entryId = isValidEntryId(entryParam) ? entryParam : "";
  const cache = caches.default;
  // 近くの場所で結果が変わるので、キャッシュの鍵に含める（hintはもう結果に影響しないので鍵から外した）。
  // v7：見出し（hint）からの当てずっぽうをやめた（無関係な場所に飛ぶことがあったため）ので、
  // それに影響されていたかもしれない以前の結果を作り直す。
  const cacheKey = new Request("https://tabilog-geocode.cache/v7?q=" + encodeURIComponent(q) +
    "&near=" + nears.map((n) => n.lat.toFixed(0) + "," + n.lng.toFixed(0)).join(";"));
  const storeForEntry = (body) => {
    if (!entryId || !env || !env.DB || !body || !body.found) return;
    if (typeof body.lat !== "number" || typeof body.lng !== "number") return;
    ctx.waitUntil(env.DB.prepare(
      "UPDATE entries SET map_lat=?, map_lng=?, map_geocoded_url=?, map_geocoded_at=? WHERE id=? AND map_url=?"
    ).bind(body.lat, body.lng, q, nowIso(), entryId, q).run());
  };
  const hit = await cache.match(cacheKey);
  if (hit) {
    const body = await hit.json();
    storeForEntry(body);
    return json({ ...body, cached: true }, 200, headers);
  }

  if (quick && !isUrl) return json({ pending: true }, 200, headers);
  const result = isUrl ? await geocodeMapUrl(q, quick, nears, env) : await geocodeText(q, nears);
  if (result && result.pending) return json({ pending: true }, 200, headers); // まだ調べていないのでキャッシュしない
  const body = result ? { found: true, lat: result.lat, lng: result.lng } : { found: false };
  storeForEntry(body);
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=" + GEOCODE_CACHE_SECONDS },
  })));
  return json({ ...body, cached: false }, 200, headers);
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

// 日ごとの場所が空いている日に、その日の記録の地図の位置（緯度・経度）から場所を入れる（2026-09-26〜）。
// 日ごとの場所は、天気・マイログの「訪れた国・都道府県」・時差の判定に使うが、手で入れていない日が多く、
// ブラジルに行った旅行がマイログに出ない・時差が分からない、ということがあった。
// 位置から町・都道府県（州）・国の名前を調べる（NominatimのReverse、日本語。1秒1回までなので
// アプリ側で間隔を空けて1日ずつ呼ぶ）。すでに場所が入っている日は変えない（手で入れたものを優先）。
const JP_PREFECTURES = ["北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県","茨城県","栃木県","群馬県","埼玉県","千葉県","東京都","神奈川県","新潟県","富山県","石川県","福井県","山梨県","長野県","岐阜県","静岡県","愛知県","三重県","滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県","鳥取県","島根県","岡山県","広島県","山口県","徳島県","香川県","愛媛県","高知県","福岡県","佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県"];

async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(
      "https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=ja&lat=" + lat + "&lon=" + lng,
      { headers: { "user-agent": "tabilog/1.0 (+https://ainaraomakaseare-coder.github.io/my-app/apps/day07-tabilog/)" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const a = (data && data.address) || {};
    // 東京都などは、都道府県名が返らずISOのコード（JP-13）だけのことがあるので、コードから引く
    const jpCode = /^JP-(\d{2})$/.exec(a["ISO3166-2-lvl4"] || "");
    const admin1 = a.province || a.state || a.region || (jpCode ? JP_PREFECTURES[Number(jpCode[1]) - 1] || "" : "");
    const place = a.city || a.town || a.village || a.municipality || a.county || admin1 || a.country || "";
    if (!place) return null;
    return { place: String(place).slice(0, 100), admin1: String(admin1), country: String(a.country || "") };
  } catch {
    return null;
  }
}

async function autoSetDayPlace(tripId, date, request, env, headers) {
  if (!DATE_RE.test(date)) return json({ error: "invalid_date" }, 400, headers);
  const trip = await env.DB.prepare("SELECT id FROM trips WHERE id = ?").bind(tripId).first();
  if (!trip) return json({ error: "trip_not_found" }, 404, headers);
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  const at = validLatLng(data.lat, data.lng);
  if (!at) return json({ error: "invalid_input" }, 400, headers);
  const id = tripId + "_" + date;
  const existing = await env.DB.prepare("SELECT * FROM day_infos WHERE id = ?").bind(id).first();
  if (existing && existing.place) return json({ skipped: true, day: rowToDayInfo(existing) }, 200, headers);

  const geo = await reverseGeocode(at.lat, at.lng);
  if (!geo) return json({ error: "place_not_found" }, 422, headers);
  const weather = await fetchDailyWeather(at.lat, at.lng, date).catch(() => null);
  const t = nowIso();
  const row = {
    place: geo.place, lat: at.lat, lon: at.lng, admin1: geo.admin1, country: geo.country,
    weather_code: weather ? weather.weatherCode : null,
    temp_max: weather ? weather.tempMax : null,
    temp_min: weather ? weather.tempMin : null,
    precip_sum: weather ? weather.precipSum : null,
    is_forecast: weather && weather.isForecast ? 1 : 0,
    fetched_at: weather ? t : "",
  };
  if (existing) {
    // 文字起こし（voice_transcript）だけがある行など。場所と天気だけを入れる
    await env.DB.prepare(
      "UPDATE day_infos SET place=?, lat=?, lon=?, admin1=?, country=?, weather_code=?, temp_max=?, temp_min=?, precip_sum=?, is_forecast=?, fetched_at=?, updated_at=? WHERE id=? AND place=''"
    )
      .bind(row.place, row.lat, row.lon, row.admin1, row.country, row.weather_code, row.temp_max, row.temp_min, row.precip_sum, row.is_forecast, row.fetched_at, t, id)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO day_infos (id, trip_id, date, place, lat, lon, admin1, country, weather_code, temp_max, temp_min, precip_sum, is_forecast, fetched_at, weather_manual, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)"
    )
      .bind(id, tripId, date, row.place, row.lat, row.lon, row.admin1, row.country, row.weather_code, row.temp_max, row.temp_min, row.precip_sum, row.is_forecast, row.fetched_at, t, t)
      .run();
  }
  const updated = await env.DB.prepare("SELECT * FROM day_infos WHERE id = ?").bind(id).first();
  return json({ day: rowToDayInfo(updated) }, 200, headers);
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

  // 「ユニバーサル」のような略した施設名は、地名以外の候補（海外の同名地名など）に化けることが
  // あるため、旅行のほかの日にすでに分かっている場所を手掛かり（near）にして、近い候補を選ぶ
  // （2026-09-26、大阪旅行で「ユニバーサル」がユニバーサル・オーランド・リゾートになった件）。
  const otherDays = await env.DB.prepare(
    "SELECT lat, lon FROM day_infos WHERE trip_id = ? AND date != ? AND lat IS NOT NULL AND lon IS NOT NULL"
  ).bind(tripId, date).all();
  const nears = ((otherDays && otherDays.results) || [])
    .map((r) => ({ lat: Number(r.lat), lng: Number(r.lon) }))
    .filter((p) => isFinite(p.lat) && isFinite(p.lng))
    .slice(0, 5);

  const geo = await geocodePlace(place, nears);
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
  const token = await issueSession(env, email);
  return json({ email, name: row.name, token }, 200, headers);
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
// メモをAIで整理する回数（音声とは別の枠、2026-09-26〜）。メモは文字起こしが要らないぶん音声より安いので、
// 無料でも月10回まで使えるようにした。有料プランは、以前（音声と共通の枠）より減らないようにしている。
// 決まった形（「10:00 新宿」のような行）のメモは、AIを使わずアプリ側で分けるので回数を使わない。
var MEMO_MONTHLY_LIMIT = { free: 10, basic: 30, premium_plus: 100 };

function currentPeriodStart() {
  var now = new Date();
  return now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0") + "-01";
}

// 暦月が変わっていたら利用回数をリセットする（Stripeの実際の請求日とは同期させない簡易な実装）。
async function resetPeriodIfNeeded(env, row) {
  var period = currentPeriodStart();
  if (row.plan_period_start === period) return row;
  await env.DB.prepare("UPDATE accounts SET plan_period_start=?, voice_uses_this_period=0, memo_uses_this_period=0, updated_at=? WHERE email=?")
    .bind(period, nowIso(), row.email)
    .run();
  return { ...row, plan_period_start: period, voice_uses_this_period: 0, memo_uses_this_period: 0 };
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
    memoMonthlyLimit: MEMO_MONTHLY_LIMIT[row.plan] || MEMO_MONTHLY_LIMIT.free,
    memoRemainingThisPeriod: Math.max(0, (MEMO_MONTHLY_LIMIT[row.plan] || MEMO_MONTHLY_LIMIT.free) - (row.memo_uses_this_period || 0)),
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
  const auth = await resolveEmail(request, env, data.email);
  if (auth.error) return json({ error: auth.error }, auth.status, headers);
  const email = auth.email;
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
  const auth = await resolveEmail(request, env, data.email);
  if (auth.error) return json({ error: auth.error }, auth.status, headers);
  const email = auth.email;

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
  await deleteSocialForAccount(env, account.account_id);
  await env.DB.prepare("DELETE FROM sessions WHERE email = ?").bind(email).run();
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
  const auth = await resolveEmail(request, env, data.email);
  if (auth.error) return json({ error: auth.error }, auth.status, headers);
  const email = auth.email;

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
  const auth = await resolveEmail(request, env, data.email);
  if (auth.error) return json({ error: auth.error }, auth.status, headers);
  const email = auth.email;

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
  const auth = await resolveEmail(request, env, data.email);
  if (auth.error) return json({ error: auth.error }, auth.status, headers);
  const email = auth.email;
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

// Cloudflare Workers AIへの切り替えを検討するための試作（docs/adr/0012）で使うモデルID。
// 本番の処理はまだ一切これらを使わない（/ai-compareでの比較専用）。
const WORKERS_AI_WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
const WORKERS_AI_LLM_MODELS = {
  qwen3_30b: "@cf/qwen/qwen3-30b-a3b-fp8",
  gpt_oss_120b: "@cf/openai/gpt-oss-120b",
};

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

// /ai-compare専用。OpenAIのtranscribeAudioと同じ入力から、Workers AIのWhisperで
// 文字起こしを試す（本番の処理からは呼ばない）。audioは音声ファイルそのもののバイト列を
// 数値の配列にして渡す（Workers AIの音声認識モデルの入力形式）。
async function transcribeAudioWithWorkersAi(env, buf) {
  const audio = [...new Uint8Array(buf)];
  const result = await env.AI.run(WORKERS_AI_WHISPER_MODEL, { audio, language: "ja" });
  const text = result && typeof result.text === "string" ? result.text : (typeof result === "string" ? result : "");
  return text.trim();
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
    "- labelは短い見出し（例：「首里城公園に到着」「ダイヤモンドヘッド登頂」）にすること。体言止め（名詞で終える）を基本とし、「〜する」「〜した」のような文にはしないこと（例の「到着」「登頂」のように、動詞ではなく名詞で終える）",
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
    "- labelは短い見出し（例：「首里城公園に到着」「ダイヤモンドヘッド登頂」）にすること。体言止め（名詞で終える）を基本とし、「〜する」「〜した」のような文にはしないこと（例の「到着」「登頂」のように、動詞ではなく名詞で終える）",
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
// kind：'voice'（音声入力・レシート。既定）か 'memo'（メモをAIで整理）。枠を使い切ったら回数券を使う。
async function checkVoiceQuota(env, email, kind) {
  if (!isValidEmailFormat(email)) return { ok: false, reason: "login_required" };
  const normalized = email.trim().toLowerCase();
  const account = await env.DB.prepare("SELECT * FROM accounts WHERE email = ?").bind(normalized).first();
  if (!account) return { ok: false, reason: "login_required" };
  const reset = await resetPeriodIfNeeded(env, account);
  const memo = kind === "memo";
  const limit = memo ? (MEMO_MONTHLY_LIMIT[reset.plan] || MEMO_MONTHLY_LIMIT.free) : (PLAN_MONTHLY_LIMIT[reset.plan] || 0);
  const used = memo ? (reset.memo_uses_this_period || 0) : reset.voice_uses_this_period;
  if (used < limit) return { ok: true, via: "plan", email: normalized, kind: memo ? "memo" : "voice" };
  if ((reset.ticket_credits || 0) > 0) return { ok: true, via: "ticket", email: normalized, kind: memo ? "memo" : "voice" };
  return { ok: false, reason: reset.plan === "free" ? "premium_required" : "quota_exceeded" };
}

async function consumeVoiceQuota(env, email, via, kind) {
  const t = nowIso();
  if (via === "ticket") {
    await env.DB.prepare("UPDATE accounts SET ticket_credits = MAX(0, ticket_credits - 1), updated_at=? WHERE email=?").bind(t, email).run();
  } else if (kind === "memo") {
    await env.DB.prepare("UPDATE accounts SET memo_uses_this_period = memo_uses_this_period + 1, updated_at=? WHERE email=?").bind(t, email).run();
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

// /ai-compare専用。organizeTextIntoBlocksと同じプロンプト・スキーマ（voicePrompt/
// multiDayPrompt・voiceBlocksSchema/multiDayBlocksSchema）を使い、OpenAIの代わりに
// Workers AIのLLMで試す（本番の処理からは呼ばない）。モデルによってresponse_format
// （json_schemaでの構造化出力）の対応状況が違う可能性があるため、まずresponse_format
// 付きで呼び、レスポンスのJSONパースに失敗した場合は「JSON以外を返さないこと」という
// 指示を足したプロンプトだけで再試行する（それでも失敗したらエラーを返すだけで、
// 本番のデータには一切触れない）。
async function organizeTextIntoBlocksWithWorkersAi(env, model, text, notes, dates) {
  const multiDay = Array.isArray(dates) && dates.length > 1;
  const schema = multiDay ? multiDayBlocksSchema() : voiceBlocksSchema();
  const schemaName = multiDay ? "voice_blocks_multi_day" : "voice_blocks";
  const basePrompt = multiDay ? multiDayPrompt(text, notes, dates) : voicePrompt(text, notes);

  function parseModelOutput(raw) {
    if (raw == null) return null;
    if (typeof raw === "object" && !Array.isArray(raw)) return raw; // すでにJSONとして返るモデルもある
    const s = String(raw).trim();
    // ```json ... ``` のようなコードブロックで返してくるモデルにも備える
    const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : s;
    try { return JSON.parse(candidate); } catch { return null; }
  }

  async function callOnce(prompt, withResponseFormat) {
    const input = {
      messages: [{ role: "user", content: prompt }],
      max_tokens: multiDay ? 12000 : 2000,
    };
    if (withResponseFormat) {
      input.response_format = { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } };
    }
    const result = await env.AI.run(model, input);
    const raw = result && (result.response ?? result);
    return parseModelOutput(raw);
  }

  let parsed;
  try {
    parsed = await callOnce(basePrompt, true);
  } catch (e) {
    // response_format自体に対応していないモデルの可能性があるため、指示だけの
    // プロンプトで1回だけ再試行する
    try {
      const jsonOnlyPrompt = basePrompt + "\n\n出力は必ずJSONのみとし、説明文やコードブロックの記号（```）を付けないこと。";
      parsed = await callOnce(jsonOnlyPrompt, false);
    } catch (e2) {
      return { error: "workers_ai_error", detail: String((e2 && e2.message) || e2).slice(0, 300) };
    }
  }
  if (!parsed) {
    const jsonOnlyPrompt = basePrompt + "\n\n出力は必ずJSONのみとし、説明文やコードブロックの記号（```）を付けないこと。";
    try { parsed = await callOnce(jsonOnlyPrompt, false); } catch { /* 下のinvalid_model_outputに落ちる */ }
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
  const auth = await resolveEmail(request, env, optStr(meta.email, 200) && meta.email ? String(meta.email) : "");
  if (auth.error) return json({ error: auth.error }, auth.status, headers);
  const email = auth.email;

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

// 決まった形のメモ（「10:00 新宿」のような時刻で始まる行＝予定、その下の行＝記録）を、アプリ側で分けたものを
// そのまま保存する。AIを使わないので、ログインも回数も要らない（手で1件ずつ記録を足すのと同じ扱い）。
// 保存の仕方はAIで整理したときと同じ（saveOrganizedBlocks）。
const MEMO_MAX_BLOCKS = 100;
async function createBlocksFromMemo(tripId, request, env, headers) {
  const trip = await env.DB.prepare("SELECT start_date, end_date FROM trips WHERE id = ?").bind(tripId).first();
  if (!trip) return json({ error: "trip_not_found" }, 404, headers);
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  if (!Array.isArray(data.blocks) || !data.blocks.length || data.blocks.length > MEMO_MAX_BLOCKS) return json({ error: "invalid_input" }, 400, headers);
  const author = optStr(data.author, 50) && data.author ? String(data.author).trim() : "";
  const tripDates = tripDateList(trip.start_date, trip.end_date);
  const dates = tripDates.length ? tripDates : [...new Set(data.blocks.map((b) => b && b.date).filter((d) => isStr(d, 10) && DATE_RE.test(d)))];
  if (!dates.length) return json({ error: "invalid_date" }, 400, headers);
  const created = await saveOrganizedBlocks(env, tripId, dates, data.blocks, author);
  await env.DB.prepare("UPDATE trips SET updated_at = ? WHERE id = ?").bind(nowIso(), tripId).run();
  return json({ blocks: created }, 200, headers);
}

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
  const auth = await resolveEmail(request, env, optStr(data.email, 200) && data.email ? String(data.email) : "");
  if (auth.error) return json({ error: auth.error }, auth.status, headers);
  const email = auth.email;

  const quota = await checkVoiceQuota(env, email, "memo");
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
  await consumeVoiceQuota(env, quota.email, quota.via, "memo");
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
  const auth = await resolveEmail(request, env, optStr(meta.email, 200) && meta.email ? String(meta.email) : "");
  if (auth.error) return json({ error: auth.error }, auth.status, headers);
  const email = auth.email;

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
  const auth = await resolveEmail(request, env, optStr(data.email, 200) && data.email ? String(data.email) : "");
  if (auth.error) return json({ error: auth.error }, auth.status, headers);
  const email = auth.email;

  const quota = await checkVoiceQuota(env, email, "memo");
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
  await consumeVoiceQuota(env, quota.email, quota.via, "memo");
  return json({ blocks: created, transcript: text }, 200, headers);
}

/* ---------- OpenAI→Workers AIの切り替え比較（試作、docs/adr/0012） ----------
 * 管理者だけが使う `POST /ai-compare`。Workerのシークレット`AI_COMPARE_TOKEN`を
 * 設定していないと常に404（機能自体が存在しないように見せる）。設定していても、
 * ヘッダー`x-compare-token`が一致しないと同じく404にする（403にして「有効なエンドポイントが
 * ある」ことを教えない）。何も保存せず、利用者の音声・メモの内容はログにも一切出さない。
 */
function timingSafeEqualStrings(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function aiCompareMemo(request, env, headers) {
  let data;
  try { data = await request.json(); } catch { return json({ error: "invalid_json" }, 400, headers); }
  const text = isStr(data.text, MAX_MULTI_DAY_TEXT_CHARS) ? data.text.trim() : "";
  if (!text) return json({ error: "empty_text" }, 422, headers);
  const notes = optStr(data.notes, 4000) && data.notes ? String(data.notes).trim() : "";
  const dates = Array.isArray(data.dates) ? data.dates.filter((d) => isStr(d, 10) && DATE_RE.test(d)) : undefined;

  const openaiResult = { result: null, ms: 0, error: undefined };
  if (env.OPENAI_API_KEY) {
    const t0 = Date.now();
    const r = await organizeTextIntoBlocks(env, text, notes, dates);
    openaiResult.ms = Date.now() - t0;
    if (r.error) openaiResult.error = r.error; else openaiResult.result = r;
  } else {
    openaiResult.error = "server_not_configured";
  }

  const workersAi = {};
  await Promise.all(
    Object.entries(WORKERS_AI_LLM_MODELS).map(async ([key, model]) => {
      const t0 = Date.now();
      try {
        const r = await organizeTextIntoBlocksWithWorkersAi(env, model, text, notes, dates);
        const ms = Date.now() - t0;
        if (r.error) workersAi[key] = { result: null, ms, error: r.error };
        else workersAi[key] = { result: r, ms };
      } catch (e) {
        workersAi[key] = { result: null, ms: Date.now() - t0, error: String((e && e.message) || e).slice(0, 300) };
      }
    })
  );

  return json({ openai: openaiResult, workersAi }, 200, headers);
}

async function aiCompareVoice(request, env, headers) {
  const { buf, contentType, format: providedFormat } = await (async () => {
    const b = await readBinaryBody(request);
    return { ...b, format: VOICE_AUDIO_FORMATS[b.contentType] };
  })();
  if (!providedFormat) return json({ error: "unsupported_type" }, 415, headers);
  if (buf.byteLength === 0 || buf.byteLength > MAX_VOICE_AUDIO_BYTES) return json({ error: "invalid_size" }, 413, headers);

  const openaiResult = { result: null, ms: 0, error: undefined };
  if (env.OPENAI_API_KEY) {
    const t0 = Date.now();
    const transcript = await transcribeAudio(env, buf, contentType, providedFormat);
    openaiResult.ms = Date.now() - t0;
    if (transcript == null) openaiResult.error = "transcription_failed";
    else openaiResult.result = transcript;
  } else {
    openaiResult.error = "server_not_configured";
  }

  const workersAiResult = { result: null, ms: 0, error: undefined };
  {
    const t0 = Date.now();
    try {
      const transcript = await transcribeAudioWithWorkersAi(env, buf);
      workersAiResult.ms = Date.now() - t0;
      workersAiResult.result = transcript;
    } catch (e) {
      workersAiResult.ms = Date.now() - t0;
      workersAiResult.error = String((e && e.message) || e).slice(0, 300);
    }
  }

  return json({ openai: openaiResult, workersAi: { [WORKERS_AI_WHISPER_MODEL]: workersAiResult } }, 200, headers);
}

async function aiCompare(request, env, headers, url) {
  if (!env.AI_COMPARE_TOKEN || !timingSafeEqualStrings(request.headers.get("x-compare-token") || "", env.AI_COMPARE_TOKEN)) {
    return json({ error: "not_found" }, 404, headers);
  }
  if (!env.AI) return json({ error: "server_not_configured" }, 503, headers);
  const mode = url.searchParams.get("mode");
  if (mode === "memo") return aiCompareMemo(request, env, headers);
  if (mode === "voice") return aiCompareVoice(request, env, headers);
  return json({ error: "invalid_mode" }, 400, headers);
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

// Cloud Vision（DOCUMENT_TEXT_DETECTION）でレシートの文字を読み取り、ルールベースの
// parseReceiptText（receipt-parse.js）で品目に分ける（docs/adr/0011）。無料枠は月1,000枚。
// 読み取れなかった・0件だったとき、またはVision呼び出し自体が失敗したときはnullを返し、
// 呼び出し側（scanReceipt）が今までどおりOpenAIに回せるようにする。
async function scanReceiptWithVision(base64, env) {
  try {
    const res = await fetch("https://vision.googleapis.com/v1/images:annotate?key=" + encodeURIComponent(env.GOOGLE_API_KEY), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requests: [{
          image: { content: base64 },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          imageContext: { languageHints: ["ja"] },
        }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data && Array.isArray(data.responses) && data.responses[0];
    if (!result || result.error) return null;
    const text = result.fullTextAnnotation && result.fullTextAnnotation.text;
    if (!text) return null;
    const parsed = parseReceiptText(text);
    return parsed.items.length ? parsed.items : null;
  } catch {
    return null;
  }
}

async function scanReceipt(request, env, headers) {
  if (!env.GOOGLE_API_KEY && !env.OPENAI_API_KEY) return json({ error: "server_not_configured" }, 503, headers);
  const { buf, contentType, getHeader } = await readBinaryBody(request);
  if (!Object.prototype.hasOwnProperty.call(IMAGE_EXT, contentType)) return json({ error: "unsupported_type" }, 415, headers);
  if (buf.byteLength === 0 || buf.byteLength > MAX_RECEIPT_IMAGE_BYTES) return json({ error: "invalid_size" }, 413, headers);

  const meta = decodeVoiceMeta(getHeader("x-receipt-meta"));
  const auth = await resolveEmail(request, env, optStr(meta.email, 200) && meta.email ? String(meta.email) : "");
  if (auth.error) return json({ error: auth.error }, auth.status, headers);
  const email = auth.email;

  if (env.AI_RATE_LIMITER) {
    const actor = request.headers.get("cf-connecting-ip") || "anonymous";
    const limited = await env.AI_RATE_LIMITER.limit({ key: actor });
    if (!limited.success) return json({ error: "rate_limited" }, 429, headers);
  }

  const base64 = arrayBufferToBase64(buf);

  // Visionが使えるときはこちらを先に試す。回数の枠（checkVoiceQuota）を使わないため、
  // 無料プランでもレシート読み取りが使えるようになる。失敗したときだけOpenAIに回す
  // （そのときは今までどおり音声入力と共通の枠を使う）。
  if (env.GOOGLE_API_KEY) {
    const visionItems = await scanReceiptWithVision(base64, env);
    if (visionItems) return json({ items: visionItems }, 200, headers);
  }

  if (!env.OPENAI_API_KEY) return json({ error: "server_not_configured" }, 503, headers);

  // プラン・回数券の確認（音声入力・テキストメモと同じ枠。docs/adr/0004）
  const quota = await checkVoiceQuota(env, email);
  if (!quota.ok) return json({ error: quota.reason }, 403, headers);

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

/* ---------- いいね・コメント（友達同士のSNS機能。docs/adr/0006） ----------
 * 旅行（target_type='trip'）と記録（'entry'）の両方に、いいね・コメントをつけられる。
 * 読むのは旅行のリンクを知っている人なら誰でも（旅行そのものと同じ）、書くのはログイン済みの人だけ
 * （セッショントークン必須。メールアドレスだけの古い方式は受け付けない）。
 * 書いた人はaccount_idで持ち、名前はaccountsから引く（メールアドレスは他人に見せない）。
 *
 * Appleの審査ガイドライン1.2（ユーザーが投稿したものを他の人が見られるアプリ）の要件：
 * - 不適切な投稿を防ぐ仕組み：明らかな誹謗中傷・差別の語を含むコメントは保存しない（BANNED_WORDS）
 * - 通報：通報した本人にはそのコメントが見えなくなり、運営者（REPORT_NOTIFY_EMAIL）にメールで知らせる
 * - ブロック：ブロックした相手のコメントは、自分には見えなくなる
 */
const SOCIAL_TARGETS = ["trip", "entry"];
const COMMENT_MAX_LENGTH = 500;
// 完全な判定は無理なので、明らかなものだけを弾く（見逃しは通報・ブロックで補う）。
const BANNED_WORDS = [
  "死ね", "しね", "氏ね", "殺す", "ころす", "消えろ", "きもい", "キモい", "うざい", "ウザい", "ブス", "ガイジ",
  "fuck", "shit", "bitch", "kill yourself", "nigger", "faggot", "retard",
];

function containsBannedWord(text) {
  const t = text.normalize("NFKC").toLowerCase();
  return BANNED_WORDS.some((w) => t.includes(w.normalize("NFKC").toLowerCase()));
}

// ログイン中の本人（セッション必須）のアカウント。無ければ作る（ensureを経ずに来た場合のため）。
async function requireAccount(request, env) {
  const auth = await resolveEmail(request, env, "", true);
  if (auth.error) return auth;
  const account = await getOrCreateAccount(env, auth.email, "");
  return { account };
}

// 対象が本当にその旅行のものか確かめる（他の旅行の記録に書き込ませない）。
async function targetBelongsToTrip(env, tripId, targetType, targetId) {
  if (!SOCIAL_TARGETS.includes(targetType) || !isStr(targetId, 100) || !targetId) return false;
  if (targetType === "trip") {
    if (targetId !== tripId) return false;
    return !!(await env.DB.prepare("SELECT id FROM trips WHERE id = ?").bind(tripId).first());
  }
  const row = await env.DB.prepare(
    "SELECT b.trip_id FROM entries e JOIN blocks b ON b.id = e.block_id WHERE e.id = ?"
  ).bind(targetId).first();
  return !!(row && row.trip_id === tripId);
}

// 旅行1件分のいいね・コメントをまとめて返す（旅行を開いたときに1回だけ呼ぶ）。
// ログイン中なら、自分がいいねしたか・自分のコメントか、も付ける。ブロックした相手・通報したコメントは除く。
async function getTripSocial(tripId, request, env, headers) {
  const email = await sessionEmail(request, env);
  const me = email ? await env.DB.prepare("SELECT account_id FROM accounts WHERE email = ?").bind(email).first() : null;
  const myId = me ? me.account_id : "";

  const { results: likeRows } = await env.DB.prepare(
    "SELECT target_type, target_id, account_id FROM likes WHERE trip_id = ?"
  ).bind(tripId).all();
  const likes = {};
  for (const r of likeRows) {
    const k = r.target_type + ":" + r.target_id;
    if (!likes[k]) likes[k] = { count: 0, liked: false };
    likes[k].count++;
    if (myId && r.account_id === myId) likes[k].liked = true;
  }

  const { results: commentRows } = await env.DB.prepare(
    `SELECT c.id, c.target_type, c.target_id, c.account_id, c.body, c.created_at, a.name
     FROM comments c LEFT JOIN accounts a ON a.account_id = c.account_id
     WHERE c.trip_id = ? ORDER BY c.created_at ASC`
  ).bind(tripId).all();
  let hiddenAccounts = new Set(), hiddenComments = new Set();
  if (myId) {
    const { results: blocked } = await env.DB.prepare(
      "SELECT blocked_account_id FROM user_blocks WHERE blocker_account_id = ?"
    ).bind(myId).all();
    hiddenAccounts = new Set(blocked.map((r) => r.blocked_account_id));
    const { results: reported } = await env.DB.prepare(
      "SELECT comment_id FROM comment_reports WHERE reporter_account_id = ?"
    ).bind(myId).all();
    hiddenComments = new Set(reported.map((r) => r.comment_id));
  }
  const comments = commentRows
    .filter((r) => !hiddenAccounts.has(r.account_id) && !hiddenComments.has(r.id))
    .map((r) => ({
      id: r.id, targetType: r.target_type, targetId: r.target_id, accountId: r.account_id,
      name: r.name || "", body: r.body, createdAt: r.created_at, mine: !!myId && r.account_id === myId,
    }));
  return json({ likes, comments, accountId: myId }, 200, headers);
}

async function readSocialBody(request) {
  try { return await request.json(); } catch { return null; }
}

async function setLike(tripId, request, env, headers, on) {
  const data = await readSocialBody(request);
  if (!data) return json({ error: "invalid_json" }, 400, headers);
  const who = await requireAccount(request, env);
  if (who.error) return json({ error: who.error }, who.status, headers);
  if (!(await targetBelongsToTrip(env, tripId, data.targetType, data.targetId))) return json({ error: "not_found" }, 404, headers);
  const accountId = who.account.account_id;
  if (on) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO likes (id, trip_id, target_type, target_id, account_id, created_at) VALUES (?,?,?,?,?,?)"
    ).bind(uid("lk"), tripId, data.targetType, data.targetId, accountId, nowIso()).run();
  } else {
    await env.DB.prepare("DELETE FROM likes WHERE target_type = ? AND target_id = ? AND account_id = ?")
      .bind(data.targetType, data.targetId, accountId).run();
  }
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM likes WHERE target_type = ? AND target_id = ?")
    .bind(data.targetType, data.targetId).first();
  return json({ count: row ? row.n : 0, liked: on }, 200, headers);
}

async function createComment(tripId, request, env, headers) {
  const data = await readSocialBody(request);
  if (!data) return json({ error: "invalid_json" }, 400, headers);
  const who = await requireAccount(request, env);
  if (who.error) return json({ error: who.error }, who.status, headers);
  const body = typeof data.body === "string" ? data.body.trim() : "";
  if (!body || body.length > COMMENT_MAX_LENGTH) return json({ error: "invalid_body" }, 400, headers);
  if (containsBannedWord(body)) return json({ error: "inappropriate" }, 422, headers);
  if (!(await targetBelongsToTrip(env, tripId, data.targetType, data.targetId))) return json({ error: "not_found" }, 404, headers);
  const c = {
    id: uid("cm"), trip_id: tripId, target_type: data.targetType, target_id: data.targetId,
    account_id: who.account.account_id, body, created_at: nowIso(),
  };
  await env.DB.prepare(
    "INSERT INTO comments (id, trip_id, target_type, target_id, account_id, body, created_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(c.id, c.trip_id, c.target_type, c.target_id, c.account_id, c.body, c.created_at).run();
  return json({
    id: c.id, targetType: c.target_type, targetId: c.target_id, accountId: c.account_id,
    name: who.account.name || "", body: c.body, createdAt: c.created_at, mine: true,
  }, 201, headers);
}

// 自分のコメントだけ消せる
async function deleteComment(commentId, request, env, headers) {
  const who = await requireAccount(request, env);
  if (who.error) return json({ error: who.error }, who.status, headers);
  const row = await env.DB.prepare("SELECT account_id FROM comments WHERE id = ?").bind(commentId).first();
  if (!row) return json({ error: "not_found" }, 404, headers);
  if (row.account_id !== who.account.account_id) return json({ error: "forbidden" }, 403, headers);
  await env.DB.prepare("DELETE FROM comment_reports WHERE comment_id = ?").bind(commentId).run();
  await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(commentId).run();
  return json({ ok: true }, 200, headers);
}

async function reportComment(commentId, request, env, headers, ctx) {
  const data = (await readSocialBody(request)) || {};
  const who = await requireAccount(request, env);
  if (who.error) return json({ error: who.error }, who.status, headers);
  const c = await env.DB.prepare("SELECT id, trip_id, account_id, body FROM comments WHERE id = ?").bind(commentId).first();
  if (!c) return json({ error: "not_found" }, 404, headers);
  const reason = typeof data.reason === "string" ? data.reason.trim().slice(0, 200) : "";
  await env.DB.prepare(
    "INSERT OR IGNORE INTO comment_reports (id, comment_id, reporter_account_id, reason, created_at) VALUES (?,?,?,?,?)"
  ).bind(uid("rp"), commentId, who.account.account_id, reason, nowIso()).run();
  if (env.RESEND_API_KEY && env.REPORT_NOTIFY_EMAIL) {
    ctx.waitUntil(fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        from: env.RESEND_FROM || "旅の足跡 <onboarding@resend.dev>",
        to: [env.REPORT_NOTIFY_EMAIL],
        subject: "旅の足跡：コメントが通報されました",
        text: "コメントID: " + c.id + "\n旅行ID: " + c.trip_id + "\n書いた人のアカウントID: " + c.account_id
          + "\n通報した人のアカウントID: " + who.account.account_id + "\n理由: " + (reason || "（未記入）")
          + "\n\n本文:\n" + c.body + "\n\n24時間以内に内容を確認し、必要ならD1から削除してください。",
      }),
    }).catch(() => {}));
  }
  return json({ ok: true }, 200, headers);
}

async function setUserBlock(request, env, headers, on) {
  const data = (await readSocialBody(request)) || {};
  const who = await requireAccount(request, env);
  if (who.error) return json({ error: who.error }, who.status, headers);
  const target = typeof data.accountId === "string" ? data.accountId.trim() : "";
  if (!/^\d{6}$/.test(target) || target === who.account.account_id) return json({ error: "invalid_input" }, 400, headers);
  if (on) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO user_blocks (blocker_account_id, blocked_account_id, created_at) VALUES (?,?,?)"
    ).bind(who.account.account_id, target, nowIso()).run();
  } else {
    await env.DB.prepare("DELETE FROM user_blocks WHERE blocker_account_id = ? AND blocked_account_id = ?")
      .bind(who.account.account_id, target).run();
  }
  return json({ ok: true }, 200, headers);
}

async function deleteSocialForTarget(env, targetType, targetId) {
  await env.DB.prepare(
    "DELETE FROM comment_reports WHERE comment_id IN (SELECT id FROM comments WHERE target_type = ? AND target_id = ?)"
  ).bind(targetType, targetId).run();
  await env.DB.prepare("DELETE FROM comments WHERE target_type = ? AND target_id = ?").bind(targetType, targetId).run();
  await env.DB.prepare("DELETE FROM likes WHERE target_type = ? AND target_id = ?").bind(targetType, targetId).run();
}

async function deleteSocialForTrip(env, tripId) {
  await env.DB.prepare(
    "DELETE FROM comment_reports WHERE comment_id IN (SELECT id FROM comments WHERE trip_id = ?)"
  ).bind(tripId).run();
  await env.DB.prepare("DELETE FROM comments WHERE trip_id = ?").bind(tripId).run();
  await env.DB.prepare("DELETE FROM likes WHERE trip_id = ?").bind(tripId).run();
}

async function deleteSocialForAccount(env, accountId) {
  await env.DB.prepare(
    "DELETE FROM comment_reports WHERE comment_id IN (SELECT id FROM comments WHERE account_id = ?)"
  ).bind(accountId).run();
  await env.DB.prepare("DELETE FROM comment_reports WHERE reporter_account_id = ?").bind(accountId).run();
  await env.DB.prepare("DELETE FROM comments WHERE account_id = ?").bind(accountId).run();
  await env.DB.prepare("DELETE FROM likes WHERE account_id = ?").bind(accountId).run();
  await env.DB.prepare("DELETE FROM user_blocks WHERE blocker_account_id = ? OR blocked_account_id = ?")
    .bind(accountId, accountId).run();
}

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
    if (method === "PATCH" && (m = path.match(/^\/trips\/([^/]+)$/))) return updateTrip(m[1], request, env, headers, ctx);
    if (method === "DELETE" && (m = path.match(/^\/trips\/([^/]+)$/))) return deleteTrip(m[1], env, headers);

    if (method === "POST" && (m = path.match(/^\/trips\/([^/]+)\/blocks$/))) return createBlock(m[1], request, env, headers);
    if (method === "PATCH" && (m = path.match(/^\/blocks\/([^/]+)$/))) return updateBlock(m[1], request, env, headers);
    if (method === "DELETE" && (m = path.match(/^\/blocks\/([^/]+)$/))) return deleteBlock(m[1], env, headers);
    if (method === "PATCH" && (m = path.match(/^\/trips\/([^/]+)\/days\/([^/]+)\/blocks\/reorder$/))) {
      return reorderBlocks(m[1], m[2], request, env, headers);
    }

    if (method === "POST" && (m = path.match(/^\/blocks\/([^/]+)\/entries$/))) return createEntry(m[1], request, env, headers, ctx);
    if (method === "PATCH" && (m = path.match(/^\/entries\/([^/]+)$/))) return updateEntry(m[1], request, env, headers, ctx);
    if (method === "PATCH" && (m = path.match(/^\/entries\/([^/]+)\/move$/))) return moveEntry(m[1], request, env, headers);
    if (method === "DELETE" && (m = path.match(/^\/entries\/([^/]+)$/))) return deleteEntry(m[1], env, headers);

    if (method === "PUT" && (m = path.match(/^\/entries\/([^/]+)\/rating$/))) return setRating(m[1], request, env, headers);
    if (method === "DELETE" && (m = path.match(/^\/entries\/([^/]+)\/rating$/))) return deleteRating(m[1], request, env, headers);
    if (method === "GET" && (m = path.match(/^\/trips\/([^/]+)\/social$/))) return getTripSocial(m[1], request, env, headers);
    if (method === "PUT" && (m = path.match(/^\/trips\/([^/]+)\/likes$/))) return setLike(m[1], request, env, headers, true);
    if (method === "DELETE" && (m = path.match(/^\/trips\/([^/]+)\/likes$/))) return setLike(m[1], request, env, headers, false);
    if (method === "POST" && (m = path.match(/^\/trips\/([^/]+)\/comments$/))) return createComment(m[1], request, env, headers);
    if (method === "DELETE" && (m = path.match(/^\/comments\/([^/]+)$/))) return deleteComment(m[1], request, env, headers);
    if (method === "POST" && (m = path.match(/^\/comments\/([^/]+)\/report$/))) return reportComment(m[1], request, env, headers, ctx);
    if (method === "PUT" && path === "/user-blocks") return setUserBlock(request, env, headers, true);
    if (method === "DELETE" && path === "/user-blocks") return setUserBlock(request, env, headers, false);
    if (method === "GET" && path === "/geocode") return geocodeForReplay(url.searchParams.get("q"), headers, ctx, url.searchParams.get("quick") === "1", url.searchParams.get("near"), url.searchParams.get("hint"), url.searchParams.get("entry"), env);
    if (method === "GET" && path === "/route") return getRoute(url, headers, ctx);
    if (method === "GET" && path === "/timezone") return getTimezone(url, headers, ctx);
    if (method === "GET" && path === "/places/search") {
      return searchPlaces(url.searchParams.get("q"), headers, ctx, env, url.searchParams.get("session"));
    }
    if (method === "GET" && path === "/places/details") {
      return placeDetails(url.searchParams.get("id"), url.searchParams.get("session"), env, headers);
    }
    if (method === "GET" && path === "/mylog") {
      const auth = await resolveEmail(request, env, url.searchParams.get("email") || "");
      if (auth.error) return json({ error: auth.error }, auth.status, headers);
      return getMyLog(auth.email, env, headers);
    }

    if (method === "PUT" && (m = path.match(/^\/trips\/([^/]+)\/days\/([^/]+)$/))) return setDayPlace(m[1], m[2], request, env, headers);
    if (method === "POST" && (m = path.match(/^\/trips\/([^/]+)\/days\/([^/]+)\/auto-place$/))) return autoSetDayPlace(m[1], m[2], request, env, headers);
    if (method === "DELETE" && (m = path.match(/^\/trips\/([^/]+)\/days\/([^/]+)$/))) return deleteDayPlace(m[1], m[2], env, headers);
    if (method === "PATCH" && (m = path.match(/^\/trips\/([^/]+)\/days\/([^/]+)\/weather$/))) return setDayWeatherManual(m[1], m[2], request, env, headers);

    if (method === "POST" && path === "/auth/email/send") return sendEmailOtp(request, env, headers);
    if (method === "POST" && path === "/auth/email/verify") return verifyEmailOtp(request, env, headers);
    if (method === "POST" && path === "/auth/logout") return logout(request, env, headers);

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
    if (method === "POST" && (m = path.match(/^\/trips\/([^/]+)\/memo-blocks$/))) return createBlocksFromMemo(m[1], request, env, headers);
    if (method === "POST" && (m = path.match(/^\/trips\/([^/]+)\/text-entries$/))) {
      return createBlocksFromTextMultiDay(m[1], request, env, headers);
    }

    if (method === "POST" && path === "/photos") return uploadPhoto(request, env, headers);
    if (method === "GET" && (m = path.match(/^\/photos\/([^/]+)$/))) return getPhoto(m[1], env, headers);

    if (method === "POST" && path === "/receipts/scan") return scanReceipt(request, env, headers);

    if (method === "POST" && path === "/ai-compare") return aiCompare(request, env, headers, url);

    return json({ error: "not_found" }, 404, headers);
  },
};
