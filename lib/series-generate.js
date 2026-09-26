'use strict';
/**
 * 企画の型に沿って、5つのSNSの投稿案（と動画台本）を書かせる。
 *
 * ★ 流れ
 *   1. AI に書かせる。数字は書かせず、{累計} {DAY} のような差し込み口だけを使わせる
 *   2. 点検する（lib/series.js の check）。AI が数字を書いた・稼げると約束した等は止める
 *   3. 止まったら、指摘を添えて書き直させる（最大3回）
 *   4. 差し込み口を本物の値に置き換え、締めの一言とハッシュタグを付ける
 *   5. 長さ（X は日本語1文字＝2）を点検する
 *
 * ★ 締めの一言とハッシュタグは AI に書かせず、こちらで付ける。
 *   毎回同じものなので、書かせると言い回しが揺れたり、落としたりするだけ。
 */

const llm = require('./llm');
const series = require('./series');
const { captionWithTags, normalizeHashtags } = require('./draft-rules');

const MAX_ATTEMPTS = 3;

const SCHEMA = {
  type: 'object',
  properties: {
    instagram: { type: 'string', description: 'Instagram リール用の本文。ハッシュタグと締めの一言は書かない' },
    tiktok: { type: 'string', description: 'TikTok 用の本文。Instagram より短く。ハッシュタグと締めの一言は書かない' },
    youtubeTitle: { type: 'string', description: 'YouTube Shorts のタイトル。40文字前後、100文字以内' },
    youtubeDescription: { type: 'string', description: 'YouTube の概要欄。ハッシュタグと締めの一言は書かない' },
    x: { type: 'string', description: 'X 用。日本語で100文字以内に収める（X は日本語1文字を2と数えて280まで）。ハッシュタグは書かない' },
    threads: { type: 'string', description: 'Threads 用。会話のような語り口で、最後は問いかけ。500文字以内。ハッシュタグは書かない' },
    hashtags: {
      type: 'array', items: { type: 'string' },
      description: '内容に合うハッシュタグを3個まで。# を付ける。数字を含めない',
    },
    script: { type: 'string', description: '動画台本（頼まれたときだけ。頼まれていなければ空文字）' },
  },
  required: ['instagram', 'tiktok', 'youtubeTitle', 'youtubeDescription', 'x', 'threads', 'hashtags', 'script'],
  additionalProperties: false,
};

const SYSTEM = `あなたは、個人が続けている企画（チャレンジ）の記録を、SNS 向けの投稿文にする担当です。
投稿するのは企画をやっている本人です。一人称（「作りました」「やってみた」）で書いて構いません。

# 数字の決まり（最重要）
- 数字（算用数字）を自分で書いてはいけません。日付・金額・日数・時間・回数・順位、すべてです。
- 数字が必要なところは、与えられた「差し込み口」をそのまま書いてください。例：「DAY{DAY}」「累計{累計}」
  差し込み口は、あとで本物の値に置き換えます。
- 与えられていない差し込み口を作ってはいけません（{年収} など）。
- 本人が入力した項目の値は、差し込み口（{項目名}）で入れてください。言い換えたり数字を書き写したりしないでください。
- 数を言いたいときも算用数字は使わず、「もう一本」「一つ目」のように書くか、書かずに済む言い方にしてください。

# 稼ぐ・成果の話の決まり
- 見る人に「あなたも稼げる」「誰でも簡単に」「確実に」と約束しないでください。自分の記録として書きます。
- 起きていないことを書かないでください。入力に無い成果・反響・感想を作らないでください。

# 書き方
- 企画の「書き方の指示」があれば、それに従ってください。
- SNS ごとに長さと語り口を変えてください（Instagram は丁寧に、TikTok は短くテンポよく、X は要点だけ、Threads は語りかけ）。
- ハッシュタグと「締めの一言」は本文に書かないでください（こちらで付けます）。`;

/** AI に渡す依頼文。 */
/**
 * その日の記録を、AI に渡す材料にする。
 * ★ 作業の時間と金額は渡さない（差し込み口 {今日の作業} {今日の売上} で入る）。
 *   渡すと AI がその数字を本文に書き写し、差し込み口を使わなくなる。
 */
function todayMaterial(today) {
  if (!today) return '# 今日の記録\n（まだありません。記録に無いことは書かない）';
  const parts = ['# 今日の記録（本人が入れた事実。ここに無い成果・反響は書かない）'];
  if ((today.tasks || []).length) parts.push('やった作業：' + today.tasks.map((t) => t.name).join('、') + '（時間は {今日の作業} {今日の作業時間} で入れる）');
  if ((today.accounts || []).length) parts.push('作ったアカウント：' + today.accounts.join('、'));
  if ((today.services || []).length) {
    parts.push('公開した、お金を稼げるサービス：' + today.services.map((v) => v.earn ? `${v.name}（${v.earn}）` : v.name).join('、'));
  }
  if (today.learnings) parts.push('学び：' + today.learnings);
  if (today.note) parts.push('メモ：' + today.note);
  if (Object.keys(today.income || {}).length) parts.push('売上とかかったお金は {今日の売上} {今日の内訳} {今日かかったお金} で入れる（金額は書かない）');
  return parts.join('\n');
}

function userPrompt({ s, values, inputs, note, today, hasAffiliateLink, feedback }) {
  const slots = Object.keys(values);
  const lines = [
    `# 企画名\n${s.name}`,
    s.style ? `# 書き方の指示\n${s.style}` : '',
    `# 使える差し込み口（これ以外の数字は書かない）\n${slots.map((k) => `{${k}}`).join(' ') || '（なし）'}`,
    (s.fields || []).length ? `# 本人が入力した項目（値は差し込み口で入れる）\n${
      s.fields.map((f) => `- ${f}：${inputs[f] ? `{${f}}（＝${inputs[f]}）` : '（未入力。触れない）'}`).join('\n')}` : '',
    todayMaterial(today),
    note ? `# 今回の中身（本人のメモ。ここに無いことは書かない）\n${note}` : '',
    hasAffiliateLink ? '# 案件リンクを含む投稿です\n本文のどこかに「PR」と明記してください（ステマ規制）。' : '',
    s.script
      ? `# 動画台本も作ってください（script 欄）\n縦型ショート動画（30〜60秒）の台本。次の形で書く：\n【冒頭2秒のひと言】見る人が手を止める一文\n【本編】場面ごとに「読み上げ：」「テロップ：」「映すもの：」の3行\n【締め】コメントを促す一言\n最後に【用意する素材】として、撮る画面・写真の一覧。`
      : '# 動画台本は不要です（script は空文字）',
    feedback ? `# 前回の案の直すところ（必ず直す）\n${feedback}` : '',
  ];
  return lines.filter(Boolean).join('\n\n');
}

/**
 * 投稿案を作る。
 *
 * @param p.series      正規化済みの企画の型
 * @param p.entries     毎日の記録（series_entries の行 { happened_on, entry }）
 * @param p.onDate      投稿する日（YYYY-MM-DD）
 * @param p.inputs      { 項目名: 値 }
 * @param p.note        今回の中身のメモ
 * @param p.hasAffiliateLink
 * @param deps.json     LLM を呼ぶ関数（テストで差し替える）
 */
async function generate(p, deps = {}) {
  const ask = deps.json || llm.json;
  const s = p.series;
  const inputs = Object.assign({}, p.inputs || {});
  const entries = p.entries || [];
  const st = series.stats(s, entries, p.onDate);
  const todayRow = entries.find((r) => r.happened_on === p.onDate);
  const today = todayRow ? todayRow.entry : null;
  const values = series.slotValues(s, st, inputs, today);

  // 数字が出てきてよい文字列：本人が入れた言葉（項目の値・記録の中の名前や学び）・企画名・
  // 締めの一言・固定ハッシュタグ（# を外した形でも。「#企画名」を本文で書くのは正しい）
  const tagWords = (s.hashtags || []).map((t) => t.replace(/^#/, '')).filter((t) => !/[{}]/.test(t));
  const fromToday = today ? [
    ...(today.tasks || []).map((t) => t.name), ...(today.accounts || []),
    ...(today.services || []).flatMap((v) => [v.name, v.earn]), today.learnings, today.note,
  ] : [];
  const allowed = [s.name, s.closing, ...Object.values(inputs).map(String), ...(s.hashtags || []), ...tagWords, ...fromToday]
    .filter(Boolean);

  let feedback = '', last = null, findings = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const raw = await ask({
      system: SYSTEM,
      user: userPrompt({ s, values, inputs, note: p.note, today, hasAffiliateLink: p.hasAffiliateLink, feedback }),
      schema: SCHEMA, schemaName: 'series_posts', effort: 'medium', maxTokens: 8000,
    });
    const draft = pick(raw);
    const posts = assemble(draft, s, values);
    findings = series.check(draft, { allowed, values, hasAffiliateLink: p.hasAffiliateLink })
      .concat(series.checkLengths(posts));
    last = { draft, posts, attempts: attempt };
    const errors = findings.filter((f) => f.severity === 'error');
    if (!errors.length) break;
    feedback = errors.map((f) => `- ${f.field}：${f.message}${f.excerpt ? `（「${f.excerpt}」）` : ''}`).join('\n');
  }

  return {
    ok: !findings.some((f) => f.severity === 'error'),
    attempts: last.attempts,
    posts: last.posts,
    script: last.posts.script,
    stats: st,
    findings,
  };
}

const FIELDS = ['instagram', 'tiktok', 'youtubeTitle', 'youtubeDescription', 'x', 'threads', 'script'];

function pick(raw) {
  const d = {};
  for (const k of FIELDS) d[k] = String((raw && raw[k]) || '').trim();
  d.hashtags = normalizeHashtags(raw && raw.hashtags)
    .filter((t) => !/[0-9０-９]/.test(t)).slice(0, 3);   // AI のタグに数字は入れさせない
  return d;
}

/**
 * 差し込み口を値に置き換え、締めの一言とハッシュタグを付けて、投稿する形にする。
 * ★ 固定ハッシュタグの中の差し込み口（#DAY{DAY}）もここで置き換える。
 */
function assemble(d, s, values) {
  const fixed = (s.hashtags || []).map((t) => series.fill(t, values));
  const tags = normalizeHashtags(fixed.concat(d.hashtags || []));
  const withClosing = (t) => (s.closing ? `${t}\n\n${series.fill(s.closing, values)}` : t);
  const body = (k) => series.fill(d[k], values);

  return {
    instagram: captionWithTags(withClosing(body('instagram')), tags, 'instagram'),
    tiktok: captionWithTags(withClosing(body('tiktok')), tags.slice(0, 5), 'tiktok'),
    youtubeTitle: body('youtubeTitle'),
    youtubeDescription: captionWithTags(withClosing(body('youtubeDescription')), ['#Shorts'].concat(tags).slice(0, 6), 'youtube'),
    // X は短いので締めの一言は付けない。タグは2個まで（captionWithTags が絞る）
    x: captionWithTags(body('x'), tags, 'x'),
    // Threads はタグ（トピック）を1つしか付けられない
    threads: captionWithTags(withClosing(body('threads')), tags.slice(0, 1), 'threads'),
    script: body('script'),
  };
}

module.exports = { generate, assemble, userPrompt, todayMaterial, SCHEMA, SYSTEM };
