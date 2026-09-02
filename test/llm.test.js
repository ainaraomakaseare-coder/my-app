'use strict';
/**
 * 書かせる相手（Claude / OpenAI）の切り替えを確かめる。
 *
 * ネットには出ないので fetch を差し替えて、
 * 「どこへ、どんな形で投げたか」「返事をどう解いたか」を見る。
 *
 *   node test/llm.test.js
 */
const assert = require('assert');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['ok', name]); }
  catch (err) { results.push(['NG', name + ' → ' + err.message]); }
}

const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_MODEL', 'OPENAI_MODEL', 'LLM_PROVIDER'];

/** 環境変数を入れ替えて lib/llm.js を読み直す。 */
function load(env) {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env || {})) process.env[k] = v;
  delete require.cache[require.resolve('../lib/llm.js')];
  return require('../lib/llm.js');
}

/** fetch を差し替えて、投げた中身と返す中身を握る。 */
async function withFetch(reply, fn) {
  const real = global.fetch;
  const seen = {};
  global.fetch = async (url, opt) => {
    seen.url = String(url);
    seen.headers = opt.headers;
    seen.body = JSON.parse(opt.body);
    return {
      ok: reply.ok !== false,
      status: reply.status || 200,
      statusText: reply.statusText || 'OK',
      async json() { return reply.json; },
    };
  };
  try { seen.result = await fn(); } catch (e) { seen.error = e; }
  finally { global.fetch = real; }
  return seen;
}

const REQ = {
  system: '前置き',
  user: 'ネタ:「テスト」',
  schema: {
    type: 'object',
    properties: {
      rows: { type: 'array', minItems: 6, maxItems: 6, items: { type: 'string', maxLength: 8 } },
      tone: { type: 'string', enum: ['calm', 'plain'] },
    },
    required: ['rows', 'tone'],
    additionalProperties: false,
  },
  schemaName: 'reel_draft',
  effort: 'medium',
  maxTokens: 16000,
};

const DRAFT = { rows: ['a', 'b', 'c', 'd', 'e', 'f'], tone: 'calm' };
const ANTHROPIC_OK = { content: [{ type: 'text', text: JSON.stringify(DRAFT) }] };
const OPENAI_OK = { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(DRAFT) } }] };

(async () => {
  // ---------------------------------------------------------------- 相手選び
  await check('鍵が1つも無ければ、直し方まで言って断る', () => {
    const llm = load({});
    assert.throws(() => llm.provider(), (e) => /鍵が設定されていません/.test(e.message) &&
                                               /OPENAI_API_KEY/.test(e.hint));
  });

  await check('OpenAI の鍵だけなら OpenAI を使う', () => {
    assert.strictEqual(load({ OPENAI_API_KEY: 'sk-x' }).provider(), 'openai');
  });

  await check('Claude の鍵だけなら Claude を使う', () => {
    assert.strictEqual(load({ ANTHROPIC_API_KEY: 'sk-ant' }).provider(), 'anthropic');
  });

  await check('両方あるときは Claude', () => {
    assert.strictEqual(load({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'b' }).provider(), 'anthropic');
  });

  await check('LLM_PROVIDER の指定が優先される', () => {
    const llm = load({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'b', LLM_PROVIDER: 'openai' });
    assert.strictEqual(llm.provider(), 'openai');
  });

  await check('指定した相手の鍵が無ければ断る', () => {
    const llm = load({ ANTHROPIC_API_KEY: 'a', LLM_PROVIDER: 'openai' });
    assert.throws(() => llm.provider(), /OPENAI_API_KEY が設定されていません/);
  });

  await check('知らない相手を指定したら断る', () => {
    const llm = load({ OPENAI_API_KEY: 'b', LLM_PROVIDER: 'gemini' });
    assert.throws(() => llm.provider(), /指定できません/);
  });

  // ★ 空文字は「設定されている」ではない。Vercel で値を消し忘れると起きる。
  await check('中身が空の鍵は、設定されていないものとして扱う', () => {
    const llm = load({ ANTHROPIC_API_KEY: '  ', OPENAI_API_KEY: 'sk-x' });
    assert.strictEqual(llm.provider(), 'openai');
  });

  await check('モデルは環境変数で差し替えられる', () => {
    assert.strictEqual(load({ OPENAI_API_KEY: 'b' }).modelFor('openai'), 'gpt-4o-mini');
    assert.strictEqual(
      load({ OPENAI_API_KEY: 'b', OPENAI_MODEL: 'gpt-4.1' }).modelFor('openai'), 'gpt-4.1');
  });

  // ---------------------------------------------------------------- 形の translate
  await check('OpenAI の strict が通さない語だけを落とす', () => {
    const llm = load({ OPENAI_API_KEY: 'b' });
    const out = llm.forStrict(REQ.schema);
    assert.ok(!('minItems' in out.properties.rows));
    assert.ok(!('maxLength' in out.properties.rows.items));
    // 落としてはいけないもの
    assert.deepStrictEqual(out.properties.tone.enum, ['calm', 'plain']);
    assert.deepStrictEqual(out.required, ['rows', 'tone']);
    assert.strictEqual(out.additionalProperties, false);
    // 元を書き換えない
    assert.strictEqual(REQ.schema.properties.rows.minItems, 6);
  });

  // ---------------------------------------------------------------- 送り先と形
  await check('Claude には x-api-key を付けて送る', async () => {
    const llm = load({ ANTHROPIC_API_KEY: 'sk-ant' });
    const seen = await withFetch({ json: ANTHROPIC_OK }, () => llm.json(REQ));
    assert.ok(seen.url.includes('api.anthropic.com'), seen.url);
    assert.strictEqual(seen.headers['x-api-key'], 'sk-ant');
    assert.strictEqual(seen.headers['anthropic-version'], '2023-06-01');
    assert.strictEqual(seen.body.output_config.format.type, 'json_schema');
    assert.deepStrictEqual(seen.result, DRAFT);
  });

  await check('OpenAI には Authorization を付けて送る', async () => {
    const llm = load({ OPENAI_API_KEY: 'sk-x' });
    const seen = await withFetch({ json: OPENAI_OK }, () => llm.json(REQ));
    assert.ok(seen.url.includes('api.openai.com'), seen.url);
    assert.strictEqual(seen.headers.authorization, 'Bearer sk-x');
    assert.strictEqual(seen.body.response_format.json_schema.name, 'reel_draft');
    assert.strictEqual(seen.body.response_format.json_schema.strict, true);
    assert.deepStrictEqual(seen.result, DRAFT);
  });

  // ★ 出力上限を送らない。項目名がモデル世代で変わるので、送ると差し替えで落ちる。
  await check('OpenAI には出力の上限を送らない', async () => {
    const llm = load({ OPENAI_API_KEY: 'sk-x' });
    const seen = await withFetch({ json: OPENAI_OK }, () => llm.json(REQ));
    assert.ok(!('max_tokens' in seen.body) && !('max_completion_tokens' in seen.body));
  });

  await check('鍵の前後の空白は落として送る', async () => {
    const llm = load({ OPENAI_API_KEY: ' sk-x \n' });
    const seen = await withFetch({ json: OPENAI_OK }, () => llm.json(REQ));
    assert.strictEqual(seen.headers.authorization, 'Bearer sk-x');
  });

  // ---------------------------------------------------------------- 失敗の伝え方
  await check('401 は「鍵を確認して再デプロイ」と伝える', async () => {
    const llm = load({ OPENAI_API_KEY: 'sk-x' });
    const seen = await withFetch(
      { ok: false, status: 401, json: { error: { message: 'bad key' } } }, () => llm.json(REQ));
    assert.ok(/OPENAI_API_KEY が正しくない/.test(seen.error.message), seen.error.message);
    assert.ok(/再デプロイ/.test(seen.error.message));
  });

  await check('429 は待つよう伝える', async () => {
    const llm = load({ ANTHROPIC_API_KEY: 'a' });
    const seen = await withFetch(
      { ok: false, status: 429, json: { error: { message: 'rate limit' } } }, () => llm.json(REQ));
    assert.ok(/待って/.test(seen.error.message), seen.error.message);
  });

  await check('モデル名が違うときは、直す場所を言う', async () => {
    const llm = load({ OPENAI_API_KEY: 'sk-x', OPENAI_MODEL: 'gpt-9' });
    const seen = await withFetch(
      { ok: false, status: 400, json: { error: { message: 'The model `gpt-9` does not exist' } } },
      () => llm.json(REQ));
    assert.ok(/OPENAI_MODEL/.test(seen.error.message), seen.error.message);
  });

  await check('断られたときは、そう分かる形で返す', async () => {
    const llm = load({ OPENAI_API_KEY: 'sk-x' });
    const seen = await withFetch(
      { json: { choices: [{ message: { refusal: 'I cannot help' } }] } }, () => llm.json(REQ));
    assert.ok(/断りました/.test(seen.error.message), seen.error.message);
  });

  await check('Claude が断ったときも同じ', async () => {
    const llm = load({ ANTHROPIC_API_KEY: 'a' });
    const seen = await withFetch({ json: { stop_reason: 'refusal', content: [] } }, () => llm.json(REQ));
    assert.ok(/断りました/.test(seen.error.message), seen.error.message);
  });

  await check('途中で切れたときは、それと分かる', async () => {
    const llm = load({ OPENAI_API_KEY: 'sk-x' });
    const seen = await withFetch(
      { json: { choices: [{ finish_reason: 'length', message: { content: '{"rows"' } }] } },
      () => llm.json(REQ));
    assert.ok(/途中で切れました/.test(seen.error.message), seen.error.message);
  });

  await check('JSON になっていなければ、そう言う', async () => {
    const llm = load({ OPENAI_API_KEY: 'sk-x' });
    const seen = await withFetch(
      { json: { choices: [{ finish_reason: 'stop', message: { content: 'すみません' } }] } },
      () => llm.json(REQ));
    assert.ok(/JSON になっていません/.test(seen.error.message), seen.error.message);
  });

  // ---------------------------------------------------------------- 通しで
  await check('OpenAI だけの設定でも、下書きが最後まで作れる', async () => {
    load({ OPENAI_API_KEY: 'sk-x' });
    delete require.cache[require.resolve('../lib/draft-generate.js')];
    const gen = require('../lib/draft-generate.js');

    const draft = {
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
      igCaption: '5番がいちばん刺さる…。第二新卒の口コミを集めた結果です',
      ttCaption: '5番がいちばん刺さる…。第二新卒の口コミを集めた結果です',
      xText: '「転職活動がバレにくい進め方」6つ、答え合わせ。',
      tone: 'calm',
    };

    const seen = await withFetch(
      { json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft) } }] } },
      () => gen.generateDraft({ topicId: 'N01', title: '転職がバレない進め方' }));

    assert.ok(!seen.error, seen.error && seen.error.message);
    assert.strictEqual(seen.result.ok, true, JSON.stringify(seen.result.findings));
    assert.strictEqual(seen.result.draft.title, draft.title);
    assert.ok(seen.url.includes('api.openai.com'));
  });

  for (const k of KEYS) delete process.env[k];

  const bad = results.filter((r) => r[0] === 'NG');
  for (const [mark, name] of results) console.log(`  ${mark === 'ok' ? '✓' : '✗'} ${name}`);
  console.log(`\n  ${results.length - bad.length} / ${results.length} 件成功`);
  process.exit(bad.length ? 1 : 0);
})();
