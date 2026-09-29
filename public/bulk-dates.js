'use strict';
/**
 * 「まとめて仕込む」で、ネタごとの予約日を決める。
 *
 * ★ 予約がある日は飛ばす。
 *   仕込み直すと、空いている日がとびとび（10/2・10/3・10/4・10/6…）になる。
 *   以前は「1本目の日付から毎日」しか入れられず、空いた日に合わせて何回かに分けるか、
 *   そのまま仕込んで同じ日に2本出すかしかなかった（2026-09-29 に二重になりかけた）。
 *
 * ブラウザでは window.BulkDates、Node（テスト）では require で使う。
 */
(function (root) {
  /** 'YYYY-MM-DD' に日数を足す。暦の計算は UTC で行い、地域の設定に左右されないようにする。 */
  function addDays(ymd, n) {
    const [y, m, d] = ymd.split('-').map(Number);
    const at = new Date(Date.UTC(y, m - 1, d));
    at.setUTCDate(at.getUTCDate() + n);
    return at.toISOString().slice(0, 10);
  }

  /** ISO の日時を、日本時間の 'YYYY-MM-DD' に。 */
  function jstDate(iso) {
    const t = new Date(iso);
    if (isNaN(t.getTime())) return null;
    return new Date(t.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  }

  // 予約がある、とみなす状態。下書き（draft）は日付が無いので数えない。
  const BOOKED = ['scheduled', 'processing', 'partial', 'success'];

  /**
   * その運用アカウントで、すでに予約（または投稿済み）の日の集合。
   * @param posts    /api/posts の posts
   * @param groupId  いま仕込もうとしている運用アカウント
   */
  function bookedDates(posts, groupId) {
    const out = new Set();
    for (const p of posts || []) {
      if (!p || !p.scheduled_at || !BOOKED.includes(p.status)) continue;
      if (groupId && p.group_id && p.group_id !== groupId) continue;
      const d = jstDate(p.scheduled_at);
      if (d) out.add(d);
    }
    return out;
  }

  /**
   * count 本ぶんの予約日を決める。
   * @param start   1本目の候補日 'YYYY-MM-DD'
   * @param every   何日おきか（1以上）
   * @param booked  飛ばす日の集合（null なら飛ばさない）
   * @returns { dates: ['YYYY-MM-DD', ...], skipped: ['YYYY-MM-DD', ...] }
   */
  function plan(start, count, every, booked) {
    const step = Math.max(1, every | 0);
    const dates = [];
    const skipped = [];
    let day = start;
    // 1年ぶん空きが無ければ諦める（無限に回らないように）
    for (let guard = 0; dates.length < count && guard < 366 * step + count; guard++) {
      if (booked && booked.has(day)) {
        skipped.push(day);
        day = addDays(day, 1);   // 埋まっていたら翌日を見る
        continue;
      }
      dates.push(day);
      day = addDays(day, step);
    }
    return { dates, skipped };
  }

  const api = { addDays, jstDate, bookedDates, plan, BOOKED };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BulkDates = api;
})(typeof window !== 'undefined' ? window : this);
