'use strict';
/**
 * 分析部隊の③企画。②分析（lib/benchmark-analyze.js）の結果をもとに、
 * 次にやる3つの案と、「まとめて仕込む」に並べるネタ20本を LLM に考えさせる。
 *
 * ★ 数字と URL は事実（facts）にある物だけ。LLM に作らせない考え方は
 *   lib/benchmark-analyze.js と同じ（CLAUDE.md「嘘を書かない」）。
 * ★ 自動で作れる型は決まっている（文字の穴埋め6問の動画だけ）。
 *   それ以外の型を「自動」にされても実際には作れないので、機械で直す。
 * ★ ネタは lib/topic-generate.js の点検・作り直しをそのまま使う
 *   （二重に書かない。切り口の重複回避・体験談排除は同じ仕組みでよい）。
 */

const rules = require('./draft-rules');
const benchmark = require('./benchmark');
const analyzeMod = require('./benchmark-analyze');
const llm = require('./llm');

const MAX_ATTEMPTS = 2;   // Vercel の1回60秒に収めるため、作り直しは1回まで
const TOPIC_COUNT = 20;

const SCHEMA_NAME = 'benchmark_plan';

const PERCENT_RE = /\d+\s*[%％割]/;

const SCHEMA = {
  type: 'object',
  properties: {
    plans: {
      type: 'array', minItems: 3, maxItems: 3,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          aim: { type: 'string' },
          changes: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } },
          format: { type: 'string', enum: Object.keys(benchmark.FORMATS) },
          auto: { type: 'boolean' },
          effort: { type: 'string' },
          verify: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'aim', 'changes', 'format', 'auto', 'effort', 'verify', 'evidence'],
        additionalProperties: false,
      },
    },
    recommended: { type: 'integer', minimum: 0, maximum: 2 },
    why: { type: 'string' },
    topics: { type: 'array', minItems: TOPIC_COUNT, maxItems: TOPIC_COUNT, items: { type: 'string' } },
  },
  required: ['plans', 'recommended', 'why', 'topics'],
  additionalProperties: false,
};

function goalFor(genre) {
  if (genre === 'ai') return 'フォロワーを増やすこと';
  return 'フォロワーを増やすことと、案件（アフィリエイト）への誘導。' +
    '一人称の体験は書けません。アフィリエイトリンクは X（Twitter）の本文には置けません（プロフィール欄で誘導します）';
}

function systemPromptFor(genre) {
  return `あなたはSNSの短尺動画・投稿の企画を考える担当です。

# 目的
このジャンルの目的は「${goalFor(genre)}」です。

# このアプリで自動に作れるもの（これ以外は人手）
- 自動で作れるのは、文字の穴埋め6問の動画（format: "text"、720×1280、16.8秒）だけです
- 顔出しで話す（talking）・声だけ（voice）・画面収録（screen）・画像スライド（slides）などは、
  アプリでは作れません。人が撮る・録る・並べる作業が要ります。企画に出すときは、
  その手間を effort にはっきり書いてください（「人手：〜」のように）

# 確かめ方の目安
- 同じ型の投稿を最低10本ほど並べてから良し悪しを判断してください（1〜2本では偶然と見分けが付きません）
- のび率（再生数÷フォロワー数）だけでなく、保存・コメントの変化も見てください

# 書き方の決めごと
- 根拠として挙げる URL は、渡された「根拠として使えるURL」の一覧にあるものだけにしてください
- aim・changes・why に、出典のない割合・パーセント（「3割が」「20%が」など）を書かないでください
- 断定・保証（「必ず」「絶対」）はしないでください
- ネタ（topics）は、おすすめした企画に沿うもの・30文字以内・一人称にならない言い方にしてください。
  出典のない数字や、効果の断定を含むネタも不可です`;
}

function compact(x) {
  try { return JSON.stringify(x); } catch (_) { return '{}'; }
}

function buildUserMessage(facts, analysis, allowed, dropped) {
  const parts = [
    '②分析の結果（analysis）:\n' + compact(analysis),
    '事実（facts。数字の出どころ）:\n' + compact(facts),
    '根拠として使えるURL（このURL以外は書かないでください）:\n' +
      (allowed.length ? allowed.map((u) => '- ' + u).join('\n') : '（無し）'),
  ];
  if (dropped && dropped.length) {
    parts.push('前回の案は次の理由で使えませんでした。同じ問題を繰り返さないでください:\n' +
      dropped.map((d) => `- [${d.section}] ${d.text}（${d.reason}）`).join('\n'));
  }
  return parts.join('\n\n');
}

function requestFor(facts, analysis, allowed, genre, dropped) {
  return {
    system: systemPromptFor(genre),
    user: buildUserMessage(facts, analysis, allowed, dropped),
    schema: SCHEMA,
    schemaName: SCHEMA_NAME,
    effort: 'low',
    maxTokens: 4500,
  };
}

/** 本物を呼ぶ。テストではここを差し替える。 */
async function callModel(facts, analysis, allowed, genre, dropped) {
  return llm.json(requestFor(facts, analysis, allowed, genre, dropped));
}

function textFieldReason(text, profile) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return '空です';
  const bad = rules.bannedIn(t, profile).filter((f) => f.severity === 'error');
  if (bad.length) return bad[0].message;
  return null;
}

/** {evidence} が根拠として使える集合の部分集合か。lib/benchmark-analyze.js と同じ規則。 */
const checkEvidence = analyzeMod.checkEvidence;

/**
 * 案1件を点検する。だめなら { ok:false, reason }。
 * よければ { ok:true, corrections, plan }。corrections は直した箇所の注記
 * （例：自動で作れない型なのに auto:true だったのを false に直した）。
 */
function screenPlanEntry(raw, allowedSet, profile) {
  const item = raw || {};
  const name = String(item.name == null ? '' : item.name).trim();
  const aim = String(item.aim == null ? '' : item.aim).trim();
  const changes = (Array.isArray(item.changes) ? item.changes : [])
    .map((c) => String(c == null ? '' : c).trim()).filter(Boolean);
  const format = String(item.format == null ? '' : item.format).trim();
  const effort = String(item.effort == null ? '' : item.effort).trim();
  const verify = String(item.verify == null ? '' : item.verify).trim();
  const evidence = Array.isArray(item.evidence) ? item.evidence : [];

  let reason = null;
  if (!name) reason = '名前（name）が空です';
  else if (!aim) reason = '狙い（aim）が空です';
  else if (!changes.length) reason = '変更点（changes）が空です';
  else if (!benchmark.FORMATS[format]) reason = `format は ${Object.keys(benchmark.FORMATS).join(' / ')} のどれか`;
  else if (!effort) reason = '見積り（effort）が空です';
  else if (!verify) reason = '確かめ方（verify）が空です';
  else reason = checkEvidence(evidence, allowedSet);

  if (!reason) reason = textFieldReason(name, profile);
  if (!reason) reason = textFieldReason(aim, profile);
  if (!reason) { for (const c of changes) { reason = textFieldReason(c, profile); if (reason) break; } }
  if (!reason && PERCENT_RE.test(aim)) reason = '出典のない割合・パーセントが aim に入っています';
  if (!reason) { for (const c of changes) if (PERCENT_RE.test(c)) { reason = '出典のない割合・パーセントが changes に入っています'; break; } }

  if (reason) return { ok: false, reason };

  const corrections = [];
  let auto = !!item.auto;
  // ★ 自動で作れるのは文字の穴埋め動画（text）だけ。それ以外を自動と言い張っても実際には作れない。
  if (format !== 'text' && auto) {
    corrections.push('自動で作れるのは text 形式だけなので、auto を false に直しました');
    auto = false;
  }

  return {
    ok: true,
    corrections,
    plan: { name, aim, changes, format, auto, effort, verify, evidence: evidence.slice() },
  };
}

function screenWhy(why, profile) {
  const t = String(why == null ? '' : why).trim();
  if (!t) return { ok: false, reason: 'why が空です' };
  const bad = textFieldReason(t, profile);
  if (bad) return { ok: false, reason: bad };
  if (PERCENT_RE.test(t)) return { ok: false, reason: '出典のない割合・パーセントが why に入っています' };
  return { ok: true, text: t };
}

/**
 * LLM の生の返事を機械で点検する。
 * @returns { plans, recommended, why, dropped, ok }
 *   ok は「2案以上残った」かどうか（作り直すかどうかの判断に使う）。
 */
function screen(raw, allowedSet, profile) {
  const r = raw || {};
  const dropped = [];
  const survivors = []; // [{ index, plan }]

  (Array.isArray(r.plans) ? r.plans.slice(0, 3) : []).forEach((p, i) => {
    const result = screenPlanEntry(p, allowedSet, profile);
    if (!result.ok) {
      dropped.push({ section: 'plans', text: String((p && p.name) || ''), reason: result.reason });
      return;
    }
    for (const note of result.corrections) {
      dropped.push({ section: 'plans', text: result.plan.name, reason: note });
    }
    survivors.push({ index: i, plan: result.plan });
  });

  const whyResult = screenWhy(r.why, profile);
  let why = '';
  if (whyResult.ok) why = whyResult.text;
  else dropped.push({ section: 'why', text: String(r.why || ''), reason: whyResult.reason });

  // recommended: 生き残った案の中の番号に付け替える。
  const rawRecommended = r.recommended;
  const inRange = Number.isInteger(rawRecommended) && rawRecommended >= 0 && rawRecommended <= 2;
  let recommended = inRange ? survivors.findIndex((s) => s.index === rawRecommended) : -1;
  if (recommended < 0) {
    dropped.push({
      section: 'recommended', text: String(rawRecommended),
      reason: inRange
        ? 'おすすめに指定された案が点検で落ちたので、先頭の案をおすすめにしました'
        : 'recommended が0〜2の範囲外だったので、先頭の案をおすすめにしました',
    });
    recommended = survivors.length ? 0 : -1;
  }

  return {
    plans: survivors.map((s) => s.plan),
    recommended,
    why,
    dropped,
    ok: survivors.length >= 2,
  };
}

/**
 * facts と analysis から企画を作る。
 * @param facts     lib/benchmark-facts.js の facts(...) の戻り値
 * @param analysis  lib/benchmark-analyze.js の analyze(...).analysis
 * @param options   { genre, used, generate, topicGenerate, maxAttempts }
 */
async function plan(facts, analysis, options) {
  const opts = options || {};
  const genre = opts.genre;
  const used = Array.isArray(opts.used) ? opts.used : [];
  const generate = opts.generate || callModel;
  const topicGenerate = opts.topicGenerate || require('./topic-generate');
  const maxAttempts = opts.maxAttempts || MAX_ATTEMPTS;

  const profile = rules.profileFor(genre === 'ai' ? 'personal' : 'curator');
  const allowedSet = analyzeMod.allowedUrls(facts);
  const allowedList = [...allowedSet];

  let attempts = 0;
  let dropped = [];
  let screened = { plans: [], recommended: -1, why: '', dropped: [], ok: false };
  let rawTopics = [];

  while (attempts < maxAttempts) {
    attempts++;
    let raw;
    try {
      raw = await generate(facts, analysis, allowedList, genre, dropped);
    } catch (err) {
      dropped = [{ section: '(全体)', text: '', reason: err.message }];
      continue;
    }
    screened = screen(raw, allowedSet, profile);
    dropped = screened.dropped;
    rawTopics = Array.isArray(raw && raw.topics) ? raw.topics : [];
    if (screened.ok) break;
  }

  // ---- ネタ（topics）。既存の点検・作り直しをそのまま使う ----
  const seen = new Set(used.map((t) => topicGenerate.norm(t)));
  const first = topicGenerate.screen(rawTopics, seen);
  let kept = first.kept;
  let topicsRejected = first.rejected;
  if (kept.length < TOPIC_COUNT) {
    const need = TOPIC_COUNT - kept.length;
    const more = await topicGenerate.generateTopics(used.concat(kept), { count: need });
    kept = kept.concat(more.topics);
    topicsRejected = topicsRejected.concat(more.rejected || []);
  }

  const finalPlan = {
    plans: screened.plans,
    recommended: screened.recommended,
    why: screened.why,
    topics: kept.slice(0, TOPIC_COUNT),
    topicsRejected,
  };

  return { plan: finalPlan, attempts, dropped };
}

module.exports = {
  SCHEMA, SCHEMA_NAME, TOPIC_COUNT,
  systemPromptFor, buildUserMessage, requestFor, callModel,
  screenPlanEntry, screenWhy, screen, plan,
};
