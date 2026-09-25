/*
 * 実ブラウザで記録の追加・編集・削除と各画面の切り替えを確かめる。
 * 実行: node test/ui.smoke.js [index.html]
 */
const { chromium } = require("playwright");
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

  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if(m.type() === "error" && !/font|net::/i.test(m.text())) errors.push(m.text()); });
  await page.goto(URL);
  await page.click("#nav-list");

  const vis = s => page.isVisible(s);
  const val = s => page.$eval(s, e => e.value);
  const txt = s => page.textContent(s);
  const count = s => page.$$eval(s, e => e.length);

  /* ───────── 初期表示 ───────── */
  check("一覧画面が最初に表示される", await vis("#scr-list"));
  check("記録がなければ空メッセージが出る", await vis("#empty-msg"));

  /* ───────── 試合を1件記録する ───────── */
  await page.click("#add-game");
  check("フォーム画面に切り替わる", await vis("#scr-form"));
  await page.fill("#f-date", "2025-04-12");
  await page.fill("#f-opponent", "阪神");
  await page.fill("#f-venue", "横浜スタジアム");
  await page.fill("#f-bay-score", "5");
  await page.fill("#f-opp-score", "3");
  check("スコア入力で勝敗が自動判定される", await val("#f-result") === "win");

  await page.fill("#f-companion-input", "友人A");
  await page.click("#f-companion-add");
  check("同行者チップが追加される", await count("#f-companions-chips .chip-tag") === 1);

  await page.fill("#f-ticket-price", "4500");
  await page.selectOption("#f-weather", "sunny");
  await page.fill("#f-mvp-player", "牧秀悟");
  await page.fill("#f-mvp-note", "決勝タイムリー");
  await page.click("#f-notable-add");
  await page.fill("[data-notable-name='0']", "佐野恵太");
  await page.fill("[data-notable-note='0']", "2安打");
  await page.fill("#f-highlight", "9回裏の逆転劇に鳥肌が立った");

  await page.click("#f-save");
  check("保存後に一覧へ戻る", await vis("#scr-list"));
  check("記録が1件表示される", await count(".game-card") === 1);
  check("勝ちバッジが出る", (await txt(".gc-badge")).includes("勝ち"));
  check("同行者が表示される", (await txt("#game-list")).includes("友人A"));
  check("チケット代が表示される", (await txt("#game-list")).includes("4,500"));
  check("MVPが表示される", (await txt("#game-list")).includes("牧秀悟"));
  check("活躍選手が表示される", (await txt("#game-list")).includes("佐野恵太"));
  check("成績サマリーに反映される", (await txt("#header-summary")).includes("1勝"));

  /* ───────── もう1件、負け試合を記録する ───────── */
  await page.click("#add-game");
  await page.fill("#f-date", "2025-04-13");
  await page.fill("#f-opponent", "広島");
  await page.fill("#f-bay-score", "2");
  await page.fill("#f-opp-score", "6");
  await page.click("#f-save");
  check("2件目が追加される", await count(".game-card") === 2);
  check("2025年の成績が1勝1敗になる", (await txt("#header-summary")).includes("1勝1敗"));

  /* ───────── 選手分析画面 ───────── */
  await page.click("#nav-players");
  check("選手分析画面に切り替わる", await vis("#scr-players"));
  const playersText = await txt("#players-list");
  check("MVPの選手が一覧に出る", playersText.includes("牧秀悟"));
  check("活躍選手も一覧に出る", playersText.includes("佐野恵太"));

  /* ───────── 編集して削除する ───────── */
  await page.click("#nav-list");
  await page.click("[data-edit]");
  check("編集フォームに値が入る", await val("#f-opponent") !== "");
  await page.click("#f-delete");
  check("1回目のクリックでは確認表示になる", (await txt("#f-delete")).includes("本当に"));
  await page.click("#f-delete");
  await page.waitForTimeout(200);
  check("削除後に一覧へ戻る", await vis("#scr-list"));
  check("1件減る", await count(".game-card") === 1);

  /* ───────── 設定画面：APIキー保存とエクスポート/インポートの導線 ───────── */
  await page.click("#nav-settings");
  check("設定画面に切り替わる", await vis("#scr-settings"));
  check("試合結果APIの設定欄は非表示", !(await vis("#settings-api-key")));

  /* ───────── 再読み込みしてもデータが残る ───────── */
  await page.reload();
  check("再読み込み後はホーム画面", await vis("#scr-dashboard"));
  await page.click("#nav-list");
  check("再読み込み後も記録が残る", await count(".game-card") === 1);

  check("JS エラーなし", errors.length === 0, errors.join(" | "));
  await browser.close();
  server.close();
  console.log("\n" + pass + " 件 通過 / " + fail + " 件 失敗");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("EXCEPTION", e); process.exit(1); });
