'use strict';
/**
 * 企画（シリーズ）の記録・数字の計算・AI が書いた投稿案の点検を確かめる。
 *
 * ★ 守りたいのは3つ。
 *   1. 売上の累計と内訳・かかったお金・利益・残り日数・達成率・作業時間は、
 *      記録から正しく計算される（盛らない。未来の記録は数えない）
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
  closing: 'パソコンを捨てるまで、あと{残り日数}。',
  hashtags: '#半年で100万 #DAY{DAY}',
  startDate: '2026-10-01', endDate: '2027-03-31', goalYen: 1000000,
  incomeCategories: 'アフィリエイト\nアプリ収益',
  script: true,
});

const APPS = series.normalizeSeries({
  name: '30日で30アプリ',
  hashtags: ['30日で30アプリ', '#個人開発'],
  fields: ['アプリ名'],
  startDate: '2026-08-25',
});

const e = (happened_on, raw) => ({ happened_on, entry: series.normalizeEntry(raw, MONEY) });
const ENTRIES = [
  e('2026-10-01', { tasks: [{ name: 'ブログ開設', humanMin: 90, aiMin: 30 }], accounts: ['A8.net', 'はてなブログ'],
    expenses: [{ item: 'ドメイン', yen: 1500 }] }),
  e('2026-10-02', { income: { 'アフィリエイト': 1200 }, tasks: [{ name: '記事作成', humanMin: 60, aiMin: 20 }] }),
  e('2026-10-03', { income: { 'アフィリエイト': 800, 'アプリ収益': 2400 }, expenses: [{ item: 'API利用料', yen: 300 }],
    tasks: [{ name: 'LP作成', humanMin: 60, aiMin: 30 }, { name: '投稿', humanMin: 15 }],
    services: [{ name: '家事分担アプリ', earn: '月額課金' }], learnings: '課金導線は最初に作るべき' }),
  e('2026-10-10', { income: { 'アフィリエイト': 99999 } }),   // 未来の記録
];

(async () => {
  console.log('\n企画の型');

  await check('目標金額がある企画は、売上の内訳の名前を持つ', () => {
    assert.deepStrictEqual(MONEY.incomeCategories, ['アフィリエイト', 'アプリ収益']);
    assert.strictEqual(MONEY.goalBasis, 'revenue');
  });

  await check('目標金額があるのに期限が無ければ断る', () => {
    assert.throws(() => series.normalizeSeries({ name: 'x', goalYen: 100, startDate: '2026-10-01' }), /期限/);
  });

  await check('自動で計算する項目（累計など）は、入れる項目にできない', () => {
    assert.throws(() => series.normalizeSeries({ name: 'x', fields: ['累計'] }), /自動で計算/);
  });

  console.log('\n毎日の記録');

  await check('知らない内訳の名前は捨てる（別の財布を作らない）', () => {
    const x = series.normalizeEntry({ income: { 'アフィリエイト': 100, '謎の収入': 999 } }, MONEY);
    assert.deepStrictEqual(x.income, { 'アフィリエイト': 100, 'アプリ収益': 0 });
  });

  await check('マイナスや小数の金額は断る', () => {
    assert.throws(() => series.normalizeEntry({ income: { 'アフィリエイト': -1 } }, MONEY), /0円以上/);
    assert.throws(() => series.normalizeEntry({ expenses: [{ item: 'x', yen: 1.5 }] }, MONEY), /0円以上/);
  });

  await check('名前の無い作業・かかったお金は断り、空の行は捨てる', () => {
    assert.throws(() => series.normalizeEntry({ tasks: [{ name: '', humanMin: 30 }] }, MONEY), /作業の名前/);
    assert.throws(() => series.normalizeEntry({ expenses: [{ item: '', yen: 100 }] }, MONEY), /何に使ったか/);
    assert.deepStrictEqual(series.normalizeEntry({ tasks: [{ name: '' }], expenses: [{}] }, MONEY).tasks, []);
  });

  console.log('\n数字の計算');

  const st = series.stats(MONEY, ENTRIES, '2026-10-03');

  await check('DAY は開始日を DAY1 として、投稿する日で数える', () => {
    assert.strictEqual(st.day, 3);
    assert.strictEqual(series.stats(APPS, [], '2026-09-24').day, 31);
  });

  await check('開始日より前は DAY を出さない（DAY-5 を投稿しない）', () => {
    const b = series.stats(MONEY, [], '2026-09-26');
    assert.strictEqual(b.day, null);
    assert.strictEqual(b.startsIn, 5);
    assert.ok(!('DAY' in series.slotValues(MONEY, b, {}, null)));
  });

  await check('売上の累計と内訳（未来の記録は数えない）', () => {
    assert.strictEqual(st.total.revenue, 4400);
    assert.deepStrictEqual(st.total.byCategory, { 'アフィリエイト': 2000, 'アプリ収益': 2400 });
    assert.strictEqual(st.today.revenue, 3200);
  });

  await check('かかったお金と利益', () => {
    assert.strictEqual(st.total.expenses, 1800);
    assert.strictEqual(st.total.profit, 2600);
    assert.strictEqual(st.today.expenses, 300);
  });

  await check('達成率・あと・残り日数（売上で数える）', () => {
    assert.strictEqual(st.counted, 4400);
    assert.strictEqual(st.remainingYen, 995600);
    assert.strictEqual(st.percent, 0.4);
    assert.strictEqual(st.daysLeft, 179);
  });

  await check('目標を「利益」で数える設定なら、利益で数える', () => {
    const p = series.normalizeSeries(Object.assign({}, MONEY, { goalBasis: 'profit' }));
    const s2 = series.stats(p, ENTRIES, '2026-10-03');
    assert.strictEqual(s2.counted, 2600);
    assert.strictEqual(s2.remainingYen, 997400);
  });

  await check('利益がマイナスでも、達成率は0%より下にしない', () => {
    const p = series.normalizeSeries(Object.assign({}, MONEY, { goalBasis: 'profit' }));
    assert.strictEqual(series.stats(p, ENTRIES, '2026-10-01').percent, 0);
  });

  await check('作業時間の累計と、公開したサービス・作ったアカウントの数', () => {
    assert.strictEqual(st.total.humanMin, 225);
    assert.strictEqual(st.total.aiMin, 80);
    assert.strictEqual(st.total.services, 1);
    assert.strictEqual(st.total.accounts, 2);
  });

  await check('差し込み口の値は、円・内訳・時間の形で入る', () => {
    const v = series.slotValues(MONEY, st, {}, ENTRIES[2].entry);
    assert.strictEqual(v['累計'], '4,400円');
    assert.strictEqual(v['累計の内訳'], 'アフィリエイト2,000円／アプリ収益2,400円');
    assert.strictEqual(v['今日の内訳'], 'アフィリエイト800円／アプリ収益2,400円');
    assert.strictEqual(v['かかったお金'], '1,800円');
    assert.strictEqual(v['利益'], '2,600円');
    assert.strictEqual(v['今日の作業'], 'LP作成（人間1時間／AI30分）、投稿（人間15分）');
    assert.strictEqual(v['今日の作業時間'], '人間1時間15分／AI30分');
    assert.strictEqual(v['累計の作業時間'], '人間3時間45分／AI1時間20分');
    assert.strictEqual(v['残り日数'], '179日');
  });

  await check('目標の無い企画には、お金の差し込み口を出さない', () => {
    const v = series.slotValues(APPS, series.stats(APPS, [], '2026-09-24'), {}, null);
    assert.ok(!('累計' in v));
    assert.strictEqual(v.DAY, '31');
  });

  console.log('\n点検');

  const values = { DAY: '3', '累計': '4,400円' };

  await check('AI が自分で数字を書いたら止める', () => {
    const f = series.check({ x: '今日は売上5万円を突破しました' }, { values });
    assert.ok(f.some((x) => x.severity === 'error' && /数字/.test(x.message)));
  });

  await check('差し込み口・ハッシュタグ・本人が入れた言葉の中の数字は通す', () => {
    const f = series.check({ x: 'DAY{DAY}、累計{累計}。#30日で30アプリ A8.netに登録' }, { values, allowed: ['A8.net'] });
    assert.deepStrictEqual(f.filter((x) => x.severity === 'error'), []);
  });

  await check('知らない差し込み口（{年収}）は止める', () => {
    assert.ok(series.check({ x: '年収{年収}を目指す' }, { values }).some((x) => /年収/.test(x.message)));
  });

  await check('「誰でも簡単に稼げる」は止め、自分の記録として「稼げた」は通す', () => {
    for (const t of ['誰でも簡単に稼げる方法', 'あなたも稼げます', '不労所得を作ろう']) {
      assert.ok(series.check({ instagram: t }, { values }).some((x) => x.severity === 'error'), t);
    }
    assert.deepStrictEqual(series.check({ instagram: '今日は{累計}まで来ました。やっと稼げた。' }, { values })
      .filter((x) => x.severity === 'error'), []);
  });

  await check('台本の場面番号や秒数は通し、金額は止める', () => {
    assert.deepStrictEqual(series.check({ script: '場面1（0〜3秒）' }, { values }).filter((x) => x.severity === 'error'), []);
    assert.ok(series.check({ script: '売上は3万円でした' }, { values }).some((x) => x.severity === 'error'));
  });

  await check('案件リンクがあるのに PR 表記が無ければ止める', () => {
    assert.ok(series.check({ instagram: 'おすすめです' }, { values, hasAffiliateLink: true }).some((x) => /PR/.test(x.message)));
  });

  console.log('\n投稿案を作る（AI は偽物）');

  const good = {
    instagram: 'DAY{DAY}。今日は{今日の作業}。売上は{今日の売上}（{今日の内訳}）、累計{累計}。家事分担アプリを公開しました。',
    tiktok: 'DAY{DAY}、累計{累計}！',
    youtubeTitle: '半年で100万 DAY{DAY}｜累計{累計}',
    youtubeDescription: '今日の作業：{今日の作業}\n学び：課金導線は最初に作るべき',
    x: 'DAY{DAY}：累計{累計}（{累計の内訳}）',
    threads: '家事分担アプリを公開しました。皆さんならどう売りますか？',
    hashtags: ['#副業', '#記録'],
    script: '【冒頭2秒のひと言】パソコンを捨てるまで、あと{残り日数}\n【本編】場面1：読み上げ：…',
  };
  const input = { series: MONEY, entries: ENTRIES, onDate: '2026-10-03', inputs: {} };

  await check('差し込み口を本物の値に置き換え、締めの一言と固定タグを付ける', async () => {
    const out = await gen.generate(input, { json: async () => good });
    assert.ok(out.ok, JSON.stringify(out.findings));
    assert.ok(out.posts.instagram.startsWith('DAY3。今日はLP作成（人間1時間／AI30分）、投稿（人間15分）。売上は3,200円（アフィリエイト800円／アプリ収益2,400円）、累計4,400円。'));
    assert.ok(out.posts.instagram.includes('パソコンを捨てるまで、あと179日。'));
    assert.ok(out.posts.instagram.includes('#半年で100万 #DAY3 #副業 #記録'));
    assert.ok(!/\{/.test(out.posts.x), '差し込み口が残っている');
    assert.strictEqual((out.posts.x.match(/#/g) || []).length, 2, 'X のタグは2個まで');
    assert.strictEqual((out.posts.threads.match(/#/g) || []).length, 1, 'Threads のタグは1個');
    assert.ok(out.script.includes('あと179日'));
  });

  await check('依頼文にはその日の記録が入り、作業の時間と金額は入らない', async () => {
    let prompt = '';
    await gen.generate(input, { json: async (req) => { prompt = req.user; return good; } });
    assert.ok(prompt.includes('LP作成') && prompt.includes('家事分担アプリ（月額課金）') && prompt.includes('課金導線'));
    assert.ok(!/[0-9]+分|3,200|2400|800円/.test(prompt.replace(/\{[^}]+\}/g, '')), '時間や金額が依頼文に入っている');
  });

  await check('AI が数字を書いたら指摘を添えて書き直させ、直ればそれを使う', async () => {
    let n = 0; const prompts = [];
    const ask = async (req) => { prompts.push(req.user); n++; return n === 1 ? Object.assign({}, good, { x: '売上5万円突破！' }) : good; };
    const out = await gen.generate(input, { json: ask });
    assert.strictEqual(out.attempts, 2);
    assert.ok(out.ok);
    assert.ok(/直すところ/.test(prompts[1]) && /数字/.test(prompts[1]));
  });

  await check('3回とも直らなければ ok:false で止める（予約させない）', async () => {
    const out = await gen.generate(input, { json: async () => Object.assign({}, good, { instagram: '誰でも簡単に稼げる！' }) });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.attempts, 3);
  });

  console.log(`\n${passed} 件成功 / ${failed} 件失敗`);
  if (failed) process.exit(1);
})();
