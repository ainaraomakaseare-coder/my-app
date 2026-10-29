// raw-*.png に見出しを付けて、App Storeに出す画像（gohan-ashiato-1〜5.png、1179×2556）を作る
// 使い方: NODE_PATH=<playwrightのnode_modules> node store-frame.cjs
const path = require('path'), fs = require('fs');
const { chromium } = require('playwright');
const WORK = path.join(__dirname, 'work');
const slides = [
  ['raw-1-list', '食べたものを、<br>写真でさっと記録', '今月の件数・合計・平均評価もひと目で'],
  ['raw-2-grid', '写真で並べると、<br>ごはんのアルバムに', '「あの日なに食べたっけ？」がすぐ見つかる'],
  ['raw-3-detail', 'お店・値段・評価・<br>メモまで残せる', '同じお店のほかの記録もいっしょに'],
  ['raw-4-edit', '近くのお店を、<br>タップで入力', '写真を選ぶと、撮影日時も自動で入る'],
  ['raw-5-places', 'よく行くお店が<br>ひと目でわかる', '回数・平均評価・合計をお店ごとに'],
];
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await b.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3 });
  for (let i = 0; i < slides.length; i++) {
    const [raw, title, sub] = slides[i];
    const img = 'data:image/png;base64,' + fs.readFileSync(path.join(WORK, raw + '.png')).toString('base64');
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;width:393px;height:852px;overflow:hidden;font-family:"Noto Sans CJK JP","Hiragino Sans",sans-serif;-webkit-font-smoothing:antialiased;
        background:linear-gradient(180deg,#FFF3EA 0%,#FBE3D2 100%)}
      .cap{padding:52px 28px 0;text-align:center}
      .brand{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#C2491A;letter-spacing:.06em;margin-bottom:12px}
      .brand i{display:inline-block;width:6px;height:6px;border-radius:50%;background:#E8682E}
      h1{margin:0;font-size:28px;line-height:1.38;font-weight:800;color:#2A1A10;font-feature-settings:"palt"}
      p{margin:10px 0 0;font-size:14px;line-height:1.6;color:#6E5446;font-feature-settings:"palt"}
      .phone{position:absolute;left:50%;top:238px;transform:translateX(-50%);width:318px;height:690px;border-radius:38px;overflow:hidden;background:#F5F6F8;
        border:7px solid #1F1A17;box-shadow:0 18px 40px rgba(110,60,25,.22)}
      .phone img{width:100%;display:block}
    </style></head><body><div class="cap"><div class="brand"><i></i>ごはんの足跡</div><h1>${title}</h1><p>${sub}</p></div>
    <div class="phone"><img src="${img}"></div></body></html>`);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(__dirname, `gohan-ashiato-${i + 1}.png`) });
  }
  await b.close();
  console.log('done');
})();
