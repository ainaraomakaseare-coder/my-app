/*
 * ごはんの足跡：画面の動き。記録はlocalStorage、写真はIndexedDB（この端末の中だけ）に保存する。
 * 画面の切り替えはURLの#（#/・#/new・#/r/ID・#/r/ID/edit・#/settings）で行い、端末の「戻る」でも戻れるようにする。
 */
(function () {
  'use strict';
  var C = window.GohanCore;
  var RECORDS_KEY = 'gohan-ashiato.records.v1';
  var PREFS_KEY = 'gohan-ashiato.prefs.v1';
  var PHOTO_DB = 'gohan-ashiato-photos';
  var PHOTO_MAX_PX = 1600;
  var PHOTO_QUALITY = 0.82;
  var MAX_PHOTOS = 10;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function icon(name) { return '<svg class="ic"><use href="#i-' + name + '"/></svg>'; }
  function starsHtml(n) {
    if (!n) return '';
    var s = '<span class="stars" aria-label="評価' + n + '">';
    for (var i = 1; i <= 5; i++) s += '<svg class="ic' + (i <= n ? '' : ' off') + '"><use href="#i-star"/></svg>';
    return s + '</span>';
  }
  function mealLabel(id) {
    for (var i = 0; i < C.MEALS.length; i++) if (C.MEALS[i].id === id) return C.MEALS[i].label;
    return '';
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  // ---------- 保存 ----------
  function loadJson(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v === null ? fallback : v; } catch (e) { return fallback; }
  }
  var records = loadJson(RECORDS_KEY, []);
  if (!Array.isArray(records)) records = [];
  var prefs = Object.assign({ view: 'list', sort: 'new' }, loadJson(PREFS_KEY, {}));

  function saveRecords() {
    try { localStorage.setItem(RECORDS_KEY, JSON.stringify(records)); return true; }
    catch (e) { toast('保存できませんでした（端末の空き容量を確認してください）'); return false; }
  }
  function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* 表示の好みだけなので無視 */ } }
  function findRecord(id) { for (var i = 0; i < records.length; i++) if (records[i].id === id) return records[i]; return null; }

  // 写真（IndexedDB。キー＝写真のID、値＝JPEGのBlob）
  var dbPromise = null;
  function db() {
    if (!dbPromise) dbPromise = new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) { reject(new Error('no-indexeddb')); return; }
      var req = indexedDB.open(PHOTO_DB, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('photos'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }
  function photoTx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction('photos', mode), store = tx.objectStore('photos'), out;
        var r = fn(store);
        if (r) r.onsuccess = function () { out = r.result; };
        tx.oncomplete = function () { resolve(out); };
        tx.onerror = tx.onabort = function () { reject(tx.error); };
      });
    });
  }
  function putPhoto(id, blob) { return photoTx('readwrite', function (s) { return s.put(blob, id); }); }
  function getPhoto(id) { return photoTx('readonly', function (s) { return s.get(id); }); }
  function deletePhotos(ids) {
    ids.forEach(function (id) { if (urlCache[id]) { URL.revokeObjectURL(urlCache[id]); delete urlCache[id]; } });
    if (!ids.length) return Promise.resolve();
    return photoTx('readwrite', function (s) { ids.forEach(function (id) { s.delete(id); }); return null; }).catch(function () {});
  }
  var urlCache = {};
  function photoUrl(id) {
    if (urlCache[id]) return Promise.resolve(urlCache[id]);
    return getPhoto(id).then(function (blob) {
      if (!blob) return '';
      if (!urlCache[id]) urlCache[id] = URL.createObjectURL(blob);
      return urlCache[id];
    }).catch(function () { return ''; });
  }
  // data-photo="ID" を持つimgに、あとから写真を入れる
  function fillPhotos(rootEl) {
    Array.prototype.forEach.call(rootEl.querySelectorAll('img[data-photo]'), function (img) {
      photoUrl(img.getAttribute('data-photo')).then(function (u) { if (u) img.src = u; else img.remove(); });
    });
  }

  // 写真を長い辺1600pxのJPEGに縮める
  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var scale = Math.min(1, PHOTO_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
        var w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('toBlob')); }, 'image/jpeg', PHOTO_QUALITY);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('この画像は読み込めませんでした')); };
      img.src = url;
    });
  }
  function newPhotoId() { return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  // ---------- 一覧 ----------
  var filters = { q: '', minRating: 0, meal: '' };
  var activeTab = 'records';

  function renderSummary() {
    var ym = C.localDate(new Date()).slice(0, 7);
    var s = C.summarize(C.filterRecords(records, { month: ym }));
    $('summary').innerHTML =
      '<div class="stat"><div class="stat-label">' + Number(ym.slice(5)) + '月の記録</div><div class="stat-value">' + s.count + '<small>件</small></div></div>' +
      '<div class="stat"><div class="stat-label">' + Number(ym.slice(5)) + '月の合計</div><div class="stat-value">' + (s.priced ? C.formatYen(s.total) : '—') + '</div></div>' +
      '<div class="stat"><div class="stat-label">平均の評価</div><div class="stat-value">' + (s.avgRating ? s.avgRating.toFixed(1) : '—') + '</div></div>';
  }

  function renderChips() {
    var html = '<button class="chip' + (filters.minRating === 4 ? ' on' : '') + '" data-f="r4">★4以上</button>';
    C.MEALS.forEach(function (m) { html += '<button class="chip' + (filters.meal === m.id ? ' on' : '') + '" data-f="meal" data-v="' + m.id + '">' + m.label + '</button>'; });
    $('filter-chips').innerHTML = html;
  }

  function recordRow(r) {
    var thumb = r.photoIds.length ? '<img class="thumb" data-photo="' + esc(r.photoIds[0]) + '" alt="">' : '<span class="thumb">' + icon('bowl') + '</span>';
    var when = C.formatDateJa(r.date) + (r.time ? ' ' + r.time : '') + (r.meal ? '・' + mealLabel(r.meal) : '');
    return '<a class="rec" href="#/r/' + encodeURIComponent(r.id) + '">' + thumb +
      '<div class="rec-body"><div class="rec-name">' + esc(r.name || '（名前なし）') + '</div>' +
      (r.place ? '<div class="rec-place">' + icon('pin') + esc(r.place) + '</div>' : '') +
      '<div class="rec-meta"><span>' + esc(when) + '</span>' + starsHtml(r.rating) +
      (r.price !== null ? '<span class="rec-price">' + C.formatYen(r.price) + '</span>' : '') + '</div></div></a>';
  }

  function renderRecords() {
    var list = C.sortRecords(C.filterRecords(records, filters), prefs.sort);
    var filtered = filters.q || filters.minRating || filters.meal;
    $('result-count').textContent = filtered ? list.length + '件' : '';
    var el = $('records');
    if (!records.length) {
      el.innerHTML = '<div class="empty">' + icon('bowl') + '<p>まだ記録がありません。<br>右下の「記録する」から、食べたものを残しましょう。</p></div>';
      return;
    }
    if (!list.length) { el.innerHTML = '<div class="empty"><p>見つかりませんでした</p></div>'; return; }
    var html = '';
    var byMonth = prefs.sort === 'new' || prefs.sort === 'old';
    var groups = byMonth ? C.groupByMonth(list) : [{ label: '', items: list, summary: null }];
    groups.forEach(function (g) {
      if (g.label) {
        html += '<div class="month-head"><h2>' + esc(g.label) + '</h2><span>' + g.summary.count + '件' +
          (g.summary.priced ? '・' + C.formatYen(g.summary.total) : '') + '</span></div>';
      }
      if (prefs.view === 'grid') {
        html += '<div class="grid">' + g.items.map(function (r) {
          return '<a href="#/r/' + encodeURIComponent(r.id) + '">' +
            (r.photoIds.length ? '<img data-photo="' + esc(r.photoIds[0]) + '" alt=""><span class="grid-name">' + esc(r.name) + '</span>'
              : '<span class="grid-noimg">' + esc(r.name || '（名前なし）') + '</span>') + '</a>';
        }).join('') + '</div>';
      } else {
        html += g.items.map(recordRow).join('');
      }
    });
    el.innerHTML = html;
    fillPhotos(el);
  }

  function renderPlaces() {
    var stats = C.placeStats(records);
    var el = $('places');
    if (!stats.length) { el.innerHTML = '<div class="empty"><p>お店・場所を入れた記録がここにまとまります</p></div>'; return; }
    el.innerHTML = stats.map(function (s, i) {
      return '<button class="place" data-place="' + esc(s.place) + '"><span class="place-rank">' + (i + 1) + '</span>' +
        '<div class="place-body"><div class="place-name">' + esc(s.place) + '</div><div class="place-meta">' +
        (s.avgRating ? '★' + s.avgRating.toFixed(1) + '・' : '') + (s.total ? '合計' + C.formatYen(s.total) + '・' : '') +
        '最後 ' + esc(C.formatDateJa(s.last)) + '</div></div><span class="place-count">' + s.count + '<small>回</small></span></button>';
    }).join('');
  }

  function renderList() {
    renderSummary();
    renderChips();
    $('sort').value = prefs.sort;
    $('view-toggle').innerHTML = icon(prefs.view === 'grid' ? 'list' : 'grid');
    $('view-toggle').setAttribute('aria-label', prefs.view === 'grid' ? '一覧で並べる' : '写真で並べる');
    Array.prototype.forEach.call(document.querySelectorAll('.seg-btn'), function (b) { b.classList.toggle('active', b.dataset.tab === activeTab); });
    $('tab-records').hidden = activeTab !== 'records';
    $('tab-places').hidden = activeTab !== 'places';
    if (activeTab === 'records') renderRecords(); else renderPlaces();
  }

  $('q').addEventListener('input', function () { filters.q = this.value; renderRecords(); });
  $('sort').addEventListener('change', function () { prefs.sort = this.value; savePrefs(); renderRecords(); });
  $('view-toggle').addEventListener('click', function () { prefs.view = prefs.view === 'grid' ? 'list' : 'grid'; savePrefs(); renderList(); });
  $('filter-chips').addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b) return;
    if (b.dataset.f === 'r4') filters.minRating = filters.minRating ? 0 : 4;
    else filters.meal = filters.meal === b.dataset.v ? '' : b.dataset.v;
    renderChips(); renderRecords();
  });
  document.querySelector('.seg').addEventListener('click', function (e) {
    var b = e.target.closest('.seg-btn'); if (!b) return;
    activeTab = b.dataset.tab; renderList();
  });
  // お店をタップすると、そのお店の記録だけを出す
  $('places').addEventListener('click', function (e) {
    var b = e.target.closest('.place'); if (!b) return;
    filters.q = b.dataset.place; $('q').value = filters.q;
    activeTab = 'records'; renderList(); window.scrollTo(0, 0);
  });

  // ---------- 詳細 ----------
  function renderDetail(r) {
    $('detail-edit').href = '#/r/' + encodeURIComponent(r.id) + '/edit';
    document.querySelector('#screen-detail .topbar-title').textContent = C.formatDateJa(r.date);
    var map = C.mapsUrl(r);
    var html = '';
    if (r.photoIds.length) html += '<div class="detail-photos">' + r.photoIds.map(function (id) { return '<img data-photo="' + esc(id) + '" alt="">'; }).join('') + '</div>';
    html += '<div class="card detail-card"><h2>' + esc(r.name || '（名前なし）') + '</h2>' +
      '<div class="detail-when">' + esc(C.formatDateJa(r.date) + (r.time ? ' ' + r.time : '') + (r.meal ? '・' + mealLabel(r.meal) : '')) + '</div>' +
      (r.rating ? '<div class="detail-stars">' + starsHtml(r.rating) + '</div>' : '') + '</div>';
    html += '<div class="card detail-card">';
    html += '<div class="detail-row"><span class="label">お店・場所</span><span class="value">' + (r.place ? esc(r.place) : '<span style="color:var(--ink-soft)">—</span>') + '</span>' +
      (map ? '<a class="map-link" href="' + esc(map) + '" target="_blank" rel="noopener">' + icon('pin') + '地図</a>' : '') + '</div>';
    html += '<div class="detail-row"><span class="label">値段</span><span class="value">' + (r.price !== null ? C.formatYen(r.price) : '<span style="color:var(--ink-soft)">—</span>') + '</span></div>';
    if (r.memo) html += '<div class="detail-row"><span class="label">メモ</span><span class="value detail-memo">' + esc(r.memo) + '</span></div>';
    html += '</div>';
    // 同じお店のほかの記録
    if (r.place) {
      var key = C.placeKey(r.place);
      var others = C.sortRecords(records.filter(function (x) { return x.id !== r.id && C.placeKey(x.place) === key; }), 'new').slice(0, 5);
      if (others.length) html += '<div class="same-place"><h3>' + esc(r.place) + 'のほかの記録</h3>' + others.map(recordRow).join('') + '</div>';
    }
    $('detail').innerHTML = html;
    fillPhotos($('detail'));
  }
  $('detail').addEventListener('click', function (e) {
    var img = e.target.closest('.detail-photos img'); if (!img || !img.src) return;
    $('viewer').querySelector('img').src = img.src; $('viewer').hidden = false;
  });
  $('viewer').addEventListener('click', function () { $('viewer').hidden = true; });

  // ---------- 登録・編集 ----------
  // draft: 編集中の内容。addedは今回の編集で足した写真（やめたら消す）、removedは外した写真（保存したら消す）
  var draft = null;

  function startEdit(r) {
    var now = new Date();
    var isNew = !r;
    draft = {
      id: r ? r.id : null, createdAt: r ? r.createdAt : null,
      photoIds: r ? r.photoIds.slice() : [], added: [], removed: [],
      lat: r ? r.lat : null, lng: r ? r.lng : null, locFrom: r && r.lat !== null ? 'saved' : '',
      rating: r ? r.rating : 0, meal: r ? r.meal : C.guessMeal(C.localTime(now)),
      touchedWhen: !isNew, busy: 0
    };
    $('edit-title').textContent = isNew ? '記録する' : '記録を編集';
    $('f-name').value = r ? r.name : '';
    $('f-date').value = r ? r.date : C.localDate(now);
    $('f-time').value = r ? r.time : C.localTime(now);
    $('f-place').value = r ? r.place : '';
    $('f-price').value = r && r.price !== null ? String(r.price) : '';
    $('f-memo').value = r ? r.memo : '';
    $('form-error').textContent = '';
    $('photo-hint').hidden = true;
    $('delete-btn').hidden = isNew;
    $('edit-cancel').href = isNew ? '#/' : '#/r/' + encodeURIComponent(r.id);
    fillDatalists();
    renderDraftPhotos(); renderMeal(); renderRating(); renderLoc();
    shopsSeq++; $('f-shops').hidden = true; $('f-shops').innerHTML = '';
  }

  function fillDatalists() {
    function uniq(field) {
      var seen = {}, out = [];
      C.sortRecords(records, 'new').forEach(function (r) { var v = r[field]; if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
      return out.slice(0, 50).map(function (v) { return '<option value="' + esc(v) + '">'; }).join('');
    }
    $('dl-name').innerHTML = uniq('name');
    $('dl-place').innerHTML = uniq('place');
  }

  function renderDraftPhotos() {
    var row = $('photo-row'), add = $('photo-pick');
    Array.prototype.forEach.call(row.querySelectorAll('.photo-item'), function (n) { n.remove(); });
    draft.photoIds.forEach(function (id) {
      var d = document.createElement('div');
      d.className = 'photo-item';
      d.innerHTML = '<img data-photo="' + esc(id) + '" alt=""><button type="button" data-remove="' + esc(id) + '" aria-label="写真を外す">' + icon('x') + '</button>';
      row.insertBefore(d, add);
    });
    var full = draft.photoIds.length >= MAX_PHOTOS;
    add.hidden = full;
    $('photo-camera').hidden = full || !plugin('Camera');
    fillPhotos(row);
  }
  function renderMeal() {
    $('f-meal').innerHTML = C.MEALS.map(function (m) {
      return '<button type="button" class="chip' + (draft.meal === m.id ? ' on' : '') + '" data-meal="' + m.id + '">' + m.label + '</button>';
    }).join('');
  }
  function renderRating() {
    var html = '';
    for (var i = 1; i <= 5; i++) html += '<button type="button" class="' + (i <= draft.rating ? 'on' : '') + '" data-star="' + i + '" aria-label="' + i + '">' + icon('star') + '</button>';
    $('f-rating').innerHTML = html;
  }
  function renderLoc() {
    var el = $('f-loc-state');
    if (draft.lat === null) { el.innerHTML = ''; return; }
    var label = draft.locFrom === 'photo' ? '写真の撮影場所を記録' : draft.locFrom === 'gps' ? '現在地を記録しました' : '位置を記録済み';
    el.innerHTML = icon('pin') + label + '<button type="button" id="f-loc-clear" aria-label="位置を消す">' + icon('x') + '</button>';
  }

  $('photo-row').addEventListener('click', function (e) {
    var b = e.target.closest('[data-remove]'); if (!b) return;
    var id = b.getAttribute('data-remove');
    draft.photoIds = draft.photoIds.filter(function (x) { return x !== id; });
    if (draft.added.indexOf(id) >= 0) { draft.added = draft.added.filter(function (x) { return x !== id; }); deletePhotos([id]); }
    else draft.removed.push(id);
    renderDraftPhotos();
  });
  // 写真を足す。sources：[{ blob(): Promise<Blob>, exif(): Promise<{gps, takenAt}> }]
  // iPhoneでメモリが足りなくならないよう、1枚ずつ縮めて保存する
  function addPhotos(sources, opts) {
    sources = sources.slice(0, MAX_PHOTOS - draft.photoIds.length);
    if (!sources.length) return;
    var d = draft;
    d.busy++; $('save-btn').disabled = true;
    var firstPhoto = !d.photoIds.length, items = [];
    sources.reduce(function (prev, src) {
      return prev.then(function () {
        return Promise.all([src.blob().then(compressImage), src.exif().catch(function () { return { gps: null, takenAt: '' }; })]).then(function (res) {
          var id = newPhotoId();
          return putPhoto(id, res[0]).then(function () { items.push({ id: id, exif: res[1] }); });
        }).catch(function (err) { toast(err && err.message ? err.message : '写真を読み込めませんでした'); });
      });
    }, Promise.resolve()).then(function () {
      d.busy--;
      if (d !== draft) { deletePhotos(items.map(function (x) { return x.id; })); return; }
      if (!d.busy) $('save-btn').disabled = false;
      var hint = [];
      items.forEach(function (it) { d.photoIds.push(it.id); d.added.push(it.id); });
      // 最初の写真の撮影日時・撮影場所で、まだ触っていない日付・時刻・位置を埋める
      var first = items[0];
      if (first && firstPhoto) {
        if (first.exif.takenAt && !d.touchedWhen) {
          $('f-date').value = first.exif.takenAt.slice(0, 10);
          $('f-time').value = first.exif.takenAt.slice(11, 16);
          d.meal = C.guessMeal($('f-time').value); renderMeal();
          hint.push('日時を写真の撮影日時にしました');
        }
        if (first.exif.gps && d.lat === null) {
          setLocation(first.exif.gps, 'photo');
          hint.push('写真の撮影場所を記録しました');
        } else if (opts && opts.camera && d.lat === null) {
          locateNow(); // いま撮った写真は、いまいる場所
        }
      }
      $('photo-hint').textContent = hint.join('・'); $('photo-hint').hidden = !hint.length;
      renderDraftPhotos();
    });
  }
  var NO_EXIF = { gps: null, takenAt: '' };
  $('photo-input').addEventListener('change', function () {
    var files = Array.prototype.slice.call(this.files || []);
    this.value = '';
    addPhotos(files.map(function (file) {
      var jpeg = file.type === 'image/jpeg' || /\.jpe?g$/i.test(file.name);
      return {
        blob: function () { return Promise.resolve(file); },
        exif: function () { return jpeg ? file.arrayBuffer().then(C.jpegExif) : Promise.resolve(NO_EXIF); }
      };
    }));
  });

  // ---------- iPhoneアプリ（Capacitor）のとき ----------
  // iPhoneのWebViewはファイルとして渡す写真から位置情報を消すので、写真はCameraプラグインで選び、
  // プラグインが返すexif（撮影日時・GPS）を使う（旅の足跡と同じ。docs/adr/0025）
  // プラグインは apps/gohan-ashiato-ios の native.js が window.GohanNative に入れる（無ければ Capacitor.Plugins）
  var cap = window.Capacitor;
  var NATIVE = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  function plugin(name) {
    if (!NATIVE) return null;
    var p = (window.GohanNative && window.GohanNative[name]) || (cap.Plugins && cap.Plugins[name]);
    return p || null;
  }
  function nativeSource(p) {
    var exif = p.exif || {};
    return {
      blob: function () { return fetch(p.webPath).then(function (r) { return r.blob(); }); },
      exif: function () { return Promise.resolve({ gps: C.exifGps(exif.GPS), takenAt: C.exifDateTime(exif.DateTimeOriginal || exif.DateTimeDigitized || '') }); }
    };
  }
  function nativePhotoError(err) {
    var msg = String((err && err.message) || err || '');
    if (/cancel/i.test(msg)) return;
    if (/denied|access/i.test(msg)) toast('写真へのアクセスが許可されていません。設定アプリの「ごはんの足跡」から許可してください');
    else toast('写真を読み込めませんでした');
  }
  if (plugin('Camera')) {
    document.documentElement.classList.add('native-app');
    $('photo-pick').addEventListener('click', function (e) {
      e.preventDefault();
      if (!draft) return;
      plugin('Camera').pickImages({ quality: 90, limit: MAX_PHOTOS - draft.photoIds.length }).then(function (res) {
        addPhotos(((res && res.photos) || []).map(nativeSource));
      }).catch(nativePhotoError);
    });
    $('photo-camera').addEventListener('click', function () {
      if (!draft) return;
      plugin('Camera').getPhoto({ source: 'CAMERA', resultType: 'uri', quality: 90, saveToGallery: true, correctOrientation: true }).then(function (p) {
        addPhotos([nativeSource(p)], { camera: true });
      }).catch(nativePhotoError);
    });
  }

  ['f-date', 'f-time'].forEach(function (id) { $(id).addEventListener('input', function () { draft.touchedWhen = true; }); });
  $('f-time').addEventListener('change', function () { var m = C.guessMeal(this.value); if (m) { draft.meal = m; renderMeal(); } });
  $('f-meal').addEventListener('click', function (e) {
    var b = e.target.closest('[data-meal]'); if (!b) return;
    draft.meal = draft.meal === b.dataset.meal ? '' : b.dataset.meal; renderMeal();
  });
  $('f-rating').addEventListener('click', function (e) {
    var b = e.target.closest('[data-star]'); if (!b) return;
    var n = Number(b.dataset.star);
    draft.rating = draft.rating === n ? 0 : n; renderRating();
  });
  function setLocation(pt, from) {
    draft.lat = pt.lat; draft.lng = pt.lng; draft.locFrom = from; renderLoc();
    loadShops();
  }
  function locateNow() {
    if (!navigator.geolocation) { toast('この端末では現在地を使えません'); return; }
    var btn = $('f-locate'), d = draft;
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(function (pos) {
      btn.disabled = false;
      var pt = C.geoPoint(pos.coords.latitude, pos.coords.longitude);
      if (!pt || d !== draft) return;
      setLocation(pt, 'gps');
    }, function () {
      btn.disabled = false;
      toast('現在地を取得できませんでした（位置情報の許可を確認してください）');
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }
  $('f-locate').addEventListener('click', locateNow);
  $('f-loc-state').addEventListener('click', function (e) {
    if (!e.target.closest('#f-loc-clear')) return;
    draft.lat = null; draft.lng = null; draft.locFrom = ''; renderLoc();
    $('f-shops').hidden = true;
  });

  // 位置の近くの飲食店の候補（旅の足跡のWorkerの GET /places/nearby?kind=food。Google Places、
  // 使えなければOpenStreetMap）。タップでお店の名前に入れる。位置と言語以外は送らない
  var NEARBY_API = 'https://tabilog-api.hiroya-apps.workers.dev/places/nearby';
  var shopsSeq = 0;
  function loadShops() {
    var d = draft, seq = ++shopsSeq, box = $('f-shops');
    if (!d || d.lat === null) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<span class="shops-label">近くのお店を探しています…</span>';
    fetch(NEARBY_API + '?kind=food&lang=ja&lat=' + d.lat + '&lng=' + d.lng).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    }).then(function (data) {
      if (seq !== shopsSeq || d !== draft) return;
      var places = (data && data.places) || [];
      if (!places.length) { box.innerHTML = '<span class="shops-label">近くにお店の候補が見つかりませんでした</span>'; return; }
      box.innerHTML = '<span class="shops-label">近くのお店（タップで入れる）</span><div class="chips">' + places.map(function (p) {
        return '<button type="button" class="chip" data-shop="' + esc(p.name) + '">' + esc(p.name) + '</button>';
      }).join('') + '</div>';
      markShop();
    }).catch(function () {
      if (seq !== shopsSeq) return;
      box.innerHTML = '<span class="shops-label">お店の候補を読み込めませんでした</span>';
    });
  }
  function markShop() {
    var v = $('f-place').value.trim();
    Array.prototype.forEach.call($('f-shops').querySelectorAll('[data-shop]'), function (b) { b.classList.toggle('on', b.getAttribute('data-shop') === v); });
  }
  $('f-shops').addEventListener('click', function (e) {
    var b = e.target.closest('[data-shop]'); if (!b) return;
    $('f-place').value = b.getAttribute('data-shop'); markShop();
  });
  $('f-place').addEventListener('input', markShop);

  $('edit-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!draft || draft.busy) return;
    var rawPrice = $('f-price').value;
    var r = C.normalizeRecord({
      id: draft.id, createdAt: draft.createdAt,
      date: $('f-date').value, time: $('f-time').value, meal: draft.meal,
      name: $('f-name').value, place: $('f-place').value, lat: draft.lat, lng: draft.lng,
      price: rawPrice, rating: draft.rating, memo: $('f-memo').value, photoIds: draft.photoIds
    });
    var errors = C.validateRecord(r, rawPrice);
    if (errors.length) { $('form-error').textContent = errors.join('／'); return; }
    var old = draft.id ? findRecord(draft.id) : null;
    var prev = records.slice();
    if (old) records[records.indexOf(old)] = r; else records.push(r);
    if (!saveRecords()) { records = prev; return; }
    deletePhotos(draft.removed);
    draft = null;
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
    toast(old ? '保存しました' : '記録しました');
    location.replace(old ? '#/r/' + encodeURIComponent(r.id) : '#/');
  });

  $('delete-btn').addEventListener('click', function () {
    if (!draft || !draft.id) return;
    if (!confirm('この記録を削除します。写真も消え、元に戻せません。よろしいですか？')) return;
    var r = findRecord(draft.id);
    records = records.filter(function (x) { return x.id !== draft.id; });
    saveRecords();
    deletePhotos((r ? r.photoIds : []).concat(draft.added, draft.removed));
    draft = null;
    toast('削除しました');
    location.replace('#/');
  });

  // 編集をやめたら、今回足した写真を消す
  function abandonDraft() {
    if (draft) { deletePhotos(draft.added); draft = null; }
  }

  // ---------- 書き出し・読み込み ----------
  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }
  function dataUrlToBlob(u) {
    var parts = u.split(','), mime = /data:([^;]+)/.exec(parts[0])[1], bin = atob(parts[1]);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
  function renderStorageInfo() {
    var n = 0; records.forEach(function (r) { n += r.photoIds.length; });
    $('storage-info').textContent = '記録 ' + records.length + '件・写真 ' + n + '枚';
  }
  function renderSettings() { renderStorageInfo(); $('backup-status').textContent = ''; }
  $('export-btn').addEventListener('click', function () {
    var btn = this; btn.disabled = true;
    $('backup-status').textContent = '書き出しています…';
    var ids = [];
    records.forEach(function (r) { ids = ids.concat(r.photoIds); });
    var photos = {};
    Promise.all(ids.map(function (id) {
      return getPhoto(id).then(function (b) { return b ? blobToDataUrl(b).then(function (u) { photos[id] = u; }) : null; }).catch(function () {});
    })).then(function () {
      var data = { app: 'gohan-ashiato', version: 1, exportedAt: new Date().toISOString(), records: records, photos: photos };
      var name = 'gohan-ashiato-' + C.localDate(new Date()) + '.json';
      var text = JSON.stringify(data);
      var done = '書き出しました（記録' + records.length + '件・写真' + Object.keys(photos).length + '枚）';
      // iPhoneアプリではダウンロードができないので、ファイルにしてから共有メニューで保存先を選んでもらう
      if (plugin('Filesystem') && plugin('Share')) {
        return plugin('Filesystem').writeFile({ path: name, data: text, directory: 'CACHE', encoding: 'utf8' }).then(function (res) {
          return plugin('Share').share({ title: name, files: [res.uri], dialogTitle: '書き出したファイルを保存' });
        }).then(function () { $('backup-status').textContent = done; }).catch(function (err) {
          $('backup-status').textContent = /cancel/i.test(String((err && err.message) || err)) ? '' : '書き出せませんでした';
        });
      }
      var blob = new Blob([text], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
      $('backup-status').textContent = done;
    }).finally(function () { btn.disabled = false; });
  });
  $('import-input').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    file.text().then(function (text) {
      var data = C.parseBackup(text);
      return Promise.all(Object.keys(data.photos).map(function (id) { return putPhoto(id, dataUrlToBlob(data.photos[id])); })).then(function () {
        var m = C.mergeRecords(records, data.records);
        records = m.records;
        saveRecords();
        $('backup-status').textContent = '読み込みました（追加' + m.added + '件・更新' + m.updated + '件）';
        renderStorageInfo();
      });
    }).catch(function (err) {
      $('backup-status').textContent = '読み込めませんでした：' + (err && err.message ? err.message : 'ファイルを確認してください');
    });
  });

  // ---------- 画面の切り替え ----------
  var currentScreen = null;
  function show(id) {
    Array.prototype.forEach.call(document.querySelectorAll('.screen'), function (s) { s.hidden = s.id !== id; });
    if (currentScreen !== id) window.scrollTo(0, 0);
    currentScreen = id;
  }
  function route() {
    var h = location.hash.replace(/^#/, '') || '/';
    var m;
    if (currentScreen === 'screen-edit' && draft) abandonDraft();
    if (h === '/new') { startEdit(null); show('screen-edit'); return; }
    if ((m = /^\/r\/([^/]+)\/edit$/.exec(h))) {
      var r = findRecord(decodeURIComponent(m[1]));
      if (r) { startEdit(r); show('screen-edit'); return; }
    } else if ((m = /^\/r\/([^/]+)$/.exec(h))) {
      var r2 = findRecord(decodeURIComponent(m[1]));
      if (r2) { renderDetail(r2); show('screen-detail'); return; }
    } else if (h === '/settings') { renderSettings(); show('screen-settings'); return; }
    renderList(); show('screen-list');
  }
  window.addEventListener('hashchange', route);
  route();
})();
