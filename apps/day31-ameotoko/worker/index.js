// 雨男決定戦の共有サーバー。状態は1つのJSONとしてKVに保存し、操作は logic.js の applyAction で適用する。
import { applyAction } from '../logic.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

const todayJST = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const load = async (env) => JSON.parse((await env.STATE.get('state')) || '{"members":[],"events":[]}');

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method === 'GET') return json({ state: await load(env) });
    if (req.method !== 'POST') return json({ error: 'method' }, 405);
    let action;
    try { action = await req.json(); } catch (e) { return json({ error: '不正なリクエストです' }, 400); }
    const state = await load(env);
    const r = applyAction(state, action, todayJST());
    if (r.error) return json({ error: r.error, state }, 400);
    const body = JSON.stringify(r.state);
    if (body.length > 500000) return json({ error: '記録が多すぎます', state }, 400);
    await env.STATE.put('state', body);
    return json({ state: r.state });
  },
};
