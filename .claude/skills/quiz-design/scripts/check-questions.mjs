#!/usr/bin/env node
/* 設問の機械検査。SKILL.md の「4つの検査」をコードにしたもの。
   使い方: node check-questions.mjs questions.json
   期待する形: [{ text, choices:[4つ], answer, level }, ...]
   出題ロジックのテストでも、AI出力の実行時検証でも、同じ基準を使うために切り出してある。 */

/* 選択肢の数。4択以外にするなら呼ぶ側で差し替える */
const WANT_CHOICES = 4;
/* 正解だけが極端に長い／短いのを弾く閾値。
   正解の長さが他の平均の何倍まで許すか。1.8 は「明らかに浮いている」の手前 */
const LEN_RATIO = 1.8;

/* 設問ひとつを検査して、壊れている理由の配列を返す。空なら合格。 */
export function checkQuestion(q, opts = {}) {
  const want = opts.choices || WANT_CHOICES;
  const levels = opts.levels || [1, 2, 3];
  const bad = [];

  if (!q || typeof q !== "object") return ["設問が object ではない"];
  if (typeof q.text !== "string" || !q.text.trim()) bad.push("問題文が空");
  if (!Array.isArray(q.choices)) return bad.concat("choices が配列ではない");

  /* 検査2の一部: 数と重複 */
  if (q.choices.length !== want) bad.push(`選択肢が${want}つでない（${q.choices.length}）`);
  if (q.choices.some(c => typeof c !== "string" || !c.trim())) bad.push("空の選択肢がある");
  if (new Set(q.choices).size !== q.choices.length) bad.push("選択肢が重複している");

  /* 検査1: 正解が選択肢の中に文字列として在ること。
     添字で持たせたり、表記ゆれがあると ここで落ちる */
  if (typeof q.answer !== "string") bad.push("answer が文字列でない");
  else if (!q.choices.includes(q.answer)) bad.push("answer が choices の中に無い");

  /* 検査4: 答えが問題文に漏れていないか */
  if (typeof q.answer === "string" && q.answer.length >= 2 &&
      typeof q.text === "string" && q.text.includes(q.answer)) {
    bad.push("問題文に答えが含まれている");
  }

  /* 検査2の残り: 正解だけ長さが浮いていないか */
  if (typeof q.answer === "string" && q.choices.includes(q.answer) && q.choices.length > 1) {
    const others = q.choices.filter(c => c !== q.answer);
    const avg = others.reduce((s, c) => s + c.length, 0) / others.length;
    if (avg > 0 && (q.answer.length > avg * LEN_RATIO || q.answer.length * LEN_RATIO < avg)) {
      bad.push(`正解だけ長さが浮いている（正解${q.answer.length}字 / 他の平均${avg.toFixed(1)}字）`);
    }
  }

  if (!levels.includes(q.level)) bad.push(`level が ${levels.join("/")} でない（${q.level}）`);

  return bad;
}

/* 設問の配列を検査して { ok, ng } に分ける。ng には理由が付く。
   落ちた設問は直さずに捨てる、が原則。 */
export function checkAll(questions, opts) {
  const ok = [], ng = [];
  (questions || []).forEach((q, i) => {
    const bad = checkQuestion(q, opts);
    if (bad.length) ng.push({ index: i, question: q, reasons: bad });
    else ok.push(q);
  });
  return { ok, ng };
}

/* コマンドから直接呼ばれたときだけ実行する */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const file = process.argv[2];
  if (!file) {
    console.error("使い方: node check-questions.mjs questions.json");
    process.exit(2);
  }
  const { readFileSync } = await import("node:fs");
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`${file} を JSON として読めない: ${e.message}`);
    process.exit(2);
  }
  const list = Array.isArray(data) ? data : data.questions;
  if (!Array.isArray(list)) {
    console.error("配列か { questions: [...] } を渡すこと");
    process.exit(2);
  }
  const { ok, ng } = checkAll(list);
  ng.forEach(({ index, question, reasons }) => {
    console.log(`NG  #${index}  ${String(question && question.text).slice(0, 40)}`);
    reasons.forEach(r => console.log(`      - ${r}`));
  });
  console.log(`\n合格 ${ok.length} / ${list.length}`);
  process.exit(ng.length ? 1 : 0);
}
