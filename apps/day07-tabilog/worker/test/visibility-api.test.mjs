/*
 * 見るだけの公開リンクのAPIを、node:sqlite（Node 22.5+）で作った本物のSQLiteの上で通しで確かめるテスト（docs/adr/0010 の2026-10-01の節）。
 * D1の代わりに、prepare/bind/first/all/run/batchだけ真似た薄い入れ物を使う。SNSのテーブル（0035）は作らない。
 * 確かめること：アカウント参加者なら誰でも入り切りできる（ゲスト・未参加・ログインなしは不可）／親しい友人・フォロワー向けは400／
 * 公開の画面はログイン不要で、費用・名前・メール・本物のtrip.id・予定と記録のid・別行動の予定が一切漏れない／
 * SNS系ルートは410／マイグレーション前・SNSのテーブルなしでも壊れない／アカウント削除の後始末。
 * 実行: node worker/test/visibility-api.test.mjs
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { MAP_COORDS_VALID_SINCE } from "../src/geo-decode.js";

let pass = 0, fail = 0;
function check(label, got, want) {
  try { assert.deepEqual(got, want); pass++; } catch {
    fail++;
    console.log("NG  " + label);
    console.log("    got  " + JSON.stringify(got));
    console.log("    want " + JSON.stringify(want));
  }
}

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`
CREATE TABLE trips (id TEXT PRIMARY KEY, title TEXT NOT NULL, start_date TEXT NOT NULL DEFAULT '', end_date TEXT NOT NULL DEFAULT '', companions TEXT NOT NULL DEFAULT '[]', cover_photo_id TEXT NOT NULL DEFAULT '', trip_type TEXT NOT NULL DEFAULT '', settle_unit INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE blocks (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, date TEXT NOT NULL DEFAULT '', time TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'sightseeing', transport TEXT NOT NULL DEFAULT '', move_minutes INTEGER NOT NULL DEFAULT 0, manual_order INTEGER, tz_override TEXT, branch_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE entries (id TEXT PRIMARY KEY, block_id TEXT NOT NULL, map_lat REAL, map_lng REAL, map_admin1 TEXT, map_country TEXT, map_geocoded_at TEXT, map_geocoded_url TEXT, episode TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', photo_ids TEXT NOT NULL DEFAULT '[]', video_ids TEXT NOT NULL DEFAULT '[]', cost_items TEXT NOT NULL DEFAULT '[]', wait_time TEXT NOT NULL DEFAULT '', map_url TEXT NOT NULL DEFAULT '', map_place_name TEXT NOT NULL DEFAULT '', shop_url TEXT NOT NULL DEFAULT '', other_url TEXT NOT NULL DEFAULT '', time TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', travel TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE ratings (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, rater_email TEXT NOT NULL, rater_name TEXT NOT NULL DEFAULT '', score REAL, review TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT '');
CREATE TABLE day_infos (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, date TEXT NOT NULL, place TEXT NOT NULL DEFAULT '', admin1 TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', lat REAL, lon REAL, weather_code INTEGER, temp_max REAL, temp_min REAL, precip_sum REAL, is_forecast INTEGER NOT NULL DEFAULT 0, fetched_at TEXT NOT NULL DEFAULT '', voice_transcript TEXT NOT NULL DEFAULT '', weather_manual INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '');
CREATE TABLE accounts (email TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT 'free', ticket_credits INTEGER NOT NULL DEFAULT 0, plan_period_start TEXT NOT NULL DEFAULT '', voice_uses_this_period INTEGER NOT NULL DEFAULT 0, memo_uses_this_period INTEGER NOT NULL DEFAULT 0, stripe_customer_id TEXT NOT NULL DEFAULT '', stripe_subscription_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE trip_members (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, account_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', joined_at TEXT NOT NULL, UNIQUE(trip_id, account_id));
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE likes (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, account_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE comments (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, account_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE user_blocks (blocker_account_id TEXT NOT NULL, blocked_account_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (blocker_account_id, blocked_account_id));
CREATE TABLE auth_identities (provider TEXT NOT NULL, subject TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL, refresh_token TEXT NOT NULL DEFAULT '');
CREATE TABLE comment_reports (id TEXT PRIMARY KEY, comment_id TEXT NOT NULL, reporter_account_id TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
`);

const DB = {
  prepare(sql) {
    const st = sqlite.prepare(sql);
    let params = [];
    const o = {
      bind(...p) { params = p; return o; },
      async first() { return st.get(...params) || null; },
      async all() { return { results: st.all(...params) }; },
      async run() { st.run(...params); return { success: true }; },
    };
    return o;
  },
  async batch(stmts) {
    sqlite.exec("BEGIN");
    try { for (const s of stmts) await s.run(); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  },
};
const env = { DB, ALLOWED_ORIGIN: "https://app.example", REQUIRE_SESSION: "1" };

const now = new Date().toISOString();
const later = new Date(Date.now() + 86400000).toISOString();
const people = {
  alice: ["alice@example.com", "111111", "アリス"],
  bob: ["bob@example.com", "222222", "ボブ"],
  carol: ["carol@example.com", "333333", "キャロル"],
  dave: ["dave@example.com", "444444", "デイブ"],
  erin: ["erin@example.com", "555555", "エリン"],
};
const tokens = {};
for (const [k, [email, aid, name]] of Object.entries(people)) {
  tokens[k] = (k[0].repeat(64)).slice(0, 64).replace(/[^0-9a-f]/g, "a");
  sqlite.prepare("INSERT INTO accounts (email, account_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run(email, aid, name, now, now);
  sqlite.prepare("INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?,?,?,?)")
    .run(createHash("sha256").update(tokens[k]).digest("hex"), email, now, later);
}
const id = (k) => people[k][1];

// 旅行t1：今ある旅行（持ち主なし）。aliceが先に、そのあとbobが「参加する」を押した
sqlite.prepare("INSERT INTO trips (id, title, start_date, end_date, companions, cover_photo_id, created_at, updated_at) VALUES ('trip_secret1','沖縄','2026-10-01','2026-10-02',?,?,?,?)")
  .run(JSON.stringify(["ゲスト太郎"]), "photo_" + "c".repeat(32) + ".jpg", now, now);
sqlite.prepare("INSERT INTO trips (id, title, created_at, updated_at) VALUES ('trip_secret2','別の旅行',?,?)").run(now, now);
sqlite.prepare("INSERT INTO trip_members (id, trip_id, account_id, name, joined_at) VALUES ('m1','trip_secret1',?,?,?)").run(id("alice"), "アリス", "2026-09-01T00:00:00.000Z");
sqlite.prepare("INSERT INTO trip_members (id, trip_id, account_id, name, joined_at) VALUES ('m2','trip_secret1',?,?,?)").run(id("bob"), "ボブ", "2026-09-02T00:00:00.000Z");
sqlite.prepare("INSERT INTO blocks (id, trip_id, date, time, label, category, created_at, updated_at) VALUES ('blk_pub1','trip_secret1','2026-10-01','10:00','首里城','sightseeing',?,?)").run(now, now);
sqlite.prepare("INSERT INTO blocks (id, trip_id, date, time, label, category, branch_id, created_at, updated_at) VALUES ('blk_priv1','trip_secret1','2026-10-01','14:00','ひとりだけの寄り道','sightseeing','br_secret',?,?)").run(now, now);
sqlite.prepare("INSERT INTO entries (id, block_id, episode, comment, photo_ids, cost_items, author, travel, created_at, updated_at) VALUES ('ent_secret1','blk_pub1','朝いちで行った','最高',?,?,?,?,?,?)")
  .run(JSON.stringify(["photo_" + "a".repeat(32) + ".jpg"]), JSON.stringify([{ name: "入場料", amount: 40000, payer: "ゲスト太郎" }]), "ゲスト太郎", JSON.stringify({ from: "那覇", to: "首里", amount: 777 }), now, now);
sqlite.prepare("INSERT INTO entries (id, block_id, episode, created_at, updated_at) VALUES ('ent_secret2','blk_priv1','別行動の秘密のメモ',?,?)").run(now, now);
sqlite.prepare("INSERT INTO ratings (id, entry_id, rater_email, rater_name, score, review) VALUES ('rt_secret1','ent_secret1','alice@example.com','アリス',4,?)").run(JSON.stringify({ menu: "秘密のレビュー" }));
sqlite.prepare("INSERT INTO ratings (id, entry_id, rater_email, rater_name, score) VALUES ('rt_secret2','ent_secret1','bob@example.com','ボブ',5)").run();
sqlite.prepare("INSERT INTO day_infos (id, trip_id, date, place, lat, lon, weather_code, voice_transcript, updated_at) VALUES ('di_secret1','trip_secret1','2026-10-01','那覇',26.2,127.6,1,'音声の文字起こし本文',?)").run(now);

sqlite.prepare("UPDATE day_infos SET admin1 = '沖縄県', country = '日本' WHERE id = 'di_secret1'").run();
sqlite.prepare("INSERT INTO trips (id, title, start_date, end_date, created_at, updated_at) VALUES ('trip_swiss1','スイス周遊','2025-08-01','2025-08-05',?,?)").run(now, now);
sqlite.prepare("INSERT INTO trip_members (id, trip_id, account_id, name, joined_at) VALUES ('m3','trip_swiss1',?,?,?)").run(id("alice"), "アリス", "2026-09-03T00:00:00.000Z");
sqlite.prepare("INSERT INTO day_infos (id, trip_id, date, place, admin1, country, lat, lon, updated_at) VALUES ('di_swiss1','trip_swiss1','2025-08-02','ツェルマット','ヴァレー州','スイス',46.02,7.75,?)").run(now);
sqlite.prepare("INSERT INTO blocks (id, trip_id, date, time, label, category, created_at, updated_at) VALUES ('blk_swiss1','trip_swiss1','2025-08-02','10:00','マッターホルン','sightseeing',?,?)").run(now, now);
// 地域がまだ未解決の座標つきの記録（プロフィールの閲覧では、逆ジオコーディングをしない＝fetchを呼ばない）
sqlite.prepare("INSERT INTO entries (id, block_id, map_url, map_lat, map_lng, map_geocoded_at, map_geocoded_url, created_at, updated_at) VALUES ('ent_stale1','blk_swiss1','https://maps.example/x',46.0,7.7,?,'https://maps.example/x',?,?)").run(new Date(Math.max(Date.now(), Date.parse(MAP_COORDS_VALID_SINCE) + 1)).toISOString(), now, now);

async function call(method, path, who, body) {
  const headers = { origin: "https://app.example" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (who) headers.authorization = "Bearer " + tokens[who];
  const res = await worker.fetch(new Request("https://api.example" + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }), env, undefined);
  let data = null;
  try { data = await res.json(); } catch { /* 本文なし */ }
  return { status: res.status, data };
}
const sqlOf = (name) => readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8");

// ---------- マイグレーション前（trips に列なし）でも壊れない ----------
{
  let x = await call("GET", "/trips/trip_secret1");
  check("[前] 旅行は開ける。一緒に行った人だけ・未公開", [x.status, x.data.trip.visibility, x.data.trip.publicId], [200, "members", ""]);
  x = await call("POST", "/trips", "alice", { title: "新しい旅" });
  check("[前] ログイン中でも旅行は作れる", [x.status, x.data.visibility], [201, "members"]);
  x = await call("PUT", "/trips/trip_secret1/visibility", "alice", { visibility: "public" });
  check("[前] リンクの入り切りは503（わかるエラー）", [x.status, x.data.error], [503, "visibility_not_ready"]);
  x = await call("GET", "/public/trips/pub_" + "0".repeat(32));
  check("[前] 公開の画面は404", [x.status, x.data.error], [404, "not_found"]);
}

// 見るだけのリンクに要るのは 0034（trips の3列とindex）だけ。0035（SNSのテーブル）は流さない
sqlite.exec(sqlOf("0034_trip_owner_visibility.sql"));

// ---------- 入り切り：アカウント参加者なら誰でも ----------
let PID = "";
{
  let x = await call("POST", "/trips", "alice", { title: "アリスの旅" });
  check("初期値は一緒に行った人だけ・公開用IDなし", [x.status, x.data.visibility, x.data.publicId], [201, "members", ""]);
  x = await call("GET", "/trips/trip_secret1");
  check("今ある旅行はすべて一緒に行った人だけ", [x.data.trip.visibility, x.data.trip.publicId], ["members", ""]);

  x = await call("PUT", "/trips/trip_secret1/visibility", null, { visibility: "public" });
  check("ログインなしは401", [x.status, x.data.error], [401, "login_required"]);
  x = await call("PUT", "/trips/trip_secret1/visibility", "carol", { visibility: "public" });
  check("参加していないアカウントは403", [x.status, x.data.error], [403, "forbidden"]);
  x = await call("PUT", "/trips/trip_secret1/visibility", "alice", { visibility: "everyone" });
  check("知らない値は400", [x.status, x.data.error], [400, "invalid_input"]);
  for (const v of ["close_friends", "followers"]) {
    x = await call("PUT", "/trips/trip_secret1/visibility", "alice", { visibility: v });
    check("親しい友人・フォロワー向けは今は使えない（" + v + "）", [x.status, x.data.error], [400, "visibility_unavailable"]);
  }
  check("拒否された操作では何も変わらない", sqlite.prepare("SELECT visibility FROM trips WHERE id='trip_secret1'").get().visibility, "members");

  // bobは2番目に参加した人。「持ち主になる」なしで入れられ、最初に公開した人が owner_account_id に記録される
  x = await call("PUT", "/trips/trip_secret1/visibility", "bob", { visibility: "public" });
  PID = x.data.publicId;
  check("参加者（2番目に参加したbob）がオンにできる。公開用IDができる", [x.status, x.data.visibility, /^pub_[0-9a-f]{32}$/.test(PID)], [200, "public", true]);
  check("最初に公開した人が owner_account_id に記録される", sqlite.prepare("SELECT owner_account_id FROM trips WHERE id='trip_secret1'").get().owner_account_id, id("bob"));
  x = await call("PUT", "/trips/trip_secret1/visibility", "alice", { visibility: "members" });
  check("別の参加者（alice）がオフにできる", [x.status, x.data.visibility, x.data.publicId], [200, "members", ""]);
  check("オフにしても owner は変わらず、public_id は残る", { ...sqlite.prepare("SELECT owner_account_id, public_id FROM trips WHERE id='trip_secret1'").get() }, { owner_account_id: id("bob"), public_id: PID });
  x = await call("GET", "/public/trips/" + PID);
  check("オフのあいだ、リンクは見えない（404）", [x.status, x.data.error], [404, "not_found"]);
  x = await call("GET", "/trips/trip_secret1");
  check("オフの旅行の取得に公開用IDは出ない", x.data.trip.publicId, "");
  x = await call("PUT", "/trips/trip_secret1/visibility", "alice", { visibility: "public" });
  check("もう一度オンにすると同じリンクに戻る（ownerは変わらない）", [x.data.publicId, sqlite.prepare("SELECT owner_account_id FROM trips WHERE id='trip_secret1'").get().owner_account_id], [PID, id("bob")]);
  check("オンの旅行の取得（編集用）に公開用IDが出る", (await call("GET", "/trips/trip_secret1")).data.trip.publicId, PID);

  const own = (await call("POST", "/trips", "alice", { title: "アリスだけの旅" })).data;
  x = await call("PUT", "/trips/" + own.id + "/visibility", "bob", { visibility: "public" });
  check("参加していない旅行は、他人は入り切りできない", [x.status, x.data.error], [403, "forbidden"]);
  x = await call("PUT", "/trips/nope/visibility", "alice", { visibility: "public" });
  check("存在しない旅行の入り切りは404", x.status, 404);
}

// ---------- 公開の画面：出してよいものだけ・漏れない・ログイン不要 ----------
{
  let x = await call("GET", "/public/trips/" + PID);
  check("ログインなしで見られる", x.status, 200);
  const body = JSON.stringify(x.data);
  check("本物のtrip.idは出ない", body.includes("trip_secret1"), false);
  check("block・entry・rating・day_infoのidは出ない", /blk_|ent_|rt_secret|di_secret|br_secret/.test(body), false);
  check("ゲスト参加者の名前・記録した人は出ない", body.includes("ゲスト太郎"), false);
  check("アカウント参加者の名前（アリス・ボブ）・アカウントIDは出ない", /アリス|ボブ|111111|222222/.test(body), false);
  check("メールアドレスは出ない", /@example\.com/.test(body), false);
  check("費用・精算・移動の金額は出ない", /入場料|40000|777|costItems|settleUnit|amount|payer/.test(body), false);
  check("評価のレビュー本文・評価した人の名前は出ない", /秘密のレビュー|raterName|raterEmail|review/.test(body), false);
  check("音声の文字起こし・座標は出ない", /音声の文字起こし本文|"lat"|"lon"|voiceTranscript/.test(body), false);
  check("別行動の予定・記録（自分だけの道）は出ない", /ひとりだけの寄り道|別行動の秘密のメモ|branch/.test(body), false);
  check("メンバー一覧・companions・持ち主・見る人の情報は出ない", /"members"|companions|"author"|"owner"|"viewer"|"relation"|ownerAccountId/.test(body), false);
  check("予定・記録・写真・評価の平均は出る", [x.data.blocks.length, x.data.blocks[0].label, x.data.blocks[0].entries[0].episode, x.data.blocks[0].entries[0].photoIds.length, x.data.blocks[0].entries[0].ratingAvg, x.data.blocks[0].entries[0].ratingCount, x.data.blocks[0].entries[0].travel],
    [1, "首里城", "朝いちで行った", 1, 4.5, 2, { from: "那覇", to: "首里" }]);
  check("公開用IDと公開範囲が付く", [x.data.trip.publicId, x.data.trip.visibility], [PID, "public"]);
  check("日ごとの天気・場所は出る", [x.data.days[0].place, x.data.days[0].weatherCode], ["那覇", 1]);
  const withSession = await call("GET", "/public/trips/" + PID, "carol");
  check("ログインしていても同じ内容（見る人で出し分けない）", JSON.stringify(withSession.data), body);

  x = await call("GET", "/public/trips/pub_" + "f".repeat(32));
  check("存在しない公開用IDは404", x.status, 404);
  x = await call("GET", "/public/trips/trip_secret1");
  check("trip.idを公開用IDとしては使えない", x.status, 404);
  x = await call("GET", "/public/trips/x");
  check("形が違うIDは404", x.status, 404);
  check("公開の旅行の一覧・検索のAPIは無い", [(await call("GET", "/public/trips")).status === 200, (await call("GET", "/public/trips/")).status === 200], [false, false]);
}

// ---------- SNS系は止まっている（SOCIAL_ENABLED=false）。テーブルが無くても壊れない ----------
{
  const routes = [
    ["GET", "/profiles/me", "alice"], ["GET", "/profiles/222222", "alice"], ["POST", "/profiles/222222/report", "alice"],
    ["PATCH", "/me/profile", "alice"], ["GET", "/me/connections?kind=followers", "alice"],
    ["PUT", "/follows/222222", "alice"], ["DELETE", "/follows/222222", "alice"],
    ["POST", "/me/follow-requests/222222/approve", "alice"], ["DELETE", "/me/followers/222222", "alice"],
    ["PUT", "/me/close-friends/222222", "alice"], ["DELETE", "/me/close-friends/222222", "alice"],
    ["POST", "/trips/trip_secret1/claim-owner", "alice"],
  ];
  for (const [m, p, who] of routes) {
    const x = await call(m, p, who, m === "GET" || m === "DELETE" ? undefined : {});
    check("SNS系は410 feature_disabled：" + m + " " + p, [x.status, x.data && x.data.error], [410, "feature_disabled"]);
  }
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('follows','close_friends','profile_reports')").all();
  check("SNSのテーブル（0035）は作っていない", tables, []);
  const cols = sqlite.prepare("PRAGMA table_info(accounts)").all().map((c) => c.name);
  check("accountsにSNSの列（bio・is_private…）も無い", cols.filter((c) => /bio|avatar|private|visited|show_counts/.test(c)), []);
}

// ---------- アカウント削除（SNSのテーブルが無くても動く） ----------
{
  const t = (await call("POST", "/trips", "erin", { title: "エリンの旅" })).data;
  sqlite.prepare("INSERT OR IGNORE INTO trip_members (id, trip_id, account_id, name, joined_at) VALUES ('m9',?,?,?,?)").run(t.id, id("erin"), "エリン", now);
  let x = await call("PUT", "/trips/" + t.id + "/visibility", "erin", { visibility: "public" });
  const pid = x.data.publicId;
  check("erinがオンにできる", [x.status, !!pid], [200, true]);
  x = await call("POST", "/accounts/delete", "erin", { email: "erin@example.com" });
  check("アカウントを削除できる（SNSのテーブルが無くても）", x.status, 200);
  x = await call("GET", "/trips/" + t.id);
  check("旅行は残り、一緒に行った人だけに戻る", [x.status, x.data.trip.visibility], [200, "members"]);
  x = await call("GET", "/public/trips/" + pid);
  check("削除した人が公開した旅行のリンクは見られなくなる", x.status, 404);
}

console.log("visibility-api: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
