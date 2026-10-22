// Cloudflare Pages（tabinoashiato）は、このリポジトリのルートをプロジェクトのルートとして読み、
// apps/day07-tabilog を公開フォルダにしている。Pagesの関数はプロジェクトのルートの functions/ しか
// 見ないので、旅の足跡の共有リンクの紹介カード（OGP）の本体をここから読み込む（2026-10-22）。
export { onRequest } from '../apps/day07-tabilog/functions/_middleware.js';
