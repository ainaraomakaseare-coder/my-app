'use strict';
/**
 * 企画（シリーズ）の型と、毎日の記録と、数字の計算と、AI が書いた文の点検。
 *
 * ★ いちばん大事な決まり：数字は AI に書かせない。
 *   DAY・売上の累計と内訳・かかったお金・利益・残り日数・達成率・作業時間は、
 *   本人が入れた「毎日の記録」からここで計算する。AI には {累計} のような
 *   差し込み口だけを書かせ、あとで本物の値に置き換える。
 *   AI が自分で数字を書いてきたら（「売上5万円突破！」など）、点検で止める。
 *   稼ぐ系の企画は、数字を1回盛っただけで信用が終わるため。
 *
 * ★ 毎日の記録（1日1件。同じ日に保存し直すと上書き。足し算しない）
 *     income    売上の内訳 { アフィリエイト: 1200, アプリ収益: 0 }（円）
 *     expenses  かかったお金 [{ item: 'ドメイン', yen: 1500 }]
 *     tasks     やった作業と時間 [{ name: 'LP作成', humanMin: 60, aiMin: 30 }]
 *     accounts  作ったアカウント ['A8.net', 'note']
 *     services  公開した「お金を稼げるサービス」 [{ name: '家事分担アプリ', earn: '月額課金' }]
 *     learnings 学び（文章）
 *
 * AI も通信も使わない。全部決まった計算なので、テストで確かめられる。
 */

const { xLength } = require('../public/split-drafts.js');

const MAX_FIELDS = 10;
const MAX_TEXT = 2000;
const MAX_ROWS = 30;

const text = (v, max = MAX_TEXT) => String(v == null ? '' : v).trim().slice(0, max);
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/\r?\n/));

// ---------------------------------------------------------------- 型

/**
 * 画面から来た型を、決まった形に揃える。知らないキーは捨てる。null なら企画なし。
 *
 *   name       企画名
 *   style      書き方の指示（AI への指示）
 *   closing    毎回最後に入れる一言（差し込み口も使える）
 *   hashtags   毎回付けるハッシュタグ（差し込み口も使える。#DAY{DAY}）
 *   fields     毎回入れる項目（記録に無い、その回だけの事実。例：アプリ名）
 *   startDate  DAY1 の日（YYYY-MM-DD、日本時間）
 *   endDate    期限
 *   goalYen    目標金額（円）。あるとお金の記録を使う
 *   goalBasis  目標を何で数えるか。'revenue'（売上）か 'profit'（売上−かかったお金）
 *   incomeCategories  売上の内訳の名前（アフィリエイト・アプリ収益…）
 *   script     動画台本も作るか
 */
function normalizeSeries(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('企画の型の指定が正しくありません。');

  const name = text(raw.name, 60);
  if (!name) throw bad('企画名を入れてください。');

  const fields = uniqueNames(raw.fields, '毎回入れる項目', MAX_FIELDS);
  for (const f of fields) {
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

  let incomeCategories = uniqueNames(raw.incomeCategories, '売上の内訳', 10);
  if (goalYen && !incomeCategories.length) incomeCategories = ['アフィリエイト', 'アプリ収益'];

  return {
    name, style: text(raw.style), closing: text(raw.closing, 300),
    hashtags: [...new Set(hashtags)].slice(0, 15), fields,
    startDate, endDate, goalYen,
    goalBasis: raw.goalBasis === 'profit' ? 'profit' : 'revenue',
    incomeCategories: goalYen ? incomeCategories : [],
    script: raw.script === true,
  };
}

function uniqueNames(raw, label, max) {
  const names = list(raw).map((f) => text(f, 30)).filter(Boolean);
  if (names.length > max) throw bad(`${label}は${max}個までです。`);
  if (new Set(names).size !== names.length) throw bad(`${label}に同じ名前があります。`);
  for (const n of names) if (/[{}]/.test(n)) throw bad(`「${n}」に { } は使えません。`);
  return names;
}

function date(v, label) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(new Date(s + 'T00:00:00+09:00').getTime())) {
    throw bad(`${label}は YYYY-MM-DD の形で入れてください。`);
  }
  return s;
}

// ---------------------------------------------------------------- 毎日の記録

const yenInt = (v, label) => {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw bad(`${label}は0円以上の整数で入れてください。`);
  return n;
};
const minInt = (v, label) => {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 24 * 60) throw bad(`${label}は0〜1440分の整数で入れてください。`);
  return n;
};

/**
 * 画面から来た1日分の記録を揃える。
 * ★ 売上の内訳は、企画の型で決めた名前だけを受け付ける（打ち間違いで別の財布ができないように）。
 */
function normalizeEntry(raw, s) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const income = {};
  for (const c of (s && s.incomeCategories) || []) {
    income[c] = yenInt(r.income && r.income[c], `売上（${c}）`);
  }
  const rows = (v) => (Array.isArray(v) ? v : []).slice(0, MAX_ROWS);
  const expenses = rows(r.expenses)
    .map((e) => ({ item: text(e && e.item, 60), yen: yenInt(e && e.yen, `かかったお金（${text(e && e.item, 20) || '名前なし'}）`) }))
    .filter((e) => e.item || e.yen);
  for (const e of expenses) if (!e.item) throw bad('かかったお金に、何に使ったかを入れてください。');

  const tasks = rows(r.tasks)
    .map((t) => ({ name: text(t && t.name, 80), humanMin: minInt(t && t.humanMin, '人間の作業時間'), aiMin: minInt(t && t.aiMin, 'AIの作業時間') }))
    .filter((t) => t.name || t.humanMin || t.aiMin);
  for (const t of tasks) if (!t.name) throw bad('作業時間を入れた行に、作業の名前を入れてください。');

  const services = rows(r.services)
    .map((v) => ({ name: text(v && v.name, 80), earn: text(v && v.earn, 120), url: text(v && v.url, 300) }))
    .filter((v) => v.name || v.earn || v.url);
  for (const v of services) if (!v.name) throw bad('公開したサービスに名前を入れてください。');

  return {
    income,
    expenses,
    tasks,
    accounts: list(r.accounts).map((a) => text(a, 60)).filter(Boolean).slice(0, MAX_ROWS),
    services,
    learnings: text(r.learnings),
    note: text(r.note),
  };
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

const sumIncome = (e) => Object.values((e && e.income) || {}).reduce((a, b) => a + Number(b || 0), 0);
const sumExpenses = (e) => ((e && e.expenses) || []).reduce((a, x) => a + Number(x.yen || 0), 0);
const sumMin = (e, k) => ((e && e.tasks) || []).reduce((a, t) => a + Number(t[k] || 0), 0);

/**
 * 記録から数字を出す。ここが「AI に書かせない数字」の出どころ。
 *
 * @param entries [{ happened_on, entry }]（series_entries の行）
 * @param onDate  投稿する日。DAY はこの日で数え、累計はこの日までの記録だけを足す
 *                （予約投稿は明日の分を今日作ることがあるので「今日」ではなく投稿する日）
 */
function stats(s, entries, onDate) {
  const raw = s && s.startDate ? daysBetween(s.startDate, onDate) + 1 : null;
  // 開始日より前は DAY を出さない（「DAY-5」を投稿しないため）。代わりに「開始まであと○日」
  const day = raw !== null && raw >= 1 ? raw : null;
  const startsIn = raw !== null && raw < 1 ? 1 - raw : null;
  const upto = (entries || []).filter((r) => r.happened_on <= onDate && (!s || !s.startDate || r.happened_on >= s.startDate));
  const todayRow = upto.find((r) => r.happened_on === onDate);
  const today = (todayRow && todayRow.entry) || null;

  const out = {
    day, startsIn, onDate,
    hasToday: !!today,
    today: {
      humanMin: sumMin(today, 'humanMin'),
      aiMin: sumMin(today, 'aiMin'),
    },
    total: {
      humanMin: upto.reduce((a, r) => a + sumMin(r.entry, 'humanMin'), 0),
      aiMin: upto.reduce((a, r) => a + sumMin(r.entry, 'aiMin'), 0),
      services: upto.reduce((a, r) => a + ((r.entry && r.entry.services) || []).length, 0),
      accounts: upto.reduce((a, r) => a + ((r.entry && r.entry.accounts) || []).length, 0),
    },
  };
  if (!s || !s.goalYen) return out;

  const byCategory = {};
  for (const c of s.incomeCategories || []) byCategory[c] = 0;
  for (const r of upto) {
    for (const [c, v] of Object.entries((r.entry && r.entry.income) || {})) byCategory[c] = (byCategory[c] || 0) + Number(v || 0);
  }
  const revenue = upto.reduce((a, r) => a + sumIncome(r.entry), 0);
  const expenses = upto.reduce((a, r) => a + sumExpenses(r.entry), 0);
  const profit = revenue - expenses;
  const counted = s.goalBasis === 'profit' ? profit : revenue;

  Object.assign(out.today, {
    revenue: sumIncome(today),
    byCategory: Object.assign({}, ...Object.keys(byCategory).map((c) => ({ [c]: Number(((today && today.income) || {})[c] || 0) }))),
    expenses: sumExpenses(today),
  });
  Object.assign(out.total, { revenue, byCategory, expenses, profit });
  Object.assign(out, {
    goalYen: s.goalYen,
    goalBasis: s.goalBasis,
    counted,
    remainingYen: Math.max(0, s.goalYen - counted),
    // 小数1桁、切り捨て（盛らない）。利益がマイナスなら0%
    percent: Math.max(0, Math.floor((counted / s.goalYen) * 1000) / 10),
    daysLeft: s.endDate ? Math.max(0, daysBetween(onDate, s.endDate)) : null,
  });
  return out;
}

// ---------------------------------------------------------------- 差し込み口

/** 投稿卓が計算して入れる差し込み口。AI にはこれだけを書かせる。 */
const RESERVED = [
  'DAY', '今日の作業', '今日の作業時間', '累計の作業時間',
  '今日の売上', '今日の内訳', '累計', '累計の内訳', '今日かかったお金', 'かかったお金', '利益',
  '目標', 'あと', '達成率', '残り日数',
];

const yen = (n) => (n < 0 ? '-' : '') + Math.abs(Number(n)).toLocaleString('ja-JP') + '円';

/** 分 → 「1時間30分」「45分」「0分」 */
function hm(min) {
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m}分`;
  return m ? `${h}時間${m}分` : `${h}時間`;
}

const breakdown = (by) => Object.entries(by || {}).map(([c, v]) => `${c}${yen(v)}`).join('／');

/** 差し込み口 → 値。企画に無い数字（目標の無い企画の「累計」など）は入れない。 */
function slotValues(s, st, inputs, today) {
  const v = {};
  if (st.day !== null && st.day !== undefined) v.DAY = String(st.day);

  const tasks = (today && today.tasks) || [];
  if (tasks.length) {
    v['今日の作業'] = tasks.map((t) => {
      const parts = [];
      if (t.humanMin) parts.push(`人間${hm(t.humanMin)}`);
      if (t.aiMin) parts.push(`AI${hm(t.aiMin)}`);
      return parts.length ? `${t.name}（${parts.join('／')}）` : t.name;
    }).join('、');
    v['今日の作業時間'] = `人間${hm(st.today.humanMin)}／AI${hm(st.today.aiMin)}`;
  }
  if (st.total.humanMin || st.total.aiMin) v['累計の作業時間'] = `人間${hm(st.total.humanMin)}／AI${hm(st.total.aiMin)}`;

  if (s && s.goalYen) {
    v['今日の売上'] = yen(st.today.revenue);
    v['今日の内訳'] = breakdown(st.today.byCategory);
    v['累計'] = yen(st.total.revenue);
    v['累計の内訳'] = breakdown(st.total.byCategory);
    v['今日かかったお金'] = yen(st.today.expenses);
    v['かかったお金'] = yen(st.total.expenses);
    v['利益'] = yen(st.total.profit);
    v['目標'] = yen(st.goalYen);
    v['あと'] = yen(st.remainingYen);
    v['達成率'] = st.percent + '%';
    if (st.daysLeft !== null) v['残り日数'] = st.daysLeft + '日';
  }
  for (const f of (s && s.fields) || []) {
    const val = String((inputs || {})[f] == null ? '' : inputs[f]).trim();
    if (val) v[f] = val;
  }
  return v;
}

/** {名前} を値に置き換える。知らない差し込み口は残す（点検で止めるため）。 */
function fill(t, values) {
  return String(t || '').replace(/\{([^{}\n]{1,30})\}/g, (m, k) => (k in values ? values[k] : m));
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
 * @param allowed 数字が出てきてよい文字列（本人が入れた記録の言葉・企画名・固定ハッシュタグなど）
 */
function check(draft, { allowed = [], values = {}, hasAffiliateLink = false } = {}) {
  const out = [];
  const allow = allowed.filter(Boolean).slice().sort((a, b) => b.length - a.length);
  for (const [field, t] of Object.entries(draft || {})) {
    if (typeof t !== 'string' || !t) continue;

    // 1) AI が書いた数字。差し込み口・ハッシュタグ・本人が入れた言葉の中の数字は除く。
    let rest = t.replace(/\{[^{}\n]{1,30}\}/g, ' ').replace(/[#＃][^\s#＃]+/g, ' ');
    for (const a of allow) rest = rest.split(a).join(' ');
    // ★ 台本は投稿されず、場面の番号や秒数が普通に入る。お金と割合だけを見る。
    const m = field === 'script'
      ? rest.match(/[0-9０-９][0-9０-９,，.]*\s*(円|万|千|[%％])/)
      : rest.match(/[0-9０-９]+/);
    if (m) out.push({ field, severity: 'error', message: MSG_AI_NUMBER, excerpt: around(rest, m.index) });

    // 2) 知らない差し込み口（AI が勝手に作った {年収} など）
    for (const s of t.matchAll(/\{([^{}\n]{1,30})\}/g)) {
      if (!(s[1] in values)) {
        out.push({ field, severity: 'error', message: `「{${s[1]}}」は入れられる値がありません。この企画で使える差し込み口だけを使ってください`, excerpt: s[0] });
      }
    }

    // 3) 稼げる約束・断定
    for (const r of INCOME_PROMISE) {
      const hit = t.match(r.pattern);
      if (hit) out.push({ field, severity: 'error', message: r.message, excerpt: hit[0] });
    }
    const abs = t.match(ABSOLUTE);
    if (abs) out.push({ field, severity: 'warning', message: '断定的な言い方です。文脈によっては緩めてください', excerpt: abs[0] });

    // 4) 案件リンクがあるなら PR 表記（ステマ規制）。台本とタイトルは投稿本文ではないので見ない。
    if (hasAffiliateLink && field !== 'script' && field !== 'youtubeTitle' &&
        !/(^|[^A-Za-z])(PR|ＰＲ)([^A-Za-z]|$)|広告|プロモーション/.test(t)) {
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

function around(t, i) {
  return t.slice(Math.max(0, i - 10), i + 12).replace(/\s+/g, ' ').trim();
}

function bad(message, hint) {
  const e = new Error(message);
  e.userError = true;
  e.hint = hint;
  return e;
}

module.exports = {
  RESERVED, normalizeSeries, normalizeEntry, jstToday, daysBetween, stats, slotValues, fill, hm,
  check, checkLengths, bad,
};
