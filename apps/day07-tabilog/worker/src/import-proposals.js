/*
 * 音声入力・メモ（AIで整理）を「スクショから予定を作る」と同じ形の候補にする、純粋関数
 * （docs/adr/0022 2026-09-30追記、docs/adr/0002、docs/adr/0021）。
 *
 * 流れ：文字起こし（音声）または貼り付けたメモ → OpenAIに「話した／書いたことだけ」を候補にしてもらう
 * → screenshot-import.js の共有の検証・補正（normalizeProposalItems）→ 場所の名前を Google Text Search で
 * 探して地図を付ける（collectPlaceQueries / attachPlaces。スクショと同じ・上限12件）→ 確認画面へ返す。
 * ここでは何も保存しない。保存は確認のあとの POST /trips/:id/import-blocks（旧 /screenshot-blocks と同じ）。
 *
 * fetch などWorkers専用のグローバルを使わない（nodeでそのまま単体テストできる。
 * worker/test/import-proposals.test.mjs）。実際の通信・D1は index.js が受け持つ。
 */

import {
  SCREENSHOT_CATEGORIES, SCREENSHOT_TRANSPORTS, SCREENSHOT_MAX_PLACE_LOOKUPS, WORKERS_FREE_SUBREQUEST_LIMIT,
  PROPOSAL_MAX_ITEMS, normalizeProposalItems, addDays,
} from "./screenshot-import.js";
import { branchEndDateOf } from "./branches.js";

export const PROPOSAL_MAX_DAYS = 60; // 複数日モードでAIに見せる日数の上限（tripDateListと同じ）

// 別行動（分岐）がかかっている日（始まりの日〜終わりの日）の一覧。60日で打ち切る
export function branchDateList(branch) {
  const start = branch.date, end = branchEndDateOf(branch);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || "")) return [];
  const out = [];
  for (let d = start, i = 0; d <= end && i < PROPOSAL_MAX_DAYS; i++) { out.push(d); d = addDays(d, 1); }
  return out;
}

/* ---------- AIへのプロンプト・出力スキーマ ---------- */

// kind：'voice'（音声の文字起こし）か 'memo'（貼り付けたメモ・スケジュール）。
// dates：対象の日の一覧。1件なら「この日」モード（日付はサーバーが固定する）、2件以上なら複数日モード。
// branch：別行動に入れるとき { title, date, endDate, startTime, endTime }
export function buildProposalPrompt({ kind, text, notes, dates, branch }) {
  const isVoice = kind === "voice";
  const multi = Array.isArray(dates) && dates.length > 1;
  const source = isVoice ? "旅行者が出来事をまとめて話した音声の文字起こし" : "旅行者が貼り付けたスケジュール・メモ";
  const lines = [
    "あなたは旅行記録アプリのアシスタントです。" + source + "を読んで、予定（1件＝1つの出来事や場所）の配列にしてください。",
    "この結果は、旅行者が確認画面で直してから保存します。",
    "",
  ];
  if (branch) {
    lines.push("これは旅行者の「自分だけの道（別行動）」" + (branch.title ? "「" + branch.title + "」" : "") + "の予定です。");
    lines.push("別行動の時間帯：" + branch.date + " " + branch.startTime + " 〜 " + branchEndDateOf(branch) + " " + branch.endTime, "");
  }
  if (multi) {
    lines.push("この日程は次のとおりです。", dates.map((d, i) => (i + 1) + "日目：" + d).join("\n"), "");
  } else if (dates && dates.length === 1) {
    lines.push("対象の日：" + dates[0] + "（すべての予定の日はこの日です）", "");
  }
  lines.push(
    (isVoice ? "文字起こし：" : "メモ：") + "\n" + text,
    "",
    "ルール：",
    "- 話された／書かれた順番のとおりに並べること。1つの出来事・場所ごとに1件にすること。移動（電車・新幹線・飛行機・バスなど）は、区間ごとに1件（徒歩は作らない）",
    "- 話されていない・書かれていないことは絶対に作らないこと。分からない項目は、空文字（数字なら空配列）のままにすること。推測で埋めないこと",
  );
  if (multi) {
    lines.push("- dateには、その出来事があった日を上記の日程からYYYY-MM-DD形式で選ぶこと。「1日目」「次の日」「2日目の朝」のような表現から判断し、はっきりしなければ直前の予定と同じ日にすること。最初の予定で日が全く分からなければ1日目の日付にすること");
  } else {
    lines.push("- dateは常に" + ((dates && dates[0]) || "対象の日") + "にすること");
  }
  lines.push(
    "- categoryは transport（移動）/ lodging（宿泊）/ food（食事）/ sightseeing（観光・イベント）/ other のいずれか。transportには移動手段（plane, shinkansen, train, bus, car, taxi, walk, bicycle のいずれか。移動以外は空文字）を入れること",
    "- labelは短い見出し。体言止め（名詞で終える）にすること（例：「浅草寺」「天丼でランチ」「羽田→那覇 JAL903」）。「〜する」「〜した」のような文にしないこと。宿泊（lodging）は宿の名前だけにすること",
    "- timeは、「10時に」「18時ごろ」のように具体的な時刻が話された／書かれたときだけ、24時間表記のHH:MM（例：10:00）で入れること。話されていなければ空文字。時刻を推測で作らないこと（「昼」「夕方」のようなあいまいな言葉は空文字）",
    "- costItemsは、「ランチ1500円」「入場料800円」「タクシー$12」のように金額が話された／書かれたときだけ、品目名と金額を1件以上で入れること。amountは数字、currencyは日本円なら空文字、外貨ならISO 4217の3文字（USD、EURなど）。「一人5000円で3人」のように計算が必要なときは合計を入れ、品目名は「合計」などにしてよい。金額が無ければ空配列。金額を推測で作らないこと",
    "- placeは、地図で探せる具体的な場所の名前（観光地・お店・施設・宿など。例：「浅草寺」「東京スカイツリー」「ふふ奈良」）が話された／書かれたときだけ入れること。店名・施設名が言われていれば、料理名やあいまいな言葉（「ランチ」「ホテル」「カフェ」）ではなく、その名前を入れること。名前が無いときは空文字。場所を推測で作らないこと",
    "- 移動（transport）のとき：fromPlaceに出発地、toPlaceに到着地（駅名・空港名。「羽田空港」「東京駅」のように「空港」「駅」まで付ける。話されていなければ空文字）、departTime・arriveTimeに出発・到着時刻（話されていれば。HH:MM）、routeNumberに便名・列車名、companyに会社名（話されていれば）を入れること。移動のplaceは空文字にすること。arriveDateは出発日と同じ書き方で、翌日以降に着くと話されたときだけ別の日にすること（普通は空文字）",
    "- noteには、話した／書いた内容をもとにした2〜3文程度の記録（その場の出来事・感想。話していないことを足さない）を入れること。予約番号・氏名・電話番号・メールアドレス・カード番号は書かないこと",
    notes
      ? "- 次のメモ（URLや店名が雑多に書かれている）の中に、予定の内容と対応しそうなものがあれば、GoogleマップのURLはmapUrl、それ以外のお店などのURLはshopUrlに入れること。対応するものが無ければ空文字のままにすること。\n\nメモ:\n" + notes
      : "- mapUrl・shopUrlは、話された／書かれた中に明確なURLが無ければ空文字にすること",
  );
  return lines.join("\n");
}

// スクショの候補の項目のうち、音声・メモに要るものだけ（画像の番号・チェックアウト日・推測フラグは無い）に、
// 話したURL（mapUrl・shopUrl）を足したスキーマ。strictなので全項目を必須にする
export function proposalSchema() {
  const str = { type: "string" };
  return {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
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
            mapUrl: str,
            shopUrl: str,
          },
          required: [
            "category", "transport", "date", "time", "label", "routeNumber", "company", "fromPlace", "toPlace",
            "departTime", "arriveTime", "arriveDate", "place", "costItems", "note", "mapUrl", "shopUrl",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  };
}

/* ---------- AIの出力 → 候補 ---------- */

// ctx：{ trip:{startDate,endDate}, dates（対象の日の一覧。1件＝この日、2件以上＝複数日）, branch, today }
export function normalizeProposalResult(parsed, ctx) {
  const dates = Array.isArray(ctx.dates) ? ctx.dates : [];
  const multi = dates.length > 1;
  const raw = parsed && Array.isArray(parsed.items) ? parsed.items : [];
  return normalizeProposalItems(raw, {
    trip: ctx.trip,
    today: ctx.today,
    fixedDate: !multi && dates.length === 1 ? dates[0] : "",
    allowedDates: multi ? dates : null,
    defaultDate: dates[0] || "",
    noteMax: 1000,
    maxItems: PROPOSAL_MAX_ITEMS,
    allowGuess: false,
    checkInDefaults: false,
    branch: ctx.branch || null,
  });
}

/* ---------- サブリクエストの見積もり（Workers Freeは1リクエスト50回まで） ---------- */

// kind：'voice'は 文字起こし（Workers AI→だめならOpenAI＝最大2回）＋OpenAI（切れたときの再試行で最大2回）
//       'memo'は 文字起こし無し。placeLookups：場所検索の件数（上限12）。
// d1：ログイン・回数の確認と消費・旅行の取得ぶんの目安。別行動のときは分岐の取得とログイン確認（セッション）が増える
export function estimateProposalSubrequests(kind, placeLookups, opts) {
  const transcribe = kind === "voice" ? 2 : 0;
  const openai = 2;
  const places = Math.max(0, Math.min(placeLookups, SCREENSHOT_MAX_PLACE_LOOKUPS));
  const d1 = 12 + (opts && opts.branch ? 4 : 0);
  const total = transcribe + openai + places + d1;
  return { transcribe, openai, places, d1, total, limit: WORKERS_FREE_SUBREQUEST_LIMIT, ok: total <= WORKERS_FREE_SUBREQUEST_LIMIT };
}
