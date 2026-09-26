/*
 * 旅の足跡
 * 旅行（trip）と、その中の「大項目（block）」「小項目（entry）」はサーバー
 * （Cloudflare Worker + D1 + R2）に保存する。
 * データを扱う純粋な関数は window.TabiLog に集めてあり、node からもテストできる。
 */
(function (root) {
  'use strict';

  var CATEGORIES = [
    { key: 'sightseeing', label: '観光', color: 'oklch(60% 0.13 150)' },
    { key: 'food', label: '食事', color: 'oklch(64% 0.15 45)' },
    { key: 'lodging', label: '宿泊', color: 'oklch(48% 0.1 195)' },
    { key: 'transport', label: '移動', color: 'oklch(60% 0.12 260)' },
    { key: 'other', label: 'その他', color: 'oklch(55% 0.08 280)' }
  ];

  // 予定（Block）の場所までの移動手段。「地図でふりかえる」で、どのアイコンがどう動くかに使う。
  // key=''は未設定＝移動の演出なし（Worker側のTRANSPORTSと同じ並び）。
  var TRANSPORTS = [
    { key: '', label: 'なし' },
    { key: 'plane', label: '飛行機' },
    { key: 'car', label: '車（レンタカー）' },
    { key: 'taxi', label: 'タクシー（Uber）' },
    { key: 'train', label: '電車' },
    { key: 'bus', label: 'バス' },
    { key: 'walk', label: '徒歩' },
    { key: 'bicycle', label: '自転車' }
  ];

  var WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

  function categoryLabel(key) {
    var c = CATEGORIES.filter(function (c) { return c.key === key; })[0];
    return c ? c.label : key;
  }
  function categoryColor(key) {
    var c = CATEGORIES.filter(function (c) { return c.key === key; })[0];
    return c ? c.color : 'oklch(55% 0.08 280)';
  }

  function formatYen(n) {
    if (n === null || n === undefined || n === '') return '';
    return '¥' + Number(n).toLocaleString('ja-JP');
  }

  function parseDate(dateStr) {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    var parts = dateStr.split('-').map(Number);
    var d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    if (d.getUTCFullYear() !== parts[0] || d.getUTCMonth() !== parts[1] - 1 || d.getUTCDate() !== parts[2]) return null;
    return d;
  }

  function dateDiffDays(a, b) {
    var da = parseDate(a), db = parseDate(b);
    if (!da || !db) return null;
    return Math.round((db.getTime() - da.getTime()) / 86400000);
  }

  function formatDateJp(dateStr) {
    var d = parseDate(dateStr);
    if (!d) return '';
    return d.getUTCFullYear() + '.' + (d.getUTCMonth() + 1) + '.' + d.getUTCDate() + '（' + WEEKDAYS_JA[d.getUTCDay()] + '）';
  }

  function dayLabel(trip, dateStr) {
    if (!dateStr) return '日付未設定';
    var diff = trip && trip.startDate ? dateDiffDays(trip.startDate, dateStr) : null;
    if (diff !== null && diff >= 0) return (diff + 1) + '日目';
    return formatDateJp(dateStr) || dateStr;
  }

  function tripNights(trip) {
    if (!trip) return '';
    var diff = dateDiffDays(trip.startDate, trip.endDate);
    if (diff === null || diff < 0) return '';
    return diff === 0 ? '日帰り' : diff + '泊' + (diff + 1) + '日';
  }

  // 開始日・終了日から旅行の全日程を作る。無ければ大項目に実際にある日付から作る
  // （日付未入力の大項目があれば、末尾に空文字のキーとしてまとめる）。
  function allDatesForTrip(trip, blocks) {
    var dates = [];
    var start = trip ? parseDate(trip.startDate) : null;
    var end = trip ? parseDate(trip.endDate) : null;
    if (start && end && end.getTime() >= start.getTime()) {
      var cur = new Date(start.getTime());
      while (cur.getTime() <= end.getTime()) {
        var y = cur.getUTCFullYear(), m = String(cur.getUTCMonth() + 1).padStart(2, '0'), d = String(cur.getUTCDate()).padStart(2, '0');
        dates.push(y + '-' + m + '-' + d);
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    } else {
      var seen = {};
      (blocks || []).forEach(function (b) { if (b.date) seen[b.date] = true; });
      dates = Object.keys(seen).sort();
    }
    var hasUndated = (blocks || []).some(function (b) { return !b.date; });
    if (hasUndated) dates = dates.concat(['']);
    return dates;
  }

  // 時刻ありのBlockは常に時刻順で先に並べ、時刻なしのBlockはその後ろに作成順（＝ドラッグでの
  // 並べ替え順）で並べる。
  // 以前は「両方とも時刻が分かっているときだけ時刻で比べ、片方でも未設定なら作成順に委ねる」
  // 方式だったが、これは比較の一貫性（推移律：AがBより前でBがCより前ならAはCより前、が
  // 常に成り立つこと）が無く、時刻なしのBlockが1件でも混ざっていると、時刻ありのBlock同士の
  // 並び順までJavaScriptのsort()の内部処理によって壊れることがあった（2026-09-19、
  // 実際に9時の予定が10時の予定より後ろに表示される不具合として発覚）。
  // 「時刻ありは常に時刻順が先頭グループ、時刻なしは後ろグループ」という1本のキーに正規化
  // することで、一貫性のある比較にしている。
  // 同じ日の中の並び。時刻は現地時間のまま持ち、時差（_offset、分。applyBlockZonesが付ける）が分かっていれば
  // 世界共通の時刻（現地の分 − 時差）で比べる（docs/adr/0009）。日本20:00発→ハワイ同日10:00着のような移動で、
  // 現地時間のまま並べると着が発より前に来てしまっていたため。時差が分からなければ今までどおり現地時間で並べる。
  function blockSortKey(b) {
    if (!b.time) return '1:' + (b.createdAt || '');
    var m = /^(\d{1,2}):(\d{2})$/.exec(b.time);
    if (m && typeof b._offset === 'number') {
      return '0:' + String(Number(m[1]) * 60 + Number(m[2]) - b._offset + 2000).padStart(5, '0');
    }
    return '0:' + (m ? String(Number(m[1]) * 60 + Number(m[2]) + 2000).padStart(5, '0') : b.time);
  }

  // ---------- 時差（docs/adr/0009） ----------
  // 時刻は「その場所の現地時間」で入力・表示する（チケットや現地の時計に書いてある時刻のまま）。
  // 場所ごとのタイムゾーン（IANA名、例：Europe/London）から、その日その時刻の時差を求める。
  // サマータイムもIntlが正しく扱う。

  // tzの、utcMs（世界共通の時刻）における時差（分、東が正。日本は+540）
  var tzFormatters = {};
  function tzOffsetAt(tz, utcMs) {
    var fmt = tzFormatters[tz] || (tzFormatters[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }));
    var parts = fmt.formatToParts(new Date(utcMs));
    var get = function (t) { return Number(parts.filter(function (x) { return x.type === t; })[0].value); };
    return Math.round((Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute')) - utcMs) / 60000);
  }

  // tzでの現地時間 ymd hhmm の時差（分）。時刻が無ければその日の正午で考える。tzが無い・不正ならnull
  function tzOffsetMinutes(tz, ymd, hhmm) {
    var d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || ''), t = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '12:00');
    if (!tz || !d || !t) return null;
    try {
      var local = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
      var off = tzOffsetAt(tz, local);
      return tzOffsetAt(tz, local - off * 60000); // 切り替わり直前後でずれないよう、もう一度求め直す
    } catch (e) {
      return null;
    }
  }

  // 予定ごとのタイムゾーンを決める。優先順：その予定の場所（記録の地図）→ その日の場所（天気の場所）→
  // 直前の予定 → 端末のタイムゾーン。移動の予定の時刻は「出発の時刻」なので、出発地（直前の予定）の
  // タイムゾーンで読む（移動の予定自体の地図は到着地のことが多いため、次の予定へはそちらを引き継ぐ）。
  // 「直前の予定」は時差を考えた順でないと決まらない（現地時間の順だと、日付変更線をまたぐ移動で着が発より
  // 前に来る）ので、まず移動の決まりを使わずに仮に決めて時差を付けて並べ、その順でもう一度決める。
  function assignBlockZones(blocks, byBlock, byDate, fallback) {
    byBlock = byBlock || {}; byDate = byDate || {};
    function pass(list, useTransportRule) {
      var out = {}, prev = '';
      list.forEach(function (b) {
        var own = byBlock[b.id] || '';
        var tz = useTransportRule && b.category === 'transport' && prev ? prev : (own || byDate[b.date] || prev || fallback || '');
        out[b.id] = tz;
        prev = useTransportRule && b.category === 'transport' ? (own || byDate[b.date] || tz) : tz;
      });
      return out;
    }
    var copies = (blocks || []).map(function (b) { return Object.assign({}, b); });
    var first = pass(sortBlocks(copies), false);
    applyBlockZones(copies, first);
    return pass(sortBlocks(copies), true);
  }

  // 予定に _tz・_offset（分）を付ける（画面の中だけの値で、保存はしない）。zonesが無ければ外す。
  function applyBlockZones(blocks, zones) {
    (blocks || []).forEach(function (b) {
      var tz = zones && zones[b.id];
      var off = tz ? tzOffsetMinutes(tz, b.date, b.time) : null;
      if (typeof off === 'number') { b._tz = tz; b._offset = off; }
      else { delete b._tz; delete b._offset; }
    });
    return blocks;
  }

  // 時差の差（分）を「+1時間」「−8時間」「+5時間30分」にする
  function offsetDiffText(diffMin) {
    var sign = diffMin < 0 ? '−' : '+', a = Math.abs(diffMin), h = Math.floor(a / 60), m = a % 60;
    return sign + (h ? h + '時間' : '') + (m ? m + '分' : '') + (!h && !m ? '0時間' : '');
  }

  function sortBlocks(blocks) {
    return (blocks || []).slice().sort(function (a, b) {
      if (a.date !== b.date) return (a.date || '').localeCompare(b.date || '');
      return blockSortKey(a).localeCompare(blockSortKey(b));
    });
  }

  function groupBlocksByDate(blocks) {
    var map = {};
    sortBlocks(blocks).forEach(function (b) {
      var key = b.date || '';
      if (!map[key]) map[key] = [];
      map[key].push(b);
    });
    return map;
  }

  function entryCostTotal(entry) {
    return ((entry && entry.costItems) || []).reduce(function (sum, it) {
      return sum + (typeof it.amount === 'number' ? it.amount : 0);
    }, 0);
  }

  function blockCostTotal(block) {
    return ((block && block.entries) || []).reduce(function (sum, e) { return sum + entryCostTotal(e); }, 0);
  }

  function tripTotalCost(blocks) {
    return (blocks || []).reduce(function (sum, b) { return sum + blockCostTotal(b); }, 0);
  }

  // ---------- 割り勘（貸し借り・精算） ----------
  // costItemの立て替え・割り勘情報（paidBy・splitAmong）から、参加者ごとの貸し借り残高を
  // 集計する。paidByが無い費用行は「誰が払ったか分からない」ので集計から除外する
  // （旧仕様のときのように、Entryのauthorを勝手に払った人とみなすことはしない。
  // 「他の人が立て替えたのも入れられるようにしたい」という要望どおり、払った人は本人が
  // 明示的に選ぶ前提のため）。splitAmongが無い費用行は「割り勘なしの個人費用」という、
  // これまでどおりの意味として扱い、paidBy本人だけで割ったもの（＝貸し借りゼロ）とみなす。
  // 戻り値は {費用のあった参加者名: 残高（円、プラス＝もらう側、マイナス＝払う側）}。
  function tripBalances(trip, blocks) {
    var balance = {};
    ((trip && trip.companions) || []).forEach(function (name) { balance[name] = 0; });
    function add(name, yen) {
      if (!name) return;
      balance[name] = (balance[name] || 0) + yen;
    }
    (blocks || []).forEach(function (block) {
      (block.entries || []).forEach(function (entry) {
        (entry.costItems || []).forEach(function (item) {
          var paidBy = item.paidBy || '';
          if (!paidBy || !(item.amount > 0)) return;
          var splitAmong = (item.splitAmong && item.splitAmong.length) ? item.splitAmong : [paidBy];
          add(paidBy, item.amount);
          var share = item.amount / splitAmong.length;
          splitAmong.forEach(function (name) { add(name, -share); });
        });
      });
    });
    return balance;
  }

  // 貸し借り残高（tripBalancesの結果）から、送金の回数が最小になるような精算方法を作る
  // （最も多くもらう人と最も多く払う人を順にマッチさせる、よく知られた貪欲法）。
  // 端数（1円未満）は四捨五入し、集計誤差で1円未満だけ残るケースは無視する。
  function settlementPlan(balance) {
    var creditors = [];
    var debtors = [];
    Object.keys(balance || {}).forEach(function (name) {
      var yen = Math.round(balance[name]);
      if (yen > 0) creditors.push({ name: name, amount: yen });
      else if (yen < 0) debtors.push({ name: name, amount: -yen });
    });
    creditors.sort(function (a, b) { return b.amount - a.amount; });
    debtors.sort(function (a, b) { return b.amount - a.amount; });
    var plan = [];
    var i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      var pay = Math.min(debtors[i].amount, creditors[j].amount);
      if (pay >= 1) plan.push({ from: debtors[i].name, to: creditors[j].name, amount: pay });
      debtors[i].amount -= pay;
      creditors[j].amount -= pay;
      if (debtors[i].amount < 1) i++;
      if (creditors[j].amount < 1) j++;
    }
    return plan;
  }

  // 割り勘の対象になっている費用行だけを、日付順に一覧できる形にする（精算画面の「支出一覧」用）
  function tripExpenseList(blocks) {
    var out = [];
    (blocks || []).forEach(function (block) {
      (block.entries || []).forEach(function (entry) {
        (entry.costItems || []).forEach(function (item) {
          if (!item.paidBy || !(item.amount > 0)) return;
          out.push({
            date: block.date, label: item.label, amount: item.amount,
            paidBy: item.paidBy, splitAmong: (item.splitAmong && item.splitAmong.length) ? item.splitAmong : [item.paidBy],
            blockLabel: block.label,
          });
        });
      });
    });
    out.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    return out;
  }

  // 宿泊カテゴリのBlockは「到着する」「宿に戻る」のように、同じ宿について複数できることがある
  // （特に音声入力は行動ごとにBlockを分けるため）。すべて繋げると意味不明になるので、
  // 一番最初（日程順で最初）の見出しだけを「宿泊先」として代表させる。
  function primaryLodgingName(blocks) {
    var lodging = (blocks || []).filter(function (b) { return b.category === 'lodging' && b.label; });
    return lodging.length ? lodging[0].label : '';
  }

  // 宿泊先を「何泊目に、どこに泊まったか」で一覧にする。宿泊カテゴリのBlockは、
  // そのBlockの日付「以降」ずっとそこに泊まっている（次の宿泊Blockが出てくるまで）とみなす
  // （「1日目にAホテル到着、7日目にBホテルへ移動」なら、1〜6泊目がAホテル・7泊目がBホテル）。
  // 同じ宿が連続する夜はまとめて「1〜7泊目」のように範囲でまとめる。
  function lodgingByNight(trip, blocks) {
    var dates = allDatesForTrip(trip, blocks);
    if (dates.length < 2) return []; // 日帰り、または日程が確定していない旅行には「泊」が無い
    var nights = dates.length - 1;
    var lodging = (blocks || [])
      .filter(function (b) { return b.category === 'lodging' && b.label && b.date; })
      .slice()
      .sort(function (a, b) {
        if (a.date !== b.date) return (a.date || '').localeCompare(b.date || '');
        return blockSortKey(a).localeCompare(blockSortKey(b));
      });
    var labelForNight = [];
    for (var i = 0; i < nights; i++) {
      var nightDate = dates[i];
      var applicable = '';
      for (var j = 0; j < lodging.length; j++) {
        if (lodging[j].date <= nightDate) applicable = lodging[j].label; else break;
      }
      labelForNight.push(applicable);
    }
    var groups = [];
    labelForNight.forEach(function (label, idx) {
      var n = idx + 1;
      var last = groups[groups.length - 1];
      if (last && last.label === label) last.to = n;
      else groups.push({ label: label, from: n, to: n });
    });
    return groups;
  }

  // 費用の総額を「実際に払った人」ごとに内訳表示するための集計。立て替え（paidBy）を
  // 設定した費用行はpaidByへ、設定していない費用行（従来どおりの個人費用）はEntryの
  // authorへ、それぞれ全額を計上する（誰か1人が全部払ったことにして二重計上はしない）。
  function costBreakdownByPerson(blocks) {
    var totals = {};
    (blocks || []).forEach(function (block) {
      (block.entries || []).forEach(function (entry) {
        (entry.costItems || []).forEach(function (item) {
          if (!(item.amount > 0)) return;
          var payer = item.paidBy || entry.author || '';
          if (!payer) return;
          totals[payer] = (totals[payer] || 0) + item.amount;
        });
      });
    });
    return totals;
  }

  function parseTags(text) {
    return (text || '').split(/[、,]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function getTripIdFromSearch(search) {
    var m = /(?:^\?|&)trip=([^&]+)/.exec(search || '');
    return m ? decodeURIComponent(m[1]) : '';
  }

  function buildShareUrl(origin, pathname, tripId) {
    return origin + pathname + '?trip=' + encodeURIComponent(tripId);
  }

  // 端末に「開いたことのある旅行」を憶えておくための一覧（サーバーのデータそのものではない、ローカルの索引）
  function upsertTripIndexEntry(list, entry) {
    var out = (list || []).filter(function (t) { return t.id !== entry.id; });
    out.unshift(entry);
    return out.slice(0, 50);
  }

  // サーバー側で削除済み（見つからない）旅行を、この索引からも取り除く
  function removeTripIndexEntry(list, id) {
    return (list || []).filter(function (t) { return t.id !== id; });
  }

  // ホーム画面の「最近開いた旅行一覧」を、誰と行ったか・年・旅行区分（自由入力）で絞り込む。
  // 3つとも指定が無ければ全件そのまま返す（AND条件）。
  function filterTrips(trips, filters) {
    filters = filters || {};
    return (trips || []).filter(function (t) {
      if (filters.companion && (t.companions || []).indexOf(filters.companion) === -1) return false;
      if (filters.year && (t.startDate || '').slice(0, 4) !== filters.year) return false;
      if (filters.tripType && (t.tripType || '') !== filters.tripType) return false;
      return true;
    });
  }

  // ホーム画面の並び順。''（既定）は「最近開いた・編集した順」（upsertTripIndexEntryの並びそのまま）。
  // 'date_asc'/'date_desc'は旅行の開始日で並べ替える。日程未設定の旅行はどちらの向きでも末尾に置く。
  function sortTrips(trips, sortKey) {
    var out = (trips || []).slice();
    if (sortKey === 'date_asc') {
      out.sort(function (a, b) { return (a.startDate || '9999-99-99').localeCompare(b.startDate || '9999-99-99'); });
    } else if (sortKey === 'date_desc') {
      out.sort(function (a, b) { return (b.startDate || '').localeCompare(a.startDate || ''); });
    }
    return out;
  }

  // 上の絞り込み欄（プルダウン）に出す選択肢を、実際に旅行データに登場する値だけから作る
  // （固定の選択肢を用意すると、人によって「サークルの友達」「大学のサークル」のように
  // 呼び方が揺れて選べない値が出てしまうため、自由入力＋実データからの選択肢にしている）。
  function tripFilterOptions(trips) {
    var companions = {}, years = {}, tripTypes = {};
    (trips || []).forEach(function (t) {
      (t.companions || []).forEach(function (c) { if (c) companions[c] = true; });
      if (t.startDate) years[t.startDate.slice(0, 4)] = true;
      if (t.tripType) tripTypes[t.tripType] = true;
    });
    return {
      companions: Object.keys(companions).sort(),
      years: Object.keys(years).sort().reverse(),
      tripTypes: Object.keys(tripTypes).sort(),
    };
  }

  // entryが持つ評価（{raterEmail, raterName, score}の配列）から、平均と件数を出す
  function ratingSummary(ratings) {
    var list = (ratings || []).filter(function (r) { return typeof r.score === 'number' && r.score > 0; });
    if (!list.length) return { avg: 0, count: 0 };
    var sum = list.reduce(function (s, r) { return s + r.score; }, 0);
    return { avg: sum / list.length, count: list.length };
  }

  // 評価の一覧から、指定したメールアドレス本人の評価だけを取り出す（無ければ0）
  function myRatingScore(ratings, email) {
    if (!email) return 0;
    var mine = (ratings || []).filter(function (r) { return (r.raterEmail || '').toLowerCase() === email.toLowerCase(); })[0];
    return mine ? mine.score : 0;
  }

  // マイログの並べ替え。sortKeyは'score'（評価が高い順、同点なら新しい順）か'date'（新しい順）
  function sortMyLogItems(items, sortKey) {
    var out = (items || []).slice();
    if (sortKey === 'score') {
      out.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return (b.ratedAt || '').localeCompare(a.ratedAt || '');
      });
    } else {
      out.sort(function (a, b) { return (b.ratedAt || '').localeCompare(a.ratedAt || ''); });
    }
    return out;
  }

  // WMO weather code（Open-Meteoが返す天気コード）を日本語の短い表示に変換する。
  // precipSum（その日の降水量mm）が1mm以下なら、雨系のコードでも「曇り」として扱う
  // （コードだけだと、ごく僅かな小雨でも「雨」表示になってしまうため）。
  // 雷雨（95以上）は降水量が少なくても雷そのものが観測された結果なので対象外。
  function weatherLabel(code, precipSum) {
    if (code === null || code === undefined) return '';
    var isLightRain = ((code >= 51 && code <= 67) || (code >= 80 && code <= 82))
      && typeof precipSum === 'number' && precipSum <= 1;
    if (isLightRain) return '曇り';
    if (code === 0) return '快晴';
    if (code === 1 || code === 2) return '晴れ';
    if (code === 3) return '曇り';
    if (code === 45 || code === 48) return '霧';
    if (code >= 51 && code <= 57) return '霧雨';
    if (code >= 61 && code <= 67) return '雨';
    if (code >= 71 && code <= 77) return '雪';
    if (code >= 80 && code <= 82) return 'にわか雨';
    if (code >= 85 && code <= 86) return 'にわか雪';
    if (code >= 95) return '雷雨';
    return '';
  }

  // ---------- 地図でふりかえる（replay） ----------
  // 予定（Block）を「地図の上を時刻どおりに移動していく演出」に変換する純粋関数。
  // 地図の描画（Leaflet）は画面側の仕事で、ここでは「どの順で・いつ・どこにいるか」だけを決める。
  // 時間の単位は2つある：t＝旅の中の時刻（1日目0時からの経過分）、r＝再生の実時間（秒）。

  var REPLAY_SEC_PER_MIN = 0.12;     // 500倍速（旅の1分＝実時間0.12秒）。100倍速では遅いという声で変更
  var REPLAY_LEAD_MIN = 5;           // 最初の予定の少し前から時計を動かし始める
  var REPLAY_DWELL_MIN = 8;          // 到着後、吹き出しを見せながら500倍速で進める旅の時間（分）
  var REPLAY_MIN_CAPTION_SEC = 2.5;  // 時刻が詰まっている予定でも、吹き出しは最低この秒数見せる
  var REPLAY_MAX_CAPTION_SEC = 8;    // 長い吹き出しでも、これ以上は止めない
  var REPLAY_READ_CHARS_PER_SEC = 12; // 吹き出しを読み切れるよう、1秒にこの文字数を目安に見せる時間を延ばす
  var REPLAY_MOVE_MIN_SEC = 2;       // 移動の演出は最低この秒数
  var REPLAY_MOVE_CAP_SEC = 6;       // 長い移動（数時間のフライトなど）もこの秒数に早送りする
  var REPLAY_IDLE_CAP_SEC = 1.2;     // 移動も何も無い空き時間はこの秒数に早送りする
  var REPLAY_UNTIMED_START_MIN = 9 * 60;

  // 予定の場所は、記録に入っている地図のURL（Googleマップの共有リンク maps.app.goo.gl/… や
  // 検索URL）だけから決める。URLのままWorker（/geocode）に渡し、短縮URLの展開・座標や住所の
  // 読み取りはWorker側で行う。地図の入っていない予定（「小西遅刻」など）は移動の目的地にせず、
  // 空文字を返して「出来事」（その場で吹き出しだけ出す）として扱う。
  // 以前は見出し（「那覇空港に到着」など）から地名を推測していたが、同名の別の場所に飛ぶなど
  // 外れることがあったため、地図が入っている予定だけを使う方針にした。
  function replayPlaceQuery(block) {
    var entries = (block && block.entries) || [];
    for (var i = 0; i < entries.length; i++) {
      var url = (entries[i].mapUrl || '').trim();
      if (/^https?:\/\//i.test(url)) return url;
    }
    return '';
  }

  function hhmmToMinute(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }
  function minuteToHHMM(min) {
    var h = Math.floor(min / 60), m = Math.floor(min % 60);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  // タイムラインと同じ並び（sortBlocks：時刻ありが時刻順で先、時刻なしは後ろ）で、再生する地点を作る。
  // 時刻なしの予定は、その日の直前の予定の30分後（その日に時刻ありが1つも無ければ9時から1時間おき）と推定する。
  // 各地点の記録（エピソード・ひとこと）は、到着したときに出す吹き出しの中身にする。
  function replayStops(trip, blocks) {
    var dates = allDatesForTrip(trip, blocks).filter(function (d) { return d; });
    var lastMinute = {}, hasTimed = {}, lastOffset = null;
    (blocks || []).forEach(function (b) { if (b.date && hhmmToMinute(b.time) !== null) hasTimed[b.date] = true; });
    // 移動の予定（種類が「移動」）の移動手段・移動時間は、その予定から次の場所への移動として、次の地点に渡す。
    // 以前のデータ（移動以外の予定に「ここまでの移動手段」が付いているもの）は、その予定自身の値を使う。
    var pendingTransport = '', pendingMove = 0;
    return sortBlocks(blocks).filter(function (b) { return b.date && dates.indexOf(b.date) !== -1; }).map(function (b) {
      var minute = hhmmToMinute(b.time);
      var estimated = minute === null;
      if (estimated) {
        var prev = lastMinute[b.date];
        // 時刻の無い予定でも、直前の移動に移動時間があれば、その分だけ後と見積もる
        var step = pendingMove || (hasTimed[b.date] ? 30 : 60);
        minute = prev === undefined ? REPLAY_UNTIMED_START_MIN : Math.min(prev + step, 23 * 60 + 59);
      }
      var arriving = b.category === 'transport' ? '' : (b.transport || pendingTransport);
      if (b.category === 'transport') { pendingTransport = b.transport || ''; pendingMove = b.moveMinutes || 0; }
      else if (replayPlaceQuery(b)) { pendingTransport = ''; pendingMove = 0; }
      lastMinute[b.date] = minute;
      if (typeof b._offset === 'number') lastOffset = b._offset;
      var dayIndex = dates.indexOf(b.date);
      var captions = (b.entries || []).map(function (e) {
        // 以前は40文字で切っていたため、スマホでは1.5行ほどで途切れていた。全文を出す（見せる時間は文字数で延ばす）
        return (e.episode || '').trim() || (e.comment || '').trim();
      }).filter(Boolean).slice(0, 3);
      return {
        blockId: b.id, date: b.date, dayIndex: dayIndex, dayNumber: dayIndex + 1,
        minute: minute, estimated: estimated, label: b.label || '', captions: captions,
        transport: arriving, query: replayPlaceQuery(b),
        offset: lastOffset // 現地の時差（分）。分からなければnull（時刻なしの予定は直前の予定の時差）
      };
    });
  }

  // 2点の間の位置（f=0〜1）。飛行機（arc=true）は進行方向の左へ弧を描くようにふくらませる。
  function arcLatLng(from, to, f, arc) {
    var dLat = to.lat - from.lat, dLng = to.lng - from.lng;
    var lat = from.lat + dLat * f, lng = from.lng + dLng * f;
    if (arc) {
      var bulge = Math.sin(Math.PI * f) * 0.18;
      lat += -dLng * bulge;
      lng += dLat * bulge;
    }
    return { lat: lat, lng: lng };
  }

  // 真北を0度とした時計回りの向き（飛行機アイコンを進行方向へ回すのに使う）
  function bearingDeg(a, b) {
    var dy = b.lat - a.lat, dx = (b.lng - a.lng) * Math.cos(a.lat * Math.PI / 180);
    return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  }

  // 地点（replayStops）と地名→座標の対応から、再生の時間割を作る。
  // - 地図上の地点になるのは、座標が分かった予定だけ（分からなければ吹き出しだけの「出来事」）
  // - 移動の演出は「移動手段がある予定」へ、直前に地図上にいた地点から向かうときだけ
  // - 移動は到着する予定の1つ前の地点での滞在が終わってから始める（途中で夕食など場所不明の出来事が
  //   挟まっても、アイコンはそれまで最後にいた場所で待つ）
  // - 旅の時間は基本500倍速、ただし長い移動・何も無い空き時間は上限秒数に早送りする
  function buildReplayTimeline(stops, coordsByQuery) {
    coordsByQuery = coordsByQuery || {};
    var withOffset = (stops || []).filter(function (st) { return typeof st.offset === 'number'; })[0];
    var baseOffset = withOffset ? withOffset.offset : 0;
    var s = (stops || []).map(function (st) {
      var c = st.query ? coordsByQuery[st.query] : null;
      var located = !!(c && typeof c.lat === 'number' && typeof c.lng === 'number');
      return Object.assign({}, st, {
        // 時差がある旅行では、現地の分から「最初の場所の時差との差」を引き、並びと移動の長さを世界共通の時刻にする
        t: st.dayIndex * 1440 + st.minute - (typeof st.offset === 'number' ? st.offset - baseOffset : 0), located: located,
        lat: located ? c.lat : null, lng: located ? c.lng : null
      });
    });
    if (!s.length) return { stops: [], legs: [], keyframes: [{ t: 0, r: 0 }], totalReal: 0, baseOffset: 0 };

    var legs = [], lastLoc = -1;
    s.forEach(function (st, i) {
      if (!st.located) return;
      if (lastLoc >= 0 && st.transport && (s[lastLoc].lat !== st.lat || s[lastLoc].lng !== st.lng)) {
        legs.push({ from: lastLoc, to: i, transport: st.transport });
      }
      lastLoc = i;
    });
    var legArrivingAt = {};
    legs.forEach(function (l) { legArrivingAt[l.to] = l; });

    var kf = [], r = 0;
    var tStart = Math.max(s[0].t - REPLAY_LEAD_MIN, s[0].dayIndex * 1440);
    kf.push({ t: tStart, r: 0 });
    r += (s[0].t - tStart) * REPLAY_SEC_PER_MIN;
    s.forEach(function (st, i) {
      st.r = r;
      kf.push({ t: st.t, r: r });
      var next = s[i + 1];
      // 最後の予定は、深夜でも時計が翌日（存在しない日）にはみ出さないよう、その日の23:59までにとどめる
      var gap = next ? Math.max(0, next.t - st.t) : Math.max(0, Math.min(REPLAY_DWELL_MIN, (st.dayIndex + 1) * 1440 - 1 - st.t));
      var moving = !!(next && legArrivingAt[i + 1]);
      var dwell = moving ? Math.min(gap / 2, REPLAY_DWELL_MIN) : Math.min(gap, REPLAY_DWELL_MIN);
      r += dwell * REPLAY_SEC_PER_MIN;
      kf.push({ t: st.t + dwell, r: r });
      var chars = (st.captions || []).join('').length + (st.label || '').length;
      var minSec = Math.min(REPLAY_MAX_CAPTION_SEC, Math.max(REPLAY_MIN_CAPTION_SEC, chars / REPLAY_READ_CHARS_PER_SEC));
      if (dwell * REPLAY_SEC_PER_MIN < minSec) {
        r += minSec - dwell * REPLAY_SEC_PER_MIN;
        kf.push({ t: st.t + dwell, r: r });
      }
      st.rDwellEnd = r;
      if (!next) return;
      var rest = gap - dwell;
      r += moving
        ? Math.min(Math.max(rest * REPLAY_SEC_PER_MIN, REPLAY_MOVE_MIN_SEC), REPLAY_MOVE_CAP_SEC)
        : Math.min(rest * REPLAY_SEC_PER_MIN, REPLAY_IDLE_CAP_SEC);
    });
    legs.forEach(function (l) {
      l.r0 = s[l.to - 1].rDwellEnd;
      l.r1 = s[l.to].r;
    });
    return { stops: s, legs: legs, keyframes: kf, totalReal: r , baseOffset: baseOffset };
  }

  function replayRealToTrip(kf, r) {
    if (r <= kf[0].r) return kf[0].t;
    for (var j = 0; j < kf.length - 1; j++) {
      var a = kf[j], b = kf[j + 1];
      if (r <= b.r) {
        var span = b.r - a.r;
        return span > 0 ? a.t + (b.t - a.t) * (r - a.r) / span : b.t;
      }
    }
    return kf[kf.length - 1].t;
  }

  // 再生開始からr秒の時点の状態：時計（何日目・何時何分）、吹き出しを出す地点、移動中のアイコンの位置、
  // いま地図上でいる場所（here：カメラを合わせる位置）。
  // ---- 道のり（実際の道路に沿ったルート。docs/adr/0008）----
  // 移動手段ごとに、どのルート検索を使うか。電車は線路のルートを出せる無料サービスが無いので直線、
  // 飛行機は弧（どちらも''＝ルート検索しない）。
  function routeProfileFor(transport) {
    if (transport === 'car' || transport === 'taxi' || transport === 'bus') return 'car';
    if (transport === 'walk') return 'foot';
    if (transport === 'bicycle') return 'bike';
    return '';
  }

  // 道のり（[[緯度,経度], ...]）の、出発からの割合fの位置と、そこまでの折れ線。
  // 距離は短い区間なので緯度で経度を補正した平面近似で十分（見た目の進み方を均一にするためだけ）。
  function pathAt(path, f) {
    if (!path._cum) {
      var cum = [0];
      for (var i = 1; i < path.length; i++) {
        var dy = path[i][0] - path[i - 1][0];
        var dx = (path[i][1] - path[i - 1][1]) * Math.cos(path[i][0] * Math.PI / 180);
        cum.push(cum[i - 1] + Math.sqrt(dx * dx + dy * dy));
      }
      path._cum = cum;
    }
    var c = path._cum, total = c[c.length - 1];
    f = Math.max(0, Math.min(1, f));
    if (!total) return { point: { lat: path[0][0], lng: path[0][1] }, prefix: [path[0]] };
    var target = total * f, k = 1;
    while (k < c.length - 1 && c[k] < target) k++;
    var seg = c[k] - c[k - 1], t = seg ? (target - c[k - 1]) / seg : 0;
    var lat = path[k - 1][0] + (path[k][0] - path[k - 1][0]) * t;
    var lng = path[k - 1][1] + (path[k][1] - path[k - 1][1]) * t;
    return { point: { lat: lat, lng: lng }, prefix: path.slice(0, k).concat([[lat, lng]]) };
  }

  // 「この日から見たい」ためのジャンプ先。日ごとの最初の予定の少し前（再生の実時間r）。
  // 何日目かは予定の現地の日付（dayNumber）で数える。
  var REPLAY_JUMP_LEAD_SEC = 0.4;
  function replayDayStarts(tl) {
    var out = [];
    (tl.stops || []).forEach(function (s) {
      if (out.length && out[out.length - 1].dayNumber === s.dayNumber) return;
      if (out.some(function (d) { return d.dayNumber === s.dayNumber; })) return;
      out.push({ dayNumber: s.dayNumber, date: s.date, r: Math.max(0, s.r - REPLAY_JUMP_LEAD_SEC) });
    });
    if (out.length) out[0].r = 0; // 1日目は最初から
    return out;
  }

  // 前・次の予定へのジャンプ先。今のrより前（少し余裕を見る）／後で、いちばん近い予定の到着の少し前
  function replayNeighborStop(tl, r, dir) {
    var list = (tl.stops || []).map(function (s) { return Math.max(0, s.r - REPLAY_JUMP_LEAD_SEC); });
    if (dir < 0) {
      var prev = list.filter(function (x) { return x < r - 0.5; });
      return prev.length ? prev[prev.length - 1] : 0;
    }
    var next = list.filter(function (x) { return x > r + 0.05; });
    return next.length ? next[0] : tl.totalReal;
  }

  function replayStateAt(tl, r) {
    r = Math.max(0, Math.min(r, tl.totalReal));
    var t = replayRealToTrip(tl.keyframes, r);
    var s = tl.stops;
    var idx = -1;
    for (var i = 0; i < s.length; i++) { if (s[i].r <= r + 1e-9) idx = i; }
    var captionIndex = idx >= 0 && r <= s[idx].rDwellEnd + 1e-9 ? idx : -1;

    var icon = null;
    for (var k = 0; k < tl.legs.length; k++) {
      var l = tl.legs[k];
      if (r >= l.r0 && r <= l.r1) {
        var f = l.r1 > l.r0 ? (r - l.r0) / (l.r1 - l.r0) : 1;
        var arc = l.transport === 'plane';
        var pos, ahead;
        if (l.path && l.path.length > 1) {
          // 道のりが分かっている移動は、道路に沿って進む
          pos = pathAt(l.path, f).point;
          ahead = pathAt(l.path, Math.min(1, f + 0.02)).point;
        } else {
          pos = arcLatLng(s[l.from], s[l.to], f, arc);
          ahead = arcLatLng(s[l.from], s[l.to], Math.min(1, f + 0.02), arc);
        }
        icon = { lat: pos.lat, lng: pos.lng, transport: l.transport, bearing: f < 1 ? bearingDeg(pos, ahead) : bearingDeg(s[l.from], s[l.to]), legIndex: k };
        break;
      }
    }
    var here = icon ? { lat: icon.lat, lng: icon.lng } : null;
    if (!here) {
      for (var j = Math.max(idx, 0); j >= 0; j--) { if (s[j].located) { here = { lat: s[j].lat, lng: s[j].lng }; break; } }
    }
    if (!here) {
      for (var n = 0; n < s.length; n++) { if (s[n].located) { here = { lat: s[n].lat, lng: s[n].lng }; break; } }
    }
    // 時計は今いる場所（最後に着いた予定。移動中は出発地）の現地時間で出す
    var cur = idx >= 0 ? s[idx] : s[0];
    var offsetDiff = cur && typeof cur.offset === 'number' ? cur.offset - (tl.baseOffset || 0) : 0;
    var localT = t + offsetDiff;
    var localDay = Math.floor(localT / 1440);
    return {
      t: t, dayNumber: localDay + 1, hhmm: minuteToHHMM(localT - localDay * 1440),
      stopIndex: idx, captionIndex: captionIndex, icon: icon, here: here, offsetDiff: offsetDiff
    };
  }

  // ---------- 紹介文（ホテログ・レクログ・飯ログ。docs/adr/0007） ----------
  // 旅の紹介動画（「5泊7日の総額公開」のような投稿）の文字の部分を、記録から作る。
  // 評価（★）に添える人ごとのレビュー項目と、移動の記録の情報（travel）を使う。
  // 予定の種類でログの種類が決まる：宿泊→ホテログ、食事→飯ログ、観光・その他→レクログ、移動→移動（★なし）。
  var REVIEW_PUBLIC_MIN = 3.0; // これ未満（3.0ちょうどは出す）の評価は紹介文に出さない
  var REVIEW_GRADES = ['◎', '〇', '△', '×'];
  var REVIEW_KINDS = {
    hotel: {
      label: 'ホテログ', emoji: '🏨', unit: '泊',
      levels: ['絶対また泊まりたい', 'また泊まりたい', 'また泊まってもいい', '機会があれば泊まる', 'もう泊まらない'],
      grades: [['price', '価格'], ['location', '立地'], ['value', '価格見合い'], ['hospitality', 'ホスピタリティ'], ['amenity', 'アメニティ'], ['cleanliness', '清潔さ'], ['breakfast', '朝食']],
      texts: [['roomType', '部屋タイプ']]
    },
    activity: {
      label: 'レクログ', emoji: '🎡', unit: '回',
      levels: ['2回目もまた行きたい', '初めてなら絶対行くべき', '初めてなら行くべき', '時間があれば行く', '行かなくてもいいかな'],
      grades: [['price', '価格'], ['location', '立地'], ['value', '価格見合い'], ['hospitality', 'ホスピタリティ']],
      choices: [['crowd', '混雑'], ['reservation', '予約']],
      texts: [['duration', '所要時間'], ['bestTime', 'おすすめの時間帯']]
    },
    food: {
      label: '飯ログ', emoji: '🍴', unit: '人',
      levels: ['絶対また行きたい', 'また行きたい', '近くに来たらまた行きたい', '機会があれば行く', 'もう行かなくてもいいかな'],
      grades: [['taste', '美味しさ'], ['price', '価格'], ['location', '立地'], ['value', '価格見合い'], ['hospitality', 'ホスピタリティ']],
      choices: [['reservation', '予約']],
      texts: [['menu', 'おすすめメニュー']]
    }
  };
  var REVIEW_CHOICE_OPTIONS = { reservation: ['不要', '推奨', '必須'], crowd: ['空いている', '普通', '混んでいる'] };

  function reviewKindForCategory(category) {
    if (category === 'lodging') return 'hotel';
    if (category === 'food') return 'food';
    if (category === 'transport') return '';
    return 'activity';
  }

  // ★の数値を、その種類の言葉にする（4.5以上／4.0以上／3.5以上／3.0以上／それ未満）
  function reviewLevelLabel(kind, score) {
    var k = REVIEW_KINDS[kind];
    if (!k || !(score > 0)) return '';
    var s = Math.round(score * 10) / 10;
    if (s >= 4.5) return k.levels[0];
    if (s >= 4.0) return k.levels[1];
    if (s >= 3.5) return k.levels[2];
    if (s >= REVIEW_PUBLIC_MIN) return k.levels[3];
    return k.levels[4];
  }

  function isReviewPublic(score) {
    return Math.round(score * 10) / 10 >= REVIEW_PUBLIC_MIN;
  }

  // 出発・到着（どちらも現地時間のHH:MM）から、所要時間（分）と、到着が出発の何日後か（現地の日付で）。
  // 出発地・到着地の時差（分）が分かれば時差を考える（日本20:00発→ロンドン翌04:00着＝14時間）。
  // 到着が出発より前（に見える）なら日をまたいだとみなす。
  function travelDuration(depart, arrive, depOffset, arrOffset) {
    var d = /^(\d{1,2}):(\d{2})$/.exec(depart || ''), a = /^(\d{1,2}):(\d{2})$/.exec(arrive || '');
    if (!d || !a) return null;
    var dm = Number(d[1]) * 60 + Number(d[2]), am = Number(a[1]) * 60 + Number(a[2]);
    var shift = typeof depOffset === 'number' && typeof arrOffset === 'number' ? arrOffset - depOffset : 0;
    var min = (am - shift) - dm;
    while (min <= 0) min += 1440;
    return { minutes: min, dayShift: Math.floor((dm + min + shift) / 1440) };
  }

  function travelDurationText(depart, arrive, depOffset, arrOffset) {
    var r = travelDuration(depart, arrive, depOffset, arrOffset);
    if (!r) return '';
    var h = Math.floor(r.minutes / 60), m = r.minutes % 60;
    return (h ? h + '時間' : '') + (m ? m + '分' : '');
  }

  // 分を「14時間」「1時間30分」「45分」にする
  function minutesText(min) {
    var h = Math.floor(min / 60), m = min % 60;
    return (h ? h + '時間' : '') + (m ? m + '分' : '') || '0分';
  }

  function dayShiftPrefix(n) {
    return n === 1 ? '翌' : n === 2 ? '翌々日' : n > 2 ? n + '日後' : n === -1 ? '前日' : '';
  }

  function findMyRating(ratings, email) {
    if (!email) return null;
    return (ratings || []).filter(function (r) { return (r.raterEmail || '').toLowerCase() === email.toLowerCase(); })[0] || null;
  }

  function yen(n) { return Number(n).toLocaleString('ja-JP') + '円'; }

  // 1件分のログ（ホテログなど）の文章。表示しないもの（評価なし・3.0未満）は''。
  function reviewLogText(block, entry, rating) {
    var kind = reviewKindForCategory(block.category);
    var k = REVIEW_KINDS[kind];
    if (!k || !rating || !(rating.score > 0) || !isReviewPublic(rating.score)) return '';
    var r = rating.review || {};
    var lines = [k.emoji + ' ' + k.label + ' ⭐' + (Math.round(rating.score * 10) / 10).toFixed(1), block.label || '（名前なし）'];
    var amount = typeof r.amount === 'number' ? r.amount : entryCostTotal(entry);
    k.grades.forEach(function (g) {
      var key = g[0], name = g[1];
      var grade = r[key] || '';
      var extra = '';
      if (key === 'price' && amount > 0) {
        var units = r.units > 1 ? r.units : 0;
        extra = units ? '1' + k.unit + 'あたり' + yen(Math.round(amount / units)) + '／' + units + k.unit + '合計' + yen(amount) : yen(amount);
      }
      if (key === 'location' && r.access) extra = r.access;
      if (!grade && !extra) return;
      lines.push(name + '：' + (grade || '') + (extra ? (grade ? '（' + extra + '）' : extra) : ''));
    });
    (k.choices || []).forEach(function (c) { if (r[c[0]]) lines.push(c[1] + '：' + r[c[0]]); });
    (k.texts || []).forEach(function (t) { if (r[t[0]]) lines.push(t[1] + '：' + r[t[0]]); });
    if (kind === 'food') {
      var menu = (entry.costItems || []).filter(function (it) { return it.label && typeof it.amount === 'number'; })
        .map(function (it) { return it.label + ' ' + yen(it.amount); });
      if (menu.length) lines.push('メニュー：' + menu.join('／'));
      if (entry.waitTime) lines.push('待ち時間：' + entry.waitTime);
    }
    if (r.other) lines.push('その他：' + r.other);
    lines.push('→ ' + reviewLevelLabel(kind, rating.score));
    return lines.join('\n');
  }

  // 移動の記録の文章（★なし）。区間も会社も時刻も金額も無ければ''。
  function travelLogText(block, entry, arrOffset) {
    var t = entry.travel || {};
    var mode = transportLabel(block.transport);
    var amount = typeof t.amount === 'number' ? t.amount : entryCostTotal(entry);
    var route = t.from || t.to ? (t.from || '') + '→' + (t.to || '') : '';
    if (!route && !t.company && !t.depart && !t.arrive && !amount && !block.moveMinutes) return '';
    var emoji = { plane: '✈️', car: '🚗', taxi: '🚕', train: '🚃', bus: '🚌', walk: '🚶', bicycle: '🚲' }[block.transport] || '🚃';
    var lines = [emoji + ' 移動' + (mode ? '｜' + mode : ''), route || block.label || ''];
    if (t.company) lines.push('会社：' + t.company);
    if (t.depart || t.arrive) {
      var info = travelDuration(t.depart, t.arrive, block._offset, arrOffset);
      var dur = travelDurationText(t.depart, t.arrive, block._offset, arrOffset);
      var zoneNote = typeof block._offset === 'number' && typeof arrOffset === 'number' && arrOffset !== block._offset
        ? '・時差' + offsetDiffText(arrOffset - block._offset) : '';
      lines.push((t.depart ? t.depart + '発' : '') + (t.depart && t.arrive ? ' → ' : '') +
        (t.arrive ? (info ? dayShiftPrefix(info.dayShift) : '') + t.arrive + '着' : '') + (dur ? '（' + dur + zoneNote + '）' : ''));
    }
    if (!t.depart && !t.arrive && block.moveMinutes) lines.push('所要時間：約' + minutesText(block.moveMinutes));
    if (amount > 0) lines.push('料金：' + yen(amount));
    return lines.join('\n');
  }

  function transportLabel(key) {
    var t = TRANSPORTS.filter(function (x) { return x.key === key; })[0];
    return t && t.key ? t.label : '';
  }

  // 費用を「移動・ホテル・食事と観光」に分けて合計する（紹介文の最後の「総額公開」用）
  function tripCostByGroup(blocks) {
    var out = { transport: 0, lodging: 0, other: 0 };
    (blocks || []).forEach(function (b) {
      var group = b.category === 'transport' ? 'transport' : b.category === 'lodging' ? 'lodging' : 'other';
      (b.entries || []).forEach(function (e) {
        var cost = entryCostTotal(e);
        if (!cost && e.travel && typeof e.travel.amount === 'number') cost = e.travel.amount;
        out[group] += cost;
      });
    });
    return out;
  }

  // 旅行の行き先（天気のために入れた「日ごとの場所」の国・都道府県）。海外があれば国、国内だけなら都道府県。
  function tripPlaceNames(days) {
    var countries = [], prefs = [];
    (days || []).forEach(function (d) {
      if (d.country && countries.indexOf(d.country) === -1) countries.push(d.country);
      if (d.country === '日本' && d.admin1 && prefs.indexOf(d.admin1) === -1) prefs.push(d.admin1);
    });
    var abroad = countries.filter(function (c) { return c !== '日本'; });
    return abroad.length ? countries : prefs;
  }

  // 紹介文の全体：表紙 → 評価の基準 → 時系列のログ → 総額。自分（email）の評価だけを使う。
  function buildTripPostText(trip, blocks, days, email) {
    var parts = [];
    var head = ['【' + (trip.title || '旅の記録') + '】'];
    var start = parseDate(trip.startDate), end = parseDate(trip.endDate);
    if (start) {
      var range = start.getFullYear() + ' ' + (start.getMonth() + 1) + '/' + start.getDate() +
        (end && trip.endDate !== trip.startDate ? '〜' + (end.getMonth() + 1) + '/' + end.getDate() : '');
      head.push(range + (tripNights(trip) ? '（' + tripNights(trip) + '）' : ''));
    }
    var places = tripPlaceNames(days);
    head.push((places.length ? places.join('・') + ' ' : '') + (tripNights(trip) || '旅') + 'の総額公開！');
    parts.push(head.join('\n'));

    var logs = [], usedKinds = [];
    var sortedForPost = sortBlocks(blocks);
    sortedForPost.forEach(function (b, bi) {
      (b.entries || []).forEach(function (e) {
        var text = '';
        var nextBlock = sortedForPost[bi + 1];
        if (b.category === 'transport') text = travelLogText(b, e, nextBlock ? nextBlock._offset : undefined);
        else {
          text = reviewLogText(b, e, findMyRating(e.ratings, email));
          var kind = reviewKindForCategory(b.category);
          if (text && usedKinds.indexOf(kind) === -1) usedKinds.push(kind);
        }
        if (text) logs.push(text);
      });
    });
    if (usedKinds.length) {
      parts.push('＼評価の基準／\n' + usedKinds.map(function (kind) {
        var k = REVIEW_KINDS[kind];
        return k.label + '：4.5〜 ' + k.levels[0] + '／4.0〜 ' + k.levels[1] + '／3.5〜 ' + k.levels[2] + '／3.0〜 ' + k.levels[3];
      }).join('\n'));
    }
    parts = parts.concat(logs);

    var cost = tripCostByGroup(blocks);
    var total = cost.transport + cost.lodging + cost.other;
    if (total > 0) {
      var lines = ['💰 合計金額は' + yen(total)];
      if (cost.transport) lines.push('移動 ' + yen(cost.transport));
      if (cost.lodging) lines.push('ホテル ' + yen(cost.lodging));
      if (cost.other) lines.push('食事と観光 ' + yen(cost.other));
      parts.push(lines.join('\n'));
    }
    parts.push('#旅の足跡');
    return parts.join('\n\n');
  }

  // ---------- メモをAIなしで分ける（無料・回数を使わない。2026-09-26〜） ----------
  // 決まった形のメモなら、AIに頼らずアプリ側で予定と記録に分ける。形は：
  //   ・時刻で始まる行（10:00 / 10時 / 10時半 / 10時30分、全角でも可）→ 予定。時刻のあとが見出し
  //   ・その下の行 → その予定の記録（1行ずつ改行でつなぐ）
  //   ・「1日目」「4/1」「4月1日」だけの行 → それ以降の予定の日付
  //   ・予定の行にGoogleマップなどのURLがあれば、その記録の地図にする
  // 1行に「10時 那覇空港／12時 沖縄そば」のように並んでいても分ける。最初の予定より前に文章があるときは
  // 決まった形ではない（ok=false）として、AIでの整理をすすめる。
  var MEMO_TIME_RE = /^(\d{1,2})(?::(\d{2})|時(?:(\d{1,2})分|(半))?)\s*[〜~\-ー]?\s*(.*)$/;
  var MEMO_TIME_SPLIT_RE = /(?:[／\/]|\s+)(?=\d{1,2}(?::\d{2}|時))/g; // 全角の／は正規化で/になる

  function memoDayHeader(line, tripDates) {
    var m = /^(\d{1,2})日目$/.exec(line);
    if (m) return tripDates[Number(m[1]) - 1] || null;
    m = /^(?:(\d{4})[-\/年])?(\d{1,2})[\/月](\d{1,2})日?(?:\s*[(（][^)）]*[)）])?$/.exec(line);
    if (!m) return null;
    var md = String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
    return tripDates.filter(function (d) { return d.slice(5) === md && (!m[1] || d.slice(0, 4) === m[1]); })[0] || null;
  }

  function guessMemoCategory(label) {
    if (/ホテル|旅館|宿|チェックイン|チェックアウト|泊/.test(label)) return 'lodging';
    if (/ランチ|昼食|夕食|朝食|朝ごはん|昼ごはん|夜ごはん|ご飯|ごはん|ディナー|カフェ|そば|ラーメン|寿司|すし|焼肉|居酒屋|レストラン|食べ|飲み/.test(label)) return 'food';
    if (/移動|新幹線|飛行機|フライト|便|バス|電車|タクシー|レンタカー|ドライブ/.test(label) || /へ$/.test(label)) return 'transport';
    return 'sightseeing';
  }

  function parseMemo(text, tripDates, defaultDate) {
    tripDates = tripDates || [];
    var normalized = String(text || '').normalize('NFKC').replace(/\r\n?/g, '\n');
    var lines = [];
    normalized.split('\n').forEach(function (line) {
      line.replace(MEMO_TIME_SPLIT_RE, '\n').split('\n').forEach(function (l) { lines.push(l.trim()); });
    });
    var blocks = [], cur = null, curDate = defaultDate || tripDates[0] || '', preamble = 0;
    lines.forEach(function (line) {
      if (!line) return;
      var day = memoDayHeader(line, tripDates);
      if (day) { curDate = day; cur = null; return; }
      var m = MEMO_TIME_RE.exec(line);
      var h = m ? Number(m[1]) : -1, min = m ? Number(m[2] || m[3] || (m[4] ? 30 : 0)) : -1;
      if (m && h <= 23 && min <= 59) {
        var rest = m[5] || '';
        var url = (/https?:\/\/\S+/.exec(rest) || [''])[0];
        var label = rest.replace(url, '').replace(/^[にからで、,：:\s]+/, '').trim();
        cur = { date: curDate, time: String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0'), label: label || '予定', mapUrl: url, lines: [] };
        blocks.push(cur);
        return;
      }
      if (cur) cur.lines.push(line.replace(/^[・\-*●○]\s*/, ''));
      else preamble++;
    });
    return {
      ok: blocks.length > 0 && preamble === 0,
      blocks: blocks.map(function (b) {
        return { date: b.date, time: b.time, label: b.label, category: guessMemoCategory(b.label), entry: { episode: b.lines.join('\n'), mapUrl: b.mapUrl } };
      })
    };
  }

  var Core = {
    CATEGORIES: CATEGORIES,
    TRANSPORTS: TRANSPORTS,
    categoryLabel: categoryLabel,
    categoryColor: categoryColor,
    formatYen: formatYen,
    parseDate: parseDate,
    dateDiffDays: dateDiffDays,
    formatDateJp: formatDateJp,
    dayLabel: dayLabel,
    tripNights: tripNights,
    allDatesForTrip: allDatesForTrip,
    sortBlocks: sortBlocks,
    groupBlocksByDate: groupBlocksByDate,
    entryCostTotal: entryCostTotal,
    blockCostTotal: blockCostTotal,
    tripTotalCost: tripTotalCost,
    tripBalances: tripBalances,
    settlementPlan: settlementPlan,
    tripExpenseList: tripExpenseList,
    primaryLodgingName: primaryLodgingName,
    lodgingByNight: lodgingByNight,
    costBreakdownByPerson: costBreakdownByPerson,
    parseTags: parseTags,
    getTripIdFromSearch: getTripIdFromSearch,
    buildShareUrl: buildShareUrl,
    upsertTripIndexEntry: upsertTripIndexEntry,
    removeTripIndexEntry: removeTripIndexEntry,
    filterTrips: filterTrips,
    sortTrips: sortTrips,
    tripFilterOptions: tripFilterOptions,
    ratingSummary: ratingSummary,
    myRatingScore: myRatingScore,
    sortMyLogItems: sortMyLogItems,
    weatherLabel: weatherLabel,
    replayPlaceQuery: replayPlaceQuery,
    replayStops: replayStops,
    buildReplayTimeline: buildReplayTimeline,
    replayStateAt: replayStateAt,
    arcLatLng: arcLatLng,
    routeProfileFor: routeProfileFor,
    parseMemo: parseMemo,
    transportLabel: transportLabel,
    minutesText: minutesText,
    replayDayStarts: replayDayStarts,
    replayNeighborStop: replayNeighborStop,
    tzOffsetMinutes: tzOffsetMinutes,
    assignBlockZones: assignBlockZones,
    applyBlockZones: applyBlockZones,
    offsetDiffText: offsetDiffText,
    travelDuration: travelDuration,
    dayShiftPrefix: dayShiftPrefix,
    pathAt: pathAt,
    REVIEW_KINDS: REVIEW_KINDS,
    REVIEW_GRADES: REVIEW_GRADES,
    REVIEW_CHOICE_OPTIONS: REVIEW_CHOICE_OPTIONS,
    reviewKindForCategory: reviewKindForCategory,
    reviewLevelLabel: reviewLevelLabel,
    isReviewPublic: isReviewPublic,
    travelDurationText: travelDurationText,
    findMyRating: findMyRating,
    reviewLogText: reviewLogText,
    travelLogText: travelLogText,
    tripCostByGroup: tripCostByGroup,
    tripPlaceNames: tripPlaceNames,
    buildTripPostText: buildTripPostText
  };

  root.TabiLog = Core;

  // ==========================================================
  // ここから下はブラウザでの画面操作。node からの require では走らない。
  // ==========================================================
  if (typeof document === 'undefined') return;

  var API_BASE = (function () {
    var meta = document.querySelector('meta[name="tabilog-api-endpoint"]');
    var v = meta ? meta.getAttribute('content').trim() : '';
    return v.replace(/\/$/, '');
  })();
  var GOOGLE_CLIENT_ID = (function () {
    var meta = document.querySelector('meta[name="tabilog-google-client-id"]');
    return meta ? meta.getAttribute('content').trim() : '';
  })();
  var APPLE_CLIENT_ID = (function () {
    var meta = document.querySelector('meta[name="tabilog-apple-client-id"]');
    return meta ? meta.getAttribute('content').trim() : '';
  })();
  var MY_TRIPS_KEY = 'tabilog:my-trips';
  var HIDDEN_TRIPS_KEY = 'tabilog:hidden-trips';
  var CURRENT_USER_KEY = 'tabilog:user';

  function $(sel, root2) { return (root2 || document).querySelector(sel); }
  function $all(sel, root2) { return Array.prototype.slice.call((root2 || document).querySelectorAll(sel)); }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 画面ごとのスクロール位置。記録・予定の編集から旅行の画面に戻ったとき、毎回いちばん上に戻ってしまい
  // 編集していた記録を探し直す必要があったため、旅行の画面だけは離れたときの位置に戻す。
  // 別の旅行を開いたとき（openTrip）はいちばん上から。
  var screenScroll = {};
  function showScreen(name) {
    var leaving = $('.screen.active');
    if (leaving && leaving.dataset.screen !== name) screenScroll[leaving.dataset.screen] = window.scrollY;
    $all('.screen').forEach(function (s) { s.classList.toggle('active', s.dataset.screen === name); });
    var y = name === 'tripDetail' ? (screenScroll.tripDetail || 0) : 0;
    window.scrollTo(0, y);
    // 呼び出し元がこのあと画面を描き直すので、描き終わった後にもう一度合わせる
    if (y) setTimeout(function () { if ($('.screen.active') && $('.screen.active').dataset.screen === name) window.scrollTo(0, y); }, 0);
  }

  // ---------- Googleログイン ----------
  // クライアント側だけで完結する簡易的な仕組み（サーバー側でのトークン検証はしていない）。
  // 家族・少人数での利用を想定しており、「誰が記録したか」を自動で埋めるための本人確認として使う。
  function decodeJwtPayload(token) {
    try {
      var base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(base64))));
    } catch (e) { return null; }
  }

  function loadCurrentUser() {
    try { return JSON.parse(localStorage.getItem(CURRENT_USER_KEY) || 'null'); } catch (e) { return null; }
  }
  function saveCurrentUser(u) { localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(u)); }
  function clearCurrentUser() { localStorage.removeItem(CURRENT_USER_KEY); }

  // メールでのログイン（送信確認なしの簡易な本人確認）は常に使えるため、ログイン機能自体は常に有効。
  // Google/Appleのボタンは各クライアントIDを設定したときだけ追加で出る。
  function loginEnabled() { return true; }

  function renderAccountRow() {
    var row = $('#accountRow');
    var promptRow = $('#loginPromptRow');
    var user = loadCurrentUser();
    if (!loginEnabled()) { row.hidden = true; promptRow.hidden = true; return; }
    if (user) {
      row.hidden = false;
      promptRow.hidden = true;
      $('#accountName').textContent = user.name || user.email || '';
    } else {
      row.hidden = true;
      promptRow.hidden = false;
    }
  }

  function findEntryById(id) {
    for (var i = 0; i < state.blocks.length; i++) {
      var entries = state.blocks[i].entries || [];
      for (var j = 0; j < entries.length; j++) {
        if (entries[j].id === id) return entries[j];
      }
    }
    return null;
  }

  function loadMyTrips() {
    try { return JSON.parse(localStorage.getItem(MY_TRIPS_KEY) || '[]'); } catch (e) { return []; }
  }
  function rememberTrip(trip) {
    var list = Core.upsertTripIndexEntry(loadMyTrips(), {
      id: trip.id, title: trip.title, startDate: trip.startDate, endDate: trip.endDate, companions: trip.companions,
      tripType: trip.tripType || '', coverPhotoId: trip.coverPhotoId || ''
    });
    localStorage.setItem(MY_TRIPS_KEY, JSON.stringify(list));
    var hidden = loadHiddenTripIds();
    if (hidden.indexOf(trip.id) !== -1) saveHiddenTripIds(hidden.filter(function (h) { return h !== trip.id; }));
  }
  function forgetTrip(id) {
    localStorage.setItem(MY_TRIPS_KEY, JSON.stringify(Core.removeTripIndexEntry(loadMyTrips(), id)));
  }

  // 利用者が自分で「履歴から消した」旅行のID。ログイン中はsyncAccountTripsIntoHomeが
  // 参加済みの旅行を索引へ自動で足し直すため、ここに載っているものは足し直さない。
  // その旅行をURLなどから再び開いたとき（rememberTrip）に一覧へ戻す。
  function loadHiddenTripIds() {
    try { return JSON.parse(localStorage.getItem(HIDDEN_TRIPS_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveHiddenTripIds(ids) {
    localStorage.setItem(HIDDEN_TRIPS_KEY, JSON.stringify(ids));
  }
  function hideTripFromHistory() {
    if (!state.trip) return;
    if (!confirm('この旅行をホームの一覧（この端末の履歴）から消しますか？\n（旅行そのもの・サーバー上のデータは削除されません。共有URLを開けば、また一覧に戻ります）')) return;
    var id = state.trip.id;
    forgetTrip(id);
    var hidden = loadHiddenTripIds().filter(function (h) { return h !== id; });
    hidden.push(id);
    saveHiddenTripIds(hidden);
    goHome();
  }
  // 「この端末の旅行の履歴を削除」。tabilog:my-tripsはログイン状態と無関係の端末ローカルな
  // 索引（ログアウトしても消えない）なので、別アカウントに切り替えて試すときなどに前の
  // 旅行が残り続けて紛らわしい、という声を受けて追加した手動クリア機能。サーバー上の旅行
  // データ自体は削除しない（あくまでこの端末の「開いたことのある旅行」一覧が空になるだけ）。
  function clearTripHistory() {
    if (!confirm('この端末に保存されている「旅行の履歴」を削除しますか？\n（旅行そのもの・サーバー上のデータは削除されません。URLを知っていれば引き続き開けます）')) return;
    localStorage.removeItem(MY_TRIPS_KEY);
    renderHomeTripList();
  }

  function photoUrl(id) {
    if (!id) return '';
    return API_BASE + '/photos/' + id;
  }

  // ---------- 写真・動画のビューア（LINEのような見方） ----------
  // 記録の写真と動画（またはアルバム全体）を1つの並びで開き、左右スワイプで前後へ（指に付いて動く）、
  // 下（上）へスワイプで閉じる、タップでボタンを出し入れする。開いているあいだは後ろのページが
  // 動かないようにする（以前は写真を開いたまま上下に動かすと、後ろのスケジュールがスクロールしていた）。
  // 以前は写真と動画が別々の拡大表示で、写真から動画へスワイプで移れなかった。
  // items：[{ type: 'photo' | 'video', id }]
  var viewer = { items: [], index: 0 };

  function openMediaViewer(items, index) {
    viewer.items = items || [];
    viewer.index = Math.max(0, Math.min(index || 0, viewer.items.length - 1));
    $('#mvTrack').innerHTML = viewer.items.map(function (it, i) {
      var url = escapeHtml(photoUrl(it.id));
      return '<div class="mv-slide" data-i="' + i + '">' + (it.type === 'video'
        ? '<video data-src="' + url + '" controls playsinline preload="none"></video>'
        : '<img data-src="' + url + '" alt="" draggable="false">') + '</div>';
    }).join('');
    var el = $('#photoLightbox');
    el.classList.remove('mv-chrome-hidden');
    el.style.backgroundColor = '';
    el.hidden = false;
    document.body.classList.add('viewer-open');
    goToMedia(viewer.index, false);
  }

  function mediaSlide(i) { return $('#mvTrack').querySelector('.mv-slide[data-i="' + i + '"]'); }

  // 今の前後1枚だけ読み込む（アルバム全体を開いても、見る分しか通信しない）
  function loadNearbyMedia() {
    for (var i = viewer.index - 1; i <= viewer.index + 1; i++) {
      var slide = mediaSlide(i);
      var media = slide && slide.querySelector('[data-src]');
      if (media && !media.getAttribute('src')) media.setAttribute('src', media.dataset.src);
    }
  }

  function goToMedia(i, animate) {
    i = Math.max(0, Math.min(i, viewer.items.length - 1));
    $all('#mvTrack video').forEach(function (v, k) { if (!v.paused) v.pause(); });
    viewer.index = i;
    var track = $('#mvTrack');
    track.style.transition = animate ? 'transform 0.25s ease' : 'none';
    track.style.transform = 'translateX(' + (-i * 100) + '%)';
    var cur = mediaSlide(i);
    if (cur) { cur.style.transition = animate ? 'transform 0.2s ease' : 'none'; cur.style.transform = ''; }
    $('#photoLightbox').style.backgroundColor = '';
    loadNearbyMedia();
    var multi = viewer.items.length > 1;
    $('#lightboxPrev').hidden = !multi || i === 0;
    $('#lightboxNext').hidden = !multi || i === viewer.items.length - 1;
    $('#lightboxCount').hidden = !multi;
    $('#lightboxCount').textContent = (i + 1) + ' / ' + viewer.items.length;
  }

  function closeMediaViewer() {
    $all('#mvTrack video').forEach(function (v) { v.pause(); });
    var el = $('#photoLightbox');
    el.hidden = true;
    el.style.backgroundColor = '';
    $('#mvTrack').innerHTML = '';
    $('#mvTrack').style.transform = '';
    document.body.classList.remove('viewer-open');
    viewer = { items: [], index: 0 };
  }

  // 指（マウス）の動きで、左右なら前後の写真へ、上下なら閉じる。最初に大きく動いた向きで決める。
  // 動画の再生バー（下の方）から始めた操作は、動画の操作に任せる。
  function initMediaViewerGestures() {
    var el = $('#photoLightbox'), track = $('#mvTrack'), g = null;
    el.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return;
      var v = e.target.closest('video');
      if (v && e.clientY > v.getBoundingClientRect().bottom - 64) return;
      g = { x: e.clientX, y: e.clientY, t: Date.now(), dir: null, dx: 0, dy: 0, onVideo: !!v };
    });
    el.addEventListener('pointermove', function (e) {
      if (!g) return;
      g.dx = e.clientX - g.x; g.dy = e.clientY - g.y;
      if (!g.dir && (Math.abs(g.dx) > 10 || Math.abs(g.dy) > 10)) g.dir = Math.abs(g.dx) > Math.abs(g.dy) ? 'h' : 'v';
      if (g.dir === 'h') {
        var last = viewer.items.length - 1;
        var dx = (viewer.index === 0 && g.dx > 0) || (viewer.index === last && g.dx < 0) ? g.dx / 3 : g.dx; // 端では重く
        track.style.transition = 'none';
        track.style.transform = 'translateX(calc(' + (-viewer.index * 100) + '% + ' + dx + 'px))';
      } else if (g.dir === 'v') {
        var slide = mediaSlide(viewer.index);
        var k = Math.min(Math.abs(g.dy) / 400, 0.9);
        if (slide) { slide.style.transition = 'none'; slide.style.transform = 'translateY(' + g.dy + 'px) scale(' + (1 - k * 0.15) + ')'; }
        el.style.backgroundColor = 'rgba(10, 12, 16, ' + (0.96 * (1 - k)) + ')';
      }
    });
    var end = function (cancel) {
      if (!g) return;
      var s = g; g = null;
      var fast = (Date.now() - s.t) < 250;
      if (cancel) { goToMedia(viewer.index, true); return; }
      if (s.dir === 'h') {
        var step = Math.abs(s.dx) > 60 || (fast && Math.abs(s.dx) > 25) ? (s.dx < 0 ? 1 : -1) : 0;
        goToMedia(viewer.index + step, true);
      } else if (s.dir === 'v') {
        if (Math.abs(s.dy) > 110 || (fast && Math.abs(s.dy) > 40)) {
          var slide = mediaSlide(viewer.index);
          if (slide) { slide.style.transition = 'transform 0.18s ease'; slide.style.transform = 'translateY(' + (s.dy > 0 ? '' : '-') + '100vh)'; }
          el.style.transition = 'background-color 0.18s ease';
          el.style.backgroundColor = 'rgba(10, 12, 16, 0)';
          setTimeout(function () { el.style.transition = ''; closeMediaViewer(); }, 180);
        } else {
          goToMedia(viewer.index, true);
        }
      } else if (!s.onVideo) {
        el.classList.toggle('mv-chrome-hidden'); // タップ：ボタンを隠す／出す
      }
    };
    el.addEventListener('pointerup', function () { end(false); });
    el.addEventListener('pointercancel', function () { end(true); });
    // 後ろのページが動かないように（iOSではoverflow: hiddenだけでは止まらないことがある）
    el.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
    document.addEventListener('keydown', function (e) {
      if (el.hidden) return;
      if (e.key === 'Escape') closeMediaViewer();
      else if (e.key === 'ArrowLeft') goToMedia(viewer.index - 1, true);
      else if (e.key === 'ArrowRight') goToMedia(viewer.index + 1, true);
    });
  }

  // 記録（Entry）の写真→動画の順の並び
  function entryMediaItems(entry) {
    return (entry.photoIds || []).map(function (id) { return { type: 'photo', id: id }; })
      .concat((entry.videoIds || []).map(function (id) { return { type: 'video', id: id }; }));
  }

  // 写真・動画の保存（アルバムから開いたライトボックスの「保存」ボタン、DAY30〜）。
  // Web Share API（ファイル共有）に対応していれば、iOSの共有シート経由で「画像/動画を保存」を
  // 出せるのでそちらを優先する。対応していない環境（主にPCブラウザ）ではオブジェクトURL＋
  // <a download>でのダウンロードにフォールバックする（cross-originのURLへ直接download属性を
  // 付けてもブラウザに無視されるため、一度fetchでblobとして取り込んでからdownloadする必要がある）。
  function downloadBlob(blob, filename) {
    var objectUrl = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 10000);
  }

  function saveMediaFromUrl(url, filename, btn) {
    if (!url) return;
    if (btn) btn.disabled = true;
    fetch(url).then(function (res) {
      if (!res.ok) throw new Error('fetch_failed');
      return res.blob();
    }).then(function (blob) {
      var file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        return navigator.share({ files: [file] }).catch(function (e) {
          if (e && e.name === 'AbortError') return; // 共有シートをキャンセルしただけなので何もしない
          downloadBlob(blob, filename);
        });
      }
      downloadBlob(blob, filename);
    }).catch(function () {
      alert('保存に失敗しました。もう一度お試しください。');
    }).then(function () {
      if (btn) btn.disabled = false;
    });
  }

  // ---------- アルバム（旅行全体の写真・動画をまとめて見る） ----------
  function openAlbum() {
    renderAlbum();
    showScreen('album');
  }

  function renderAlbum() {
    var items = [];
    (state.blocks || []).forEach(function (block) {
      (block.entries || []).forEach(function (entry) {
        (entry.photoIds || []).forEach(function (id) {
          items.push({ type: 'photo', id: id, date: block.date || '' });
        });
        (entry.videoIds || []).forEach(function (id) {
          items.push({ type: 'video', id: id, date: block.date || '' });
        });
      });
    });
    items.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });

    var grid = $('#albumGrid');
    $('#albumEmpty').hidden = items.length > 0;
    grid.innerHTML = items.map(function (it, idx) {
      var dateBadge = it.date ? '<span class="album-date">' + escapeHtml(it.date.slice(5).replace('-', '/')) + '</span>' : '';
      if (it.type === 'photo') {
        return '<div class="album-tile" data-index="' + idx + '" data-type="photo" data-id="' + escapeHtml(it.id) + '" style="background-image:url(\'' + escapeHtml(photoUrl(it.id)) + '\')">' + dateBadge + '</div>';
      }
      return '<div class="album-tile" data-index="' + idx + '" data-type="video" data-id="' + escapeHtml(it.id) + '">' +
        '<video src="' + escapeHtml(photoUrl(it.id)) + '#t=0.1" preload="metadata" muted playsinline></video>' +
        '<div class="album-play">' + ALBUM_PLAY_ICON + '</div>' + dateBadge +
        '</div>';
    }).join('');

    $all('.album-tile', grid).forEach(function (tile) {
      // アルバム全体を1つの並びで開き、スワイプで次々に見られるようにする
      tile.addEventListener('click', function () { openMediaViewer(items, Number(tile.dataset.index)); });
    });
  }

  // ---------- 精算（割り勘の貸し借り・精算方法） ----------
  function openSettlement() {
    renderSettlement();
    showScreen('settlement');
  }

  function renderSettlement() {
    var expenses = Core.tripExpenseList(state.blocks);
    var hasExpenses = expenses.length > 0;
    $('#settlementEmpty').hidden = hasExpenses;
    $('#settlementBody').hidden = !hasExpenses;
    if (!hasExpenses) return;

    var balance = Core.tripBalances(state.trip, state.blocks);
    var names = Object.keys(balance).filter(function (n) { return Math.round(balance[n]) !== 0; });
    // 貸し借りが無い（＝0円の）参加者も、参加していることが分かるよう一覧には残す
    (state.trip.companions || []).forEach(function (n) { if (names.indexOf(n) === -1) names.push(n); });

    $('#settlementBalances').innerHTML = names.map(function (name) {
      var yen = Math.round(balance[name] || 0);
      var cls = yen > 0 ? 'plus' : (yen < 0 ? 'minus' : '');
      var text = yen > 0 ? '+' + Core.formatYen(yen) + '（もらう）' : (yen < 0 ? '－' + Core.formatYen(-yen) + '（払う）' : '±¥0');
      return '<div class="balance-row ' + cls + '"><span class="name">' + escapeHtml(name) + '</span><span class="amount">' + escapeHtml(text) + '</span></div>';
    }).join('');

    var plan = Core.settlementPlan(balance);
    var planEl = $('#settlementPlanList');
    if (!plan.length) {
      planEl.innerHTML = '<p class="empty">貸し借りはありません。</p>';
    } else {
      planEl.innerHTML = plan.map(function (p) {
        return '<div class="settle-plan-row"><span class="from">' + escapeHtml(p.from) + '</span>' + SETTLE_ARROW_ICON
          + '<span class="to">' + escapeHtml(p.to) + '</span><span class="amount">' + escapeHtml(Core.formatYen(p.amount)) + '</span></div>';
      }).join('');
    }

    $('#settlementExpenses').innerHTML = expenses.map(function (e) {
      var splitText = e.splitAmong.length > 1 ? e.splitAmong.join('・') + 'で割り勘' : e.paidBy + 'の分';
      var dateText = e.date ? e.date.slice(5).replace('-', '/') : '';
      return '<div class="expense-row">' +
        '<div class="expense-main"><span class="label">' + escapeHtml(e.label || '（内容未入力）') + '</span><span class="amount">' + escapeHtml(Core.formatYen(e.amount)) + '</span></div>' +
        '<div class="expense-sub">' + escapeHtml(dateText) + '　' + escapeHtml(e.paidBy) + 'が立替・' + escapeHtml(splitText) + '</div>' +
        '</div>';
    }).join('');
  }

  // iOSアプリ内では、WKWebViewのfetch実装がcapacitor://からのクロスオリジンPOSTの
  // プリフライト後処理をうまく扱えず、本体のリクエストが送られないことがある。
  // その場合はCapacitorHttpプラグイン経由でネイティブ側からHTTP通信する
  // （ブラウザ版ではwindow.Capacitorが存在しないので、従来通りfetchを使う）。
  function isNativeApp() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  }

  // ログイン時にサーバーが発行したセッショントークン（docs/adr/0005）。あればすべての通信に付ける。
  // サーバーはこれで本人を確かめる（以前は送ったメールアドレスをそのまま信用していた）。
  function authHeaders() {
    var user = loadCurrentUser();
    return user && user.token ? { authorization: 'Bearer ' + user.token } : {};
  }

  function nativeApi(path, method, body) {
    return window.Capacitor.Plugins.CapacitorHttp.request({
      url: API_BASE + path,
      method: method || 'GET',
      headers: Object.assign(body !== undefined ? { 'content-type': 'application/json' } : {}, authHeaders()),
      data: body
    }).then(function (res) {
      if (res.status < 200 || res.status >= 300) {
        var e = (res.data && typeof res.data === 'object' && res.data.error) || ('http_' + res.status);
        throw new Error(e);
      }
      return res.status === 204 ? null : res.data;
    });
  }

  function api(path, method, body) {
    if (isNativeApp()) return nativeApi(path, method, body);
    return fetch(API_BASE + path, {
      method: method || 'GET',
      headers: Object.assign(body !== undefined ? { 'content-type': 'application/json' } : {}, authHeaders()),
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(function (res) {
      if (!res.ok) return res.json().catch(function () { return {}; }).then(function (e) {
        throw new Error(e.error || ('http_' + res.status));
      });
      return res.status === 204 ? null : res.json();
    });
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onloadend = function () {
        var result = reader.result;
        var comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = function () { reject(new Error('read_failed')); };
      reader.readAsDataURL(blob);
    });
  }

  // 写真・音声など、生のバイナリをPOSTする共通の窓口（fetch＋エラー処理をここに集約する）。
  // iOSアプリ内ではWKWebViewのfetchでバイナリボディを直接送るとクロスオリジンPOSTが
  // 失敗するため、その場合はbase64化してJSON({dataBase64, contentType, headers})で送る。
  function postBinary(path, blob, extraHeaders) {
    if (isNativeApp()) {
      return blobToBase64(blob).then(function (dataBase64) {
        return nativeApi(path, 'POST', {
          dataBase64: dataBase64,
          contentType: blob.type || 'application/octet-stream',
          headers: extraHeaders || {}
        });
      });
    }
    var headers = Object.assign({ 'content-type': blob.type || 'application/octet-stream' }, extraHeaders || {}, authHeaders());
    return fetch(API_BASE + path, { method: 'POST', headers: headers, body: blob }).then(function (res) {
      if (!res.ok) return res.json().catch(function () { return {}; }).then(function (e) {
        throw new Error(e.error || ('http_' + res.status));
      });
      return res.json();
    });
  }

  function uploadPhotoBlob(blob) {
    return postBinary('/photos', blob);
  }

  // meta（notes・author）はUTF-8を含みうるので、ヘッダーに載せる前にBase64化する
  // （atob/btoaはLatin1前提のため、encodeURIComponent/unescapeで橋渡しする）。
  // date省略時は「複数日をまとめて記録する」（DAY30〜）：特定の日タブに紐づけず、
  // 旅行そのものに対して呼ぶ（AI自身が各予定の日を判定する）。
  function createVoiceEntries(tripId, date, blob, meta) {
    var metaHeader = btoa(unescape(encodeURIComponent(JSON.stringify(meta))));
    var path = date
      ? '/trips/' + encodeURIComponent(tripId) + '/days/' + encodeURIComponent(date) + '/voice-entries'
      : '/trips/' + encodeURIComponent(tripId) + '/voice-entries';
    return postBinary(path, blob, { 'x-voice-meta': metaHeader });
  }

  // 音声の文字起こし版と違い、貼り付けたテキストをそのままJSONで送るだけなのでbase64化は不要
  function createTextEntries(tripId, date, text, meta) {
    var path = date
      ? '/trips/' + encodeURIComponent(tripId) + '/days/' + encodeURIComponent(date) + '/text-entries'
      : '/trips/' + encodeURIComponent(tripId) + '/text-entries';
    return api(path, 'POST', { text: text, notes: meta.notes, author: meta.author, email: meta.email });
  }

  // レシート・領収書の写真をAIに読み取らせ、費用明細の候補（{label, amount}の配列）を返してもらう。
  // 音声入力・テキストメモと同じ利用枠を消費するため、メールアドレスをmetaヘッダーで送る。
  function scanReceiptBlob(blob, email) {
    var metaHeader = btoa(unescape(encodeURIComponent(JSON.stringify({ email: email }))));
    return postBinary('/receipts/scan', blob, { 'x-receipt-meta': metaHeader });
  }

  function fileToCompressedBlob(file, maxDim, quality) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = reject;
      reader.onload = function () {
        var img = new Image();
        img.onerror = reject;
        img.onload = function () {
          var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          var w = Math.max(1, Math.round(img.width * scale));
          var h = Math.max(1, Math.round(img.height * scale));
          var canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error('toBlob failed')); }, 'image/jpeg', quality);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // 画像を時計回りに90度単位で回す（スマホのカメラ写真が横向きに保存されてしまうときの手直し用）
  function rotateImageBlob(blob, degrees) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onerror = reject;
      img.onload = function () {
        var swap = (degrees / 90) % 2 !== 0;
        var canvas = document.createElement('canvas');
        canvas.width = swap ? img.height : img.width;
        canvas.height = swap ? img.width : img.height;
        var ctx = canvas.getContext('2d');
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(degrees * Math.PI / 180);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);
        URL.revokeObjectURL(url);
        canvas.toBlob(function (out) { out ? resolve(out) : reject(new Error('toBlob failed')); }, 'image/jpeg', 0.85);
      };
      img.src = url;
    });
  }

  // ---------- 旅行のサムネイル画像（新規作成・編集フォームで共用） ----------
  function resetCoverPhotoDraft(existingId) {
    state.coverPhotoDraft = { blob: null, previewUrl: '', existingId: existingId || '', removed: false };
  }

  function renderCoverPhotoPreview(prefix) {
    var el = $('#' + prefix + 'CoverPhotoPreview');
    var draft = state.coverPhotoDraft;
    var url = draft.blob ? draft.previewUrl : (!draft.removed && draft.existingId ? photoUrl(draft.existingId) : '');
    el.innerHTML = url
      ? '<div class="ph"><img src="' + escapeHtml(url) + '"><button type="button" class="ph-remove" aria-label="削除">×</button></div>'
      : '';
    if (url) {
      el.querySelector('button').addEventListener('click', function () {
        state.coverPhotoDraft.blob = null;
        state.coverPhotoDraft.previewUrl = '';
        state.coverPhotoDraft.removed = true;
        renderCoverPhotoPreview(prefix);
      });
    }
  }

  function handleCoverPhotoChange(prefix, file) {
    fileToCompressedBlob(file, 1280, 0.72).then(function (blob) {
      state.coverPhotoDraft.blob = blob;
      state.coverPhotoDraft.previewUrl = URL.createObjectURL(blob);
      state.coverPhotoDraft.removed = false;
      renderCoverPhotoPreview(prefix);
    });
  }

  // 新しく選んだ画像があればアップロードしてそのidを、削除だけされていれば空文字を、
  // どちらでもなければ元のidをそのまま使う
  function resolveCoverPhotoId() {
    var draft = state.coverPhotoDraft;
    if (draft.blob) return uploadPhotoBlob(draft.blob).then(function (p) { return p.id; });
    if (draft.removed) return Promise.resolve('');
    return Promise.resolve(draft.existingId || '');
  }

  // マイログの画面で使う、カテゴリごとの呼び名
  var MYLOG_LABELS = {
    food: '飯ログ',
    lodging: 'ほてログ',
    sightseeing: 'アクティビティーログ',
    transport: '移動ログ',
    other: 'その他ログ'
  };

  // ---------- 音声入力の有料プラン（docs/adr/0004） ----------
  var PLAN_LABELS = { free: '無料', basic: 'ベーシック', premium_plus: 'プレミア＋' };
  var PLAN_OPTIONS = [
    { plan: 'basic', name: 'ベーシック', detail: '月300円・音声入力 月10回まで' },
    { plan: 'premium_plus', name: 'プレミア＋', detail: '月1000円・音声入力 月50回まで' }
  ];

  // ---------- 状態 ----------
  var state = {
    account: null,            // ログイン中アカウントのプラン状況（{plan, voiceRemainingThisPeriod, ticketCredits, ...}）
    trip: null,
    blocks: [],
    days: [],                // 旅行の日ごとの場所・天気（{date, place, weatherCode, tempMax, tempMin, isForecast}）
    members: [],             // アカウント参加者（{accountId, name, joinedAt}）。ゲスト参加者(companions)とは別
    selectedDate: null,
    editingBlockId: null,
    formCategory: 'sightseeing',
    editingEntryId: null,
    editingEntry: null,       // 編集中の記録（評価の表示・更新に使う）
    entryBlockId: null,       // 記録を追加する先の大項目
    // 記録フォームの写真。並べ替えられるよう、保存済み（{id}）と、まだアップロードしていない新しい写真
    // （{blob, url}）を1つの並びで持つ（以前は別々に持ち、新しい写真は必ず後ろに付いていた）
    formPhotos: [],
    formVideoIds: [],         // 既存（サーバー上）の動画id
    pendingVideos: [],        // 新規に選んだ、まだアップロードしていない {blob, name, size}
    formCostItems: [],        // {label, amount}
    loginReturnTo: 'home',    // ログイン画面から戻る先の画面名
    myLogItems: [],
    myLogTrips: [],
    myLogPlaces: { prefectures: [], countries: [] },
    homeFilters: { companion: '', year: '', tripType: '', sort: '' },
    social: { likes: {}, comments: [], accountId: '' },
    myLogCategory: 'food',
    myLogSort: 'score',
    // 旅行のサムネイル画像。新規作成・編集どちらのフォームでも使い回す
    // （同時に開けるのは片方だけなので、フォームを開くたびに作り直す）
    coverPhotoDraft: { blob: null, previewUrl: '', existingId: '', removed: false }
  };

  function apiNoticeCheck() {
    var notice = $('#apiNotice');
    if (!API_BASE) {
      notice.hidden = false;
      notice.textContent = 'サーバー（Worker）が未設定です。apps/day07-tabilog/worker/README.md の手順で公開し、index.html の tabilog-api-endpoint に設定してください。設定するまで旅行の保存はできません。';
    } else {
      notice.hidden = true;
    }
  }

  // ---------- ホーム ----------
  function renderHome() {
    apiNoticeCheck();
    renderHomeTripList();
    syncAccountTripsIntoHome();
  }

  function tripThumbHtml(coverPhotoId) {
    return coverPhotoId
      ? '<div class="trip-card-thumb" style="background-image:url(\'' + escapeHtml(photoUrl(coverPhotoId)) + '\')"></div>'
      : '';
  }

  // 参加者名を丸いアイコン（頭文字＋色）で表示するための色分け。名前ごとに毎回同じ色になるよう、
  // 文字列から単純なハッシュ値を出して6色から選ぶだけで、特別な意味は持たせていない。
  function avatarColorClass(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) { h = (h * 31 + name.charCodeAt(i)) & 0xffffffff; }
    return 'c' + (Math.abs(h) % 6);
  }
  function tripCardAvatarsHtml(companions) {
    var list = (companions || []).filter(Boolean);
    if (!list.length) return '';
    return '<div class="trip-card-avatars">' + list.slice(0, 4).map(function (name) {
      var initial = name.trim().charAt(0) || '?';
      return '<span class="trip-card-avatar ' + avatarColorClass(name) + '">' + escapeHtml(initial) + '</span>';
    }).join('') + '</div>';
  }

  // 絞り込み欄（誰と一緒か・年・旅行区分）の選択肢を、実際の旅行データから作り直す。
  // 今選んでいる値はstate.homeFiltersに持っておき、作り直したあとも選択状態を保つ。
  function renderTripFilterOptions(allTrips) {
    var opts = Core.tripFilterOptions(allTrips);
    var f = state.homeFilters;
    $('#filterCompanion').innerHTML = '<option value="">誰と一緒か：すべて</option>' +
      opts.companions.map(function (c) {
        return '<option value="' + escapeHtml(c) + '"' + (f.companion === c ? ' selected' : '') + '>' + escapeHtml(c) + '</option>';
      }).join('');
    $('#filterYear').innerHTML = '<option value="">年：すべて</option>' +
      opts.years.map(function (y) {
        return '<option value="' + escapeHtml(y) + '"' + (f.year === y ? ' selected' : '') + '>' + escapeHtml(y) + '年</option>';
      }).join('');
    $('#filterTripType').innerHTML = '<option value="">旅行区分：すべて</option>' +
      opts.tripTypes.map(function (tt) {
        return '<option value="' + escapeHtml(tt) + '"' + (f.tripType === tt ? ' selected' : '') + '>' + escapeHtml(tt) + '</option>';
      }).join('');
  }

  function renderHomeTripList() {
    var allTrips = loadMyTrips();
    $('#tripFilters').hidden = allTrips.length < 2; // 1件以下なら絞り込みは出さない
    $('#btnClearTripHistory').hidden = !allTrips.length; // 履歴が無ければ削除ボタンも出さない
    if (allTrips.length >= 2) renderTripFilterOptions(allTrips);

    var list = Core.sortTrips(Core.filterTrips(allTrips, state.homeFilters), state.homeFilters.sort);
    $('#sortTripOrder').value = state.homeFilters.sort;
    var el = $('#tripList');
    if (!allTrips.length) {
      el.innerHTML = '<div class="empty">まだ旅行がありません。「＋ 新しい旅を記録する」から始めてください。</div>';
      return;
    }
    if (!list.length) {
      el.innerHTML = '<div class="empty">条件に一致する旅行がありません。</div>';
      return;
    }
    el.innerHTML = '';
    list.forEach(function (t) {
      var card = document.createElement('button');
      var dateText = t.startDate ? Core.formatDateJp(t.startDate) + (t.endDate && t.endDate !== t.startDate ? ' 〜 ' + Core.formatDateJp(t.endDate) : '') : '';
      var infoHtml =
        '<div class="trip-card-top"><div class="trip-card-title">' + escapeHtml(t.title) + '</div>' +
        (dateText ? '<span class="trip-card-date">' + escapeHtml(dateText) + '</span>' : '') + '</div>';
      // サムネイル画像がある旅行は、写真を大きく見せてその上に旅行区分バッジを重ね、
      // 写真の下にタイトル・日程・参加者のアイコンを並べる（ホーム画面だけの見た目。
      // マイログの「参加した旅行一覧」は今までどおりの小さいサムネイルの一覧のまま）。
      if (t.coverPhotoId) {
        card.className = 'trip-card has-photo';
        card.innerHTML =
          '<div class="trip-card-photo" style="background-image:url(\'' + escapeHtml(photoUrl(t.coverPhotoId)) + '\')">' +
          (t.tripType ? '<span class="trip-card-photo-badge">' + escapeHtml(t.tripType) + '</span>' : '') +
          '</div>' +
          '<div class="trip-card-info">' + infoHtml +
          '<div class="trip-card-people">' + tripCardAvatarsHtml(t.companions) +
          '<span class="trip-card-people-text">' +
          ((t.companions || []).length ? escapeHtml(t.companions.join('・')) + ' と一緒' : '参加者は未設定') +
          '</span></div></div>';
      } else {
        card.className = 'trip-card';
        card.innerHTML =
          infoHtml +
          '<div class="trip-card-companions">' +
          ((t.companions || []).length ? escapeHtml(t.companions.join('・')) + ' と一緒' : '参加者は未設定') +
          (t.tripType ? '<span class="trip-card-type">' + escapeHtml(t.tripType) + '</span>' : '') +
          '</div>';
      }
      card.addEventListener('click', function () { openTrip(t.id); });
      el.appendChild(card);
    });
  }

  // ホーム画面の旅行一覧は本来この端末のローカル索引（tabilog:my-trips）だけを見ているため、
  // 別の端末で参加した旅行や、この端末の索引から消えてしまった旅行が表示されない弱点があった。
  // ログイン中はアカウントに紐づく「参加した旅行」（マイログと同じ情報源）も取り寄せ、
  // ローカル索引にまだ無ければ足しておく（＝以後はこの端末でもオフラインで一覧に出る）。
  function syncAccountTripsIntoHome() {
    var user = loadCurrentUser();
    if (!API_BASE || !user) return;
    api('/mylog?email=' + encodeURIComponent(user.email)).then(function (data) {
      var known = loadMyTrips();
      var knownIds = {};
      known.forEach(function (t) { knownIds[t.id] = true; });
      loadHiddenTripIds().forEach(function (id) { knownIds[id] = true; }); // 本人が履歴から消したものは足し直さない
      var added = false;
      (data.trips || []).forEach(function (t) {
        if (knownIds[t.id]) return;
        known = Core.upsertTripIndexEntry(known, {
          id: t.id, title: t.title, startDate: t.startDate, endDate: t.endDate, companions: t.companions || [],
          tripType: t.tripType || '', coverPhotoId: t.coverPhotoId || ''
        });
        added = true;
      });
      if (added) {
        localStorage.setItem(MY_TRIPS_KEY, JSON.stringify(known));
        renderHomeTripList();
      }
    }).catch(function () {});
  }

  function goHome() {
    history.pushState(null, '', location.pathname);
    showScreen('home');
    renderHome();
  }

  // ---------- 旅行を開く ----------
  function openTrip(id) {
    if (!API_BASE) { apiNoticeCheck(); showScreen('home'); return; }
    api('/trips/' + encodeURIComponent(id)).then(function (data) {
      state.trip = data.trip;
      state.blocks = data.blocks;
      state.days = data.days || [];
      state.members = data.members || [];
      state.social = emptySocial();
      var dates = Core.allDatesForTrip(state.trip, state.blocks);
      state.selectedDate = dates[0] !== undefined ? dates[0] : '';
      rememberTrip(state.trip);
      history.pushState(null, '', Core.buildShareUrl(location.origin, location.pathname, id).replace(location.origin, ''));
      state.zoneInfo = { byBlock: {}, byDate: {} };
      screenScroll.tripDetail = 0; // 別の旅行はいちばん上から
      showScreen('tripDetail');
      renderTripDetail();
      loadSocial();
      loadTripZones();
    }).catch(function () {
      forgetTrip(id);
      alert('旅行が見つかりませんでした（削除された可能性があります）。一覧からも消しました。');
      goHome();
    });
  }

  function refreshTrip() {
    return api('/trips/' + encodeURIComponent(state.trip.id)).then(function (data) {
      state.trip = data.trip;
      state.blocks = data.blocks;
      state.days = data.days || [];
      state.members = data.members || [];
    });
  }

  // ---------- 新規作成 ----------
  function openNewTripForm() {
    $('#ntTitle').value = '';
    $('#ntStart').value = '';
    $('#ntEnd').value = '';
    $('#ntCompanions').value = '';
    $('#ntTripType').value = '';
    $('#newTripStatus').textContent = '';
    resetCoverPhotoDraft('');
    renderCoverPhotoPreview('nt');
    showScreen('newTrip');
  }

  function createTrip() {
    var title = $('#ntTitle').value.trim();
    var status = $('#newTripStatus');
    if (!API_BASE) { status.textContent = 'サーバーが未設定のため作成できません。'; return; }
    if (!title) { status.textContent = 'タイトルを入力してください。'; return; }
    status.textContent = '作成中…';
    resolveCoverPhotoId().then(function (coverPhotoId) {
      return api('/trips', 'POST', {
        title: title,
        startDate: $('#ntStart').value,
        endDate: $('#ntEnd').value,
        companions: Core.parseTags($('#ntCompanions').value),
        tripType: $('#ntTripType').value.trim(),
        coverPhotoId: coverPhotoId
      });
    }).then(function (trip) {
      rememberTrip(trip);
      openTrip(trip.id);
    }).catch(function () {
      status.textContent = '作成に失敗しました。もう一度お試しください。';
    });
  }

  // ---------- 旅行のタイトル・日程・参加者を編集する ----------
  function openTripEditForm() {
    var trip = state.trip;
    $('#teTitle').value = trip.title;
    $('#teStart').value = trip.startDate || '';
    $('#teEnd').value = trip.endDate || '';
    $('#teCompanions').value = (trip.companions || []).join('、');
    $('#teTripType').value = trip.tripType || '';
    $('#tripEditStatus').textContent = '';
    resetCoverPhotoDraft(trip.coverPhotoId || '');
    renderCoverPhotoPreview('te');
    showScreen('tripEditForm');
  }

  function saveTripEdit() {
    var title = $('#teTitle').value.trim();
    var status = $('#tripEditStatus');
    if (!title) { status.textContent = 'タイトルを入力してください。'; return; }
    status.textContent = '保存中…';
    resolveCoverPhotoId().then(function (coverPhotoId) {
      return api('/trips/' + encodeURIComponent(state.trip.id), 'PATCH', {
        title: title,
        startDate: $('#teStart').value,
        endDate: $('#teEnd').value,
        companions: Core.parseTags($('#teCompanions').value),
        tripType: $('#teTripType').value.trim(),
        coverPhotoId: coverPhotoId
      });
    }).then(function (trip) {
      state.trip = trip;
      rememberTrip(trip);
      var dates = Core.allDatesForTrip(state.trip, state.blocks);
      if (dates.indexOf(state.selectedDate) === -1) state.selectedDate = dates[0] !== undefined ? dates[0] : '';
      showScreen('tripDetail');
      renderTripDetail();
    }).catch(function () {
      status.textContent = '保存に失敗しました。もう一度お試しください。';
    });
  }

  // 宿泊先の統計カード用の表示文字列。「1〜6泊目：Aホテル／7泊目：Bホテル」のように、
  // 同じ宿が続く夜はまとめる（lodgingByNight）。宿泊が1か所だけの旅行では、これまでどおり
  // 宿の名前だけをシンプルに出す（範囲表記を付けない）。
  function formatLodgingStat(groups) {
    if (!groups.length) return Core.primaryLodgingName(state.blocks) || '未設定';
    if (groups.length === 1) return groups[0].label || '未設定';
    return groups.map(function (g) {
      var range = g.from === g.to ? (g.from + '泊目') : (g.from + '〜' + g.to + '泊目');
      return range + '：' + (g.label || '未定');
    }).join('／');
  }

  // 宿泊先の内訳（何泊目にどこへ泊まったか、全件）。統計カードの表示文字列（formatLodgingStat）は
  // 3行までしか出せない（.stat-card .valのline-clamp）ため、宿泊先が3件を超える旅行では
  // 全部を確認できなかった。統計カードの「宿泊先」をタップすると開閉する（DAY30〜）。
  function toggleLodgingBreakdown() {
    var panel = $('#lodgingBreakdownPanel');
    if (!panel.hidden) { panel.hidden = true; return; }
    $('#costBreakdownPanel').hidden = true;
    var groups = Core.lodgingByNight(state.trip, state.blocks);
    var primaryName = Core.primaryLodgingName(state.blocks);
    if (groups.length) {
      panel.innerHTML = groups.map(function (g) {
        var range = g.from === g.to ? (g.from + '泊目') : (g.from + '〜' + g.to + '泊目');
        return '<div class="cost-breakdown-row"><span class="name">' + escapeHtml(range) + '</span><span class="amount">' + escapeHtml(g.label || '未定') + '</span></div>';
      }).join('');
    } else if (primaryName) {
      // 日帰りなど「泊」の無い旅行では日ごとの内訳が作れないため、宿泊カテゴリの見出しをそのまま出す
      panel.innerHTML = '<div class="cost-breakdown-row"><span class="name">宿泊先</span><span class="amount">' + escapeHtml(primaryName) + '</span></div>';
    } else {
      panel.innerHTML = '<p class="empty">宿泊カテゴリの予定がまだありません。</p>';
    }
    panel.hidden = false;
  }

  // 総費用の内訳（誰が実際にいくら払ったか）。統計カードの「総費用」をタップすると開閉する。
  function toggleCostBreakdown() {
    var panel = $('#costBreakdownPanel');
    if (!panel.hidden) { panel.hidden = true; return; }
    $('#lodgingBreakdownPanel').hidden = true;
    var breakdown = Core.costBreakdownByPerson(state.blocks);
    var names = Object.keys(breakdown).sort(function (a, b) { return breakdown[b] - breakdown[a]; });
    panel.innerHTML = names.length
      ? names.map(function (name) {
          return '<div class="cost-breakdown-row"><span class="name">' + escapeHtml(name) + '</span><span class="amount">' + escapeHtml(Core.formatYen(breakdown[name])) + '</span></div>';
        }).join('')
      : '<p class="empty">まだ費用の記録がありません。</p>';
    panel.hidden = false;
  }

  // ---------- 旅行詳細 ----------
  function renderTripDetail() {
    applyTripZones();
    var trip = state.trip;
    var coverEl = $('#tripCoverPhoto');
    coverEl.hidden = !trip.coverPhotoId;
    coverEl.style.backgroundImage = trip.coverPhotoId ? "url('" + photoUrl(trip.coverPhotoId) + "')" : '';
    $('#tripTitle').textContent = trip.title;
    var range = trip.startDate ? Core.formatDateJp(trip.startDate) + (trip.endDate ? ' 〜 ' + Core.formatDateJp(trip.endDate) : '') : '日程未設定';
    var nights = Core.tripNights(trip);
    $('#tripDates').textContent = range + (nights ? '・' + nights : '');
    $('#tripCompanions').textContent = (trip.companions || []).length ? trip.companions.join('・') + ' と一緒' : '参加者は未設定';
    $('#btnOpenReplay').hidden = !(state.blocks || []).some(function (b) { return b.date; });
    renderTripJoin();
    renderTripSocialBar();

    var lodging = formatLodgingStat(Core.lodgingByNight(trip, state.blocks));
    var total = Core.tripTotalCost(state.blocks);
    $('#tripStats').innerHTML =
      '<button type="button" class="stat-card stat-card-btn" id="btnShowLodgingBreakdown"><div class="lbl">宿泊先</div><div class="val">' + escapeHtml(lodging) + '</div></button>' +
      '<button type="button" class="stat-card stat-card-btn" id="btnShowCostBreakdown"><div class="lbl">総費用</div><div class="val">' + escapeHtml(Core.formatYen(total) || '¥0') + '</div></button>' +
      statCard('日程', nights || (Core.allDatesForTrip(trip, state.blocks).length + '日'));
    $('#lodgingBreakdownPanel').hidden = true;
    $('#costBreakdownPanel').hidden = true;
    $('#btnShowLodgingBreakdown').addEventListener('click', toggleLodgingBreakdown);
    $('#btnShowCostBreakdown').addEventListener('click', toggleCostBreakdown);

    renderDayTabs();
    renderDaySection();
  }

  // ---------- アカウント参加者（参加する） ----------
  // ゲスト参加者（companions、テキストのみ）とは別に、ログイン中の本人が押すことで
  // 自分のアカウントをこの旅行に紐付ける。紐付いた旅行はマイログの「参加した旅行一覧」に出る。
  function renderTripJoin() {
    var user = loadCurrentUser();
    var members = state.members || [];
    var namesEl = $('#tripMembers');
    namesEl.hidden = !members.length;
    namesEl.textContent = members.length
      ? 'アカウント参加：' + members.map(function (m) { return m.name || 'アカウント参加者'; }).join('・')
      : '';
    var btn = $('#btnJoinTrip');
    var joined = user && user.accountId && members.some(function (m) { return m.accountId === user.accountId; });
    btn.disabled = !!joined;
    btn.textContent = joined ? '参加済み' : '参加する';
  }

  function handleJoinTrip() {
    var user = loadCurrentUser();
    if (!user) { openLogin('tripDetail'); return; }
    api('/trips/' + encodeURIComponent(state.trip.id) + '/join', 'POST', { email: user.email, name: user.name || '' })
      .then(function (res) {
        state.members = res.members || [];
        if (res.accountId && user.accountId !== res.accountId) {
          saveCurrentUser(Object.assign({}, user, { accountId: res.accountId }));
        }
        renderTripJoin();
      })
      .catch(function () {
        $('#tripDetailStatus').textContent = '参加に失敗しました。もう一度お試しください。';
      });
  }

  // ---------- いいね・コメント（友達同士のSNS機能。docs/adr/0006） ----------
  // 旅行と記録の両方に、いいね・コメントをつけられる。読むのは旅行のリンクを知っている人なら誰でも、
  // 書くのはログイン済みの人だけ（サーバーはセッショントークンで本人を確かめる。docs/adr/0005）。
  // 旅行を開いたときに /trips/:id/social を1回だけ呼び、state.socialに持っておく。
  // Appleの審査ガイドライン1.2のため、他人のコメントには「通報」「ブロック」を用意し、
  // 初めてコメントするときにルールへの同意を求める。
  var HEART_ICON = '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M10 16.5s-6.5-3.9-6.5-8.4A3.6 3.6 0 0 1 10 5.8a3.6 3.6 0 0 1 6.5 2.3c0 4.5-6.5 8.4-6.5 8.4z"/></svg>';
  var COMMENT_ICON = '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-4 3v-3H4A1.5 1.5 0 0 1 2.5 13V6A1.5 1.5 0 0 1 4 4.5z"/></svg>';
  var COMMENT_TERMS_KEY = 'tabilog:comment-terms-ok';
  var commentTarget = null; // コメントシートで開いている対象 { type: 'trip'|'entry', id }

  function emptySocial() { return { likes: {}, comments: [], accountId: '' }; }

  function loadSocial() {
    if (!state.trip || !API_BASE) return Promise.resolve();
    var tripId = state.trip.id;
    return api('/trips/' + encodeURIComponent(tripId) + '/social').then(function (res) {
      if (!state.trip || state.trip.id !== tripId) return; // 読み込み中に別の旅行へ移った
      state.social = { likes: res.likes || {}, comments: res.comments || [], accountId: res.accountId || '' };
      renderSocial();
    }).catch(function () { /* 読めなくても旅行自体は見られるようにする */ });
  }

  function likeInfo(type, id) {
    return (state.social && state.social.likes[type + ':' + id]) || { count: 0, liked: false };
  }

  function commentsFor(type, id) {
    return ((state.social && state.social.comments) || []).filter(function (c) {
      return c.targetType === type && c.targetId === id;
    });
  }

  function socialButtonsHtml(type, id) {
    var like = likeInfo(type, id);
    var n = commentsFor(type, id).length;
    return '<button type="button" class="social-btn like-btn' + (like.liked ? ' liked' : '') + '" data-social-like="' + type +
        '" data-target-id="' + escapeHtml(id) + '" aria-pressed="' + (like.liked ? 'true' : 'false') + '" aria-label="いいね">' +
        HEART_ICON + '<span>' + (like.count || '') + '</span></button>' +
      '<button type="button" class="social-btn" data-social-comment="' + type + '" data-target-id="' + escapeHtml(id) +
        '" aria-label="コメント">' + COMMENT_ICON + '<span>' + (n || '') + '</span></button>';
  }

  function renderTripSocialBar() {
    if (state.trip) $('#tripSocialBar').innerHTML = socialButtonsHtml('trip', state.trip.id);
  }

  function renderSocial() {
    renderTripSocialBar();
    $all('.entry-social').forEach(function (el) { el.innerHTML = socialButtonsHtml('entry', el.dataset.entryId); });
    if (!$('#commentSheet').hidden) renderCommentSheet();
  }

  // いいね・コメントは本人確認済み（トークンあり）のときだけ。以前からログインしていてトークンを
  // まだ持っていない人は、もう一度ログインしてもらう（ログイン後はこの旅行に戻る）。
  function requireSocialLogin() {
    var user = loadCurrentUser();
    if (user && user.token) return true;
    closeCommentSheet();
    openLogin('tripDetail');
    $('#loginLead').textContent = user
      ? 'いいね・コメントするには、もう一度ログインしてください（本人確認のしくみを新しくしました）'
      : 'ログインすると、いいねやコメントができます';
    return false;
  }

  function toggleLike(type, id) {
    if (!requireSocialLogin()) return;
    var key = type + ':' + id;
    var before = likeInfo(type, id);
    var on = !before.liked;
    // 押した瞬間に見た目を変え、失敗したら元に戻す
    state.social.likes[key] = { count: Math.max(0, before.count + (on ? 1 : -1)), liked: on };
    renderSocial();
    api('/trips/' + encodeURIComponent(state.trip.id) + '/likes', on ? 'PUT' : 'DELETE', { targetType: type, targetId: id })
      .then(function (res) {
        state.social.likes[key] = { count: res.count, liked: res.liked };
        renderSocial();
      })
      .catch(function (e) {
        state.social.likes[key] = before;
        renderSocial();
        if (e && e.message === 'login_required') requireSocialLoginAgain();
      });
  }

  // サーバー側でトークンが無効（期限切れ・ログアウト済み）だった場合
  function requireSocialLoginAgain() {
    var user = loadCurrentUser();
    if (user) saveCurrentUser(Object.assign({}, user, { token: '' }));
    requireSocialLogin();
  }

  function openCommentSheet(type, id) {
    commentTarget = { type: type, id: id };
    $('#commentSheetTitle').textContent = type === 'trip' ? 'この旅行へのコメント' : 'この記録へのコメント';
    $('#commentStatus').textContent = '';
    $('#commentSheet').hidden = false;
    document.body.classList.add('sheet-open');
    renderCommentSheet();
  }

  function closeCommentSheet() {
    $('#commentSheet').hidden = true;
    document.body.classList.remove('sheet-open');
    commentTarget = null;
  }

  function formatCommentTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function renderCommentSheet() {
    if (!commentTarget) return;
    var list = commentsFor(commentTarget.type, commentTarget.id);
    $('#commentList').innerHTML = list.length
      ? list.map(function (c) {
          var actions = c.mine
            ? '<button type="button" class="btn text danger" data-comment-delete="' + escapeHtml(c.id) + '">削除</button>'
            : '<button type="button" class="btn text" data-comment-report="' + escapeHtml(c.id) + '">通報する</button>' +
              '<button type="button" class="btn text danger" data-comment-block="' + escapeHtml(c.accountId) + '" data-name="' + escapeHtml(c.name || '') + '">この人をブロック</button>';
          return '<div class="comment-item">' +
            '<div class="comment-head">' +
              '<span class="comment-name">' + escapeHtml(c.name || '名前未設定') + '</span>' +
              '<span class="comment-time">' + escapeHtml(formatCommentTime(c.createdAt)) + '</span>' +
              '<button type="button" class="comment-menu-btn" aria-label="メニュー" data-comment-menu>…</button>' +
            '</div>' +
            '<div class="comment-body">' + escapeHtml(c.body) + '</div>' +
            '<div class="comment-actions" hidden>' + actions + '</div>' +
          '</div>';
        }).join('')
      : '<div class="empty comment-empty">まだコメントはありません。</div>';
  }

  function agreeToCommentTerms() {
    try { if (localStorage.getItem(COMMENT_TERMS_KEY)) return true; } catch (e) { /* 読めなければ毎回聞く */ }
    var ok = confirm('コメントのルール\n\n・誹謗中傷、差別、嫌がらせ、わいせつな内容など、不適切な投稿は禁止です\n' +
      '・不適切なコメントは誰でも通報でき、運営者が確認して削除します。繰り返す場合は利用を停止することがあります\n\n' +
      'このルールに同意してコメントしますか？');
    if (ok) { try { localStorage.setItem(COMMENT_TERMS_KEY, '1'); } catch (e) { /* 次回また聞くだけ */ } }
    return ok;
  }

  function submitComment(e) {
    e.preventDefault();
    if (!commentTarget) return;
    var input = $('#commentInput');
    var body = input.value.trim();
    if (!body) return;
    if (!requireSocialLogin() || !agreeToCommentTerms()) return;
    var target = commentTarget;
    var status = $('#commentStatus');
    status.textContent = '送信中…';
    $('#btnSendComment').disabled = true;
    api('/trips/' + encodeURIComponent(state.trip.id) + '/comments', 'POST', { targetType: target.type, targetId: target.id, body: body })
      .then(function (c) {
        state.social.comments.push(c);
        input.value = '';
        status.textContent = '';
        renderSocial();
      })
      .catch(function (err) {
        var msg = (err && err.message) || '';
        if (msg === 'login_required') { requireSocialLoginAgain(); return; }
        status.textContent = msg === 'inappropriate'
          ? '不適切な表現が含まれているため投稿できません。'
          : 'コメントを送れませんでした。もう一度お試しください。';
      })
      .then(function () { $('#btnSendComment').disabled = false; });
  }

  function handleCommentListClick(e) {
    var menuBtn = e.target.closest('[data-comment-menu]');
    if (menuBtn) {
      var actions = menuBtn.closest('.comment-item').querySelector('.comment-actions');
      actions.hidden = !actions.hidden;
      return;
    }
    var del = e.target.closest('[data-comment-delete]');
    if (del) {
      if (!confirm('このコメントを削除しますか？')) return;
      var delId = del.dataset.commentDelete;
      api('/comments/' + encodeURIComponent(delId), 'DELETE').then(function () {
        state.social.comments = state.social.comments.filter(function (c) { return c.id !== delId; });
        renderSocial();
      }).catch(function () { $('#commentStatus').textContent = '削除できませんでした。もう一度お試しください。'; });
      return;
    }
    var rep = e.target.closest('[data-comment-report]');
    if (rep) {
      if (!requireSocialLogin()) return;
      if (!confirm('このコメントを通報しますか？\n運営者が内容を確認し、必要なら削除します。通報したコメントは、あなたには表示されなくなります。')) return;
      var repId = rep.dataset.commentReport;
      api('/comments/' + encodeURIComponent(repId) + '/report', 'POST', {}).then(function () {
        state.social.comments = state.social.comments.filter(function (c) { return c.id !== repId; });
        renderSocial();
        $('#commentStatus').textContent = '通報しました。ご協力ありがとうございます。';
      }).catch(function () { $('#commentStatus').textContent = '通報できませんでした。もう一度お試しください。'; });
      return;
    }
    var blk = e.target.closest('[data-comment-block]');
    if (blk) {
      if (!requireSocialLogin()) return;
      var who = blk.dataset.name || 'この人';
      if (!confirm(who + 'さんをブロックしますか？\nこの人のコメントは、あなたには表示されなくなります。')) return;
      var accountId = blk.dataset.commentBlock;
      api('/user-blocks', 'PUT', { accountId: accountId }).then(function () {
        state.social.comments = state.social.comments.filter(function (c) { return c.accountId !== accountId; });
        renderSocial();
        $('#commentStatus').textContent = 'ブロックしました。';
      }).catch(function () { $('#commentStatus').textContent = 'ブロックできませんでした。もう一度お試しください。'; });
    }
  }

  // ---------- 紹介文（ホテログ・レクログ・飯ログ。docs/adr/0007） ----------
  // 自分がつけた★とレビュー項目から、表紙→評価の基準→時系列のログ→総額の文章を作り、コピーしてSNSに貼れるようにする。
  // ★3.0未満の記録は入らない（Core.buildTripPostText）。文章はその場で直してからコピーできる。
  function openPostSheet() {
    if (!state.trip) return;
    var user = loadCurrentUser();
    var text = Core.buildTripPostText(state.trip, state.blocks, state.days, user ? user.email : '');
    $('#postText').value = text;
    $('#postSheetNote').textContent = user
      ? 'あなたが★をつけた記録から作りました（★3.0未満は入りません）。文章はここで直してからコピーできます。'
      : 'ログインして記録に★とレビューをつけると、ホテログ・飯ログなどが入ります。';
    $('#postStatus').textContent = '';
    $('#btnSharePost').hidden = !navigator.share;
    $('#postSheet').hidden = false;
    document.body.classList.add('sheet-open');
  }

  function closePostSheet() {
    $('#postSheet').hidden = true;
    document.body.classList.remove('sheet-open');
  }

  function copyPostText() {
    var text = $('#postText').value;
    var done = function () { $('#postStatus').textContent = 'コピーしました。SNSの投稿に貼り付けてください。'; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { $('#postText').select(); document.execCommand('copy'); done(); });
    } else {
      $('#postText').select(); document.execCommand('copy'); done();
    }
  }

  function initSocial() {
    $('#btnOpenPost').addEventListener('click', openPostSheet);
    $('#btnClosePostSheet').addEventListener('click', closePostSheet);
    $('#postSheet').addEventListener('click', function (e) { if (e.target === e.currentTarget) closePostSheet(); });
    $('#btnCopyPost').addEventListener('click', copyPostText);
    $('#btnSharePost').addEventListener('click', function () {
      navigator.share({ text: $('#postText').value }).catch(function () {});
    });
    // いいね・コメントのボタンは旅行の上部と各記録カードにあるので、まとめてdocumentで受ける
    // （記録カード自体のクリック＝編集を開く処理は、.entry-social内のクリックを無視する）
    document.addEventListener('click', function (e) {
      var likeBtn = e.target.closest('[data-social-like]');
      if (likeBtn) { toggleLike(likeBtn.dataset.socialLike, likeBtn.dataset.targetId); return; }
      var commentBtn = e.target.closest('[data-social-comment]');
      if (commentBtn) openCommentSheet(commentBtn.dataset.socialComment, commentBtn.dataset.targetId);
    });
    $('#btnCloseCommentSheet').addEventListener('click', closeCommentSheet);
    $('#commentSheet').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeCommentSheet(); });
    $('#commentForm').addEventListener('submit', submitComment);
    $('#commentList').addEventListener('click', handleCommentListClick);
  }

  // ---------- 音声でまとめて記録する（このアプリで唯一AIを呼び出す機能） ----------
  // 話した順番どおりに複数の予定・記録へAIが分割し、今開いている日タブに直接保存する
  // （保存前の確認画面は挟まない。docs/adr/0002参照）。
  var voiceStream = null;
  var voiceRecorder = null;
  var voiceChunks = [];
  var voiceBlob = null;
  var voiceStartedAt = 0;
  var voiceTimerInterval = null;
  var voiceAutoStopped = false;
  // プレミアムプランの「1回3分まで」に合わせて、録音時間そのものをアプリ側で強制する
  // （時間の上限を超えられないようにしておけば、費用の見積もりが崩れない）
  var VOICE_MAX_MS = 3 * 60 * 1000;

  function formatVoiceElapsed(ms) {
    var seconds = Math.max(0, Math.floor(ms / 1000));
    var mm = Math.floor(seconds / 60);
    var ss = seconds % 60;
    return mm + ':' + (ss < 10 ? '0' : '') + ss;
  }

  function stopVoiceTimer() {
    if (voiceTimerInterval) { clearInterval(voiceTimerInterval); voiceTimerInterval = null; }
  }

  // 録音中に別画面へ移動したとき、マイクを使いっぱなしにしないための後始末
  // （既存のstopイベントハンドラがマイクの解放・タイマー停止まで行う）
  function stopVoiceRecordingIfActive() {
    if (voiceRecorder && voiceRecorder.state === 'recording') voiceRecorder.stop();
  }

  var MIC_ICON = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7.5" y="2.5" width="5" height="9" rx="2.5"/><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0"/><path d="M10 15v2.5M7 17.5h6"/></svg>';
  var STOP_ICON = '<svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="5" width="10" height="10" rx="2"/></svg>';

  function setVoiceRecordLabel(icon, text) {
    $('#btnVoiceRecord').innerHTML = icon + '<span>' + escapeHtml(text) + '</span>';
  }

  function pickVoiceMimeType() {
    var candidates = ['audio/webm', 'audio/mp4', 'audio/ogg'];
    for (var i = 0; i < candidates.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  // 音声入力・レシート読み取りは、内容の読み取りのため録音データ・メモの文章・レシート写真を
  // 外部のAIサービス（OpenAI）へ送信する（Apple Guideline 5.1.1(i)/5.1.2(i)対応）。
  // 送信前に必ず内容を説明し、同意を得てから実際の送信処理へ進む。一度同意すればこの端末では
  // 再確認しない（同意そのものをやり直したい場合はブラウザのサイトデータ削除で戻せる）。
  var AI_CONSENT_KEY = 'tabilog:ai-consent';
  function hasAiConsent() {
    try { return localStorage.getItem(AI_CONSENT_KEY) === '1'; } catch (e) { return false; }
  }
  function confirmAiDataSharing() {
    if (hasAiConsent()) return true;
    var ok = confirm(
      '音声入力・レシート読み取りでは、録音した音声・入力したメモの文章・レシートの写真を、' +
      '内容の読み取り・文字起こしのために外部のAIサービス（OpenAI）へ送信します。\n' +
      '送信されたデータはOpenAIのモデル学習には使われません（APIの既定ポリシー）。\n\n' +
      '同意してこの機能を使いますか？'
    );
    if (ok) { try { localStorage.setItem(AI_CONSENT_KEY, '1'); } catch (e) {} }
    return ok;
  }

  // 音声入力は有料プラン専用（docs/adr/0004）。ログインしていない、またはプラン・回数券が
  // 無い場合は、録音の代わりに案内とプランへの導線を出す。
  // multiDay=trueで開くと「複数日をまとめて記録する」（DAY30〜）：特定の日タブを選ばず、
  // 旅行の日程全体に対してAIが各予定の日も判定する（state.voiceEntryMultiDayで保持し、
  // 保存時にcreateVoiceEntries/createTextEntriesへ渡すdateをnullにする分岐に使う）。
  // 音声・メモでまとめて記録する画面。メモの「決まった形」の取り込みはAIを使わず無料なので、ログインや
  // 回数に関係なく誰でも開ける（以前はログインとAIの残り回数が無いと、画面ごと使えなかった）。
  // 音声入力とAIでの整理は、使うときにログイン・AIへの送信の同意・月の回数を確かめる。
  function openVoiceEntryForm(multiDay) {
    if (!multiDay && !state.selectedDate) { alert('先に日付を選んでから記録を始めてください。'); return; }
    state.voiceEntryMultiDay = !!multiDay;
    $('#voiceEntryTitle').textContent = multiDay ? '複数日をまとめて記録する' : '音声・メモでまとめて記録する';
    $('#voiceEntryLead').textContent = multiDay
      ? '複数日ぶんの出来事をまとめて話す、またはスケジュール・メモを貼り付けると、予定・記録に分けて保存します（評価や費用はあとで入力してください）'
      : 'その日にあったことをまとめて話す、またはスケジュール・メモを貼り付けると、予定・記録に分けて保存します（評価や費用はあとで入力してください）';
    showScreen('voiceEntryForm');
    voiceBlob = null;
    $('#voiceNotes').value = '';
    setVoiceRecordLabel(MIC_ICON, '話しはじめる');
    $('#btnVoiceRecord').disabled = false;
    $('#btnCreateVoiceEntries').hidden = true;
    $('#btnCreateVoiceEntries').disabled = false;
    $('#voiceRecordStatus').textContent = '';
    $('#voiceRecordStatus').classList.remove('is-recording');
    $('#voiceEntryStatus').textContent = '';
    $('#textMemoInput').value = state.pendingMemoText || ''; // ログインを挟んだときは書きかけのメモを戻す
    state.pendingMemoText = '';
    $('#btnCreateTextEntries').disabled = false;
    $('#btnOrganizeMemoAi').disabled = false;
    $('#textEntryStatus').textContent = '';
    $('#voicePremiumRequired').hidden = true;
    $('#voiceRecordArea').hidden = false;
    var user = loadCurrentUser();
    if (!user) {
      $('#memoAiInfo').textContent = 'AIでの整理と音声入力は、ログインすると使えます（メモのAI整理は月10回まで無料）。';
      return;
    }
    $('#memoAiInfo').textContent = '';
    fetchAccountStatus().then(function (account) {
      if (!account) return;
      var tickets = account.ticketCredits ? '（回数券の残り' + account.ticketCredits + '回）' : '';
      $('#memoAiInfo').textContent = 'AIでの整理：今月あと' + account.memoRemainingThisPeriod + '回（月' + account.memoMonthlyLimit + '回まで無料）' + tickets;
      var voiceOk = account.voiceRemainingThisPeriod > 0 || account.ticketCredits > 0;
      if (!voiceOk) {
        // 音声だけ使えない。メモ（決まった形・AIでの整理）はこのまま使える
        $('#voicePremiumRequired').hidden = false;
        $('#voicePremiumMessage').textContent = '今月の音声入力の回数を使い切りました。メモの取り込みはこのまま使えます。';
        $('#btnVoiceRecord').disabled = true;
      }
    });
  }

  // 音声・AIを使う前の確認。ログインしていなければログインへ（書きかけのメモは残す）
  function requireAiReady() {
    if (!loadCurrentUser()) {
      state.pendingMemoText = $('#textMemoInput').value;
      openLogin('voiceEntryForm');
      $('#loginLead').textContent = 'ログインすると、音声入力やAIでの整理が使えます';
      return false;
    }
    return confirmAiDataSharing();
  }

  function handleVoiceRecordToggle() {
    if (voiceRecorder && voiceRecorder.state === 'recording') {
      voiceRecorder.stop();
      return;
    }
    if (!requireAiReady()) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      $('#voiceRecordStatus').textContent = 'このブラウザは音声の録音に対応していません。';
      return;
    }
    $('#voiceRecordStatus').textContent = 'マイクの使用を許可してください…';
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      voiceStream = stream;
      var mimeType = pickVoiceMimeType();
      voiceRecorder = mimeType ? new MediaRecorder(stream, { mimeType: mimeType }) : new MediaRecorder(stream);
      voiceChunks = [];
      voiceStartedAt = Date.now();
      voiceAutoStopped = false;
      voiceRecorder.addEventListener('dataavailable', function (e) {
        if (e.data && e.data.size) voiceChunks.push(e.data);
      });
      voiceRecorder.addEventListener('stop', function () {
        stopVoiceTimer();
        voiceStream.getTracks().forEach(function (t) { t.stop(); });
        voiceBlob = new Blob(voiceChunks, { type: voiceRecorder.mimeType || mimeType || 'audio/webm' });
        var seconds = Math.max(1, Math.round((Date.now() - voiceStartedAt) / 1000));
        setVoiceRecordLabel(MIC_ICON, '話しなおす');
        $('#voiceRecordStatus').classList.remove('is-recording');
        var doneMessage = '録音できました（約' + seconds + '秒）。内容を確認して「この内容で予定を作る」を押してください。';
        $('#voiceRecordStatus').textContent = voiceAutoStopped
          ? '1回の録音は3分までのため、自動的に止めました。' + doneMessage
          : doneMessage;
        $('#btnCreateVoiceEntries').hidden = false;
      });
      voiceRecorder.start();
      setVoiceRecordLabel(STOP_ICON, '話し終わる');
      $('#voiceRecordStatus').classList.add('is-recording');
      $('#voiceRecordStatus').textContent = '● 録音中… 0:00';
      $('#btnCreateVoiceEntries').hidden = true;
      stopVoiceTimer();
      voiceTimerInterval = setInterval(function () {
        var elapsed = Date.now() - voiceStartedAt;
        if (elapsed >= VOICE_MAX_MS) {
          voiceAutoStopped = true;
          if (voiceRecorder && voiceRecorder.state === 'recording') voiceRecorder.stop();
          return;
        }
        $('#voiceRecordStatus').textContent = '● 録音中… ' + formatVoiceElapsed(elapsed) + ' / ' + formatVoiceElapsed(VOICE_MAX_MS);
      }, 500);
    }).catch(function () {
      $('#voiceRecordStatus').textContent = 'マイクを使えませんでした（許可されているか確認してください）。';
    });
  }

  function handleCreateVoiceEntries() {
    if (!voiceBlob) { $('#voiceEntryStatus').textContent = '先に録音してください。'; return; }
    var user = loadCurrentUser();
    var meta = { notes: $('#voiceNotes').value.trim(), author: (user && user.name) || '', email: (user && user.email) || '' };
    $('#btnCreateVoiceEntries').disabled = true;
    $('#voiceEntryStatus').textContent = 'AIが内容を確認しています…（数十秒かかることがあります）';
    createVoiceEntries(state.trip.id, state.voiceEntryMultiDay ? null : state.selectedDate, voiceBlob, meta).then(function () {
      return refreshTrip();
    }).then(function () {
      $('#btnCreateVoiceEntries').disabled = false;
      showScreen('tripDetail');
      renderDaySection();
    }).catch(function (e) {
      var msg = (e && e.message) || '';
      $('#btnCreateVoiceEntries').disabled = false;
      if (msg === 'server_not_configured') $('#voiceEntryStatus').textContent = '音声入力はまだ使えません（サーバー側の設定が必要です）。';
      else if (msg === 'rate_limited') $('#voiceEntryStatus').textContent = '少し時間をおいてからもう一度お試しください。';
      else if (msg === 'trip_dates_required') $('#voiceEntryStatus').textContent = '複数日をまとめて記録するには、旅行の出発日・帰着日（2日以上）を設定してください。';
      else if (msg === 'invalid_model_output' || msg === 'upstream_error') $('#voiceEntryStatus').textContent = 'うまく処理できませんでした。もう一度お試しください。';
      else if (msg === 'login_required' || msg === 'premium_required' || msg === 'quota_exceeded') {
        $('#voiceEntryStatus').textContent = '';
        openVoiceEntryForm(state.voiceEntryMultiDay);
      }
      else $('#voiceEntryStatus').textContent = '失敗しました。もう一度お試しください。';
    });
  }

  // 「この内容で予定を作る」：決まった形ならAIを使わず無料で取り込み、そうでなければAIで整理する
  function handleCreateTextEntries() {
    var text = $('#textMemoInput').value.trim();
    if (!text) { $('#textEntryStatus').textContent = '先にスケジュールやメモを入力してください。'; return; }
    var dates = Core.allDatesForTrip(state.trip, state.blocks).filter(function (d) { return d; });
    var parsed = Core.parseMemo(text, dates, state.voiceEntryMultiDay ? '' : state.selectedDate);
    if (parsed.ok) { importMemoWithoutAi(parsed); return; }
    if (!confirm('決まった形（「10時 新宿」のように時刻で始まる行）になっていないので、AIで整理します（今月のAIの回数を1回使います）。よろしいですか？')) {
      $('#textEntryStatus').textContent = '時刻で始まる行の形に直すと、AIを使わず無料で取り込めます。';
      return;
    }
    organizeMemoWithAi(text);
  }

  function importMemoWithoutAi(parsed) {
    var user = loadCurrentUser();
    $('#btnCreateTextEntries').disabled = true;
    $('#textEntryStatus').textContent = 'AIを使わずに取り込んでいます…（無料）';
    api('/trips/' + encodeURIComponent(state.trip.id) + '/memo-blocks', 'POST', { blocks: parsed.blocks, author: (user && user.name) || '' })
      .then(function () { return refreshTrip(); })
      .then(function () {
        $('#btnCreateTextEntries').disabled = false;
        if (parsed.blocks[0] && parsed.blocks[0].date) state.selectedDate = parsed.blocks[0].date;
        showScreen('tripDetail');
        renderTripDetail();
      })
      .catch(function () {
        $('#btnCreateTextEntries').disabled = false;
        $('#textEntryStatus').textContent = '取り込みに失敗しました。もう一度お試しください。';
      });
  }

  function organizeMemoWithAi(text) {
    text = text || $('#textMemoInput').value.trim();
    if (!text) { $('#textEntryStatus').textContent = '先にスケジュールやメモを入力してください。'; return; }
    if (!requireAiReady()) return;
    var user = loadCurrentUser();
    var meta = { notes: $('#voiceNotes').value.trim(), author: (user && user.name) || '', email: (user && user.email) || '' };
    $('#btnCreateTextEntries').disabled = true;
    $('#btnOrganizeMemoAi').disabled = true;
    $('#textEntryStatus').textContent = 'AIが内容を確認しています…';
    createTextEntries(state.trip.id, state.voiceEntryMultiDay ? null : state.selectedDate, text, meta).then(function () {
      return refreshTrip();
    }).then(function () {
      $('#btnCreateTextEntries').disabled = false;
      $('#btnOrganizeMemoAi').disabled = false;
      showScreen('tripDetail');
      renderDaySection();
    }).catch(function (e) {
      var msg = (e && e.message) || '';
      $('#btnCreateTextEntries').disabled = false;
      $('#btnOrganizeMemoAi').disabled = false;
      if (msg === 'server_not_configured') $('#textEntryStatus').textContent = 'この機能はまだ使えません（サーバー側の設定が必要です）。';
      else if (msg === 'rate_limited') $('#textEntryStatus').textContent = '少し時間をおいてからもう一度お試しください。';
      else if (msg === 'trip_dates_required') $('#textEntryStatus').textContent = '複数日をまとめて記録するには、旅行の出発日・帰着日（2日以上）を設定してください。';
      else if (msg === 'invalid_model_output' || msg === 'upstream_error') $('#textEntryStatus').textContent = 'うまく処理できませんでした。もう一度お試しください。';
      else if (msg === 'premium_required' || msg === 'quota_exceeded') {
        $('#textEntryStatus').textContent = '今月のAIでの整理の回数を使い切りました。「10時 新宿」のように時刻で始まる行の形にすると、AIを使わず無料で取り込めます。';
      }
      else if (msg === 'login_required') { state.pendingMemoText = text; openLogin('voiceEntryForm'); }
      else $('#textEntryStatus').textContent = '失敗しました。もう一度お試しください。';
    });
  }

  function statCard(label, value) {
    return '<div class="stat-card"><div class="lbl">' + escapeHtml(label) + '</div><div class="val">' + escapeHtml(value) + '</div></div>';
  }

  function renderDayTabs() {
    var dates = Core.allDatesForTrip(state.trip, state.blocks);
    var el = $('#dayTabs');
    if (!dates.length) { el.innerHTML = ''; return; }
    el.innerHTML = dates.map(function (d) {
      var on = d === state.selectedDate;
      return '<button class="day-tab' + (on ? ' on' : '') + '" data-date="' + escapeHtml(d) + '">' + escapeHtml(Core.dayLabel(state.trip, d)) + '</button>';
    }).join('');
    $all('.day-tab', el).forEach(function (b) {
      b.addEventListener('click', function () {
        state.selectedDate = b.dataset.date;
        renderDayTabs();
        renderDaySection();
      });
    });
  }

  function currentDayBlocks() {
    var byDate = Core.groupBlocksByDate(state.blocks);
    return byDate[state.selectedDate || ''] || [];
  }

  // 画面の左端（EDGE_SWIPE_BACK_PX以内）から始まったスワイプだけを「戻る」操作として扱うための
  // しきい値。iOSのエッジスワイプ相当の操作を、タイムライン上の日タブ切り替えスワイプ（どこから
  // 始めてもよい）と区別するために使う。日タブスワイプ側は、この範囲から始まったタッチを
  // 「戻る」操作に譲って自分では反応しないようにしている（initDaySwipe参照）。
  var EDGE_SWIPE_BACK_PX = 24;

  // 日タブを左右スワイプで切り替える。タイムライン上での横方向の指の動きを見て、
  // 縦スクロールと誤認しないよう「最初にどちらの向きに動いたか」で一度だけ判定する。
  // Blockの並べ替え・記録の移動ドラッグは持ち手（.block-drag-handle / .entry-drag-handle）
  // から始まる操作なので、そこから始まったタッチはスワイプの対象にしない。
  // 画面左端から始まったタッチも対象にしない（そちらは「戻る」操作、initEdgeSwipeBack参照）。
  var daySwipeState = null;
  function initDaySwipe() {
    var el = $('#timeline');

    el.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { daySwipeState = null; return; }
      if (e.target.closest('.block-drag-handle, .entry-drag-handle, a, video, button, input, textarea, select')) {
        daySwipeState = null;
        return;
      }
      var t = e.touches[0];
      if (t.clientX <= EDGE_SWIPE_BACK_PX) { daySwipeState = null; return; }
      // 「最初にどちらの向きに動いたか判定するまでの数px」の間はpreventDefaultしていないため、
      // 指が斜めに動いただけでもその間にページが数px縦スクロールしてしまうことがある
      // （横スワイプのつもりが、判定後に見た目がわずかにずれる不具合の原因）。横方向と判定できた
      // 時点で、その間にずれた分のスクロール位置を元に戻す。
      daySwipeState = { startX: t.clientX, startY: t.clientY, startScrollY: window.scrollY, decided: false, horizontal: false };
    }, { passive: true });

    el.addEventListener('touchmove', function (e) {
      if (!daySwipeState || e.touches.length !== 1) return;
      var t = e.touches[0];
      var dx = t.clientX - daySwipeState.startX;
      var dy = t.clientY - daySwipeState.startY;
      if (!daySwipeState.decided && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
        daySwipeState.decided = true;
        daySwipeState.horizontal = Math.abs(dx) > Math.abs(dy) * 1.5;
        if (daySwipeState.horizontal && window.scrollY !== daySwipeState.startScrollY) {
          window.scrollTo(window.scrollX, daySwipeState.startScrollY);
        }
      }
      if (daySwipeState.decided && daySwipeState.horizontal) e.preventDefault();
    }, { passive: false });

    el.addEventListener('touchend', function (e) {
      if (!daySwipeState) return;
      var ds = daySwipeState;
      daySwipeState = null;
      if (!ds.decided || !ds.horizontal) return;
      var t = e.changedTouches[0];
      var dx = t.clientX - ds.startX;
      if (Math.abs(dx) < 60) return;
      goToAdjacentDay(dx < 0 ? 1 : -1);
    });

    el.addEventListener('touchcancel', function () { daySwipeState = null; });
  }

  // 画面左端からのスワイプで「戻る」操作にする（iOSのエッジスワイプ相当）。マイログ画面・
  // 旅行詳細画面（日タブがどれを選んでいても、そこから直接ホームへ戻れる）の両方で使う共通処理。
  var edgeSwipeBackState = null;
  function initEdgeSwipeBack(el, onBack) {
    if (!el) return;

    el.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { edgeSwipeBackState = null; return; }
      var t = e.touches[0];
      if (t.clientX > EDGE_SWIPE_BACK_PX) { edgeSwipeBackState = null; return; }
      edgeSwipeBackState = { startX: t.clientX, startY: t.clientY, decided: false, horizontal: false };
    }, { passive: true });

    el.addEventListener('touchmove', function (e) {
      if (!edgeSwipeBackState || e.touches.length !== 1) return;
      var t = e.touches[0];
      var dx = t.clientX - edgeSwipeBackState.startX;
      var dy = t.clientY - edgeSwipeBackState.startY;
      if (!edgeSwipeBackState.decided && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
        edgeSwipeBackState.decided = true;
        edgeSwipeBackState.horizontal = Math.abs(dx) > Math.abs(dy) * 1.5;
      }
      if (edgeSwipeBackState.decided && edgeSwipeBackState.horizontal) e.preventDefault();
    }, { passive: false });

    el.addEventListener('touchend', function (e) {
      if (!edgeSwipeBackState) return;
      var es = edgeSwipeBackState;
      edgeSwipeBackState = null;
      if (!es.decided || !es.horizontal) return;
      var t = e.changedTouches[0];
      var dx = t.clientX - es.startX;
      if (dx < 60) return; // 左→右に一定以上動いたときだけ
      onBack();
    });

    el.addEventListener('touchcancel', function () { edgeSwipeBackState = null; });
  }

  function goToAdjacentDay(delta) {
    var dates = Core.allDatesForTrip(state.trip, state.blocks);
    var idx = dates.indexOf(state.selectedDate);
    if (idx === -1) return;
    var nextIdx = idx + delta;
    if (nextIdx < 0 || nextIdx >= dates.length) return; // 最初・最後の日では何もしない
    state.selectedDate = dates[nextIdx];
    renderDayTabs();
    renderDaySection();
    var activeTab = $('#dayTabs .day-tab.on');
    if (activeTab) activeTab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  function renderDaySection() {
    applyTripZones();
    $('#dayTitle').textContent = Core.dayLabel(state.trip, state.selectedDate) + 'のきろく';
    renderTimeline(currentDayBlocks());
    renderDayWeather();
    renderVoiceTranscript();
  }

  // 音声でまとめて記録したときの文字起こしを、その日の記録の下に折りたたみで表示する
  function renderVoiceTranscript() {
    var info = findDayInfo(state.selectedDate);
    var text = info && info.voiceTranscript ? info.voiceTranscript : '';
    $('#voiceTranscriptBox').hidden = !text;
    $('#voiceTranscriptText').textContent = text;
  }

  // ---------- 日ごとの場所・天気 ----------
  function findDayInfo(date) {
    return (state.days || []).filter(function (d) { return d.date === date; })[0] || null;
  }

  function renderDayWeather() {
    var btn = $('#dayWeather');
    var editBtn = $('#btnEditWeather');
    $('#weatherEditPanel').hidden = true;
    if (!state.selectedDate) { btn.hidden = true; editBtn.hidden = true; return; }
    btn.hidden = false;
    var info = findDayInfo(state.selectedDate);
    var hasWeather = info && info.weatherCode !== null && info.weatherCode !== undefined;
    if (hasWeather) {
      btn.classList.add('has-weather');
      var label = Core.weatherLabel(info.weatherCode, info.precipSum);
      var temps = (info.tempMax !== null && info.tempMax !== undefined) ? Math.round(info.tempMax) + '℃/' + Math.round(info.tempMin) + '℃' : '';
      btn.innerHTML = escapeHtml(info.place) + '　' + escapeHtml(label) + ' ' + escapeHtml(temps)
        + (info.isForecast ? ' <span class="forecast-mark">（予報）</span>' : '')
        + (info.weatherManual ? ' <span class="forecast-mark">（手動修正）</span>' : '');
    } else if (info && info.place) {
      btn.classList.remove('has-weather');
      btn.textContent = escapeHtml(info.place) + '（天気取得中…）';
    } else {
      btn.classList.remove('has-weather');
      btn.textContent = '＋ 場所を設定';
    }
    btn.onclick = function () { promptDayPlace(); };
    // 天気が取れている日だけ、手動修正ボタンを出す（場所未設定の日は修正のしようがない）
    editBtn.hidden = !hasWeather;
    editBtn.onclick = function () { openWeatherEditPanel(info); };
  }

  function openWeatherEditPanel(info) {
    var panel = $('#weatherEditPanel');
    $('#weatherEditCode').value = String(info.weatherCode);
    $('#weatherEditMax').value = (info.tempMax !== null && info.tempMax !== undefined) ? Math.round(info.tempMax) : '';
    $('#weatherEditMin').value = (info.tempMin !== null && info.tempMin !== undefined) ? Math.round(info.tempMin) : '';
    $('#weatherEditStatus').textContent = '';
    panel.hidden = false;
  }

  function saveWeatherEdit() {
    if (!state.trip || !state.selectedDate) return;
    var status = $('#weatherEditStatus');
    var weatherCode = Number($('#weatherEditCode').value);
    var maxVal = $('#weatherEditMax').value.trim();
    var minVal = $('#weatherEditMin').value.trim();
    var payload = { weatherCode: weatherCode };
    if (maxVal !== '') payload.tempMax = Number(maxVal);
    if (minVal !== '') payload.tempMin = Number(minVal);
    status.textContent = '保存中…';
    api('/trips/' + encodeURIComponent(state.trip.id) + '/days/' + encodeURIComponent(state.selectedDate) + '/weather', 'PATCH', payload)
      .then(function () { return refreshTrip(); })
      .then(function () {
        $('#weatherEditPanel').hidden = true;
        renderDayWeather();
      })
      .catch(function () { status.textContent = '保存に失敗しました。もう一度お試しください。'; });
  }

  function promptDayPlace() {
    if (!state.trip || !state.selectedDate) return;
    var existing = findDayInfo(state.selectedDate);
    var place = prompt('この日の場所（市区町村名など）を入力してください。天気・気温を自動で取得します。', existing ? existing.place : '');
    if (place === null) return;
    place = place.trim();
    if (!place) return;
    var btn = $('#dayWeather');
    btn.textContent = '取得中…';
    api('/trips/' + encodeURIComponent(state.trip.id) + '/days/' + encodeURIComponent(state.selectedDate), 'PUT', { place: place })
      .then(function () { return refreshTrip(); })
      .then(function () { renderDayWeather(); })
      .catch(function () {
        alert('場所が見つからなかったか、天気の取得に失敗しました。地名を変えて試してください。');
        renderDayWeather();
      });
  }

  // タイムゾーンの日本語名（例：「英国夏時間」「ハワイ・アリューシャン標準時」）
  function zoneDisplayName(tz, ymd) {
    try {
      var d = Core.parseDate(ymd) || new Date();
      var part = new Intl.DateTimeFormat('ja-JP', { timeZone: tz, timeZoneName: 'long' }).formatToParts(d)
        .filter(function (x) { return x.type === 'timeZoneName'; })[0];
      return part ? part.value : tz;
    } catch (e) { return tz; }
  }

  function renderZoneDivider(block, base) {
    var div = document.createElement('div');
    div.className = 'zone-divider';
    var from = base._tz === 'Asia/Tokyo' ? '日本' : '出発地';
    div.textContent = '🕒 ここから現地時間（' + zoneDisplayName(block._tz, block.date) + '・' + from + 'との時差 ' +
      Core.offsetDiffText(block._offset - base._offset) + '）';
    return div;
  }

  // ---------- 時差（docs/adr/0009） ----------
  // 予定ごとのタイムゾーンは、記録の地図の場所（座標がすぐ分かるものだけ）と、日ごとの場所（天気の場所）から
  // Worker（/timezone）に聞いて決める。旅行を開いたあと裏で調べ、分かったら並びと区切りを描き直す。
  // 結果は端末にも保存するので、2回目からは通信しない。
  var TZ_CACHE_KEY = 'tabilog:tz-cache';
  var DEVICE_TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } })();

  function applyTripZones() {
    if (!state.trip) return;
    var info = state.zoneInfo || { byBlock: {}, byDate: {} };
    Core.applyBlockZones(state.blocks, Core.assignBlockZones(state.blocks, info.byBlock, info.byDate, DEVICE_TZ));
  }

  function timezoneAt(lat, lng, cache) {
    var key = lat.toFixed(2) + ',' + lng.toFixed(2);
    if (cache[key]) return Promise.resolve(cache[key]);
    return api('/timezone?lat=' + lat.toFixed(4) + '&lng=' + lng.toFixed(4)).then(function (res) {
      if (res && res.timezone) cache[key] = res.timezone;
      return cache[key] || '';
    }).catch(function () { return ''; });
  }

  function loadTripZones() {
    if (!state.trip || !API_BASE) return Promise.resolve();
    var tripId = state.trip.id;
    var tzCache, geoCache;
    try { tzCache = JSON.parse(localStorage.getItem(TZ_CACHE_KEY) || '{}'); } catch (e) { tzCache = {}; }
    try { geoCache = JSON.parse(localStorage.getItem(GEOCODE_CACHE_KEY) || '{}'); } catch (e) { geoCache = {}; }
    var byBlock = {}, byDate = {};
    var dayJobs = (state.days || []).filter(function (d) { return typeof d.lat === 'number' && typeof d.lon === 'number'; })
      .map(function (d) { return timezoneAt(d.lat, d.lon, tzCache).then(function (tz) { if (tz) byDate[d.date] = tz; }); });
    var blockJobs = (state.blocks || []).map(function (b) {
      var q = Core.replayPlaceQuery(b);
      if (!q) return null;
      var c = geoCache[q];
      var coords = c && c.lat !== undefined ? Promise.resolve(c)
        : api('/geocode?quick=1&q=' + encodeURIComponent(q)).then(function (res) {
            if (res && res.found) { geoCache[q] = { lat: res.lat, lng: res.lng, at: Date.now() }; return geoCache[q]; }
            return null;
          }).catch(function () { return null; });
      return coords.then(function (p) {
        if (!p) return;
        return timezoneAt(p.lat, p.lng, tzCache).then(function (tz) { if (tz) byBlock[b.id] = tz; });
      });
    }).filter(Boolean);
    return Promise.all(dayJobs.concat(blockJobs)).then(function () {
      try { localStorage.setItem(TZ_CACHE_KEY, JSON.stringify(tzCache)); } catch (e) {}
      try { localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(geoCache)); } catch (e) {}
      if (!state.trip || state.trip.id !== tripId) return;
      var next = { byBlock: byBlock, byDate: byDate };
      if (JSON.stringify(next) === JSON.stringify(state.zoneInfo)) return;
      state.zoneInfo = next;
      if ($('.screen.active') && $('.screen.active').dataset.screen === 'tripDetail') renderDaySection();
    });
  }

  function renderTimeline(blocks) {
    var el = $('#timeline');
    el.innerHTML = '';
    if (!blocks.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'この日の記録はまだありません。下のボタンから追加できます。';
      el.appendChild(empty);
    }
    // 時差の違う場所に移ったところに「ここから現地時間（時差）」の区切りを入れる（docs/adr/0009）。
    // この日の最初の予定は、旅行全体の並びで直前の予定と比べる（前の日から続く移動のため）。
    var all = Core.sortBlocks(state.blocks);
    var base = all.filter(function (b) { return typeof b._offset === 'number'; })[0];
    var prevOffset = null;
    if (blocks.length) {
      var at = all.indexOf(blocks[0]);
      for (var i = at - 1; i >= 0; i--) { if (typeof all[i]._offset === 'number') { prevOffset = all[i]._offset; break; } }
    }
    blocks.forEach(function (block) {
      if (base && typeof block._offset === 'number' && typeof prevOffset === 'number' && block._offset !== prevOffset) {
        el.appendChild(renderZoneDivider(block, base));
      }
      if (typeof block._offset === 'number') prevOffset = block._offset;
      el.appendChild(renderBlockEl(block));
    });
    var addBtn = document.createElement('button');
    addBtn.className = 'block-add';
    addBtn.innerHTML = plusIcon() + '<span>予定を追加</span>';
    addBtn.addEventListener('click', function () { openBlockForm(null); });
    el.appendChild(addBtn);

    var voiceBtn = document.createElement('button');
    voiceBtn.className = 'block-add';
    voiceBtn.innerHTML = MIC_ICON + '<span>音声・メモでまとめて記録する</span>';
    // addEventListenerはハンドラーにクリックのEvent引数を渡すため、openVoiceEntryFormへ
    // そのまま参照を渡すとEventがmultiDay引数に化けてしまう（常にtruthy＝複数日モード扱いに
    // なるバグの元）。必ずラップして呼ぶ。
    voiceBtn.addEventListener('click', function () { openVoiceEntryForm(false); });
    el.appendChild(voiceBtn);

    // 「複数日をまとめて記録する」（DAY30〜）：日タブを選ばず旅行全体に対して話す・貼り付ける
    var multiDayBtn = document.createElement('button');
    multiDayBtn.className = 'block-add';
    multiDayBtn.innerHTML = MIC_ICON + '<span>複数日をまとめて記録する</span>';
    multiDayBtn.addEventListener('click', function () { openVoiceEntryForm(true); });
    el.appendChild(multiDayBtn);
  }

  var DRAG_HANDLE_ICON = '<svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><circle cx="6" cy="5" r="1.4"/><circle cx="14" cy="5" r="1.4"/><circle cx="6" cy="10" r="1.4"/><circle cx="14" cy="10" r="1.4"/><circle cx="6" cy="15" r="1.4"/><circle cx="14" cy="15" r="1.4"/></svg>';
  var MOVE_ICON = '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10h12M11 6l4 4-4 4"/></svg>';
  var ALBUM_PLAY_ICON = '<svg width="26" height="26" viewBox="0 0 20 20" fill="currentColor"><path d="M6.5 4.5v11l9-5.5z"/></svg>';
  var SETTLE_ARROW_ICON = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10h13M11 6l5 4-5 4"/></svg>';

  function renderBlockEl(block) {
    var wrap = document.createElement('div');
    wrap.className = 'block';
    wrap.dataset.blockId = block.id;

    var head = document.createElement('div');
    head.className = 'block-head';
    head.innerHTML =
      // 時刻ありのBlockは常にその時刻の位置に固定するため、持ち手（ドラッグでの並べ替え）は
      // 時刻未設定のBlockにだけ出す
      (!block.time ? '<button type="button" class="block-drag-handle" aria-label="ならべかえる">' + DRAG_HANDLE_ICON + '</button>' : '') +
      (block.time ? '<span class="block-time">' + escapeHtml(block.time) + '</span>' : '') +
      '<span class="block-label">' + escapeHtml(block.label || Core.categoryLabel(block.category)) + '</span>' +
      '<span class="block-cat" style="background:color-mix(in oklch,' + Core.categoryColor(block.category) + ' 18%, white);color:' + Core.categoryColor(block.category) + '">' + escapeHtml(Core.categoryLabel(block.category)) + '</span>' +
      (block.category === 'transport' && (block.transport || block.moveMinutes)
        ? '<span class="block-move">' + (block.transport ? transportIconSvg(block.transport, 13) : '') +
          escapeHtml([Core.transportLabel(block.transport), block.moveMinutes ? '約' + Core.minutesText(block.moveMinutes) : ''].filter(Boolean).join('・')) + '</span>'
        : '');
    head.addEventListener('click', function (e) {
      if (e.target.closest('.block-drag-handle')) return;
      openBlockForm(block);
    });
    wrap.appendChild(head);

    var entriesWrap = document.createElement('div');
    entriesWrap.className = 'entries';
    (block.entries || []).forEach(function (entry) {
      entriesWrap.appendChild(renderEntryEl(block, entry));
    });
    wrap.appendChild(entriesWrap);

    var addEntryBtn = document.createElement('button');
    addEntryBtn.className = 'entry-add';
    addEntryBtn.innerHTML = plusIcon() + '<span>' + ((block.entries || []).length ? '別の記録を追加（別行動など）' : '記録を追加') + '</span>';
    addEntryBtn.addEventListener('click', function (e) { e.stopPropagation(); openEntryForm(block.id, null); });
    wrap.appendChild(addEntryBtn);

    return wrap;
  }

  // ---------- Blockの並べ替え（ドラッグ、時刻未設定のBlockだけ） ----------
  // 「感覚的に引っ張って場所を変えたい」という要望より。時刻ありのBlockは常にその時刻の
  // 位置で固定したいので、持ち手（.block-drag-handle）自体を時刻未設定のBlockにしか出していない。
  // ドラッグ中は他のBlockは動かさず、挿入位置に細い線（インジケーター）を出すだけにしてある
  // （Blockの高さが写真の枚数などでまちまちなため、他要素を仮に動かす方式より確実に動く）。
  var blockDragState = null;

  function initBlockDragReorder() {
    var timelineEl = $('#timeline');

    timelineEl.addEventListener('pointerdown', function (e) {
      var handle = e.target.closest('.block-drag-handle');
      if (!handle) return;
      var draggedEl = handle.closest('.block');
      if (!draggedEl) return;
      e.preventDefault();

      var rect = draggedEl.getBoundingClientRect();
      // 時刻ありのBlockは並べ替えの対象外（常に時刻順で固定）。持ち手が出ているBlock
      // （＝時刻なしのBlock）同士でだけ順番を入れ替えられるようにする。
      var draggableBlocks = Array.prototype.slice.call(timelineEl.querySelectorAll('.block')).filter(function (el) { return el.querySelector('.block-drag-handle'); });
      var siblings = draggableBlocks.filter(function (el) { return el !== draggedEl; });
      var addBtn = timelineEl.querySelector('.block-add');
      var originalOrder = draggableBlocks.map(function (el) { return el.dataset.blockId; });

      var indicator = document.createElement('div');
      indicator.className = 'block-drop-indicator';
      timelineEl.insertBefore(indicator, draggedEl);

      draggedEl.classList.add('dragging');
      draggedEl.style.width = rect.width + 'px';
      draggedEl.style.left = rect.left + 'px';
      draggedEl.style.top = rect.top + 'px';

      blockDragState = {
        handle: handle, draggedEl: draggedEl, pointerId: e.pointerId, offsetY: e.clientY - rect.top,
        siblings: siblings, addBtn: addBtn, indicator: indicator, originalOrder: originalOrder
      };
      handle.setPointerCapture(e.pointerId);
    });

    timelineEl.addEventListener('pointermove', function (e) {
      if (!blockDragState || e.pointerId !== blockDragState.pointerId) return;
      e.preventDefault();
      blockDragState.draggedEl.style.top = (e.clientY - blockDragState.offsetY) + 'px';

      var target = null;
      for (var i = 0; i < blockDragState.siblings.length; i++) {
        var r = blockDragState.siblings[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) { target = blockDragState.siblings[i]; break; }
      }
      timelineEl.insertBefore(blockDragState.indicator, target || blockDragState.addBtn);
    });

    function endBlockDrag(e) {
      if (!blockDragState || e.pointerId !== blockDragState.pointerId) return;
      var ds = blockDragState;
      blockDragState = null;
      ds.handle.releasePointerCapture(ds.pointerId);
      ds.draggedEl.classList.remove('dragging');
      ds.draggedEl.style.top = '';
      ds.draggedEl.style.left = '';
      ds.draggedEl.style.width = '';
      timelineEl.insertBefore(ds.draggedEl, ds.indicator);
      ds.indicator.remove();

      var finalOrder = Array.prototype.slice.call(timelineEl.querySelectorAll('.block'))
        .filter(function (el) { return el.querySelector('.block-drag-handle'); })
        .map(function (el) { return el.dataset.blockId; });
      if (finalOrder.join(',') !== ds.originalOrder.join(',')) persistBlockOrder(finalOrder);
    }
    timelineEl.addEventListener('pointerup', endBlockDrag);
    timelineEl.addEventListener('pointercancel', endBlockDrag);
  }

  function persistBlockOrder(blockIds) {
    if (!state.trip || !state.selectedDate) return;
    api('/trips/' + encodeURIComponent(state.trip.id) + '/days/' + encodeURIComponent(state.selectedDate) + '/blocks/reorder', 'PATCH', { blockIds: blockIds })
      .then(function () {
        // 保存自体はここで成功している。このあとの再取得・再描画で失敗しても
        // 「保存に失敗した」と誤って伝えないよう、ここでは分けてcatchする
        return refreshTrip().then(renderDaySection).catch(function (e) {
          console.error('reorder: refresh/render failed after save succeeded', e);
          renderDaySection();
        });
      })
      .catch(function () {
        alert('並べ替えの保存に失敗しました。もう一度お試しください。');
        renderDaySection();
      });
  }

  function renderEntryEl(block, entry) {
    var card = document.createElement('div');
    card.className = 'entry-card' + (block.category === 'lodging' ? ' lodging' : '');
    card.dataset.entryId = entry.id;
    card.dataset.blockId = block.id;

    var photosHtml = (entry.photoIds || []).length
      ? '<div class="entry-photos">' + entry.photoIds.map(function (id) {
          return '<div class="entry-photo" data-photo-id="' + escapeHtml(id) + '" style="background-image:url(\'' + escapeHtml(photoUrl(id)) + '\')"></div>';
        }).join('') + '</div>'
      : '';

    // 動画も写真と同じ粒度（正方形のタイル）で並べる。タップすると動画ライトボックスを開く
    // （インラインでcontrolsを出す作りだと、縦長動画がそのままの縦横比で表示されて
    // 写真の並びと見た目が揃わなかったため）。
    var videosHtml = (entry.videoIds || []).length
      ? '<div class="entry-videos">' + entry.videoIds.map(function (id) {
          return '<div class="entry-video-tile" data-video-id="' + escapeHtml(id) + '">' +
            '<video src="' + escapeHtml(photoUrl(id)) + '#t=0.1" preload="metadata" muted playsinline></video>' +
            '<div class="entry-video-play">' + ALBUM_PLAY_ICON + '</div>' +
          '</div>';
        }).join('') + '</div>'
      : '';

    var costItems = entry.costItems || [];
    var costHtml = costItems.length
      ? '<div class="cost-lines">' +
        costItems.map(function (it) {
          return '<div class="cost-line"><span>' + escapeHtml(it.label) + '</span><span>' + escapeHtml(Core.formatYen(it.amount)) + '</span></div>';
        }).join('') +
        '<div class="cost-line total"><span>計</span><span>' + escapeHtml(Core.formatYen(Core.entryCostTotal(entry))) + '</span></div>' +
        '</div>'
      : '';

    var metaBits = [];
    if (entry.waitTime) metaBits.push('<span>待ち時間 ' + escapeHtml(entry.waitTime) + '</span>');
    if (entry.mapUrl) metaBits.push('<a href="' + escapeHtml(entry.mapUrl) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">地図</a>');
    if (entry.shopUrl) metaBits.push('<a href="' + escapeHtml(entry.shopUrl) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">お店のHP</a>');
    if (entry.otherUrl) metaBits.push('<a href="' + escapeHtml(entry.otherUrl) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">リンク</a>');

    var ratingSummary = Core.ratingSummary(entry.ratings);
    var ratingHtml = ratingSummary.count
      ? '<div class="entry-rating">★ ' + ratingSummary.avg.toFixed(1) + '<span class="count">（' + ratingSummary.count + '人）</span></div>'
      : '';

    // 詳細（detail）は一覧には出さない。タップして記録編集を開けば見られる。
    // entry-card-head：別の予定へこの記録を移す用（音声入力で「予定」になってしまったものを
    // 別の予定の「記録」として移したい、という要望より）。持ち手をドラッグするか、
    // 「移動」ボタンから移動先の予定を選んでも移せる。同じ日の予定にだけ移動できる。
    card.innerHTML =
      '<div class="entry-card-head">' +
        '<button type="button" class="entry-move-btn" aria-label="別の予定に移動">' + MOVE_ICON + '<span>移動</span></button>' +
        '<button type="button" class="entry-drag-handle" aria-label="ドラッグで別の予定に移動">' + DRAG_HANDLE_ICON + '</button>' +
      '</div>' +
      '<div class="entry-move-menu" hidden></div>' +
      (entry.time ? '<div class="entry-time">' + escapeHtml(entry.time) + '</div>' : '') +
      (entry.episode ? '<div class="entry-episode">' + escapeHtml(entry.episode) + '</div>' : '') +
      (entry.comment ? '<div class="entry-comment">「' + escapeHtml(entry.comment) + '」</div>' : '') +
      photosHtml +
      videosHtml +
      '<div class="entry-author">記録：' + escapeHtml(entry.author || '匿名') + '</div>' +
      ratingHtml +
      costHtml +
      (metaBits.length ? '<div class="entry-meta">' + metaBits.join('') + '</div>' : '') +
      '<div class="entry-social" data-entry-id="' + escapeHtml(entry.id) + '">' + socialButtonsHtml('entry', entry.id) + '</div>';

    // 写真・動画をタップしたときは編集画面へ行かず、拡大表示（ライトボックス）を開く。
    // 動画は（アルバムと同じく）タイルをタップしたときだけライトボックスを開く作りにしたので、
    // 以前あった「動画の全画面再生から戻ると編集画面が勝手に開く」バグ（iOSのWKWebViewが
    // 全画面再生を閉じたときにvideo要素へ合成的なclickイベントを発生させる挙動が原因だった）も、
    // ライトボックスがentry-cardの外側にあるDOM構造になったことで併せて解消される。
    card.addEventListener('click', function (e) {
      var photoEl = e.target.closest('.entry-photo');
      if (photoEl) {
        e.stopPropagation();
        openMediaViewer(entryMediaItems(entry), Math.max(0, (entry.photoIds || []).indexOf(photoEl.dataset.photoId)));
        return;
      }
      var videoTile = e.target.closest('.entry-video-tile');
      if (videoTile) {
        e.stopPropagation();
        openMediaViewer(entryMediaItems(entry), (entry.photoIds || []).length + Math.max(0, (entry.videoIds || []).indexOf(videoTile.dataset.videoId)));
        return;
      }
      if (e.target.closest('.entry-card-head') || e.target.closest('.entry-move-menu') || e.target.closest('.entry-social')) return;
      openEntryForm(block.id, entry);
    });
    $('.entry-move-btn', card).addEventListener('click', function (e) {
      e.stopPropagation();
      toggleEntryMoveMenu(card, entry.id, block.id);
    });
    return card;
  }

  // 「移動」ボタン：同じ日の他の予定を一覧で出し、選ぶとそこへ記録を移す
  // （指でのドラッグ操作がしづらい場合の代わり）。
  function toggleEntryMoveMenu(card, entryId, currentBlockId) {
    var menu = $('.entry-move-menu', card);
    var wasOpen = !menu.hidden;
    $all('.entry-move-menu').forEach(function (m) { m.hidden = true; m.innerHTML = ''; });
    if (wasOpen) return;

    var targets = currentDayBlocks().filter(function (b) { return b.id !== currentBlockId; });
    if (!targets.length) {
      menu.innerHTML = '<p class="hint">この日には他に移動先の予定がありません。</p>';
    } else {
      menu.innerHTML = targets.map(function (b) {
        return '<button type="button" class="entry-move-target" data-block-id="' + escapeHtml(b.id) + '">' +
          (b.time ? escapeHtml(b.time) + ' ' : '') + escapeHtml(b.label || Core.categoryLabel(b.category)) +
          '</button>';
      }).join('');
      $all('.entry-move-target', menu).forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          moveEntryTo(entryId, btn.dataset.blockId);
        });
      });
    }
    menu.hidden = false;
  }

  function moveEntryTo(entryId, targetBlockId) {
    api('/entries/' + encodeURIComponent(entryId) + '/move', 'PATCH', { blockId: targetBlockId })
      .then(function () { return refreshTrip(); })
      .then(function () { renderDaySection(); })
      .catch(function () { alert('記録の移動に失敗しました。もう一度お試しください。'); });
  }

  // ---------- 記録（entry）のドラッグでの移動（別の予定へ）----------
  // Blockの並べ替え（initBlockDragReorder）と同じくpointer eventsで実装。
  // こちらは「同じリスト内での並べ替え」ではなく「別のBlockへ移す」操作なので、
  // ドラッグ中はカードを指に追従させ、指の真下にあるBlockを移動先候補としてハイライトするだけ。
  var entryDragState = null;

  function initEntryDragMove() {
    var timelineEl = $('#timeline');

    timelineEl.addEventListener('pointerdown', function (e) {
      var handle = e.target.closest('.entry-drag-handle');
      if (!handle) return;
      var draggedEl = handle.closest('.entry-card');
      if (!draggedEl) return;
      e.preventDefault();

      var rect = draggedEl.getBoundingClientRect();
      entryDragState = {
        handle: handle, draggedEl: draggedEl, pointerId: e.pointerId,
        offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top,
        width: rect.width, sourceBlockId: draggedEl.dataset.blockId, targetEl: null
      };
      draggedEl.style.width = rect.width + 'px';
      draggedEl.style.left = rect.left + 'px';
      draggedEl.style.top = rect.top + 'px';
      draggedEl.classList.add('dragging');
      handle.setPointerCapture(e.pointerId);
    });

    timelineEl.addEventListener('pointermove', function (e) {
      if (!entryDragState || e.pointerId !== entryDragState.pointerId) return;
      e.preventDefault();
      entryDragState.draggedEl.style.left = (e.clientX - entryDragState.offsetX) + 'px';
      entryDragState.draggedEl.style.top = (e.clientY - entryDragState.offsetY) + 'px';

      var under = document.elementFromPoint(e.clientX, e.clientY);
      var blockEl = under && under.closest('.block');
      if (blockEl && blockEl.dataset.blockId === entryDragState.sourceBlockId) blockEl = null;
      if (entryDragState.targetEl !== blockEl) {
        if (entryDragState.targetEl) entryDragState.targetEl.classList.remove('drop-target');
        if (blockEl) blockEl.classList.add('drop-target');
        entryDragState.targetEl = blockEl;
      }
    });

    function endEntryDrag(e) {
      if (!entryDragState || e.pointerId !== entryDragState.pointerId) return;
      var ds = entryDragState;
      entryDragState = null;
      ds.handle.releasePointerCapture(ds.pointerId);
      ds.draggedEl.classList.remove('dragging');
      ds.draggedEl.style.left = '';
      ds.draggedEl.style.top = '';
      ds.draggedEl.style.width = '';
      if (ds.targetEl) {
        ds.targetEl.classList.remove('drop-target');
        moveEntryTo(ds.draggedEl.dataset.entryId, ds.targetEl.dataset.blockId);
      }
    }
    timelineEl.addEventListener('pointerup', endEntryDrag);
    timelineEl.addEventListener('pointercancel', endEntryDrag);
  }

  function plusIcon() {
    return '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 4v12M4 10h12"/></svg>';
  }

  // 移動手段のアイコン（予定フォームのチップと、地図でふりかえるの移動アイコンで共用）。
  // 飛行機だけは進行方向に回転させるので、上（北）向きの塗りつぶしシルエットにしてある。
  var TRANSPORT_ICON_PATHS = {
    plane: '<path fill="currentColor" stroke="none" d="M12 2c.8 0 1.4.7 1.4 1.6V9l7.6 4.4v2.1l-7.6-2.3v4.5l2.2 1.7V21L12 20l-3.6 1v-1.6l2.2-1.7v-4.5L3 15.5v-2.1L10.6 9V3.6C10.6 2.7 11.2 2 12 2z"/>',
    car: '<path d="M4 12l1.8-4.6A2 2 0 0 1 7.7 6h8.6a2 2 0 0 1 1.9 1.4L20 12"/><rect x="3" y="12" width="18" height="5.5" rx="1.2"/><circle cx="7.5" cy="14.8" r="1"/><circle cx="16.5" cy="14.8" r="1"/><path d="M5.5 17.5V20M18.5 17.5V20"/>',
    taxi: '<path d="M5.5 11l1.4-4a2 2 0 0 1 1.9-1.3h6.4a2 2 0 0 1 1.9 1.3l1.4 4"/><path d="M3.5 11h17v5.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/><path d="M10 5.7V3.5h4v2.2"/><circle cx="7.5" cy="14.3" r="1"/><circle cx="16.5" cy="14.3" r="1"/><path d="M5.5 17.5V20M18.5 17.5V20"/>',
    train: '<rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 10h14"/><circle cx="9" cy="13.5" r="1"/><circle cx="15" cy="13.5" r="1"/><path d="M8.5 17l-2.5 4M15.5 17l2.5 4"/>',
    bus: '<rect x="4" y="3.5" width="16" height="14" rx="2.5"/><path d="M4 11h16M12 3.5V11"/><path d="M7 17.5V20M17 17.5V20"/><circle cx="8" cy="14.3" r="1"/><circle cx="16" cy="14.3" r="1"/>',
    walk: '<circle cx="13" cy="4.3" r="1.8"/><path d="M13 8.5 11.2 14l-2.7 7"/><path d="M11.2 14l3.3 2.6.8 4.4"/><path d="M12.6 10.2l3.6 2.6M12.6 10.2l-4 1.6"/>',
    bicycle: '<circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/><path d="M6 16l3.8-7h5.7L18 16"/><path d="M9.8 9 12.5 16H6"/><path d="M15.5 9l-1-3h-2.2"/>'
  };
  function transportIconSvg(key, size) {
    var paths = TRANSPORT_ICON_PATHS[key];
    if (!paths) return '';
    size = size || 18;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }

  // ---------- 大項目（予定）の追加・編集 ----------
  function openBlockForm(block) {
    state.editingBlockId = block ? block.id : null;
    state.formCategory = block ? block.category : 'sightseeing';
    state.formTransport = block ? (block.transport || '') : '';
    var mm = block ? (block.moveMinutes || 0) : 0;
    $('#blkMoveHours').value = mm ? Math.floor(mm / 60) : '';
    $('#blkMoveMins').value = mm ? mm % 60 : '';
    $('#blkFormTitle').textContent = block ? '予定を編集' : '予定を追加';
    $('#blkDate').value = block ? block.date : (state.selectedDate || new Date().toISOString().slice(0, 10));
    $('#blkTime').value = block ? block.time : '';
    $('#blkLabel').value = block ? block.label : '';
    $('#blkFormStatus').textContent = '';
    $('#btnDeleteBlock').hidden = !block;
    renderCategoryChips();
    renderTransportChips();
    showScreen('blockForm');
  }

  function renderCategoryChips() {
    var el = $('#blkCategoryChips');
    el.innerHTML = Core.CATEGORIES.map(function (c) {
      return '<button type="button" class="cat-chip' + (c.key === state.formCategory ? ' on' : '') + '" data-cat="' + c.key + '">' + escapeHtml(c.label) + '</button>';
    }).join('');
    $all('.cat-chip', el).forEach(function (b) {
      b.addEventListener('click', function () { state.formCategory = b.dataset.cat; renderCategoryChips(); });
    });
    // 移動手段・移動時間は、種類が「移動」のときだけ出す（以前は種類に関係なく「ここまでの移動手段」を出していた）。
    // 以前のデータで、移動以外の予定に移動手段が付いているものは、見えないまま残らないよう出しておく
    $('#blkMoveFields').hidden = !(state.formCategory === 'transport' || state.formTransport);
  }

  function renderTransportChips() {
    var el = $('#blkTransportChips');
    el.innerHTML = Core.TRANSPORTS.map(function (t) {
      return '<button type="button" class="cat-chip' + (t.key === state.formTransport ? ' on' : '') + '" data-transport="' + t.key + '">' +
        (t.key ? transportIconSvg(t.key, 14) : '') + '<span>' + escapeHtml(t.label) + '</span></button>';
    }).join('');
    $all('.cat-chip', el).forEach(function (b) {
      b.addEventListener('click', function () { state.formTransport = b.dataset.transport; renderTransportChips(); });
    });
  }

  function readMoveMinutes() {
    var h = parseInt($('#blkMoveHours').value, 10), m = parseInt($('#blkMoveMins').value, 10);
    var total = (isNaN(h) ? 0 : Math.max(0, h)) * 60 + (isNaN(m) ? 0 : Math.max(0, Math.min(59, m)));
    return Math.min(total, 14400);
  }

  function saveBlock() {
    var status = $('#blkFormStatus');
    if (!API_BASE) { status.textContent = 'サーバーが未設定のため保存できません。'; return; }
    var label = $('#blkLabel').value.trim();
    if (!label) { status.textContent = '見出しを入力してください。'; return; }
    status.textContent = '保存中…';
    var payload = {
      date: $('#blkDate').value || '',
      time: $('#blkTime').value || '',
      label: label,
      category: state.formCategory,
      transport: $('#blkMoveFields').hidden ? '' : (state.formTransport || ''),
      moveMinutes: state.formCategory === 'transport' ? readMoveMinutes() : 0
    };
    var req = state.editingBlockId
      ? api('/blocks/' + encodeURIComponent(state.editingBlockId), 'PATCH', payload)
      : api('/trips/' + encodeURIComponent(state.trip.id) + '/blocks', 'POST', payload);
    req.then(function (block) {
      return refreshTrip().then(function () {
        state.selectedDate = block.date || '';
        renderDayTabs();
        if (state.editingBlockId) {
          showScreen('tripDetail');
          renderTripDetail();
        } else {
          // 新規の予定は、続けて最初の記録を書いてもらう
          openEntryForm(block.id, null);
        }
      });
    }).catch(function () { status.textContent = '保存に失敗しました。もう一度お試しください。'; });
  }

  function deleteBlock() {
    if (!state.editingBlockId) return;
    if (!confirm('この予定と、ぶら下がる記録をすべて削除しますか？')) return;
    api('/blocks/' + encodeURIComponent(state.editingBlockId), 'DELETE').then(function () {
      return refreshTrip();
    }).then(function () {
      showScreen('tripDetail');
      renderTripDetail();
    }).catch(function () { $('#blkFormStatus').textContent = '削除に失敗しました。'; });
  }

  // ---------- 小項目（記録）の追加・編集 ----------
  function openEntryForm(blockId, entry) {
    state.entryBlockId = blockId;
    state.editingEntryId = entry ? entry.id : null;
    state.editingEntry = entry || null;
    state.formPhotos = entry ? (entry.photoIds || []).map(function (id) { return { id: id }; }) : [];
    state.formVideoIds = entry ? (entry.videoIds || []).slice() : [];
    state.pendingVideos = [];
    state.formCostItems = entry ? (entry.costItems || []).map(function (it) {
      var copy = { label: it.label, amount: it.amount };
      if (it.paidBy) copy.paidBy = it.paidBy;
      if (it.splitAmong && it.splitAmong.length) copy.splitAmong = it.splitAmong.slice();
      return copy;
    }) : [];
    $('#receiptScanStatus').textContent = '';

    $('#entFormTitle').textContent = entry ? '記録を編集' : '記録を追加';
    $('#entEpisode').value = entry ? entry.episode : '';
    $('#entComment').value = entry ? entry.comment : '';
    $('#entDetail').value = entry ? entry.detail : '';
    $('#entWaitTime').value = entry ? entry.waitTime : '';
    $('#entTime').value = entry ? entry.time : '';
    $('#entMapUrl').value = entry ? entry.mapUrl : '';
    $('#entShopUrl').value = entry ? entry.shopUrl : '';
    $('#entOtherUrl').value = entry ? entry.otherUrl : '';
    $('#entMoreFields').open = !!(entry && (entry.detail || entry.waitTime || entry.shopUrl || entry.otherUrl));
    $('#entPlaceSearch').value = '';
    $('#entMapPreview').hidden = true;
    $('#entPlaceCandidates').hidden = true;
    $('#entPlaceStatus').textContent = '';
    var loggedInUser = loadCurrentUser();
    $('#entAuthor').value = entry ? entry.author : (loggedInUser ? (loggedInUser.name || loggedInUser.email) : '');
    $('#entFormStatus').textContent = '';
    $('#btnDeleteEntry').hidden = !entry;

    renderPhotoPreview();
    renderVideoPreview();
    renderCostItems();
    renderEntryRatingSection();
    renderTravelFields(entry);
    showScreen('entryForm');
  }

  function entryFormBlock() {
    return (state.blocks || []).filter(function (b) { return b.id === state.entryBlockId; })[0] || null;
  }

  // ---------- 移動の情報（紹介文用。docs/adr/0007） ----------
  // 移動の予定の記録だけに出す。★はつけない（誰が見ても同じ事実なので、記録そのものに持つ）。
  function renderTravelFields(entry) {
    var block = entryFormBlock();
    var isMove = !!(block && block.category === 'transport');
    $('#entTravelField').hidden = !isMove;
    if (!isMove) return;
    var t = (entry && entry.travel) || {};
    $('#entTravelFrom').value = t.from || '';
    $('#entTravelTo').value = t.to || '';
    $('#entTravelCompany').value = t.company || '';
    $('#entTravelDepart').value = t.depart || '';
    $('#entTravelArrive').value = t.arrive || '';
    $('#entTravelAmount').value = typeof t.amount === 'number' ? t.amount : '';
    updateTravelDuration();
  }

  function updateTravelDuration() {
    var block = entryFormBlock();
    var all = Core.sortBlocks(state.blocks);
    var next = block ? all[all.indexOf(block) + 1] : null;
    var depOff = block ? block._offset : undefined, arrOff = next ? next._offset : undefined;
    var dep = $('#entTravelDepart').value, arr = $('#entTravelArrive').value;
    var d = Core.travelDurationText(dep, arr, depOff, arrOff);
    var info = Core.travelDuration(dep, arr, depOff, arrOff);
    var notes = [];
    if (typeof depOff === 'number' && typeof arrOff === 'number' && depOff !== arrOff) notes.push('時差' + Core.offsetDiffText(arrOff - depOff));
    if (info && info.dayShift) notes.push('到着は現地の' + (Core.dayShiftPrefix(info.dayShift) === '翌' ? '翌日' : Core.dayShiftPrefix(info.dayShift)));
    $('#entTravelDuration').textContent = d ? '所要時間：' + d + (notes.length ? '（' + notes.join('・') + '）' : '') +
      '。時刻はどちらも現地時間で入れてください。' : '時刻はどちらも現地時間で入れてください。';
  }

  function readTravelFields() {
    var amount = $('#entTravelAmount').value.trim();
    var out = {
      from: $('#entTravelFrom').value.trim(),
      to: $('#entTravelTo').value.trim(),
      company: $('#entTravelCompany').value.trim(),
      depart: $('#entTravelDepart').value || '',
      arrive: $('#entTravelArrive').value || ''
    };
    if (amount !== '' && /^\d+$/.test(amount)) out.amount = Number(amount);
    return out;
  }

  // ---------- 評価（★1〜5） ----------
  // 評価はログイン必須。閲覧・記録の追加自体はログイン不要のまま。
  // 1つの記録に、ログインした人それぞれが1つずつ評価を付けられる（自分の分だけこの画面から操作する）。
  function renderEntryRatingSection() {
    var field = $('#entRatingField');
    var entry = state.editingEntry;
    var block = entryFormBlock();
    var kind = Core.reviewKindForCategory(block ? block.category : '');
    $('#entReviewFields').hidden = true;
    if (!loginEnabled() || !entry || !kind) { field.hidden = true; return; }
    field.hidden = false;
    var user = loadCurrentUser();
    var widget = $('#entRatingWidget');
    var summary = Core.ratingSummary(entry.ratings);
    var summaryText = summary.count ? ('みんなの平均：★' + summary.avg.toFixed(1) + '（' + summary.count + '人）') : 'まだ誰も評価していません';

    if (!user) {
      widget.innerHTML = '<button type="button" class="btn ghost small" id="btnRatingLogin">ログインして評価する</button>';
      $('#btnRatingLogin').addEventListener('click', function () { openLogin('entryForm'); });
      $('#entRatingSummary').textContent = summaryText;
      return;
    }

    var mine = Core.myRatingScore(entry.ratings, user.email);
    var mineWhole = Math.round(mine); // 星タップの見た目は整数（0.1刻みの端数は微調整ボタンで付ける）
    var stars = '';
    for (var i = 1; i <= 5; i++) {
      stars += '<button type="button" class="star-btn' + (i <= mineWhole ? ' on' : '') + '" data-score="' + i + '" aria-label="★' + i + '">★</button>';
    }
    var level = Core.reviewLevelLabel(kind, mine);
    var fine = mine > 0
      ? '<div class="rating-fine">' +
        '<button type="button" class="btn ghost small" id="ratingFineMinus">－0.1</button>' +
        '<span class="rating-fine-value">★' + mine.toFixed(1) + '</span>' +
        '<button type="button" class="btn ghost small" id="ratingFinePlus">＋0.1</button>' +
        '</div>' +
        '<div class="rating-level' + (Core.isReviewPublic(mine) ? '' : ' private') + '">' + escapeHtml(level) +
        (Core.isReviewPublic(mine) ? '' : '（★3.0未満なので紹介文には出ません）') + '</div>'
      : '';
    widget.innerHTML = '<div class="stars">' + stars + '</div>' + fine;
    $all('.star-btn', widget).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var score = Number(btn.dataset.score);
        setMyRating(score === mineWhole ? 0 : score);
      });
    });
    if (mine > 0) {
      $('#ratingFineMinus', widget).addEventListener('click', function () {
        setMyRating(Math.max(1, Math.round((mine - 0.1) * 10) / 10));
      });
      $('#ratingFinePlus', widget).addEventListener('click', function () {
        setMyRating(Math.min(5, Math.round((mine + 0.1) * 10) / 10));
      });
    }
    $('#entRatingSummary').textContent = summaryText;
    renderReviewFields(kind, mine > 0 ? (Core.findMyRating(entry.ratings, user.email) || {}).review || {} : null);
  }

  // ---------- レビュー項目（紹介文用。docs/adr/0007） ----------
  // ★をつけた人だけが、自分のレビュー項目（◎〇△×・金額・立地など）を書ける。どの項目を出すかは
  // 予定の種類（ホテログ・レクログ・飯ログ）で変わる。★は押した瞬間に保存されるが、レビュー項目は
  // 「レビューを保存」を押したときに★と一緒に保存する。
  function renderReviewFields(kind, review) {
    var el = $('#entReviewFields');
    var k = Core.REVIEW_KINDS[kind];
    if (!k || !review) { el.hidden = true; return; }
    el.hidden = false;
    var gradeSelect = function (key, label) {
      return '<label class="review-row"><span>' + label + '</span><select data-review-key="' + key + '">' +
        '<option value="">―</option>' +
        Core.REVIEW_GRADES.map(function (g) { return '<option' + (review[key] === g ? ' selected' : '') + '>' + g + '</option>'; }).join('') +
        '</select></label>';
    };
    var choiceSelect = function (key, label) {
      return '<label class="review-row"><span>' + label + '</span><select data-review-key="' + key + '">' +
        '<option value="">―</option>' +
        Core.REVIEW_CHOICE_OPTIONS[key].map(function (o) { return '<option' + (review[key] === o ? ' selected' : '') + '>' + o + '</option>'; }).join('') +
        '</select></label>';
    };
    var textInput = function (key, label, placeholder, max) {
      return '<label class="review-row review-row-wide"><span>' + label + '</span><input type="text" data-review-key="' + key + '" maxlength="' + max +
        '" placeholder="' + escapeHtml(placeholder) + '" value="' + escapeHtml(review[key] || '') + '"></label>';
    };
    var unitLabel = { hotel: '泊数', activity: '回数', food: '人数' }[kind];
    var html = '<div class="review-title">' + escapeHtml(k.label) + 'のレビュー（紹介文に使います）</div>';
    html += '<div class="review-grid">' + k.grades.map(function (g) { return gradeSelect(g[0], g[1]); }).join('') +
      (k.choices || []).map(function (c) { return choiceSelect(c[0], c[1]); }).join('') + '</div>';
    html += '<div class="review-grid">' +
      '<label class="review-row"><span>金額（円）</span><input type="number" min="0" inputmode="numeric" data-review-key="amount" data-number placeholder="明細の合計" value="' + (typeof review.amount === 'number' ? review.amount : '') + '"></label>' +
      '<label class="review-row"><span>' + unitLabel + '</span><input type="number" min="1" max="365" inputmode="numeric" data-review-key="units" data-number value="' + (review.units || '') + '"></label>' +
      '</div>';
    html += textInput('access', '立地（行き方）', '例：〇〇駅から徒歩5分', 60);
    (k.texts || []).forEach(function (t) {
      var ph = { roomType: '例：ダブル・オーシャンビュー', duration: '例：2時間', bestTime: '例：夕方（夕日がきれい）', menu: '例：クロワッサン' }[t[0]] || '';
      html += textInput(t[0], t[1], ph, t[0] === 'menu' ? 200 : 60);
    });
    html += '<label class="review-row review-row-wide"><span>その他</span><textarea data-review-key="other" maxlength="300" rows="2" placeholder="例：ベッドがふかふか、浴槽あり">' + escapeHtml(review.other || '') + '</textarea></label>';
    html += '<button type="button" class="btn ghost small" id="btnSaveReview">レビューを保存</button><span class="hint review-status" id="reviewStatus"></span>';
    el.innerHTML = html;
    $('#btnSaveReview').addEventListener('click', saveMyReview);
  }

  function readReviewFields() {
    var out = {};
    $all('[data-review-key]', $('#entReviewFields')).forEach(function (input) {
      var v = input.value.trim();
      if (!v) return;
      if (input.hasAttribute('data-number')) { if (/^\d+$/.test(v)) out[input.dataset.reviewKey] = Number(v); }
      else out[input.dataset.reviewKey] = v;
    });
    return out;
  }

  function saveMyReview() {
    var user = loadCurrentUser();
    var entry = state.editingEntry;
    if (!user || !entry) return;
    var score = Core.myRatingScore(entry.ratings, user.email);
    if (!(score > 0)) return;
    var status = $('#reviewStatus');
    status.textContent = '保存中…';
    api('/entries/' + encodeURIComponent(entry.id) + '/rating', 'PUT', { raterEmail: user.email, raterName: user.name || '', score: score, review: readReviewFields() })
      .then(function () { return refreshTrip(); })
      .then(function () {
        state.editingEntry = findEntryById(entry.id);
        renderEntryRatingSection();
        $('#reviewStatus').textContent = '保存しました';
      })
      .catch(function () { status.textContent = '保存に失敗しました。もう一度お試しください。'; });
  }

  function setMyRating(score) {
    var user = loadCurrentUser();
    if (!user || !state.editingEntryId) return;
    var status = $('#entRatingSummary');
    status.textContent = '保存中…';
    var req = score > 0
      ? api('/entries/' + encodeURIComponent(state.editingEntryId) + '/rating', 'PUT', { raterEmail: user.email, raterName: user.name || '', score: score })
      : api('/entries/' + encodeURIComponent(state.editingEntryId) + '/rating', 'DELETE', { raterEmail: user.email });
    req.then(function () {
      return refreshTrip();
    }).then(function () {
      state.editingEntry = findEntryById(state.editingEntryId);
      renderEntryRatingSection();
    }).catch(function () { status.textContent = '評価の保存に失敗しました。もう一度お試しください。'; });
  }

  var ROTATE_ICON = '<svg width="11" height="11" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 8A6 6 0 1 0 16 11"/><path d="M16 4v4h-4"/></svg>';

  // 写真の並びのプレビュー。長押ししてからドラッグすると並べ替えられる（先頭の写真が、マイログなどで
  // 代表の写真になる）。すぐにドラッグにしないのは、スマホで写真の上から指でページをスクロールしたいときに
  // 誤って動かさないため。回転・削除のボタンはこれまでどおり。
  function renderPhotoPreview() {
    var el = $('#entPhotoPreview');
    el.innerHTML = '';
    state.formPhotos.forEach(function (item, idx) {
      var ph = document.createElement('div');
      ph.className = 'ph';
      ph.dataset.index = idx;
      ph.innerHTML = '<img src="' + escapeHtml(item.id ? photoUrl(item.id) : item.url) + '" draggable="false">' +
        (idx === 0 && state.formPhotos.length > 1 ? '<span class="ph-first">先頭</span>' : '') +
        '<button type="button" class="ph-rotate" aria-label="90度回す">' + ROTATE_ICON + '</button>' +
        '<button type="button" class="ph-remove" aria-label="削除">×</button>';
      ph.querySelector('.ph-remove').addEventListener('click', function () {
        if (item.url) URL.revokeObjectURL(item.url);
        state.formPhotos.splice(idx, 1);
        renderPhotoPreview();
      });
      ph.querySelector('.ph-rotate').addEventListener('click', function () {
        var btn = ph.querySelector('.ph-rotate');
        btn.disabled = true;
        if (item.id) {
          // 保存済みの写真の回転は、一度取得→回転→再アップロードしてidを差し替える
          // （このアプリに写真の上書き更新APIが無いため、新しい写真として置き換える形）
          fetch(photoUrl(item.id)).then(function (res) { return res.blob(); })
            .then(function (blob) { return rotateImageBlob(blob, 90); })
            .then(function (rotated) { return uploadPhotoBlob(rotated); })
            .then(function (up) { item.id = up.id; renderPhotoPreview(); })
            .catch(function () { btn.disabled = false; alert('写真の回転に失敗しました。もう一度お試しください。'); });
        } else {
          rotateImageBlob(item.blob, 90).then(function (rotated) {
            URL.revokeObjectURL(item.url);
            item.blob = rotated;
            item.url = URL.createObjectURL(rotated);
            renderPhotoPreview();
          });
        }
      });
      el.appendChild(ph);
    });
    $('#entPhotoOrderHint').hidden = state.formPhotos.length < 2;
  }

  // 長押し→ドラッグで並べ替え。指の下にある写真の位置へ、離したときに移す。
  var PHOTO_DRAG_HOLD_MS = 280;
  function initPhotoReorder() {
    var el = $('#entPhotoPreview');
    var drag = null; // { from, ph, startX, startY, timer, active, target }
    function thumbAt(x, y) {
      var hit = null;
      $all('.ph', el).forEach(function (ph) {
        if (drag && ph === drag.ph) return; // 動かしている写真自身は、指の下に来ているので数えない
        var r = ph.getBoundingClientRect();
        if (x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4) hit = ph;
      });
      return hit;
    }
    function clearTargets() { $all('.ph.drop-target', el).forEach(function (p) { p.classList.remove('drop-target'); }); }
    function finish(commit) {
      if (!drag) return;
      clearTimeout(drag.timer);
      if (drag.active) {
        drag.ph.classList.remove('dragging');
        drag.ph.style.transform = '';
        clearTargets();
        if (commit && drag.target !== null && drag.target !== drag.from) {
          var moved = state.formPhotos.splice(drag.from, 1)[0];
          state.formPhotos.splice(drag.target, 0, moved);
        }
        renderPhotoPreview();
      }
      drag = null;
    }
    el.addEventListener('pointerdown', function (e) {
      var ph = e.target.closest('.ph');
      if (!ph || e.target.closest('button') || state.formPhotos.length < 2) return;
      drag = { from: Number(ph.dataset.index), ph: ph, startX: e.clientX, startY: e.clientY, active: false, target: null };
      var start = function () {
        if (!drag) return;
        drag.active = true;
        drag.target = drag.from;
        ph.classList.add('dragging');
        if (navigator.vibrate) navigator.vibrate(10);
      };
      // マウスはすぐ、指は長押ししてから
      if (e.pointerType === 'mouse') start(); else drag.timer = setTimeout(start, PHOTO_DRAG_HOLD_MS);
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* 古いブラウザ */ }
    });
    el.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
      if (!drag.active) {
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) finish(false); // 長押しの前に動いた＝スクロールしたい
        return;
      }
      drag.ph.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(1.08)';
      clearTargets();
      var over = thumbAt(e.clientX, e.clientY);
      if (over && over !== drag.ph) { over.classList.add('drop-target'); drag.target = Number(over.dataset.index); }
      else if (!over) drag.target = drag.from;
    });
    el.addEventListener('pointerup', function () { finish(true); });
    el.addEventListener('pointercancel', function () { finish(false); });
    // iOSでは、ドラッグ中にページがスクロールしないよう、タッチの移動を止める（長押しの後だけ）
    el.addEventListener('touchmove', function (e) { if (drag && drag.active) e.preventDefault(); }, { passive: false });
    // 長押しでiOSの「画像を保存」メニューが出ないように
    el.addEventListener('contextmenu', function (e) { if (e.target.closest('.ph')) e.preventDefault(); });
  }

  function formatMB(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
  }

  function renderVideoPreview() {
    var el = $('#entVideoPreview');
    el.innerHTML = '';
    state.formVideoIds.forEach(function (id, idx) {
      var chip = document.createElement('div');
      chip.className = 'video-chip';
      chip.innerHTML = '<span class="name">' + escapeHtml(id) + '</span><button type="button">×</button>';
      chip.querySelector('button').addEventListener('click', function () {
        state.formVideoIds.splice(idx, 1);
        renderVideoPreview();
      });
      el.appendChild(chip);
    });
    state.pendingVideos.forEach(function (v, idx) {
      var chip = document.createElement('div');
      chip.className = 'video-chip';
      chip.innerHTML = '<span class="name">' + escapeHtml(v.name) + '</span><span class="size">' + formatMB(v.size) + '</span><button type="button">×</button>';
      chip.querySelector('button').addEventListener('click', function () {
        state.pendingVideos.splice(idx, 1);
        renderVideoPreview();
      });
      el.appendChild(chip);
    });
  }

  // 「立て替え」（誰が払った・誰と割るか）の選択パネル。旅行の参加者（trip.companions）を
  // チップで選ぶだけのシンプルな作り。チップを押すたびに全体を再描画するとパネルが
  // 閉じてしまうので、ここだけはDOMを直接書き換えて開いたままにする。
  function buildCostPayerRow(idx, row) {
    // trip.companions は「一緒に行った人」（＝自分以外）の一覧なので、これだけだと
    // 記録している本人が払った・割る人に選べない（DAY30〜、実際に「自分が入っていない」
    // という報告を受けて対応）。今の「記録した人（#entAuthor）」欄の値を本人として
    // 先頭に加える（companions側には追加しない＝「〇〇と一緒」の表示はそのまま）。
    var companions = (state.trip && state.trip.companions) || [];
    var self = $('#entAuthor').value.trim();
    var people = self && companions.indexOf(self) === -1 ? [self].concat(companions) : companions.slice();
    var panel = document.createElement('div');
    panel.className = 'cost-payer-row';
    if (!people.length) {
      panel.innerHTML = '<p class="hint">参加者が未設定です。旅行の編集画面で参加者を入力する、または「記録した人」欄に名前を入れると選べるようになります。</p>';
      return panel;
    }
    function currentItem() { return state.formCostItems[idx]; }
    function updateToggleButton() {
      var btn = row.querySelector('.cost-payer-toggle');
      var paidBy = currentItem().paidBy;
      btn.textContent = paidBy ? (paidBy + 'が立替') : '立て替えを設定';
      btn.classList.toggle('on', !!paidBy);
    }

    var payerSection = document.createElement('div');
    payerSection.className = 'cost-payer-section';
    payerSection.innerHTML = '<span class="cost-payer-label">払った人</span><div class="chip-select" data-role="payer"></div>';
    var splitSection = document.createElement('div');
    splitSection.className = 'cost-payer-section';
    splitSection.innerHTML =
      '<span class="cost-payer-label">割る人（未選択なら払った人だけ）</span>' +
      '<div class="chip-select" data-role="split"></div>' +
      '<button type="button" class="btn ghost small cost-split-even">参加者全員で均等割り</button>';
    var payerChipWrap = payerSection.querySelector('[data-role="payer"]');
    var splitChipWrap = splitSection.querySelector('[data-role="split"]');

    people.forEach(function (name) {
      var payerBtn = document.createElement('button');
      payerBtn.type = 'button';
      payerBtn.className = 'chip-option' + (currentItem().paidBy === name ? ' on' : '');
      payerBtn.textContent = name;
      payerBtn.addEventListener('click', function () {
        var item = currentItem();
        item.paidBy = (item.paidBy === name) ? '' : name;
        $all('.chip-option', payerChipWrap).forEach(function (b) { b.classList.toggle('on', b === payerBtn && !!item.paidBy); });
        updateToggleButton();
      });
      payerChipWrap.appendChild(payerBtn);

      var splitBtn = document.createElement('button');
      splitBtn.type = 'button';
      splitBtn.className = 'chip-option' + ((currentItem().splitAmong || []).indexOf(name) !== -1 ? ' on' : '');
      splitBtn.textContent = name;
      splitBtn.addEventListener('click', function () {
        var item = currentItem();
        item.splitAmong = item.splitAmong || [];
        var pos = item.splitAmong.indexOf(name);
        if (pos === -1) item.splitAmong.push(name); else item.splitAmong.splice(pos, 1);
        splitBtn.classList.toggle('on', item.splitAmong.indexOf(name) !== -1);
      });
      splitChipWrap.appendChild(splitBtn);
    });

    splitSection.querySelector('.cost-split-even').addEventListener('click', function () {
      var item = currentItem();
      item.splitAmong = people.slice();
      $all('.chip-option', splitChipWrap).forEach(function (b) { b.classList.add('on'); });
    });

    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn ghost small cost-payer-clear';
    clearBtn.textContent = '立て替えの設定を外す';
    clearBtn.addEventListener('click', function () {
      var item = currentItem();
      delete item.paidBy;
      delete item.splitAmong;
      updateToggleButton();
      panel.remove();
    });

    panel.appendChild(payerSection);
    panel.appendChild(splitSection);
    panel.appendChild(clearBtn);
    return panel;
  }

  // 費用の明細（costItems）は、基本は「個人（またはそのサブグループ）が実際に払った金額」を
  // そのまま入れる（CONTEXT.md参照）。駐車場代など全体でまとめて払ったものを人数で割りたい
  // ときは、下記「立て替え」機能で全体の金額をそのまま入れ、払った人・割る人を選ぶ
  // （以前あった「全体費用÷人数」電卓は、金額欄の意味が「個人費用」と「全体の金額」の
  // どちらか曖昧になり、立て替え機能と併用すると二重に割ってしまう事故のもとだったため廃止した）。
  // 「立て替え」（誰が払った・誰と割るか）は任意項目。触らなければ、これまでどおり
  // 「本人の個人費用」として扱われ、割り勘の精算画面（貸し借り）には出てこない。
  function renderCostItems() {
    var el = $('#entCostItems');
    el.innerHTML = '';
    state.formCostItems.forEach(function (item, idx) {
      var row = document.createElement('div');
      row.className = 'cost-item-row';
      var payerLabel = item.paidBy ? (item.paidBy + 'が立替') : '立て替えを設定';
      row.innerHTML =
        '<input type="text" placeholder="内容（例：そば）" value="' + escapeHtml(item.label) + '">' +
        '<input type="number" min="0" step="1" placeholder="円" value="' + (item.amount || '') + '">' +
        '<button type="button" aria-label="削除">×</button>' +
        '<div class="cost-item-row-actions">' +
          '<button type="button" class="cost-payer-toggle' + (item.paidBy ? ' on' : '') + '" aria-label="立て替えを設定">' + escapeHtml(payerLabel) + '</button>' +
        '</div>';
      var inputs = row.querySelectorAll('input');
      var amountInput = inputs[1];
      inputs[0].addEventListener('input', function (e) { state.formCostItems[idx].label = e.target.value; });
      amountInput.addEventListener('input', function (e) {
        state.formCostItems[idx].amount = Math.max(0, parseInt(e.target.value, 10) || 0);
        renderCostTotal();
      });
      row.querySelector('.cost-payer-toggle').addEventListener('click', function () {
        var existing = row.nextElementSibling;
        if (existing && existing.classList.contains('cost-payer-row')) { existing.remove(); return; }
        row.insertAdjacentElement('afterend', buildCostPayerRow(idx, row));
      });
      row.querySelector('[aria-label="削除"]').addEventListener('click', function () {
        state.formCostItems.splice(idx, 1);
        renderCostItems();
      });
      el.appendChild(row);
    });
    renderCostTotal();
  }

  function renderCostTotal() {
    var total = state.formCostItems.reduce(function (s, it) { return s + (it.amount || 0); }, 0);
    $('#entCostTotal').textContent = state.formCostItems.length ? '計 ' + Core.formatYen(total) : '';
  }

  // レシートの写真から読み取った内訳を費用明細欄に追加するだけで、まだ何も保存はしない。
  // 「保存」ボタンを押すまでは本人が内容を見て消す・直すことができる（AIの読み取り誤りが
  // そのままDBに残らないようにするための確認ステップ）。
  function handleScanReceipt(file) {
    var user = loadCurrentUser();
    if (!user) {
      $('#receiptScanStatus').textContent = 'ログインすると使えます。';
      return;
    }
    var status = $('#receiptScanStatus');
    status.textContent = '読み取り中…（数十秒かかることがあります）';
    $('#btnScanReceipt').disabled = true;
    fileToCompressedBlob(file, 1600, 0.85).then(function (blob) {
      return scanReceiptBlob(blob, user.email);
    }).then(function (res) {
      $('#btnScanReceipt').disabled = false;
      var items = (res && res.items) || [];
      if (!items.length) { status.textContent = '品目を読み取れませんでした。写真を変えてお試しください。'; return; }
      items.forEach(function (it) {
        state.formCostItems.push({ label: (it.label || '').trim(), amount: Math.max(0, Math.round(it.amount || 0)) });
      });
      renderCostItems();
      status.textContent = items.length + '件の明細を追加しました。内容を確認してください。';
    }).catch(function (e) {
      $('#btnScanReceipt').disabled = false;
      var msg = (e && e.message) || '';
      if (msg === 'server_not_configured') status.textContent = 'この機能はまだ使えません（サーバー側の設定が必要です）。';
      else if (msg === 'rate_limited') status.textContent = '少し時間をおいてからもう一度お試しください。';
      else if (msg === 'invalid_model_output' || msg === 'upstream_error') status.textContent = 'うまく読み取れませんでした。もう一度お試しください。';
      else if (msg === 'premium_required' || msg === 'quota_exceeded') status.textContent = '今月の利用回数の上限に達しました（音声入力・テキストメモと共通の枠です）。';
      else if (msg === 'login_required') status.textContent = 'ログインすると使えます。';
      else status.textContent = '失敗しました。もう一度お試しください。';
    });
  }

  // ---------- 場所名からの地図検索（「地図のURL」欄の入力補助） ----------
  // Google Maps Embed API（APIキーが要る）は使わず、キー不要の地図表示・検索URLの
  // 形式（.../maps?q=...&output=embed、.../maps/search/?api=1&query=...）だけを使う。
  // 以前はGoogleがいちばん上に出した場所しか選べず、違う場所だったときに選び直せなかったため、
  // Worker（/places/search）から候補を最大8件もらってプルダウンで選べるようにした。候補を選ぶと
  // その座標の地図URLを入れる（地図でふりかえるでも、その場所へぴったり移動する）。
  // 候補に無い小さなお店などのために、最後に「Googleマップで名前のまま検索」も残す。
  var placeCandidates = [];
  var PLACE_GOOGLE = 'google';

  function showPlaceMapPreview() {
    var place = $('#entPlaceSearch').value.trim();
    if (!place) return;
    var select = $('#entPlaceCandidates');
    var status = $('#entPlaceStatus');
    status.textContent = '候補を探しています…';
    select.hidden = true;
    api('/places/search?q=' + encodeURIComponent(place)).then(function (res) {
      placeCandidates = (res && res.places) || [];
      select.innerHTML = placeCandidates.map(function (p, i) {
        return '<option value="' + i + '">' + escapeHtml(p.name + (p.address ? '（' + p.address + '）' : '')) + '</option>';
      }).join('') + '<option value="' + PLACE_GOOGLE + '">候補にない場合：「' + escapeHtml(place) + '」をGoogleマップで検索</option>';
      select.hidden = false;
      status.textContent = placeCandidates.length
        ? '候補が' + placeCandidates.length + '件見つかりました。違う場所なら、上のリストから選び直してください。'
        : '候補が見つかりませんでした。Googleマップの検索結果を表示しています。';
      select.value = placeCandidates.length ? '0' : PLACE_GOOGLE;
      previewSelectedPlace();
    }).catch(function () {
      // 候補が取れなくても、これまでどおりGoogleマップの検索結果は見られるようにする
      placeCandidates = [];
      select.innerHTML = '<option value="' + PLACE_GOOGLE + '">「' + escapeHtml(place) + '」をGoogleマップで検索</option>';
      select.value = PLACE_GOOGLE;
      select.hidden = true;
      status.textContent = '';
      previewSelectedPlace();
    });
  }

  function selectedPlace() {
    var v = $('#entPlaceCandidates').value;
    return v === PLACE_GOOGLE || v === '' ? null : placeCandidates[Number(v)] || null;
  }

  // 候補を選んだときのプレビューは、地図でふりかえると同じLeaflet（OpenStreetMap）の地図にする。
  // Googleの埋め込み地図はアプリ内では指で拡大・縮小しにくかったため。ピンはドラッグでき、地図をタップしても
  // そこへ動く（候補の座標を細かく直せる。直した座標がそのまま地図URLに入る）。
  // 「Googleマップで検索」のときだけは座標が無いのでGoogleの埋め込み地図のままにし、＋/－ボタンで拡大・縮小する。
  var placeMap = null, placeMarker = null, placeFrameZoom = 16;

  function movePlacePin(latlng) {
    placeMarker.setLatLng(latlng);
    var cur = selectedPlace();
    if (cur) {
      cur.lat = Math.round(latlng.lat * 1e6) / 1e6;
      cur.lng = Math.round(latlng.lng * 1e6) / 1e6;
    }
  }

  function showPlaceFrame() {
    $('#entPlaceMap').hidden = true;
    $('#entPlaceMapHint').hidden = true;
    $('#entMapFrameWrap').hidden = false;
    var q = $('#entPlaceSearch').value.trim();
    if (q) $('#entMapPreviewFrame').src = 'https://maps.google.com/maps?q=' + encodeURIComponent(q) + '&z=' + placeFrameZoom + '&output=embed';
  }

  function zoomPlaceFrame(delta) {
    placeFrameZoom = Math.max(3, Math.min(20, placeFrameZoom + delta));
    showPlaceFrame();
  }

  function previewSelectedPlace() {
    var p = selectedPlace();
    if (!p && !$('#entPlaceSearch').value.trim()) return;
    $('#entMapPreview').hidden = false;
    if (!p) { placeFrameZoom = 16; showPlaceFrame(); return; }
    $('#entMapFrameWrap').hidden = true;
    $('#entPlaceMap').hidden = false;
    $('#entPlaceMapHint').hidden = false;
    loadLeaflet().then(function (L) {
      if (!placeMap) {
        placeMap = L.map($('#entPlaceMap'));
        placeMap.attributionControl.setPrefix(false);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        }).addTo(placeMap);
        placeMarker = L.marker([p.lat, p.lng], {
          draggable: true,
          icon: L.divIcon({ className: '', html: '<div class="place-pin"></div>', iconSize: [26, 26], iconAnchor: [13, 26] })
        }).addTo(placeMap);
        placeMarker.on('dragend', function () { movePlacePin(placeMarker.getLatLng()); });
        placeMap.on('click', function (e) { movePlacePin(e.latlng); });
      }
      placeMap.invalidateSize(); // 隠れていた要素に作った・表示し直した地図は、大きさを測り直さないと崩れる
      placeMap.setView([p.lat, p.lng], 16);
      placeMarker.setLatLng([p.lat, p.lng]);
    }).catch(function () { placeFrameZoom = 16; showPlaceFrame(); });
  }

  function useSearchedPlaceAsMapUrl() {
    var p = selectedPlace();
    var q = p ? p.lat + ',' + p.lng : $('#entPlaceSearch').value.trim();
    if (!q) return;
    $('#entMapUrl').value = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
  }

  function saveEntry() {
    var status = $('#entFormStatus');
    if (!API_BASE) { status.textContent = 'サーバーが未設定のため保存できません。'; return; }
    var author = $('#entAuthor').value.trim();
    status.textContent = '保存中…';

    var payload = {
      episode: $('#entEpisode').value.trim(),
      comment: $('#entComment').value.trim(),
      detail: $('#entDetail').value.trim(),
      costItems: state.formCostItems.filter(function (it) { return it.label.trim() || it.amount; })
        .map(function (it) {
          var out = { label: it.label.trim() || '費用', amount: it.amount || 0 };
          if (it.paidBy) out.paidBy = it.paidBy;
          if (it.splitAmong && it.splitAmong.length) out.splitAmong = it.splitAmong;
          return out;
        }),
      waitTime: $('#entWaitTime').value.trim(),
      time: $('#entTime').value || '',
      mapUrl: $('#entMapUrl').value.trim(),
      shopUrl: $('#entShopUrl').value.trim(),
      otherUrl: $('#entOtherUrl').value.trim(),
      author: author
    };
    if (!$('#entTravelField').hidden) payload.travel = readTravelFields();

    Promise.all([
      // 並べた順のまま、新しい写真だけアップロードしてidにする
      Promise.all(state.formPhotos.map(function (p) { return p.id ? Promise.resolve({ id: p.id }) : uploadPhotoBlob(p.blob); })),
      Promise.all(state.pendingVideos.map(function (v) { return uploadPhotoBlob(v.blob); }))
    ])
      .then(function (results) {
        var uploaded = results[0], uploadedVideos = results[1];
        payload.photoIds = uploaded.map(function (u) { return u.id; });
        payload.videoIds = state.formVideoIds.concat(uploadedVideos.map(function (u) { return u.id; }));
        var req = state.editingEntryId
          ? api('/entries/' + encodeURIComponent(state.editingEntryId), 'PATCH', payload)
          : api('/blocks/' + encodeURIComponent(state.entryBlockId) + '/entries', 'POST', payload);
        return req;
      })
      .then(function () {
        return refreshTrip().then(function () {
          showScreen('tripDetail');
          renderTripDetail();
        });
      })
      .catch(function () { status.textContent = '保存に失敗しました。もう一度お試しください。'; });
  }

  function deleteEntry() {
    if (!state.editingEntryId) return;
    if (!confirm('この記録を削除しますか？')) return;
    api('/entries/' + encodeURIComponent(state.editingEntryId), 'DELETE').then(function () {
      return refreshTrip();
    }).then(function () {
      showScreen('tripDetail');
      renderTripDetail();
    }).catch(function () { $('#entFormStatus').textContent = '削除に失敗しました。'; });
  }

  // ---------- マイログ（ログイン中の自分の評価を、旅行をまたいで振り返る） ----------
  function openMyLog() {
    var user = loadCurrentUser();
    if (!user) { openLogin('mylog'); return; }
    showScreen('mylog');
    $('#mylogList').innerHTML = '<div class="empty">読み込み中…</div>';
    api('/mylog?email=' + encodeURIComponent(user.email)).then(function (data) {
      state.myLogItems = data.items || [];
      state.myLogTrips = data.trips || [];
      state.myLogPlaces = data.places || { prefectures: [], countries: [] };
      renderMyLog();
    }).catch(function () {
      $('#mylogList').innerHTML = '<div class="empty">マイログの読み込みに失敗しました。</div>';
    });
    fetchAccountStatus().then(renderPlanStatus);
  }

  // ---------- 音声入力プラン（docs/adr/0004） ----------
  // アカウントのプラン・利用状況は/accounts/ensureがまとめて返すので、それをそのまま使い回す
  // （ログインのたびに呼んでいる処理と同じもので、ここでは最新化のために呼び直しているだけ）。
  function fetchAccountStatus() {
    var user = loadCurrentUser();
    if (!user) { state.account = null; return Promise.resolve(null); }
    return api('/accounts/ensure', 'POST', { email: user.email, name: user.name || '' }).then(function (account) {
      state.account = account;
      return account;
    }).catch(function () { state.account = null; return null; });
  }

  function renderPlanStatus() {
    var statusEl = $('#planStatus');
    var optionsEl = $('#planOptions');
    var msgEl = $('#planStatusMessage');
    var badgeEl = $('#planBadgeTop');
    var manageBtn = $('#btnManageBilling');
    var account = state.account;
    if (!account) {
      statusEl.innerHTML = '';
      optionsEl.innerHTML = '';
      msgEl.textContent = '';
      badgeEl.hidden = true;
      manageBtn.hidden = true;
      return;
    }
    manageBtn.hidden = account.plan === 'free';
    var planName = PLAN_LABELS[account.plan] || PLAN_LABELS.free;
    var usageText = '今月の音声入力：残り' + account.voiceRemainingThisPeriod + '回（月' + account.voiceMonthlyLimit + '回まで）' +
      (typeof account.memoRemainingThisPeriod === 'number' ? '・メモのAI整理：残り' + account.memoRemainingThisPeriod + '回（月' + account.memoMonthlyLimit + '回まで）' : '');

    badgeEl.hidden = false;
    badgeEl.classList.toggle('is-free', account.plan === 'free');
    badgeEl.textContent = planName + '・残り' + account.voiceRemainingThisPeriod + '回';

    statusEl.innerHTML =
      '<div class="plan-name">今のプラン：' + escapeHtml(planName) + '</div>' +
      '<div class="plan-usage">' + escapeHtml(usageText) +
      (account.ticketCredits ? '・回数券の残り' + account.ticketCredits + '回' : '') + '</div>';

    optionsEl.innerHTML = '';
    PLAN_OPTIONS.forEach(function (opt) {
      if (account.plan === opt.plan) return;
      var card = document.createElement('div');
      card.className = 'plan-card';
      card.innerHTML =
        '<div><div class="plan-card-name">' + escapeHtml(opt.name) + '</div>' +
        '<div class="plan-card-detail">' + escapeHtml(opt.detail) + '</div></div>' +
        '<button class="btn primary" type="button">登録する</button>';
      card.querySelector('button').addEventListener('click', function () { startCheckout(opt.plan); });
      optionsEl.appendChild(card);
    });
    msgEl.textContent = '';
  }

  // iOSアプリ内ではlocation.originがcapacitor://localhostになってしまい、
  // Stripeへの戻り先URLとしては使えず、他の人と共有するリンクとしても開けない。
  // その場合は実際に公開しているWebサイトのURLを使う。
  function publicPageUrl() {
    return isNativeApp()
      ? 'https://ainaraomakaseare-coder.github.io/my-app/apps/day07-tabilog/'
      : location.origin + location.pathname;
  }

  function startCheckout(plan) {
    var user = loadCurrentUser();
    if (!user) { openLogin('mylog'); return; }
    var msgEl = $('#planStatusMessage');
    msgEl.textContent = '決済ページに移動しています…';
    var returnUrl = publicPageUrl();
    api('/billing/checkout', 'POST', {
      email: user.email,
      plan: plan,
      successUrl: returnUrl + '?billing=success',
      cancelUrl: returnUrl + '?billing=cancel'
    }).then(function (res) {
      if (res && res.url) location.href = res.url;
      else msgEl.textContent = '決済ページの作成に失敗しました。もう一度お試しください。';
    }).catch(function () {
      msgEl.textContent = '決済ページの作成に失敗しました。もう一度お試しください。';
    });
  }

  function startBillingPortal() {
    var user = loadCurrentUser();
    if (!user) { openLogin('mylog'); return; }
    var msgEl = $('#planStatusMessage');
    msgEl.textContent = '支払い管理ページに移動しています…';
    api('/billing/portal', 'POST', {
      email: user.email,
      returnUrl: publicPageUrl()
    }).then(function (res) {
      if (res && res.url) location.href = res.url;
      else msgEl.textContent = '支払い管理ページを開けませんでした。もう一度お試しください。';
    }).catch(function () {
      msgEl.textContent = '支払い管理ページを開けませんでした。もう一度お試しください。';
    });
  }

  // アカウント削除。旅行の記録自体は家族と共有しているものなので消さず、
  // アカウント本体（名前・プラン・回数券・参加した旅行への紐付け）だけを消す。
  // メールアドレスは、削除→再登録を繰り返した無料枠の不正な繰り返し取得を防ぐため残す（worker側の実装を参照）。
  // この端末に残しているデータ（旅行一覧・非表示にした旅行・AI送信の同意など、tabilog:で始まるキー）も
  // 一緒に消す。消さないと削除後のホームに同じ旅行が並んだままになり、「削除できていない」ように見える
  // （App Store審査で5.1.1(v)の指摘を受けた）。
  function deleteMyAccount() {
    var user = loadCurrentUser();
    if (!user) return;
    if (!confirm('アカウントを削除しますか？\n（名前・プラン・回数券の情報と、この端末の旅行一覧が削除されます。同行者と共有している旅行の記録自体は、他の参加者のために残ります。同じメールアドレスで登録し直しても、音声入力の利用回数は復活しません）')) return;
    api('/accounts/delete', 'POST', { email: user.email }).then(function () {
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf('tabilog:') === 0) localStorage.removeItem(k);
      });
      state.homeFilters = { companion: '', year: '', tripType: '', sort: '' };
      renderAccountRow();
      alert('アカウントを削除しました。');
      goHome();
    }).catch(function () {
      alert('アカウントの削除に失敗しました。もう一度お試しください。');
    });
  }

  // ページに戻ってきたときのURL（?billing=success/cancel）を見て、決済結果を伝える
  function checkBillingReturn() {
    var params = new URLSearchParams(location.search);
    var billing = params.get('billing');
    if (!billing) return;
    history.replaceState(null, '', location.pathname);
    if (billing === 'success') {
      fetchAccountStatus().then(function () {
        alert('プレミアムになりました！音声入力が使えるようになりました。');
      });
    }
  }

  function renderMyLog() {
    renderMyLogTrips();
    renderMyLogPlaces();
    renderMyLogTabs();
    renderMyLogSort();
    renderMyLogList();
  }

  // 「訪れた都道府県・国」：参加した旅行の「日ごとの場所」（天気取得のときに入力した地名）から
  // サーバー側で自動集計されたものを、そのままチップで並べるだけ（フロント側では集計しない）。
  function renderMyLogPlaces() {
    var el = $('#mylogPlaces');
    var places = state.myLogPlaces || { prefectures: [], countries: [] };
    var prefectures = places.prefectures || [];
    var countries = places.countries || [];
    if (!prefectures.length && !countries.length) {
      el.innerHTML = '<div class="empty">まだ訪れた場所がありません。旅行の日タブで「＋場所を設定」すると、ここに自動で集計されます。</div>';
      return;
    }
    var html = '';
    if (prefectures.length) {
      html += '<div class="visited-group"><span class="visited-group-label">都道府県（' + prefectures.length + '）</span><div class="visited-chips">'
        + prefectures.map(function (p) { return '<span class="visited-chip">' + escapeHtml(p) + '</span>'; }).join('') + '</div></div>';
    }
    if (countries.length) {
      html += '<div class="visited-group"><span class="visited-group-label">海外（' + countries.length + 'か国）</span><div class="visited-chips">'
        + countries.map(function (c) { return '<span class="visited-chip">' + escapeHtml(c) + '</span>'; }).join('') + '</div></div>';
    }
    el.innerHTML = html;
  }

  // 「参加した旅行一覧」：アカウント参加者として参加した旅行そのものの一覧（Trip単位）。
  // 評価の細かいログ（下のカテゴリ別一覧）とは別物で、どの端末からログインしても同じ内容が見える。
  function renderMyLogTrips() {
    var el = $('#mylogTripList');
    var trips = state.myLogTrips || [];
    if (!trips.length) {
      el.innerHTML = '<div class="empty">まだ参加した旅行がありません。旅行のページで「参加する」を押すとここに表示されます。</div>';
      return;
    }
    el.innerHTML = '';
    trips.forEach(function (t) {
      var card = document.createElement('button');
      card.className = 'trip-card';
      var dateText = t.startDate ? Core.formatDateJp(t.startDate) + (t.endDate && t.endDate !== t.startDate ? ' 〜 ' + Core.formatDateJp(t.endDate) : '') : '';
      card.innerHTML =
        '<div class="trip-card-row">' +
        tripThumbHtml(t.coverPhotoId) +
        '<div class="trip-card-body">' +
        '<div class="trip-card-top"><div class="trip-card-title">' + escapeHtml(t.title) + '</div>' +
        (dateText ? '<span class="trip-card-date">' + escapeHtml(dateText) + '</span>' : '') + '</div>' +
        '</div></div>';
      card.addEventListener('click', function () { openTrip(t.id); });
      el.appendChild(card);
    });
  }

  function renderMyLogTabs() {
    var el = $('#mylogTabs');
    el.innerHTML = Core.CATEGORIES.map(function (c) {
      var on = c.key === state.myLogCategory;
      var count = state.myLogItems.filter(function (it) { return it.category === c.key; }).length;
      return '<button class="mylog-tab' + (on ? ' on' : '') + '" data-cat="' + c.key + '">' + escapeHtml(MYLOG_LABELS[c.key] || c.label) + (count ? '（' + count + '）' : '') + '</button>';
    }).join('');
    $all('.mylog-tab', el).forEach(function (b) {
      b.addEventListener('click', function () {
        state.myLogCategory = b.dataset.cat;
        renderMyLog();
      });
    });
  }

  function renderMyLogSort() {
    $all('.sort-btn', $('#mylogSort')).forEach(function (b) {
      b.classList.toggle('on', b.dataset.sort === state.myLogSort);
    });
  }

  function renderMyLogList() {
    var el = $('#mylogList');
    var items = Core.sortMyLogItems(
      state.myLogItems.filter(function (it) { return it.category === state.myLogCategory; }),
      state.myLogSort
    );
    if (!items.length) {
      el.innerHTML = '<div class="empty">まだ' + escapeHtml(MYLOG_LABELS[state.myLogCategory] || '') + 'に評価がありません。記録を開いて★を付けてみてください。</div>';
      return;
    }
    el.innerHTML = '';
    items.forEach(function (it) {
      var row = document.createElement('button');
      row.className = 'mylog-row';
      var photoHtml = it.photoId ? '<div class="mylog-photo" style="background-image:url(\'' + escapeHtml(photoUrl(it.photoId)) + '\')"></div>' : '<div class="mylog-photo empty"></div>';
      row.innerHTML =
        photoHtml +
        '<div class="mylog-info">' +
        '<div class="mylog-label">' + escapeHtml(it.label || Core.categoryLabel(it.category)) + '</div>' +
        '<div class="mylog-trip">' + escapeHtml(it.tripTitle) + (it.date ? '・' + escapeHtml(Core.formatDateJp(it.date)) : '') + '</div>' +
        '</div>' +
        '<div class="mylog-score">★' + it.score + '</div>';
      row.addEventListener('click', function () { openTrip(it.tripId); });
      el.appendChild(row);
    });
  }

  // ---------- 地図でふりかえる（replay） ----------
  // 地図はLeaflet（vendor/leaflet、BSD-2）＋OpenStreetMapのタイル（無料・APIキー不要。帰属表示が必須で、
  // 大量アクセスは利用規約上不可）。Leafletは地図を開いたときだけ読み込み、普段の起動を重くしない。
  // 何を・いつ・どこに出すかは全部Core（replayStops / buildReplayTimeline / replayStateAt）が決め、
  // ここは「r秒時点の状態を地図に描く」だけにしている（シークや巻き戻しもrを変えて描き直すだけで済む）。
  var leafletLoading = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (leafletLoading) return leafletLoading;
    leafletLoading = new Promise(function (resolve, reject) {
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'vendor/leaflet/leaflet.css';
      document.head.appendChild(css);
      var js = document.createElement('script');
      js.src = 'vendor/leaflet/leaflet.js';
      js.onload = function () { resolve(window.L); };
      js.onerror = function () { leafletLoading = null; reject(new Error('leaflet_load_failed')); };
      document.head.appendChild(js);
    });
    return leafletLoading;
  }

  // 地名→座標は端末内にもキャッシュし、無いものだけWorker（/geocode）に1件ずつ聞く。Worker側の
  // Nominatimは1秒1回までの規約なので、Worker側のキャッシュにも無かった（cached:false）ときだけ1.1秒空ける。
  // 見つからなかった地名は7日間は聞き直さない（通信エラーのときは記録せず、次回また聞く）。
  // 聞く内容を「見出しから推測した地名」から「地図のURL」に変えたので、キーを-v2にして古い結果（同名の
  // 別の場所になっていたものを含む）は使わず、読み込み時に消す。
  var GEOCODE_CACHE_KEY = 'tabilog:geocode-cache-v2';
  try { localStorage.removeItem('tabilog:geocode-cache'); } catch (e) {}
  var GEOCODE_MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  function geocodeQueries(queries, onProgress) {
    var cache;
    try { cache = JSON.parse(localStorage.getItem(GEOCODE_CACHE_KEY) || '{}'); } catch (e) { cache = {}; }
    var now = Date.now(), result = {}, todo = [];
    queries.forEach(function (q) {
      if (!q || Object.prototype.hasOwnProperty.call(result, q) || todo.indexOf(q) !== -1) return;
      var c = cache[q];
      if (c && c.lat !== undefined) result[q] = { lat: c.lat, lng: c.lng };
      else if (c && now - c.at < GEOCODE_MISS_TTL_MS) result[q] = null;
      else todo.push(q);
    });
    var done = 0;
    function record(q, res) {
      if (res && res.found) { result[q] = { lat: res.lat, lng: res.lng }; cache[q] = { lat: res.lat, lng: res.lng, at: Date.now() }; }
      else { result[q] = null; cache[q] = { at: Date.now() }; }
      done++;
      if (onProgress) onProgress(done, todo.length);
    }
    // 1回目：座標入りのリンクなど、Nominatim（1秒に1回まで）を使わずに分かるものを、全部同時に聞く（quick=1）。
    // 以前は全部を1.1秒ずつ空けて1件ずつ聞いていたので、場所が多い旅行ほど準備に時間がかかっていた。
    var pending = [];
    return Promise.all(todo.map(function (q) {
      return api('/geocode?quick=1&q=' + encodeURIComponent(q)).then(function (res) {
        if (res && res.pending) pending.push(q); else record(q, res);
      }).catch(function () { result[q] = null; done++; });
    })).then(function () {
      // 2回目：住所・店名から探す必要があるものだけ、1件ずつ（Worker側のキャッシュに無かったときだけ1.1秒空ける）
      return pending.reduce(function (p, q) {
        return p.then(function (needWait) {
          return (needWait ? new Promise(function (ok) { setTimeout(ok, 1100); }) : Promise.resolve()).then(function () {
            return api('/geocode?q=' + encodeURIComponent(q)).then(function (res) {
              record(q, res);
              return !(res && res.cached);
            }).catch(function () { result[q] = null; done++; return false; });
          });
        });
      }, Promise.resolve(false));
    }).then(function () {
      try { localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
      return result;
    });
  }

  // 移動手段が車・タクシー・バス・徒歩・自転車の区間は、実際の道路に沿った道のりをWorker（/route）に聞き、
  // その区間の path にする（Core.replayStateAt と線の描画が、直線の代わりにこれをたどる。docs/adr/0008）。
  // 取れなかった区間は、これまでどおり直線のまま。
  function fetchReplayRoutes(tl) {
    var jobs = tl.legs.filter(function (l) { return Core.routeProfileFor(l.transport); });
    return Promise.all(jobs.map(function (l) {
      var a = tl.stops[l.from], b = tl.stops[l.to];
      var q = '/route?profile=' + Core.routeProfileFor(l.transport) +
        '&from=' + a.lat.toFixed(5) + ',' + a.lng.toFixed(5) + '&to=' + b.lat.toFixed(5) + ',' + b.lng.toFixed(5);
      return api(q).then(function (res) {
        if (res && res.found && res.path && res.path.length > 1) l.path = res.path;
      }).catch(function () {});
    }));
  }

  var PLAY_ICON = '<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M6 4.5v11l9-5.5z"/></svg>';
  var PAUSE_ICON = '<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="4.5" width="3.5" height="11" rx="1"/><rect x="11.5" y="4.5" width="3.5" height="11" rx="1"/></svg>';
  var replayMap = null, replayLayer = null, replay = null, replayToken = null;

  function openReplay() {
    if (!state.trip) return;
    stopReplay();
    showScreen('replay');
    $('#replayClock').hidden = true;
    $('#replayControls').hidden = true;
    $('#replayCaption').hidden = true;
    $('#replayDayBanner').hidden = true;
    var stops = Core.replayStops(state.trip, state.blocks);
    var status = $('#replayStatus');
    if (!stops.length) { status.textContent = '日付の入った予定がまだありません。'; return; }
    status.textContent = '地図を準備しています…';
    var token = {};
    replayToken = token;
    Promise.all([
      loadLeaflet(),
      geocodeQueries(stops.map(function (s) { return s.query; }), function (done, total) {
        if (replayToken === token) status.textContent = '地図で場所を探しています…（' + done + '/' + total + '）';
      })
    ]).then(function (res) {
      if (replayToken !== token) return; // 準備中に閉じられた
      var tl = Core.buildReplayTimeline(stops, res[1]);
      if (!tl.stops.some(function (s) { return s.located; })) {
        status.textContent = '地図に出せる場所が見つかりませんでした。記録の「地図」にGoogleマップの共有リンクを入れた予定が、地図の上で移動する目的地になります。';
        return;
      }
      status.textContent = '道のりを調べています…';
      return fetchReplayRoutes(tl).then(function () {
        if (replayToken !== token) return;
        status.textContent = '';
        startReplay(res[0], tl);
      });
    }).catch(function () {
      if (replayToken === token) status.textContent = '地図を読み込めませんでした。通信環境を確認してください。';
    });
  }

  function startReplay(L, tl) {
    if (!replayMap) {
      // 線を描く範囲を画面の外まで広げておく（カメラが次の区間へ動くあいだに、道のりの端が切れて見えないように）
      replayMap = L.map($('#replayMap'), { zoomControl: false, renderer: L.svg({ padding: 1 }) });
      replayMap.attributionControl.setPrefix(false);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      }).addTo(replayMap);
    }
    replayMap.invalidateSize();
    if (replayLayer) replayLayer.remove();
    replayLayer = L.layerGroup().addTo(replayMap);
    replay = {
      L: L, tl: tl, r: 0, playing: false, lastTs: null, raf: null,
      dots: {}, lines: [], vehicle: null, vehicleTransport: '',
      lastDay: 0, lastLeg: -1, lastStop: -2, captionIndex: -2,
      dates: Core.allDatesForTrip(state.trip, state.blocks).filter(function (d) { return d; })
    };
    tl.stops.forEach(function (s, i) {
      if (!s.located) return;
      replay.dots[i] = L.marker([s.lat, s.lng], {
        interactive: false,
        icon: L.divIcon({ className: '', html: '<div class="replay-dot"></div>', iconSize: [14, 14], iconAnchor: [7, 7] })
      });
    });
    // 移動の線はGoogleマップの道のりのような青（白い縁取り付き）。区間に入ったら、これから通る道のりを
    // 薄い青で先に見せ、進んだところまでを濃い青で伸ばしていく。飛行機は弧の点線。
    tl.legs.forEach(function (l, k) {
      var plane = l.transport === 'plane';
      var full = l.path || null;
      replay.lines[k] = {
        plan: full ? L.polyline(full, { color: ROUTE_BLUE, weight: 6, opacity: 0.3, interactive: false, lineCap: 'round', lineJoin: 'round' }) : null,
        casing: plane ? null : L.polyline([], { color: '#FFFFFF', weight: 9, opacity: 0.95, interactive: false, lineCap: 'round', lineJoin: 'round' }),
        line: L.polyline([], { color: ROUTE_BLUE, weight: plane ? 4 : 6, opacity: 0.95, interactive: false, lineCap: 'round', lineJoin: 'round', dashArray: plane ? '8 10' : null })
      };
    });
    resetReplayCamera();
    renderReplayDays();
    $('#replayClock').hidden = false;
    $('#replayControls').hidden = false;
    renderReplay();
    setReplayPlaying(true);
  }

  function resetReplayCamera() {
    var first = replay.tl.stops.filter(function (s) { return s.located; })[0];
    replayMap.setView([first.lat, first.lng], 13, { animate: false });
    replay.lastLeg = -1;
    replay.lastStop = -2;
    replay.captionIndex = -2;
    replay.lastDay = 0;
  }

  var ROUTE_BLUE = '#1A73E8';

  function replayLegPoints(l, f) {
    if (l.path && l.path.length > 1) return Core.pathAt(l.path, f).prefix;
    var s = replay.tl.stops, a = s[l.from], b = s[l.to];
    if (l.transport !== 'plane') {
      var p = Core.arcLatLng(a, b, f, false);
      return [[a.lat, a.lng], [p.lat, p.lng]];
    }
    var pts = [], n = Math.max(2, Math.ceil(32 * f));
    for (var i = 0; i <= n; i++) {
      var q = Core.arcLatLng(a, b, f * i / n, true);
      pts.push([q.lat, q.lng]);
    }
    return pts;
  }

  function replayShortDate(ymd) {
    var d = parseDate(ymd);
    return d ? (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '（' + WEEKDAYS_JA[d.getUTCDay()] + '）' : '';
  }

  function showReplayDayBanner(dayNumber) {
    showReplayBanner(dayNumber + '日目');
  }

  function showReplayBanner(text) {
    var el = $('#replayDayBanner');
    el.hidden = true;
    void el.offsetWidth; // アニメーションを最初から再生し直すため
    el.textContent = text;
    el.hidden = false;
    clearTimeout(showReplayBanner.timer);
    showReplayBanner.timer = setTimeout(function () { el.hidden = true; }, 1600);
  }

  function setLayerVisible(layer, visible) {
    var has = replayLayer.hasLayer(layer);
    if (visible && !has) replayLayer.addLayer(layer);
    else if (!visible && has) replayLayer.removeLayer(layer);
  }

  function renderReplay() {
    var L = replay.L, tl = replay.tl, r = replay.r;
    var st = Core.replayStateAt(tl, r);

    $('#replayDay').textContent = st.dayNumber + '日目　' + replayShortDate(replay.dates[st.dayNumber - 1]);
    highlightReplayDay(st.dayNumber);
    $('#replayTime').textContent = st.hhmm;
    if (replay.lastOffsetDiff !== undefined && st.offsetDiff !== replay.lastOffsetDiff && replay.playing) {
      showReplayBanner('時差 ' + Core.offsetDiffText(st.offsetDiff - replay.lastOffsetDiff) + '（ここから現地時間）');
    }
    replay.lastOffsetDiff = st.offsetDiff;
    if (st.dayNumber !== replay.lastDay) {
      if (replay.lastDay && st.dayNumber > replay.lastDay && replay.playing) showReplayDayBanner(st.dayNumber);
      replay.lastDay = st.dayNumber;
    }

    // 到着済みの地点は塗りつぶしの点、移動中の行き先は白抜きの点で先に見せる
    var headingTo = st.icon ? tl.legs[st.icon.legIndex].to : -1;
    tl.stops.forEach(function (s, i) {
      var dot = replay.dots[i];
      if (!dot) return;
      var arrived = s.r <= r + 1e-9;
      setLayerVisible(dot, arrived || i === headingTo);
      var el = dot.getElement();
      if (el && el.firstChild) el.firstChild.classList.toggle('upcoming', !arrived);
    });
    tl.legs.forEach(function (l, k) {
      var f = r >= l.r1 ? 1 : (r <= l.r0 ? 0 : (r - l.r0) / (l.r1 - l.r0));
      var set = replay.lines[k];
      if (f > 0) {
        var pts = replayLegPoints(l, f);
        set.line.setLatLngs(pts);
        if (set.casing) set.casing.setLatLngs(pts);
      }
      if (set.plan) setLayerVisible(set.plan, f > 0 && f < 1);
      if (set.casing) setLayerVisible(set.casing, f > 0);
      setLayerVisible(set.line, f > 0);
    });

    if (st.icon) {
      if (!replay.vehicle || replay.vehicleTransport !== st.icon.transport) {
        if (replay.vehicle) replayLayer.removeLayer(replay.vehicle);
        replay.vehicle = L.marker([st.icon.lat, st.icon.lng], {
          interactive: false, zIndexOffset: 1000,
          icon: L.divIcon({ className: '', html: '<div class="replay-vehicle">' + transportIconSvg(st.icon.transport, 20) + '</div>', iconSize: [38, 38], iconAnchor: [19, 19] })
        });
        replay.vehicleTransport = st.icon.transport;
      }
      replay.vehicle.setLatLng([st.icon.lat, st.icon.lng]);
      setLayerVisible(replay.vehicle, true);
      var svg = replay.vehicle.getElement() && replay.vehicle.getElement().querySelector('svg');
      if (svg && st.icon.transport === 'plane') svg.style.transform = 'rotate(' + Math.round(st.icon.bearing) + 'deg)';
    } else if (replay.vehicle) {
      setLayerVisible(replay.vehicle, false);
    }

    // カメラ：移動が始まったら出発地と到着地が両方入るように、移動なしで別の場所に着いたらそこへ寄せる
    if (st.icon && st.icon.legIndex !== replay.lastLeg) {
      var leg = tl.legs[st.icon.legIndex];
      var legBounds = leg.path && leg.path.length > 1 ? leg.path
        : [[tl.stops[leg.from].lat, tl.stops[leg.from].lng], [tl.stops[leg.to].lat, tl.stops[leg.to].lng]];
      replayMap.flyToBounds(legBounds, { padding: [70, 70], maxZoom: 15, duration: 0.8 });
      replay.lastLeg = st.icon.legIndex;
    } else if (!st.icon && st.stopIndex !== replay.lastStop) {
      var arrived = tl.stops[st.stopIndex];
      var cameFromLeg = tl.legs.some(function (l) { return l.to === st.stopIndex; });
      if (arrived && arrived.located && !cameFromLeg && replay.lastStop !== -2) {
        replayMap.flyTo([arrived.lat, arrived.lng], Math.max(replayMap.getZoom(), 12), { duration: 0.8 });
      }
      replay.lastStop = st.stopIndex;
    }

    if (st.captionIndex !== replay.captionIndex) {
      replay.captionIndex = st.captionIndex;
      var cap = $('#replayCaption');
      var s = tl.stops[st.captionIndex];
      if (!s) {
        cap.hidden = true;
      } else {
        $('#replayCaptionTime').textContent = s.estimated ? '' : minuteToHHMM(s.minute);
        $('#replayCaptionTitle').textContent = s.label;
        $('#replayCaptionLines').innerHTML = s.captions.map(function (c) { return '<div>' + escapeHtml(c) + '</div>'; }).join('');
        cap.hidden = true;
        void cap.offsetWidth;
        cap.hidden = false;
      }
    }

    $('#replayProgressBar').style.width = (tl.totalReal ? Math.min(100, r / tl.totalReal * 100) : 100) + '%';
  }

  function replayTick(ts) {
    if (!replay || !replay.playing) return;
    if (replay.lastTs !== null) replay.r = Math.min(replay.tl.totalReal, replay.r + (ts - replay.lastTs) / 1000);
    replay.lastTs = ts;
    renderReplay();
    if (replay.r >= replay.tl.totalReal) { setReplayPlaying(false); return; }
    replay.raf = requestAnimationFrame(replayTick);
  }

  function setReplayPlaying(on) {
    if (!replay) return;
    if (on && replay.r >= replay.tl.totalReal) { replay.r = 0; resetReplayCamera(); }
    replay.playing = on;
    replay.lastTs = null;
    var btn = $('#btnReplayToggle');
    btn.innerHTML = on ? PAUSE_ICON : PLAY_ICON;
    btn.setAttribute('aria-label', on ? '一時停止' : '再生');
    if (replay.raf) cancelAnimationFrame(replay.raf);
    replay.raf = on ? requestAnimationFrame(replayTick) : null;
  }

  // 再生位置を r（秒）に移す。カメラは移った先の場所へ、アニメーションなしで寄せる
  function seekReplayTo(r) {
    if (!replay) return;
    replay.r = Math.max(0, Math.min(replay.tl.totalReal, r));
    replay.lastOffsetDiff = undefined; // 飛んだ先で「時差」のバナーを出さない
    replay.lastLeg = -1;
    replay.lastStop = -2;
    replay.captionIndex = -2;
    replay.lastDay = 0;
    var here = Core.replayStateAt(replay.tl, replay.r).here;
    if (here) replayMap.setView([here.lat, here.lng], replayMap.getZoom(), { animate: false });
    renderReplay();
  }

  function seekReplay(e) {
    if (!replay) return;
    var rect = $('#replayProgress').getBoundingClientRect();
    var f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekReplayTo(f * replay.tl.totalReal);
  }

  // シークバーは、タップだけでなく指でつまんで動かせるようにする（以前はタップしかできず、
  // 「この日から見たい」ときに合わせにくかった）。動かしているあいだは一時停止し、離したら元に戻す。
  function initReplaySeekDrag() {
    var bar = $('#replayProgress'), dragging = false, wasPlaying = false;
    bar.addEventListener('pointerdown', function (e) {
      if (!replay) return;
      dragging = true;
      wasPlaying = replay.playing;
      if (wasPlaying) setReplayPlaying(false);
      bar.classList.add('dragging');
      try { bar.setPointerCapture(e.pointerId); } catch (err) { /* 古いブラウザ */ }
      seekReplay(e);
      e.preventDefault();
    });
    bar.addEventListener('pointermove', function (e) { if (dragging) seekReplay(e); });
    var end = function () {
      if (!dragging) return;
      dragging = false;
      bar.classList.remove('dragging');
      if (wasPlaying) setReplayPlaying(true);
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  }

  // 「1日目 12/12」…の日ボタン。押すとその日の最初の予定へ飛ぶ。今いる日を強調する
  function renderReplayDays() {
    var el = $('#replayDays');
    var days = Core.replayDayStarts(replay.tl);
    replay.dayStarts = days;
    el.hidden = days.length < 2;
    el.innerHTML = days.map(function (d) {
      return '<button type="button" class="replay-day-chip" data-day="' + d.dayNumber + '">' + d.dayNumber + '日目' +
        (d.date ? '<span>' + escapeHtml(replayShortDate(d.date)) + '</span>' : '') + '</button>';
    }).join('');
  }

  function highlightReplayDay(dayNumber) {
    $all('.replay-day-chip', $('#replayDays')).forEach(function (b) {
      var on = Number(b.dataset.day) === dayNumber;
      if (on && !b.classList.contains('on')) b.scrollIntoView({ block: 'nearest', inline: 'center' });
      b.classList.toggle('on', on);
    });
  }

  function stopReplay() {
    replayToken = null;
    if (replay) {
      replay.playing = false;
      if (replay.raf) cancelAnimationFrame(replay.raf);
    }
    replay = null;
  }

  function closeReplay() {
    stopReplay();
    showScreen('tripDetail');
    renderTripDetail();
  }

  // ---------- 初期化 ----------
  // ---------- 入力欄の×（中身を消す）ボタン ----------
  // URLなどを入れたあと消すのが面倒、という要望より。1行の入力欄（テキスト・URL・検索・メール・数字）を
  // 編集しているあいだ、中身があれば右端に×を1つだけ出す（iOS標準の「編集中だけ出る消去ボタン」と同じ考え方）。
  // 入力欄ごとに要素を足すと、親の並び（検索欄の横並び・レビューの2列など）の幅が崩れるので、
  // 画面に1つだけ置いたボタンを、編集中の欄の上に重ねて動かす。後から描く欄（レビュー項目など）にも効く。
  // 複数行の欄（エピソードなど）は、長文を一度に消してしまうと困るので対象にしない。
  var CLEARABLE_TYPES = ['text', 'url', 'search', 'email', 'number'];
  var clearTarget = null;

  function isClearable(el) {
    return !!(el && el.tagName === 'INPUT' && CLEARABLE_TYPES.indexOf(el.type) !== -1 &&
      !el.readOnly && !el.disabled && !el.hasAttribute('data-no-clear'));
  }

  function placeClearButton() {
    var btn = $('#inputClearBtn');
    if (!clearTarget || !clearTarget.value || !document.body.contains(clearTarget)) { btn.hidden = true; return; }
    var r = clearTarget.getBoundingClientRect();
    if (!r.width) { btn.hidden = true; return; }
    btn.style.top = (r.top + r.height / 2 - 14) + 'px';
    btn.style.left = (r.right - 32) + 'px';
    btn.hidden = false;
  }

  function initClearButtons() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'inputClearBtn';
    btn.className = 'input-clear-btn';
    btn.setAttribute('aria-label', '入力を消す');
    btn.textContent = '×';
    btn.hidden = true;
    document.body.appendChild(btn);
    // 押したときに入力欄からフォーカスが外れる（＝ボタンが消える）前に処理する
    btn.addEventListener('pointerdown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', function () {
      if (!clearTarget) return;
      clearTarget.value = '';
      clearTarget.dispatchEvent(new Event('input', { bubbles: true }));
      clearTarget.dispatchEvent(new Event('change', { bubbles: true }));
      clearTarget.focus();
      placeClearButton();
    });
    document.addEventListener('focusin', function (e) {
      clearTarget = isClearable(e.target) ? e.target : null;
      placeClearButton();
    });
    document.addEventListener('focusout', function () {
      setTimeout(function () {
        if (!isClearable(document.activeElement)) { clearTarget = null; placeClearButton(); }
      }, 0);
    });
    document.addEventListener('input', function (e) { if (e.target === clearTarget) placeClearButton(); });
    window.addEventListener('scroll', placeClearButton, true);
    window.addEventListener('resize', placeClearButton);
  }

  function init() {
    initClearButtons();
    $('#btnCloseLightbox').addEventListener('click', closeMediaViewer);
    $('#lightboxPrev').addEventListener('click', function (e) { e.stopPropagation(); goToMedia(viewer.index - 1, true); });
    $('#lightboxNext').addEventListener('click', function (e) { e.stopPropagation(); goToMedia(viewer.index + 1, true); });
    $('#btnSaveLightboxPhoto').addEventListener('click', function (e) {
      e.stopPropagation();
      var it = viewer.items[viewer.index];
      if (it) saveMediaFromUrl(photoUrl(it.id), it.id, e.currentTarget);
    });
    initMediaViewerGestures();
    $('#btnOpenAlbum').addEventListener('click', openAlbum);
    $('#btnOpenSettlement').addEventListener('click', openSettlement);
    $('#filterCompanion').addEventListener('change', function (e) { state.homeFilters.companion = e.target.value; renderHomeTripList(); });
    $('#filterYear').addEventListener('change', function (e) { state.homeFilters.year = e.target.value; renderHomeTripList(); });
    $('#filterTripType').addEventListener('change', function (e) { state.homeFilters.tripType = e.target.value; renderHomeTripList(); });
    $('#sortTripOrder').addEventListener('change', function (e) { state.homeFilters.sort = e.target.value; renderHomeTripList(); });
    $('#btnClearTripHistory').addEventListener('click', clearTripHistory);
    $('#btnScanReceipt').addEventListener('click', function () { if (!confirmAiDataSharing()) return; $('#receiptFileInput').click(); });
    $('#btnPlaceSearch').addEventListener('click', showPlaceMapPreview);
    $('#entPlaceCandidates').addEventListener('change', previewSelectedPlace);
    $('#btnMapZoomIn').addEventListener('click', function () { zoomPlaceFrame(1); });
    $('#btnMapZoomOut').addEventListener('click', function () { zoomPlaceFrame(-1); });
    $('#entPlaceSearch').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); showPlaceMapPreview(); }
    });
    $('#btnUseMapUrl').addEventListener('click', useSearchedPlaceAsMapUrl);
    $('#receiptFileInput').addEventListener('change', function (e) {
      var file = e.target.files[0];
      e.target.value = '';
      if (file) handleScanReceipt(file);
    });
    $('#btnCancelWeatherEdit').addEventListener('click', function () { $('#weatherEditPanel').hidden = true; });
    $('#btnSaveWeatherEdit').addEventListener('click', saveWeatherEdit);
    initBlockDragReorder();
    initEntryDragMove();
    initDaySwipe();
    initEdgeSwipeBack(document.querySelector('[data-screen="mylog"]'), goHome);
    initEdgeSwipeBack(document.querySelector('[data-screen="tripDetail"]'), goHome);
    document.addEventListener('click', function (e) {
      if (e.target.closest('.entry-card-head') || e.target.closest('.entry-move-menu')) return;
      $all('.entry-move-menu').forEach(function (m) { m.hidden = true; m.innerHTML = ''; });
    });

    $('#btnNewTrip').addEventListener('click', openNewTripForm);
    $('#btnCreateTrip').addEventListener('click', createTrip);
    $('#btnOpenTripId').addEventListener('click', function () {
      var id = $('#openTripId').value.trim();
      if (id) openTrip(id);
    });

    $('#btnShareTrip').addEventListener('click', copyShareLink);
    $('#btnInvite').addEventListener('click', copyShareLink);
    $('#btnJoinTrip').addEventListener('click', handleJoinTrip);
    $('#btnEditTrip').addEventListener('click', openTripEditForm);
    $('#btnSaveTripEdit').addEventListener('click', saveTripEdit);
    $('#btnForgetTrip').addEventListener('click', hideTripFromHistory);
    $('#btnOpenReplay').addEventListener('click', openReplay);
    $('#btnCloseReplay').addEventListener('click', closeReplay);
    $('#btnReplayToggle').addEventListener('click', function () { if (replay) setReplayPlaying(!replay.playing); });
    $('#btnReplayPrev').addEventListener('click', function () {
      if (replay) seekReplayTo(Core.replayNeighborStop(replay.tl, replay.r, -1));
    });
    $('#btnReplayNext').addEventListener('click', function () {
      if (replay) seekReplayTo(Core.replayNeighborStop(replay.tl, replay.r, 1));
    });
    $('#replayDays').addEventListener('click', function (e) {
      var chip = e.target.closest('.replay-day-chip');
      if (!chip || !replay) return;
      var d = (replay.dayStarts || []).filter(function (x) { return x.dayNumber === Number(chip.dataset.day); })[0];
      if (!d) return;
      seekReplayTo(d.r);
      if (!replay.playing) setReplayPlaying(true);
    });
    initReplaySeekDrag();
    ['nt', 'te'].forEach(function (prefix) {
      $('#' + prefix + 'CoverPhotoPicker').addEventListener('click', function () { $('#' + prefix + 'CoverPhoto').click(); });
      $('#' + prefix + 'CoverPhoto').addEventListener('change', function (e) {
        var file = (e.target.files || [])[0];
        if (file) handleCoverPhotoChange(prefix, file);
        e.target.value = '';
      });
    });
    $('#btnVoiceRecord').addEventListener('click', handleVoiceRecordToggle);
    $('#btnCreateVoiceEntries').addEventListener('click', handleCreateVoiceEntries);
    $('#btnCreateTextEntries').addEventListener('click', handleCreateTextEntries);
    $('#btnOrganizeMemoAi').addEventListener('click', function () { organizeMemoWithAi(); });

    $('#btnSaveBlock').addEventListener('click', saveBlock);
    $('#btnDeleteBlock').addEventListener('click', deleteBlock);

    $('#btnSaveEntry').addEventListener('click', saveEntry);
    $('#btnDeleteEntry').addEventListener('click', deleteEntry);
    $('#entTravelDepart').addEventListener('input', updateTravelDuration);
    $('#entTravelArrive').addEventListener('input', updateTravelDuration);
    $('#btnAddCostItem').addEventListener('click', function () {
      state.formCostItems.push({ label: '', amount: 0 });
      renderCostItems();
    });

    $('#entPhotoPicker').addEventListener('click', function () { $('#entPhoto').click(); });
    initPhotoReorder();
    $('#entPhoto').addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files || []);
      Promise.all(files.map(function (f) { return fileToCompressedBlob(f, 1280, 0.72); })).then(function (blobs) {
        blobs.forEach(function (blob) { state.formPhotos.push({ blob: blob, url: URL.createObjectURL(blob) }); });
        renderPhotoPreview();
      });
      e.target.value = '';
    });

    var MAX_VIDEO_BYTES = 200 * 1024 * 1024;
    $('#entVideoPicker').addEventListener('click', function () { $('#entVideo').click(); });
    $('#entVideo').addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files || []);
      var tooBig = files.filter(function (f) { return f.size > MAX_VIDEO_BYTES; });
      files.filter(function (f) { return f.size <= MAX_VIDEO_BYTES; }).forEach(function (f) {
        state.pendingVideos.push({ blob: f, name: f.name, size: f.size });
      });
      renderVideoPreview();
      if (tooBig.length) alert('200MBを超える動画は追加できませんでした：' + tooBig.map(function (f) { return f.name; }).join('、'));
      e.target.value = '';
    });

    $all('[data-back]').forEach(function (b) {
      b.addEventListener('click', function () {
        var to = b.dataset.back;
        stopVoiceRecordingIfActive();
        if (to === 'home') goHome();
        else { showScreen(to); if (to === 'tripDetail') renderTripDetail(); }
      });
    });

    $('#btnLogout').addEventListener('click', function () {
      if (loadCurrentUser() && loadCurrentUser().token) api('/auth/logout', 'POST', {}).catch(function () {});
      clearCurrentUser();
      renderAccountRow();
      goHome();
    });
    $('#btnOpenLogin').addEventListener('click', function () { openLogin('home'); });
    $('#btnLoginBack').addEventListener('click', closeLogin);
    $('#btnSendOtp').addEventListener('click', handleSendOtp);
    $('#btnVerifyOtp').addEventListener('click', handleVerifyOtp);
    $('#btnResendOtp').addEventListener('click', handleSendOtp);
    $('#btnOpenMyLog').addEventListener('click', function () {
      if (loadCurrentUser()) openMyLog(); else openLogin('mylog');
    });
    $('#btnGoToPlans').addEventListener('click', function () {
      if (loadCurrentUser()) openMyLog(); else openLogin('mylog');
    });
    $('#planBadgeTop').addEventListener('click', function () {
      $('#planStatus').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#btnManageBilling').addEventListener('click', startBillingPortal);
    $('#btnDeleteAccount').addEventListener('click', deleteMyAccount);
    initSocial();

    $('#mylogSort').addEventListener('click', function (e) {
      var btn = e.target.closest('.sort-btn');
      if (!btn) return;
      state.myLogSort = btn.dataset.sort;
      renderMyLog();
    });

    apiNoticeCheck();
    enterApp();
  }

  // 閲覧・記録の追加はログイン不要（今までどおりリンクで誰でも）。
  // ログインが必要なのは「評価をつける」「マイログを見る」ときだけなので、
  // 最初から画面をブロックせず、必要になった場面でopenLoginへ誘導する。
  function openLogin(returnTo) {
    state.loginReturnTo = returnTo || 'home';
    showScreen('login');
    $('#loginStatus').textContent = '';
    $('#loginLead').textContent = 'ログインすると、評価をつけたりマイログを見たりできます';

    if (GOOGLE_CLIENT_ID) {
      if (!window.google || !window.google.accounts) {
        $('#loginStatus').textContent = 'Googleログインの読み込みに失敗しました。時間をおいて再読み込みしてください。';
      } else {
        google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleGoogleCredential });
        google.accounts.id.renderButton($('#googleSignInButton'), { theme: 'outline', size: 'large', width: 280 });
      }
    }

    if (APPLE_CLIENT_ID) {
      var appleBtn = $('#appleSignInButton');
      appleBtn.hidden = false;
      appleBtn.onclick = handleAppleSignIn;
    }

    // 「または」の区切りは、Google/Appleどちらかのボタンが並んでいるときだけ意味を持つ
    $('#emailLoginDivider').hidden = !(GOOGLE_CLIENT_ID || APPLE_CLIENT_ID);
    var existing = loadCurrentUser();
    $('#loginName').value = (existing && existing.provider === 'email') ? existing.name : '';
    $('#loginEmail').value = (existing && existing.provider === 'email') ? existing.email : '';
    $('#loginOtpCode').value = '';
    $('#emailLoginForm').hidden = false;
    $('#emailOtpForm').hidden = true;
  }

  // メールでのログイン（OTP）。実際にメールで6桁のコードを送り、入力してもらうことで
  // 「メールの持ち主であること」をサーバー側で確認する（Google/Appleとは違い、唯一
  // サーバー側で検証するログイン方法）。
  function handleSendOtp() {
    var name = $('#loginName').value.trim();
    var email = $('#loginEmail').value.trim();
    if (!email || email.indexOf('@') === -1) {
      $('#loginStatus').textContent = 'メールアドレスを入力してください。';
      return;
    }
    $('#loginStatus').textContent = '送信中…';
    api('/auth/email/send', 'POST', { name: name, email: email }).then(function () {
      $('#loginStatus').textContent = '';
      $('#emailOtpSentTo').textContent = email + ' に確認コードを送りました。';
      $('#emailLoginForm').hidden = true;
      $('#emailOtpForm').hidden = false;
      $('#emailOtpForm').dataset.name = name;
      $('#emailOtpForm').dataset.email = email;
    }).catch(function (e) {
      var msg = (e && e.message) || '';
      if (msg === 'too_soon') $('#loginStatus').textContent = 'コードを送ったばかりです。少し時間をおいてから再度お試しください。';
      else if (msg === 'email_not_configured') $('#loginStatus').textContent = 'メールログインがまだ設定されていません。他のログイン方法をお試しください。';
      else $('#loginStatus').textContent = 'コードの送信に失敗しました。メールアドレスを確認してもう一度お試しください。';
    });
  }

  function handleVerifyOtp() {
    var form = $('#emailOtpForm');
    var email = form.dataset.email;
    var name = form.dataset.name;
    var code = $('#loginOtpCode').value.trim();
    if (!code) { $('#loginStatus').textContent = 'コードを入力してください。'; return; }
    $('#loginStatus').textContent = '確認中…';
    api('/auth/email/verify', 'POST', { email: email, code: code }).then(function (res) {
      ensureAccountAndProceed({ name: name || res.name || email, email: res.email, provider: 'email', token: res.token || '' });
    }).catch(function (e) {
      var msg = (e && e.message) || '';
      if (msg === 'wrong_code') $('#loginStatus').textContent = 'コードが正しくありません。';
      else if (msg === 'expired') $('#loginStatus').textContent = 'コードの有効期限が切れました。もう一度送信してください。';
      else if (msg === 'too_many_attempts') $('#loginStatus').textContent = '間違いが多いため、コードを無効にしました。もう一度送信してください。';
      else $('#loginStatus').textContent = '確認に失敗しました。もう一度お試しください。';
    });
  }

  // ログイン成功後の共通処理：アカウントID（6桁、サーバー側で発行）を取得してから
  // 元の画面に戻る。アカウントIDは「参加者」欄で生のメールアドレスを晒さず本人を
  // 指し示すための識別子で、これが無いと「参加する」機能が使えない。
  // 取得に失敗してもログイン自体は成立させる（参加機能だけ使えない状態で進む）。
  function ensureAccountAndProceed(user) {
    saveCurrentUser(user);
    renderAccountRow();
    api('/accounts/ensure', 'POST', { email: user.email, name: user.name || '' }).then(function (account) {
      saveCurrentUser(Object.assign({}, loadCurrentUser(), { accountId: account.accountId }));
    }).catch(function () {
      // アカウントIDが取れなくてもログインは成立させる
    }).then(function () {
      goToReturnScreen(state.loginReturnTo, true);
    });
  }

  // ログイン画面を、ログインせずに閉じる（元の画面へ戻る）
  function closeLogin() {
    goToReturnScreen(state.loginReturnTo, false);
  }

  function goToReturnScreen(target, loggedIn) {
    if (target === 'entryForm' && state.editingEntryId) {
      showScreen('entryForm');
      renderEntryRatingSection();
    } else if (target === 'tripDetail' && state.trip) {
      showScreen('tripDetail');
      renderTripDetail();
      if (loggedIn) loadSocial();
    } else if (target === 'voiceEntryForm' && state.trip) {
      openVoiceEntryForm();
    } else if (target === 'mylog' && loggedIn) {
      openMyLog();
    } else {
      goHome();
    }
  }

  function handleGoogleCredential(response) {
    var payload = decodeJwtPayload(response.credential);
    if (!payload) { $('#loginStatus').textContent = 'ログインに失敗しました。もう一度お試しください。'; return; }
    ensureAccountAndProceed({ name: payload.name, email: payload.email, picture: payload.picture, provider: 'google' });
  }

  function handleAppleSignIn() {
    if (!window.AppleID || !window.AppleID.auth) {
      $('#loginStatus').textContent = 'Appleログインの読み込みに失敗しました。時間をおいて再読み込みしてください。';
      return;
    }
    AppleID.auth.init({
      clientId: APPLE_CLIENT_ID,
      scope: 'name email',
      redirectURI: location.origin + location.pathname,
      usePopup: true
    });
    AppleID.auth.signIn().then(function (res) {
      // Appleは初回ログインのときだけ res.user に氏名・メールを返す。2回目以降はid_tokenからメールだけ分かる。
      var payload = decodeJwtPayload(res.authorization.id_token) || {};
      var name = (res.user && res.user.name) ? [res.user.name.firstName, res.user.name.lastName].filter(Boolean).join(' ') : '';
      var existing = loadCurrentUser();
      ensureAccountAndProceed({
        name: name || (existing && existing.provider === 'apple' ? existing.name : '') || '',
        email: (res.user && res.user.email) || payload.email || '',
        provider: 'apple'
      });
    }).catch(function () {
      $('#loginStatus').textContent = 'Appleログインに失敗、またはキャンセルされました。';
    });
  }

  // 起動時：ログイン状態にかかわらず、いつもどおりホーム/共有された旅行を表示する
  function enterApp() {
    renderAccountRow();
    checkBillingReturn();
    var tripId = Core.getTripIdFromSearch(location.search);
    if (tripId) openTrip(tripId);
    else { showScreen('home'); renderHome(); }
  }

  function copyShareLink() {
    if (!state.trip) return;
    // iOSアプリ内ではlocation.hrefがcapacitor://localhost/...になり、
    // 他の人に共有しても開けないリンクになってしまうため、その場合は
    // 実際に公開しているWebサイトのURLを組み立てる。
    var url = isNativeApp()
      ? Core.buildShareUrl(publicPageUrl(), '', state.trip.id)
      : location.href;
    var done = function () {
      var status = $('#tripDetailStatus');
      status.textContent = 'リンクをコピーしました。共有した相手も見たり書き足したりできます。';
      setTimeout(function () { status.textContent = ''; }, 4000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(function () { prompt('このURLを共有してください', url); });
    } else {
      prompt('このURLを共有してください', url);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})(typeof window !== 'undefined' ? window : this);
