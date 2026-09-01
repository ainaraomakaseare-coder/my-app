'use strict';
/**
 * 投稿文を Claude に書かせる。
 *
 * ★ SDK ではなく fetch で書いている理由
 *   このアプリは Meta / Google / TikTok / X / Supabase まで全部 fetch で
 *   手書きしていて、外部パッケージがひとつも無い。ここだけ SDK を入れると
 *   その方針が崩れ、依存とビルドが増える。方針に合わせた。
 *   （依存を入れる方針に変えるなら @anthropic-ai/sdk のほうが短く書ける）
 *
 * 出力は JSON Schema で縛る。プロンプトで頼むだけでは形が揺れる。
 * そのうえで draft-rules.js で中身を見る。二段構えなのは、形が正しくても
 * 「私も転職しました」と書いてくることがあるため。
 */

const rules = require('./draft-rules');

const API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-5';

/** 短い文章を型に沿って書くだけなので medium で足りる。物足りなければ high。 */
const EFFORT = 'medium';
const MAX_TOKENS = 16000;

/** 作り直しの上限。既定2回。 */
const MAX_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// 出させる形
// ---------------------------------------------------------------------------

const ROW = {
  type: 'object',
  properties: {
    question: { type: 'string', description: '前半の問い' },
    answer: { type: 'string', description: '枠に入る答え。2〜6文字' },
  },
  required: ['question', 'answer'],
  additionalProperties: false,
};

const SCHEMA = {
  type: 'object',
  properties: {
    kicker: { type: 'string', description: '小見出し。「不安な人へ!?」のような呼びかけ' },
    title: { type: 'string', description: '本題。14文字以内' },
    rows: { type: 'array', minItems: rules.ROW_COUNT, maxItems: rules.ROW_COUNT, items: ROW },
    igCaption: { type: 'string', description: 'Instagram 用。出典の断りを必ず入れる' },
    ttCaption: { type: 'string', description: 'TikTok 用。出典の断りを必ず入れる' },
    xText: { type: 'string', description: 'X 用。画像2枚に添える本文' },
    tone: { type: 'string', enum: ['calm', 'plain', 'alert'] },
  },
  required: ['kicker', 'title', 'rows', 'igCaption', 'ttCaption', 'xText', 'tone'],
  additionalProperties: false,
};

/** 毎回同じ。キャッシュを効かせるため先頭に固定で置く。 */
const SYSTEM_PROMPT = `あなたは20代・第二新卒向けの転職ジャンルで、SNSの短尺動画の台本を書く担当です。

# 立ち位置（最重要）
運用者はネットの口コミを集めて紹介する「キュレーター」です。転職の実体験はありません。
一人称の体験談を書くと、事実と違う投稿になります。絶対に書かないでください。

## 禁止
- 一人称の体験:「私も転職しました」「実際に使ってみたら」「作ってみました」
- 出典のない数値:「利用者の8割が」「3人に1人が」
- 効果の断定:「必ず年収が上がります」「確実に内定が取れます」
- 実在しない口コミの捏造

## 許される書き方
- 「口コミで多かったのは〜」
- 「〜という声がありました」
- 「賛否あって、〜という意見も」

# 動画の形
縦型16.8秒。タイトルと6つの問いが最初から表示され、答えだけが2.5秒ごとに1つずつ埋まる穴埋め形式です。

- kicker: 呼びかけ。「不安な人へ!?」「3社落ちた人へ!?」のような短い一文
- title: 14文字以内。超えると画面からはみ出します
- rows: ちょうど6行
  - answer は2〜6文字
  - question と answer の合計は15文字以内（半角英数は0.5文字ぶんで数える）
  - 6行目はオチ。「いちばん確実なのは → 黙ること」のように締める
- igCaption / ttCaption: 動画のキャプション。**出典の断りを必ず入れる**
  （動画本文は言い切ってよい。断りはキャプションが担う）
- xText: X用。画像2枚（空欄／答え）に添える本文。断りは不要
- tone: calm（共感・不安）/ plain（手順・実務）/ alert（注意喚起）

# 実例
kicker: 不安な人へ!?
title: 転職活動がバレにくい進め方
rows:
  職場で話す人ほど → 広まる
  同僚に相談すると → 伝わる
  急に有給を取ると → 目立つ
  SNSで書く人ほど → 特定される
  服装が変わると → 察される
  いちばん確実なのは → 黙ること
igCaption: 5番がいちばん刺さる…。第二新卒の口コミを集めた結果です。他にもあったらコメントで教えてください
xText: 「転職活動がバレにくい進め方」6つ、答え合わせ。3番が意外と知られてないと思う。`;

function buildUserMessage(topic, previous) {
  const parts = [`ネタ:「${topic.title}」`, `トーン: ${topic.tone || 'calm'}`];

  if (topic.direction) parts.push(`切り口の指示: ${topic.direction}`);

  if (topic.hasAffiliateLink) {
    parts.push(
      'この回は案件リンクを含みます。ステマ規制の対象なので、igCaption と ttCaption の両方にPR表記（#PR など）を入れてください。' +
      'なお X は A8.net の掲載対象外なので、xText に案件リンクやPR表記は入れないでください。'
    );
  }

  if (topic.avoidTitles && topic.avoidTitles.length) {
    parts.push('次のネタとは切り口を変えてください（言い換えただけは不可）:\n' +
      topic.avoidTitles.map((t) => '- ' + t).join('\n'));
  }

  if (previous) {
    parts.push([
      '前回の生成は次の指摘で弾かれました。同じ形を繰り返さないでください。',
      ...previous.findings.map((f) =>
        `- [${f.field}] ${f.message}` + (f.excerpt ? `（該当: ${f.excerpt}）` : '')),
    ].join('\n'));
  }

  return parts.join('\n\n');
}

/** Messages API に渡す本体。通常呼び出しとバッチで共用する。 */
function buildParams(topic, previous) {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema: SCHEMA } },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: buildUserMessage(topic, previous) }],
  };
}

/** 返ってきた本文（テキストブロック）を1つにまとめる。 */
function textOf(message) {
  return (message.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** 本物の Claude を呼ぶ。テストではここを差し替える。 */
async function callClaude(topic, previous) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY が設定されていません');

  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(buildParams(topic, previous)),
  });

  const body = await res.json();
  if (!res.ok) {
    const detail = (body && body.error && body.error.message) || res.statusText;
    throw new Error(`Claude の呼び出しに失敗しました（${res.status}）: ${detail}`);
  }
  if (body.stop_reason === 'refusal') {
    throw new Error('Claude が生成を断りました。ネタの指定を見直してください');
  }
  return JSON.parse(textOf(body));
}

// ---------------------------------------------------------------------------
// 生成 → 点検 → 駄目なら作り直し
// ---------------------------------------------------------------------------

/**
 * 下書きを1本作る。
 *
 * 作り直しても直らないときは投げずに、最後の結果と指摘をそのまま返す。
 * 直すかどうかを決めるのは人間なので、握りつぶすより見せたほうがいい。
 *
 * @param topic     { topicId, title, tone, hasAffiliateLink, groupId, avoidTitles, direction }
 * @param options   { generate, profile, maxAttempts }
 */
async function generateDraft(topic, options) {
  const opts = options || {};
  const generate = opts.generate || callClaude;
  const profile = opts.profile || rules.CURATOR;
  const maxAttempts = opts.maxAttempts || MAX_ATTEMPTS;

  let previous = null;
  let last = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let generated;
    try {
      generated = await generate(topic, previous, attempt);
    } catch (err) {
      // JSON が壊れていた・通信が落ちた。作り直しの対象にする。
      const findings = [{ field: '(全体)', rule: 'generate-failed', severity: 'error', message: err.message }];
      last = { draft: null, findings, attempts: attempt, ok: false };
      previous = { draft: null, findings };
      continue;
    }

    const draft = Object.assign({}, generated, {
      topicId: topic.topicId,
      groupId: topic.groupId || null,
      hasAffiliateLink: !!topic.hasAffiliateLink,
    });

    const findings = rules.validateDraft(draft, profile);
    const ok = !rules.hasBlocking(findings);
    last = { draft, findings, attempts: attempt, ok };
    if (ok) return last;

    previous = { draft, findings };
  }

  return last;
}

/**
 * まとめて作るとき用。下書きは前もって作るもので即時性が要らないので、
 * 1週間ぶんを Batch API に投げれば単価が半分になる。
 * POST https://api.anthropic.com/v1/messages/batches に { requests } で渡す。
 */
function buildBatchRequests(topics) {
  return topics.map((t) => ({ custom_id: String(t.topicId), params: buildParams(t, null) }));
}

module.exports = {
  MODEL, EFFORT, MAX_TOKENS, MAX_ATTEMPTS, SCHEMA, SYSTEM_PROMPT,
  buildUserMessage, buildParams, callClaude, generateDraft, buildBatchRequests,
};
