'use strict';
/**
 * 「言えることだけ言う」が守れているかを見る。
 *
 * ★ このテストの主目的は、正しい分析ができることではなく、
 *   間違った言い切りをしないことの確認。
 *   本数が足りないのに断定していないか、差が小さいのに
 *   「この切り口が効いた」と言っていないか。
 *
 *   node test/advice.test.js
 */
const assert = require('assert');
const advice = require('../lib/advice');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['ok', name]); }
  catch (err) { results.push(['NG', name + ' → ' + err.message]); }
}

/**
 * n日ぶんのフォロワー数を作る。2026-09-03（日本時間）から遡って並べる。
 *
 * ★ toISOString はUTCに直すので、そのまま使うと日付が1日ずれる。
 *   本体が日本時間で数えている以上、テストのデータも日本時間で作る。
 */
function days(values, opts) {
  const o = opts || {};
  const base = new Date('2026-09-03T00:00:00+09:00').getTime();
  const jstDate = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
  return values.map((v, i) => ({
    taken_on: jstDate(base - (values.length - 1 - i) * 86400000),
    followers: v,
    ok: o.ok === undefined ? true : o.ok,
  }));
}

const account = (over) => Object.assign({
  id: 'a1', network: 'youtube', label: 'ひろや', account_name: 'ひろや',
  latest: { ok: true, followers: 100, taken_on: '2026-09-03' },
  days: days([100]),
}, over || {});

const posts = (scores) => scores.map((s, i) => ({ title: `ネタ${i + 1}`, views: s }));

(async () => {
  // ------------------------------------------------------- 言い切らない
  await check('本数が足りないうちは、投稿を比べない', () => {
    const f = advice.postFindings('youtube', posts([100, 50, 10]));
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].confidence, advice.WEAK);
    assert.ok(/3本ぶんしかありません/.test(f[0].headline));
  });

  // ★ ここが肝。差が小さいのに順位を出すと、偶然を法則として読んでしまう。
  await check('差が小さいときは「まだ何とも言えません」と言う', () => {
    const f = advice.postFindings('youtube', posts([120, 110, 100, 95, 90, 85]));
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].confidence, advice.WEAK);
    assert.ok(/似たような数字/.test(f[0].headline));
    assert.ok(/偶然の範囲/.test(f[0].detail), '理由を言っていない');
  });

  await check('はっきり差があれば、順位を出す', () => {
    const f = advice.postFindings('youtube', posts([1000, 120, 100, 95, 90, 85]));
    assert.ok(f.some((x) => /いちばん伸びた/.test(x.headline)));
    assert.ok(f[0].numbers.length >= 3, '根拠の数字が出ていない');
  });

  // ★ 差があっても、本数が少なければ「入れ替わるかも」と添える。
  await check('10本未満なら、断定せず断りを入れる', () => {
    const f = advice.postFindings('youtube', posts([1000, 120, 100, 95, 90, 85]));
    const top = f.find((x) => /いちばん伸びた/.test(x.headline));
    assert.ok(/入れ替わる可能性/.test(top.detail), '断りが無い');
  });

  await check('10本あれば、断りは付けない', () => {
    const f = advice.postFindings('youtube',
      posts([1000, 300, 120, 110, 100, 95, 90, 85, 80, 75]));
    const top = f.find((x) => /いちばん伸びた/.test(x.headline));
    assert.strictEqual(top.confidence, advice.SURE);
    assert.ok(!/入れ替わる可能性/.test(top.detail));
  });

  // ------------------------------------------------------- フォロワー
  await check('1日ぶんでは、増減を言わない', () => {
    const f = advice.followerFindings(account({ days: days([100]) }));
    assert.strictEqual(f[0].confidence, advice.WEAK);
    assert.ok(/まだ分かりません/.test(f[0].headline));
  });

  await check('増減は、期間と1日あたりを添えて出す', () => {
    const f = advice.followerFindings(account({ days: days([100, 105, 112]) }));
    assert.ok(/\+12人/.test(f[0].headline), f[0].headline);
    assert.ok(/1日あたり/.test(f[0].detail));
    assert.ok(/2026-09-01 100人 → 2026-09-03 112人/.test(f[0].numbers[0]), f[0].numbers[0]);
  });

  // ★ 1日0.5人未満の差を「速くなった」と言うと、揺れを傾向として読む。
  await check('ペースの差が小さければ、速いとも遅いとも言わない', () => {
    const v = [];
    for (let i = 0; i < 15; i++) v.push(100 + i * 2);       // ずっと1日+2人
    const f = advice.followerFindings(account({ days: days(v) }));
    const pace = f.find((x) => /ペース/.test(x.headline));
    assert.ok(pace, 'ペースの話が出ていない');
    assert.strictEqual(pace.confidence, advice.WEAK);
    assert.ok(/ほぼ同じ/.test(pace.headline));
  });

  await check('14日ぶん揃っていなければ、ペースの比較は参考程度と断る', () => {
    const v = [100, 101, 102, 103, 104, 105, 106, 116, 126, 136];  // 後半だけ急に伸びる
    const f = advice.followerFindings(account({ days: days(v) }));
    const pace = f.find((x) => /ペース/.test(x.headline));
    assert.strictEqual(pace.confidence, advice.WEAK);
    assert.ok(/参考程度/.test(pace.detail));
  });

  // ------------------------------------------------------- 取れていないもの
  await check('取れていない連携は、いちばん先に出す', () => {
    const out = advice.observations({
      accounts: [
        account({ id: 'a1', network: 'instagram', label: '転職',
                  latest: { ok: false, error: '権限がありません', taken_on: '2026-09-03' } }),
        account({ id: 'a2', days: days([100, 200]) }),
      ],
      postsByNetwork: {},
    });
    assert.strictEqual(out[0].confidence, advice.BLOCKED);
    assert.ok(/取れていません/.test(out[0].headline));
    assert.ok(/権限がありません/.test(out[0].detail), 'SNS側の理由を伝えていない');
  });

  // ★ 取れていないアカウントについて、伸びの話までしてしまうと
  //   「伸びていない」と「測れていない」が混ざる。
  await check('取れていない連携について、伸びの話はしない', () => {
    const out = advice.observations({
      accounts: [account({ latest: { ok: false, error: 'だめ', taken_on: '2026-09-03' },
                           days: days([100, 200]) })],
      postsByNetwork: {},
    });
    assert.ok(!out.some((x) => x.kind === 'followers'), '伸びを語っている');
  });

  await check('繋いだばかりで数字が無いことも伝える', () => {
    const out = advice.collectionFindings([account({ latest: null })]);
    assert.ok(/まだ一度も数字を取れていません/.test(out[0].headline));
    assert.ok(/毎晩/.test(out[0].detail), '待てばよいことを伝えていない');
  });

  await check('つながっているのに項目が欠けるときは、権限を疑うよう伝える', () => {
    const out = advice.collectionFindings([
      account({ latest: { ok: true, followers: null, views: null, taken_on: '2026-09-03' } })]);
    const f = out.find((x) => /返ってきません/.test(x.headline));
    assert.ok(f, '欠けを指摘していない');
    assert.ok(/権限/.test(f.detail));
  });

  // ------------------------------------------------------- 止まっているもの
  await check('手渡しのまま止まっている投稿を出す', () => {
    const f = advice.stalledFindings([
      { network: 'tiktok', title: '面接で落ちる人' },
      { network: 'youtube', title: '退職の切り出し方' },
    ]);
    assert.strictEqual(f[0].confidence, advice.SURE);
    assert.ok(/2本/.test(f[0].headline));
    assert.ok(/数字が付かない/.test(f[0].detail), 'なぜ困るかを言っていない');
  });

  await check('止まっていなければ、何も言わない', () => {
    assert.deepStrictEqual(advice.stalledFindings([]), []);
  });

  // ------------------------------------------------------- 並び
  await check('直せることを先、まだ言えないことを後ろに並べる', () => {
    const out = advice.observations({
      accounts: [
        account({ id: 'a1', days: days([100, 102]) }),
        account({ id: 'a2', network: 'instagram',
                  latest: { ok: false, error: 'だめ', taken_on: '2026-09-03' } }),
      ],
      postsByNetwork: { youtube: posts([100, 90]) },
      stalled: [{ network: 'tiktok', title: 'なにか' }],
    });
    const order = out.map((x) => x.confidence);
    const rank = { blocked: 0, sure: 1, weak: 2 };
    for (let i = 1; i < order.length; i++) {
      assert.ok(rank[order[i - 1]] <= rank[order[i]], '並びが崩れている: ' + order.join(','));
    }
  });

  await check('連携が1つも無ければ、それだけを言う', () => {
    const out = advice.observations({ accounts: [] });
    assert.strictEqual(out.length, 1);
    assert.ok(/まだ連携がありません/.test(out[0].headline));
  });

  // ------------------------------------------------------- 道具
  await check('中央値は、跳ねた1本に引っぱられない', () => {
    assert.strictEqual(advice.median([1, 2, 3, 4, 10000]), 3);
    assert.strictEqual(advice.median([1, 2, 3, 4]), 2.5);
    assert.strictEqual(advice.median([]), null);
  });

  await check('日数は日本時間で数える', () => {
    assert.strictEqual(advice.daysBetween('2026-09-01', '2026-09-03'), 2);
    assert.strictEqual(advice.daysBetween('2026-09-03', '2026-09-03'), 0);
  });

  // ------------------------------------------------------- まとめ
  const ng = results.filter((r) => r[0] === 'NG');
  for (const [state, name] of results) console.log(`  ${state === 'ok' ? '✓' : '✗'} ${name}`);
  console.log(`\n  ${results.length - ng.length} / ${results.length} 件成功`);
  if (ng.length) process.exit(1);
})();
