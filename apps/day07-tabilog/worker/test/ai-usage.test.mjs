/*
 * 運営者向け「AIの使用状況」（ai_usage_dailyの記録と GET /admin/ai-usage）を、node:sqlite の本物のSQLiteの上で確かめるテスト。
 * 確かめること：外部API（Google Places）を呼ぶとUPSERTで回数が増える／記録に失敗してもリクエストは成功する／
 * ADMIN_EMAILS未設定なら404／運営者でなければ404／運営者なら200で集計が返る／/accounts/ensureのisAdminは運営者にだけ付く。
 * 実行: node worker/test/ai-usage.test.mjs
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
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
CREATE TABLE accounts (email TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT 'free', ticket_credits INTEGER NOT NULL DEFAULT 0, plan_period_start TEXT NOT NULL DEFAULT '', voice_uses_this_period INTEGER NOT NULL DEFAULT 0, memo_uses_this_period INTEGER NOT NULL DEFAULT 0, stripe_customer_id TEXT NOT NULL DEFAULT '', stripe_subscription_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
`);

let failWrites = false;
const DB = {
  prepare(sql) {
    if (failWrites && /ai_usage_daily/.test(sql) && /INSERT/.test(sql)) throw new Error("D1 down");
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
const ctx = { waitUntil() {} };
const tick = () => new Promise((r) => setTimeout(r, 20));

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://places.googleapis.com/")) {
    return new Response(JSON.stringify({ location: { latitude: 35.0, longitude: 139.0 }, displayName: { text: "x" }, formattedAddress: "y" }), { status: 200 });
  }
  return realFetch(url, init);
};

const token = (n) => String(n).repeat(64).slice(0, 64);
const nowIso = new Date().toISOString();
const month = nowIso.slice(0, 7) + "-01";
function addSession(t, email) {
  sqlite.prepare("INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?,?,?,?)")
    .run(createHash("sha256").update(t).digest("hex"), email, nowIso, new Date(Date.now() + 86400000).toISOString());
}
const adminTok = token("a"), userTok = token("b");
addSession(adminTok, "boss@example.com");
addSession(userTok, "user@example.com");
sqlite.prepare("INSERT INTO accounts (email, account_id, name, ticket_credits, plan_period_start, voice_uses_this_period, memo_uses_this_period, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .run("boss@example.com", "acc1", "B", 3, month, 2, 1, nowIso, nowIso);
sqlite.prepare("INSERT INTO accounts (email, account_id, name, ticket_credits, plan_period_start, voice_uses_this_period, memo_uses_this_period, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .run("user@example.com", "acc2", "U", 3, "2000-01-01", 9, 9, nowIso, nowIso);

async function call(method, path, env, tok, body) {
  const headers = { origin: "https://app.example" };
  if (tok) headers.authorization = "Bearer " + tok;
  if (body) headers["content-type"] = "application/json";
  const res = await worker.fetch(new Request("https://api.example" + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  let data = null;
  try { data = await res.json(); } catch { /* 本文なし */ }
  return { status: res.status, data };
}
const baseEnv = { DB, ALLOWED_ORIGIN: "https://app.example", GOOGLE_API_KEY: "k", REQUIRE_SESSION: "1" };
const rowsNow = () => sqlite.prepare("SELECT feature, provider, calls FROM ai_usage_daily ORDER BY feature, provider").all().map((r) => ({ ...r }));

// ---------- migration前（テーブルなし）でもリクエストは成功する ----------
{
  const r = await call("GET", "/places/details?id=ChIJ1234567890abc", baseEnv);
  await tick();
  check("テーブルが無くても本体は200", [r.status, r.data.found], [200, true]);
}
sqlite.exec(readFileSync(new URL("../migrations/0035_ai_usage_daily.sql", import.meta.url), "utf8"));

// ---------- UPSERTで増える ----------
{
  await call("GET", "/places/details?id=ChIJ1234567890abc", baseEnv);
  await tick();
  check("1回目は1", rowsNow(), [{ feature: "places", provider: "google_places", calls: 1 }]);
  await call("GET", "/places/details?id=ChIJ1234567890abc", baseEnv);
  await call("GET", "/places/details?id=ChIJ1234567890abc", baseEnv);
  await tick();
  check("同じ日・機能・サービスは足し算される", rowsNow(), [{ feature: "places", provider: "google_places", calls: 3 }]);
}

// ---------- 記録に失敗してもリクエストは壊れない ----------
{
  failWrites = true;
  const r = await call("GET", "/places/details?id=ChIJ1234567890abc", baseEnv);
  await tick();
  failWrites = false;
  check("記録に失敗しても200で、数は増えない", [r.status, r.data.found, rowsNow()[0].calls], [200, true, 3]);
}

// ---------- GET /admin/ai-usage ----------
{
  let r = await call("GET", "/admin/ai-usage", baseEnv, adminTok);
  check("ADMIN_EMAILS未設定は404", r.status, 404);
  const env = { ...baseEnv, ADMIN_EMAILS: " Boss@Example.com , other@example.com" };
  r = await call("GET", "/admin/ai-usage", env);
  check("ログインしていないと404", r.status, 404);
  r = await call("GET", "/admin/ai-usage", env, userTok);
  check("運営者でないと404", r.status, 404);
  r = await call("GET", "/admin/ai-usage", env, adminTok);
  check("運営者は200", r.status, 200);
  check("今月のサービス別・機能別", [r.data.monthTotals.byProvider, r.data.monthTotals.byFeature], [{ google_places: 3 }, { places: 3 }]);
  check("日別の行", r.data.rows.map((x) => [x.feature, x.provider, x.calls]), [["places", "google_places", 3]]);
  // 先月のまま更新されていないアカウント(user)の使用回数は今月の集計に入れない
  check("アカウント集計", r.data.accounts, { count: 2, voiceUsesThisPeriod: 2, memoUsesThisPeriod: 1, ticketCredits: 6, usedAiThisMonth: 1 });
  check("Visionの本日分と上限", [r.data.vision.imagesToday, r.data.vision.dailyCap], [0, null]);

  // /accounts/ensure：isAdminは運営者にだけ
  const a = await call("POST", "/accounts/ensure", env, adminTok, { email: "boss@example.com", name: "B" });
  const u = await call("POST", "/accounts/ensure", env, userTok, { email: "user@example.com", name: "U" });
  check("運営者のensureにはisAdmin:true", a.data.isAdmin, true);
  check("一般ユーザーのensureにはisAdminが無い", "isAdmin" in u.data, false);
  const n = await call("POST", "/accounts/ensure", baseEnv, adminTok, { email: "boss@example.com", name: "B" });
  check("ADMIN_EMAILS未設定ならisAdminは付かない", "isAdmin" in n.data, false);
}

globalThis.fetch = realFetch;
console.log(`ai-usage: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
