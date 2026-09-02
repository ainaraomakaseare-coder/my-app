'use strict';
/**
 * ネタから投稿文を1本作る。
 *
 * 画面の「投稿を作る」に流し込む手前まで。保存はしない。
 * 出てきたものは lib/draft-rules.js で点検し、指摘も一緒に返す。
 * 直すかどうかを決めるのは人間なので、悪い結果でも隠さず返す。
 *
 * ★ 点検の規則は運用アカウントごとに変わる。
 *   account_groups.validation_profile を見て切り替える。
 *   転職側では一人称が嘘になるが、ひろや側は本人の記録なので正しい。
 *
 * ★ 書かせる相手（Claude / OpenAI）は lib/llm.js が決める。
 *   ANTHROPIC_API_KEY か OPENAI_API_KEY の、設定してあるほうを使う。
 */

const auth = require('../lib/auth');
const db = require('../lib/db');
const rules = require('../lib/draft-rules');
const gen = require('../lib/draft-generate');

module.exports = async function handler(req, res) {
  if (!auth.guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

    const topicTitle = String(body.title || '').trim();
    if (!topicTitle) return res.status(400).json({ error: 'ネタを入力してください。' });

    // 運用アカウントに紐づく規則を引く。指定が無ければ安全側（キュレーター）。
    let profileId = null;
    if (body.group_id) {
      const groups = await db.listGroups();
      const g = groups.find((x) => x.id === body.group_id);
      profileId = g && g.validation_profile;
    }

    // 過去のネタを渡して切り口の重複を避ける。管理用タイトルを流用する。
    const past = (await db.rest('posts', {
      query: { select: 'title', order: 'created_at.desc', limit: 40 },
    })) || [];

    const result = await gen.generateDraft(
      {
        topicId: body.topic_id || topicTitle,
        title: topicTitle,
        tone: body.tone || 'calm',
        direction: body.direction || '',
        hasAffiliateLink: !!body.has_affiliate_link,
        groupId: body.group_id || null,
        avoidTitles: past.map((p) => p.title).filter(Boolean),
      },
      { profile: rules.profileFor(profileId) }
    );

    return res.status(200).json({
      ok: result.ok,
      attempts: result.attempts,
      draft: result.draft,
      findings: result.findings,
      profile: rules.profileFor(profileId).label,
    });
  } catch (err) {
    // 鍵の設定漏れやモデル名の間違いは、利用者が直せる。
    // 500 で潰さず、直し方（hint）ごと返す。
    const status = err.userError ? 400 : 500;
    return res.status(status).json({ error: err.message, hint: err.hint });
  }
};
