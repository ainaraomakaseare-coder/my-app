/*
 * 取り込みの元（AIなどで予定を入れたときの元の入力。migrations/0038、src/import-sources.js）を、
 * Workerの入口（fetch）から node:sqlite の本物のSQLiteの上で通しで確かめる。
 * 確かめること：import-blocks に source を付けると1行残り、作った予定すべての source_id になる／
 * 形のおかしい source は残さないが予定は保存する／一覧（GET）／消す（DELETE。予定は残り、スクショ画像も消える）／
 * 別行動の元は持ち主だけが消せる／旅行を消すと元とスクショ画像も消える。
 * 実行: node worker/test/import-sources.test.mjs
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import worker from "../src/index.js";
import { normalizeImportSource } from "../src/import-sources.js";

let pass = 0, fail = 0;
function check(label, got, want) {
  try { assert.deepEqual(got, want); pass++; } catch {
    fail++;
    console.log("NG  " + label + "\n    got  " + JSON.stringify(got) + "\n    want " + JSON.stringify(want));
  }
}

/* ---- 純粋関数 ---- */
const K1 = "photo_" + "a".repeat(32) + ".jpg", K2 = "photo_" + "b".repeat(32) + ".jpg";
check("音声：文字だけでよい", normalizeImportSource({ kind: "voice", text: " 10時に浅草寺 ", notes: "家族旅行" }), { kind: "voice", text: "10時に浅草寺", notes: "家族旅行", photoIds: [] });
check("スクショ：画像だけでよい・重複は1つに", normalizeImportSource({ kind: "screenshot", photoIds: [K1, K2, K1] }), { kind: "screenshot", text: "", notes: "", photoIds: [K1, K2] });
check("中身が無いものは残さない", normalizeImportSource({ kind: "memo", text: "  " }), null);
check("知らない種類は残さない", normalizeImportSource({ kind: "photos", text: "x" }), null);
check("R2のキーの形でないものは残さない", normalizeImportSource({ kind: "screenshot", photoIds: ["../x"] }), null);
check("長すぎる文字は残さない", normalizeImportSource({ kind: "memo", text: "あ".repeat(8001) }), null);
check("無し", normalizeImportSource(undefined), null);

/* ---- DB ---- */
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`
CREATE TABLE trips (id TEXT PRIMARY KEY, title TEXT NOT NULL, start_date TEXT NOT NULL DEFAULT '', end_date TEXT NOT NULL DEFAULT '', companions TEXT NOT NULL DEFAULT '[]', cover_photo_id TEXT NOT NULL DEFAULT '', trip_type TEXT NOT NULL DEFAULT '', settle_unit INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE blocks (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, date TEXT NOT NULL DEFAULT '', time TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'sightseeing', transport TEXT NOT NULL DEFAULT '', move_minutes INTEGER NOT NULL DEFAULT 0, manual_order INTEGER, tz_override TEXT, branch_id TEXT NOT NULL DEFAULT '', source_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE entries (id TEXT PRIMARY KEY, block_id TEXT NOT NULL, episode TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', photo_ids TEXT NOT NULL DEFAULT '[]', video_ids TEXT NOT NULL DEFAULT '[]', cost_items TEXT NOT NULL DEFAULT '[]', wait_time TEXT NOT NULL DEFAULT '', map_url TEXT NOT NULL DEFAULT '', map_place_name TEXT NOT NULL DEFAULT '', map_lat REAL, map_lng REAL, map_geocoded_url TEXT, map_geocoded_at TEXT, shop_url TEXT NOT NULL DEFAULT '', other_url TEXT NOT NULL DEFAULT '', time TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', travel TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE ratings (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL);
CREATE TABLE day_infos (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, date TEXT NOT NULL, place TEXT NOT NULL DEFAULT '', is_forecast INTEGER NOT NULL DEFAULT 0, fetched_at TEXT NOT NULL DEFAULT '', voice_transcript TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
CREATE TABLE accounts (email TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE trip_members (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, account_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', joined_at TEXT NOT NULL, UNIQUE(trip_id, account_id));
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE branches (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, account_id TEXT NOT NULL, date TEXT NOT NULL, end_date TEXT NOT NULL DEFAULT '', start_time TEXT NOT NULL, end_time TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE likes (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, account_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE comments (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, account_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE comment_reports (id TEXT PRIMARY KEY, comment_id TEXT NOT NULL, reporter_account_id TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE import_sources (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, branch_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', photo_ids TEXT NOT NULL DEFAULT '[]', author TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
`);
const DB = {
  prepare(sql) {
    const st = sqlite.prepare(sql);
    let params = [];
    const o = {
      bind(...p) { params = p; return o; },
      async first() { return st.get(...params) || null; },
      async all() { return { results: st.all(...params) }; },
      async run() { st.run(...params); return { success: true }; },
      _run() { st.run(...params); },
    };
    return o;
  },
  async batch(stmts) {
    sqlite.exec("BEGIN");
    try { for (const s of stmts) s._run(); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  },
};
const r2 = new Set();
const PHOTOS_BUCKET = { async delete(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => r2.delete(k)); } };
const env = { DB, PHOTOS_BUCKET, ALLOWED_ORIGIN: "https://app.example", REQUIRE_SESSION: "1" };

const now = new Date().toISOString();
const later = new Date(Date.now() + 86400000).toISOString();
const tokens = { alice: "a".repeat(64), bob: "b".repeat(64) };
const people = { alice: ["alice@example.com", "111111", "アリス"], bob: ["bob@example.com", "222222", "ボブ"] };
for (const [k, [email, aid, name]] of Object.entries(people)) {
  sqlite.prepare("INSERT INTO accounts (email, account_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run(email, aid, name, now, now);
  sqlite.prepare("INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?,?,?,?)").run(createHash("sha256").update(tokens[k]).digest("hex"), email, now, later);
}
sqlite.prepare("INSERT INTO trip_members (id, trip_id, account_id, name, joined_at) VALUES ('m1','t1','111111','アリス',?)").run(now);
sqlite.prepare("INSERT INTO trips (id, title, start_date, end_date, created_at, updated_at) VALUES ('t1','東京','2026-10-03','2026-10-05',?,?)").run(now, now);
sqlite.prepare("INSERT INTO branches (id, trip_id, account_id, date, end_date, start_time, end_time, title, created_at, updated_at) VALUES ('br1','t1','111111','2026-10-04','2026-10-04','13:00','18:00','美術館',?,?)").run(now, now);

async function call(method, path, who, body) {
  const headers = { origin: "https://app.example" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (who) headers.authorization = "Bearer " + tokens[who];
  const res = await worker.fetch(new Request("https://api.example" + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
  let data = null;
  try { data = await res.json(); } catch { /* 本文なし */ }
  return { status: res.status, data };
}
const item = (o) => ({ category: "sightseeing", transport: "", date: "2026-10-04", time: "", label: "予定", place: "", costItems: [], note: "", mapUrl: "", shopUrl: "", ...o });

/* ---- 保存：音声の元 ---- */
let voiceSrcId;
{
  const r = await call("POST", "/trips/t1/import-blocks", null, {
    author: "アリス", source: { kind: "voice", text: "10時に浅草寺、そのあとスカイツリー", notes: "家族旅行" },
    items: [item({ time: "10:00", label: "浅草寺" }), item({ label: "スカイツリー" })],
  });
  check("import-blocks: 200・2件", [r.status, r.data.blocks.length], [200, 2]);
  voiceSrcId = r.data.source && r.data.source.id;
  check("元が返る", [r.data.source.kind, r.data.source.text, r.data.source.notes, r.data.source.author], ["voice", "10時に浅草寺、そのあとスカイツリー", "家族旅行", "アリス"]);
  check("作った予定すべてにsourceIdが付く（応答）", r.data.blocks.map((b) => b.sourceId), [voiceSrcId, voiceSrcId]);
  check("作った予定すべてにsource_idが付く（DB）", sqlite.prepare("SELECT source_id s FROM blocks ORDER BY created_at").all().map((x) => x.s), [voiceSrcId, voiceSrcId]);
  const trip = await call("GET", "/trips/t1");
  check("旅行の読み込みでもsourceIdが付く", trip.data.blocks.map((b) => b.sourceId), [voiceSrcId, voiceSrcId]);
}

/* ---- 形のおかしい元：予定は保存・元は残さない ---- */
{
  const r = await call("POST", "/trips/t1/import-blocks", null, { source: { kind: "voice", text: "" }, items: [item({ label: "手入力風" })] });
  check("元なしでも保存できる", [r.status, r.data.source, r.data.blocks[0].sourceId], [200, null, ""]);
  const r2 = await call("POST", "/trips/t1/import-blocks", null, { items: [item({ label: "元なし" })] });
  check("sourceを送らなければ今までどおり", [r2.status, r2.data.source, r2.data.blocks[0].sourceId], [200, null, ""]);
  check("元の行は1つのまま", sqlite.prepare("SELECT COUNT(*) n FROM import_sources").get().n, 1);
}

/* ---- スクショの元・別行動 ---- */
let ssSrcId;
{
  r2.add(K1); r2.add(K2);
  const r = await call("POST", "/trips/t1/import-blocks", "alice", { branchId: "br1", source: { kind: "screenshot", photoIds: [K1, K2] }, items: [item({ time: "14:00", label: "美術館" })] });
  ssSrcId = r.data.source.id;
  check("別行動に入れた元は、その別行動のidを持つ", [r.status, r.data.source.branchId, r.data.source.photoIds], [200, "br1", [K1, K2]]);
  const list = await call("GET", "/trips/t1/import-sources");
  check("一覧は新しい順", [list.status, list.data.sources.map((s) => s.kind)], [200, ["screenshot", "voice"]]);
  check("知らない旅行は404", (await call("GET", "/trips/nope/import-sources")).status, 404);
  const bob = await call("DELETE", "/import-sources/" + ssSrcId, "bob");
  check("別行動の元は、ほかの人は消せない", [bob.status, bob.data.error], [403, "forbidden"]);
  const del = await call("DELETE", "/import-sources/" + ssSrcId, "alice");
  check("持ち主は消せる", del.status, 200);
  check("予定は残り、source_idが空になる", sqlite.prepare("SELECT source_id s FROM blocks WHERE label = '美術館'").get().s, "");
  check("スクショ画像も消える", [r2.has(K1), r2.has(K2)], [false, false]);
  check("もう一度消すと404", (await call("DELETE", "/import-sources/" + ssSrcId, "alice")).status, 404);
}

/* ---- 旅行を消すと元も消える ---- */
{
  const K3 = "photo_" + "c".repeat(32) + ".jpg";
  r2.add(K3);
  await call("POST", "/trips/t1/import-blocks", null, { source: { kind: "screenshot", photoIds: [K3] }, items: [item({ label: "チケット" })] });
  const r = await call("DELETE", "/trips/t1", "alice");
  check("旅行を消せる", r.status, 200);
  check("元の行が消える", sqlite.prepare("SELECT COUNT(*) n FROM import_sources WHERE trip_id = 't1'").get().n, 0);
  check("元のスクショ画像も消える", r2.has(K3), false);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
