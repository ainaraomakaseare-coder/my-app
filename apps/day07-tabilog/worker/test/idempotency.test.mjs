/*
 * 冪等性キー（src/idempotency.js）の単体テスト。D1の代わりに最小の偽物を使う。
 * 実行: node worker/test/idempotency.test.mjs
 */
import assert from "node:assert/strict";
import { withIdempotency, isIdempotentTarget, KEY_RE } from "../src/idempotency.js";
import { cors } from "../src/cors.js";

let pass = 0, fail = 0;
function check(label, got, want) {
  try { assert.deepEqual(got, want); pass++; }
  catch { fail++; console.log("NG  " + label + "\n    got  " + JSON.stringify(got) + "\n    want " + JSON.stringify(want)); }
}

function fakeDb({ missingTable = false } = {}) {
  const rows = new Map();
  const log = [];
  return {
    rows, log,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              log.push(["first", sql]);
              if (missingTable) throw new Error("no such table: idempotency_keys");
              const r = rows.get(args[0]);
              return r ? { response: r.response } : null;
            },
            async run() {
              log.push(["run", sql]);
              if (/^INSERT/.test(sql)) { if (!rows.has(args[0])) rows.set(args[0], { response: args[1], created_at: args[2] }); }
              if (/^DELETE/.test(sql)) for (const [k, v] of rows) if (v.created_at < args[0]) rows.delete(k);
              return {};
            },
          };
        },
      };
    },
  };
}
const req = (path, key, method = "POST") =>
  new Request("https://api.example" + path, { method, headers: key ? { "idempotency-key": key } : {} });
const CORS = cors("capacitor://localhost", "https://x.example");

/* ---- 対象とキーの形 ---- */
check("対象: 予定の作成", isIdempotentTarget("POST", "/trips/t1/blocks"), true);
check("対象: 記録の作成", isIdempotentTarget("POST", "/blocks/b1/entries"), true);
check("対象: 写真", isIdempotentTarget("POST", "/photos"), true);
check("対象外: 更新(PATCH)", isIdempotentTarget("PATCH", "/blocks/b1"), false);
check("対象外: 評価(PUT)", isIdempotentTarget("PUT", "/entries/e1/rating"), false);
check("キー: 短すぎは不可", KEY_RE.test("abc"), false);
check("キー: uuid形式は可", KEY_RE.test("0123456789abcdef0123456789abcdef"), true);

/* ---- 同じキーは1回しか作らない ---- */
{
  const db = fakeDb(); let created = 0;
  const handler = async () => { created++; return new Response(JSON.stringify({ id: "blk_" + created }), { status: 201, headers: { "content-type": "application/json" } }); };
  const k = "a".repeat(32);
  const r1 = await withIdempotency(req("/trips/t1/blocks", k), { DB: db }, CORS, null, handler, () => 1);
  const r2 = await withIdempotency(req("/trips/t1/blocks", k), { DB: db }, CORS, null, handler, () => 1);
  check("1回目は作る", [r1.status, await r1.json()], [201, { id: "blk_1" }]);
  check("2回目は作らず前回の返事", [r2.status, await r2.json(), created], [201, { id: "blk_1" }, 1]);
  check("返事にCORSヘッダーが付く", r2.headers.get("access-control-allow-origin"), "capacitor://localhost");
  check("D1の呼び出し: 1回目は読み1＋書き1", db.log.map((l) => l[0]), ["first", "run", "first"]);
  const r3 = await withIdempotency(req("/trips/t1/blocks", "b".repeat(32)), { DB: db }, CORS, null, handler, () => 1);
  check("別のキーは別に作る", [await r3.json(), created], [{ id: "blk_2" }, 2]);
}

/* ---- キー無し・対象外・失敗は覚えない ---- */
{
  const db = fakeDb(); let n = 0;
  const handler = async () => { n++; return new Response("{}", { status: 201 }); };
  await withIdempotency(req("/trips/t1/blocks", ""), { DB: db }, CORS, null, handler, () => 1);
  await withIdempotency(req("/trips/t1/blocks", ""), { DB: db }, CORS, null, handler, () => 1);
  check("キー無しは毎回作る・D1に触らない", [n, db.log.length], [2, 0]);
  await withIdempotency(req("/blocks/b1", "c".repeat(32), "PATCH"), { DB: db }, CORS, null, handler, () => 1);
  check("対象外のメソッドはD1に触らない", db.log.length, 0);
  const bad = async () => new Response('{"error":"invalid_input"}', { status: 400 });
  await withIdempotency(req("/photos", "d".repeat(32)), { DB: db }, CORS, null, bad, () => 1);
  check("エラー（4xx）は覚えない", db.rows.size, 0);
}

/* ---- テーブルが無い環境では今までどおり ---- */
{
  const db = fakeDb({ missingTable: true }); let n = 0;
  const handler = async () => { n++; return new Response("{}", { status: 201 }); };
  const r = await withIdempotency(req("/photos", "e".repeat(32)), { DB: db }, CORS, null, handler, () => 1);
  check("テーブル無しでも作成は通る", [r.status, n], [201, 1]);
}

/* ---- 古いキーの掃除（確率1%。乱数で強制） ---- */
{
  const db = fakeDb();
  db.rows.set("old-key-123456", { response: "{}", created_at: new Date(Date.now() - 8 * 86400000).toISOString() });
  db.rows.set("new-key-123456", { response: "{}", created_at: new Date().toISOString() });
  const handler = async () => new Response("{}", { status: 201 });
  await withIdempotency(req("/photos", "f".repeat(32)), { DB: db }, CORS, null, handler, () => 0);
  check("7日より古いキーだけ消える", [db.rows.has("old-key-123456"), db.rows.has("new-key-123456"), db.rows.has("f".repeat(32))], [false, true, true]);
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
