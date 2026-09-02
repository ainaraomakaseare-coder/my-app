'use strict';
/**
 * 保存した動画を、手元にダウンロードするための期限つきURLを出す。
 *
 * ★ なぜ必要か
 *   Instagram には下書きのAPIが無いので、動画は本人がアプリから投稿する。
 *   そのためには手元にファイルが要る。
 *   置き場（Storage のバケット）は非公開のままにしておきたいので、
 *   2時間だけ有効なURLをその都度作って渡す。投稿処理が Instagram へ
 *   渡すのと同じ仕組み（db.signedUrl）を、人に向けて使う。
 *
 *   GET /api/media-url?id=<投稿のid>
 */

const auth = require('../lib/auth');
const db = require('../lib/db');

module.exports = async function handler(req, res) {
  if (!auth.guard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const id = req.query && req.query.id;
  if (!id) return res.status(400).json({ error: '投稿が指定されていません。' });

  try {
    const rows = await db.rest('posts', {
      query: { select: 'title,media_path,media_kind', id: `eq.${id}` },
    });
    const post = rows && rows[0];
    if (!post) return res.status(404).json({ error: 'その投稿は見つかりません。' });
    if (!post.media_path) {
      return res.status(400).json({ error: 'この投稿には動画がありません。' });
    }

    const url = await db.signedUrl(post.media_path);
    const ext = (post.media_path.match(/\.[a-z0-9]+$/i) || ['.mp4'])[0];

    return res.status(200).json({
      url,
      // 保存したときに何の動画か分かる名前にしておく
      filename: safeName(post.title) + ext,
      kind: post.media_kind,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

/** ファイル名に使えない文字を落とす。空になったら日付で代える。 */
function safeName(title) {
  const s = String(title || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40).replace(/^_+|_+$/g, '');
  return s || 'post_' + new Date().toISOString().slice(0, 10);
}

module.exports.safeName = safeName;
