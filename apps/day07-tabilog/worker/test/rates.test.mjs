/*
 * 為替レート取得（GET /rates）の純粋関数（ソースの組み立て・レスポンスの解釈・キャッシュキー）の単体テスト。
 * Workers専用のグローバル（fetch・caches）を使わないので、nodeでそのまま実行できる。
 * 実行: node worker/test/rates.test.mjs
 */
import assert from "node:assert/strict";
import {
  isValidCurrency, isValidDate, frankfurterUrl, parseFrankfurterResponse,
  dateToNpmVersion, fallbackUrl, parseFallbackResponse, cacheKeyUrl, cacheTtlSeconds,
} from "../src/rates.js";

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

/* ---- isValidCurrency / isValidDate ---- */
ok("isValidCurrency: 3文字の大文字はOK", isValidCurrency("USD"));
ok("isValidCurrency: 小文字はNG", !isValidCurrency("usd"));
ok("isValidCurrency: 2文字はNG", !isValidCurrency("US"));
ok("isValidCurrency: undefinedはNG", !isValidCurrency(undefined));
ok("isValidDate: YYYY-MM-DDはOK", isValidDate("2024-02-11"));
ok("isValidDate: スラッシュ区切りはNG", !isValidDate("2024/02/11"));

/* ---- frankfurterUrl / parseFrankfurterResponse ---- */
check("frankfurterUrl: base・symbolsを組み立てる",
  frankfurterUrl("2024-02-11", "USD"), "https://api.frankfurter.dev/v1/2024-02-11?base=USD&symbols=JPY");
check("parseFrankfurterResponse: JPYのレートと営業日の日付を返す（週末→直前営業日）",
  parseFrankfurterResponse({ amount: 1.0, base: "USD", date: "2024-02-09", rates: { JPY: 149.46 } }),
  { rate: 149.46, date: "2024-02-09" });
check("parseFrankfurterResponse: 対応していない通貨（ARSなど）のエラーはnull",
  parseFrankfurterResponse({ message: "not found" }), null);
check("parseFrankfurterResponse: dataが無ければnull", parseFrankfurterResponse(null), null);
check("parseFrankfurterResponse: rates.JPYが0以下はnull",
  parseFrankfurterResponse({ date: "2024-02-09", rates: { JPY: 0 } }), null);

/* ---- dateToNpmVersion / fallbackUrl / parseFallbackResponse ---- */
check("dateToNpmVersion: 先頭ゼロを付けないnpmバージョン表記にする",
  dateToNpmVersion("2024-03-02"), "@2024.3.2");
check("dateToNpmVersion: 不正な日付はnull", dateToNpmVersion("abc"), null);
check("fallbackUrl: 通貨コードを小文字にしてjsDelivrのURLを組み立てる",
  fallbackUrl("@2024.3.2", "ARS"), "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@2024.3.2/v1/currencies/ars.json");
check("fallbackUrl: @latestも同じ形", fallbackUrl("@latest", "ARS"),
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/ars.json");
check("parseFallbackResponse: 対象通貨のjpyを拾う",
  parseFallbackResponse({ date: "2024-03-02", ars: { jpy: 0.485 } }, "ARS"), { rate: 0.485, date: "2024-03-02" });
check("parseFallbackResponse: バージョンが存在しない（'Couldn't find...'）はnull",
  parseFallbackResponse({ message: "Couldn't find the requested release version" }, "ARS"), null);
check("parseFallbackResponse: 通貨の値が無ければnull", parseFallbackResponse({ date: "2024-03-02" }, "ARS"), null);

/* ---- cacheKeyUrl / cacheTtlSeconds ---- */
check("cacheKeyUrl: 日付・通貨ごとに違う鍵になる",
  cacheKeyUrl("2024-02-11", "USD") !== cacheKeyUrl("2024-02-12", "USD"), true);
check("cacheKeyUrl: 同じ日付・通貨なら同じ鍵",
  cacheKeyUrl("2024-02-11", "USD"), cacheKeyUrl("2024-02-11", "USD"));
check("cacheTtlSeconds: 過去日は30日", cacheTtlSeconds("2024-02-11", "2026-09-27"), 60 * 60 * 24 * 30);
check("cacheTtlSeconds: 今日の日付は6時間", cacheTtlSeconds("2026-09-27", "2026-09-27"), 60 * 60 * 6);

console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
