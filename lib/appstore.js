'use strict';
/**
 * App Store のダウンロード数（App Store Connect API の「売上とトレンド」レポート）。
 *
 *   const out = await appstore.downloads();
 *   // { configured, apps:[{appleId,title,total,latest,last7}], latestDate, since, pending, errors }
 *
 * ★ 数え方は App Store Connect の「売上とトレンド」の「ユニット数」と同じ。
 *   製品タイプが「新規ダウンロード」の行だけを数える。再ダウンロードとアップデートは入れない。
 *   アナリティクスの「初回ダウンロード数」とは少しずれることがある（Apple 側の数え方の違い）。
 *
 * ★ 鍵は Vercel の環境変数にだけ置く（公開リポジトリなので、ここにもログにも出さない）。
 *   ASC_KEY_ID        … キーID
 *   ASC_ISSUER_ID     … 発行者ID
 *   ASC_PRIVATE_KEY   … .p8 ファイルの中身（改行ごと貼る。「\n」で書いても読める）
 *   ASC_VENDOR_NUMBER … ベンダー番号（「支払いと財務レポート」の左上）
 *
 * ★ 保存はしない。見るたびに Apple から取る。
 *   済んだ月は月次レポート1回で済ませ、今月（と月次がまだ出ていない月）だけ日次で取る。
 *   済んだ日のレポートは変わらないので、同じサーバーの中では覚えておく。
 *
 * ★ npm を増やさない。署名（ES256）は Node の crypto、展開は zlib で足りる。
 */

const crypto = require('crypto');
const zlib = require('zlib');

const BASE = 'https://api.appstoreconnect.apple.com/v1/salesReports';
const ENV_KEYS = ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_PRIVATE_KEY', 'ASC_VENDOR_NUMBER'];

// 新規ダウンロードの製品タイプ（iPhone/ユニバーサル/iPad/Mac/カスタム）。
const FIRST_DOWNLOAD = new Set(['1', '1F', '1T', 'F1', '1E', '1EP', '1EU']);

// さかのぼる長さ。アプリはどれもここ1年以内に出したもの。
const MONTHS_BACK = 12;
const PARALLEL = 6;

/** 済んだレポート（ある日・ある月の中身は後から変わらない）。サーバーが生きている間だけ。 */
const cache = new Map();

function missingEnv(env) {
  return ENV_KEYS.filter((k) => !String(env[k] || '').trim());
}

/** .p8 の中身を PEM に整える。改行が「\n」の文字になっていても、頭と尻尾が無くても読む。 */
function toPem(raw) {
  let s = String(raw || '').trim().replace(/\\n/g, '\n');
  if (!/BEGIN PRIVATE KEY/.test(s)) {
    const body = s.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').trim();
    s = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
  }
  return s;
}

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** App Store Connect API の入場券（JWT、ES256）。有効期限は Apple の上限の20分より短く。 */
function token(env, now) {
  const iat = Math.floor((now || Date.now()) / 1000);
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: env.ASC_KEY_ID.trim(), typ: 'JWT' }));
  const body = b64url(JSON.stringify({
    iss: env.ASC_ISSUER_ID.trim(), iat, exp: iat + 15 * 60, aud: 'appstoreconnect-v1',
  }));
  let key;
  try {
    key = crypto.createPrivateKey(toPem(env.ASC_PRIVATE_KEY));
  } catch (_) {
    throw userError('ASC_PRIVATE_KEY が .p8 の中身として読めません。',
      '.p8 ファイルをメモ帳で開き、「-----BEGIN PRIVATE KEY-----」から最後の行まで全部を貼ってください。');
  }
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64url(sig)}`;
}

function userError(message, hint) {
  const e = new Error(message);
  e.hint = hint;
  e.userError = true;
  return e;
}

/**
 * レポートの TSV から、アプリごとの新規ダウンロード数を数える。
 * 返り値: { [appleId]: { title, units } }
 */
function parseReport(tsv) {
  const lines = String(tsv || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return {};
  const cols = lines[0].split('\t').map((c) => c.trim());
  const at = (name) => cols.indexOf(name);
  const iType = at('Product Type Identifier');
  const iUnits = at('Units');
  const iId = at('Apple Identifier');
  const iTitle = at('Title');
  if (iType < 0 || iUnits < 0 || iId < 0) return {};

  const out = {};
  for (const line of lines.slice(1)) {
    const f = line.split('\t');
    const type = (f[iType] || '').trim();
    if (!FIRST_DOWNLOAD.has(type)) continue;
    const id = (f[iId] || '').trim();
    const units = Number(f[iUnits]) || 0;
    if (!id) continue;
    const row = (out[id] = out[id] || { title: (f[iTitle] || '').trim(), units: 0 });
    row.units += units;
  }
  return out;
}

/**
 * レポートを1つ取る。
 * 返り値: { state: 'ok'|'none'|'pending', apps }
 *   none    … その日（月）は1件も無かった（Apple は 404 で返す）
 *   pending … まだ作られていない（日次は1日ほど、月次は翌月の上旬まで遅れる）
 */
async function fetchReport(frequency, date, ctx) {
  const ck = `${ctx.env.ASC_VENDOR_NUMBER}|${frequency}|${date}`;
  if (cache.has(ck)) return cache.get(ck);

  const url = new URL(BASE);
  url.searchParams.set('filter[frequency]', frequency);
  url.searchParams.set('filter[reportDate]', date);
  url.searchParams.set('filter[reportSubType]', 'SUMMARY');
  url.searchParams.set('filter[reportType]', 'SALES');
  url.searchParams.set('filter[vendorNumber]', String(ctx.env.ASC_VENDOR_NUMBER).trim());
  url.searchParams.set('filter[version]', '1_0');

  const res = await ctx.fetch(url.toString(), {
    headers: { Authorization: `Bearer ${ctx.jwt}`, Accept: 'application/a-gzip' },
  });

  if (res.status === 404) {
    const text = await res.text().catch(() => '');
    const pending = /not available yet|not yet available/i.test(text);
    const result = { state: pending ? 'pending' : 'none', apps: {} };
    if (!pending) cache.set(ck, result);
    return result;
  }
  if (res.status === 401) {
    throw userError('Apple に断られました（401：鍵が違います）。',
      'ASC_KEY_ID・ASC_ISSUER_ID・ASC_PRIVATE_KEY が同じキーのものか確かめてください。');
  }
  if (res.status === 403) {
    throw userError('Apple に断られました（403：このキーでは売上レポートを見られません）。',
      'App Store Connect でキーの役割を「Sales」（または「Finance」「Admin」）にして作り直してください。');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const e = new Error(`Apple が ${res.status} を返しました: ${text.slice(0, 200)}`);
    if (res.status === 400 && /vendor/i.test(text)) {
      e.hint = 'ASC_VENDOR_NUMBER（ベンダー番号）を確かめてください。「支払いと財務レポート」の左上にある数字です。';
      e.userError = true;
    }
    throw e;
  }

  let buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  const result = { state: 'ok', apps: parseReport(buf.toString('utf8')) };
  cache.set(ck, result);
  return result;
}

// ---------------------------------------------------------------- 日付

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const ym = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;

/** 日本時間の今日（YYYY-MM-DD）を UTC 0時の Date で持つ。 */
function jstTodayDate(now) {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now));
  return new Date(s + 'T00:00:00Z');
}

function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function monthStart(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); }
function addMonths(d, n) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)); }

/** 指定した月の、from〜to（含む）の日付。 */
function daysOf(month, from, to) {
  const out = [];
  for (let d = new Date(month); d.getUTCMonth() === month.getUTCMonth(); d = addDays(d, 1)) {
    if (d >= from && d <= to) out.push(ymd(d));
  }
  return out;
}

async function inBatches(items, fn) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += PARALLEL) {
    const part = await Promise.all(items.slice(i, i + PARALLEL).map(fn));
    part.forEach((v, j) => { out[i + j] = v; });
  }
  return out;
}

// ---------------------------------------------------------------- 本体

/**
 * アプリごとのダウンロード数。
 * opts.env / opts.fetch / opts.now は試験で差し替える。
 */
async function downloads(opts = {}) {
  const env = opts.env || process.env;
  const missing = missingEnv(env);
  if (missing.length) return { configured: false, missing };

  const now = opts.now || Date.now();
  const ctx = { env, fetch: opts.fetch || fetch, jwt: token(env, now) };

  const today = jstTodayDate(now);
  const lastDay = addDays(today, -1);              // 今日のぶんはまだ無い
  const thisMonth = monthStart(today);
  const firstMonth = addMonths(thisMonth, -MONTHS_BACK);

  // 済んだ月は月次で。出ていなければ、その月は日次で取り直す。
  const months = [];
  for (let m = firstMonth; m < thisMonth; m = addMonths(m, 1)) months.push(m);
  const monthly = await inBatches(months, (m) => fetchReport('MONTHLY', ym(m), ctx));

  // 日次で取る日：今月＋月次がまだの月。さらに直近7日は月をまたいでも日ごとに要る。
  const dailyDays = new Set(daysOf(thisMonth, thisMonth, lastDay));
  months.forEach((m, i) => {
    if (monthly[i].state === 'pending') daysOf(m, m, lastDay).forEach((d) => dailyDays.add(d));
  });
  const week = [];
  for (let i = 6; i >= 0; i--) week.push(ymd(addDays(lastDay, -i)));
  week.forEach((d) => dailyDays.add(d));
  const dayList = [...dailyDays].sort();
  const daily = await inBatches(dayList, (d) => fetchReport('DAILY', d, ctx));
  const byDay = new Map(dayList.map((d, i) => [d, daily[i]]));

  const apps = {};
  const touch = (id, title) => {
    const a = (apps[id] = apps[id] || { appleId: id, title: '', total: 0, latest: 0, last7: 0 });
    if (title && !a.title) a.title = title;
    return a;
  };

  // 累計：月次（出ている月）＋ 日次（今月と、月次がまだの月）
  const thisYm = ym(thisMonth);
  months.forEach((m, i) => {
    if (monthly[i].state !== 'ok') return;
    for (const [id, r] of Object.entries(monthly[i].apps)) touch(id, r.title).total += r.units;
  });
  const monthlyDone = new Set(months.filter((_, i) => monthly[i].state !== 'pending').map(ym));
  for (const [d, r] of byDay) {
    if (r.state !== 'ok') continue;
    const inTotal = d.slice(0, 7) === thisYm || !monthlyDone.has(d.slice(0, 7));
    for (const [id, a] of Object.entries(r.apps)) {
      const app = touch(id, a.title);
      if (inTotal) app.total += a.units;
      if (week.includes(d)) app.last7 += a.units;
    }
  }

  // いちばん新しい「出ている日」。前の日のレポートは1日ほど遅れて出る。
  const ready = dayList.filter((d) => byDay.get(d).state !== 'pending');
  const latestDate = ready.length ? ready[ready.length - 1] : null;
  if (latestDate && byDay.get(latestDate).state === 'ok') {
    for (const [id, a] of Object.entries(byDay.get(latestDate).apps)) touch(id, a.title).latest += a.units;
  }

  return {
    configured: true,
    since: ymd(firstMonth),
    latestDate,
    pending: dayList.filter((d) => byDay.get(d).state === 'pending'),
    apps: Object.values(apps).sort((a, b) => b.total - a.total || a.title.localeCompare(b.title)),
  };
}

module.exports = { downloads, parseReport, token, toPem, missingEnv, FIRST_DOWNLOAD, _cache: cache };
