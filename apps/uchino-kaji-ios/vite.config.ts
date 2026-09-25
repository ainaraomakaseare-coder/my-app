import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
const pkg=fileURLToPath(new URL('.',import.meta.url));
export default defineConfig({root:pkg,plugins:[react()],resolve:{alias:{'@':pkg}},build:{outDir:'build/web',emptyOutDir:true}});
