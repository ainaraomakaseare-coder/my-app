/*
 * 実ブラウザで登録・編集・削除・並び替え・書き出し/読み込みの流れを確かめる。
 * AIスクショ読み取りはWorkerへの外部通信を伴うため、ここでは
 * 「未設定時に手入力へ誘導される」ことまでを確認する。
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

  // 登録（期間限定・失効間近）
  await page.click("#open-add");
  check("シートが開く", await vis(".overlay .sheet"));
  await page.selectOption("#f-program", "楽天ポイント");
  await page.fill("#f-balance", "1200");
  const today = new Date();
  const soon = new Date(today.getTime() + 5 * 86400000).toISOString().slice(0, 10);
  await page.fill("#f-expiry", soon);
  await page.click("#save-btn");
  check("保存後にシートが閉じる", await page.isHidden(".overlay"));
  check("一覧に1件表示", (await count(".entry")) === 1);
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
  check("2件目が登録される", (await count(".entry")) === 2);

  // 並び替え：失効間近のほうが先に出る
  const firstName = await page.$eval(".entry:first-child .entry-name", e => e.textContent);
  check("失効日が近いほうが先頭に来る", firstName === "楽天ポイント", "got " + firstName);

  // 編集
  await page.click(".entry:first-child .entry-actions .btn:not(.btn-danger)");
  check("編集シートに残高が入っている", (await val("#f-balance")) === "1200");
  await page.fill("#f-balance", "1500");
  await page.click("#save-btn");
  const updatedBal = await page.$eval(".entry:first-child .entry-balance", e => e.textContent);
  check("編集した残高が反映される", updatedBal.includes("1,500"), "got " + updatedBal);

  // スクショタブ：AI未設定なら手入力へ誘導される
  await page.click("#open-add");
  await page.click("#tab-shot");
  check("スクショタブに切り替わる", await vis("#panel-shot"));
  const buffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  const tmp = path.join(require("os").tmpdir(), "poimamo-test.png");
  fs.writeFileSync(tmp, buffer);
  await page.setInputFiles("#shot-file", tmp);
  check("AI未設定の案内が出る", (await txt("#ai-status")).includes("設定されていません"));
  check("読み取りボタンは無効化される", !(await page.isEnabled("#shot-run")));
  fs.unlinkSync(tmp);
  await page.click("#close-sheet");

  // 削除（2段階確認）
  const beforeDelete = await count(".entry");
  const delBtn = await page.$(".entry:last-child .entry-actions .btn-danger");
  await delBtn.click();
  check("1回目のクリックで確認状態になる", (await page.$eval(".entry:last-child .entry-actions .btn-danger", e => e.textContent)).includes("本当に"));
  check("1回目のクリックではまだ削除されない", (await count(".entry")) === beforeDelete);
  await delBtn.click();
  check("2回目のクリックで削除される", (await count(".entry")) === beforeDelete - 1);

  // 書き出し
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#export-btn"),
  ]);
  const exportPath = await download.path();
  const exported = JSON.parse(fs.readFileSync(exportPath, "utf8"));
  check("書き出したJSONは配列", Array.isArray(exported));
  check("書き出したJSONに残高が含まれる", exported.some(e => e.balance === 1500));

  check("ページエラーが発生していない", errors.length === 0, errors.join("\n"));

  await browser.close();
  server.close();

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
