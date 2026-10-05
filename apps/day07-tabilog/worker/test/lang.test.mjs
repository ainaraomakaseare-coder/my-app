/*
 * AIの出力言語（繁体字中国語・台湾対応）の単体テスト＋Workerの入口からの通しテスト。
 * Accept-Language（またはリクエストJSONのlang）で zh-Hant の指示がプロンプトに付くこと、
 * 日本語（既定）のプロンプトは従来から変わらないことを確かめる。OpenAI・Googleはモック。
 * 実行: node worker/test/lang.test.mjs
 */
import assert from "node:assert/strict";
import { detectLang, langDirective } from "../src/lang.js";
import { buildProposalPrompt } from "../src/import-proposals.js";
import { buildScreenshotPrompt } from "../src/screenshot-import.js";
import worker from "../src/index.js";

let pass = 0, fail = 0;
function check(label, got, want) {
  try { assert.deepEqual(got, want); pass++; }
  catch { fail++; console.log("NG  " + label + "\n    got  " + JSON.stringify(got) + "\n    want " + JSON.stringify(want)); }
}
const req = (al) => new Request("https://api/x", { headers: al ? { "accept-language": al } : {} });

// detectLang
check("lang: ヘッダ無しはja", detectLang(req("")), "ja");
check("lang: ja-JPはja", detectLang(req("ja-JP,ja;q=0.9")), "ja");
check("lang: zh-TW先頭はzh-Hant", detectLang(req("zh-TW,zh;q=0.9,en;q=0.8")), "zh-Hant");
check("lang: zh-Hant-TWはzh-Hant", detectLang(req("zh-Hant-TW")), "zh-Hant");
check("lang: zh-HKはzh-Hant", detectLang(req("zh-HK")), "zh-Hant");
check("lang: 簡体zh-CNはen（日本語・繁体字以外は英語）", detectLang(req("zh-CN,zh;q=0.9")), "en");
check("lang: en-USはen", detectLang(req("en-US,en;q=0.9")), "en");
check("lang: fr-FRはen", detectLang(req("fr-FR")), "en");
check("lang: *はja", detectLang(req("*")), "ja");
check("lang: 本文のlang=enが優先", detectLang(req("ja-JP"), { lang: "en" }), "en");
check("lang: 本文のlang=jaがen headerに優先", detectLang(req("en-US"), { lang: "ja" }), "ja");
check("lang: 先頭がjaならzhが後ろでもja", detectLang(req("ja,zh-TW;q=0.8")), "ja");
check("lang: 本文のlang=zh-Hantが優先", detectLang(req("ja-JP"), { lang: "zh-Hant" }), "zh-Hant");
check("lang: 本文のlang=jaが優先", detectLang(req("zh-TW"), { lang: "ja" }), "ja");
check("lang: 本文にlangが無ければヘッダ", detectLang(req("zh-TW"), { text: "x" }, null), "zh-Hant");

// プロンプト：jaは変わらない
const dates = ["2026-10-03", "2026-10-04"];
const base = buildProposalPrompt({ kind: "memo", text: "メモ", notes: "", dates });
check("prompt(提案): ja指定は未指定と同一", buildProposalPrompt({ kind: "memo", text: "メモ", notes: "", dates, lang: "ja" }), base);
check("prompt(提案): jaに指示が混ざらない", base.includes("OUTPUT LANGUAGE"), false);
const zh = buildProposalPrompt({ kind: "memo", text: "メモ", notes: "", dates, lang: "zh-Hant" });
check("prompt(提案): zh-Hantは日本語版の先頭部分をそのまま含み末尾に指示", [zh.startsWith(base), zh === base + langDirective("zh-Hant"), zh.includes("Traditional Chinese")], [true, true, true]);
check("prompt(提案): enum・通貨コードは変えない指示", zh.includes("category, transport, currency"), true);
const ocr = [{ index: 0, text: "JAL903 羽田" }];
const sBase = buildScreenshotPrompt(ocr, { startDate: "2026-10-03", endDate: "2026-10-05" });
check("prompt(スクショ): ja指定は未指定と同一・指示なし", [buildScreenshotPrompt(ocr, { startDate: "2026-10-03", endDate: "2026-10-05" }, "ja") === sBase, sBase.includes("OUTPUT LANGUAGE")], [true, false]);
check("prompt(スクショ): zh-Hantは末尾に指示", buildScreenshotPrompt(ocr, { startDate: "2026-10-03", endDate: "2026-10-05" }, "zh-Hant") === sBase + langDirective("zh-Hant"), true);
check("directive: jaは空文字", langDirective("ja"), "");
const en = buildProposalPrompt({ kind: "memo", text: "メモ", notes: "", dates, lang: "en" });
check("prompt(提案): enは日本語版＋英語の指示", [en === base + langDirective("en"), en.includes("natural English"), en.includes("Traditional Chinese")], [true, true, false]);
check("prompt(スクショ): enは末尾に指示", buildScreenshotPrompt(ocr, { startDate: "2026-10-03", endDate: "2026-10-05" }, "en") === sBase + langDirective("en"), true);
check("directive: enはenum・通貨コードを変えない指示", langDirective("en").includes("category, transport, currency"), true);

// 入口から通し：メモ（複数日）とスクショで、OpenAIに渡る入力を確かめる
const period = new Date().toISOString().slice(0, 7) + "-01";
function makeEnv() {
  const mk = (sql) => ({
    sql, args: [],
    bind(...a) { this.args = a; return this; },
    async first() {
      if (/FROM trips/.test(sql)) return { start_date: "2026-10-03", end_date: "2026-10-05", id: "trip_1" };
      if (/FROM accounts/.test(sql)) return { email: "a@b.c", plan: "free", plan_period_start: period, voice_uses_this_period: 0, memo_uses_this_period: 0, ticket_credits: 0 };
      return null;
    },
    async all() { return { results: [] }; },
    async run() { return {}; },
  });
  return { DB: { prepare: mk, async batch() { return []; } }, OPENAI_API_KEY: "test", GOOGLE_API_KEY: "test", ALLOWED_ORIGIN: "https://x" };
}
const ctx = { waitUntil() {} };
async function openAiInputFor(request) {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("api.openai.com")) { sent.push(JSON.parse(init.body).input); return new Response(JSON.stringify({ status: "completed", output_text: JSON.stringify({ items: [], unreadableImages: [] }) })); }
    if (u.includes("vision.googleapis.com")) return new Response(JSON.stringify({ responses: [{ fullTextAnnotation: { text: "JAL903 羽田 09:30" } }] }));
    return new Response("{}", { status: 404 });
  };
  await worker.fetch(request, makeEnv(), ctx);
  return sent[0];
}
const memoReq = (al) => new Request("https://api/trips/trip_1/text-scan", {
  method: "POST", headers: { "content-type": "application/json", origin: "https://x", ...(al ? { "accept-language": al } : {}) },
  body: JSON.stringify({ email: "a@b.c", text: "10時に淺草寺", date: "2026-10-03" }),
});
const scanReq = (al) => new Request("https://api/trips/trip_1/screenshot-scan", {
  method: "POST", headers: { "content-type": "application/json", origin: "https://x", ...(al ? { "accept-language": al } : {}) },
  body: JSON.stringify({ email: "a@b.c", images: [{ type: "image/jpeg", data: "QUJD" }] }),
});
{
  const ja = await openAiInputFor(scanReq("ja-JP"));
  const zhIn = await openAiInputFor(scanReq("zh-TW"));
  check("通し(スクショ): jaに指示なし", typeof ja === "string" && !ja.includes("OUTPUT LANGUAGE"), true);
  check("通し(スクショ): zh-TWに指示あり", typeof zhIn === "string" && zhIn.includes("OUTPUT LANGUAGE") && zhIn.startsWith(ja.slice(0, 200)), true);
}
{
  const ja = await openAiInputFor(memoReq(""));
  const zhIn = await openAiInputFor(memoReq("zh-TW,zh;q=0.9"));
  check("通し(メモ取り込み): ja/zhとも入力が取れる", [typeof ja, typeof zhIn], ["string", "string"]);
  if (typeof ja === "string" && typeof zhIn === "string") {
    check("通し(メモ取り込み): jaに指示なし", ja.includes("OUTPUT LANGUAGE"), false);
    check("通し(メモ取り込み): zh-TWはjaの入力＋指示", zhIn === ja + langDirective("zh-Hant"), true);
  }
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
