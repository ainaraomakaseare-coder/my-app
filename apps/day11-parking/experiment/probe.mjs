/*
 * 駐車場料金の読み取り検証スクリプト（アプリ本体を作る前の実験用）。
 *
 * 1. Places API (New) の Nearby Search で、指定地点の周りの駐車場を探す
 * 2. 各駐車場の Googleマップ投稿写真を数枚取ってくる
 * 3. 写真をまとめて Claude に見せ、料金看板が写っていれば料金を読み取らせる
 * 4. 「何件中何件読めたか」と、写真つきの確認用レポート（HTML）を出す
 *
 * 写真は Google の規約上、保存・再配布しないのが安全なので、結果は results/ に
 * 書き出すだけで Git には入れない（.gitignore 済み）。
 *
 * 使い方:
 *   GOOGLE_MAPS_API_KEY=... ANTHROPIC_API_KEY=... node probe.mjs \
 *     --lat 36.3706 --lng 140.4762 --radius 800 --max 20 --photos 4
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith("--")) pairs.push([arg.slice(2), all[i + 1]]);
    return pairs;
  }, [])
);

const LAT = Number(args.lat ?? 36.3706); // 既定は水戸駅
const LNG = Number(args.lng ?? 140.4762);
const RADIUS = Number(args.radius ?? 800);
const MAX_PLACES = Math.min(Number(args.max ?? 20), 20); // Nearby Search は最大20件
const PHOTOS_PER_PLACE = Number(args.photos ?? 4);
const MODEL = args.model ?? "claude-sonnet-5";
const LABEL = args.label ?? `${LAT},${LNG}`;

const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || process.env.POIMAMO_ANTHROPIC_API_KEY;
if (!GOOGLE_KEY || !ANTHROPIC_KEY) {
  console.error("GOOGLE_MAPS_API_KEY と ANTHROPIC_API_KEY を環境変数に設定してください");
  process.exit(1);
}

const usage = { nearbySearch: 0, photos: 0, inputTokens: 0, outputTokens: 0 };

async function searchParking() {
  usage.nearbySearch++;
  const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_KEY,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.photos,places.googleMapsUri",
    },
    body: JSON.stringify({
      includedTypes: ["parking"],
      maxResultCount: MAX_PLACES,
      rankPreference: "DISTANCE",
      languageCode: "ja",
      locationRestriction: { circle: { center: { latitude: LAT, longitude: LNG }, radius: RADIUS } },
    }),
  });
  if (!res.ok) throw new Error(`Nearby Search ${res.status}: ${await res.text()}`);
  return (await res.json()).places ?? [];
}

async function fetchPhoto(photo) {
  usage.photos++;
  const url = `https://places.googleapis.com/v1/${photo.name}/media?maxWidthPx=1568&key=${GOOGLE_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Photo ${res.status}: ${await res.text()}`);
  const mediaType = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
  const data = Buffer.from(await res.arrayBuffer()).toString("base64");
  const author = photo.authorAttributions?.map((a) => a.displayName).join(", ") ?? "";
  return { mediaType, data, author };
}

const PROMPT = `これは日本のコインパーキング（時間貸し駐車場）について、Googleマップに投稿された写真です（${"{n}"}枚、0番から順に番号付け）。
料金看板が写っている写真を探し、料金体系を読み取ってください。

次のJSONだけを返してください（説明文やコードブロック記号は不要）:
{
  "found": 料金が読み取れたら true、看板が写っていない・読めないなら false,
  "photoIndex": 料金看板が最もよく写っている写真の番号（無ければ null）,
  "rawText": 看板に書かれている料金の文言をそのまま書き起こしたもの（無ければ ""）,
  "rates": [ { "from": "08:00", "to": "20:00", "minutes": 30, "yen": 200 } ],
  "caps":  [ { "type": "24h" | "same-day" | "window", "from": "08:00" or null, "to": "20:00" or null, "yen": 1000 } ],
  "confidence": "high" | "medium" | "low",
  "note": "読めなかった理由や、曜日による違い・注意書きなど（日本語で短く）"
}
- 時間帯の区別が無ければ from/to は "00:00"/"24:00"。
- 数字がぼやけて確信が持てない場合は推測で埋めず、confidence を low にして note に書く。`;

async function readPrices(photos) {
  const content = [
    ...photos.map((p) => ({ type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } })),
    { type: "text", text: PROMPT.replace("{n}", photos.length) },
  ];
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const body = await res.json();
  usage.inputTokens += body.usage.input_tokens;
  usage.outputTokens += body.usage.output_tokens;
  const text = body.content.find((c) => c.type === "text")?.text ?? "";
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(json);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function renderReport(rows, summary) {
  const cards = rows
    .map(({ place, photos, result, error }) => {
      const status = error ? "エラー" : !photos.length ? "写真なし" : result.found ? `読めた（${result.confidence}）` : "読めず";
      const thumbs = photos
        .map(
          (p, i) =>
            `<figure class="${result?.photoIndex === i ? "hit" : ""}"><img src="data:${p.mediaType};base64,${p.data}"><figcaption>#${i} ${escapeHtml(p.author)}</figcaption></figure>`
        )
        .join("");
      return `<section><h2>${escapeHtml(place.displayName?.text)} <span>${status}</span></h2>
<p><a href="${escapeHtml(place.googleMapsUri)}">Googleマップで開く</a> ・ ${escapeHtml(place.formattedAddress)}</p>
${result ? `<pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>` : ""}${error ? `<pre>${escapeHtml(error)}</pre>` : ""}
<div class="photos">${thumbs}</div></section>`;
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>駐車場料金 読み取り検証</title>
<style>body{font-family:sans-serif;max-width:1100px;margin:auto;padding:16px}section{border-top:1px solid #ccc;padding:8px 0}
h2 span{font-size:14px;background:#eee;padding:2px 8px;border-radius:8px}.photos{display:flex;gap:8px;flex-wrap:wrap}
figure{margin:0;width:240px}figure img{width:100%}figure.hit{outline:4px solid #2a9d8f}figcaption{font-size:11px;color:#666}
pre{background:#f6f6f6;padding:8px;white-space:pre-wrap;font-size:12px}</style>
<h1>駐車場料金 読み取り検証：${escapeHtml(LABEL)}</h1><pre>${escapeHtml(JSON.stringify(summary, null, 2))}</pre>${cards}`;
}

const places = await searchParking();
console.log(`${places.length} 件の駐車場が見つかりました`);
const rows = [];
for (const place of places) {
  const name = place.displayName?.text;
  const photoRefs = (place.photos ?? []).slice(0, PHOTOS_PER_PLACE);
  const row = { place, photos: [], result: null, error: null };
  try {
    row.photos = await Promise.all(photoRefs.map(fetchPhoto));
    if (row.photos.length) row.result = await readPrices(row.photos);
  } catch (e) {
    row.error = String(e.message ?? e);
  }
  console.log(`- ${name}: 写真${row.photos.length}枚 → ${row.error ? "エラー" : row.result?.found ? `読めた(${row.result.confidence})` : "読めず"}`);
  rows.push(row);
}

const summary = {
  label: LABEL,
  model: MODEL,
  places: rows.length,
  withPhotos: rows.filter((r) => r.photos.length).length,
  readable: rows.filter((r) => r.result?.found).length,
  readableHigh: rows.filter((r) => r.result?.found && r.result.confidence === "high").length,
  usage,
};
console.log(summary);

const outDir = join(dirname(fileURLToPath(import.meta.url)), "results");
await mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(join(outDir, `${stamp}.html`), renderReport(rows, summary));
await writeFile(
  join(outDir, `${stamp}.json`),
  JSON.stringify({ summary, rows: rows.map(({ place, result, error, photos }) => ({ name: place.displayName?.text, uri: place.googleMapsUri, photos: photos.length, result, error })) }, null, 2)
);
console.log(`レポート: results/${stamp}.html`);
