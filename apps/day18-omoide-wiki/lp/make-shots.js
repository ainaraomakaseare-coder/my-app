// LP（紹介ページ）用の画面画像を撮る。架空の人物「山田 花子」さんのデータを入れたアプリを、
// テスト用ブラウザ（Playwright）で開いて撮影する。AIの返事は台本どおりに返す偽物（本物のAIは使わない）。
// 使い方: NODE_PATH=<playwrightのnode_modules> node make-shots.js
// → img/ に chat.png・page.png・records.png・trip.png（あとで JPEG にして使う）
const path = require('path'), http = require('http'), fs = require('fs');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'work');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
// AIの台本：1回目は深掘り、2回目は深掘りをやめてあいづちだけ
const SCRIPT = [
  { done: false, followUp: '5月生まれなんですね！子どものころ、誕生日にはどんなお祝いをしてもらいましたか？', ack: '' },
  { done: true, followUp: '', ack: 'りんごの寒天、やさしい味が目に浮かびます。' },
];
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = http.createServer((req, res) => { const rel = decodeURIComponent(req.url.split('?')[0]); const file = path.join(ROOT, rel === '/' ? 'index.html' : rel); if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' }); res.end(fs.readFileSync(file)); });
  const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  let turn = 0;
  await ctx.route('https://mock-ai.invalid/**', (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.action === 'tts') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"upstream_error"}' });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(SCRIPT[Math.min(turn++, SCRIPT.length - 1)]) });
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.evaluate(() => {
    const W = window.OmoideWiki;
    const w = W.newWiki('person', '山田 花子', 'いつも笑顔の、みんなのおばあちゃん');
    w.infobox = W.parseInfoboxText('生年月日: 1942年5月10日\n出身: 長野県松本市\n職業: 元・小学校教諭\n家族: 夫、子ども3人、孫5人\n趣味: 押し花、合唱');
    const add = (cat, text, who, q, key) => w[cat].push(W.newEntry(text, who, q, key));
    add('history', '長野県松本市の、りんご農家に生まれました。5人きょうだいの3番目です。', '本人', '生まれた場所を教えてください', 'birth-place');
    add('history', '松本第一小学校に入学しました。冬は雪道を1時間かけて歩いて通いました。', '本人', '小学校の名前と、入学した年を教えてください', 'elementary-school');
    add('history', '1965年から、地元の小学校で38年間、先生をしていました。', '本人', '最初に働いた会社・職場の名前と、入った年を教えてください', 'first-job');
    add('personality', '困っている子を見ると放っておけない性格。卒業生から今も年賀状が届きます。', '長女', '誰かが困っているのを見て、実際にどう動いたか教えてください', 'personality-helped-someone');
    add('favorites', '野沢菜の漬物。冬になると、樽いっぱいに漬けて近所に配ります。', '本人', '一番好きな食べ物は何ですか？', 'favorite-food');
    add('skills', '押し花。公民館で20年、教室を開いています。', '本人', '得意なこと・自信のあることは何ですか？', 'skill-best');
    w.episodes.push(W.newEpisode({ title: '金婚式の温泉旅行', body: '家族12人で上高地へ。みんなで写真を撮りました。', author: '長男', period: '2015年秋' }));
    w.composed = {
      overview: '山田花子（1942年 - ）は、長野県松本市出身の元小学校教諭。38年にわたり地元の子どもたちを教え、退職後は公民館で押し花教室を開いている。',
      history: '・1942年、長野県松本市のりんご農家に、5人きょうだいの3番目として生まれる\n・松本第一小学校に入学。冬は雪道を1時間歩いて通学した\n・1965年、地元の小学校の教諭となり、以後38年間勤める\n・退職後、公民館で押し花教室を始める',
      personality: '困っている子どもを放っておけない面倒見のよい性格で、教え子からは今も年賀状が届く。',
      favorites: '', skills: ''
    };
    w.composedAt = new Date().toISOString();
    const tripId = W.findOrCreateTrip(w, '金婚式の温泉旅行');
    const trip = w.trips[0]; trip.startDate = '2015-10-10T08:00'; trip.endDate = '2015-10-11T17:00'; trip.lodging = '上高地の温泉旅館';
    w.episodes[0].tripId = tripId;
    const s1 = W.newStop({ tripId, date: '2015-10-10', time: '08:00', timeLabel: '松本駅に集合', type: '移動' });
    const s2 = W.newStop({ tripId, date: '2015-10-10', time: '12:00', timeLabel: '河童橋に到着', type: '観光' });
    const s3 = W.newStop({ tripId, date: '2015-10-10', time: '18:00', timeLabel: 'お祝いの夕食', type: '食事' });
    w.stops.push(s1, s2, s3);
    const d1 = W.newStopDetail({ stopId: s2.id, author: '長男', episode: '紅葉がちょうど見頃。おばあちゃんが一番はしゃいでいた。', comment: 'また来年も来たい', waitTime: '' });
    const d2 = W.newStopDetail({ stopId: s2.id, author: '孫・ゆい', episode: '私たちは先に大正池まで散歩した。', pricePerPerson: '' });
    const d3 = W.newStopDetail({ stopId: s3.id, author: '長女', episode: '50年分のありがとうを、手紙にして読んだ。みんな泣いた。', pricePerPerson: 12000 });
    W.rateStopDetail(d3, '長男', 5); W.rateStopDetail(d3, '孫・ゆい', 5);
    w.stopDetails.push(d1, d2, d3);
    w.contributors = ['本人', '長男', '長女', '孫・ゆい'];
    const st = { wikis: {}, currentId: w.id }; st.wikis[w.id] = w;
    localStorage.setItem(W.STORAGE_KEY, JSON.stringify(st));
    localStorage.setItem('omoide-wiki:pace', '5');
    localStorage.setItem('omoide-wiki:aiConsent', 'granted');
    localStorage.setItem('omoide-wiki:ivStyle', 'chat');
    localStorage.setItem('omoide-wiki:voicePref', 'off');
  });
  await page.reload();
  const setEndpoint = (url) => page.evaluate((u) => document.querySelector('meta[name="omoide-ai-endpoint"]').setAttribute('content', u), url);
  const shot = (name) => page.screenshot({ path: path.join(OUT, name + '.png') });
  await page.click('.wiki-card'); await page.waitForSelector('[data-screen=dash].active');

  // 1. チャットのインタビュー
  await setEndpoint('https://mock-ai.invalid/');
  await page.click('#tileInterview'); await page.waitForSelector('[data-screen=interview].active');
  const answer = async (text, aiCount) => {
    await page.fill('#qAnswer', text);
    await page.click('#btnSaveQ');
    await page.waitForFunction((n) => document.querySelectorAll('#chatLog .msg.ai:not(.typing)').length === n, aiCount);
  };
  await answer('昭和17年の5月10日です。', 2);
  await answer('母がりんごの寒天を作ってくれてね。それが毎年の楽しみでした。', 3);
  // スマホの画面なので、パソコン向けの「Ctrl＋Enterで送信」の案内は消しておく
  await page.evaluate(() => { document.getElementById('qAnswer').placeholder = 'ここに答えを書く（またはマイクで話す）'; document.getElementById('qMicStatus').textContent = ''; document.getElementById('ttsNote').textContent = ''; window.scrollTo(0, document.documentElement.scrollHeight); });
  await page.waitForTimeout(300);
  await shot('chat');
  await page.click('[data-screen="interview"] .back'); await page.waitForSelector('[data-screen=dash].active');
  await setEndpoint('');

  // 2. 完成ページ
  await page.click('#tileView'); await page.waitForSelector('[data-screen=view].active');
  await page.evaluate(() => { document.getElementById('composeNote').textContent = ''; document.getElementById('btnPrint').hidden = true; window.scrollTo(0, 0); });
  await shot('page');
  await page.click('[data-screen="view"] .back'); await page.waitForSelector('[data-screen=dash].active');

  // 3. 集まった記録（あとから書き直せる）
  await page.evaluate(() => { document.querySelector('.dash-section').scrollIntoView({ block: 'start' }); window.scrollBy(0, -12); });
  await shot('records');

  // 4. 過ごした一日
  await page.click('#tileTrips'); await page.waitForSelector('[data-screen=trips].active');
  await page.click('#tripsList .wiki-card'); await page.waitForSelector('[data-screen=tripDetail].active');
  await page.evaluate(() => { document.querySelector('.stops-section').scrollIntoView({ block: 'start' }); window.scrollBy(0, -12); });
  await shot('trip');
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
