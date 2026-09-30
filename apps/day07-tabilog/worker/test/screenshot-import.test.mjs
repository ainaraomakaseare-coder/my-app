/*
 * スクショから予定を作る（docs/adr/0022）の純粋関数の単体テスト。
 * OpenAI・Google（Vision／Places）は一切呼ばない。実際の予約画面・チケットのOCR結果に近い
 * 文章と、AIが返したはずのJSON（モック）を用意して、検証・補正・地図付け・保存前の再検証を確かめる。
 * 実行: node worker/test/screenshot-import.test.mjs
 */
import assert from "node:assert/strict";
import {
  SCREENSHOT_MAX_PLACE_LOOKUPS, estimateSubrequests, buildVisionBatchBody, parseVisionBatchResponse,
  receiptHintFor, buildOcrSection, buildScreenshotPrompt, screenshotSchema, normalizeTime, resolveDate,
  normalizeScreenshotResult, collectPlaceQueries, parseTextSearchResponse, buildTextSearchRequest,
  attachPlaces, placeKey, validateSaveItems, validateImagesInput, dateInTrip, addDays,
} from "../src/screenshot-import.js";

let pass = 0, fail = 0;
function check(label, got, want) {
  try { assert.deepEqual(got, want); pass++; }
  catch { fail++; console.log("NG  " + label + "\n    got  " + JSON.stringify(got) + "\n    want " + JSON.stringify(want)); }
}
function ok(label, cond) { check(label, !!cond, true); }

const TRIP = { startDate: "2026-10-03", endDate: "2026-10-06" };

/* ---- 実際の画面に近いOCR結果（モック） ---- */
const OCR = {
  jal: "JAL 予約確認\n2026年10月3日(土)\nJAL903便\n羽田 HANEDA 09:30 発\n那覇 NAHA 12:05 着\n運賃 ¥18,700\n座席 24A\nご予約番号 ABC123\nご搭乗者 ヤマダ タロウ",
  hotel: "Booking.com\nホテル日航那覇グランドキャッスル\n〒900-0006 沖縄県那覇市おもろまち4-4-1\nチェックイン 10月3日(土)\nチェックアウト 10月5日(月)\n2泊\n合計 ¥38,400\n確認番号 5551234567",
  ex: "エクスプレス予約\n10月6日(火)\n東京 → 新大阪\nのぞみ25号 17:03発 19:34着\n普通車指定席 12号車 8番A席\nきっぷ代金 ¥14,720",
  maps: "8:12発 → 8:47着 (35分)\n小田急線 急行 新宿方面\n町田駅 → 新宿駅\n¥260\n徒歩 5分",
  baystars: "横浜DeNAベイスターズ\n2026 公式戦\nvs 阪神タイガース\n10月4日(日) 14:00 試合開始\n横浜スタジアム\n内野指定席B 4,800円",
  manzai: "なんばグランド花月\n漫才劇場 10月5日 19:00開演\n前売 3,500円",
  receipt: "ローソン 那覇おもろまち店\n2026/10/03 17:42\nおにぎり 鮭 ¥150\nサンドイッチ ¥298\n小計 ¥448\n合計 ¥448\nお預り ¥500\nお釣り ¥52",
};

/* ---- サブリクエストの見積もり ---- */
{
  const e = estimateSubrequests(10, 12);
  check("見積もり: 10枚・場所12件は 1+1+12+10=24", [e.vision, e.openai, e.places, e.d1, e.total], [1, 1, 12, 10, 24]);
  ok("見積もり: 50回以内", e.ok);
  check("見積もり: 場所検索は12件を超えて数えない", estimateSubrequests(10, 99).places, SCREENSHOT_MAX_PLACE_LOOKUPS);
  check("見積もり: 画像0枚ならVisionは0回", estimateSubrequests(0, 0).vision, 0);
}

/* ---- Vision（バッチ） ---- */
{
  const body = buildVisionBatchBody(["AAA", "BBB", "CCC"]);
  check("Visionのボディ: 画像の数だけ requests", body.requests.length, 3);
  check("Visionのボディ: 機能と言語ヒント", [body.requests[0].features[0].type, body.requests[2].imageContext.languageHints], ["DOCUMENT_TEXT_DETECTION", ["ja"]]);
  const parsed = parseVisionBatchResponse({
    responses: [{ fullTextAnnotation: { text: "  こんにちは  " } }, { error: { code: 3 } }, {}],
  }, 4);
  check("Vision応答: 1枚目は文字あり", parsed[0], { index: 0, text: "こんにちは", reason: "" });
  check("Vision応答: errorはread_error", parsed[1].reason, "read_error");
  check("Vision応答: 文字なしはno_text", parsed[2].reason, "no_text");
  check("Vision応答: 応答が足りない画像はread_error", parsed[3].reason, "read_error");
  check("Vision応答: 壊れたデータでも落ちない", parseVisionBatchResponse(null, 2).map((x) => x.reason), ["read_error", "read_error"]);
}

/* ---- プロンプト ---- */
{
  ok("レシートのヒント: 品目が取れる", receiptHintFor(OCR.receipt).includes("おにぎり 鮭 150円"));
  check("レシートのヒント: 航空券には付けない", receiptHintFor(OCR.jal), "");
  const section = buildOcrSection([{ index: 0, text: OCR.jal }, { index: 4, text: OCR.receipt }]);
  ok("OCR節: 画像番号は1始まり", section.includes("【画像1】") && section.includes("【画像5】"));
  ok("OCR節: レシートだけに参考が付く", section.split("参考：ルール解析").length === 2);
  const prompt = buildScreenshotPrompt([{ index: 0, text: OCR.jal }], TRIP);
  ok("プロンプト: 旅行の日程が入る", prompt.includes("2026-10-03 〜 2026-10-06"));
  ok("プロンプト: OCR本文が入る", prompt.includes("JAL903便"));
  ok("プロンプト: 予約番号・氏名を書かない指示", prompt.includes("予約番号") && prompt.includes("氏名"));
  ok("プロンプト: 日程未設定でも作れる", buildScreenshotPrompt([{ index: 0, text: "x" }], {}).includes("日程は未設定"));
}

/* ---- スキーマ（OpenAIのstrictは、全項目がrequired・additionalProperties:false） ---- */
{
  const bad = [];
  (function walk(node, path) {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") {
      const keys = Object.keys(node.properties || {});
      if (node.additionalProperties !== false) bad.push(path + ": additionalProperties");
      if (JSON.stringify([...keys].sort()) !== JSON.stringify([...(node.required || [])].sort())) bad.push(path + ": required");
      keys.forEach((k) => walk(node.properties[k], path + "." + k));
    }
    if (node.type === "array") walk(node.items, path + "[]");
  })(screenshotSchema(), "root");
  check("スキーマ: strictの条件を満たす", bad, []);
}

/* ---- 時刻・日付 ---- */
{
  check("時刻: 9:05", normalizeTime("9:05"), "09:05");
  check("時刻: 全角と「発」", normalizeTime("１７：０３発"), "17:03");
  check("時刻: 午後3時", normalizeTime("午後3時"), "15:00");
  check("時刻: 午後3:30", normalizeTime("午後3:30"), "15:30");
  check("時刻: 12:00 AM", normalizeTime("12:00 AM"), "00:00");
  check("時刻: 25:00は不正", normalizeTime("25:00"), "");
  check("時刻: 空", normalizeTime(""), "");
  check("日付: 年あり", resolveDate("2026-10-03", TRIP), { date: "2026-10-03", yearInferred: false });
  check("日付: 年なし（--MM-DD）は旅行の年", resolveDate("--10-03", TRIP), { date: "2026-10-03", yearInferred: true });
  check("日付: 10月3日(土)", resolveDate("10月3日(土)", TRIP), { date: "2026-10-03", yearInferred: true });
  check("日付: 全角 １０/５", resolveDate("１０/５", TRIP), { date: "2026-10-05", yearInferred: true });
  check("日付: 2026年10月3日", resolveDate("2026年10月3日", TRIP), { date: "2026-10-03", yearInferred: false });
  check("日付: 年をまたぐ旅行の1/1は翌年", resolveDate("--01-01", { startDate: "2026-12-30", endDate: "2027-01-02" }), { date: "2027-01-01", yearInferred: true });
  check("日付: 年をまたぐ旅行の12/31は前の年", resolveDate("12/31", { startDate: "2026-12-30", endDate: "2027-01-02" }), { date: "2026-12-31", yearInferred: true });
  check("日付: 存在しない日は読めない扱い", resolveDate("2026-02-30", TRIP), null);
  check("日付: 2/30（年なし）も読めない扱い", resolveDate("--02-30", TRIP), null);
  check("日付: 空", resolveDate("", TRIP), null);
  check("日付: 日程が無ければ今日の年", resolveDate("--03-05", {}, "2026-09-30"), { date: "2026-03-05", yearInferred: true });
  check("日付: 日程の外でも近い年で読む", resolveDate("--10-20", TRIP).date, "2026-10-20");
  check("addDays: 月またぎ", addDays("2026-10-31", 1), "2026-11-01");
  ok("dateInTrip: 範囲内", dateInTrip("2026-10-04", TRIP));
  ok("dateInTrip: 範囲外", !dateInTrip("2026-10-07", TRIP));
  ok("dateInTrip: 日程未設定は常にtrue", dateInTrip("2030-01-01", {}));
}

/* ---- AIの出力の補正：モックの出力（画像の順は jal, hotel, ex, maps, baystars, manzai, receipt） ---- */
function raw(over) {
  return {
    image: 1, category: "other", transport: "", date: "", time: "", label: "", routeNumber: "", company: "",
    fromPlace: "", toPlace: "", departTime: "", arriveTime: "", arriveDate: "", place: "", placeGuessed: false,
    checkOutDate: "", costItems: [], note: "", ...over,
  };
}
const AI = {
  items: [
    raw({ image: 1, category: "transport", transport: "plane", date: "--10-03", label: "羽田→那覇 JAL903", routeNumber: "JAL903", company: "日本航空", fromPlace: "羽田空港", toPlace: "那覇空港", departTime: "09:30", arriveTime: "12:05", arriveDate: "--10-03", costItems: [{ label: "運賃", amount: 18700, currency: "" }], note: "座席24A" }),
    raw({ image: 2, category: "lodging", date: "--10-03", label: "ホテル日航那覇グランドキャッスル", place: "ホテル日航那覇グランドキャッスル 那覇市おもろまち", checkOutDate: "--10-05", costItems: [{ label: "宿泊料金", amount: 38400, currency: "" }] }),
    raw({ image: 3, category: "transport", transport: "shinkansen", date: "--10-06", label: "東京→新大阪 のぞみ25号", routeNumber: "のぞみ25号", company: "JR東海", fromPlace: "東京駅", toPlace: "新大阪駅", departTime: "17:03", arriveTime: "19:34", arriveDate: "--10-06", costItems: [{ label: "きっぷ代金", amount: 14720, currency: "" }], note: "12号車 8番A席" }),
    raw({ image: 4, category: "transport", transport: "train", date: "", label: "町田→新宿 小田急線急行", fromPlace: "町田駅", toPlace: "新宿駅", departTime: "8:12", arriveTime: "8:47", costItems: [{ label: "運賃", amount: 260, currency: "" }] }),
    raw({ image: 5, category: "sightseeing", date: "--10-04", time: "14:00", label: "横浜DeNAベイスターズ戦", place: "横浜スタジアム", costItems: [{ label: "チケット代", amount: 4800, currency: "" }] }),
    raw({ image: 6, category: "sightseeing", date: "--10-05", time: "19:00", label: "漫才劇場公演", place: "なんばグランド花月", placeGuessed: true, costItems: [{ label: "チケット代", amount: 3500, currency: "" }] }),
    raw({ image: 7, category: "food", date: "2026-10-03", time: "17:42", label: "ローソン 那覇おもろまち店", place: "ローソン 那覇おもろまち店", costItems: [{ label: "おにぎり 鮭", amount: 150, currency: "" }, { label: "サンドイッチ", amount: 298, currency: "" }] }),
  ],
  unreadableImages: [{ image: 8, reason: "no_event" }],
};
const norm = normalizeScreenshotResult(JSON.parse(JSON.stringify(AI)), { trip: TRIP, imageCount: 8, today: "2026-09-30" });
{
  const by = (label) => norm.items.find((i) => i.label === label);
  // 宿泊が2泊に展開され、7件→8件
  check("補正: 宿泊は2泊ぶんに展開される", norm.items.filter((i) => i.category === "lodging").map((i) => [i.date, i.nightIndex]), [["2026-10-03", 0], ["2026-10-04", 1]]);
  check("補正: 件数（7件＋宿の追加1泊）", norm.items.length, 8);
  check("補正: 捨てた件数は0", norm.dropped, 0);
  check("補正: idは連番", norm.items.map((i) => i.id), ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]);

  const jal = by("羽田→那覇 JAL903");
  check("JAL: 日付は旅行の年を補う", jal.date, "2026-10-03");
  check("JAL: 時刻は出発時刻", jal.time, "09:30");
  check("JAL: 出発・到着", [jal.departTime, jal.arriveTime, jal.arriveDate], ["09:30", "12:05", "2026-10-03"]);
  check("JAL: 費用は円のまま", jal.costItems, [{ label: "運賃", amount: 18700 }]);
  check("JAL: 移動手段", [jal.category, jal.transport, jal.company, jal.routeNumber], ["transport", "plane", "日本航空", "JAL903"]);
  ok("JAL: 年を補った旨の警告", jal.warnings.some((w) => w.includes("2026年")));
  ok("JAL: 予約番号・氏名はどこにも入らない", !JSON.stringify(norm).includes("ABC123") && !JSON.stringify(norm).includes("ヤマダ"));

  const h1 = norm.items.find((i) => i.category === "lodging" && i.nightIndex === 0);
  const h2 = norm.items.find((i) => i.category === "lodging" && i.nightIndex === 1);
  check("ホテル: チェックイン時刻が無く、到着12:05なので15:00", [h1.time, h1.timeEstimated], ["15:00", true]);
  check("ホテル: 2泊目は時刻なし・費用は1泊目にだけ付く", [h2.time, h2.costItems, h1.costItems.length], ["", [], 1]);
  check("ホテル: 場所の検索名", h1.place, "ホテル日航那覇グランドキャッスル 那覇市おもろまち");

  const ex = by("東京→新大阪 のぞみ25号");
  check("EX: 金額つき", ex.costItems, [{ label: "きっぷ代金", amount: 14720 }]);
  check("EX: 新幹線", [ex.transport, ex.time, ex.arriveTime], ["shinkansen", "17:03", "19:34"]);

  const maps = by("町田→新宿 小田急線急行");
  check("マップ: 日付が読めなければ旅行の初日にして警告", [maps.date, maps.warnings.some((w) => w.includes("日付が読み取れませんでした"))], ["2026-10-03", true]);
  check("マップ: 時刻の補正 8:12→08:12", [maps.time, maps.departTime, maps.arriveTime], ["08:12", "08:12", "08:47"]);

  const bs = by("横浜DeNAベイスターズ戦");
  check("野球: 会場は検索名として持つ（固定リストではなくplace）", [bs.place, bs.time, bs.category, bs.transport], ["横浜スタジアム", "14:00", "sightseeing", ""]);
  const mz = by("漫才劇場公演");
  ok("漫才劇場: 推測した会場には警告", mz.placeGuessed && mz.warnings.some((w) => w.includes("推測")));
  const rc = by("ローソン 那覇おもろまち店");
  check("レシート: 品目ごとの費用", rc.costItems.map((c) => c.amount), [150, 298]);
  check("読み取れなかった画像（AIの判定）は0始まりで返る", norm.unreadable, [{ image: 7, reason: "no_event" }]);
}

/* ---- チェックイン時刻の既定：到着が遅い日 ---- */
{
  const lateAi = { items: [
    raw({ image: 1, category: "transport", transport: "plane", date: "--10-03", label: "羽田→那覇 ANA495", fromPlace: "羽田空港", toPlace: "那覇空港", departTime: "16:30", arriveTime: "18:45", arriveDate: "--10-03" }),
    raw({ image: 2, category: "lodging", date: "--10-03", label: "ホテルA", place: "ホテルA", checkOutDate: "--10-04" }),
  ], unreadableImages: [] };
  const r = normalizeScreenshotResult(lateAi, { trip: TRIP, imageCount: 2 });
  const hotel = r.items.find((i) => i.category === "lodging");
  check("遅い到着: 18:45着なら19:45にチェックイン", [hotel.time, hotel.timeEstimated], ["19:45", true]);

  const midnight = normalizeScreenshotResult({ items: [
    raw({ image: 1, category: "transport", transport: "plane", date: "--10-03", label: "便", departTime: "21:00", arriveTime: "23:40", arriveDate: "--10-03" }),
    raw({ image: 2, category: "lodging", date: "--10-03", label: "ホテルB", place: "ホテルB" }),
  ], unreadableImages: [] }, { trip: TRIP, imageCount: 2 });
  check("遅い到着: 24時をこえない", midnight.items.find((i) => i.category === "lodging").time, "23:59");

  const given = normalizeScreenshotResult({ items: [
    raw({ image: 1, category: "transport", transport: "plane", date: "--10-03", label: "便", departTime: "16:00", arriveTime: "19:00" }),
    raw({ image: 2, category: "lodging", date: "--10-03", time: "16:30", label: "ホテルC", place: "ホテルC" }),
  ], unreadableImages: [] }, { trip: TRIP, imageCount: 2 });
  const g = given.items.find((i) => i.category === "lodging");
  check("チェックイン時刻が書かれていれば変えない", [g.time, g.timeEstimated], ["16:30", false]);

  const nextDay = normalizeScreenshotResult({ items: [
    raw({ image: 1, category: "transport", transport: "plane", date: "--10-02", label: "深夜便", departTime: "23:00", arriveTime: "01:30", arriveDate: "--10-03" }),
    raw({ image: 2, category: "lodging", date: "--10-03", label: "ホテルD", place: "ホテルD" }),
  ], unreadableImages: [] }, { trip: { startDate: "2026-10-02", endDate: "2026-10-05" }, imageCount: 2 });
  check("翌日着（1:30着）は15:00のまま", nextDay.items.find((i) => i.category === "lodging").time, "15:00");
  ok("翌日着は補足に「到着は10/3」", nextDay.items[0].note.includes("到着は10/3"));
}

/* ---- 壊れた・不正な出力 ---- */
{
  const r = normalizeScreenshotResult({
    items: [
      null, "x",
      raw({ category: "unknown", transport: "rocket", label: "変な種類", date: "--10-04" }),
      raw({ label: "", date: "--10-04" }), // 見出しが作れない（移動でも宿でもない）→捨てる
      raw({ category: "transport", transport: "train", label: "", fromPlace: "渋谷駅", toPlace: "", date: "--10-04" }), // 見出しを区間から作る
      raw({ image: 99, label: "画像番号が範囲外", date: "--10-04" }),
      raw({ label: "範囲外の日付", date: "--12-25" }),
      raw({ label: "費用の検証", date: "--10-04", costItems: [{ label: "", amount: -5, currency: "" }, { label: "外貨", amount: 12.345, currency: "usd" }, { label: "巨額", amount: 99999999, currency: "" }, { label: "文字", amount: "abc", currency: "" }, { label: "円", amount: 100.6, currency: "JPY" }] }),
      raw({ category: "transport", transport: "", label: "移動手段なしの移動", date: "--10-04" }),
      raw({ category: "food", transport: "bus", label: "食事なのにバス", date: "--10-04" }),
    ],
    unreadableImages: [{ image: 0, reason: "x" }, { image: 50, reason: "x" }],
  }, { trip: TRIP, imageCount: 3 });
  check("不正: 捨てた件数（null・文字列・見出しなし）", r.dropped, 3);
  const get = (l) => r.items.find((i) => i.label === l);
  check("不正: 未知のcategoryはother・未知のtransportは空", [get("変な種類").category, get("変な種類").transport], ["other", ""]);
  check("不正: 移動の見出しを区間から作る", get("渋谷駅→?").category, "transport");
  check("不正: 画像番号が範囲外ならnull", get("画像番号が範囲外").sourceImage, null);
  ok("不正: 日程外の日付には警告", get("範囲外の日付").warnings.some((w) => w.includes("日程の外")));
  check("不正: 費用は正しいものだけ（外貨は小数2桁・通貨は大文字、円は整数）", get("費用の検証").costItems, [{ label: "外貨", amount: 12.35, currency: "USD" }, { label: "円", amount: 101 }]);
  check("不正: transport付きのfoodは移動に直る", [get("食事なのにバス").category, get("食事なのにバス").transport], ["transport", "bus"]);
  check("不正: unreadableの範囲外は無視", r.unreadable, []);
  check("不正: itemsが無くても落ちない", normalizeScreenshotResult({}, { trip: TRIP, imageCount: 1 }).items, []);
  check("不正: nullでも落ちない", normalizeScreenshotResult(null, { trip: TRIP, imageCount: 1 }).dropped, 0);

  // 上限30件
  const many = { items: Array.from({ length: 40 }, (_, i) => raw({ label: "予定" + i, date: "--10-04" })), unreadableImages: [] };
  const capped = normalizeScreenshotResult(many, { trip: TRIP, imageCount: 1 });
  check("上限: 30件まで、超えた分は捨てた数に数える", [capped.items.length, capped.dropped], [30, 10]);
  // 宿泊の泊数展開は14泊まで
  const long = normalizeScreenshotResult({ items: [raw({ category: "lodging", label: "長期滞在", place: "宿", date: "--10-03", checkOutDate: "--12-01" })], unreadableImages: [] }, { trip: TRIP, imageCount: 1 });
  check("宿泊: 泊数展開は14泊まで", long.items.length, 14);
}

/* ---- 場所検索の絞り込み ---- */
{
  const { queries, skipped } = collectPlaceQueries(norm.items);
  // 優先順：宿・会場・店 → 出発地 → 到着地。同じ名前（宿の2泊）は1件
  check("場所検索: 優先順（宿・会場・店→出発地→到着地）", queries, [
    "ホテル日航那覇グランドキャッスル 那覇市おもろまち", "横浜スタジアム", "なんばグランド花月", "ローソン 那覇おもろまち店",
    "羽田空港", "東京駅", "町田駅", "那覇空港", "新大阪駅", "新宿駅",
  ]);
  check("場所検索: 溢れは0", skipped, 0);

  const items = Array.from({ length: 20 }, (_, i) => ({ category: "sightseeing", place: "場所" + i }));
  const c = collectPlaceQueries(items);
  check("場所検索: 上限12件", c.queries.length, 12);
  check("場所検索: 溢れた8件は数える", c.skipped, 8);
  const dup = collectPlaceQueries([{ category: "sightseeing", place: "東京タワー" }, { category: "food", place: " 東京タワー " }, { category: "food", place: "ＴＯＫＹＯ" }]);
  check("場所検索: 全角・空白ちがいは同じ名前", dup.queries.length, 2);
  const pri = collectPlaceQueries([
    { category: "transport", fromPlace: "出発駅", toPlace: "到着駅" },
    { category: "lodging", place: "宿A" },
  ], 2);
  check("場所検索: 上限のときは宿が出発地より先", pri.queries, ["宿A", "出発駅"]);
  check("場所検索: 上限で溢れた到着地", pri.skipped, 1);
  check("場所検索のリクエスト: 1回で座標まで（FieldMask）", [buildTextSearchRequest("羽田空港").fieldMask, buildTextSearchRequest("羽田空港").body.pageSize], ["places.displayName,places.formattedAddress,places.location", 1]);
  check("場所検索の応答: 先頭1件", parseTextSearchResponse({ places: [{ displayName: { text: "羽田空港" }, formattedAddress: "東京都大田区", location: { latitude: 35.5494, longitude: 139.7798 } }] }), { name: "羽田空港", address: "東京都大田区", lat: 35.5494, lng: 139.7798 });
  check("場所検索の応答: 0件はnull", parseTextSearchResponse({}), null);
  check("場所検索の応答: 座標が壊れていればnull", parseTextSearchResponse({ places: [{ location: { latitude: 999, longitude: 0 } }] }), null);
}

/* ---- 地図を付ける ---- */
{
  const results = {
    [placeKey("羽田空港")]: { name: "東京国際空港（羽田空港）", address: "東京都大田区", lat: 35.5494, lng: 139.7798 },
    [placeKey("那覇空港")]: { name: "那覇空港", address: "沖縄県那覇市", lat: 26.2065, lng: 127.6459 },
    [placeKey("横浜スタジアム")]: null,
  };
  const items = attachPlaces(JSON.parse(JSON.stringify(norm.items)), results);
  const jal = items.find((i) => i.label === "羽田→那覇 JAL903");
  check("地図: 出発地は記録の地図・到着地は到着地の地図", [jal.mapPlaceName, jal.arrivePlaceName], ["東京国際空港（羽田空港）", "那覇空港"]);
  check("地図: 座標つきURL", jal.mapUrl, "https://www.google.com/maps/search/?api=1&query=35.5494%2C139.7798");
  check("地図: 到着地の座標", [jal.arriveLat, jal.arriveLng], [26.2065, 127.6459]);
  const bs = items.find((i) => i.label === "横浜DeNAベイスターズ戦");
  check("地図: 見つからなかった場所は地図なしのまま", [bs.mapUrl, bs.place], [undefined, "横浜スタジアム"]);
}

/* ---- 保存前の再検証 ---- */
{
  const good = {
    date: "2026-10-03", time: "09:30", label: "羽田→那覇 JAL903", category: "transport", transport: "plane", note: "座席24A",
    mapUrl: "https://www.google.com/maps/search/?api=1&query=35.5494%2C139.7798", mapPlaceName: "羽田空港", mapLat: 35.5494, mapLng: 139.7798,
    from: "羽田空港", to: "那覇空港", company: "日本航空 JAL903", depart: "09:30", arrive: "12:05",
    arriveMapUrl: "https://www.google.com/maps/search/?api=1&query=26.2065%2C127.6459", arriveLat: 26.2065, arriveLng: 127.6459,
    costItems: [{ label: "運賃", amount: 18700 }, { label: "USD", amount: 10, currency: "USD", rate: 150 }, { label: "レート不正", amount: 1, currency: "EUR", rate: -3 }],
  };
  const r = validateSaveItems([
    good,
    { ...good, date: "2026-10-09" }, // 日程外
    { ...good, label: "  " },
    { ...good, date: "2026-13-01" },
    null,
    { date: "2026-10-04", label: "邪悪なURL", category: "food", mapUrl: "https://evil.example.com/maps", mapLat: 1, mapLng: 2, transport: "bus", from: "x" },
  ], TRIP);
  check("再検証: 通るのは正しい2件", r.items.map((i) => i.label), ["羽田→那覇 JAL903", "邪悪なURL"]);
  check("再検証: エラーの理由", r.errors, [{ index: 1, reason: "date_out_of_range" }, { index: 2, reason: "empty_label" }, { index: 3, reason: "invalid_date" }, { index: 4, reason: "invalid_item" }]);
  const a = r.items[0];
  check("再検証: 移動の到着地・時刻・会社", a.travel, { from: "羽田空港", to: "那覇空港", company: "日本航空 JAL903", depart: "09:30", arrive: "12:05", arriveMapUrl: good.arriveMapUrl, arriveLat: 26.2065, arriveLng: 127.6459 });
  check("再検証: 費用のレートは正しいものだけ通る", a.costItems, [{ label: "運賃", amount: 18700 }, { label: "USD", amount: 10, currency: "USD", rate: 150 }, { label: "レート不正", amount: 1, currency: "EUR" }]);
  check("再検証: 地図と座標", [a.mapUrl, a.mapLat, a.mapLng, a.mapPlaceName], [good.mapUrl, 35.5494, 139.7798, "羽田空港"]);
  const evil = r.items[1];
  check("再検証: Google以外の地図URLは捨て、座標も持たない", [evil.mapUrl, evil.mapLat, evil.transport, evil.travel], ["", undefined, "", undefined]);
  check("再検証: 日程が未設定の旅行なら日付は何でも通る", validateSaveItems([good], {}).items.length, 1);
  check("再検証: 配列でなければ空", validateSaveItems("x", TRIP), { items: [], errors: [] });
}

/* ---- 画像の入力チェック ---- */
{
  const b64 = "QUJD";
  ok("画像: 正常", validateImagesInput([{ type: "image/jpeg", data: b64 }]).ok);
  check("画像: 空配列", validateImagesInput([]).error, "invalid_input");
  check("画像: 配列でない", validateImagesInput("x").error, "invalid_input");
  check("画像: 11枚は多すぎ", validateImagesInput(Array.from({ length: 11 }, () => ({ data: b64 }))).error, "too_many_images");
  check("画像: 10枚はOK", validateImagesInput(Array.from({ length: 10 }, () => ({ data: b64 }))).ok, true);
  check("画像: base64でない文字", validateImagesInput([{ data: "abc def!" }]).error, "invalid_input");
  check("画像: 1枚が大きすぎ", validateImagesInput([{ data: "A".repeat(1500001) }]).error, "invalid_size");
  check("画像: 合計が大きすぎ", validateImagesInput(Array.from({ length: 7 }, () => ({ data: "A".repeat(1400000) }))).error, "invalid_size");
  check("画像: 中身が無い", validateImagesInput([{ data: "" }]).error, "invalid_input");
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
