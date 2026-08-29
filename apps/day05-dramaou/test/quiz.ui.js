/*
 * ドラマ検定を実ブラウザで確かめる。
 * Wikipedia への通信は差し替えるので、ネットにつながっていなくても走る。
 * 実行: node test/quiz.ui.js [index.html]
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
<h2>登場人物</h2>
<dl><dt>天野アキ（あまの あき）</dt><dd>演 - 能年玲奈</dd><dd>本作の主人公。</dd></dl>
<dl><dt>天野春子（あまの はるこ）</dt><dd>演 - 小泉今日子</dd><dd>アキの母。</dd></dl>
<dl><dt>天野夏（あまの なつ）</dt><dd>演 - 宮本信子</dd><dd>アキの祖母。海女。</dd></dl>
<dl><dt>大向大吉（おおむかい だいきち）</dt><dd>演 - 杉本哲太</dd><dd>北三陸鉄道の駅長。</dd></dl>
<dl><dt>足立ヒロシ（あだち ひろし）</dt><dd>演 - 小池徹平</dd><dd>アキの同級生。</dd></dl>
<dl><dt>安部小百合（あべ さゆり）</dt><dd>演 - 片桐はいり</dd><dd>喫茶リアスの店主。</dd></dl>
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
  const parsed = await page.evaluate(h => ({
    work: window.__quiz.parseArticle("あまちゃん", h)
  }), ARTICLE_HTML);

  eq("放送局を主要局名に寄せる", parsed.work.station, "NHK");
  eq("脚注を落として脚本を読む", parsed.work.writers, ["宮藤官九郎"]);
  eq("<br> 区切りの演出を割る", parsed.work.directors, ["井上剛", "吉田照幸", "梶原登城"]);
  eq("出演者から「ほか」を落とす", parsed.work.cast.length, 6);
  eq("放送開始日", parsed.work.start, { y: 2013, m: 4, d: 1 });
  eq("回数は infobox の値を優先", parsed.work.count, 156);
  eq("各話を拾う", parsed.work.episodes.length, 15);
  eq("登場人物を拾う", parsed.work.characters.length, 6);
  eq("役名と俳優の組", [parsed.work.characters[0].role, parsed.work.characters[0].actor],
     ["天野アキ", "能年玲奈"]);
  eq("先頭の各話", [parsed.work.episodes[0].no, parsed.work.episodes[0].subtitle,
                    parsed.work.episodes[0].rating],
     [1, "おら、この海が好きだ！", 19.3]);
  check("関係ない表は各話として拾わない", parsed.work.episodes.length === 15);

  /* ---- 10問を通しで解く ---- */
  eq("進捗の目盛りは10", await page.locator("#progress i").count(), 10);
  const seen = [], lvs = [];
  for(let i = 0; i < 10; i++){
    await page.waitForSelector("#choices .ch");
    const text = (await page.textContent("#qtext")).trim();
    seen.push(text);
    lvs.push((await page.textContent("#qlv")).trim());
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
  check("スタッフを問う設問は出ない",
        !seen.some(t => /脚本|演出|音楽|原作|プロデューサー/.test(t)), seen.join(" / "));
  /* 外側の事実（放送局・放送年・話数）ではなく、中身を問う設問が中心であること。
     DAY10 で地の文からの出題が増えたので、その言い回しもここに含める。 */
  check("中身を問う設問が中心",
        seen.filter(t => /演じたのは|サブタイトル|第何話|出演|説明されるのは|にあたるのは|あらすじの一節/.test(t)).length >= 8,
        seen.join(" / "));

  /* ---- 結果 ---- */
  await page.waitForSelector("#scr-done:not([hidden])");
  const rank = (await page.textContent("#rank")).trim();
  check("称号が出る", rank.length > 0, rank);
  const score = +(await page.textContent("#score"));
  const full = +(await page.textContent("#full"));
  const weight = { "やさしい":1, "ふつう":2, "難しい":3 };
  const wantFull = lvs.reduce((a, l) => a + (weight[l] || 0), 0);
  check("満点は出題の重みの合計", full === wantFull, full + " / 期待 " + wantFull + "  " + lvs.join(","));
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

  /* ---- 今日つぶした取り違えを、記事の形で固定する ---- */
  const REG = await page.evaluate(() => {
    const P = window.__quiz;

    /* 半沢直樹。演出が rowspan でまたがり、サブタイトル列は無い */
    const hanzawa = `<div><table class="infobox">
      <tr><th>脚本</th><td>2013年版<br>八津弘幸<br>半沢直樹II<br>丑尾健太郎</td></tr>
      <tr><th>出演者</th><td>堺雅人、上戸彩、及川光博、片岡愛之助</td></tr>
      <tr><th>放送局</th><td>TBS系列</td></tr>
      <tr><th>放送期間</th><td>2013年7月7日 - 9月22日</td></tr>
      <tr><th>回数</th><td>全10話</td></tr></table>
      <table class="wikitable">
      <tr><th>話</th><th>放送日</th><th>演出</th><th>視聴率</th></tr>
      <tr><td>第1話</td><td>2013年7月7日</td><td rowspan="5">福澤克雄</td><td>19.4%</td></tr>
      <tr><td>第2話</td><td>2013年7月14日</td><td>21.8%</td></tr>
      <tr><td>第3話</td><td>2013年7月21日</td><td>22.9%</td></tr>
      <tr><td>第4話</td><td>2013年7月28日</td><td>27.6%</td></tr>
      <tr><td>第5話</td><td>2013年8月4日</td><td>29.0%</td></tr>
      <tr><td>第6話</td><td>2013年8月18日</td><td rowspan="5">棚澤孝義</td><td>29.0%</td></tr>
      <tr><td>第7話</td><td>2013年8月25日</td><td>30.0%</td></tr>
      <tr><td>第8話</td><td>2013年9月1日</td><td>32.9%</td></tr>
      <tr><td>第9話</td><td>2013年9月15日</td><td>35.9%</td></tr>
      <tr><td>第10話</td><td>2013年9月22日</td><td>42.2%</td></tr></table></div>`;

    /* プロポーズ大作戦。フジ版に「放送局」行が無く、韓国版に有る */
    const propose = `<div><table class="infobox">
      <tr><th>脚本</th><td>金子ありさ</td></tr>
      <tr><th>出演者</th><td>山下智久、長澤まさみ、榮倉奈々、藤木直人</td></tr>
      <tr><th>放送チャンネル</th><td>フジテレビ系列</td></tr>
      <tr><th>放送期間</th><td>2007年4月16日 - 6月25日</td></tr>
      <tr><th>回数</th><td>全11話</td></tr></table>
      <table class="infobox">
      <tr><th>放送局</th><td>テレビ朝鮮</td></tr>
      <tr><th>出演者</th><td>ユ・スンホ、パク・ウンビン</td></tr>
      <tr><th>放送期間</th><td>2012年2月20日 - 4月10日</td></tr></table></div>`;

    /* 花より男子。漫画・アニメ(テレビ朝日)・ドラマ(TBS)・韓国版が同居 */
    const ep = (n, label) => Array.from({length:n}, (_, i) =>
      `<tr><td>第${i+1}話</td><td>2005年10月${i+1}日</td><td>${label}${i+1}</td></tr>`).join("");
    const hanadan = `<div><table class="infobox">
      <tr><th>作者</th><td>神尾葉子</td></tr><tr><th>出版社</th><td>集英社</td></tr>
      <tr><th>掲載誌</th><td>マーガレット</td></tr><tr><th>巻数</th><td>全37巻</td></tr></table>
      <table class="infobox">
      <tr><th>アニメーション制作</th><td>東映動画</td></tr>
      <tr><th>シリーズ構成</th><td>富田祐弘</td></tr>
      <tr><th>キャラクターデザイン</th><td>山室直儀</td></tr>
      <tr><th>放送局</th><td>テレビ朝日</td></tr>
      <tr><th>放送期間</th><td>1996年9月8日 - 1997年8月31日</td></tr>
      <tr><th>話数</th><td>全51話</td></tr></table>
      <table class="infobox">
      <tr><th>脚本</th><td>サタケミキオ</td></tr><tr><th>演出</th><td>石井康晴</td></tr>
      <tr><th>出演者</th><td>井上真央、松本潤、小栗旬、松田翔太、阿部力</td></tr>
      <tr><th>放送局</th><td>TBS系列</td></tr>
      <tr><th>放送期間</th><td>2005年10月21日 - 12月16日</td></tr>
      <tr><th>回数</th><td>全9話</td></tr></table>
      <table class="wikitable"><tr><th>話数</th><th>放送日</th><th>サブタイトル</th></tr>${ep(51,"アニメ第")}</table>
      <table class="wikitable"><tr><th>話数</th><th>放送日</th><th>サブタイトル</th></tr>${ep(9,"ドラマ第")}</table></div>`;

    return {
      hanzawa: P.parseArticle("半沢直樹", hanzawa),
      propose: P.parseArticle("プロポーズ大作戦", propose),
      hanadan: P.parseArticle("花より男子", hanadan)
    };
  });

  /* 半沢直樹 */
  eq("rowspan があっても視聴率の列を取り違えない",
     REG.hanzawa.episodes.slice(0, 3).map(e => e.rating), [19.4, 21.8, 22.9]);
  check("サブタイトル列が無ければ空のままにする",
        REG.hanzawa.episodes.every(e => !e.subtitle),
        JSON.stringify(REG.hanzawa.episodes.map(e => e.subtitle)));
  eq("版の見出しを脚本家として拾わない", REG.hanzawa.writers, ["八津弘幸", "丑尾健太郎"]);
  eq("主人公の役名が作品名と同じでも残す",
     REG.hanzawa.station, "TBS");

  /* プロポーズ大作戦 */
  eq("箱をまたいで放送局を拾わない", REG.propose.station, "フジテレビ");
  eq("フジ版の出演者を保つ", REG.propose.cast[0], "山下智久");
  eq("韓国版の出演者を混ぜない", REG.propose.cast.indexOf("ユ・スンホ"), -1);

  /* 花より男子 */
  eq("漫画とアニメを避けてドラマの放送局を取る", REG.hanadan.station, "TBS");
  eq("ドラマの出演者を取る", REG.hanadan.cast[0], "井上真央");
  eq("ドラマの話数を取る", REG.hanadan.count, 9);
  eq("アニメ51話ではなくドラマ9話の表を取る", REG.hanadan.episodes.length, 9);
  check("アニメ側のサブタイトルを掴まない",
        REG.hanadan.episodes.every(e => e.subtitle.indexOf("アニメ") < 0),
        JSON.stringify(REG.hanadan.episodes.map(e => e.subtitle)));

  /* ==================== 地の文からの出題 ====================
     あらすじと人物の説明文から、物語の中身を問う問題が出るか。
     あわせて、外へ余計な通信をしていないことも見る。 */
  {
    const st = await browser.newContext();
    const sp = await st.newPage();

    const STORY = `<div class="mw-parser-output">
      <table class="infobox">
        <tr><th>出演者</th><td>能年玲奈、小泉今日子、宮本信子、杉本哲太、小池徹平、片桐はいり</td></tr>
        <tr><th>放送局</th><td>NHK総合テレビジョン</td></tr>
        <tr><th>放送期間</th><td>2013年4月1日 - 9月28日</td></tr>
        <tr><th>回数</th><td>全156回</td></tr></table>
      <h2>あらすじ</h2>
      <p>東京で内気に育ったアキは、母に連れられて母の故郷である北三陸へやってくる。
      大吉は北三陸鉄道の駅長として、地元を盛り上げようと奔走する。
      小百合は喫茶リアスを切り盛りしながら、若者たちを見守っている。
      ヒロシは無口な同級生で、やがて自分の道を選びとっていく。</p>
      <h2>登場人物</h2>
      <dl><dt>天野アキ</dt><dd>演 - 能年玲奈</dd><dd>本作の主人公。東京育ちの内気な女子高生で、北三陸で海女を目指す。</dd></dl>
      <dl><dt>天野春子</dt><dd>演 - 小泉今日子</dd><dd>アキの母。かつて上京しアイドルを目指した過去がある。</dd></dl>
      <dl><dt>天野夏</dt><dd>演 - 宮本信子</dd><dd>北三陸で長年働く現役の海女。</dd></dl>
      <dl><dt>大向大吉</dt><dd>演 - 杉本哲太</dd><dd>北三陸鉄道の駅長。地元の観光振興に奔走する。</dd></dl>
      <dl><dt>足立ヒロシ</dt><dd>演 - 小池徹平</dd><dd>アキの同級生。無口だが実直な高校生。</dd></dl>
      <dl><dt>安部小百合</dt><dd>演 - 片桐はいり</dd><dd>喫茶リアスの店主。若者たちを見守る。</dd></dl>
      <h2>外部リンク</h2><p>公式サイトはこちら。番組の公式ページへ移動します。</p>
      </div>`;

    /* Wikipedia 以外の宛先に出ていないことを見張る */
    const outside = [];
    await sp.route("**/*", route => {
      const u = route.request().url();
      /* 書体の読み込みは DAY5 からある。ここで見張りたいのは、
         問題を作るために外部のAPIを呼んでいないかどうか。 */
      const ok = /^https?:\/\/127\.0\.0\.1/.test(u) || /ja\.wikipedia\.org/.test(u)
              || /fonts\.(googleapis|gstatic)\.com/.test(u);
      if(!ok) outside.push(u);
      route.continue();
    });
    await sp.route("**://ja.wikipedia.org/w/api.php**", route => {
      const action = new URL(route.request().url()).searchParams.get("action");
      const body = action === "parse"
        ? { parse: { title: "あまちゃん", pageid: 1, text: STORY } }
        : SEARCH_JSON;
      route.fulfill({ status: 200,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        body: JSON.stringify(body) });
    });
    sp.on("pageerror", e => check("地の文の出題で例外が出ない", false, String(e)));

    await sp.goto(base);
    await sp.fill("#q", "あまちゃん");
    await sp.click("#go");
    await sp.waitForSelector("#scr-hits:not([hidden])");
    await sp.locator("#hits .hit").first().click();
    await sp.waitForSelector("#scr-quiz:not([hidden])", { timeout: 10000 });

    const texts = [];
    const n = await sp.locator("#progress i").count();
    for(let i = 0; i < n; i++){
      await sp.waitForSelector("#choices .ch:not([disabled])");
      texts.push((await sp.textContent("#qtext")).trim());
      await sp.locator("#choices .ch").first().click();
      await sp.click("#next");
    }
    const joined = texts.join(" / ");
    check("外部リンクの文からは出題しない", !/公式サイト/.test(joined), joined);

    /* どの種類が画面に並ぶかは種しだいなので、ここは種を固定して確かめる。
       実際に出た1回ぶんだけを見ると、種によって通ったり落ちたりする。 */
    const kinds = await sp.evaluate(a => {
      const Q = window.__quiz, w = Q.parseArticle("あまちゃん", a), got = {};
      for(let s = 1; s <= 20; s++){
        Q.buildQuiz(w, s * 7919).forEach(q => { got[String(q.id).split("#")[0]] = 1; });
      }
      return Object.keys(got);
    }, STORY);
    check("説明文から役名を当てる設問を作る", kinds.indexOf("chardesc") >= 0, kinds.join(","));
    check("人物の関係を問う設問を作る", kinds.indexOf("relation") >= 0, kinds.join(","));
    check("あらすじの空欄補充を作る", kinds.indexOf("cloze") >= 0, kinds.join(","));

    await sp.waitForSelector("#scr-done:not([hidden])");
    eq("問題を作るために外部のAPIを呼ばない", outside, []);
    check("APIキーを入れる欄は無い", (await sp.locator("#ai-key").count()) === 0);
    check("費用の表示も無い", !/\$/.test(await sp.textContent("#scr-done")));

    /* もう一度：記事を取り直さない */
    await sp.click("#again");
    await sp.waitForSelector("#scr-quiz:not([hidden])");
    check("もう一度で第1問に戻る", (await sp.textContent("#qcount")).indexOf("第 1 問") >= 0);
    eq("もう一度でも外部のAPIを呼ばない", outside, []);

    await st.close();
  }

  await browser.close();
  server.close();
  console.log((fail ? "FAIL" : "PASS") + "  " + pass + " 件通過" + (fail ? " / " + fail + " 件失敗" : ""));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
