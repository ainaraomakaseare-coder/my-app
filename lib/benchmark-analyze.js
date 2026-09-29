'use strict';
/**
 * 分析部隊の②分析。lib/benchmark-facts.js が機械で出した事実（facts）をもとに、
 * LLM に「気づき」を書かせる。
 *
 * ★ 数字は LLM に作らせない。
 *   facts に入っている数字だけが正しい（CLAUDE.md の「嘘を書かない」）。
 *   LLM の仕事は、その数字を言葉にすること・仮説を立てることだけ。
 *   だから本文に数字を書かせない（数字は facts 側で別に見せる）。
 *
 * ★ 根拠のURLは facts に載っているものだけ使わせる。
 *   出てきたものをそのまま信じず、ここで機械が必ず点検する
 *   （lib/topic-generate.js と同じ「LLM + 機械点検 + 作り直し1回」の形）。
 */

const rules = require('./draft-rules');
const llm = require('./llm');

const MAX_ATTEMPTS = 2;   // Vercel の1回60秒に収めるため、作り直しは1回まで
const MAX_STRENGTHS = 6;
const MAX_GAPS = 5;
const MAX_OPPORTUNITIES = 5;

const SCHEMA_NAME = 'benchmark_analysis';

// 半角・全角の数字。本文にはどちらも書かせない。
const DIGIT = /[0-9０-９]/;

const EVIDENCE_ITEM = { type: 'array', items: { type: 'string' } };

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string' } },
    strengths: {
      type: 'array', maxItems: MAX_STRENGTHS,
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, evidence: EVIDENCE_ITEM },
        required: ['text', 'evidence'],
        additionalProperties: false,
      },
    },
    gaps: {
      type: 'array', maxItems: MAX_GAPS,
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, evidence: EVIDENCE_ITEM },
        required: ['text', 'evidence'],
        additionalProperties: false,
      },
    },
    opportunities: {
      type: 'array', maxItems: MAX_OPPORTUNITIES,
      items: {
        type: 'object',
        properties: { topic: { type: 'string' }, text: { type: 'string' }, evidence: EVIDENCE_ITEM },
        required: ['topic', 'text', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'strengths', 'gaps', 'opportunities'],
  additionalProperties: false,
};

function operatorContext(genre) {
  if (genre === 'ai') {
    return 'このジャンルの運用アカウントは「ひろや｜AI初心者30日30アプリ」。' +
      '本人が実際に作ってみた記録を投稿している立場で、目的はフォロワーを増やすことです。';
  }
  return 'このジャンルの運用アカウントは「転職のホンネまとめ」。' +
    'ネットの口コミを集めて紹介するキュレーターで、転職の実体験はありません。' +
    '目的はフォロワーと、案件（アフィリエイト）への誘導です。';
}

function systemPromptFor(genre) {
  return `あなたはSNSの短尺動画・投稿を分析するアナリストです。

# 立ち位置
${operatorContext(genre)}

# 書き方の決めごと（必ず守る）
- すべての主張は「仮説」として書いてください。渡された事実（facts）に根拠が無いことは書かないでください
- 根拠として挙げる URL は、渡された「根拠として使えるURL」の一覧にあるものだけにしてください。一覧に無いURLを作らない・書き換えないでください
- 本文に数字（0-9、０-９）を書かないでください。数字は facts 側で別に示すので、本文は言葉だけで説明してください
- 「必ず」「絶対」「確実に」のような断定・保証はしないでください
- 伸びている投稿の言い回しをそのまま真似ることは勧めないでください。切り口や構成の共通点を指摘するのはよいです`;
}

function compact(facts) {
  try { return JSON.stringify(facts); } catch (_) { return '{}'; }
}

function buildUserMessage(facts, allowed, dropped) {
  const parts = [
    '次の事実（facts。機械が計算したものです。ここに無い数字を使わないでください）をもとに、分析を書いてください:\n' + compact(facts),
    '根拠として使えるURL（このURL以外は書かないでください）:\n' + (allowed.length ? allowed.map((u) => '- ' + u).join('\n') : '（無し）'),
  ];
  if (dropped && dropped.length) {
    parts.push('前回の案は次の理由で使えませんでした。同じ問題を繰り返さないでください:\n' +
      dropped.map((d) => `- [${d.section}] ${d.text}（${d.reason}）`).join('\n'));
  }
  return parts.join('\n\n');
}

function requestFor(facts, allowed, dropped) {
  return {
    system: systemPromptFor(facts.genre),
    user: buildUserMessage(facts, allowed, dropped),
    schema: SCHEMA,
    schemaName: SCHEMA_NAME,
    effort: 'low',
    maxTokens: 4000,
  };
}

/** 本物を呼ぶ。テストではここを差し替える。 */
async function callModel(facts, allowed, dropped) {
  return llm.json(requestFor(facts, allowed, dropped));
}

/** facts の中で、根拠として指せてよい URL の集合。 */
function allowedUrls(facts) {
  const f = facts || {};
  const set = new Set();
  for (const t of (f.top || [])) if (t && t.url) set.add(t.url);
  for (const t of (f.topics || [])) for (const u of (t.sampleUrls || [])) if (u) set.add(u);
  for (const q of (f.questions || [])) for (const u of (q.urls || [])) if (u) set.add(u);
  return set;
}

function checkEvidence(evidence, allowedSet) {
  if (!Array.isArray(evidence) || evidence.length === 0) return '根拠（evidence）が空です';
  for (const u of evidence) {
    if (!allowedSet.has(u)) return `根拠のURLが、渡した記録の中にありません（${u}）`;
  }
  return null;
}

function checkText(text, profile) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return '本文が空です';
  if (DIGIT.test(t)) return '数字が入っています（数字は事実側で示すので本文には書かない）';
  const bad = rules.bannedIn(t, profile).filter((f) => f.severity === 'error');
  if (bad.length) return bad[0].message;
  return null;
}

/** strengths / gaps 共通の点検（{text, evidence}）。 */
function screenTextEvidenceList(items, sectionName, allowedSet, profile, max) {
  const kept = [];
  const dropped = [];
  const list = Array.isArray(items) ? items.slice(0, max) : [];
  for (const raw of list) {
    const item = raw || {};
    const textReason = checkText(item.text, profile);
    const evReason = textReason ? null : checkEvidence(item.evidence, allowedSet);
    const reason = textReason || evReason;
    if (reason) { dropped.push({ section: sectionName, text: String(item.text || ''), reason }); continue; }
    kept.push({ text: String(item.text).trim(), evidence: item.evidence.slice() });
  }
  return { kept, dropped };
}

function screenOpportunities(items, allowedSet, profile) {
  const kept = [];
  const dropped = [];
  const list = Array.isArray(items) ? items.slice(0, MAX_OPPORTUNITIES) : [];
  for (const raw of list) {
    const item = raw || {};
    const topic = String(item.topic == null ? '' : item.topic).trim();
    let reason = null;
    if (!topic) reason = 'topic が空です';
    if (!reason) reason = checkText(item.text, profile);
    if (!reason) reason = checkEvidence(item.evidence, allowedSet);
    if (reason) { dropped.push({ section: 'opportunities', text: String(item.text || topic || ''), reason }); continue; }
    kept.push({ topic, text: String(item.text).trim(), evidence: item.evidence.slice() });
  }
  return { kept, dropped };
}

function screenSummary(raw, profile) {
  const lines = Array.isArray(raw) ? raw : [];
  const dropped = [];
  const kept = [];
  for (const line of lines) {
    const text = String(line == null ? '' : line).trim();
    const reason = checkText(text, profile);
    if (reason) { dropped.push({ section: 'summary', text, reason }); continue; }
    kept.push(text);
  }
  // ★ ちょうど3行そろってはじめて「使える」。1〜2行しか残らなければ、
  //   その回は summary として不合格（呼び出し側が作り直しを判断する）。
  const ok = lines.length === 3 && kept.length === 3;
  return { summary: kept, ok, dropped };
}

/**
 * LLM の生の返事を機械で点検する。
 * own が無い（facts.own === null）ジャンルでは、gaps は必ず空にする
 * （「うちの投稿と比べて」の材料が無いのに書かせない）。
 */
function screen(raw, facts, allowed, profile) {
  const r = raw || {};
  const summaryResult = screenSummary(r.summary, profile);
  const strengthsResult = screenTextEvidenceList(r.strengths, 'strengths', allowed, profile, MAX_STRENGTHS);

  let gapsResult;
  if (facts.own == null) {
    const forced = (Array.isArray(r.gaps) ? r.gaps : []).map((g) => ({
      section: 'gaps', text: String((g && g.text) || ''), reason: '自分の投稿の記録（own）が無いので gaps は出しません',
    }));
    gapsResult = { kept: [], dropped: forced };
  } else {
    gapsResult = screenTextEvidenceList(r.gaps, 'gaps', allowed, profile, MAX_GAPS);
  }

  const opportunitiesResult = screenOpportunities(r.opportunities, allowed, profile);

  const dropped = [].concat(
    summaryResult.dropped, strengthsResult.dropped, gapsResult.dropped, opportunitiesResult.dropped
  );

  const growing = (facts.n && facts.n.growing) || 0;
  const strengthsFailed = growing >= 3 && strengthsResult.kept.length === 0 && (r.strengths || []).length > 0;

  // own が無いときの gaps=[] は「正しい結果」なので、作り直しの理由にはしない。
  const ok = summaryResult.ok && !strengthsFailed;

  const analysis = {
    summary: summaryResult.summary,
    strengths: strengthsResult.kept,
    gaps: gapsResult.kept,
    opportunities: opportunitiesResult.kept,
  };

  return { analysis, ok, dropped };
}

/**
 * facts から分析を作る。
 * @param facts    lib/benchmark-facts.js の facts(...) の戻り値
 * @param options  { generate, maxAttempts }
 */
async function analyze(facts, options) {
  const opts = options || {};
  const generate = opts.generate || callModel;
  const maxAttempts = opts.maxAttempts || MAX_ATTEMPTS;
  const profile = rules.profileFor(facts.genre === 'ai' ? 'personal' : 'curator');
  const allowedSet = allowedUrls(facts);
  const allowedList = [...allowedSet];

  let attempts = 0;
  let dropped = [];
  let analysis = { summary: [], strengths: [], gaps: [], opportunities: [] };

  while (attempts < maxAttempts) {
    attempts++;
    let raw;
    try {
      raw = await generate(facts, allowedList, dropped);
    } catch (err) {
      dropped = [{ section: '(全体)', text: '', reason: err.message }];
      continue;
    }
    const result = screen(raw, facts, allowedSet, profile);
    analysis = result.analysis;
    dropped = result.dropped;
    if (result.ok) break;
  }

  return { analysis, attempts, dropped };
}

module.exports = {
  SCHEMA, SCHEMA_NAME, MAX_STRENGTHS, MAX_GAPS, MAX_OPPORTUNITIES,
  systemPromptFor, buildUserMessage, requestFor, callModel,
  allowedUrls, checkEvidence, checkText, screen, analyze,
};
