/*
 * 時差と「地図でふりかえる」のシナリオ試験（2026-10-09）。飛行機の入れ方（移動の予定に到着を入れる／別の記録で
 * 到着を入れる／ピンが到着地／到着時刻なし 等）と路線・出発時刻を組み合わせた旅を作り、再生の各時点で
 *  - 止まっているときの時計の時差が、今いる場所の時差か
 *  - 移動中は出発地の時差で、着いた瞬間に到着地の時差へ切り替わるか
 *  - 吹き出し中の時計・何日目が予定どおりか、時計が逆戻りしないか、飛行機の区間があるか
 * を確かめる。実行: node test/replay-timezone.scenarios.js（192件）
 *              MULTI=1 SEED=1 N=60 node test/replay-timezone.scenarios.js（乗り継ぎのある旅を乱数で作る）
 *              V=1 で見つかった問題の詳細、DUMP=1 ONLY=<番号> で1件の時間割を出す
 */
var APP = require('path').join(__dirname, '..', 'app.js');
global.window = {}; require(APP); var T = global.window.TabiLog;
var C = {
  tokyo: [35.68, 139.76, 'Asia/Tokyo'], nrt: [35.772, 140.393, 'Asia/Tokyo'], hnd: [35.549, 139.78, 'Asia/Tokyo'],
  hkg: [22.308, 113.918, 'Asia/Hong_Kong'], hkcity: [22.296, 114.172, 'Asia/Hong_Kong'],
  lax: [33.942, -118.408, 'America/Los_Angeles'], la: [34.05, -118.25, 'America/Los_Angeles'], las: [36.084, -115.152, 'America/Los_Angeles'], vegas: [36.115, -115.173, 'America/Los_Angeles'],
  hnl: [21.318, -157.92, 'Pacific/Honolulu'], waikiki: [21.279, -157.83, 'Pacific/Honolulu'],
  cdg: [49.009, 2.547, 'Europe/Paris'], paris: [48.857, 2.352, 'Europe/Paris'],
  lhr: [51.47, -0.454, 'Europe/London'], london: [51.507, -0.128, 'Europe/London'],
  sin: [1.364, 103.991, 'Asia/Singapore'], sgcity: [1.29, 103.85, 'Asia/Singapore'],
  jfk: [40.641, -73.778, 'America/New_York'], nyc: [40.758, -73.985, 'America/New_York'],
  syd: [-33.94, 151.175, 'Australia/Sydney'], sydcity: [-33.868, 151.209, 'Australia/Sydney'],
  icn: [37.46, 126.44, 'Asia/Seoul'], seoul: [37.566, 126.978, 'Asia/Seoul'],
  oka: [26.206, 127.646, 'Asia/Tokyo'], naha: [26.212, 127.681, 'Asia/Tokyo'],
  kix: [34.434, 135.244, 'Asia/Tokyo'], osaka: [34.702, 135.495, 'Asia/Tokyo']
};
var uid = 0;
function url(p) { return 'https://www.google.com/maps/search/?api=1&query=' + p[0] + ',' + p[1]; }
function entry(pl, extra) { var p = C[pl]; return Object.assign({ id: 'e' + (++uid), mapUrl: url(p), mapLat: p[0], mapLng: p[1] }, extra || {}); }
function rec(date, time, label, pl, extra) {
  var b = Object.assign({ id: 'b' + (++uid), date: date, time: time || '', label: label, category: 'sightseeing', createdAt: String(uid).padStart(5, '0'), entries: pl ? [entry(pl)] : [{ id: 'e' + (++uid), episode: label }] }, extra || {});
  b._pl = pl; return b;
}
function addDays(d, n) { var x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function hm(min) { min = ((min % 1440) + 1440) % 1440; return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }
function off(tz, date, time) { return T.tzOffsetMinutes(tz, date, time); }

// フライトの到着（現地の日付・時刻）を計算
function arrivalLocal(depPl, depDate, depTime, arrPl, durMin) {
  var dOff = off(C[depPl][2], depDate, depTime);
  var dm = Number(depTime.slice(0, 2)) * 60 + Number(depTime.slice(3));
  var utc = dm - dOff + durMin;
  var aOff = off(C[arrPl][2], depDate, '12:00');
  var local = utc + aOff, dayShift = Math.floor(local / 1440);
  return { date: addDays(depDate, dayShift), time: hm(local - dayShift * 1440) };
}

// 1つの旅：出発都市で予定→フライト（パターン）→到着都市で予定
function makeTrip(o) {
  var start = o.start, blocks = [], d0 = start;
  blocks.push(rec(d0, '09:00', o.home + 'の朝', o.homeCity));
  blocks.push(rec(d0, hm(o.depMin - 120), '空港へ', o.dep));
  if (o.preEvent) blocks.push(rec(d0, hm(o.depMin - 60), 'ラウンジ', null));
  var dep = hm(o.depMin), arr = arrivalLocal(o.dep, d0, dep, o.arr, o.dur);
  var travel = { depart: dep, from: o.dep.toUpperCase(), to: o.arr.toUpperCase() };
  var tb = { category: 'transport', transport: o.assumedTransport ? '' : 'plane' };
  var p = o.pattern;
  var flight;
  if (p === 'A' || p === 'A-notime' || p === 'A+rec') {
    travel.arrive = p === 'A-notime' ? '' : arr.time; travel.arriveMapUrl = url(C[o.arr]); travel.arriveLat = C[o.arr][0]; travel.arriveLng = C[o.arr][1];
    flight = rec(d0, dep, o.dep + '→' + o.arr, o.dep, tb); flight.entries[0].travel = travel; flight._arr = o.arr;
  } else if (p === 'A-nodep' || p === 'A-notz') {
    travel.arrive = arr.time; travel.arriveMapUrl = url(C[o.arr]); travel.arriveLat = C[o.arr][0]; travel.arriveLng = C[o.arr][1];
    flight = rec(d0, dep, o.dep + '→' + o.arr, p === 'A-nodep' ? null : o.dep, tb); flight.entries[0].travel = travel; if (p !== 'A-notz') flight._arr = o.arr;
  } else if (p === 'A-time-only') {
    travel.arrive = arr.time;
    flight = rec(d0, dep, o.dep + '→' + o.arr, o.dep, tb); flight.entries[0].travel = travel;
  } else if (p === 'B' || p === 'B-notime' || p === 'A-time-only+rec') {
    flight = rec(d0, dep, o.dep + '→' + o.arr, o.dep, tb);
  } else if (p === 'B-nomap') {
    flight = rec(d0, dep, o.dep + '→' + o.arr, null, tb);
  } else if (p === 'C') { // 移動の予定のピンが到着地
    flight = rec(d0, dep, o.dep + '→' + o.arr, o.arr, tb);
  } else if (p === 'D') { // 到着の記録なし、次は街
    flight = rec(d0, dep, o.dep + '→' + o.arr, o.dep, tb);
  }
  blocks.push(flight);
  if (o.inflight) blocks.push(rec(d0, '', '機内食', null));
  var arrRecTime = (p === 'B-notime') ? '' : arr.time;
  if (p === 'A+rec' || p === 'B' || p === 'B-notime' || p === 'B-nomap' || p === 'C' || p === 'A-time-only+rec') {
    blocks.push(rec(arr.date, arrRecTime, o.arr + '到着', o.arr));
  }
  var am = Number(arr.time.slice(0, 2)) * 60 + Number(arr.time.slice(3));
  var hotelDate = am + 120 >= 1440 ? addDays(arr.date, 1) : arr.date;
  blocks.push(rec(hotelDate, hm(am + 120), 'ホテル', o.city));
  blocks.push(rec(addDays(hotelDate, 1), '10:00', '観光', o.city));
  var end = addDays(hotelDate, 1);
  var ds = blocks.map(function (b) { return b.date; }).sort();
  return { trip: { startDate: ds[0], endDate: ds[ds.length - 1] }, blocks: blocks, arr: arr, expect: o };
}

function run(tc) {
  var blocks = tc.blocks, byBlock = {}, byArrive = {};
  blocks.forEach(function (b) { if (b._pl) byBlock[b.id] = C[b._pl][2]; if (b._arr) byArrive[b.id] = C[b._arr][2]; });
  T.applyBlockZones(blocks, T.assignBlockZones(blocks, byBlock, 'Asia/Tokyo', byArrive));
  var stops = T.replayStops(tc.trip, blocks);
  var coords = {}; stops.forEach(function (s) { if (s.knownLat != null) coords[s.query] = { lat: s.knownLat, lng: s.knownLng }; });
  var tl = T.buildReplayTimeline(stops, coords);
  return { tl: tl, blocks: blocks };
}

function tzAt(lat, lng) {
  var best = null, bd = 1e9;
  Object.keys(C).forEach(function (k) { var c = C[k]; var d = T.distanceKm({ lat: lat, lng: ((lng + 540) % 360) - 180 }, { lat: c[0], lng: c[1] }); if (d < bd) { bd = d; best = c[2]; } });
  return best;
}

function check(tc, res) {
  var tl = res.tl, issues = [];
  var byId = {}; res.blocks.forEach(function (b) { byId[b.id] = b; });
  var prevLocal = null, prevOff = null;
  var dates = T.allDatesForTrip(tc.trip, res.blocks).filter(Boolean);
  for (var r = 0; r <= tl.totalReal + 1e-9; r += 0.02) {
    var st = T.replayStateAt(tl, r);
    var shownOff = (tl.baseOffset || 0) + st.offsetDiff;
    // 1. 止まっているとき、表示の時差は今いる場所の時差
    if (!st.icon && st.here) {
      var cur = tl.stops[Math.max(0, st.stopIndex)];
      var tz = tzAt(st.here.lat, st.here.lng);
      var want = off(tz, cur.date || dates[0], '12:00');
      if (want !== shownOff) issues.push('止まっている場所(' + tz + ')と時計の時差が違う r=' + r.toFixed(2) + ' 表示' + shownOff + ' 正' + want + ' 地点「' + cur.label + '」');
    }
    // 2. 移動中は出発地の時差
    if (st.icon) {
      var leg = tl.legs[st.icon.legIndex], fs = tl.stops[leg.from];
      var wantM = off(tzAt(fs.lat, fs.lng), fs.date, '12:00');
      if (wantM !== shownOff) issues.push('移動中の時計が出発地の時差でない r=' + r.toFixed(2) + ' 表示' + shownOff + ' 正' + wantM + ' 区間「' + fs.label + '→' + tl.stops[leg.to].label + '」');
    }
    // 3. 現地の時計（日付込み）が、時差の切り替わり以外で戻らない
    var dayIdx = dates.indexOf(dates[0]) ; // dummy
    var localAbs = st.t + st.offsetDiff;
    if (prevLocal !== null) {
      var back = localAbs < prevLocal - 0.5;
      if (back && prevOff === shownOff) issues.push('時計が戻った r=' + r.toFixed(2) + ' ' + prevLocal.toFixed(1) + '→' + localAbs.toFixed(1));
    }
    prevLocal = localAbs; prevOff = shownOff;
    // 4. 吹き出しを出している予定（時刻あり）では、時計と何日目が予定のとおり
    if (st.captionIndex >= 0) {
      var cs = tl.stops[st.captionIndex], b = byId[cs.blockId];
      if (b && b.time && !cs.estimated) {
        if (st.hhmm !== b.time.padStart(5, '0')) issues.push('吹き出し中の時計が予定の時刻と違う「' + cs.label + '」 表示' + st.hhmm + ' 予定' + b.time);
        var wantDay = dates.indexOf(b.date) + 1;
        if (st.dayNumber !== wantDay) issues.push('吹き出し中の何日目が違う「' + cs.label + '」 表示' + st.dayNumber + ' 予定' + wantDay);
      }
    }
  }
  // 5. 飛行機の区間があること・1本だけ（出発空港→到着側）
  var planes = tl.legs.filter(function (l) { return l.transport === 'plane'; });
  if (!planes.length && !(tc.expect.assumedTransport && T.distanceKm({ lat: C[tc.expect.dep][0], lng: C[tc.expect.dep][1] }, { lat: C[tc.expect.arr][0], lng: C[tc.expect.arr][1] }) < 400)) issues.push('飛行機の区間が無い');
  planes.forEach(function (l) {
    var a = tl.stops[l.from], z = tl.stops[l.to];
    if (tzAt(a.lat, a.lng) === tzAt(z.lat, z.lng) && C[tc.expect.dep][2] !== C[tc.expect.arr][2]) issues.push('飛行機の区間の両端が同じ時差の場所「' + a.label + '→' + z.label + '」');
  });
  if (tl.legs.some(function (l) { return l.transport === 'plane' && T.distanceKm(tl.stops[l.from], tl.stops[l.to]) < 100; })) issues.push('100km未満の飛行機');
  // 6. 並び：地点の世界共通の時刻（tRaw）が逆戻りしない
  var lastRaw = -Infinity;
  tl.stops.forEach(function (s) { if (s.estimated && !s.located) return; if (s.tRaw < lastRaw - 1) issues.push('並びが時刻順でない「' + s.label + '」'); lastRaw = Math.max(lastRaw, s.tRaw); });
  // 重複を詰める
  var seen = {}, out = [];
  issues.forEach(function (m) { var k = m.replace(/r=[\d.]+ /, '').replace(/[\d.]+→[\d.]+/, ''); if (!seen[k]) { seen[k] = 1; out.push(m); } });
  return out;
}

var routes = [
  ['nrt', 'hkg', 'tokyo', 'hkcity', 300, 'Tokyo'], ['hkg', 'nrt', 'hkcity', 'tokyo', 260, 'HK'],
  ['nrt', 'lax', 'tokyo', 'la', 600, 'Tokyo'], ['lax', 'nrt', 'la', 'tokyo', 690, 'LA'],
  ['hnd', 'hnl', 'tokyo', 'waikiki', 420, 'Tokyo'], ['hnl', 'hnd', 'waikiki', 'tokyo', 520, 'HNL'],
  ['hnd', 'cdg', 'tokyo', 'paris', 870, 'Tokyo'], ['cdg', 'hnd', 'paris', 'tokyo', 820, 'Paris'],
  ['lhr', 'jfk', 'london', 'nyc', 480, 'London'], ['jfk', 'lax', 'nyc', 'la', 380, 'NYC'], ['lax', 'las', 'la', 'vegas', 70, 'LA'],
  ['sin', 'syd', 'sgcity', 'sydcity', 480, 'SG'], ['nrt', 'icn', 'tokyo', 'seoul', 150, 'Tokyo'], ['hnd', 'oka', 'tokyo', 'naha', 170, 'Tokyo'],
  ['hkg', 'jfk', 'hkcity', 'nyc', 960, 'HK'], ['kix', 'sin', 'osaka', 'sgcity', 420, 'Osaka']
];
var patterns = ['A-nodep', 'A-notz', 'A', 'A-notime', 'A+rec', 'A-time-only', 'A-time-only+rec', 'B', 'B-notime', 'B-nomap', 'C', 'D'];
var depTimes = [13 * 60 + 30, 17 * 60, 22 * 60 + 30];
var cases = [], n = 0;
routes.forEach(function (rt, ri) {
  patterns.forEach(function (p, pi) {
    var dm = depTimes[(ri + pi) % depTimes.length];
    cases.push({ pattern: p, dep: rt[0], arr: rt[1], homeCity: rt[2], city: rt[3], dur: rt[4], home: rt[5], depMin: dm, start: '2026-06-10',
      preEvent: (ri + pi) % 3 === 0, inflight: (ri + pi) % 4 === 1, assumedTransport: (ri * 7 + pi) % 9 === 0 });
  });
});
var only = process.env.ONLY;
var DUMP = process.env.DUMP;
var summary = {}, total = 0, bad = 0, details = [];
cases.forEach(function (o, i) {
  if (only && String(i) !== only) return;
  uid = 0;
  var tc = makeTrip(o), res;
  var issues;
  try { res = run(tc); if (DUMP) { res.blocks.forEach(function (b) { console.log("blk", b.date, b.time, b._offset, b._arriveOffset, b.label); }); res.tl.stops.forEach(function (s, k) { console.log(k, s.dayNumber, s.minute, s.offset, "t=" + s.t, "r=" + s.r.toFixed(2), s.located ? "L" : "-", s.transport, s.label, s.arrival ? "ARR" : ""); }); res.tl.legs.forEach(function (l) { console.log("leg", l.from, l.to, l.transport, l.r0.toFixed(2), l.r1.toFixed(2)); }); } issues = check(tc, res); } catch (e) { issues = ['例外: ' + e.stack.split('\n').slice(0, 2).join(' ')]; }
  total++;
  if (issues.length) {
    bad++;
    details.push('#' + i + ' ' + o.pattern + ' ' + o.dep + '→' + o.arr + ' ' + hm(o.depMin) + (o.inflight ? ' 機内' : '') + (o.preEvent ? ' 前' : '') + (o.assumedTransport ? ' 手段なし' : '') + '\n   ' + issues.slice(0, 4).join('\n   '));
    issues.forEach(function (m) { var k = o.pattern + ': ' + m.split(/ r=| 表示| 「|「/)[0]; summary[k] = (summary[k] || 0) + 1; });
  }
});
console.log('cases', total, 'bad', bad);
if (bad) process.exitCode = 1;
Object.keys(summary).sort().forEach(function (k) { console.log(summary[k], k); });
if (process.env.V) console.log(details.join('\n'));

// ---- 複数の便を乗り継ぐ旅（乱数、再現できるよう種を固定） ----
if (process.env.MULTI) {
  var seed = Number(process.env.SEED || 1);
  function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
  function pick(a) { return a[Math.floor(rnd() * a.length)]; }
  var hubs = { tokyo: ['nrt', 'hnd'], hkcity: ['hkg'], la: ['lax'], vegas: ['las'], waikiki: ['hnl'], paris: ['cdg'], london: ['lhr'], sgcity: ['sin'], nyc: ['jfk'], sydcity: ['syd'], seoul: ['icn'], naha: ['oka'], osaka: ['kix'] };
  var plans = [['tokyo', 'hkcity', 'tokyo'], ['tokyo', 'la', 'vegas', 'tokyo'], ['tokyo', 'paris', 'london', 'tokyo'], ['osaka', 'sgcity', 'sydcity', 'tokyo'],
    ['tokyo', 'waikiki', 'tokyo'], ['tokyo', 'seoul', 'tokyo'], ['tokyo', 'naha', 'tokyo'], ['tokyo', 'nyc', 'la', 'tokyo'], ['tokyo', 'hkcity', 'sgcity', 'tokyo'], ['london', 'nyc', 'london']];
  var pats = ['A', 'A-notime', 'A+rec', 'A-time-only+rec', 'A-nodep', 'A-notz', 'B', 'B-notime', 'B-nomap', 'C'];
  var durOf = function (a, b) { return Math.round(T.distanceKm({ lat: C[a][0], lng: C[a][1] }, { lat: C[b][0], lng: C[b][1] }) / 800 * 60 + 40); };
  var mt = 0, mbad = 0, msum = {}, mdet = [];
  var N = Number(process.env.N || 100);
  var skipped = 0;
  for (var ti = 0; ti < N; ti++) {
    uid = 0;
    var plan = pick(plans), date = '2026-' + pick(['03', '06', '07', '10', '11']) + '-1' + Math.floor(rnd() * 9), blocks = [], flights = [];
    var day = date;
    plan.forEach(function (city, ci) {
      var stay = ci === 0 ? 1 : 1 + Math.floor(rnd() * 3);
      if (ci > 0) {
        // 到着後の予定
      }
      for (var sd = 0; sd < stay; sd++) {
        if (ci > 0 && sd === 0) { day = blocks.length ? blocks._nextDay : day; }
        var times = sd === 0 && ci > 0 ? [] : [9 * 60, 12 * 60 + 30];
        times.forEach(function (m) { blocks.push(rec(day, rnd() < 0.15 ? '' : hm(m + Math.floor(rnd() * 4) * 15), city + '観光', city)); });
        if (rnd() < 0.3) blocks.push(rec(day, rnd() < 0.5 ? '' : hm(15 * 60), '買い物メモ', null));
        if (sd < stay - 1) day = addDays(day, 1);
      }
      if (ci === plan.length - 1) return;
      // 次の都市へフライト
      var next = plan[ci + 1], dep = pick(hubs[city]), arrA = pick(hubs[next]);
      var depMin = pick([8 * 60 + 15, 11 * 60, 14 * 60 + 40, 18 * 60 + 5, 21 * 60 + 50, 23 * 60 + 30]);
      var p = pick(pats);
      var depDay = addDays(day, 1);
      if (rnd() < 0.7) blocks.push(rec(depDay, hm(Math.max(0, depMin - 120)), '空港へ', dep));
      var depT = hm(depMin), arr = arrivalLocal(dep, depDay, depT, arrA, durOf(dep, arrA));
      if (arr.date < depDay) blocks._backDate = true;
      var travel = { depart: depT, to: arrA.toUpperCase() };
      var tb = { category: 'transport', transport: 'plane' };
      var fl;
      if (p.indexOf('A') === 0) {
        if (p !== 'A-time-only+rec') { travel.arriveMapUrl = url(C[arrA]); travel.arriveLat = C[arrA][0]; travel.arriveLng = C[arrA][1]; }
        travel.arrive = p === 'A-notime' ? '' : arr.time;
        fl = rec(depDay, depT, dep + '→' + arrA, p === 'A-nodep' ? null : dep, tb); fl.entries[0].travel = travel;
        if (p !== 'A-notz' && p !== 'A-time-only+rec') fl._arr = arrA;
      } else if (p === 'B-nomap') fl = rec(depDay, depT, dep + '→' + arrA, null, tb);
      else if (p === 'C') fl = rec(depDay, depT, dep + '→' + arrA, arrA, tb);
      else fl = rec(depDay, depT, dep + '→' + arrA, dep, tb);
      blocks.push(fl);
      if (rnd() < 0.3) blocks.push(rec(depDay, '', '機内で映画', null));
      if (p === 'A+rec' || p === 'A-time-only+rec' || p.indexOf('B') === 0 || p === 'C') blocks.push(rec(arr.date, p === 'B-notime' ? '' : arr.time, arrA + '到着', arrA));
      flights.push({ dep: dep, arr: arrA, p: p });
      var am = Number(arr.time.slice(0, 2)) * 60 + Number(arr.time.slice(3));
      var hd = am + 90 >= 1440 ? addDays(arr.date, 1) : arr.date;
      blocks.push(rec(hd, hm(am + 90), next + 'ホテル', next));
      day = addDays(hd, 1);
      blocks._nextDay = day;
    });
    if (blocks._backDate) { skipped = (typeof skipped === 'number' ? skipped : 0) + 1; continue; }
    var ds = blocks.map(function (b) { return b.date; }).sort();
    var tc = { trip: { startDate: ds[0], endDate: ds[ds.length - 1] }, blocks: blocks, expect: { dep: flights[0].dep, arr: flights[0].arr } };
    var issues;
    try {
      var res = run(tc);
      if (process.env.DUMP && String(ti) === process.env.ONLYM) { res.blocks.forEach(function (b) { console.log('blk', b.date, b.time, b._offset, b._arriveOffset, b.label); }); res.tl.stops.forEach(function (s, k) { console.log(k, s.dayNumber, s.minute, s.offset, 't=' + s.t, 'r=' + s.r.toFixed(2), s.located ? 'L' : '-', s.transport, s.label, s.arrival ? 'ARR' : ''); }); res.tl.legs.forEach(function (l) { console.log('leg', l.from, l.to, l.transport, l.r0.toFixed(2), l.r1.toFixed(2)); }); }
      issues = check(tc, res).filter(function (m) { return m.indexOf('飛行機の区間') === -1; });
      var planes = res.tl.legs.filter(function (l) { return l.transport === 'plane'; }).length;
      if (planes !== flights.length) issues.push('飛行機の区間の数が便の数と違う ' + planes + '/' + flights.length);
      var story = T.buildVideoStory(res.tl, { title: 'x' });
      if (!story) issues.push('動画が作れない');
      else {
        var lastDay = 0;
        for (var vt = 0; vt <= story.total; vt += 0.1) { var fr = T.videoFrameAt(story, vt); if (fr.day < lastDay) { issues.push('動画の何日目が戻る'); break; } lastDay = fr.day; }
      }
    } catch (e) { issues = ['例外: ' + e.stack.split('\n').slice(0, 2).join(' ')]; }
    mt++;
    if (issues.length) {
      mbad++;
      mdet.push('#' + ti + ' ' + plan.join('→') + ' ' + flights.map(function (f) { return f.p; }).join(',') + '\n   ' + issues.slice(0, 4).join('\n   '));
      issues.forEach(function (m) { var k = m.split(/ r=| 表示| 「|「| \d/)[0]; msum[k] = (msum[k] || 0) + 1; });
    }
  }
  if (mbad) process.exitCode = 1;
  console.log('multi cases', mt, 'bad', mbad, 'skipped(到着日が出発日より前)', typeof skipped === 'number' ? skipped : 0);
  Object.keys(msum).sort().forEach(function (k) { console.log(msum[k], k); });
  if (process.env.V) console.log(mdet.join('\n'));
}
