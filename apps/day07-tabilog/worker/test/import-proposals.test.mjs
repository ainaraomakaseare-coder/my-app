/*
 * 音声・メモ（AI）を「スクショから予定を作る」と同じ形の候補にする純粋関数の単体テスト
 * （docs/adr/0022 2026-09-30追記、docs/adr/0002、docs/adr/0021）。OpenAI・Googleは一切呼ばない。
 * 「10時に浅草寺、ランチは天丼1500円、そのあとスカイツリー」のような文章と、AIが返したはずのJSON（モック）で、
 * 時刻・費用・場所が取れること／話していないことは空のままなこと／別行動の時間帯の検証／サブリクエストの見積もりを確かめる。
 * 実行: node worker/test/import-proposals.test.mjs
 */
import assert from "node:assert/strict";
import {
  buildProposalPrompt, proposalSchema, normalizeProposalResult, estimateProposalSubrequests, branchDateList,
} from "../src/import-proposals.js";
import { collectPlaceQueries, attachPlaces, placeKey, validateSaveItems, SCREENSHOT_MAX_PLACE_LOOKUPS } from "../src/screenshot-import.js";

let pass = 0, fail = 0;
function check(label, got, want) {
  try { assert.deepEqual(got, want); pass++; }
  catch { fail++; console.log("NG  " + label + "\n    got  " + JSON.stringify(got) + "\n    want " + JSON.stringify(want)); }
}
function ok(label, cond) { check(label, !!cond, true); }

const TRIP = { startDate: "2026-10-03", endDate: "2026-10-05" };
const empty = { category: "sightseeing", transport: "", date: "", time: "", label: "", routeNumber: "", company: "", fromPlace: "", toPlace: "", departTime: "", arriveTime: "", arriveDate: "", place: "", costItems: [], note: "", mapUrl: "", shopUrl: "" };
const it = (o) => ({ ...empty, ...o });

/* ---- プロンプト ---- */
{
  const text = "10時に浅草寺、ランチは天丼1500円、そのあとスカイツリー";
  const p = buildProposalPrompt({ kind: "voice", text, notes: "", dates: ["2026-10-03"] });
  ok("プロンプト: 文字起こしを含む", p.includes(text));
  ok("プロンプト: この日モードは日付を固定する", p.includes("dateは常に2026-10-03にすること"));
  ok("プロンプト: 時刻は話されたときだけ・推測しない", /時刻が話された.*ときだけ/.test(p) && p.includes("時刻を推測で作らない"));
  ok("プロンプト: 金額は書かれたときだけ・推測しない", p.includes("金額を推測で作らない") && p.includes("ランチ1500円"));
  ok("プロンプト: 場所は店名・施設名を優先（料理名やあいまいな言葉にしない）", p.includes("料理名やあいまいな言葉") && p.includes("浅草寺"));
  ok("プロンプト: 場所を推測で作らない", p.includes("場所を推測で作らない"));
  ok("プロンプト: 分からない項目は空のまま", p.includes("推測で埋めないこと"));
  const memo = buildProposalPrompt({ kind: "memo", text: "メモ本文", notes: "https://maps.app.goo.gl/x", dates: ["2026-10-03", "2026-10-04"] });
  ok("プロンプト: メモ・複数日は日程の一覧とdateの選び方", memo.includes("1日目：2026-10-03") && memo.includes("2日目：2026-10-04") && memo.includes("書かれたとおりに入れること") && memo.includes("日程の外でも"));
  ok("プロンプト: 別行動は別行動の日々から選ぶ（従来どおり）", buildProposalPrompt({ kind: "memo", text: "x", notes: "", dates: ["2026-10-04", "2026-10-05"], branch: { title: "", date: "2026-10-04", endDate: "2026-10-05", startTime: "13:00", endTime: "18:00" } }).includes("上記の日程からYYYY-MM-DD形式で選ぶ"));
  ok("プロンプト: メモのURL欄を渡す", memo.includes("https://maps.app.goo.gl/x") && memo.includes("mapUrl"));
  const br = buildProposalPrompt({ kind: "memo", text: "x", notes: "", dates: ["2026-10-04"], branch: { title: "美術館", date: "2026-10-04", endDate: "2026-10-04", startTime: "13:00", endTime: "18:00" } });
  ok("プロンプト: 別行動の名前と時間帯", br.includes("「美術館」") && br.includes("2026-10-04 13:00 〜 2026-10-04 18:00"));

  const s = proposalSchema();
  const props = s.properties.items.items.properties;
  ok("スキーマ: strictなので全項目が必須", JSON.stringify(Object.keys(props).sort()) === JSON.stringify(s.properties.items.items.required.slice().sort()));
  ok("スキーマ: スクショ専用の項目（image・checkOutDate・placeGuessed）は無い", !("image" in props) && !("checkOutDate" in props) && !("placeGuessed" in props));
  ok("スキーマ: 時刻・費用・場所・URLがある", ["time", "costItems", "place", "fromPlace", "toPlace", "mapUrl", "shopUrl"].every((k) => k in props));
}

/* ---- 「10時に浅草寺、ランチは天丼1500円、そのあとスカイツリー」→ 時刻・費用・場所 ---- */
{
  const ai = { items: [
    it({ category: "sightseeing", time: "10:00", label: "浅草寺", place: "浅草寺", note: "10時に浅草寺に行った。" }),
    it({ category: "food", label: "天丼でランチ", costItems: [{ label: "天丼", amount: 1500, currency: "" }], note: "ランチは天丼。" }),
    it({ category: "sightseeing", label: "東京スカイツリー", place: "東京スカイツリー" }),
  ] };
  const n = normalizeProposalResult(ai, { trip: TRIP, dates: ["2026-10-04"], today: "2026-09-30" });
  check("件数", n.items.length, 3);
  check("この日モード：AIの日付に関わらず、その日に固定", n.items.map((i) => i.date), ["2026-10-04", "2026-10-04", "2026-10-04"]);
  check("時刻は話された10時だけ入る（ほかは空のまま）", n.items.map((i) => i.time), ["10:00", "", ""]);
  check("費用は天丼1500円だけ（ほかは空）", n.items.map((i) => i.costItems), [[], [{ label: "天丼", amount: 1500 }], []]);
  check("場所は店名・施設名（ランチの天丼は空のまま）", n.items.map((i) => i.place), ["浅草寺", "", "東京スカイツリー"]);
  check("警告なし（日付の警告も、宿の目安の時刻も出ない）", n.items.map((i) => i.warnings), [[], [], []]);
  ok("音声・メモは分からない時刻を作らない（timeEstimatedなし）", n.items.every((i) => i.timeEstimated === false));
  // 場所検索：話した場所の2件だけ・スクショと同じ collectPlaceQueries / attachPlaces
  const { queries, skipped } = collectPlaceQueries(n.items);
  check("場所検索は名前がある2件だけ", [queries, skipped], [["浅草寺", "東京スカイツリー"], 0]);
  const found = {
    [placeKey("浅草寺")]: { name: "浅草寺", address: "東京都台東区浅草2丁目3-1", lat: 35.7148, lng: 139.7967 },
    [placeKey("東京スカイツリー")]: { name: "東京スカイツリー", address: "東京都墨田区押上1丁目1-2", lat: 35.7101, lng: 139.8107 },
  };
  attachPlaces(n.items, found);
  check("地図が付く（浅草寺・スカイツリー）", n.items.map((i) => i.mapPlaceName || ""), ["浅草寺", "", "東京スカイツリー"]);
  ok("座標つきの地図URL", n.items[0].mapUrl.startsWith("https://www.google.com/maps/") && n.items[0].mapLat === 35.7148);
  // 保存の検証も通る（確認後の形）
  const save = validateSaveItems(n.items.map((i) => ({ ...i, time: i.time })), TRIP);
  check("保存前の検証: エラーなし・3件", [save.errors, save.items.length], [[], 3]);
  check("保存前の検証: 費用と時刻が残る", [save.items[1].costItems, save.items[0].time], [[{ label: "天丼", amount: 1500 }], "10:00"]);
}

/* ---- 話していないことは空のまま／AIが作ったものは信用しない ---- */
{
  const ai = { items: [
    it({ category: "food", label: "ホテルのカフェ", time: "25:00", costItems: [{ label: "コーヒー", amount: -300, currency: "" }, { label: "x", amount: "abc", currency: "" }], place: "" }),
    it({ category: "lodging", label: "ホテルA", place: "ホテルA" }),
    it({ category: "sightseeing", label: "美術館", place: "ダミー美術館", time: "昼" }),
  ] };
  const n = normalizeProposalResult(ai, { trip: TRIP, dates: ["2026-10-03"], today: "2026-09-30" });
  check("壊れた時刻・マイナスや文字の金額は捨てて空にする", [n.items[0].time, n.items[0].costItems], ["", []]);
  check("宿に時刻が無くても15:00を作らない", [n.items[1].time, n.items[1].timeEstimated], ["", false]);
  check("あいまいな時刻（昼）は空", n.items[2].time, "");
  const guessed = normalizeProposalResult({ items: [{ ...empty, label: "劇場", place: "推測の劇場", placeGuessed: true }] }, { trip: TRIP, dates: ["2026-10-03"], today: "2026-09-30" });
  check("音声・メモは会場の推測を認めない（placeGuessedは常にfalse・警告なし）", [guessed.items[0].placeGuessed, guessed.items[0].warnings], [false, []]);
  const nolabel = normalizeProposalResult({ items: [{ ...empty, label: "" }] }, { trip: TRIP, dates: ["2026-10-03"], today: "2026-09-30" });
  check("見出しの無い候補は捨てて数える", [nolabel.items.length, nolabel.dropped], [0, 1]);
}

/* ---- 移動：区間・時刻・運賃 ---- */
{
  const ai = { items: [it({ category: "transport", transport: "shinkansen", label: "東京→京都 のぞみ", fromPlace: "東京駅", toPlace: "京都駅", departTime: "9:30", arriveTime: "11:45", routeNumber: "のぞみ", costItems: [{ label: "運賃", amount: 14000, currency: "" }] })] };
  const n = normalizeProposalResult(ai, { trip: TRIP, dates: ["2026-10-03"], today: "2026-09-30" });
  check("移動: 出発時刻がブロックの時刻になり、区間が入る", [n.items[0].time, n.items[0].departTime, n.items[0].arriveTime, n.items[0].fromPlace, n.items[0].toPlace], ["09:30", "09:30", "11:45", "東京駅", "京都駅"]);
  const { queries } = collectPlaceQueries(n.items);
  check("移動の場所検索は出発地・到着地", queries, ["東京駅", "京都駅"]);
}

/* ---- 複数日：日付はAIが選ぶ。日程に無い日付は初日に置いて警告 ---- */
{
  const ai = { items: [
    it({ label: "1日目の観光", date: "2026-10-03" }),
    it({ label: "3日目の観光", date: "2026-10-05" }),
    it({ label: "日付が範囲外", date: "2026-12-25" }),
    it({ label: "日付なし", date: "" }),
  ] };
  const n = normalizeProposalResult(ai, { trip: TRIP, dates: ["2026-10-03", "2026-10-04", "2026-10-05"], today: "2026-09-30" });
  check("複数日: AIが選んだ日が入る", n.items.slice(0, 2).map((i) => i.date), ["2026-10-03", "2026-10-05"]);
  // 書かれた日付は日程の外でも書き換えない（警告だけ。確認画面で日程・日付を合わせる）。読めない日付だけ初日に置く
  check("複数日: 日程の外の日付はそのまま残して警告（初日に黙って置かない）", n.items[2].date, "2026-12-25");
  check("複数日: 日程の外の警告の中身", n.items[2].warnings.some((w) => w.includes("旅行の日程の外")), true);
  check("複数日: 空の日付は初日に置いて警告", [n.items[3].date, n.items[3].warnings.length], ["2026-10-03", 1]);
  // 年が書かれていない月日は、日程の年で補う（日程の外でも書かれた月日のまま）
  const noYear = normalizeProposalResult({ items: [it({ label: "成田空港出発", date: "--05-16" })] }, { trip: { startDate: "2024-12-11", endDate: "2024-12-19" }, dates: ["2024-12-11", "2024-12-12", "2024-12-13"], today: "2026-09-30" });
  check("複数日: 月日だけの日付は日程の年で補い、日程の外でも月日を変えない", noYear.items[0].date, "2024-05-16");
  // 別行動は、別行動の日々の外の日付を信用しない（従来どおり）
  const brNorm = normalizeProposalResult({ items: [it({ label: "外", date: "2026-10-09" })] }, { trip: TRIP, dates: ["2026-10-03", "2026-10-04"], branch: { date: "2026-10-03", endDate: "2026-10-04", startTime: "09:00", endTime: "18:00" }, today: "2026-09-30" });
  check("別行動: 別行動の日の外の日付は別行動の初日に置く", brNorm.items[0].date, "2026-10-03");
}

/* ---- 別行動（自分だけの道）：日程・時間帯の検証 ---- */
{
  const branch = { title: "美術館", date: "2026-10-04", endDate: "2026-10-05", startTime: "13:00", endTime: "12:00" };
  check("別行動の日の一覧", branchDateList(branch), ["2026-10-04", "2026-10-05"]);
  const ai = { items: [
    it({ label: "昼食", date: "2026-10-04", time: "12:00" }), // 始まりの時刻より前
    it({ label: "美術館", date: "2026-10-04", time: "14:00" }), // OK
    it({ label: "朝のカフェ", date: "2026-10-05", time: "09:00" }), // OK（終わりの日は12:00まで）
    it({ label: "遅い昼", date: "2026-10-05", time: "12:30" }), // 終わりの時刻より後
    it({ label: "時刻なし", date: "2026-10-05" }), // 時刻なしは時刻を見ない
  ] };
  const n = normalizeProposalResult(ai, { trip: TRIP, dates: branchDateList(branch), branch, today: "2026-09-30" });
  check("別行動: 時間帯の外だけ警告", n.items.map((i) => i.warnings.filter((w) => w.startsWith("別行動の")).length), [1, 0, 0, 1, 0]);
  check("別行動: 警告の中身", [n.items[0].warnings[0], n.items[3].warnings[0]], ["別行動の時間帯の外の時刻です。時刻を直さないと追加できません", "別行動の時間帯の外の時刻です。時刻を直さないと追加できません"]);
  // 1日だけの別行動（この日モード）
  const one = { title: "", date: "2026-10-04", endDate: "2026-10-04", startTime: "13:00", endTime: "18:00" };
  const n1 = normalizeProposalResult({ items: [it({ label: "A", time: "10:00" }), it({ label: "B", time: "15:00" })] }, { trip: TRIP, dates: ["2026-10-04"], branch: one, today: "2026-09-30" });
  check("別行動（この日）: 13時前の10時は警告", n1.items.map((i) => i.warnings.length), [1, 0]);
  // 保存前の検証（サーバー）
  const branchCamel = { ...one };
  const v = validateSaveItems([
    { date: "2026-10-04", time: "10:00", label: "外", category: "food" },
    { date: "2026-10-04", time: "15:00", label: "中", category: "food" },
    { date: "2026-10-05", time: "", label: "日の外", category: "food" },
    { date: "2026-10-04", label: "時刻なし", category: "food" },
  ], TRIP, { branch: branchCamel });
  check("保存前の検証（別行動）: 中と時刻なしだけ通る", v.items.map((i) => i.label), ["中", "時刻なし"]);
  check("保存前の検証（別行動）: 外れた理由", v.errors, [{ index: 0, reason: "time_out_of_branch" }, { index: 2, reason: "date_out_of_branch" }]);
  const vdb = validateSaveItems([{ date: "2026-10-04", time: "10:00", label: "外", category: "food" }], TRIP, { branch: { date: "2026-10-04", end_date: "", start_time: "13:00", end_time: "18:00" } });
  check("保存前の検証: DB行（snake_case）の分岐でも同じ", vdb.errors, [{ index: 0, reason: "time_out_of_branch" }]);
}

/* ---- 話したURL ---- */
{
  const ai = { items: [
    it({ label: "首里城", place: "首里城", mapUrl: "https://maps.app.goo.gl/abc123" }),
    it({ label: "沖縄そば", shopUrl: "https://tabelog.com/okinawa/x/", mapUrl: "https://example.com/not-map" }),
  ] };
  const n = normalizeProposalResult(ai, { trip: TRIP, dates: ["2026-10-03"], today: "2026-09-30" });
  check("URL: Googleマップは地図、そのほかはお店のURL（地図でないURLは地図にしない）", [n.items[0].mapUrl, n.items[1].mapUrl, n.items[1].shopUrl], ["https://maps.app.goo.gl/abc123", undefined, "https://tabelog.com/okinawa/x/"]);
  check("URLの地図があるものは場所検索しない", collectPlaceQueries(n.items).queries, []);
  const v = validateSaveItems(n.items, TRIP);
  check("保存前の検証: shopUrlが残る", [v.items[0].mapUrl, v.items[1].shopUrl], ["https://maps.app.goo.gl/abc123", "https://tabelog.com/okinawa/x/"]);
}

/* ---- 場所検索の上限・サブリクエストの見積もり ---- */
{
  const many = Array.from({ length: 30 }, (_, i) => it({ label: "店" + i, place: "店" + i }));
  const n = normalizeProposalResult({ items: many }, { trip: TRIP, dates: ["2026-10-03"], today: "2026-09-30" });
  const c = collectPlaceQueries(n.items);
  check("場所検索は12件まで・残りは数えるだけ（スクショと同じ上限）", [c.queries.length, c.skipped], [SCREENSHOT_MAX_PLACE_LOOKUPS, 18]);
  const v = estimateProposalSubrequests("voice", 12, {});
  check("見積もり（音声）：文字起こし2＋OpenAI2＋場所12＋D1 12 = 28", [v.transcribe, v.openai, v.places, v.d1, v.total], [2, 2, 12, 12, 28]);
  const b = estimateProposalSubrequests("voice", 99, { branch: true });
  check("見積もり（音声・別行動）：場所は12まで、合計32で50以内", [b.places, b.total, b.ok], [12, 32, true]);
  check("見積もり（メモ）：文字起こしは無い", estimateProposalSubrequests("memo", 12, {}).total, 26);
  const big = normalizeProposalResult({ items: Array.from({ length: 80 }, (_, i) => it({ label: "x" + i })) }, { trip: TRIP, dates: ["2026-10-03"], today: "2026-09-30" });
  check("候補は60件まで・超えた分は捨てた数に入る", [big.items.length, big.dropped], [60, 20]);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
