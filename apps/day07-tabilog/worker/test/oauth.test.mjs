/*
 * ソーシャルログインの純粋な部分（worker/src/oauth.js）の単体テスト。
 * 戻り先の検証・idトークンの確認・アカウント結びつけの判断・AppleのJWT署名などを確かめる。
 * Workers専用のグローバルを使わない（WebCryptoはnode標準）ので、nodeでそのまま実行できる。
 * 実行: node worker/test/oauth.test.mjs
 */
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  configuredProviders, parseReturnTarget, buildAuthorizeUrl, checkIdTokenClaims, extractProfile,
  decideIdentity, decodeJwtPayload, toBase64Url, fromBase64Url, pkceChallenge, buildAppleClientSecret,
  nativeResultPage, nativeAuthUrl, nativeAuthUrlAndroid, authMessagePage, PROVIDER_ENDPOINTS,
  APPLE_REVOKE_URL, buildAppleRevokeBody, selectAppleRevocations, revokeAppleTokens,
} from "../src/oauth.js";

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

const ALLOWED = "https://ainaraomakaseare-coder.github.io,https://tabinoashiato.pages.dev";

/* ---------- configuredProviders：設定がそろったものだけ ---------- */
check("何も設定していなければ空", configuredProviders({}), []);
check("Googleだけ", configuredProviders({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" }), ["google"]);
check("Googleはsecretが無いと出さない", configuredProviders({ GOOGLE_CLIENT_ID: "a" }), []);
check(
  "Apple・Google・LINEの順",
  configuredProviders({
    LINE_CHANNEL_ID: "1", LINE_CHANNEL_SECRET: "2",
    GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b",
    APPLE_SERVICES_ID: "s", APPLE_TEAM_ID: "t", APPLE_KEY_ID: "k", APPLE_PRIVATE_KEY: "p",
  }),
  ["apple", "google", "line"]
);
check("Appleは4つそろわないと出さない", configuredProviders({ APPLE_SERVICES_ID: "s", APPLE_TEAM_ID: "t", APPLE_KEY_ID: "k" }), []);

/* ---------- parseReturnTarget：戻り先の検証 ---------- */
check("app", parseReturnTarget("app", ALLOWED), { kind: "app" });
check("android", parseReturnTarget("android", ALLOWED), { kind: "android" });
check("大文字のAndroidは不可", parseReturnTarget("Android", ALLOWED), null);
check("許可Origin（パス付き）", parseReturnTarget("https://tabinoashiato.pages.dev/", ALLOWED), { kind: "web", url: "https://tabinoashiato.pages.dev/" });
check(
  "GitHub Pagesのサブパスとクエリは残す・ハッシュは落とす",
  parseReturnTarget("https://ainaraomakaseare-coder.github.io/my-app/apps/day07-tabilog/?trip=trip_1#x", ALLOWED),
  { kind: "web", url: "https://ainaraomakaseare-coder.github.io/my-app/apps/day07-tabilog/?trip=trip_1" }
);
check("許可されていないOrigin", parseReturnTarget("https://evil.example.com/", ALLOWED), null);
check("似たホスト名（前方一致のすり抜け）", parseReturnTarget("https://tabinoashiato.pages.dev.evil.com/", ALLOWED), null);
check("userinfoでのすり抜け", parseReturnTarget("https://tabinoashiato.pages.dev@evil.com/", ALLOWED), null);
check("httpは不可（localhost以外）", parseReturnTarget("http://tabinoashiato.pages.dev/", ALLOWED), null);
check("localhostは開発用に可", parseReturnTarget("http://localhost:8080/index.html", ALLOWED), { kind: "web", url: "http://localhost:8080/index.html" });
check("javascript:スキーム", parseReturnTarget("javascript:alert(1)", ALLOWED), null);
check("空・未指定", parseReturnTarget("", ALLOWED), null);
check("undefined", parseReturnTarget(undefined, ALLOWED), null);
check("長すぎる", parseReturnTarget("https://tabinoashiato.pages.dev/" + "a".repeat(600), ALLOWED), null);

/* ---------- buildAuthorizeUrl ---------- */
{
  const p = { redirectUri: "https://api.example/auth/google/callback", state: "S", nonce: "N", codeChallenge: "C" };
  const g = new URL(buildAuthorizeUrl("google", { GOOGLE_CLIENT_ID: "gid" }, p));
  check("google: ホスト", g.origin + g.pathname, PROVIDER_ENDPOINTS.google.authorize);
  check("google: client_id", g.searchParams.get("client_id"), "gid");
  check("google: scope", g.searchParams.get("scope"), "openid email profile");
  check("google: PKCE", [g.searchParams.get("code_challenge"), g.searchParams.get("code_challenge_method")], ["C", "S256"]);
  check("google: state/nonce", [g.searchParams.get("state"), g.searchParams.get("nonce")], ["S", "N"]);
  const a = new URL(buildAuthorizeUrl("apple", { APPLE_SERVICES_ID: "com.x.web" }, p));
  check("apple: form_post", a.searchParams.get("response_mode"), "form_post");
  check("apple: scope", a.searchParams.get("scope"), "name email");
  check("apple: PKCEは付けない", a.searchParams.get("code_challenge"), null);
  const l = new URL(buildAuthorizeUrl("line", { LINE_CHANNEL_ID: "123" }, p));
  check("line: scope", l.searchParams.get("scope"), "openid profile email");
  check("line: ホスト", l.origin, "https://access.line.me");
}

/* ---------- checkIdTokenClaims ---------- */
{
  const now = 1_800_000_000;
  const base = { iss: "https://accounts.google.com", aud: "gid", exp: now + 600, nonce: "N", sub: "123" };
  const exp = { issuers: PROVIDER_ENDPOINTS.google.issuers, audience: "gid", nonce: "N", nowSec: now };
  check("正しいトークン", checkIdTokenClaims(base, exp), { ok: true });
  check("issがaccounts.google.com（httpsなし）でも可", checkIdTokenClaims({ ...base, iss: "accounts.google.com" }, exp), { ok: true });
  check("audが配列でも可", checkIdTokenClaims({ ...base, aud: ["x", "gid"] }, exp), { ok: true });
  check("issが違う", checkIdTokenClaims({ ...base, iss: "https://evil.example" }, exp), { ok: false, reason: "bad_iss" });
  check("audが違う（他のアプリ宛て）", checkIdTokenClaims({ ...base, aud: "other" }, exp), { ok: false, reason: "bad_aud" });
  check("期限切れ", checkIdTokenClaims({ ...base, exp: now - 1 }, exp), { ok: false, reason: "expired" });
  check("expが無い", checkIdTokenClaims({ ...base, exp: undefined }, exp), { ok: false, reason: "expired" });
  check("nonceが違う", checkIdTokenClaims({ ...base, nonce: "X" }, exp), { ok: false, reason: "bad_nonce" });
  check("nonceが無い", checkIdTokenClaims({ ...base, nonce: undefined }, exp), { ok: false, reason: "bad_nonce" });
  check("期待するnonceが空", checkIdTokenClaims({ ...base, nonce: "" }, { ...exp, nonce: "" }), { ok: false, reason: "bad_nonce" });
  check("subが無い", checkIdTokenClaims({ ...base, sub: undefined }, exp), { ok: false, reason: "no_sub" });
  check("claimsがnull", checkIdTokenClaims(null, exp), { ok: false, reason: "no_claims" });
}

/* ---------- extractProfile ---------- */
check(
  "google: 確認済みメール",
  extractProfile("google", { sub: "1", email: "A@Example.com", email_verified: true, name: "花子" }),
  { subject: "1", email: "a@example.com", emailVerified: true, name: "花子" }
);
check(
  "google: 未確認メールは確認済み扱いにしない",
  extractProfile("google", { sub: "1", email: "a@example.com", email_verified: false }).emailVerified,
  false
);
check(
  "apple: email_verifiedが文字列'true'",
  extractProfile("apple", { sub: "2", email: "x@privaterelay.appleid.com", email_verified: "true" }).emailVerified,
  true
);
check(
  "apple: 名前は初回のuserパラメータから",
  extractProfile("apple", { sub: "2", email: "x@y.com", email_verified: true }, JSON.stringify({ name: { firstName: "太郎", lastName: "山田" } })).name,
  "太郎 山田"
);
check("apple: userパラメータが壊れていても続行", extractProfile("apple", { sub: "2" }, "{bad").name, "");
check("line: メールなし", extractProfile("line", { sub: "U1", name: "たろう" }), { subject: "U1", email: "", emailVerified: false, name: "たろう" });
check("line: メールありは確認済み扱い", extractProfile("line", { sub: "U1", email: "t@e.com" }).emailVerified, true);
check("メールの形が変なら空にする", extractProfile("google", { sub: "1", email: "not-an-email", email_verified: true }).email, "");

/* ---------- decideIdentity：誰のアカウントに結びつけるか ---------- */
check(
  "以前ログイン済み → 前回のメール（今回のメールが違っても前回を優先）",
  decideIdentity("old@e.com", { email: "new@e.com", emailVerified: true }),
  { action: "existing", email: "old@e.com" }
);
check("初回・確認済みメールあり → そのメールに結びつける", decideIdentity("", { email: "a@e.com", emailVerified: true }), { action: "link", email: "a@e.com" });
check("初回・メールはあるが未確認 → メールOTPへ", decideIdentity("", { email: "a@e.com", emailVerified: false }), { action: "pending" });
check("初回・メールなし → メールOTPへ", decideIdentity("", { email: "", emailVerified: false }), { action: "pending" });

/* ---------- base64url・JWT ---------- */
check("base64url往復", new TextDecoder().decode(fromBase64Url(toBase64Url(new TextEncoder().encode("旅の足跡?>>")))), "旅の足跡?>>");
{
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ name: "清水", sub: "1" })));
  check("JWTのpayloadを日本語込みで読める", decodeJwtPayload("h." + payload + ".s"), { name: "清水", sub: "1" });
  check("壊れたJWTはnull", decodeJwtPayload("not-a-jwt"), null);
}

/* ---------- PKCE（RFC 7636 付録Bのテストベクター） ---------- */
check(
  "PKCE S256",
  await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
  "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
);

/* ---------- AppleのclientSecret（ES256のJWT）：署名を公開鍵で検証できる ---------- */
{
  const { publicKey, privateKey } = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const der = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", privateKey)).toString("base64");
  const pem = "-----BEGIN PRIVATE KEY-----\n" + der.match(/.{1,64}/g).join("\n") + "\n-----END PRIVATE KEY-----\n";
  const env = { APPLE_KEY_ID: "KID123", APPLE_TEAM_ID: "TEAM123", APPLE_SERVICES_ID: "com.example.web", APPLE_PRIVATE_KEY: pem };
  const jwt = await buildAppleClientSecret(env, 1_800_000_000);
  const [h, p, s] = jwt.split(".");
  check("apple secret: header", JSON.parse(new TextDecoder().decode(fromBase64Url(h))), { alg: "ES256", kid: "KID123", typ: "JWT" });
  check("apple secret: payload", JSON.parse(new TextDecoder().decode(fromBase64Url(p))), {
    iss: "TEAM123", iat: 1_800_000_000, exp: 1_800_000_300, aud: "https://appleid.apple.com", sub: "com.example.web",
  });
  const ok = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, publicKey, fromBase64Url(s), new TextEncoder().encode(h + "." + p)
  );
  check("apple secret: 署名が正しい", ok, true);
  check("apple secret: 署名は64バイト（r||s）", fromBase64Url(s).length, 64);
  // 1行に\nという文字で入れたsecretでも読める
  const oneLine = await buildAppleClientSecret({ ...env, APPLE_PRIVATE_KEY: pem.trim().split("\n").join("\\n") }, 1_800_000_000);
  check("apple secret: \\n入りの1行secretでも署名できる", oneLine.split(".").length, 3);
}

/* ---------- nativeAuthUrl / nativeResultPage / authMessagePage ---------- */
{
  const code = "a".repeat(64);
  check("session URL", nativeAuthUrl("session", code), "tabilog://auth?code=" + code);
  check("link URL", nativeAuthUrl("link", code), "tabilog://auth?link=" + code);
  check("error URL", nativeAuthUrl("error", "cancelled"), "tabilog://auth?error=cancelled");
  check("error URLは空なら failed", nativeAuthUrl("error", ""), "tabilog://auth?error=failed");
  check("値はURLエンコードされる", nativeAuthUrl("error", "a&b=c#d"), "tabilog://auth?error=a%26b%3Dc%23d");
  check("openと衝突しない", nativeAuthUrl("session", code).startsWith("tabilog://open"), false);

  const ok = nativeResultPage("session", code);
  check("成功ページ：すぐアプリを開く", ok.includes('location.href="tabilog://auth?code=' + code + '"'), true);
  check("成功ページ：大きな戻るボタン", ok.includes('class="b" href="tabilog://auth?code=' + code + '">旅の足跡アプリに戻る</a>'), true);
  check("成功ページ：フォールバック文言", ok.includes("自動でアプリが開かないとき"), true);
  check("linkページ", nativeResultPage("link", code).includes("tabilog://auth?link=" + code), true);
  const err = nativeResultPage("error", "cancelled");
  check("エラーページ", [err.includes("tabilog://auth?error=cancelled"), err.includes("キャンセル")], [true, true]);

  // Android：検証済みhttpsのApp Linkで戻る（iOSのページは上のとおり変わらない）
  const AB = "https://tabinoashiato.pages.dev/app-auth?";
  check("android session URL", nativeAuthUrlAndroid("session", code), AB + "code=" + code);
  check("android link URL", nativeAuthUrlAndroid("link", code), AB + "link=" + code);
  check("android error URL", nativeAuthUrlAndroid("error", "cancelled"), AB + "error=cancelled");
  check("android error URLは空なら failed", nativeAuthUrlAndroid("error", ""), AB + "error=failed");
  check("android 値はURLエンコードされる", nativeAuthUrlAndroid("error", "a&b=c#d"), AB + "error=a%26b%3Dc%23d");
  const aok = nativeResultPage("session", code, true);
  check("androidページ：自動では移動しない（ボタンを押してApp Linkで開く）", aok.includes("location.href="), false);
  check("androidページ：戻るボタン", aok.includes('class="b" href="' + AB + 'code=' + code + '">旅の足跡アプリに戻る</a>'), true);
  check("androidページ：tabilog://を含まない", aok.includes("tabilog://"), false);
  check("iOSページはandroid引数なしと同一", nativeResultPage("session", code, false), ok);

  // 想定外の値でもHTML/スクリプトを壊せない
  const evil = nativeResultPage("error", '"></a><script>alert(1)</script>');
  check("エスケープ：scriptタグが増えない", (evil.match(/<script>/g) || []).length, 1);
  check("エスケープ：生の値が出ない", evil.includes("alert(1)</script>"), false);

  const plain = authMessagePage(true, "ログインできました", 'https://x.example/"><script>', false);
  check("戻るリンクをエスケープする", plain.includes("<script>"), false);
  check("自動遷移なしならscriptなし", plain.includes("location.href"), false);
  check("戻るボタン", plain.includes("旅の足跡アプリに戻る"), true);
}


console.log(`\noauth.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
