// 縦型ショート動画を、設定ファイル（JSON）から作る。どの日でも使える。
//
//   node make-video.mjs <設定.json>
//
// 設定の形（例は examples/day33.json。実際の作業は work/ の下で。git には入らない）
//   source   顔の録画（横長でよい）
//   out      書き出し先
//   crop     { w, h, x, y }  顔の録画から縦 9:16 に切り抜く位置（元の画素）
//   header   カードの見出し（「30日で30アプリ  /  番外編DAY33」）
//   cards    { id: カード }  見せるカード
//     { type: 'shot', title, sub, image }            … 画像（スクショ）を載せるカード
//     { type: 'list', title, sub, items: [[小見出し, 本文], …] } … 文字の一覧カード
//   segments [ 場面, … ]  使う区間（元の録画の秒）と、その間の字幕・見せるもの
//     { from, to, lines: [字幕, …], show: 'face' | カードid, tel: '大テロップ（\n で改行）' }
//
// ★ 決めごと
//   ・話し終わりから次のカットまで 0.1 秒、頭に 0.05 秒の余白（ぶつ切り感を減らす）
//   ・字幕は区間の中で、文字数に比例して時間を割り振る（1行＝字幕1枚）
//   ・カードのタイトルと本文は、長さに合わせて文字を自動で小さくする（はみ出さない）

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const FFMPEG = process.env.FFMPEG ||
  'C:/Users/清水皓也/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin/ffmpeg.exe';

const specPath = resolve(process.argv[2] || '');
if (!process.argv[2] || !existsSync(specPath)) { console.error('使い方: node make-video.mjs <設定.json>'); process.exit(1); }
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
process.chdir(dirname(specPath));   // カードや字幕は設定ファイルの隣に作る

// 切れ目の余白。本人の指摘で広めにした（話し終わり・言い始めが切れて聞こえるため）
const HEAD = spec.padHead ?? 0.2, TAIL = spec.padTail ?? 0.4;

// フォントは作業フォルダに写しておく（C: の : が ffmpeg のフィルタの区切りとぶつかるため）
if (!existsSync('YuGothB.ttc')) copyFileSync('C:/Windows/Fonts/YuGothB.ttc', 'YuGothB.ttc');
const BOLD = 'YuGothB.ttc';

const ff = (args) => {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error('ffmpeg が失敗しました: ' + args.join(' ').slice(0, 300));
};

// ---------------------------------------------------------------- カード
mkdirSync('cards', { recursive: true });
const BG = '0xF3F4EF', INK = '0x173F38', SUB = '0x5E7A70', LINE = '0xD9DDD4';
const text = (name, s) => { writeFileSync(`cards/${name}.txt`, s, 'utf8'); return `cards/${name}.txt`; };

/** 全角1文字 ≒ 文字サイズ ぶんの幅として、はみ出さない大きさを出す。 */
const width = (s) => [...s].reduce((a, c) => a + (c.charCodeAt(0) < 0x2000 ? 0.55 : 1), 0);
const fit = (s, max, room) => Math.max(36, Math.min(max, Math.floor(room / Math.max(1, width(s)))));

function header(id, title, sub) {
  return [
    `drawbox=x=0:y=0:w=1080:h=20:color=${INK}:t=fill`,
    `drawtext=fontfile=${BOLD}:textfile=${text(id + '_h', spec.header || '')}:fontcolor=${INK}:fontsize=44:x=64:y=72`,
    `drawtext=fontfile=${BOLD}:textfile=${text(id + '_t', title)}:fontcolor=${INK}:fontsize=${fit(title, 100, 960)}:x=(w-text_w)/2:y=190`,
    sub ? `drawtext=fontfile=${BOLD}:textfile=${text(id + '_s', sub)}:fontcolor=${SUB}:fontsize=${fit(sub, 48, 960)}:x=(w-text_w)/2:y=380` : null,
  ].filter(Boolean).join(',');
}

function shotCard(id, c) {
  // 画像は枠（既定 950x745。スマホの縦長の画面は "box": [600, 1050] など）に、
  // 縦横比を保ったまま収めて真ん中に置く
  const [bw, bh] = c.box || [950, 745];
  ff(['-f', 'lavfi', '-i', `color=c=${BG}:s=1080x1920`, '-i', resolve(dirname(specPath), c.image), '-filter_complex',
    `[0]${header(id, c.title, c.sub)}[bg];` +
    `[1]scale=${bw}:${bh}:force_original_aspect_ratio=decrease,pad=iw+12:ih+12:6:6:color=${LINE}[s];` +
    `[bg][s]overlay=(W-w)/2:549+(${bh + 12}-h)/2`, '-frames:v', '1', `cards/${id}.png`]);
}

function listCard(id, c) {
  const n = c.items.length;
  const gap = n > 3 ? 210 : 250, h = n > 3 ? 180 : 210;
  const boxes = c.items.map(([label, body], i) => {
    const y = 540 + i * gap;
    return [
      `drawbox=x=90:y=${y}:w=900:h=${h}:color=white:t=fill`,
      `drawbox=x=90:y=${y}:w=900:h=${h}:color=${LINE}:t=4`,
      `drawtext=fontfile=${BOLD}:textfile=${text(`${id}_l${i}`, label)}:fontcolor=${SUB}:fontsize=40:x=140:y=${y + 30}`,
      `drawtext=fontfile=${BOLD}:textfile=${text(`${id}_b${i}`, body)}:fontcolor=${INK}:fontsize=${fit(body, 64, 800)}:x=140:y=${y + (n > 3 ? 88 : 100)}`,
    ].join(',');
  }).join(',');
  ff(['-f', 'lavfi', '-i', `color=c=${BG}:s=1080x1920`, '-vf', `${header(id, c.title, c.sub)},${boxes}`, '-frames:v', '1', `cards/${id}.png`]);
}

/**
 * 画面録画を載せるカード。
 *   { type: 'clip', title, sub, video, from, to, speed, blur: [[x, y, w, h], …] }
 * ★ blur は元の録画の画素で指定する（友達の写真や名前など、映してはいけない所）。
 *   ぼかしてから縮めるので、縮めたあとに透けて見えることはない。
 * ★ 場面の長さに足りないときは最後のコマで止め、長いときは切る（組み立て側で合わせる）。
 */
function clipCard(id, c) {
  const speed = c.speed || 1;
  const blurs = (c.blur || []).map(([x, y, w, h], k) =>
    `[b${k}src]crop=${w}:${h}:${x}:${y},boxblur=24:3[b${k}];`).join('');
  let chain = `[1:v]trim=${c.from}:${c.to},setpts=(PTS-STARTPTS)/${speed},fps=30`;
  if (c.blur && c.blur.length) {
    chain += `,split=${c.blur.length + 1}[base]` + c.blur.map((_, k) => `[b${k}src]`).join('') + ';' + blurs;
    let cur = '[base]';
    // [x, y, w, h, 始まり, 終わり]（元の録画の秒）のときは、その間だけぼかす
    c.blur.forEach(([x, y, , , t0, t1], k) => {
      const en = t0 !== undefined ? `:enable='between(t,${((t0 - c.from) / speed).toFixed(2)},${((t1 - c.from) / speed).toFixed(2)})'` : '';
      chain += `${cur}[b${k}]overlay=${x}:${y}${en}[o${k}];`; cur = `[o${k}]`;
    });
    chain += `${cur}scale=-2:1180[s];`;
  } else chain += `,scale=-2:1180[s];`;
  ff(['-f', 'lavfi', '-i', `color=c=${BG}:s=1080x1920:r=30`, '-i', resolve(dirname(specPath), c.video), '-filter_complex',
    `[0]${header(id, c.title, c.sub)}[bg];` + chain +
    `[s]pad=iw+12:ih+12:6:6:color=${LINE}[f];[bg][f]overlay=(W-w)/2:470:shortest=1,format=yuv420p`,
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', `cards/${id}.mp4`]);
}

for (const [id, c] of Object.entries(spec.cards || {})) {
  if (c.type === 'clip') clipCard(id, c);
  else (c.type === 'shot' ? shotCard : listCard)(id, c);
}
// 顔の録画がまだ無いときに、カードだけ先に作って確かめる
if (process.argv.includes('--cards')) { console.log('カードだけ作りました: ' + resolve('cards')); process.exit(0); }

// ---------------------------------------------------------------- 区間と字幕
// ★ 余白は、前後の場面の音にかぶらない範囲（間の真ん中まで）で足す
const segs = spec.segments.map((s, i) => {
  const prev = spec.segments[i - 1], next = spec.segments[i + 1];
  const a = s.joined ? s.from : Math.max(0, s.from - HEAD, prev ? (prev.to + s.from) / 2 : 0);
  const b = next && next.joined ? s.to : Math.min(s.to + TAIL, next ? (s.to + next.from) / 2 : Infinity);
  return { ...s, a, b };
});

const t = (s) => {
  const cs = Math.round(s * 100);
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const esc = (s) => s.replace(/\n/g, '\\N');
const events = [];
let at = 0;
for (const s of segs) {
  const d = s.b - s.a;
  const lines = s.lines || [];
  if (lines.length && Array.isArray(lines[0])) {
    // [元の秒, 字幕] の形：言い始めの時刻どおりに出す（間のある長いテイク向け）
    lines.forEach(([from, l], k) => {
      const st = k === 0 ? 0 : Math.max(0, from - s.a);
      const en = k + 1 < lines.length ? Math.max(st, lines[k + 1][0] - s.a) : d;
      events.push(`Dialogue: 0,${t(at + st)},${t(at + en)},Sub,,0,0,0,,${esc(l)}`);
    });
  } else {
    // 文字だけの形：区間の中で文字数に比例して割り振る
    const total = lines.reduce((a, l) => a + width(l), 0) || 1;
    let cur = 0;
    for (const l of lines) {
      const len = d * (width(l) / total);
      events.push(`Dialogue: 0,${t(at + cur)},${t(at + cur + len)},Sub,,0,0,0,,${esc(l)}`);
      cur += len;
    }
  }
  if (s.tel) events.push(`Dialogue: 1,${t(at)},${t(at + d)},Hook,,0,0,0,,${esc(s.tel)}`);
  at += d;
}
// ★ 字幕の高さ（画面の下からの余白、1920 の画素）。
//   TikTok・Instagram・YouTubeショートは下の約 4 分の 1 にアカウント名と投稿文が重なるので、
//   字幕の下端を下から 480（25%）より上に置く。大テロップはその上（字幕と重ならない高さ）。
//   設定ファイルの subMargin / hookMargin で日ごとに変えられる。
const SUB_MARGIN = spec.subMargin ?? 480, HOOK_MARGIN = spec.hookMargin ?? 720;
writeFileSync('subs.ass', `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Meiryo,80,&H00FFFFFF,&H00FFFFFF,&H00201815,&H00000000,-1,0,0,0,100,100,0,0,1,6,1,2,50,50,${SUB_MARGIN},1
Style: Hook,Meiryo,118,&H002A2AE8,&H002A2AE8,&H00FFFFFF,&H00000000,-1,0,0,0,100,100,0,0,1,8,0,2,40,40,${HOOK_MARGIN},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`, 'utf8');

// ---------------------------------------------------------------- 組み立て
const inputs = ['-i', spec.source];
const cardIndex = {};
for (const [id, c] of Object.entries(spec.cards || {})) {
  cardIndex[id] = 1 + Object.keys(cardIndex).length;
  if (c.type === 'clip') inputs.push('-i', `cards/${id}.mp4`);
  else inputs.push('-loop', '1', '-framerate', '30', '-i', `cards/${id}.png`);
}
const isClip = (id) => spec.cards && spec.cards[id] && spec.cards[id].type === 'clip';
const { w, h, x, y } = spec.crop;
const NORM = 'fps=30,format=yuv420p,setsar=1';
const parts = segs.map((s, i) => {
  const d = (s.b - s.a).toFixed(3);
  const v = s.show === 'face'
    ? `[0:v]trim=${s.a}:${s.b},setpts=PTS-STARTPTS,crop=${w}:${h}:${x}:${y},scale=1080:1920:flags=lanczos,${NORM}[v${i}];`
    : isClip(s.show)
      // 画面録画は、足りなければ最後のコマで止めて場面の長さに合わせる
      ? `[${cardIndex[s.show]}:v]tpad=stop_mode=clone:stop_duration=${d},trim=duration=${d},setpts=PTS-STARTPTS,${NORM}[v${i}];`
      : `[${cardIndex[s.show]}:v]trim=duration=${d},setpts=PTS-STARTPTS,${NORM}[v${i}];`;
  const fadeIn = s.joined ? '' : ',afade=t=in:d=0.03';
  const fadeOut = segs[i + 1] && segs[i + 1].joined ? '' : `,afade=t=out:st=${(s.b - s.a - 0.05).toFixed(3)}:d=0.05`;
  return v + `[0:a]atrim=${s.a}:${s.b},asetpts=PTS-STARTPTS${fadeIn}${fadeOut}[a${i}];`;
}).join('');
const cat = segs.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${segs.length}:v=1:a=1[cv][ca];`;
const look = `[cv]subtitles=subs.ass[ov];[ca]loudnorm=I=-14:TP=-1.5:LRA=11[oa]`;

ff([...inputs, '-filter_complex', parts + cat + look, '-map', '[ov]', '-map', '[oa]',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', '-shortest', spec.out]);
console.log(`できました: ${spec.out}（${at.toFixed(1)} 秒）`);
