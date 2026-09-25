const path = require('path'), fs = require('fs');
const { chromium } = require('playwright');
// 使い方: NODE_PATH=<playwrightのnode_modules> node store-raw.js && node store-frame.js
// raw-*.png（素の画面）と framed-*.png（見出し付き）が work/ にでき、framed を App Store に使う
const OUT = path.join(__dirname, 'work');
const slides = [
  ['raw-1-view', '質問に答えるだけで、<br>その人の人生が1ページに', '目次も年譜もプロフィール表も、自動でまとまる'],
  ['raw-2-voice', '読み上げを聞いて、<br>声で答えるだけ', '文字を打たなくて大丈夫。「次」と言えば次の質問へ'],
  ['raw-3-ai', 'AIが話を聞いて、<br>もう一歩深く聞き返す', '学校の名前や年、そのときの気持ちまで'],
  ['raw-4-dash', '少しずつ集めて、<br>あとから書き直せる', '1回5問から。何日かに分けてのんびり増やせる'],
  ['raw-5-trip', '家族旅行の一日も、<br>みんなで残せる', '別行動した時間も、それぞれの思い出として'],
];
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await b.newPage({ viewport: { width: 428, height: 926 }, deviceScaleFactor: 3 });
  for (let i = 0; i < slides.length; i++) {
    const [raw, title, sub] = slides[i];
    const img = 'data:image/png;base64,' + fs.readFileSync(path.join(OUT, raw + '.png')).toString('base64');
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;width:428px;height:926px;overflow:hidden;background:#f4f4f5;font-family:"Noto Sans CJK JP","Noto Sans JP","Hiragino Sans",sans-serif;-webkit-font-smoothing:antialiased}
      .cap{padding:58px 32px 0;text-align:center}
      .brand{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:#b45309;letter-spacing:.04em;margin-bottom:14px}
      .brand i{display:inline-block;width:6px;height:6px;border-radius:50%;background:#d97706}
      h1{margin:0;font-size:29px;line-height:1.38;font-weight:700;color:#18181b;letter-spacing:-.01em;font-feature-settings:"palt"}
      p{margin:12px 0 0;font-size:15px;line-height:1.6;color:#52525b;font-feature-settings:"palt"}
      .phone{position:absolute;left:50%;top:268px;transform:translateX(-50%);width:356px;height:770px;border-radius:30px;overflow:hidden;background:#fff;
        box-shadow:0 0 0 1px rgba(24,24,27,.08),0 10px 30px rgba(24,24,27,.10)}
      .phone img{width:100%;display:block}
    </style></head><body><div class="cap"><div class="brand"><i></i>おもいでWiki</div><h1>${title}</h1><p>${sub}</p></div>
    <div class="phone"><img src="${img}"></div></body></html>`);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT, `framed-${i + 1}.png`) });
  }
  await b.close();
})();
