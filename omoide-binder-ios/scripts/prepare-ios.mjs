import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const source = resolve(root, 'omoide.html');
const destination = resolve(here, '..', 'www', 'index.html');

// Compile inline JavaScript during packaging; do not execute application code.
const html = await readFile(source, 'utf8');
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
  if (match[1].trim()) new Script(match[1], { filename: 'omoide.html' });
}

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
console.log('Prepared the current omoide.html for the iOS WebView.');
