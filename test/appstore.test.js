'use strict';
/**
 * App Store のダウンロード数（lib/appstore.js）を確かめる。
 *
 * ★ ここで守りたいのは4つ。
 *   1. 新規ダウンロードだけを数える（再ダウンロード・アップデート・課金は入れない）
 *   2. 累計で同じ日を二重に数えない（月次と日次の両方がある月）
 *   3. まだ出ていない日は「0件」ではなく「まだ」として扱う
 *   4. 鍵が無い・違うときは、何を直せばよいかを返す
 *
 *   node test/appstore.test.js
 */
const assert = require('assert');
const crypto = require('crypto');
const zlib = require('zlib');
const appstore = require('../lib/appstore');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['ok', name]); }
  catch (err) { results.push(['NG', name + ' → ' + err.message]); }
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const ENV = { ASC_KEY_ID: 'KEY123', ASC_ISSUER_ID: 'issuer-1', ASC_PRIVATE_KEY: PEM, ASC_VENDOR_NUMBER: '8000001' };

const HEAD = ['Provider', 'Provider Country', 'SKU', 'Developer', 'Title', 'Version',
  'Product Type Identifier', 'Units', 'Developer Proceeds', 'Begin Date', 'End Date',
  'Customer Currency', 'Country Code', 'Currency of Proceeds', 'Apple Identifier'];
function tsv(rows) {
  const lines = [HEAD.join('\t')];
  for (const [title, type, units, id] of rows) {
    lines.push(['APPLE', 'US', 'sku', 'dev', title, '1.0', type, String(units), '0', '', '', 'JPY', 'JP', 'JPY', id].join('\t'));
  }
  return lines.join('\n') + '\n';
}

/** Apple の代わり。reports[`DAILY|2026-10-03`] = rows。無い日は 404。pending に入れた日は「まだ」。 */
function fakeApple({ reports = {}, pending = [], status } = {}) {
  const calls = [];
  const fetch = async (url, opt) => {
    const u = new URL(url);
    const key = `${u.searchParams.get('filter[frequency]')}|${u.searchParams.get('filter[reportDate]')}`;
    calls.push({ key, auth: opt.headers.Authorization });
    if (status) return res(status, 'denied');
    if (pending.includes(key)) return res(404, '{"errors":[{"detail":"Report is not available yet. Daily reports are available by 8 am PT"}]}');
    if (!reports[key]) return res(404, '{"errors":[{"detail":"There were no sales for the date specified."}]}');
    return res(200, zlib.gzipSync(tsv(reports[key])));
  };
  return { fetch, calls };
}
function res(status, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    status, ok: status >= 200 && status < 300,
    text: async () => buf.toString('utf8'),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
  };
}

// 日本時間 2026-10-05 15:00
const NOW = Date.parse('2026-10-05T06:00:00Z');

(async () => {
  await check('鍵が無いときは、足りない名前だけを返す（Apple には行かない）', async () => {
    const apple = fakeApple();
    const out = await appstore.downloads({ env: { ASC_KEY_ID: 'x' }, fetch: apple.fetch, now: NOW });
    assert.strictEqual(out.configured, false);
    assert.deepStrictEqual(out.missing, ['ASC_ISSUER_ID', 'ASC_PRIVATE_KEY', 'ASC_VENDOR_NUMBER']);
    assert.strictEqual(apple.calls.length, 0);
  });

  await check('入場券は ES256 で署名され、公開鍵で確かめられる', async () => {
    const jwt = appstore.token(ENV, NOW);
    const [h, b, s] = jwt.split('.');
    const head = JSON.parse(Buffer.from(h, 'base64url'));
    const body = JSON.parse(Buffer.from(b, 'base64url'));
    assert.deepStrictEqual(head, { alg: 'ES256', kid: 'KEY123', typ: 'JWT' });
    assert.strictEqual(body.aud, 'appstoreconnect-v1');
    assert.strictEqual(body.iss, 'issuer-1');
    assert.ok(body.exp - body.iat <= 20 * 60, '有効期限が Apple の上限20分を超えている');
    const ok = crypto.verify('sha256', Buffer.from(`${h}.${b}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    assert.ok(ok, '署名が合わない');
  });

  await check('.p8 は「\\n」で書いても、頭と尻尾が無くても読める', async () => {
    const escaped = PEM.trim().replace(/\n/g, '\\n');
    assert.ok(appstore.token(Object.assign({}, ENV, { ASC_PRIVATE_KEY: escaped }), NOW));
    const bare = PEM.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    assert.ok(appstore.token(Object.assign({}, ENV, { ASC_PRIVATE_KEY: bare }), NOW));
  });

  await check('読めない鍵は、貼り直し方を返す', async () => {
    try {
      appstore.token(Object.assign({}, ENV, { ASC_PRIVATE_KEY: 'abc' }), NOW);
      assert.fail('通ってしまった');
    } catch (e) {
      assert.ok(e.userError);
      assert.ok(/BEGIN PRIVATE KEY/.test(e.hint));
    }
  });

  await check('新規ダウンロードだけを数える（再ダウンロード・アップデート・課金は除く）', async () => {
    const got = appstore.parseReport(tsv([
      ['うちの家事', '1F', 3, '111'],
      ['うちの家事', '1T', 1, '111'],
      ['うちの家事', '3F', 5, '111'],
      ['うちの家事', '7F', 9, '111'],
      ['うちの家事', 'IA1', 2, '111'],
      ['観戦日記', '1F', 2, '222'],
    ]));
    assert.deepStrictEqual(got, { 111: { title: 'うちの家事', units: 4 }, 222: { title: '観戦日記', units: 2 } });
  });

  await check('累計・最新の日・直近7日を、同じ日を二重に数えずに出す', async () => {
    appstore._cache.clear();
    const apple = fakeApple({
      reports: {
        'MONTHLY|2026-09': [['うちの家事', '1F', 10, '111'], ['観戦日記', '1F', 4, '222']],
        // 9月の日次（直近7日に入る分）。月次と重ねて累計に足してはいけない。
        'DAILY|2026-09-28': [['うちの家事', '1F', 2, '111']],
        'DAILY|2026-10-01': [['うちの家事', '1F', 1, '111']],
        'DAILY|2026-10-03': [['うちの家事', '1F', 2, '111'], ['おもいでWiki', '1F', 1, '333']],
      },
      pending: ['DAILY|2026-10-04'],
    });
    const out = await appstore.downloads({ env: ENV, fetch: apple.fetch, now: NOW });
    assert.strictEqual(out.configured, true);
    assert.strictEqual(out.latestDate, '2026-10-03', '「まだ」の10/4を最新にしている');
    assert.deepStrictEqual(out.pending, ['2026-10-04']);
    const by = Object.fromEntries(out.apps.map((a) => [a.title, a]));
    assert.strictEqual(by['うちの家事'].total, 13);   // 9月10 + 10/1 1 + 10/3 2
    assert.strictEqual(by['うちの家事'].latest, 2);
    assert.strictEqual(by['うちの家事'].last7, 5);    // 9/28 2 + 10/1 1 + 10/3 2
    assert.strictEqual(by['観戦日記'].total, 4);
    assert.strictEqual(by['観戦日記'].latest, 0);
    assert.strictEqual(by['おもいでWiki'].total, 1);
    assert.strictEqual(out.apps[0].title, 'うちの家事', '累計の多い順になっていない');
    assert.ok(apple.calls.every((c) => /^Bearer /.test(c.auth)));
  });

  await check('先月の月次がまだ出ていなければ、その月は日次で数える', async () => {
    appstore._cache.clear();
    const apple = fakeApple({
      reports: {
        'DAILY|2026-09-15': [['旅の足跡', '1F', 3, '444']],
        'DAILY|2026-10-02': [['旅の足跡', '1F', 1, '444']],
      },
      pending: ['MONTHLY|2026-09'],
    });
    const out = await appstore.downloads({ env: ENV, fetch: apple.fetch, now: NOW });
    assert.strictEqual(out.apps[0].total, 4);
  });

  await check('済んだレポートは覚えておき、2回目は Apple に聞き直さない（まだの日だけ聞く）', async () => {
    appstore._cache.clear();
    const apple = fakeApple({ pending: ['DAILY|2026-10-04'] });
    await appstore.downloads({ env: ENV, fetch: apple.fetch, now: NOW });
    const first = apple.calls.length;
    await appstore.downloads({ env: ENV, fetch: apple.fetch, now: NOW });
    assert.deepStrictEqual(apple.calls.slice(first).map((c) => c.key), ['DAILY|2026-10-04']);
  });

  await check('403 は「キーの役割」を直すよう返す', async () => {
    appstore._cache.clear();
    const apple = fakeApple({ status: 403 });
    try {
      await appstore.downloads({ env: ENV, fetch: apple.fetch, now: NOW });
      assert.fail('通ってしまった');
    } catch (e) {
      assert.ok(e.userError);
      assert.ok(/Sales/.test(e.hint));
    }
  });

  await check('401 は「鍵の組み合わせ」を確かめるよう返す', async () => {
    appstore._cache.clear();
    const apple = fakeApple({ status: 401 });
    try {
      await appstore.downloads({ env: ENV, fetch: apple.fetch, now: NOW });
      assert.fail('通ってしまった');
    } catch (e) {
      assert.ok(e.userError);
      assert.ok(/ASC_KEY_ID/.test(e.hint));
    }
  });

  const ng = results.filter((r) => r[0] === 'NG');
  for (const [state, name] of results) console.log(`  ${state === 'ok' ? '✓' : '✗'} ${name}`);
  console.log(`\n  ${results.length - ng.length} / ${results.length} 件成功`);
  if (ng.length) process.exit(1);
})();
