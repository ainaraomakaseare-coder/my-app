/*
 * マイページの「プロフィール写真」「旅のベストピクチャー」のAPIを、node:sqliteの本物のSQLiteと
 * R2の代わりの入れ物で確かめるテスト。
 * 確かめること：ログイン必須／写真の設定・外す・置き換え（古いR2のキーは消える）／/accounts/ensureが返す／
 * 参加した旅行の写真だけ一覧に出る／ベストは最大6枚・アクセスできる写真だけ／アカウント削除で
 * プロフィール写真はR2から消え、ベストピクチャーは列を空にするだけ（旅行の写真は残る）。
 * 実行: node worker/test/account-photos.test.mjs
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
CREATE TABLE blocks (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, date TEXT NOT NULL DEFAULT '', branch_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE entries (id TEXT PRIMARY KEY, block_id TEXT NOT NULL, photo_ids TEXT NOT NULL DEFAULT '[]', video_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE ratings (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, rater_email TEXT NOT NULL, score REAL);
CREATE TABLE trip_members (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, account_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', joined_at TEXT NOT NULL);
CREATE TABLE likes (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, account_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE comments (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, account_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE comment_reports (id TEXT PRIMARY KEY, comment_id TEXT NOT NULL, reporter_account_id TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE accounts (email TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT 'free', plan_period_start TEXT NOT NULL DEFAULT '', voice_uses_this_period INTEGER NOT NULL DEFAULT 0, memo_uses_this_period INTEGER NOT NULL DEFAULT 0, ticket_credits INTEGER NOT NULL DEFAULT 0, stripe_customer_id TEXT NOT NULL DEFAULT '', stripe_subscription_id TEXT NOT NULL DEFAULT '', avatar_photo_id TEXT NOT NULL DEFAULT '', best_photo_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE auth_identities (provider TEXT, email TEXT);
CREATE TABLE user_blocks (blocker_account_id TEXT NOT NULL, blocked_account_id TEXT NOT NULL);
CREATE TABLE branches (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, account_id TEXT NOT NULL, date TEXT NOT NULL, end_date TEXT NOT NULL DEFAULT '', start_time TEXT NOT NULL, end_time TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
`);

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
  async batch(stmts) { for (const s of stmts) await s.run(); },
};
const r2 = { calls: [], async delete(keys) { this.calls.push(keys); } };
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
const later = new Date(Date.now() + 1000).toISOString();
const key = (c, ext = "jpg") => "photo_" + c.repeat(32) + "." + ext;
const AV = key("a"), AV2 = key("b", "png");
const P = "123456789".split("").map((c) => key(c)); // 旅行の写真 P[0]..P[8]
const OTHER = key("f"); // 参加していない旅行の写真
const BOB_BRANCH = key("e"); // Bobの別行動の中の写真
const sha = (t) => createHash("sha256").update(t).digest("hex");
function addAccount(email, id, token) {
  sqlite.prepare("INSERT INTO accounts (email, account_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run(email, id, id, now, now);
  sqlite.prepare("INSERT INTO sessions (token_hash,email,created_at,expires_at) VALUES (?,?,?,?)").run(sha(token), email, now, new Date(Date.now() + 86400000).toISOString());
}
addAccount("alice@example.com", "111111", "a".repeat(64));
addAccount("bob@example.com", "222222", "b".repeat(64));
const T = "a".repeat(64);

sqlite.prepare("INSERT INTO trips (id,title,created_at,updated_at) VALUES ('t1','旅',?,?),('t2','別の旅',?,?)").run(now, now, now, now);
sqlite.prepare("INSERT INTO trip_members (id,trip_id,account_id,joined_at) VALUES ('m1','t1','111111',?),('m2','t2','222222',?)").run(now, now);
sqlite.prepare("INSERT INTO blocks (id,trip_id,created_at,updated_at) VALUES ('b1','t1',?,?),('b2','t2',?,?)").run(now, now, now, now);
sqlite.prepare("INSERT INTO blocks (id,trip_id,branch_id,created_at,updated_at) VALUES ('b3','t1','br-bob',?,?)").run(now, now);
sqlite.prepare("INSERT INTO branches (id,trip_id,account_id,date,start_time,end_time,created_at,updated_at) VALUES ('br-bob','t1','222222','2026-10-01','09:00','10:00',?,?)").run(now, now);
const addEntry = (id, block, photos, at) => sqlite.prepare("INSERT INTO entries (id,block_id,photo_ids,created_at,updated_at) VALUES (?,?,?,?,?)").run(id, block, JSON.stringify(photos), at, at);
addEntry("e1", "b1", P.slice(0, 5), now);
addEntry("e2", "b1", P.slice(5, 9), later); // 新しい記録
addEntry("e3", "b2", [OTHER], now);
addEntry("e4", "b3", [BOB_BRANCH], now);

// --- ログイン必須 ---
let r = await call("PUT", "/accounts/me/avatar", { photoId: AV });
check("プロフィール写真の設定はログイン必須", r.status, 401);
r = await call("GET", "/accounts/me/photos");
check("写真一覧はログイン必須", r.status, 401);
r = await call("PUT", "/accounts/me/best-photos", { photoIds: [P[0]] });
check("ベストの保存はログイン必須", r.status, 401);

// --- プロフィール写真 ---
r = await call("PUT", "/accounts/me/avatar", { photoId: "../etc" }, T);
check("形の違うキーは400", r.status, 400);
r = await call("PUT", "/accounts/me/avatar", { photoId: key("c", "mp4") }, T);
check("動画のキーは400", r.status, 400);
r = await call("PUT", "/accounts/me/avatar", { photoId: AV }, T);
check("設定できる", [r.status, r.data], [200, { avatarPhotoId: AV }]);
r = await call("POST", "/accounts/ensure", { email: "alice@example.com" }, T);
check("/accounts/ensureがavatarPhotoIdを返す", [r.status, r.data.avatarPhotoId, r.data.bestPhotoIds], [200, AV, []]);
r2.calls.length = 0;
r = await call("PUT", "/accounts/me/avatar", { photoId: AV2 }, T);
check("置き換えると古い写真はR2から消える", [r.status, r2.calls], [200, [[AV]]]);
r2.calls.length = 0;
r = await call("PUT", "/accounts/me/avatar", { photoId: "" }, T);
check("外すと写真は消えて空に戻る", [r.status, r.data.avatarPhotoId, r2.calls], [200, "", [[AV2]]]);
// 旅行の記録の写真を指していたら、外してもR2からは消さない
sqlite.prepare("UPDATE accounts SET avatar_photo_id = ? WHERE email='alice@example.com'").run(P[0]);
r2.calls.length = 0;
await call("PUT", "/accounts/me/avatar", { photoId: "" }, T);
check("記録が使っている写真は外しても消さない", r2.calls.length, 0);

// --- 写真一覧 ---
r = await call("GET", "/accounts/me/photos", undefined, T);
check("参加した旅行の写真だけ・新しい順（他人の旅行・他人の別行動は出ない）", [r.status, r.data.photoIds], [200, [...P.slice(5, 9), ...P.slice(0, 5)]]);

// --- ベスト ---
r = await call("PUT", "/accounts/me/best-photos", { photoIds: P.slice(0, 7) }, T);
check("7枚は400", r.status, 400);
r = await call("PUT", "/accounts/me/best-photos", { photoIds: [P[0], OTHER] }, T);
check("参加していない旅行の写真は403", r.status, 403);
r = await call("PUT", "/accounts/me/best-photos", { photoIds: [BOB_BRANCH] }, T);
check("他人の別行動の写真は403", r.status, 403);
r = await call("PUT", "/accounts/me/best-photos", { photoIds: "x" }, T);
check("配列でなければ400", r.status, 400);
r = await call("PUT", "/accounts/me/best-photos", { photoIds: [P[2], P[0], P[2], P[8], P[6], P[3]] }, T);
check("6枚まで保存でき、重複は除かれ順番は保たれる", [r.status, r.data.bestPhotoIds], [200, [P[2], P[0], P[8], P[6], P[3]]]);
r = await call("POST", "/accounts/ensure", { email: "alice@example.com" }, T);
check("ensureがbestPhotoIdsを返す", r.data.bestPhotoIds, [P[2], P[0], P[8], P[6], P[3]]);
r = await call("PUT", "/accounts/me/best-photos", { photoIds: [] }, T);
check("空にもできる", [r.status, r.data.bestPhotoIds], [200, []]);

// --- アカウント削除 ---
await call("PUT", "/accounts/me/best-photos", { photoIds: [P[1], P[5]] }, T);
await call("PUT", "/accounts/me/avatar", { photoId: AV }, T);
r2.calls.length = 0;
r = await call("POST", "/accounts/delete", { email: "alice@example.com" }, T);
const row = sqlite.prepare("SELECT avatar_photo_id AS a, best_photo_ids AS b FROM accounts WHERE email='alice@example.com'").get();
check("アカウント削除は成功し、列は空になる", [r.status, row.a, row.b], [200, "", "[]"]);
check("プロフィール写真だけR2から消え、旅行の写真（ベストの元）は消さない", r2.calls, [[AV]]);
check("旅行の記録の写真は残っている", JSON.parse(sqlite.prepare("SELECT photo_ids AS p FROM entries WHERE id='e1'").get().p).length, 5);

console.log(`account-photos: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
