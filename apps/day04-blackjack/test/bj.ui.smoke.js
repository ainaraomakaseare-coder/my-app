/*
 * 実ブラウザで一局を通し、伏せた札が漏れないことまで確かめる。
 * 乱数は仕込んであるので結果は毎回同じになる。
 * 実行: node test/bj.ui.smoke.js [index.html]
 */
const { chromium } = require("/opt/node22/lib/node_modules/playwright");
const path = require("path");
const fs = require("fs");
const http = require("http");

const FILE = path.resolve(process.argv[2] || path.join(__dirname, ".." , "index.html"));

let pass = 0, fail = 0;
function check(label, cond, extra){
  if(cond) pass++;
  else { fail++; console.log("NG  " + label + (extra !== undefined ? "\n    " + extra : "")); }
}

/* 二十枚は数字順に並ぶ。赤は ♦ → ♥、黒は ♣ → ♠ の順なので位置は毎回同じ。 */
const at = n => 2 * (n - 1);          /* その数字の一枚目（♦ / ♣）の位置 */

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
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ctx.addInitScript(() => {                       // 山の順を毎回同じにする
    let s = 20260826;
    Math.random = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  });

  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if(m.type() === "error" && !/font|net::/i.test(m.text())) errors.push(m.text()); });
  await page.goto(URL);

  const vis   = s => page.isVisible(s);
  const text  = s => page.textContent(s).then(t => (t || "").trim());
  const count = s => page.locator(s).count();
  const tap   = async s => { await page.click(s); await page.waitForTimeout(30); };
  const guard = async () => { if(await vis("#scr-guard")) await tap("#b-guard"); };
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem("yunyu-blackjack-v1")).S);

  /* ---- タイトルと設定 ---- */
  check("タイトルが出る", await vis("#scr-title"));
  check("途中の対局がなければ「続きから」は出ない", !(await vis("#b-resume")));
  await tap("#b-rules");
  check("ルールが読める", await vis("#scr-rules"));
  await tap("#b-rules-close");
  await tap("#b-start");
  check("設定画面に進む", await vis("#scr-setup"));
  await page.fill("#nm0", "あかね");
  await page.fill("#nm1", "くろべ");
  await tap('#pick-color button[data-color="RED"]');
  await tap("#b-begin");

  /* ---- 一人目の手札選択 ---- */
  check("いきなり札は見えず、受け渡しから始まる", await vis("#scr-guard"));
  check("受け渡し画面に渡す相手の名前が出る", (await text("#g-to")).includes("あかね"));
  await guard();
  check("手札選択に入る", await vis("#scr-select"));
  check("二十枚が並ぶ", await count("#s-deck .card") === 20);
  check("一人目は赤の二十枚", await count("#s-deck .card.red") === 20);

  /* 22 になる四枚は確定できない */
  for(const i of [at(10), at(10) + 1, at(1), at(1) + 1]) await tap(`#s-deck .card >> nth=${i}`);
  check("合計 22 と表示される", await text("#s-sum") === "22");
  check("超過の警告が出る", await vis("#s-warn"));
  check("22 では確定できない", await page.isDisabled("#b-select"));
  await tap("#b-clear");
  check("選び直すと 0 に戻る", await text("#s-sum") === "0");

  /* 10・9・A・A = 21 を、この順で選ぶ */
  for(const i of [at(10), at(9), at(1), at(1) + 1]) await tap(`#s-deck .card >> nth=${i}`);
  check("合計 21 になる", await text("#s-sum") === "21");
  check("二十一まで 0", await text("#s-left") === "0");
  check("21 なら確定できる", !(await page.isDisabled("#b-select")));
  check("選んだ順に並ぶ", await page.locator("#s-hand .card .cn").allTextContents()
        .then(v => v.join(",")) === "10,9,A,A");
  await tap("#b-select");

  /* ---- 二人目の手札選択 ---- */
  check("二人目の前に受け渡しが入る", await vis("#scr-guard"));
  check("受け渡し先が二人目に変わる", (await text("#g-to")).includes("くろべ"));
  await guard();
  check("二人目は黒の二十枚", await count("#s-deck .card.black") === 20);
  for(const i of [at(5), at(5) + 1, at(4), at(4) + 1]) await tap(`#s-deck .card >> nth=${i}`);
  check("二人目は合計 18", await text("#s-sum") === "18");
  await tap("#b-select");

  /* ---- 公開札の指名 ---- */
  await guard();
  check("公開札の指名に進む", await vis("#scr-reveal"));
  check("相手の四枚はすべて裏向き", await count("#r-hand .card.back") === 4);
  check("裏向きの札に数字は出ていない",
        (await page.locator("#r-hand").textContent()).replace(/[^0-9A]/g, "") === "1234");
  check("選ぶまでは確定できない", await page.isDisabled("#b-reveal"));
  await tap("#r-hand .card >> nth=0");
  await tap("#b-reveal");
  await guard();
  await tap("#r-hand .card >> nth=0");
  await tap("#b-reveal");

  /* ---- 先攻決定 ---- */
  check("先攻決定に進む", await vis("#scr-draw"));
  const dq = await state();
  check("引くのは手札に使わなかった十六枚から",
        [0, 1].every(p => dq.pool[p].length + dq.draws[p].length === 16));
  check("引いた札は手札と重ならない",
        [0, 1].every(p => dq.draws[p].every(c => !dq.hands[p].some(h => h.id === c.id))));
  check("引き直しがあっても最後の二枚は数字が違う",
        dq.draws[0].slice(-1)[0].n !== dq.draws[1].slice(-1)[0].n);
  check("大きい数字を引いた方が選ぶ",
        dq.chooser === (dq.draws[0].slice(-1)[0].n > dq.draws[1].slice(-1)[0].n ? 0 : 1));
  await tap("#b-go-first");

  /* ---- 先攻の宣言 ---- */
  await guard();
  check("宣言画面に進む", await vis("#scr-act"));
  const s1 = await state();
  check("宣言するのは先攻", s1.turn === s1.first);
  check("自分の四枚が見える", await count("#a-hand .card") === 4);
  check("分かっているのは公開札の一枚だけ", await count("#a-known .card") === 1);
  await tap("#b-trade");

  /* ---- 一回目の交換 ---- */
  check("宣言した本人は渡さず、そのまま札を選ぶ", await vis("#scr-trade"));
  check("出す札を選ぶまでは進めない", await page.isDisabled("#b-give"));
  await tap("#t-hand .card >> nth=3");
  await tap("#b-give");
  check("相手が選ぶ前に受け渡しが入る", await vis("#scr-guard"));
  await guard();
  await tap("#t-hand .card >> nth=3");
  await tap("#b-give");
  check("交換の結果が二人に見える", await vis("#scr-swap"));
  check("出した二枚がどちらも表向き", await count("#w-body .card") === 2 &&
        await count("#w-body .card.back") === 0);
  await tap("#b-swap-next");

  /* ---- 後攻の宣言 ---- */
  await guard();
  check("後攻の宣言に移る", await vis("#scr-act"));
  const s2 = await state();
  check("後攻の番になっている", s2.turn === 1 - s2.first);
  check("交換は一回済み", s2.tradeNo === 1);
  check("渡した札のぶん、分かる札が二枚に増える", await count("#a-known .card") === 2);
  check("交換した枠には相手の色の札が入る",
        s2.hands[0][3].color === s2.colors[1] && s2.hands[1][3].color === s2.colors[0],
        s2.hands[0][3].id + " / " + s2.hands[1][3].id);
  check("交換していない枠は自分の色のまま",
        [0, 1, 2].every(i => s2.hands[0][i].color === s2.colors[0] &&
                             s2.hands[1][i].color === s2.colors[1]));
  check("公開枠の位置は交換で動かない", s2.open[0] === 0 && s2.open[1] === 0);
  await tap("#b-check");

  /* ---- 結果 ---- */
  check("結果が出る", await vis("#scr-result"));
  const s3 = await state();
  const tot = h => h.reduce((a, c) => a + c.n, 0);
  check("八枚すべて公開される", await count("#v-board .card") === 8 &&
        await count("#v-board .card.back") === 0);
  check("勝者の表示が判定と合う",
        (await text("#v-big")) === (s3.result.winner === -1 ? "引き分け" : s3.names[s3.result.winner] + " の勝ち"),
        await text("#v-big"));
  check("勝敗理由が出る", (await text("#v-why")).length > 0);
  check("合計が手札と合う",
        (await page.locator("#v-board .sum").allTextContents())
          .map(t => parseInt(t, 10)).join(",") === [tot(s3.hands[0]), tot(s3.hands[1])].join(","));
  check("通算成績が一局ぶん増える",
        s3.record.win[0] + s3.record.win[1] + s3.record.draw === 1);
  check("交換は最大二回に収まる", s3.tradeNo <= 2);

  /* ---- 決着の演出 ---- */
  const hasClass = (sel, cls) => page.evaluate(([s, c]) =>
    document.querySelector(s).classList.contains(c), [sel, cls]);
  check("決着した直後は演出が付く", await hasClass("#scr-result", "celebrate"));
  check("八枚とも順にめくれる", await count("#v-board .card.reveal") === 8);
  check("札のラベルも一緒に出る", await count("#v-board .lb.reveal-lb") === 8);
  check("めくる間は席ごとにずれていく",
        await page.locator("#v-board .card.reveal").evaluateAll(
          els => els.map(e => parseInt(e.style.animationDelay, 10))
        ).then(d => d.join(",")) === "0,95,190,285,460,555,650,745");
  check("金粉の受け皿が結果画面にある", await count("#scr-result > #v-dust") === 1);
  check("演出中でも合計はすぐ読める",
        (await page.locator("#v-board .sum").allTextContents()).every(t => /\d/.test(t)));
  await tap("#t-rules");
  await tap("#b-rules-close");
  check("ルールを見て戻っても演出はやり直さない", !(await hasClass("#scr-result", "celebrate")));
  check("戻っても八枚は出たまま", await count("#v-board .card") === 8);

  /* ---- 再戦 ---- */
  await tap("#b-again");
  check("再戦は受け渡しから", await vis("#scr-guard"));
  check("第二局と表示される", (await text("#ba")).includes("第 2 局"));
  await guard();
  check("再戦で赤黒が入れ替わる", await count("#s-deck .card.black") === 20);

  /* ---- 中断して再開 ---- */
  await page.reload();
  check("読み直すとタイトルに戻る", await vis("#scr-title"));
  check("途中の対局があれば「続きから」が出る", await vis("#b-resume"));
  await tap("#b-resume");
  check("再開は必ず受け渡しから", await vis("#scr-guard"));
  await guard();
  check("中断したところから続く", await vis("#scr-select"));
  check("第二局のまま", (await text("#ba")).includes("第 2 局"));

  check("JS エラーなし", errors.length === 0, errors.join(" | "));
  await browser.close();
  server.close();
  console.log("\n" + pass + " 件 通過 / " + fail + " 件 失敗");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("EXCEPTION", e); process.exit(1); });
