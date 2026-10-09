#!/usr/bin/env node
'use strict';
/**
 * 投稿の予約を、1コマンドでやる。
 *
 * ★ いままでは、ブラウザのページの中で JS を走らせて予約していた。
 *   ページが描き直されると投稿先のチェックが外れるなど、壊れやすかった。
 *   このコマンドは同じことを API だけで行う。使う鍵は POST_CLI_TOKEN の合鍵で、
 *   通るのは「画像を置く・一覧を見る・予約を作る」だけ（api/posts.js を参照）。
 *
 * Node の標準機能だけで書いている（npm パッケージなし）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { xLength } = require('../public/split-drafts.js');

const DEFAULT_GROUP = '6765a825-5031-46f4-9384-13c842750428';
const DEFAULT_URL = 'https://my-app-rouge-one-46.vercel.app';
const NETWORKS = ['instagram', 'x', 'threads', 'tiktok', 'youtube'];
const NET_NAME = { instagram: 'Instagram', x: 'X', threads: 'Threads', tiktok: 'TikTok', youtube: 'YouTube' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime',
};
const WHEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const HOUR = 60 * 60 * 1000;

const USAGE = [
  '使い方:',
  '  node scripts/schedule-post.js --to x [--to threads ...] --text-file <本文.txt> [--image <画像/動画>] (--at 2026-10-09T17:30 | --now) [--title <管理用タイトル>] [--group <運用アカウントのid か 名前の一部>] [--yes] [--force]',
  '',
  '  --to          投稿先（instagram | x | threads | tiktok | youtube）。複数指定できます',
  '  --text-file   本文のファイル（UTF-8）。全SNSに同じ本文を使います',
  '  --image       画像（png/jpg）か動画（mp4/mov）',
  '  --at          予約日時（日本時間）。2026-10-09T17:30 の形',
  '  --now         2分以上先の、次のちょうど分に予約します',
  '  --title       管理用タイトル（YouTube では動画タイトルにもなります）',
  '  --group       運用アカウント。id か名前の一部（省略すると既定の運用アカウント）',
  '  --yes         確認の質問を飛ばします',
  '  --force       24時間以内に同じ本文の投稿があっても予約します',
  '',
  '合鍵: 環境変数 TOUKOUTAKU_TOKEN か、ファイル %USERPROFILE%\\.toukoutaku\\token に置きます。',
  '送り先: 環境変数 TOUKOUTAKU_URL（省略すると ' + DEFAULT_URL + '）。',
].join('\n');

class CliError extends Error {
  constructor(message, code) { super(message); this.exitCode = code || 1; }
}

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { to: [], yes: false, force: false, now: false, help: false };
  const need = (i, name) => {
    if (i + 1 >= argv.length || String(argv[i + 1]).startsWith('--')) {
      throw new CliError(`${name} の値がありません。`);
    }
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--to': o.to.push(need(i++, a).toLowerCase()); break;
      case '--text-file': o.textFile = need(i++, a); break;
      case '--image': o.image = need(i++, a); break;
      case '--at': o.at = need(i++, a); break;
      case '--title': o.title = need(i++, a); break;
      case '--group': o.group = need(i++, a); break;
      case '--now': o.now = true; break;
      case '--yes': o.yes = true; break;
      case '--force': o.force = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new CliError(`知らない指定です: ${a}（--help で使い方を見られます）`);
    }
  }
  if (o.help) return o;
  if (!o.to.length) throw new CliError('--to で投稿先を1つ以上指定してください。');
  for (const n of o.to) {
    if (!NETWORKS.includes(n)) throw new CliError(`--to に使えるのは ${NETWORKS.join(' / ')} です（${n}）。`);
  }
  o.to = [...new Set(o.to)];
  if (!o.textFile) throw new CliError('--text-file で本文のファイルを指定してください。');
  if (!o.at && !o.now) throw new CliError('--at か --now のどちらかが必要です。');
  if (o.at && o.now) throw new CliError('--at と --now は同時に使えません。');
  if (o.to.includes('youtube') && !o.title) throw new CliError('YouTube に出すときは --title が必要です。');
  return o;
}

// ---------------------------------------------------------------------------
// 時刻（日本時間は +9時間で求める。PCの地域設定に頼らない）
// ---------------------------------------------------------------------------

/** epoch ミリ秒 → 日本時間の 'YYYY-MM-DDTHH:MM' */
function formatJst(ms) {
  return new Date(ms + 9 * HOUR).toISOString().slice(0, 16);
}

/** 'YYYY-MM-DDTHH:MM'（日本時間）→ epoch ミリ秒。読めなければ NaN */
function jstToMs(s) {
  if (!WHEN.test(String(s))) return NaN;
  return Date.parse(`${s}:00+09:00`);
}

/** --now: 2分以上先になる、次のちょうど分。 */
function nextMinute(nowMs) {
  const t = nowMs + 2 * 60 * 1000;
  return formatJst(Math.ceil(t / 60000) * 60000);
}

/** --at の点検。形が違う／過去ならエラー。 */
function validateAt(at, nowMs) {
  if (!WHEN.test(String(at))) throw new CliError('--at は 2026-10-09T17:30 の形（日本時間）で指定してください。');
  const ms = jstToMs(at);
  if (isNaN(ms) || formatJst(ms) !== at) throw new CliError(`--at の日時が正しくありません（${at}）。`);
  if (ms <= nowMs) throw new CliError(`--at が過去です（${at}）。いまは日本時間 ${formatJst(nowMs)} です。`);
  return at;
}

// ---------------------------------------------------------------------------
// 本文・宛先・重複
// ---------------------------------------------------------------------------

function cleanText(raw) {
  return String(raw).replace(/^﻿/, '').replace(/\s+$/, '');
}

/** 長さの点検。問題があれば日本語の文を返す。 */
function lengthProblems(text, networks) {
  const out = [];
  if (!text) out.push('本文が空です。');
  if (networks.includes('x')) {
    const n = xLength(text);
    if (n > 280) out.push(`X の本文が長すぎます（X の数え方で ${n}／280。日本語は1文字＝2）。`);
  }
  if (networks.includes('threads') && text.length > 500) {
    out.push(`Threads の本文が長すぎます（${text.length}／500文字）。`);
  }
  return out;
}

/** --group を id にする。UUID ならそのまま、そうでなければ名前の一部で探す。 */
function resolveGroup(spec, groups) {
  const key = spec || DEFAULT_GROUP;
  if (UUID.test(key)) return key;
  const hit = (groups || []).filter((g) =>
    [g.label, g.name].some((v) => v && String(v).includes(key)));
  if (hit.length !== 1) {
    throw new CliError(hit.length
      ? `--group「${key}」に合う運用アカウントが複数あります: ${hit.map((g) => g.label || g.name).join(' / ')}`
      : `--group「${key}」に合う運用アカウントがありません。`);
  }
  return hit[0].id;
}

/** 各 --to に、その運用アカウントのアカウントを1つ当てる。 */
function pickAccounts(networks, accounts, groupId) {
  return networks.map((n) => {
    const hit = (accounts || []).filter((a) => a.network === n && a.group_id === groupId);
    if (hit.length !== 1) {
      throw new CliError(hit.length
        ? `${NET_NAME[n]} のアカウントがこの運用アカウントに複数あります。1つだけにしてください。`
        : `${NET_NAME[n]} のアカウントがこの運用アカウントにつながっていません。`);
    }
    return hit[0];
  });
}

/** 24時間以内に、同じ本文の予約・投稿があるか。 */
function findDuplicates(posts, { text, networks, scheduledMs }) {
  const fields = [];
  if (networks.includes('x')) fields.push('x_text');
  if (networks.includes('threads')) fields.push('th_text');
  if (networks.includes('instagram')) fields.push('ig_caption');
  return (posts || []).filter((p) => {
    if (!['scheduled', 'running', 'done'].includes(p.status)) return false;
    if (!p.scheduled_at) return false;
    if (Math.abs(Date.parse(p.scheduled_at) - scheduledMs) > 24 * HOUR) return false;
    return fields.some((f) => p[f] && cleanText(p[f]) === text);
  });
}

function buildBody({ text, networks, title, whenJst, groupId, accountIds, media }) {
  const yt = networks.includes('youtube');
  return {
    status: 'scheduled',
    title,
    body_common: text,
    ig_caption: text,
    yt_title: yt ? title : '',
    yt_description: yt ? text : '',
    x_text: networks.includes('x') ? text : '',
    tt_caption: text,
    th_text: networks.includes('threads') ? text : '',
    reply_text: '',
    scheduled_at_jst: whenJst,
    group_id: groupId,
    has_affiliate_link: false,
    draft: null,
    media_path: media ? media.path : null,
    media_kind: media ? media.kind : null,
    media_bytes: media ? media.bytes : null,
    targets: accountIds,
    tt_settings: null,
  };
}

// ---------------------------------------------------------------------------
// 通信
// ---------------------------------------------------------------------------

function loadToken() {
  let t = (process.env.TOUKOUTAKU_TOKEN || '').trim();
  if (!t) {
    try { t = fs.readFileSync(path.join(os.homedir(), '.toukoutaku', 'token'), 'utf8').trim(); } catch (_) { /* 無い */ }
  }
  if (!t) {
    throw new CliError([
      '合鍵が見つかりません。次のどちらかで設定してください。',
      '  ・環境変数 TOUKOUTAKU_TOKEN に入れる',
      '  ・ファイル %USERPROFILE%\\.toukoutaku\\token に1行で保存する',
      '（合鍵は Vercel の環境変数 POST_CLI_TOKEN と同じ値です）',
    ].join('\n'));
  }
  return t;
}

function makeApi(base, token) {
  return async function api(pathname, options) {
    const opts = options || {};
    const res = await fetch(base + pathname, {
      method: opts.method || 'GET',
      headers: Object.assign({ Authorization: `Bearer ${token}` },
        opts.body ? { 'Content-Type': 'application/json' } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* JSON でない */ }
    if (!res.ok) {
      const hint = res.status === 401
        ? '合鍵が違うか、Vercel に POST_CLI_TOKEN が入っていません（32文字以上、設定後に再デプロイが必要）。'
        : (data && data.hint) || '';
      throw new CliError(`${(data && data.error) || `通信に失敗しました（${res.status}）`}${hint ? `\n  → ${hint}` : ''}`);
    }
    return data;
  };
}

async function upload(api, file) {
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type) throw new CliError('画像は png/jpg、動画は mp4/mov にしてください。');
  const bytes = fs.readFileSync(file);
  const issued = await api('/api/upload-url', { method: 'POST', body: { contentType: type, size: bytes.length } });
  const put = await fetch(issued.uploadUrl, {
    method: 'PUT', headers: { 'Content-Type': type, 'x-upsert': 'true' }, body: bytes,
  });
  if (!put.ok) throw new CliError(`ファイルのアップロードに失敗しました（${put.status}）。`);
  return { path: issued.path, kind: issued.kind, bytes: bytes.length };
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(USAGE); return 0; }

  // 通信の前に、手元で分かる間違いを全部止める
  let text;
  try { text = cleanText(fs.readFileSync(o.textFile, 'utf8')); }
  catch (e) { throw new CliError(`本文のファイルを読めません: ${o.textFile}`); }
  const problems = lengthProblems(text, o.to);
  if (problems.length) throw new CliError(problems.join('\n'));

  let imageInfo = null;
  if (o.image) {
    let st;
    try { st = fs.statSync(o.image); } catch (_) { throw new CliError(`画像・動画が見つかりません: ${o.image}`); }
    if (!TYPES[path.extname(o.image).toLowerCase()]) throw new CliError('画像は png/jpg、動画は mp4/mov にしてください。');
    imageInfo = { name: path.basename(o.image), size: st.size };
    if (path.extname(o.image).toLowerCase() === '.png' && o.to.includes('instagram')) {
      console.log('注意: Instagram は PNG を受け付けません。JPEG にしてください。');
    }
  }

  const nowMs = Date.now();
  const whenJst = o.now ? nextMinute(nowMs) : validateAt(o.at, nowMs);
  const base = (process.env.TOUKOUTAKU_URL || DEFAULT_URL).replace(/\/+$/, '');
  const api = makeApi(base, loadToken());

  const list = await api('/api/posts');
  const groupId = resolveGroup(o.group, list.groups);
  const accounts = pickAccounts(o.to, list.accounts, groupId);

  const dups = findDuplicates(list.posts, { text, networks: o.to, scheduledMs: jstToMs(whenJst) });
  if (dups.length && !o.force) {
    console.log('同じ本文の投稿が、24時間以内にすでにあります。');
    for (const p of dups) {
      console.log(`  ${p.id}  ${p.title || '(無題)'}  [${p.status}]  ${formatJst(Date.parse(p.scheduled_at))} JST`);
    }
    console.log('それでも予約するなら --force を付けてください。');
    return 2;
  }

  const title = o.title || `CLI予約 ${whenJst}`;
  console.log('--- 予約の内容 ---');
  console.log('投稿先: ' + accounts.map((a) =>
    `${NET_NAME[a.network]}（${a.label || a.account_name || a.id}）`).join(' / '));
  console.log(`日時: ${whenJst}（日本時間）`);
  console.log('画像: ' + (imageInfo ? `${imageInfo.name}（${(imageInfo.size / 1024 / 1024).toFixed(2)}MB）` : 'なし'));
  console.log('本文:\n' + text);
  console.log(`X の長さ: ${xLength(text)}／280`);
  console.log('------------------');

  if (!o.yes) {
    const ans = await ask('この内容で予約しますか？ (y/N) ');
    if (!/^[yY]$/.test(ans.trim())) { console.log('やめました。'); return 1; }
  }

  const media = o.image ? await upload(api, o.image) : null;
  const body = buildBody({
    text, networks: o.to, title, whenJst, groupId, accountIds: accounts.map((a) => a.id), media,
  });
  const created = await api('/api/posts', { method: 'POST', body });
  const newId = created && created.post && created.post.id;

  // 作れたことを、一覧から読み直して確かめる
  const after = await api('/api/posts');
  const post = (after.posts || []).find((p) => (newId ? p.id === newId : p.title === title));
  if (!post) { console.log('予約は送れましたが、一覧で見つけられませんでした。画面で確かめてください。'); return 1; }
  const targets = post.post_targets || [];
  console.log(`投稿 ${post.id}: ${post.status}`);
  for (const t of targets) console.log(`  ${t.network}: ${t.status}`);
  const ok = post.status === 'scheduled' && targets.length === accounts.length &&
    targets.every((t) => t.status === 'queued' || t.status === 'manual');
  if (targets.some((t) => t.status === 'manual')) {
    console.log('※ manual の投稿先は自動では出ません。受け渡し（画面）から進めます。');
  }
  console.log(ok ? '予約できました。' : '予約の状態がおかしいです。画面で確かめてください。');
  return ok ? 0 : 1;
}

module.exports = {
  parseArgs, formatJst, jstToMs, nextMinute, validateAt, cleanText, lengthProblems,
  resolveGroup, pickAccounts, findDuplicates, buildBody, CliError, DEFAULT_GROUP,
};

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(e instanceof CliError ? e.message : `想定外のエラー: ${e.message}`);
    process.exitCode = e.exitCode || 1;
  });
}
