// Vercel serverless function: public backend for 観戦日記's "メモから一括登録" AI feature.
//
// This reads the same TEAMS / MEMO_SCHEMA / memoInstructions() definitions that
// apps/day23-baydiary/index.html uses, straight out of that file, the same way
// apps/day23-baydiary/server.cjs (the local dev version of this same endpoint)
// does. That means this Vercel project's "Root Directory" must be set to
// apps/day23-baydiary-api AND its "Include files outside the Root Directory"
// setting must be turned on, so this function can read the sibling app's
// index.html at runtime. See ../README.md for the exact setup steps.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ALLOWED_ORIGINS = new Set([
  'https://ainaraomakaseare-coder.github.io',
  'capacitor://localhost',
  'http://localhost:60154',
  'http://127.0.0.1:60154'
]);
const GAMES_LIMIT = 200;
const DEVICE_LIFETIME_LIMIT = 3;

let cachedBox = null;
function loadLogic(htmlPath) {
  if (cachedBox) return cachedBox;
  const html = fs.readFileSync(htmlPath, 'utf8');
  const logic = html.slice(html.indexOf('var LOGIC_MARK_START'), html.indexOf('var LOGIC_MARK_END = 1;'));
  const box = {};
  vm.runInNewContext(logic, box);
  cachedBox = box;
  return box;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Device-Id');
}

// options let tests inject a fake kv store / fetch / html path without touching
// a real Redis instance or the OpenAI API.
function createHandler({
  key = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_MODEL || 'gpt-4o-mini',
  fetchImpl = fetch,
  kv = null,
  htmlPath = path.join(__dirname, '..', '..', 'day23-baydiary', 'index.html')
} = {}) {
  const store = kv || requireDefaultKv();
  return async (req, res) => {
    applyCors(req, res);
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'POSTを使用してください。' }); return; }
    if (!key) { res.status(503).json({ error: 'AI読み取りの接続設定がまだありません。しばらくしてから再試行してください。' }); return; }

    const deviceId = String(req.headers['x-device-id'] || '').slice(0, 200) || 'unknown';
    let usedByDevice;
    try {
      usedByDevice = await store.incr('baydiary:memo-uses:' + deviceId);
    } catch (e) {
      res.status(503).json({ error: '利用回数の確認に失敗しました。時間をおいて再試行してください。' });
      return;
    }
    if (usedByDevice > DEVICE_LIFETIME_LIMIT) {
      res.status(429).json({ error: 'この端末での利用上限（' + DEVICE_LIFETIME_LIMIT + '回）を超えました。' });
      return;
    }

    let box;
    try {
      box = loadLogic(htmlPath);
    } catch (e) {
      res.status(500).json({ error: 'サーバー内部エラーです。' });
      return;
    }

    const input = req.body;
    if (
      !input ||
      typeof input.text !== 'string' ||
      !input.text.trim() ||
      input.text.length > 30000 ||
      !box.TEAMS.some((t) => t.id === input.defaultTeam) ||
      (input.defaultYear !== null && input.defaultYear !== undefined &&
        (!Number.isInteger(input.defaultYear) || input.defaultYear < 1900 || input.defaultYear > 9999))
    ) {
      res.status(400).json({ error: 'メモ・応援球団・補完年度を確認してください。' });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 55000);
    try {
      const response = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          store: false,
          max_output_tokens: 14000,
          instructions: box.memoInstructions(),
          input: JSON.stringify({ text: input.text, defaultTeam: input.defaultTeam, defaultYear: input.defaultYear ?? null }),
          text: { format: { type: 'json_schema', name: 'baseball_diary_import', strict: true, schema: box.MEMO_SCHEMA } }
        })
      });
      if (!response.ok) {
        res.status(response.status === 429 ? 429 : 502).json({
          error: response.status === 429 ? 'AIサービスの利用上限です。時間をおいて再試行してください。' : 'AIサービスへ接続できませんでした。'
        });
        return;
      }
      const result = await response.json();
      const content = (result.output || []).flatMap((item) => item.content || []);
      if (content.some((c) => c.type === 'refusal')) {
        res.status(422).json({ error: 'このメモはAIで読み取れませんでした。内容を確認するかJSONを直接入力してください。' });
        return;
      }
      if (result.status !== 'completed') {
        res.status(422).json({ error: '読み取りが完了しませんでした。メモを分割して再試行してください。' });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(content.filter((c) => c.type === 'output_text').map((c) => c.text).join(''));
      } catch (e) {
        res.status(502).json({ error: 'AIの応答を読み取れませんでした。' });
        return;
      }
      if (!parsed || !Array.isArray(parsed.games) || parsed.games.length > GAMES_LIMIT) {
        res.status(422).json({ error: '一度に' + GAMES_LIMIT + '試合までです。メモを分割してください。' });
        return;
      }
      res.status(200).json({ games: parsed.games });
    } catch (error) {
      const timedOut = controller.signal.aborted;
      res.status(timedOut ? 504 : 502).json({
        error: timedOut ? 'AI読み取りが時間切れになりました。メモを分割して再試行してください。' : 'AIサービスとの通信に失敗しました。メモは保存されていません。'
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

function requireDefaultKv() {
  // Deferred require so tests that always inject their own `kv` never need
  // @vercel/kv installed or real KV_REST_API_* env vars to run.
  return require('@vercel/kv').kv;
}

// The default export is what Vercel actually calls. It builds the real
// handler (touching @vercel/kv) only on first real request, never at
// `require()` time, so unit tests can `require('./memo-extract.js').createHandler`
// with an injected fake kv/fetch without @vercel/kv being installed at all.
let defaultHandler = null;
function handler(req, res) {
  if (!defaultHandler) defaultHandler = createHandler();
  return defaultHandler(req, res);
}
handler.config = { api: { bodyParser: { sizeLimit: '160kb' } } };
handler.createHandler = createHandler;
module.exports = handler;
