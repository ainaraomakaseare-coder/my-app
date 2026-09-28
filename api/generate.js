'use strict';
/**
 * ネタから投稿文を1本作る。
 *
 * 画面の「投稿を作る」に流し込む手前まで。保存はしない。
 * 出てきたものは lib/draft-rules.js で点検し、指摘も一緒に返す。
 * 直すかどうかを決めるのは人間なので、悪い結果でも隠さず返す。
 *
 * ★ 点検の規則は運用アカウントごとに変わる。
 *   account_groups.validation_profile を見て切り替える。
 *   転職側では一人称が嘘になるが、ひろや側は本人の記録なので正しい。
 *
 * ★ 書かせる相手（Claude / OpenAI）は lib/llm.js が決める。
 *   ANTHROPIC_API_KEY か OPENAI_API_KEY の、設定してあるほうを使う。
 */

const auth = require('../lib/auth');
const db = require('../lib/db');
const rules = require('../lib/draft-rules');
const gen = require('../lib/draft-generate');
const topicGen = require('../lib/topic-generate');
const stock = require('../public/topics.json');
const benchmark = require('../lib/benchmark');
const benchmarkStore = require('../lib/benchmark-store');
const benchmarkFacts = require('../lib/benchmark-facts');
const benchmarkAnalyze = require('../lib/benchmark-analyze');
const benchmarkPlan = require('../lib/benchmark-plan');

module.exports = async function handler(req, res) {
  if (!auth.guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

    // ★ 「まとめて仕込む」のネタを考えさせる。関数の数（Vercel の上限）を増やさないよう、同じ入口に置く。
    if (body.action === 'topics') return res.status(200).json(await topics(body));

    // ★ 分析部隊②③。こちらも同じ理由で同じ入口に置く（api/ は入口の作法だけ、中身は lib/）。
    if (body.action === 'bench-analyze') return res.status(200).json(await benchAnalyze(body));
    if (body.action === 'bench-plan') return res.status(200).json(await benchPlan(body));

    const topicTitle = String(body.title || '').trim();
    if (!topicTitle) return res.status(400).json({ error: 'ネタを入力してください。' });

    // 運用アカウントに紐づく規則を引く。指定が無ければ安全側（キュレーター）。
    let profileId = null;
    if (body.group_id) {
      const groups = await db.listGroups();
      const g = groups.find((x) => x.id === body.group_id);
      profileId = g && g.validation_profile;
    }

    // 過去のネタを渡して切り口の重複を避ける。管理用タイトルを流用する。
    const past = (await db.rest('posts', {
      query: { select: 'title', order: 'created_at.desc', limit: 40 },
    })) || [];

    const result = await gen.generateDraft(
      {
        topicId: body.topic_id || topicTitle,
        title: topicTitle,
        tone: body.tone || 'calm',
        direction: body.direction || '',
        hasAffiliateLink: !!body.has_affiliate_link,
        groupId: body.group_id || null,
        avoidTitles: past.map((p) => p.title).filter(Boolean),
      },
      { profile: rules.profileFor(profileId) }
    );

    return res.status(200).json({
      ok: result.ok,
      attempts: result.attempts,
      draft: result.draft,
      // ★ 実際に投稿する本文は、ここで組み立てて返す。
      //   ハッシュタグの付け方（X だけ2個まで、など）を画面側にも書くと、
      //   いつか片方だけ直されて、点検した文と投稿する文がずれる。
      posts: result.draft ? {
        igCaption: rules.captionWithTags(result.draft.igCaption, result.draft.hashtags, 'instagram'),
        ttCaption: rules.captionWithTags(result.draft.ttCaption, result.draft.hashtags, 'tiktok'),
        xText:     rules.captionWithTags(result.draft.xText,     result.draft.hashtags, 'x'),
        ytDescription: rules.captionWithTags(result.draft.igCaption, result.draft.hashtags, 'youtube'),
        thText:    rules.threadsText(result.draft, !!body.has_affiliate_link),
      } : null,
      findings: result.findings,
      profile: rules.profileFor(profileId).label,
    });
  } catch (err) {
    // 鍵の設定漏れやモデル名の間違いは、利用者が直せる。
    // 500 で潰さず、直し方（hint）ごと返す。
    const status = err.userError ? 400 : 500;
    return res.status(status).json({ error: err.message, hint: err.hint });
  }
};

/**
 * すでに使ったネタ・タイトルを集める。
 *
 * ★ 重複を避ける相手は3つ。過去の投稿のタイトル（動画のタイトル）、
 *   用意してあるネタ（public/topics.json）、呼び出し元がその場で足したいネタ。
 *   投稿のタイトルは文案から付くのでネタそのものとは少し違うが、切り口の重なりは拾える。
 *
 * ★ 「まとめて仕込む」のネタ出し（topics）と、分析部隊③の企画（bench-plan）の
 *   両方が同じ「もう使った」の集め方を必要とするので、ここに1つだけ置く。
 */
async function usedTitles(extra) {
  const past = (await db.rest('posts', {
    query: { select: 'title', order: 'created_at.desc', limit: 200 },
  })) || [];
  return [
    ...past.map((p) => p.title),
    ...(stock.topics || []).map((t) => t.title),
    ...(Array.isArray(extra) ? extra : []),
  ];
}

/** ネタを20本考えさせる。 */
async function topics(body) {
  const used = await usedTitles(body.used);
  const result = await topicGen.generateTopics(used, { count: topicGen.COUNT });
  return { topics: result.topics, ok: result.ok, rejected: result.rejected };
}

/**
 * 分析部隊②。集めた記録から事実を計算し、LLM に気づきを書かせる。
 *
 * ★ facts（数字）は機械が計算し、LLM はそれを言葉にするだけ（lib/benchmark-analyze.js）。
 *   結果は research_runs に積んでおき、あとで画面を開き直しても見られるようにする。
 */
async function benchAnalyze(body) {
  const genre = String(body.genre || '');
  if (!benchmark.GENRES[genre]) {
    const e = new Error(`genre は ${Object.keys(benchmark.GENRES).join(' / ')} のどれか`);
    e.userError = true;
    throw e;
  }

  const items = await benchmarkStore.listItems(db, genre, { days: 30 });
  if (!items.length) {
    const e = new Error('まだ集めた投稿がありません。先に YouTube を集めるか、Chrome の結果を取り込んでください。');
    e.userError = true;
    throw e;
  }

  const run = await benchmarkStore.createRun(db, genre);
  try {
    const f = benchmarkFacts.facts(items, body.own || null, { genre });
    const a = await benchmarkAnalyze.analyze(f);
    await benchmarkStore.updateRun(db, run.id, { facts: f, analysis: a.analysis });
    return { run_id: run.id, facts: f, analysis: a.analysis, dropped: a.dropped };
  } catch (err) {
    await benchmarkStore.updateRun(db, run.id, { status: 'failed', error: err.message });
    throw err;
  }
}

/**
 * 分析部隊③。②の結果（facts・analysis）から、次の企画とネタ20本を LLM に考えさせる。
 */
async function benchPlan(body) {
  const runId = String(body.run_id || '');
  const run = runId ? await benchmarkStore.getRun(db, runId) : null;
  if (!run) {
    const e = new Error('指定された分析（run_id）が見つかりません。');
    e.userError = true;
    throw e;
  }
  if (!run.facts || !run.analysis) {
    const e = new Error('その分析はまだ終わっていません。先に②分析を行ってください。');
    e.userError = true;
    throw e;
  }

  try {
    const used = await usedTitles([]);
    const p = await benchmarkPlan.plan(run.facts, run.analysis, { genre: run.genre, used });
    await benchmarkStore.updateRun(db, run.id, { status: 'done', plan: p.plan });
    return { run_id: run.id, plan: p.plan, dropped: p.dropped };
  } catch (err) {
    await benchmarkStore.updateRun(db, run.id, { status: 'failed', error: err.message });
    throw err;
  }
}
