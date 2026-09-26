/*
 * s2ToLatLng / extractFeatureS2（GoogleマップのURLのS2セルIDから座標を求める）の単体テスト。
 * Workers専用のグローバルを使わない純粋関数なので、nodeでそのまま実行できる。
 * 実行: node worker/test/geo-decode.test.mjs
 */
import assert from "node:assert/strict";
import { s2ToLatLng, extractFeatureS2 } from "../src/geo-decode.js";

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
function near(label, pt, want, kmTol) {
  const rad = Math.PI / 180;
  const dLat = (want.lat - pt.lat) * rad, dLng = (want.lng - pt.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(pt.lat * rad) * Math.cos(want.lat * rad) * Math.sin(dLng / 2) ** 2;
  const km = 12742 * Math.asin(Math.sqrt(h));
  if (pt && km <= kmTol) pass++;
  else {
    fail++;
    console.log("NG  " + label);
    console.log("    got  " + JSON.stringify(pt) + " (" + (pt ? km.toFixed(3) : "-") + "km away)");
    console.log("    want within " + kmTol + "km of " + JSON.stringify(want));
  }
}

/* ---- s2ToLatLng：確認済みの2件（LAユニオン駅・フォス・ド・イグアス） ---- */
near("s2ToLatLng: LAユニオン駅のS2セルID→座標（約1km以内）",
  s2ToLatLng("0x80c2c64160adbc4b"), { lat: 34.0548, lng: -118.2336 }, 1);
near("s2ToLatLng: フォス・ド・イグアスのS2セルID→座標（約1km以内）",
  s2ToLatLng("0x94f6923125f5f069"), { lat: -25.598, lng: -54.573 }, 1);

/* ---- s2ToLatLng：不正な入力 ---- */
check("s2ToLatLng: 16進数でない文字列はnull", s2ToLatLng("not-a-hex"), null);
check("s2ToLatLng: 空文字はnull", s2ToLatLng(""), null);
check("s2ToLatLng: 0はnull（面が求まらない）", s2ToLatLng("0x0"), null);

/* ---- extractFeatureS2：URLからコロン前（S2セルID）を取り出す ---- */
check("extractFeatureS2: !1s0x…:0x…（場所ページのdata=）",
  extractFeatureS2("https://www.google.com/maps/place//data=!4m2!3m1!1s0x94f6923125f5f069:0x707c2dd60b7bd4d?entry=ttu"),
  "0x94f6923125f5f069");
check("extractFeatureS2: ftid=0x…:0x…（内部リンク）",
  extractFeatureS2("https://maps.google.com?ftid=0x80c2c64160adbc4b:0x527217f541ae2569&hl=ja"),
  "0x80c2c64160adbc4b");
check("extractFeatureS2: どちらも無ければnull", extractFeatureS2("https://maps.google.com/maps/place/新宿"), null);
check("extractFeatureS2: 空文字はnull", extractFeatureS2(""), null);

console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
