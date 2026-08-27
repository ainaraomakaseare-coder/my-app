'use strict';
/**
 * SNS投稿管理アプリ — ローカル専用サーバー
 *
 * サーバーを2つ立てる。
 *   本体（PORT）        : 画面と操作。127.0.0.1 のみ。トークンはここにしか無い。
 *   メディア（MEDIA_PORT）: data/media/ を読み取り専用で配るだけ。
 *
 * Instagram はメディアを「公開URL」から取りに来る仕様なので、トンネルは
 * メディア側にだけ繋ぐ。本体をトンネルに晒すと、URLを知った人が誰でも
 * あなたの投稿を操作できてしまう。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

require('./lib/env').load();
const env = require('./lib/env');
const store = require('./lib/store');
const ig = require('./lib/instagram');

const PORT = Number(process.env.PORT || 3000);
const MEDIA_PORT = Number(process.env.MEDIA_PORT || 3001);
const MAX_UPLOAD = 300 * 1024 * 1024; // 300MB

store.ensure();

const TEXT = { 'Content-Type': 'text/plain; charset=utf-8' };  // 日本語が化けないように

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webp': 'image/webp',
};

/* ---------------- 進捗（投稿中の様子を画面に見せるため） ---------------- */
const progress = new Map();
const setProgress = (id, state, message) => progress.set(id, { state, message, at: Date.now() });

/* ---------------- 小道具 ---------------- */
function send(res, code, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(payload);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error('データが大きすぎます。')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const readJsonBody = async (req) => {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch (_) { throw new store.ValidationError('送られてきたデータを読み取れませんでした。'); }
};

/** data/media/ の外を読ませない。".." を含むパスは弾く。 */
function safeMediaPath(name) {
  const base = path.basename(decodeURIComponent(name));
  const full = path.join(store.MEDIA_DIR, base);
  if (!full.startsWith(store.MEDIA_DIR + path.sep)) return null;
  return full;
}

function serveMedia(req, res, name) {
  const full = safeMediaPath(name);
  if (!full || !fs.existsSync(full)) {
    res.writeHead(404, TEXT);
    res.end('そのファイルはありません。');
    return;
  }

  const stat = fs.statSync(full);
  const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;

  // Instagram も動画プレビューも部分取得を使うので Range に答える
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : stat.size - 1;
    if (start >= stat.size) { res.writeHead(416); res.end(); return; }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(full, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(full).pipe(res);
}

/* ---------------- 公開URL ---------------- */
function publicBaseUrl() {
  const fromEnv = (process.env.PUBLIC_BASE_URL || '').trim();
  const fromSettings = (store.getSettings().publicBaseUrl || '').trim();
  return (fromSettings || fromEnv).replace(/\/+$/, '');
}

const mediaUrlFor = (post) => {
  const base = publicBaseUrl();
  if (!base || !post.media) return null;
  return `${base}/media/${encodeURIComponent(post.media.file)}`;
};

/* ---------------- Instagram へ投稿する ---------------- */
async function publishPost(id) {
  const post = store.getPost(id);
  if (!post) throw new store.ValidationError('その投稿は見つかりませんでした。');
  if (!post.targets.includes('instagram')) {
    throw new store.ValidationError('この投稿の投稿先に Instagram が入っていません。');
  }
  if (!post.media) {
    throw new store.ValidationError('Instagram はテキストだけの投稿ができません。画像か動画を添付してください。');
  }
  const url = mediaUrlFor(post);
  if (!url) {
    throw new store.ValidationError(
      '公開URLが未設定です。cloudflared でトンネルを開き、そのURLを「Instagram 連携」の画面に登録してください。'
    );
  }

  setProgress(id, 'running', '準備中…');
  store.log(id, 'publish:start', 'Instagram への投稿を開始');

  try {
    const result = await ig.publish({
      mediaUrl: url,
      caption: post.body,
      kind: post.media.kind,
      onProgress: (m) => setProgress(id, 'running', m),
    });

    const fresh = store.getPost(id);
    fresh.status = 'posted';
    fresh.postedAt = new Date().toISOString();
    fresh.results = { ...(fresh.results || {}), instagram: { ...result, at: fresh.postedAt } };
    store.upsert(fresh);
    store.log(id, 'publish:done', result.permalink || result.mediaId);
    setProgress(id, 'done', '投稿しました');
    return result;
  } catch (err) {
    const fresh = store.getPost(id);
    if (fresh) {
      fresh.status = 'failed';
      store.upsert(fresh);
      store.log(id, 'publish:error', [err.message, err.hint].filter(Boolean).join(' / '));
    }
    setProgress(id, 'error', err.message);
    throw err;
  }
}

/* ---------------- 予約投稿 ---------------- */
const scheduler = { lastRun: null, enabled: true };

async function runScheduler() {
  scheduler.lastRun = new Date().toISOString();
  const now = Date.now();
  for (const post of store.listPosts()) {
    if (post.status !== 'scheduled' || !post.autoPost) continue;
    if (!post.targets.includes('instagram')) continue;
    if (!post.scheduledAt || new Date(post.scheduledAt).getTime() > now) continue;
    const running = progress.get(post.id);
    if (running && running.state === 'running') continue;

    console.log(`[予約投稿] ${post.id} の時刻になりました。送信します。`);
    try { await publishPost(post.id); }
    catch (err) { console.error(`[予約投稿] 失敗: ${err.message}${err.hint ? ' / ' + err.hint : ''}`); }
  }
}

setInterval(() => { if (scheduler.enabled) runScheduler().catch(() => {}); }, 30_000);

/* ---------------- 本体サーバー ---------------- */
const routes = {
  'GET /api/state': async () => ({
    posts: store.listPosts(),
    settings: {
      publicBaseUrl: publicBaseUrl(),
      mediaPort: MEDIA_PORT,
      hasToken: Boolean(process.env.IG_ACCESS_TOKEN),
      hasSecret: Boolean(process.env.IG_APP_SECRET),
      tokenPreview: env.mask(process.env.IG_ACCESS_TOKEN),
      tokenExpiresAt: process.env.IG_TOKEN_EXPIRES_AT || null,
      apiVersion: ig.VERSION,
    },
    scheduler: { lastRun: scheduler.lastRun, enabled: scheduler.enabled },
    now: new Date().toISOString(),
  }),

  'POST /api/posts': async (req) => {
    const input = await readJsonBody(req);
    const existing = input.id ? store.getPost(input.id) : null;
    const post = store.normalize(input, existing);
    store.upsert(post);
    store.log(post.id, existing ? 'update' : 'create', '');
    return { post: store.getPost(post.id) };
  },

  'POST /api/settings': async (req) => {
    const input = await readJsonBody(req);
    const settings = store.getSettings();
    if (typeof input.publicBaseUrl === 'string') {
      const url = input.publicBaseUrl.trim().replace(/\/+$/, '');
      if (url && !/^https:\/\//.test(url)) {
        throw new store.ValidationError('公開URLは https:// で始まる必要があります（Instagram は https しか受け付けません）。');
      }
      settings.publicBaseUrl = url;
    }
    store.saveSettings(settings);
    return { settings: { publicBaseUrl: publicBaseUrl() } };
  },

  'GET /api/ig/status': async () => {
    const account = await ig.me();
    return { account };
  },

  'POST /api/ig/token': async (req) => {
    const { token } = await readJsonBody(req);
    if (!token || typeof token !== 'string' || token.length < 20) {
      throw new store.ValidationError('トークンが短すぎます。貼り付け漏れがないか確認してください。');
    }
    // 短期トークンなら長期に交換する。既に長期ならそのまま通る。
    let stored = token.trim();
    let expiresAt = null;
    try {
      const long = await ig.exchangeForLongLived(stored);
      if (long.access_token) {
        stored = long.access_token;
        expiresAt = new Date(Date.now() + (long.expires_in || 0) * 1000).toISOString();
      }
    } catch (err) {
      // 交換できなくても、そのトークンで通信できるなら使える
      console.warn('[トークン] 長期交換に失敗:', err.message);
    }
    env.set({ IG_ACCESS_TOKEN: stored, ...(expiresAt ? { IG_TOKEN_EXPIRES_AT: expiresAt } : {}) });
    const account = await ig.me();
    return { account, expiresAt, exchanged: Boolean(expiresAt) };
  },

  'POST /api/ig/refresh': async () => {
    const res = await ig.refreshLongLived();
    const expiresAt = new Date(Date.now() + (res.expires_in || 0) * 1000).toISOString();
    env.set({ IG_ACCESS_TOKEN: res.access_token, IG_TOKEN_EXPIRES_AT: expiresAt });
    return { expiresAt };
  },
};

async function handleApi(req, res, url) {
  const key = `${req.method} ${url.pathname}`;

  if (routes[key]) return send(res, 200, await routes[key](req));

  let m;
  if ((m = /^\/api\/posts\/([a-f0-9]+)$/.exec(url.pathname)) && req.method === 'DELETE') {
    return send(res, 200, { removed: store.remove(m[1]) });
  }
  if ((m = /^\/api\/publish\/([a-f0-9]+)$/.exec(url.pathname)) && req.method === 'POST') {
    const result = await publishPost(m[1]);
    return send(res, 200, { result, post: store.getPost(m[1]) });
  }
  if ((m = /^\/api\/progress\/([a-f0-9]+)$/.exec(url.pathname)) && req.method === 'GET') {
    return send(res, 200, { progress: progress.get(m[1]) || null, post: store.getPost(m[1]) });
  }
  if (url.pathname === '/api/media' && req.method === 'POST') {
    const name = url.searchParams.get('name') || 'upload';
    const buf = await readBody(req, MAX_UPLOAD);
    if (!buf.length) throw new store.ValidationError('ファイルが空でした。');

    const ext = (path.extname(name) || '').toLowerCase();
    const allowed = ['.jpg', '.jpeg', '.png', '.mp4', '.mov'];
    if (!allowed.includes(ext)) {
      throw new store.ValidationError(`この拡張子（${ext || 'なし'}）は扱えません。JPEG / PNG / MP4 / MOV を選んでください。`);
    }
    const file = `${store.newId()}${ext}`;
    fs.writeFileSync(path.join(store.MEDIA_DIR, file), buf);
    return send(res, 200, {
      media: {
        file,
        originalName: path.basename(name),
        kind: ['.mp4', '.mov'].includes(ext) ? 'video' : 'image',
        size: buf.length,
      },
    });
  }

  send(res, 404, { error: 'そのURLはありません。' });
}

const app = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/media/')) return serveMedia(req, res, url.pathname.slice('/media/'.length));

    const file = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
    const full = path.join(__dirname, 'public', file);
    if (!fs.existsSync(full)) { res.writeHead(404, TEXT); res.end('そのページはありません。'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'text/plain' });
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    const status = err instanceof store.ValidationError ? 400 : err instanceof ig.InstagramError ? 502 : 500;
    if (status === 500) console.error(err);
    send(res, status, { error: err.message, hint: err.hint || null });
  }
});

/* ---------------- メディア専用サーバー ---------------- */
const mediaServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${MEDIA_PORT}`);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, TEXT);
    res.end('このサーバーは読み取り専用です。');
    return;
  }
  if (!url.pathname.startsWith('/media/')) {
    res.writeHead(404, TEXT);
    res.end('このサーバーはメディアしか配りません。トンネルが繋がっている証拠なので、この表示で正常です。');
    return;
  }
  serveMedia(req, res, url.pathname.slice('/media/'.length));
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  SNS投稿管理アプリ`);
  console.log(`  画面        http://127.0.0.1:${PORT}`);
});
mediaServer.listen(MEDIA_PORT, '127.0.0.1', () => {
  console.log(`  メディア    http://127.0.0.1:${MEDIA_PORT}/media/  （ここだけトンネルに繋ぐ）`);
  console.log(`  トンネル    cloudflared tunnel --url http://localhost:${MEDIA_PORT}\n`);
});

module.exports = { app, mediaServer, publishPost, runScheduler };
