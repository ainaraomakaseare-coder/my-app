// ダミーの料理写真（真上から撮ったような絵）を SVG で描く。1200x1200。
const W = 1200;
const defs = `
<defs>
  <filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity=".28"/></filter>
  <filter id="sh2" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#000" flood-opacity=".25"/></filter>
  <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="3"/><feColorMatrix values="0 0 0 0 .5  0 0 0 0 .5  0 0 0 0 .5  0 0 0 .18 0"/></filter>
  <filter id="wood"><feTurbulence type="fractalNoise" baseFrequency=".004 .09" numOctaves="3" seed="8"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.1 .75"/></filter>
  <filter id="soft"><feGaussianBlur stdDeviation="6"/></filter>
  <filter id="soft2"><feGaussianBlur stdDeviation="2"/></filter>
  <radialGradient id="vig" cx=".5" cy=".5" r=".75"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".38"/></radialGradient>
  <radialGradient id="plate" cx=".45" cy=".4" r=".7"><stop offset="0" stop-color="#fff"/><stop offset=".8" stop-color="#f1efe9"/><stop offset="1" stop-color="#ddd8ce"/></radialGradient>
  <radialGradient id="broth" cx=".45" cy=".4" r=".65"><stop offset="0" stop-color="#e9b062"/><stop offset="1" stop-color="#b8722c"/></radialGradient>
  <radialGradient id="curry" cx=".45" cy=".4" r=".7"><stop offset="0" stop-color="#b8701e"/><stop offset="1" stop-color="#7a4510"/></radialGradient>
  <radialGradient id="egg" cx=".4" cy=".35" r=".7"><stop offset="0" stop-color="#ffcf4a"/><stop offset="1" stop-color="#f08f12"/></radialGradient>
  <radialGradient id="bun" cx=".4" cy=".35" r=".75"><stop offset="0" stop-color="#e9a55a"/><stop offset=".85" stop-color="#b8661f"/><stop offset="1" stop-color="#8d4a14"/></radialGradient>
  <radialGradient id="latte" cx=".5" cy=".5" r=".55"><stop offset="0" stop-color="#d7a774"/><stop offset=".85" stop-color="#a8692f"/><stop offset="1" stop-color="#6f3f17"/></radialGradient>
  <radialGradient id="beer" cx=".45" cy=".4" r=".6"><stop offset="0" stop-color="#ffdb6e"/><stop offset="1" stop-color="#d98c10"/></radialGradient>
  <radialGradient id="matcha" cx=".45" cy=".4" r=".6"><stop offset="0" stop-color="#a9c46a"/><stop offset="1" stop-color="#5f7d2a"/></radialGradient>
  <radialGradient id="pancake" cx=".45" cy=".4" r=".6"><stop offset="0" stop-color="#e8a04c"/><stop offset=".85" stop-color="#c47524"/><stop offset="1" stop-color="#9c5617"/></radialGradient>
  <radialGradient id="tomato" cx=".45" cy=".4" r=".6"><stop offset="0" stop-color="#e2452f"/><stop offset="1" stop-color="#a82113"/></radialGradient>
</defs>`;

function table(kind) {
  const T = {
    oak: ['#c99a64', '#a8763f'], walnut: ['#6e4a2f', '#4a2f1c'], marble: ['#efedea', '#d9d5cf'],
    linen: ['#e7dfd2', '#cdbfa9'], slate: ['#4b4f55', '#33363b'], navy: ['#2f4058', '#1f2b3d'], mint: ['#cfe3d8', '#a9c9b7'],
  }[kind];
  let s = `<rect width="${W}" height="${W}" fill="${T[0]}"/>`;
  if (kind === 'oak' || kind === 'walnut') s += `<rect width="${W}" height="${W}" fill="${T[1]}" filter="url(#wood)"/>`;
  if (kind === 'marble') s += `<g opacity=".35" stroke="#b9b2a8" fill="none" stroke-width="3" filter="url(#soft2)"><path d="M-50 300 C 200 260 380 420 620 380 S 1000 200 1260 260"/><path d="M-40 900 C 300 860 420 980 700 930 S 1100 820 1260 870"/><path d="M200 -40 C 260 300 180 600 320 1240" stroke-width="2"/></g>`;
  if (kind === 'linen' || kind === 'mint' || kind === 'navy' || kind === 'slate') s += `<g opacity=".08" stroke="#000">${Array.from({ length: 60 }, (_, i) => `<path d="M0 ${i * 20} H${W}" stroke-width="1"/>`).join('')}</g>`;
  return s;
}

const circle = (cx, cy, r, fill, extra = '') => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" ${extra}/>`;
const rng = (seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647)(42);

function plate(cx, cy, r, rim = '#ffffff') {
  return `<g filter="url(#sh)">${circle(cx, cy, r, 'url(#plate)')}</g>${circle(cx, cy, r * 0.78, 'none', `stroke="#e3ded4" stroke-width="3"`)}${rim !== '#ffffff' ? circle(cx, cy, r - 6, 'none', `stroke="${rim}" stroke-width="10" opacity=".8"`) : ''}`;
}
function chopsticks(x, y, rot, color = '#7a4a24') {
  return `<g transform="translate(${x} ${y}) rotate(${rot})" filter="url(#sh2)"><rect x="0" y="0" width="560" height="16" rx="8" fill="${color}"/><rect x="0" y="34" width="560" height="16" rx="8" fill="${color}"/><rect x="380" y="-4" width="40" height="58" rx="10" fill="#e6dccb"/></g>`;
}
function spoon(x, y, rot) {
  return `<g transform="translate(${x} ${y}) rotate(${rot})" filter="url(#sh2)"><ellipse cx="0" cy="0" rx="60" ry="42" fill="#d9dcdf"/><ellipse cx="-6" cy="-6" rx="44" ry="28" fill="#eef0f2"/><rect x="50" y="-10" width="300" height="20" rx="10" fill="#cfd3d7"/></g>`;
}
function scallions(cx, cy, n, spread) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * spread;
    const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
    s += `<g transform="translate(${x} ${y}) rotate(${rng() * 360})"><ellipse rx="13" ry="9" fill="#5aa83a"/><ellipse rx="7" ry="4" fill="#cfe9a8"/></g>`;
  }
  return s;
}

const D = {};

D.ramen = () => table('walnut') + `
  ${chopsticks(760, 980, -28)}
  <g filter="url(#sh)">${circle(560, 560, 430, '#1f1f22')}</g>${circle(560, 560, 430, 'none', 'stroke="#b3261e" stroke-width="22"')}
  ${circle(560, 560, 375, 'url(#broth)')}
  <g stroke="#f6d989" stroke-width="13" fill="none" stroke-linecap="round" opacity=".95">
    ${Array.from({ length: 16 }, (_, i) => `<path d="M${330 + i * 8} ${640 + (i % 3) * 18} c 40 -40 80 40 120 0 s 80 -40 120 0 s 80 40 120 0"/>`).join('')}
  </g>
  ${[[700, 420], [770, 520]].map(([x, y]) => `<g transform="translate(${x} ${y})" filter="url(#sh2)"><circle r="95" fill="#c98757"/><circle r="80" fill="#f0c9a6"/><path d="M-60 -10 C -20 -50 30 -30 60 10" stroke="#c98757" stroke-width="8" fill="none"/></g>`).join('')}
  <g transform="translate(430 420) rotate(-20)" filter="url(#sh2)"><ellipse rx="95" ry="70" fill="#fffaf0"/><ellipse rx="52" ry="40" cx="6" fill="url(#egg)"/></g>
  <g filter="url(#sh2)"><rect x="300" y="250" width="120" height="250" rx="6" fill="#1d2b1d" transform="rotate(-25 360 375)"/><rect x="340" y="230" width="120" height="250" rx="6" fill="#243824" transform="rotate(-12 400 355)"/></g>
  <g transform="translate(560 440) rotate(12)"><ellipse rx="70" ry="22" fill="#f5e7c3"/><path d="M-50 0 a 50 14 0 0 0 100 0" stroke="#f08aa0" stroke-width="7" fill="none"/></g>
  ${scallions(560, 560, 28, 200)}
  <ellipse cx="460" cy="380" rx="250" ry="120" fill="#fff" opacity=".07" transform="rotate(-25 460 380)"/>`;

D.curry = () => table('oak') + `
  ${spoon(930, 960, -30)}
  <g filter="url(#sh)"><ellipse cx="560" cy="560" rx="470" ry="390" fill="url(#plate)"/></g>
  <ellipse cx="560" cy="560" rx="360" ry="290" fill="none" stroke="#e3ded4" stroke-width="3"/>
  <path d="M260 560 C 260 360 420 270 560 290 C 520 400 520 700 560 830 C 400 840 260 740 260 560 Z" fill="#fbf9f3"/>
  ${Array.from({ length: 70 }, () => `<ellipse cx="${300 + rng() * 230}" cy="${330 + rng() * 460}" rx="11" ry="6" fill="#efeadf" transform="rotate(${rng() * 180} 0 0)" opacity=".9"/>`).join('')}
  <path d="M560 290 C 760 280 890 420 880 570 C 870 720 740 840 560 830 C 520 700 520 400 560 290 Z" fill="url(#curry)"/>
  ${[[620, 420], [700, 560], [640, 700], [770, 680], [780, 450]].map(([x, y], i) => `<g transform="translate(${x} ${y}) rotate(${i * 37})"><rect x="-38" y="-30" width="76" height="60" rx="16" fill="${i % 2 ? '#e8892d' : '#e9c58a'}" opacity=".95"/></g>`).join('')}
  <g transform="rotate(-8 520 560)" filter="url(#sh2)">${[0, 1, 2, 3, 4].map(i => `<rect x="${420 + i * 66}" y="380" width="60" height="330" rx="12" fill="#c8862f"/><rect x="${428 + i * 66}" y="388" width="44" height="314" rx="8" fill="#e6a94c"/>`).join('')}
  ${Array.from({ length: 90 }, () => `<circle cx="${425 + rng() * 320}" cy="${385 + rng() * 320}" r="${3 + rng() * 4}" fill="#f6cf7f" opacity=".85"/>`).join('')}</g>
  <path d="M430 520 C 520 500 600 560 720 530" stroke="#5b300a" stroke-width="18" fill="none" opacity=".8" stroke-linecap="round"/>
  <g transform="translate(330 330)">${[0, 1, 2, 3, 4].map(i => `<ellipse cx="${i * 22}" cy="${i * 6}" rx="16" ry="10" fill="#d93a4a"/>`).join('')}</g>`;

D.sushi = () => table('slate') + `
  ${chopsticks(130, 1000, -8, '#2a2a2a')}
  <g filter="url(#sh)"><rect x="140" y="250" width="920" height="560" rx="18" fill="#c99a62"/></g>
  <rect x="140" y="250" width="920" height="560" rx="18" fill="#9c6f3c" filter="url(#wood)" opacity=".5"/>
  ${[['#f26b4b', '#fbb49f'], ['#d8233a', '#f06574'], ['#f0e6d6', '#ffffff'], ['#f6b445', '#ffe08a'], ['#f26b4b', '#fbb49f'], ['#9b1b2e', '#d24a5e']].map(([a, b], i) => {
    const x = 230 + (i % 3) * 290, y = 330 + Math.floor(i / 3) * 250;
    return `<g transform="translate(${x} ${y})" filter="url(#sh2)"><rect x="0" y="20" width="220" height="130" rx="60" fill="#f7f4ec"/><rect x="-6" y="0" width="232" height="140" rx="64" fill="${a}"/>
      ${[0, 1, 2, 3].map(k => `<path d="M${30 + k * 45} 10 q 20 60 -10 125" stroke="${b}" stroke-width="10" fill="none" opacity=".7"/>`).join('')}
      ${i === 2 ? '<rect x="95" y="-6" width="30" height="152" fill="#1d2b1d"/>' : ''}</g>`;
  }).join('')}
  <g transform="translate(980 940)" filter="url(#sh2)"><circle r="110" fill="#f4f1ec"/><circle r="80" fill="#3a1a0c"/><circle r="80" fill="#5a2a12" opacity=".5"/></g>
  <g transform="translate(940 300)"><path d="M0 0 q 40 -30 80 0 q -40 30 -80 0" fill="#a5c25a"/></g>
  <g transform="translate(870 760)"><ellipse rx="56" ry="26" fill="#f2c6c9"/><ellipse rx="40" ry="18" cx="10" fill="#f8dde0"/></g>`;

D.pancake = () => table('mint') + `
  <g transform="translate(980 980) rotate(-35)" filter="url(#sh2)"><rect x="-10" y="-10" width="340" height="20" rx="10" fill="#c9cdd1"/><rect x="-120" y="-30" width="120" height="60" rx="12" fill="#d9dcdf"/></g>
  ${plate(560, 560, 430)}
  ${[0, 1, 2].map(i => `<g filter="url(#sh2)">${circle(560 + i * 8, 560 - i * 14, 300 - i * 8, 'url(#pancake)')}</g>`).join('')}
  ${circle(576, 532, 270, '#d78a35', 'opacity=".5"')}
  <path d="M420 440 C 500 400 640 420 700 480 C 760 540 700 640 600 640 C 540 700 420 650 430 580 C 380 540 380 470 420 440 Z" fill="#8a4613" opacity=".75"/>
  <g transform="translate(590 500) rotate(8)" filter="url(#sh2)"><rect x="-55" y="-40" width="110" height="80" rx="10" fill="#fff3b8"/><rect x="-55" y="-40" width="110" height="26" rx="10" fill="#fff9d8"/></g>
  ${[[350, 820, '#3e2a6e'], [395, 850, '#4a3280'], [800, 300, '#c3132d'], [840, 340, '#d91e3a'], [330, 300, '#3e2a6e'], [860, 790, '#c3132d']].map(([x, y, c]) => `<g filter="url(#sh2)">${circle(x, y, 30, c)}${circle(x - 8, y - 8, 7, '#fff', 'opacity=".35"')}</g>`).join('')}
  <g transform="translate(320 720)">${[0, 1, 2].map(i => `<path d="M${i * 26} 0 q 12 -24 24 0 q -12 20 -24 0" fill="#5aa83a"/>`).join('')}</g>`;

D.latte = () => table('marble') + `
  <g transform="translate(870 860)" filter="url(#sh2)"><rect x="-150" y="-110" width="300" height="220" rx="16" fill="#f6efe2"/><path d="M-120 -60 h240 M-120 0 h200 M-120 60 h220" stroke="#d8cbb4" stroke-width="10"/></g>
  <g filter="url(#sh)">${circle(500, 500, 400, '#f7f5f0')}</g>${circle(500, 500, 330, 'none', 'stroke="#e3ded4" stroke-width="3"')}
  <g filter="url(#sh)">${circle(500, 500, 250, '#ffffff')}</g>
  <path d="M740 500 c 90 0 110 120 20 140" stroke="#fff" stroke-width="40" fill="none" stroke-linecap="round" filter="url(#sh2)"/>
  ${circle(500, 500, 215, 'url(#latte)')}
  <g fill="#fbf2e3" opacity=".95">
    <path d="M500 330 C 600 360 620 460 500 560 C 380 460 400 360 500 330 Z"/>
    ${[0, 1, 2, 3].map(i => `<path d="M${410 + i * 0} ${590 + i * 40} q 90 -40 180 0 q -90 30 -180 0" />`).join('')}
    <rect x="494" y="560" width="12" height="150" rx="6"/>
  </g>
  <g transform="translate(860 240) rotate(30)" filter="url(#sh2)"><rect x="-26" y="-90" width="52" height="180" rx="8" fill="#c9a26b"/><rect x="-26" y="-90" width="52" height="40" rx="8" fill="#fff"/></g>`;

D.gyoza = () => table('navy') + `
  ${chopsticks(130, 1000, -10, '#d5b48a')}
  <g filter="url(#sh)"><rect x="140" y="260" width="900" height="560" rx="60" fill="#f7f5f0"/></g>
  <rect x="180" y="300" width="820" height="480" rx="40" fill="none" stroke="#3e5d8a" stroke-width="8" opacity=".6"/>
  ${[0, 1, 2, 3, 4, 5].map(i => `<g transform="translate(${290 + i * 120} 540) rotate(${-8 + (i % 2) * 6})" filter="url(#sh2)">
    <path d="M-60 -170 C -110 -60 -110 70 -60 170 C 40 140 70 60 70 0 C 70 -60 40 -140 -60 -170 Z" fill="#f3e3c4"/>
    <path d="M-60 -170 C -100 -60 -100 70 -60 170 C -20 140 0 60 0 0 C 0 -60 -20 -140 -60 -170 Z" fill="#c17a2f"/>
    <path d="M-50 -150 C -80 -60 -80 60 -50 150" stroke="#8d4f18" stroke-width="10" fill="none" opacity=".55"/>
    ${[-110, -55, 0, 55, 110].map(y => `<path d="M40 ${y} q 30 10 30 30" stroke="#e1c99c" stroke-width="7" fill="none"/>`).join('')}</g>`).join('')}
  <g transform="translate(1000 960)" filter="url(#sh2)"><circle r="120" fill="#f7f5f0"/><circle r="92" fill="#4b1d0a"/><circle r="92" fill="#8a3d10" opacity=".4"/>${[0, 1, 2, 3, 4].map(i => `<circle cx="${-40 + i * 20}" cy="${(i % 2) * 20 - 10}" r="7" fill="#d9381e" opacity=".9"/>`).join('')}</g>`;

D.yakitori = () => table('walnut') + `
  <g filter="url(#sh)"><rect x="120" y="300" width="700" height="440" rx="26" fill="#1e1e20"/></g>
  ${[0, 1, 2, 3].map(i => `<g transform="translate(160 ${370 + i * 95}) rotate(-4)"><rect x="0" y="-6" width="640" height="12" rx="6" fill="#e2c799"/>
    ${[0, 1, 2, 3].map(k => `<g filter="url(#sh2)"><rect x="${70 + k * 120}" y="-40" width="100" height="80" rx="28" fill="${i === 1 ? '#5b8f2c' : '#8b4513'}"/><rect x="${76 + k * 120}" y="-34" width="88" height="40" rx="20" fill="${i === 1 ? '#7fb546' : '#b3632a'}"/>${i !== 1 ? `<path d="M${85 + k * 120} 10 q 35 -20 70 0" stroke="#4a1e05" stroke-width="7" fill="none" opacity=".7"/>` : ''}</g>`).join('')}</g>`).join('')}
  ${Array.from({ length: 40 }, () => `<circle cx="${200 + rng() * 560}" cy="${340 + rng() * 380}" r="3" fill="#fff" opacity=".7"/>`).join('')}
  <g filter="url(#sh)">${circle(930, 760, 200, '#f1f3f2')}</g>
  ${circle(930, 760, 175, 'url(#beer)')}
  ${circle(930, 760, 175, '#fffaf0', 'opacity=".0"')}
  <g fill="#fffaf0">${circle(930, 760, 150, '#fffaf0')}${Array.from({ length: 30 }, () => circle(830 + rng() * 200, 660 + rng() * 200, 6 + rng() * 14, '#fff')).join('')}</g>
  ${circle(930, 760, 150, 'none', 'stroke="#f2e2b6" stroke-width="8"')}
  <g transform="translate(980 260)" filter="url(#sh2)"><circle r="90" fill="#f7f5f0"/>${Array.from({ length: 10 }, (_, i) => `<path d="M${-50 + (i % 5) * 22} ${-30 + Math.floor(i / 5) * 40} q 10 -20 20 0" stroke="#3f7d22" stroke-width="12" fill="none" stroke-linecap="round"/>`).join('')}</g>`;

D.teishoku = () => table('oak') + `
  <g filter="url(#sh)"><rect x="70" y="120" width="1060" height="960" rx="30" fill="#2b2522"/></g>
  <rect x="100" y="150" width="1000" height="900" rx="20" fill="#3a302b"/>
  ${chopsticks(240, 960, 0, '#a46a35')}
  <g filter="url(#sh)">${circle(340, 700, 190, '#1f2a3f')}</g>${circle(340, 700, 160, '#fbfaf6')}
  ${Array.from({ length: 80 }, () => `<ellipse cx="${210 + rng() * 260}" cy="${570 + rng() * 260}" rx="11" ry="6" fill="#ebe6da" transform="rotate(${rng() * 180})" opacity=".0"/>`).join('')}
  ${Array.from({ length: 60 }, () => { const a = rng() * 6.28, d = Math.sqrt(rng()) * 140; return `<ellipse cx="${340 + Math.cos(a) * d}" cy="${700 + Math.sin(a) * d}" rx="11" ry="6" fill="#ebe6da" transform="rotate(${rng() * 180} ${340 + Math.cos(a) * d} ${700 + Math.sin(a) * d})"/>`; }).join('')}
  <g filter="url(#sh)">${circle(820, 700, 190, '#6b1e14')}</g>${circle(820, 700, 160, '#a8642a')}${circle(820, 700, 160, '#c98a3d', 'opacity=".5"')}
  ${[[780, 660], [850, 720], [800, 760], [860, 650]].map(([x, y]) => `<rect x="${x - 22}" y="${y - 22}" width="44" height="44" rx="6" fill="#f5efe1" opacity=".95"/>`).join('')}
  ${scallions(820, 700, 14, 110)}
  <g filter="url(#sh)"><rect x="210" y="200" width="620" height="260" rx="30" fill="#f2f0ea"/></g>
  <g transform="translate(520 330) rotate(-4)"><path d="M-250 0 C -150 -90 120 -90 200 -20 L 270 -70 L 260 0 L 270 70 L 200 20 C 120 90 -150 90 -250 0 Z" fill="#c9a170"/>
    <path d="M-240 0 C -150 -70 110 -70 190 -10" stroke="#8a5a2a" stroke-width="10" fill="none" opacity=".6"/>
    ${[-160, -90, -20, 50, 120].map(x => `<path d="M${x} -50 l 30 100" stroke="#5a3814" stroke-width="10" opacity=".55" stroke-linecap="round"/>`).join('')}<circle cx="-190" cy="-14" r="10" fill="#222"/></g>
  <g transform="translate(940 330)" filter="url(#sh2)"><rect x="-90" y="-70" width="180" height="140" rx="20" fill="#f2f0ea"/><rect x="-60" y="-40" width="120" height="80" rx="16" fill="#f6d22e"/><path d="M-60 -12 h120 M-60 14 h120" stroke="#e8b20c" stroke-width="6"/></g>`;

D.omurice = () => table('linen') + `
  ${spoon(950, 990, -40)}
  ${plate(560, 560, 440)}
  <g filter="url(#sh2)"><ellipse cx="560" cy="560" rx="330" ry="215" fill="url(#egg)" transform="rotate(-12 560 560)"/></g>
  <ellipse cx="520" cy="500" rx="220" ry="90" fill="#fff" opacity=".18" transform="rotate(-12 520 500)"/>
  <path d="M330 600 C 400 520 470 640 540 560 S 680 520 760 540" stroke="#c4221a" stroke-width="34" fill="none" stroke-linecap="round" filter="url(#sh2)"/>
  <path d="M330 600 C 400 520 470 640 540 560 S 680 520 760 540" stroke="#f05a48" stroke-width="10" fill="none" stroke-linecap="round" opacity=".7"/>
  <g transform="translate(800 820)">${[0, 1, 2, 3].map(i => `<path d="M${i * 22} 0 q 14 -36 30 0 q -16 26 -30 0" fill="#4e9a2c"/>`).join('')}</g>
  ${[[300, 820], [350, 850], [390, 820]].map(([x, y]) => circle(x, y, 30, 'url(#tomato)', 'filter="url(#sh2)"')).join('')}`;

D.burger = () => table('slate') + `
  <g filter="url(#sh)"><rect x="110" y="170" width="980" height="860" rx="40" fill="#b88a55"/></g>
  <rect x="110" y="170" width="980" height="860" rx="40" fill="#8f6533" filter="url(#wood)" opacity=".5"/>
  <g transform="translate(860 560)">${Array.from({ length: 12 }, (_, i) => `<rect x="${-110 + (i % 4) * 50}" y="${-200 + Math.floor(i / 4) * 140 + (i % 2) * 20}" width="36" height="200" rx="8" fill="#f2bf55" transform="rotate(${(i * 23) % 50 - 25})" filter="url(#sh2)"/>`).join('')}</g>
  <g filter="url(#sh)">${circle(470, 600, 330, '#5aa83a')}</g>
  ${circle(470, 600, 310, 'url(#bun)')}
  ${Array.from({ length: 45 }, () => { const a = rng() * 6.28, d = Math.sqrt(rng()) * 260; return `<ellipse cx="${470 + Math.cos(a) * d}" cy="${600 + Math.sin(a) * d}" rx="9" ry="5" fill="#fbf0d8" transform="rotate(${rng() * 180} ${470 + Math.cos(a) * d} ${600 + Math.sin(a) * d})"/>`; }).join('')}
  <ellipse cx="400" cy="500" rx="150" ry="80" fill="#fff" opacity=".15" transform="rotate(-25 400 500)"/>
  <g transform="translate(940 270)" filter="url(#sh2)"><circle r="70" fill="#f7f5f0"/><circle r="52" fill="#c4221a"/></g>`;

D.parfait = () => table('mint') + `
  <g filter="url(#sh)">${circle(560, 580, 360, '#e9f1ee', 'opacity=".9"')}</g>
  ${circle(560, 580, 330, '#d4e3dd')}
  ${circle(560, 580, 300, 'url(#matcha)')}
  ${[[460, 480], [660, 500], [560, 680], [450, 660], [680, 680]].map(([x, y]) => `<g filter="url(#sh2)">${circle(x, y, 70, '#fbf7ee')}${circle(x - 14, y - 14, 30, '#fff')}</g>`).join('')}
  <g filter="url(#sh2)">${circle(560, 570, 95, '#88a94a')}${circle(540, 550, 40, '#a8c46a')}</g>
  ${[[640, 400], [470, 760], [700, 780], [400, 560]].map(([x, y]) => `<g filter="url(#sh2)">${circle(x, y, 22, '#f6f1e6')}</g>`).join('')}
  ${[[620, 420], [500, 720], [740, 600]].map(([x, y]) => `<g filter="url(#sh2)"><ellipse cx="${x}" cy="${y}" rx="34" ry="24" fill="#5b2a1c"/></g>`).join('')}
  <g transform="translate(860 260) rotate(25)" filter="url(#sh2)"><rect x="-14" y="-160" width="28" height="320" rx="14" fill="#c9cdd1"/></g>`;

D.pasta = () => table('linen') + `
  <g transform="translate(980 960) rotate(-30)" filter="url(#sh2)"><rect x="-10" y="-10" width="320" height="18" rx="9" fill="#c9cdd1"/><g transform="translate(-60 -2)">${[0, 1, 2, 3].map(i => `<rect x="-80" y="${-26 + i * 14}" width="90" height="8" rx="4" fill="#d9dcdf"/>`).join('')}</g></g>
  ${plate(560, 560, 430)}
  <g stroke-linecap="round" fill="none">${Array.from({ length: 34 }, (_, i) => { const a = i * 0.55, r = 40 + i * 6.5; return `<path d="M${560 + Math.cos(a) * r} ${560 + Math.sin(a) * r} A ${r} ${r} 0 0 1 ${560 + Math.cos(a + 2.2) * r} ${560 + Math.sin(a + 2.2) * r}" stroke="${i % 2 ? '#f2c76b' : '#e8b54e'}" stroke-width="14"/>`; }).join('')}</g>
  <path d="M420 480 C 500 400 680 420 700 520 C 720 640 560 700 470 640 C 400 600 380 540 420 480 Z" fill="#c4271a" opacity=".85"/>
  ${[[500, 520], [600, 480], [620, 600], [520, 610]].map(([x, y]) => circle(x, y, 16, '#8f1a10', 'opacity=".7"')).join('')}
  ${[[560, 470], [640, 560], [500, 580]].map(([x, y]) => `<path d="M${x} ${y} q 20 -30 40 0 q -20 24 -40 0" fill="#3f8a23"/>`).join('')}
  ${Array.from({ length: 60 }, () => circle(380 + rng() * 360, 400 + rng() * 320, 4, '#fff8e6', 'opacity=".8"')).join('')}`;

function svg(name) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}" width="${W}" height="${W}">${defs}${D[name]()}
  <rect width="${W}" height="${W}" filter="url(#grain)"/><rect width="${W}" height="${W}" fill="url(#vig)"/></svg>`;
}
module.exports = { svg, names: Object.keys(D) };
