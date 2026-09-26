#!/usr/bin/env node
// OpenAIとCloudflare Workers AIの結果を並べて比べるための小さなスクリプト（docs/adr/0012）。
// 管理者だけが使う `/ai-compare` エンドポイントを呼ぶだけで、秘密情報はこのファイルには
// 一切書かない（すべて環境変数から読む）。
//
// 使い方（メモの整理を比べる。textFilePathはUTF-8のテキストファイル）：
//   COMPARE_URL=https://tabilog-api.hiroya-apps.workers.dev/ai-compare \
//   COMPARE_TOKEN=xxxxx \
//   node scripts/ai-compare.mjs memo ./sample-memo.txt
//
// 使い方（音声の文字起こしを比べる。audioFilePathはwebm/mp4/mp3/wav/oggのいずれか）：
//   COMPARE_URL=https://tabilog-api.hiroya-apps.workers.dev/ai-compare \
//   COMPARE_TOKEN=xxxxx \
//   node scripts/ai-compare.mjs voice ./sample-voice.webm
//
// ローカルの `wrangler dev --local` に対して試す場合は、
//   COMPARE_URL=http://localhost:8799/ai-compare COMPARE_TOKEN=xxxxx node scripts/ai-compare.mjs ...
// （ローカルはCloudflareへのログインが無いとWorkers AIの呼び出し自体が失敗することがある。
//  その場合はworkersAi側がerrorになるだけで、それ自体は想定内）

import { readFile } from "node:fs/promises";
import path from "node:path";

const AUDIO_CONTENT_TYPES = {
  ".webm": "audio/webm",
  ".mp4": "audio/mp4",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

function fail(message) {
  console.error("エラー: " + message);
  process.exit(1);
}

const mode = process.argv[2];
const filePath = process.argv[3];
const compareUrl = process.env.COMPARE_URL;
const compareToken = process.env.COMPARE_TOKEN;

if (mode !== "memo" && mode !== "voice") fail('第1引数は "memo" か "voice" にしてください（例: node scripts/ai-compare.mjs memo ./memo.txt）');
if (!filePath) fail("第2引数にファイルパスを指定してください");
if (!compareUrl) fail("環境変数 COMPARE_URL を設定してください（例: https://tabilog-api.<sub>.workers.dev/ai-compare）");
if (!compareToken) fail("環境変数 COMPARE_TOKEN を設定してください（wrangler secret put AI_COMPARE_TOKEN で設定した値）");

function printResult(label, entry) {
  console.log("\n--- " + label + " ---");
  console.log("時間: " + (entry && typeof entry.ms === "number" ? entry.ms + "ms" : "?"));
  if (entry && entry.error) {
    console.log("エラー: " + entry.error);
    return;
  }
  const result = entry ? entry.result : undefined;
  if (typeof result === "string") {
    console.log(result);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

async function runMemo() {
  const text = await readFile(filePath, "utf8");
  const res = await fetch(compareUrl + "?mode=memo", {
    method: "POST",
    headers: { "content-type": "application/json", "x-compare-token": compareToken },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) fail("HTTP " + res.status + ": " + (await res.text().catch(() => "")));
  const data = await res.json();
  printResult("OpenAI", data.openai);
  for (const [key, entry] of Object.entries(data.workersAi || {})) {
    printResult("Workers AI (" + key + ")", entry);
  }
}

async function runVoice() {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = AUDIO_CONTENT_TYPES[ext];
  if (!contentType) fail("対応していない拡張子です（webm/mp4/mp3/wav/oggのいずれかにしてください）: " + ext);
  const buf = await readFile(filePath);
  const res = await fetch(compareUrl + "?mode=voice", {
    method: "POST",
    headers: { "content-type": contentType, "x-compare-token": compareToken },
    body: buf,
  });
  if (!res.ok) fail("HTTP " + res.status + ": " + (await res.text().catch(() => "")));
  const data = await res.json();
  printResult("OpenAI（文字起こし）", data.openai);
  for (const [key, entry] of Object.entries(data.workersAi || {})) {
    printResult("Workers AI（" + key + "）", entry);
  }
}

if (mode === "memo") await runMemo();
else await runVoice();
