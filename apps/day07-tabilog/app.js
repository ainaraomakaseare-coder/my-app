/*
 * たびログ
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
    { key: 'transport', label: '移動', color: 'oklch(60% 0.05 260)' },
    { key: 'other', label: 'その他', color: 'oklch(55% 0.02 280)' }
  ];

  var WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

  function categoryLabel(key) {
    var c = CATEGORIES.filter(function (c) { return c.key === key; })[0];
    return c ? c.label : key;
  }
  function categoryColor(key) {
    var c = CATEGORIES.filter(function (c) { return c.key === key; })[0];
    return c ? c.color : 'oklch(55% 0.02 280)';
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

  function sortBlocks(blocks) {
    return (blocks || []).slice().sort(function (a, b) {
      if (a.date !== b.date) return (a.date || '').localeCompare(b.date || '');
      if (a.time !== b.time) return (a.time || '').localeCompare(b.time || '');
      return (a.createdAt || '').localeCompare(b.createdAt || '');
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

  function primaryLodgingName(blocks) {
    var lodging = (blocks || []).filter(function (b) { return b.category === 'lodging' && b.label; });
    if (!lodging.length) return '';
    var names = [];
    var seen = {};
    lodging.forEach(function (b) { if (!seen[b.label]) { seen[b.label] = true; names.push(b.label); } });
    return names.join('・');
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
    primaryLodgingName: primaryLodgingName,
    parseTags: parseTags,
    getTripIdFromSearch: getTripIdFromSearch,
    buildShareUrl: buildShareUrl,
    upsertTripIndexEntry: upsertTripIndexEntry
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
  var MY_TRIPS_KEY = 'tabilog:my-trips';

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

  function loadMyTrips() {
    try { return JSON.parse(localStorage.getItem(MY_TRIPS_KEY) || '[]'); } catch (e) { return []; }
  }
  function rememberTrip(trip) {
    var list = Core.upsertTripIndexEntry(loadMyTrips(), {
      id: trip.id, title: trip.title, startDate: trip.startDate, endDate: trip.endDate, companions: trip.companions
    });
    localStorage.setItem(MY_TRIPS_KEY, JSON.stringify(list));
  }

  function photoUrl(id) {
    if (!id) return '';
    return API_BASE + '/photos/' + id;
  }

  function api(path, method, body) {
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

  function uploadPhotoBlob(blob) {
    return fetch(API_BASE + '/photos', {
      method: 'POST',
      headers: { 'content-type': blob.type || 'image/jpeg' },
      body: blob
    }).then(function (res) {
      if (!res.ok) throw new Error('upload_failed');
      return res.json();
    });
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

  // ---------- 状態 ----------
  var state = {
    trip: null,
    blocks: [],
    selectedDate: null,
    editingBlockId: null,
    formCategory: 'sightseeing',
    editingEntryId: null,
    entryBlockId: null,       // 記録を追加する先の大項目
    formPhotoIds: [],         // 既存（サーバー上）の写真id
    pendingPhotos: [],        // 新規に選んだ、まだアップロードしていない {blob, url}
    formCostItems: []         // {label, amount}
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
        '<div class="trip-card-top"><div class="trip-card-title">' + escapeHtml(t.title) + '</div>' +
        (dateText ? '<span class="trip-card-date">' + escapeHtml(dateText) + '</span>' : '') + '</div>' +
        '<div class="trip-card-companions">' +
        ((t.companions || []).length ? escapeHtml(t.companions.join('・')) + ' と一緒' : '参加者は未設定') + '</div>';
      card.addEventListener('click', function () { openTrip(t.id); });
      el.appendChild(card);
    });
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
      var dates = Core.allDatesForTrip(state.trip, state.blocks);
      var today = new Date().toISOString().slice(0, 10);
      state.selectedDate = dates.indexOf(today) !== -1 ? today : (dates[0] !== undefined ? dates[0] : '');
      rememberTrip(state.trip);
      history.pushState(null, '', Core.buildShareUrl(location.origin, location.pathname, id).replace(location.origin, ''));
      showScreen('tripDetail');
      renderTripDetail();
    }).catch(function () {
      alert('旅行が見つかりませんでした。リンクを確認してください。');
      goHome();
    });
  }

  function refreshTrip() {
    return api('/trips/' + encodeURIComponent(state.trip.id)).then(function (data) {
      state.trip = data.trip;
      state.blocks = data.blocks;
    });
  }

  // ---------- 新規作成 ----------
  function openNewTripForm() {
    $('#ntTitle').value = '';
    $('#ntStart').value = '';
    $('#ntEnd').value = '';
    $('#ntCompanions').value = '';
    $('#newTripStatus').textContent = '';
    showScreen('newTrip');
  }

  function createTrip() {
    var title = $('#ntTitle').value.trim();
    var status = $('#newTripStatus');
    if (!API_BASE) { status.textContent = 'サーバーが未設定のため作成できません。'; return; }
    if (!title) { status.textContent = 'タイトルを入力してください。'; return; }
    status.textContent = '作成中…';
    api('/trips', 'POST', {
      title: title,
      startDate: $('#ntStart').value,
      endDate: $('#ntEnd').value,
      companions: Core.parseTags($('#ntCompanions').value)
    }).then(function (trip) {
      rememberTrip(trip);
      openTrip(trip.id);
    }).catch(function () {
      status.textContent = '作成に失敗しました。もう一度お試しください。';
    });
  }

  // ---------- 旅行詳細 ----------
  function renderTripDetail() {
    var trip = state.trip;
    $('#tripTitle').textContent = trip.title;
    var range = trip.startDate ? Core.formatDateJp(trip.startDate) + (trip.endDate ? ' 〜 ' + Core.formatDateJp(trip.endDate) : '') : '日程未設定';
    var nights = Core.tripNights(trip);
    $('#tripDates').textContent = range + (nights ? '・' + nights : '');
    $('#tripCompanions').textContent = (trip.companions || []).length ? trip.companions.join('・') + ' と一緒' : '参加者は未設定';

    var lodging = Core.primaryLodgingName(state.blocks);
    var total = Core.tripTotalCost(state.blocks);
    $('#tripStats').innerHTML =
      statCard('宿泊先', lodging || '未設定') +
      statCard('総費用', Core.formatYen(total) || '¥0') +
      statCard('日程', nights || (Core.allDatesForTrip(trip, state.blocks).length + '日'));

    renderDayTabs();
    renderDaySection();
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

  function renderDaySection() {
    $('#dayTitle').textContent = Core.dayLabel(state.trip, state.selectedDate) + 'のきろく';
    renderTimeline(currentDayBlocks());
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
  }

  function renderBlockEl(block) {
    var wrap = document.createElement('div');
    wrap.className = 'block';

    var head = document.createElement('div');
    head.className = 'block-head';
    head.innerHTML =
      (block.time ? '<span class="block-time">' + escapeHtml(block.time) + '</span>' : '') +
      '<span class="block-label">' + escapeHtml(block.label || Core.categoryLabel(block.category)) + '</span>' +
      '<span class="block-cat"><span class="dot" style="background:' + Core.categoryColor(block.category) + '"></span>' + escapeHtml(Core.categoryLabel(block.category)) + '</span>';
    head.addEventListener('click', function () { openBlockForm(block); });
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

  function renderEntryEl(block, entry) {
    var card = document.createElement('div');
    card.className = 'entry-card' + (block.category === 'lodging' ? ' lodging' : '');

    var photosHtml = (entry.photoIds || []).length
      ? '<div class="entry-photos">' + entry.photoIds.map(function (id) {
          return '<div class="entry-photo" style="background-image:url(\'' + escapeHtml(photoUrl(id)) + '\')"></div>';
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

    card.innerHTML =
      '<div class="entry-author">記録：' + escapeHtml(entry.author || '匿名') + '</div>' +
      photosHtml +
      (entry.episode ? '<div class="entry-episode">' + escapeHtml(entry.episode) + '</div>' : '') +
      (entry.comment ? '<div class="entry-comment">「' + escapeHtml(entry.comment) + '」</div>' : '') +
      costHtml +
      (metaBits.length ? '<div class="entry-meta">' + metaBits.join('') + '</div>' : '');

    card.addEventListener('click', function () { openEntryForm(block.id, entry); });
    return card;
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
    state.formPhotoIds = entry ? (entry.photoIds || []).slice() : [];
    state.pendingPhotos = [];
    state.formCostItems = entry ? (entry.costItems || []).map(function (it) { return { label: it.label, amount: it.amount }; }) : [];

    $('#entFormTitle').textContent = entry ? '記録を編集' : '記録を追加';
    $('#entEpisode').value = entry ? entry.episode : '';
    $('#entComment').value = entry ? entry.comment : '';
    $('#entWaitTime').value = entry ? entry.waitTime : '';
    $('#entMapUrl').value = entry ? entry.mapUrl : '';
    $('#entShopUrl').value = entry ? entry.shopUrl : '';
    $('#entAuthor').value = entry ? entry.author : '';
    $('#entFormStatus').textContent = '';
    $('#btnDeleteEntry').hidden = !entry;

    renderPhotoPreview();
    renderCostItems();
    showScreen('entryForm');
  }

  function renderPhotoPreview() {
    var el = $('#entPhotoPreview');
    el.innerHTML = '';
    state.formPhotoIds.forEach(function (id, idx) {
      var ph = document.createElement('div');
      ph.className = 'ph';
      ph.innerHTML = '<img src="' + escapeHtml(photoUrl(id)) + '"><button type="button">×</button>';
      ph.querySelector('button').addEventListener('click', function () {
        state.formPhotoIds.splice(idx, 1);
        renderPhotoPreview();
      });
      el.appendChild(ph);
    });
    state.pendingPhotos.forEach(function (p, idx) {
      var ph = document.createElement('div');
      ph.className = 'ph';
      ph.innerHTML = '<img src="' + p.url + '"><button type="button">×</button>';
      ph.querySelector('button').addEventListener('click', function () {
        state.pendingPhotos.splice(idx, 1);
        renderPhotoPreview();
      });
      el.appendChild(ph);
    });
  }

  function renderCostItems() {
    var el = $('#entCostItems');
    el.innerHTML = '';
    state.formCostItems.forEach(function (item, idx) {
      var row = document.createElement('div');
      row.className = 'cost-item-row';
      row.innerHTML =
        '<input type="text" placeholder="内容（例：そば）" value="' + escapeHtml(item.label) + '">' +
        '<input type="number" min="0" step="1" placeholder="円" value="' + (item.amount || '') + '">' +
        '<button type="button" aria-label="削除">×</button>';
      var inputs = row.querySelectorAll('input');
      inputs[0].addEventListener('input', function (e) { state.formCostItems[idx].label = e.target.value; });
      inputs[1].addEventListener('input', function (e) {
        state.formCostItems[idx].amount = Math.max(0, parseInt(e.target.value, 10) || 0);
        renderCostTotal();
      });
      row.querySelector('button').addEventListener('click', function () {
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

  function saveEntry() {
    var status = $('#entFormStatus');
    if (!API_BASE) { status.textContent = 'サーバーが未設定のため保存できません。'; return; }
    var author = $('#entAuthor').value.trim();
    status.textContent = '保存中…';

    var payload = {
      episode: $('#entEpisode').value.trim(),
      comment: $('#entComment').value.trim(),
      costItems: state.formCostItems.filter(function (it) { return it.label.trim() || it.amount; })
        .map(function (it) { return { label: it.label.trim() || '費用', amount: it.amount || 0 }; }),
      waitTime: $('#entWaitTime').value.trim(),
      mapUrl: $('#entMapUrl').value.trim(),
      shopUrl: $('#entShopUrl').value.trim(),
      author: author
    };

    Promise.all(state.pendingPhotos.map(function (p) { return uploadPhotoBlob(p.blob); }))
      .then(function (uploaded) {
        payload.photoIds = state.formPhotoIds.concat(uploaded.map(function (u) { return u.id; }));
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

  // ---------- 初期化 ----------
  function init() {
    $('#btnNewTrip').addEventListener('click', openNewTripForm);
    $('#btnCreateTrip').addEventListener('click', createTrip);
    $('#btnOpenTripId').addEventListener('click', function () {
      var id = $('#openTripId').value.trim();
      if (id) openTrip(id);
    });

    $('#btnShareTrip').addEventListener('click', copyShareLink);
    $('#btnInvite').addEventListener('click', copyShareLink);

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

    $all('[data-back]').forEach(function (b) {
      b.addEventListener('click', function () {
        var to = b.dataset.back;
        if (to === 'home') goHome();
        else { showScreen(to); if (to === 'tripDetail') renderTripDetail(); }
      });
    });

    apiNoticeCheck();
    var tripId = Core.getTripIdFromSearch(location.search);
    if (tripId) openTrip(tripId);
    else { showScreen('home'); renderHome(); }
  }

  function copyShareLink() {
    if (!state.trip) return;
    var url = location.href;
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
