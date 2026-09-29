'use strict';
/**
 * lib/benchmark-plan.js（③企画）を確かめる。
 *
 *   node test/benchmark-plan.test.js
 */
const assert = require('assert');
const planMod = require('../lib/benchmark-plan');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); failed++; }
}

const U1 = 'https://www.tiktok.com/@a/video/1';
const U2 = 'https://www.tiktok.com/@b/video/2';

const facts = { genre: 'career', top: [{ url: U1 }, { url: U2 }], topics: [], questions: [], n: { total: 10, growing: 5 } };
const analysis = { summary: ['a', 'b', 'c'], strengths: [], gaps: [], opportunities: [] };

function goodPlan(overrides) {
  return Object.assign({
    name: '穴埋め動画で質問形式を試す',
    aim: 'コメントの質問に答える形で保存を増やす',
    changes: ['冒頭を質問形式にする', '締めに保存を呼びかける'],
    format: 'text',
    auto: true,
    effort: '自動でそのまま作れます',
    verify: '同じ型を10本並べてから、のび率と保存の変化を見ます',
    evidence: [U1],
  }, overrides || {});
}

// テスト用の topicGenerate スタブ（本物の点検規則は使わず、呼ばれ方だけ見る）
function fakeTopicGenerate(behavior) {
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  return {
    norm,
    screen: (candidates, seen) => {
      const kept = [];
      const rejected = [];
      for (const c of candidates || []) {
        const key = norm(c);
        if (seen.has(key)) { rejected.push({ title: c, reason: '重複' }); continue; }
        seen.add(key);
        kept.push(c);
      }
      return { kept, rejected };
    },
    generateTopics: behavior && behavior.generateTopics,
  };
}

(async () => {
  await check('format が text 以外なら auto を false に直す（訂正メモを残す）', async () => {
    const out = await planMod.plan(facts, analysis, {
      genre: 'career', used: [],
      generate: async () => ({
        plans: [
          goodPlan({ name: '顔出し無し解説', format: 'voice', auto: true }),
          goodPlan({ name: '案2' }),
          goodPlan({ name: '案3' }),
        ],
        recommended: 0, why: 'いちばん再現しやすいので',
        topics: Array.from({ length: 20 }, (_, i) => `ネタその${i}案`),
      }),
      topicGenerate: fakeTopicGenerate(),
    });
    const voicePlan = out.plan.plans.find((p) => p.format === 'voice');
    assert.strictEqual(voicePlan.auto, false);
    assert.ok(out.dropped.some((d) => /auto を false に直しました/.test(d.reason)));
  });

  await check('根拠のURLが渡した一覧に無ければ、その案は落ちる', async () => {
    const out = await planMod.plan(facts, analysis, {
      genre: 'career', used: [],
      generate: async () => ({
        plans: [
          goodPlan({ name: '案1', evidence: ['https://www.tiktok.com/@zzz/video/999'] }),
          goodPlan({ name: '案2' }),
          goodPlan({ name: '案3' }),
        ],
        recommended: 1, why: '理由',
        topics: Array.from({ length: 20 }, (_, i) => `ネタその${i}案`),
      }),
      topicGenerate: fakeTopicGenerate(),
    });
    assert.strictEqual(out.plan.plans.length, 2);
    assert.ok(out.dropped.some((d) => d.section === 'plans' && /記録の中にありません/.test(d.reason)));
  });

  await check('aim に出典のない割合が入っていたら、その案は落ちる', async () => {
    const out = await planMod.plan(facts, analysis, {
      genre: 'career', used: [],
      generate: async () => ({
        plans: [
          goodPlan({ name: '案1', aim: '保存が3割増えるはず' }),
          goodPlan({ name: '案2' }),
          goodPlan({ name: '案3' }),
        ],
        recommended: 1, why: '理由',
        topics: Array.from({ length: 20 }, (_, i) => `ネタその${i}案`),
      }),
      topicGenerate: fakeTopicGenerate(),
    });
    assert.strictEqual(out.plan.plans.length, 2);
    assert.ok(out.dropped.some((d) => /出典のない/.test(d.reason)));
  });

  await check('recommended が範囲外なら、先頭の案に直す', async () => {
    const out = await planMod.plan(facts, analysis, {
      genre: 'career', used: [],
      generate: async () => ({
        plans: [goodPlan({ name: '案1' }), goodPlan({ name: '案2' }), goodPlan({ name: '案3' })],
        recommended: 9, why: '理由',
        topics: Array.from({ length: 20 }, (_, i) => `ネタその${i}案`),
      }),
      topicGenerate: fakeTopicGenerate(),
    });
    assert.strictEqual(out.plan.recommended, 0);
    assert.ok(out.dropped.some((d) => d.section === 'recommended'));
  });

  await check('おすすめの案そのものが点検で落ちたら、生き残った先頭に付け替える', async () => {
    const out = await planMod.plan(facts, analysis, {
      genre: 'career', used: [],
      generate: async () => ({
        plans: [
          goodPlan({ name: '案1', evidence: [] }),
          goodPlan({ name: '案2' }),
          goodPlan({ name: '案3' }),
        ],
        recommended: 0, why: '理由',
        topics: Array.from({ length: 20 }, (_, i) => `ネタその${i}案`),
      }),
      topicGenerate: fakeTopicGenerate(),
    });
    assert.strictEqual(out.plan.plans.length, 2);
    assert.strictEqual(out.plan.recommended, 0);
    assert.strictEqual(out.plan.plans[0].name, '案2');
  });

  await check('使える案が2つ未満なら、理由を添えて1回だけ作り直す', async () => {
    const asked = [];
    const out = await planMod.plan(facts, analysis, {
      genre: 'career', used: [],
      generate: async (f, a, allowed, genre, dropped) => {
        asked.push(dropped);
        if (asked.length === 1) {
          return {
            plans: [goodPlan({ name: '案1' }), goodPlan({ name: '案2', evidence: [] }), goodPlan({ name: '案3', evidence: [] })],
            recommended: 0, why: '理由',
            topics: Array.from({ length: 20 }, (_, i) => `ネタその${i}案`),
          };
        }
        return {
          plans: [goodPlan({ name: '案1' }), goodPlan({ name: '案2' }), goodPlan({ name: '案3' })],
          recommended: 0, why: '理由',
          topics: Array.from({ length: 20 }, (_, i) => `ネタその${i}案`),
        };
      },
      topicGenerate: fakeTopicGenerate(),
    });
    assert.strictEqual(out.attempts, 2);
    assert.strictEqual(out.plan.plans.length, 3);
    assert.ok(asked[1].length > 0, '前回落とした理由を渡していない');
  });

  await check('ネタは used との重複を screen で落とし、20本に足りなければ topicGenerate.generateTopics で足す', async () => {
    let genCalls = 0;
    const out = await planMod.plan(facts, analysis, {
      genre: 'career', used: ['退職に関する切り口その0'],
      generate: async () => ({
        plans: [goodPlan({ name: '案1' }), goodPlan({ name: '案2' }), goodPlan({ name: '案3' })],
        recommended: 0, why: '理由',
        // 0番目は used と重複するので screen で落ちる → 19本 → 1本足りない
        topics: Array.from({ length: 20 }, (_, i) => `退職に関する切り口その${i}`),
      }),
      topicGenerate: fakeTopicGenerate({
        generateTopics: async (usedSoFar, o) => {
          genCalls++;
          assert.strictEqual(o.count, 1);
          return { topics: ['新しく足したネタ'], rejected: [] };
        },
      }),
    });
    assert.strictEqual(genCalls, 1);
    assert.strictEqual(out.plan.topics.length, 20);
    assert.ok(out.plan.topics.includes('新しく足したネタ'));
    assert.ok(!out.plan.topics.includes('退職に関する切り口その0'), '使ったネタが残っている');
  });

  // ★ AI の企画なのに、足りないネタの補充が全部転職ネタになった（本番の1回目）。
  await check('ネタの補充にはジャンルを渡す', async () => {
    let gotGenre = null;
    await planMod.plan(Object.assign({}, facts, { genre: 'ai' }), analysis, {
      genre: 'ai', used: [],
      generate: async () => ({ plans: [goodPlan({ name: '案1' }), goodPlan({ name: '案2' })], recommended: 0, why: '理由', topics: [] }),
      topicGenerate: fakeTopicGenerate({
        generateTopics: async (usedSoFar, o) => { gotGenre = o.genre; return { topics: [], rejected: [] }; },
      }),
    });
    assert.strictEqual(gotGenre, 'ai');
  });

  await check('AI の呼び出しが失敗しても投げず、作り直しに進む', async () => {
    let calls = 0;
    const out = await planMod.plan(facts, analysis, {
      genre: 'career', used: [],
      generate: async () => {
        calls++;
        if (calls === 1) throw new Error('通信が落ちた');
        return {
          plans: [goodPlan({ name: '案1' }), goodPlan({ name: '案2' }), goodPlan({ name: '案3' })],
          recommended: 0, why: '理由',
          topics: Array.from({ length: 20 }, (_, i) => `ネタその${i}案`),
        };
      },
      topicGenerate: fakeTopicGenerate(),
    });
    assert.strictEqual(calls, 2);
    assert.strictEqual(out.plan.plans.length, 3);
  });

  console.log(`\n${passed} 件成功 / ${failed} 件失敗`);
  if (failed) process.exit(1);
})();
