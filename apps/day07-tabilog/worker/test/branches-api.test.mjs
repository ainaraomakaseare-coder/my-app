/*
 * 自分だけの道（別行動の分岐）のAPIを、node:sqlite（Node 22.5+）で作った本物のSQLiteの上で通しで確かめるテスト
 * （docs/adr/0021）。D1の代わりに、prepare/bind/first/all/run/batchだけ真似た薄い入れ物を使う。
 * 確かめること：持ち主だけが分岐・分岐の中の予定・記録を作れる／直せる／消せる、GETは誰でも読める（メールは出さない）、
 * 分岐をまたぐ記録の移動は不可、分岐の削除で中身も消える、テーブル・列が無い環境（マイグレーション前）でも壊れない。
 * 実行: node worker/test/branches-api.test.mjs
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
CREATE TABLE blocks (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, date TEXT NOT NULL DEFAULT '', time TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'sightseeing', transport TEXT NOT NULL DEFAULT '', move_minutes INTEGER NOT NULL DEFAULT 0, manual_order INTEGER, tz_override TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE entries (id TEXT PRIMARY KEY, block_id TEXT NOT NULL, episode TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', photo_ids TEXT NOT NULL DEFAULT '[]', video_ids TEXT NOT NULL DEFAULT '[]', cost_items TEXT NOT NULL DEFAULT '[]', wait_time TEXT NOT NULL DEFAULT '', map_url TEXT NOT NULL DEFAULT '', map_place_name TEXT NOT NULL DEFAULT '', shop_url TEXT NOT NULL DEFAULT '', other_url TEXT NOT NULL DEFAULT '', time TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', travel TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE ratings (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, rater_email TEXT NOT NULL, score REAL);
CREATE TABLE day_infos (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, date TEXT NOT NULL);
CREATE TABLE accounts (email TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT 'free', ticket_credits INTEGER NOT NULL DEFAULT 0, plan_period_start TEXT NOT NULL DEFAULT '', voice_uses_this_period INTEGER NOT NULL DEFAULT 0, memo_uses_this_period INTEGER NOT NULL DEFAULT 0, stripe_customer_id TEXT NOT NULL DEFAULT '', stripe_subscription_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE trip_members (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, account_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', joined_at TEXT NOT NULL, UNIQUE(trip_id, account_id));
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE likes (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, account_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE comments (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, account_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE user_blocks (blocker_account_id TEXT NOT NULL, blocked_account_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE auth_identities (provider TEXT NOT NULL, subject TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL, refresh_token TEXT NOT NULL DEFAULT '');
CREATE TABLE comment_reports (id TEXT PRIMARY KEY, comment_id TEXT NOT NULL, reporter_account_id TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
`);
// マイグレーション0030の中身（branchesテーブルとblocks.branch_id）は、あとで「実行前」の状態を作るため別に流す
const MIGRATION_0030 = [
  "CREATE TABLE IF NOT EXISTS branches (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, account_id TEXT NOT NULL, date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_branches_trip ON branches(trip_id)",
  "ALTER TABLE blocks ADD COLUMN branch_id TEXT NOT NULL DEFAULT ''",
];

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
  async batch(stmts) {
    sqlite.exec("BEGIN");
    try { for (const s of stmts) await s.run(); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  },
};
const env = { DB, ALLOWED_ORIGIN: "https://app.example", REQUIRE_SESSION: "1" };

const now = new Date().toISOString();
const later = new Date(Date.now() + 86400000).toISOString();
const tokens = { alice: "a".repeat(64), bob: "b".repeat(64), carol: "c".repeat(64) };
const people = { alice: ["alice@example.com", "111111", "アリス"], bob: ["bob@example.com", "222222", "ボブ"], carol: ["carol@example.com", "333333", "キャロル"] };
for (const [k, [email, aid, name]] of Object.entries(people)) {
  sqlite.prepare("INSERT INTO accounts (email, account_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run(email, aid, name, now, now);
  sqlite.prepare("INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?,?,?,?)")
    .run(createHash("sha256").update(tokens[k]).digest("hex"), email, now, later);
}
sqlite.prepare("INSERT INTO trips (id, title, created_at, updated_at) VALUES ('t1','旅行',?,?)").run(now, now);
for (const k of ["alice", "bob"]) {
  sqlite.prepare("INSERT INTO trip_members (id, trip_id, account_id, name, joined_at) VALUES (?,?,?,?,?)").run("m_" + k, "t1", people[k][1], people[k][2], now);
}

async function call(method, path, who, body) {
  const headers = { origin: "https://app.example" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (who) headers.authorization = "Bearer " + tokens[who];
  const res = await worker.fetch(new Request("https://api.example" + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }), env, undefined);
  let data = null;
  try { data = await res.json(); } catch { /* 本文なし */ }
  return { status: res.status, data };
}

// ---------- マイグレーション前（テーブル・列なし）でも壊れない ----------
{
  const shared = await call("POST", "/trips/t1/blocks", null, { date: "2026-10-01", time: "10:00", label: "集合" });
  check("マイグレーション前でも、みんなの予定は作れる", shared.status, 201);
  check("マイグレーション前のブロックはbranchIdが空", shared.data.branchId, "");
  const trip = await call("GET", "/trips/t1");
  check("マイグレーション前でもGETできて、分岐は空", [trip.status, trip.data.branches], [200, []]);
  const created = await call("POST", "/trips/t1/branches", "alice", { date: "2026-10-01", startTime: "14:00", endTime: "17:00" });
  check("マイグレーション前に分岐を作ろうとすると503", [created.status, created.data.error], [503, "branches_not_ready"]);
  const reorder = await call("PATCH", "/trips/t1/days/2026-10-01/blocks/reorder", null, { blockIds: [shared.data.id] });
  check("マイグレーション前でも並べ替えは動く", reorder.status, 200);
}
for (const sql of MIGRATION_0030) sqlite.exec(sql);

// ---------- 分岐の作成 ----------
const sharedId = sqlite.prepare("SELECT id FROM blocks WHERE trip_id = 't1'").get().id;
let r = await call("POST", "/trips/t1/branches", null, { date: "2026-10-01", startTime: "14:00", endTime: "17:00" });
check("ログインなしでは作れない", [r.status, r.data.error], [401, "login_required"]);
r = await call("POST", "/trips/t1/branches", "carol", { date: "2026-10-01", startTime: "14:00", endTime: "17:00" });
check("参加していない人は作れない", [r.status, r.data.error], [403, "not_member"]);
r = await call("POST", "/trips/t1/branches", "alice", { date: "2026-10-01", startTime: "17:00", endTime: "14:00" });
check("終わりが始まりより前は400", [r.status, r.data.error], [400, "end_before_start"]);
r = await call("POST", "/trips/t1/branches", "alice", { date: "2026-10-01", startTime: "14:00", endTime: "17:00", title: "美術館とカフェ" });
check("持ち主のアリスは作れる", [r.status, r.data.accountId, r.data.name, r.data.startTime, r.data.title], [201, "111111", "アリス", "14:00", "美術館とカフェ"]);
check("応答にメールアドレスを含めない", JSON.stringify(r.data).includes("@"), false);
const branchId = r.data.id;
r = await call("POST", "/trips/t1/branches", "alice", { date: "2026-10-01", startTime: "16:00", endTime: "18:00" });
check("同じ人の分岐と重なるのは400", [r.status, r.data.error], [400, "overlap"]);
r = await call("POST", "/trips/t1/branches", "bob", { date: "2026-10-01", startTime: "16:00", endTime: "18:00" });
check("別の人なら同じ時間帯でも作れる", r.status, 201);
const bobBranchId = r.data.id;

// ---------- 分岐の中の予定・記録 ----------
r = await call("POST", "/trips/t1/blocks", "bob", { label: "ボブがアリスの道に書く", time: "15:00", branchId });
check("他人の分岐の中には予定を作れない", [r.status, r.data.error], [403, "forbidden"]);
r = await call("POST", "/trips/t1/blocks", null, { label: "匿名", time: "15:00", branchId });
check("ログインなしで分岐の中に予定は作れない", r.status, 401);
r = await call("POST", "/trips/t1/blocks", "alice", { date: "2099-01-01", label: "美術館", time: "14:30", category: "sightseeing", branchId });
check("持ち主は作れて、日付は分岐の日に固定される", [r.status, r.data.branchId, r.data.date], [201, branchId, "2026-10-01"]);
const branchBlockId = r.data.id;
r = await call("POST", "/trips/t1/blocks", "alice", { label: "存在しない分岐", branchId: "br_nothing" });
check("存在しない分岐は404", [r.status, r.data.error], [404, "branch_not_found"]);
r = await call("PATCH", "/blocks/" + branchBlockId, "bob", { label: "書き換え" });
check("他人は分岐の中の予定を直せない", r.status, 403);
r = await call("PATCH", "/blocks/" + branchBlockId, "alice", { label: "美術館（改）", date: "2099-01-01" });
check("持ち主は直せる（日付は動かない）", [r.status, r.data.label, r.data.date, r.data.branchId], [200, "美術館（改）", "2026-10-01", branchId]);
r = await call("POST", "/blocks/" + branchBlockId + "/entries", "bob", { episode: "x", author: "ボブ" });
check("他人は分岐の中の予定に記録を書けない", r.status, 403);
r = await call("POST", "/blocks/" + branchBlockId + "/entries", null, { episode: "x" });
check("ログインなしでも書けない", r.status, 401);
r = await call("POST", "/blocks/" + branchBlockId + "/entries", "alice", { episode: "絵がよかった", author: "アリス", costItems: [{ label: "入館料", amount: 1500 }] });
check("持ち主は記録を書ける", r.status, 201);
const entryId = r.data.id;
r = await call("PATCH", "/entries/" + entryId, "bob", { episode: "書き換え" });
check("他人は分岐の中の記録を直せない", r.status, 403);
r = await call("PATCH", "/entries/" + entryId, "alice", { episode: "絵がとてもよかった" });
check("持ち主は記録を直せる", [r.status, r.data.episode], [200, "絵がとてもよかった"]);
r = await call("PATCH", "/entries/" + entryId + "/move", "alice", { blockId: sharedId });
check("分岐をまたぐ記録の移動は400", [r.status, r.data.error], [400, "different_branch"]);
r = await call("DELETE", "/entries/" + entryId, "bob");
check("他人は分岐の中の記録を消せない", r.status, 403);
r = await call("DELETE", "/blocks/" + branchBlockId, "bob");
check("他人は分岐の中の予定を消せない", r.status, 403);
r = await call("PATCH", "/blocks/" + sharedId, null, { label: "集合（改）" });
check("みんなの予定は今までどおり誰でも直せる（ログインなしでも）", [r.status, r.data.label], [200, "集合（改）"]);

// ---------- 読み取り ----------
r = await call("GET", "/trips/t1");
check("GETは誰でも読めて、分岐が2件・名前つき", [r.status, r.data.branches.length, r.data.branches.map((b) => b.name)], [200, 2, ["アリス", "ボブ"]]);
check("GETの分岐にメールアドレスを含めない", JSON.stringify(r.data.branches).includes("@"), false);
check("GETのブロックにbranchIdが付く", r.data.blocks.filter((b) => b.branchId === branchId).length, 1);
check("分岐の中の記録も一緒に返る", r.data.blocks.find((b) => b.id === branchBlockId).entries.length, 1);

// ---------- 並べ替えはみんなの予定だけ ----------
r = await call("PATCH", "/trips/t1/days/2026-10-01/blocks/reorder", null, { blockIds: [branchBlockId, sharedId], manual: true });
check("並べ替えはできる", r.status, 200);
check("分岐の中の予定にはmanual_orderが付かない", sqlite.prepare("SELECT manual_order AS m FROM blocks WHERE id = ?").get(branchBlockId).m, null);
check("みんなの予定にはmanual_orderが付く", sqlite.prepare("SELECT manual_order AS m FROM blocks WHERE id = ?").get(sharedId).m, 0);

// ---------- 分岐の更新 ----------
r = await call("PATCH", "/branches/" + branchId, "bob", { title: "乗っ取り" });
check("他人は分岐を直せない", [r.status, r.data.error], [403, "forbidden"]);
r = await call("PATCH", "/branches/" + branchId, "alice", { date: "2026-10-02" });
check("日付は変えられない", r.status, 400);
r = await call("PATCH", "/branches/" + branchId, "alice", { startTime: "13:00", endTime: "17:30", title: "延長" });
check("持ち主は時間帯とタイトルを直せる（自分自身とは重ならない扱い）", [r.status, r.data.startTime, r.data.endTime, r.data.title], [200, "13:00", "17:30", "延長"]);
r = await call("PATCH", "/branches/" + branchId, "alice", { endTime: "12:00" });
check("終わりが始まりより前になる更新は400", r.status, 400);

// ---------- 分岐の削除 ----------
r = await call("DELETE", "/branches/" + branchId, "bob");
check("他人は分岐を消せない", [r.status, r.data.error], [403, "forbidden"]);
sqlite.prepare("INSERT INTO ratings (id, entry_id, rater_email, score) VALUES ('r1', ?, 'bob@example.com', 4)").run(entryId);
sqlite.prepare("INSERT INTO likes (id, trip_id, target_type, target_id, account_id, created_at) VALUES ('l1','t1','entry',?,'222222',?)").run(entryId, now);
r = await call("DELETE", "/branches/" + branchId, "alice");
check("持ち主は分岐を消せる", r.status, 200);
check("中の予定・記録・評価・いいねも消える", [
  sqlite.prepare("SELECT COUNT(*) AS n FROM blocks WHERE id = ?").get(branchBlockId).n,
  sqlite.prepare("SELECT COUNT(*) AS n FROM entries WHERE id = ?").get(entryId).n,
  sqlite.prepare("SELECT COUNT(*) AS n FROM ratings WHERE entry_id = ?").get(entryId).n,
  sqlite.prepare("SELECT COUNT(*) AS n FROM likes WHERE target_id = ?").get(entryId).n,
], [0, 0, 0, 0]);
check("みんなの予定と他人の分岐は残る", [
  sqlite.prepare("SELECT COUNT(*) AS n FROM blocks WHERE id = ?").get(sharedId).n,
  sqlite.prepare("SELECT COUNT(*) AS n FROM branches WHERE id = ?").get(bobBranchId).n,
], [1, 1]);

// ---------- アカウント削除・旅行削除 ----------
r = await call("POST", "/trips/t1/blocks", "bob", { label: "ボブの寄り道", time: "15:00", branchId: bobBranchId });
const bobBlockId = r.data.id;
await call("POST", "/blocks/" + bobBlockId + "/entries", "bob", { episode: "ボブの記録", author: "ボブ" });
r = await call("POST", "/accounts/delete", "bob", { email: "bob@example.com" });
check("アカウント削除は成功する", r.status, 200);
check("アカウント削除で、その人の分岐と中身も消える", [
  sqlite.prepare("SELECT COUNT(*) AS n FROM branches WHERE account_id = '222222'").get().n,
  sqlite.prepare("SELECT COUNT(*) AS n FROM blocks WHERE branch_id != ''").get().n,
  sqlite.prepare("SELECT COUNT(*) AS n FROM entries WHERE block_id = ?").get(bobBlockId).n,
], [0, 0, 0]);

r = await call("POST", "/trips/t1/branches", "alice", { date: "2026-10-03", startTime: "09:00", endTime: "10:00" });
check("旅行削除の準備：分岐を作る", r.status, 201);
r = await call("DELETE", "/trips/t1");
check("旅行を消すと分岐も消える", [r.status, sqlite.prepare("SELECT COUNT(*) AS n FROM branches").get().n], [200, 0]);

console.log(`branches-api: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
