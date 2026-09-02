'use strict';
/**
 * 運用アカウント（運用ライン）の追加・変更・削除。
 *
 *   GET    /api/groups           … 一覧（点検の型の選択肢も一緒に返す）
 *   POST   /api/groups           … 追加
 *   PATCH  /api/groups?id=…      … 名前・点検の型を変える
 *   DELETE /api/groups?id=…      … 消す（ぶら下がりがあれば断る）
 *
 * 中身は lib/groups.js。ここは入り口の作法だけ。
 */

const auth = require('../lib/auth');
const groups = require('../lib/groups');

module.exports = async function handler(req, res) {
  if (!auth.guard(req, res)) return;

  const id = (req.query && req.query.id) || null;
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

  try {
    if (req.method === 'GET') {
      return res.status(200).json({
        groups: await groups.list(),
        profiles: groups.profileChoices(),
      });
    }
    if (req.method === 'POST')   return res.status(200).json(await groups.create(body));
    if (req.method === 'PATCH')  return res.status(200).json(await groups.update(id, body));
    if (req.method === 'DELETE') return res.status(200).json(await groups.remove(id));
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    const status = err.userError ? 400 : 500;
    return res.status(status).json({ error: err.message, hint: err.hint });
  }
};
