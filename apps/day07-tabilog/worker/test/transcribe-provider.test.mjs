/*
 * isUsableTranscriptの単体テスト。
 * Workers専用のグローバルを使わない純粋関数なので、nodeでそのまま実行できる。
 * 実行: node worker/test/transcribe-provider.test.mjs
 */
import assert from "node:assert/strict";
import { isUsableTranscript } from "../src/transcribe-provider.js";

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

check("普通の文字起こしは使える", isUsableTranscript("首里城公園に着いた"), true);
check("前後に空白が付いていても中身があれば使える", isUsableTranscript("  こんにちは  "), true);
check("空文字は使えない", isUsableTranscript(""), false);
check("空白だけは使えない", isUsableTranscript("   "), false);
check("nullは使えない", isUsableTranscript(null), false);
check("undefinedは使えない", isUsableTranscript(undefined), false);
check("数値は使えない", isUsableTranscript(123), false);
check("オブジェクトは使えない", isUsableTranscript({ text: "abc" }), false);
check("AI_QUOTA_EXHAUSTED相当のオブジェクトも使えない扱い", isUsableTranscript({ quotaExhausted: true }), false);

console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
