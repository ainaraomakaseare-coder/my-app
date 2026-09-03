'use strict';
/**
 * lib/insights.js（SNSの数字を読む部分）を確かめる。
 *
 * ネットには出ないので fetch を差し替える。test/cloud.test.js / llm.test.js と同じ形。
 *
 *   node test/insights.test.js
 */
const assert = require('assert');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['ok', name]); }
  catch (err) { results.push(['NG', name + ' → ' + err.message]); }
}

/** fetch を差し替えて、呼ばれた順に url/body を記録しつつ、用意した返事を順番に返す。 */
function withFetch(replies) {
  const real = global.fetch;
  const calls = [];
  let i = 0;
  global.fetch = async (url, opt) => {
    calls.push({ url: String(url), opt });
    const r = typeof replies === 'function' ? replies(String(url), opt, calls.length) : replies[i++];
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      statusText: r.statusText || 'OK',
      headers: { get: () => null },
      async text() { return r.text !== undefined ? r.text : JSON.stringify(r.json || {}); },
      async json() { return r.json || {}; },
    };
  };
  return { calls, restore: () => { global.fetch = real; } };
}

delete require.cache[require.resolve('../lib/insights.js')];
const insights = require('../lib/insights.js');

// トークンが「まだ切れていない」ことにして、Google/TikTokの引換券やり取り分の
// fetch 呼び出しを増やさない（数え間違いを防ぐ）。
const FAR_FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

(async () => {
  // -------------------------------------------------------------------------
  console.log('\nYouTube');

  await check('チャンネルの統計から followers/views/posts が取り出せる', async () => {
    const account = { id: 'a1', network: 'youtube', access_token: 'yt-tok', refresh_token: 'yt-refresh', expires_at: FAR_FUTURE };
    const f = withFetch([
      { json: { items: [{ statistics: { subscriberCount: '1234', viewCount: '99999', videoCount: '42' } }] } },
    ]);
    try {
      const r = await insights.accountStats(account, {});
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.metrics.followers, 1234);
      assert.strictEqual(r.metrics.views, 99999);
      assert.strictEqual(r.metrics.posts, 42);
      assert.strictEqual(r.metrics.likes, null);
      assert.ok(r.raw, '生レスポンスが残っていない');
    } finally { f.restore(); }
  });

  await check('認証切れ（401）は throw せず ok:false で返る', async () => {
    const account = { id: 'a1', network: 'youtube', access_token: 'yt-tok', refresh_token: 'yt-refresh', expires_at: FAR_FUTURE };
    const f = withFetch([{ ok: false, status: 401, json: { error: { errors: [{ reason: 'authError' }] } } }]);
    try {
      const r = await insights.accountStats(account, {});
      assert.strictEqual(r.ok, false);
      assert.ok(/認証が切れています/.test(r.error), r.error);
      assert.ok(r.hint, 'hint が無い');
    } finally { f.restore(); }
  });

  await check('リフレッシュトークンが無いと throw せず ok:false（token取得自体の失敗も飲み込む）', async () => {
    const account = { id: 'a1', network: 'youtube' };   // refresh_token 無し
    const r = await insights.accountStats(account, {});
    assert.strictEqual(r.ok, false);
    assert.ok(/連携が済んでいません/.test(r.error), r.error);
  });

  await check('投稿が50件を超えると videos.list の呼び出しが2回に分かれる', async () => {
    const account = { id: 'a1', network: 'youtube', access_token: 'yt-tok', refresh_token: 'yt-refresh', expires_at: FAR_FUTURE };
    const targets = [];
    for (let n = 0; n < 60; n++) {
      targets.push({ id: `t${n}`, network: 'youtube', external_id: `v${n}` });
    }
    const f = withFetch((url) => {
      // URL中のidをそのまま統計として返す（存在確認だけできればよい）
      const m = url.match(/id=([^&]+)/);
      const ids = m ? m[1].split(',') : [];
      return {
        json: {
          items: ids.map((id) => ({ id, statistics: { viewCount: '10', likeCount: '1', commentCount: '0' } })),
        },
      };
    });
    try {
      const r = await insights.postStats(account, targets, {});
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(f.calls.length, 2, `呼び出し回数が2回ではない（${f.calls.length}回）`);
      assert.ok(f.calls[0].url.split('id=')[1].split(',').length === 50, '1回目が50件ではない');
      assert.ok(f.calls[1].url.split('id=')[1].split(',').length === 10, '2回目が10件ではない');
      assert.strictEqual(Object.keys(r.byTargetId).length, 60);
      assert.strictEqual(r.byTargetId['t0'].views, 10);
    } finally { f.restore(); }
  });

  // -------------------------------------------------------------------------
  console.log('\nInstagram');

  await check('followers_count / media_count が取れれば正しく反映される', async () => {
    const account = { id: 'a2', network: 'instagram', access_token: 'ig-tok' };
    const f = withFetch([
      { json: { user_id: '1', username: 'foo', followers_count: 555, media_count: 12 } },
    ]);
    try {
      const r = await insights.accountStats(account, {});
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.metrics.followers, 555);
      assert.strictEqual(r.metrics.posts, 12);
      assert.ok(!r.error, '成功したのに error が付いている: ' + r.error);
    } finally { f.restore(); }
  });

  await check('★ followers_count が返ってこないとき、null になり、Meta の原文が error に入る', async () => {
    const account = { id: 'a2', network: 'instagram', access_token: 'ig-tok' };
    // followers_count キー自体が無い（権限が無いときにありがちな返り方）
    const f = withFetch([{ json: { user_id: '1', username: 'foo', media_count: 3 } }]);
    try {
      const r = await insights.accountStats(account, {});
      assert.strictEqual(r.ok, true, '取れた項目もあるので全滅（ok:false）にはしない: ' + JSON.stringify(r));
      assert.strictEqual(r.metrics.followers, null);
      assert.strictEqual(r.metrics.posts, 3, '取れているものまで null にしてはいけない');
      assert.ok(r.error, 'error が無い（原因を隠してしまっている）');
      assert.ok(r.error.includes('foo') || r.error.includes('user_id'), 'Meta の原文がerrorに入っていない: ' + r.error);
    } finally { f.restore(); }
  });

  await check('★ フィールド単位のエラーオブジェクトで返ってきた場合も、コードと原文を拾う', async () => {
    const account = { id: 'a2', network: 'instagram', access_token: 'ig-tok' };
    const f = withFetch([{
      json: {
        user_id: '1', username: 'foo', media_count: 3,
        followers_count: { error: { message: 'この権限では取得できません', code: 100, error_subcode: 0 } },
      },
    }]);
    try {
      const r = await insights.accountStats(account, {});
      assert.strictEqual(r.metrics.followers, null);
      assert.ok(/この権限では取得できません/.test(r.error), 'Meta のメッセージ原文が error に入っていない: ' + r.error);
    } finally { f.restore(); }
  });

  await check('トークンが無いと throw せず ok:false', async () => {
    const account = { id: 'a2', network: 'instagram' };   // access_token 無し
    const r = await insights.accountStats(account, {});
    assert.strictEqual(r.ok, false);
    assert.ok(/トークンが登録されていません/.test(r.error), r.error);
  });

  await check('Instagram のAPIエラー（トークン無効）は throw せず ok:false で、原文を含む', async () => {
    const account = { id: 'a2', network: 'instagram', access_token: 'ig-tok' };
    const f = withFetch([
      { ok: false, status: 400, json: { error: { code: 190, message: 'Error validating access token' } } },
    ]);
    try {
      const r = await insights.accountStats(account, {});
      assert.strictEqual(r.ok, false);
      assert.ok(/アクセストークンが無効/.test(r.error), r.error);
      assert.ok(r.hint, 'hint が無い');
    } finally { f.restore(); }
  });

  await check('投稿ごとの like_count / comments_count が拾える', async () => {
    const account = { id: 'a2', network: 'instagram', access_token: 'ig-tok' };
    const targets = [{ id: 't1', network: 'instagram', external_id: 'media1' }];
    const f = withFetch([{ json: { like_count: 20, comments_count: 4 } }]);
    try {
      const r = await insights.postStats(account, targets, {});
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.byTargetId['t1'].likes, 20);
      assert.strictEqual(r.byTargetId['t1'].comments, 4);
      assert.strictEqual(r.byTargetId['t1'].views, null, 'Instagramのこのエンドポイントに再生数は無いはず');
    } finally { f.restore(); }
  });

  await check('1件の投稿の取得が失敗しても、他の投稿は続けて取り込める', async () => {
    const account = { id: 'a2', network: 'instagram', access_token: 'ig-tok' };
    const targets = [
      { id: 't1', network: 'instagram', external_id: 'bad' },
      { id: 't2', network: 'instagram', external_id: 'good' },
    ];
    const f = withFetch([
      { ok: false, status: 400, json: { error: { code: 190, message: 'expired' } } },
      { json: { like_count: 9, comments_count: 1 } },
    ]);
    try {
      const r = await insights.postStats(account, targets, {});
      assert.strictEqual(r.ok, true);
      assert.ok(r.byTargetId['t1'].error, '失敗した投稿の理由が残っていない');
      assert.strictEqual(r.byTargetId['t2'].likes, 9, '1件目の失敗で2件目まで巻き込まれている');
    } finally { f.restore(); }
  });

  // -------------------------------------------------------------------------
  console.log('\nTikTok');

  await check('follower_count / likes_count / video_count が取り出せる', async () => {
    const account = { id: 'a3', network: 'tiktok', access_token: 'tt-tok', refresh_token: 'tt-refresh', expires_at: FAR_FUTURE };
    const f = withFetch([
      { json: { data: { user: { follower_count: 300, likes_count: 900, video_count: 8 } } } },
    ]);
    try {
      const r = await insights.accountStats(account, {});
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.metrics.followers, 300);
      assert.strictEqual(r.metrics.likes, 900);
      assert.strictEqual(r.metrics.posts, 8);
    } finally { f.restore(); }
  });

  await check('権限不足（scope_not_authorized）は throw せず ok:false で日本語の理由が入る', async () => {
    const account = { id: 'a3', network: 'tiktok', access_token: 'tt-tok', refresh_token: 'tt-refresh', expires_at: FAR_FUTURE };
    const f = withFetch([{ json: { error: { code: 'scope_not_authorized', message: 'missing scope' } } }]);
    try {
      const r = await insights.accountStats(account, {});
      assert.strictEqual(r.ok, false);
      assert.ok(/権限が足りません/.test(r.error), r.error);
    } finally { f.restore(); }
  });

  await check('★ postStats は必ず ok:false で、理由が日本語で入っている（アプリの投稿と紐付けられないため）', async () => {
    const account = { id: 'a3', network: 'tiktok', access_token: 'tt-tok', refresh_token: 'tt-refresh', expires_at: FAR_FUTURE };
    const r = await insights.postStats(account, [{ id: 't1', external_id: 'v1' }], {});
    assert.strictEqual(r.ok, false);
    assert.ok(/下書き/.test(r.error) && /結びつけられません/.test(r.error), r.error);
    assert.ok(r.hint, 'hint が無い');
  });

  await check('recentVideos で直近の動画一覧が読める', async () => {
    const account = { id: 'a3', network: 'tiktok', access_token: 'tt-tok', refresh_token: 'tt-refresh', expires_at: FAR_FUTURE };
    const f = withFetch([
      {
        json: {
          data: {
            videos: [
              { id: 'v1', title: 'テスト', view_count: 100, like_count: 10, comment_count: 2, share_count: 1, create_time: 1735689600 },
            ],
          },
        },
      },
    ]);
    try {
      const r = await insights.recentVideos(account, {});
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.videos.length, 1);
      assert.strictEqual(r.videos[0].views, 100);
      assert.strictEqual(r.videos[0].id, 'v1');
    } finally { f.restore(); }
  });

  await check('TikTok のトークンが無いと throw せず ok:false', async () => {
    const account = { id: 'a3', network: 'tiktok' };   // refresh_token 無し
    const r = await insights.accountStats(account, {});
    assert.strictEqual(r.ok, false);
    assert.ok(/連携が済んでいません/.test(r.error), r.error);
  });

  // -------------------------------------------------------------------------
  console.log('\n未対応のSNS');

  await check('X（未対応）は throw せず、対応していない旨を返す', async () => {
    const r = await insights.accountStats({ id: 'a4', network: 'x' }, {});
    assert.strictEqual(r.ok, false);
    assert.ok(/対応していません/.test(r.error), r.error);
  });

  // -------------------------------------------------------------------------
  const bad = results.filter((r) => r[0] === 'NG');
  for (const [mark, name] of results) console.log(`  ${mark === 'ok' ? '✓' : '✗'} ${name}`);
  console.log(`\n  ${results.length - bad.length} / ${results.length} 件成功\n`);
  process.exit(bad.length ? 1 : 0);
})();
