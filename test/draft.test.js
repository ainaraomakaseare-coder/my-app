'use strict';
/**
 * ネットワークに出ずに、投稿文の点検と生成の骨組みを確かめる。
 * Claude を呼ぶ部分だけ偽物に差し替えて、その手前まで全部通す。
 *
 *   node test/draft.test.js
 */
const assert = require('assert');

const rules = require('../lib/draft-rules');
const scope = require('../lib/account-scope');
const gen = require('../lib/draft-generate');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['ok', name]); }
  catch (err) { results.push(['NG', name + ' → ' + err.message]); }
}

/** 実物の reel_09。ここが通らなくなったら点検が厳しすぎる。 */
const reel09 = {
  kicker: '不安な人へ!?',
  title: '転職活動がバレにくい進め方',
  rows: [
    { question: '職場で話す人ほど', answer: '広まる' },
    { question: '同僚に相談すると', answer: '伝わる' },
    { question: '急に有給を取ると', answer: '目立つ' },
    { question: 'SNSで書く人ほど', answer: '特定される' },
    { question: '服装が変わると', answer: '察される' },
    { question: 'いちばん確実なのは', answer: '黙ること' },
  ],
  igCaption: '5番がいちばん刺さる…。第二新卒の口コミを集めた結果です。他にもあったらコメントで教えてください',
  ttCaption: '5番がいちばん刺さる…。第二新卒の口コミを集めた結果です',
  xText: '「転職活動がバレにくい進め方」6つ、答え合わせ。3番が意外と知られてないと思う。',
  tone: 'calm',
  hasAffiliateLink: false,
};
const draft = (over) => Object.assign({}, reel09, over || {});

/** ひろや側。本人の実践記録なので一人称で書くのが正しい。 */
const personal = draft({
  kicker: '12日目!?',
  title: '音声入力アプリを作った',
  igCaption: '今日は音声入力アプリを作ってみました。詰まったのは3番です',
  ttCaption: '12日目。音声入力アプリを作ってみました',
  xText: '12日目。音声入力アプリを作ってみました。',
});

(async () => {
  // ---- 既存の投稿が通ること ------------------------------------------------

  await check('reel_09 は指摘ゼロ', () => {
    assert.deepStrictEqual(rules.validateDraft(reel09), []);
  });

  // ---- 一人称の体験（最大の事故ポイント） ----------------------------------

  await check('代名詞＋過去形を弾く', () => {
    const f = rules.findingsOf(draft({ igCaption: '私も転職しました' }), 'first-person-experience');
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].severity, 'error');
  });

  await check('代名詞がなくても「登録してみました」は体験', () => {
    const f = rules.findingsOf(draft({ igCaption: 'エージェントに登録してみました' }), 'first-person-experience');
    assert.strictEqual(f.length, 1);
  });

  await check('「作ってみました」も体験（動詞を列挙しないので拾える）', () => {
    const f = rules.findingsOf(draft({ igCaption: 'アプリを作ってみました' }), 'first-person-experience');
    assert.strictEqual(f.length, 1);
  });

  await check('「私も引き止められました」も体験', () => {
    const f = rules.findingsOf(draft({ igCaption: '私も引き止められました' }), 'first-person-experience');
    assert.strictEqual(f.length, 1);
  });

  await check('「自分を否定しないで」は体験ではない', () => {
    const d = draft({ igCaption: '自分を否定しないでください、という声がありました' });
    assert.deepStrictEqual(rules.findingsOf(d, 'first-person-experience'), []);
  });

  // ---- 出典のない数値・断定 ------------------------------------------------

  await check('「利用者の8割が」を弾く', () => {
    assert.ok(rules.findingsOf(draft({ igCaption: '利用者の8割が満足' }), 'unsourced-number').length > 0);
  });

  await check('「6つ」「3番」は数値ではない', () => {
    assert.deepStrictEqual(rules.findingsOf(reel09, 'unsourced-number'), []);
  });

  await check('成果と結びついた断定は error', () => {
    const f = rules.findingsOf(draft({ igCaption: '登録すれば必ず年収が上がります' }), 'absolute-claim');
    assert.strictEqual(f[0].severity, 'error');
  });

  await check('「いちばん確実なのは」を誤検出しない', () => {
    assert.deepStrictEqual(rules.findingsOf(reel09, 'absolute-claim'), []);
  });

  // ---- 出典の断り ----------------------------------------------------------

  await check('キャプションに断りがなければ error', () => {
    const f = rules.findingsOf(draft({ igCaption: '5番がいちばん刺さる…。' }), 'missing-sourcing');
    assert.strictEqual(f.length, 1);
  });

  await check('X用の本文には断りを求めない', () => {
    const f = rules.findingsOf(draft({ xText: '6つ、答え合わせ。' }), 'missing-sourcing');
    assert.deepStrictEqual(f, []);
  });

  // ---- PR表記 --------------------------------------------------------------

  await check('案件つきで表記がなければ error', () => {
    assert.ok(rules.findingsOf(draft({ hasAffiliateLink: true }), 'missing-pr-label').length > 0);
  });

  await check('#PR があれば通る', () => {
    const d = draft({
      hasAffiliateLink: true,
      igCaption: '口コミを集めた結果です #PR',
      ttCaption: '口コミを集めた結果です #PR',
    });
    assert.deepStrictEqual(rules.findingsOf(d, 'missing-pr-label'), []);
  });

  // ---- 画面に収まるか ------------------------------------------------------

  await check('問い＋答えが15字ぶんを超えると warning', () => {
    const rows = reel09.rows.slice();
    rows[0] = { question: '職場でうっかり話してしまうと', answer: '一気に広まる' };
    const f = rules.findingsOf(draft({ rows }), 'row-too-wide');
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].severity, 'warning');
  });

  await check('半角英数は半分の幅で数える（SNSの行は通る）', () => {
    assert.deepStrictEqual(rules.findingsOf(reel09, 'row-too-wide'), []);
  });

  await check('6行でなければ error', () => {
    const f = rules.findingsOf(draft({ rows: reel09.rows.slice(0, 5) }), 'row-count');
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].severity, 'error');
  });

  // ---- 運用アカウントごとの規則 --------------------------------------------

  await check('ひろや側では一人称を弾かない', () => {
    assert.deepStrictEqual(rules.validateDraft(personal, rules.PERSONAL), []);
  });

  await check('同じ投稿をキュレーター規則にかけると弾かれる', () => {
    const f = rules.validateDraft(personal, rules.CURATOR);
    assert.ok(f.some((x) => x.rule === 'first-person-experience'));
  });

  await check('数値と断定はどちらの規則でも弾く', () => {
    const d = Object.assign({}, personal, { igCaption: '利用者の8割が満足しています' });
    assert.ok(rules.findingsOf(d, 'unsourced-number', rules.PERSONAL).length > 0);
  });

  await check('知らないプロファイルは安全側に倒れる', () => {
    assert.strictEqual(rules.profileFor('なにこれ').id, 'curator');
  });

  // ---- 投稿先の取り違え ----------------------------------------------------

  const affi = { id: 'a1', group_id: 'g_affi', network: 'instagram', label: 'アフィリ用' };
  const kikaku = { id: 'a2', group_id: 'g_kikaku', network: 'instagram', label: '企画用' };
  const xAffi = { id: 'a3', group_id: 'g_affi', network: 'x', label: 'アフィリ用' };

  await check('選んだ運用アカウントの連携先しか出さない', () => {
    assert.deepStrictEqual(scope.accountsFor('g_affi', [affi, kikaku, xAffi]).map((a) => a.id), ['a1', 'a3']);
  });

  await check('同じ運用アカウントなら通す', () => {
    assert.strictEqual(scope.checkTarget({ group_id: 'g_affi' }, affi), null);
  });

  await check('別の運用アカウントへは出さない', () => {
    const issue = scope.checkTarget({ group_id: 'g_affi' }, kikaku);
    assert.strictEqual(issue.code, 'cross-account');
    assert.ok(issue.message.includes('企画用'));
  });

  await check('案件リンクつきの投稿は X に出せない（A8の掲載対象外）', () => {
    const issue = scope.checkTarget({ group_id: 'g_affi', hasAffiliateLink: true }, xAffi);
    assert.strictEqual(issue.code, 'affiliate-not-allowed');
  });

  await check('案件リンクなしなら X に出せる', () => {
    assert.strictEqual(scope.checkTarget({ group_id: 'g_affi', hasAffiliateLink: false }, xAffi), null);
  });

  await check('期限切れの連携先には出さない', () => {
    const dead = Object.assign({}, affi, { expires_at: '2020-01-01T00:00:00Z' });
    assert.strictEqual(scope.checkTarget({ group_id: 'g_affi' }, dead).code, 'expired');
  });

  await check('別アカウントかつ期限切れなら、別アカウントを先に言う', () => {
    const dead = Object.assign({}, kikaku, { expires_at: '2020-01-01T00:00:00Z' });
    assert.strictEqual(scope.checkTarget({ group_id: 'g_affi' }, dead).code, 'cross-account');
  });

  await check('複数の投稿先をまとめて見る（api/posts.js の呼び方）', () => {
    const issues = scope.checkTargets({ group_id: 'g_affi' }, [affi, kikaku]);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].accountId, 'a2');
  });

  await check('全部そろっていれば指摘なし', () => {
    assert.deepStrictEqual(scope.checkTargets({ group_id: 'g_affi' }, [affi, xAffi]), []);
  });

  await check('投稿先が空でも落ちない', () => {
    assert.deepStrictEqual(scope.checkTargets({ group_id: 'g_affi' }, []), []);
  });

  // ---- 生成 → 点検 → 作り直し ----------------------------------------------

  const clean = {
    kicker: '迷ってる人へ!?',
    title: '引き止められたときの返し方',
    rows: [
      { question: 'その場で答えると', answer: '覆る' },
      { question: '口約束のままだと', answer: '消える' },
      { question: '理由を蒸し返すと', answer: '長引く' },
      { question: '退職日を動かすと', answer: '延びる' },
      { question: '条件交渉に乗ると', answer: '残される' },
      { question: 'いちばん確実なのは', answer: '記録' },
    ],
    igCaption: '引き止めは一度はある、という声が多かったです',
    ttCaption: '引き止めは一度はある、という声が多かったです',
    xText: '6つ、答え合わせ。',
    tone: 'calm',
  };
  const dirty = Object.assign({}, clean, { igCaption: '私も引き止められました' });
  const topic = { topicId: 'N03', title: '引き止められたときの受け答え', tone: 'calm', groupId: 'g_affi' };

  /** 用意した順に返すだけの偽物。何を渡されたかを記録する。 */
  function stub(queue) {
    const seen = [];
    return {
      seen,
      generate: async (t, previous, attempt) => {
        seen.push({ topic: t, previous, attempt });
        const next = queue.shift();
        if (!next) throw new Error('呼ばれすぎです');
        return next;
      },
    };
  }

  await check('一度で通れば1回しか呼ばない', async () => {
    const s = stub([clean]);
    const r = await gen.generateDraft(topic, { generate: s.generate });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.attempts, 1);
    assert.strictEqual(s.seen.length, 1);
  });

  await check('呼び出し側が決める値を差し込む', async () => {
    const s = stub([clean]);
    const r = await gen.generateDraft(topic, { generate: s.generate });
    assert.strictEqual(r.draft.topicId, 'N03');
    assert.strictEqual(r.draft.groupId, 'g_affi');
    assert.strictEqual(r.draft.hasAffiliateLink, false);
  });

  await check('error が出たら作り直す', async () => {
    const s = stub([dirty, clean]);
    const r = await gen.generateDraft(topic, { generate: s.generate });
    assert.strictEqual(r.attempts, 2);
    assert.strictEqual(r.ok, true);
  });

  await check('作り直しのときは、何が悪かったかを渡す', async () => {
    const s = stub([dirty, clean]);
    await gen.generateDraft(topic, { generate: s.generate });
    assert.strictEqual(s.seen[0].previous, null);
    assert.ok(s.seen[1].previous.findings.some((f) => f.rule === 'first-person-experience'));
  });

  await check('直らなければ、最後の結果と指摘を返す（投げない）', async () => {
    const s = stub([dirty, dirty, dirty]);
    const r = await gen.generateDraft(topic, { generate: s.generate, maxAttempts: 3 });
    assert.strictEqual(r.attempts, 3);
    assert.strictEqual(r.ok, false);
    assert.ok(r.findings.some((f) => f.rule === 'first-person-experience'));
  });

  await check('生成が例外を投げても、作り直しに進む', async () => {
    let n = 0;
    const generate = async () => {
      n += 1;
      if (n === 1) throw new Error('JSONが壊れていた');
      return clean;
    };
    const r = await gen.generateDraft(topic, { generate });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.attempts, 2);
  });

  await check('warning だけなら作り直さない', async () => {
    const wide = Object.assign({}, clean, { title: '引き止められたときのすごく上手な返し方' });
    const s = stub([wide]);
    const r = await gen.generateDraft(topic, { generate: s.generate });
    assert.strictEqual(s.seen.length, 1);
    assert.strictEqual(r.ok, true);
    assert.ok(r.findings.every((f) => f.severity === 'warning'));
  });

  await check('案件つきで PR表記が無ければ作り直す', async () => {
    const withPr = Object.assign({}, clean, {
      igCaption: '引き止めは一度はある、という声が多かったです #PR',
      ttCaption: '引き止めは一度はある、という声が多かったです #PR',
    });
    const s = stub([clean, withPr]);
    const r = await gen.generateDraft(Object.assign({}, topic, { hasAffiliateLink: true }), { generate: s.generate });
    assert.strictEqual(s.seen.length, 2);
    assert.strictEqual(r.ok, true);
  });

  // ---- リクエストの組み立て ------------------------------------------------

  await check('構造化出力の形で投げている', () => {
    const p = gen.buildParams(topic, null);
    assert.strictEqual(p.model, 'claude-opus-5');
    assert.strictEqual(p.output_config.format.type, 'json_schema');
    assert.strictEqual(p.output_config.format.schema.properties.rows.minItems, 6);
    assert.strictEqual(p.system[0].cache_control.type, 'ephemeral');
  });

  await check('案件つきのときは X に載せないよう伝える', () => {
    const msg = gen.buildUserMessage(Object.assign({}, topic, { hasAffiliateLink: true }), null);
    assert.ok(msg.includes('X は A8.net の掲載対象外'));
  });

  await check('まとめ生成は custom_id を付ける', () => {
    const reqs = gen.buildBatchRequests([topic, Object.assign({}, topic, { topicId: 'N05' })]);
    assert.deepStrictEqual(reqs.map((r) => r.custom_id), ['N03', 'N05']);
  });

  const bad = results.filter((r) => r[0] === 'NG');
  for (const [mark, name] of results) console.log(`  ${mark === 'ok' ? '✓' : '✗'} ${name}`);
  console.log(`\n  ${results.length - bad.length} / ${results.length} 件成功`);
  process.exit(bad.length ? 1 : 0);
})();
