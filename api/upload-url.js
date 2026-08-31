'use strict';
/**
 * 「動画をここに置いていい」という期限つきの許可証を出す。
 * 動画そのものはこのサーバーを通らない（Vercel は 4.5MB までしか受け取れないため）。
 */
const auth = require('../lib/auth');
const db = require('../lib/db');
const crypto = require('crypto');

// Supabase 無料プランの1ファイル上限
const MAX_BYTES = 50 * 1024 * 1024;

const EXT = {
  'video/mp4': 'mp4', 'video/quicktime': 'mov',
  'image/jpeg': 'jpg', 'image/png': 'png',
};

module.exports = async function handler(req, res) {
  if (!auth.guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const { contentType, size } = body;

  if (!EXT[contentType]) {
    return res.status(400).json({
      error: '対応していないファイル形式です。',
      hint: '動画は MP4（推奨）か MOV、画像は JPEG か PNG にしてください。',
    });
  }
  if (!size || size > MAX_BYTES) {
    return res.status(400).json({
      error: `ファイルが大きすぎます（${(size / 1024 / 1024).toFixed(1)}MB）。`,
      hint: 'Supabase の無料プランは1ファイル50MBまでです。動画を短くするか、書き出し設定を下げてください。',
    });
  }

  const now = new Date();
  const path =
    `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/` +
    `${crypto.randomBytes(8).toString('hex')}.${EXT[contentType]}`;

  const out = await db.signedUploadUrl(path);
  return res.status(200).json({
    ...out,
    kind: contentType.startsWith('video/') ? 'video' : 'image',
  });
};
