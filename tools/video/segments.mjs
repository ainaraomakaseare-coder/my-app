// 無音で区切って、話している区間ごとに文字起こしする。
//
//   node segments.mjs <動画> <出力.json> [--noise -35] [--gap 0.35] [--join 0.6]
//
// ★ 全体をまとめて文字起こしすると、言い直しが1つの塊にまとまり、
//   どこからどこまでがどのテイクかが分からない（DAY33 の 57〜80 秒がそうだった）。
//   無音で切った区間ごとに起こせば、区間＝テイクの候補になり、
//   「最後のテイクを使う」を区間の単位で選べる。
// ★ 区間の端は無音の検出から取るので、切れ目が正確（文字起こしの時刻は粗い）。

import { pipeline, env } from '@huggingface/transformers';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FFMPEG = process.env.FFMPEG ||
  'C:/Users/清水皓也/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin/ffmpeg.exe';
env.cacheDir = fileURLToPath(new URL('./models/hf/', import.meta.url));

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? Number(args.splice(i, 2)[1]) : def; };
const NOISE = opt('--noise', -35), GAP = opt('--gap', 0.35), JOIN = opt('--join', 0.6);
const [input, out] = args;
if (!input || !out) { console.error('使い方: node segments.mjs <動画> <出力.json>'); process.exit(1); }

// 1) 無音を探す
const sd = spawnSync(FFMPEG, ['-hide_banner', '-i', input, '-vn', '-af', `silencedetect=noise=${NOISE}dB:d=${GAP}`, '-f', 'null', '-'], { encoding: 'utf8' });
const log = sd.stderr;
const dur = Number((log.match(/Duration: (\d+):(\d+):([\d.]+)/) || []).slice(1).reduce((a, v, i) => a + Number(v) * [3600, 60, 1][i], 0));
const silences = [];
let s0 = null;
for (const m of log.matchAll(/silence_(start|end): ([\d.]+)/g)) {
  if (m[1] === 'start') s0 = Number(m[2]);
  else if (s0 !== null) { silences.push([s0, Number(m[2])]); s0 = null; }
}
if (s0 !== null) silences.push([s0, dur]);

// 2) 無音の間＝話している区間。短い息継ぎ（JOIN 秒未満）はつなぐ
let speech = [];
let cur = 0;
for (const [a, b] of silences) { if (a > cur) speech.push([cur, a]); cur = b; }
if (cur < dur) speech.push([cur, dur]);
speech = speech.filter(([a, b]) => b - a > 0.2);
const merged = [];
for (const seg of speech) {
  const last = merged[merged.length - 1];
  if (last && seg[0] - last[1] < JOIN) last[1] = seg[1];
  else merged.push([...seg]);
}

// 3) 区間ごとに文字起こし
const pcm = spawnSync(FFMPEG, ['-v', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
const audio = new Float32Array(Uint8Array.from(pcm.stdout).buffer);
const asr = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-large-v3-turbo', {
  dtype: { encoder_model: 'q8', decoder_model_merged: 'q4' }, device: 'cpu',
});
const result = [];
for (const [a, b] of merged) {
  const clip = audio.subarray(Math.floor(a * 16000), Math.ceil(b * 16000));
  const r = await asr(clip, { language: 'japanese', task: 'transcribe', chunk_length_s: 30 });
  const text = (r.text || '').trim();
  result.push({ start: +a.toFixed(3), end: +b.toFixed(3), text });
  console.log(`${a.toFixed(2).padStart(7)} ${b.toFixed(2).padStart(7)}  ${text}`);
}
writeFileSync(out, JSON.stringify({ input, duration: dur, segments: result }, null, 2), 'utf8');
