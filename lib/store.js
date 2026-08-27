'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// テストから別の置き場所を指せるようにしておく
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const POSTS_FILE = path.join(DATA_DIR, 'posts.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const NETWORKS = ['instagram', 'x', 'tiktok', 'youtube'];
const STATUSES = ['draft', 'scheduled', 'posted', 'failed'];

function ensure() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  if (!fs.existsSync(POSTS_FILE)) writeJson(POSTS_FILE, []);
  if (!fs.existsSync(SETTINGS_FILE)) writeJson(SETTINGS_FILE, { publicBaseUrl: '' });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

/** 書きかけのファイルを残さないよう、一時ファイルに書いてから差し替える。 */
function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const listPosts = () => readJson(POSTS_FILE, []);
const savePosts = (posts) => writeJson(POSTS_FILE, posts);
const getSettings = () => readJson(SETTINGS_FILE, { publicBaseUrl: '' });
const saveSettings = (s) => writeJson(SETTINGS_FILE, s);

const newId = () => crypto.randomBytes(8).toString('hex');
const getPost = (id) => listPosts().find((p) => p.id === id) || null;

/** 受け取った値を検証し、保存してよい形に整える。画面からの入力を素通しにしない。 */
function normalize(input, existing) {
  const base = existing || {
    id: newId(),
    createdAt: new Date().toISOString(),
    history: [],
    results: {},
  };
  const body = typeof input.body === 'string' ? input.body : base.body || '';
  const targets = Array.isArray(input.targets)
    ? input.targets.filter((t) => NETWORKS.includes(t))
    : base.targets || [];

  let scheduledAt = null;
  if (input.scheduledAt) {
    const d = new Date(input.scheduledAt);
    if (isNaN(d.getTime())) throw new ValidationError('予定日時の形式が読み取れませんでした。');
    scheduledAt = d.toISOString();
  }

  let status = STATUSES.includes(input.status) ? input.status : base.status || 'draft';
  if (status === 'scheduled' && !scheduledAt) {
    throw new ValidationError('「投稿予定」にするには予定日時が必要です。');
  }

  return {
    ...base,
    body,
    targets,
    scheduledAt,
    status,
    autoPost: input.autoPost === true,
    media: input.media === null ? null : input.media || base.media || null,
    updatedAt: new Date().toISOString(),
  };
}

function upsert(post) {
  const posts = listPosts();
  const at = posts.findIndex((p) => p.id === post.id);
  if (at >= 0) posts[at] = post;
  else posts.unshift(post);
  savePosts(posts);
  return post;
}

function remove(id) {
  const posts = listPosts();
  const at = posts.findIndex((p) => p.id === id);
  if (at < 0) return false;
  const [gone] = posts.splice(at, 1);
  savePosts(posts);
  if (gone.media && gone.media.file) {
    const file = path.join(MEDIA_DIR, path.basename(gone.media.file));
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  return true;
}

/** 何が起きたかを投稿ごとに追記する。投稿履歴の画面はこれを読む。 */
function log(id, event, detail) {
  const posts = listPosts();
  const post = posts.find((p) => p.id === id);
  if (!post) return;
  post.history = post.history || [];
  post.history.push({ at: new Date().toISOString(), event, detail: detail || '' });
  if (post.history.length > 50) post.history = post.history.slice(-50);
  savePosts(posts);
}

class ValidationError extends Error {}

module.exports = {
  ensure, listPosts, savePosts, getPost, normalize, upsert, remove, log,
  getSettings, saveSettings, newId,
  DATA_DIR, MEDIA_DIR, NETWORKS, STATUSES, ValidationError,
};
