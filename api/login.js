'use strict';
const auth = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ loggedIn: auth.isLoggedIn(req) });
  }
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', auth.clearHeader());
    return res.status(200).json({ loggedIn: false });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  if (!process.env.APP_PASSWORD) {
    return res.status(500).json({
      error: 'サーバーに合言葉が設定されていません。',
      hint: 'Vercel の Settings → Environment Variables に APP_PASSWORD を追加してください。',
    });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  if (!auth.checkPassword(body.password)) {
    // わざと少し待つ。総当たりの速度を落とすため。
    await new Promise((r) => setTimeout(r, 700));
    return res.status(401).json({ error: '合言葉が違います。' });
  }

  res.setHeader('Set-Cookie', auth.cookieHeader(auth.issue()));
  return res.status(200).json({ loggedIn: true });
};
