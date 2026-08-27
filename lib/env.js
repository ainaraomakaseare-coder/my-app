'use strict';
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

/**
 * .env を読んで process.env に流し込む。
 * 既に環境変数がある場合はそちらを優先する（本番で上書きされないように）。
 */
function load() {
  if (!fs.existsSync(ENV_PATH)) return;
  const text = fs.readFileSync(ENV_PATH, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

/**
 * .env の1項目を書き換える（他の行とコメントは保つ）。
 * トークンを長期トークンに差し替えるときに使う。
 */
function set(updates) {
  let lines = fs.existsSync(ENV_PATH)
    ? fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)
    : [];
  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = String(value);
    const line = `${key}=${value}`;
    const at = lines.findIndex((l) => l.startsWith(key + '='));
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  }
  fs.writeFileSync(ENV_PATH, lines.join('\n').replace(/\n+$/, '') + '\n', { mode: 0o600 });
  try { fs.chmodSync(ENV_PATH, 0o600); } catch (_) {}
}

/** 画面やログに出すときの伏せ字。先頭6文字だけ見せる。 */
function mask(secret) {
  if (!secret) return null;
  return secret.slice(0, 6) + '…' + `(${secret.length}文字)`;
}

module.exports = { load, set, mask, ENV_PATH };
