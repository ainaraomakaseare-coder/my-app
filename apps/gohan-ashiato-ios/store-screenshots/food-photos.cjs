// App Store用スクリーンショットのサンプル写真（料理のイラスト）を作る。
// 使い方: NODE_PATH=<playwrightのnode_modules> node food-photos.cjs → work/photos/*.jpg
const path = require('path'), fs = require('fs');
const { chromium } = require('playwright');
const OUT = path.join(__dirname, 'work', 'photos');

const S = 1200; // 正方形
// 木のテーブル
const table = (tone = ['#C89B6D', '#B5855A']) => `
  <defs>
    <linearGradient id="wood" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${tone[0]}"/><stop offset="1" stop-color="${tone[1]}"/></linearGradient>
    <radialGradient id="vig" cx=".5" cy=".5" r=".75"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".28"/></radialGradient>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#3b2412" flood-opacity=".35"/></filter>
    <filter id="soft"><feGaussianBlur stdDeviation="1.2"/></filter>
    <radialGradient id="plate" cx=".45" cy=".4" r=".7"><stop offset="0" stop-color="#ffffff"/><stop offset=".8" stop-color="#f1efea"/><stop offset="1" stop-color="#dcd8cf"/></radialGradient>
  </defs>
  <rect width="${S}" height="${S}" fill="url(#wood)"/>
  ${Array.from({ length: 14 }, (_, i) => `<path d="M0 ${i * 90 + 20} C 300 ${i * 90 + 50}, 800 ${i * 90 - 10}, ${S} ${i * 90 + 30}" stroke="#8a5e38" stroke-opacity=".18" stroke-width="${3 + (i % 3) * 2}" fill="none"/>`).join('')}`;
const vignette = `<rect width="${S}" height="${S}" fill="url(#vig)"/>`;
const plate = (cx, cy, r) => `<g filter="url(#sh)"><circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#plate)"/></g><circle cx="${cx}" cy="${cy}" r="${r * 0.78}" fill="none" stroke="#e2ddd2" stroke-width="4"/>`;
const rnd = (seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647)(7);

const dishes = {
  ramen: () => `${table(['#5b4636', '#3f2f24'])}
    <g filter="url(#sh)"><circle cx="600" cy="600" r="470" fill="#1f1c1a"/></g>
    <circle cx="600" cy="600" r="440" fill="#2b2522"/><circle cx="600" cy="600" r="415" fill="#c8102e" opacity=".85"/>
    <defs><radialGradient id="broth" cx=".45" cy=".4" r=".7"><stop offset="0" stop-color="#f1c27a"/><stop offset="1" stop-color="#c98a3f"/></radialGradient></defs>
    <circle cx="600" cy="600" r="395" fill="url(#broth)"/>
    ${Array.from({ length: 26 }, (_, i) => { const y = 430 + i * 14; return `<path d="M${330 + (i % 4) * 8} ${y} q 30 -14 60 0 t 60 0 t 60 0 t 60 0 t 60 0 t 60 0 t 60 0" stroke="#f5dc9a" stroke-width="9" fill="none" stroke-linecap="round" opacity=".95"/>`; }).join('')}
    <g><circle cx="430" cy="420" r="110" fill="#c98366"/><circle cx="430" cy="420" r="92" fill="#e7b39a"/><circle cx="430" cy="420" r="50" fill="#d89479" opacity=".7"/></g>
    <g><circle cx="560" cy="350" r="100" fill="#c98366"/><circle cx="560" cy="350" r="84" fill="#e9b8a0"/><circle cx="545" cy="345" r="40" fill="#d89479" opacity=".7"/></g>
    <g transform="rotate(-20 760 470)"><ellipse cx="760" cy="470" rx="78" ry="96" fill="#fffdf7"/><ellipse cx="760" cy="480" rx="44" ry="50" fill="#f29c1f"/><ellipse cx="750" cy="470" rx="20" ry="18" fill="#ffcc66" opacity=".7"/></g>
    <g transform="rotate(15 860 620)"><ellipse cx="860" cy="620" rx="74" ry="92" fill="#fffdf7"/><ellipse cx="860" cy="630" rx="42" ry="48" fill="#ef951a"/></g>
    <rect x="690" y="700" width="200" height="230" rx="10" fill="#1b2a1f" transform="rotate(12 790 815)"/>
    ${Array.from({ length: 7 }, (_, i) => `<rect x="${430 + i * 22}" y="${720 + (i % 2) * 20}" width="18" height="120" rx="6" fill="#c9a15a" transform="rotate(${-20 + i * 6} ${440 + i * 22} 780)"/>`).join('')}
    ${Array.from({ length: 34 }, () => { const x = 360 + rnd() * 480, y = 520 + rnd() * 300; return `<circle cx="${x}" cy="${y}" r="13" fill="#5fae47"/><circle cx="${x}" cy="${y}" r="6" fill="#d7f0b8"/>`; }).join('')}
    ${vignette}`,
  karaage: () => `${table()}
    <g filter="url(#sh)"><rect x="70" y="140" width="1060" height="920" rx="40" fill="#2a2420"/></g>
    ${plate(780, 470, 300)}
    ${Array.from({ length: 5 }, (_, i) => { const a = i * 1.25, x = 780 + Math.cos(a) * 120, y = 470 + Math.sin(a) * 110; return `<g><path d="M${x - 85} ${y} q 10 -80 85 -82 q 90 0 86 80 q -6 82 -88 84 q -88 -4 -83 -82z" fill="#b3631f"/><path d="M${x - 60} ${y - 10} q 20 -50 70 -48" stroke="#d98a3a" stroke-width="16" fill="none" stroke-linecap="round" opacity=".8"/>${Array.from({ length: 6 }, () => `<circle cx="${x - 50 + rnd() * 100}" cy="${y - 50 + rnd() * 100}" r="${5 + rnd() * 6}" fill="#8f4a14" opacity=".55"/>`).join('')}</g>`; }).join('')}
    ${Array.from({ length: 40 }, () => { const x = 560 + rnd() * 160, y = 330 + rnd() * 300; return `<path d="M${x} ${y} q 30 ${-10 + rnd() * 20} 70 ${-5 + rnd() * 10}" stroke="#cfe8a8" stroke-width="7" fill="none" stroke-linecap="round"/>`; }).join('')}
    <path d="M940 640 l 90 -40 a 80 80 0 0 1 -20 110 z" fill="#ffe36b" stroke="#f4c430" stroke-width="6"/>
    <g filter="url(#sh)"><circle cx="330" cy="820" r="190" fill="#f6f1e7"/></g><circle cx="330" cy="820" r="165" fill="#fbfaf6"/>
    ${Array.from({ length: 70 }, () => { const a = rnd() * 6.28, r = rnd() * 140; return `<ellipse cx="${330 + Math.cos(a) * r}" cy="${820 + Math.sin(a) * r}" rx="12" ry="7" fill="#ffffff" stroke="#ece6d8" stroke-width="2" transform="rotate(${rnd() * 180} ${330 + Math.cos(a) * r} ${820 + Math.sin(a) * r})"/>`; }).join('')}
    <g filter="url(#sh)"><circle cx="760" cy="880" r="160" fill="#5a1d14"/></g><circle cx="760" cy="880" r="138" fill="#a86b3a"/><circle cx="760" cy="880" r="138" fill="#c58a50" opacity=".5"/>
    ${Array.from({ length: 6 }, () => `<rect x="${700 + rnd() * 100}" y="${830 + rnd() * 90}" width="34" height="34" rx="6" fill="#f3ead6" opacity=".9"/>`).join('')}
    ${Array.from({ length: 8 }, () => `<circle cx="${690 + rnd() * 140}" cy="${820 + rnd() * 120}" r="9" fill="#4f9a3a"/>`).join('')}
    ${vignette}`,
  curry: () => `${table(['#d8c3a5', '#c4a985'])}
    ${plate(600, 600, 470)}
    <path d="M300 420 q 120 -150 300 -90 q -60 250 0 560 q -260 30 -330 -150 q -40 -170 30 -320z" fill="#fffef9"/>
    ${Array.from({ length: 90 }, () => { const x = 300 + rnd() * 260, y = 380 + rnd() * 460; return `<ellipse cx="${x}" cy="${y}" rx="13" ry="7" fill="#fff" stroke="#efe8da" stroke-width="2" transform="rotate(${rnd() * 180} ${x} ${y})"/>`; }).join('')}
    <defs><radialGradient id="cur" cx=".6" cy=".5" r=".6"><stop offset="0" stop-color="#b8661f"/><stop offset="1" stop-color="#7f3f12"/></radialGradient></defs>
    <path d="M600 330 q 280 -20 330 230 q 40 260 -180 340 q -110 30 -150 -10 q -60 -280 0 -560z" fill="url(#cur)"/>
    ${[['#e57c2a', 700, 470, 50], ['#e57c2a', 820, 620, 44], ['#f1d98a', 700, 700, 48], ['#f1d98a', 830, 430, 40], ['#8a4a2a', 760, 560, 46], ['#8a4a2a', 650, 600, 40], ['#3e8e3a', 880, 720, 26], ['#3e8e3a', 690, 390, 22]].map(([c, x, y, r]) => `<rect x="${x - r}" y="${y - r * .8}" width="${r * 2}" height="${r * 1.6}" rx="${r * .4}" fill="${c}" transform="rotate(${rnd() * 60 - 30} ${x} ${y})"/>`).join('')}
    <g transform="rotate(-25 520 760)"><ellipse cx="520" cy="760" rx="80" ry="62" fill="#fffdf6"/><ellipse cx="520" cy="760" rx="44" ry="36" fill="#f5a623"/></g>
    ${vignette}`,
  pancake: () => `${table(['#efe4d4', '#dcc9ae'])}
    ${plate(600, 610, 470)}
    <defs><radialGradient id="pc" cx=".45" cy=".4" r=".7"><stop offset="0" stop-color="#e7a95a"/><stop offset=".85" stop-color="#c47a2c"/><stop offset="1" stop-color="#a5601d"/></radialGradient></defs>
    ${[0, 1, 2].map(i => `<ellipse cx="600" cy="${660 - i * 50}" rx="330" ry="300" fill="#f4d7a1"/><ellipse cx="600" cy="${640 - i * 50}" rx="330" ry="300" fill="url(#pc)"/>`).join('')}
    <path d="M420 400 q 180 -80 330 20 q 60 60 30 140 q -40 30 -20 90 q -30 30 -50 -20 q -40 -60 -120 -30 q -90 40 -130 -40 q -40 -90 -40 -160z" fill="#8a3f0b" opacity=".55"/>
    <rect x="535" y="430" width="130" height="110" rx="16" fill="#fff4b8"/><rect x="545" y="438" width="110" height="40" rx="10" fill="#fffbe0"/>
    ${[[860, 830, '#2b3a8f'], [900, 790, '#2b3a8f'], [830, 870, '#c4122f'], [920, 860, '#c4122f'], [870, 900, '#2b3a8f'], [960, 820, '#c4122f']].map(([x, y, c]) => `<circle cx="${x}" cy="${y}" r="30" fill="${c}"/><circle cx="${x - 9}" cy="${y - 10}" r="8" fill="#fff" opacity=".35"/>`).join('')}
    <path d="M300 850 q 20 -40 60 -20 q -10 40 -60 20z" fill="#3e8e3a"/><path d="M330 880 q 40 -10 50 30 q -40 10 -50 -30z" fill="#4fa346"/>
    ${vignette}`,
  salmon: () => `${table(['#6b5a4b', '#4b3d32'])}
    <g filter="url(#sh)"><circle cx="600" cy="600" r="470" fill="#2d2a3a"/></g><circle cx="600" cy="600" r="440" fill="#3d3a52"/><circle cx="600" cy="600" r="410" fill="#fbfaf5"/>
    ${Array.from({ length: 120 }, () => { const a = rnd() * 6.28, r = 330 + rnd() * 70; const x = 600 + Math.cos(a) * r, y = 600 + Math.sin(a) * r; return `<ellipse cx="${x}" cy="${y}" rx="12" ry="7" fill="#fff" stroke="#ece6d8" stroke-width="2" transform="rotate(${rnd() * 180} ${x} ${y})"/>`; }).join('')}
    ${Array.from({ length: 9 }, (_, i) => { const a = i / 9 * 6.28, x = 600 + Math.cos(a) * 200, y = 600 + Math.sin(a) * 200; return `<g transform="rotate(${a * 57.3 + 90} ${x} ${y})"><ellipse cx="${x}" cy="${y}" rx="78" ry="150" fill="#f47c3c"/>${[-60, -20, 20, 60].map(o => `<path d="M${x - 70} ${y + o} q 70 -26 140 0" stroke="#ffd9c2" stroke-width="10" fill="none" opacity=".9"/>`).join('')}</g>`; }).join('')}
    <path d="M520 560 q 80 -120 170 -10 q -80 110 -170 10z" fill="#3c8d3a"/><path d="M530 560 q 80 0 150 -10" stroke="#9fd18b" stroke-width="5" fill="none"/>
    ${Array.from({ length: 22 }, () => { const x = 560 + rnd() * 110, y = 560 + rnd() * 110; return `<circle cx="${x}" cy="${y}" r="17" fill="#e8461c"/><circle cx="${x - 5}" cy="${y - 6}" r="5" fill="#fff" opacity=".6"/>`; }).join('')}
    ${vignette}`,
  pizza: () => `${table(['#cfa678', '#b98c5d'])}
    <g filter="url(#sh)"><circle cx="600" cy="600" r="500" fill="#7a5532"/></g><circle cx="600" cy="600" r="490" fill="#9b6d41"/>
    <circle cx="600" cy="600" r="440" fill="#e1a35d"/><circle cx="600" cy="600" r="430" fill="#d78b3d" opacity=".4"/>
    ${Array.from({ length: 14 }, () => { const a = rnd() * 6.28; return `<circle cx="${600 + Math.cos(a) * 425}" cy="${600 + Math.sin(a) * 425}" r="${10 + rnd() * 12}" fill="#5a3415" opacity=".55"/>`; }).join('')}
    <circle cx="600" cy="600" r="385" fill="#c8361e"/><circle cx="600" cy="600" r="385" fill="#e04a2a" opacity=".5"/>
    ${[[470, 450], [700, 420], [600, 600], [430, 680], [760, 650], [600, 800], [820, 520], [500, 860]].map(([x, y]) => `<path d="M${x - 70} ${y} q 0 -70 70 -66 q 80 -4 76 64 q 4 66 -74 70 q -76 0 -72 -68z" fill="#fff8e7"/><ellipse cx="${x - 10}" cy="${y - 14}" rx="30" ry="18" fill="#ffffff" opacity=".8"/>`).join('')}
    ${[[540, 520, 20], [680, 520, -30], [520, 760, 60], [700, 760, 110], [820, 400, -60]].map(([x, y, r]) => `<g transform="rotate(${r} ${x} ${y})"><path d="M${x - 50} ${y} q 50 -50 100 0 q -50 50 -100 0z" fill="#2f7d32"/><path d="M${x - 46} ${y} h 92" stroke="#7cc47f" stroke-width="4"/></g>`).join('')}
    ${vignette}`,
  omurice: () => `${table(['#d6c7b3', '#c2ae93'])}
    ${plate(600, 610, 470)}
    <defs><radialGradient id="egg" cx=".45" cy=".35" r=".7"><stop offset="0" stop-color="#ffe27a"/><stop offset=".8" stop-color="#f7c331"/><stop offset="1" stop-color="#e4a316"/></radialGradient></defs>
    <g filter="url(#sh)"><ellipse cx="600" cy="610" rx="360" ry="230" fill="url(#egg)" transform="rotate(-12 600 610)"/></g>
    <path d="M330 600 q 40 -60 80 0 t 80 0 t 80 0 t 80 0 t 80 0 t 80 0" transform="rotate(-12 600 610)" stroke="#c8261b" stroke-width="34" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M330 600 q 40 -60 80 0 t 80 0 t 80 0 t 80 0 t 80 0 t 80 0" transform="rotate(-12 600 610)" stroke="#ec4a3a" stroke-width="12" fill="none" stroke-linecap="round" opacity=".7"/>
    ${[[880, 830], [910, 800], [860, 800]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="26" fill="#2e7d32"/><circle cx="${x + 6}" cy="${y - 4}" r="14" fill="#4caf50"/>`).join('')}
    <ellipse cx="330" cy="870" rx="70" ry="40" fill="#e9455a"/><ellipse cx="310" cy="860" rx="20" ry="10" fill="#fff" opacity=".4"/>
    ${vignette}`,
  yakitori: () => `${table(['#4a3a2e', '#2f241c'])}
    <g filter="url(#sh)"><rect x="140" y="250" width="920" height="700" rx="60" fill="#1d1d1d" transform="rotate(-8 600 600)"/></g>
    <rect x="160" y="270" width="880" height="660" rx="50" fill="#2b2b2b" transform="rotate(-8 600 600)"/>
    ${[0, 1, 2, 3].map(i => { const y = 380 + i * 140; return `<g transform="rotate(-8 600 600)"><rect x="200" y="${y - 6}" width="820" height="12" rx="6" fill="#e3c79a"/>${[0, 1, 2, 3].map(j => { const x = 330 + j * 150; const leek = i % 2 === 0 && j % 2 === 1; return leek ? `<rect x="${x - 50}" y="${y - 42}" width="100" height="84" rx="22" fill="#cfe3a8"/><rect x="${x - 50}" y="${y - 42}" width="100" height="30" rx="15" fill="#e8f2cf"/><path d="M${x - 30} ${y - 30} l 20 60 M${x + 10} ${y - 30} l 20 60" stroke="#4d3018" stroke-width="10" opacity=".6"/>` : `<path d="M${x - 62} ${y} q 0 -58 62 -58 q 64 0 62 58 q 0 58 -62 58 q -64 0 -62 -58z" fill="${i === 3 ? '#7a3b16' : '#a8561f'}"/><path d="M${x - 40} ${y - 30} q 40 -24 80 0" stroke="#d68a46" stroke-width="12" fill="none" opacity=".7"/><path d="M${x - 34} ${y - 40} l 22 80 M${x + 12} ${y - 40} l 22 80" stroke="#3a1d0a" stroke-width="12" opacity=".55"/>`; }).join('')}</g>`; }).join('')}
    <circle cx="920" cy="860" r="40" fill="#f4e04d" transform="rotate(-8 600 600)"/>
    ${vignette}`,
  gyoza: () => `${table(['#c6a07a', '#ad8661'])}
    ${plate(600, 600, 470)}
    ${Array.from({ length: 7 }, (_, i) => { const y = 330 + i * 80, x = 600 + (i % 2) * 30 - 15; return `<g><path d="M${x - 230} ${y + 40} q 230 -120 460 0 q -230 60 -460 0z" fill="#f2e3c6"/><path d="M${x - 230} ${y + 40} q 230 60 460 0 q -230 40 -460 0z" fill="#c9792e"/>${[-150, -90, -30, 30, 90, 150].map(o => `<path d="M${x + o} ${y - 30 + Math.abs(o) * .25} l 10 30" stroke="#e1cda6" stroke-width="7" stroke-linecap="round"/>`).join('')}</g>`; }).join('')}
    <g filter="url(#sh)"><circle cx="930" cy="870" r="110" fill="#f7f4ee"/></g><circle cx="930" cy="870" r="85" fill="#5b2a12"/><circle cx="905" cy="850" r="18" fill="#e8b65a" opacity=".8"/>
    ${vignette}`,
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await b.newPage({ viewport: { width: S, height: S } });
  for (const [name, fn] of Object.entries(dishes)) {
    await page.setContent(`<html><body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${fn()}</svg></body></html>`);
    await page.screenshot({ path: path.join(OUT, name + '.jpg'), type: 'jpeg', quality: 88 });
  }
  await b.close();
  console.log('photos:', Object.keys(dishes).join(', '));
})();
