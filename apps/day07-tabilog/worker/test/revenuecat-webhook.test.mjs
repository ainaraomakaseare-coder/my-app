/*
 * RevenueCat Webhook（回数券のアプリ内課金。docs/adr/0004の2026-09-30の節）を、Workerの入口（fetch）から
 * node:sqlite（Node 22.5+）の本物のSQLiteの上で確かめる。
 * 確かめること：合言葉が未設定なら404／合言葉が違えば401／購入で回数が足される（10回・30回）／
 * 同じtransaction_idの再送では足されない／SANDBOXは変数がtrueのときだけ反映／未知の商品・未知のユーザー・
 * NON_RENEWING_PURCHASE以外のイベントは200で何も変えない／/accounts/ensureのticketCreditsに反映される。
 * 実行: node worker/test/revenuecat-webhook.test.mjs
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
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
CREATE TABLE accounts (email TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT 'free', ticket_credits INTEGER NOT NULL DEFAULT 0, plan_period_start TEXT NOT NULL DEFAULT '', voice_uses_this_period INTEGER NOT NULL DEFAULT 0, memo_uses_this_period INTEGER NOT NULL DEFAULT 0, stripe_customer_id TEXT NOT NULL DEFAULT '', stripe_subscription_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE iap_transactions (transaction_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, product_id TEXT NOT NULL, credits INTEGER NOT NULL, environment TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
`);
function stmt(sql) {
  const st = sqlite.prepare(sql);
  let params = [];
  const o = {
    bind(...p) { params = p; return o; },
    async first() { return st.get(...params) || null; },
    async all() { return { results: st.all(...params) }; },
    async run() { st.run(...params); return { success: true }; },
    _exec() { st.run(...params); },
  };
  return o;
}
const DB = {
  prepare: stmt,
  // D1のbatchと同じく、全部成功するか全部取り消すか
  async batch(list) {
    sqlite.exec("BEGIN");
    try { list.forEach((s) => s._exec()); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
    return [];
  },
};
const AUTH = "Bearer secret-for-test";
const env = { DB, ALLOWED_ORIGIN: "https://app.example", REVENUECAT_WEBHOOK_AUTH: AUTH };

async function post(body, auth, e) {
  const headers = { "content-type": "application/json" }; // Originは付けない（RevenueCatのサーバーから直接届く）
  if (auth !== null) headers.authorization = auth === undefined ? AUTH : auth;
  const res = await worker.fetch(new Request("https://api.example/billing/revenuecat-webhook", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }), e || env, { waitUntil() {} });
  let data = null;
  try { data = await res.json(); } catch { /* 本文なし */ }
  return { status: res.status, data };
}
const ev = (o) => ({ api_version: "1.0", event: { type: "NON_RENEWING_PURCHASE", app_user_id: "100001", product_id: "com.hiroyaapps.tabilog.ticket10", transaction_id: "tx1", environment: "PRODUCTION", ...o } });
const credits = (id) => sqlite.prepare("SELECT ticket_credits t FROM accounts WHERE account_id = ?").get(id).t;
const txCount = () => sqlite.prepare("SELECT COUNT(*) c FROM iap_transactions").get().c;

const now = new Date().toISOString();
const period = now.slice(0, 7) + "-01";
sqlite.prepare("INSERT INTO accounts (email, account_id, name, ticket_credits, plan_period_start, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run("a@example.com", "100001", "A", 3, period, now, now);
sqlite.prepare("INSERT INTO accounts (email, account_id, name, ticket_credits, plan_period_start, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run("b@example.com", "100002", "B", 0, period, now, now);

// 各テストで隠れたconsole.errorを黙らせる（未知の商品・ユーザーは意図的にログを出す）
const origError = console.error;
console.error = () => {};

/* ---- 認証 ---- */
{
  let r = await post(ev(), undefined, { ...env, REVENUECAT_WEBHOOK_AUTH: undefined });
  check("合言葉が未設定なら404（経路が無いのと同じ）", r.status, 404);
  r = await post(ev(), "Bearer wrong");
  check("合言葉が違えば401", r.status, 401);
  r = await post(ev(), null);
  check("Authorizationヘッダーが無ければ401", r.status, 401);
  check("認証に失敗した間は回数が変わらない", [credits("100001"), txCount()], [3, 0]);
  r = await post("not json");
  check("JSONでなければ400", r.status, 400);
}

/* ---- 購入で回数が足される ---- */
{
  let r = await post(ev());
  check("ticket10の購入は200", r.status, 200);
  check("ticket10で+10（3→13）", credits("100001"), 13);
  r = await post(ev({ product_id: "com.hiroyaapps.tabilog.ticket30", transaction_id: "tx2" }));
  check("ticket30で+30（13→43）", credits("100001"), 43);
  check("取引が2件記録される", txCount(), 2);
  check("他のアカウントは変わらない", credits("100002"), 0);
}

/* ---- 再送（同じtransaction_id）では足されない ---- */
{
  const r = await post(ev());
  check("同じ取引の再送は200", r.status, 200);
  check("同じ取引の再送で回数は増えない", [credits("100001"), txCount()], [43, 2]);
}

/* ---- SANDBOX ---- */
{
  let r = await post(ev({ environment: "SANDBOX", transaction_id: "sb1" }));
  check("SANDBOXは変数が無ければ200で無視", [r.status, credits("100001"), txCount()], [200, 43, 2]);
  r = await post(ev({ environment: "SANDBOX", transaction_id: "sb1" }), undefined, { ...env, REVENUECAT_ACCEPT_SANDBOX: "false" });
  check("SANDBOXはfalseでも無視", [r.status, credits("100001")], [200, 43]);
  r = await post(ev({ environment: "SANDBOX", transaction_id: "sb1" }), undefined, { ...env, REVENUECAT_ACCEPT_SANDBOX: "true" });
  check("SANDBOXは変数がtrueなら反映", [r.status, credits("100001")], [200, 53]);
  r = await post(ev({ environment: "SANDBOX", transaction_id: "sb1" }), undefined, { ...env, REVENUECAT_ACCEPT_SANDBOX: "true" });
  check("SANDBOXでも再送は足さない", credits("100001"), 53);
}

/* ---- 何もせず200 ---- */
{
  let r = await post(ev({ product_id: "com.example.other", transaction_id: "u1" }));
  check("未知の商品は200で無視", [r.status, credits("100001"), txCount()], [200, 53, 3]);
  r = await post(ev({ app_user_id: "999999", transaction_id: "u2" }));
  check("未知のユーザーは200で無視", [r.status, txCount()], [200, 3]);
  r = await post(ev({ app_user_id: "$RCAnonymousID:abc", transaction_id: "u3" }));
  check("匿名IDも200で無視", [r.status, txCount()], [200, 3]);
  for (const type of ["INITIAL_PURCHASE", "RENEWAL", "CANCELLATION", "REFUND", "TEST", "EXPIRATION"]) {
    r = await post(ev({ type, transaction_id: "e_" + type }));
    check(type + "は200で何もしない", [r.status, credits("100001"), txCount()], [200, 53, 3]);
  }
  r = await post(ev({ transaction_id: "" }));
  check("transaction_idが無ければ無視", [r.status, txCount()], [200, 3]);
}

/* ---- 上の購入が /accounts/ensure のticketCreditsに出る ---- */
{
  const res = await worker.fetch(new Request("https://api.example/accounts/ensure", {
    method: "POST",
    headers: { origin: "https://app.example", "content-type": "application/json" },
    body: JSON.stringify({ email: "a@example.com", name: "A" }),
  }), env, { waitUntil() {} });
  const data = await res.json();
  check("ensureのticketCreditsに反映される（プランはfreeのまま）", [res.status, data.ticketCredits, data.plan], [200, 53, "free"]);
}

console.error = origError;
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
