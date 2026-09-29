'use strict';
/**
 * lib/topic-generate.js（「まとめて仕込む」のネタを AI に考えさせる）を確かめる。
 *
 * ★ 守りたいのは3つ。
 *   1. 使ったネタと同じもの（言い換えの空白・記号違いも含む）は入れない
 *   2. 体験・出典のない数値・断定が入ったネタは入れない（文案と同じ点検）
 *   3. 落としたぶんは、理由を添えて足りない本数だけ作り直させる
 *
 *   node test/topics.test.js
 */
const assert = require('assert');
const topicGen = require('../lib/topic-generate');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); failed++; }
}

const many = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}のときに気をつけること${i + 1}`);

(async () => {
  await check('一度で揃えば、20本をそのまま返す（AI は1回だけ）', async () => {
    let calls = 0;
    const out = await topicGen.generateTopics([], {
      generate: async (need) => { calls++; return many('面接', need); },
    });
    assert.strictEqual(out.topics.length, 20);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(calls, 1);
  });

  await check('使ったネタと同じものは落とす（空白や記号の違いも同じとみなす）', async () => {
    const used = ['面接で落ちる人がやりがちなこと'];
    const out = await topicGen.generateTopics(used, {
      count: 2,
      generate: async () => ['面接で 落ちる人が、やりがちなこと', '退職を切り出すときの順番', '求人票で見落とすと危ない欄'],
    });
    assert.deepStrictEqual(out.topics, ['退職を切り出すときの順番', '求人票で見落とすと危ない欄']);
  });

  await check('同じ回の中での重複も落とす', async () => {
    const out = await topicGen.generateTopics([], {
      count: 2, maxAttempts: 1,
      generate: async () => ['退職を切り出すときの順番', '退職を切り出すときの順番'],
    });
    assert.deepStrictEqual(out.topics, ['退職を切り出すときの順番']);
    assert.strictEqual(out.ok, false);
  });

  await check('断定・出典のない数値・一人称の体験が入ったネタは落とす', async () => {
    const r = topicGen.screen([
      '必ず年収が上がる転職の順番',
      '8割の人が失敗する面接の答え方',
      '私が転職して後悔したこと',
      '面接で落ちる人の共通点',
    ], new Set());
    assert.deepStrictEqual(r.kept, ['面接で落ちる人の共通点']);
    assert.strictEqual(r.rejected.length, 3);
  });

  await check('長すぎる・短すぎるネタは落とす', async () => {
    const r = topicGen.screen(['短い', 'あ'.repeat(topicGen.TITLE_MAX + 1)], new Set());
    assert.deepStrictEqual(r.kept, []);
  });

  await check('落としたぶんは、理由を添えて足りない本数だけ作り直させる', async () => {
    const asked = [];
    const out = await topicGen.generateTopics([], {
      count: 3,
      generate: async (need, used, rejected) => {
        asked.push({ need, used: used.slice(), rejected });
        return asked.length === 1
          ? ['退職を切り出すときの順番', '必ず内定が取れる面接の準備', '求人票で見落とすと危ない欄']
          : ['内定辞退の連絡で失礼にならない言い方'];
      },
    });
    assert.strictEqual(out.topics.length, 3);
    assert.strictEqual(asked[1].need, 1, '足りない本数だけ頼んでいない');
    assert.ok(asked[1].rejected.some((r) => r.title === '必ず内定が取れる面接の準備'), '落とした理由を渡していない');
    assert.ok(asked[1].used.includes('退職を切り出すときの順番'), '選んだネタを「使ったもの」に足していない');
  });

  await check('AI が失敗しても投げず、作り直しに進む', async () => {
    let calls = 0;
    const out = await topicGen.generateTopics([], {
      count: 2,
      generate: async (need) => { calls++; if (calls === 1) throw new Error('通信が落ちた'); return many('退職', need); },
    });
    assert.strictEqual(out.topics.length, 2);
  });

  await check('依頼文には使ったネタが入る', () => {
    const msg = topicGen.buildUserMessage(20, ['面接で落ちる人がやりがちなこと'], []);
    assert.ok(msg.includes('面接で落ちる人がやりがちなこと'));
    assert.ok(msg.includes('20本'));
  });

  // ★ 分析部隊③で AI（ひろや）の企画を作ったとき、補充のネタが全部転職になった。
  await check('ジャンルで指示を切り替える（ai はひろや、既定は転職）', async () => {
    assert.ok(topicGen.requestFor(20, [], [], 'ai').system.includes('ひろや'));
    assert.ok(!topicGen.requestFor(20, [], [], 'ai').system.includes('第二新卒'));
    assert.ok(topicGen.requestFor(20, [], []).system.includes('第二新卒'), '既定は転職のまま');
    let got = null;
    await topicGen.generateTopics([], { count: 1, genre: 'ai', generate: async (need, used, rejected, genre) => { got = genre; return ['AIに頼むと失敗する指示の出し方']; } });
    assert.strictEqual(got, 'ai', 'generate にジャンルが渡っていない');
  });

  console.log(`\n${passed} 件成功 / ${failed} 件失敗`);
  if (failed) process.exit(1);
})();
