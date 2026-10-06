import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const source = resolve(root, 'omoide.html');
const destination = resolve(here, '..', 'www', 'index.html');

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
console.log('Prepared the current omoide.html for the iOS WebView.');
