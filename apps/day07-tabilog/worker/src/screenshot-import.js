/*
 * 「スクショから予定を作る」（docs/adr/0022）の純粋関数。
 *
 * 流れ：画像（最大10枚）→ Cloud Vision（DOCUMENT_TEXT_DETECTION）を1回のバッチで呼んで文字にする
 * → OpenAI（既存の整理役）に「予約・チケット・レシート向け」のプロンプトで予定の候補にしてもらう
 * → 場所の名前をGoogle Text Searchで探して地図（座標）を付ける → 利用者が確認画面で直して保存。
 *
 * このファイルは、fetch などWorkers専用のグローバルを一切使わない（nodeでそのまま単体テストできる。
 * worker/test/screenshot-import.test.mjs）。実際の通信・D1の保存は index.js が受け持つ。
 * 中身：Visionへのリクエストとレスポンスの解釈、AIへのプロンプト・出力スキーマ、AIの出力の検証と補正
 * （日付の年の補い・チェックイン時刻の既定・宿泊の泊数ぶんの展開）、場所検索の件数の絞り込み、
 * 保存する前の再検証、サブリクエスト数の見積もり。
 */

import { parseReceiptText } from "./receipt-parse.js";
import { validateBranchBlockPlacement } from "./branches.js";

/* ---------- 上限（Workers Freeのサブリクエスト50回以内に収めるための数字） ---------- */

export const SCREENSHOT_MAX_IMAGES = 10; // 1回の取り込みで送れる画像の枚数
export const SCREENSHOT_MAX_PLACE_LOOKUPS = 12; // 場所検索（Text Search）を呼ぶ回数の上限
export const SCREENSHOT_MAX_ITEMS = 30; // 確認画面に出す予定の上限（宿泊の泊数展開を含む）
// 音声・メモ（AI）の候補の上限。スクショより長い文章から作るので多めにする（docs/adr/0022 2026-09-30追記）
export const PROPOSAL_MAX_ITEMS = 60;
// 確認画面から保存できる件数の上限（決まった形のメモは最大100件。docs/adr/0002）
export const IMPORT_MAX_ITEMS = 100;
export const SCREENSHOT_MAX_NIGHTS = 14; // 宿泊1件を何泊ぶんの予定に展開するかの上限
export const VISION_MAX_IMAGES_PER_REQUEST = 16; // Cloud Visionが1リクエストで受け付ける画像の上限
export const WORKERS_FREE_SUBREQUEST_LIMIT = 50; // Workers Freeの1リクエストあたりのサブリクエスト上限
// 画像1枚（base64文字列）の上限。クライアントは長辺1600px・JPEG品質0.8に縮めて送るので
// 通常は300〜700KB程度。Visionのリクエスト全体の上限（10MB）に収めるため、合計にも上限を置く
export const SCREENSHOT_MAX_IMAGE_BASE64_CHARS = 1500000;
export const SCREENSHOT_MAX_TOTAL_BASE64_CHARS = 9000000;
// 1枚のOCR結果からAIに渡す文字数の上限（長すぎるとAIのトークン代が膨らむ）
export const SCREENSHOT_MAX_OCR_CHARS = 4000;
// D1へのアクセス（ログイン確認・回数の確認と消費・旅行の取得・更新）は、余裕を見て10回と見積もる
export const SCREENSHOT_D1_QUERY_ESTIMATE = 10;

// 宿泊のチェックイン時刻が写っていないときの既定（15:00）。その日に到着する移動が15:00より遅い
// 場合は、到着時刻のあと「到着してから宿に着くまで」の目安として60分後にする
export const DEFAULT_CHECK_IN_TIME = "15:00";
export const CHECK_IN_BUFFER_MINUTES = 60;

export const SCREENSHOT_CATEGORIES = ["transport", "lodging", "food", "sightseeing", "other"];
// 音声・メモ・自分のAIの答えと、保存のときは「到着」（arrival：着いた場所の予定。地図はその場所）も使う。
// スクショは移動を出発・到着つきの1件で表すので、AIへの指定（SCREENSHOT_CATEGORIES）には入れない（2026-09-30）
export const PROPOSAL_CATEGORIES = SCREENSHOT_CATEGORIES.concat(["arrival"]);
export const SCREENSHOT_TRANSPORTS = ["", "plane", "shinkansen", "train", "bus", "car", "taxi", "walk", "bicycle"];

// 読み取れなかった画像の理由（画面にそのまま出す）
export const UNREADABLE_REASONS = {
  no_text: "文字が見つかりませんでした",
  read_error: "読み取りに失敗しました",
  no_event: "予定や費用として使える情報が見つかりませんでした",
};

/* ---------- サブリクエストの見積もり ---------- */

// 1回の取り込みで使うサブリクエスト数の見積もり。
// vision：画像を1リクエストにまとめる（10枚以内なら1回）／openai：整理は1回／places：場所検索の件数
// d1：D1へのアクセスの見積もり。合計がlimit（50）以下なら ok
// opts.branch：別行動の中から取り込むときは、分岐の取得とログイン確認（セッション）でD1が約4回増える
export function estimateSubrequests(imageCount, placeLookups, opts) {
  const vision = imageCount > 0 ? Math.ceil(imageCount / VISION_MAX_IMAGES_PER_REQUEST) : 0;
  const openai = 1;
  const places = Math.max(0, Math.min(placeLookups, SCREENSHOT_MAX_PLACE_LOOKUPS));
  const d1 = SCREENSHOT_D1_QUERY_ESTIMATE + (opts && opts.branch ? 4 : 0);
  const total = vision + openai + places + d1;
  return { vision, openai, places, d1, total, limit: WORKERS_FREE_SUBREQUEST_LIMIT, ok: total <= WORKERS_FREE_SUBREQUEST_LIMIT };
}

/* ---------- Cloud Vision（バッチ） ---------- */

// base64の画像の配列から、1回のimages:annotateに送るボディを作る。languageHintsは日本語。
export function buildVisionBatchBody(base64List) {
  return {
    requests: base64List.map((content) => ({
      image: { content },
      features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
      imageContext: { languageHints: ["ja"] },
    })),
  };
}

// Visionのレスポンス（{responses:[...]}）を、送った画像と同じ並びの
// [{ index, text, reason }]（読めなければtext=""でreasonに理由）にする。
export function parseVisionBatchResponse(data, count) {
  const responses = data && Array.isArray(data.responses) ? data.responses : [];
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = responses[i];
    if (!r || r.error) { out.push({ index: i, text: "", reason: "read_error" }); continue; }
    const text = r.fullTextAnnotation && typeof r.fullTextAnnotation.text === "string" ? r.fullTextAnnotation.text.trim() : "";
    out.push(text ? { index: i, text, reason: "" } : { index: i, text: "", reason: "no_text" });
  }
  return out;
}

/* ---------- AIへのプロンプト・出力スキーマ ---------- */

// レシートらしい画像には、既存のルールベース解析（receipt-parse.js）で取れた品目を「参考」として添える。
// 誤りを含むことがあるので、AIには「画像の文字を優先する」と伝える
const RECEIPT_MARK_RE = /(合計|小計|領収|レシート|お会計|お買上|税込)/;
export function receiptHintFor(text) {
  const t = String(text || "").normalize("NFKC");
  if (!RECEIPT_MARK_RE.test(t)) return "";
  const items = parseReceiptText(t).items;
  if (!items.length) return "";
  return items.slice(0, 20).map((it) => it.label + " " + it.amount + "円").join(" / ");
}

// ocr：[{index（0始まり）, text}]。読み取れた画像だけを渡す。AIには1始まりの「画像N」として見せる
export function buildOcrSection(ocr) {
  return ocr.map((o) => {
    const text = String(o.text || "").slice(0, SCREENSHOT_MAX_OCR_CHARS);
    const hint = receiptHintFor(text);
    return "【画像" + (o.index + 1) + "】\n" + text + (hint ? "\n（参考：ルール解析で読めた品目 " + hint + "。誤りがあるかもしれないので、画像の文字を優先すること）" : "");
  }).join("\n\n");
}

export function buildScreenshotPrompt(ocr, trip) {
  const start = (trip && trip.startDate) || "";
  const end = (trip && trip.endDate) || "";
  const period = start ? (end && end !== start ? start + " 〜 " + end : start) : "（日程は未設定）";
  return [
    "あなたは旅行記録アプリのアシスタントです。旅行者が選んだスクリーンショット（航空券・新幹線のきっぷ・ホテルの予約画面・",
    "Googleマップの乗換案内・野球やお笑いのチケット・レシートなど）から文字読み取り（OCR）した結果を読んで、",
    "旅行の予定（1件＝1つの出来事）の配列にしてください。OCRの結果は誤字・欠け・語順の乱れを含みます。",
    "",
    "この旅行の日程：" + period,
    "",
    "OCRの結果：",
    buildOcrSection(ocr),
    "",
    "ルール：",
    "- 1つの出来事につき1件。往復の航空券は往路と復路の2件、乗り換えのある経路は区間（電車・新幹線・バス・飛行機）ごとに1件にすること。徒歩の区間は作らないこと",
    "- imageには、その情報が載っていた画像の番号（【画像N】のN）を入れること",
    "- categoryは transport（移動）/ lodging（宿泊）/ food（食事・レシート）/ sightseeing（観光・イベント・チケット）/ other のいずれか。transportには移動手段transport（plane, shinkansen, train, bus, car, taxi, walk, bicycle のいずれか。移動以外は空文字）を入れること",
    "- dateは、その予定の日付。年が書かれていればYYYY-MM-DD、年が書かれていなければ--MM-DD（例：--10-03）。日付がどこにも読み取れなければ空文字にすること。日付を推測で作らないこと。書かれた日付は、上の旅行の日程の外でも、そのまま書き写すこと（日程に合わせて変えたりずらしたりしないこと）",
    "- timeは、開始・出発・チェックインなど予定が始まる時刻を24時間表記のHH:MMで入れること。書かれていなければ空文字。時刻を推測で作らないこと（チェックインの既定時刻はアプリ側で補うので、書かれていなければ空文字でよい）",
    "- labelは短い見出し。体言止めにすること。移動は「羽田→那覇 JAL903」「東京→新大阪 のぞみ25号」のように区間と便名・列車名、宿泊は施設名だけ、チケットは「横浜DeNAベイスターズ戦」「漫才劇場公演」のようにイベント名、レシートは店名にすること",
    "- 移動（transport）のとき：fromPlaceに出発地、toPlaceに到着地（駅名・空港名。「羽田空港」「東京駅」のように地図で探せる名前に。空港・駅の場合は「空港」「駅」まで付けること）、departTimeに出発時刻、arriveTimeに到着時刻、arriveDateに到着日（出発日と違うときだけ。同じなら出発日と同じ書き方で）、routeNumberに便名・列車名・号数（例：JAL903、のぞみ25号）、companyに航空会社・鉄道会社名を入れること。書かれていない項目は空文字",
    "- 宿泊（lodging）のとき：placeに宿の名前（地図で探せる名前。市区町村や最寄りが書かれていれば末尾に添える）、timeにチェックイン時刻（書かれていれば）、dateにチェックイン日、checkOutDateにチェックアウト日（書かれていれば。dateと同じ書き方）を入れること",
    "- チケット・食事・観光のとき：placeに会場・店の名前（画像に書かれている名前を地図で探せる形で）を入れること。会場名が画像に書かれておらず、主催・チーム・劇場名などから会場が確実に分かるときだけ、会場名を入れてplaceGuessedをtrueにすること。確実でなければplaceは空文字",
    "- 移動のplaceは空文字にすること（fromPlace・toPlaceを使う）。placeGuessedは推測していなければfalse",
    "- costItemsは、画像に書かれた金額だけを入れること。チケット・運賃・宿泊料金は「運賃」「チケット代」「宿泊料金」などの品目名で1件、レシートは品目ごと（読み分けられなければ「合計」で1件）。amountは数字、currencyは日本円なら空文字、外貨ならISO 4217の3文字（USD、EURなど）。金額が無ければ空配列。割引・マイナスの行や、ポイント・お預り・お釣りは入れないこと",
    "- noteには、座席・ゲート・注意事項など、旅行の記録として役立つ短い補足を1〜2文で入れること。予約番号・確認番号・搭乗者や宿泊者の氏名・電話番号・メールアドレス・カード番号は、画像に書かれていても絶対に書かないこと",
    "- 予定として使える情報が読み取れなかった画像は、unreadableImagesにその画像の番号とreason（no_event）を入れること。画像に書かれていないことは絶対に作らないこと",
  ].join("\n");
}

export function screenshotSchema() {
  const str = { type: "string" };
  return {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            image: { type: "integer" },
            category: { type: "string", enum: SCREENSHOT_CATEGORIES },
            transport: { type: "string", enum: SCREENSHOT_TRANSPORTS },
            date: str,
            time: str,
            label: str,
            routeNumber: str,
            company: str,
            fromPlace: str,
            toPlace: str,
            departTime: str,
            arriveTime: str,
            arriveDate: str,
            place: str,
            placeGuessed: { type: "boolean" },
            checkOutDate: str,
            costItems: {
              type: "array",
              items: {
                type: "object",
                properties: { label: str, amount: { type: "number" }, currency: str },
                required: ["label", "amount", "currency"],
                additionalProperties: false,
              },
            },
            note: str,
          },
          required: [
            "image", "category", "transport", "date", "time", "label", "routeNumber", "company",
            "fromPlace", "toPlace", "departTime", "arriveTime", "arriveDate", "place", "placeGuessed",
            "checkOutDate", "costItems", "note",
          ],
          additionalProperties: false,
        },
      },
      unreadableImages: {
        type: "array",
        items: {
          type: "object",
          properties: { image: { type: "integer" }, reason: str },
          required: ["image", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["items", "unreadableImages"],
    additionalProperties: false,
  };
}

/* ---------- 日付・時刻の補正 ---------- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function pad2(n) { return String(n).padStart(2, "0"); }

function isRealDate(y, m, d) {
  if (!(y >= 1900 && y <= 2200) || !(m >= 1 && m <= 12) || !(d >= 1)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function ymd(y, m, d) { return y + "-" + pad2(m) + "-" + pad2(d); }

function dayNumber(date) {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

export function addDays(date, n) {
  const [y, m, dd] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, dd + n));
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

// 「9:05」「09時05分」「午後3:00」「15:00発」などをHH:MMにする。読めなければ空文字
export function normalizeTime(raw) {
  const s = String(raw || "").normalize("NFKC").trim();
  if (!s) return "";
  const m = /(午前|午後|AM|PM|am|pm)?\s*(\d{1,2})\s*(?::|時)\s*(\d{1,2})?\s*(分)?\s*(AM|PM|am|pm)?/.exec(s);
  if (!m) return "";
  let h = Number(m[2]);
  const min = m[3] === undefined ? 0 : Number(m[3]);
  const mer = (m[1] || m[5] || "").toLowerCase();
  if ((mer === "午後" || mer === "pm") && h < 12) h += 12;
  if ((mer === "午前" || mer === "am") && h === 12) h = 0;
  const out = pad2(h) + ":" + pad2(min);
  return TIME_RE.test(out) ? out : "";
}

function timeToMinutes(t) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function minutesToTime(min) { const c = Math.max(0, Math.min(23 * 60 + 59, min)); return pad2(Math.floor(c / 60)) + ":" + pad2(c % 60); }

// 年が書かれていない月日に、旅行の日程から年を補う。旅行の開始日・終了日の年を候補にして、
// 日程の中に入る年を選ぶ。どれも入らなければ日程にいちばん近い年（範囲外は後で警告する）。
// 日程が無ければ今日の年
function inferYear(m, d, trip, today) {
  const start = trip && DATE_RE.test(trip.startDate || "") ? trip.startDate : "";
  const end = trip && DATE_RE.test(trip.endDate || "") ? trip.endDate : start;
  const years = start
    ? [...new Set([Number(start.slice(0, 4)), Number(end.slice(0, 4))])]
    : [Number((DATE_RE.test(today || "") ? today : new Date().toISOString().slice(0, 10)).slice(0, 4))];
  let best = null;
  for (const y of years) {
    if (!isRealDate(y, m, d)) continue;
    if (!start) return y;
    const n = dayNumber(ymd(y, m, d));
    const s = dayNumber(start), e = dayNumber(end);
    const dist = n < s ? s - n : n > e ? n - e : 0;
    if (dist === 0) return y;
    if (!best || dist < best.dist) best = { y, dist };
  }
  if (best) return best.y;
  // うるう日（2/29）などで候補の年に無いとき：近くのうるう年を探す
  if (start) for (let y = years[0]; y <= years[0] + 4; y++) if (isRealDate(y, m, d)) return y;
  return null;
}

// AIが返した日付の文字（YYYY-MM-DD／--MM-DD／M/D／M月D日など）をYYYY-MM-DDにする。
// { date, yearInferred } か、読めなければnull
export function resolveDate(raw, trip, today) {
  let s = String(raw || "").normalize("NFKC").trim();
  if (!s) return null;
  s = s.replace(/[（(][^)）]*[)）]/g, "").replace(/[月火水木金土日]曜日?/g, "").trim();
  let m = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(s);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    return isRealDate(y, mo, d) ? { date: ymd(y, mo, d), yearInferred: false } : null;
  }
  m = /(?:^|[^\d])(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/.exec(s.replace(/^--/, " "));
  if (!m) return null;
  const mo = Number(m[1]), d = Number(m[2]);
  const y = inferYear(mo, d, trip, today);
  return y && isRealDate(y, mo, d) ? { date: ymd(y, mo, d), yearInferred: true } : null;
}

function tripDatesOf(trip) {
  const start = trip && DATE_RE.test(trip.startDate || "") ? trip.startDate : "";
  if (!start) return { start: "", end: "" };
  const end = DATE_RE.test(trip.endDate || "") && trip.endDate >= start ? trip.endDate : start;
  return { start, end };
}

// 旅行の日程の中に入っているか（日程が未設定なら常にtrue）
export function dateInTrip(date, trip) {
  const { start, end } = tripDatesOf(trip);
  return !start || (date >= start && date <= end);
}

/* ---------- AIの出力の検証と補正 ---------- */

function cleanStr(x, max) {
  return typeof x === "string" ? x.normalize("NFKC").trim().slice(0, max) : "";
}

function cleanCostItems(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    const amount = Number(c.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1000000) continue;
    const cur = cleanStr(c.currency, 3).toUpperCase();
    const foreign = /^[A-Z]{3}$/.test(cur) && cur !== "JPY";
    const item = { label: cleanStr(c.label, 60) || "費用", amount: foreign ? Math.round(amount * 100) / 100 : Math.round(amount) };
    if (foreign) {
      item.currency = cur;
      // 円換算のレート（1単位あたりの円）。確認画面のあと、クライアントが/ratesから取って付けてくる
      const rate = Number(c.rate);
      if (Number.isFinite(rate) && rate > 0 && rate < 1000000) item.rate = rate;
    }
    out.push(item);
    if (out.length >= 30) break;
  }
  return out;
}

// 検索用の名前（場所検索に使う）。長すぎるものは切る
function cleanPlace(x) { return cleanStr(x, 100); }

// AIの出力（parsed）を検証し、確認画面に出す予定の候補にする。
// 戻り値 { items, unreadable, dropped }：
// - items：候補（下のsourceImageは0始まり。地図の情報はまだ無い＝あとでattachPlacesで足す）
// - unreadable：読み取れなかった画像 [{image（0始まり）, reason}]（AIが「使える情報なし」とした画像）
// - dropped：捨てた候補の数（見出しが作れない・壊れたもの）
// ctx：{ trip:{startDate,endDate}, imageCount, today }
export function normalizeScreenshotResult(parsed, ctx) {
  return normalizeProposalItems(parsed && Array.isArray(parsed.items) ? parsed.items : [], ctx, parsed);
}

// スクショ・音声・メモ（AI）が共有する、候補の検証と補正（docs/adr/0022 2026-09-30追記）。
// ctx（すべて任意。無ければスクショの動き）：
// - trip:{startDate,endDate}／today／imageCount（0なら画像なし＝sourceImageはnull）
// - fixedDate：この日に固定する（音声・メモの「この日」モード。AIの日付は見ない）
// - allowedDates：候補の日付がこの中に無ければ、defaultDate（無ければ先頭）に置いて警告する
//   （音声・メモの複数日モード・別行動の日々）
// - defaultDate：日付が読めなかったときの置き場所（無ければ旅行の初日）
// - noteMax：note（記録のひとこと）の最大文字数（スクショ300／音声・メモ1000）
// - maxItems：候補の上限
// - allowGuess：会場の推測（placeGuessed）を許すか。音声・メモはfalse＝話していない場所は作らない
// - checkInDefaults：宿の時刻が無いときに15:00などの目安を入れるか。音声・メモはfalse＝分からない時刻は空のまま
// - branch：自分だけの道（別行動）に入れるとき、その分岐（date・endDate・startTime・endTime）。時間帯の外は警告する
export function normalizeProposalItems(rawItems, ctx, parsed) {
  const trip = ctx.trip || {};
  const items = [];
  let dropped = 0;
  const { start } = tripDatesOf(trip);
  const imageCount = ctx.imageCount || 0;
  const allowed = Array.isArray(ctx.allowedDates) && ctx.allowedDates.length ? ctx.allowedDates : null;
  const fallbackDate = ctx.fixedDate || ctx.defaultDate || (allowed ? allowed[0] : "") || start || "";
  const noteMax = ctx.noteMax || 300;
  const allowGuess = ctx.allowGuess !== false;

  for (const r of rawItems) {
    if (!r || typeof r !== "object") { dropped++; continue; }
    const warnings = [];
    let category = PROPOSAL_CATEGORIES.includes(r.category) ? r.category : "other";
    let transport = SCREENSHOT_TRANSPORTS.includes(r.transport) ? r.transport : "";
    // 到着（arrival）は移動手段を持ってよい（どの手段で着いたか）。それ以外で手段があれば移動にする
    if (transport && category !== "transport" && category !== "arrival") category = "transport";
    if (category !== "transport" && category !== "arrival") transport = "";
    const image = Number.isInteger(r.image) && r.image >= 1 && r.image <= imageCount ? r.image - 1 : null;

    const fromPlace = category === "transport" ? cleanPlace(r.fromPlace) : "";
    const toPlace = category === "transport" ? cleanPlace(r.toPlace) : "";
    const company = category === "transport" ? cleanStr(r.company, 40) : "";
    const routeNumber = category === "transport" ? cleanStr(r.routeNumber, 30) : "";
    let place = category === "transport" ? "" : cleanPlace(r.place);

    let label = cleanStr(r.label, 120);
    if (!label) {
      if (category === "transport" && (fromPlace || toPlace)) label = (fromPlace || "?") + "→" + (toPlace || "?") + (routeNumber ? " " + routeNumber : "");
      else if (category === "lodging" && place) label = place;
      else { dropped++; continue; }
    }
    if (category === "lodging" && !place) place = label; // 宿は見出しが宿の名前のはず

    const departTime = category === "transport" ? normalizeTime(r.departTime) : "";
    const arriveTime = category === "transport" ? normalizeTime(r.arriveTime) : "";
    let time = normalizeTime(r.time) || departTime;

    // 日付：読めなければ空のままにせず「旅行の初日」（別行動なら別行動の初日）に置き、警告して確認してもらう
    let date = "";
    if (ctx.fixedDate) {
      date = ctx.fixedDate;
    } else {
      const resolved = resolveDate(r.date, trip, ctx.today);
      date = resolved ? resolved.date : "";
      if (date && allowed && !allowed.includes(date)) date = ""; // 対象の日々に無い日付は信用しない
      if (!date) {
        date = fallbackDate;
        warnings.push("日付が読み取れませんでした。日付を確認してください");
      } else if (resolved.yearInferred) {
        warnings.push("年が書かれていないため、旅行の日程から" + date.slice(0, 4) + "年としました");
      }
    }
    if (date && !dateInTrip(date, trip)) warnings.push("旅行の日程の外の日付です。日付を直さないと追加できません");

    let arriveDate = "";
    if (category === "transport") {
      const ra = ctx.fixedDate ? null : resolveDate(r.arriveDate, trip, ctx.today);
      arriveDate = ra && ra.date >= date && (!allowed || allowed.includes(ra.date)) ? ra.date : date;
    }

    const costItems = cleanCostItems(r.costItems);
    let note = cleanStr(r.note, noteMax);
    if (category === "transport" && arriveDate && arriveDate > date) {
      note = (note ? note + " " : "") + "到着は" + Number(arriveDate.slice(5, 7)) + "/" + Number(arriveDate.slice(8, 10)) + "。";
    }
    const placeGuessed = allowGuess && r.placeGuessed === true && !!place;
    if (placeGuessed) warnings.push("会場を推測しました。場所を確認してください");

    const item = {
      sourceImage: image, category, transport, date, time, label,
      place, placeGuessed, fromPlace, toPlace, company, routeNumber,
      departTime, arriveTime, arriveDate,
      costItems, note, warnings, timeEstimated: false, nightIndex: 0,
    };
    // 話した／書いたURL（音声・メモ）：Googleの地図のURLなら地図に、そのほかのURLはお店のURLにする
    const mapUrl = cleanStr(r.mapUrl, 500);
    if (mapUrl && validMapUrl(mapUrl)) item.mapUrl = mapUrl;
    const shopUrl = cleanStr(r.shopUrl, 500);
    if (shopUrl && SHOP_URL_RE.test(shopUrl)) item.shopUrl = shopUrl;

    // 宿泊：チェックアウト日までの泊数ぶんの予定に展開する（旅行詳細の「宿泊先」は泊ごとの予定で数える）
    if (category === "lodging") {
      const co = resolveDate(r.checkOutDate, trip, ctx.today);
      let nights = 1;
      if (co && co.date > date) nights = Math.min(SCREENSHOT_MAX_NIGHTS, dayNumber(co.date) - dayNumber(date));
      for (let k = 0; k < nights; k++) {
        const nightDate = k === 0 ? date : addDays(date, k);
        const w = warnings.slice();
        if (nightDate !== date && !dateInTrip(nightDate, trip)) w.push("旅行の日程の外の日付です。日付を直さないと追加できません");
        items.push({
          ...item, date: nightDate, time: k === 0 ? time : "", nightIndex: k,
          costItems: k === 0 ? costItems : [], note: k === 0 ? note : "", warnings: w,
        });
      }
    } else {
      items.push(item);
    }
  }

  if (ctx.checkInDefaults !== false) applyCheckInDefaults(items);
  if (ctx.branch) applyBranchPlacement(items, ctx.branch);

  const unreadable = [];
  const rawUn = parsed && Array.isArray(parsed.unreadableImages) ? parsed.unreadableImages : [];
  for (const u of rawUn) {
    if (u && Number.isInteger(u.image) && u.image >= 1 && u.image <= imageCount) {
      unreadable.push({ image: u.image - 1, reason: "no_event" });
    }
  }

  // 上限。宿泊の泊数展開で超えたぶんは黙って捨てず、捨てた数に数える
  const maxItems = ctx.maxItems || SCREENSHOT_MAX_ITEMS;
  let kept = items;
  if (items.length > maxItems) { dropped += items.length - maxItems; kept = items.slice(0, maxItems); }
  kept.forEach((it, i) => { it.id = "p" + (i + 1); });
  return { items: kept, unreadable, dropped };
}

// 別行動（自分だけの道）に入れる候補の日付・時刻が、その別行動の時間帯に収まっているか確かめ、
// 外れていれば警告を足す（直すまで追加できない。サーバーの保存時も同じ規則 validateBranchBlockPlacement）。
// 警告は「別行動の」で始める（画面は、本人が直したあとこの種類の警告を消して数え直す）
export function applyBranchPlacement(items, branch) {
  for (const it of items) {
    const reason = validateBranchBlockPlacement(branch, it.date, it.time);
    if (reason === "date_out_of_branch") it.warnings.push("別行動の日程の外の日付です。日付を直さないと追加できません");
    else if (reason === "time_out_of_branch") it.warnings.push("別行動の時間帯の外の時刻です。時刻を直さないと追加できません");
  }
  return items;
}

// 宿泊の1泊目にチェックイン時刻が無いとき、15:00にする。ただし、同じ日に到着する移動
// （到着日がその日で、到着時刻が分かるもの）があり、その到着が15:00より遅いなら、いちばん遅い
// 到着時刻の60分後にする（例：18:30着の便なら19:30）。日付をまたぐ時刻（24:00以降）にはしない。
// 目安の時刻なので timeEstimated=true にして、画面で「（目安）」と分かるようにする
export function applyCheckInDefaults(items) {
  for (const it of items) {
    if (it.category !== "lodging" || it.nightIndex !== 0 || it.time) continue;
    let time = DEFAULT_CHECK_IN_TIME;
    let latest = -1;
    for (const o of items) {
      if (o.category !== "transport" || !o.arriveTime) continue;
      if ((o.arriveDate || o.date) !== it.date) continue;
      latest = Math.max(latest, timeToMinutes(o.arriveTime));
    }
    if (latest >= 0) {
      const candidate = minutesToTime(latest + CHECK_IN_BUFFER_MINUTES);
      if (timeToMinutes(candidate) > timeToMinutes(DEFAULT_CHECK_IN_TIME)) time = candidate;
    }
    it.time = time;
    it.timeEstimated = true;
  }
}

/* ---------- 場所検索（Google Text Search） ---------- */

function placeKey(q) { return String(q || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(); }
export { placeKey };

// 場所を探す名前を、優先順に並べてmax件まで選ぶ（同じ名前は1件にまとめる）。
// 優先順：①宿・会場・店（移動以外）②移動の出発地③移動の到着地。溢れたぶんはskippedに数える
// （地図なしで確認画面に出て、利用者があとから場所を探せる）
export function collectPlaceQueries(items, max) {
  const cap = max === undefined ? SCREENSHOT_MAX_PLACE_LOOKUPS : max;
  const ranked = [];
  for (const it of items) {
    if (it.mapUrl) continue; // 話した／書いたURLの地図があるものは探さない
    if (it.category === "transport") {
      if (it.fromPlace) ranked.push({ rank: 1, q: it.fromPlace });
      if (it.toPlace) ranked.push({ rank: 2, q: it.toPlace });
    } else if (it.place) {
      ranked.push({ rank: 0, q: it.place });
    }
  }
  ranked.sort((a, b) => a.rank - b.rank);
  const seen = new Set();
  const queries = [];
  let skipped = 0;
  for (const r of ranked) {
    const k = placeKey(r.q);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    if (queries.length < cap) queries.push(r.q); else skipped++;
  }
  return { queries, skipped };
}

export function buildTextSearchRequest(q) {
  return {
    url: "https://places.googleapis.com/v1/places:searchText",
    // 位置情報（location）を含めて1回で座標まで取る。フィールドは名前・住所・座標だけにする
    // （評価・営業時間などを足すとより高い単価になるため）
    fieldMask: "places.displayName,places.formattedAddress,places.location",
    body: { textQuery: q, languageCode: "ja", pageSize: 1 },
  };
}

export function parseTextSearchResponse(data) {
  const p = data && Array.isArray(data.places) ? data.places[0] : null;
  if (!p || !p.location) return null;
  const lat = Number(p.location.latitude), lng = Number(p.location.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return {
    name: (p.displayName && typeof p.displayName.text === "string" ? p.displayName.text : "").slice(0, 200),
    address: typeof p.formattedAddress === "string" ? p.formattedAddress.slice(0, 200) : "",
    lat, lng,
  };
}

// クライアント側のCore.placeMapUrlと同じ形（座標の検索URL）
export function coordMapUrl(lat, lng) {
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(Math.round(lat * 1e6) / 1e6 + "," + Math.round(lng * 1e6) / 1e6);
}

// 場所検索の結果（placeKey→{name,address,lat,lng}|null のオブジェクト）を候補に付ける
export function attachPlaces(items, results) {
  const find = (q) => (q ? results[placeKey(q)] || null : null);
  for (const it of items) {
    const main = it.mapUrl ? null : (it.category === "transport" ? find(it.fromPlace) : find(it.place));
    if (main) {
      it.mapUrl = coordMapUrl(main.lat, main.lng);
      it.mapPlaceName = main.name;
      it.mapAddress = main.address;
      it.mapLat = main.lat; it.mapLng = main.lng;
    }
    if (it.category === "transport") {
      const arr = find(it.toPlace);
      if (arr) {
        it.arriveMapUrl = coordMapUrl(arr.lat, arr.lng);
        it.arrivePlaceName = arr.name;
        it.arriveLat = arr.lat; it.arriveLng = arr.lng;
      }
    }
  }
  return items;
}

/* ---------- 保存前の再検証（クライアントから届いた確認済みの候補） ---------- */

const MAP_URL_RE = /^https:\/\/(www\.google\.com\/maps|maps\.google\.com|maps\.app\.goo\.gl|goo\.gl\/maps)[^\s]{0,450}$/;

const SHOP_URL_RE = /^https?:\/\/[^\s]{1,490}$/;

function validMapUrl(x) { return typeof x === "string" && x.length <= 500 && MAP_URL_RE.test(x); }
function latLngOf(lat, lng) {
  const a = Number(lat), b = Number(lng);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 ? { lat: a, lng: b } : null;
}

// 確認画面で直したあとの候補の配列を検証する。サーバーは画面の値をそのまま信用しない。
// 日程の外の日付・見出しが空・壊れた項目はerrorsに積んで保存しない（他の正しい項目は保存する）。
// 戻り値 { items（保存する形）, errors:[{index, reason}] }
// opts.branch：別行動（自分だけの道）に保存するとき、その分岐。日付・時刻が分岐の時間帯に収まらない項目は
// date_out_of_branch／time_out_of_branch としてerrorsに積む（validateBranchBlockPlacementと同じ規則）
export function validateSaveItems(rawItems, trip, opts) {
  const branch = opts && opts.branch ? opts.branch : null;
  const items = [];
  const errors = [];
  const list = Array.isArray(rawItems) ? rawItems : [];
  list.forEach((r, index) => {
    if (!r || typeof r !== "object") { errors.push({ index, reason: "invalid_item" }); return; }
    const label = cleanStr(r.label, 200);
    if (!label) { errors.push({ index, reason: "empty_label" }); return; }
    const date = typeof r.date === "string" && DATE_RE.test(r.date) && isRealDate(...r.date.split("-").map(Number)) ? r.date : "";
    if (!date) { errors.push({ index, reason: "invalid_date" }); return; }
    if (!dateInTrip(date, trip)) { errors.push({ index, reason: "date_out_of_range" }); return; }
    const category = PROPOSAL_CATEGORIES.includes(r.category) ? r.category : "other";
    const transport = (category === "transport" || category === "arrival") && SCREENSHOT_TRANSPORTS.includes(r.transport) ? r.transport : "";
    const time = typeof r.time === "string" && TIME_RE.test(r.time) ? r.time : "";
    if (branch) {
      const placed = validateBranchBlockPlacement(branch, date, time);
      if (placed) { errors.push({ index, reason: placed }); return; }
    }

    const out = {
      date, time, label, category, transport,
      episode: cleanStr(r.note, 4000),
      shopUrl: typeof r.shopUrl === "string" && SHOP_URL_RE.test(r.shopUrl.trim()) ? r.shopUrl.trim() : "",
      mapUrl: "", mapPlaceName: "",
      costItems: cleanCostItems(r.costItems),
    };
    if (validMapUrl(r.mapUrl)) {
      out.mapUrl = r.mapUrl;
      out.mapPlaceName = cleanStr(r.mapPlaceName, 200);
      const pt = latLngOf(r.mapLat, r.mapLng);
      if (pt) { out.mapLat = pt.lat; out.mapLng = pt.lng; }
    }
    if (category === "transport") {
      const travel = {};
      const from = cleanStr(r.from, 60), to = cleanStr(r.to, 60), company = cleanStr(r.company, 60);
      if (from) travel.from = from;
      if (to) travel.to = to;
      if (company) travel.company = company;
      const dep = typeof r.depart === "string" && TIME_RE.test(r.depart) ? r.depart : "";
      const arr = typeof r.arrive === "string" && TIME_RE.test(r.arrive) ? r.arrive : "";
      if (dep) travel.depart = dep;
      if (arr) travel.arrive = arr;
      if (validMapUrl(r.arriveMapUrl)) {
        travel.arriveMapUrl = r.arriveMapUrl;
        const pt = latLngOf(r.arriveLat, r.arriveLng);
        if (pt) { travel.arriveLat = pt.lat; travel.arriveLng = pt.lng; }
      }
      out.travel = travel;
    }
    items.push(out);
  });
  return { items, errors };
}

// 画像の配列（クライアントから届いたJSON）の形と大きさを確かめる。
// 戻り値 { ok:true, images:[{type, data}] } か { ok:false, error }
export function validateImagesInput(images) {
  if (!Array.isArray(images) || images.length === 0) return { ok: false, error: "invalid_input" };
  if (images.length > SCREENSHOT_MAX_IMAGES) return { ok: false, error: "too_many_images" };
  let total = 0;
  const out = [];
  for (const im of images) {
    if (!im || typeof im.data !== "string" || !im.data) return { ok: false, error: "invalid_input" };
    if (!/^[A-Za-z0-9+/=]+$/.test(im.data)) return { ok: false, error: "invalid_input" };
    if (im.data.length > SCREENSHOT_MAX_IMAGE_BASE64_CHARS) return { ok: false, error: "invalid_size" };
    total += im.data.length;
    out.push({ type: typeof im.type === "string" ? im.type : "image/jpeg", data: im.data });
  }
  if (total > SCREENSHOT_MAX_TOTAL_BASE64_CHARS) return { ok: false, error: "invalid_size" };
  return { ok: true, images: out };
}
