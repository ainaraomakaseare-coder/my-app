/*
 * 実ブラウザで、サービス単位のグルーピング・詳細画面への遷移・内訳の追加編集削除・
 * スクショ一括更新画面（本番Workerへの実リクエストはモックして応答／エンドポイント
 * 未設定時のフォールバック）・書き出し/読み込みの流れを確かめる。
 * 実行: node test/ui.smoke.js [index.html]
 */
const { chromium } = require("/opt/node22/lib/node_modules/playwright");
const path = require("path");
const fs = require("fs");
const http = require("http");

const FILE = path.resolve(process.argv[2] || path.join(__dirname, "..", "index.html"));

let pass = 0, fail = 0;
function check(label, cond, extra){
  if(cond) pass++;
  else { fail++; console.log("NG  " + label + (extra !== undefined ? "\n    " + extra : "")); }
}

(async () => {
  const html = fs.readFileSync(FILE, "utf8");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const URL = "http://127.0.0.1:" + server.address().port + "/";

  const browser = await chromium.launch();
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

  // 楽天ポイントを新規登録（期間限定・失効間近）
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

  // 「その他」サービスのカスタム名必須チェック
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
  check("追加シートではタブが隠れる（スクショ経由は詳細の更新ボタンから）", await page.isHidden(".overlay .tabs"));
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

  // 一覧に戻ると集計された1枚のチケットとして見える
  await page.click("#detail-back");
  check("一覧に戻る", await vis("#view-list"));
  const rakutenBalance = await page.$eval('.ticket:has-text("楽天ポイント") .ticket-balance', e => e.textContent);
  check("一覧のチケットは内訳の合計残高を表示する", rakutenBalance.includes("1,110"), "got " + rakutenBalance);
  const rakutenBadge = await page.$eval('.ticket:has-text("楽天ポイント") .badge', e => e.textContent);
  check("複数内訳は「内訳N件」と表示される", rakutenBadge.includes("内訳3件"), "got " + rakutenBadge);

  // スクショで一括更新：本番のAI Workerエンドポイントが設定済みなので、実際のリクエスト先を
  // モックして応答させ、コスト・外部通信なしで本物の読み取り→反映の流れを確認する
  const AI_ENDPOINT = "https://poimamo-ai.hiroya-apps.workers.dev";
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
  check("対象サービス名が表示される", (await txt("#update-program-name")) === "楽天ポイント");
  const buffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  const tmp = path.join(require("os").tmpdir(), "poimamo-test.png");
  fs.writeFileSync(tmp, buffer);
  await page.setInputFiles("#upd-shot-file", tmp);
  check("エンドポイント設定済みなので読み取りボタンが有効になる", await page.isEnabled("#upd-shot-run"));
  await page.click("#upd-shot-run");
  await page.waitForSelector("#upd-rows .upd-row");
  check("AIの読み取り結果が一覧に入力される（1行）", (await count(".upd-row")) === 1);
  check("読み取り成功メッセージが出る", (await txt("#upd-ai-status")).includes("確認してから"));
  fs.unlinkSync(tmp);

  await page.click("#upd-confirm");
  check("更新後オーバーレイが閉じる", await page.isHidden("#update-overlay"));
  check("内訳が置き換わり1件になる", (await count(".lot-row")) === 1);
  const updatedTotal = await txt("#detail-total");
  check("合計残高が5000ptに置き換わる（AI読み取り結果通り）", updatedTotal.includes("5,000"), "got " + updatedTotal);

  // 内訳の編集
  await page.click(".lot-row .entry-actions .btn:not(.btn-danger)");
  check("編集シートに残高が入っている", (await val("#f-balance")) === "5000");
  await page.fill("#f-balance", "5500");
  await page.click("#save-btn");
  const editedBalance = await page.$eval(".lot-row .entry-balance", e => e.textContent);
  check("編集した残高が反映される", editedBalance.includes("5,500"), "got " + editedBalance);

  // 内訳を削除すると、最後の1件なら一覧に自動で戻る
  const delBtn = await page.$(".lot-row .entry-actions .btn-danger");
  await delBtn.click();
  await delBtn.click();
  check("最後の内訳を削除すると一覧に自動遷移する", await vis("#view-list"));
  check("楽天ポイントのチケットは消える", (await page.$('.ticket:has-text("楽天ポイント")')) === null);
  check("スタバカードのチケットは残る", (await page.$('.ticket:has-text("スタバカード")')) !== null);

  // エンドポイント未設定時のフォールバックも確認する（メタタグを一時的に空にして検証）
  await page.evaluate(() => document.querySelector('meta[name="poimamo-ai-endpoint"]').setAttribute("content", ""));
  await page.click('.ticket:has-text("スタバカード")');
  await page.click("#open-update-btn");
  const tmp2 = path.join(require("os").tmpdir(), "poimamo-test2.png");
  fs.writeFileSync(tmp2, buffer);
  await page.setInputFiles("#upd-shot-file", tmp2);
  check("エンドポイント未設定時はAI未設定の案内が出る", (await txt("#upd-ai-status")).includes("設定されていません"));
  check("エンドポイント未設定時は読み取りボタンが無効化される", !(await page.isEnabled("#upd-shot-run")));
  fs.unlinkSync(tmp2);
  await page.click("#close-update");
  await page.click("#detail-back");
  await page.evaluate((url) => document.querySelector('meta[name="poimamo-ai-endpoint"]').setAttribute("content", url), AI_ENDPOINT);
  await page.unroute(AI_ENDPOINT + "/**");

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
