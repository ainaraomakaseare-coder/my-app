/*
 * 有料プランの販売停止（2026-09-30、docs/adr/0004、App Review 3.1.1）を、Workerの入口（fetch）から
 * node:sqlite（Node 22.5+）の本物のSQLiteの上で確かめる。Stripeは呼ばない（fetchはモックで、呼ばれたら数える）。
 * 確かめること：/accounts/ensureのplanは常にfree（DBにpremium_plusが入っていても）／
 * 回数の上限はDBのplanに関係なく無料の上限／使い切ったらpremium_requiredではなくquota_exceeded／
 * おまけの回数（ticket_credits）は使い切ったあとに1回ずつ減る／checkout・portal・回数券の購入は410 billing_disabled／
 * Webhookは200を返すが何も変えない。
 * 実行: node worker/test/billing-disabled.test.mjs
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
CREATE TABLE trips (id TEXT PRIMARY KEY, title TEXT NOT NULL, start_date TEXT NOT NULL DEFAULT '', end_date TEXT NOT NULL DEFAULT '', companions TEXT NOT NULL DEFAULT '[]', cover_photo_id TEXT NOT NULL DEFAULT '', trip_type TEXT NOT NULL DEFAULT '', settle_unit INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
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
const env = { DB, ALLOWED_ORIGIN: "https://app.example", STRIPE_SECRET_KEY: "sk_test_dummy", STRIPE_WEBHOOK_SECRET: "whsec_dummy", OPENAI_API_KEY: "test" };

let stripeCalls = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("stripe.com")) { stripeCalls++; return new Response("{}", { status: 500 }); }
  if (u.includes("api.openai.com")) {
    return new Response(JSON.stringify({ status: "completed", output_text: JSON.stringify({ items: [] }) }));
  }
  return new Response("{}", { status: 404 });
};

async function call(method, path, body, headers) {
  const h = { origin: "https://app.example", "content-type": "application/json", ...(headers || {}) };
  const res = await worker.fetch(new Request("https://api.example" + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
  let data = null;
  try { data = await res.json(); } catch { /* 本文なし */ }
  return { status: res.status, data };
}

const now = new Date().toISOString();
const period = now.slice(0, 7) + "-01";
function addAccount(email, aid, fields) {
  const f = { plan: "free", ticket_credits: 0, voice_uses_this_period: 0, memo_uses_this_period: 0, ...fields };
  sqlite.prepare("INSERT INTO accounts (email, account_id, name, plan, ticket_credits, plan_period_start, voice_uses_this_period, memo_uses_this_period, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(email, aid, "テスト", f.plan, f.ticket_credits, period, f.voice_uses_this_period, f.memo_uses_this_period, now, now);
  sqlite.prepare("INSERT INTO trip_members (id, trip_id, account_id, name, joined_at) VALUES (?,?,?,?,?)").run("m_" + aid, "t1", aid, "テスト", now);
}
sqlite.prepare("INSERT INTO trips (id, title, start_date, end_date, created_at, updated_at) VALUES ('t1','東京','2026-10-03','2026-10-05',?,?)").run(now, now);
addAccount("legacy@example.com", "100001", { plan: "premium_plus", ticket_credits: 5, voice_uses_this_period: 10, memo_uses_this_period: 10 });
addAccount("basic@example.com", "100002", { plan: "basic" });
addAccount("free@example.com", "100003", { plan: "free", ticket_credits: 0, memo_uses_this_period: 10 });
addAccount("bonus@example.com", "100004", { plan: "free", ticket_credits: 2, memo_uses_this_period: 10 });
addAccount("plus@example.com", "100005", { plan: "premium_plus", memo_uses_this_period: 10 });

const tickets = (email) => sqlite.prepare("SELECT ticket_credits t FROM accounts WHERE email = ?").get(email).t;

/* ---- /accounts/ensure：DBにpremium_plusが入っていても、freeの上限で返す（フィールド名は変えない） ---- */
{
  const r = await call("POST", "/accounts/ensure", { email: "legacy@example.com", name: "テスト" });
  check("ensure: 200", r.status, 200);
  check("ensure: planは常にfree", r.data.plan, "free");
  check("ensure: 音声の上限は3（50ではない）", [r.data.voiceMonthlyLimit, r.data.voiceRemainingThisPeriod], [3, 0]);
  check("ensure: メモ・スクショの上限は3（100ではない）", [r.data.memoMonthlyLimit, r.data.memoRemainingThisPeriod], [3, 0]);
  check("ensure: 古いアプリ用のフィールド名は残る", ["accountId", "email", "name", "plan", "voiceUsesThisPeriod", "voiceMonthlyLimit", "voiceRemainingThisPeriod", "memoMonthlyLimit", "memoRemainingThisPeriod", "ticketCredits"].every((k) => k in r.data), true);
  const b = await call("POST", "/accounts/ensure", { email: "basic@example.com", name: "テスト" });
  check("ensure: basicも音声3・メモ3", [b.data.plan, b.data.voiceMonthlyLimit, b.data.memoMonthlyLimit], ["free", 3, 3]);
  const n = await call("POST", "/accounts/ensure", { email: "new@example.com", name: "新規" });
  check("ensure: 新規はfree・おまけ3回", [n.data.plan, n.data.ticketCredits], ["free", 3]);
}

/* ---- 回数の確認：premium_plusでも枠を使い切ったら断る（premium_requiredは返さない） ---- */
const textScan = (email) => call("POST", "/trips/t1/text-scan", { text: "10時に浅草寺", email, date: "2026-10-04" });
{
  const r = await textScan("free@example.com");
  check("text-scan: 無料で枠を使い切り、おまけも無いと403 quota_exceeded（premium_requiredではない）", [r.status, r.data.error], [403, "quota_exceeded"]);
  const p = await textScan("plus@example.com");
  check("text-scan: DBがpremium_plusでもメモ10回使い切りなら403 quota_exceeded（100回にはならない）", [p.status, p.data.error], [403, "quota_exceeded"]);
  const before = tickets("bonus@example.com");
  const b = await textScan("bonus@example.com");
  check("text-scan: おまけの回数がある人は枠を使い切っても403にならない", b.status === 403, false);
  check("text-scan: おまけの回数は増えない（使ったら1減る）", tickets("bonus@example.com") <= before && tickets("bonus@example.com") >= before - 1, true);
}

/* ---- 購入の入口は全部止まっている ---- */
{
  const c = await call("POST", "/billing/checkout", { email: "free@example.com", plan: "basic", successUrl: "https://app.example/?billing=success", cancelUrl: "https://app.example/?billing=cancel" });
  check("checkout: 410 billing_disabled", [c.status, c.data], [410, { error: "billing_disabled" }]);
  const p = await call("POST", "/billing/portal", { email: "legacy@example.com", returnUrl: "https://app.example/" });
  check("portal: 410 billing_disabled", [p.status, p.data], [410, { error: "billing_disabled" }]);
  const t = await call("POST", "/billing/ticket", { email: "free@example.com" });
  check("ticket購入: 410 billing_disabled", [t.status, t.data], [410, { error: "billing_disabled" }]);
  const t2 = await call("POST", "/billing/tickets/checkout", { email: "free@example.com" });
  check("ticket購入（別名）: 410 billing_disabled", [t2.status, t2.data], [410, { error: "billing_disabled" }]);
  check("Stripeは1回も呼ばれない", stripeCalls, 0);
}

/* ---- Webhook：200を返すが、アカウントは何も変わらない ---- */
{
  const event = { type: "checkout.session.completed", data: { object: { client_reference_id: "free@example.com", customer: "cus_x", subscription: "sub_x", metadata: { plan: "premium_plus" } } } };
  const w = await call("POST", "/billing/webhook", event, { "stripe-signature": "t=1,v1=bad" });
  check("webhook: 200（Stripeの再送を止める）", w.status, 200);
  const row = sqlite.prepare("SELECT plan, stripe_customer_id c, stripe_subscription_id s, ticket_credits t FROM accounts WHERE email='free@example.com'").get();
  check("webhook: プランも顧客IDも回数も変わらない", [row.plan, row.c, row.s, row.t], ["free", "", "", 0]);
  const e = await call("POST", "/accounts/ensure", { email: "free@example.com", name: "テスト" });
  check("webhook後もplanはfree", e.data.plan, "free");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
