'use strict';
/**
 * 企画（シリーズ）の数字の計算と、AI が書いた投稿案の点検を確かめる。
 *
 * ★ 守りたいのは3つ。
 *   1. DAY・累計・残り日数・達成率は、記録から正しく計算される（盛らない）
 *   2. AI が自分で数字を書いたら止める。数字は差し込み口でしか入らない
 *   3. 「誰でも稼げる」のような約束を止める
 */

const assert = require('assert');
const series = require('../lib/series');
const gen = require('../lib/series-generate');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); failed++; }
}

const MONEY = series.normalizeSeries({
  name: '半年で100万稼げなければパソコン捨てます',
  style: '毎日の記録。淡々と、正直に。',
  closing: '残り{残り日数}、あと{あと}。',
  hashtags: '#半年で100万 #DAY{DAY}',
  fields: '今日やったこと',
  startDate: '2026-10-01', endDate: '2027-03-31', goalYen: 1000000,
  script: true,
});

const APPS = series.normalizeSeries({
  name: '30日で30アプリ',
  hashtags: ['30日で30アプリ', '#個人開発'],
  fields: ['アプリ名', '人間の作業時間', 'AIの作業時間', '追加費用'],
  startDate: '2026-08-25',
});

const LOGS = [
  { happened_on: '2026-10-01', amount_yen: 0 },
  { happened_on: '2026-10-02', amount_yen: 1500 },
  { happened_on: '2026-10-03', amount_yen: 3200 },
  { happened_on: '2026-10-10', amount_yen: 99999 },   // 未来の記録
];

(async () => {
  console.log('\n企画の型');

  await check('型を整える（ハッシュタグに # を付け、項目を分ける）', () => {
    assert.deepStrictEqual(APPS.hashtags, ['#30日で30アプリ', '#個人開発']);
    assert.deepStrictEqual(APPS.fields, ['アプリ名', '人間の作業時間', 'AIの作業時間', '追加費用']);
    assert.strictEqual(APPS.goalYen, null);
  });

  await check('目標金額があるのに期限が無ければ断る', () => {
    assert.throws(() => series.normalizeSeries({ name: 'x', goalYen: 100, startDate: '2026-10-01' }), /期限/);
  });

  await check('自動で計算する項目（累計など）は、入れる項目にできない', () => {
    assert.throws(() => series.normalizeSeries({ name: 'x', fields: ['累計'] }), /自動で計算/);
  });

  console.log('\n数字の計算');

  await check('DAY は開始日を DAY1 として、投稿する日で数える', () => {
    assert.strictEqual(series.stats(APPS, [], '2026-08-25').day, 1);
    assert.strictEqual(series.stats(APPS, [], '2026-09-24').day, 31);
  });

  await check('累計は投稿する日までの記録だけを足す（未来の記録は数えない）', () => {
    const st = series.stats(MONEY, LOGS, '2026-10-03');
    assert.strictEqual(st.total, 4700);
    assert.strictEqual(st.today, 3200);
    assert.strictEqual(st.remainingYen, 995300);
    assert.strictEqual(st.daysLeft, 179);
  });

  await check('達成率は切り捨て（盛らない）', () => {
    const st = series.stats(MONEY, [{ happened_on: '2026-10-01', amount_yen: 1999 }], '2026-10-01');
    assert.strictEqual(st.percent, 0.1);   // 0.1999% → 0.1%
  });

  await check('差し込み口の値は、円と%と日の形で入る', () => {
    const v = series.slotValues(MONEY, series.stats(MONEY, LOGS, '2026-10-03'), { '今日やったこと': 'LP作成' });
    assert.strictEqual(v['累計'], '4,700円');
    assert.strictEqual(v['達成率'], '0.4%');
    assert.strictEqual(v['残り日数'], '179日');
    assert.strictEqual(v.DAY, '3');
    assert.strictEqual(v['今日やったこと'], 'LP作成');
  });

  await check('目標の無い企画には、お金の差し込み口を出さない', () => {
    const v = series.slotValues(APPS, series.stats(APPS, [], '2026-09-24'), {});
    assert.ok(!('累計' in v));
    assert.strictEqual(v.DAY, '31');
  });

  console.log('\n点検');

  const values = { DAY: '3', '累計': '4,700円', '今日やったこと': 'LP作成' };

  await check('AI が自分で数字を書いたら止める', () => {
    const f = series.check({ x: '今日は売上5万円を突破しました' }, { values });
    assert.ok(f.some((x) => x.severity === 'error' && /数字/.test(x.message)));
  });

  await check('差し込み口・ハッシュタグ・本人が入れた値の中の数字は通す', () => {
    const f = series.check({ x: 'DAY{DAY}、累計{累計}。#30日で30アプリ 次の一本 横浜' }, { values, allowed: ['30日で30アプリ'] });
    assert.deepStrictEqual(f.filter((x) => x.severity === 'error'), []);
  });

  await check('知らない差し込み口（{年収}）は止める', () => {
    const f = series.check({ x: '年収{年収}を目指す' }, { values });
    assert.ok(f.some((x) => /年収/.test(x.message)));
  });

  await check('「誰でも簡単に稼げる」は止める', () => {
    for (const t of ['誰でも簡単に稼げる方法', 'あなたも稼げます', '不労所得を作ろう']) {
      assert.ok(series.check({ instagram: t }, { values }).some((x) => x.severity === 'error'), t);
    }
  });

  await check('自分の記録として「稼いだ」と書くのは通す', () => {
    const f = series.check({ instagram: '今日は{今日の売上}稼げました。累計{累計}。' }, { values: Object.assign({ '今日の売上': '3,200円' }, values) });
    assert.deepStrictEqual(f.filter((x) => x.severity === 'error'), []);
  });

  await check('台本の場面番号や秒数は通し、金額は止める', () => {
    assert.deepStrictEqual(series.check({ script: '場面1（0〜3秒）：画面を映す' }, { values }).filter((x) => x.severity === 'error'), []);
    assert.ok(series.check({ script: '売上は3万円でした' }, { values }).some((x) => x.severity === 'error'));
  });

  await check('案件リンクがあるのに PR 表記が無ければ止める', () => {
    assert.ok(series.check({ instagram: 'おすすめです' }, { values, hasAffiliateLink: true }).some((x) => /PR/.test(x.message)));
  });

  console.log('\n投稿案を作る（AI は偽物）');

  const good = {
    instagram: 'DAY{DAY}。今日は{今日やったこと}をやりました。累計{累計}。',
    tiktok: 'DAY{DAY}、{今日やったこと}！',
    youtubeTitle: '半年で100万 DAY{DAY}｜{今日やったこと}',
    youtubeDescription: '今日は{今日やったこと}。累計{累計}、達成率{達成率}。',
    x: 'DAY{DAY}：{今日やったこと}。累計{累計}',
    threads: '今日は{今日やったこと}をやってみました。皆さんならどうしますか？',
    hashtags: ['#副業', '#記録'],
    script: '【冒頭2秒のひと言】パソコンを捨てるまで、あと{残り日数}\n【本編】場面1：読み上げ：…',
  };

  await check('差し込み口を本物の値に置き換え、締めの一言と固定タグを付ける', async () => {
    const out = await gen.generate({ series: MONEY, logs: LOGS, onDate: '2026-10-03', inputs: { '今日やったこと': 'LP作成' } },
      { json: async () => good });
    assert.ok(out.ok, JSON.stringify(out.findings));
    assert.ok(out.posts.instagram.startsWith('DAY3。今日はLP作成をやりました。累計4,700円。'));
    assert.ok(out.posts.instagram.includes('残り179日、あと995,300円。'));
    assert.ok(out.posts.instagram.includes('#半年で100万 #DAY3 #副業 #記録'));
    assert.ok(!/\{/.test(out.posts.x), '差し込み口が残っている');
    assert.strictEqual((out.posts.x.match(/#/g) || []).length, 2, 'X のタグは2個まで');
    assert.strictEqual((out.posts.threads.match(/#/g) || []).length, 1, 'Threads のタグは1個');
    assert.ok(out.script.includes('あと179日'));
  });

  await check('AI が数字を書いたら指摘を添えて書き直させ、直ればそれを使う', async () => {
    let n = 0; const prompts = [];
    const ask = async (req) => {
      prompts.push(req.user); n++;
      return n === 1 ? Object.assign({}, good, { x: '売上5万円突破！' }) : good;
    };
    const out = await gen.generate({ series: MONEY, logs: LOGS, onDate: '2026-10-03', inputs: { '今日やったこと': 'LP作成' } }, { json: ask });
    assert.strictEqual(out.attempts, 2);
    assert.ok(out.ok);
    assert.ok(/直すところ/.test(prompts[1]) && /数字/.test(prompts[1]));
  });

  await check('3回とも直らなければ ok:false で止める（予約させない）', async () => {
    const out = await gen.generate({ series: MONEY, logs: LOGS, onDate: '2026-10-03', inputs: {} },
      { json: async () => Object.assign({}, good, { instagram: '誰でも簡単に稼げる！' }) });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.attempts, 3);
  });

  await check('依頼文には、使える差し込み口と本人の入力が入る', () => {
    const v = series.slotValues(MONEY, series.stats(MONEY, LOGS, '2026-10-03'), { '今日やったこと': 'LP作成' });
    const u = gen.userPrompt({ s: MONEY, values: v, inputs: { '今日やったこと': 'LP作成' }, note: 'メモ' });
    assert.ok(u.includes('{累計}') && u.includes('{DAY}') && u.includes('LP作成') && u.includes('動画台本も作って'));
  });

  console.log(`\n${passed} 件成功 / ${failed} 件失敗`);
  if (failed) process.exit(1);
})();
