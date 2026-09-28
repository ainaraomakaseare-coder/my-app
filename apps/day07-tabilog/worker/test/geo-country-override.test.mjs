/*
 * overrideCountryByCoords（src/geo-country-override.js）の単体テスト。
 * 香港・マカオを「中国」から座標だけで分ける、既存データ向けの上書き。
 * 実行: node worker/test/geo-country-override.test.mjs
 */
import assert from "node:assert/strict";
import { overrideCountryByCoords } from "../src/geo-country-override.js";

let pass = 0, fail = 0;
function check(label, got, want) {
  try { assert.deepEqual(got, want); pass++; }
  catch (e) { fail++; console.error("FAIL:", label, "\n  got: ", JSON.stringify(got), "\n  want:", JSON.stringify(want)); }
}

// オーナー報告：ブラジル旅行の香港経由の乗り継ぎ（香港島・香港空港）が「中国」になっていた
check("香港島は香港", overrideCountryByCoords("中国", 22.28, 114.16), "香港");
check("香港国際空港は香港", overrideCountryByCoords("中国", 22.31, 113.91), "香港");
check("マカオ半島はマカオ", overrideCountryByCoords("中国", 22.1987, 113.5439), "マカオ");
check("タイパはマカオ", overrideCountryByCoords("中国", 22.15, 113.58), "マカオ");

// 境界値：深圳・珠海は引き続き「中国」のまま（bboxが粗い矩形なので、隣接する本土の都市を
// 誤って香港・マカオにしないことを確認する）
check("深圳は中国のまま（香港のbbox北端に近いが除外）", overrideCountryByCoords("中国", 22.54, 114.06), "中国");
check("珠海は中国のまま（マカオの少し北）", overrideCountryByCoords("中国", 22.27, 113.57), "中国");

// 「中国」以外の国名はそのまま（すでに正しく判定されている・関係ない国の座標を誤って書き換えない）
check("すでに香港ならそのまま", overrideCountryByCoords("香港", 22.28, 114.16), "香港");
check("日本はそのまま（座標がたまたま近くても対象外）", overrideCountryByCoords("日本", 22.28, 114.16), "日本");
check("空文字はそのまま", overrideCountryByCoords("", 22.28, 114.16), "");

// 座標が無い・不正なとき（中国のままにする。落ちない）
check("座標がundefinedでも例外にならない", overrideCountryByCoords("中国", undefined, undefined), "中国");
check("座標がnullでも例外にならない", overrideCountryByCoords("中国", null, null), "中国");

// 中国国内の全く関係ない場所（北京など）はそのまま
check("北京は中国のまま", overrideCountryByCoords("中国", 39.9, 116.4), "中国");

console.log(`geo-country-override.test.mjs: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
