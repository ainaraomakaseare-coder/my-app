// Web版（apps/gohan-ashiato）を www/ に同梱する。決まったファイルだけをコピーし、テストなどは入れない
import fs from 'node:fs/promises';
import { build } from 'esbuild';
const SRC = '../gohan-ashiato/';
const FILES = ['core.js', 'app.js', 'style.css', 'icon-180.png', 'icon-512.png'];
await fs.rm('www', { recursive: true, force: true });
await fs.mkdir('www', { recursive: true });
for (const f of FILES) await fs.copyFile(SRC + f, 'www/' + f);
let html = await fs.readFile(SRC + 'index.html', 'utf8');
// ホーム画面に追加する設定（manifest）はアプリでは要らない。橋渡しは core.js より前に読む
html = html.replace(/<link rel="manifest"[^>]*>\n?/, '');
if (!html.includes('<script src="core.js"></script>')) throw new Error('core.js script tag not found');
html = html.replace('<script src="core.js"></script>', '<script src="native.js"></script>\n<script src="core.js"></script>');
await fs.writeFile('www/index.html', html);
await build({ entryPoints: ['src/native.mjs'], outfile: 'www/native.js', bundle: true, format: 'iife', target: 'safari15', minify: true });
console.log('Bundled', (await fs.readdir('www')).sort().join(', '));
