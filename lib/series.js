'use strict';
/**
 * 企画（シリーズ）の型と、数字の計算と、AI が書いた文の点検。
 *
 * ★ いちばん大事な決まり：数字は AI に書かせない。
 *   「30日で30アプリ」の DAY、「半年で100万」の累計・残り日数・達成率は、
 *   記録した値からここで計算する。AI には {累計} のような差し込み口だけを
 *   書かせ、あとで本物の値に置き換える。
 *   AI が自分で数字を書いてきたら（「売上5万円突破！」など）、点検で止める。
 *   稼ぐ系の企画は、数字を1回盛っただけで信用が終わるため。
 *
 * ★ 作業時間や費用のように、本人しか知らない数字は「毎回入れる項目」として
 *   本人に入れてもらい、それも差し込み口経由で入れる。
 *
 * AI も通信も使わない。全部決まった計算なので、テストで確かめられる。
 */

const { xLength } = require('../public/split-drafts.js');

const MAX_FIELDS = 10;
const MAX_TEXT = 2000;

// ---------------------------------------------------------------- 型

/**
 * 画面から来た型を、決まった形に揃える。知らないキーは捨てる。null なら企画なし。
 *
 *   name       企画名（「30日で30アプリ」）
 *   style      書き方の指示（口調・構成・締め方など。AI への指示になる）
 *   closing    毎回最後に入れる一言（任意）
 *   hashtags   毎回付けるハッシュタグ
 *   fields     毎回入れる項目の名前（「アプリ名」「人間の作業時間」…）
 *   startDate  DAY1 の日（YYYY-MM-DD、日本時間）
 *   goalYen    目標金額（円）。無ければ売上の記録を使わない
 *   endDate    期限（YYYY-MM-DD）
 *   script     動画台本も作るか
 */
function normalizeSeries(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('企画の型の指定が正しくありません。');

  const text = (v, max = MAX_TEXT) => String(v == null ? '' : v).trim().slice(0, max);
  const name = text(raw.name, 60);
  if (!name) throw bad('企画名を入れてください。');

  const fields = (Array.isArray(raw.fields) ? raw.fields : String(raw.fields || '').split(/\r?\n|,|、/))
    .map((f) => text(f, 30)).filter(Boolean);
  if (fields.length > MAX_FIELDS) throw bad(`毎回入れる項目は${MAX_FIELDS}個までです。`);
  if (new Set(fields).size !== fields.length) throw bad('毎回入れる項目に同じ名前があります。');
  for (const f of fields) {
    if (/[{}]/.test(f)) throw bad(`項目名「${f}」に { } は使えません。`);
    if (RESERVED.includes(f)) throw bad(`「${f}」は投稿卓が自動で計算する項目なので、入れる項目にはできません。`);
  }

  const hashtags = (Array.isArray(raw.hashtags) ? raw.hashtags : String(raw.hashtags || '').split(/\s+/))
    .map((t) => text(t, 60).replace(/^[#＃]+/, '')).filter(Boolean).map((t) => '#' + t);

  const startDate = date(raw.startDate, '開始日');
  const endDate = date(raw.endDate, '期限');
  const goalYen = raw.goalYen === '' || raw.goalYen == null ? null : Number(raw.goalYen);
  if (goalYen !== null && (!Number.isInteger(goalYen) || goalYen <= 0)) throw bad('目標金額は1円以上の整数で入れてください。');
  if (goalYen !== null && (!startDate || !endDate)) throw bad('目標金額を決めるときは、開始日と期限も入れてください。');
  if (startDate && endDate && endDate < startDate) throw bad('期限が開始日より前になっています。');

  return {
    name, style: text(raw.style), closing: text(raw.closing, 300),
    hashtags: [...new Set(hashtags)].slice(0, 15), fields,
    startDate, endDate, goalYen, script: raw.script === true,
  };
}

function date(v, label) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(new Date(s + 'T00:00:00+09:00').getTime())) {
    throw bad(`${label}は YYYY-MM-DD の形で入れてください。`);
  }
  return s;
}

// ---------------------------------------------------------------- 数字の計算

/** 日本時間の今日（YYYY-MM-DD）。 */
function jstToday(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
}

/** 日付の差（日）。a から b まで。 */
function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400e3);
}

/**
 * 記録から数字を出す。ここが「AI に書かせない数字」の出どころ。
 *
 * ★ DAY は開始日を DAY1 として、投稿する日（onDate）で数える。
 *   予約投稿は明日の分を今日作ることがあるので、「今日」ではなく投稿する日で数える。
 * ★ 累計は onDate までの記録だけを足す（未来の日付の記録は数えない）。
 */
function stats(series, logs, onDate) {
  const day = series && series.startDate ? daysBetween(series.startDate, onDate) + 1 : null;
  const out = { day, onDate };
  if (!series || !series.goalYen) return out;

  const upto = (logs || []).filter((l) => l.happened_on <= onDate);
  const total = upto.reduce((s, l) => s + Number(l.amount_yen || 0), 0);
  const todayRow = upto.find((l) => l.happened_on === onDate);
  return Object.assign(out, {
    total,
    today: todayRow ? Number(todayRow.amount_yen || 0) : 0,
    remainingYen: Math.max(0, series.goalYen - total),
    percent: Math.floor((total / series.goalYen) * 1000) / 10,   // 小数1桁、切り捨て（盛らない）
    daysLeft: series.endDate ? Math.max(0, daysBetween(onDate, series.endDate)) : null,
    goalYen: series.goalYen,
  });
}

// ---------------------------------------------------------------- 差し込み口

/** 投稿卓が計算して入れる差し込み口。AI にはこれだけを書かせる。 */
const RESERVED = ['DAY', '今日の売上', '累計', '目標', 'あと', '達成率', '残り日数'];

const yen = (n) => Number(n).toLocaleString('ja-JP') + '円';

/** 差し込み口 → 値。企画に無い数字（目標の無い企画の「累計」など）は入れない。 */
function slotValues(series, st, inputs) {
  const v = {};
  if (st.day !== null && st.day !== undefined) v.DAY = String(st.day);
  if (series && series.goalYen) {
    v['今日の売上'] = yen(st.today);
    v['累計'] = yen(st.total);
    v['目標'] = yen(st.goalYen);
    v['あと'] = yen(st.remainingYen);
    v['達成率'] = st.percent + '%';
    if (st.daysLeft !== null) v['残り日数'] = st.daysLeft + '日';
  }
  for (const f of (series && series.fields) || []) {
    const val = String((inputs || {})[f] == null ? '' : inputs[f]).trim();
    if (val) v[f] = val;
  }
  return v;
}

/** {名前} を値に置き換える。知らない差し込み口は残す（点検で止めるため）。 */
function fill(text, values) {
  return String(text || '').replace(/\{([^{}\n]{1,30})\}/g, (m, k) => (k in values ? values[k] : m));
}

// ---------------------------------------------------------------- 点検

const MSG_AI_NUMBER = 'AI が自分で数字を書いています。数字は差し込み口（{累計} など）でしか入れられません';

/**
 * 稼ぐ系で、見る人に向けて約束している言い方。
 * ★ 「自分が稼いだ記録」は問題ない。止めるのは「あなたも稼げる」の側。
 */
const INCOME_PROMISE = [
  { pattern: /(誰でも|だれでも|簡単に|かんたんに|楽に|ラクに|確実に|絶対に?|必ず|放置で|寝てても|スマホだけで)[^。\n]{0,20}(稼げ|儲か|月収|収入|万円)/, message: '「誰でも・簡単に稼げる」のように読める言い方です（景品表示法などに触れやすい）。自分の記録として書いてください' },
  { pattern: /(あなたも|君も|みなさんも|皆さんも)[^。\n]{0,20}(稼げ|儲か)/, message: '見る人に「稼げる」と約束する言い方です。自分の記録として書いてください' },
  { pattern: /(不労所得|ほったらかし|自動で稼)/, message: '「不労所得」のような言い方は誤解を招きやすいので避けてください' },
];

const ABSOLUTE = /(必ず|絶対|確実に|保証(します|されます|する|付))/;

/**
 * AI が書いた下書き（差し込み口を置き換える前）を点検する。
 * 返すのは [{ field, severity: 'error'|'warning', message, excerpt }]。
 *
 * @param draft   { instagram, tiktok, youtubeTitle, youtubeDescription, x, threads, script? }
 * @param allowed 数字が出てきてよい文字列（本人が入れた項目の値・企画名・固定ハッシュタグなど）
 */
function check(draft, { allowed = [], values = {}, hasAffiliateLink = false } = {}) {
  const out = [];
  for (const [field, text] of Object.entries(draft || {})) {
    if (typeof text !== 'string' || !text) continue;

    // 1) AI が書いた数字。差し込み口・ハッシュタグ・本人が入れた言葉の中の数字は除く。
    let rest = text.replace(/\{[^{}\n]{1,30}\}/g, ' ').replace(/[#＃][^\s#＃]+/g, ' ');
    for (const a of allowed) if (a) rest = rest.split(a).join(' ');
    // ★ 台本は投稿されず、場面の番号や秒数が普通に入る。お金と割合だけを見る。
    const m = field === 'script'
      ? rest.match(/[0-9０-９][0-9０-９,，.]*\s*(円|万|千|[%％])/)
      : rest.match(/[0-9０-９]+/);
    if (m) out.push({ field, severity: 'error', message: MSG_AI_NUMBER, excerpt: around(rest, m.index) });

    // 2) 知らない差し込み口（AI が勝手に作った {年収} など）
    for (const s of text.matchAll(/\{([^{}\n]{1,30})\}/g)) {
      if (!(s[1] in values)) {
        out.push({ field, severity: 'error', message: `「{${s[1]}}」は入れられる値がありません。この企画で使える差し込み口だけを使ってください`, excerpt: s[0] });
      }
    }

    // 3) 稼げる約束・断定
    for (const r of INCOME_PROMISE) {
      const hit = text.match(r.pattern);
      if (hit) out.push({ field, severity: 'error', message: r.message, excerpt: hit[0] });
    }
    const abs = text.match(ABSOLUTE);
    if (abs) out.push({ field, severity: 'warning', message: '断定的な言い方です。文脈によっては緩めてください', excerpt: abs[0] });

    // 4) 案件リンクがあるなら PR 表記（ステマ規制）。台本は投稿されないので見ない。
    if (hasAffiliateLink && field !== 'script' && field !== 'youtubeTitle' &&
        !/(^|[^A-Za-z])(PR|ＰＲ)([^A-Za-z]|$)|広告|プロモーション/.test(text)) {
      out.push({ field, severity: 'error', message: '案件リンクを含む投稿には PR 表記が必要です（ステマ規制）', excerpt: '' });
    }
  }
  return out;
}

/** 置き換えたあとの長さの点検（SNSごとの上限）。 */
function checkLengths(posts) {
  const out = [];
  if (posts.x && xLength(posts.x) > 280) {
    out.push({ field: 'x', severity: 'error', message: `X の本文が長すぎます（X の数え方で ${xLength(posts.x)}／280）`, excerpt: '' });
  }
  if (posts.threads && posts.threads.length > 500) {
    out.push({ field: 'threads', severity: 'error', message: `Threads の本文が長すぎます（${posts.threads.length}／500）`, excerpt: '' });
  }
  if (posts.youtubeTitle && posts.youtubeTitle.length > 100) {
    out.push({ field: 'youtubeTitle', severity: 'error', message: `YouTube のタイトルが長すぎます（${posts.youtubeTitle.length}／100）`, excerpt: '' });
  }
  return out;
}

function around(text, i) {
  return text.slice(Math.max(0, i - 10), i + 12).replace(/\s+/g, ' ').trim();
}

function bad(message, hint) {
  const e = new Error(message);
  e.userError = true;
  e.hint = hint;
  return e;
}

module.exports = {
  RESERVED, normalizeSeries, jstToday, daysBetween, stats, slotValues, fill, check, checkLengths, bad,
};
