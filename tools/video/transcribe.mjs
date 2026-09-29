// 動画・音声を文字起こしして、字幕ファイル（.srt）と JSON を書き出す。
//
//   node transcribe.mjs <入力ファイル> [出力の名前（拡張子なし）] [--limit 秒]
//
// ★ このPCは Windows on ARM（Snapdragon）。ffmpeg 内蔵の whisper は x64 の
//   エミュレーションで動くため遅く、結果も崩れた。音声認識は Node（arm64 ネイティブ）の
//   transformers.js で行い、ffmpeg は音声の取り出しにだけ使う。
// ★ 無料・このPCの中だけで動く。モデルは初回だけ models/hf にダウンロードされる。

import { pipeline, env } from '@huggingface/transformers';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { basename, extname, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FFMPEG = process.env.FFMPEG ||
  'C:/Users/清水皓也/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin/ffmpeg.exe';

// ★ URL の pathname だと日本語のフォルダ名が %E6… に化けるので、fileURLToPath で戻す
env.cacheDir = fileURLToPath(new URL('./models/hf/', import.meta.url));

const args = process.argv.slice(2);
const limitAt = args.indexOf('--limit');
const limit = limitAt >= 0 ? Number(args.splice(limitAt, 2)[1]) : null;
const [input, outArg] = args;
if (!input) {
  console.error('使い方: node transcribe.mjs <入力ファイル> [出力の名前] [--limit 秒]');
  process.exit(1);
}
const out = outArg || join(dirname(input), basename(input, extname(input)));

// 1) 音声を 16kHz・モノラル・32bit float で取り出す（Whisper が受け取る形）
const ff = spawnSync(FFMPEG, ['-v', 'error', ...(limit ? ['-t', String(limit)] : []), '-i', input,
  '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
if (ff.status !== 0) {
  console.error('音声を取り出せませんでした:', ff.stderr.toString());
  process.exit(1);
}
// Buffer の先頭が4バイト境界に揃っているとは限らないので、コピーしてから読む
const audio = new Float32Array(Uint8Array.from(ff.stdout).buffer);
console.log(`音声 ${(audio.length / 16000).toFixed(1)} 秒`);

// 2) 文字起こし
const t0 = Date.now();
const asr = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-large-v3-turbo', {
  dtype: { encoder_model: 'q8', decoder_model_merged: 'q4' },
  device: 'cpu',
});
console.log(`モデル読み込み ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

const t1 = Date.now();
const res = await asr(audio, {
  language: 'japanese', task: 'transcribe',
  chunk_length_s: 30, stride_length_s: 5,
  return_timestamps: true,
});
console.log(`文字起こし ${((Date.now() - t1) / 1000).toFixed(1)} 秒`);

// 3) 書き出す
const chunks = (res.chunks || []).filter((c) => c.text && c.text.trim());
const ts = (s) => {
  const ms = Math.max(0, Math.round((s || 0) * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
const srt = chunks.map((c, i) => `${i + 1}\n${ts(c.timestamp[0])} --> ${ts(c.timestamp[1] ?? c.timestamp[0] + 2)}\n${c.text.trim()}\n`).join('\n');
writeFileSync(out + '.srt', srt, 'utf8');
writeFileSync(out + '.json', JSON.stringify({ text: res.text, chunks }, null, 2), 'utf8');
console.log(`書き出し: ${out}.srt / ${out}.json`);
