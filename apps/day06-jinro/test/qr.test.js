/*
 * 自前のQRコード生成器を、本物のデコーダー（jsqr）で読み返して検証する。
 * 実行: node test/qr.test.js
 * jsqr が入っていない場合はスキップする（npm install jsqr）。
 */
const path = require('path');

let jsQR;
try {
  jsQR = require('jsqr');
} catch (e) {
  console.log('SKIP  jsqr が見つからないので飛ばします（npm install jsqr で入ります）');
  process.exit(0);
}

global.window = {};
require(path.join(__dirname, '..', 'qr.js'));
const QR = global.window.QR;

let pass = 0, fail = 0;

/* モジュール配列を画素に起こしてから読み返す */
function roundTrip(text) {
  const m = QR.encode(text);
  const quiet = 4, scale = 4;
  const size = m.length, total = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(total * total * 4).fill(255);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!m[r][c]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const y = (r + quiet) * scale + dy;
          const x = (c + quiet) * scale + dx;
          const i = (y * total + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  const res = jsQR(data, total, total);
  return res ? res.data : null;
}

function check(name, cond, extra) {
  if (cond) { pass++; }
  else { console.log('  NG  ' + name + (extra ? '  -> ' + extra : '')); fail++; }
}

// 実際に配るリンクに近い形
const base = 'https://example.github.io/my-app/apps/day06-jinro/';
const samples = [
  'HELLO',
  base,
  base + '#p=eyJ2IjoxLCJuIjoiXHUzMDQyIiwiciI6IndvbGYifQ',
  base + '#p=' + 'A'.repeat(120),
  base + '#r=' + 'Zm9vYmFy'.repeat(20),
  '日本語のなまえ・占い師・仲間の人狼',
];
samples.forEach(function (s) {
  check('読み返せる（' + s.length + '文字）', roundTrip(s) === s);
});

// 長さを変えながら網羅的に
let sweepFail = [];
for (let n = 1; n <= 858; n += 3) {
  const t = 'x'.repeat(n);
  if (roundTrip(t) !== t) sweepFail.push(n);
}
check('1〜858バイトを通しで読み返せる', sweepFail.length === 0, '失敗した長さ: ' + sweepFail.slice(0, 10));

// 日本語（1文字3バイト）
let jpFail = [];
for (let n = 1; n <= 200; n += 3) {
  const t = 'あ'.repeat(n);
  if (roundTrip(t) !== t) jpFail.push(n);
}
check('日本語も読み返せる', jpFail.length === 0, '失敗した長さ: ' + jpFail.slice(0, 10));

// 入りきらない場合はエラーにする
let threw = false;
try { QR.encode('x'.repeat(900)); } catch (e) { threw = true; }
check('長すぎるデータははっきり失敗する', threw);

console.log('\n' + pass + ' 件 通過 / ' + fail + ' 件 失敗');
process.exit(fail ? 1 : 0);
