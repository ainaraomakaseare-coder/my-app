/*
 * 費用の明細（costItems）の外貨→円レート取得（DAY31〜、docs/adr/0014）で、
 * 「どのソースを使うか・結果をどう解釈するか」だけを扱う純粋関数。
 * 実際のfetch・キャッシュ（caches.default）はWorkers専用のグローバルを使うため、
 * こちらではURL組み立て・レスポンスの解釈・キャッシュキー計算だけに留め、
 * nodeでそのまま単体テストできるようにしている（worker/test/rates.test.mjs）。
 *
 * ソースは2段構え：
 * 1) Frankfurter（ECB基準レート、https://api.frankfurter.dev/ ）。約30通貨・過去日にも対応。
 *    週末・休場日を指定すると直前の営業日のレートが返る（レスポンスのdateで分かる）。
 * 2) Frankfurterが対応していない通貨（ARSなど）のフォールバック：fawazahmed0/currency-api
 *    （jsDelivr配信）。日付ごとのバージョン（@YYYY.M.D、2024-03-02以降のみ存在）でまず試し、
 *    無ければ@latestを使う（そのときはUIに「最新のレートです」と警告を出すため、
 *    sourceを"currency-api-latest"で区別する）。
 */

const CURRENCY_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const FRANKFURTER_BASE_URL = "https://api.frankfurter.dev/v1/";
export const FALLBACK_BASE_URL = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api";

export function isValidCurrency(code) {
  return typeof code === "string" && CURRENCY_RE.test(code);
}

export function isValidDate(date) {
  return typeof date === "string" && DATE_RE.test(date);
}

// Frankfurter：base=<currency>・symbols=JPYで「1<currency>が何円か」を直接もらう
// （逆に base=JPY にして 1/rate を計算するより、桁落ちが少ない）。
export function frankfurterUrl(date, currency) {
  return FRANKFURTER_BASE_URL + date + "?base=" + currency + "&symbols=JPY";
}

export function parseFrankfurterResponse(data) {
  const rate = data && data.rates && data.rates.JPY;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const date = typeof data.date === "string" ? data.date.slice(0, 10) : null;
  return { rate, date: DATE_RE.test(date || "") ? date : null };
}

// "2024-03-02" -> "@2024.3.2"（npmのバージョン表記は先頭ゼロを付けない）
export function dateToNpmVersion(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!m) return null;
  return "@" + Number(m[1]) + "." + Number(m[2]) + "." + Number(m[3]);
}

export function fallbackUrl(version, currency) {
  return FALLBACK_BASE_URL + version + "/v1/currencies/" + currency.toLowerCase() + ".json";
}

export function parseFallbackResponse(data, currency) {
  const bucket = data && data[currency.toLowerCase()];
  const rate = bucket && bucket.jpy;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const date = typeof data.date === "string" ? data.date.slice(0, 10) : null;
  return { rate, date: DATE_RE.test(date || "") ? date : null };
}

export function cacheKeyUrl(date, currency) {
  return "https://tabilog-rates.cache/v1?date=" + encodeURIComponent(date) + "&currency=" + encodeURIComponent(currency);
}

// 過去日のレートは変わらないので長く（30日）キャッシュする。今日の日付だけ、まだ更新され得るので短め（6時間）。
export function cacheTtlSeconds(date, todayDate) {
  return date === todayDate ? 60 * 60 * 6 : 60 * 60 * 24 * 30;
}
