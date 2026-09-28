/*
 * 本番の音声文字起こし（`createBlocksFromVoice`／`createBlocksFromVoiceMultiDay`）は
 * 2026-09-28から、Cloudflare Workers AI（`@cf/openai/whisper-large-v3-turbo`）を先に試し、
 * 失敗した・空文字だったときだけ今までどおりOpenAI（Whisper）にフォールバックする
 * （docs/adr/0012「試作→本採用」。整理（`organizeTextIntoBlocks`）は引き続きOpenAIのまま）。
 *
 * Workers AIの結果が「使える文字起こしか」を判定する部分だけを、Workers専用の
 * グローバル（env.AI・fetch）を使わない純粋関数として切り出した。nodeでそのまま
 * 単体テストできる（worker/test/transcribe-provider.test.mjs）。
 */

// Workers AIの文字起こし結果を、そのまま使ってよいか判定する。
// 空文字・空白のみ・null/undefined・文字列以外（例外的にオブジェクトが返ってきた場合など）は
// 「使えない」＝OpenAIへフォールバックする対象とする。
export function isUsableTranscript(text) {
  return typeof text === "string" && text.trim().length > 0;
}
