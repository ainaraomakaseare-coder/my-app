/*
 * parseWorkersAiOutput / describeWorkersAiOutputForDebugの単体テスト。
 * Workers専用のグローバルを使わない純粋関数なので、nodeでそのまま実行できる。
 * 実行: node worker/test/ai-parse.test.mjs
 */
import assert from "node:assert/strict";
import { parseWorkersAiOutput, describeWorkersAiOutputForDebug } from "../src/ai-parse.js";

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

const BLOCKS = { blocks: [{ label: "首里城公園に到着", category: "sightseeing", time: "10:00", entry: { episode: "", mapUrl: "", shopUrl: "", costItems: [] } }] };
const BLOCKS_JSON = JSON.stringify(BLOCKS);

/* ---- response: 素朴なテキスト生成（{ response: "..." }） ---- */
check("response: 文字列のJSONをそのままparse", parseWorkersAiOutput({ response: BLOCKS_JSON }), BLOCKS);

/* ---- response: JSON Modeですでにオブジェクト（{ response: {...} }） ---- */
check("response: すでにオブジェクトならそのまま", parseWorkersAiOutput({ response: BLOCKS }), BLOCKS);

/* ---- choices[0].message.content（Chat Completions互換。gpt-oss-120b・qwen3-30bはこの形） ---- */
check("choices: message.contentのJSON文字列をparse",
  parseWorkersAiOutput({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: BLOCKS_JSON } }] }),
  BLOCKS);

/* ---- choices: 前に<think>...</think>が付く（Qwen3のようなモデル） ---- */
check("choices: <think>...</think>を取り除いてからparse",
  parseWorkersAiOutput({ choices: [{ message: { content: "<think>まず整理すると…うんぬん</think>\n" + BLOCKS_JSON } }] }),
  BLOCKS);

/* ---- choices: <think>が閉じずに打ち切られた（考え中に尽きた） ---- */
check("choices: 閉じタグの無い<think>は丸ごと捨てる → 中身が残らずnull",
  parseWorkersAiOutput({ choices: [{ message: { content: "<think>まだ考え中で終わってしまった" } }] }),
  null);

/* ---- choices: コードブロック（```json ... ```）で返す ---- */
check("choices: ```json ... ``` のコードブロックを外してparse",
  parseWorkersAiOutput({ choices: [{ message: { content: "```json\n" + BLOCKS_JSON + "\n```" } }] }),
  BLOCKS);

/* ---- choices: 前後に説明文が付く（最も外側の{}だけを取り出す） ---- */
check("choices: 前後の説明文を無視して最も外側の{}を取り出す",
  parseWorkersAiOutput({ choices: [{ message: { content: "はい、整理しました:\n" + BLOCKS_JSON + "\n以上です。" } }] }),
  BLOCKS);

/* ---- output_text（Responses API互換） ---- */
check("output_text: 文字列のJSONをそのままparse", parseWorkersAiOutput({ output_text: BLOCKS_JSON }), BLOCKS);

/* ---- output[]（Responses API互換、type: message → content[].type: output_text） ---- */
check("output: message型のoutput_textパートからJSONをparse",
  parseWorkersAiOutput({
    output: [
      { type: "reasoning", content: [] },
      { type: "message", content: [{ type: "output_text", text: BLOCKS_JSON }] },
    ],
  }),
  BLOCKS);

/* ---- output[]（typeが"text"のパート） ---- */
check("output: message型のtextパートからもJSONをparse",
  parseWorkersAiOutput({ output: [{ type: "message", content: [{ type: "text", text: BLOCKS_JSON }] }] }),
  BLOCKS);

/* ---- 完全な文字列そのもの ---- */
check("resultが文字列そのもの", parseWorkersAiOutput(BLOCKS_JSON), BLOCKS);

/* ---- 壊れている・読めない場合はnull ---- */
check("responseが壊れたJSON文字列 → null", parseWorkersAiOutput({ response: "{ blocks: [ この時点で切れた" }), null);
check("resultがnull → null", parseWorkersAiOutput(null), null);
check("resultが空オブジェクト（どの形にも当てはまらない） → null", parseWorkersAiOutput({}), null);
check("choicesが空配列 → null", parseWorkersAiOutput({ choices: [] }), null);

/* ---- describeWorkersAiOutputForDebug ---- */
{
  const d = describeWorkersAiOutputForDebug({ choices: [{ message: { content: "abc" } }], model: "x" });
  check("debug: トップレベルのキーを返す", d.shape.sort(), ["choices", "model"].sort());
  check("debug: rawSnippetはJSON文字列化した先頭部分を含む", d.rawSnippet.includes('"choices"'), true);
}
{
  const long = "a".repeat(2000);
  const d = describeWorkersAiOutputForDebug({ response: long });
  check("debug: rawSnippetは800文字までに切り詰める", d.rawSnippet.length, 800);
}
{
  const d = describeWorkersAiOutputForDebug("plain string result");
  check("debug: 文字列のresultはそのままrawSnippetに", d.rawSnippet, "plain string result");
  check("debug: 文字列のresultはshapeに型名を入れる", d.shape, ["string"]);
}

console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
