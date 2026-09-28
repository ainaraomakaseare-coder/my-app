'use strict';
/**
 * lib/benchmark-analyze.js（②分析）を確かめる。
 *
 * ★ 守りたいのは、数字を LLM に作らせず、機械が必ず点検すること。
 *   - 数字（半角・全角）が入った文は落とす
 *   - 渡していないURLを根拠にしたら落とす
 *   - 根拠が空なら落とす
 *   - 断定・出典のない数値・一人称の体験（プロフィール次第）は落とす
 *   - own が無ければ gaps は必ず空（作り直しの理由にはしない）
 *   - 落としすぎたら、理由を添えて1回だけ作り直す
 *
 *   node test/benchmark-analyze.test.js
 */
const assert = require('assert');
const analyzeMod = require('../lib/benchmark-analyze');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); failed++; }
}

const U1 = 'https://www.tiktok.com/@a/video/1';
const U2 = 'https://www.tiktok.com/@b/video/2';
const U3 = 'https://www.tiktok.com/@c/video/3';

function baseFacts(overrides) {
  return Object.assign({
    genre: 'career',
    n: { total: 10, growing: 5, byPlatform: { tiktok: 10 } },
    top: [{ url: U1 }, { url: U2 }],
    topics: [{ topic: '退職', total: 3, growing: 2, questions: 0, medianRatio: 20, sampleUrls: [U3] }],
    questions: [],
    openings: [],
    own: { accounts: 1, posts: 5, withMetrics: 5, medianViews: 100, format: 'text', titles: [] },
  }, overrides || {});
}

const goodEntry = (evidence) => ({ text: '冒頭で問いを投げているものが多いという仮説です', evidence });
const GOOD_SUMMARY = ['一つ目のまとめです', '二つ目のまとめです', '三つ目のまとめです'];

(async () => {
  await check('根拠のURL一覧は top / topics / questions から集める', () => {
    const facts = baseFacts({
      questions: [{ text: '質問', count: 2, urls: ['https://www.tiktok.com/@d/video/4'] }],
    });
    const allowed = analyzeMod.allowedUrls(facts);
    assert.ok(allowed.has(U1) && allowed.has(U2) && allowed.has(U3));
    assert.ok(allowed.has('https://www.tiktok.com/@d/video/4'));
  });

  await check('数字（半角・全角）が入った文は落とす', async () => {
    const facts = baseFacts();
    const out = await analyzeMod.analyze(facts, {
      maxAttempts: 1,
      generate: async () => ({
        summary: GOOD_SUMMARY,
        strengths: [
          { text: '冒頭に問いがある投稿が多い', evidence: [U1] },
          { text: '半角数字は無いが全角の１２３が入った文', evidence: [U1] },
        ],
        gaps: [],
        opportunities: [],
      }),
    });
    assert.strictEqual(out.analysis.strengths.length, 1);
    assert.ok(out.dropped.some((d) => /数字/.test(d.reason)));
  });

  await check('渡していないURLを根拠にしたら落とす', async () => {
    const facts = baseFacts();
    const out = await analyzeMod.analyze(facts, {
      maxAttempts: 1,
      generate: async () => ({
        summary: GOOD_SUMMARY,
        strengths: [goodEntry(['https://www.tiktok.com/@zzz/video/999'])],
        gaps: [],
        opportunities: [],
      }),
    });
    assert.strictEqual(out.analysis.strengths.length, 0);
    assert.ok(out.dropped.some((d) => /記録の中にありません/.test(d.reason)));
  });

  await check('根拠が空なら落とす', async () => {
    const facts = baseFacts();
    const out = await analyzeMod.analyze(facts, {
      maxAttempts: 1,
      generate: async () => ({
        summary: GOOD_SUMMARY,
        strengths: [{ text: '冒頭に問いがある', evidence: [] }],
        gaps: [],
        opportunities: [],
      }),
    });
    assert.strictEqual(out.analysis.strengths.length, 0);
    assert.ok(out.dropped.some((d) => /根拠（evidence）が空/.test(d.reason)));
  });

  await check('断定的な言い方は落とす', async () => {
    const facts = baseFacts();
    const out = await analyzeMod.analyze(facts, {
      maxAttempts: 1,
      generate: async () => ({
        summary: GOOD_SUMMARY,
        strengths: [{ text: 'この形で撮れば必ず内定が決まります', evidence: [U1] }],
        gaps: [],
        opportunities: [],
      }),
    });
    assert.strictEqual(out.analysis.strengths.length, 0);
    assert.ok(out.dropped.some((d) => d.section === 'strengths'));
  });

  await check('own が無いジャンルでは gaps を必ず空にする（作り直しの理由にはしない）', async () => {
    const facts = baseFacts({ own: null });
    let calls = 0;
    const out = await analyzeMod.analyze(facts, {
      generate: async () => {
        calls++;
        return {
          summary: GOOD_SUMMARY,
          strengths: [goodEntry([U1])],
          gaps: [goodEntry([U1])],
          opportunities: [],
        };
      },
    });
    assert.strictEqual(out.analysis.gaps.length, 0);
    assert.strictEqual(calls, 1, 'own が無いだけで作り直しさせてはいけない');
    assert.strictEqual(out.attempts, 1);
  });

  await check('strengths が全部落ちて growing が3以上なら、理由を添えて1回だけ作り直す', async () => {
    const facts = baseFacts({ n: { total: 10, growing: 5, byPlatform: {} } });
    const asked = [];
    const out = await analyzeMod.analyze(facts, {
      generate: async (f, allowed, dropped) => {
        asked.push(dropped);
        if (asked.length === 1) {
          return {
            summary: GOOD_SUMMARY,
            strengths: [{ text: 'これは必ず内定が決まります', evidence: [U1] }],
            gaps: [],
            opportunities: [],
          };
        }
        return {
          summary: GOOD_SUMMARY,
          strengths: [goodEntry([U1])],
          gaps: [],
          opportunities: [],
        };
      },
    });
    assert.strictEqual(out.attempts, 2);
    assert.strictEqual(out.analysis.strengths.length, 1);
    assert.ok(asked[1].length > 0, '前回落とした理由を渡していない');
  });

  await check('summary がちょうど3行そろわなければ、作り直しに回る', async () => {
    const facts = baseFacts();
    let calls = 0;
    const out = await analyzeMod.analyze(facts, {
      generate: async () => {
        calls++;
        return {
          summary: calls === 1 ? ['行1だけ'] : GOOD_SUMMARY,
          strengths: [],
          gaps: [],
          opportunities: [],
        };
      },
    });
    assert.strictEqual(calls, 2);
    assert.strictEqual(out.analysis.summary.length, 3);
  });

  await check('AI の呼び出しが失敗しても投げず、作り直しに進む', async () => {
    let calls = 0;
    const out = await analyzeMod.analyze(baseFacts(), {
      generate: async () => {
        calls++;
        if (calls === 1) throw new Error('通信が落ちた');
        return { summary: GOOD_SUMMARY, strengths: [], gaps: [], opportunities: [] };
      },
    });
    assert.strictEqual(calls, 2);
    assert.strictEqual(out.analysis.summary.length, 3);
  });

  await check('opportunities は topic・text・evidence をそれぞれ点検する', async () => {
    const facts = baseFacts();
    const out = await analyzeMod.analyze(facts, {
      maxAttempts: 1,
      generate: async () => ({
        summary: GOOD_SUMMARY,
        strengths: [],
        gaps: [],
        opportunities: [
          { topic: '退職', text: '質問に答える切り口が伸びやすいという仮説です', evidence: [U1] },
          { topic: '', text: '質問に答える', evidence: [U1] },
        ],
      }),
    });
    assert.strictEqual(out.analysis.opportunities.length, 1);
    assert.ok(out.dropped.some((d) => d.section === 'opportunities' && /topic/.test(d.reason)));
  });

  console.log(`\n${passed} 件成功 / ${failed} 件失敗`);
  if (failed) process.exit(1);
})();
