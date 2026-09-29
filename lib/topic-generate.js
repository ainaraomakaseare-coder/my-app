'use strict';
/**
 * 「まとめて仕込む」に並べるネタを、AI に考えさせる。
 *
 * ★ 追加の費用はかからない。文案づくりと同じ鍵（OpenAI か Anthropic）を使う。
 *   最新ニュースは拾えないが、第二新卒・転職の「落とし穴／手順」ネタは
 *   時事に左右されにくいので、これで足りる。足りなくなったら検索つきに替える。
 *
 * ★ 出てきたものをそのまま使わない。
 *   - 過去に使ったネタ・動画のタイトルと同じものは落とす
 *   - 20本の中での重複も落とす
 *   - 体験・出典のない数値・断定が入ったものは落とす（文案と同じ点検）
 *   足りなくなったら、落とした理由を添えて足りない本数だけ作り直させる。
 */

const rules = require('./draft-rules');
const llm = require('./llm');

const COUNT = 20;
const MAX_ATTEMPTS = 2;   // Vercel の1回60秒に収めるため、作り直しは1回まで
const TITLE_MIN = 6;
const TITLE_MAX = 30;

const SCHEMA_NAME = 'topics';
const FIRST_PERSON_WORD = /(私|僕|俺|わたし|ぼく|オレ|自分が|自分も)/;
// ★ 説明型のネタは穴埋めにならない。「退職届と退職願の使い分け」は6行とも言い切りの文になり、
//   3回書き直しても下書きで止まった（2026-09-29）。落とし穴・手順の形にさせる。
const EXPLAIN_TAIL = /(使い分け|の違い|とは|って何|の意味)$/;

const schemaFor = (n) => ({
  type: 'object',
  properties: {
    topics: {
      type: 'array',
      minItems: n,
      maxItems: n,
      items: { type: 'string', description: `ネタ1本。${TITLE_MAX}文字以内` },
    },
  },
  required: ['topics'],
  additionalProperties: false,
});

const SYSTEM_PROMPT = `あなたは20代・第二新卒向けの転職ジャンルで、SNSの短尺動画のネタを考える担当です。

# 立ち位置
運用者はネットの口コミを集めて紹介する「キュレーター」です。転職の実体験はありません。

# ネタの条件
- 1本の動画で「6つの落とし穴」か「6つの手順」に開けるもの
- 20代・第二新卒が、転職活動・退職・面接・書類・入社直後で実際につまずく場面
- ${TITLE_MAX}文字以内の、短い名詞句か「〜とき」「〜こと」で終わる形
- 一人称の体験（「私が〜した」）、出典のない数値（「8割が」）、効果の断定（「必ず受かる」）は入れない
- 渡された「使ったネタ」と、言い換えただけのものは不可。切り口を変える
- 同じ回の中で、似たネタを並べない（面接・書類・退職・入社後・お金・人間関係のように散らす）
- 「〜の使い分け」「〜の違い」「〜とは」のような説明型にしない。穴埋めにならない。「〜でやりがちなこと」「〜で見落としがちなこと」「〜の前に確認すること」の形にする

# 良い例
面接で落ちる人がやりがちなこと
退職を切り出すときの順番
求人票で見落とすと危ない欄
内定辞退の連絡で失礼にならない言い方
試用期間中に見えてくる危ない会社のサイン`;

/**
 * ★ ジャンルごとの指示。はじめは転職しか無く、分析部隊③で AI（ひろや）の企画を作ったとき、
 *   足りないネタの補充が全部転職のネタになった（本番の1回目）。ジャンルを渡して切り替える。
 */
const AI_PROMPT = `あなたは「ひろや｜AI初心者30日30アプリ」の短尺動画のネタを考える担当です。

# 立ち位置
運用者は AI の初心者で、AI を使ってアプリを作る自分の実践を記録しています。
見る人は、AI を使ってみたいがまだ慣れていない人です。

# ネタの条件
- 1本の動画で「6つの落とし穴」か「6つの手順」に開けるもの
- AI 初心者が ChatGPT などの AI を使うとき・AI でアプリや道具を作るときに、実際につまずく場面
- ${TITLE_MAX}文字以内の、短い名詞句か「〜とき」「〜こと」で終わる形
- 出典のない数値（「9割が」）、効果の断定（「必ず稼げる」「誰でも月10万」）は入れない
- 特定の新製品・新機能の名前やニュースには頼らない（すぐ古くなり、確かめられない）
- 渡された「使ったネタ」と、言い換えただけのものは不可。切り口を変える
- 同じ回の中で、似たネタを並べない（指示の出し方・アプリ作り・無料と有料・失敗・続け方・仕事での使い方のように散らす）
- 「〜の使い分け」「〜の違い」「〜とは」のような説明型にしない。穴埋めにならない

# 良い例
AIに頼むと失敗する指示の出し方
AIでアプリを作る前に決めておくこと
無料のAIだけで始めるときの落とし穴
AIの答えをそのまま使うと困る場面
初心者がAIで最初に作るとよいもの`;

const SYSTEM_PROMPTS = { career: SYSTEM_PROMPT, ai: AI_PROMPT };
const promptFor = (genre) => SYSTEM_PROMPTS[genre] || SYSTEM_PROMPT;

/** 比べるために、空白と記号を落とす。「面接で 落ちる人」と「面接で落ちる人」を同じとみなす。 */
const norm = (s) => String(s || '').replace(/[\s　、。・！？!?「」『』（）()\-ー〜~]/g, '');

function buildUserMessage(need, used, rejected) {
  const parts = [`ネタを${need}本考えてください。`];
  if (used.length) {
    parts.push('使ったネタ（これらとは切り口を変える）:\n' + used.map((t) => '- ' + t).join('\n'));
  }
  if (rejected && rejected.length) {
    parts.push('前回の案は次の理由で使えませんでした。同じ形を繰り返さないでください:\n' +
      rejected.map((r) => `- ${r.title}（${r.reason}）`).join('\n'));
  }
  return parts.join('\n\n');
}

function requestFor(need, used, rejected, genre) {
  return {
    system: promptFor(genre),
    user: buildUserMessage(need, used, rejected),
    schema: schemaFor(need),
    schemaName: SCHEMA_NAME,
    effort: 'low',
    maxTokens: 8000,
  };
}

/** 本物を呼ぶ。テストではここを差し替える。 */
async function callModel(need, used, rejected, genre) {
  const json = await llm.json(requestFor(need, used, rejected, genre));
  return Array.isArray(json && json.topics) ? json.topics : [];
}

/**
 * 案をふるいにかける。使えるものと、落とした理由を返す。
 * seen は「もう使った・もう選んだ」の正規化済み集合（呼び出し側と共有して増やす）。
 */
function screen(candidates, seen) {
  const kept = [];
  const rejected = [];
  for (const raw of candidates || []) {
    const title = String(raw == null ? '' : raw).trim();
    const key = norm(title);
    if (title.length < TITLE_MIN) { rejected.push({ title, reason: '短すぎる' }); continue; }
    if (title.length > TITLE_MAX) { rejected.push({ title, reason: `${TITLE_MAX}文字を超えている` }); continue; }
    if (seen.has(key)) { rejected.push({ title, reason: '使ったネタか、同じ回のネタと重なっている' }); continue; }
    // ★ ネタは「〜したこと」のような名詞句で終わるので、文案用の「一人称＋過去形」の形では拾えない。
    //   ネタに一人称が入る理由は無いので、語が入った時点で落とす。
    if (FIRST_PERSON_WORD.test(title)) { rejected.push({ title, reason: '一人称の体験に読める' }); continue; }
    if (EXPLAIN_TAIL.test(title)) { rejected.push({ title, reason: '説明型（〜の使い分け・〜の違い）は穴埋めにならない' }); continue; }
    const banned = rules.bannedIn(title).filter((f) => f.severity === 'error');
    if (banned.length) { rejected.push({ title, reason: banned[0].message }); continue; }
    seen.add(key);
    kept.push(title);
  }
  return { kept, rejected };
}

/**
 * ネタを count 本作る。
 * 作り直しても揃わなければ、揃ったぶんだけ返す（止めずに見せる。足りなければ人が足す）。
 *
 * @param used     使ったネタ・動画のタイトル（重複を避ける相手）
 * @param options  { count, generate, maxAttempts, genre（'career' か 'ai'。既定は career） }
 */
async function generateTopics(used, options) {
  const opts = options || {};
  const count = opts.count || COUNT;
  const generate = opts.generate || callModel;
  const maxAttempts = opts.maxAttempts || MAX_ATTEMPTS;

  const usedList = [...new Set((used || []).map((t) => String(t || '').trim()).filter(Boolean))];
  const seen = new Set(usedList.map(norm));
  const topics = [];
  let rejected = [];
  let attempts = 0;

  while (topics.length < count && attempts < maxAttempts) {
    attempts++;
    const need = count - topics.length;
    let candidates;
    try {
      candidates = await generate(need, usedList.concat(topics), rejected, opts.genre);
    } catch (err) {
      rejected = [{ title: '(全体)', reason: err.message }];
      continue;
    }
    const r = screen(candidates, seen);
    topics.push(...r.kept.slice(0, need));
    rejected = r.rejected;
  }

  return { topics, attempts, rejected, ok: topics.length === count };
}

module.exports = {
  COUNT, TITLE_MIN, TITLE_MAX, SYSTEM_PROMPT, SYSTEM_PROMPTS, promptFor, schemaFor,
  norm, screen, buildUserMessage, requestFor, callModel, generateTopics,
};
