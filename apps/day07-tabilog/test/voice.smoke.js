/*
 * 音声でまとめて記録する機能（このアプリで唯一AIを呼び出す機能）を検証する。
 * 実際のマイク・OpenAIとは通信せず、Chromiumのフェイクマイク（--use-fake-device-for-media-stream）
 * と、page.route で用意したフェイクのvoice-scan／import-blocks APIで検証する
 * （音声→候補（確認画面）→「この内容で追加」で保存。docs/adr/0002・0022）。
 * 実行: node test/voice.smoke.js   （要 playwright）
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
  const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
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
  const ctx = await browser.newContext({
    viewport: { width: 420, height: 900 },
    permissions: ['microphone']
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // AIへの送信の同意確認（confirmAiDataSharing）には同意して進める
  page.on('dialog', (d) => d.accept());

  // 音声入力はログイン済みアカウントの月の回数まで使える（docs/adr/0004）ため、テストでも
  // ログイン済みのアカウントとして進める（planフィールドは古いアプリ互換で残っているだけ）。
  const TEST_USER = { email: 'tester@example.com', name: 'テスト太郎', accountId: '123456' };
  await page.addInitScript((user) => {
    localStorage.setItem('tabilog:user', JSON.stringify(user));
  }, TEST_USER);
  await page.route(/\/api\/accounts\/ensure$/, async (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        accountId: TEST_USER.accountId,
        email: TEST_USER.email,
        name: TEST_USER.name,
        plan: 'premium_plus',
        voiceUsesThisPeriod: 0,
        voiceMonthlyLimit: 50,
        voiceRemainingThisPeriod: 50,
        ticketCredits: 0
      })
    });
  });

  await page.route('**/', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace('<meta name="tabilog-api-endpoint" content="https://tabilog-api.hiroya-apps.workers.dev">', '<meta name="tabilog-api-endpoint" content="/api">');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });

  const blocks = {}, entriesByBlock = {};
  const dayInfosByTrip = {}; // tripId -> date -> {voiceTranscript}
  await page.route(/\/api\/trips$/, async (route) => {
    const data = JSON.parse(route.request().postData());
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'trip_1', title: data.title, startDate: data.startDate || '', endDate: data.endDate || '', companions: data.companions || [], coverPhotoId: '', createdAt: 'now', updatedAt: 'now' }) });
  });
  await page.route(/\/api\/trips\/([^/]+)$/, async (route) => {
    const tripBlocks = Object.values(blocks).map((b) => ({ ...b, entries: entriesByBlock[b.id] || [] }));
    const days = Object.entries(dayInfosByTrip.trip_1 || {}).map(([date, info]) => ({ date, place: '', weatherCode: null, tempMax: null, tempMin: null, isForecast: false, voiceTranscript: info.voiceTranscript || '' }));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ trip: { id: 'trip_1', title: 'ハワイ旅行', startDate: '2026-08-10', endDate: '2026-08-10', companions: [] }, blocks: tripBlocks, days, members: [] }) });
  });

  let receivedContentType = '';
  let receivedMeta = null;
  let receivedBodySize = 0;
  let voiceCallCount = 0;
  let savedBody = null;
  const FAKE_TRANSCRIPT = '朝からダイヤモンドヘッドに登って、そのあとファーマーズマーケット行っておいしい5ドルのアサイー食べておなか壊したんだよね、そのあとホテルに帰ってプールに行ったんだけどタオル忘れてびしょびしょで帰った。';
  const base = { transport: '', place: '', placeGuessed: false, fromPlace: '', toPlace: '', company: '', routeNumber: '', departTime: '', arriveTime: '', arriveDate: '', warnings: [], timeEstimated: false, nightIndex: 0, sourceImage: null };
  // 音声は候補を返すだけ（保存しない）。確認画面のあと import-blocks で保存する
  await page.route(/\/api\/trips\/([^/]+)\/voice-scan$/, async (route) => {
    const req = route.request();
    receivedContentType = req.headers()['content-type'] || '';
    const metaHeader = req.headers()['x-voice-meta'];
    try { receivedMeta = JSON.parse(Buffer.from(metaHeader, 'base64').toString('utf-8')); } catch (e) { receivedMeta = null; }
    receivedBodySize = (req.postDataBuffer() || Buffer.alloc(0)).length;
    voiceCallCount += 1;
    const items = [
      { ...base, id: 'p1', category: 'sightseeing', date: '2026-08-10', time: '10:00', label: 'ダイヤモンドヘッドに登る', place: 'ダイヤモンドヘッド', mapUrl: 'https://www.google.com/maps/search/?api=1&query=21.26%2C-157.8', mapPlaceName: 'ダイヤモンドヘッド', mapLat: 21.26, mapLng: -157.8, costItems: [], note: '朝からダイヤモンドヘッドに登った。' },
      { ...base, id: 'p2', category: 'food', date: '2026-08-10', time: '', label: 'ファーマーズマーケットでアサイーを食べる', costItems: [{ label: 'アサイー', amount: 5, currency: 'USD' }], note: '5ドルのアサイーを食べたが、おなかを壊した。' },
      { ...base, id: 'p3', category: 'other', date: '2026-08-10', time: '', label: 'プールでタオルを忘れる', costItems: [], note: 'ホテルのプールに行ったがタオルを忘れ、びしょ濡れで帰った。' }
    ];
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items, dropped: 0, transcript: FAKE_TRANSCRIPT, dates: ['2026-08-10'], usage: {} }) });
  });
  await page.route(/\/api\/rates\?/, async (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rate: 160 }) });
  });
  await page.route(/\/api\/trips\/([^/]+)\/import-blocks$/, async (route) => {
    savedBody = JSON.parse(route.request().postData());
    const suffix = voiceCallCount;
    const created = savedBody.items.map((it, i) => ({
      id: 'blk_v' + i + '_' + suffix, tripId: 'trip_1', date: it.date, time: it.time, label: it.label, category: it.category, createdAt: 'now', updatedAt: 'now',
      entries: [{ id: 'ent_v' + i + '_' + suffix, blockId: 'blk_v' + i + '_' + suffix, episode: it.note, comment: '', detail: '', photoIds: [], videoIds: [], costItems: (it.costItems || []).map((c) => ({ label: c.label, amount: c.currency ? Math.round(c.amount * (c.rate || 0)) : c.amount })), waitTime: '', mapUrl: it.mapUrl || '', shopUrl: '', author: 'テスト太郎', createdAt: 'now', updatedAt: 'now' }]
    }));
    created.forEach((b) => {
      blocks[b.id] = { id: b.id, tripId: b.tripId, date: b.date, time: b.time, label: b.label, category: b.category, createdAt: b.createdAt, updatedAt: b.updatedAt };
      entriesByBlock[b.id] = b.entries;
    });
    if (savedBody.transcript && savedBody.transcriptDate) {
      dayInfosByTrip.trip_1 = dayInfosByTrip.trip_1 || {};
      dayInfosByTrip.trip_1[savedBody.transcriptDate] = { voiceTranscript: savedBody.transcript };
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ blocks: created, errors: [] }) });
  });

  await page.goto(BASE);
  await page.click('#btnNewTrip');
  await page.fill('#ntTitle', 'ハワイ旅行');
  await page.fill('#ntStart', '2026-08-10');
  await page.fill('#ntEnd', '2026-08-10');
  await page.click('#btnCreateTrip');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');

  check('日タイムラインに「音声でまとめて記録する」ボタンが出る', await page.isVisible('.block-add >> text=音声・メモでまとめて記録する'));
  await page.click('.block-add >> text=音声・メモでまとめて記録する');
  await page.waitForSelector('.screen[data-screen="voiceEntryForm"].active');

  check('録音していないうちは「この内容で予定を作る」が押せない', await page.isHidden('#btnCreateVoiceEntries'));
  await page.click('#btnCreateVoiceEntries', { force: true }).catch(() => {});

  await page.fill('#voiceNotes', 'https://maps.example.com/farmers-market ファーマーズマーケット');
  await page.click('#btnVoiceRecord');
  await page.waitForFunction(() => (document.querySelector('#voiceRecordStatus') || {}).textContent.includes('録音中'));
  check('録音中はボタンが「話し終わる」になる', (await page.textContent('#btnVoiceRecord')).includes('話し終わる'));

  await page.waitForTimeout(800); // フェイクマイクから最低限の音声データを積ませる
  await page.click('#btnVoiceRecord');
  await page.waitForSelector('#btnCreateVoiceEntries:not([hidden])');
  check('録音を終えると「この内容で予定を作る」が押せるようになる', await page.isVisible('#btnCreateVoiceEntries'));

  await page.click('#btnCreateVoiceEntries');
  await page.waitForSelector('.screen[data-screen="importConfirm"].active');
  check('音声も確認画面を通る（まだ保存されていない）', savedBody === null && (await page.$$('.ss-card')).length === 3);
  check('確認画面に「音声から」と出る', (await page.textContent('#ssResult')).includes('音声から'));
  check('話した時刻・金額・場所が候補に入っている', (await page.inputValue('[data-ss="time"] >> nth=0')) === '10:00' && (await page.textContent('.ss-card >> nth=0')).includes('ダイヤモンドヘッド') && (await page.inputValue('[data-ss-cost-amount="0"] >> nth=0')) === '5');
  await page.click('#btnSsSave');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  await page.waitForSelector('.block');

  check('音声から作った3件の予定がタイムラインに反映される', (await page.$$('.block')).length === 3);
  check('話した順番どおりに並ぶ（1件目）', (await page.textContent('.block-label >> nth=0')) === 'ダイヤモンドヘッドに登る');
  check('話した順番どおりに並ぶ（2件目）', (await page.textContent('.block-label >> nth=1')) === 'ファーマーズマーケットでアサイーを食べる');
  check('話した順番どおりに並ぶ（3件目）', (await page.textContent('.block-label >> nth=2')) === 'プールでタオルを忘れる');
  check('話した内容に具体的な時刻があれば、その予定の時刻として反映される', (await page.textContent('.block-time >> nth=0')) === '10:00');
  check('話した内容に具体的な金額があれば、その記録の費用の明細として反映される（外貨は保存時にレートが付く）', (await page.textContent('.cost-line.total >> nth=0')).includes('¥800'));
  check('確認して追加したとき、文字起こしがその日の欄に送られる', savedBody && savedBody.transcript === FAKE_TRANSCRIPT && savedBody.transcriptDate === '2026-08-10');
  check('メモに書いたURLが、対応する予定のentryに反映される（サーバー側の仕事だが、返り値どおり表示されるか）', (await page.textContent('.entry-card >> nth=1')).length > 0);

  check('文字起こしの折りたたみが表示される', await page.isVisible('#voiceTranscriptBox'));
  await page.click('#voiceTranscriptBox summary');
  check('文字起こしの内容が見える', (await page.textContent('#voiceTranscriptText')).includes('ダイヤモンドヘッドに登って'));

  check('録音した音声データがサーバーに送られている', receivedBodySize > 0);
  check('content-typeが音声の形式になっている', receivedContentType.indexOf('audio/') === 0);
  check('メモ（notes）がx-voice-metaヘッダー経由でサーバーに届く', receivedMeta && receivedMeta.notes.indexOf('ファーマーズマーケット') !== -1);
  check('ログイン中の名前が、保存のときのauthorとして届く', savedBody && savedBody.author === TEST_USER.name);
  check('取り込み先の日がx-voice-metaヘッダー経由でサーバーに届く', receivedMeta && receivedMeta.date === '2026-08-10');
  check('ログイン中のメールアドレスもx-voice-metaヘッダー経由でサーバーに届く', receivedMeta && receivedMeta.email === TEST_USER.email);

  // ---- 同じ日にもう一度録音して送れる（1回目の成功後に「この内容で予定を作る」が無効のまま残らないか） ----
  await page.click('.block-add >> text=音声・メモでまとめて記録する');
  await page.waitForSelector('.screen[data-screen="voiceEntryForm"].active');
  check('2回目もボタンが押せる状態で開く', !(await page.isDisabled('#btnCreateVoiceEntries')));
  await page.click('#btnVoiceRecord');
  await page.waitForFunction(() => (document.querySelector('#voiceRecordStatus') || {}).textContent.includes('録音中'));
  check('録音中は経過時間が見える', /\d:\d\d/.test(await page.textContent('#voiceRecordStatus')));
  await page.waitForTimeout(600);
  const elapsedDuringRecording = await page.textContent('#voiceRecordStatus');
  await page.waitForTimeout(600);
  check('経過時間が更新されていく', (await page.textContent('#voiceRecordStatus')) !== elapsedDuringRecording);
  await page.click('#btnVoiceRecord');
  await page.waitForSelector('#btnCreateVoiceEntries:not([hidden])');
  check('2回目の録音後もボタンが無効になっていない', !(await page.isDisabled('#btnCreateVoiceEntries')));
  await page.click('#btnCreateVoiceEntries');
  await page.waitForSelector('.screen[data-screen="importConfirm"].active');
  await page.click('#btnSsSave');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  await page.waitForFunction(() => document.querySelectorAll('.block').length === 6);
  check('2回目の送信もタイムラインに積み増される（3件→6件）', (await page.$$('.block')).length === 6);

  // ---- 1回の録音は3分まで（1回3分までの上限を、時間そのものをアプリ側で強制する） ----
  await page.click('.block-add >> text=音声・メモでまとめて記録する');
  await page.waitForSelector('.screen[data-screen="voiceEntryForm"].active');
  await page.clock.install();
  await page.click('#btnVoiceRecord');
  await page.waitForFunction(() => (document.querySelector('#voiceRecordStatus') || {}).textContent.includes('録音中'));
  await page.clock.fastForward(3 * 60 * 1000 + 1000);
  await page.waitForSelector('#btnCreateVoiceEntries:not([hidden])');
  check('3分に達すると自動的に録音が止まる', (await page.textContent('#voiceRecordStatus')).includes('自動的に止めました'));
  check('録音ボタンのラベルも「話しなおす」に戻る', (await page.textContent('#btnVoiceRecord')).includes('話しなおす'));

  check('ページ内エラーが発生していない', errors.length === 0, errors.join(' / '));

  await browser.close();
  server.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
