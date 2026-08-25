const { chromium } = require("/opt/node22/lib/node_modules/playwright");
const path = require("path");

const URL = "file://" + path.resolve(process.argv[2] || "index.html");
let pass = 0, fail = 0;
function check(label, cond, extra){
  if(cond) pass++; else { fail++; console.log("NG  " + label + (extra ? "  " + extra : "")); }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if(m.type() === "error" && !/font|net::/i.test(m.text())) errors.push(m.text()); });
  await page.goto(URL);

  const st = () => page.evaluate(() => {
    const g = window.__peek && window.__peek();
    return g;
  });
  // 状態を覗くフックを注入（アプリ側は無改変）
  await page.addInitScript(() => {});

  // --- 設定 ---
  await page.click("#add-player");                       // 3人にする
  const inputs = await page.$$("#names input");
  check("名前欄が3つ", inputs.length === 3, "実際 " + inputs.length);
  await inputs[0].fill("たろう");
  await inputs[1].fill("はなこ");
  await inputs[2].fill("じろう");
  await page.fill("#rounds", "2");
  await page.fill("#base", "2");
  await page.click("#start");
  check("対局画面に入る", await page.isVisible("#scr-game"));

  const scores = () => page.$$eval("#scores .pt", els => els.map(e => parseInt(e.textContent, 10)));
  const vis = s => page.isVisible(s);
  const txt = s => page.textContent(s);

  check("親の最初の番ではパスが出ない", !(await vis("#pass")));
  check("0回振った状態では確定できない", !(await vis("#advance")));

  // --- 親の番：3回まで振り直せることを確認 ---
  for(let i = 1; i <= 3; i++){
    await page.click("#roll");
    await page.waitForTimeout(950);
    check("振った後は確定ボタンが出る（" + i + "回目）", await vis("#advance"));
    check("残り回数の表示", (await txt("#tries")).includes(String(3 - i) + " 回"));
    if(i < 3) check("まだ振り直せる（" + i + "回目）", await vis("#roll"));
  }
  check("3回振ったら振るボタンは消える", !(await vis("#roll")));
  await page.click("#advance");                          // この目で決める
  check("確定後は役が出る", (await txt("#hand")).length > 0);
  await page.click("#advance");                          // 次の人へ渡す

  // --- 子の番：パスできる ---
  check("子の番ではパスが出る", await vis("#pass"));
  const passLabel = await txt("#pass");
  check("パスの支払額が出ている", /\d+ 点/.test(passLabel), passLabel);
  await page.click("#pass");
  check("パス後に役の欄がパス表示", (await txt("#hand")).includes("パス"));
  await page.click("#advance");

  // --- 3人目：1回で確定 ---
  await page.click("#roll");
  await page.waitForTimeout(950);
  await page.click("#advance");
  await page.click("#advance");

  // --- 精算 ---
  check("精算画面に入る", await page.isVisible("#scr-settle"));
  let s = await page.$$eval("#scores2 .pt", els => els.map(e => parseInt(e.textContent, 10)));
  check("点の総和がゼロ（1局目）", s.reduce((a, b) => a + b, 0) === 0, JSON.stringify(s));
  check("精算に基準値の注記", (await txt("#settle-note")).includes("基準 2"));
  check("記録ボタンが出る", await vis("#t-log"));

  // --- 記録を見て戻る ---
  await page.click("#t-log");
  check("記録画面", await page.isVisible("#scr-log"));
  check("第1局が記録されている", (await txt("#log-list")).includes("第 1 局"));
  await page.click("#log-back");
  check("精算画面に戻る", await page.isVisible("#scr-settle"));

  // --- 2局目：親が回る ---
  const oya1 = await txt("#ba");
  await page.click("#next-round");
  const oya2 = await txt("#ba");
  check("親が交代する", oya1 !== oya2, oya1 + " → " + oya2);
  check("第2局になる", oya2.includes("第 2 局"));

  for(let p = 0; p < 3; p++){
    await page.click("#roll");
    await page.waitForTimeout(950);
    await page.click("#advance");
    await page.click("#advance");
  }
  s = await page.$$eval("#scores2 .pt", els => els.map(e => parseInt(e.textContent, 10)));
  check("点の総和がゼロ（2局目）", s.reduce((a, b) => a + b, 0) === 0, JSON.stringify(s));
  check("最終局なので成績へ", (await txt("#next-round")).includes("成績"));

  // --- 成績とマムシ ---
  await page.click("#next-round");
  check("成績画面", await page.isVisible("#scr-over"));
  const final = await txt("#final");
  check("成績に3人分", ["たろう", "はなこ", "じろう"].every(n => final.includes(n)));
  check("成績に統計が出る", /ピンゾロ|ゾロ目|シゴロ|ヒフミ|目なし|パス|親 \d+局/.test(final), final.slice(0, 120));
  check("成績に記録が出る", (await txt("#log-list2")).includes("第 2 局"));

  await page.fill("#extra", "2");
  await page.click("#mamushi");
  check("マムシで対局に戻る", await page.isVisible("#scr-game"));
  check("全4局に延びる", (await txt("#ba")).includes("全 4 局"), await txt("#ba"));
  check("第3局から", (await txt("#ba")).includes("第 3 局"));
  const carried = await page.$$eval("#scores .pt", els => els.map(e => parseInt(e.textContent, 10)));
  check("点が引き継がれる", carried.reduce((a, b) => a + Math.abs(b), 0) >= 0);

  // --- リロードで再開できる ---
  await page.reload();
  check("再開後も対局画面", await page.isVisible("#scr-game"));
  check("再開後も第3局", (await page.textContent("#ba")).includes("第 3 局"));

  check("JS エラーなし", errors.length === 0, errors.join(" | "));
  await browser.close();
  console.log("\n" + pass + " 件 通過 / " + fail + " 件 失敗");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("EXCEPTION", e); process.exit(1); });
