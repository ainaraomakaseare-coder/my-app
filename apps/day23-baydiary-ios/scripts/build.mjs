import fs from 'node:fs/promises';
import {build} from 'esbuild';
await fs.mkdir('www',{recursive:true});
// Explicit allowlist: never copy the source directory (it contains server secrets).
let html=await fs.readFile('../day23-baydiary/index.html','utf8');
html=html.replace(/<link[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/g,'');
html=html.replace('<head>','<head>\n<script src="native.js"></script>');
await build({entryPoints:['src/native.mjs'],outfile:'www/native.js',bundle:true,format:'iife',target:'safari15',minify:true});
const css=await fs.readFile('src/ios.css','utf8');
html=html.replace('</head>','<style>'+css+'</style></head>');
await fs.writeFile('www/index.html',html);
const names=(await fs.readdir('www')).sort();
if(JSON.stringify(names)!==JSON.stringify(['index.html','native.js'])) throw new Error('Unexpected bundled files: '+names.join(', '));
console.log('Bundled HTML + native bridge; no server or environment files.');
