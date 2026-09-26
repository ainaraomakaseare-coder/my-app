/*
 * s2ToLatLng / extractFeatureS2（GoogleマップのURLのS2セルIDから座標を求める）の単体テスト。
 * Workers専用のグローバルを使わない純粋関数なので、nodeでそのまま実行できる。
 * 実行: node worker/test/geo-decode.test.mjs
 */
import assert from "node:assert/strict";
import {
  s2ToLatLng, extractFeatureS2,
  distanceKm, nearestCandidate, pickNominatimCandidate, placeNameRank, pickWikiHit, pickGeoNamesCandidate,
  isValidEntryId, entryNeedsGeocode,
} from "../src/geo-decode.js";

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

/* ---- distanceKm：2点間のおおよその距離 ---- */
{
  const osakaToTokyo = distanceKm({ lat: 34.6937, lng: 135.5023 }, { lat: 35.6812, lng: 139.7671 });
  if (osakaToTokyo > 390 && osakaToTokyo < 410) pass++;
  else { fail++; console.log("NG  distanceKm: 大阪→東京は約400km\n    got  " + osakaToTokyo); }
}
check("distanceKm: 同じ点は0km", Math.round(distanceKm({ lat: 34.6937, lng: 135.5023 }, { lat: 34.6937, lng: 135.5023 })), 0);

/* ---- nearestCandidate：候補の中からnearsにいちばん近いものを選ぶ ---- */
{
  const osaka = { lat: 34.6656, lng: 135.4325, id: "osaka" };
  const orlando = { lat: 28.4744, lng: -81.4683, id: "orlando" };
  const nearOsaka = [{ lat: 34.70, lng: 135.50 }];
  check("nearestCandidate: 大阪の近くのnearsなら大阪の候補を選ぶ（ユニバーサル問題）",
    (nearestCandidate([orlando, osaka], nearOsaka) || {}).id, "osaka");
  check("nearestCandidate: nearsが空ならnull（呼び出し側でフォールバック）", nearestCandidate([orlando, osaka], []), null);
  check("nearestCandidate: 候補が空ならnull", nearestCandidate([], nearOsaka), null);
}

/* ---- pickNominatimCandidate：nearsがあれば近い方、無ければ重要度がいちばん高いもの ---- */
{
  // 「赤レンガ倉庫」：敦賀（重要度高い）と横浜（重要度は低いが実在の場所）が並ぶケース
  const tsuruga = { lat: "35.6619607", lon: "136.0745531", importance: 0.218 };
  const yokohama = { lat: "35.4518491", lon: "139.6419320", importance: 0.0000748 };
  check("pickNominatimCandidate: nearsが無ければ重要度がいちばん高い候補（敦賀）",
    (pickNominatimCandidate([tsuruga, yokohama]) || {}).lat, 35.6619607);
  const nearYokohama = [{ lat: 35.44, lng: 139.64 }]; // みなとみらい発（同じ旅行のほかの場所）
  check("pickNominatimCandidate: nearsがあれば重要度が低くても近い候補（横浜）を選ぶ",
    (pickNominatimCandidate([tsuruga, yokohama], nearYokohama) || {}).lat, 35.4518491);
  check("pickNominatimCandidate: 座標が不正な要素は無視する",
    (pickNominatimCandidate([{ lat: "NaN", lon: "x", importance: 0.9 }, yokohama]) || {}).lat, 35.4518491);
  check("pickNominatimCandidate: 配列でなければnull", pickNominatimCandidate(null), null);
}

/* ---- placeNameRank：名前と記事の題名の合い方 ---- */
check("placeNameRank: 完全一致は3", placeNameRank("ドジャースタジアム", "ドジャースタジアム"), 3);
check("placeNameRank: 表記ゆれ（ヴ→ブ・空白・かっこ）を吸収して3", placeNameRank("ラスヴェガス", "ラス ベガス（アメリカ）"), 3);
check("placeNameRank: 題名が名前を含む部分一致は2", placeNameRank("赤レンガ倉庫", "横浜赤レンガ倉庫"), 2);
check("placeNameRank: 名前が題名を含む（逆）は0（町全体になるため使わない）", placeNameRank("フラミンゴ ラスベガス", "ラスベガス"), 0);
check("placeNameRank: 合わない名前は0", placeNameRank("ドジャースタジアム", "エンゼル・スタジアム"), 0);

/* ---- pickWikiHit：同じ順位の候補からnearsで選ぶ（敦賀赤レンガ倉庫 vs 横浜赤レンガ倉庫） ---- */
{
  const tsurugaHit = { title: "敦賀赤レンガ倉庫", rank: 2, lat: 35.6619607, lng: 136.0745531 };
  const yokohamaHit = { title: "横浜赤レンガ倉庫", rank: 2, lat: 35.4518491, lng: 139.6419320 };
  const exactHit = { title: "赤レンガ倉庫", rank: 3, lat: 0, lng: 0 };
  check("pickWikiHit: 同順位（rank 2）どうしはnearsで近い方（横浜）",
    (pickWikiHit([tsurugaHit, yokohamaHit], [{ lat: 35.44, lng: 139.64 }]) || {}).title, "横浜赤レンガ倉庫");
  check("pickWikiHit: nearsが無ければ先頭（従来どおり）",
    (pickWikiHit([tsurugaHit, yokohamaHit]) || {}).title, "敦賀赤レンガ倉庫");
  check("pickWikiHit: 完全一致（rank 3）はnearsを見ずに常に優先",
    (pickWikiHit([tsurugaHit, yokohamaHit, exactHit], [{ lat: 35.44, lng: 139.64 }]) || {}).title, "赤レンガ倉庫");
  check("pickWikiHit: 空配列はnull", pickWikiHit([]), null);
}

/* ---- pickGeoNamesCandidate：Open-Meteoの結果からnearsで選ぶ ---- */
{
  const orlando = { name: "ユニバーサル・オーランド・リゾート", latitude: 28.4744, longitude: -81.4683 };
  const universalCityWalkOsaka = { name: "ユニバーサル・シティウォーク大阪", latitude: 34.66828, longitude: 135.4375939 };
  check("pickGeoNamesCandidate: nearsがあれば近い方（大阪）を選ぶ",
    (pickGeoNamesCandidate([orlando, universalCityWalkOsaka], [{ lat: 34.70, lng: 135.50 }]) || {}).name,
    "ユニバーサル・シティウォーク大阪");
  check("pickGeoNamesCandidate: nearsが無ければ先頭（従来どおり、人口順などAPIの並び順）",
    (pickGeoNamesCandidate([orlando, universalCityWalkOsaka]) || {}).name, "ユニバーサル・オーランド・リゾート");
  check("pickGeoNamesCandidate: 空配列はnull", pickGeoNamesCandidate([]), null);
}

/* ---- isValidEntryId：/geocode?entry=の値検証（Part A、2026-09-26〜） ---- */
check("isValidEntryId: 正しい形式（ent_+32桁16進）はtrue", isValidEntryId("ent_" + "a".repeat(32)), true);
check("isValidEntryId: プレフィックス違いはfalse", isValidEntryId("blk_" + "a".repeat(32)), false);
check("isValidEntryId: 桁数が違うとfalse", isValidEntryId("ent_abc"), false);
check("isValidEntryId: SQLインジェクションを試みる文字列はfalse", isValidEntryId("ent_' OR '1'='1"), false);
check("isValidEntryId: undefinedはfalse", isValidEntryId(undefined), false);

/* ---- entryNeedsGeocode：記録の保存で裏の座標計算を走らせるか（Part A） ---- */
check("entryNeedsGeocode: 地図なしは求めない", entryNeedsGeocode("", "", ""), false);
check("entryNeedsGeocode: 新規で地図URLを付けたら求める", entryNeedsGeocode("", "", "https://maps.example/a"), true);
check("entryNeedsGeocode: 地図URLを別のものに変えたら求め直す",
  entryNeedsGeocode("https://maps.example/a", "https://maps.example/a", "https://maps.example/b"), true);
check("entryNeedsGeocode: 同じURLのままで、すでに求めてあれば求めない",
  entryNeedsGeocode("https://maps.example/a", "https://maps.example/a", "https://maps.example/a"), false);
check("entryNeedsGeocode: 同じURLのままでも、まだ一度も求めていなければ求める",
  entryNeedsGeocode("https://maps.example/a", "", "https://maps.example/a"), true);

console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
