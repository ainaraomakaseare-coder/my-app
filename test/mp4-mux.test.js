'use strict';
/**
 * public/mp4-mux.js（WebCodecs のコマを MP4 に詰める）と、reel.js の書き出し方を確かめる。
 *
 * ★ 守りたいのは3つ。
 *   1. どのコマも同じ長さ（1/30 秒）で記録される → TikTok の frame_rate_check_failed を起こさない
 *   2. 索引（stco）が中身（mdat）の先頭を正しく指している → 再生・取り込みができる
 *   3. 動画づくりはタイマーに頼らない → 裏のタブでも止まらない（まとめて仕込むで13本落ちた）
 *
 *   ffmpeg で作った本物の H.264 を詰め直し、ffprobe で 504コマ・30fps・16.8秒・
 *   絵が元と同じになることは手元で確かめてある。ここでは箱の中身を読んで同じことを見る。
 *
 *   node test/mp4-mux.test.js
 */
const assert = require('assert');
const fs = require('fs');
const { mux } = require('../public/mp4-mux');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); failed++; }
}

// --- 箱を読む（検証用の最小限） --------------------------------------------
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf']);
function readBoxes(buf, start, end) {
  const out = [];
  for (let at = start; at < end;) {
    const size = buf.readUInt32BE(at);
    assert.ok(size >= 8 && at + size <= end, '箱の大きさが壊れている: ' + at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const b = { type, start: at, body: at + 8, end: at + size };
    if (CONTAINERS.has(type)) b.children = readBoxes(buf, b.body, b.end);
    out.push(b);
    at += size;
  }
  return out;
}
function find(list, path) {
  let cur = { children: list };
  for (const t of path) {
    cur = (cur.children || []).find((b) => b.type === t);
    if (!cur) return null;
  }
  return cur;
}

// 長さ前置きの NAL っぽい中身。値は見分けがつけば何でもよい。
const sample = (i, key) => ({ data: Uint8Array.from([0, 0, 0, 3, key ? 0x65 : 0x41, i & 255, (i >> 8) & 255]), key });
const AVCC = Uint8Array.from([1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x1f, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80]);
const N = 504;
const samples = Array.from({ length: N }, (_, i) => sample(i, i % 60 === 0));
const file = Buffer.from(mux({ width: 720, height: 1280, fps: 30, avcC: AVCC, samples }));
const top = readBoxes(file, 0, file.length);
const ST = ['moov', 'trak', 'mdia', 'minf', 'stbl'];

check('箱の並びは ftyp → moov → mdat（索引が先）', () => {
  assert.deepStrictEqual(top.map((b) => b.type), ['ftyp', 'moov', 'mdat']);
});

check('どのコマも同じ長さ：1コマ1000・1秒30000 刻みの1行だけ', () => {
  const stts = find(top, [...ST, 'stts']);
  assert.strictEqual(file.readUInt32BE(stts.body + 4), 1, 'コマの長さが1種類でない');
  assert.strictEqual(file.readUInt32BE(stts.body + 8), N);
  assert.strictEqual(file.readUInt32BE(stts.body + 12), 1000);
  const mdhd = find(top, ['moov', 'trak', 'mdia', 'mdhd']);
  assert.strictEqual(file.readUInt32BE(mdhd.body + 12), 30000, '時間の刻みが30fpsでない');
  assert.strictEqual(file.readUInt32BE(mdhd.body + 16), N * 1000);
});

check('動画の長さは 16.8 秒', () => {
  const mvhd = find(top, ['moov', 'mvhd']);
  assert.strictEqual(file.readUInt32BE(mvhd.body + 16) / file.readUInt32BE(mvhd.body + 12), 16.8);
});

check('索引（stco）が中身の先頭を指し、各コマの大きさどおりに並んでいる', () => {
  const stco = find(top, [...ST, 'stco']);
  const stsz = find(top, [...ST, 'stsz']);
  const mdat = top.find((b) => b.type === 'mdat');
  const offset = file.readUInt32BE(stco.body + 8);
  assert.strictEqual(offset, mdat.body, '中身の先頭を指していない');
  assert.strictEqual(file.readUInt32BE(stsz.body + 8), N);
  let at = offset;
  for (let i = 0; i < N; i++) {
    const size = file.readUInt32BE(stsz.body + 12 + 4 * i);
    assert.deepStrictEqual([...file.subarray(at, at + size)], [...samples[i].data], i + '枚目の中身が違う');
    at += size;
  }
  assert.strictEqual(at, mdat.end, '中身の終わりが合わない');
});

check('キーフレームの一覧（stss）は、渡したとおり（1始まり）', () => {
  const stss = find(top, [...ST, 'stss']);
  const n = file.readUInt32BE(stss.body + 4);
  const keys = Array.from({ length: n }, (_, i) => file.readUInt32BE(stss.body + 8 + 4 * i));
  assert.deepStrictEqual(keys, [1, 61, 121, 181, 241, 301, 361, 421, 481]);
});

check('H.264 の設定（avcC）と画面の大きさが入っている', () => {
  const stsd = find(top, [...ST, 'stsd']);
  const avc1At = stsd.body + 8;
  assert.strictEqual(file.toString('latin1', avc1At + 4, avc1At + 8), 'avc1');
  assert.strictEqual(file.readUInt16BE(avc1At + 8 + 24), 720);
  assert.strictEqual(file.readUInt16BE(avc1At + 8 + 26), 1280);
  const avcCAt = avc1At + 8 + 78;
  assert.strictEqual(file.toString('latin1', avcCAt + 4, avcCAt + 8), 'avcC');
  assert.deepStrictEqual([...file.subarray(avcCAt + 8, avcCAt + 8 + AVCC.length)], [...AVCC]);
});

check('壊れた入力は、黙って変な動画を作らずに止める', () => {
  assert.throws(() => mux({ width: 720, height: 1280, fps: 30, avcC: AVCC, samples: [] }), /コマがありません/);
  assert.throws(() => mux({ width: 720, height: 1280, fps: 30, avcC: null, samples }), /avcC/);
  assert.throws(() => mux({ width: 720, height: 1280, fps: 30, avcC: AVCC, samples: [sample(0, false)] }), /キーフレーム/);
});

// --- reel.js の書き出し方 ---------------------------------------------------
const reel = fs.readFileSync(__dirname + '/../public/reel.js', 'utf8');
const between = (a, b) => reel.slice(reel.indexOf(a), reel.indexOf(b, reel.indexOf(a) + a.length));

check('動画はまず WebCodecs で書き、駄目なときだけ実時間録画に戻る', () => {
  const rec = between('async function record(', 'window.Reel');
  assert.ok(/pickEncoderConfig\(\)/.test(rec), 'WebCodecs を試していない');
  assert.ok(rec.indexOf('encodeFrames(') < rec.indexOf('recordRealtime('), '実時間録画を先に使っている');
  assert.ok(/wcConfig = null/.test(rec), '失敗した書き方を使い続ける（20本で20回失敗する）');
});

check('WebCodecs の書き出しはタイマーに頼らない（裏のタブでも止まらない）', () => {
  const body = between('async function encodeFrames(', 'async function record(');
  assert.ok(!/setTimeout|requestAnimationFrame|setInterval/.test(body), 'コマの書き出しがタイマーを待っている');
  assert.ok(/timestamp: Math\.round\(i \* stepUs\)/.test(body), 'コマの時刻を枚数から決めていない');
  assert.ok(/drained\(encoder\)/.test(body), 'エンコーダの待ち行列を見ずに詰め込んでいる');
  assert.ok(/'ondequeue' in encoder/.test(between('function drained(', 'async function encodeFrames(')),
    '待ち行列が空いた知らせ（dequeue）で起きていない');
});

check('index.html は reel.js より先に mp4-mux.js を読む', () => {
  const html = fs.readFileSync(__dirname + '/../public/index.html', 'utf8');
  const m = html.indexOf('src="/mp4-mux.js'), r = html.indexOf('src="/reel.js');
  assert.ok(m >= 0 && m < r, 'mp4-mux.js が無いか、reel.js の後にある');
});

console.log(`\n${passed} 件成功 / ${failed} 件失敗`);
if (failed) process.exit(1);
