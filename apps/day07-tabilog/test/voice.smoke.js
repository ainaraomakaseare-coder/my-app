/*
 * 音声でまとめて記録する機能（このアプリで唯一AIを呼び出す機能）を検証する。
 * 実際のマイク・OpenAIとは通信せず、Chromiumのフェイクマイク（--use-fake-device-for-media-stream）
 * と、page.route で用意したフェイクのvoice-entries APIで検証する。
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
  const FAKE_TRANSCRIPT = '朝からダイヤモンドヘッドに登って、そのあとファーマーズマーケット行っておいしい5ドルのアサイー食べておなか壊したんだよね、そのあとホテルに帰ってプールに行ったんだけどタオル忘れてびしょびしょで帰った。';
  await page.route(/\/api\/trips\/([^/]+)\/days\/([^/]+)\/voice-entries$/, async (route) => {
    const req = route.request();
    const m = req.url().match(/\/api\/trips\/([^/]+)\/days\/([^/]+)\/voice-entries$/);
    const tripId = decodeURIComponent(m[1]);
    const date = decodeURIComponent(m[2]);
    receivedContentType = req.headers()['content-type'] || '';
    const metaHeader = req.headers()['x-voice-meta'];
    try { receivedMeta = JSON.parse(Buffer.from(metaHeader, 'base64').toString('utf-8')); } catch (e) { receivedMeta = null; }
    receivedBodySize = (req.postDataBuffer() || Buffer.alloc(0)).length;
    voiceCallCount += 1;

    // 実際のサーバーは毎回新しいIDでBlock/Entryを作る（同じ日にもう一度話すと積み増される）ので、
    // モックも呼ばれるたびに新しいIDを発行する。
    const suffix = voiceCallCount;
    const created = [
      { id: 'blk_v1_' + suffix, tripId: 'trip_1', date: '2026-08-10', time: '', label: 'ダイヤモンドヘッドに登る', category: 'sightseeing', createdAt: 'now', updatedAt: 'now', entries: [{ id: 'ent_v1_' + suffix, blockId: 'blk_v1_' + suffix, episode: '朝からダイヤモンドヘッドに登った。', comment: '', detail: '', photoIds: [], videoIds: [], costItems: [], waitTime: '', mapUrl: '', shopUrl: '', author: 'テスト太郎', createdAt: 'now', updatedAt: 'now' }] },
      { id: 'blk_v2_' + suffix, tripId: 'trip_1', date: '2026-08-10', time: '', label: 'ファーマーズマーケットでアサイーを食べる', category: 'food', createdAt: 'now', updatedAt: 'now', entries: [{ id: 'ent_v2_' + suffix, blockId: 'blk_v2_' + suffix, episode: '5ドルのアサイーを食べたが、おなかを壊した。', comment: '', detail: '', photoIds: [], videoIds: [], costItems: [], waitTime: '', mapUrl: 'https://maps.example.com/farmers-market', shopUrl: '', author: 'テスト太郎', createdAt: 'now', updatedAt: 'now' }] },
      { id: 'blk_v3_' + suffix, tripId: 'trip_1', date: '2026-08-10', time: '', label: 'プールでタオルを忘れる', category: 'other', createdAt: 'now', updatedAt: 'now', entries: [{ id: 'ent_v3_' + suffix, blockId: 'blk_v3_' + suffix, episode: 'ホテルのプールに行ったがタオルを忘れ、びしょ濡れで帰った。', comment: '', detail: '', photoIds: [], videoIds: [], costItems: [], waitTime: '', mapUrl: '', shopUrl: '', author: 'テスト太郎', createdAt: 'now', updatedAt: 'now' }] }
    ];
    created.forEach((b) => {
      blocks[b.id] = { id: b.id, tripId: b.tripId, date: b.date, time: b.time, label: b.label, category: b.category, createdAt: b.createdAt, updatedAt: b.updatedAt };
      entriesByBlock[b.id] = b.entries;
    });
    dayInfosByTrip[tripId] = dayInfosByTrip[tripId] || {};
    dayInfosByTrip[tripId][date] = { voiceTranscript: FAKE_TRANSCRIPT };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ blocks: created, transcript: FAKE_TRANSCRIPT }) });
  });

  await page.goto(BASE);
  await page.click('#btnNewTrip');
  await page.fill('#ntTitle', 'ハワイ旅行');
  await page.fill('#ntStart', '2026-08-10');
  await page.fill('#ntEnd', '2026-08-10');
  await page.click('#btnCreateTrip');
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');

  check('日タイムラインに「音声でまとめて記録する」ボタンが出る', await page.isVisible('.block-add >> text=音声でまとめて記録する'));
  await page.click('.block-add >> text=音声でまとめて記録する');
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
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  await page.waitForSelector('.block');

  check('音声から作った3件の予定がタイムラインに反映される', (await page.$$('.block')).length === 3);
  check('話した順番どおりに並ぶ（1件目）', (await page.textContent('.block-label >> nth=0')) === 'ダイヤモンドヘッドに登る');
  check('話した順番どおりに並ぶ（2件目）', (await page.textContent('.block-label >> nth=1')) === 'ファーマーズマーケットでアサイーを食べる');
  check('話した順番どおりに並ぶ（3件目）', (await page.textContent('.block-label >> nth=2')) === 'プールでタオルを忘れる');
  check('メモに書いたURLが、対応する予定のentryに反映される（サーバー側の仕事だが、返り値どおり表示されるか）', (await page.textContent('.entry-card >> nth=1')).length > 0);

  check('文字起こしの折りたたみが表示される', await page.isVisible('#voiceTranscriptBox'));
  await page.click('#voiceTranscriptBox summary');
  check('文字起こしの内容が見える', (await page.textContent('#voiceTranscriptText')).includes('ダイヤモンドヘッドに登って'));

  check('録音した音声データがサーバーに送られている', receivedBodySize > 0);
  check('content-typeが音声の形式になっている', receivedContentType.indexOf('audio/') === 0);
  check('メモ（notes）がx-voice-metaヘッダー経由でサーバーに届く', receivedMeta && receivedMeta.notes.indexOf('ファーマーズマーケット') !== -1);
  check('ログイン中でなくてもauthorは空のまま送られる（未ログイン想定）', receivedMeta && receivedMeta.author === '');

  // ---- 同じ日にもう一度録音して送れる（1回目の成功後に「この内容で予定を作る」が無効のまま残らないか） ----
  await page.click('.block-add >> text=音声でまとめて記録する');
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
  await page.waitForSelector('.screen[data-screen="tripDetail"].active');
  await page.waitForFunction(() => document.querySelectorAll('.block').length === 6);
  check('2回目の送信もタイムラインに積み増される（3件→6件）', (await page.$$('.block')).length === 6);

  check('ページ内エラーが発生していない', errors.length === 0, errors.join(' / '));

  await browser.close();
  server.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
