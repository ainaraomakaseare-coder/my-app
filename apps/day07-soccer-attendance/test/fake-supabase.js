#!/usr/bin/env node
// 【テスト用】Supabase の代わりに、手元の PostgreSQL に繋ぐ小さなサーバー。
// 本番では使いません。画面の通し確認のためだけのものです。
//
//   node test/fake-supabase.js   （PGDATABASE などの環境変数で接続先を指定）

const http = require('http');
const { execFileSync } = require('child_process');

const PORT = Number(process.env.FAKE_PORT) || 54321;
const PSQL = process.env.PSQL || 'psql';
const DB = process.env.PGDATABASE || 'soccer';

// 関数の引数の型を pg_catalog から引いて、正しくキャストして呼ぶ仕掛け
const DISPATCHER = `
create or replace function test_rpc(p_fn text, p_args jsonb) returns jsonb
language plpgsql as $fn$
declare
  v_types  text[];
  v_names  text[];
  v_parts  text[] := '{}';
  v_sql    text;
  v_res    jsonb;
  i        int;
  v        jsonb;
  v_lit    text;
begin
  select p.proargnames, array(select format_type(t, null) from unnest(p.proargtypes) t)
    into v_names, v_types
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = p_fn
   limit 1;

  if v_names is null then
    raise exception '関数が見つかりません: %', p_fn;
  end if;

  for i in 1 .. array_length(v_names, 1) loop
    v := p_args -> v_names[i];
    if v is null or jsonb_typeof(v) = 'null' then
      v_lit := format('null::%s', v_types[i]);
    elsif jsonb_typeof(v) = 'array' then
      v_lit := format('%L::%s',
        (select coalesce('{' || string_agg('"' || replace(x, '"', '\\"') || '"', ',') || '}', '{}')
           from jsonb_array_elements_text(v) x), v_types[i]);
    else
      v_lit := format('%L::%s', v #>> '{}', v_types[i]);
    end if;
    v_parts := v_parts || format('%I => %s', v_names[i], v_lit);
  end loop;

  v_sql := format('select to_jsonb(%I(%s))', p_fn, array_to_string(v_parts, ', '));
  execute v_sql into v_res;
  return v_res;
end $fn$;
`;

function sql(text) {
  return execFileSync(PSQL, ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-c', text],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

sql(DISPATCHER);

http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  const m = req.url.match(/^\/rest\/v1\/rpc\/([a-z0-9_]+)$/i);
  if (!m) { res.writeHead(404, cors); res.end('{"message":"not found"}'); return; }

  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    try {
      const args = body ? JSON.parse(body) : {};
      const out = sql(`select test_rpc(${lit(m[1])}, ${lit(JSON.stringify(args))}::jsonb)`).trim();
      res.writeHead(200, cors);
      res.end(out || 'null');
    } catch (e) {
      const err = String((e.stderr || e.message || '')).split('\n')
        .find((l) => l.includes('ERROR:')) || String(e.message);
      res.writeHead(400, cors);
      res.end(JSON.stringify({ message: err.replace(/^.*ERROR:\s*/, '') }));
    }
  });
}).listen(PORT, () => console.log('fake-supabase: http://localhost:' + PORT));

function lit(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
