/*
 * AIの出力言語（繁体字中国語・台湾、英語対応）。リクエスト本文（JSON・x-voice-meta）の lang、
 * なければAccept-Languageの先頭の言語で決める。zh-TW/HK/MO/Hant は 'zh-Hant'、ja・ヘッダ無しは 'ja'、
 * それ以外の言語は 'en'。日本語のときはプロンプトを一切変えない（既存の挙動を保つ）。
 * エラーはコード（error: "..."）で返し、利用者に見せる文言はクライアント側で言語ごとに決める。
 */

export function detectLang(request, ...bodies) {
  for (const b of bodies) {
    if (b && typeof b === "object" && typeof b.lang === "string") {
      if (b.lang === "zh-Hant") return "zh-Hant";
      if (b.lang === "en") return "en";
      if (b.lang === "ja") return "ja";
    }
  }
  const h = request && request.headers && typeof request.headers.get === "function" ? request.headers.get("accept-language") : "";
  const first = String(h || "").split(",")[0].trim();
  if (!first || first === "*") return "ja";
  if (/^ja/i.test(first)) return "ja";
  if (/^zh-(TW|HK|MO|Hant)/i.test(first)) return "zh-Hant";
  return "en"; // 日本語・繁体字以外の言語（海外の利用者）は英語
}

// zh-Hant・enのときだけプロンプトの末尾に足す指示。jaのときは空文字
export function langDirective(lang) {
  if (lang === "en") {
    return [
      "",
      "OUTPUT LANGUAGE: The traveler is an English speaker. The input above may be in English, Japanese or another language.",
      "Write every human-readable text field (label, episode, note, cost item names, and similar free-text fields) in natural English, even though the instructions above are written in Japanese.",
      "The label rule about noun-ending headings applies in English too: use a short noun phrase, not a full sentence.",
      "Place names (place, fromPlace, toPlace): keep the name as written in the source so it can still be found on a map; when the source gives no written form, use the common English name.",
      "Do NOT translate or change enum and code fields: category, transport, currency (ISO 4217 codes), date, time and similar fields must follow the schema exactly as instructed above.",
    ].join("\n");
  }
  if (lang !== "zh-Hant") return "";
  return [
    "",
    "OUTPUT LANGUAGE: The traveler is a Traditional Chinese (Taiwan) speaker. The input above may be in Traditional Chinese, Japanese or another language.",
    "Write every human-readable text field (label, episode, note, cost item names, and similar free-text fields) in Traditional Chinese as used in Taiwan (繁體中文・台灣用語), even though the instructions above are written in Japanese.",
    "The label rule about noun-ending headings applies in Chinese too: use a short noun phrase, not a full sentence.",
    "Place names (place, fromPlace, toPlace): keep the name as written in the source so it can still be found on a map; when the source gives no written form, use the form commonly written in Taiwan.",
    "Do NOT translate or change enum and code fields: category, transport, currency (ISO 4217 codes), date, time and similar fields must follow the schema exactly as instructed above.",
  ].join("\n");
}
