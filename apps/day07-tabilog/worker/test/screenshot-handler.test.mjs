/*
 * スクショから予定を作る（docs/adr/0022）のエンドポイントを、Workerの入口（fetch）から通しで確かめる。
 * D1・Cloud Vision・OpenAI・Google Placesはすべてモック（有料APIは呼ばない）。
 * サブリクエスト（fetchの回数）とD1のアクセス回数、回数の消費、保存のバッチを確かめる。
 * 実行: node worker/test/screenshot-handler.test.mjs
 */
import assert from "node:assert/strict";
import worker from "../src/index.js";

let pass = 0, fail = 0;
function check(label, got, want) {
  try { assert.deepEqual(got, want); pass++; }
  catch { fail++; console.log("NG  " + label + "\n    got  " + JSON.stringify(got) + "\n    want " + JSON.stringify(want)); }
}

const period = new Date().toISOString().slice(0, 7) + "-01";
function makeEnv(account) {
  const log = { queries: [], batches: [] };
  const mk = (sql) => ({
    sql, args: [],
    bind(...a) { this.args = a; return this; },
    async first() {
      log.queries.push(sql);
      if (/FROM trips/.test(sql)) return { start_date: "2026-10-03", end_date: "2026-10-05" };
      if (/FROM accounts/.test(sql)) return account;
      return null;
    },
    async run() { log.queries.push(sql); return {}; },
  });
  return { log, env: { DB: { prepare: mk, async batch(st) { log.batches.push(st.map((s) => s.sql)); } }, OPENAI_API_KEY: "test", GOOGLE_API_KEY: "test", ALLOWED_ORIGIN: "https://x" } };
}

const AI = {
  items: [
    { image: 1, category: "transport", transport: "plane", date: "--10-03", time: "", label: "羽田→那覇 JAL903", routeNumber: "JAL903", company: "日本航空", fromPlace: "羽田空港", toPlace: "那覇空港", departTime: "09:30", arriveTime: "12:05", arriveDate: "--10-03", place: "", placeGuessed: false, checkOutDate: "", costItems: [{ label: "運賃", amount: 18700, currency: "" }], note: "" },
    { image: 2, category: "lodging", transport: "", date: "--10-03", time: "", label: "ホテルA", routeNumber: "", company: "", fromPlace: "", toPlace: "", departTime: "", arriveTime: "", arriveDate: "", place: "ホテルA", placeGuessed: false, checkOutDate: "--10-04", costItems: [], note: "" },
  ],
  unreadableImages: [],
};

function mockFetch(fetched, opts) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    fetched.push(u.split("?")[0]);
    if (u.includes("vision.googleapis.com")) return new Response(JSON.stringify(opts.vision || { responses: [{ fullTextAnnotation: { text: "JAL903 羽田 09:30" } }, { fullTextAnnotation: { text: "ホテルA" } }, {}] }), { status: opts.visionStatus || 200 });
    if (u.includes("api.openai.com")) return new Response(JSON.stringify({ status: "completed", output_text: JSON.stringify(opts.ai || AI) }));
    if (u.includes("places:searchText")) return new Response(JSON.stringify({ places: [{ displayName: { text: "場所" }, formattedAddress: "住所", location: { latitude: 35, longitude: 139 } }] }));
    return new Response("{}", { status: 404 });
  };
}

function scanRequest(images) {
  return new Request("https://api/trips/trip_1/screenshot-scan", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://x" },
    body: JSON.stringify({ email: "a@b.c", images }),
  });
}
function saveRequest(items) {
  return new Request("https://api/trips/trip_1/screenshot-blocks", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://x" },
    body: JSON.stringify({ author: "t", items }),
  });
}
const img = { type: "image/jpeg", data: "QUJD" };
const ctx = { waitUntil() {} };
const freshAccount = () => ({ email: "a@b.c", plan: "free", plan_period_start: period, voice_uses_this_period: 0, memo_uses_this_period: 0, ticket_credits: 0 });
const CONSUME = /memo_uses_this_period = memo_uses_this_period \+ 1/;

// 正常：Vision1回・OpenAI1回・場所3回（羽田・那覇・ホテルA）
{
  const { env, log } = makeEnv(freshAccount());
  const fetched = [];
  mockFetch(fetched, {});
  const res = await worker.fetch(scanRequest([img, img, img]), env, ctx);
  const j = await res.json();
  check("scan: 200", res.status, 200);
  check("scan: 移動1件＋宿1泊で2件", j.items.length, 2);
  check("scan: サブリクエストはVision1・OpenAI1・場所3", fetched.map((u) => u.split("/")[2]), ["vision.googleapis.com", "api.openai.com", "places.googleapis.com", "places.googleapis.com", "places.googleapis.com"]);
  check("scan: 画像3枚目（文字なし）は読み取れなかった画像", j.unreadable.map((u) => [u.image, u.reason]), [[2, "no_text"]]);
  check("scan: 地図が付く", [j.items[0].mapLat, j.items[0].arriveLat], [35, 35]);
  check("scan: メモのAI整理の枠を1回消費", log.queries.some((s) => CONSUME.test(s)), true);
  check("scan: D1のアクセスは見積もり（10回）以内", log.queries.length <= 10, true);
  check("scan: 使用量に見積もりを返す", [j.usage.images, j.usage.placeLookups, j.usage.subrequests.ok], [3, 3, true]);
}

// 全部読めない：OpenAIも場所検索も呼ばず、枠も消費しない
{
  const { env, log } = makeEnv(freshAccount());
  const fetched = [];
  mockFetch(fetched, { vision: { responses: [{}, { error: { code: 3 } }] } });
  const res = await worker.fetch(scanRequest([img, img]), env, ctx);
  const j = await res.json();
  check("全部読めない: 200で候補0件", [res.status, j.items.length, j.unreadable.length], [200, 0, 2]);
  check("全部読めない: Visionだけ呼ぶ", fetched.length, 1);
  check("全部読めない: 枠を消費しない", log.queries.some((s) => CONSUME.test(s)), false);
}

// 枠を使い切っていれば、外部APIを呼ぶ前に403
{
  const { env } = makeEnv({ ...freshAccount(), memo_uses_this_period: 10 });
  const fetched = [];
  mockFetch(fetched, {});
  const res = await worker.fetch(scanRequest([img]), env, ctx);
  check("枠切れ: 403 quota_exceeded（有料プランへの案内は返さない）", [res.status, (await res.json()).error], [403, "quota_exceeded"]);
  check("枠切れ: 外部APIを呼ばない", fetched.length, 0);
}

// 入力の検証：11枚・空・APIキー無し・Visionの失敗
{
  const { env } = makeEnv(freshAccount());
  const fetched = [];
  mockFetch(fetched, {});
  const many = await worker.fetch(scanRequest(Array.from({ length: 11 }, () => img)), env, ctx);
  check("11枚は400 too_many_images", [many.status, (await many.json()).error], [400, "too_many_images"]);
  const none = await worker.fetch(scanRequest([]), env, ctx);
  check("0枚は400 invalid_input", [none.status, (await none.json()).error], [400, "invalid_input"]);
  const noKey = await worker.fetch(scanRequest([img]), { ...env, GOOGLE_API_KEY: "" }, ctx);
  check("Googleのキーが無ければ503", noKey.status, 503);
  check("ここまで外部APIは呼ばない", fetched.length, 0);
  mockFetch(fetched, { visionStatus: 500 });
  const vf = await worker.fetch(scanRequest([img]), makeEnv(freshAccount()).env, ctx);
  check("Vision失敗は502 vision_failed", [vf.status, (await vf.json()).error], [502, "vision_failed"]);
}

// 保存：予定と記録を1つのバッチで
{
  const { env, log } = makeEnv(freshAccount());
  const res = await worker.fetch(saveRequest([
    { date: "2026-10-03", time: "09:30", label: "羽田→那覇", category: "transport", transport: "plane", mapUrl: "https://www.google.com/maps/search/?api=1&query=1%2C2", mapPlaceName: "羽田", mapLat: 1, mapLng: 2, from: "a", to: "b", depart: "09:30", arrive: "12:00", costItems: [{ label: "運賃", amount: 100 }] },
    { date: "2026-10-04", label: "夕食", category: "food" },
    { date: "2026-12-25", label: "日程の外", category: "food" },
  ]), env, ctx);
  const j = await res.json();
  check("save: 200・日程の外の1件はエラーで返す", [res.status, j.blocks.length, j.errors], [200, 2, [{ index: 2, reason: "date_out_of_range" }]]);
  check("save: 1回のバッチに予定2＋記録1（中身が無い予定には空の記録を作らない）", [log.batches.length, log.batches[0].length], [1, 3]);
  check("save: 中身のある予定は記録1件・中身が無い予定は記録0件", [j.blocks[0].entries.length, j.blocks[1].entries.length], [1, 0]);
  check("save: 座標つきで返る", [j.blocks[0].entries[0].mapLat, j.blocks[0].entries[0].travel.from], [1, "a"]);
  const empty = await worker.fetch(saveRequest([]), env, ctx);
  check("save: 空は400", empty.status, 400);
  const allBad = await worker.fetch(saveRequest([{ date: "2027-01-01", label: "x", category: "food" }]), env, ctx);
  check("save: 全部不正なら400 invalid_input", [allBad.status, (await allBad.json()).error], [400, "invalid_input"]);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
