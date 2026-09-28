/*
 * /ai-compare専用（docs/adr/0012）。Workers AIの様々なモデルが返す出力からJSONを
 * 取り出すための純粋関数。モデルによってレスポンスの形が違う（2026-09-27に実機で
 * 確認できたもの）：
 * - { response: "...文字列..." }                        … Workers AIの素朴なテキスト生成
 * - { response: { ...すでにJSON... } }                   … JSON Mode（response_format）が効いたとき
 * - { choices: [{ message: { content: "..." } }] }       … OpenAI Chat Completions互換形式
 *   （@cf/openai/gpt-oss-120b・@cf/qwen/qwen3-30b-a3b-fp8はこちらの形で返ってくる）
 * - { output_text: "..." } / { output: [{ type: "message", content: [{ type: "output_text", text }] }] }
 *   … OpenAI Responses API互換形式で返すモデルに備えて（念のため）対応
 *
 * また、Qwen3のような「考える」モデルは、本文の前に<think>...</think>で思考過程を
 * 書いてくることがあり、コードブロック（```json ... ```）で囲って返すこともある。
 * さらに前後に説明文が付くこともあるため、それらを取り除いた上で、最初の「{」から
 * 対応する「}」までの最も外側のJSONオブジェクトだけを取り出してからJSON.parseする。
 *
 * Workers専用のグローバルを使わない純粋関数なので、nodeでそのまま単体テストできる
 * （worker/test/ai-parse.test.mjs）。
 */

// <think>...</think>（考える過程）を除く。閉じタグが無い（考え中に打ち切られた）場合は
// <think>以降を丸ごと捨てる。その後、```json ... ``` / ``` ... ``` のコードブロック記法を外す
function stripThinkAndFences(text) {
  let s = String(text);
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/<think>[\s\S]*$/i, "");
  s = s.trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) s = fenced[1].trim();
  return s.trim();
}

// 前後に説明文が付いていても、最初の「{」からそれと対応する「}」までを取り出す
// （文字列リテラルの中の{}は数えない簡易パーサ）。見つからなければnull
function extractOutermostJsonObject(text) {
  const s = String(text);
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// output[]（Responses API互換）からテキストを取り出す
function outputArrayText(output) {
  if (!Array.isArray(output)) return "";
  for (const item of output) {
    if (!item || item.type !== "message") continue;
    for (const part of item.content || []) {
      if (part && (part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
        return part.text;
      }
    }
  }
  return "";
}

// env.AI.run(...)の戻り値（result）から、モデルが書いたはずの「テキストまたはすでに
// パース済みのオブジェクト」を取り出す。見つからなければnull
export function extractRawModelOutput(result) {
  if (result == null) return null;
  if (typeof result === "string") return result;
  if (typeof result !== "object") return null;
  if (typeof result.output_text === "string" && result.output_text) return result.output_text;
  if (Array.isArray(result.output)) {
    const t = outputArrayText(result.output);
    if (t) return t;
  }
  if (result.response !== undefined && result.response !== null && result.response !== "") return result.response;
  const choice = Array.isArray(result.choices) ? result.choices[0] : null;
  const content = choice && choice.message && choice.message.content;
  if (typeof content === "string" && content) return content;
  return null;
}

// extractRawModelOutputで取り出した値を実際にJSONへ変換する。オブジェクトならそのまま、
// 文字列ならthink/コードブロックを除いてからJSON.parseし、それでも失敗したら最も外側の
// {}だけを取り出して再挑戦する。どちらも失敗すればnull
export function parseWorkersAiOutput(result) {
  const raw = extractRawModelOutput(result);
  if (raw == null) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw; // JSON Modeなどですでにオブジェクトの場合
  if (typeof raw !== "string") return null;
  const cleaned = stripThinkAndFences(raw);
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const outer = extractOutermostJsonObject(cleaned);
  if (outer) {
    try { return JSON.parse(outer); } catch { /* 諦めてnullを返す */ }
  }
  return null;
}

// /ai-compareのレスポンスにだけ載せる診断用の抜粋。生のresultそのもの（Workers AIから
// 返ってきたそのままの形）を文字列化して先頭800文字と、トップレベルのキー一覧を返す
// （利用者の音声・メモの内容はここには入らない。あくまでモデルが作った構造上のクセの調査用）
export function describeWorkersAiOutputForDebug(result) {
  let rawSnippet;
  try {
    rawSnippet = (typeof result === "string" ? result : JSON.stringify(result)).slice(0, 800);
  } catch {
    rawSnippet = String(result).slice(0, 800);
  }
  const shape = result && typeof result === "object" ? Object.keys(result) : [typeof result];
  return { rawSnippet, shape };
}
