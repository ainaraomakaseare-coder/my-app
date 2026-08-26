/*
 * 実ブラウザでの画面の流れを確認する。
 * 実行: node test/ui.smoke.js   （要 playwright）
 *
 * 親機（GM卓）と参加者の端末を別々のブラウザ文脈で開き、
 * 「別々の端末に別々の役職が出る」ところまで見る。
 */
const path = require('path');
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; }
  else { console.log('  NG  ' + name + (extra ? '  -> ' + extra : '')); fail++; }
}
const b64 = o => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const P = names => names.map((n, i) => ({ id: i, name: n[0], role: n[1], alive: true }));

function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
      const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function launch() {
  try { return await chromium.launch(); }
  catch (e) {
    const fallback = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(fallback)) return chromium.launch({ executablePath: fallback });
    throw e;
  }
}

(async () => {
  const { server, port } = await startServer();
  const BASE = `http://127.0.0.1:${port}/`;
  const browser = await launch();

  async function gmWith(players, opts) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    page.on('dialog', d => d.accept());
    await page.goto(BASE);
    await page.evaluate(({ players, opts }) => {
      localStorage.setItem('jinro.game.v1', JSON.stringify({
        players, day: 1, phase: 'distribute', distIndex: players.length - 1,
        opts, night: null, lastGuard: null, lastExecuted: null, lastVictim: null, winner: null
      }));
    }, { players, opts });
    await page.reload();
    await page.waitForSelector('#scDistribute.active');
    await page.click('#distNextBtn');
    await page.waitForSelector('#scNight.active');
    return page;
  }
  const label = p => p.textContent('#nightStepLabel');
  const pick = (p, n) => p.click(`#nightTargets .target:has-text("${n}")`);
  const targets = p => p.locator('#nightTargets .target').allTextContents();

  // ---- 設定から決着まで ----
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const gm = await ctx.newPage();
  const errors = [];
  gm.on('pageerror', e => errors.push(e.message));
  await gm.goto(BASE);

  await gm.fill('#namesInput', 'あきら\nかおり\nさとし\nちひろ\nなおき');
  check('人数を数える', (await gm.textContent('#playerCount')) === '5人');
  check('役職が揃うまで開始できない', await gm.isDisabled('#startBtn'));
  await gm.click('#autoBtn');
  check('おすすめ構成が入る', (await gm.textContent('#roleTotal')) === '5');
  check('開始できる', !(await gm.isDisabled('#startBtn')));

  await gm.click('#startBtn');
  await gm.waitForSelector('#scDistribute.active');
  const state = await gm.evaluate(() => JSON.parse(localStorage.getItem('jinro.game.v1')));
  check('5人に配られる', state.players.length === 5);
  check('QRが出る', (await gm.locator('#distQr svg').count()) === 1);

  // 参加者それぞれの端末
  const link = p => {
    const payload = { v: 1, n: p.name, r: p.role };
    const mates = state.players.filter(o => o.role === 'wolf' && o.id !== p.id).map(o => o.name);
    if (p.role === 'wolf' && mates.length) payload.f = mates;
    return BASE + '#p=' + b64(payload);
  };
  const wolf = state.players.find(p => p.role === 'wolf');
  const vill = state.players.find(p => p.role === 'villager');

  const wCtx = await browser.newContext(); const wPage = await wCtx.newPage();
  await wPage.goto(link(wolf));
  check('最初は役職が隠れている', !(await wPage.isVisible('#roleBody')));
  await wPage.click('#revealBtn');
  check('人狼の端末に人狼と出る', (await wPage.textContent('#roleName')) === '人狼');
  check('参加者画面にGM画面は出ない', !(await wPage.isVisible('#gmView')));

  const vCtx = await browser.newContext(); const vPage = await vCtx.newPage();
  await vPage.goto(link(vill));
  await vPage.click('#revealBtn');
  check('村人の端末に村人と出る', (await vPage.textContent('#roleName')) === '村人');
  check('★ 2台に別々の役職が出ている',
    (await wPage.textContent('#roleName')) !== (await vPage.textContent('#roleName')));

  for (let i = 0; i < 5; i++) await gm.click('#distNextBtn');
  await gm.waitForSelector('#scNight.active');
  check('配り終えると夜になる', true);
  check('JSエラーが出ていない', errors.length === 0, errors.join(' | '));

  // ---- 騎士の護衛と連続ガード禁止 ----
  {
    const p = await gmWith(P([['W','wolf'],['K','knight'],['S','seer'],['V1','villager'],['V2','villager']]),
      { firstNightPeace: false, noSameGuard: true });
    await pick(p, 'V1');                       // 襲撃
    await pick(p, 'V1');                       // 同じ人を守る
    await pick(p, 'V2');                       // 占い
    await p.click('#nightQrDoneBtn');
    await p.waitForSelector('#scDawn.active');
    check('★ 守られた人は死なない',
      (await p.textContent('#dawnMsg')).includes('誰も襲撃されませんでした'));

    await p.click('#dawnNextBtn');
    await p.click('#dayVoteBtn');
    await p.click('#voteNoneBtn');
    await p.click('#execNextBtn');
    await p.waitForSelector('#scNight.active');
    await pick(p, 'V2');
    check('★ 連続ガードは禁止される', !(await targets(p)).includes('V1'));
    await p.close();
  }

  // ---- 初日の襲撃なし ----
  {
    const p = await gmWith(P([['W','wolf'],['K','knight'],['S','seer'],['V1','villager'],['V2','villager']]),
      { firstNightPeace: true, noSameGuard: true });
    check('★ 初日は占い師だけ', (await label(p)).includes('占い師'));
    await p.close();
  }

  // ---- 狂人は「人狼ではない」と出る ----
  {
    const rCtx = await browser.newContext(); const rPage = await rCtx.newPage();
    await rPage.goto(BASE + '#r=' + b64({ v: 1, t: 'divine', d: 1, n: 'M', w: false }));
    await rPage.click('#resRevealBtn');
    check('★ 狂人の占い結果は人狼ではない', (await rPage.textContent('#resVerdict')) === '人狼ではない');
    await rPage.close();
  }

  // ---- 霊媒師 ----
  {
    const p = await gmWith(P([['W','wolf'],['R','medium'],['S','seer'],['V1','villager'],['V2','villager']]),
      { firstNightPeace: true, noSameGuard: true });
    await pick(p, 'V1');
    await p.click('#nightQrDoneBtn');
    await p.click('#dawnNextBtn');
    await p.click('#dayVoteBtn');
    await p.click('#voteTargets .target:has-text("V2")');
    await p.click('#execNextBtn');
    await p.waitForSelector('#scNight.active');
    await pick(p, 'V1');
    await pick(p, 'R');
    await p.click('#nightQrDoneBtn');
    check('★ 処刑の翌夜に霊媒師の番が来る', (await label(p)).includes('霊媒師'));
    await p.close();
  }

  // ---- 人狼側の勝利条件 ----
  {
    const p = await gmWith(P([['W','wolf'],['M','madman'],['V1','villager'],['V2','villager']]),
      { firstNightPeace: false, noSameGuard: true });
    await pick(p, 'V1');
    await p.waitForSelector('#scDawn.active');
    check('狂人は人狼として数えない', await p.isVisible('#scDawn.active'));
    await p.click('#dawnNextBtn');
    await p.click('#dayVoteBtn');
    await p.click('#voteNoneBtn');
    await p.click('#execNextBtn');
    await p.waitForSelector('#scNight.active');
    await pick(p, 'V2');
    await p.waitForSelector('#scResult.active');
    check('★ 人狼の数がそれ以上になれば人狼の勝ち',
      (await p.textContent('#winTitle')) === '人狼の勝ち');
    await p.close();
  }

  // ---- 壊れたリンク ----
  {
    const bCtx = await browser.newContext(); const bPage = await bCtx.newPage();
    await bPage.goto(BASE + '#p=こわれたデータ');
    check('壊れたリンクでも落ちない', (await bPage.textContent('body')).includes('読み取れませんでした'));
    await bPage.close();
  }

  await browser.close();
  server.close();
  console.log('\n' + pass + ' 件 通過 / ' + fail + ' 件 失敗');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('テストが落ちました:', e); process.exit(1); });
