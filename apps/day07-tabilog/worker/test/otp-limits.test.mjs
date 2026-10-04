/*
 * メールOTPの乱用対策を、node:sqlite の本物のSQLiteの上で確かめるテスト。
 * 確かめること：再送しても失敗回数の上限（1時間10回）は戻らない／コード送信はメールごと1日10回・IPごと1時間20回まで／
 * 1つのコードの試行回数は5回までで原子的に数える／正しいコードなら通る／テーブルが無い環境（migration前）でも動く。
 * 実行: node worker/test/otp-limits.test.mjs
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
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
CREATE TABLE email_otps (email TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE accounts (email TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT 'free', ticket_credits INTEGER NOT NULL DEFAULT 0, plan_period_start TEXT NOT NULL DEFAULT '', voice_uses_this_period INTEGER NOT NULL DEFAULT 0, memo_uses_this_period INTEGER NOT NULL DEFAULT 0, stripe_customer_id TEXT NOT NULL DEFAULT '', stripe_subscription_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE auth_identities (provider TEXT NOT NULL, subject TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL, refresh_token TEXT NOT NULL DEFAULT '');
CREATE TABLE auth_codes (code_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
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
const env = { DB, ALLOWED_ORIGIN: "https://app.example", RESEND_API_KEY: "test-key" };
const ctx = { waitUntil() {} };

// メール送信（Resend）は本物を呼ばない
const realFetch = globalThis.fetch;
let sent = 0;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.resend.com/")) { sent++; return new Response("{}", { status: 200 }); }
  return realFetch(url, init);
};

async function post(path, body, ip = "1.1.1.1") {
  const res = await worker.fetch(new Request("https://api.example" + path, {
    method: "POST",
    headers: { origin: "https://app.example", "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  }), env, ctx);
  let data = null;
  try { data = await res.json(); } catch { /* 本文なし */ }
  return { status: res.status, data };
}
const send = (email, ip) => post("/auth/email/send", { email, name: "テスト" }, ip);
const verify = (email, code) => post("/auth/email/verify", { email, code });
// クールダウン（60秒）を飛ばすため、送信済みの行の作成時刻を過去にずらす
const skipCooldown = (email) => sqlite.prepare("UPDATE email_otps SET created_at = ? WHERE email = ?").run(new Date(Date.now() - 120000).toISOString(), email);
const setCode = (email, code) => sqlite.prepare("UPDATE email_otps SET code = ? WHERE email = ?").run(code, email);

// ---------- migration前（otp_limitsなし）でも壊れない ----------
{
  let r = await send("pre@example.com");
  check("テーブルが無くても送信できる", [r.status, r.data.ok], [200, true]);
  setCode("pre@example.com", "123456");
  r = await verify("pre@example.com", "000000");
  check("テーブルが無くても間違いは401", [r.status, r.data.error], [401, "wrong_code"]);
  r = await verify("pre@example.com", "123456");
  check("テーブルが無くても正しいコードは通る", [r.status, r.data.ok !== false], [200, true]);
}

sqlite.exec(readFileSync(new URL("../migrations/0034_otp_limits.sql", import.meta.url), "utf8"));

// ---------- 再送しても失敗回数は戻らない ----------
{
  const email = "guess@example.com";
  await send(email);
  setCode(email, "123456");
  let last;
  let blockedAt = 0;
  // 1コード5回までの試行。5回で無効になったら再送して続ける（攻撃者の動き）
  for (let i = 1; i <= 14; i++) {
    last = await verify(email, "000000");
    if (last.status === 429) { blockedAt = i; if (last.data.error === "too_many_attempts" && sqlite.prepare("SELECT COUNT(*) AS n FROM email_otps WHERE email = ?").get(email).n === 0) { skipCooldown(email); await send(email); setCode(email, "123456"); } else break; }
  }
  const fails = sqlite.prepare("SELECT count FROM otp_limits WHERE key = ?").get("fail:" + email);
  check("再送を挟んでも失敗は合計10回で打ち止め（11回目以降は429）", [last.status, last.data.error, fails.count], [429, "too_many_attempts", 10]);
  // 予算を使い切ったあとは、正しいコードでも通らない
  const ok = await verify(email, "123456");
  check("失敗の予算を使い切ると、正しいコードでも429", [ok.status, ok.data.error], [429, "too_many_attempts"]);
  // 窓（1時間）が過ぎたら戻る
  sqlite.prepare("UPDATE otp_limits SET window_start = ? WHERE key = ?").run(new Date(Date.now() - 2 * 3600000).toISOString(), "fail:" + email);
  sqlite.prepare("DELETE FROM email_otps WHERE email = ?").run(email);
  sqlite.prepare("INSERT INTO email_otps (email, code, name, attempts, expires_at, created_at) VALUES (?,?,?,0,?,?)").run(email, "654321", "", new Date(Date.now() + 600000).toISOString(), new Date().toISOString());
  const again = await verify(email, "654321");
  check("1時間たつと、正しいコードで通る", again.status, 200);
}

// ---------- 1つのコードは5回まで（原子的に数える） ----------
{
  const email = "five@example.com";
  await send(email);
  setCode(email, "123456");
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await verify(email, "000000")).status);
  check("5回までは401", codes, [401, 401, 401, 401, 401]);
  const sixth = await verify(email, "123456");
  check("6回目は正しいコードでも429（コードは無効）", [sixth.status, sixth.data.error], [429, "too_many_attempts"]);
}

// ---------- 送信回数の上限 ----------
{
  const email = "many@example.com";
  const results = [];
  for (let i = 0; i < 11; i++) {
    const r = await send(email, "9.9." + i + ".1");
    results.push(r.status);
    skipCooldown(email);
  }
  check("メールごとの1日の送信は10回まで（11回目は429 too_soon）", [results.slice(0, 10).every((s) => s === 200), results[10]], [true, 429]);
  const r = await send("other@example.com", "9.9.1.1");
  check("別のメールは別枠", r.status, 200);
}
{
  const results = [];
  for (let i = 0; i < 21; i++) results.push((await send("ip" + i + "@example.com", "8.8.8.8")).status);
  check("IPごとの1時間の送信は20回まで（21回目は429）", [results.slice(0, 20).every((s) => s === 200), results[20]], [true, 429]);
  const r = await send("ipx@example.com", "8.8.4.4");
  check("別のIPは別枠", r.status, 200);
}

globalThis.fetch = realFetch;
console.log(`otp-limits: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
