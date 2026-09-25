const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHandler } = require('../api/memo-extract.js');

const htmlPath = path.join(__dirname, '..', '..', 'day23-baydiary', 'index.html');
const good = { date: '2025-04-12', myTeam: 'baystars', opponent: '阪神', venue: '横浜スタジアム', score: { bay: 5, opp: 3 }, result: 'win', sourceText: '原文', highlight: '最高' };
const input = { text: '4/12 阪神に5-3で勝ち', defaultTeam: 'baystars', defaultYear: 2025 };

function fakeKv() {
  const counts = new Map();
  return { incr: async (k) => { const n = (counts.get(k) || 0) + 1; counts.set(k, n); return n; } };
}
function mockReq({ method = 'POST', headers = {}, body = {} } = {}) {
  return { method, headers, body };
}
function mockRes() {
  return {
    _status: 200, _json: null, _headers: {},
    status(code) { this._status = code; return this; },
    json(obj) { this._json = obj; return this; },
    end() { return this; },
    setHeader(k, v) { this._headers[k] = v; }
  };
}
const successfulFetch = async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ games: [good] }) }] }] }) });

test('OPTIONS preflight returns 204 with CORS headers for an allowed origin', async () => {
  const handler = createHandler({ htmlPath, kv: fakeKv() });
  const res = mockRes();
  await handler(mockReq({ method: 'OPTIONS', headers: { origin: 'capacitor://localhost' } }), res);
  assert.equal(res._status, 204);
  assert.equal(res._headers['Access-Control-Allow-Origin'], 'capacitor://localhost');
});

test('disallowed origin gets no Access-Control-Allow-Origin header', async () => {
  const handler = createHandler({ htmlPath, kv: fakeKv() });
  const res = mockRes();
  await handler(mockReq({ headers: { origin: 'https://evil.example' }, body: input }), res);
  assert.equal(res._headers['Access-Control-Allow-Origin'], undefined);
});

test('no configured key yields a clear error, no API call', async () => {
  const handler = createHandler({ htmlPath, key: '', kv: fakeKv(), fetchImpl: () => { throw new Error('must not call'); } });
  const res = mockRes();
  await handler(mockReq({ body: input }), res);
  assert.equal(res._status, 503);
});

test('rejects malformed or too-large input before calling the AI', async () => {
  const handler = createHandler({ htmlPath, key: 'test', kv: fakeKv(), fetchImpl: () => { throw new Error('must not call'); } });
  let res = mockRes(); await handler(mockReq({ body: { ...input, defaultTeam: 'x' } }), res); assert.equal(res._status, 400);
  res = mockRes(); await handler(mockReq({ body: { ...input, text: 'a'.repeat(30001) } }), res); assert.equal(res._status, 400);
});

test('sends the structured schema to OpenAI and returns games on success', async () => {
  const handler = createHandler({
    htmlPath, key: 'test-key', kv: fakeKv(),
    fetchImpl: async (url, opts) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(opts.body);
      assert.equal(body.store, false);
      assert.equal(body.text.format.strict, true);
      assert.equal(body.text.format.schema.additionalProperties, false);
      assert.equal(opts.headers.Authorization, 'Bearer test-key');
      return successfulFetch();
    }
  });
  const res = mockRes();
  await handler(mockReq({ body: input }), res);
  assert.equal(res._status, 200);
  assert.equal(res._json.games.length, 1);
});

test('rejects a response with more than 200 games', async () => {
  const handler = createHandler({
    htmlPath, key: 'test', kv: fakeKv(),
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ games: Array(201).fill(good) }) }] }] }) })
  });
  const res = mockRes();
  await handler(mockReq({ body: input }), res);
  assert.equal(res._status, 422);
});

test('provider errors never leak response details or credentials', async () => {
  const handler = createHandler({ htmlPath, key: 'secret-test', kv: fakeKv(), fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'secret-test' }) }) });
  const res = mockRes();
  await handler(mockReq({ body: input }), res);
  assert.equal(res._status, 502);
  assert.equal(JSON.stringify(res._json).includes('secret-test'), false);
});

test('per-device lifetime quota blocks a device past 3 uses, other devices unaffected', async () => {
  const handler = createHandler({ htmlPath, key: 'test', kv: fakeKv(), fetchImpl: successfulFetch });
  const call = (deviceId) => { const res = mockRes(); return handler(mockReq({ body: input, headers: { 'x-device-id': deviceId } }), res).then(() => res); };
  assert.equal((await call('device-a'))._status, 200);
  assert.equal((await call('device-a'))._status, 200);
  assert.equal((await call('device-a'))._status, 200);
  const blocked = await call('device-a');
  assert.equal(blocked._status, 429);
  assert.ok(blocked._json.error.includes('上限'));
  assert.equal((await call('device-b'))._status, 200);
});
