'use strict';
/**
 * 生成した投稿文を機械で点検する。
 *
 * 運用者はネットの口コミを集めて紹介する「キュレーター」で、転職の実体験がない。
 * LLM は放っておくと一人称の体験談を書くので、プロンプトで頼むだけでは足りない。
 * 出てきたものをここで必ず見る。
 *
 * ★ 規則は運用アカウントごとに変える（PROFILES）。
 *   転職アカウントでは一人称が嘘になるが、ひろやアカウントは本人の実践記録なので
 *   一人称で書くのが正しい。同じ物差しを当てると後者は全部エラーになる。
 *   可変なのは「一人称」と「出典の断り」だけ。数値・断定・PR表記・画面幅は共通。
 *
 * ★ 動画本文とキャプションで基準が違う。
 *   実物の動画（reel_09）は「職場で話す人ほど → 広まる」と言い切っていて、
 *   出典の断りはキャプションの「口コミを集めた結果です」が担っている。
 *   動画本文に同じ基準をかけると、既存の投稿9本が全部引っかかる。
 */

// ---------------------------------------------------------------------------
// 運用アカウントごとの規則
// ---------------------------------------------------------------------------

/** 転職・第二新卒。口コミを集めて紹介する立場。 */
const CURATOR = { id: 'curator', label: 'キュレーター（実体験なし）', banFirstPerson: true, requireSourcing: true };

/** ひろや｜AI初心者30日30アプリ。本人が作ってみた記録。 */
const PERSONAL = { id: 'personal', label: '本人の実践記録', banFirstPerson: false, requireSourcing: false };

const PROFILES = { curator: CURATOR, personal: PERSONAL };

/** 知らない値なら安全側（キュレーター）に倒す。 */
function profileFor(id) {
  return PROFILES[id] || CURATOR;
}

// ---------------------------------------------------------------------------
// 引っかける言い回し
// ---------------------------------------------------------------------------

const MSG_FIRST_PERSON = '一人称の体験に読めます。「〜という声がありました」の形に直してください';

/**
 * 一人称の体験。ここが最大の事故ポイント。
 *
 * ★ 動詞を並べて当てにいってはいけない。並べ忘れた言い回しが素通りする。
 *   実際に「私も引き止められました」「作ってみました」の2つを取りこぼした。
 *   なので「一人称＋過去形」「て形＋みた」という"形"で拾う。
 *
 * 「自分」だけは別扱い。「自分を否定しないで」のように一般名詞として普通に
 * 使うので、「自分も／自分が」＋体験の形に限る。
 */
const FIRST_PERSON = [
  { rule: 'first-person-experience', severity: 'error', message: MSG_FIRST_PERSON,
    pattern: /(私|僕|俺|わたし|ぼく|オレ)(も|は|が|の)?[^。]{0,20}(ました|でした|だった|ています|てみた)/ },
  { rule: 'first-person-experience', severity: 'error', message: MSG_FIRST_PERSON,
    pattern: /自分(も|が)[^。]{0,12}(使っ|利用|登録|受け|やっ|転職|退職|面接|試し|行っ)/ },
  { rule: 'first-person-experience', severity: 'error', message: MSG_FIRST_PERSON,
    pattern: /([てで]み(た|ました|たら|ています)|実体験|体験談)/ },
];

const MSG_NUMBER = '出典のない数値です。数字を外すか、出典を添えてください';

/** 出典のない数値。「6つ」「3番」のような件数・番号は通す。 */
const UNSOURCED_NUMBER = [
  { rule: 'unsourced-number', severity: 'error', message: MSG_NUMBER,
    pattern: /[0-9０-９]+\s*(割|[%％]|人中|件中|倍以上)/ },
  { rule: 'unsourced-number', severity: 'error', message: MSG_NUMBER,
    pattern: /[0-9０-９]+\s*人に\s*[0-9０-９]+\s*人/ },
];

/** 成果と結びついた断定。「必ず年収が上がります」の類。 */
const ABSOLUTE_WITH_OUTCOME = {
  rule: 'absolute-claim', severity: 'error',
  message: '効果を断定しています。「〜という声が多かった」に緩めてください',
  pattern: /(必ず|絶対|確実に|100\s*[%％]|１００\s*[%％])[^。]{0,15}(上が|成功|受か|内定|決ま|なれ|できま|叶)/,
};

/** 成果とは結びついていない断定。念のため見せるだけ。 */
const ABSOLUTE_BARE = {
  rule: 'absolute-claim', severity: 'warning',
  message: '断定的な言い方です。文脈によっては緩めてください',
  pattern: /(必ず|絶対|確実に|保証(します|されます|する|付)|100\s*[%％])/,
};

/** 出典の断り。動画のキャプションにだけ求める。 */
const SOURCING = /(という声|との声|声も|声が|口コミ|集め|多かった|意見|感想|寄せられ|賛否|みたい)/;

/**
 * 断りが入っているか。
 *
 * ★ 足りないときに「こちらで足す」ために外へ出している（lib/draft-generate.js）。
 *   頼み方を強めても、モデルはときどき書き落とす。落としたぶんが下書きで
 *   止まると、20日続ける運用がそこで途切れる。
 *   この一文は、誰が書いても同じ内容の事実（実体験ではない）なので、
 *   足しても嘘にならない。むしろ落ちたまま出るほうが問題。
 */
const hasSourcing = (text) => SOURCING.test(String(text || ''));

/** PR表記（ステマ規制）。 */
const PR_LABEL = /(^|[^A-Za-z])(PR|ＰＲ)([^A-Za-z]|$)|広告|プロモーション|タイアップ/i;

/**
 * ハッシュタグ。
 *
 * ★ キャプションとは別の欄で受け取る。
 *   本文に混ぜて書かせると、書き漏らしても気づけず、
 *   数や中身を機械で見ることもできない。
 *
 * ★ X だけ 2個までにする。Instagram と TikTok は多いほうが見つけてもらえるが、
 *   X は多いと逆に読まれない（1〜2個が通例）。
 */
const HASHTAG_MIN = 3;
const X_HASHTAG_MAX = 2;

/** 使える形に整える。# の付け忘れを直し、空と重複を落とす。 */
function normalizeHashtags(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const t of raw) {
    const body = String(t == null ? '' : t).trim().replace(/^[#＃]+/, '').replace(/\s+/g, '');
    if (!body) continue;
    const tag = '#' + body;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * 実際に投稿される本文。キャプションの後ろにハッシュタグを足したもの。
 *
 * ★ 画面と点検が同じ関数を通ることが大事。
 *   別々に組み立てると、点検を通った文と投稿される文が食い違う。
 */
function captionWithTags(text, hashtags, network) {
  const tags = normalizeHashtags(hashtags);
  const use = network === 'x' ? tags.slice(0, X_HASHTAG_MAX) : tags;
  const body = String(text == null ? '' : text).trim();
  if (!use.length) return body;
  return body ? body + '\n\n' + use.join(' ') : use.join(' ');
}

// ---------------------------------------------------------------------------
// 画面に収まるか（reel_09 の実測から逆算）
// ---------------------------------------------------------------------------

/**
 * 問い開始 x=111、答えの枠は問いの右+15、枠の内側余白は左右20、
 * 字送り34px、右余白44px。
 *   111 + 34(問い) + 15 + 34(答え) + 40 <= 676  =>  問い+答え <= 15字ぶん
 */
const MAX_ROW_WIDTH = 15;
/** タイトルは x=44 から 43px 送りで右余白44px。(720-88)/43 = 14.7 */
const MAX_TITLE_WIDTH = 14;
const ANSWER_MIN = 2;
const ANSWER_MAX = 6;
const ROW_COUNT = 6;

/**
 * 縮めても収まらなくなる長さ。
 *
 * ★ public/reel.js は、右にはみ出す行を MIN_SCALE(0.55) まで縮めて収める。
 *   つまり 15字ぶんの枠に、0.55倍なら 15/0.55 ≒ 27字ぶんまで入る。
 *   そこまでは「小さくなるが全部見える」ので warning。
 *   超えると本当に切れるので error にして止める。文字の大きさではなく
 *   中身の問題なので、書き直してもらうしかない。
 *
 * ★ この2つの数は reel.js の MIN_SCALE と連動している。
 *   片方だけ変えると、点検を通ったのに切れる、が起きる。
 */
const MIN_SCALE = 0.55;
const MAX_ROW_FIT = Math.floor(MAX_ROW_WIDTH / MIN_SCALE);       // 27
const MAX_TITLE_FIT = Math.floor(MAX_TITLE_WIDTH / MIN_SCALE);   // 25

/** 見た目の字幅。半角英数は全角の半分として数える。 */
function visualWidth(text) {
  let w = 0;
  for (const ch of String(text || '')) {
    const c = ch.codePointAt(0);
    const half = c < 0x80 || (c >= 0xff61 && c <= 0xff9f);
    w += half ? 0.5 : 1;
  }
  return w;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

function excerptAround(text, index, length) {
  return text.slice(Math.max(0, index - 10), Math.min(text.length, index + length + 15));
}

/** 同じフィールドで同じ規則に何度当たっても、指摘は1件にまとめる。 */
function scan(field, text, rules, out) {
  for (const r of rules) {
    if (out.some((f) => f.field === field && f.rule === r.rule)) continue;
    const m = r.pattern.exec(text);
    if (!m) continue;
    out.push({
      field, rule: r.rule, severity: r.severity, message: r.message,
      excerpt: excerptAround(text, m.index, m[0].length),
    });
  }
}

function scanBanned(field, text, out, profile) {
  scan(field, text, profile.banFirstPerson ? FIRST_PERSON.concat(UNSOURCED_NUMBER) : UNSOURCED_NUMBER, out);
  // 成果つきの断定を先に見る。当たったら、ゆるい方は出さない。
  const before = out.length;
  scan(field, text, [ABSOLUTE_WITH_OUTCOME], out);
  if (out.length === before) scan(field, text, [ABSOLUTE_BARE], out);
}

/**
 * 下書き1本を点検する。
 *
 * draft = {
 *   kicker, title, rows: [{question, answer} x6],
 *   igCaption, ttCaption, xText,   // 媒体ごとの本文
 *   hasAffiliateLink
 * }
 *
 * 戻り値は指摘の配列。severity が 'error' のものが1つでもあれば公開を止める。
 */
function validateDraft(draft, profile) {
  const p = profile || CURATOR;
  const out = [];

  // --- 動画本文。言い切ってよいが、体験・数値・断定は許さない ---
  scanBanned('kicker', draft.kicker || '', out, p);
  scanBanned('title', draft.title || '', out, p);
  const rows = Array.isArray(draft.rows) ? draft.rows : [];
  rows.forEach((row, i) => {
    scanBanned(`rows[${i}].question`, row.question || '', out, p);
    scanBanned(`rows[${i}].answer`, row.answer || '', out, p);
  });

  if (rows.length !== ROW_COUNT) {
    out.push({ field: 'rows', rule: 'row-count', severity: 'error',
      message: `行はちょうど${ROW_COUNT}行にしてください（いまは${rows.length}行）` });
  }

  // --- 媒体ごとの本文 ---
  const texts = [
    ['igCaption', draft.igCaption],
    ['ttCaption', draft.ttCaption],
    ['xText', draft.xText],
  ];
  for (const [field, text] of texts) {
    if (!text) continue;
    scanBanned(field, text, out, p);
  }

  // 出典の断りは動画のキャプションにだけ求める（X は「答え合わせ」型なので不要）
  if (p.requireSourcing) {
    for (const field of ['igCaption', 'ttCaption']) {
      const text = draft[field];
      if (text && !SOURCING.test(text)) {
        out.push({ field, rule: 'missing-sourcing', severity: 'error',
          message: '出典の断りがありません。「口コミを集めた結果です」にあたる一文を入れてください' });
      }
    }
  }

  // --- PR表記（ステマ規制） ---
  //
  // ★ 見るのは「投稿される本文」。#PR をハッシュタグ側に入れるのが実務なので、
  //   キャプション本文だけを見ていると、正しく付けてあるのに弾いてしまう。
  if (draft.hasAffiliateLink) {
    for (const [field, network] of [['igCaption', 'instagram'], ['ttCaption', 'tiktok']]) {
      const text = draft[field];
      if (!text) continue;
      if (!PR_LABEL.test(captionWithTags(text, draft.hashtags, network))) {
        out.push({ field, rule: 'missing-pr-label', severity: 'error',
          message: '案件リンクを含む投稿です。PR表記を入れてください' });
      }
    }
  }

  // --- ハッシュタグ ---
  //
  // ★ 止めない。無くても投稿として成り立つし、
  //   ここで止めると、中身は問題ない20本が予約されなくなる。
  const tags = normalizeHashtags(draft.hashtags);
  if (tags.length < HASHTAG_MIN) {
    out.push({ field: 'hashtags', rule: 'too-few-hashtags', severity: 'warning',
      message: `ハッシュタグが${tags.length}個です。${HASHTAG_MIN}個以上あると見つけてもらいやすくなります`,
      excerpt: tags.join(' ') });
  }

  // --- 画面に収まるか ---
  const titleW = visualWidth(draft.title);
  if (titleW > MAX_TITLE_FIT) {
    out.push({ field: 'title', rule: 'title-too-wide', severity: 'error',
      message: `タイトルが長すぎて、縮めても入りません（${MAX_TITLE_FIT}字ぶんまで）。短くしてください`,
      excerpt: draft.title });
  } else if (titleW > MAX_TITLE_WIDTH) {
    out.push({ field: 'title', rule: 'title-too-wide', severity: 'warning',
      message: `タイトルが${MAX_TITLE_WIDTH}字ぶんを超えるので、小さくして収めます`, excerpt: draft.title });
  }
  rows.forEach((row, i) => {
    const rowW = visualWidth(row.question) + visualWidth(row.answer);
    if (rowW > MAX_ROW_FIT) {
      out.push({ field: `rows[${i}]`, rule: 'row-too-wide', severity: 'error',
        message: `長すぎて、縮めても枠に入りません（${MAX_ROW_FIT}字ぶんまで）。短くしてください`,
        excerpt: `${row.question}　${row.answer}` });
    } else if (rowW > MAX_ROW_WIDTH) {
      out.push({ field: `rows[${i}]`, rule: 'row-too-wide', severity: 'warning',
        message: `問いと答えの合計が${MAX_ROW_WIDTH}字ぶんを超えるので、この行だけ小さくして収めます`,
        excerpt: `${row.question}　${row.answer}` });
    }
    const a = visualWidth(row.answer);
    if (a < ANSWER_MIN || a > ANSWER_MAX) {
      out.push({ field: `rows[${i}].answer`, rule: 'answer-length', severity: 'warning',
        message: `答えは${ANSWER_MIN}〜${ANSWER_MAX}字ぶんが読みやすいです（見た目の話で、切れはしません）`,
        excerpt: row.answer });
    }
  });

  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

/** ある規則の指摘だけ取り出す。テストと画面の絞り込み用。 */
function findingsOf(draft, rule, profile) {
  return validateDraft(draft, profile).filter((f) => f.rule === rule);
}

/** 公開を止めるべきか。 */
function hasBlocking(findings) {
  return findings.some((f) => f.severity === 'error');
}

module.exports = {
  CURATOR, PERSONAL, PROFILES, profileFor,
  validateDraft, findingsOf, hasBlocking,
  visualWidth, hasSourcing, SOURCING,
  MAX_ROW_WIDTH, MAX_TITLE_WIDTH, MAX_ROW_FIT, MAX_TITLE_FIT, MIN_SCALE,
  ANSWER_MIN, ANSWER_MAX, ROW_COUNT,
  HASHTAG_MIN, X_HASHTAG_MAX, normalizeHashtags, captionWithTags,
};
