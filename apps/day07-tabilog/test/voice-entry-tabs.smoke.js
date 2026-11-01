/*
 * 「音声・メモでまとめて記録する」の画面が、入れ方のタブ（話す／メモを貼る／ChatGPTなど）で
 * 1つずつ出ることを確かめる（2026-11-01、「ごちゃごちゃして何をすればいいかわからない」を受けて）。
 * 実行: node test/voice-entry-tabs.smoke.js   （要 playwright）
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

function startServer() {
  return new Promise((resolve) => {
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
  const args = [];
  try { return await chromium.launch({ args }); }
  catch (e) {
    const fallback = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(fallback)) return chromium.launch({ executablePath: fallback, args });
    throw e;
  }
}

(async () => {
  const { server, port } = await startServer();
  const BASE = `http://127.0.0.1:${port}/`;
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'ja-JP' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());

  const TEST_USER = { email: 'tester@example.com', name: 'テスト太郎', accountId: '123456' };
  await page.addInitScript((user) => {
    localStorage.setItem('tabilog:user', JSON.stringify(user));
    localStorage.setItem('tabilog.tutorialDone', '1');
    localStorage.setItem('tabilog.tutorialTripDone', '1');
  }, TEST_USER);
  await page.route(/\/api\/accounts\/ensure$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ accountId: TEST_USER.accountId, email: TEST_USER.email, name: TEST_USER.name, memoRemainingThisPeriod: 4, voiceRemainingThisPeriod: 3, memoMonthlyLimit: 5, voiceMonthlyLimit: 5, ticketCredits: 0 })
  }));
  await page.route('**/', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace('<meta name="tabilog-api-endpoint" content="https://tabilog-api.hiroya-apps.workers.dev">', '<meta name="tabilog-api-endpoint" content="/api">');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });
  await page.route(/\/api\/trips$/, (route) => {
    const data = JSON.parse(route.request().postData());
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'trip_1', title: data.title, startDate: data.startDate, endDate: data.endDate, companions: [], coverPhotoId: '', createdAt: 'now', updatedAt: 'now' }) });
  });
  await page.route(/\/api\/trips\/([^/]+)$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ trip: { id: 'trip_1', title: '京都', startDate: '2026-08-28', endDate: '2026-08-29', companions: [] }, blocks: [], days: [], members: [] })
  }));
  const shown = () => page.evaluate(() => ({
    voice: !document.querySelector('#vePanelVoice').hidden,
    memo: !document.querySelector('#vePanelMemo').hidden,
    ai: !document.querySelector('#vePanelAi').hidden,
    selected: Array.from(document.querySelectorAll('.ve-tab[aria-selected="true"]')).map((b) => b.dataset.veTab)
  }));
  const openSheet = async (cls) => {
    await page.click('.block-add-bulk');
    await page.click(cls);
    await page.waitForSelector('.screen[data-screen="voiceEntryForm"].active');
  };
  const back = async () => {
    await page.click('.screen[data-screen="voiceEntryForm"] [data-back="tripDetail"]');
    await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  };

  await page.goto(BASE);
  await page.click('#btnNewTrip');
  await page.fill('#ntTitle', '京都');
  await page.fill('#ntStart', '2026-08-28');
  await page.fill('#ntEnd', '2026-08-29');
  await page.click('#btnCreateTrip');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');

  // ---- 最初は「話す」だけが出る ----
  await openSheet('.block-add-voice');
  let s = await shown();
  check('最初は「話す」タブだけが出る', s.voice && !s.memo && !s.ai && s.selected.join() === 'voice', JSON.stringify(s));
  check('話すタブに録音ボタンが見える', await page.isVisible('#btnVoiceRecord'));
  check('メモ欄・お願い文のボタンは見えない', (await page.isHidden('#textMemoInput')) && (await page.isHidden('#btnCopyAiPrompt')));
  check('URL・お店の名前の欄は最初は畳まれている', await page.isHidden('#voiceNotes'));
  await page.waitForFunction(() => /あと3回/.test(document.querySelector('#voiceAiInfo').textContent));
  check('話すタブに音声入力の残り回数（月5回まで無料）が出る', /音声入力：あと3回（月5回まで無料）/.test(await page.textContent('#voiceAiInfo')));

  // ---- タブを切り替える ----
  await page.click('#veTabMemo');
  s = await shown();
  check('「メモを貼る」を押すとメモだけが出る', !s.voice && s.memo && !s.ai && s.selected.join() === 'memo', JSON.stringify(s));
  check('メモタブにメモのAI整理の残り回数が出る', /あと4回（月5回まで）/.test(await page.textContent('#memoAiInfo')));
  check('長い書き方の説明は畳まれている', await page.isHidden('.memo-help'));
  await page.click('#veTabAi');
  s = await shown();
  check('「ChatGPTなど」を押すとお願い文の手順だけが出る', !s.voice && !s.memo && s.ai && (await page.isVisible('#btnCopyAiPrompt')), JSON.stringify(s));

  // ---- 最後に選んだタブを覚えている ----
  await back();
  await openSheet('.block-add-voice');
  s = await shown();
  check('次に開いたときは前回のタブ（ChatGPTなど）から始まる', s.ai && !s.voice, JSON.stringify(s));

  // ---- 「ChatGPTなど他のAIに頼む」から開くとそのタブ ----
  await page.click('#veTabVoice');
  await back();
  await openSheet('.block-add-other-ai');
  s = await shown();
  check('まとめての一覧の「ChatGPTなど他のAIに頼む」からはChatGPTなどのタブで開く', s.ai && !s.voice, JSON.stringify(s));

  // ---- メモタブから無料の取り込みがこれまでどおりできる ----
  await page.click('#veTabMemo');
  await page.fill('#textMemoInput', '10時 東京駅\n13時 清水寺\n抹茶パフェを食べた');
  await page.click('#btnCreateTextEntries');
  await page.waitForSelector('.screen[data-screen="importConfirm"].active');
  check('メモタブの「この内容で予定を作る」で確認画面へ進む', await page.isVisible('.screen[data-screen="importConfirm"]'));

  check('ページでエラーが出ていない', errors.length === 0, errors.join(' / '));
  console.log(`voice-entry-tabs.smoke: ${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
