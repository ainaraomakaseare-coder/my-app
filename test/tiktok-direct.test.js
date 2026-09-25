'use strict';
/**
 * TikTok の直接投稿（video.publish）を、通信せずに確かめる。
 *
 * ★ 守りたいのは3つ。
 *   1. TikTok が決めた投稿設定の決まり（既定値なし・ブランドコンテンツは非公開不可）と、
 *      このアプリの決まり（案件リンクならブランドコンテンツ申告）を破らせない
 *   2. 直接投稿できないときは、黙って公開せず下書き送信に落ちる
 *   3. 下書きに落ちたときは、本文を貼る手間が画面に残る
 */

const assert = require('assert');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); failed++; }
}

const rules = require('../lib/tiktok-settings');
const tiktok = require('../lib/tiktok');
const net = require('../lib/networks/tiktok');
const handoff = require('../lib/handoff');

const ok = (over) => rules.normalize(Object.assign({
  privacy_level: 'SELF_ONLY', consent: true,
}, over || {}));

/** mvhd 箱だけを持つ、最小の「MP4らしきもの」。 */
function fakeMp4(seconds, pad = 16) {
  const b = Buffer.alloc(pad + 40);
  b.write('mvhd', pad);
  b[pad + 4] = 0;                       // version 0
  b.writeUInt32BE(1000, pad + 16);      // timescale
  b.writeUInt32BE(seconds * 1000, pad + 20);
  return b;
}

/**
 * TikTok の API を差し替える。path → 返事 の表で答え、呼ばれた順を記録する。
 */
function fakeTiktokApi(table) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, body: opts && opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null });
    if (u.startsWith('https://upload.example')) return { ok: true, status: 200, text: async () => '' };
    const key = Object.keys(table).find((k) => u.includes(k));
    const r = key ? table[key] : { status: 404, json: {} };
    // 本物と同じく、生の文字列で返す（raw があればそれを優先。19桁のIDを数値のまま書くため）
    const text = r.raw || JSON.stringify(r.json);
    return { ok: (r.status || 200) < 400, status: r.status || 200,
      text: async () => text, json: async () => JSON.parse(text) };
  };
  return calls;
}

const CREATOR = {
  json: { error: { code: 'ok' }, data: {
    creator_nickname: 'ひろや', creator_username: 'hiroya',
    privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
    comment_disabled: false, duet_disabled: true, stitch_disabled: false,
    max_video_post_duration_sec: 60,
  } },
};
const INIT_OK = { json: { error: { code: 'ok' }, data: { publish_id: 'p_1', upload_url: 'https://upload.example/x' } } };

const directAccount = {
  id: 'acc', network: 'tiktok', refresh_token: 'r', access_token: 't',
  expires_at: new Date(Date.now() + 3600e3).toISOString(),
  meta: { scopes: ['user.info.basic', 'video.upload', 'video.publish'] },
};
const inboxAccount = Object.assign({}, directAccount, { meta: { scopes: ['user.info.basic', 'video.upload'] } });

const fakeDb = (media) => ({ download: async () => media, updateAccount: async () => ({}) });

(async () => {
  const realFetch = global.fetch;

  console.log('\n投稿設定の決まり');

  await check('公開範囲を選んでいなければ断る（TikTok の決まりで既定値は置かない）', () => {
    assert.ok(rules.problems(ok({ privacy_level: '' })).some((m) => /公開範囲/.test(m)));
  });

  await check('コメント等は、何も言われなければ許可しない側になる', () => {
    const s = rules.normalize({ privacy_level: 'SELF_ONLY' });
    assert.strictEqual(s.allow_comment, false);
    assert.strictEqual(s.allow_duet, false);
    assert.strictEqual(s.allow_stitch, false);
    assert.strictEqual(s.commercial, false);
  });

  await check('規約への同意が無ければ断る', () => {
    assert.ok(rules.problems(ok({ consent: false })).some((m) => /同意/.test(m)));
  });

  await check('ブランドコンテンツは「自分のみ」にできない', () => {
    const p = rules.problems(ok({ commercial: true, branded_content: true, privacy_level: 'SELF_ONLY' }));
    assert.ok(p.some((m) => /自分のみ/.test(m)));
  });

  await check('商用申告を ON にしたら、種類を選ばせる', () => {
    assert.ok(rules.problems(ok({ commercial: true })).length > 0);
  });

  await check('案件リンクを含む投稿は、ブランドコンテンツ申告が無いと断る（ステマ規制）', () => {
    assert.ok(rules.problems(ok({ privacy_level: 'PUBLIC_TO_EVERYONE' }), { hasAffiliateLink: true })
      .some((m) => /ブランドコンテンツ/.test(m)));
    assert.deepStrictEqual(rules.problems(
      ok({ privacy_level: 'PUBLIC_TO_EVERYONE', commercial: true, branded_content: true }),
      { hasAffiliateLink: true }), []);
  });

  await check('そのアカウントで選べない公開範囲は断る', () => {
    const p = rules.problems(ok({ privacy_level: 'FOLLOWER_OF_CREATOR' }),
      { privacyOptions: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'] });
    assert.ok(p.length === 1 && /選べません/.test(p[0]));
  });

  await check('TikTok に送る形へ正しく言い換える', () => {
    const info = rules.toPostInfo(ok({ allow_comment: true, commercial: true, your_brand: true }), '本文');
    assert.deepStrictEqual(info, {
      title: '本文', privacy_level: 'SELF_ONLY',
      disable_comment: false, disable_duet: true, disable_stitch: true,
      brand_content_toggle: false, brand_organic_toggle: true, is_aigc: false,
    });
  });

  await check('同意文とラベルは、TikTok が指定した文言のまま', () => {
    assert.strictEqual(rules.disclosure(ok()).consent,
      "By posting, you agree to TikTok's Music Usage Confirmation");
    const branded = rules.disclosure(ok({ commercial: true, branded_content: true, your_brand: true }));
    assert.strictEqual(branded.label, "Your photo/video will be labeled as 'Paid partnership'");
    assert.ok(/Branded Content Policy/.test(branded.consent));
  });

  console.log('\n権限');

  await check('実際にもらえた権限に video.publish があるときだけ直接投稿できる', () => {
    assert.ok(tiktok.canDirectPost(directAccount));
    assert.ok(!tiktok.canDirectPost(inboxAccount));
    assert.ok(!tiktok.canDirectPost({ meta: {} }));
  });

  await check('TikTok の権限の返事（カンマ区切り）を読める', () => {
    assert.deepStrictEqual(tiktok.parseScopes('user.info.basic,video.publish'), ['user.info.basic', 'video.publish']);
    assert.deepStrictEqual(tiktok.withScopes({ keep: 1 }, 'a,b'), { keep: 1, scopes: ['a', 'b'] });
  });

  await check('環境変数を入れたときだけ video.publish を頼む（入れていない人の連携を壊さない）', () => {
    process.env.TIKTOK_CLIENT_KEY = 'k';
    delete process.env.TIKTOK_DIRECT_POST;
    assert.ok(!/video\.publish/.test(decodeURIComponent(tiktok.authUrl('https://x/cb'))));
    process.env.TIKTOK_DIRECT_POST = '1';
    assert.ok(/video\.publish/.test(decodeURIComponent(tiktok.authUrl('https://x/cb'))));
    delete process.env.TIKTOK_DIRECT_POST;
  });

  console.log('\n動画の長さ');

  await check('MP4 の長さを読める', () => {
    assert.strictEqual(net.mp4DurationSec(fakeMp4(17)), 17);
  });
  await check('読めないときは null（確認を飛ばす）', () => {
    assert.strictEqual(net.mp4DurationSec(Buffer.from('not a video')), null);
  });

  console.log('\n送り方の切り替え');

  const post = (over) => Object.assign({
    media_kind: 'video', media_path: 'a.mp4', tt_caption: 'キャプション #AI',
    tt_settings: { privacy_level: 'SELF_ONLY', allow_duet: true, allow_comment: true, consent: true },
  }, over || {});

  await check('直接投稿：本文と設定を一緒に送り、閉じられている操作は送らない', async () => {
    const calls = fakeTiktokApi({ '/creator_info/': CREATOR, '/post/publish/video/init/': INIT_OK });
    const out = await net.step({ post: post(), target: {}, account: directAccount, db: fakeDb(fakeMp4(17)) });
    assert.strictEqual(out.stage, net.STAGE_DIRECT);
    assert.strictEqual(out.externalId, 'p_1');
    const init = calls.find((c) => c.url.includes('/post/publish/video/init/'));
    assert.strictEqual(init.body.post_info.title, 'キャプション #AI');
    assert.strictEqual(init.body.post_info.privacy_level, 'SELF_ONLY');
    assert.strictEqual(init.body.post_info.disable_comment, false);
    assert.strictEqual(init.body.post_info.disable_duet, true, 'デュエットが閉じられているのに許可して送った');
    assert.ok(!calls.some((c) => c.url.includes('/inbox/')), '下書きにも送っている');
  });

  await check('審査前で公開アカウントに断られたら、下書き送信に切り替える', async () => {
    const calls = fakeTiktokApi({
      '/creator_info/': CREATOR,
      '/post/publish/video/init/': { status: 403, json: { error: { code: 'unaudited_client_can_only_post_to_private_accounts' } } },
      '/inbox/video/init/': INIT_OK,
    });
    const out = await net.step({ post: post(), target: {}, account: directAccount, db: fakeDb(fakeMp4(17)) });
    assert.strictEqual(out.stage, net.STAGE_INBOX);
    assert.ok(/下書き/.test(out.note));
    assert.strictEqual(calls.filter((c) => c.url.startsWith('https://upload.example')).length, 1, '動画を2回送った');
  });

  await check('直接投稿の権限が無ければ、設定があっても下書き送信', async () => {
    const calls = fakeTiktokApi({ '/inbox/video/init/': INIT_OK });
    const out = await net.step({ post: post(), target: {}, account: inboxAccount, db: fakeDb(fakeMp4(17)) });
    assert.strictEqual(out.stage, net.STAGE_INBOX);
    assert.ok(!calls.some((c) => c.url.includes('/creator_info/')));
  });

  await check('投稿設定が無ければ、権限があっても下書き送信（勝手に公開しない）', async () => {
    fakeTiktokApi({ '/inbox/video/init/': INIT_OK });
    const out = await net.step({ post: post({ tt_settings: null }), target: {}, account: directAccount, db: fakeDb(fakeMp4(17)) });
    assert.strictEqual(out.stage, net.STAGE_INBOX);
  });

  await check('上限より長い動画は送らない', async () => {
    const calls = fakeTiktokApi({ '/creator_info/': CREATOR, '/post/publish/video/init/': INIT_OK });
    await assert.rejects(
      () => net.step({ post: post(), target: {}, account: directAccount, db: fakeDb(fakeMp4(90)) }),
      /長すぎます/);
    assert.ok(!calls.some((c) => c.url.includes('/init/')));
  });

  await check('送る直前に選べなくなった公開範囲は、送らずに止める', async () => {
    const calls = fakeTiktokApi({ '/creator_info/': CREATOR, '/post/publish/video/init/': INIT_OK });
    await assert.rejects(() => net.step({
      post: post({ tt_settings: { privacy_level: 'FOLLOWER_OF_CREATOR', consent: true } }),
      target: {}, account: directAccount, db: fakeDb(fakeMp4(17)),
    }), /選べません/);
    assert.ok(!calls.some((c) => c.url.includes('/init/')));
  });

  await check('公開されたら、動画IDとURLを持ち帰る（のびと結びつけられる）', async () => {
    fakeTiktokApi({
      '/status/fetch/': { raw: '{"error":{"code":"ok"},"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7412345678901234567]}}' },
      '/creator_info/': CREATOR,
    });
    const out = await net.step({ post: post(), target: { external_id: 'p_1', stage: net.STAGE_DIRECT }, account: directAccount, db: fakeDb(null) });
    assert.ok(out.done);
    // ★ 19桁が1桁も丸められていないこと。数値で読むと末尾が変わる。
    assert.strictEqual(out.externalId, '7412345678901234567');
    assert.strictEqual(out.permalink, 'https://www.tiktok.com/@hiroya/video/7412345678901234567');
  });

  await check('下書き送信の完了は、送り方が分かる名前で終わる', async () => {
    fakeTiktokApi({ '/status/fetch/': { json: { error: { code: 'ok' }, data: { status: 'SEND_TO_USER_INBOX' } } } });
    const out = await net.step({ post: post(), target: { external_id: 'p_1', stage: net.STAGE_INBOX }, account: directAccount, db: fakeDb(null) });
    assert.ok(out.done);
    assert.strictEqual(out.stage, 'published_inbox');
  });

  console.log('\n画面に残る手間');

  const acc = { id: 'acc', network: 'tiktok', can_direct_post: true };
  const withSettings = { tt_caption: 'x', tt_settings: { privacy_level: 'SELF_ONLY' } };

  await check('直接投稿なら、本文を貼る手間は残らない', () => {
    const plan = handoff.planFor(withSettings, [acc], null, [{ account_id: 'acc', status: 'success', stage: 'published' }]);
    assert.deepStrictEqual(plan[0].needs, []);
    assert.deepStrictEqual(handoff.afterSend(plan), []);
  });

  await check('下書きに切り替わったときは、本文を貼る手間が残る', () => {
    const plan = handoff.planFor(withSettings, [acc], null, [{ account_id: 'acc', status: 'success', stage: 'published_inbox' }]);
    assert.strictEqual(handoff.afterSend(plan).length, 1);
    assert.strictEqual(plan[0].needs[0].key, 'ttCaption');
  });

  await check('いままでの下書き送信の投稿は、いままでどおり', () => {
    const plan = handoff.planFor({ tt_caption: 'x' }, [Object.assign({}, acc, { can_direct_post: false })], null,
      [{ account_id: 'acc', status: 'success', stage: 'published' }]);
    assert.strictEqual(handoff.afterSend(plan).length, 1);
  });

  global.fetch = realFetch;
  console.log(`\n${passed} 件成功 / ${failed} 件失敗`);
  if (failed) process.exit(1);
})();
