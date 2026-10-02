// SNSでリンクを貼ったときに出る画像（OGP・1200×630）を作る。
// 使い方: NODE_PATH=<playwrightのnode_modules> node make-og.js（先に make-shots.js で img/chat.jpg を作っておく）
const path = require('path'), fs = require('fs');
const { chromium } = require('playwright');
const img = (f) => 'data:image/' + (f.endsWith('.svg') ? 'svg+xml' : 'jpeg') + ';base64,' + fs.readFileSync(path.join(__dirname, f)).toString('base64');
const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@500;700&family=Noto+Serif+JP:wght@700&display=swap">
<style>
  body { margin: 0; width: 1200px; height: 630px; background: #f4f1ea; font-family: "Noto Sans JP", sans-serif; color: #18181b; display: flex; overflow: hidden; }
  .text { flex: 1; padding: 0 0 0 84px; display: flex; flex-direction: column; justify-content: center; }
  .hook { font-family: "Noto Serif JP", serif; font-size: 30px; color: #52525b; margin: 0 0 14px; }
  h1 { font-family: "Noto Serif JP", serif; font-size: 54px; white-space: nowrap; line-height: 1.32; margin: 0 0 36px; font-weight: 700; }
  h1 em { font-style: normal; background: linear-gradient(transparent 64%, rgba(180,83,9,.2) 64%); }
  .brand { display: flex; align-items: center; gap: 14px; font-size: 30px; font-weight: 700; }
  .brand img { width: 52px; height: 52px; border-radius: 13px; }
  .brand span { font-size: 22px; font-weight: 500; color: #71717a; margin-left: 8px; }
  .phone { width: 300px; margin: 64px 84px 0 0; border-radius: 44px; background: #18181b; padding: 10px; box-shadow: 0 30px 60px rgba(24,24,27,.25); align-self: flex-start; }
  .phone img { width: 100%; border-radius: 35px; display: block; }
</style></head><body>
  <div class="text">
    <p class="hook">Wikipediaに載るのは、有名人だけ。でも――</p>
    <h1>おじいちゃんの人生にも、<br><em>1ページ</em>を。</h1>
    <div class="brand"><img src="${img('../icons/icon.svg')}">おもいでWiki<span>無料・登録なし</span></div>
  </div>
  <div class="phone"><img src="${img('img/chat.jpg')}"></div>
</body></html>`;
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(html, { waitUntil: 'networkidle' }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(__dirname, 'img', 'og.png') });
  await browser.close();
})();
