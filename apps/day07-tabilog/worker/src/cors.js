/*
 * CORS（どのOriginからのリクエストを許可するか）だけを扱う純粋関数。
 * Workers専用のグローバルを使わないので、nodeでそのまま単体テストできる
 * （worker/test/cors.test.mjs）。
 *
 * ALLOWED_ORIGIN（wrangler.jsoncのvars）はカンマ区切りで複数指定できる
 * （2026-09-29〜：GitHub PagesからCloudflare Pagesへの移行期間中、両方のホストを許可するため）。
 */

function parseAllowedOrigins(allowed) {
  return (allowed || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAllowedOrigin(origin, allowed) {
  const list = parseAllowedOrigins(allowed);
  if (list.indexOf(origin) !== -1) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "")) return true;
  // iOSアプリ（Capacitor）内のWebViewは、ページを https://... ではなく
  // capacitor://localhost から読み込んでいるため、そのOriginも許可する。
  if (origin === "capacitor://localhost") return true;
  // CapacitorHttpプラグイン経由（WebViewを介さずネイティブ側がHTTPリクエストを
  // 送る方式）だとOriginヘッダー自体が付かないため、それも許可する。
  if (!origin) return true;
  return false;
}

export function cors(origin, allowed) {
  const ok = isAllowedOrigin(origin, allowed);
  // 許可リストの中で実際に一致したOriginをそのまま返す（複数許可していても、
  // access-control-allow-originはリクエストごとに一つだけ返す必要があるため）。
  const list = parseAllowedOrigins(allowed);
  const fallback = list[0] || allowed || "";
  return {
    "access-control-allow-origin": ok ? (origin || fallback) : fallback,
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, x-voice-meta, authorization, idempotency-key",
    "vary": "Origin",
  };
}
