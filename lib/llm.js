'use strict';
/**
 * 文章を書かせる相手（Claude / OpenAI）を1か所に閉じ込める。
 *
 * ★ なぜ2つに対応するのか
 *   支払いの都合で使える先が決まることがある。片方に固定すると、
 *   そのために新しく支払い先を作ることになる（＝追加コスト）。
 *   設定してあるキーのほうを使う作りにしておけば、その必要がない。
 *
 * ★ SDK ではなく fetch
 *   このアプリは Meta / Google / TikTok / X / Supabase まで全部 fetch で
 *   手書きしていて、外部パッケージがひとつも無い。ここだけ SDK を入れると
 *   その方針が崩れる。
 *
 * ★ 出す形は JSON Schema で縛る
 *   プロンプトで頼むだけでは形が揺れる。ただし両者で書き方が違うので、
 *   同じスキーマを渡せば済むように、ここで translate する。
 */

const PROVIDERS = {
  anthropic: {
    label: 'Claude',
    keyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL',
    defaultModel: 'claude-opus-5',
  },
  openai: {
    label: 'OpenAI',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    // 構造化出力に対応していて安い。物足りなければ OPENAI_MODEL で差し替える。
    defaultModel: 'gpt-4o-mini',
  },
};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const has = (name) => !!(process.env[name] || '').trim();

/**
 * どちらを使うか決める。
 *
 * ★ LLM_PROVIDER があればそれに従う。無ければ、キーが入っているほうを使う。
 *   両方入っているときは Claude（この用途で作り込んであるのはこちら）。
 */
function provider() {
  const forced = (process.env.LLM_PROVIDER || '').trim().toLowerCase();
  if (forced) {
    const p = PROVIDERS[forced];
    if (!p) {
      throw fail(`LLM_PROVIDER に「${forced}」は指定できません。`,
        '指定できるのは ' + Object.keys(PROVIDERS).join(' / ') + ' です。');
    }
    if (!has(p.keyEnv)) {
      throw fail(`LLM_PROVIDER が ${forced} ですが、${p.keyEnv} が設定されていません。`);
    }
    return forced;
  }
  if (has('ANTHROPIC_API_KEY')) return 'anthropic';
  if (has('OPENAI_API_KEY')) return 'openai';

  throw fail(
    '文章を書かせるための鍵が設定されていません。',
    'Vercel の Settings → Environment Variables に ANTHROPIC_API_KEY か ' +
    'OPENAI_API_KEY のどちらかを追加して、再デプロイしてください。'
  );
}

function modelFor(id) {
  const p = PROVIDERS[id];
  return (process.env[p.modelEnv] || '').trim() || p.defaultModel;
}

/** 画面にそのまま出してよい断り。 */
function fail(message, hint) {
  const e = new Error(message);
  e.userError = true;
  if (hint) e.hint = hint;
  return e;
}

// ---------------------------------------------------------------------------
// スキーマの translate
// ---------------------------------------------------------------------------

/**
 * OpenAI の strict モードが受け付けない語を落とす。
 *
 * ★ minItems / maxItems は通らない。
 *   つまり「ちょうど6行」をスキーマでは縛れない。
 *   ただし draft-rules.js の row-count が同じことを見ていて、
 *   外れれば作り直しに回る。縛りが消えるのではなく、担当が移るだけ。
 */
const STRICT_UNSUPPORTED = [
  'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minProperties', 'maxProperties', 'default',
];

function forStrict(schema) {
  if (Array.isArray(schema)) return schema.map(forStrict);
  if (!schema || typeof schema !== 'object') return schema;

  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (STRICT_UNSUPPORTED.includes(k)) continue;
    out[k] = forStrict(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 呼び出し
// ---------------------------------------------------------------------------

/** Claude に渡す本体。バッチ投入でも同じものを使う。 */
function anthropicBody({ system, user, schema, effort, maxTokens }) {
  return {
    model: modelFor('anthropic'),
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort, format: { type: 'json_schema', schema } },
    // 毎回同じ前置きなので、キャッシュを効かせて単価を下げる。
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
  };
}

/**
 * OpenAI に渡す本体。
 *
 * ★ 出力の上限を指定していない。
 *   出るのは6行と短い本文だけで、放っておいても数百トークンに収まる。
 *   一方この項目の名前はモデル世代で変わる（max_tokens / max_completion_tokens）ので、
 *   指定すると model を差し替えたときに落ちる。省くほうが壊れにくい。
 */
function openaiBody({ system, user, schema, schemaName }) {
  return {
    model: modelFor('openai'),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: schemaName || 'draft', schema: forStrict(schema), strict: true },
    },
  };
}

/** 相手に合わせて本体を組み立てる。中身を見たいときのために外へ出す。 */
function buildBody(id, req) {
  return id === 'openai' ? openaiBody(req) : anthropicBody(req);
}

async function post(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers),
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, statusText: res.statusText, json };
}

/**
 * JSON をひとつ書かせて、解いて返す。
 *
 * @param req { system, user, schema, schemaName, effort, maxTokens }
 */
async function json(req) {
  const id = provider();
  const p = PROVIDERS[id];
  const key = process.env[p.keyEnv].trim();

  const out = id === 'openai'
    ? await post(OPENAI_URL, { authorization: `Bearer ${key}` }, buildBody(id, req))
    : await post(ANTHROPIC_URL, { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
                 buildBody(id, req));

  if (!out.ok) throw fail(errorMessage(p, out));

  const text = id === 'openai' ? openaiText(p, out.json) : anthropicText(p, out.json);
  try {
    return JSON.parse(text);
  } catch (_) {
    throw fail(`${p.label} の返事が JSON になっていませんでした。`);
  }
}

/** 番号だけ出しても直せないので、直し方まで言う。 */
function errorMessage(p, out) {
  const detail = (out.json && out.json.error && out.json.error.message) || out.statusText;

  if (out.status === 401) {
    return `${p.keyEnv} が正しくないようです（401）。Vercel の環境変数を確認して、再デプロイしてください。`;
  }
  if (out.status === 429) {
    return `${p.label} が混み合っているか、上限に達しています（429）。少し待ってからお試しください。｜${detail}`;
  }
  if (out.status === 400 && /model/i.test(String(detail))) {
    return `${p.label} がモデル名を受け付けませんでした。${p.modelEnv} を設定するか、外して既定に戻してください。｜${detail}`;
  }
  return `${p.label} の呼び出しに失敗しました（${out.status}）: ${detail}`;
}

function anthropicText(p, body) {
  if (body.stop_reason === 'refusal') {
    throw fail(`${p.label} が生成を断りました。ネタの指定を見直してください。`);
  }
  return (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function openaiText(p, body) {
  const choice = (body.choices || [])[0];
  if (!choice) throw fail(`${p.label} から返事がありませんでした。`);

  // 断られたときは content ではなく refusal に入る。
  if (choice.message && choice.message.refusal) {
    throw fail(`${p.label} が生成を断りました。ネタの指定を見直してください。｜` +
               String(choice.message.refusal).slice(0, 200));
  }
  if (choice.finish_reason === 'length') {
    throw fail(`${p.label} の返事が途中で切れました。もう一度お試しください。`);
  }
  return (choice.message && choice.message.content) || '';
}

module.exports = {
  PROVIDERS, STRICT_UNSUPPORTED,
  provider, modelFor, forStrict, buildBody, json, fail,
};
