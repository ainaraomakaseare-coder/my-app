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
  function blockSortKey(b) {
    return b.time ? '0:' + b.time : '1:' + (b.createdAt || '');
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

  var Core = {
    CATEGORIES: CATEGORIES,
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
    parseTags: parseTags,
    getTripIdFromSearch: getTripIdFromSearch,
    buildShareUrl: buildShareUrl,
    upsertTripIndexEntry: upsertTripIndexEntry,
    removeTripIndexEntry: removeTripIndexEntry,
    ratingSummary: ratingSummary,
    myRatingScore: myRatingScore,
    sortMyLogItems: sortMyLogItems,
    weatherLabel: weatherLabel
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
  var CURRENT_USER_KEY = 'tabilog:user';

  function $(sel, root2) { return (root2 || document).querySelector(sel); }
  function $all(sel, root2) { return Array.prototype.slice.call((root2 || document).querySelectorAll(sel)); }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function showScreen(name) {
    $all('.screen').forEach(function (s) { s.classList.toggle('active', s.dataset.screen === name); });
    window.scrollTo(0, 0);
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
      coverPhotoId: trip.coverPhotoId || ''
    });
    localStorage.setItem(MY_TRIPS_KEY, JSON.stringify(list));
  }
  function forgetTrip(id) {
    localStorage.setItem(MY_TRIPS_KEY, JSON.stringify(Core.removeTripIndexEntry(loadMyTrips(), id)));
  }

  function photoUrl(id) {
    if (!id) return '';
    return API_BASE + '/photos/' + id;
  }

  // ---------- 写真の拡大表示（ライトボックス） ----------
  function openPhotoLightbox(url) {
    $('#lightboxImg').src = url;
    $('#photoLightbox').hidden = false;
  }
  function closePhotoLightbox() {
    $('#photoLightbox').hidden = true;
    $('#lightboxImg').src = '';
  }

  function openVideoLightbox(url) {
    $('#lightboxVideo').src = url;
    $('#videoLightbox').hidden = false;
  }
  function closeVideoLightbox() {
    var v = $('#lightboxVideo');
    v.pause();
    v.src = '';
    $('#videoLightbox').hidden = true;
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
    grid.innerHTML = items.map(function (it) {
      var dateBadge = it.date ? '<span class="album-date">' + escapeHtml(it.date.slice(5).replace('-', '/')) + '</span>' : '';
      if (it.type === 'photo') {
        return '<div class="album-tile" data-type="photo" data-id="' + escapeHtml(it.id) + '" style="background-image:url(\'' + escapeHtml(photoUrl(it.id)) + '\')">' + dateBadge + '</div>';
      }
      return '<div class="album-tile" data-type="video" data-id="' + escapeHtml(it.id) + '">' +
        '<video src="' + escapeHtml(photoUrl(it.id)) + '#t=0.1" preload="metadata" muted playsinline></video>' +
        '<div class="album-play">' + ALBUM_PLAY_ICON + '</div>' + dateBadge +
        '</div>';
    }).join('');

    $all('.album-tile', grid).forEach(function (tile) {
      tile.addEventListener('click', function () {
        var url = photoUrl(tile.dataset.id);
        if (tile.dataset.type === 'video') openVideoLightbox(url);
        else openPhotoLightbox(url);
      });
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

  function nativeApi(path, method, body) {
    return window.Capacitor.Plugins.CapacitorHttp.request({
      url: API_BASE + path,
      method: method || 'GET',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
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
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
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
    var headers = Object.assign({ 'content-type': blob.type || 'application/octet-stream' }, extraHeaders || {});
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
  // （atob/btoaはLatin1前提のため、encodeURIComponent/unescapeで橋渡しする）
  function createVoiceEntries(tripId, date, blob, meta) {
    var metaHeader = btoa(unescape(encodeURIComponent(JSON.stringify(meta))));
    return postBinary(
      '/trips/' + encodeURIComponent(tripId) + '/days/' + encodeURIComponent(date) + '/voice-entries',
      blob,
      { 'x-voice-meta': metaHeader }
    );
  }

  // 音声の文字起こし版と違い、貼り付けたテキストをそのままJSONで送るだけなのでbase64化は不要
  function createTextEntries(tripId, date, text, meta) {
    return api(
      '/trips/' + encodeURIComponent(tripId) + '/days/' + encodeURIComponent(date) + '/text-entries',
      'POST',
      { text: text, notes: meta.notes, author: meta.author, email: meta.email }
    );
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
    formPhotoIds: [],         // 既存（サーバー上）の写真id
    pendingPhotos: [],        // 新規に選んだ、まだアップロードしていない {blob, url}
    formVideoIds: [],         // 既存（サーバー上）の動画id
    pendingVideos: [],        // 新規に選んだ、まだアップロードしていない {blob, name, size}
    formCostItems: [],        // {label, amount}
    loginReturnTo: 'home',    // ログイン画面から戻る先の画面名
    myLogItems: [],
    myLogTrips: [],
    myLogPlaces: { prefectures: [], countries: [] },
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

  function renderHomeTripList() {
    var list = loadMyTrips();
    var el = $('#tripList');
    if (!list.length) {
      el.innerHTML = '<div class="empty">まだ旅行がありません。「＋ 新しい旅を記録する」から始めてください。</div>';
      return;
    }
    el.innerHTML = '';
    list.forEach(function (t) {
      var card = document.createElement('button');
      card.className = 'trip-card';
      var dateText = t.startDate ? Core.formatDateJp(t.startDate) + (t.endDate && t.endDate !== t.startDate ? ' 〜 ' + Core.formatDateJp(t.endDate) : '') : '';
      card.innerHTML =
        '<div class="trip-card-row">' +
        tripThumbHtml(t.coverPhotoId) +
        '<div class="trip-card-body">' +
        '<div class="trip-card-top"><div class="trip-card-title">' + escapeHtml(t.title) + '</div>' +
        (dateText ? '<span class="trip-card-date">' + escapeHtml(dateText) + '</span>' : '') + '</div>' +
        '<div class="trip-card-companions">' +
        ((t.companions || []).length ? escapeHtml(t.companions.join('・')) + ' と一緒' : '参加者は未設定') + '</div>' +
        '</div></div>';
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
      var added = false;
      (data.trips || []).forEach(function (t) {
        if (knownIds[t.id]) return;
        known = Core.upsertTripIndexEntry(known, {
          id: t.id, title: t.title, startDate: t.startDate, endDate: t.endDate, companions: t.companions || [],
          coverPhotoId: t.coverPhotoId || ''
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
      var dates = Core.allDatesForTrip(state.trip, state.blocks);
      state.selectedDate = dates[0] !== undefined ? dates[0] : '';
      rememberTrip(state.trip);
      history.pushState(null, '', Core.buildShareUrl(location.origin, location.pathname, id).replace(location.origin, ''));
      showScreen('tripDetail');
      renderTripDetail();
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

  // ---------- 旅行詳細 ----------
  function renderTripDetail() {
    var trip = state.trip;
    var coverEl = $('#tripCoverPhoto');
    coverEl.hidden = !trip.coverPhotoId;
    coverEl.style.backgroundImage = trip.coverPhotoId ? "url('" + photoUrl(trip.coverPhotoId) + "')" : '';
    $('#tripTitle').textContent = trip.title;
    var range = trip.startDate ? Core.formatDateJp(trip.startDate) + (trip.endDate ? ' 〜 ' + Core.formatDateJp(trip.endDate) : '') : '日程未設定';
    var nights = Core.tripNights(trip);
    $('#tripDates').textContent = range + (nights ? '・' + nights : '');
    $('#tripCompanions').textContent = (trip.companions || []).length ? trip.companions.join('・') + ' と一緒' : '参加者は未設定';
    renderTripJoin();

    var lodging = Core.primaryLodgingName(state.blocks);
    var total = Core.tripTotalCost(state.blocks);
    $('#tripStats').innerHTML =
      statCard('宿泊先', lodging || '未設定') +
      statCard('総費用', Core.formatYen(total) || '¥0') +
      statCard('日程', nights || (Core.allDatesForTrip(trip, state.blocks).length + '日'));

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

  // 音声入力は有料プラン専用（docs/adr/0004）。ログインしていない、またはプラン・回数券が
  // 無い場合は、録音の代わりに案内とプランへの導線を出す。
  function openVoiceEntryForm() {
    var user = loadCurrentUser();
    if (!user) { openLogin('voiceEntryForm'); return; }
    if (!state.selectedDate) { alert('先に日付を選んでから音声入力を始めてください。'); return; }
    showScreen('voiceEntryForm');
    $('#voicePremiumRequired').hidden = true;
    $('#voiceRecordArea').hidden = true;
    $('#voicePremiumMessage').textContent = '確認しています…';
    fetchAccountStatus().then(function (account) {
      var ok = account && (account.voiceRemainingThisPeriod > 0 || account.ticketCredits > 0);
      if (!ok) {
        $('#voicePremiumRequired').hidden = false;
        $('#voiceRecordArea').hidden = true;
        $('#voicePremiumMessage').textContent = !account
          ? '音声入力はログインすると使えます。'
          : '今月の音声入力の回数を使い切りました。プランのアップグレードや回数券をご検討ください。';
        return;
      }
      voiceBlob = null;
      $('#voiceNotes').value = '';
      setVoiceRecordLabel(MIC_ICON, '話しはじめる');
      $('#btnVoiceRecord').disabled = false;
      $('#btnCreateVoiceEntries').hidden = true;
      $('#btnCreateVoiceEntries').disabled = false;
      $('#voiceRecordStatus').textContent = '';
      $('#voiceRecordStatus').classList.remove('is-recording');
      $('#voiceEntryStatus').textContent = '';
      $('#textMemoInput').value = '';
      $('#btnCreateTextEntries').disabled = false;
      $('#textEntryStatus').textContent = '';
      $('#voicePremiumRequired').hidden = true;
      $('#voiceRecordArea').hidden = false;
    });
  }

  function handleVoiceRecordToggle() {
    if (voiceRecorder && voiceRecorder.state === 'recording') {
      voiceRecorder.stop();
      return;
    }
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
    createVoiceEntries(state.trip.id, state.selectedDate, voiceBlob, meta).then(function () {
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
      else if (msg === 'invalid_model_output' || msg === 'upstream_error') $('#voiceEntryStatus').textContent = 'うまく処理できませんでした。もう一度お試しください。';
      else if (msg === 'login_required' || msg === 'premium_required' || msg === 'quota_exceeded') {
        $('#voiceEntryStatus').textContent = '';
        openVoiceEntryForm();
      }
      else $('#voiceEntryStatus').textContent = '失敗しました。もう一度お試しください。';
    });
  }

  function handleCreateTextEntries() {
    var text = $('#textMemoInput').value.trim();
    if (!text) { $('#textEntryStatus').textContent = '先にスケジュールやメモを入力してください。'; return; }
    var user = loadCurrentUser();
    var meta = { notes: $('#voiceNotes').value.trim(), author: (user && user.name) || '', email: (user && user.email) || '' };
    $('#btnCreateTextEntries').disabled = true;
    $('#textEntryStatus').textContent = 'AIが内容を確認しています…';
    createTextEntries(state.trip.id, state.selectedDate, text, meta).then(function () {
      return refreshTrip();
    }).then(function () {
      $('#btnCreateTextEntries').disabled = false;
      showScreen('tripDetail');
      renderDaySection();
    }).catch(function (e) {
      var msg = (e && e.message) || '';
      $('#btnCreateTextEntries').disabled = false;
      if (msg === 'server_not_configured') $('#textEntryStatus').textContent = 'この機能はまだ使えません（サーバー側の設定が必要です）。';
      else if (msg === 'rate_limited') $('#textEntryStatus').textContent = '少し時間をおいてからもう一度お試しください。';
      else if (msg === 'invalid_model_output' || msg === 'upstream_error') $('#textEntryStatus').textContent = 'うまく処理できませんでした。もう一度お試しください。';
      else if (msg === 'login_required' || msg === 'premium_required' || msg === 'quota_exceeded') {
        $('#textEntryStatus').textContent = '';
        openVoiceEntryForm();
      }
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

  // 日タブを左右スワイプで切り替える。タイムライン上での横方向の指の動きを見て、
  // 縦スクロールと誤認しないよう「最初にどちらの向きに動いたか」で一度だけ判定する。
  // Blockの並べ替え・記録の移動ドラッグは持ち手（.block-drag-handle / .entry-drag-handle）
  // から始まる操作なので、そこから始まったタッチはスワイプの対象にしない。
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
      daySwipeState = { startX: t.clientX, startY: t.clientY, decided: false, horizontal: false };
    }, { passive: true });

    el.addEventListener('touchmove', function (e) {
      if (!daySwipeState || e.touches.length !== 1) return;
      var t = e.touches[0];
      var dx = t.clientX - daySwipeState.startX;
      var dy = t.clientY - daySwipeState.startY;
      if (!daySwipeState.decided && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
        daySwipeState.decided = true;
        daySwipeState.horizontal = Math.abs(dx) > Math.abs(dy) * 1.5;
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

  function renderTimeline(blocks) {
    var el = $('#timeline');
    el.innerHTML = '';
    if (!blocks.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'この日の記録はまだありません。下のボタンから追加できます。';
      el.appendChild(empty);
    }
    blocks.forEach(function (block) {
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
    voiceBtn.addEventListener('click', openVoiceEntryForm);
    el.appendChild(voiceBtn);
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
      '<span class="block-cat" style="background:color-mix(in oklch,' + Core.categoryColor(block.category) + ' 18%, white);color:' + Core.categoryColor(block.category) + '">' + escapeHtml(Core.categoryLabel(block.category)) + '</span>';
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

    var videosHtml = (entry.videoIds || []).length
      ? '<div class="entry-videos">' + entry.videoIds.map(function (id) {
          return '<video src="' + escapeHtml(photoUrl(id)) + '" controls></video>';
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
      (metaBits.length ? '<div class="entry-meta">' + metaBits.join('') + '</div>' : '');

    // 写真をタップしたときは編集画面へ行かず、拡大表示（ライトボックス）を開く
    card.addEventListener('click', function (e) {
      var photoEl = e.target.closest('.entry-photo');
      if (photoEl) {
        e.stopPropagation();
        openPhotoLightbox(photoUrl(photoEl.dataset.photoId));
        return;
      }
      // 動画（.entry-videos内のvideoタグ）の操作・全画面再生からの復帰は編集画面へ行かない。
      // iOSのWKWebViewは動画の全画面再生を閉じたときにvideo要素へ合成的なclickイベントを
      // 発生させることがあり、これを拾うと「動画を見て戻ったら勝手に編集画面が開く」ことになる。
      if (e.target.closest('.entry-videos')) return;
      if (e.target.closest('.entry-card-head') || e.target.closest('.entry-move-menu')) return;
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

  // ---------- 大項目（予定）の追加・編集 ----------
  function openBlockForm(block) {
    state.editingBlockId = block ? block.id : null;
    state.formCategory = block ? block.category : 'sightseeing';
    $('#blkFormTitle').textContent = block ? '予定を編集' : '予定を追加';
    $('#blkDate').value = block ? block.date : (state.selectedDate || new Date().toISOString().slice(0, 10));
    $('#blkTime').value = block ? block.time : '';
    $('#blkLabel').value = block ? block.label : '';
    $('#blkFormStatus').textContent = '';
    $('#btnDeleteBlock').hidden = !block;
    renderCategoryChips();
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
      category: state.formCategory
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
    state.formPhotoIds = entry ? (entry.photoIds || []).slice() : [];
    state.pendingPhotos = [];
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
    $('#entPlaceSearch').value = '';
    $('#entMapPreview').hidden = true;
    var loggedInUser = loadCurrentUser();
    $('#entAuthor').value = entry ? entry.author : (loggedInUser ? (loggedInUser.name || loggedInUser.email) : '');
    $('#entFormStatus').textContent = '';
    $('#btnDeleteEntry').hidden = !entry;

    renderPhotoPreview();
    renderVideoPreview();
    renderCostItems();
    renderEntryRatingSection();
    showScreen('entryForm');
  }

  // ---------- 評価（★1〜5） ----------
  // 評価はログイン必須。閲覧・記録の追加自体はログイン不要のまま。
  // 1つの記録に、ログインした人それぞれが1つずつ評価を付けられる（自分の分だけこの画面から操作する）。
  function renderEntryRatingSection() {
    var field = $('#entRatingField');
    var entry = state.editingEntry;
    if (!loginEnabled() || !entry) { field.hidden = true; return; }
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
    var fine = mine > 0
      ? '<div class="rating-fine">' +
        '<button type="button" class="btn ghost small" id="ratingFineMinus">－0.1</button>' +
        '<span class="rating-fine-value">★' + mine.toFixed(1) + '</span>' +
        '<button type="button" class="btn ghost small" id="ratingFinePlus">＋0.1</button>' +
        '</div>'
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

  function renderPhotoPreview() {
    var el = $('#entPhotoPreview');
    el.innerHTML = '';
    state.formPhotoIds.forEach(function (id, idx) {
      var ph = document.createElement('div');
      ph.className = 'ph';
      ph.innerHTML = '<img src="' + escapeHtml(photoUrl(id)) + '">' +
        '<button type="button" class="ph-rotate" aria-label="90度回す">' + ROTATE_ICON + '</button>' +
        '<button type="button" class="ph-remove" aria-label="削除">×</button>';
      ph.querySelector('.ph-remove').addEventListener('click', function () {
        state.formPhotoIds.splice(idx, 1);
        renderPhotoPreview();
      });
      // 保存済みの写真の回転は、一度取得→回転→再アップロードしてidを差し替える
      // （このアプリに写真の上書き更新APIが無いため、新しい写真として置き換える形）
      ph.querySelector('.ph-rotate').addEventListener('click', function () {
        var btn = ph.querySelector('.ph-rotate');
        btn.disabled = true;
        fetch(photoUrl(id)).then(function (res) { return res.blob(); })
          .then(function (blob) { return rotateImageBlob(blob, 90); })
          .then(function (rotated) { return uploadPhotoBlob(rotated); })
          .then(function (p) {
            state.formPhotoIds[idx] = p.id;
            renderPhotoPreview();
          })
          .catch(function () { btn.disabled = false; alert('写真の回転に失敗しました。もう一度お試しください。'); });
      });
      el.appendChild(ph);
    });
    state.pendingPhotos.forEach(function (p, idx) {
      var ph = document.createElement('div');
      ph.className = 'ph';
      ph.innerHTML = '<img src="' + p.url + '">' +
        '<button type="button" class="ph-rotate" aria-label="90度回す">' + ROTATE_ICON + '</button>' +
        '<button type="button" class="ph-remove" aria-label="削除">×</button>';
      ph.querySelector('.ph-remove').addEventListener('click', function () {
        URL.revokeObjectURL(state.pendingPhotos[idx].url);
        state.pendingPhotos.splice(idx, 1);
        renderPhotoPreview();
      });
      ph.querySelector('.ph-rotate').addEventListener('click', function () {
        rotateImageBlob(state.pendingPhotos[idx].blob, 90).then(function (rotated) {
          URL.revokeObjectURL(state.pendingPhotos[idx].url);
          state.pendingPhotos[idx] = { blob: rotated, url: URL.createObjectURL(rotated) };
          renderPhotoPreview();
        });
      });
      el.appendChild(ph);
    });
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

  function closeCostSubRow(row, className) {
    var sib = row.nextElementSibling;
    if (sib && sib.classList.contains(className)) sib.remove();
  }

  // 「立て替え」（誰が払った・誰と割るか）の選択パネル。旅行の参加者（trip.companions）を
  // チップで選ぶだけのシンプルな作り。チップを押すたびに全体を再描画するとパネルが
  // 閉じてしまうので、ここだけはDOMを直接書き換えて開いたままにする。
  function buildCostPayerRow(idx, row) {
    var companions = (state.trip && state.trip.companions) || [];
    var panel = document.createElement('div');
    panel.className = 'cost-payer-row';
    if (!companions.length) {
      panel.innerHTML = '<p class="hint">参加者が未設定です。旅行の編集画面で参加者を入力すると選べるようになります。</p>';
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

    companions.forEach(function (name) {
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
      item.splitAmong = companions.slice();
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
  // そのまま入れる（CONTEXT.md参照）。ただし駐車場代など全体でまとめて払ったものは、
  // 「全体費用」と「人数」から個人費用を計算して入れられるよう、行ごとに電卓を用意する
  // （計算結果を金額欄に反映するだけで、保存する値はあくまで個人費用のまま）。
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
          '<button type="button" class="cost-split-toggle" aria-label="全体費用から計算">÷人数</button>' +
          '<button type="button" class="cost-payer-toggle' + (item.paidBy ? ' on' : '') + '" aria-label="立て替えを設定">' + escapeHtml(payerLabel) + '</button>' +
        '</div>';
      var inputs = row.querySelectorAll('input');
      var amountInput = inputs[1];
      inputs[0].addEventListener('input', function (e) { state.formCostItems[idx].label = e.target.value; });
      amountInput.addEventListener('input', function (e) {
        state.formCostItems[idx].amount = Math.max(0, parseInt(e.target.value, 10) || 0);
        renderCostTotal();
      });
      row.querySelector('.cost-split-toggle').addEventListener('click', function () {
        closeCostSubRow(row, 'cost-payer-row');
        var existing = row.nextElementSibling;
        if (existing && existing.classList.contains('cost-split-row')) { existing.remove(); return; }
        var splitRow = document.createElement('div');
        splitRow.className = 'cost-split-row';
        splitRow.innerHTML =
          '<input type="number" min="0" step="1" placeholder="全体費用（円）">' +
          '<span>÷</span>' +
          '<input type="number" min="1" step="1" placeholder="人数" value="2">' +
          '<button type="button">反映</button>';
        var splitInputs = splitRow.querySelectorAll('input');
        splitRow.querySelector('button').addEventListener('click', function () {
          var total = Math.max(0, parseInt(splitInputs[0].value, 10) || 0);
          var count = Math.max(1, parseInt(splitInputs[1].value, 10) || 1);
          var perPerson = Math.round(total / count);
          amountInput.value = perPerson;
          state.formCostItems[idx].amount = perPerson;
          renderCostTotal();
          splitRow.remove();
        });
        row.insertAdjacentElement('afterend', splitRow);
      });
      row.querySelector('.cost-payer-toggle').addEventListener('click', function () {
        closeCostSubRow(row, 'cost-split-row');
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
  // どちらもGoogle側が場所名をその場で解決してくれるので、こちらでジオコーディングは行わない。
  function showPlaceMapPreview() {
    var place = $('#entPlaceSearch').value.trim();
    if (!place) return;
    $('#entMapPreviewFrame').src = 'https://maps.google.com/maps?q=' + encodeURIComponent(place) + '&output=embed';
    $('#entMapPreview').hidden = false;
  }

  function useSearchedPlaceAsMapUrl() {
    var place = $('#entPlaceSearch').value.trim();
    if (!place) return;
    $('#entMapUrl').value = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(place);
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

    Promise.all([
      Promise.all(state.pendingPhotos.map(function (p) { return uploadPhotoBlob(p.blob); })),
      Promise.all(state.pendingVideos.map(function (v) { return uploadPhotoBlob(v.blob); }))
    ])
      .then(function (results) {
        var uploaded = results[0], uploadedVideos = results[1];
        payload.photoIds = state.formPhotoIds.concat(uploaded.map(function (u) { return u.id; }));
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
    var usageText = '今月の音声入力：残り' + account.voiceRemainingThisPeriod + '回（月' + account.voiceMonthlyLimit + '回まで）';

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
  function deleteMyAccount() {
    var user = loadCurrentUser();
    if (!user) return;
    if (!confirm('アカウントを削除しますか？\n（名前・プラン・回数券の情報が削除されます。旅行の記録自体は削除されません。同じメールアドレスで登録し直しても、音声入力の利用回数は復活しません）')) return;
    api('/accounts/delete', 'POST', { email: user.email }).then(function () {
      clearCurrentUser();
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

  // ---------- 初期化 ----------
  function init() {
    $('#btnCloseLightbox').addEventListener('click', closePhotoLightbox);
    $('#photoLightbox').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) closePhotoLightbox();
    });
    $('#btnCloseVideoLightbox').addEventListener('click', closeVideoLightbox);
    $('#videoLightbox').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) closeVideoLightbox();
    });
    $('#btnOpenAlbum').addEventListener('click', openAlbum);
    $('#btnOpenSettlement').addEventListener('click', openSettlement);
    $('#btnScanReceipt').addEventListener('click', function () { $('#receiptFileInput').click(); });
    $('#btnPlaceSearch').addEventListener('click', showPlaceMapPreview);
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

    $('#btnSaveBlock').addEventListener('click', saveBlock);
    $('#btnDeleteBlock').addEventListener('click', deleteBlock);

    $('#btnSaveEntry').addEventListener('click', saveEntry);
    $('#btnDeleteEntry').addEventListener('click', deleteEntry);
    $('#btnAddCostItem').addEventListener('click', function () {
      state.formCostItems.push({ label: '', amount: 0 });
      renderCostItems();
    });

    $('#entPhotoPicker').addEventListener('click', function () { $('#entPhoto').click(); });
    $('#entPhoto').addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files || []);
      Promise.all(files.map(function (f) { return fileToCompressedBlob(f, 1280, 0.72); })).then(function (blobs) {
        blobs.forEach(function (blob) { state.pendingPhotos.push({ blob: blob, url: URL.createObjectURL(blob) }); });
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
      ensureAccountAndProceed({ name: name || res.name || email, email: res.email, provider: 'email' });
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
