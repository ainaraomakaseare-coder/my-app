/*
 * parseReceiptText（Cloud Visionの読み取り結果を品目に分けるルールベース処理）の単体テスト。
 * Workers専用のグローバルを使わない純粋関数なので、nodeでそのまま実行できる。
 * 実行: node worker/test/receipt-parse.test.mjs
 */
import assert from "node:assert/strict";
import { parseReceiptText } from "../src/receipt-parse.js";

let pass = 0, fail = 0;
function check(label, got, want) {
  try {
    assert.deepEqual(got, want);
    pass++;
  } catch {
    fail++;
    console.log("NG  " + label);
    console.log("    got  " + JSON.stringify(got));
    console.log("    want " + JSON.stringify(want));
  }
}

/* ---- フィクスチャ1：コンビニ（品目名と金額が同じ行、¥表記、小計・税・お預り・お釣りを含む） ---- */
const receiptConbini = [
  "セブン-イレブン 渋谷店",
  "2026年09月26日 12:34",
  "おにぎり             ¥120",
  "サンドイッチ         ¥298",
  "コーヒー             ¥150",
  "小計                 ¥568",
  "消費税               ¥45",
  "合計                 ¥613",
  "お預り               ¥1,000",
  "お釣り               ¥387",
  "またお越しください",
].join("\n");

check("コンビニ：品目だけを読み取り、小計・税・お預り・お釣りは除く", parseReceiptText(receiptConbini).items, [
  { label: "おにぎり", amount: 120 },
  { label: "サンドイッチ", amount: 298 },
  { label: "コーヒー", amount: 150 },
]);

/* ---- フィクスチャ2：レストラン（円表記、品目名だけの行→金額だけの行、現金・お釣り） ---- */
const receiptRestaurant = [
  "焼肉レストラン 大阪店",
  "TEL 06-1234-5678",
  "カルビ定食",
  "1200円",
  "ライス大盛り",
  "150円",
  "ウーロン茶",
  "300円",
  "小計 1650円",
  "消費税(10%) 150円",
  "合計 1800円",
  "現金 2000円",
  "お釣り 200円",
  "ありがとうございました",
].join("\n");

check("レストラン：品目名の行と金額の行が分かれていても合体させる", parseReceiptText(receiptRestaurant).items, [
  { label: "カルビ定食", amount: 1200 },
  { label: "ライス大盛り", amount: 150 },
  { label: "ウーロン茶", amount: 300 },
]);

/* ---- フィクスチャ3：スーパー（全角数字・全角￥、ポイント利用・値引きの行を除く） ---- */
const receiptSuper = [
  "スーパーマーケットいろは",
  "牛乳                  ￥２５０",
  "食パン                ￥１８０",
  "卵１０個パック        ￥２１０",
  "ポイント利用          -￥５０",
  "値引き                ￥０",
  "小計                  ￥６４０",
  "消費税                ￥５１",
  "合計                  ￥６９１",
  "クレジットカード      ￥６９１",
].join("\n");

check("スーパー：全角数字を半角に直し、ポイント・値引き・カードの行は除く", parseReceiptText(receiptSuper).items, [
  { label: "牛乳", amount: 250 },
  { label: "食パン", amount: 180 },
  { label: "卵10個パック", amount: 210 },
]);

/* ---- フィクスチャ4：カフェ（登録番号・営業時間・定休日などの店情報の行が混じる） ---- */
const receiptCafe = [
  "カフェ・ド・タビ",
  "登録番号 T1234567890123",
  "営業時間 8:00-20:00",
  "定休日 水曜日",
  "ブレンドコーヒー      ¥480",
  "チーズケーキ          ¥420",
  "小計                  ¥900",
  "内税                  ¥81",
  "合計                  ¥900",
  "お預かり              ¥1,000",
  "お釣り                ¥100",
].join("\n");

check("カフェ：登録番号・営業時間・定休日などの店情報の行を品目と誤認しない", parseReceiptText(receiptCafe).items, [
  { label: "ブレンドコーヒー", amount: 480 },
  { label: "チーズケーキ", amount: 420 },
]);

/* ---- 金額が全く無い・空文字などの入力でも例外を投げない ---- */
check("空文字は0件", parseReceiptText("").items, []);
check("金額の行が無ければ0件", parseReceiptText("店名のみ\n住所のみ").items, []);

console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
