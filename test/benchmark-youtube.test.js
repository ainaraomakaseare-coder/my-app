'use strict';
/**
 * lib/benchmark-youtube.js（「のび」タブの YouTube 自動収集）を確かめる。
 *
 * ネットには出ないので fetch を差し替える（fetchImpl を直接渡す。
 * accessTokenFor は expires_at を未来にしておけば通信せずに済む。test/insights.test.js と同じ形）。
 *
 *   node test/benchmark-youtube.test.js
 */
const assert = require('assert');
const benchmarkYoutube = require('../lib/benchmark-youtube');
const benchmark = require('../lib/benchmark');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); failed++; }
}

// トークンが「まだ切れていない」ことにして、Google とのやり取り分の呼び出しを増やさない。
const FAR_FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const account = () => ({
  id: 'yt1', network: 'youtube', access_token: 'yt-tok', refresh_token: 'yt-refresh', expires_at: FAR_FUTURE,
});

/** fetchImpl を差し替える。呼ばれた url/opt を calls に残し、handler の戻り値をレスポンスにする。 */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opt) => {
    calls.push({ url: String(url), opt });
    const r = handler(String(url), opt, calls.length);
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      statusText: r.statusText || 'OK',
      async text() { return r.text !== undefined ? r.text : JSON.stringify(r.json || {}); },
      async json() { return r.json || {}; },
    };
  };
  fn.calls = calls;
  return fn;
}

const QA = benchmarkYoutube.QUERIES.ai;

/** search / videos / channels の3種類のエンドポイントに答える、主要シナリオ用のハンドラ。 */
function mainHandler(url) {
  if (url.includes('/search?')) {
    const q = decodeURIComponent(new URL(url).searchParams.get('q'));
    if (q === QA[0]) return { json: { items: [{ id: { videoId: 'v1' } }] } };
    if (q === QA[1]) return { json: { items: [{ id: { videoId: 'v1' } }, { id: { videoId: 'v2' } }] } };
    if (q === QA[2]) return { json: { items: [{ id: { videoId: 'v3' } }] } };
    return { json: { items: [] } };
  }
  if (url.includes('/videos?')) {
    return {
      json: {
        items: [
          {
            id: 'v1',
            snippet: {
              channelId: 'c1', channelTitle: 'AIチャンネル',
              title: 'AIでできること10選 #AI #Shorts', description: '#AI 詳しくはコメント欄',
              publishedAt: '2026-09-27T16:30:00Z',
            },
            statistics: { viewCount: '100000', commentCount: '10' }, // likeCount 無し
            contentDetails: { duration: 'PT45S' },
          },
          {
            id: 'v2',
            snippet: {
              channelId: 'c2', channelTitle: 'ChatGPT研究所',
              title: 'ChatGPTの小技', description: '',
              publishedAt: '2026-09-20T00:00:00Z',
            },
            statistics: { viewCount: '5000', likeCount: '200', commentCount: '5' },
            contentDetails: { duration: 'PT2M' },
          },
          {
            id: 'v3',
            snippet: {
              channelId: 'c1', channelTitle: 'AIチャンネル',
              title: '長尺の動画', description: '',
              publishedAt: '2026-09-20T00:00:00Z',
            },
            statistics: { viewCount: '999', likeCount: '1', commentCount: '0' },
            contentDetails: { duration: 'PT4M' }, // 240秒。180秒超なので落ちるはず
          },
        ],
      },
    };
  }
  if (url.includes('/channels?')) {
    return {
      json: {
        items: [
          { id: 'c1', statistics: { hiddenSubscriberCount: true }, snippet: { customUrl: null } },
          { id: 'c2', statistics: { hiddenSubscriberCount: false, subscriberCount: '1000' }, snippet: { customUrl: '@chatgpt' } },
        ],
      },
    };
  }
  throw new Error('想定外の呼び出し: ' + url);
}

(async () => {
  await check('search に type=video/videoDuration=short/order=viewCount/regionCode=JP/publishedAfter(30日前) が入る', async () => {
    const now = new Date('2026-09-28T00:00:00Z');
    const fetchImpl = fakeFetch(() => ({ json: { items: [] } }));
    await benchmarkYoutube.collect('ai', { account: account(), db: {}, fetchImpl, now });
    const first = new URL(fetchImpl.calls[0].url);
    assert.strictEqual(first.searchParams.get('type'), 'video');
    assert.strictEqual(first.searchParams.get('videoDuration'), 'short');
    assert.strictEqual(first.searchParams.get('order'), 'viewCount');
    assert.strictEqual(first.searchParams.get('regionCode'), 'JP');
    assert.strictEqual(
      first.searchParams.get('publishedAfter'),
      new Date(now.getTime() - 30 * 86400000).toISOString(),
      '30日前になっていない',
    );
  });

  await check('2つのクエリがヒットしたIDは、videos.list には1回だけ渡す（重複しない）', async () => {
    const fetchImpl = fakeFetch(mainHandler);
    await benchmarkYoutube.collect('ai', { account: account(), db: {}, fetchImpl, now: new Date('2026-09-28T00:00:00Z') });
    const videosCall = fetchImpl.calls.find((c) => c.url.includes('/videos?'));
    assert.ok(videosCall, 'videos.list が呼ばれていない');
    const ids = new URL(videosCall.url).searchParams.get('id').split(',');
    assert.deepStrictEqual(ids, ['v1', 'v2', 'v3'], 'v1が重複して渡っているか、順番がおかしい');
  });

  await check('parseDuration: PT45S→45 / PT1M5S→65 / PT2M→120', () => {
    assert.strictEqual(benchmarkYoutube.parseDuration('PT45S'), 45);
    assert.strictEqual(benchmarkYoutube.parseDuration('PT1M5S'), 65);
    assert.strictEqual(benchmarkYoutube.parseDuration('PT2M'), 120);
  });

  await check('180秒を超える動画は結果から落ちる', async () => {
    const fetchImpl = fakeFetch(mainHandler);
    const out = await benchmarkYoutube.collect('ai', { account: account(), db: {}, fetchImpl, now: new Date('2026-09-28T00:00:00Z') });
    assert.ok(!out.items.some((it) => it.url.includes('v3')), '240秒のv3が残っている');
    assert.ok(out.rejected !== undefined, 'rejected が返っていない');
  });

  await check('登録者非公開のチャンネル → followers は null（0にしない）。のび率も null', async () => {
    const fetchImpl = fakeFetch(mainHandler);
    const out = await benchmarkYoutube.collect('ai', { account: account(), db: {}, fetchImpl, now: new Date('2026-09-28T00:00:00Z') });
    const v1 = out.items.find((it) => it.url.includes('v1'));
    assert.ok(v1, 'v1が結果に無い');
    assert.strictEqual(v1.account.followers, null);
    assert.strictEqual(v1.ratio, null);
    assert.ok(!('followers_source' in v1.account), 'followersが無いのにfollowers_sourceを付けている');
  });

  await check('likeCount が無い動画 → likes は null（0にしない）', async () => {
    const fetchImpl = fakeFetch(mainHandler);
    const out = await benchmarkYoutube.collect('ai', { account: account(), db: {}, fetchImpl, now: new Date('2026-09-28T00:00:00Z') });
    const v1 = out.items.find((it) => it.url.includes('v1'));
    assert.strictEqual(v1.metrics.likes, null);
  });

  await check('topic は最初にヒットしたクエリになる', async () => {
    const fetchImpl = fakeFetch(mainHandler);
    const out = await benchmarkYoutube.collect('ai', { account: account(), db: {}, fetchImpl, now: new Date('2026-09-28T00:00:00Z') });
    const v1 = out.items.find((it) => it.url.includes('v1'));
    assert.strictEqual(v1.content.topic, QA[0]);
  });

  await check('のび率が出る動画が先、出ない動画は後ろ（views順にもならない）', async () => {
    const fetchImpl = fakeFetch(mainHandler);
    const out = await benchmarkYoutube.collect('ai', { account: account(), db: {}, fetchImpl, now: new Date('2026-09-28T00:00:00Z') });
    assert.strictEqual(out.items.length, 2, 'v3が混じっている等、件数がおかしい: ' + JSON.stringify(out.items.map((i) => i.url)));
    assert.ok(out.items[0].url.includes('v2'), 'のび率(5倍)が出るv2が先頭に来ていない');
    assert.ok(out.items[1].url.includes('v1'), 'のび率が出ないv1が後ろに来ていない');
    assert.strictEqual(out.items[0].ratio, 5, 'v2ののび率(5000再生÷1000人)が違う');
  });

  await check('posted_at は日本時間の暦日（publishedAt 16:30 UTC → 翌日28日）', async () => {
    const fetchImpl = fakeFetch(mainHandler);
    const out = await benchmarkYoutube.collect('ai', { account: account(), db: {}, fetchImpl, now: new Date('2026-09-28T00:00:00Z') });
    const v1 = out.items.find((it) => it.url.includes('v1'));
    assert.strictEqual(v1.posted_at, '2026-09-28');
  });

  await check('toJstDate 単体でも同じ結果', () => {
    assert.strictEqual(benchmarkYoutube.toJstDate('2026-09-27T16:30:00Z'), '2026-09-28');
  });

  await check('できあがったレコードは lib/benchmark.js の点検をエラー無しで通る', async () => {
    const fetchImpl = fakeFetch(mainHandler);
    const out = await benchmarkYoutube.collect('ai', { account: account(), db: {}, fetchImpl, now: new Date('2026-09-28T00:00:00Z') });
    assert.ok(out.items.length > 0, '点検を試す対象が無い');
    for (const it of out.items) {
      const r = benchmark.checkItem(it);
      assert.deepStrictEqual(r.errors, [], JSON.stringify(r.errors) + ' → ' + it.url);
    }
  });

  await check('知らない genre は断る', async () => {
    await assert.rejects(() => benchmarkYoutube.collect('other', { account: account(), db: {} }), /genre は/);
  });

  await check('YouTube と連携できていないと、通信せずに ok:false で返る', async () => {
    const fetchImpl = fakeFetch(() => { throw new Error('呼ばれてはいけない'); });
    const out = await benchmarkYoutube.collect('ai', { account: { network: 'youtube' }, db: {}, fetchImpl });
    assert.strictEqual(out.ok, false);
    assert.ok(/連携が済んでいません/.test(out.error), out.error);
  });

  await check('YouTube のエラー（クォータ切れ）は日本語のメッセージになり、生JSONを見せない', async () => {
    const fetchImpl = fakeFetch(() => ({
      ok: false, status: 403,
      json: { error: { errors: [{ reason: 'quotaExceeded', message: 'Quota exceeded' }] } },
    }));
    const out = await benchmarkYoutube.collect('ai', { account: account(), db: {}, fetchImpl, now: new Date('2026-09-28T00:00:00Z') });
    assert.strictEqual(out.ok, false);
    assert.ok(/利用枠を使い切りました/.test(out.error), out.error);
    assert.ok(out.hint, 'hint が無い');
    assert.ok(!/\{/.test(out.error), '生のJSONがそのままメッセージに出ている: ' + out.error);
  });

  // ★ relevanceLanguage=ja でも英語の動画が混ざった（本番の1回目）。題名に仮名・漢字が無いものは比べない。
  await check('題名に仮名・漢字が無い動画（英語など）は落とす', async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.includes('/search?')) return { json: { items: [{ id: { videoId: 'en1' } }, { id: { videoId: 'ja1' } }] } };
      if (url.includes('/videos?')) {
        const v = (id, title) => ({ id, snippet: { channelId: 'c9', channelTitle: 'x', title, description: '', publishedAt: '2026-09-20T00:00:00Z' },
          statistics: { viewCount: '50000', likeCount: '10', commentCount: '1' }, contentDetails: { duration: 'PT30S' } });
        return { json: { items: [v('en1', 'ChatGPT Codes Every Student Needs in 2026'), v('ja1', 'ChatGPTで時短する方法')] } };
      }
      return { json: { items: [{ id: 'c9', statistics: { subscriberCount: '100' }, snippet: {} }] } };
    });
    const out = await benchmarkYoutube.collect('ai', { account: account(), db: {}, fetchImpl, now: new Date('2026-09-28T00:00:00Z') });
    assert.deepStrictEqual(out.items.map((i) => i.url), ['https://www.youtube.com/shorts/ja1']);
  });

  await check('extractHashtags: 重複を除き（大小無視）、最大10個まで', () => {
    const many = Array.from({ length: 15 }, (_, i) => '#t' + i).join(' ');
    const tags = benchmarkYoutube.extractHashtags('#AI #ai #Shorts ' + many);
    assert.strictEqual(tags.length, 10);
    assert.strictEqual(tags.filter((t) => t.toLowerCase() === '#ai').length, 1, '大小違いの重複を除けていない');
  });

  console.log(`\n${passed} 件成功 / ${failed} 件失敗`);
  if (failed) process.exit(1);
})();
