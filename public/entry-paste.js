'use strict';
/**
 * 「この日の記録」に、Claude が整理した記録をまとめて貼る。
 *
 * ★ 本人は話し言葉で Claude に送るだけ。Claude が次の形の1ブロックにして返し、
 *   それを「Claude の記録を貼る」欄に貼ると、各欄が埋まる。保存は本人が押す。
 *
 *   【投稿卓の記録】
 *   {"date":"2026-10-01",
 *    "income":{"アプリ課金":0,"アフィリエイト":0,"note":1480},
 *    "expenses":[{"item":"ドメイン代","yen":1500}],
 *    "tasks":[{"name":"LP作成","humanMin":30,"aiMin":15}],
 *    "services":[{"name":"家計簿アプリ","earn":"月額課金"}],
 *    "accounts":["A8.net"],
 *    "learnings":"…"}
 *
 *   {"date":…,"entry":{…}} の形（API に送る形）でも読む。
 *
 * ★ ここでは数字を作らない・直さない。読めない値は空にして、注意として返す。
 *   最終的な点検はサーバーの normalizeEntry（lib/series.js）が行う。
 *
 * ブラウザでは window.EntryPaste、Node（テスト）では require で使う。
 */
(function (root) {
  const DATE = /^\d{4}-\d{2}-\d{2}$/;

  /** "1,480円" や "１４８０" も数にする。読めなければ null。 */
  function num(v) {
    if (v === undefined || v === null || v === '') return 0;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v)
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[,，\s円分]/g, '');
    if (s === '') return 0;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  const str = (v) => (v === undefined || v === null ? '' : String(v));

  /**
   * 貼られた文から記録を取り出す。
   * @param {string} text 貼られた文（前後に説明文があってもよい）
   * @param {string[]} incomeCategories この企画の売上の内訳の名前
   * @returns {{date: string|null, entry: object, warnings: string[]}}
   */
  function parse(text, incomeCategories) {
    const s = str(text);
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('記録のブロック（{ から } まで）が見つかりません。Claude が返した【投稿卓の記録】をそのまま貼ってください。');
    let raw;
    try { raw = JSON.parse(s.slice(a, b + 1)); }
    catch (e) { throw new Error('記録のブロックが読めません。途中が切れていないか確かめて、もう一度貼ってください。'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('記録のブロックの形が違います。');

    const warnings = [];
    const src = raw.entry && typeof raw.entry === 'object' ? raw.entry : raw;
    const date = DATE.test(str(raw.date)) ? str(raw.date) : null;
    if (raw.date && !date) warnings.push(`日付「${str(raw.date)}」が読めないので、画面の日付のままにしました。`);

    const cats = incomeCategories || [];
    const income = {};
    for (const [k, v] of Object.entries(src.income || {})) {
      if (!cats.includes(k)) { warnings.push(`売上の内訳「${k}」はこの企画にありません（入れていません）。企画の型に足してから貼り直してください。`); continue; }
      const n = num(v);
      if (n === null) { warnings.push(`売上（${k}）「${str(v)}」が数として読めません。`); continue; }
      income[k] = n;
    }

    const rows = (v) => (Array.isArray(v) ? v : []).filter((x) => x && typeof x === 'object');
    const numField = (label, v) => {
      const n = num(v);
      if (n === null) { warnings.push(`${label}「${str(v)}」が数として読めません。`); return 0; }
      return n;
    };
    const expenses = rows(src.expenses).map((e) => ({ item: str(e.item), yen: numField(`かかったお金（${str(e.item)}）`, e.yen) }));
    const tasks = rows(src.tasks).map((t) => ({
      name: str(t.name),
      humanMin: numField(`人間の時間（${str(t.name)}）`, t.humanMin),
      aiMin: numField(`AIの時間（${str(t.name)}）`, t.aiMin),
    }));
    const services = rows(src.services).map((v) => ({ name: str(v.name), earn: str(v.earn), url: str(v.url) }));
    const accounts = (Array.isArray(src.accounts) ? src.accounts : str(src.accounts).split(/\r?\n/))
      .map(str).map((x) => x.trim()).filter(Boolean);

    return {
      date,
      entry: { income, expenses, tasks, services, accounts, learnings: str(src.learnings), note: str(src.note) },
      warnings,
    };
  }

  const api = { parse, num };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EntryPaste = api;
})(typeof window !== 'undefined' ? window : this);
