'use strict';
/**
 * 投稿文を書かせる。
 *
 * ★ 相手（Claude / OpenAI）は lib/llm.js が決める。
 *   設定してあるキーのほうを使う。支払い先の都合で片方しか使えないことが
 *   あるので、そのために新しく契約させないための作り。
 *
 * 出力は JSON Schema で縛る。プロンプトで頼むだけでは形が揺れる。
 * そのうえで draft-rules.js で中身を見る。二段構えなのは、形が正しくても
 * 「私も転職しました」と書いてくることがあるため。
 */

const rules = require('./draft-rules');
const llm = require('./llm');

/** 短い文章を型に沿って書くだけなので medium で足りる。物足りなければ high。 */
const EFFORT = 'medium';
const MAX_TOKENS = 16000;
const SCHEMA_NAME = 'reel_draft';

/** 作り直しの上限。既定2回。 */
/**
 * ★ 2回から3回に増やした。
 *   行の点検を厳しくしたので、1回の書き直しでは通り切らないことがある。
 *   ここで諦めると下書きで止まり、毎日1本の運用が途切れる。
 *   指摘は次の依頼に添えて渡すので、回を重ねるほど通りやすくなる。
 */
const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// 出させる形
// ---------------------------------------------------------------------------

const ROW = {
  type: 'object',
  properties: {
    question: {
      type: 'string',
      description: '前半。11文字以内。「〜ほど」「〜すると」のように、答えに続く形で切る。'
        + '言い切らない。答えの言葉をここに入れない',
    },
    answer: {
      type: 'string',
      description: '枠に入る答え。2〜6文字。問いの続きになる言葉。問いに出てくる語は使わない',
    },
  },
  required: ['question', 'answer'],
  additionalProperties: false,
};

const SCHEMA = {
  type: 'object',
  properties: {
    kicker: { type: 'string', description: '小見出し。「不安な人へ!?」のような呼びかけ' },
    hook: {
      type: 'string',
      description: 'つかみ。動画の一番上に0秒目から赤の太字で出る一言。14文字前後、長くても16文字。'
        + '続きが気になる形で、行の番号を指す（例:「6番、やってる人多い…」「2番でバレる人が多いらしい」）',
    },
    title: { type: 'string', description: '本題。14文字以内' },
    rows: { type: 'array', minItems: rules.ROW_COUNT, maxItems: rules.ROW_COUNT, items: ROW },
    igCaption: { type: 'string', description: 'Instagram 用。出典の断りを必ず入れる' },
    ttCaption: { type: 'string', description: 'TikTok 用。出典の断りを必ず入れる' },
    xText: { type: 'string', description: 'X 用。画像2枚に添える本文' },
    thText: { type: 'string', description: 'Threads 用。1行目で止める書き出し、短い改行、最後に問いかけ。200〜350字。リンク・ハッシュタグ・PR表記は書かない' },
    hashtags: {
      type: 'array',
      items: { type: 'string' },
      description: 'ハッシュタグ。# を先頭に付けて6〜10個。ネタに合うものを具体的な順に並べる',
    },
    tone: { type: 'string', enum: ['calm', 'plain', 'alert'] },
  },
  // ★ hashtags を required に入れているのは、指示だけでは書き漏らすため。
  //   構造化出力の required は必ず守られるので、ここで存在を保証する。
  required: ['kicker', 'hook', 'title', 'rows', 'igCaption', 'ttCaption', 'xText', 'thText', 'hashtags', 'tone'],
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
縦型16.8秒。タイトルと6つの問いが最初から表示され、答えだけが0.4秒目から2.5秒ごとに1つずつ埋まる穴埋め形式です。
一番上には、0秒目から「つかみ（hook）」が赤の太字で出ます。

- hook: つかみ（下の「つかみの書き方」を参照）
- kicker: 呼びかけ。「不安な人へ!?」「3社落ちた人へ!?」のような短い一文（つかみがある動画では画面には出ません）
- title: 14文字以内。超えると画面からはみ出します
- rows: ちょうど6行。**「前半 → 答え」の穴埋め**です。1行は短い1つの文になります

## 行の書き方（ここを外すと動画が成立しません）

  - question は**11文字以内**。「〜ほど」「〜すると」「〜のは」のように、
    **答えに続く形で切る**。言い切らない
  - answer は**2〜6文字**
  - question と answer の合計は**15文字以内**（半角英数は0.5文字ぶん）
  - **answer の言葉を question に入れない**。同じ語が2回出ると、
    黒と赤で二重に表示されて読めたものになりません

### 良い例（実物の動画から）

    職場で話す人ほど → 広まる          （8字＋3字）
    同僚に相談すると → 伝わる          （8字＋3字）
    急に有給を取ると → 目立つ          （8字＋3字）
    SNSで書く人ほど → 特定される       （7字＋5字）
    服装が変わると → 察される          （7字＋4字）
    いちばん確実なのは → 黙ること      （9字＋4字）

### 悪い例と、なぜ駄目か

    ✗ 職場で話す人ほど広まる → 広まる
      「広まる」が2回。黒と赤で同じ語が並ぶ

    ✗ 同僚に軽い気持ちで相談してしまうと → 一気に伝わる
      長すぎる（23字）。文字が小さくなって読めない

    ✗ 同僚に相談すると。 → 伝わる
      問いが言い切りで終わっている。穴埋めにならない

    ✗ 転職活動をしていることは → 職場の人にはできるだけ話さないほうがいい
      答えが長い。枠に入らない

  - 6行目はオチ。「いちばん確実なのは → 黙ること」のように締める
  - **rows はちょうど6行**。7行以上・5行以下は動画が作れません
  - **question の最後に「。」「？」を付けない**。答えに続く途中で切る

## つかみの書き方（hook）
視聴者のほとんどが最初の1秒で離れます。0秒目に見えるのは、つかみとタイトルだけです。
- 14文字前後（長くても16文字）。行の番号を指して、続きが気になる形にする
  例:「6番、やってる人多い…」「2番でバレる人が多いらしい」「最後のが一番大事かも」
- 番号は「何番目の行か」の意味だけ。「8割が」のような割合・人数は書かない
- 「絶対」「必ず」を使わない。キュレーターなので「私も」のような一人称の体験にしない
- igCaption / ttCaption: 動画のキャプション。**出典の断りを必ず入れる**
  （動画本文は言い切ってよい。断りはキャプションが担う）
  - 1行目は、つかみと同じ方向の「続きが気になる」一文にする。例:「5番がいちばん刺さる…」「2番でバレた話、けっこう聞く」
    「〜についての口コミを集めました」のような説明から始めない（数字では、説明から始めた回ほど早く離れられている）
  - 最後は、番号で答えられる問いかけで締める。例:「何番やってた？番号だけコメントで教えて」「どれが一番意外だった？番号で教えて」
- xText: X用。画像2枚（空欄／答え）に添える本文。断りは不要
- thText: Threads用。Threads は文字が主役で、会話（リプライ）が続く投稿ほど広がる。次の形で書く
  - 1行目で手を止めさせる。20字前後の短い一文。例:「面接で落ちる人、ここが共通してるらしい」
    「これ知らないまま転職すると損するかも」「口コミで一番多かったのがこれ」
  - 2行目以降は短い行と改行で区切る。6つのポイントは「・」の箇条書きで答えまで見せてよい
    （動画は穴埋め、Threads は中身を読ませる役）
  - 最後はリプライしたくなる問いかけで締める。例:「どれか当てはまった？」「他にもあったらリプで教えて」
  - 200〜350字。長すぎると読まれない
  - 立ち位置は同じくキュレーター。「正直、私も〜でした」のような一人称の体験は書かない
  - リンク・ハッシュタグ・PR表記は書かない（アプリが最後に付ける）
- hashtags: 6〜10個。すべて # で始める。キャプションの中には書かず、この欄にだけ入れる
  - 具体的なものを先に、広いものを後に並べる（例: #第二新卒の転職 → #転職 → #キャリア）
  - そのネタに実際に関係するものだけ。数合わせで無関係な語を混ぜない
  - 日本語中心。半角スペースや記号は入れない
- tone: calm（共感・不安）/ plain（手順・実務）/ alert（注意喚起）

# 実例
kicker: 不安な人へ!?
hook: 5番、やりがちな人多い…
title: 転職活動がバレにくい進め方
rows:
  職場で話す人ほど → 広まる
  同僚に相談すると → 伝わる
  急に有給を取ると → 目立つ
  SNSで書く人ほど → 特定される
  服装が変わると → 察される
  いちばん確実なのは → 黙ること
igCaption: 5番がいちばん刺さる…。第二新卒の口コミを集めた結果です。何番やってた？番号だけコメントで教えて
xText: 「転職活動がバレにくい進め方」6つ、答え合わせ。3番が意外と知られてないと思う。
thText: 転職活動、職場にバレる人には共通点があるらしい。

口コミを集めたら、だいたいこの6つ。
・職場で話す人ほど広まる
・同僚に相談すると伝わる
・急に有給を取ると目立つ
・SNSで書く人ほど特定される
・服装が変わると察される
・いちばん確実なのは黙ること

3つ目、意外とやりがち。
どれか当てはまった？
hashtags: #転職活動 #第二新卒 #転職したい #退職 #社会人3年目 #キャリア #仕事の悩み #転職相談`;

function buildUserMessage(topic, previous) {
  const parts = [`ネタ:「${topic.title}」`, `トーン: ${topic.tone || 'calm'}`];

  if (topic.direction) parts.push(`切り口の指示: ${topic.direction}`);

  if (topic.hasAffiliateLink) {
    parts.push(
      'この回は案件リンクを含みます。ステマ規制の対象なので、igCaption と ttCaption の両方にPR表記（#PR など）を入れてください。' +
      'なお X は A8.net の掲載対象外なので、xText に案件リンクやPR表記は入れないでください。' +
      'thText にもリンクとPR表記は書かないでください（プロフィールへの誘導とPR表記はアプリが付けます）。'
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

/** 相手に渡す中身。相手ごとの形の違いは lib/llm.js が吸収する。 */
function requestFor(topic, previous) {
  return {
    system: SYSTEM_PROMPT,
    user: buildUserMessage(topic, previous),
    schema: SCHEMA,
    schemaName: SCHEMA_NAME,
    effort: EFFORT,
    maxTokens: MAX_TOKENS,
  };
}

/** 組み立てた本体。中身を確かめたいときのために外へ出す。 */
function buildParams(topic, previous, providerId) {
  return llm.buildBody(providerId || llm.provider(), requestFor(topic, previous));
}

/** 本物を呼ぶ。テストではここを差し替える。 */
function callModel(topic, previous) {
  return llm.json(requestFor(topic, previous));
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
  const generate = opts.generate || callModel;
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

    // ★ 断りが落ちていたら、こちらで足す。
    //   頼み方を強めても、モデルはときどき書き落とす。落ちたぶんが下書きで
    //   止まると、毎日1本を20日続ける運用がそこで途切れる。
    const added = ensureSourcing(draft, profile)
      .concat(ensurePrLabel(draft))
      .concat(closeOpenQuestions(draft));

    const findings = rules.validateDraft(draft, profile).concat(added);
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
 *
 * ★ これは Claude のバッチの形。OpenAI にも同じ趣旨の仕組みはあるが、
 *   渡し方（JSONL のファイル）が違うので、いまは対応していない。
 *   1本ずつ作るぶんにはどちらでも動く。
 */
/**
 * 出典の断りが無ければ、末尾に一文足す。
 *
 * ★ なぜ足してよいのか
 *   この一文は「運用者に実体験は無く、ネットの声を集めている」という、
 *   誰が書いても変わらない事実。モデルが書こうが、こちらが足そうが、
 *   内容は同じで嘘にならない。むしろ落ちたまま出るほうが、
 *   体験談に見えてしまって問題になる。
 *
 * ★ 黙って足さない。
 *   足したことを指摘として残し、画面に出す。
 *   本人が読んで、自分の言い回しに直せるようにするため。
 */
const SOURCING_LINE = 'ネットで見かけた声を集めたものです。';

function ensureSourcing(draft, profile) {
  const p = profile || rules.CURATOR;
  if (!p.requireSourcing) return [];

  const added = [];
  for (const field of ['igCaption', 'ttCaption']) {
    const text = String(draft[field] || '').trim();
    // ★ 空文字はここでは足さずに素通りする。
    //   断りの一文だけを空欄に足しても、中身のある本文にはならない
    //   （ハッシュタグだけの投稿の再発になりかねない）。
    //   空欄は lib/draft-rules.js の empty-caption が error として止めるので、
    //   そちらに任せて書き直させる。
    if (!text || rules.hasSourcing(text)) continue;

    draft[field] = text + (/[。．！？!?…]$/.test(text) ? '' : '。') + SOURCING_LINE;
    added.push({
      field, rule: 'sourcing-added', severity: 'warning',
      message: '出典の断りが無かったので、末尾に一文足しました',
      excerpt: SOURCING_LINE,
    });
  }
  return added;
}

/**
 * 案件つきなのに PR 表記が抜けていたら、キャプションの先頭に【PR】を足す。
 *
 * ★ なぜ足してよいのか：案件リンクを含む投稿であることは事実で、誰が書いても変わらない
 *   （出典の断りと同じ考え方）。抜けたまま出るほうがステマ規制に反する。
 *   モデルは igCaption にだけ書いて ttCaption に書き落とすことがあった（2026-09-29 の仕込みで3本）。
 * ★ 先頭に足す。末尾だと、TikTok では「もっと見る」の下に隠れて読まれない。
 * ★ 見るのは「投稿される本文」（ハッシュタグ込み）。#PR をタグ側に入れてあれば足さない。
 */
const PR_PREFIX = '【PR】';

function ensurePrLabel(draft) {
  if (!draft.hasAffiliateLink) return [];
  const added = [];
  for (const [field, network] of [['igCaption', 'instagram'], ['ttCaption', 'tiktok']]) {
    const text = String(draft[field] || '').trim();
    if (!text) continue;   // 空欄は empty-caption が止める
    if (rules.PR_LABEL.test(rules.captionWithTags(text, draft.hashtags, network))) continue;
    draft[field] = PR_PREFIX + text;
    added.push({ field, rule: 'pr-added', severity: 'warning',
      message: 'PR表記が無かったので、先頭に【PR】を足しました', excerpt: PR_PREFIX });
  }
  return added;
}

/**
 * 問いの末尾の「。」を外す。ただし、外せば答えに続く形になるものだけ。
 *
 * ★ 「同僚に相談すると。」は「。」を取れば正しい穴埋めになる。モデルは句点を付けがちで、
 *   それだけで6行とも止まっていた（2026-09-29 の仕込みで4本）。
 * ★ 「面接官は話し方を見ています。」のように文として言い切っているものは外さない。
 *   外しても穴埋めにならないので、点検（question-not-open）で止めて書き直させる。
 */
const OPEN_TAIL = /(ほど|と|ば|たら|なら|のは|のが|より|ても|でも|けど|から|ので|って|ながら|まま|うちに|前に|後に|とき|時|は|が|を|に|で|も|へ|、)$/;

function closeOpenQuestions(draft) {
  const added = [];
  (Array.isArray(draft.rows) ? draft.rows : []).forEach((row, i) => {
    const q = String((row && row.question) || '');
    const trimmed = q.replace(/[。．]+$/, '');
    if (trimmed === q || !OPEN_TAIL.test(trimmed)) return;
    row.question = trimmed;
    added.push({ field: `rows[${i}].question`, rule: 'question-trimmed', severity: 'warning',
      message: '問いの最後の「。」を外しました（答えに続く形にするため）', excerpt: trimmed });
  });
  return added;
}

function buildBatchRequests(topics) {
  return topics.map((t) => ({
    custom_id: String(t.topicId),
    params: llm.buildBody('anthropic', requestFor(t, null)),
  }));
}

module.exports = {
  EFFORT, MAX_TOKENS, MAX_ATTEMPTS, SCHEMA, SCHEMA_NAME, SYSTEM_PROMPT,
  SOURCING_LINE, ensureSourcing, PR_PREFIX, ensurePrLabel, closeOpenQuestions,
  buildUserMessage, requestFor, buildParams, callModel, generateDraft, buildBatchRequests,
};
