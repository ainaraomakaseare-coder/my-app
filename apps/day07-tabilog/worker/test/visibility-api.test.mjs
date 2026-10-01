/*
 * 旅行の公開範囲・プロフィール・フォローのAPIを、node:sqlite（Node 22.5+）で作った本物のSQLiteの上で通しで確かめるテスト
 * （docs/adr/0010）。D1の代わりに、prepare/bind/first/all/run/batchだけ真似た薄い入れ物を使う。
 * 確かめること：持ち主だけが公開範囲を変えられる／持ち主になれるのは最初に参加した人だけ／公開の画面は見る人との関係
 * （全体・フォロワー・親しい友人・一緒に行った人だけ）で出し分ける／費用・名前・メール・本物のtrip.id・予定と記録のid・
 * 別行動の予定が一切漏れない／フォローの申請・承認・断る・外す／親しい友人はフォロワーの中から／ブロックの効き方／
 * プロフィールの入力チェックと通報／アカウント削除の後始末／マイグレーション前（テーブル・列なし）でも壊れない。
 * 実行: node worker/test/visibility-api.test.mjs
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";

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
CREATE TABLE entries (id TEXT PRIMARY KEY, block_id TEXT NOT NULL, episode TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', photo_ids TEXT NOT NULL DEFAULT '[]', video_ids TEXT NOT NULL DEFAULT '[]', cost_items TEXT NOT NULL DEFAULT '[]', wait_time TEXT NOT NULL DEFAULT '', map_url TEXT NOT NULL DEFAULT '', map_place_name TEXT NOT NULL DEFAULT '', shop_url TEXT NOT NULL DEFAULT '', other_url TEXT NOT NULL DEFAULT '', time TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', travel TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE ratings (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, rater_email TEXT NOT NULL, rater_name TEXT NOT NULL DEFAULT '', score REAL, review TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT '');
CREATE TABLE day_infos (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, date TEXT NOT NULL, place TEXT NOT NULL DEFAULT '', lat REAL, lon REAL, weather_code INTEGER, temp_max REAL, temp_min REAL, precip_sum REAL, is_forecast INTEGER NOT NULL DEFAULT 0, fetched_at TEXT NOT NULL DEFAULT '', voice_transcript TEXT NOT NULL DEFAULT '', weather_manual INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '');
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

// ---------- マイグレーション前（列・テーブルなし）でも壊れない ----------
{
  let x = await call("GET", "/trips/trip_secret1");
  check("[前] 旅行は開ける。持ち主なし・一緒に行った人だけ・未公開", [x.status, x.data.trip.ownerAccountId, x.data.trip.visibility, x.data.trip.publicId, x.data.owner], [200, "", "members", "", null]);
  x = await call("POST", "/trips", "alice", { title: "新しい旅" });
  check("[前] ログイン中でも旅行は作れる（持ち主は書けないだけ）", [x.status, x.data.ownerAccountId], [201, ""]);
  x = await call("PUT", "/trips/trip_secret1/visibility", "alice", { visibility: "public" });
  check("[前] 公開範囲の変更は503（わかるエラー）", [x.status, x.data.error], [503, "visibility_not_ready"]);
  x = await call("POST", "/trips/trip_secret1/claim-owner", "alice");
  check("[前] 持ち主になるも503", [x.status, x.data.error], [503, "visibility_not_ready"]);
  x = await call("GET", "/public/trips/pub_" + "0".repeat(32));
  check("[前] 公開の画面は404", [x.status, x.data.error], [404, "not_found"]);
  x = await call("GET", "/profiles/me", "alice");
  check("[前] 自分のプロフィールは読める（フォローなし・旅行なし）", [x.status, x.data.profile.name, x.data.profile.followerCount, x.data.profile.followingCount, x.data.trips], [200, "アリス", 0, 0, []]);
  x = await call("PUT", "/follows/222222", "alice");
  check("[前] フォローは503", [x.status, x.data.error], [503, "social_not_ready"]);
  x = await call("PATCH", "/me/profile", "alice", { bio: "こんにちは" });
  check("[前] ひとことの保存は503", [x.status, x.data.error], [503, "profile_not_ready"]);
  x = await call("PATCH", "/me/profile", "alice", { name: "アリス2" });
  check("[前] 名前だけなら直せる", [x.status, x.data.profile.name], [200, "アリス2"]);
  await call("PATCH", "/me/profile", "alice", { name: "アリス" });
  x = await call("GET", "/me/connections?kind=followers", "alice");
  check("[前] フォロワー一覧は空", [x.status, x.data.items], [200, []]);
  x = await call("PUT", "/user-blocks", "carol", { accountId: id("dave") });
  check("[前] ブロックはできる（フォロー・親しい友人のテーブルが無くても）", x.status, 200);
  await call("DELETE", "/user-blocks", "carol", { accountId: id("dave") });
}

for (const f of ["0034_trip_owner_visibility.sql", "0035_profiles_follows.sql"]) sqlite.exec(sqlOf(f));
{
  // 同じマイグレーションを2回流すと重複列エラー（害はない）。CREATEは何度でも通る
  let dup = "";
  try { sqlite.exec(sqlOf("0034_trip_owner_visibility.sql")); } catch (e) { dup = String(e.message); }
  check("0034を2回流すと重複列エラー（害はない）", /duplicate column/i.test(dup), true);
}

// ---------- 持ち主 ----------
{
  let x = await call("POST", "/trips", "alice", { title: "アリスの旅" });
  check("ログインして作った旅行は、作った人が持ち主・初期は一緒に行った人だけ", [x.status, x.data.ownerAccountId, x.data.visibility, x.data.publicId], [201, id("alice"), "members", ""]);
  const ownTrip = x.data.id;
  x = await call("POST", "/trips", null, { title: "ログインなしの旅" });
  check("ログインなしで作った旅行は持ち主なし", [x.status, x.data.ownerAccountId], [201, ""]);
  x = await call("GET", "/trips/trip_secret1");
  check("今ある旅行はすべて一緒に行った人だけ・持ち主なし", [x.data.trip.visibility, x.data.trip.ownerAccountId, x.data.trip.publicId], ["members", "", ""]);

  x = await call("POST", "/trips/trip_secret1/claim-owner", "bob");
  check("最初に参加したのではない人は持ち主になれない", [x.status, x.data.error], [403, "not_first_member"]);
  x = await call("POST", "/trips/trip_secret1/claim-owner", "carol");
  check("参加していない人は持ち主になれない", [x.status, x.data.error], [403, "not_first_member"]);
  x = await call("POST", "/trips/trip_secret1/claim-owner", null);
  check("ログインなしは401", [x.status, x.data.error], [401, "login_required"]);
  x = await call("PUT", "/trips/trip_secret1/visibility", "alice", { visibility: "public" });
  check("持ち主がいない間は公開範囲を変えられない", [x.status, x.data.error], [403, "no_owner"]);
  x = await call("POST", "/trips/trip_secret1/claim-owner", "alice");
  check("最初に参加したアリスは持ち主になれる", [x.status, x.data.ownerAccountId], [200, id("alice")]);
  x = await call("POST", "/trips/trip_secret1/claim-owner", "alice");
  check("持ち主がもう一度押しても同じ（冪等）", [x.status, x.data.ownerAccountId], [200, id("alice")]);
  x = await call("POST", "/trips/trip_secret1/claim-owner", "bob");
  check("持ち主がいる旅行には、ほかの人は持ち主になれない", [x.status, x.data.error], [409, "already_owned"]);
  x = await call("GET", "/trips/trip_secret1");
  check("旅行の取得に持ち主の表示名が付く（メールは無い）", [x.data.trip.ownerAccountId, x.data.owner.name, "email" in x.data.owner], [id("alice"), "アリス", false]);

  // 公開範囲を変えられるのは持ち主だけ
  x = await call("PUT", "/trips/trip_secret1/visibility", "bob", { visibility: "public" });
  check("持ち主でない人は公開範囲を変えられない", [x.status, x.data.error], [403, "forbidden"]);
  x = await call("PUT", "/trips/trip_secret1/visibility", null, { visibility: "public" });
  check("ログインなしは公開範囲を変えられない", x.status, 401);
  x = await call("PUT", "/trips/trip_secret1/visibility", "alice", { visibility: "everyone" });
  check("知らない公開範囲は400", x.status, 400);
  x = await call("PUT", "/trips/trip_secret1/visibility", "alice", { visibility: "followers" });
  const publicId = x.data.publicId;
  check("初めて公開すると公開用IDができる", [x.status, x.data.visibility, /^pub_[0-9a-f]{32}$/.test(publicId)], [200, "followers", true]);
  x = await call("PUT", "/trips/trip_secret1/visibility", "alice", { visibility: "members" });
  check("一緒に行った人だけに戻すと、公開用IDは返さない", [x.data.visibility, x.data.publicId], ["members", ""]);
  x = await call("GET", "/trips/trip_secret1");
  check("一緒に行った人だけの旅行の取得に公開用IDは出ない", x.data.trip.publicId, "");
  x = await call("PUT", "/trips/trip_secret1/visibility", "alice", { visibility: "public" });
  check("再公開しても同じ公開用ID（同じリンクに戻る）", x.data.publicId, publicId);
  check("旅行の取得は編集用のidを持つ人にだけ公開用IDを出す", (await call("GET", "/trips/trip_secret1")).data.trip.publicId, publicId);
  x = await call("PUT", "/trips/" + ownTrip + "/visibility", "bob", { visibility: "public" });
  check("他人の旅行は変えられない", x.status, 403);
  globalThis.__publicId = publicId;
}
const PID = globalThis.__publicId;

// ---------- 公開の画面：出してよいものだけ・漏れない ----------
{
  let x = await call("GET", "/public/trips/" + PID);
  check("全体向けはログインなしで見られる", x.status, 200);
  const body = JSON.stringify(x.data);
  check("本物のtrip.idは出ない", body.includes("trip_secret1"), false);
  check("block・entry・rating・day_infoのidは出ない", /blk_|ent_|rt_secret|di_secret|br_secret/.test(body), false);
  check("ゲスト参加者の名前・記録した人は出ない", body.includes("ゲスト太郎"), false);
  check("メールアドレスは出ない", /@example\.com/.test(body), false);
  check("費用・精算・移動の金額は出ない", /入場料|40000|777|costItems|settleUnit|amount|payer/.test(body), false);
  check("評価のレビュー本文・評価した人の名前は出ない", /秘密のレビュー|raterName|raterEmail|review/.test(body), false);
  check("音声の文字起こし・座標は出ない", /音声の文字起こし本文|"lat"|"lon"|voiceTranscript/.test(body), false);
  check("別行動の予定・記録（自分だけの道）は出ない", /ひとりだけの寄り道|別行動の秘密のメモ|branch/.test(body), false);
  check("メンバー一覧・companionsは出ない", /"members"|companions|"author"/.test(body), false);
  check("予定・記録・写真・評価の平均は出る", [x.data.blocks.length, x.data.blocks[0].label, x.data.blocks[0].entries[0].episode, x.data.blocks[0].entries[0].photoIds.length, x.data.blocks[0].entries[0].ratingAvg, x.data.blocks[0].entries[0].ratingCount, x.data.blocks[0].entries[0].travel],
    [1, "首里城", "朝いちで行った", 1, 4.5, 2, { from: "那覇", to: "首里" }]);
  check("持ち主の名前と、見る人の関係が付く", [x.data.owner.accountId, x.data.owner.name, x.data.viewer.isOwner, x.data.trip.publicId, x.data.trip.visibility, x.data.relation.state], [id("alice"), "アリス", false, PID, "public", "none"]);
  check("日ごとの天気・場所は出る", [x.data.days[0].place, x.data.days[0].weatherCode], ["那覇", 1]);

  x = await call("GET", "/public/trips/pub_" + "f".repeat(32));
  check("存在しない公開用IDは404", x.status, 404);
  x = await call("GET", "/public/trips/trip_secret1");
  check("trip.idを公開用IDとしては使えない（編集用idでは公開の画面を開けない）", x.status, 404);
  x = await call("GET", "/public/trips/x");
  check("形が違うIDは404", x.status, 404);
}

// ---------- 見る人との関係ごとの出し分け ----------
{
  const set = (v) => call("PUT", "/trips/trip_secret1/visibility", "alice", { visibility: v });
  const view = async (who) => { const r = await call("GET", "/public/trips/" + PID, who); return [r.status, r.data && r.data.error]; };
  await set("followers");
  check("[フォロワー向け] ログインなしは401", await view(null), [401, "login_required"]);
  check("[フォロワー向け] フォロワーでない人は403", await view("carol"), [403, "not_allowed"]);
  let x = await call("GET", "/public/trips/" + PID, "carol");
  check("[フォロワー向け] 403には持ち主の名前だけ付く（旅行の中身・タイトルは無い）", [x.data.owner.name, x.data.visibility, x.data.relation.state, x.data.trip, x.data.blocks, JSON.stringify(x.data).includes("沖縄")], ["アリス", "followers", "none", undefined, undefined, false]);
  check("[フォロワー向け] 持ち主は見られる（確認用）", await view("alice"), [200, undefined]);
  x = await call("PUT", "/follows/" + id("alice"), "bob");
  check("承認制でないアカウントは、フォローするとすぐフォロー中", [x.status, x.data.state], [200, "following"]);
  check("[フォロワー向け] フォロワーは見られる", await view("bob"), [200, undefined]);
  await set("close_friends");
  check("[親しい友人向け] フォロワーだけでは見られない", await view("bob"), [403, "not_allowed"]);
  x = await call("PUT", "/me/close-friends/" + id("bob"), "alice");
  check("[親しい友人] フォロワーの中から入れられる", [x.status, x.data.closeFriend], [200, true]);
  check("[親しい友人向け] 親しい友人は見られる", await view("bob"), [200, undefined]);
  check("[親しい友人向け] ほかの人は見られない", await view("carol"), [403, "not_allowed"]);
  await set("followers");
  check("[フォロワー向け] 親しい友人はフォロワーでもあるので見られる", await view("bob"), [200, undefined]);
  await set("members");
  check("[一緒に行った人だけ] 公開の画面では誰にも見せない（持ち主・フォロワー・ログインなし）", [await view("alice"), await view("bob"), await view(null)], [[404, "not_found"], [404, "not_found"], [404, "not_found"]]);
  await set("public");
  check("[全体向け] 戻すとまた見られる", await view(null), [200, undefined]);
}

// ---------- フォロー（承認制）の流れ ----------
{
  let x = await call("PATCH", "/me/profile", "alice", { isPrivate: true });
  check("承認制にする", [x.status, x.data.profile.isPrivate], [200, true]);
  x = await call("PUT", "/follows/" + id("alice"), "carol");
  check("承認制の相手には、申請になる", [x.status, x.data.state], [200, "requested"]);
  x = await call("PUT", "/follows/" + id("alice"), "carol");
  check("申請の繰り返しは同じ状態のまま", x.data.state, "requested");
  x = await call("GET", "/me/connections?kind=requests", "alice");
  check("申請の一覧に出る", x.data.items.map((i) => i.accountId), [id("carol")]);
  x = await call("GET", "/profiles/" + id("alice"), "alice");
  check("自分のプロフィールに承認待ちの件数が出る", [x.data.pendingRequestCount, x.data.profile.followerCount, x.data.profile.followingCount], [1, 1, 0]);
  x = await call("GET", "/profiles/" + id("alice"), "carol");
  check("申請中の人から見たプロフィール", [x.data.relation.state, x.data.profile.followerCount], ["requested", 1]);
  x = await call("POST", "/me/follow-requests/" + id("carol") + "/approve", "bob");
  check("他の人は承認できない（その人あての申請ではない）", x.status, 404);
  x = await call("POST", "/me/follow-requests/" + id("carol") + "/approve", null);
  check("ログインなしは承認できない", x.status, 401);
  x = await call("POST", "/me/follow-requests/" + id("carol") + "/approve", "alice");
  check("承認するとフォロワーになる", [x.status, x.data.state], [200, "approved"]);
  x = await call("GET", "/profiles/" + id("alice"), "carol");
  check("承認されたあとの関係", [x.data.relation.state, x.data.profile.followerCount], ["following", 2]);
  x = await call("GET", "/me/connections?kind=followers", "alice");
  check("フォロワーの一覧（親しい友人の印つき）", x.data.items.map((i) => [i.accountId, i.closeFriend]).sort(), [[id("bob"), true], [id("carol"), false]]);
  x = await call("GET", "/me/connections?kind=following", "carol");
  check("フォロー中の一覧", x.data.items.map((i) => i.name), ["アリス"]);
  x = await call("POST", "/me/follow-requests/" + id("carol") + "/decline", "alice");
  check("承認したあとの「断る」はできない（外すを使う）", [x.status, x.data.error], [409, "invalid_transition"]);

  x = await call("PUT", "/follows/" + id("alice"), "dave");
  x = await call("POST", "/me/follow-requests/" + id("dave") + "/decline", "alice");
  check("断ると申請が消える", [x.status, x.data.state], [200, "none"]);
  x = await call("GET", "/profiles/" + id("alice"), "dave");
  check("断られた人の関係は「なし」に戻る", x.data.relation.state, "none");
  x = await call("PUT", "/follows/" + id("alice"), "dave");
  x = await call("DELETE", "/follows/" + id("alice"), "dave");
  check("申請の取り消し", [x.status, x.data.state], [200, "none"]);
  x = await call("DELETE", "/follows/" + id("alice"), "dave");
  check("何もしていなくても取り消しは失敗しない", [x.status, x.data.state], [200, "none"]);
  x = await call("POST", "/me/follow-requests/" + id("dave") + "/approve", "alice");
  check("申請が無い人は承認できない", x.status, 404);

  x = await call("PUT", "/me/close-friends/" + id("dave"), "alice");
  check("フォロワーでない人は親しい友人に入れられない", [x.status, x.data.error], [409, "not_a_follower"]);
  x = await call("PUT", "/me/close-friends/" + id("alice"), "alice");
  check("自分は親しい友人に入れられない", x.status, 400);
  x = await call("DELETE", "/me/followers/" + id("bob"), "alice");
  check("フォロワーから外す", [x.status, x.data.state], [200, "none"]);
  x = await call("GET", "/me/connections?kind=close_friends", "alice");
  check("フォロワーから外すと、親しい友人の印も消える", x.data.items, []);
  x = await call("PUT", "/follows/" + id("alice"), "bob");
  check("外された人は承認制のアカウントを、申請から始め直す", x.data.state, "requested");

  // 承認制をやめると、承認待ちは自動でフォローになる
  x = await call("PATCH", "/me/profile", "alice", { isPrivate: false });
  x = await call("GET", "/profiles/" + id("alice"), "bob");
  check("承認制をやめると承認待ちの申請は自動でフォローになる", x.data.relation.state, "following");
  x = await call("PUT", "/follows/" + id("alice"), "alice");
  check("自分はフォローできない", x.status, 400);
  x = await call("PUT", "/follows/999999", "bob");
  check("いないアカウントは404", x.status, 404);
  x = await call("DELETE", "/follows/" + id("alice"), "carol");
  check("フォローをやめる", x.data.state, "none");
}

// ---------- プロフィール・旅行の一覧 ----------
{
  let x = await call("GET", "/profiles/" + id("alice"));
  check("プロフィールはログインなしだと401", x.status, 401);
  x = await call("GET", "/profiles/abc", "bob");
  check("形が違うIDは404", x.status, 404);
  // aliceの旅行：trip_secret1（全体）、ownTrip（一緒に行った人だけ）に加えて followers 向け・親しい友人向けを作る
  const mk = async (title, vis) => {
    const t = (await call("POST", "/trips", "alice", { title })).data;
    if (vis !== "members") await call("PUT", "/trips/" + t.id + "/visibility", "alice", { visibility: vis });
    return t;
  };
  await mk("フォロワー旅", "followers");
  await mk("親しい友人旅", "close_friends");
  x = await call("GET", "/profiles/" + id("alice"), "alice");
  check("自分のプロフィールには全部の旅行が公開範囲つきで並ぶ（編集用idつき）",
    [x.data.trips.some((t) => t.id === "trip_secret1"), x.data.trips.map((t) => t.visibility).sort()],
    [true, ["close_friends", "followers", "members", "public"]]);
  x = await call("GET", "/profiles/" + id("alice"), "dave");
  check("フォローしていない人には全体向けの旅行だけ。編集用idは出ない", [x.data.trips.map((t) => t.title), x.data.trips.some((t) => "id" in t), JSON.stringify(x.data).includes("trip_secret1")], [["沖縄"], false, false]);
  await call("PUT", "/follows/" + id("alice"), "carol");
  x = await call("GET", "/profiles/" + id("alice"), "carol");
  check("フォロワーには全体向け＋フォロワー向け", x.data.trips.map((t) => t.title).sort(), ["フォロワー旅", "沖縄"]);
  await call("PUT", "/me/close-friends/" + id("carol"), "alice");
  x = await call("GET", "/profiles/" + id("alice"), "carol");
  check("親しい友人には全部（一緒に行った人だけの旅行を除く）", x.data.trips.map((t) => t.title).sort(), ["フォロワー旅", "沖縄", "親しい友人旅"]);
  check("一緒に行った人だけの旅行は誰の一覧にも出ない（公開用IDも無い）", x.data.trips.some((t) => t.title === "アリスの旅"), false);

  // 承認制のアカウントの旅行一覧は、承認されたフォロワーにだけ
  await call("PATCH", "/me/profile", "alice", { isPrivate: true });
  x = await call("GET", "/profiles/" + id("alice"), "dave");
  check("承認制のアカウントは、フォロワーでない人に旅行の一覧を見せない", [x.data.tripsHidden, x.data.trips, x.data.profile.isPrivate], [true, [], true]);
  x = await call("GET", "/profiles/" + id("alice"), "carol");
  check("承認制でも、承認されたフォロワーには見える", [x.data.tripsHidden, x.data.trips.length], [false, 3]);
  x = await call("GET", "/public/trips/" + PID, "dave");
  check("承認制でも、全体向けの旅行を直接のリンクで開くことはできる", x.status, 200);
  await call("PATCH", "/me/profile", "alice", { isPrivate: false });

  // 入力チェック
  x = await call("PATCH", "/me/profile", "alice", { bio: "旅が好きです" });
  check("ひとことを保存", [x.status, x.data.profile.bio], [200, "旅が好きです"]);
  x = await call("PATCH", "/me/profile", "alice", { bio: "あ".repeat(161) });
  check("ひとことは160字まで", [x.status, x.data.error], [400, "invalid_bio"]);
  x = await call("PATCH", "/me/profile", "alice", { bio: "お前はしね" });
  check("ひとこと・名前の暴言は保存しない", [x.status, x.data.error], [422, "inappropriate"]);
  x = await call("PATCH", "/me/profile", "alice", { name: "fuck you" });
  check("名前の暴言も保存しない", x.status, 422);
  x = await call("PATCH", "/me/profile", "alice", { name: "  " });
  check("名前は空にできない", [x.status, x.data.error], [400, "invalid_name"]);
  x = await call("PATCH", "/me/profile", "alice", { avatarPhotoId: "../secret" });
  check("アイコンは写真のID以外を受け付けない", [x.status, x.data.error], [400, "invalid_avatar"]);
  const avatar = "photo_" + "b".repeat(32) + ".jpg";
  x = await call("PATCH", "/me/profile", "alice", { avatarPhotoId: avatar });
  check("アイコンの写真IDを保存", [x.status, x.data.profile.avatarPhotoId], [200, avatar]);
  x = await call("PATCH", "/me/profile", "alice", { isPrivate: "yes" });
  check("承認制の値は真偽だけ", x.status, 400);
  x = await call("PATCH", "/me/profile", null, { bio: "x" });
  check("ログインなしはプロフィールを直せない", x.status, 401);
  x = await call("GET", "/profiles/" + id("alice"), "dave");
  check("他の人から見たプロフィールにメール・プランは出ない", [x.data.profile.avatarPhotoId, /email|plan|@/.test(JSON.stringify(x.data))], [avatar, false]);
  x = await call("GET", "/trips/trip_secret1");
  check("旅行の取得の持ち主カードに、プロフィールの名前が出る", x.data.owner.name, "アリス");

  // 通報
  x = await call("POST", "/profiles/" + id("alice") + "/report", "dave", { reason: "なりすまし" });
  check("プロフィールを通報できる", [x.status, x.data.ok], [200, true]);
  x = await call("POST", "/profiles/" + id("alice") + "/report", "dave", { reason: "なりすまし" });
  check("同じ通報の繰り返しも失敗しない", x.status, 200);
  check("通報が1件だけ記録される", sqlite.prepare("SELECT COUNT(*) AS n FROM profile_reports").get().n, 1);
  x = await call("POST", "/profiles/" + id("dave") + "/report", "dave");
  check("自分は通報できない", x.status, 404);
  x = await call("POST", "/profiles/" + id("alice") + "/report", null);
  check("ログインなしは通報できない", x.status, 401);
}

// ---------- ブロック ----------
{
  let x = await call("PUT", "/follows/" + id("alice"), "bob");
  await call("PUT", "/me/close-friends/" + id("bob"), "alice");
  await call("PUT", "/follows/" + id("bob"), "alice");
  check("ブロック前：お互いにフォローしている", (await call("GET", "/profiles/" + id("alice"), "bob")).data.relation.followsMe, true);
  x = await call("PUT", "/user-blocks", "alice", { accountId: id("bob") });
  check("ブロックできる", x.status, 200);
  check("ブロックするとお互いのフォロー・親しい友人が外れる",
    [sqlite.prepare("SELECT COUNT(*) AS n FROM follows WHERE (follower_id=? AND followee_id=?) OR (follower_id=? AND followee_id=?)").get(id("alice"), id("bob"), id("bob"), id("alice")).n,
      sqlite.prepare("SELECT COUNT(*) AS n FROM close_friends WHERE owner_account_id=? AND friend_account_id=?").get(id("alice"), id("bob")).n], [0, 0]);
  x = await call("GET", "/profiles/" + id("alice"), "bob");
  check("ブロックされた人にはプロフィールが見えない（404）", x.status, 404);
  x = await call("GET", "/profiles/" + id("bob"), "alice");
  check("ブロックした人には、相手のプロフィールが「ブロック中」の最小限で出る（解除できるように）", [x.status, x.data.blockedByMe, x.data.profile, x.data.trips], [200, true, { accountId: id("bob"), name: "ボブ" }, undefined]);
  x = await call("PUT", "/follows/" + id("alice"), "bob");
  check("ブロックされた人はフォローできない", x.status, 404);
  x = await call("PUT", "/follows/" + id("bob"), "alice");
  check("ブロックした人も相手をフォローできない", x.status, 404);
  x = await call("GET", "/me/connections?kind=followers", "alice");
  check("ブロックした人はフォロワーの一覧に出ない", x.data.items.some((i) => i.accountId === id("bob")), false);
  x = await call("GET", "/public/trips/" + PID, "bob");
  check("ブロックされた人も、全体向けの旅行は見られる（ログインなしでも見られるため）", x.status, 200);
  await call("PUT", "/trips/trip_secret1/visibility", "alice", { visibility: "followers" });
  x = await call("GET", "/public/trips/" + PID, "bob");
  check("ブロックされた人は、非公開（フォロワー向け）は見られない", x.status, 404);
  await call("PUT", "/trips/trip_secret1/visibility", "alice", { visibility: "public" });
  // 見る人が持ち主をブロックしているとき
  await call("PUT", "/user-blocks", "dave", { accountId: id("alice") });
  x = await call("GET", "/public/trips/" + PID, "dave");
  check("持ち主をブロックした人には、全体向けでも見せない", x.status, 404);
  x = await call("GET", "/profiles/" + id("alice"), "dave");
  check("持ち主をブロックした人には、持ち主のプロフィールは最小限（解除用）", x.data.blockedByMe, true);
  x = await call("DELETE", "/user-blocks", "dave", { accountId: id("alice") });
  x = await call("GET", "/public/trips/" + PID, "dave");
  check("ブロックを解除すると見られる", x.status, 200);
  await call("DELETE", "/user-blocks", "alice", { accountId: id("bob") });
  check("ブロック解除後、プロフィールがまた見える", (await call("GET", "/profiles/" + id("alice"), "bob")).status, 200);
}

// ---------- アカウント削除の後始末 ----------
{
  const t = (await call("POST", "/trips", "erin", { title: "エリンの旅" })).data;
  await call("PUT", "/trips/" + t.id + "/visibility", "erin", { visibility: "public" });
  await call("PUT", "/follows/" + id("erin"), "bob");
  await call("PUT", "/follows/" + id("bob"), "erin");
  await call("PATCH", "/me/profile", "erin", { bio: "消えるひとこと", avatarPhotoId: "photo_" + "d".repeat(32) + ".png" });
  const pid = (await call("GET", "/trips/" + t.id)).data.trip.publicId;
  let x = await call("POST", "/accounts/delete", "erin", { email: "erin@example.com" });
  check("アカウントを削除できる", x.status, 200);
  check("削除したアカウントのフォロー・親しい友人は消える", sqlite.prepare("SELECT COUNT(*) AS n FROM follows WHERE follower_id=? OR followee_id=?").get(id("erin"), id("erin")).n, 0);
  check("削除したアカウントのひとこと・アイコンは消える", { ...sqlite.prepare("SELECT bio, avatar_photo_id FROM accounts WHERE account_id=?").get(id("erin")) }, { bio: "", avatar_photo_id: "" });
  x = await call("GET", "/trips/" + t.id);
  check("旅行は残り、持ち主なし・一緒に行った人だけに戻る", [x.status, x.data.trip.ownerAccountId, x.data.trip.visibility], [200, "", "members"]);
  x = await call("GET", "/public/trips/" + pid);
  check("削除した人の旅行の公開の画面は見られなくなる", x.status, 404);
}

console.log("visibility-api: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
