/*
 * 音声・メモ（AI）の確認画面つき取り込みと、3つ共通の保存（POST /trips/:id/import-blocks）を、
 * Workerの入口（fetch）から、node:sqlite（Node 22.5+）の本物のSQLiteの上で通しで確かめる
 * （docs/adr/0022 2026-09-30追記、docs/adr/0002、docs/adr/0021）。
 * OpenAI（文字起こし・整理）・Google Placesはモック（有料APIは呼ばない）。
 * 確かめること：候補を返すだけで何も保存しない／枠の消費（音声＝音声枠、メモ＝メモ枠）／サブリクエスト（fetchとD1）の回数／
 * 別行動の持ち主だけが使える（セッション）／別行動の日程・時間帯の検証／保存（branch_id・文字起こし・費用・地図）。
 * 実行: node worker/test/import-handler.test.mjs
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import worker from "../src/index.js";

let pass = 0, fail = 0;
function check(label, got, want) {
  try { assert.deepEqual(got, want); pass++; } catch {
    fail++;
    console.log("NG  " + label + "\n    got  " + JSON.stringify(got) + "\n    want " + JSON.stringify(want));
  }
}
function ok(label, cond) { check(label, !!cond, true); }

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`
CREATE TABLE trips (id TEXT PRIMARY KEY, title TEXT NOT NULL, start_date TEXT NOT NULL DEFAULT '', end_date TEXT NOT NULL DEFAULT '', companions TEXT NOT NULL DEFAULT '[]', cover_photo_id TEXT NOT NULL DEFAULT '', trip_type TEXT NOT NULL DEFAULT '', settle_unit INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE blocks (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, date TEXT NOT NULL DEFAULT '', time TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'sightseeing', transport TEXT NOT NULL DEFAULT '', move_minutes INTEGER NOT NULL DEFAULT 0, manual_order INTEGER, tz_override TEXT, branch_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE entries (id TEXT PRIMARY KEY, block_id TEXT NOT NULL, episode TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', photo_ids TEXT NOT NULL DEFAULT '[]', video_ids TEXT NOT NULL DEFAULT '[]', cost_items TEXT NOT NULL DEFAULT '[]', wait_time TEXT NOT NULL DEFAULT '', map_url TEXT NOT NULL DEFAULT '', map_place_name TEXT NOT NULL DEFAULT '', map_lat REAL, map_lng REAL, map_geocoded_url TEXT, map_geocoded_at TEXT, shop_url TEXT NOT NULL DEFAULT '', other_url TEXT NOT NULL DEFAULT '', time TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', travel TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE day_infos (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, date TEXT NOT NULL, place TEXT NOT NULL DEFAULT '', is_forecast INTEGER NOT NULL DEFAULT 0, fetched_at TEXT NOT NULL DEFAULT '', voice_transcript TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
CREATE TABLE accounts (email TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT 'free', ticket_credits INTEGER NOT NULL DEFAULT 0, plan_period_start TEXT NOT NULL DEFAULT '', voice_uses_this_period INTEGER NOT NULL DEFAULT 0, memo_uses_this_period INTEGER NOT NULL DEFAULT 0, stripe_customer_id TEXT NOT NULL DEFAULT '', stripe_subscription_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE trip_members (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, account_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', joined_at TEXT NOT NULL, UNIQUE(trip_id, account_id));
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE branches (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, account_id TEXT NOT NULL, date TEXT NOT NULL, end_date TEXT NOT NULL DEFAULT '', start_time TEXT NOT NULL, end_time TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
`);

const queries = [];
const DB = {
  prepare(sql) {
    const st = sqlite.prepare(sql);
    let params = [];
    const o = {
      bind(...p) { params = p; return o; },
      async first() { queries.push(sql); return st.get(...params) || null; },
      async all() { queries.push(sql); return { results: st.all(...params) }; },
      async run() { queries.push(sql); st.run(...params); return { success: true }; },
      _run() { st.run(...params); },
    };
    return o;
  },
  async batch(stmts) {
    queries.push("BATCH");
    sqlite.exec("BEGIN");
    try { for (const s of stmts) s._run(); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  },
};
const env = { DB, ALLOWED_ORIGIN: "https://app.example", REQUIRE_SESSION: "1", OPENAI_API_KEY: "test", GOOGLE_API_KEY: "test" };

const now = new Date().toISOString();
const later = new Date(Date.now() + 86400000).toISOString();
const period = now.slice(0, 7) + "-01";
const tokens = { alice: "a".repeat(64), bob: "b".repeat(64) };
const people = { alice: ["alice@example.com", "111111", "アリス"], bob: ["bob@example.com", "222222", "ボブ"] };
for (const [k, [email, aid, name]] of Object.entries(people)) {
  sqlite.prepare("INSERT INTO accounts (email, account_id, name, plan_period_start, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(email, aid, name, period, now, now);
  sqlite.prepare("INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?,?,?,?)").run(createHash("sha256").update(tokens[k]).digest("hex"), email, now, later);
  sqlite.prepare("INSERT INTO trip_members (id, trip_id, account_id, name, joined_at) VALUES (?,?,?,?,?)").run("m_" + k, "t1", aid, name, now);
}
sqlite.prepare("INSERT INTO trips (id, title, start_date, end_date, created_at, updated_at) VALUES ('t1','東京',?,?,?,?)").run("2026-10-03", "2026-10-05", now, now);
// アリスの別行動：10/4 13:00〜18:00（1日）と、10/5 19:00〜（別の日々にまたがる分は作らない）
sqlite.prepare("INSERT INTO branches (id, trip_id, account_id, date, end_date, start_time, end_time, title, created_at, updated_at) VALUES ('br1','t1','111111','2026-10-04','2026-10-04','13:00','18:00','美術館',?,?)").run(now, now);
// 日をまたぐ別行動（10/4 20:00 〜 10/5 12:00）はアリスの別のtripに置く（同じtripでは重なるので）
sqlite.prepare("INSERT INTO trips (id, title, start_date, end_date, created_at, updated_at) VALUES ('t2','大阪',?,?,?,?)").run("2026-10-03", "2026-10-05", now, now);
sqlite.prepare("INSERT INTO trip_members (id, trip_id, account_id, name, joined_at) VALUES ('m2','t2','111111','アリス',?)").run(now);
sqlite.prepare("INSERT INTO branches (id, trip_id, account_id, date, end_date, start_time, end_time, title, created_at, updated_at) VALUES ('br2','t2','111111','2026-10-04','2026-10-05','20:00','12:00','',?,?)").run(now, now);

/* ---- モック ---- */
const empty = { category: "sightseeing", transport: "", date: "", time: "", label: "", routeNumber: "", company: "", fromPlace: "", toPlace: "", departTime: "", arriveTime: "", arriveDate: "", place: "", costItems: [], note: "", mapUrl: "", shopUrl: "" };
const it = (o) => ({ ...empty, ...o });
let aiItems = [];
const fetched = [];
const openaiBodies = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  fetched.push(u.split("?")[0]);
  if (u.includes("vision.googleapis.com")) return new Response(JSON.stringify({ responses: [{ fullTextAnnotation: { text: "美術館のチケット 10月4日 10:00" } }] }));
  if (u.includes("audio/transcriptions")) return new Response(JSON.stringify({ text: "10時に浅草寺、ランチは天丼1500円、そのあとスカイツリー" }));
  if (u.includes("api.openai.com/v1/responses")) {
    openaiBodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ status: "completed", output_text: JSON.stringify({ items: aiItems }) }));
  }
  if (u.includes("places:searchText")) {
    const q = JSON.parse(init.body).textQuery;
    const table = { 浅草寺: [35.7148, 139.7967], 東京スカイツリー: [35.7101, 139.8107] };
    if (!table[q]) return new Response(JSON.stringify({ places: [] }));
    return new Response(JSON.stringify({ places: [{ displayName: { text: q }, formattedAddress: "東京都", location: { latitude: table[q][0], longitude: table[q][1] } }] }));
  }
  return new Response("{}", { status: 404 });
};

async function call(method, path, who, body, extraHeaders) {
  const headers = { origin: "https://app.example", ...(extraHeaders || {}) };
  if (body !== undefined && !(body instanceof Uint8Array)) headers["content-type"] = "application/json";
  if (who) headers.authorization = "Bearer " + tokens[who];
  const init = { method, headers, body: body instanceof Uint8Array ? body : (body !== undefined ? JSON.stringify(body) : undefined) };
  const res = await worker.fetch(new Request("https://api.example" + path, init), env, { waitUntil() {} });
  let data = null;
  try { data = await res.json(); } catch { /* 本文なし */ }
  return { status: res.status, data };
}
const count = (sql) => sqlite.prepare(sql).get().n;
const quota = (email) => sqlite.prepare("SELECT voice_uses_this_period v, memo_uses_this_period m FROM accounts WHERE email = ?").get(email);
function reset() { fetched.length = 0; openaiBodies.length = 0; queries.length = 0; }
const voiceMeta = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const audio = new Uint8Array([1, 2, 3, 4]);
const voiceCall = (who, meta) => call("POST", "/trips/t1/voice-scan", who, audio, { "content-type": "audio/webm", "x-voice-meta": voiceMeta(meta) });

const SAMPLE = [
  it({ category: "sightseeing", time: "10:00", label: "浅草寺", place: "浅草寺", note: "10時に浅草寺へ。" }),
  it({ category: "food", label: "天丼でランチ", costItems: [{ label: "天丼", amount: 1500, currency: "" }], note: "ランチは天丼。" }),
  it({ category: "sightseeing", label: "東京スカイツリー", place: "東京スカイツリー" }),
];

/* ---- メモ（AI）：候補を返すだけ・保存しない・メモの枠を1回 ---- */
{
  reset(); aiItems = SAMPLE;
  const r = await call("POST", "/trips/t1/text-scan", "alice", { text: "10時に浅草寺、ランチは天丼1500円、そのあとスカイツリー", email: "alice@example.com", date: "2026-10-04" });
  check("text-scan: 200", r.status, 200);
  check("text-scan: 日付はその日に固定、時刻は10時だけ、費用は天丼だけ", [r.data.items.map((i) => i.date), r.data.items.map((i) => i.time), r.data.items.map((i) => i.costItems.length)], [["2026-10-04", "2026-10-04", "2026-10-04"], ["10:00", "", ""], [0, 1, 0]]);
  check("text-scan: 場所は浅草寺とスカイツリーに地図が付く（ランチは付かない）", r.data.items.map((i) => !!i.mapLat), [true, false, true]);
  check("text-scan: 外部呼び出しはOpenAI1回＋場所検索2回", fetched.map((u) => u.split("/")[2]), ["api.openai.com", "places.googleapis.com", "places.googleapis.com"]);
  check("text-scan: 保存していない（予定0件・文字起こし0件）", [count("SELECT COUNT(*) n FROM blocks"), count("SELECT COUNT(*) n FROM day_infos")], [0, 0]);
  check("text-scan: メモの枠を1回だけ消費（音声の枠は使わない）", { ...quota("alice@example.com") }, { v: 0, m: 1 });
  ok("text-scan: D1のアクセスは見積もり内", queries.length <= 12);
  check("text-scan: 見積もりを返す（50回以内）", [r.data.usage.placeLookups, r.data.usage.subrequests.ok], [2, true]);
  ok("text-scan: 文字起こし欄用に元の文章を返す", r.data.transcript.startsWith("10時に浅草寺"));
  ok("text-scan: AIにはstrictなスキーマと「推測しない」プロンプト", openaiBodies[0].text.format.strict === true && openaiBodies[0].input.includes("推測で埋めないこと"));
}

/* ---- 音声：文字起こし→候補・音声の枠・保存しない ---- */
{
  reset(); aiItems = SAMPLE;
  const r = await voiceCall("alice", { email: "alice@example.com", date: "2026-10-04" });
  check("voice-scan: 200・transcriptを返す", [r.status, r.data.transcript], [200, "10時に浅草寺、ランチは天丼1500円、そのあとスカイツリー"]);
  check("voice-scan: 3件・時刻・費用・場所", [r.data.items.length, r.data.items[0].time, r.data.items[1].costItems, r.data.items[2].mapPlaceName], [3, "10:00", [{ label: "天丼", amount: 1500 }], "東京スカイツリー"]);
  check("voice-scan: 外部呼び出しは文字起こし1・OpenAI1・場所検索2", fetched.map((u) => u.split("/")[2]), ["api.openai.com", "api.openai.com", "places.googleapis.com", "places.googleapis.com"]);
  check("voice-scan: 何も保存しない", [count("SELECT COUNT(*) n FROM blocks"), count("SELECT COUNT(*) n FROM day_infos")], [0, 0]);
  check("voice-scan: 音声の枠を1回消費（メモの枠はそのまま）", { ...quota("alice@example.com") }, { v: 1, m: 1 });
  // 複数日（dateなし）
  reset(); aiItems = [it({ label: "3日目", date: "2026-10-05" }), it({ label: "1日目", date: "2026-10-03" })];
  const multi = await voiceCall("alice", { email: "alice@example.com" });
  check("voice-scan: 日付なしは旅行の日々（複数日）でAIが選ぶ", multi.data.items.map((i) => i.date), ["2026-10-05", "2026-10-03"]);
  ok("voice-scan: 複数日のプロンプトに日程", openaiBodies[0].input.includes("1日目：2026-10-03"));
  sqlite.prepare("UPDATE accounts SET voice_uses_this_period = 0, memo_uses_this_period = 0").run();
}

/* ---- 枠・ログイン ---- */
{
  reset(); aiItems = SAMPLE;
  const anon = await call("POST", "/trips/t1/text-scan", null, { text: "x", date: "2026-10-04" });
  check("ログインなしは401で外部APIを呼ばない", [anon.status, fetched.length], [401, 0]);
  sqlite.prepare("UPDATE accounts SET memo_uses_this_period = 10 WHERE email = 'bob@example.com'").run();
  const full = await call("POST", "/trips/t1/text-scan", "bob", { text: "x", email: "bob@example.com", date: "2026-10-04" });
  check("メモの枠が切れていれば403で外部APIを呼ばない", [full.status, full.data.error, fetched.length], [403, "quota_exceeded", 0]);
  const noKey = await worker.fetch(new Request("https://api.example/trips/t1/text-scan", { method: "POST", headers: { origin: "https://app.example", "content-type": "application/json", authorization: "Bearer " + tokens.alice }, body: JSON.stringify({ text: "x", date: "2026-10-04" }) }), { ...env, OPENAI_API_KEY: "" }, { waitUntil() {} });
  check("OpenAIのキーが無ければ503", noKey.status, 503);
  const noDates = await call("POST", "/trips/t1/text-scan", "alice", { text: "x", email: "alice@example.com", date: "2026-13-99" });
  ok("壊れた日付は400", noDates.status === 400);
  sqlite.prepare("UPDATE accounts SET memo_uses_this_period = 0").run();
}

/* ---- 別行動：持ち主だけ・日程・時間帯 ---- */
{
  reset(); aiItems = [it({ label: "午前の散歩", time: "10:00" }), it({ label: "美術館", time: "14:00", place: "浅草寺" })];
  const bob = await call("POST", "/trips/t1/text-scan", "bob", { text: "x", email: "bob@example.com", branchId: "br1", date: "2026-10-04" });
  check("他人の別行動には使えない（403・AIを呼ばない）", [bob.status, bob.data.error, fetched.length], [403, "forbidden", 0]);
  const anon = await call("POST", "/trips/t1/text-scan", null, { text: "x", branchId: "br1", date: "2026-10-04" });
  check("ログインなしは401", [anon.status, anon.data.error], [401, "login_required"]);
  const gone = await call("POST", "/trips/t1/text-scan", "alice", { text: "x", email: "alice@example.com", branchId: "nothing", date: "2026-10-04" });
  check("存在しない別行動は404", [gone.status, gone.data.error], [404, "branch_not_found"]);
  const wrongTrip = await call("POST", "/trips/t2/text-scan", "alice", { text: "x", email: "alice@example.com", branchId: "br1", date: "2026-10-04" });
  check("別の旅行の別行動は404", [wrongTrip.status, wrongTrip.data.error], [404, "branch_not_found"]);
  const outDay = await call("POST", "/trips/t1/text-scan", "alice", { text: "x", email: "alice@example.com", branchId: "br1", date: "2026-10-05" });
  check("別行動の日の外は400", [outDay.status, outDay.data.error], [400, "date_out_of_branch"]);
  check("ここまでAIは1回も呼ばれていない", fetched.length, 0);
  queries.length = 0;
  const good = await call("POST", "/trips/t1/text-scan", "alice", { text: "x", email: "alice@example.com", branchId: "br1", date: "2026-10-04" });
  check("持ち主は使える・日付は別行動の日", [good.status, good.data.items.map((i) => i.date)], [200, ["2026-10-04", "2026-10-04"]]);
  check("別行動の時間帯（13:00〜）より前の時刻に警告、中は警告なし", good.data.items.map((i) => i.warnings.filter((w) => w.startsWith("別行動の")).length), [1, 0]);
  ok("プロンプトに別行動の時間帯", openaiBodies[0].input.includes("2026-10-04 13:00 〜 2026-10-04 18:00"));
  ok("別行動のD1アクセスも見積もり内（16回以内）", queries.length <= 16);
  ok("別行動の見積もりは50回以内", good.data.usage.subrequests.ok && good.data.usage.subrequests.total <= 50);
  // 日をまたぐ別行動：dateなし＝別行動の全日
  reset(); aiItems = [it({ label: "夜", date: "2026-10-04", time: "21:00" }), it({ label: "朝", date: "2026-10-05", time: "09:00" }), it({ label: "外", date: "2026-10-03" })];
  const span = await call("POST", "/trips/t2/text-scan", "alice", { text: "x", email: "alice@example.com", branchId: "br2" });
  check("日をまたぐ別行動：日付なしは別行動の日々でAIが選ぶ・外の日付は初日に置いて警告", [span.data.items.map((i) => i.date), span.data.items.map((i) => i.warnings.length)], [["2026-10-04", "2026-10-05", "2026-10-04"], [0, 0, 1]]);
  const vb = await call("POST", "/trips/t1/voice-scan", "bob", audio, { "content-type": "audio/webm", "x-voice-meta": voiceMeta({ email: "bob@example.com", branchId: "br1", date: "2026-10-04" }) });
  check("音声も他人の別行動には使えない", [vb.status, vb.data.error], [403, "forbidden"]);
  sqlite.prepare("UPDATE accounts SET memo_uses_this_period = 0, voice_uses_this_period = 0").run();
}

/* ---- スクショの取り込みも別行動の持ち主だけ・別行動の時間帯で警告 ---- */
{
  const shot = (o) => ({ image: 1, placeGuessed: false, checkOutDate: "", ...empty, ...o });
  aiItems = [shot({ category: "sightseeing", date: "--10-04", time: "10:00", label: "美術館", place: "浅草寺" }), shot({ category: "sightseeing", date: "", time: "15:00", label: "日付なし" })];
  const scan = (who, body) => call("POST", "/trips/t1/screenshot-scan", who, { images: [{ type: "image/jpeg", data: "QUJD" }], email: who ? people[who][0] : "", ...body });
  reset();
  const bob = await scan("bob", { branchId: "br1" });
  check("スクショ: 他人の別行動は403でVisionもAIも呼ばない", [bob.status, bob.data.error, fetched.length], [403, "forbidden", 0]);
  const gone = await scan("alice", { branchId: "nothing" });
  check("スクショ: 存在しない別行動は404", [gone.status, gone.data.error], [404, "branch_not_found"]);
  reset();
  const good = await scan("alice", { branchId: "br1" });
  check("スクショ: 持ち主は使える・日付なしは別行動の初日に置く", [good.status, good.data.items.map((i) => i.date)], [200, ["2026-10-04", "2026-10-04"]]);
  check("スクショ: 別行動の時間帯の外（10:00）だけ警告", good.data.items.map((i) => i.warnings.filter((w) => w.startsWith("別行動の")).length), [1, 0]);
  check("スクショ: 外部呼び出しはVision1・OpenAI1・場所検索1", fetched.map((u) => u.split("/")[2]), ["vision.googleapis.com", "api.openai.com", "places.googleapis.com"]);
  ok("スクショ（別行動）の見積もりは50回以内", good.data.usage.subrequests.ok);
  const shared = await scan("alice", {});
  check("スクショ: 別行動でなければ今までどおり（旅行の初日に置いて警告）", [shared.data.items[1].date, shared.data.items[1].warnings.length], ["2026-10-03", 1]);
  sqlite.prepare("UPDATE accounts SET memo_uses_this_period = 0").run();
}

/* ---- 保存（3つ共通）：共有の予定 ---- */
const item = (o) => ({ date: "2026-10-04", time: "", label: "予定", category: "sightseeing", note: "", costItems: [], ...o });
{
  reset();
  const r = await call("POST", "/trips/t1/import-blocks", null, {
    author: "アリス", transcript: "10時に浅草寺", transcriptDate: "2026-10-04",
    items: [
      item({ time: "10:00", label: "浅草寺", note: "10時に浅草寺へ。", mapUrl: "https://www.google.com/maps/search/?api=1&query=35.7148%2C139.7967", mapPlaceName: "浅草寺", mapLat: 35.7148, mapLng: 139.7967 }),
      item({ label: "天丼でランチ", category: "food", costItems: [{ label: "天丼", amount: 1500 }], shopUrl: "https://tabelog.com/x" }),
    ],
  });
  check("import-blocks（共有）: 200・2件", [r.status, r.data.blocks.length, r.data.errors], [200, 2, []]);
  check("共有の予定はbranch_idが空", sqlite.prepare("SELECT branch_id b FROM blocks").all().map((x) => x.b), ["", ""]);
  check("費用・お店のURL・座標が保存される", [JSON.parse(sqlite.prepare("SELECT cost_items c FROM entries WHERE cost_items != '[]'").get().c), sqlite.prepare("SELECT shop_url s FROM entries WHERE shop_url != ''").get().s, sqlite.prepare("SELECT map_lat l FROM entries WHERE map_lat IS NOT NULL").get().l], [[{ label: "天丼", amount: 1500 }], "https://tabelog.com/x", 35.7148]);
  check("文字起こしがその日の欄に残る（DayInfo）", sqlite.prepare("SELECT voice_transcript t FROM day_infos WHERE id = 't1_2026-10-04'").get().t, "10時に浅草寺");
  ok("保存のD1アクセスは少ない（旅行・バッチ・文字起こし・更新）", queries.length <= 8);
  check("旧エンドポイント /screenshot-blocks も同じ処理", (await call("POST", "/trips/t1/screenshot-blocks", null, { items: [item({ label: "旧" })] })).status, 200);
  sqlite.exec("DELETE FROM blocks; DELETE FROM entries; DELETE FROM day_infos;");
}

/* ---- 保存：別行動 ---- */
{
  reset();
  const items = [item({ time: "14:00", label: "美術館" }), item({ time: "10:00", label: "時間外" }), item({ date: "2026-10-05", label: "日の外" })];
  const bob = await call("POST", "/trips/t1/import-blocks", "bob", { items, branchId: "br1" });
  check("他人は別行動に保存できない（403）", [bob.status, bob.data.error], [403, "forbidden"]);
  const anon = await call("POST", "/trips/t1/import-blocks", null, { items, branchId: "br1" });
  check("ログインなしは401", [anon.status, anon.data.error], [401, "login_required"]);
  check("拒否されたときは何も保存されない", count("SELECT COUNT(*) n FROM blocks"), 0);
  const wrongTrip = await call("POST", "/trips/t2/import-blocks", "alice", { items, branchId: "br1" });
  check("別の旅行の別行動は404", [wrongTrip.status, wrongTrip.data.error], [404, "branch_not_found"]);
  const r = await call("POST", "/trips/t1/import-blocks", "alice", { items, branchId: "br1", transcript: "秘密の別行動", transcriptDate: "2026-10-04" });
  check("持ち主は保存できる・時間帯の外と日の外の項目だけerrorsで返す", [r.status, r.data.blocks.map((b) => b.label), r.data.errors], [200, ["美術館"], [{ index: 1, reason: "time_out_of_branch" }, { index: 2, reason: "date_out_of_branch" }]]);
  check("保存した予定にbranchIdが付く", [r.data.blocks[0].branchId, sqlite.prepare("SELECT branch_id b FROM blocks").get().b], ["br1", "br1"]);
  check("別行動の文字起こしはみんなのDayInfoに残さない", count("SELECT COUNT(*) n FROM day_infos"), 0);
  const allBad = await call("POST", "/trips/t1/import-blocks", "alice", { items: [item({ time: "10:00" })], branchId: "br1" });
  check("全部外れていれば400 invalid_input", [allBad.status, allBad.data.error], [400, "invalid_input"]);
  const badId = await call("POST", "/trips/t1/import-blocks", "alice", { items, branchId: 123 });
  check("branchIdが文字列でなければ400", badId.status, 400);
  // 日をまたぐ別行動の中の保存
  const span = await call("POST", "/trips/t2/import-blocks", "alice", { branchId: "br2", items: [
    item({ date: "2026-10-04", time: "19:00", label: "始まる前" }), item({ date: "2026-10-04", time: "21:00", label: "夜" }),
    item({ date: "2026-10-05", time: "09:00", label: "朝" }), item({ date: "2026-10-05", time: "13:00", label: "終わった後" }),
  ] });
  check("日をまたぐ別行動：始まる前・終わった後は保存しない", [span.data.blocks.map((b) => b.label), span.data.errors.map((e) => e.reason)], [["夜", "朝"], ["time_out_of_branch", "time_out_of_branch"]]);
}

/* ---- 保存の検証（共有の予定の日程チェックは今までどおり） ---- */
{
  const r = await call("POST", "/trips/t1/import-blocks", null, { items: [item({ date: "2026-12-25" })] });
  check("日程の外は400", [r.status, r.data.error], [400, "invalid_input"]);
  const many = await call("POST", "/trips/t1/import-blocks", null, { items: Array.from({ length: 101 }, () => item({})) });
  check("101件は400（上限100件）", many.status, 400);
  const hundred = await call("POST", "/trips/t1/import-blocks", null, { items: Array.from({ length: 100 }, (_, i) => item({ label: "予定" + i })) });
  check("100件は保存できる（決まった形のメモの上限）", [hundred.status, hundred.data.blocks.length], [200, 100]);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
