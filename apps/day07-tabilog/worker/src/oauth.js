/*
 * ソーシャルログイン（Apple / Google / LINE）の「純粋な部分」だけを集めたファイル
 * （docs/adr/0019-server-side-social-login.md）。
 * DBやfetchは使わないので、nodeでそのまま単体テストできる（worker/test/oauth.test.mjs）。
 * D1の読み書き・プロバイダーとの通信は index.js 側にある。
 *
 * 仕組み（認可コードフロー）：
 *   ①アプリ → Worker /auth/<provider>/start → プロバイダーのログイン画面へ302
 *   ②プロバイダー → Worker /auth/<provider>/callback?code=... （Appleだけ POST）
 *   ③Workerが code をプロバイダーのトークンエンドポイントに渡して id_token を受け取り、
 *     中身（誰か）を確かめて、うちのセッションと引き換えられる「使い捨てコード」を作る
 *   ④アプリが POST /auth/exchange でコードをセッショントークンに交換する
 */

export const PROVIDERS = ["apple", "google", "line"];

// ログイン画面に並べる順番もこの順（Apple, Google, LINE）。
export function configuredProviders(env) {
  const list = [];
  if (env.APPLE_SERVICES_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY) list.push("apple");
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) list.push("google");
  if (env.LINE_CHANNEL_ID && env.LINE_CHANNEL_SECRET) list.push("line");
  return list;
}

export const PROVIDER_ENDPOINTS = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    issuers: ["https://accounts.google.com", "accounts.google.com"],
  },
  apple: {
    authorize: "https://appleid.apple.com/auth/authorize",
    token: "https://appleid.apple.com/auth/token",
    issuers: ["https://appleid.apple.com"],
  },
  line: {
    authorize: "https://access.line.me/oauth2/v2.1/authorize",
    token: "https://api.line.me/oauth2/v2.1/token",
    issuers: ["https://access.line.me"],
  },
};

// プロバイダーごとの「クライアントID」（idトークンのaudと一致するべき値）
export function clientIdOf(provider, env) {
  if (provider === "google") return env.GOOGLE_CLIENT_ID || "";
  if (provider === "apple") return env.APPLE_SERVICES_ID || "";
  if (provider === "line") return env.LINE_CHANNEL_ID || "";
  return "";
}

/* ---------- 戻り先（return パラメータ）の検証 ---------- */

function allowedOrigins(allowed) {
  return (allowed || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// return は「ログイン後に戻るWebページのURL」か、リテラルの "app"（iOSアプリ）／"android"（Androidアプリ）。
// 許可リスト（ALLOWED_ORIGIN）にあるOriginだけを受け付ける（オープンリダイレクト対策）。
// 手元の開発用にhttp://localhostだけは通す。返り値：
//   {kind:"app"} / {kind:"android"} / {kind:"web", url:"https://…/path?query"（ハッシュ抜き）} / null（不正）
export function parseReturnTarget(value, allowed) {
  if (value === "app") return { kind: "app" };
  if (value === "android") return { kind: "android" };
  if (typeof value !== "string" || value.length === 0 || value.length > 500) return null;
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  const isLocal = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  if (u.protocol !== "https:" && !isLocal) return null;
  if (u.username || u.password) return null;
  if (!isLocal && allowedOrigins(allowed).indexOf(u.origin) === -1) return null;
  return { kind: "web", url: u.origin + u.pathname + u.search };
}

/* ---------- 乱数・ハッシュ・base64url ---------- */

export function toBase64Url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// PKCE（S256）：code_verifier のSHA-256をbase64urlにしたもの
export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

/* ---------- 認可URLの組み立て ---------- */

export function buildAuthorizeUrl(provider, env, p) {
  const ep = PROVIDER_ENDPOINTS[provider];
  const q = new URLSearchParams();
  q.set("response_type", "code");
  q.set("client_id", clientIdOf(provider, env));
  q.set("redirect_uri", p.redirectUri);
  q.set("state", p.state);
  q.set("nonce", p.nonce);
  if (provider === "google") {
    q.set("scope", "openid email profile");
    q.set("prompt", "select_account");
  } else if (provider === "apple") {
    // 名前・メールを求めるとき、Appleは response_mode=form_post（POSTで戻す）を必須にしている
    q.set("scope", "name email");
    q.set("response_mode", "form_post");
  } else if (provider === "line") {
    q.set("scope", "openid profile email");
  }
  if (provider !== "apple" && p.codeChallenge) {
    q.set("code_challenge", p.codeChallenge);
    q.set("code_challenge_method", "S256");
  }
  return ep.authorize + "?" + q.toString();
}

/* ---------- Appleのclient_secret（ES256のJWT。.p8の秘密鍵で自分で署名する） ---------- */

function pemToDer(pem) {
  const body = String(pem)
    .replace(/\\n/g, "\n") // secretに1行で入れたとき用（\nという文字が入っていても読めるように）
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function buildAppleClientSecret(env, nowSec) {
  const enc = new TextEncoder();
  const header = toBase64Url(enc.encode(JSON.stringify({ alg: "ES256", kid: env.APPLE_KEY_ID, typ: "JWT" })));
  const payload = toBase64Url(
    enc.encode(
      JSON.stringify({
        iss: env.APPLE_TEAM_ID,
        iat: nowSec,
        exp: nowSec + 300, // 使い捨てなので5分で十分
        aud: "https://appleid.apple.com",
        sub: env.APPLE_SERVICES_ID,
      })
    )
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(env.APPLE_PRIVATE_KEY),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  // WebCryptoのECDSA署名は r||s の64バイト（JWTのES256が求める形）でそのまま返る
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(header + "." + payload));
  return header + "." + payload + "." + toBase64Url(new Uint8Array(sig));
}

/* ---------- idトークンの中身の確認 ---------- */

export function decodeJwtPayload(token) {
  try {
    const part = String(token).split(".")[1];
    return JSON.parse(new TextDecoder().decode(fromBase64Url(part)));
  } catch {
    return null;
  }
}

// idトークンはプロバイダーのトークンエンドポイントからTLS（https）で直接受け取ったものなので、
// OpenID Connectの仕様上、署名の検証は省いてよい（ブラウザ経由で渡ってきたものではないため）。
// その代わり、発行元(iss)・宛先(aud)・有効期限(exp)・nonce（リプレイ対策）は必ず確かめる。
export function checkIdTokenClaims(claims, expected) {
  if (!claims || typeof claims !== "object") return { ok: false, reason: "no_claims" };
  if (expected.issuers.indexOf(claims.iss) === -1) return { ok: false, reason: "bad_iss" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (aud.indexOf(expected.audience) === -1) return { ok: false, reason: "bad_aud" };
  if (typeof claims.exp !== "number" || claims.exp < expected.nowSec) return { ok: false, reason: "expired" };
  if (!expected.nonce || claims.nonce !== expected.nonce) return { ok: false, reason: "bad_nonce" };
  if (!claims.sub || typeof claims.sub !== "string") return { ok: false, reason: "no_sub" };
  return { ok: true };
}

// idトークンの中身から、こちらが使う形（subject・メール・確認済みか・名前）にそろえる。
// Appleの名前はidトークンに入らず、初回のPOSTの user パラメータ（JSON）でだけ届く。
export function extractProfile(provider, claims, appleUserParam) {
  let email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  let verified = false;
  let name = "";
  if (provider === "google") {
    verified = claims.email_verified === true || claims.email_verified === "true";
    name = claims.name || "";
  } else if (provider === "apple") {
    verified = claims.email_verified === true || claims.email_verified === "true";
    if (appleUserParam) {
      try {
        const u = typeof appleUserParam === "string" ? JSON.parse(appleUserParam) : appleUserParam;
        name = u && u.name ? [u.name.firstName, u.name.lastName].filter(Boolean).join(" ") : "";
      } catch {
        // 名前が読めなくてもログインは続ける
      }
    }
  } else if (provider === "line") {
    // LINEのidトークンにemail_verifiedは無い。LINEが登録時に確認したメールアドレスだけが
    // emailとして返るので、あるときは確認済みとして扱う（docs/adr/0019）。
    verified = !!email;
    name = claims.name || "";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    email = "";
    verified = false;
  }
  return { subject: String(claims.sub), email, emailVerified: verified, name: String(name || "").slice(0, 100) };
}

/* ---------- 誰のアカウントに結びつけるかの判断 ---------- */

// identityEmail：auth_identitiesに既にあれば、そこに結びつけたメール（なければ空文字）
// 返り値：
//   {action:"existing", email} 以前ログインした人。前回のメールで入る
//   {action:"link", email}     初めてだが、確認済みメールがある。そのメールのアカウント（無ければ新規）に結びつける
//   {action:"pending"}         メールが分からない。メールOTPで一度だけ確認してもらう
export function decideIdentity(identityEmail, profile) {
  if (identityEmail) return { action: "existing", email: identityEmail };
  if (profile.email && profile.emailVerified) return { action: "link", email: profile.email };
  return { action: "pending" };
}

/* ---------- 「アプリに戻ってください」ページ用 ---------- */

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// アプリに戻るためのカスタムURLスキームのURL（Info.plistのCFBundleURLSchemes=tabilog。
// tabilog://open?trip=…（共有リンク）とはホスト部分（auth / open）で区別する）。
//   session → tabilog://auth?code=<使い捨てコード>
//   link    → tabilog://auth?link=<使い捨てコード>（メールの確認が必要）
//   error   → tabilog://auth?error=<理由>
export function nativeAuthUrl(kind, value) {
  const key = kind === "session" ? "code" : kind === "link" ? "link" : "error";
  return "tabilog://auth?" + key + "=" + encodeURIComponent(value || (kind === "error" ? "failed" : ""));
}

// Androidアプリ用：検証済みのhttpsのApp Link（assetlinks.json）で戻る。ChromebookのChromeなどは
// カスタムスキーム（tabilog://）をAndroidアプリに渡さないため。クエリはnativeAuthUrlと同じ
// （アプリが開かなかったときは、Pagesの/app-authページがtabilog://auth?…のボタンを出す）。
export const ANDROID_APP_LINK_BASE = "https://tabinoashiato.pages.dev/app-auth";
export function nativeAuthUrlAndroid(kind, value) {
  return ANDROID_APP_LINK_BASE + nativeAuthUrl(kind, value).slice("tabilog://auth".length);
}

// 結果を知らせるHTML。backUrlの「旅の足跡アプリに戻る」ボタンを出し、autoOpenなら開いた瞬間に
// そのURLへ移動してアプリを起動しようとする（起動できなかったときのためにボタンも残す）。
export function authMessagePage(ok, message, backUrl, autoOpen) {
  const title = ok ? "ログインできました" : "ログインできませんでした";
  return (
    '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="referrer" content="no-referrer">' +
    "<title>旅の足跡</title>" +
    "<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#F5F6F8;color:#222;margin:0;" +
    "display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}" +
    ".c{background:#fff;border-radius:16px;padding:32px 24px;max-width:340px;box-shadow:0 2px 12px rgba(0,0,0,.08)}" +
    "h1{font-size:19px;margin:0 0 10px}p{font-size:14px;line-height:1.7;margin:0 0 20px;color:#555}" +
    "a.b{display:block;background:#00BF8F;color:#fff;text-decoration:none;border-radius:14px;padding:18px 24px;font-size:18px;font-weight:700}" +
    ".s{font-size:12px;color:#888;margin:16px 0 0}" +
    '</style></head><body><div class="c"><h1>' +
    escapeHtml(title) +
    "</h1><p>" +
    escapeHtml(message) +
    '</p><a class="b" href="' +
    escapeHtml(backUrl) +
    '">旅の足跡アプリに戻る</a>' +
    (autoOpen
      ? '<p class="s">自動でアプリが開かないときは、上のボタンを押してください。</p>' +
        "<script>location.href=" +
        // </script>で閉じられないよう < をエスケープしたJSON文字列として埋め込む
        JSON.stringify(backUrl).replace(/</g, "\u003c") +
        ";</script>"
      : "") +
    "</div></body></html>"
  );
}

// アプリ用：ログインの結果をアプリに渡すページ。iOSはカスタムURLスキーム、
// Android（android=true）はApp Link（https）で戻る。
export function nativeResultPage(kind, value, android) {
  const message =
    kind === "session"
      ? "ログインできました。旅の足跡アプリに戻ってください。"
      : kind === "link"
        ? "アプリに戻って、メールアドレスの確認を続けてください。"
        : value === "cancelled"
          ? "ログインをキャンセルしました。"
          : "ログインに失敗しました。もう一度お試しください。";
  // Androidは自動で移動しない：ボタンを押したとき（ユーザーの操作）でないと、ChromeがApp Linkをアプリに渡さないことがある
  return android
    ? authMessagePage(kind !== "error", message, nativeAuthUrlAndroid(kind, value), false)
    : authMessagePage(kind !== "error", message, nativeAuthUrl(kind, value), true);
}

/* ---------- アカウント削除時のSign in with Appleトークンの取り消し ---------- */
// App Storeの規約（5.1.1(v)）とAppleの要件：Sign in with Appleで作ったアカウントを削除するときは、
// Appleのトークン取り消しAPI（POST https://appleid.apple.com/auth/revoke）でトークンを無効にする。
// 取り消すのはAppleのコールバックで受け取って保存しておいたrefresh_token（docs/adr/0019）。

export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";

// 取り消しAPIに送るフォーム本文を作る。
export function buildAppleRevokeBody(servicesId, clientSecret, refreshToken) {
  const body = new URLSearchParams();
  body.set("client_id", servicesId);
  body.set("client_secret", clientSecret);
  body.set("token", refreshToken);
  body.set("token_type_hint", "refresh_token");
  return body.toString();
}

// auth_identitiesの行のうち、取り消す対象（Appleで、refresh_tokenが空でないもの）だけを返す。
// 対応前にログインした人の行はrefresh_tokenが空なので対象外（取り消しようがない）。
export function selectAppleRevocations(identities) {
  return (identities || []).filter(
    (r) => r && r.provider === "apple" && typeof r.refresh_token === "string" && r.refresh_token !== ""
  );
}

// 対象のトークンを1件ずつ取り消す。1件の失敗（通信エラー・Appleのエラー）でも例外は投げず、
// アカウント削除を止めないために結果（{ok, failed}の件数）だけ返す。
// ネットワークとログはfetchFn・logFnとして外から渡す（テストで差し替えられるように）。
// 1件につきsubrequestは1回（Workers無料プランの50回上限に対して十分小さい）。
export async function revokeAppleTokens(identities, { servicesId, clientSecret, fetchFn, logFn }) {
  const targets = selectAppleRevocations(identities);
  let ok = 0;
  let failed = 0;
  for (const t of targets) {
    try {
      const res = await fetchFn(APPLE_REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: buildAppleRevokeBody(servicesId, clientSecret, t.refresh_token),
      });
      if (res.ok) ok++;
      else {
        failed++;
        if (logFn) logFn({ event: "apple_revoke_failed", status: res.status });
      }
    } catch (e) {
      failed++;
      if (logFn) logFn({ event: "apple_revoke_failed", status: 0, error: String((e && e.message) || "") });
    }
  }
  return { ok, failed };
}
