/*
 * ドラマ検定を実ブラウザで確かめる。
 * Wikipedia への通信は差し替えるので、ネットにつながっていなくても走る。
 * 実行: node test/quiz.ui.js [drama/index.html]
 */
const { chromium } = require("/opt/node22/lib/node_modules/playwright");
const path = require("path");
const fs = require("fs");
const http = require("http");

const FILE = path.resolve(process.argv[2] || path.join(__dirname, "..", "drama", "index.html"));

let pass = 0, fail = 0;
function check(label, cond, extra){
  if(cond) pass++;
  else { fail++; console.log("NG  " + label + (extra !== undefined ? "\n    " + extra : "")); }
}
function eq(label, got, want){
  check(label, JSON.stringify(got) === JSON.stringify(want),
        "got  " + JSON.stringify(got) + "\n    want " + JSON.stringify(want));
}

/* ---- 差し替える記事 ---- */
const SUBS = ["おら、この海が好きだ！","おら、アイドルになりでぇ","おらの人生",
  "おら、友だちができた","おら、はじめての恋",  "おら、東京さ行くだ","おらの大失敗",
  "おら、迷子になった","おらの大逆転","おら、海女になる","おら、母ちゃんに会いてぇ",
  "おらの決心","おら、故郷さ帰る","おらの夏","おらの旅立ち"];
const EP_ROWS = SUBS.map((s, i) => `
  <tr><td>第${i + 1}回</td><td>2013年4月${i + 1}日</td><td>${s}</td><td>${(19.3 + i * 0.4).toFixed(1)}%</td></tr>`).join("");

const ARTICLE_HTML = `
<div class="mw-parser-output">
<table class="infobox">
  <tr><th colspan="2">あまちゃん</th></tr>
  <tr><th>ジャンル</th><td>テレビドラマ</td></tr>
  <tr><th>脚本</th><td>宮藤官九郎<sup class="reference">[1]</sup></td></tr>
  <tr><th>演出</th><td>井上剛<br>吉田照幸<br>梶原登城</td></tr>
  <tr><th>出演者</th><td>能年玲奈、小泉今日子、宮本信子、杉本哲太、尾美としのり、片桐はいり ほか</td></tr>
  <tr><th>音楽</th><td>大友良英</td></tr>
  <tr><th>原作</th><td>宮藤官九郎</td></tr>
  <tr><th>放送局</th><td>NHK総合テレビジョン</td></tr>
  <tr><th>放送期間</th><td>2013年4月1日 - 9月28日</td></tr>
  <tr><th>回数</th><td>全156回</td></tr>
</table>
<h2>各話</h2>
<table class="wikitable">
  <tr><th>話数</th><th>放送日</th><th>サブタイトル</th><th>視聴率</th></tr>
  ${EP_ROWS}
</table>
<table class="wikitable">
  <tr><th>関係ない表</th><th>列</th></tr>
  <tr><td>あ</td><td>い</td></tr>
</table>
</div>`;

const SEARCH_JSON = {
  query: { pages: [
    { pageid: 1, title: "あまちゃん", index: 1, description: "2013年のNHK連続テレビ小説" },
    { pageid: 2, title: "あまちゃんのうた", index: 2, description: "楽曲" }
  ]}
};

(async () => {
  const html = fs.readFileSync(FILE, "utf8");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port + "/";

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const asked = [];

  await page.route("**://ja.wikipedia.org/w/api.php**", route => {
    const u = new URL(route.request().url());
    const action = u.searchParams.get("action");
    asked.push(action);
    const body = action === "parse"
      ? { parse: { title: "あまちゃん", pageid: 1, text: ARTICLE_HTML } }
      : SEARCH_JSON;
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      body: JSON.stringify(body)
    });
  });

  page.on("pageerror", e => check("画面で例外が出ない", false, String(e)));
  await page.goto(base);

  /* ---- 入口 ---- */
  check("入口が出ている", await page.isVisible("#scr-home"));
  check("最初は「最初から」を出さない", await page.isHidden("#restart"));
  check("例の作品名が並ぶ", (await page.locator("#examples .ex").count()) >= 4);

  /* ---- 検索 ---- */
  await page.fill("#q", "あまちゃん");
  await page.click("#go");
  await page.waitForSelector("#scr-hits:not([hidden])");
  const hits = page.locator("#hits .hit");
  check("候補が出る", (await hits.count()) === 2);
  eq("ドラマらしい候補が先頭", (await hits.first().locator(".t").textContent()).trim(), "あまちゃん");

  /* ---- 記事の読み込みと出題 ---- */
  await hits.first().click();
  await page.waitForSelector("#scr-quiz:not([hidden])", { timeout: 10000 });
  eq("検索と記事取得の2回だけ通信する", asked, ["query", "parse"]);

  /* ---- パーサを直接あてる ---- */
  const parsed = await page.evaluate(h => {
    const doc = new DOMParser().parseFromString(h, "text/html");
    const info = window.__quiz.readInfobox(doc.body);
    const eps = window.__quiz.readEpisodes(doc.body);
    return { info, work: window.__quiz.makeWork("あまちゃん", "u", info, eps) };
  }, ARTICLE_HTML);

  eq("放送局を主要局名に寄せる", parsed.work.station, "NHK");
  eq("脚注を落として脚本を読む", parsed.work.writers, ["宮藤官九郎"]);
  eq("<br> 区切りの演出を割る", parsed.work.directors, ["井上剛", "吉田照幸", "梶原登城"]);
  eq("出演者から「ほか」を落とす", parsed.work.cast.length, 6);
  eq("放送開始日", parsed.work.start, { y: 2013, m: 4, d: 1 });
  eq("回数は infobox の値を優先", parsed.work.count, 156);
  eq("各話を拾う", parsed.work.episodes.length, 15);
  eq("先頭の各話", [parsed.work.episodes[0].no, parsed.work.episodes[0].subtitle,
                    parsed.work.episodes[0].rating],
     [1, "おら、この海が好きだ！", 19.3]);
  check("関係ない表は各話として拾わない", parsed.work.episodes.length === 15);

  /* ---- 10問を通しで解く ---- */
  eq("進捗の目盛りは10", await page.locator("#progress i").count(), 10);
  const seen = [];
  for(let i = 0; i < 10; i++){
    await page.waitForSelector("#choices .ch");
    const text = (await page.textContent("#qtext")).trim();
    seen.push(text);
    check("第" + (i + 1) + "問に設問がある", text.length > 4, text);
    eq("第" + (i + 1) + "問の選択肢は4つ", await page.locator("#choices .ch").count(), 4);
    check("第" + (i + 1) + "問は答える前は判定を出さない", await page.isHidden("#verdict"));

    await page.locator("#choices .ch").first().click();
    check("第" + (i + 1) + "問で判定が出る", await page.isVisible("#verdict"));
    check("第" + (i + 1) + "問で正解に印がつく",
          (await page.locator("#choices .ch.right").count()) === 1);
    check("第" + (i + 1) + "問は答えたら押せない",
          await page.locator("#choices .ch").first().isDisabled());
    await page.click("#next");
  }
  check("設問が重複しない", new Set(seen).size === 10, seen.join(" / "));

  /* ---- 結果 ---- */
  await page.waitForSelector("#scr-done:not([hidden])");
  const rank = (await page.textContent("#rank")).trim();
  check("称号が出る", rank.length > 0, rank);
  const score = +(await page.textContent("#score"));
  const full = +(await page.textContent("#full"));
  check("満点は出題の重みの合計", full === 3 * 1 + 4 * 2 + 3 * 3, full);
  check("得点は満点以下", score <= full, score + "/" + full);
  eq("振り返りは10件", await page.locator("#review .rv").count(), 10);
  eq("層ごとの内訳は3本", await page.locator("#bars .bar").count(), 3);
  check("出典に Wikipedia の記事へのリンクを置く",
        (await page.getAttribute("#src a", "href")).indexOf("ja.wikipedia.org/wiki/") > 0);

  /* ---- もう一度 ---- */
  await page.click("#again");
  await page.waitForSelector("#scr-quiz:not([hidden])");
  eq("もう一度でも通信し直さない", asked, ["query", "parse"]);
  check("もう一度で第1問に戻る", (await page.textContent("#qcount")).indexOf("第 1 問") >= 0);

  /* ---- 材料の乏しい記事 ---- */
  await page.click("#restart");
  await page.route("**://ja.wikipedia.org/w/api.php**", route => {
    const action = new URL(route.request().url()).searchParams.get("action");
    const body = action === "parse"
      ? { parse: { title: "情報の少ないドラマ", pageid: 9,
                   text: '<div><table class="infobox"><tr><th>放送局</th><td>NHK</td></tr></table></div>' } }
      : { query: { pages: [{ pageid: 9, title: "情報の少ないドラマ", index: 1, description: "テレビドラマ" }] } };
    route.fulfill({ status: 200,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      body: JSON.stringify(body) });
  });
  await page.fill("#q", "情報の少ないドラマ");
  await page.click("#go");
  await page.waitForSelector("#scr-hits:not([hidden])");
  await page.locator("#hits .hit").first().click();
  await page.waitForSelector("#scr-load:not([hidden])");
  await page.waitForFunction(() => document.getElementById("load-msg").textContent.indexOf("作れませんでした") >= 0,
                             null, { timeout: 10000 });
  check("問題を作れないときは理由を出す", true);
  check("そこから戻る道がある", await page.locator("#found button").count() > 0);

  await browser.close();
  server.close();
  console.log((fail ? "FAIL" : "PASS") + "  " + pass + " 件通過" + (fail ? " / " + fail + " 件失敗" : ""));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
