/*
 * 旅の作成（POST /trips）：ログイン中の人が作ると、その人が自動で参加者（trip_members）になる。
 * ゲスト（トークンなし）が作っても参加者は作られない。
 * 実行: node worker/test/create-trip-member.test.mjs
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

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`
CREATE TABLE trips (id TEXT PRIMARY KEY, title TEXT NOT NULL, start_date TEXT NOT NULL DEFAULT '', end_date TEXT NOT NULL DEFAULT '', companions TEXT NOT NULL DEFAULT '[]', cover_photo_id TEXT NOT NULL DEFAULT '', trip_type TEXT NOT NULL DEFAULT '', settle_unit INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE accounts (email TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT 'free', ticket_credits INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE trip_members (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, account_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', joined_at TEXT NOT NULL, UNIQUE(trip_id, account_id));
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
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
    };
    return o;
  },
};
const env = { DB, ALLOWED_ORIGIN: "https://app.example" };
const now = new Date().toISOString();
const later = new Date(Date.now() + 86400000).toISOString();
const token = "a".repeat(64);
sqlite.prepare("INSERT INTO accounts (email, account_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run("alice@example.com", "111111", "アリス", now, now);
sqlite.prepare("INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), "alice@example.com", now, later);

async function create(auth) {
  const headers = { origin: "https://app.example", "content-type": "application/json" };
  if (auth) headers.authorization = "Bearer " + auth;
  const res = await worker.fetch(new Request("https://api.example/trips", { method: "POST", headers, body: JSON.stringify({ title: "京都", startDate: "2026-10-10", endDate: "2026-10-11" }) }), env, { waitUntil() {} });
  return { status: res.status, data: await res.json() };
}
const members = (id) => sqlite.prepare("SELECT account_id, name FROM trip_members WHERE trip_id = ?").all(id).map((r) => ({ ...r }));

const a = await create(token);
check("login: 201", a.status, 201);
check("login: creator becomes member", members(a.data.id), [{ account_id: "111111", name: "アリス" }]);
const g = await create("");
check("guest: 201", g.status, 201);
check("guest: no member", members(g.data.id), []);
const bad = await create("f".repeat(64));
check("invalid token: still created as guest", [bad.status, members(bad.data.id)], [201, []]);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
