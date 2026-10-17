/*
 * 「メモから一括登録」で、別のAI（ChatGPTなど）が返したJSONを貼ってから登録するまでを実ブラウザで確かめる。
 * 年のない日付・球団名の表記ゆれなど、よくある返答のずれがあっても登録までたどり着けること。
 * 実行: node test/memo-import.ui.js [index.html]
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

// ChatGPTが実際に返しがちな形：前置き付き、年のない日付はnull、球団名は「DeNA」、勝敗は日本語
const AI_REPLY = `以下が変換結果です。
\`\`\`json
{"games":[
 {"competition":"regular","date":null,"myTeam":"DeNA","opponent":"阪神","venue":"横浜スタジアム","score":{"bay":5,"opp":3},"result":"勝ち","companions":["友人"],"ticketPrice":null,"temp":null,"weather":"","mvpPlayer":null,"mvpNote":null,"notablePlayers":[],"highlight":"最後までドキドキした！","sourceText":"4/12 阪神に5-3で勝ち","warnings":["年が不明です"]},
 {"competition":"regular","date":"2025/5/3","myTeam":"DeNA","opponent":"巨人","venue":"東京ドーム","score":{"bay":2,"opp":4},"result":"負け","companions":[],"ticketPrice":"4,500円","temp":null,"weather":"ドーム","mvpPlayer":null,"mvpNote":null,"notablePlayers":[],"highlight":null,"sourceText":"5/3 巨人戦 2-4","warnings":[]}
]}
\`\`\`
ご確認ください。`;

(async () => {
  const html = fs.readFileSync(FILE, "utf8");
  const server = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(html); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const URL = "http://127.0.0.1:" + server.address().port + "/";
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {});
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear()); await page.reload();

  await page.click("#list-memo", { force: true }).catch(async () => { await page.evaluate(() => openMemo()); });
  await page.evaluate(() => openMemo());
  check("メモ画面が開く", await page.isVisible("#memo-json"));

  // 空のまま押すと、理由が見える
  await page.click("#memo-preview");
  check("空のまま確認すると理由が出る", (await page.textContent("#memo-review-status")).includes("空です"));

  await page.fill("#memo-json", AI_REPLY);
  await page.click("#memo-preview");
  check("2件が確認一覧に出る", await page.locator(".memo-row").count() === 2);
  check("日付のある2件目は最初から選ばれている", await page.isChecked('[data-memo-row="1"]'));
  check("日付のない1件目は選べない", await page.isDisabled('[data-memo-row="0"]'));
  check("日付のない行に入力欄が出る", await page.isVisible('[data-memo-fix="date"][data-memo-index="0"]'));
  check("状態の説明に要修正が出る", (await page.textContent("#memo-review-status")).includes("要修正 1件"));
  check("2件目は表記ゆれを読み替えて負け・東京ドーム", (await page.textContent(".memo-row:nth-child(2)")).includes("負け"));

  await page.fill('[data-memo-fix="date"][data-memo-index="0"]', "2025-04-12");
  check("日付を入れると1件目が選べて選択される", await page.isChecked('[data-memo-row="0"]'));
  check("追加ボタンが押せる", !(await page.isDisabled("#memo-import")));
  check("ボタンに件数が出る", (await page.textContent("#memo-import")).includes("2件"));

  await page.click("#memo-import");
  const games = await page.evaluate(() => JSON.parse(localStorage.getItem("bay-diary:v1")).games);
  check("2件が保存される", games.length === 2, JSON.stringify(games));
  const first = games.find(g => g.opponent === "阪神") || {};
  check("入れた日付・応援球団・勝敗で保存される", first.date === "2025-04-12" && first.myTeam === "baystars" && first.result === "win", JSON.stringify(first));
  const second = games.find(g => g.opponent === "巨人") || {};
  check("チケット代・天気も読み替えて保存される", second.ticketPrice === 4500 && second.weather === "dome", JSON.stringify(second));
  check("ページでエラーが出ていない", errors.length === 0, errors.join("\n"));

  await browser.close(); server.close();
  console.log("\n" + pass + " 件 通過 / " + fail + " 件 失敗");
  process.exit(fail ? 1 : 0);
})();
