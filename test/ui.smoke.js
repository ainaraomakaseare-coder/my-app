/*
 * 実ブラウザで画面の流れを確かめる。
 * 目は仕込んであるので結果は毎回同じになる。
 * 実行: node test/ui.smoke.js [index.html]
 */
const { chromium } = require("/opt/node22/lib/node_modules/playwright");
const path = require("path");
const fs = require("fs");
const http = require("http");

const FILE = path.resolve(process.argv[2] || path.join(__dirname, "..", "index.html"));

/* 3人・1局（＝親が一周）・基準2 で流す筋書き
   親番1 たろう : 役なし → 三の目 → ピンゾロ / はなこ パス / じろう ヒフミ
   親番2 はなこ : 六の目 / じろう ゾロ目六 / たろう 一の目
   親番3 じろう : シゴロ / たろう ヒフミ / はなこ ゾロ目五                     */
const DICE = [1,4,6, 5,5,3, 1,1,1, 1,2,3, 2,2,6, 6,6,6, 3,3,1, 4,5,6, 1,2,3, 5,5,5];

let pass = 0, fail = 0;
function check(label, cond, extra){
  if(cond) pass++;
  else { fail++; console.log("NG  " + label + (extra !== undefined ? "\n    " + extra : "")); }
}

(async () => {
  // file:// だと localStorage がリロードをまたがないので、その場で配る
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
  await page.emulateMedia({ reducedMotion: "reduce" });   // 演出を止めて目の消費を3つ/回に固定
  await ctx.addInitScript(dice => {
    try{ localStorage.setItem("nhk-chinchiro-pref", "1"); }catch(e){}   // 音を切る
    let i = 0; const real = Math.random;
    Math.random = () => (i < dice.length ? (dice[i++] - 1) / 6 + 0.01 : real());
  }, DICE);

  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if(m.type() === "error" && !/font|net::/i.test(m.text())) errors.push(m.text()); });
  await page.goto(URL);

  const vis      = s => page.isVisible(s);
  const txt      = s => page.textContent(s);
  const order    = s => page.$eval(s, e => getComputedStyle(e).order);
  const disabled = s => page.$eval(s, e => e.disabled);
  const cls      = s => page.$eval(s, e => e.className);
  const pips     = () => page.$$eval("#dice .pip", e => e.length);
  const scores   = sel => page.$$eval(sel + " .pt", e => e.map(x => parseInt(x.textContent, 10)));
  const settle   = () => scores("#scores2");
  const GUARD    = 460;   // 画面が切り替わった直後の受付停止をまたぐ待ち

  // WCAG コントラスト比（文字色 vs 背景グラデーションの各端）
  const contrast = sel => page.$eval(sel, e => {
    const cs = getComputedStyle(e);
    const lum = c => { const [r,g,b] = c.map(v => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
                       return 0.2126*r + 0.7152*g + 0.0722*b; };
    const parse = s => (s.match(/\d+/g) || []).slice(0, 3).map(Number);
    const fg = lum(parse(cs.color));
    return (cs.backgroundImage.match(/rgba?\([^)]+\)/g) || [cs.backgroundColor])
      .map(st => { const bg = lum(parse(st));
                   return +(((Math.max(fg,bg)+0.05)/(Math.min(fg,bg)+0.05)).toFixed(2)); });
  });

  async function decideAndHandOff(){          // 決めるを押せばそのまま次の人へ
    await page.click("#advance"); await page.waitForTimeout(160);
  }
  async function rollOnce(){                  // 1回振って、そのまま渡す
    await page.click("#roll"); await page.waitForTimeout(GUARD);
    await page.click("#advance"); await page.waitForTimeout(160);
  }
  async function toNext(){                    // 精算から次へ
    await page.waitForTimeout(GUARD);
    await page.click("#next-round"); await page.waitForTimeout(160);
  }

  /* ───────── 設定 ───────── */
  await page.click("#add-player");
  check("名前欄が3つ", (await page.$$("#names input")).length === 3);
  const ins = await page.$$("#names input");
  await ins[0].fill("たろう"); await ins[1].fill("はなこ"); await ins[2].fill("じろう");
  await page.fill("#rounds", "1");
  await page.fill("#base", "2");
  await page.click("#start");
  check("対局画面に入る", await vis("#scr-game"));
  check("第1局から始まる", (await txt("#ba")).includes("第 1 局"));
  check("親は1人目", (await txt("#ba")).includes("1 / 3 人目"));

  /* ───────── 親番1：たろう ───────── */
  check("親の番ではパスが出ない", !(await vis("#pass")));
  check("振る前は確定できない", !(await vis("#advance")));
  check("振る前のサイコロは目を伏せている", await pips() === 0);
  check("振るボタンは最上段", await order("#roll") === "1");
  const con = await contrast("#roll");
  check("赤ボタンの文字が 4.5:1 以上", con.every(c => c >= 4.5), JSON.stringify(con));
  const btnFont = await page.$eval("#roll", e => getComputedStyle(e).fontFamily);
  check("赤ボタンは見出し（明朝）書体を使わない", !/Mincho/i.test(btnFont), btnFont);
  check("赤ボタンは本文書体", /Zen Kaku Gothic New/.test(btnFont), btnFont);
  const btnWeight = await page.$eval("#roll", e => getComputedStyle(e).fontWeight);
  check("漢字が潰れない太さ（900未満）", parseInt(btnWeight, 10) < 900, btnWeight);

  await page.click("#roll");                                   // 1,4,6
  check("振ったら目が出る", await pips() > 0);
  check("役なしと出る", (await txt("#hand")).includes("役なし"));
  check("振り終わった直後は確定できない", await disabled("#advance"));
  check("残り2回", (await txt("#tries")).includes("2 回"));
  await page.waitForTimeout(GUARD);
  check("少し待てば確定できる", !(await disabled("#advance")));
  check("役なしなら振り直しが主ボタン", (await cls("#roll")).includes("btn-main"));

  await page.click("#roll"); await page.waitForTimeout(GUARD);  // 5,5,3
  check("三の目が出る", (await txt("#hand")).includes("三の目"));
  check("役が出たら決めるが主ボタン", (await cls("#advance")).includes("btn-main"));
  check("役が出ても振り直しは同じ位置", await order("#roll") === "1");
  check("決めるは常にその下", await order("#advance") === "2");

  await page.click("#roll"); await page.waitForTimeout(GUARD);  // 1,1,1
  check("ピンゾロが出る", (await txt("#hand")).includes("ピンゾロ"));
  check("3回振っても振るボタンは残る", await vis("#roll"));
  check("3回振ったら押せなくなる", await disabled("#roll"));
  check("振り切った表示", (await txt("#roll")).includes("もう振れない"));
  await decideAndHandOff();

  /* ───────── 子はなこ：パス ───────── */
  check("子の番ではパスが出る", await vis("#pass"));
  check("親の役が見えている", (await txt("#oyaref")).includes("ピンゾロ"));
  check("パスの支払額は15点", (await txt("#pass")).includes("15 点"), await txt("#pass"));
  await page.click("#pass"); await page.waitForTimeout(160);
  check("パスを押せばそのまま次の人へ", (await txt("#who")).includes("じろう"), await txt("#who"));

  /* ───────── 子じろう：ヒフミは強制確定 ───────── */
  await page.click("#roll"); await page.waitForTimeout(GUARD);  // 1,2,3
  check("ヒフミが出る", (await txt("#hand")).includes("ヒフミ"));
  check("ヒフミは振り直せない", !(await vis("#roll")));
  check("ヒフミだけは足止めして見せる", (await txt("#advance")).includes("精算"), await txt("#advance"));
  await page.click("#advance"); await page.waitForTimeout(160);

  /* ───────── 精算1 ───────── */
  check("精算画面に入る", await vis("#scr-settle"));
  check("親ピンゾロの精算", JSON.stringify(await settle()) === "[45,-15,-30]", JSON.stringify(await settle()));
  check("点の総和がゼロ", (await settle()).reduce((a, b) => a + b, 0) === 0);
  check("基準値の注記", (await txt("#settle-note")).includes("基準 2"));
  check("一周前なので次の親へ", (await txt("#next-round")).includes("次の親"), await txt("#next-round"));

  check("精算直後は次へ進めない", await disabled("#next-round"));
  await page.click("#t-log");
  check("記録画面", await vis("#scr-log"));
  check("局と何人目かが残る", (await txt("#log-list")).includes("第 1 局 ・ 1 人目"));
  await page.click("#log-back");

  /* ───────── 親番2：はなこ ───────── */
  await toNext();
  check("親が交代する", (await txt("#ba")).includes("親 はなこ"));
  check("局は変わらない", (await txt("#ba")).includes("第 1 局"), await txt("#ba"));
  check("親は2人目", (await txt("#ba")).includes("2 / 3 人目"));
  await rollOnce(); await rollOnce(); await rollOnce();          // 2,2,6 / 6,6,6 / 3,3,1
  check("ゾロ目で子が逆転", JSON.stringify(await settle()) === "[42,-18,-24]", JSON.stringify(await settle()));

  /* ───────── 親番3：じろう ───────── */
  await toNext();
  check("親は3人目", (await txt("#ba")).includes("3 / 3 人目"));
  await rollOnce(); await rollOnce(); await rollOnce();          // 4,5,6 / 1,2,3 / 5,5,5
  check("シゴロ対ヒフミの精算", JSON.stringify(await settle()) === "[30,-12,-18]", JSON.stringify(await settle()));
  check("一周したので成績へ", (await txt("#next-round")).includes("成績"), await txt("#next-round"));

  /* ───────── 成績 ───────── */
  await toNext();
  check("成績画面", await vis("#scr-over"));
  check("全1局と数える", (await txt("#ba")).includes("全 1 局"), await txt("#ba"));
  const final = await txt("#final");
  check("順位はたろうが上", final.indexOf("たろう") < final.indexOf("はなこ"));
  check("成績に勝敗が出る", /\d+ 勝 \d+ 敗/.test(final));
  check("ピンゾロが数えられている", final.includes("ピンゾロ 1"));
  check("ヒフミが数えられている", final.includes("ヒフミ 1"));
  check("パスが数えられている", final.includes("パス 1"));
  check("記録に3親番ぶん", (await txt("#log-list2")).includes("3 人目"));

  /* ───────── マムシ ───────── */
  await page.fill("#extra", "2");
  await page.click("#mamushi");
  check("マムシで対局に戻る", await vis("#scr-game"));
  check("全3局に延びる", (await txt("#ba")).includes("全 3 局"), await txt("#ba"));
  check("第2局から", (await txt("#ba")).includes("第 2 局"));
  check("親は一周して1人目に戻る", (await txt("#ba")).includes("1 / 3 人目"));
  check("点は引き継がれる", JSON.stringify(await scores("#scores")) === "[30,-12,-18]");

  /* ───────── 再開 ───────── */
  await page.reload();
  await page.waitForSelector("#scr-game:not([hidden])", { timeout: 3000 }).catch(() => {});
  check("再開後も対局画面", await vis("#scr-game"));
  check("再開後も第2局", (await txt("#ba")).includes("第 2 局"));
  check("再開後も点が残る", JSON.stringify(await scores("#scores")) === "[30,-12,-18]");

  /* ───────── 転がる時間 ───────── */
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p2 = await ctx2.newPage();
  await p2.goto(URL);
  const i2 = await p2.$$("#names input");
  await i2[0].fill("A"); await i2[1].fill("B");
  await p2.click("#start");
  const t0 = Date.now();
  await p2.click("#roll");
  await p2.waitForFunction(() => !document.getElementById("advance").hidden, null, { timeout: 8000 });
  const dur = Date.now() - t0;
  check("丼で 2 秒以上転がる", dur >= 2000, dur + "ms");
  check("転がりは 3.5 秒以内に収まる", dur <= 3500, dur + "ms");
  await ctx2.close();

  check("JS エラーなし", errors.length === 0, errors.join(" | "));
  await browser.close();
  server.close();
  console.log("\n" + pass + " 件 通過 / " + fail + " 件 失敗");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("EXCEPTION", e); process.exit(1); });
