/*
 * 冪等性キー（Idempotency-Key）。電波がないときの送信待ち（app.js のoutbox）が、同じ作成（POST）を
 * もう一度送っても二重に作らないための仕組み。サーバーに届いたのに返事だけ失われた場合に起きる。
 *
 * 対象：予定の作成（POST /trips/:id/blocks）・記録の作成（POST /blocks/:id/entries）・写真/動画のアップロード（POST /photos）。
 * キー（クライアントが作る推測できない乱数）が付いていて、すでに覚えていれば、作らずに前回の返事をそのまま返す。
 * 付いていなければ、今までどおり。
 *
 * 覚える場所は D1 の idempotency_keys（migrations/0037_idempotency_keys.sql）。1リクエストにつき読み1回＋書き1回
 * （Workers Free の subrequest 上限の中）。作成の処理本体（各ハンドラ）とは別の書き込みなので「同じバッチ」にはできず、
 * 作成した直後にキーを書く。その間にWorkerが落ちると、再送で二重になりうる（極めて稀）。
 * 同じキーの2つのリクエストが同時に届いた場合も、両方が作成しうる（送信待ちは1件ずつ順に送るので通常は起きない）。
 *
 * 古いキーの掃除：キーを書くとき、約1%の確率で7日より古いものを消す（定期ジョブは使わない）。
 * テーブルがまだ無い環境（マイグレーション前にデプロイしたとき）では、キーを無視して今までどおり動く。
 */
export const KEY_RE = /^[A-Za-z0-9_-]{8,80}$/;
export const KEY_TTL_DAYS = 7;
export const CLEANUP_RATE = 0.01;

export function isIdempotentTarget(method, path) {
  if (method !== "POST") return false;
  return /^\/trips\/[^/]+\/blocks$/.test(path) || /^\/blocks\/[^/]+\/entries$/.test(path) || path === "/photos";
}

// handler：本来の処理（() => Promise<Response>）。corsHeaders：覚えていた返事を返すときに付けるCORSヘッダー
export async function withIdempotency(request, env, corsHeaders, ctx, handler, random = Math.random) {
  const key = request.headers.get("idempotency-key") || "";
  if (!key || !KEY_RE.test(key) || !env.DB) return handler();
  const path = new URL(request.url).pathname;
  if (!isIdempotentTarget(request.method, path)) return handler();

  try {
    const hit = await env.DB.prepare("SELECT response FROM idempotency_keys WHERE key = ?").bind(key).first();
    if (hit && hit.response) {
      const saved = JSON.parse(hit.response);
      return new Response(saved.body, {
        status: saved.status,
        headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders, "idempotent-replay": "1" },
      });
    }
  } catch {
    return handler(); // テーブルが無いなど：キーを無視する
  }

  const res = await handler();
  if (res.status >= 200 && res.status < 300) {
    try {
      const body = await res.clone().text();
      const now = new Date();
      await env.DB.prepare("INSERT OR IGNORE INTO idempotency_keys (key, response, created_at) VALUES (?,?,?)")
        .bind(key, JSON.stringify({ status: res.status, body }), now.toISOString())
        .run();
      if (random() < CLEANUP_RATE) {
        const cutoff = new Date(now.getTime() - KEY_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
        const job = env.DB.prepare("DELETE FROM idempotency_keys WHERE created_at < ?").bind(cutoff).run().catch(() => {});
        if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(job);
        else await job;
      }
    } catch { /* 覚えられなくても、作成そのものは成功している */ }
  }
  return res;
}
