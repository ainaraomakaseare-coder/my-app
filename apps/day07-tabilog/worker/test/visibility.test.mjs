/*
 * 公開範囲の判定表・フォローの状態遷移・公開の画面に返す旅行の「許可リスト」（docs/adr/0010）の純粋関数テスト。
 * 実行: node worker/test/visibility.test.mjs
 */
import assert from "node:assert/strict";
import {
  VISIBILITIES, BIO_MAX, normalizeVisibility, canViewByVisibility, nextFollowStatus, followStateLabel,
  validAvatarId, newPublicId, validPublicId, stripTripForPublic,
} from "../src/visibility.js";

let pass = 0, fail = 0;
function check(label, got, want) {
  try { assert.deepEqual(got, want); pass++; } catch {
    fail++;
    console.log("NG  " + label);
    console.log("    got  " + JSON.stringify(got));
    console.log("    want " + JSON.stringify(want));
  }
}

/* ---- 判定表：見る人の立場 × 公開範囲 ---- */
const viewers = {
  "持ち主":                { isOwner: true },
  "ログインなし/関係なし": {},
  "フォロワー":            { isFollower: true },
  "親しい友人（=フォロワー）": { isFollower: true, isCloseFriend: true },
  "親しい友人だけ（念のため）": { isCloseFriend: true },
  "持ち主にブロックされた人（フォロワー扱い）": { isFollower: true, isCloseFriend: true, blockedByOwner: true },
  "持ち主をブロックした人（フォロワー）":       { isFollower: true, blockedByViewer: true },
};
const matrix = {
  //                                    members  close_friends followers public
  "持ち主":                            [true, true, true, true],
  "ログインなし/関係なし":             [false, false, false, true],
  "フォロワー":                        [false, false, true, true],
  "親しい友人（=フォロワー）":         [false, true, true, true],
  "親しい友人だけ（念のため）":        [false, true, true, true],
  "持ち主にブロックされた人（フォロワー扱い）": [false, false, false, true],
  "持ち主をブロックした人（フォロワー）":       [false, false, false, false],
};
for (const [who, base] of Object.entries(viewers)) {
  const got = VISIBILITIES.map((v) => canViewByVisibility({ visibility: v, ...base }));
  check("判定表：" + who, got, matrix[who]);
}
check("判定表：知らない公開範囲は一緒に行った人だけ扱い（持ち主以外は見えない）", canViewByVisibility({ visibility: "world", isFollower: true }), false);
check("normalizeVisibility：壊れた値はmembers", [normalizeVisibility(undefined), normalizeVisibility("x"), normalizeVisibility("public")], ["members", "members", "public"]);
check("公開範囲は4つ", VISIBILITIES, ["members", "close_friends", "followers", "public"]);

/* ---- フォローの状態遷移 ---- */
const S = ["none", "pending", "approved"];
const table = {
  follow:   { none: ["approved", "pending"], pending: ["pending", "pending"], approved: ["approved", "approved"] }, // [通常の相手, 承認制の相手]
  unfollow: { none: "none", pending: "none", approved: "none" },
  approve:  { none: null, pending: "approved", approved: "approved" },
  decline:  { none: "none", pending: "none", approved: null },
  remove:   { none: "none", pending: null, approved: "none" },
};
for (const s of S) {
  check("follow（通常）：" + s, nextFollowStatus(s, "follow", { targetPrivate: false }), table.follow[s][0]);
  check("follow（承認制）：" + s, nextFollowStatus(s, "follow", { targetPrivate: true }), table.follow[s][1]);
  for (const a of ["unfollow", "approve", "decline", "remove"]) check(a + "：" + s, nextFollowStatus(s, a), table[a][s]);
}
check("知らない操作・知らない状態", [nextFollowStatus("approved", "block"), nextFollowStatus("weird", "follow", { targetPrivate: true }), nextFollowStatus(undefined, "follow")], [null, "pending", "approved"]);
check("followStateLabel", ["none", "pending", "approved", undefined].map(followStateLabel), ["none", "requested", "following", "none"]);

/* ---- 入力・ID ---- */
check("validAvatarId", [
  validAvatarId(""), validAvatarId("photo_" + "a".repeat(32) + ".jpg"), validAvatarId("photo_" + "a".repeat(32) + ".webp"),
  validAvatarId("photo_" + "a".repeat(32) + ".mp4"), validAvatarId("../x"), validAvatarId("photo_zz.jpg"), validAvatarId("photo_" + "a".repeat(32) + ".jpg/../x"),
], [true, true, true, false, false, false, false]);
const pid = newPublicId();
check("公開用IDの形・毎回違う・trip.idとは別物", [validPublicId(pid), pid === newPublicId(), validPublicId("trip_" + "a".repeat(32)), validPublicId(undefined)], [true, false, false, false]);

/* ---- 許可リスト：入力にどんな項目が増えても、決めたものしか出ない ---- */
{
  const trip = { id: "trip_REAL", title: "沖縄", startDate: "2026-10-01", endDate: "2026-10-02", companions: ["ゲストA"], tripType: "家族", coverPhotoId: "photo_cover.jpg", settleUnit: 10, ownerAccountId: "111111", createdAt: "x", updatedAt: "y", futureColumn: "SECRET" };
  const blocks = [
    { id: "blk_1", tripId: "trip_REAL", date: "2026-10-01", time: "10:00", label: "首里城", category: "sightseeing", transport: "walk", moveMinutes: 5, manualOrder: 2, tzOverride: "Asia/Tokyo", branchId: "", futureColumn: "SECRET",
      entries: [{ id: "ent_1", blockId: "blk_1", episode: "良かった", comment: "c", detail: "d", photoIds: ["p1"], videoIds: ["v1"], costItems: [{ amount: 100 }], waitTime: "10分", time: "10:05", mapUrl: "https://maps.example/1", shopUrl: "", otherUrl: "", author: "ゲストA",
        travel: { from: "A", to: "B", company: "JR", depart: "10:00", arrive: "10:30", amount: 1200, arriveMapUrl: "https://maps.example/2", arriveLat: 1, arriveLng: 2 },
        mapLat: 26.2, mapLng: 127.7, mapPlaceName: "首里城公園", createdAt: "x", updatedAt: "y",
        ratings: [{ id: "r1", raterEmail: "a@x", raterName: "A", score: 4, review: { menu: "m" } }, { id: "r2", raterEmail: "b@x", raterName: "B", score: 3.5 }] }] },
    { id: "blk_2", tripId: "trip_REAL", date: "2026-10-01", time: "12:00", label: "別行動", category: "other", branchId: "br_1", entries: [{ id: "ent_2", episode: "秘密" }] },
  ];
  const days = [{ date: "2026-10-01", place: "那覇", lat: 1, lon: 2, admin1: "沖縄県", country: "日本", weatherCode: 1, tempMax: 28, tempMin: 22, precipSum: 0, isForecast: false, fetchedAt: "t", voiceTranscript: "秘密", weatherManual: true }];
  const out = stripTripForPublic({ trip, blocks, days, publicId: "pub_X" });
  const s = JSON.stringify(out);
  check("許可リスト：本物のid類・秘密の項目は出ない", /trip_REAL|blk_|ent_|br_1|SECRET|ゲストA|a@x|b@x|秘密|costItems|settleUnit|"amount"|raterName|review|companions|author|111111|"lat"|"lon"|tzOverride|"id"/.test(s), false);
  check("許可リスト：trip", out.trip, { publicId: "pub_X", title: "沖縄", startDate: "2026-10-01", endDate: "2026-10-02", tripType: "家族", coverPhotoId: "photo_cover.jpg" });
  check("許可リスト：別行動の予定は出ない（みんなの予定だけ）", out.blocks.map((b) => b.label), ["首里城"]);
  const e = out.blocks[0].entries[0];
  check("許可リスト：記録の中身", [e.episode, e.photoIds, e.videoIds, e.mapUrl, e.waitTime, e.mapLat, e.mapPlaceName, e.ratingAvg, e.ratingCount], ["良かった", ["p1"], ["v1"], "https://maps.example/1", "10分", 26.2, "首里城公園", 3.8, 2]);
  check("許可リスト：移動は金額を除いて残る", e.travel, { from: "A", to: "B", company: "JR", depart: "10:00", arrive: "10:30", arriveMapUrl: "https://maps.example/2", arriveLat: 1, arriveLng: 2 });
  check("許可リスト：日ごと", out.days, [{ date: "2026-10-01", place: "那覇", admin1: "沖縄県", country: "日本", weatherCode: 1, tempMax: 28, tempMin: 22, precipSum: 0, isForecast: false }]);
  check("許可リスト：表示用の通し番号", out.blocks.map((b) => b.n), [0]);
  const empty = stripTripForPublic({ trip, blocks: [{ date: "d", label: "x", entries: [{ ratings: [] }] }], days: [], publicId: "p" });
  check("評価が無い記録の平均はnull", [empty.blocks[0].entries[0].ratingAvg, empty.blocks[0].entries[0].ratingCount], [null, 0]);
}

/* ---- クライアント（app.jsのCore）との総当たり照合：判定表・状態遷移が食い違わない ---- */
{
  const { createRequire } = await import("node:module");
  globalThis.window = {};
  createRequire(import.meta.url)("../../app.js");
  const T = globalThis.window.TabiLog;
  let diffs = 0, n = 0;
  const flags = ["isOwner", "isFollower", "isCloseFriend", "blockedByOwner", "blockedByViewer"];
  for (const v of [...VISIBILITIES, "junk", undefined]) {
    for (let mask = 0; mask < 32; mask++) {
      const o = { visibility: v };
      flags.forEach((k, i) => { o[k] = !!(mask & (1 << i)); });
      n++;
      if (canViewByVisibility(o) !== T.canViewByVisibility(o)) diffs++;
    }
  }
  check("判定表：サーバーとCoreが全" + n + "通りで一致", diffs, 0);
  let sdiffs = 0;
  for (const s of ["none", "pending", "approved", "junk", undefined]) {
    for (const a of ["follow", "unfollow", "approve", "decline", "remove", "block"]) {
      for (const priv of [true, false]) if (nextFollowStatus(s, a, { targetPrivate: priv }) !== T.nextFollowStatus(s, a, { targetPrivate: priv })) sdiffs++;
    }
  }
  check("フォローの状態遷移：サーバーとCoreが一致", sdiffs, 0);
  check("公開範囲の一覧：サーバーとCoreが一致", T.VISIBILITY_OPTIONS.map((o) => o.key), VISIBILITIES);
  check("ひとことの上限：サーバーとCoreが一致", T.BIO_MAX, BIO_MAX);
}

console.log("visibility: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
