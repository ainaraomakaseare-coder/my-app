/*
 * 実ブラウザでの画面の流れを確認する（作成→インタビュー→エピソード追加→
 * 基本情報編集→完成ページ表示→書き出し→読み込みで合体→削除）。
 * 実行: node test/ui.smoke.js   （要 playwright）
 */
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; }
  else { console.log('  NG  ' + name + (extra ? '  -> ' + extra : '')); fail++; }
}

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

// 1x1のPNG（アップロード動作の確認用）
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

(async () => {
  const { server, port } = await startServer();
  const BASE = `http://127.0.0.1:${port}/`;
  const browser = await launch();

  const tmpPhoto = path.join(os.tmpdir(), 'omoide-wiki-test.png');
  fs.writeFileSync(tmpPhoto, TINY_PNG);

  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  let dismissNextConfirm = false;
  let lastDismissedMessage = '';
  let promptQueue = [];
  page.on('dialog', d => {
    if (dismissNextConfirm && d.type() === 'confirm') {
      dismissNextConfirm = false;
      lastDismissedMessage = d.message();
      d.dismiss();
    } else if (d.type() === 'prompt' && promptQueue.length) {
      d.accept(promptQueue.shift());
    } else {
      d.accept();
    }
  });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE);
  // index.html には本番用のWorker URLが書かれているため、AI深掘りを検証する節より前では
  // 空にしておく（テストを本番のWorkerに依存させない・実際のAPI呼び出しを避けるため）
  await page.evaluate(() => {
    document.querySelector('meta[name="omoide-ai-endpoint"]').setAttribute('content', '');
  });

  // ---- 一覧が空の状態 ----
  check('最初は「まだ何もありません」', (await page.textContent('#wikiList')).indexOf('まだ何もありません') !== -1);

  // ---- 新規作成 ----
  await page.click('#btnNewWiki');
  await page.check('input[name=newType][value=person]');
  await page.fill('#newTitle', 'やまだ たろう');
  await page.fill('#newSubtitle', 'いつも笑っていた父');
  await page.click('#btnCreateWiki');
  await page.waitForSelector('[data-screen=dash].active');
  check('作成後はダッシュボードにタイトルが出る', (await page.textContent('#dashTitle')) === 'やまだ たろう');

  // ---- インタビュー：1問だけ答えて戻る ----
  await page.click('#tileInterview');
  await page.waitForSelector('[data-screen=interview].active');
  check('マイクボタンが表示される（対応の有無はブラウザ依存）', await page.locator('#qMicBtn').count() === 1);
  check('AIエンドポイント未設定時はAI深掘りトグルが隠れている', await page.isHidden('#aiDeepenBlock'));
  check('音声で会話するは初回からONになっている', await page.isChecked('#voiceModeToggle'));
  check('最初の質問は生い立ち・経歴カテゴリから始まる', (await page.textContent('#qCategory')).indexOf('生い立ち・経歴') !== -1);
  const firstQuestion = await page.textContent('#qText');
  await page.fill('#qAnswer', '几帳面で、誰にでも敬語で話す人でした');
  await page.setInputFiles('#qPhotos', [tmpPhoto]);
  await page.waitForFunction(() => document.querySelectorAll('#qPhotoPreview img').length === 1);
  check('インタビューの回答にも写真を添えられる', true);
  await page.click('#btnSaveQ');
  await page.waitForFunction(() => document.getElementById('qText').textContent.length > 0);
  const secondQuestion = await page.textContent('#qText');
  check('次の質問に進む', secondQuestion !== firstQuestion);
  check('次の質問では写真プレビューがリセットされる', await page.locator('#qPhotoPreview img').count() === 0);

  // ---- 前の質問に戻る：直前の回答を取り消して答え直せる ----
  check('1問答えた後は「前の質問に戻る」が押せる', !(await page.isDisabled('#btnPrevQ')));
  await page.click('#btnPrevQ');
  await page.waitForFunction((q) => document.getElementById('qText').textContent === q, firstQuestion);
  check('前の質問に戻ると質問文も戻る', (await page.textContent('#qText')) === firstQuestion);
  check('前の質問に戻ると回答欄に直前の回答が戻る', (await page.inputValue('#qAnswer')) === '几帳面で、誰にでも敬語で話す人でした');
  check('最初の質問まで戻ると「前の質問に戻る」は押せない', await page.isDisabled('#btnPrevQ'));
  await page.click('#btnSaveQ');
  await page.waitForFunction((q) => document.getElementById('qText').textContent === q, secondQuestion);
  check('戻ってから保存し直すと元通り次の質問に進む', (await page.textContent('#qText')) === secondQuestion);

  // 音声をオフにして戻り、次にインタビューを開いたときもオフのままであること（毎回オンに戻らない）
  await page.uncheck('#voiceModeToggle');
  await page.click('[data-screen="interview"] .back');
  await page.waitForSelector('[data-screen=dash].active');
  check('回答がダッシュボードの記録に反映される', (await page.textContent('#entryList')).indexOf('几帳面で') !== -1);
  await page.click('#tileInterview');
  await page.waitForSelector('[data-screen=interview].active');
  check('一度オフにすると、次に開いたときもオフのまま覚えている', !(await page.isChecked('#voiceModeToggle')));
  check('既に答えた質問はインタビューを開き直しても出てこない', (await page.textContent('#qText')) !== firstQuestion);
  await page.check('#voiceModeToggle');
  await page.click('[data-screen="interview"] .back');
  await page.waitForSelector('[data-screen=dash].active');
  check('回答がダッシュボードの記録に反映される', (await page.textContent('#entryList')).indexOf('几帳面で') !== -1);

  // ---- 質問をとばすと、答えていなくても二度と出てこない ----
  await page.click('#tileInterview');
  await page.waitForSelector('[data-screen=interview].active');
  const skipQuestion = await page.textContent('#qText');
  await page.click('#btnSkipQ');
  await page.waitForFunction((q) => document.getElementById('qText').textContent !== q, skipQuestion);
  await page.click('[data-screen="interview"] .back');
  await page.waitForSelector('[data-screen=dash].active');
  await page.click('#tileInterview');
  await page.waitForSelector('[data-screen=interview].active');
  check('とばした質問は、インタビューを開き直しても二度と出てこない', (await page.textContent('#qText')) !== skipQuestion);
  await page.click('[data-screen="interview"] .back');
  await page.waitForSelector('[data-screen=dash].active');

  // ---- エピソード追加（写真つき） ----
  await page.click('#tileEpisode');
  await page.waitForSelector('[data-screen=episode].active');
  await page.fill('#epTitle', '雨の遠足で全員ずぶ濡れになった話');
  await page.fill('#epBody', 'バスが来なくて、みんなで歌いながら歩いた');
  await page.fill('#epAuthor', '花子');
  await page.fill('#epPeriod', '2019年秋');
  await page.fill('#epTrip', '秋の遠足');
  await page.fill('#epParticipants', '次郎, 三郎');
  await page.setInputFiles('#epPhotos', [tmpPhoto, tmpPhoto]);
  await page.waitForFunction(() => document.querySelectorAll('#epPhotoPreview img').length === 2);
  await page.click('#epPhotoPreview .rm button');
  await page.waitForFunction(() => document.querySelectorAll('#epPhotoPreview img').length === 1);
  check('写真の削除ボタンでプレビューが1枚に減る（arguments.callee 回帰確認）', true);
  await page.click('#btnSaveEpisode');
  await page.waitForSelector('[data-screen=dash].active');
  check('エピソードが記録に増える', (await page.textContent('#entryList')).indexOf('雨の遠足') !== -1);
  check('サムネイルが表示される', await page.locator('#entryList .thumbs img').count() > 0);
  check('旅行名がダッシュボードの記録に表示される', (await page.textContent('#entryList')).indexOf('秋の遠足') !== -1);

  // ---- 旅行・イベントでまとめる ----
  await page.click('#tileTrips');
  await page.waitForSelector('[data-screen=trips].active');
  check('旅行名がまとめ画面の一覧に出る', (await page.textContent('#tripsList')).indexOf('秋の遠足') !== -1);
  check('参加者（書いた人＋その場にいた人）が一覧に出る', (await page.textContent('#tripsList')).indexOf('花子') !== -1 && (await page.textContent('#tripsList')).indexOf('次郎') !== -1);
  check('エピソードの「いつ頃」から旅行の時期が自動で補われ、年代の見出しが出る', (await page.textContent('#tripsList')).indexOf('2010年代') !== -1);
  await page.click('.wiki-card:has-text("秋の遠足")');
  await page.waitForSelector('[data-screen=tripDetail].active');
  check('詳細画面にタイトルが出る', (await page.textContent('#tripDetailTitle')) === '秋の遠足');
  check('詳細画面に時期が出る', (await page.textContent('#tripDetailPeriod')).indexOf('2019年秋') !== -1);
  check('詳細画面にだれがいたかが出る', (await page.textContent('#tripDetailParticipants')).indexOf('三郎') !== -1);
  check('詳細画面にエピソードが出る', (await page.textContent('#tripDetailEpisodes')).indexOf('雨の遠足') !== -1);

  // ---- 旅行の名前・時期を変更すると、一覧・詳細の両方に反映される（Tripが実体だから） ----
  promptQueue = ['2019年秋の遠足', '2023年1月'];
  await page.click('#btnRenameTrip');
  await page.waitForFunction(() => document.getElementById('tripDetailTitle').textContent === '2019年秋の遠足');
  check('名前を変更すると詳細画面のタイトルが変わる', (await page.textContent('#tripDetailTitle')) === '2019年秋の遠足');
  check('時期を変更すると詳細画面にも反映される', (await page.textContent('#tripDetailPeriod')).indexOf('2023年1月') !== -1);
  await page.click('[data-screen="tripDetail"] .back');
  await page.waitForSelector('[data-screen=trips].active');
  check('名前を変更すると一覧にも反映される', (await page.textContent('#tripsList')).indexOf('2019年秋の遠足') !== -1);
  check('時期を変更すると年代の見出しも変わる', (await page.textContent('#tripsList')).indexOf('2020年代') !== -1);

  // ---- 旅行の詳細画面から直接エピソードを追加すると、旅行名が引き継がれ、保存後もその旅行に戻る ----
  await page.click('.wiki-card:has-text("2019年秋の遠足")');
  await page.waitForSelector('[data-screen=tripDetail].active');
  await page.click('#btnAddTripEpisode');
  await page.waitForSelector('[data-screen=episode].active');
  check('旅行の詳細から追加すると、旅行名が引き継がれている', (await page.inputValue('#epTrip')) === '2019年秋の遠足');
  await page.fill('#epTitle', '2日目の朝ごはん');
  await page.fill('#epBody', 'みんなでパン屋に行った');
  await page.click('#btnSaveEpisode');
  await page.waitForSelector('[data-screen=tripDetail].active');
  check('保存後はダッシュボードではなく、同じ旅行の詳細画面に戻る', (await page.textContent('#tripDetailTitle')) === '2019年秋の遠足');
  check('追加したエピソードが同じ旅行の中に増える', (await page.textContent('#tripDetailEpisodes')).indexOf('2日目の朝ごはん') !== -1);

  // ダッシュボードの「エピソードを追加する」から開いたときは、旅行名は引き継がれない（誤って
  // 直前の旅行に紐づかないように、正しくリセットされることを確認する）
  await page.click('[data-screen="tripDetail"] .back');
  await page.waitForSelector('[data-screen=trips].active');
  await page.click('[data-screen="trips"] .back');
  await page.waitForSelector('[data-screen=dash].active');
  await page.click('#tileEpisode');
  await page.waitForSelector('[data-screen=episode].active');
  check('ダッシュボードから開くと旅行名は空のまま', (await page.inputValue('#epTrip')) === '');
  await page.click('#btnEpisodeBack');
  await page.waitForSelector('[data-screen=dash].active');

  // ---- 基本情報編集 ----
  await page.click('#tileProfile');
  await page.waitForSelector('[data-screen=profile].active');
  await page.fill('#pfInfobox', '生年月日: 1955年3月3日\n出身: 京都府');
  await page.fill('#pfOverview', '誰にでも優しく、家族思いだった父。');
  await page.click('#btnSaveProfile');
  await page.waitForSelector('[data-screen=dash].active');

  // ---- 完成ページ ----
  await page.click('#tileView');
  await page.waitForSelector('[data-screen=view].active');
  check('完成ページに名前が出る', (await page.textContent('#wikiPage h1')) === 'やまだ たろう');
  check('概要文が反映される', (await page.textContent('.wp-main')).indexOf('家族思い') !== -1);
  check('プロフィール表に出身が出る', (await page.textContent('.wp-infobox')).indexOf('京都府') !== -1);
  check('エピソードのアルバムに写真が出る', await page.locator('.wp-card img').count() > 0);
  check('年表にエピソードが出る', (await page.textContent('.wp-timeline')).indexOf('雨の遠足') !== -1);
  check('旅行名の見出しでアルバムがまとまる', (await page.textContent('.wp-trip-title')) === '2019年秋の遠足');
  check('目次に生い立ち・経歴が出る', (await page.textContent('.wp-toc')).indexOf('生い立ち・経歴') !== -1);
  check('人物像・性格の回答に、答えた質問文がラベルとして表示される', (await page.textContent('.wp-main')).indexOf('几帳面で') !== -1 && (await page.locator('.wp-list .q').count()) > 0);

  // ---- 書き出し ----
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('[data-screen="view"] .back').then(() => page.click('#btnExportWiki'))
  ]);
  const exportPath = await download.path();
  const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  check('書き出しJSONにschemaがある', exported.schema === 'omoide-wiki');
  check('書き出しJSONにWikiが1件入る', exported.wikis.length === 1);
  const wikiId = exported.wikis[0].id;

  // ---- 別の人が書いた分を読み込んで合体する ----
  const mergedPayload = JSON.parse(JSON.stringify(exported));
  mergedPayload.wikis[0].episodes.push({
    id: 'ep_from_another_device', title: '合宿での出来事', body: 'カラオケで熱唱していた',
    photos: [], author: '鈴木', period: '2020年', tags: [], prompt: '', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z'
  });
  const importPath = path.join(os.tmpdir(), 'omoide-wiki-import.json');
  fs.writeFileSync(importPath, JSON.stringify(mergedPayload));
  await page.click('[data-screen="dash"] .back');
  await page.waitForSelector('[data-screen=home].active');
  await page.setInputFiles('#fileImport', importPath);
  await page.waitForFunction(() => (document.getElementById('homeStatus').textContent || '').indexOf('読み込み完了') !== -1);
  check('合体件数が表示される', (await page.textContent('#homeStatus')).indexOf('合体 1件') !== -1);

  await page.click(`.wiki-card:has-text("やまだ たろう")`);
  await page.waitForSelector('[data-screen=dash].active');
  await page.click('#tileView');
  check('合体後、相手のエピソードも見える', (await page.textContent('.wp-main')).indexOf('カラオケ') !== -1);
  check('自分のエピソードも失われていない', (await page.textContent('.wp-main')).indexOf('雨の遠足') !== -1);

  // ---- AI深掘り（フェイクのWorkerを立てて模擬する） ----
  let aiCallCount = 0;
  let lastAiPayload = null;
  const aiServer = http.createServer((req, res) => {
    const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type' };
    if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders); return res.end(); }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      aiCallCount++;
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (e) { /* noop */ }
      if (parsed.action !== 'compose') lastAiPayload = parsed;
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        if (parsed.action === 'compose') {
          res.end(JSON.stringify({
            overview: 'AIがまとめた概要です。',
            history: '・1955年3月3日、京都府で生まれる\n・雨の遠足で全員ずぶ濡れになった',
            personality: 'AIがまとめた人物像の文章です。',
            favorites: '', skills: '',
            episodes: (parsed.episodes || []).map(ep => ({ id: ep.id, text: 'AIが整えた文章：' + ep.body }))
          }));
        } else {
          res.end(JSON.stringify({ done: false, followUp: 'AIの追い質問' + aiCallCount }));
        }
      }, 150);
    });
  });
  const aiPort = await new Promise(resolve => aiServer.listen(0, '127.0.0.1', () => resolve(aiServer.address().port)));
  await page.evaluate((url) => {
    document.querySelector('meta[name="omoide-ai-endpoint"]').setAttribute('content', url);
  }, `http://127.0.0.1:${aiPort}/`);

  await page.click('[data-screen="view"] .back');
  await page.waitForSelector('[data-screen=dash].active');
  await page.click('#tileInterview');
  await page.waitForSelector('[data-screen=interview].active');
  check('AIエンドポイント設定時はAI深掘りトグルが表示される', !(await page.isHidden('#aiDeepenBlock')));
  check('AI深掘りはWorker設定済みなら初回からONになっている', await page.isChecked('#aiDeepenToggle'));

  await page.fill('#qAnswer', '最初の回答です');
  await page.click('#btnSaveQ');
  check('AI呼び出し中はボタンが無効化される', await page.isDisabled('#btnSaveQ'));
  await page.waitForFunction(() => (document.getElementById('qText').textContent || '').indexOf('AIの追い質問1') !== -1);
  check('1回目のAI追い質問が次の質問として表示される', true);
  check('AIへのリクエストに、同じカテゴリで既に答えた質問の一覧が含まれる（同じ質問の再生成を防ぐため）',
    Array.isArray(lastAiPayload.askedQuestions) && lastAiPayload.askedQuestions.length >= 1);

  // MAX_AI_DEPTH(6)に達するまで追い質問が続くことを確認する（2回目〜6回目）
  for (let depth = 2; depth <= 6; depth++) {
    await page.fill('#qAnswer', '深掘り回答' + (depth - 1));
    await page.click('#btnSaveQ');
    await page.waitForFunction((d) => (document.getElementById('qText').textContent || '').indexOf('AIの追い質問' + d) !== -1, depth);
  }
  check('depth6までは追い質問が続く', (await page.textContent('#qCategory')).indexOf('AIの深掘り') !== -1);

  await page.fill('#qAnswer', '深掘り回答6');
  await page.click('#btnSaveQ');
  await page.waitForFunction(() => (document.getElementById('qCategory').textContent || '').indexOf('AIの深掘り') === -1);
  check('クライアント側の上限（depth6）でAI呼び出しが頭打ちになる', aiCallCount === 6, 'aiCallCount=' + aiCallCount);

  await page.click('[data-screen="interview"] .back');
  await page.waitForSelector('[data-screen=dash].active');

  // ---- 固定質問を全部使い切った状態から、AIが自分で次の話題を考えて続ける（育てるモード） ----
  await page.evaluate(() => {
    const W = window.OmoideWiki;
    const w = W.newWiki('person', 'すぐ育つ人', '');
    ['history', 'personality', 'favorites', 'skills', 'episodes'].forEach((cat) => {
      (W.QUESTIONS.person[cat] || []).forEach((q) => {
        if (cat === 'episodes') w.episodes.push(W.newEpisode({ body: 'テスト回答', prompt: q.text, questionKey: q.key }));
        else w[cat].push(W.newEntry('テスト回答', '', q.text, q.key));
      });
    });
    // 既存のWiki（やまだ たろう）を消さないよう、上書きではなく追加する
    const store = JSON.parse(localStorage.getItem(W.STORAGE_KEY) || '{"wikis":{},"currentId":null}');
    store.wikis[w.id] = w;
    localStorage.setItem(W.STORAGE_KEY, JSON.stringify(store));
  });
  await page.reload();
  await page.evaluate((url) => {
    document.querySelector('meta[name="omoide-ai-endpoint"]').setAttribute('content', url);
  }, `http://127.0.0.1:${aiPort}/`);
  aiCallCount = 0;
  await page.click('.wiki-card:has-text("すぐ育つ人")');
  await page.waitForSelector('[data-screen=dash].active');
  await page.click('#tileInterview');
  await page.waitForSelector('[data-screen=interview].active');
  await page.waitForFunction(() => (document.getElementById('qCategory').textContent || '').indexOf('AIの深掘り') !== -1);
  check('固定質問を使い切ると、AIが自分で次の話題を考えて続く（育てるモード）', aiCallCount >= 1);
  await page.click('[data-screen="interview"] .back');
  await page.waitForSelector('[data-screen=dash].active');
  await page.click('#btnDeleteWiki');
  await page.waitForSelector('[data-screen=home].active');
  await page.click('.wiki-card:has-text("やまだ たろう")');
  await page.waitForSelector('[data-screen=dash].active');

  // ---- AIでまとめる ----
  await page.click('#tileView');
  await page.waitForSelector('[data-screen=view].active');
  check('AIエンドポイント設定時は「AIでまとめる」ボタンが表示される', !(await page.isHidden('#btnCompose')));
  await page.click('#btnCompose');
  await page.waitForFunction(() => (document.getElementById('composeNote').textContent || '').indexOf('AIがまとめた') !== -1);
  check('AIがまとめた概要が概要欄に反映される', (await page.textContent('#sec-overview')).indexOf('AIがまとめた概要です') !== -1);
  check('生い立ちが箇条書き（年譜）で反映される', await page.locator('#sec-history .wp-compose-list li').count() === 2);
  check('箇条書きの各行に元の内容が入る', (await page.textContent('#sec-history')).indexOf('雨の遠足で全員ずぶ濡れになった') !== -1);
  check('まとめられなかった項目（好きなもの）は元の一問一答のまま', (await page.textContent('#sec-favorites')).indexOf('まとめた') === -1);
  check('元の回答を見る、で生データを確認できる', await page.locator('#sec-history .wp-raw-toggle summary').count() > 0);
  check('エピソードもAIで整えた文章に置き換わる', (await page.textContent('#sec-episodes')).indexOf('AIが整えた文章：') !== -1);
  check('エピソードにも元の文章を見る、の切り替えがある', await page.locator('#sec-episodes .wp-raw-toggle summary').count() > 0);

  await page.click('[data-screen="view"] .back');
  await page.waitForSelector('[data-screen=dash].active');

  aiServer.close();

  // ---- 15問ごとの休憩確認（お年寄りなど、長く話すと疲れる人向け） ----
  await page.click('[data-screen="dash"] .back');
  await page.waitForSelector('[data-screen=home].active');
  await page.click('#btnNewWiki');
  await page.fill('#newTitle', 'こまめさん');
  await page.click('#btnCreateWiki');
  await page.click('#tileInterview');
  await page.waitForSelector('[data-screen=interview].active');
  for (let i = 0; i < 14; i++) {
    await page.fill('#qAnswer', 'テスト回答' + i);
    await page.click('#btnSaveQ');
    await page.waitForFunction(() => !document.getElementById('btnSaveQ').disabled);
  }
  dismissNextConfirm = true;
  await page.fill('#qAnswer', 'テスト回答14');
  await page.click('#btnSaveQ');
  await page.waitForSelector('[data-screen=dash].active');
  check('15問ごとに休憩を確認するダイアログが出る', lastDismissedMessage.indexOf('休憩') !== -1);
  check('休憩で「今日はここまで」を選ぶとダッシュボードに戻る（＝インタビューが終わる）', await page.locator('[data-screen=dash].active').count() === 1);
  const savedCount = ((await page.textContent('#entryList')).match(/テスト回答/g) || []).length;
  check('休憩を挟んでも15問ぶんきちんと保存されている', savedCount === 15, 'savedCount=' + savedCount);
  await page.click('#btnDeleteWiki');
  await page.waitForSelector('[data-screen=home].active');
  await page.click('.wiki-card:has-text("やまだ たろう")');
  await page.waitForSelector('[data-screen=dash].active');

  // ---- 削除（AI深掘りの後片付けを終えて dash 画面にいる状態から） ----
  await page.click('#btnDeleteWiki');
  await page.waitForSelector('[data-screen=home].active');
  check('削除すると一覧から消える', (await page.textContent('#wikiList')).indexOf('やまだ たろう') === -1);

  check('JSのエラーが発生していない', errors.length === 0, errors.join(' / '));

  await browser.close();
  server.close();
  fs.unlinkSync(tmpPhoto);
  fs.unlinkSync(importPath);

  console.log('\n' + pass + ' 件 通過 / ' + fail + ' 件 失敗');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
