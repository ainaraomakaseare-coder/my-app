/*
 * ごはんの足跡：画面に依存しない計算（並べ替え・絞り込み・集計・入力チェック・写真のExif読み取り）。
 * ブラウザでは window.GohanCore、Node（test/core.test.js）では require で使う。
 */
(function (root, factory) {
  var core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.GohanCore = core;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MEALS = [
    { id: 'breakfast', label: '朝' },
    { id: 'lunch', label: '昼' },
    { id: 'dinner', label: '夜' },
    { id: 'snack', label: 'おやつ' },
    { id: 'drink', label: '飲み' }
  ];
  var MEAL_IDS = MEALS.map(function (m) { return m.id; });
  var MAX_PRICE = 10000000;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function parseDate(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    var p = s.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    if (d.getUTCFullYear() !== p[0] || d.getUTCMonth() !== p[1] - 1 || d.getUTCDate() !== p[2]) return null;
    return d;
  }
  function isTime(s) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(s || ''); }

  // 端末の現在時刻から 'YYYY-MM-DD' と 'HH:MM'
  function localDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function localTime(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }

  // 時刻からだいたいの食事の区分を決める（あとで変えられる初期値）
  function guessMeal(time) {
    if (!isTime(time)) return '';
    var h = Number(time.slice(0, 2));
    if (h >= 5 && h < 10) return 'breakfast';
    if (h >= 10 && h < 15) return 'lunch';
    if (h >= 15 && h < 17) return 'snack';
    return 'dinner';
  }

  // 「1,200円」「¥980」「１５００」などを数にする。空・読めないときは null
  function parsePrice(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) && v >= 0 ? Math.round(v) : null;
    var s = String(v).replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/[,，円¥￥\s]/g, '');
    if (!s) return null;
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    var n = Math.round(Number(s));
    return n <= MAX_PRICE ? n : null;
  }
  function formatYen(n) {
    if (n === null || n === undefined || !isFinite(n)) return '';
    return '¥' + Math.round(n).toLocaleString('ja-JP');
  }

  function cleanText(v, max) { return String(v === null || v === undefined ? '' : v).trim().slice(0, max); }

  function geoPoint(lat, lng) {
    if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
    return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
  }

  // 入力（画面・読み込んだファイル）を、保存できる形にそろえる。
  // 必須は日付だけ（料理名・写真のどちらかは validateRecord で確かめる）
  function normalizeRecord(input, now) {
    input = input || {};
    var nowIso = (now || new Date()).toISOString();
    var pt = geoPoint(input.lat, input.lng);
    var rating = Number(input.rating);
    return {
      id: cleanText(input.id, 64) || ('r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
      date: parseDate(input.date) ? input.date : '',
      time: isTime(input.time) ? input.time : '',
      meal: MEAL_IDS.indexOf(input.meal) >= 0 ? input.meal : '',
      name: cleanText(input.name, 80),
      place: cleanText(input.place, 80),
      lat: pt ? pt.lat : null,
      lng: pt ? pt.lng : null,
      price: parsePrice(input.price),
      rating: rating >= 1 && rating <= 5 ? Math.round(rating) : 0,
      memo: cleanText(input.memo, 1000),
      photoIds: Array.isArray(input.photoIds) ? input.photoIds.filter(function (p) { return typeof p === 'string' && p; }).slice(0, 10) : [],
      createdAt: typeof input.createdAt === 'string' && input.createdAt ? input.createdAt : nowIso,
      updatedAt: nowIso
    };
  }

  // 保存できない理由の一覧（空なら保存できる）
  function validateRecord(r, rawPrice) {
    var errors = [];
    if (!r.date) errors.push('日付を入れてください');
    if (!r.name && !r.photoIds.length) errors.push('料理の名前か写真のどちらかを入れてください');
    if (rawPrice !== undefined && String(rawPrice).trim() !== '' && r.price === null) errors.push('値段は数字で入れてください');
    return errors;
  }

  function sortKeyDate(r) { return (r.date || '') + 'T' + (r.time || '99:99') + '|' + (r.createdAt || ''); }

  // 並べ替え：new（新しい順）・old（古い順）・rating（評価が高い順）・priceHigh・priceLow
  // 同じ値どうしは新しい順。値段なし・評価なしは常に後ろ
  function sortRecords(list, mode) {
    var arr = list.slice();
    function byNew(a, b) { var x = sortKeyDate(a), y = sortKeyDate(b); return x < y ? 1 : x > y ? -1 : 0; }
    var cmp = byNew;
    if (mode === 'old') cmp = function (a, b) { return -byNew(a, b); };
    else if (mode === 'rating') cmp = function (a, b) { return (b.rating || 0) - (a.rating || 0) || byNew(a, b); };
    else if (mode === 'priceHigh' || mode === 'priceLow') {
      var dir = mode === 'priceHigh' ? 1 : -1;
      cmp = function (a, b) {
        var pa = a.price, pb = b.price;
        if (pa === null && pb === null) return byNew(a, b);
        if (pa === null) return 1;
        if (pb === null) return -1;
        return (pb - pa) * dir || byNew(a, b);
      };
    }
    return arr.sort(cmp);
  }

  // 絞り込み：q（料理名・お店・メモに含む文字。スペース区切りはすべて含むもの）、minRating、meal、month（'YYYY-MM'）
  function filterRecords(list, f) {
    f = f || {};
    var words = String(f.q || '').toLowerCase().split(/[\s　]+/).filter(Boolean);
    return list.filter(function (r) {
      if (f.minRating && (r.rating || 0) < f.minRating) return false;
      if (f.meal && r.meal !== f.meal) return false;
      if (f.month && (r.date || '').slice(0, 7) !== f.month) return false;
      if (words.length) {
        var hay = (r.name + ' ' + r.place + ' ' + r.memo).toLowerCase();
        for (var i = 0; i < words.length; i++) if (hay.indexOf(words[i]) < 0) return false;
      }
      return true;
    });
  }

  // 件数・合計金額（値段のある記録だけ）・平均評価（評価のある記録だけ。無ければ0）
  function summarize(list) {
    var total = 0, priced = 0, rsum = 0, rated = 0;
    list.forEach(function (r) {
      if (r.price !== null && r.price !== undefined) { total += r.price; priced++; }
      if (r.rating) { rsum += r.rating; rated++; }
    });
    return { count: list.length, total: total, priced: priced, avgRating: rated ? Math.round(rsum / rated * 10) / 10 : 0 };
  }

  function monthLabel(ym) { return Number(ym.slice(0, 4)) + '年' + Number(ym.slice(5, 7)) + '月'; }

  // 並んだ順のまま、月ごとのまとまりにする（見出しに件数・合計を出すため）
  function groupByMonth(list) {
    var groups = [], cur = null;
    list.forEach(function (r) {
      var ym = (r.date || '').slice(0, 7) || '----';
      if (!cur || cur.month !== ym) { cur = { month: ym, label: ym === '----' ? '日付なし' : monthLabel(ym), items: [] }; groups.push(cur); }
      cur.items.push(r);
    });
    groups.forEach(function (g) { g.summary = summarize(g.items); });
    return groups;
  }

  // お店・場所が同じかどうかを比べる形。表記ゆれは空白と大文字小文字だけそろえる
  function placeKey(place) { return String(place || '').trim().toLowerCase().replace(/[\s　]+/g, ' '); }

  // お店・場所ごとの集計（よく行く順）
  function placeStats(list) {
    var map = {}, out = [];
    list.forEach(function (r) {
      if (!r.place) return;
      var key = placeKey(r.place);
      var name = r.place.trim();
      var s = map[key];
      if (!s) { s = map[key] = { place: name, count: 0, items: [], last: '' }; out.push(s); }
      s.count++;
      s.items.push(r);
      if ((r.date || '') > s.last) s.last = r.date;
    });
    out.forEach(function (s) {
      var sum = summarize(s.items);
      s.total = sum.total; s.avgRating = sum.avgRating;
      delete s.items;
    });
    return out.sort(function (a, b) { return b.count - a.count || (b.last > a.last ? 1 : b.last < a.last ? -1 : 0); });
  }

  // Googleマップで開くURL。位置があれば位置、無ければお店の名前で検索
  function mapsUrl(r) {
    if (r.lat !== null && r.lng !== null && r.lat !== undefined) return 'https://www.google.com/maps/search/?api=1&query=' + r.lat + ',' + r.lng;
    if (r.place) return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(r.place);
    return '';
  }

  function formatDateJa(date) {
    var d = parseDate(date);
    if (!d) return '';
    return (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日(' + '日月火水木金土'.charAt(d.getUTCDay()) + ')';
  }

  // 書き出したファイルの中身を確かめて、記録の一覧と写真（id→dataURL）を返す。読めなければ例外
  function parseBackup(json) {
    var data = typeof json === 'string' ? JSON.parse(json) : json;
    if (!data || data.app !== 'gohan-ashiato' || !Array.isArray(data.records)) throw new Error('ごはんの足跡の書き出しファイルではありません');
    var records = data.records.map(function (r) { var n = normalizeRecord(r); n.updatedAt = r.updatedAt || n.updatedAt; return n; })
      .filter(function (r) { return r.date; });
    var photos = {};
    if (data.photos && typeof data.photos === 'object') {
      Object.keys(data.photos).forEach(function (id) {
        if (/^data:image\/(jpeg|png|webp);base64,/.test(data.photos[id])) photos[id] = data.photos[id];
      });
    }
    return { records: records, photos: photos };
  }

  // 読み込んだ記録を今の記録にまぜる。同じidは更新日時が新しいほうを残す
  function mergeRecords(current, incoming) {
    var byId = {}, out = current.slice(), added = 0, updated = 0;
    out.forEach(function (r, i) { byId[r.id] = i; });
    incoming.forEach(function (r) {
      if (byId[r.id] === undefined) { byId[r.id] = out.length; out.push(r); added++; }
      else if ((r.updatedAt || '') > (out[byId[r.id]].updatedAt || '')) { out[byId[r.id]] = r; updated++; }
    });
    return { records: out, added: added, updated: updated };
  }

  // ---------- 写真のExif（撮影日時・撮影場所）。旅の足跡 app.js から流用 ----------
  function gpsDms(v) {
    if (typeof v === 'number') return v;
    if (!v || v.length !== 3) return NaN;
    return Number(v[0]) + Number(v[1]) / 60 + Number(v[2]) / 3600;
  }
  // Exifの日時（"2026:10:20 14:23:11"）を 'YYYY-MM-DDTHH:MM' にする。読めなければ''
  function exifDateTime(s) {
    var m = /^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || '').trim());
    if (!m || Number(m[4]) > 23 || Number(m[5]) > 59) return '';
    var date = m[1] + '-' + m[2] + '-' + m[3];
    if (!parseDate(date) || m[1] < '1990') return '';
    return date + 'T' + m[4] + ':' + m[5];
  }
  function tiffReader(v, start) {
    var le = v.getUint16(start) === 0x4949;
    var t = {
      u16: function (o) { return v.getUint16(start + o, le); },
      u32: function (o) { return v.getUint32(start + o, le); },
      findTag: function (ifd, tag) {
        var n = t.u16(ifd);
        for (var i = 0; i < n; i++) if (t.u16(ifd + 2 + i * 12) === tag) return ifd + 2 + i * 12;
        return -1;
      }
    };
    return t;
  }
  function tiffGps(v, start) {
    var t = tiffReader(v, start);
    var ptr = t.findTag(t.u32(4), 0x8825);
    if (ptr < 0) return null;
    var gpsIfd = t.u32(ptr + 8);
    function ref(tag) { var e = t.findTag(gpsIfd, tag); return e < 0 ? '' : String.fromCharCode(v.getUint8(start + e + 8)); }
    function dms(tag) {
      var e = t.findTag(gpsIfd, tag);
      if (e < 0 || t.u16(e + 2) !== 5 || t.u32(e + 4) !== 3) return NaN;
      var o = t.u32(e + 8), parts = [];
      for (var i = 0; i < 3; i++) { var den = t.u32(o + i * 8 + 4); parts.push(den ? t.u32(o + i * 8) / den : 0); }
      return gpsDms(parts);
    }
    return exifGps({ Latitude: dms(2), LatitudeRef: ref(1), Longitude: dms(4), LongitudeRef: ref(3) });
  }
  function tiffTakenAt(v, start) {
    var t = tiffReader(v, start);
    function ascii(e) {
      var len = t.u32(e + 4), o = len > 4 ? t.u32(e + 8) : e + 8, s = '';
      for (var i = 0; i < len && i < 32; i++) { var c = v.getUint8(start + o + i); if (!c) break; s += String.fromCharCode(c); }
      return s;
    }
    var ifd0 = t.u32(4), exifPtr = t.findTag(ifd0, 0x8769);
    if (exifPtr >= 0) {
      var orig = t.findTag(t.u32(exifPtr + 8), 0x9003); // DateTimeOriginal
      if (orig >= 0) { var s = exifDateTime(ascii(orig)); if (s) return s; }
    }
    var dt = t.findTag(ifd0, 0x0132);
    return dt >= 0 ? exifDateTime(ascii(dt)) : '';
  }
  // iPhoneアプリで写真を選んだとき（@capacitor/cameraのpickImages）に返るexif.GPSから緯度・経度。
  // iOSは度の値（35.68など）と向き（N/S・E/W）を別々に返す
  function exifGps(gps) {
    if (!gps) return null;
    var lat = gpsDms(gps.Latitude), lng = gpsDms(gps.Longitude);
    if (/^s/i.test(gps.LatitudeRef || '')) lat = -lat;
    if (/^w/i.test(gps.LongitudeRef || '')) lng = -lng;
    return geoPoint(lat, lng);
  }
  // JPEGの中身（ArrayBuffer）から { gps（{lat,lng}かnull）, takenAt（'YYYY-MM-DDTHH:MM'か''） }
  // ※iPhoneのブラウザは写真を渡すときに位置情報を消すことが多い（日時は残る）
  function jpegExif(buf) {
    var out = { gps: null, takenAt: '' };
    try {
      var v = new DataView(buf);
      if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return out;
      var pos = 2;
      while (pos + 4 <= v.byteLength) {
        if (v.getUint8(pos) !== 0xFF) return out;
        var marker = v.getUint8(pos + 1), size = v.getUint16(pos + 2);
        if (marker === 0xDA || marker === 0xD9) return out;
        if (marker === 0xE1 && v.getUint32(pos + 4) === 0x45786966) {
          try { out.gps = tiffGps(v, pos + 10); } catch (e) { /* 場所だけ読めない */ }
          try { out.takenAt = tiffTakenAt(v, pos + 10); } catch (e) { /* 時刻だけ読めない */ }
          return out;
        }
        pos += 2 + size;
      }
    } catch (e) { /* 壊れたファイルは、場所も時刻もなし */ }
    return out;
  }

  return {
    MEALS: MEALS, parseDate: parseDate, isTime: isTime, localDate: localDate, localTime: localTime,
    guessMeal: guessMeal, parsePrice: parsePrice, formatYen: formatYen, geoPoint: geoPoint,
    normalizeRecord: normalizeRecord, validateRecord: validateRecord, sortRecords: sortRecords,
    filterRecords: filterRecords, summarize: summarize, groupByMonth: groupByMonth, monthLabel: monthLabel,
    placeKey: placeKey, placeStats: placeStats, mapsUrl: mapsUrl, formatDateJa: formatDateJa, parseBackup: parseBackup,
    mergeRecords: mergeRecords, exifDateTime: exifDateTime, exifGps: exifGps, jpegExif: jpegExif
  };
});
