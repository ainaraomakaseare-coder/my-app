/*
 * CORS（どのOriginを許可するか）の純粋関数の単体テスト。
 * ALLOWED_ORIGINがカンマ区切りで複数指定できるようになった（GitHub PagesからCloudflare
 * Pagesへの移行期間中、両方のホストを許可するため。2026-09-29〜）ことを主に確認する。
 * Workers専用のグローバルを使わないので、nodeでそのまま実行できる。
 * 実行: node worker/test/cors.test.mjs
 */
import assert from "node:assert/strict";
import { isAllowedOrigin, cors } from "../src/cors.js";

let pass = 0, fail = 0;
function check(label, got, want) {
  try {
    assert.deepEqual(got, want);
    pass++;
  } catch {
    fail++;
    console.log("NG  " + label);
    console.log("    got  " + JSON.stringify(got));
    console.log("    want " + JSON.stringify(want));
  }
}
function ok(label, cond) { check(label, !!cond, true); }

const OLD = "https://ainaraomakaseare-coder.github.io";
const NEW = "https://tabinoashiato.pages.dev";
const LIST = OLD + "," + NEW;

/* ---- isAllowedOrigin：カンマ区切りの複数許可 ---- */
ok("旧ホスト単体設定は今までどおり許可", isAllowedOrigin(OLD, OLD));
ok("複数許可リストの1つ目（旧ホスト）を許可", isAllowedOrigin(OLD, LIST));
ok("複数許可リストの2つ目（新ホスト）を許可", isAllowedOrigin(NEW, LIST));
ok("複数許可リストに無いOriginは拒否", !isAllowedOrigin("https://evil.example", LIST));
ok("前後にスペースが入ったリストも許可", isAllowedOrigin(NEW, OLD + ", " + NEW));

/* ---- isAllowedOrigin：これまでどおりの特別扱い（複数許可リストでも変わらない） ---- */
ok("localhostは常に許可", isAllowedOrigin("http://localhost:5000", LIST));
ok("127.0.0.1は常に許可", isAllowedOrigin("http://127.0.0.1:5000", LIST));
ok("capacitor://localhostは常に許可", isAllowedOrigin("capacitor://localhost", LIST));
ok("Originヘッダーが無い（CapacitorHttp経由）は常に許可", isAllowedOrigin("", LIST));
ok("許可リストに無いOriginは拒否（単体設定のときと同じ）", !isAllowedOrigin("https://evil.example", OLD));

/* ---- cors：一致したOriginをそのまま返す（複数許可時にaccess-control-allow-originを1つに絞る） ---- */
check("旧ホストからのリクエストには旧ホストをそのまま返す",
  cors(OLD, LIST)["access-control-allow-origin"], OLD);
check("新ホストからのリクエストには新ホストをそのまま返す",
  cors(NEW, LIST)["access-control-allow-origin"], NEW);
check("許可されないOriginにはリストの先頭を返す（実際は403で弾かれ、この値は使われない）",
  cors("https://evil.example", LIST)["access-control-allow-origin"], OLD);
check("単体設定のときの挙動は変わらない（許可時はOriginをそのまま返す）",
  cors(OLD, OLD)["access-control-allow-origin"], OLD);
check("varyヘッダーは今までどおりOrigin",
  cors(OLD, LIST).vary, "Origin");

console.log((fail === 0 ? "" : "FAIL  ") + pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
