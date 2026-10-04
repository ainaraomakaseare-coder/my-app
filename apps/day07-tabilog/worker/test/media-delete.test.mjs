/*
 * 記録・予定・旅行・別行動を消したとき、参照していた写真・動画（R2）も消えることを、
 * node:sqlite の本物のSQLiteと、R2の代わりの入れ物で確かめるテスト。
 * 確かめること：消した行が参照していたキーは消える／まだ別の行（記録・表紙写真）が参照しているキーは残る／
 * 編集で外した写真は消える／R2の削除が失敗してもDBの削除は成功する／削除は1回の呼び出しにまとまる。
 * 実行: node worker/test/media-delete.test.mjs
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import worker from "../src/index.js";

let pass = 0, fail = 0;
function check(label, got, want) {
  try { assert.deepEqual(got, want); pass++; } catch {
    fail++;
    console.log("NG  " + label);
    console.log("    got  " + JSON.stringify(got));
    console.log("    want " + JSON.stringify(want));
  }
}

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`
CREATE TABLE trips (id TEXT PRIMARY KEY, title TEXT NOT NULL, start_date TEXT NOT NULL DEFAULT '', end_date TEXT NOT NULL DEFAULT '', companions TEXT NOT NULL DEFAULT '[]', cover_photo_id TEXT NOT NULL DEFAULT '', trip_type TEXT NOT NULL DEFAULT '', settle_unit INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE blocks (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, date TEXT NOT NULL DEFAULT '', time TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'sightseeing', transport TEXT NOT NULL DEFAULT '', move_minutes INTEGER NOT NULL DEFAULT 0, manual_order INTEGER, tz_override TEXT, branch_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE entries (id TEXT PRIMARY KEY, block_id TEXT NOT NULL, episode TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', photo_ids TEXT NOT NULL DEFAULT '[]', video_ids TEXT NOT NULL DEFAULT '[]', cost_items TEXT NOT NULL DEFAULT '[]', wait_time TEXT NOT NULL DEFAULT '', map_url TEXT NOT NULL DEFAULT '', map_place_name TEXT NOT NULL DEFAULT '', shop_url TEXT NOT NULL DEFAULT '', other_url TEXT NOT NULL DEFAULT '', time TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', travel TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE ratings (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, rater_email TEXT NOT NULL, score REAL);
CREATE TABLE day_infos (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, date TEXT NOT NULL);
CREATE TABLE trip_members (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, account_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', joined_at TEXT NOT NULL);
CREATE TABLE likes (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, account_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE comments (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, account_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE comment_reports (id TEXT PRIMARY KEY, comment_id TEXT NOT NULL, reporter_account_id TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE accounts (email TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT 'free', ticket_credits INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
`);
// 別行動のテーブル（migrations/0030と同じ形。blocks.branch_idは上で作成済み）
sqlite.exec("CREATE TABLE branches (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, account_id TEXT NOT NULL, date TEXT NOT NULL, end_date TEXT NOT NULL DEFAULT '', start_time TEXT NOT NULL, end_time TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");

const DB = {
  prepare(sql) {
    const st = sqlite.prepare(sql);
    let params = [];
    const o = {
      bind(...p) { params = p; return o; },
      async first() { return st.get(...params) || null; },
      async all() { return { results: st.all(...params) }; },
      async run() { const r = st.run(...params); return { success: true, meta: { changes: Number(r.changes) } }; },
    };
    return o;
  },
  async batch(stmts) {
    sqlite.exec("BEGIN");
    try { for (const s of stmts) await s.run(); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  },
};

const r2 = { calls: [], failNext: false, async delete(keys) { if (this.failNext) { this.failNext = false; throw new Error("r2 down"); } this.calls.push(keys); } };
const env = { DB, PHOTOS_BUCKET: r2, ALLOWED_ORIGIN: "https://app.example" };
const ctx = { waitUntil() {} };

async function call(method, path, body, token) {
  const headers = { origin: "https://app.example" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = "Bearer " + token;
  const res = await worker.fetch(new Request("https://api.example" + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }), env, ctx);
  let data = null;
  try { data = await res.json(); } catch { /* 本文なし */ }
  return { status: res.status, data };
}

const now = new Date().toISOString();
const A = "photo_" + "a".repeat(32) + ".jpg", B = "photo_" + "b".repeat(32) + ".jpg", C = "photo_" + "c".repeat(32) + ".png";
const D = "photo_" + "d".repeat(32) + ".webp", V = "photo_" + "e".repeat(32) + ".mp4", X = "photo_" + "f".repeat(32) + ".jpg";
const sorted = (c) => (c || []).slice().sort();
const lastDeleted = () => (r2.calls.length ? sorted(r2.calls[r2.calls.length - 1]) : []);

function addTrip(id, cover = "") { sqlite.prepare("INSERT INTO trips (id,title,cover_photo_id,created_at,updated_at) VALUES (?,?,?,?,?)").run(id, "旅", cover, now, now); }
function addBlock(id, tripId, branchId = "") { sqlite.prepare("INSERT INTO blocks (id,trip_id,branch_id,created_at,updated_at) VALUES (?,?,?,?,?)").run(id, tripId, branchId, now, now); }
function addEntry(id, blockId, photos, videos = []) {
  sqlite.prepare("INSERT INTO entries (id,block_id,photo_ids,video_ids,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, blockId, JSON.stringify(photos), JSON.stringify(videos), now, now);
}

// 記録を消す：自分だけが使うキーは消え、別の記録がまだ使うキーは残る
addTrip("t1");
addBlock("b1", "t1");
addEntry("e1", "b1", [A, B], [V]);
addEntry("e2", "b1", [B]);
let r = await call("DELETE", "/entries/e1");
check("記録の削除は成功する", r.status, 200);
check("別の記録が使っているBは残り、A・動画だけ消える（1回の呼び出し）", [r2.calls.length, lastDeleted()], [1, sorted([A, V])]);

// 編集で外した写真：BをDに差し替える。Bは誰も使わなくなるので消える
addEntry("e3", "b1", [C]);
r2.calls.length = 0;
r = await call("PATCH", "/entries/e2", { photoIds: [D] });
check("記録の編集は成功する", r.status, 200);
check("編集で外れたBが消える", lastDeleted(), [B]);
r2.calls.length = 0;
r = await call("PATCH", "/entries/e2", { episode: "更新" });
check("写真を変えない編集では何も消さない", r2.calls.length, 0);

// 表紙写真と共有しているキーは、記録を消しても残る
sqlite.prepare("UPDATE trips SET cover_photo_id = ? WHERE id = 't1'").run(C);
r2.calls.length = 0;
r = await call("DELETE", "/entries/e3");
check("表紙写真に使われているCは、記録を消しても残る", [r.status, r2.calls.length], [200, 0]);

// 予定（block）を消す：中の記録の写真をまとめて1回で消す
addBlock("b2", "t1");
addEntry("e4", "b2", [X], [V]);
addEntry("e5", "b2", [X, A]);
r2.calls.length = 0;
r = await call("DELETE", "/blocks/b2");
check("予定の削除で、中の記録の写真・動画がまとめて消える", [r.status, r2.calls.length, lastDeleted()], [200, 1, sorted([A, V, X])]);

// R2が失敗してもDBの削除は成功する
addBlock("b3", "t1");
addEntry("e6", "b3", [X]);
r2.failNext = true;
r = await call("DELETE", "/entries/e6");
check("R2の削除が失敗しても200で、行は消えている", [r.status, sqlite.prepare("SELECT COUNT(*) AS n FROM entries WHERE id='e6'").get().n], [200, 0]);

// 不正なキー（URLなど）は無視される
addEntry("e7", "b3", ["https://example.com/x.jpg", "../etc", X]);
r2.calls.length = 0;
r = await call("DELETE", "/entries/e7");
check("キーの形が違うものは消す対象にしない", lastDeleted(), [X]);

// 別行動を消す
sqlite.prepare("INSERT INTO branches (id,trip_id,account_id,date,start_time,end_time,created_at,updated_at) VALUES ('br1','t1','111111','2026-10-01','09:00','10:00',?,?)").run(now, now);
addBlock("b4", "t1", "br1");
addEntry("e8", "b4", [D, A]);
{
  const token = "a".repeat(64);
  sqlite.prepare("INSERT INTO accounts (email, account_id, name, created_at, updated_at) VALUES ('alice@example.com','111111','アリス',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO sessions (token_hash,email,created_at,expires_at) VALUES (?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), "alice@example.com", now, new Date(Date.now() + 86400000).toISOString());
  r2.calls.length = 0;
  r = await call("DELETE", "/branches/br1", undefined, token);
  // e2はDを使っているので、Dは残りAだけ消える
  check("別行動の削除は成功し、別の記録が使うDは残ってAだけ消える", [r.status, lastDeleted()], [200, [A]]);
}

// 旅行を消す：表紙と中の全部の記録の写真が消える
addTrip("t2", B);
addBlock("b5", "t2");
addEntry("e10", "b5", [X]);
r2.calls.length = 0;
r = await call("DELETE", "/trips/t2");
check("旅行の削除で表紙と記録の写真が消える", [r.status, lastDeleted()], [200, sorted([B, X])]);

console.log(`media-delete: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
