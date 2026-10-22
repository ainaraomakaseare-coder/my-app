/*
 * 写真から旅程を作る（docs/adr/0026）の GET /places/nearby を、Workerの入口（fetch）から確かめる。
 * fetchはモック（Google Nearby Search・Nominatimへの呼び出しを記録して、決まった答えを返す）。
 * 実行: node worker/test/places-nearby.test.mjs
 */
import assert from "node:assert/strict";
import worker from "../src/index.js";

let pass = 0, fail = 0;
function check(label, got, want) {
  try { assert.deepEqual(got, want); pass++; } catch {
    fail++;
    console.log("NG  " + label + "\n    got  " + JSON.stringify(got) + "\n    want " + JSON.stringify(want));
  }
}

const calls = [];
let googleAnswer = null, nominatimAnswer = null;
globalThis.fetch = async (input, init) => {
  const u = String(input && input.url ? input.url : input);
  calls.push({ url: u, body: init && init.body ? JSON.parse(init.body) : null, headers: (init && init.headers) || {} });
  if (u.indexOf("places.googleapis.com/v1/places:searchNearby") >= 0) {
    if (!googleAnswer) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify(googleAnswer), { status: 200 });
  }
  if (u.indexOf("nominatim.openstreetmap.org/reverse") >= 0) return new Response(JSON.stringify(nominatimAnswer || {}), { status: 200 });
  return new Response("{}", { status: 404 });
};

const DB = { prepare() { const o = { bind() { return o; }, async first() { return null; }, async all() { return { results: [] }; }, async run() { return {}; } }; return o; }, async batch() { return []; } };
const ctx = { waitUntil() {}, passThroughOnException() {} };
async function get(path, env) {
  const res = await worker.fetch(new Request("https://api.example" + path, { headers: { origin: "https://x" } }), { ALLOWED_ORIGIN: "https://x", ...env }, ctx);
  return { status: res.status, body: await res.json() };
}

// Googleのキーがあるとき：近く150mで知名度順の1件目の名前と種類を返す
googleAnswer = { places: [{ displayName: { text: "清水寺" }, types: ["buddhist_temple", "tourist_attraction"] }, { displayName: { text: "茶屋" }, types: ["cafe"] }] };
calls.length = 0;
let r = await get("/places/nearby?lat=34.994856&lng=135.785046&lang=ja", { DB, GOOGLE_API_KEY: "k" });
check("Google: 1件目の名前", r, { status: 200, body: { found: true, name: "清水寺", types: ["buddhist_temple", "tourist_attraction"] } });
check("Google: 半径150m・知名度順・日本語", calls[0] && calls[0].body && { r: calls[0].body.locationRestriction.circle.radius, rank: calls[0].body.rankPreference, lang: calls[0].body.languageCode }, { r: 150, rank: "POPULARITY", lang: "ja" });
check("Google: 名前と種類だけ聞く", calls[0] && calls[0].headers["X-Goog-FieldMask"], "places.displayName,places.types");

// 繁体字は zh-TW で聞く
calls.length = 0;
await get("/places/nearby?lat=25.0339&lng=121.5645&lang=zh-Hant", { DB, GOOGLE_API_KEY: "k" });
check("Google: 繁体字はzh-TW", calls[0] && calls[0].body.languageCode, "zh-TW");

// Googleが失敗したら Nominatim（施設の名前）
googleAnswer = null;
nominatimAnswer = { name: "伏見稲荷大社", category: "amenity", type: "place_of_worship", address: { city: "京都市" } };
r = await get("/places/nearby?lat=34.967&lng=135.7727&lang=ja", { DB, GOOGLE_API_KEY: "k" });
check("Googleの失敗→Nominatimの名前", r.body, { found: true, name: "伏見稲荷大社", types: [] });

// キーが無いときも Nominatim。名前が無ければ地区の名前、飲食店は種類をrestaurantにする
calls.length = 0;
nominatimAnswer = { name: "", category: "highway", type: "residential", address: { suburb: "祇園", city: "京都市" } };
r = await get("/places/nearby?lat=35.0037&lng=135.7788", { DB });
check("キー無し→Nominatimの地区名", r.body, { found: true, name: "祇園", types: [] });
check("キー無し→Googleは呼ばない", calls.filter((c) => c.url.indexOf("googleapis") >= 0).length, 0);
nominatimAnswer = { name: "一蘭", category: "amenity", type: "restaurant", address: {} };
r = await get("/places/nearby?lat=35.0037&lng=135.7788", { DB });
check("Nominatimの飲食店", r.body, { found: true, name: "一蘭", types: ["restaurant"] });

// 何も見つからない・座標が不正
nominatimAnswer = {};
r = await get("/places/nearby?lat=10&lng=10", { DB });
check("見つからない", r.body, { found: false });
r = await get("/places/nearby?lat=abc&lng=10", { DB });
check("座標が不正", r.status, 400);
r = await get("/places/nearby?lat=0&lng=0", { DB });
check("0,0は使わない", r.status, 400);

// 呼びすぎ（WRITE_RATE_LIMITERで断る）
r = await get("/places/nearby?lat=35&lng=135", { DB, WRITE_RATE_LIMITER: { async limit() { return { success: false }; } } });
check("呼びすぎ", r.status, 429);

console.log(pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
