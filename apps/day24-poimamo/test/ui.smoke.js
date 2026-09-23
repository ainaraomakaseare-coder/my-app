/*
 * 実ブラウザで、サービス単位のグルーピング・詳細画面への遷移・内訳の追加編集削除・
 * スクショから読み取る画面（新規登録／既存サービスの一括更新の両方、複数枚選択、
 * 本番Workerへの実リクエストはモックして応答／エンドポイント未設定時のフォールバック）・
 * カレンダー登録（.ics）・書き出し/読み込みの流れを確かめる。
 * 実行: node test/ui.smoke.js [index.html]
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const path = require("path");
const fs = require("fs");
const http = require("http");
const os = require("os");

const FILE = path.resolve(process.argv[2] || path.join(__dirname, "..", "index.html"));

let pass = 0, fail = 0;
function check(label, cond, extra){
  if(cond) pass++;
  else { fail++; console.log("NG  " + label + (extra !== undefined ? "\n    " + extra : "")); }
}

const PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
function makeTmpPng(name){
  const p = path.join(os.tmpdir(), name);
  fs.writeFileSync(p, PNG_BUFFER);
  return p;
}

(async () => {
  const html = fs.readFileSync(FILE, "utf8");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const URL = "http://127.0.0.1:" + server.address().port + "/";

  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? {channel: process.env.PLAYWRIGHT_CHANNEL} : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if(m.type() === "error" && !/font|net::/i.test(m.text())) errors.push(m.text()); });
  await page.goto(URL);

  const vis = s => page.isVisible(s);
  const val = s => page.$eval(s, e => e.value);
  const txt = s => page.textContent(s);
  const count = s => page.$$eval(s, e => e.length);

  check("初期状態は空の一覧", (await txt(".empty")).includes("まだ登録がありません"));

  // 手入力で楽天ポイントを新規登録（期間限定・失効間近）
  await page.click("#open-add");
  check("シートが開く", await vis(".overlay .sheet"));
  await page.selectOption("#f-program", "楽天ポイント");
  await page.fill("#f-balance", "100");
  const today = new Date();
  const soon = new Date(today.getTime() + 5 * 86400000).toISOString().slice(0, 10);
  await page.fill("#f-expiry", soon);
  await page.click("#save-btn");
  check("保存後にシートが閉じる", await page.isHidden(".overlay"));
  check("一覧に1サービス表示", (await count(".ticket")) === 1);
  check("失効間近の警告バナーが出る", (await txt("#banner-area")).includes("30日以内"));

  // 「その他」サービスのカスタム名必須チェック（手入力）
  await page.click("#open-add");
  await page.selectOption("#f-program", "その他");
  check("その他を選ぶとカスタム名欄が出る", await vis("#field-custom"));
  await page.fill("#f-balance", "300");
  await page.click('input[name="ptype"][value="通常"]');
  await page.click("#save-btn");
  check("カスタム名未入力はエラー表示", (await txt("#err-custom")).length > 0);
  await page.fill("#f-custom", "スタバカード");
  await page.click("#save-btn");
  check("入力後は保存できる", await page.isHidden(".overlay"));
  check("2サービス目が登録される", (await count(".ticket")) === 2);

  // サービスをタップすると詳細画面へ遷移する
  await page.click('.ticket:has-text("楽天ポイント")');
  check("詳細画面が表示される", await vis("#view-detail"));
  check("一覧画面は隠れる", await page.isHidden("#view-list"));
  check("詳細の名前が楽天ポイント", (await txt("#detail-name")) === "楽天ポイント");
  check("詳細の内訳は1件", (await count(".lot-row")) === 1);

  // 詳細画面から内訳を手入力で追加 → 同じサービスに複数の内訳（期間限定×2＋通常）を持たせる
  await page.click("#add-lot-btn");
  check("追加シートではサービス選択が隠れる", await page.isHidden("#field-program"));
  await page.fill("#f-balance", "10");
  const soon2 = new Date(today.getTime() + 20 * 86400000).toISOString().slice(0, 10);
  await page.fill("#f-expiry", soon2);
  await page.click("#save-btn");
  check("詳細画面に戻り内訳が2件になる", (await count(".lot-row")) === 2);

  await page.click("#add-lot-btn");
  await page.click('input[name="ptype"][value="通常"]');
  await page.fill("#f-balance", "1000");
  await page.click("#save-btn");
  check("内訳が3件になる（期間限定×2＋通常）", (await count(".lot-row")) === 3);
  const detailTotal = await txt("#detail-total");
  check("合計残高が1110ptになる", detailTotal.includes("1,110"), "got " + detailTotal);

  // カレンダー登録（.ics）：失効日つきの内訳にだけボタンが出る
  const icsButtons = await page.$$('.lot-row:has(.expiry-line:not(:text("失効日なし"))) .entry-actions .btn:has-text("カレンダー")');
  check("失効日つきの内訳にカレンダーボタンが2件ある", icsButtons.length === 2);
  const noIcsOnNoExpiry = await page.$('.lot-row:has-text("失効日なし") .entry-actions .btn:has-text("カレンダー")');
  check("失効日なしの内訳にはカレンダーボタンが無い", noIcsOnNoExpiry === null);
  const [icsDownload] = await Promise.all([
    page.waitForEvent("download"),
    icsButtons[0].click(),
  ]);
  check(".icsファイルがダウンロードされる", icsDownload.suggestedFilename().endsWith(".ics"));
  const icsPath = await icsDownload.path();
  const icsContent = fs.readFileSync(icsPath, "utf8");
  check("ics内容にVCALENDARが含まれる", icsContent.includes("BEGIN:VCALENDAR"));
  check("ics内容に失効3日前のリマインドが含まれる", icsContent.includes("TRIGGER:-P3D"));

  // 一覧に戻ると集計された1枚のチケットとして見える
  await page.click("#detail-back");
  check("一覧に戻る", await vis("#view-list"));
  const rakutenBalance = await page.$eval('.ticket:has-text("楽天ポイント") .ticket-balance', e => e.textContent);
  check("一覧のチケットは内訳の合計残高を表示する", rakutenBalance.includes("1,110"), "got " + rakutenBalance);
  const rakutenBadge = await page.$eval('.ticket:has-text("楽天ポイント") .badge', e => e.textContent);
  check("複数内訳は「内訳N件」と表示される", rakutenBadge.includes("内訳3件"), "got " + rakutenBadge);

  const AI_ENDPOINT = "https://poimamo-ai.hiroya-apps.workers.dev";

  // ---- 新規登録：スクショから登録（複数枚まとめて読み取り、本番Workerはモック） ----
  await page.route(AI_ENDPOINT + "/**", route => {
    const body = JSON.parse(route.request().postData());
    check("新規登録時は複数枚の画像がまとめて送られる", body.images.length === 2, "got " + body.images.length);
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        program: "dポイント",
        lots: [
          { pointType: "期間限定", balance: 50, expiryDate: null, expiryMonth: "2026-07" },
          { pointType: "期間限定", balance: 0, expiryDate: null, expiryMonth: "08" },
          { pointType: "通常", balance: 200, expiryDate: null },
        ],
        confidence: "high",
      }),
    });
  });

  await page.click("#open-add-shot");
  check("スクショ登録オーバーレイが開く", await vis("#update-overlay"));
  check("新規登録モードではサービス選択が表示される", await vis("#shot-program-field"));
  const tmpA = makeTmpPng("poimamo-a.png");
  const tmpB = makeTmpPng("poimamo-b.png");
  await page.setInputFiles("#upd-shot-file", [tmpA, tmpB]);
  check("複数枚選ぶとサムネイルが2枚表示される", (await count(".ss-thumb")) === 2);
  check("エンドポイント設定済みなので読み取りボタンが有効になる", await page.isEnabled("#upd-shot-run"));
  await page.click("#upd-shot-run");
  await page.waitForSelector("#upd-rows .upd-row");
  check("AIの読み取り結果が一覧に入力される（3行）", (await count(".upd-row")) === 3);
  check("AIが推測したサービスがプルダウンに反映される", (await val("#shot-program-select")) === "dポイント");
  check("月のみの期限は7月末になる", await val('.upd-row:nth-child(1) input[type="date"]') === "2026-07-31");
  check("年不明の月も確認画面に残る", (await txt(".upd-row:nth-child(2)")).includes("8月失効"));
  await page.click("#upd-confirm");
  check("年不明のまま登録しない", await vis("#update-overlay"));
  await page.fill('.upd-row:nth-child(2) input[type="date"]', "2026-08-31");
  await page.click("#upd-confirm");
  check("登録後オーバーレイが閉じる", await page.isHidden("#update-overlay"));
  check("新しいサービス（3件目）が一覧に追加される", (await count(".ticket")) === 3);
  check("既存のサービス（楽天ポイント）は消えない", (await page.$('.ticket:has-text("楽天ポイント")')) !== null);
  const dpointBalance = await page.$eval('.ticket:has-text("dポイント") .ticket-balance', e => e.textContent);
  check("dポイントの合計残高が250ptになる", dpointBalance.includes("250"), "got " + dpointBalance);
  fs.unlinkSync(tmpA);
  fs.unlinkSync(tmpB);
  await page.unroute(AI_ENDPOINT + "/**");

  // ---- 既存サービスの一括更新：スクショで情報を更新する ----
  await page.route(AI_ENDPOINT + "/**", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      program: "楽天ポイント",
      lots: [{ pointType: "通常", balance: 5000, expiryDate: null }],
      confidence: "high",
    }),
  }));

  await page.click('.ticket:has-text("楽天ポイント")');
  await page.click("#open-update-btn");
  check("更新オーバーレイが開く", await vis("#update-overlay"));
  check("更新モードではサービス選択が隠れる", await page.isHidden("#shot-program-field"));
  check("見出しにサービス名が入る", (await txt("#shot-overlay-title")).includes("楽天ポイント"));
  const tmpC = makeTmpPng("poimamo-c.png");
  await page.setInputFiles("#upd-shot-file", tmpC);
  await page.click("#upd-shot-run");
  await page.waitForFunction(() => document.querySelectorAll("#upd-rows .upd-row").length === 1);
  await page.click("#upd-confirm");
  check("更新後オーバーレイが閉じる", await page.isHidden("#update-overlay"));
  check("内訳が置き換わり1件になる", (await count(".lot-row")) === 1);
  const updatedTotal = await txt("#detail-total");
  check("合計残高が5000ptに置き換わる（AI読み取り結果通り）", updatedTotal.includes("5,000"), "got " + updatedTotal);
  fs.unlinkSync(tmpC);

  // エンドポイント未設定時のフォールバックも確認する（メタタグを一時的に空にして検証）
  await page.evaluate(() => document.querySelector('meta[name="poimamo-ai-endpoint"]').setAttribute("content", ""));
  await page.click("#detail-back");
  await page.click('.ticket:has-text("スタバカード")');
  await page.click("#open-update-btn");
  const tmpD = makeTmpPng("poimamo-d.png");
  await page.setInputFiles("#upd-shot-file", tmpD);
  check("エンドポイント未設定時はAI未設定の案内が出る", (await txt("#upd-ai-status")).includes("設定されていません"));
  check("エンドポイント未設定時は読み取りボタンが無効化される", !(await page.isEnabled("#upd-shot-run")));
  fs.unlinkSync(tmpD);
  await page.click("#close-update");
  await page.click("#detail-back");
  await page.evaluate((url) => document.querySelector('meta[name="poimamo-ai-endpoint"]').setAttribute("content", url), AI_ENDPOINT);
  await page.unroute(AI_ENDPOINT + "/**");

  // 手入力で行を追加して一括更新することもできる（AI未使用でも動く）
  await page.click('.ticket:has-text("楽天ポイント")');
  await page.click("#open-update-btn");
  await page.click("#upd-add-row");
  check("行が1つ追加される", (await count(".upd-row")) === 1);
  await page.click('#upd-rows input[type="radio"][value="通常"]');
  await page.fill('#upd-rows input[type="number"]', "5500");
  await page.click("#upd-confirm");
  check("手入力の一括更新でも置き換わる", (await count(".lot-row")) === 1);

  // 内訳の編集
  await page.click(".lot-row .entry-actions .btn:not(.btn-danger):not(:has-text('カレンダー'))");
  check("編集シートに残高が入っている", (await val("#f-balance")) === "5500");
  await page.fill("#f-balance", "5600");
  await page.click("#save-btn");
  const editedBalance = await page.$eval(".lot-row .entry-balance", e => e.textContent);
  check("編集した残高が反映される", editedBalance.includes("5,600"), "got " + editedBalance);

  // 内訳を削除すると、最後の1件なら一覧に自動で戻る
  const delBtn = await page.$(".lot-row .entry-actions .btn-danger");
  await delBtn.click();
  await delBtn.click();
  check("最後の内訳を削除すると一覧に自動遷移する", await vis("#view-list"));
  check("楽天ポイントのチケットは消える", (await page.$('.ticket:has-text("楽天ポイント")')) === null);
  check("スタバカードのチケットは残る", (await page.$('.ticket:has-text("スタバカード")')) !== null);

  // 合計不一致の場合は登録せず、画像追加の案内を表示する。
  const errorCountBefore422 = errors.length;
  await page.route(AI_ENDPOINT + "/**", route => route.fulfill({status:422,contentType:"application/json",body:JSON.stringify({error:"inconsistent_balances"})}));
  await page.click("#open-add-shot");
  const badShot = makeTmpPng("poimamo-inconsistent.png");
  await page.setInputFiles("#upd-shot-file", badShot);
  await page.click("#upd-shot-run");
  await page.waitForFunction(() => document.getElementById("upd-ai-status").textContent.includes("合計と内訳"));
  check("合計不一致なら画像追加を案内", (await txt("#upd-ai-status")).includes("画像を追加"));
  check("合計不一致の結果を登録行へ入れない", (await count(".upd-row")) === 0);
  for(let i=errors.length-1;i>=errorCountBefore422;i--){
    if(errors[i].includes("status of 422")) errors.splice(i,1);
  }
  fs.unlinkSync(badShot);
  await page.unroute(AI_ENDPOINT + "/**");
  await page.click("#close-update");

  // 通常マイルの単位・期限・カレンダー・保存を確認する。
  const todayDate = new Date();
  const todayIso = todayDate.getFullYear()+"-"+String(todayDate.getMonth()+1).padStart(2,"0")+"-"+String(todayDate.getDate()).padStart(2,"0");
  await page.click("#open-add");
  await page.selectOption("#f-program","ANAマイレージ");
  check("ANAの手入力はマイルになる",await val("#f-unit")==="マイル");
  await page.check('input[name="ptype"][value="通常"]');
  await page.fill("#f-balance","165");
  await page.fill("#f-expiry",todayIso);
  await page.click("#save-btn");
  check("一覧にマイル単位を表示",(await txt('.ticket:has-text("ANAマイレージ")')).includes("165マイル"));
  check("登録残高はptとマイルを分ける",(await txt("#summary-row")).includes("pt")&&(await txt("#summary-row")).includes("マイル"));
  check("今日の日付を表示",(await txt("#cal-today-label")).includes(todayIso.replaceAll("-","/")));
  check("今日のセルを強調",await page.getAttribute('.calendar-day[data-date="'+todayIso+'"]',"aria-current")==="date");
  check("通常マイルも当日の失効予定に表示",(await txt("#cal-events")).includes("165 マイル"));
  check("直近の失効カードに今日のマイル",(await txt("#next-expiry")).includes("165")&&(await txt("#next-expiry")).includes("今日"));
  await page.click("#cal-all");
  check("月全体の予定へ切替",(await txt("#cal-events")).includes("この月の失効予定"));
  check("月の残高にマイルを表示",(await txt("#cal-month-total")).includes("マイル"));
  await page.click("#next-expiry button");
  check("直近の予定へジャンプ",await page.getAttribute('.calendar-day[data-date="'+todayIso+'"]',"aria-pressed")==="true");
  const thisMonth=await txt("#cal-month");
  await page.click("#cal-next");
  check("翌月へ移動",await txt("#cal-month")!==thisMonth);
  await page.click("#cal-today");
  check("今日へ戻れる",await txt("#cal-month")===thisMonth);
  await page.click('.calendar-day[data-date="'+todayIso+'"]');
  await page.click('.calendar-event:has-text("ANAマイレージ")');
  check("カレンダーからサービス詳細へ",(await txt("#detail-total")).includes("165マイル"));
  check("通常マイルの期限を詳細へ表示",(await txt("#lot-list")).includes("通常"));
  await page.click("#detail-back");
  await page.reload();
  check("再読み込み後もマイルと期限が残る",(await txt("#cal-events")).includes("165 マイル"));
  check("スマホで横にはみ出さない",await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  if(process.env.POIMAMO_QA_DIR){
    fs.mkdirSync(process.env.POIMAMO_QA_DIR,{recursive:true});
    await page.screenshot({path:path.join(process.env.POIMAMO_QA_DIR,"mobile.png"),fullPage:true});
    await page.setViewportSize({width:1280,height:900});
    await page.screenshot({path:path.join(process.env.POIMAMO_QA_DIR,"desktop.png"),fullPage:true});
    await page.click("#open-add");
    await page.screenshot({path:path.join(process.env.POIMAMO_QA_DIR,"form.png"),fullPage:true});
    await page.click("#close-sheet");
  }

  // 書き出し
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#export-btn"),
  ]);
  const exportPath = await download.path();
  const exported = JSON.parse(fs.readFileSync(exportPath, "utf8"));
  check("書き出したJSONは配列", Array.isArray(exported));
  check("書き出したJSONにスタバカードが含まれる", exported.some(e => e.customProgramName === "スタバカード"));

  check("ページエラーが発生していない", errors.length === 0, errors.join("\n"));

  await browser.close();
  server.close();

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
