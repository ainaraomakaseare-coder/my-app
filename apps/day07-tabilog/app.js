/*
 * たびログ
 * 旅行（trip）とエピソードはサーバー（Cloudflare Worker + D1 + R2）に保存する。
 * データを扱う純粋な関数は window.TabiLog に集めてあり、node からもテストできる。
 */
(function (root) {
  'use strict';

  var CATEGORIES = [
    { key: 'sightseeing', label: '観光' },
    { key: 'food', label: '食事' },
    { key: 'lodging', label: '宿泊' },
    { key: 'transport', label: '移動' },
    { key: 'other', label: 'その他' }
  ];

  var WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

  function categoryLabel(key) {
    var c = CATEGORIES.filter(function (c) { return c.key === key; })[0];
    return c ? c.label : key;
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

  // 開始日・終了日から旅行の全日程を作る。無ければエピソードに実際にある日付から作る
  // （日付未入力のエピソードがあれば、末尾に空文字のキーとしてまとめる）。
  function allDatesForTrip(trip, episodes) {
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
      (episodes || []).forEach(function (ep) { if (ep.date) seen[ep.date] = true; });
      dates = Object.keys(seen).sort();
    }
    var hasUndated = (episodes || []).some(function (ep) { return !ep.date; });
    if (hasUndated) dates = dates.concat(['']);
    return dates;
  }

  function sortEpisodes(episodes) {
    return (episodes || []).slice().sort(function (a, b) {
      if (a.date !== b.date) return (a.date || '').localeCompare(b.date || '');
      if (a.time !== b.time) return (a.time || '').localeCompare(b.time || '');
      return (a.createdAt || '').localeCompare(b.createdAt || '');
    });
  }

  function groupEpisodesByDate(episodes) {
    var map = {};
    sortEpisodes(episodes).forEach(function (ep) {
      var key = ep.date || '';
      if (!map[key]) map[key] = [];
      map[key].push(ep);
    });
    return map;
  }

  function distinctGroupTags(episodes) {
    var seen = {};
    var out = [];
    (episodes || []).forEach(function (ep) {
      var tag = (ep.groupTag || '').trim();
      if (tag && !seen[tag]) { seen[tag] = true; out.push(tag); }
    });
    return out;
  }

  function filterEpisodesByGroupTag(episodes, tag) {
    if (!tag) return (episodes || []).slice();
    return (episodes || []).filter(function (ep) { return (ep.groupTag || '') === tag; });
  }

  function tripTotalCost(episodes) {
    return (episodes || []).reduce(function (sum, ep) {
      return sum + (typeof ep.cost === 'number' ? ep.cost : 0);
    }, 0);
  }

  function primaryLodgingName(episodes) {
    var lodging = (episodes || []).filter(function (ep) { return ep.category === 'lodging' && ep.placeName; });
    if (!lodging.length) return '';
    var names = [];
    var seen = {};
    lodging.forEach(function (ep) { if (!seen[ep.placeName]) { seen[ep.placeName] = true; names.push(ep.placeName); } });
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
    formatYen: formatYen,
    parseDate: parseDate,
    dateDiffDays: dateDiffDays,
    formatDateJp: formatDateJp,
    dayLabel: dayLabel,
    tripNights: tripNights,
    allDatesForTrip: allDatesForTrip,
    sortEpisodes: sortEpisodes,
    groupEpisodesByDate: groupEpisodesByDate,
    distinctGroupTags: distinctGroupTags,
    filterEpisodesByGroupTag: filterEpisodesByGroupTag,
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
    episodes: [],
    selectedDate: null,
    selectedGroupTag: '',
    editingEpisodeId: null,
    formCategory: 'sightseeing',
    formRating: null,
    formPhotoIds: [],   // 既存（サーバー上）の写真id
    pendingPhotos: []   // 新規に選んだ、まだアップロードしていない {blob, url}
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
        '<div class="trip-card-cover"><div class="trip-card-text"><div class="t">' + escapeHtml(t.title) + '</div>' +
        (dateText ? '<div class="d">' + escapeHtml(dateText) + '</div>' : '') + '</div></div>' +
        '<div class="trip-card-body"><div class="trip-card-companions">' +
        ((t.companions || []).length ? escapeHtml(t.companions.join('・')) + ' と一緒' : '参加者は未設定') + '</div></div>';
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
      state.episodes = data.episodes;
      state.selectedGroupTag = '';
      var dates = Core.allDatesForTrip(state.trip, state.episodes);
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
      state.episodes = data.episodes;
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

    var lodging = Core.primaryLodgingName(state.episodes);
    var total = Core.tripTotalCost(state.episodes);
    $('#tripStats').innerHTML =
      statCard('宿泊先', lodging || '未設定') +
      statCard('総費用', Core.formatYen(total) || '¥0') +
      statCard('日程', nights || (Core.allDatesForTrip(trip, state.episodes).length + '日'));

    renderGroupFilter();
    renderDayTabs();
    renderDaySection();
  }

  function statCard(label, value) {
    return '<div class="stat-card"><div class="lbl">' + escapeHtml(label) + '</div><div class="val">' + escapeHtml(value) + '</div></div>';
  }

  function renderGroupFilter() {
    var tags = Core.distinctGroupTags(state.episodes);
    var el = $('#groupFilter');
    if (!tags.length) { el.innerHTML = ''; return; }
    var all = [''].concat(tags);
    el.innerHTML = all.map(function (tag) {
      var on = tag === state.selectedGroupTag;
      return '<button class="gf-chip' + (on ? ' on' : '') + '" data-tag="' + escapeHtml(tag) + '">' + escapeHtml(tag || '全員') + '</button>';
    }).join('');
    $all('.gf-chip', el).forEach(function (b) {
      b.addEventListener('click', function () {
        state.selectedGroupTag = b.dataset.tag;
        renderGroupFilter();
        renderDaySection();
      });
    });
  }

  function renderDayTabs() {
    var dates = Core.allDatesForTrip(state.trip, state.episodes);
    var el = $('#dayTabs');
    if (!dates.length) { el.innerHTML = ''; return; }
    el.innerHTML = dates.map(function (d, i) {
      var on = d === state.selectedDate;
      return '<button class="day-tab' + (on ? ' on' : '') + '" data-date="' + escapeHtml(d) + '"><span class="n">' + (i + 1) + '</span>' + escapeHtml(Core.dayLabel(state.trip, d)) + '</button>';
    }).join('');
    $all('.day-tab', el).forEach(function (b) {
      b.addEventListener('click', function () {
        state.selectedDate = b.dataset.date;
        renderDayTabs();
        renderDaySection();
      });
    });
  }

  function currentDayEpisodes() {
    var byDate = Core.groupEpisodesByDate(state.episodes);
    var dayEpisodes = byDate[state.selectedDate || ''] || [];
    return Core.filterEpisodesByGroupTag(dayEpisodes, state.selectedGroupTag);
  }

  function renderDaySection() {
    var trip = state.trip;
    $('#dayTitle').textContent = Core.dayLabel(trip, state.selectedDate) + 'のモデルコース';
    var episodes = currentDayEpisodes();
    var placeNames = episodes.map(function (ep) { return ep.placeName; }).filter(Boolean);
    $('#dayRouteText').textContent = placeNames.length ? placeNames.join(' → ') : '';

    renderRouteStrip(episodes);
    renderTimeline(episodes);
  }

  function renderRouteStrip(episodes) {
    var el = $('#routeStrip');
    var withPlace = episodes.filter(function (ep) { return ep.placeName; });
    if (withPlace.length < 2) { el.innerHTML = ''; return; }
    var nodes = withPlace.map(function (ep, i) {
      return '<div class="route-node' + (ep.category === 'lodging' ? ' lodging' : '') + '"><div class="dot">' + (i + 1) + '</div>' +
        '<div class="lbl">' + escapeHtml(ep.placeName) + '</div></div>' +
        (i < withPlace.length - 1 ? '<div class="route-link"></div>' : '');
    }).join('');
    el.innerHTML = '<div class="route-strip-inner">' + nodes + '</div>';
  }

  function renderTimeline(episodes) {
    var el = $('#timeline');
    el.innerHTML = '';
    if (!episodes.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'この日の記録はまだありません。下のボタンから追加できます。';
      el.appendChild(empty);
    }
    episodes.forEach(function (ep, i) {
      var item = document.createElement('div');
      item.className = 'tl-item' + (ep.category === 'lodging' ? ' lodging' : '');
      var photo = ep.photoIds && ep.photoIds[0] ? '<div class="tl-photo" style="background-image:url(\'' + escapeHtml(photoUrl(ep.photoIds[0])) + '\')"></div>' : photoPlaceholder();
      var stars = ep.rating ? starsHtml(ep.rating) : '';
      var price = (ep.cost || ep.cost === 0) ? '<div class="tl-price">' + escapeHtml(Core.formatYen(ep.cost)) + '</div>' : '';
      var links = linksHtml(ep);
      var lodgingLabel = ep.category === 'lodging' ? '<div class="tl-lodging-label">' + bedIcon() + '本日の宿</div>' : '';
      item.innerHTML =
        '<div class="tl-badge"><div class="n">' + (i + 1) + '</div>' + (ep.time ? '<div class="t">' + escapeHtml(ep.time) + '</div>' : '') + '</div>' +
        '<div class="tl-card">' + lodgingLabel +
        '<div class="tl-card-main">' + photo +
        '<div style="flex:1;min-width:0">' +
        '<div class="tl-title">' + escapeHtml(ep.placeName || ep.title || Core.categoryLabel(ep.category)) + '</div>' +
        (ep.note ? '<div class="tl-note">' + escapeHtml(ep.note) + '</div>' : '') +
        '</div></div>' +
        ((stars || price) ? '<div class="tl-meta"><div class="tl-stars">' + stars + '</div>' + price + '</div>' : '') +
        (links ? '<div class="tl-links">' + links + '</div>' : '') +
        '</div>';
      item.addEventListener('click', function () { openEpisodeForm(ep); });
      el.appendChild(item);
    });
    var addBtn = document.createElement('button');
    addBtn.className = 'tl-add';
    addBtn.innerHTML = plusIcon() + '<span>' + escapeHtml(Core.dayLabel(state.trip, state.selectedDate)) + 'にエピソードを追加</span>';
    addBtn.addEventListener('click', function () { openEpisodeForm(null); });
    el.appendChild(addBtn);
  }

  function photoPlaceholder() {
    return '<div class="tl-photo">' + cameraIcon() + '</div>';
  }
  function cameraIcon() {
    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h1.3l.7-1.2c.2-.3.5-.5.9-.5h4.2c.4 0 .7.2.9.5l.7 1.2H15a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="10" cy="10.5" r="3.2"/></svg>';
  }
  function plusIcon() {
    return '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 4v12M4 10h12"/></svg>';
  }
  function bedIcon() {
    return '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 16v-9"/><path d="M2.5 13h15v3"/><path d="M2.5 13v-2.5a1.5 1.5 0 0 1 1.5-1.5h4.5v4"/><path d="M9.5 9h6.5a1.5 1.5 0 0 1 1.5 1.5V13"/><circle cx="5.3" cy="8.3" r="1.3"/></svg>';
  }
  function starSvg(filled) {
    return '<svg width="13" height="13" viewBox="0 0 20 20"><path d="M10 2.5l2.35 4.76 5.25.76-3.8 3.7.9 5.23L10 14.6l-4.7 2.35.9-5.23-3.8-3.7 5.25-.76z" fill="' +
      (filled ? '#e0a940' : 'none') + '" stroke="' + (filled ? 'none' : '#c9bda6') + '" stroke-width="1.3"/></svg>';
  }
  function starsHtml(rating) {
    var out = '';
    for (var i = 1; i <= 5; i++) out += starSvg(i <= rating);
    return out;
  }
  function pinIcon() {
    return '<svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 17.5s6-5.6 6-10a6 6 0 1 0-12 0c0 4.4 6 10 6 10z"/><circle cx="10" cy="7.5" r="2"/></svg>';
  }
  function linkIcon() {
    return '<svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 11.5l3-3"/><path d="M7 13.5L5 15.5a2.5 2.5 0 0 1-3.5-3.5l3-3a2.5 2.5 0 0 1 3.5 0"/><path d="M13 6.5l2-2a2.5 2.5 0 1 1 3.5 3.5l-3 3a2.5 2.5 0 0 1-3.5 0"/></svg>';
  }
  function tagIcon() {
    return '<svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11 3H5a2 2 0 0 0-2 2v6l8.6 8.6a2 2 0 0 0 2.8 0l4.2-4.2a2 2 0 0 0 0-2.8L11 3z"/><circle cx="7.2" cy="7.2" r="1.2"/></svg>';
  }

  function linksHtml(ep) {
    var out = '';
    if (ep.mapUrl) out += '<a class="tl-link" href="' + escapeHtml(ep.mapUrl) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + pinIcon() + '地図で見る</a>';
    if (ep.infoUrl) out += '<a class="tl-link" href="' + escapeHtml(ep.infoUrl) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + linkIcon() + '公式サイト</a>';
    if (ep.bookingSite) out += '<span class="tl-link">' + tagIcon() + escapeHtml(ep.bookingSite) + '</span>';
    return out;
  }

  // ---------- エピソードの追加・編集 ----------
  function openEpisodeForm(ep) {
    state.editingEpisodeId = ep ? ep.id : null;
    state.formCategory = ep ? ep.category : 'sightseeing';
    state.formRating = ep ? ep.rating : null;
    state.formPhotoIds = ep ? (ep.photoIds || []).slice() : [];
    state.pendingPhotos = [];

    $('#epFormTitle').textContent = ep ? 'この記録を編集' : 'この時間の思い出を追加';
    $('#epDate').value = ep ? ep.date : (state.selectedDate || new Date().toISOString().slice(0, 10));
    $('#epTime').value = ep ? ep.time : '';
    $('#epPlace').value = ep ? ep.placeName : '';
    $('#epNote').value = ep ? ep.note : '';
    $('#epCost').value = ep && (ep.cost || ep.cost === 0) ? ep.cost : '';
    $('#epGroupTag').value = ep ? ep.groupTag : '';
    $('#epMapUrl').value = ep ? ep.mapUrl : '';
    $('#epInfoUrl').value = ep ? ep.infoUrl : '';
    $('#epBookingSite').value = ep ? ep.bookingSite : '';
    $('#epAuthor').value = ep ? ep.author : '';
    $('#epFormStatus').textContent = '';
    $('#btnDeleteEpisode').hidden = !ep;

    renderCategoryChips();
    renderRatingPicker();
    renderPhotoPreview();
    showScreen('episodeForm');
  }

  function renderCategoryChips() {
    var el = $('#epCategoryChips');
    el.innerHTML = Core.CATEGORIES.map(function (c) {
      return '<button type="button" class="cat-chip' + (c.key === state.formCategory ? ' on' : '') + '" data-cat="' + c.key + '">' + escapeHtml(c.label) + '</button>';
    }).join('');
    $all('.cat-chip', el).forEach(function (b) {
      b.addEventListener('click', function () { state.formCategory = b.dataset.cat; renderCategoryChips(); });
    });
  }

  function renderRatingPicker() {
    var el = $('#epRatingPicker');
    el.innerHTML = '';
    for (var i = 1; i <= 5; i++) {
      (function (i) {
        var b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = starSvg(state.formRating && i <= state.formRating);
        b.addEventListener('click', function () {
          state.formRating = state.formRating === i ? null : i;
          renderRatingPicker();
        });
        el.appendChild(b);
      })(i);
    }
  }

  function renderPhotoPreview() {
    var el = $('#epPhotoPreview');
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

  function saveEpisode() {
    var status = $('#epFormStatus');
    var place = $('#epPlace').value.trim();
    if (!API_BASE) { status.textContent = 'サーバーが未設定のため保存できません。'; return; }
    if (!place) { status.textContent = '場所を入力してください。'; return; }
    status.textContent = '保存中…';

    var costRaw = $('#epCost').value;
    var payload = {
      date: $('#epDate').value || '',
      time: $('#epTime').value || '',
      placeName: place,
      category: state.formCategory,
      note: $('#epNote').value.trim(),
      cost: costRaw === '' ? null : Math.max(0, parseInt(costRaw, 10) || 0),
      rating: state.formRating,
      groupTag: $('#epGroupTag').value.trim(),
      mapUrl: $('#epMapUrl').value.trim(),
      infoUrl: $('#epInfoUrl').value.trim(),
      bookingSite: $('#epBookingSite').value.trim(),
      author: $('#epAuthor').value.trim()
    };

    Promise.all(state.pendingPhotos.map(function (p) { return uploadPhotoBlob(p.blob); }))
      .then(function (uploaded) {
        payload.photoIds = state.formPhotoIds.concat(uploaded.map(function (u) { return u.id; }));
        var req = state.editingEpisodeId
          ? api('/episodes/' + encodeURIComponent(state.editingEpisodeId), 'PATCH', payload)
          : api('/trips/' + encodeURIComponent(state.trip.id) + '/episodes', 'POST', payload);
        return req;
      })
      .then(function (ep) {
        return refreshTrip().then(function () {
          state.selectedDate = ep.date || '';
          showScreen('tripDetail');
          renderTripDetail();
        });
      })
      .catch(function () { status.textContent = '保存に失敗しました。もう一度お試しください。'; });
  }

  function deleteEpisode() {
    if (!state.editingEpisodeId) return;
    if (!confirm('この記録を削除しますか？')) return;
    api('/episodes/' + encodeURIComponent(state.editingEpisodeId), 'DELETE').then(function () {
      return refreshTrip();
    }).then(function () {
      showScreen('tripDetail');
      renderTripDetail();
    }).catch(function () { $('#epFormStatus').textContent = '削除に失敗しました。'; });
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

    $('#btnSaveEpisode').addEventListener('click', saveEpisode);
    $('#btnDeleteEpisode').addEventListener('click', deleteEpisode);

    $('#epPhotoPicker').addEventListener('click', function () { $('#epPhoto').click(); });
    $('#epPhoto').addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files || []);
      Promise.all(files.map(function (f) { return fileToCompressedBlob(f, 1280, 0.72); })).then(function (blobs) {
        blobs.forEach(function (blob) { state.pendingPhotos.push({ blob: blob, url: URL.createObjectURL(blob) }); });
        renderPhotoPreview();
      });
      e.target.value = '';
    });

    $all('.back').forEach(function (b) {
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
