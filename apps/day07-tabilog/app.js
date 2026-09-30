/*
 * 旅の足跡
 * 旅行（trip）と、その中の「大項目（block）」「小項目（entry）」はサーバー
 * （Cloudflare Worker + D1 + R2）に保存する。
 * データを扱う純粋な関数は window.TabiLog に集めてあり、node からもテストできる。
 */
(function (root) {
  'use strict';

  // 機能フラグ（2026-09-26〜）：ユーザーの希望で「紹介文を作る」「いいね・コメント」の入り口を
  // 一時的に隠す。サーバー側のAPI・データはそのまま残しており、trueに戻すだけで元通り出せる。
  // コード自体は削らず、呼び出し側でこのフラグを見て出し分ける。
  var FEATURES = { post: false, social: false };

  // 公開しているWebサイトのURL（2026-09-29〜：GitHub PagesからCloudflare Pagesへ移行）。
  // 共有リンク・Stripeの戻り先・アプリ内から開けないリンクの組み立てなど、
  // 「今どこで動いているか」に関係なく公開URLが要る場所はすべてここを参照する。
  var PUBLIC_WEB_BASE = 'https://tabinoashiato.pages.dev/';

  var CATEGORIES = [
    { key: 'sightseeing', label: '観光', color: 'oklch(60% 0.13 150)' },
    { key: 'food', label: '食事', color: 'oklch(64% 0.15 45)' },
    { key: 'lodging', label: '宿泊', color: 'oklch(48% 0.1 195)' },
    { key: 'transport', label: '移動', color: 'oklch(60% 0.12 260)' },
    // 「到着」（2026-09-27〜）。種類の選択では「移動」の隣のチップで選ぶ。
    // 移動（＝出発）と違い、着いた場所の予定として扱う：地図はその時刻にいた場所。
    // inMoveはMyLogのタブ（renderMyLogTabs）が「移動」にまとめて出すためのフラグで、種類の選択のチップでは使わない。
    { key: 'arrival', label: '到着', color: 'oklch(58% 0.12 225)', inMove: true },
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
    { key: 'shinkansen', label: '新幹線' },
    { key: 'bus', label: 'バス' },
    { key: 'walk', label: '徒歩' },
    { key: 'bicycle', label: '自転車' }
  ];

  var WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

  // 費用の明細（costItems）に選べる通貨（DAY31〜、docs/adr/0014）。一覧に無い通貨は
  // 「その他」から3文字コード（ISO 4217）を自由入力できるので、ここは「よく使う」ものだけに絞る。
  // currencyが無い（省略）costItemはこれまでどおり円（JPY）として扱う＝後方互換。
  var COST_CURRENCIES = ['JPY', 'USD', 'EUR', 'GBP', 'KRW', 'TWD', 'CNY', 'HKD', 'THB', 'SGD',
    'AUD', 'BRL', 'ARS', 'MXN', 'CAD', 'CHF', 'VND', 'PHP', 'IDR', 'MYR'];
  // 表示用の通貨記号。無い通貨（「その他」で入力した3文字コード）はコードそのままを頭に出す。
  var COST_CURRENCY_SYMBOLS = {
    USD: 'US$', EUR: '€', GBP: '£', KRW: '₩', TWD: 'NT$', CNY: 'CN¥', HKD: 'HK$', THB: '฿',
    SGD: 'S$', AUD: 'A$', BRL: 'R$', ARS: 'AR$', MXN: 'MX$', CAD: 'C$', CHF: 'CHF', VND: '₫',
    PHP: '₱', IDR: 'Rp', MYR: 'RM'
  };
  function costCurrencySymbol(code) { return COST_CURRENCY_SYMBOLS[code] || (code + ' '); }

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

  function addDaysToDate(dateStr, days) {
    var d = parseDate(dateStr);
    if (!d) return '';
    d.setUTCDate(d.getUTCDate() + days);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }

  // 旅行の日程を編集したとき、予定（blocks）をいっしょに何日ずらすかを決める（2026-09-26）。
  // - 開始日を変えた（'start'）：予定も同じ日数だけずらす。1日目が空の旅行でも、日と日の間隔を保つ
  // - 開始日は変えていないが、予定が日程の外にはみ出していて、しかも最初の予定が1日目と違う（'blocks'）：
  //   以前に開始日だけを変えて予定が取り残された旅行（ロサンゼルス旅など）。最初の予定を1日目にそろえる
  // ずらす必要が無ければnull。実際にずらすかどうかは、画面側で本人に確かめてから決める。
  var LEFT_BEHIND_EMPTY_DAYS = 3;
  function tripScheduleShift(oldTrip, newStart, newEnd, blocks) {
    if (!parseDate(newStart)) return null;
    var dates = (blocks || []).map(function (b) { return b.date; }).filter(function (d) { return !!parseDate(d); }).sort();
    if (!dates.length) return null;
    var first = dates[0], last = dates[dates.length - 1];
    var oldStart = oldTrip && parseDate(oldTrip.startDate) ? oldTrip.startDate : '';
    var days, reason;
    if (oldStart && oldStart !== newStart) {
      days = dateDiffDays(oldStart, newStart);
      reason = 'start';
    } else {
      var hasEnd = !!parseDate(newEnd);
      var outside = first < newStart || (hasEnd && last > newEnd);
      // 開始日だけを前に動かした旅行（ワールドカップ旅：7/3→6/26）は、予定が日程の中に収まったまま最初の
      // 7日が空になり、上の判定では拾えなかった（2026-09-27）。最初の3日以上が空なら取り残されたとみなす
      // （到着日だけ予定が無い、のような1〜2日の空きでは聞かない）。
      var leadingEmpty = dateDiffDays(newStart, first) >= LEFT_BEHIND_EMPTY_DAYS;
      if ((!outside && !leadingEmpty) || first === newStart) return null;
      days = dateDiffDays(first, newStart);
      reason = 'blocks';
    }
    if (!days) return null;
    return { days: days, reason: reason, count: dates.length, firstFrom: first, firstTo: addDaysToDate(first, days) };
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

  // 飛行機の移動。移動手段が空欄でも、見出しが「〜フライト」「飛行機」なら飛行機とみなす（記録フォームで
  // 「移動の情報」欄を出すかどうかの判定にだけ使う。時差の決め方には使わない。2026-09-27）
  function isPlaneMove(b) {
    if (!b) return false;
    if (b.transport === 'plane') return true;
    return !b.transport && /フライト|飛行機|航空便|flight/i.test(b.label || '');
  }

  var ARRIVAL_PIN_SAME_PLACE_KM = 3; // 次の予定の地図とこれ未満なら「同じ場所」

  // 移動の予定の唯一のピンが、出発地ではなく到着地を指していると判断できるか（地図だけで決める）。
  // 次の予定のピンとほぼ同じ場所なら、到着の予定に同じ場所を入れている＝この予定のピンも到着地。
  // そうでなければ今までどおり出発地として読む（着いた先を別の移動の予定として入れた場合など）。
  // 時刻の前後（出発が直前の予定より前になる等）では判断しない：日付変更線をまたぐ日は、時差が決まる前の
  // 並びが当てにならないため。
  function isArrivalOnlyPin(b, next) {
    var e = (b.entries || [])[0], ne = next && (next.entries || [])[0];
    return !!(e && ne && typeof e.mapLat === 'number' && typeof e.mapLng === 'number' &&
      typeof ne.mapLat === 'number' && typeof ne.mapLng === 'number' &&
      distanceKm({ lat: e.mapLat, lng: e.mapLng }, { lat: ne.mapLat, lng: ne.mapLng }) < ARRIVAL_PIN_SAME_PLACE_KM);
  }

  // ---------- ログインし直しが必要かどうか（セッショントークン導入前のログイン、docs/adr/0005） ----------
  // REQUIRE_SESSION導入後、トークン無しでログインした端末（tabilog:userにtokenが無い）や、トークンが
  // 無効になった端末では、マイログなどのアカウント系APIが401 login_requiredを返す。
  function needsFreshLogin(user) { return !!user && !user.token; }
  function isLoginRequiredError(e) { return !!e && e.message === 'login_required'; }

  // 予定ごとのタイムゾーンは、その予定「自身」の地図（記録の地図。移動の予定は出発地）だけで決める。
  // 見出しの文言（「〜到着」「〜へ」）・その日の場所（天気の場所）・予定を入れた順は一切見ない
  // （オーナー方針、2026-09-29：「マップが正。マップ入れてなかったら前の予定と一緒で大丈夫。
  // 勝手に推測するのはやめてほしい（ラスベガスのニューヨークニューヨークというホテルをニューヨークと
  // 判断されたらややこしい）」）。地図の無い予定は直前の予定（表示順で。手で並べた日はmanualOrderの順）を
  // 引き継ぐ。旅の最初の方に地図の無い予定が続くときは、旅の中で最初に地図が出てくる予定のタイムゾーン
  // （それも無ければ端末のタイムゾーン）を使う。
  // 移動の予定（transport）の地図は出発地として読む（時刻は出発の時刻のため）。移動の情報に到着地の地図
  // （travel.arriveMapUrl）が入っていれば、そのタイムゾーンを次の予定から使う。
  // 手で直したタイムゾーン（block.tzOverride）があれば地図より優先する：
  //   'inherit' … 直前の予定と同じにする（区切りを消す）。IANA名 … その場所の時間として読む。
  // 前後から遠く離れたピン（findFarMapOutlierBlockIds、ピンが違うかもしれない）は、地図が無いのと
  // 同じに扱う（地図そのもの・吹き出しはそのまま残す）。
  function walkZones(order, byBlock, outlierIds, fallback, byArrive) {
    byBlock = byBlock || {};
    byArrive = byArrive || {};
    var ownZone = function (b) {
      if (outlierIds && outlierIds[b.id]) return '';
      return byBlock[b.id] || '';
    };
    var firstPinned = '';
    for (var i = 0; i < order.length; i++) {
      var z0 = ownZone(order[i]);
      if (z0) { firstPinned = z0; break; }
    }
    var zones = {}, carry = firstPinned || fallback || '';
    order.forEach(function (b, idx) {
      var own = ownZone(b);
      var auto = own || carry;
      // 移動の予定の時刻は出発の時刻。到着地の地図が別に無く、唯一のピンが今いる場所と違うタイムゾーンで、
      // しかも次の予定が同じ場所のピンを持つ（isArrivalOnlyPin）ときは、そのピンは到着地と
      // みなす：この予定は今いる場所（直前のタイムゾーン）の時間で読み、新しいタイムゾーンは次の予定から
      // 使う（docs/adr/0009、2026-09-30）
      var arrivalOnlyPin = '';
      if (b.category === 'transport' && own && carry && own !== carry && !byArrive[b.id] &&
          !b.tzOverride && isArrivalOnlyPin(b, order[idx + 1])) {
        arrivalOnlyPin = own;
        auto = carry;
      }
      var zone;
      if (b.tzOverride === 'inherit') zone = carry;
      else if (b.tzOverride) zone = b.tzOverride;
      else zone = auto;
      zones[b.id] = zone;
      // 次の予定へ引き継ぐ「いまいる場所」：移動の予定に到着地の地図があれば、そちらを優先する
      // （到着地が分かっているのに出発地のままだと、あとの地図の無い予定が出発地に巻き戻ってしまう）。
      // それ以外は、いま決めたタイムゾーン（手で直したものも含む。取り消せば直前へ戻る＝そのまま連鎖する）。
      carry = (b.category === 'transport' && byArrive[b.id]) ? byArrive[b.id] : zone;
      if (arrivalOnlyPin) carry = arrivalOnlyPin;
    });
    return zones;
  }

  // 予定ごとのタイムゾーンを決める（walkZonesを、時差を考えた並び順が落ち着くまで数回繰り返す）。
  // 地図の無い予定は「直前の予定」を引き継ぐので、直前が何かは表示順（sortBlocks、時差が分かれば
  // 世界共通の時刻の順）で決まる必要があり、時差が並び順に効くぶん、並べ直してもう一度決める。
  function assignBlockZones(blocks, byBlock, fallback, byArrive) {
    byArrive = byArrive || {};
    var copies = (blocks || []).map(function (b) { var c = Object.assign({}, b); delete c._offset; delete c._tz; return c; });
    // 前後の予定から遠く離れた地図（ピン違い、isFarMapOutlier）は、時差の手がかりにしない＝地図が
    // 無いのと同じに扱う。地図が無い予定と同じく前の予定の時差を引き継ぎ、「ここから現地時間」の
    // 区切りを出さない。地図そのもの（吹き出し・警告表示）はそのまま残す（docs/adr/0009、2026-09-29）
    var outlierIds = findFarMapOutlierBlockIds(copies);
    var order = sortBlocks(copies);
    var zones = {};
    for (var round = 0; round < 3; round++) {
      zones = walkZones(order, byBlock, outlierIds, fallback, byArrive);
      applyBlockZones(order, zones);
      var next = sortBlocks(order);
      var same = next.every(function (b, i) { return b === order[i]; });
      order = next;
      if (same) break;
    }
    // 到着地の地図がある移動の予定は、到着地のタイムゾーンも「<id>#arrive」で返す（地図でふりかえるの到着地点用）
    Object.keys(byArrive).forEach(function (id) { if (byArrive[id]) zones[id + '#arrive'] = byArrive[id]; });
    return zones;
  }


  // 予定に _tz・_offset（分）を付ける（画面の中だけの値で、保存はしない）。zonesが無ければ外す。
  function applyBlockZones(blocks, zones) {
    (blocks || []).forEach(function (b) {
      var tz = zones && zones[b.id];
      var off = tz ? tzOffsetMinutes(tz, b.date, b.time) : null;
      if (typeof off === 'number') { b._tz = tz; b._offset = off; }
      else { delete b._tz; delete b._offset; }
      var atz = zones && zones[b.id + '#arrive'];
      var arr = atz ? travelArrival(b) : null;
      var aoff = atz ? tzOffsetMinutes(atz, b.date, (arr && arr.time) || b.time) : null;
      if (typeof aoff === 'number') { b._arriveTz = atz; b._arriveOffset = aoff; }
      else { delete b._arriveTz; delete b._arriveOffset; }
    });
    return blocks;
  }

  // 時差の差（分）を「+1時間」「-8時間」「+5時間30分」にする（+に合わせて-も半角）
  function offsetDiffText(diffMin) {
    var sign = diffMin < 0 ? '-' : '+', a = Math.abs(diffMin), h = Math.floor(a / 60), m = a % 60;
    return sign + (h ? h + '時間' : '') + (m ? m + '分' : '') + (!h && !m ? '0時間' : '');
  }

  function sortBlocks(blocks) {
    var natural = (blocks || []).slice().sort(function (a, b) {
      if (a.date !== b.date) return (a.date || '').localeCompare(b.date || '');
      return blockSortKey(a).localeCompare(blockSortKey(b));
    });
    if (!natural.some(function (b) { return typeof b.manualOrder === 'number'; })) return natural;
    // 手で決めた並び（2026-09-27〜）：その日の予定に1つでもmanualOrderがあれば、その日はその並びにする。
    // あとから足した予定（manualOrderなし）は、ふだんの並びで前にある予定のすぐ後ろに入れる
    var out = [], i = 0;
    while (i < natural.length) {
      var j = i;
      while (j < natural.length && natural[j].date === natural[i].date) j++;
      out = out.concat(applyManualOrder(natural.slice(i, j)));
      i = j;
    }
    return out;
  }
  function applyManualOrder(day) {
    if (!day.some(function (b) { return typeof b.manualOrder === 'number'; })) return day;
    var ordered = day.filter(function (b) { return typeof b.manualOrder === 'number'; })
      .sort(function (a, b) { return a.manualOrder - b.manualOrder; });
    day.forEach(function (b, k) {
      if (typeof b.manualOrder === 'number') return;
      var prev = null;
      for (var m = k - 1; m >= 0; m--) { if (ordered.indexOf(day[m]) !== -1) { prev = day[m]; break; } }
      ordered.splice(prev ? ordered.indexOf(prev) + 1 : 0, 0, b);
    });
    return ordered;
  }
  // その日の予定に「手で決めた並び」があるか
  function dayHasManualOrder(blocks, date) {
    return (blocks || []).some(function (b) { return b.date === date && typeof b.manualOrder === 'number'; });
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

  // ---------- 自分だけの道（別行動の分岐。docs/adr/0021） ----------
  // 「この人が、この日のこの時間帯だけ、みんなと別行動した」という分岐（branch）と、その中の予定
  // （branchIdが入ったBlock）を扱う純粋な関数。画面（renderTimeline・地図でふりかえる・動画）はここが返す
  // 「見せる予定の並び」だけを使う。サーバー側の同じ規則は worker/src/branches.js。

  // 自分だけの道を作ってよい人か。いまは無料機能なのでログインしていれば誰でも true。
  // 課金（有料プラン）を始めたら、ここだけを「有料プランの人だけ true」に変える（画面側はこの関数だけを見る）。
  function canUseBranches(account) {
    void account; // 有料プランの判定に使う予定（accountのplanなど）
    return true;
  }

  // 分岐の時間帯に入る「みんなの予定」（開始ちょうどは含み、終了ちょうどは含まない）。
  // 時刻なしの予定は、いつ起きたか分からないので入れない（別行動の間も、みんなの予定として残る）。
  function blocksInBranchWindow(sharedBlocks, branch) {
    var s = hhmmToMinute(branch.startTime), e = hhmmToMinute(branch.endTime);
    if (s === null || e === null) return [];
    return (sharedBlocks || []).filter(function (b) {
      var m = b.date === branch.date ? hhmmToMinute(b.time) : null;
      return m !== null && m >= s && m < e;
    });
  }

  // 選んだ人の道（viewAccountId）で見るときの、旅行全体の予定の並び。みんな（''）ならみんなの予定そのまま。
  // その人の分岐の時間帯にあるみんなの予定は外し、代わりにその人の分岐の予定を入れる。
  // 「地図でふりかえる」「動画でシェア」もこの並びを使う。元の配列は変えない。
  function visibleBlocksForView(sharedBlocks, branchBlocks, branches, viewAccountId) {
    var shared = sharedBlocks || [];
    if (!viewAccountId) return shared.slice();
    var mine = (branches || []).filter(function (br) { return br.accountId === viewAccountId; });
    if (!mine.length) return shared.slice();
    var hidden = {};
    mine.forEach(function (br) { blocksInBranchWindow(shared, br).forEach(function (b) { hidden[b.id] = true; }); });
    var mineIds = {};
    mine.forEach(function (br) { mineIds[br.id] = true; });
    return shared.filter(function (b) { return !hidden[b.id]; })
      .concat((branchBlocks || []).filter(function (b) { return mineIds[b.branchId]; }));
  }

  // 保存しておいた「見ている人」が、いまの旅行でも分岐を持っているか確かめ、無ければみんな（''）に戻す。
  function resolveViewAccountId(viewAccountId, branches) {
    if (!viewAccountId) return '';
    return (branches || []).some(function (br) { return br.accountId === viewAccountId; }) ? viewAccountId : '';
  }

  // 「みんな／○○」の切り替えに出す人の一覧（分岐を持つ人だけ）。名前は旅行の参加者名を優先し、無ければ分岐に付いている名前。
  function branchViewOptions(branches, members) {
    var out = [], byId = {};
    (branches || []).forEach(function (br) {
      if (byId[br.accountId]) { byId[br.accountId].count++; return; }
      var member = (members || []).filter(function (m) { return m.accountId === br.accountId; })[0];
      byId[br.accountId] = { accountId: br.accountId, name: (member && member.name) || br.name || 'だれか', count: 1 };
      out.push(byId[br.accountId]);
    });
    return out;
  }

  // 分岐の中の予定の見出しを→でつないだ短い説明（3つまで）。分岐にタイトルがあればそちらを優先する。
  function branchSummary(branch, branchBlocks) {
    if (branch.title) return branch.title;
    var labels = sortBlocks((branchBlocks || []).filter(function (b) { return b.branchId === branch.id; }))
      .map(function (b) { return b.label || categoryLabel(b.category); });
    if (!labels.length) return '';
    return labels.slice(0, 3).join('→') + (labels.length > 3 ? '…' : '');
  }

  // みんなの画面（と、ほかの人の道）に出す小さなカードの文。例：アリス：14:00〜17:00 別行動（美術館→カフェ）
  function branchCardText(branch, branchBlocks) {
    var summary = branchSummary(branch, branchBlocks);
    return (branch.name || 'だれか') + '：' + branch.startTime + '〜' + branch.endTime + ' 別行動' + (summary ? '（' + summary + '）' : '');
  }

  // その日のタイムラインに並べるもの。type: 'block'（予定）｜'card'（ほかの人の別行動のカード）｜'band'（自分の分岐の見出し。own=true）。
  // 帯・カードは、開始時刻以降で最初の「時刻ありの予定」の手前に入れる（無ければ時刻なしの手前＝末尾）。
  // 自分の分岐の「時刻なし」の予定は、帯のすぐ後ろに続ける（並びの末尾に飛ばさない）。
  function dayTimelineItems(sharedBlocks, branchBlocks, branches, viewAccountId, date) {
    var dayBranches = (branches || []).filter(function (br) { return br.date === date; });
    var blocks = visibleBlocksForView(sharedBlocks, branchBlocks, branches, viewAccountId)
      .filter(function (b) { return (b.date || '') === date; });
    var ownBranchIds = {};
    if (viewAccountId) dayBranches.forEach(function (br) { if (br.accountId === viewAccountId) ownBranchIds[br.id] = true; });
    var floating = {}; // 自分の分岐の、時刻なしの予定（帯の後ろに置く）
    var sorted = sortBlocks(blocks).filter(function (b) {
      if (ownBranchIds[b.branchId] && hhmmToMinute(b.time) === null) {
        (floating[b.branchId] = floating[b.branchId] || []).push(b);
        return false;
      }
      return true;
    });
    var items = sorted.map(function (b) { return { type: 'block', block: b }; });
    var marks = dayBranches.map(function (br) {
      return { type: ownBranchIds[br.id] ? 'band' : 'card', branch: br, own: !!ownBranchIds[br.id], start: hhmmToMinute(br.startTime) };
    }).sort(function (a, b) { return (a.start - b.start) || (a.branch.id < b.branch.id ? -1 : 1); });
    var out = items.slice();
    // 開始が早い順に、後ろから挿入すると位置がずれないので、逆順に入れる
    for (var k = marks.length - 1; k >= 0; k--) {
      var mk = marks[k], at = -1;
      for (var i = 0; i < out.length; i++) {
        if (out[i].type !== 'block') continue;
        var m = hhmmToMinute(out[i].block.time);
        if (m !== null && m >= mk.start) { at = i; break; }
      }
      if (at === -1) {
        for (var j = 0; j < out.length; j++) { if (out[j].type === 'block' && hhmmToMinute(out[j].block.time) === null) { at = j; break; } }
      }
      if (at === -1) at = out.length;
      var inserted = [mk];
      if (mk.type === 'band') {
        (floating[mk.branch.id] || []).forEach(function (b) { inserted.push({ type: 'block', block: b }); });
      }
      out.splice.apply(out, [at, 0].concat(inserted));
    }
    return out;
  }

  // 分岐の入力を確かめる（サーバーと同じ規則）。問題なければ空文字、あれば理由。
  // others：ほかの分岐（同じ人の分だけ見る）。excludeId：更新のときの自分自身。
  function validateBranch(input, others, accountId, excludeId) {
    var s = hhmmToMinute(input.startTime), e = hhmmToMinute(input.endTime);
    if (!input.date) return 'invalid_date';
    if (s === null || e === null) return 'invalid_time';
    if (e <= s) return 'end_before_start';
    var clash = (others || []).some(function (o) {
      if (o.id === excludeId || o.accountId !== accountId || o.date !== input.date) return false;
      var os = hhmmToMinute(o.startTime), oe = hhmmToMinute(o.endTime);
      return s < oe && os < e;
    });
    return clash ? 'overlap' : '';
  }

  function branchErrorText(reason) {
    var texts = {
      invalid_date: '日付が正しくありません。',
      invalid_time: '始まりと終わりの時刻を入れてください。',
      end_before_start: '終わりの時刻は、始まりより後にしてください。',
      overlap: 'ほかの自分の別行動と時間が重なっています。',
      invalid_title: 'タイトルは100文字までです。',
      not_member: 'この旅行に「参加する」と、別行動を追加できます。',
      login_required: 'ログインすると、自分の別行動を追加できます。',
      forbidden: '別行動は、その人だけが変更できます。',
      branches_not_ready: 'サーバーの準備がまだ終わっていません。少し待ってからお試しください。'
    };
    return texts[reason] || '保存に失敗しました。もう一度お試しください。';
  }

  // costItem 1件分の金額を円に換算する（DAY31〜、docs/adr/0014）。currencyが無い・'JPY'なら
  // amountがそのまま円（これまでどおり）。それ以外は、rate（1単位あたりの円。/ratesで自動取得しつつ
  // 本人が直せる値）を掛けて円に丸める。合計・貸し借り（tripBalances）はこの丸めた円をそのまま
  // 積み上げる（為替の端数まで追いかけても実用上の意味が薄く、精算の丸め＝settlementPlanと
  // 同じ「多少はまとめて丸める」考え方に揃えた）。
  function costItemJpy(item) {
    if (!item) return 0;
    var amount = typeof item.amount === 'number' ? item.amount : 0;
    if (!item.currency || item.currency === 'JPY') return amount;
    var rate = typeof item.rate === 'number' ? item.rate : 0;
    return Math.round(amount * rate);
  }

  // 外貨のcostItemにレート（1単位あたりの円）が入っているか。/ratesの自動取得前・取得失敗・
  // 古いデータ（レート無しで保存された外貨行）でfalseになる＝costItemJpyが0円扱いする場合と同じ判定。
  function costItemHasRate(item) {
    return !!item && !!item.currency && item.currency !== 'JPY' && typeof item.rate === 'number' && item.rate > 0;
  }

  // 費用明細1件の表示用文字列。円ならこれまでどおり`formatYen`と同じ「¥1,200」、外貨なら
  // 元の金額と円換算の両方を見せる（例：「US$25.00（¥3,737）」）。精算はすべて円で行うため、
  // 元の金額だけだと精算画面の内訳（円）と一致しているか本人には分からなくなるため。
  // レートが無い外貨（未取得・未入力）は円換算が0円になり「US$25.00（¥0）」のように実際より
  // 安く見えてしまうため、代わりに「レート未設定」と出す（合計・精算の円換算もcostItemJpy通り0円のまま＝
  // 過大にごまかさず、本人が記録を開いてレートを入れるまで正しい額として合算しない）。
  function formatCostItemAmount(item) {
    if (!item || typeof item.amount !== 'number') return '';
    if (!item.currency || item.currency === 'JPY') return formatYen(item.amount);
    var amountText = costCurrencySymbol(item.currency) + item.amount.toFixed(2);
    if (!costItemHasRate(item)) return amountText + '（レート未設定）';
    return amountText + '（' + formatYen(costItemJpy(item)) + '）';
  }

  function entryCostTotal(entry) {
    return ((entry && entry.costItems) || []).reduce(function (sum, it) {
      return sum + costItemJpy(it);
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
          var jpy = costItemJpy(item);
          if (!paidBy || !(jpy > 0)) return;
          var splitAmong = (item.splitAmong && item.splitAmong.length) ? item.splitAmong : [paidBy];
          add(paidBy, jpy);
          var share = jpy / splitAmong.length;
          splitAmong.forEach(function (name) { add(name, -share); });
        });
      });
    });
    return balance;
  }

  // 精算の端数（丸め）単位。Walicaにならい、旅行ごとに1円／10円／100円から選べる
  // （trips.settle_unit、2026-09-27）。全員で共有する設定なので、trip側に持たせる。
  var SETTLE_UNITS = [1, 10, 100];

  // xをunit単位の最も近い値に丸める。半端（ちょうど半分）は0から遠い方へ丸める
  // （四捨五入の対称版。JSのMath.roundは常に+Infinity方向へ丸めるため、
  // 例えば-22977.5は-22977になってしまい、「23,000円送る」つもりが「22,977円」になる
  // ような食い違いが起きる。それを避けるため符号を先に取り出してから丸める）。
  function roundToUnit(x, unit) {
    var u = (unit === 10 || unit === 100) ? unit : 1;
    if (!x) return 0;
    return Math.sign(x) * Math.round(Math.abs(x) / u) * u;
  }

  // 貸し借り残高（tripBalancesの結果）から、送金の回数が最小になるような精算方法を作る
  // （最も多くもらう人と最も多く払う人を順にマッチさせる、よく知られた貪欲法）。
  // unit（1／10／100円、省略時は1円）は、マッチング自体は端数のない実残高のまま行い、
  // 最後に送金額だけをunit単位に丸める（Walicaと同じ挙動。マッチング前に丸めてしまうと、
  // 各人の丸め誤差が積み上がって「受け取る人の合計」が実際の残高より数円ずれて送金し
  // 損ねるケースがあった）。丸めた結果0円になった送金は一覧から外す。
  function settlementPlan(balance, unit) {
    var u = SETTLE_UNITS.indexOf(unit) !== -1 ? unit : 1;
    var creditors = [];
    var debtors = [];
    Object.keys(balance || {}).forEach(function (name) {
      var yen = balance[name] || 0;
      if (yen > 0.005) creditors.push({ name: name, amount: yen });
      else if (yen < -0.005) debtors.push({ name: name, amount: -yen });
    });
    creditors.sort(function (a, b) { return b.amount - a.amount; });
    debtors.sort(function (a, b) { return b.amount - a.amount; });
    var raw = [];
    var i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      var pay = Math.min(debtors[i].amount, creditors[j].amount);
      if (pay > 0.005) raw.push({ from: debtors[i].name, to: creditors[j].name, amount: pay });
      debtors[i].amount -= pay;
      creditors[j].amount -= pay;
      if (debtors[i].amount <= 0.005) i++;
      if (creditors[j].amount <= 0.005) j++;
    }
    var plan = [];
    raw.forEach(function (p) {
      var amount = roundToUnit(p.amount, u);
      if (amount !== 0) plan.push({ from: p.from, to: p.to, amount: amount });
    });
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
            currency: item.currency, rate: item.rate,
            paidBy: item.paidBy, splitAmong: (item.splitAmong && item.splitAmong.length) ? item.splitAmong : [item.paidBy],
            blockLabel: block.label,
          });
        });
      });
    });
    out.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    return out;
  }

  // 宿泊の見出し（label）は「ホテルに帰宅」「宿に戻る」のように、音声入力などで一般的な文言だけに
  // なることがある。「宿泊先」の表示にはお店の名前として意味が無いので、地図から分かった場所の名前
  // （entries[0].mapPlaceName）があればそちらを使う（v26、2026-09-29）。「ホテルニューオータニ」の
  // ような実在の名前は誤って外さないよう、パターンはオーナー指定のものをそのまま使う。
  var LODGING_GENERIC_LABEL_RE = /^(ホテル|宿|旅館|部屋)(に|へ)?(帰宅|戻る|帰る|到着|チェックイン)?$|帰宅|戻る|へ$/;
  function isGenericLodgingLabel(label) {
    return LODGING_GENERIC_LABEL_RE.test((label || '').trim());
  }
  // このBlockの記録（最初のもの）に、地図から分かった場所の名前が付いていればそれを返す
  function lodgingBlockMapName(b) {
    var e = (b && b.entries || [])[0];
    return ((e && e.mapPlaceName) || '').trim();
  }
  // 宿泊Blockの「表示名」：地図の場所の名前 → 一般的な文言でない見出し → どちらも無ければ空文字
  function lodgingDisplayName(b) {
    var mapName = lodgingBlockMapName(b);
    if (mapName) return mapName;
    var label = (b.label || '').trim();
    return isGenericLodgingLabel(label) ? '' : label;
  }

  // 宿泊カテゴリのBlockは「到着する」「宿に戻る」のように、同じ宿について複数できることがある
  // （特に音声入力は行動ごとにBlockを分けるため）。すべて繋げると意味不明になるので、
  // 一番最初（日程順で最初）の見出しだけを「宿泊先」として代表させる。
  // ただし、その見出しが「ホテルに帰宅」のような一般的な文言で地図の名前も無いときは、あとに
  // 出てくる宿泊Blockに地図の名前・ちゃんとした見出しがあれば、そちらを代わりに使う（2026-09-29）。
  function primaryLodgingName(blocks) {
    var lodging = (blocks || []).filter(function (b) { return b.category === 'lodging' && b.label; });
    if (!lodging.length) return '';
    for (var i = 0; i < lodging.length; i++) {
      var name = lodgingDisplayName(lodging[i]);
      if (name) return name;
    }
    return lodging[0].label;
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
      // 表示名（地図の名前／一般的でない見出し）が分かればそれを使い、その夜のいちばん新しい宿泊
      // Blockが一般的な文言だけ（例：同じ宿での「宿に帰宅」）でも、前の宿泊Blockで分かった名前を
      // 引き継ぐ（applicableを一般的な文言では上書きしない）。最後まで名前が分からなければ、
      // これまでどおりいちばん新しいBlockの見出しをそのまま出す（2026-09-29）。
      var applicable = '', applicableRaw = '';
      for (var j = 0; j < lodging.length; j++) {
        if (lodging[j].date > nightDate) break;
        applicableRaw = lodging[j].label;
        var name = lodgingDisplayName(lodging[j]);
        if (name) applicable = name;
      }
      labelForNight.push(applicable || applicableRaw);
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

  // 宿泊先の内訳の行ごとに、その行の元になった「宿泊」の予定を返す（行をタップして直すため。2026-09-27）。
  // lodgingByNightと同じまとめ方で、{ label, from, to, blockIds（その行に効いている予定。日程順） }
  function lodgingGroupBlocks(trip, blocks) {
    var dates = allDatesForTrip(trip, blocks);
    if (dates.length < 2) return [];
    var lodging = (blocks || [])
      .filter(function (b) { return b.category === 'lodging' && b.label && b.date; })
      .slice()
      .sort(function (a, b) {
        if (a.date !== b.date) return (a.date || '').localeCompare(b.date || '');
        return blockSortKey(a).localeCompare(blockSortKey(b));
      });
    var groups = [];
    for (var i = 0; i < dates.length - 1; i++) {
      var applicable = null;
      for (var j = 0; j < lodging.length; j++) {
        if (lodging[j].date <= dates[i]) applicable = lodging[j]; else break;
      }
      var label = applicable ? applicable.label : '';
      var last = groups[groups.length - 1];
      if (last && last.label === label) last.to = i + 1;
      else { last = { label: label, from: i + 1, to: i + 1, blockIds: [] }; groups.push(last); }
      if (applicable && last.blockIds.indexOf(applicable.id) === -1) last.blockIds.push(applicable.id);
      // 同じ夜のうちに同じ宿の予定がほかにもあれば（「到着」と「宿に戻る」など）一緒に直す
      lodging.forEach(function (b) {
        if (applicable && b.date === dates[i] && b.label === label && last.blockIds.indexOf(b.id) === -1) last.blockIds.push(b.id);
      });
    }
    return groups;
  }

  // 宿泊先の内訳の行を直すときに、どの予定をどう変えるか（2026-09-27）。
  // blocks：その行の元になった「宿泊」の予定、groupStart：その行の最初の夜、newStart：選んだ泊まり始め。
  //  ・泊まり始めがそのまま、または前にずらした：行の予定すべての名前を変え、最初の予定をその日へ移す
  //  ・行の途中の夜にした：その夜から先だけを新しい宿にする（それより前の夜の宿は動かさない）。
  //    その夜に予定があればそれから先の名前を変え、無ければその夜に予定を足す
  //    （以前は最初の予定をその夜へ移してしまい、手前の夜が「未定」になっていた）
  function lodgingEditPlan(blocks, groupStart, newStart) {
    var sorted = (blocks || []).slice().sort(function (a, b) { return (a.date || '').localeCompare(b.date || '') || blockSortKey(a).localeCompare(blockSortKey(b)); });
    if (!sorted.length) return { rename: [], move: null, create: newStart || null };
    if (!newStart || newStart <= groupStart) {
      var first = sorted[0];
      return { rename: sorted.map(function (b) { return b.id; }), move: newStart && newStart !== first.date && newStart < first.date ? { id: first.id, date: newStart } : null, create: null };
    }
    var later = sorted.filter(function (b) { return b.date >= newStart; });
    var startsThere = later.some(function (b) { return b.date === newStart; });
    return { rename: later.map(function (b) { return b.id; }), move: null, create: startsThere ? null : newStart };
  }

  // 宿泊先カードの短い表し方（2026-09-27）。以前は「1〜2泊目：菊の家／3泊目：マリオット／…」を全部並べ、
  // カードの中で途中から切れていた。いちばん長く泊まった宿（同じなら先の宿）＋「ほか○か所」にし、
  // 詳しくはカードを押したときの1泊1行の内訳で見る。未定の夜は数えない
  function lodgingSummary(groups) {
    var p = lodgingSummaryParts(groups);
    return !p ? '' : p.others ? p.main + ' ほか' + p.others + 'か所' : p.main;
  }
  function lodgingSummaryParts(groups) {
    var nightsBy = {}, order = [];
    (groups || []).forEach(function (g) {
      if (!g.label) return;
      if (!(g.label in nightsBy)) { nightsBy[g.label] = 0; order.push(g.label); }
      nightsBy[g.label] += g.to - g.from + 1;
    });
    if (!order.length) return null;
    var main = order.reduce(function (best, l) { return nightsBy[l] > nightsBy[best] ? l : best; }, order[0]);
    return { main: main, others: order.length - 1 };
  }
  // 泊ごとの宿（1泊目から順に）。{ night, date, label, blockId }（宿が無ければlabel=''・blockId=null）
  function lodgingNights(trip, blocks) {
    var dates = allDatesForTrip(trip, blocks).filter(Boolean);
    if (dates.length < 2) return [];
    var lodging = sortedLodging(blocks);
    return dates.slice(0, -1).map(function (d, i) {
      var applicable = null;
      for (var j = 0; j < lodging.length; j++) { if (lodging[j].date <= d) applicable = lodging[j]; else break; }
      return { night: i + 1, date: d, label: applicable ? applicable.label : '', blockId: applicable ? applicable.id : null };
    });
  }
  function sortedLodging(blocks) {
    return (blocks || [])
      .filter(function (b) { return b.category === 'lodging' && b.label && b.date; })
      .slice()
      .sort(function (a, b) {
        if (a.date !== b.date) return (a.date || '').localeCompare(b.date || '');
        return blockSortKey(a).localeCompare(blockSortKey(b));
      });
  }
  // 「from泊目〜to泊目を、この宿にする」ための変更（2026-09-27）。予定の日付は動かさない
  // （以前は最初の予定を別の日へ移していて、記録ごと別の日へ動き、手前の夜が「未定」になっていた）。
  //  ・その範囲の日付にある「宿泊」の予定は、名前をこの宿にする
  //  ・泊まり始めの日に「宿泊」の予定が無ければ、その日に足す（地図はここに入れる）
  //  ・泊まり終わりの次の夜まで前の宿が続いていたなら、次の夜に前の宿の予定を足して、そこから元に戻す
  // 返す値：{ rename: [予定のid], create: [{ date, label, mapFrom（地図を写す元の予定のid）, target }], target（地図を入れる予定のid。足すときはnull） }
  function lodgingRangePlan(trip, blocks, fromNight, toNight, name) {
    var nights = lodgingNights(trip, blocks);
    if (!nights.length) return { rename: [], create: [], target: null };
    var a = Math.max(1, Math.min(fromNight, toNight)), b = Math.min(nights.length, Math.max(fromNight, toNight));
    var from = nights[a - 1].date, to = nights[b - 1].date;
    var lodging = sortedLodging(blocks);
    var inRange = lodging.filter(function (x) { return x.date >= from && x.date <= to; });
    var plan = { rename: inRange.filter(function (x) { return x.label !== name; }).map(function (x) { return x.id; }), create: [], target: null };
    var atStart = inRange.filter(function (x) { return x.date === from; });
    if (atStart.length) plan.target = atStart[0].id;
    else plan.create.push({ date: from, label: name, mapFrom: null, target: true });
    var next = nights[b];
    if (next && next.blockId && next.label !== name) {
      var nb = lodging.filter(function (x) { return x.id === next.blockId; })[0];
      if (nb && nb.date <= to) plan.create.push({ date: next.date, label: next.label, mapFrom: nb.id, target: false });
    }
    return plan;
  }

  // 宿泊先を手で足すときの「何泊目から」の選択肢（2026-09-27）。n泊目＝旅行のn日目の夜。
  // 日帰り・日程未設定の旅行は、分かっている日付をそのまま選べるようにする
  function lodgingNightOptions(trip, blocks) {
    var dates = allDatesForTrip(trip, blocks).filter(Boolean);
    if (dates.length < 2) return dates.map(function (d) { return { date: d, label: formatMonthDay(d) }; });
    return dates.slice(0, -1).map(function (d, i) { return { date: d, label: (i + 1) + '泊目（' + formatMonthDay(d) + '）' }; });
  }
  function formatMonthDay(d) {
    var m = /^\d{4}-(\d{2})-(\d{2})$/.exec(d || '');
    return m ? Number(m[1]) + '/' + Number(m[2]) : (d || '');
  }

  // 費用の総額を「実際に払った人」ごとに内訳表示するための集計。立て替え（paidBy）を
  // 設定した費用行はpaidByへ、設定していない費用行（従来どおりの個人費用）はEntryの
  // authorへ、それぞれ全額を計上する（誰か1人が全部払ったことにして二重計上はしない）。
  function costBreakdownByPerson(blocks) {
    var totals = {};
    (blocks || []).forEach(function (block) {
      (block.entries || []).forEach(function (entry) {
        (entry.costItems || []).forEach(function (item) {
          var jpy = costItemJpy(item);
          if (!(jpy > 0)) return;
          var payer = item.paidBy || entry.author || '';
          if (!payer) return;
          totals[payer] = (totals[payer] || 0) + jpy;
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

  // 「履歴から消す」の計算（純粋関数）。選んだ旅行を索引から外し、隠しリストへ足した新しい2つを返す。
  // 隠しリストに足すのは、ログイン中のアカウント同期が消した旅行を索引へ足し直さないようにするため。
  // ids：消したい旅行のID配列。索引に無いIDは無視する（隠しリストにも足さない）。
  function planHistoryRemoval(myTrips, hiddenIds, ids) {
    var remove = {};
    (ids || []).forEach(function (id) { remove[id] = true; });
    var removedIds = (myTrips || []).filter(function (t) { return remove[t.id]; }).map(function (t) { return t.id; });
    var hidden = (hiddenIds || []).slice();
    removedIds.forEach(function (id) { if (hidden.indexOf(id) === -1) hidden.push(id); });
    return {
      trips: (myTrips || []).filter(function (t) { return !remove[t.id]; }),
      hidden: hidden,
      removedIds: removedIds
    };
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

  // 手動で選べる天気（2026-09-26〜）。場所の入力欄は分かりづらい（「ユニバーサル」がオーランドの
  // 天気になった等）ため廃止し、本人がアイコンで選ぶだけにした。温度は持たない。
  // コードはWMO weather codeの代表値を流用しているだけで、weatherLabel()の分類とは別物
  // （「晴れ時々くもり」はweatherLabel()には無い区分）。
  var MANUAL_WEATHER_OPTIONS = [
    { code: 1, icon: '☀️', label: '晴れ' },
    { code: 2, icon: '🌤️', label: '晴れ時々くもり' },
    { code: 3, icon: '☁️', label: 'くもり' },
    { code: 61, icon: '🌧️', label: '雨' },
    { code: 95, icon: '⛈️', label: '雷雨' },
    { code: 71, icon: '❄️', label: '雪' },
  ];

  // 昔の自動取得・旧手動修正機能（0/45/48/51〜57/80〜82/85〜86など）で入っていたWMOコードも、
  // 上の6種のどれかに寄せて表示する（古いデータを消さずに済むように。2026-09-26）。
  function manualWeatherDisplay(code) {
    if (code === null || code === undefined) return null;
    var exact = MANUAL_WEATHER_OPTIONS.filter(function (o) { return o.code === code; })[0];
    if (exact) return exact;
    if (code === 0) return MANUAL_WEATHER_OPTIONS[0]; // 快晴→晴れ
    if (code === 3 || code === 45 || code === 48) return MANUAL_WEATHER_OPTIONS[2]; // 曇り・霧→くもり
    if ((code >= 51 && code <= 57) || (code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return MANUAL_WEATHER_OPTIONS[3]; // 霧雨・雨・にわか雨→雨
    if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return MANUAL_WEATHER_OPTIONS[5]; // 雪・にわか雪→雪
    if (code >= 95) return MANUAL_WEATHER_OPTIONS[4]; // 雷雨
    return null;
  }

  // ---------- 地図でふりかえる（replay） ----------
  // 予定（Block）を「地図の上を時刻どおりに移動していく演出」に変換する純粋関数。
  // 地図の描画（Leaflet）は画面側の仕事で、ここでは「どの順で・いつ・どこにいるか」だけを決める。
  // 時間の単位は2つある：t＝旅の中の時刻（1日目0時からの経過分）、r＝再生の実時間（秒）。

  var REPLAY_SEC_PER_MIN = 0.06;     // 1000倍速（旅の1分＝実時間0.06秒）。100倍速・500倍速でも遅いという声で変更
  var REPLAY_LEAD_MIN = 5;           // 最初の予定の少し前から時計を動かし始める
  var REPLAY_DWELL_MIN = 8;          // 到着後、吹き出しを見せながら1000倍速で進める旅の時間（分）
  var REPLAY_MIN_CAPTION_SEC = 3;     // 写真が無い地点は、文章の長さに関わらずこの秒数だけ吹き出しを見せる（2026-09-27: 文章が長いほど延ばす仕組みは廃止）
  var REPLAY_MAX_CAPTION_SEC = 10;    // 写真がある地点でも、これ以上は止めない（写真4枚分の秒数）
  var REPLAY_MAX_PHOTOS = 4;          // 1つの地点で見せる写真の上限（6枚だと1地点15秒止まり長かったので4枚＝10秒に）
  var REPLAY_CAPTION_HIDE_LEAD_SEC = 1.15; // 次の移動でカメラが動き出す少し前に吹き出しを消す秒数（画面側と共通）
  var REPLAY_SEC_PER_PHOTO = 2.5;     // 写真1枚をこの秒数ずつ見せる（1.4秒は速すぎるという声で変更）。吹き出しは全部の写真を見せ終わるまで出す
  // 移動の演出の長さ（秒）。以前はどれだけ遠くても一律2秒だったが、「短い移動と同じ速さだと、
  // 長距離の移動が味気ない」という声より、遠い移動は少しだけ長く見せる（2026-09-27）。
  var REPLAY_MOVE_SEC_MIN = 2;       // 100km以下はこれまでどおり2秒
  var REPLAY_MOVE_SEC_MAX = 4;       // 500km以上はこれまでの2倍の4秒
  var REPLAY_PLANE_MOVE_SEC = 1.8;   // 飛行機の移動の秒数（カメラの動き・着いたあとの一呼吸を合わせて約3秒）
  var REPLAY_MOVE_KM_SHORT = 100;
  var REPLAY_MOVE_KM_LONG = 500;
  function legMoveSeconds(km) {
    if (!(km > REPLAY_MOVE_KM_SHORT)) return REPLAY_MOVE_SEC_MIN;
    if (km >= REPLAY_MOVE_KM_LONG) return REPLAY_MOVE_SEC_MAX;
    var f = (km - REPLAY_MOVE_KM_SHORT) / (REPLAY_MOVE_KM_LONG - REPLAY_MOVE_KM_SHORT);
    return REPLAY_MOVE_SEC_MIN + f * (REPLAY_MOVE_SEC_MAX - REPLAY_MOVE_SEC_MIN);
  }
  var REPLAY_IDLE_CAP_SEC = 1.2;     // 移動も何も無い空き時間はこの秒数に早送りする
  var REPLAY_ARRIVAL_PAUSE_SEC = 0.5; // 着いてから吹き出し（写真・エピソード）を出すまでの一呼吸（カメラが収まるのを待つ。2026-09-27）
  // 区間で着いた地点は、着いたあとカメラが着いた地点へ寄せ直す（遅延＋飛行の時間）ことがある。
  // 吹き出し・写真は「乗り物が着いて、カメラが落ち着いてから」出す（オーナーの指示、2026-09-30）ので、
  // 区間で着いた地点は、その分（カメラの寄せ直しが終わるまで）待ってから吹き出しを出す。
  // 画面側（カメラの制御）も同じ値を使う。
  var REPLAY_CAMERA_FLIGHT_SEC = 0.8;        // カメラのアニメーション（flyTo）の長さ
  var REPLAY_ARRIVAL_ZOOM_DELAY_SEC = 0.2;   // 着いてから、着いた地点へ寄せ直し始めるまで
  var REPLAY_ARRIVAL_SETTLE_SEC = 1.1;       // 区間で着いた地点：吹き出しを出すまで（0.2＋0.8＋余裕0.1）
  var REPLAY_JUMP_EPS = 1e-6;         // 吹き出しが消えて時計を一気に進める瞬間の、見た目には分からない実時間のずらし幅
  var REPLAY_UNTIMED_START_MIN = 9 * 60;

  // 予定の場所は、記録に入っている地図のURL（Googleマップの共有リンク maps.app.goo.gl/… や
  // 検索URL）だけから決める。URLのままWorker（/geocode）に渡し、短縮URLの展開・座標や住所の
  // 読み取りはWorker側で行う。地図の入っていない予定（「小西遅刻」など）は移動の目的地にせず、
  // 空文字を返して「出来事」（その場で吹き出しだけ出す）として扱う。
  // 以前は見出し（「那覇空港に到着」など）から地名を推測していたが、同名の別の場所に飛ぶなど
  // 外れることがあったため、地図が入っている予定だけを使う方針にした。
  // 地図のURLだけでなく、その元になった記録(entry)のid・サーバーがすでに求めてある座標
  // （entry.mapLat/mapLng。entry.mapGeocodedUrlが今のmap_urlと同じときだけAPIが返す。Part A、
  // 2026-09-26〜）も一緒に返す。座標があれば/geocodeを呼ばずに使え、無ければ&entry=<id>を付けて
  // 呼ぶことでサーバー側に保存してもらい、次回からは呼ばなくてよくなる。
  // Googleマップの検索リンクのquery（またはq）が「undefined」「null」「NaN」（カンマ区切りの2つ含む）
  // だけのときは、クライアント側の不具合で壊れて保存されたリンクとみなし、地図が無いのと同じに扱う
  // （地図の目的地にしない・地名の手がかり探しにも使わない）。以前はこの手のリンクの見出し（hint）から
  // 場所を推測しようとして、無関係な場所（例：エチオピア）に飛ぶことがあった（2026-09-26、大阪旅行）。
  function hasBrokenMapQuery(url) {
    try {
      var u = new URL(url);
      var q = (u.searchParams.get('query') || u.searchParams.get('q') || '').trim();
      return /^(undefined|null|nan)(\s*,\s*(undefined|null|nan))?$/i.test(q);
    } catch (e) {
      return false;
    }
  }

  // 記録フォームの「地図のURL」欄を、候補（place：座標があればlat/lng、無ければplaceIdだけ）と
  // 検索した文字列（searchText）から作る。座標が数値として両方揃っているときだけ座標のURLにし、
  // まだ座標が届いていない・壊れている（undefined/NaN）ときは検索文字列のURLにする。
  // undefined/NaNを含むURLを絶対に作らないための、書き込み前の最後の関門（2026-09-27、大阪旅行の実データより）。
  // 移動の予定の到着地（記録の「移動の情報」の到着地の地図と到着時刻。2026-09-27〜）。無ければnull
  function travelArrival(block) {
    if (!block || block.category !== 'transport') return null;
    var entries = (block && block.entries) || [];
    for (var i = 0; i < entries.length; i++) {
      var t = entries[i].travel || {};
      var url = (t.arriveMapUrl || '').trim();
      if (/^https?:\/\//i.test(url) && !hasBrokenMapQuery(url)) {
        return {
          url: url,
          lat: typeof t.arriveLat === 'number' ? t.arriveLat : null,
          lng: typeof t.arriveLng === 'number' ? t.arriveLng : null,
          time: /^\d{1,2}:\d{2}$/.test(t.arrive || '') ? t.arrive : '',
          label: (t.to || '').trim()
        };
      }
    }
    return null;
  }

  function placeMapUrl(place, searchText) {
    var q = (place && isFinite(place.lat) && isFinite(place.lng)) ? place.lat + ',' + place.lng : (searchText || '').trim();
    if (!q) return '';
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
  }
  // 候補（place。「地図のURL」欄の座標検索で選んだもの）または検索した文字列（searchText。
  // 「Googleマップで検索」を選んだときなど、座標のない検索）から、記録と一緒に保存する
  // 「場所の名前」を決める。候補があればその名前（例：Googleの候補のname）。無ければ検索文字列を
  // そのまま名前にするが、それが座標（"35.68,139.76"のような並び）そのものなら名前として
  // 意味が無いので保存しない（applySelectedPlaceToMapUrl・saveEntryの名前紐付けで使う。2026-09-29）。
  var COORD_PAIR_RE = /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/;
  function placeSelectionName(place, searchText) {
    var name = (place && place.name) ? String(place.name).trim() : '';
    if (name) return name;
    var text = (searchText || '').trim();
    if (!text || COORD_PAIR_RE.test(text)) return '';
    return text;
  }
  function replayPlaceEntry(block) {
    var entries = (block && block.entries) || [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var url = (e.mapUrl || '').trim();
      if (/^https?:\/\//i.test(url) && !hasBrokenMapQuery(url)) {
        return {
          url: url,
          entryId: e.id || '',
          lat: typeof e.mapLat === 'number' ? e.mapLat : null,
          lng: typeof e.mapLng === 'number' ? e.mapLng : null
        };
      }
    }
    return null;
  }
  function replayPlaceQuery(block) {
    var e = replayPlaceEntry(block);
    return e ? e.url : '';
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
    var pendingTransport = '', pendingMove = 0, out = [];
    var sorted = sortBlocks(blocks).filter(function (b) { return b.date && dates.indexOf(b.date) !== -1; });
    sorted.forEach(function (b, bi) {
      var minute = hhmmToMinute(b.time);
      var estimated = minute === null;
      // 「ここまでの移動手段」は次の予定にも引き継ぐ値なので、時刻の見積もりより前に求めておく
      // （時刻なしの予定が飛行機で到着した先かどうかを、日をまたぐ見積もり（下のstep2）で使う）。
      var arrivingGuess = b.category === 'transport' ? pendingTransport : (b.transport || pendingTransport);
      var estimateSource = '';
      var dayIndexOverride = null;
      if (estimated) {
        var prev = lastMinute[b.date];
        var dayIdxCur = dates.indexOf(b.date);
        var curOffset = typeof b._offset === 'number' ? b._offset : (typeof lastOffset === 'number' ? lastOffset : 0);
        if (pendingMove) {
          // 1. 直前の移動の予定に移動時間があれば、その分だけ後と見積もる（従来どおり）
          minute = prev === undefined ? REPLAY_UNTIMED_START_MIN : Math.min(prev + pendingMove, 23 * 60 + 59);
          estimateSource = 'move';
        } else {
          // 2. 直前に移動時間が無ければ、あとで時刻の分かっている予定を探し、その30分前と見積もる
          //    （羽田発→ハワイ着（時刻なし）→ハワイでの次の予定11:00、のようなケースを、次の予定を
          //    無視して「直前+30分」にしてしまっていたのを直す。2026-09-29）。
          //    日をまたいで探すのは、飛行機で着いた先（日付が変わることがある）だけに限る。
          var found = null;
          for (var k = bi + 1; k < sorted.length; k++) {
            var nb = sorted[k];
            if (nb.date !== b.date) {
              if (arrivingGuess !== 'plane') break;
              var nbDayIdx = dates.indexOf(nb.date);
              if (nbDayIdx === -1 || nbDayIdx !== dayIdxCur + 1) break;
            }
            var nm = hhmmToMinute(nb.time);
            if (nm !== null) { found = nb; break; }
          }
          if (found) {
            var nextOffset = typeof found._offset === 'number' ? found._offset : curOffset;
            var foundDayIdx = dates.indexOf(found.date);
            var targetAbs = foundDayIdx * 1440 + hhmmToMinute(found.time) - nextOffset;
            var prevAbs = prev === undefined ? null : (dayIdxCur * 1440 + prev - curOffset);
            var candidateAbs = targetAbs - 30;
            if (prevAbs !== null) {
              var gap = targetAbs - prevAbs;
              if (gap < 35) candidateAbs = prevAbs + gap / 2;
            }
            // あとの予定は日付・時差ともに確かな値を持つ手がかりなので、日付をまたぐ見積もりになっても
            // （前日の23:xxではなく）実際の日に置く（下のstep3の「元の日付のまま」とは違い、こちらは
            // 具体的な次の予定という裏付けがあるため）。
            var localTotal = candidateAbs + curOffset;
            var newDayIdx = Math.max(0, Math.min(dates.length - 1, Math.floor(localTotal / 1440)));
            minute = Math.max(0, Math.min(23 * 60 + 59, Math.round(localTotal - newDayIdx * 1440)));
            dayIndexOverride = newDayIdx;
            estimateSource = 'next';
          } else {
            // 4. 見積もりの手がかりが無ければ、従来どおり直前の30分後（その日に時刻ありが無ければ9時から1時間おき）
            minute = prev === undefined ? REPLAY_UNTIMED_START_MIN : Math.min(prev + (hasTimed[b.date] ? 30 : 60), 23 * 60 + 59);
            estimateSource = 'default';
          }
        }
      }
      var placeEntry = replayPlaceEntry(b);
      // 移動の予定（category==='transport'）自身の transport は「次の場所への移動」を表す値なので、
      // その予定自身が地図上の地点になるとき（＝移動の予定に、たどり着いた先の地図が入っているとき）の
      // 「ここまでの移動手段」には使わない。代わりに、直前までに引き継いだpendingTransportを使う
      // （地図が壊れている移動の予定でも、移動手段だけは次に引き継いでいるため）。
      // 例：赤レンガ倉庫→（新横浜から大阪への移動、地図が壊れている。ここでpendingTransport='train'）
      //     →新大阪からユニバへ（地図あり、それ自身のtransportは'train'だが「次への移動」の意味なので
      //     使わず、pendingTransportの'train'を使う。2026-09-27）
      var arriving = arrivingGuess;
      if (b.category === 'transport') { pendingTransport = b.transport || ''; pendingMove = b.moveMinutes || 0; }
      else if (placeEntry) { pendingTransport = ''; pendingMove = 0; }
      // 日をまたぐ見積もり（上のstep2）で置き先の日が変わったときは、その日付で並びを扱う
      var stopDate = dayIndexOverride !== null ? (dates[dayIndexOverride] || b.date) : b.date;
      lastMinute[stopDate] = minute;
      if (typeof b._offset === 'number') lastOffset = b._offset;
      var dayIndex = dayIndexOverride !== null ? dayIndexOverride : dates.indexOf(b.date);
      var captions = (b.entries || []).map(function (e) {
        // 以前は40文字で切っていたため、スマホでは1.5行ほどで途切れていた。全文を出す（見せる時間は文字数で延ばす）
        return (e.episode || '').trim() || (e.comment || '').trim();
      }).filter(Boolean).slice(0, 3);
      // Reliveのように、着いたところで写真もエピソードと一緒に見せる（予定の記録の写真を最大4枚）
      var photos = [];
      (b.entries || []).forEach(function (e) { (e.photoIds || []).forEach(function (id) { if (photos.length < REPLAY_MAX_PHOTOS) photos.push(id); }); });
      out.push({
        blockId: b.id, date: stopDate, dayIndex: dayIndex, dayNumber: dayIndex + 1,
        minute: minute, estimated: estimated, label: b.label || '', captions: captions, photos: photos,
        transport: arriving, query: placeEntry ? placeEntry.url : '',
        // 記録のid・サーバーがすでに求めてある座標（Part A）。geocodeQueriesがこれを見て、
        // 分かっていれば/geocodeを呼ばずに使い、無ければ&entry=を付けて呼ぶ
        entryId: placeEntry ? placeEntry.entryId : '',
        knownLat: placeEntry ? placeEntry.lat : null,
        knownLng: placeEntry ? placeEntry.lng : null,
        offset: lastOffset, // 現地の時差（分）。分からなければnull（時刻なしの予定は直前の予定の時差）
        // 時刻を見積もった根拠（'move'=直前の移動時間／'next'=あとの予定の30分前／'default'=直前+30分など）。
        // buildReplayTimelineが、座標が分かってから飛行機の所要時間で見積もり直せるかどうかに使う（2026-09-29）
        estimateSource: estimated ? estimateSource : ''
      });
      // 移動の予定に「到着地の地図」が入っていれば、その移動の到着を1つの地点として足す（2026-09-27）。
      // 到着時刻は到着地の現地時間なので、出発（出発地の時差）より前にならない日付に置く
      // （例：6/26 20:00 成田発 → 6/26 18:50 LA着は、LAの時差で見ると出発の後）。
      var arr = travelArrival(b);
      if (arr && (arr.url || typeof arr.lat === 'number')) {
        var depOff = typeof b._offset === 'number' ? b._offset : (typeof lastOffset === 'number' ? lastOffset : 0);
        var arrOff = typeof b._arriveOffset === 'number' ? b._arriveOffset : depOff;
        var depUtc = dayIndex * 1440 + minute - depOff;
        var aMin = hhmmToMinute(arr.time), aDay = dayIndex, aEst = aMin === null;
        if (aEst) {
          var local = depUtc + (b.moveMinutes || 60) + arrOff;
          aDay = Math.floor(local / 1440); aMin = local - aDay * 1440;
        } else {
          while (aDay * 1440 + aMin - arrOff < depUtc && aDay < dayIndex + 3) aDay++;
        }
        var aDate = dates[aDay] || b.date;
        out.push({
          blockId: b.id + '#arrive', date: aDate, dayIndex: aDay, dayNumber: aDay + 1,
          minute: aMin, estimated: aEst, label: arr.label || '到着', captions: [], photos: [],
          transport: b.transport || '', query: arr.url || '', entryId: '',
          knownLat: typeof arr.lat === 'number' ? arr.lat : null,
          knownLng: typeof arr.lng === 'number' ? arr.lng : null,
          offset: typeof b._arriveOffset === 'number' ? b._arriveOffset : lastOffset,
          arrival: true
        });
        // 到着でその移動は終わり。次の場所へは、移動手段を引き継がない（飛行機の続きで飛ばない）
        pendingTransport = ''; pendingMove = 0;
        if (typeof b._arriveOffset === 'number') lastOffset = b._arriveOffset;
        if (dates[aDay]) lastMinute[aDate] = aMin;
      }
    });
    return out;
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
  // - 旅の時間は基本1000倍速、ただし長い移動・何も無い空き時間は上限秒数に早送りする
  var REPLAY_PLANE_KM = 400;
  var REPLAY_PLANE_MIN_KM = 100; // これより近い区間の飛行機はありえない（移動手段の付き違い）とみなす（2026-09-27）
  var REPLAY_WALK_KM = 1.5; // 移動手段が入っていない、とても近い移動（1.5km未満）は徒歩とみなす（2026-09-26）
  var REPLAY_STAY_KM = 0.3; // これ未満の距離は「同じ場所にとどまっている」とみなし、移動（leg）を作らない（2026-09-29）
  // 時刻の無い到着（見積もりの手がかり（moveMinutes・後の予定）が無いとき）を、飛行機の所要時間から見積もる
  // ときの速さと、離着陸・待ち時間ぶんの余裕（分）。docs/adr/0008参照（2026-09-29）
  var REPLAY_FLIGHT_KMH = 850;
  var REPLAY_FLIGHT_BUFFER_MIN = 60;

  // 2地点の距離（km）
  function distanceKm(a, b) {
    var rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 12742 * Math.asin(Math.sqrt(h));
  }

  // ふりかえりの再生で、カメラを動かす前に「もう合っている」かどうかを決める純粋な判定（Leafletに依存しない
  // ので単体テストできる）。今の中心・縮尺（current）が動かしたい先（target）とほぼ同じ（許容誤差以内）なら
  // 動かす必要なしとみなす。同じ場所が続く予定（乗り継ぎ空港など）で、着くたびにほぼ同じ場所へ何度も
  // flyToBounds／flyToが呼ばれ、地図が細かく揺れて見えていたのを防ぐ（2026-09-29、docs/adr/0008）。
  var REPLAY_CAMERA_CENTER_TOLERANCE_KM = 0.05; // これ未満のずれは「同じ場所」とみなす
  var REPLAY_CAMERA_ZOOM_TOLERANCE = 0.2; // これ未満のズームの差は「同じ縮尺」とみなす
  function cameraMoveNeeded(current, target) {
    if (!current || !target) return true;
    if (typeof current.lat !== 'number' || typeof current.lng !== 'number') return true;
    if (typeof target.lat !== 'number' || typeof target.lng !== 'number') return true;
    if (distanceKm(current, target) > REPLAY_CAMERA_CENTER_TOLERANCE_KM) return true;
    if (typeof current.zoom === 'number' && typeof target.zoom === 'number' &&
      Math.abs(current.zoom - target.zoom) > REPLAY_CAMERA_ZOOM_TOLERANCE) return true;
    return false;
  }

  // カメラを1本の制御で動かすための判断（2026-09-30）。'skip'（動かさない）・'defer'（いまのアニメが終わってから）・
  // 'go'（いま始める）のどれかを返す。
  //   view   ：いまの見え方。アニメ中なら、そのアニメの行き先（今の途中の見え方ではなく）
  //   target ：動かしたい先（fitBoundsの実際の結果。中心と縮尺）
  //   o.flying       ：アニメ中か
  //   o.urgent       ：動かさないと間に合わない（移動の直前）か。急ぎならアニメ中でも始め直す
  //   o.viewWidthPx  ：地図の横幅（px）。あれば「ずれ」の許容を画面の大きさに合わせる（画面幅の6%未満は同じ場所）。
  //                    以前は固定の50mで、ズーム15なら画面の1/10ほどのずれでも毎回カメラが動いていた
  //   o.alreadyVisible：動かしたい対象（道のりの両端など）が、いまの見え方の中にもう収まっているか。
  //                    収まっていて縮尺の差が1段以内なら、動かさない（続く短い区間で、毎回寄せ直して
  //                    ズームが行ったり来たりしないように）
  var REPLAY_CAMERA_SCREEN_TOLERANCE = 0.06;
  var REPLAY_CAMERA_ZOOM_TOLERANCE_SNAPPED = 0.5; // 縮尺は整数刻み（zoomSnap=1）なので、半段未満は同じ
  function cameraMoveDecision(view, target, o) {
    o = o || {};
    var needed;
    if (!view || !target) needed = true;
    else if (typeof o.viewWidthPx === 'number' && o.viewWidthPx > 0 && typeof view.zoom === 'number') {
      var kmPerPx = 156.54303392 * Math.cos((view.lat || 0) * Math.PI / 180) / Math.pow(2, view.zoom) ;
      var tol = Math.max(REPLAY_CAMERA_CENTER_TOLERANCE_KM, REPLAY_CAMERA_SCREEN_TOLERANCE * o.viewWidthPx * kmPerPx);
      needed = distanceKm(view, target) > tol ||
        (typeof target.zoom === 'number' && Math.abs(view.zoom - target.zoom) > REPLAY_CAMERA_ZOOM_TOLERANCE_SNAPPED);
    } else needed = cameraMoveNeeded(view, target);
    if (!needed) return 'skip';
    if (o.alreadyVisible && view && target && typeof view.zoom === 'number' && typeof target.zoom === 'number' &&
      Math.abs(view.zoom - target.zoom) <= 1) return 'skip';
    if (o.flying && !o.urgent) return 'defer';
    return 'go';
  }

  // 前後の場所からだけ、遠く離れた「ピンが違うかもしれない」地点を見つける。前後の地点どうしは
  // 近い（FAR未満）のに、真ん中の地点だけ両方からFAR超え離れているときだけ怪しいと判定する
  // （前後も含めて遠くへ移動した日＝本物の長距離移動は、前後どうしも遠いのでここには当たらない）。
  // 地図でふりかえる（ピンが違うせいで大きく飛んで見える。例：ヒューストン滞在中の1件だけ
  // ロサンゼルスの自宅のピンが残っていた）と、旅行詳細画面の「この地図は前後の予定から遠く
  // 離れています」の注意書き、両方で使う（2026-09-29）。
  var OUTLIER_FAR_KM = 800;
  var OUTLIER_NEAR_KM = 300;
  function isFarMapOutlier(prev, cur, next) {
    if (!prev || !cur || !next) return false;
    if (typeof prev.lat !== 'number' || typeof cur.lat !== 'number' || typeof next.lat !== 'number') return false;
    return distanceKm(prev, cur) > OUTLIER_FAR_KM && distanceKm(cur, next) > OUTLIER_FAR_KM &&
      distanceKm(prev, next) < OUTLIER_NEAR_KM;
  }

  // 予定（Block）を時系列に並べ、前後から遠く離れたピンを持つ予定のidを集める。各Blockの地図は
  // 最初の記録（entries[0]）のmapLat/mapLngを使う（lodgingBlockMapName等と同じ決め方）。
  // 旅行詳細画面の警告表示に使う（2026-09-29）。
  function findFarMapOutlierBlockIds(blocks) {
    var sorted = sortBlocks(blocks || []);
    var located = [];
    sorted.forEach(function (b) {
      var e = (b.entries || [])[0];
      if (e && typeof e.mapLat === 'number' && typeof e.mapLng === 'number') {
        located.push({ id: b.id, lat: e.mapLat, lng: e.mapLng });
      }
    });
    var out = {};
    for (var i = 1; i < located.length - 1; i++) {
      if (isFarMapOutlier(located[i - 1], located[i], located[i + 1])) out[located[i].id] = true;
    }
    return out;
  }

  // OSRMの車ルートが、たどり着けない目的地（歩行者専用の階段など）を遠い道に迂回させることがある
  // （リオデジャネイロ大聖堂→セラロン階段、約1kmの徒歩圏なのに車で大回りするなど）。
  // 直線距離よりずっと長い道のり（2.5倍を超え、かつ+1.5km以上長い）は「たどり着けていない」とみなし、
  // 呼び出し側で徒歩ルートを調べ直す・それでも長ければ直線に戻す判断に使う。
  // ただしこれは近距離（直線2km未満）に限る。コルコバードの丘のように直線は数kmでも、山道で実際に
  // 大回りになる道路ルートは正しい経路なので、直線に戻さない（2026-09-26）。
  var ROUTE_DETOUR_MAX_STRAIGHT_KM = 2;
  function isRouteDetourTooLong(straightKm, routeKm) {
    if (!(straightKm > 0) || !(routeKm >= 0)) return false;
    if (straightKm >= ROUTE_DETOUR_MAX_STRAIGHT_KM) return false;
    return routeKm > straightKm * 2.5 && routeKm > straightKm + 1.5;
  }

  // 住所・店名から探すとき、Workerに「この近く」として渡してよい旅行内の前後の場所を選ぶ。
  // 単に旅程順で前後にある「すでに座標が分かった場所」を渡すと、成田空港の出発（飛行機で最初の記録）に
  // 対して、遠く離れたリオデジャネイロのホテル（すでに座標が分かっていた）を「近く」として渡してしまい、
  // Worker側の距離ガードで正しい成田の結果を弾いてしまっていた（2026-09-26）。
  // 前後の場所は、①同じ日付で、②間（両端を含む）に飛行機（transport === 'plane'）の区間が無いときだけ使う。
  // stops：[{ date, transport, coords }]（旅程順、coordsは座標が分かっていればlat/lng、まだなら null/undefined）
  function geocodeNearIndexes(stops, i) {
    stops = stops || [];
    function hasPlaneBetween(a, b) {
      var lo = Math.min(a, b), hi = Math.max(a, b);
      for (var k = lo; k <= hi; k++) if (stops[k] && stops[k].transport === 'plane') return true;
      return false;
    }
    function validNeighbor(a) {
      var s = stops[a], cur = stops[i];
      if (!s || !s.coords || !cur) return false;
      if (s.date !== cur.date) return false;
      return !hasPlaneBetween(a, i);
    }
    var near = [];
    for (var a = i - 1; a >= 0; a--) if (stops[a] && stops[a].coords) { if (validNeighbor(a)) near.push(stops[a].coords); break; }
    for (var b = i + 1; b < stops.length; b++) if (stops[b] && stops[b].coords) { if (validNeighbor(b)) near.push(stops[b].coords); break; }
    return near;
  }

  // 飛行機の弧（arcLatLng、arc=true）を、移動アイコンが実際にたどる密な折れ線にする。
  // これにより「アイコンの位置」と「線の描画」が常に同じ点を通る（docs/adr/0008）。
  // 経度が日付変更線をまたぐ移動（ハワイ⇄東京など）は、そのまま引くと逆回りの長い経路になってしまうため、
  // 出発地から見て連続した経度（180度を超えてもよい）に直してから弧を作る。
  var REPLAY_PLANE_ARC_POINTS = 32;
  function planeArcPath(a, b, n) {
    n = Math.max(2, n || REPLAY_PLANE_ARC_POINTS);
    var dLng = b.lng - a.lng;
    if (dLng > 180) dLng -= 360; else if (dLng < -180) dLng += 360;
    var to = { lat: b.lat, lng: a.lng + dLng };
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var p = arcLatLng(a, to, i / n, true);
      pts.push([p.lat, p.lng]);
    }
    return pts;
  }

  // 道のり（Worker「/route」）がまだ届いていない・見つからない区間でも、旅は必ずつなげてほしいという声より
  // （2026-09-27）、直線ではなく少しだけ膨らませた「やわらかい曲線」を最初から用意しておく。飛行機の弧
  // （arcLatLng、bulge比率0.18）と同じ考え方だが、膨らみは直線距離の約8%に抑える（車・電車などの短い
  // 移動で弧が大げさに見えないように）。アイコンと線が同じ点をたどるよう、この道のりをそのままleg.pathに使う。
  var REPLAY_GENTLE_CURVE_POINTS = 32;
  var REPLAY_GENTLE_CURVE_OFFSET_RATIO = 0.08;
  function gentleCurvePath(a, b, n) {
    n = Math.max(2, n || REPLAY_GENTLE_CURVE_POINTS);
    var offsetKm = distanceKm(a, b) * REPLAY_GENTLE_CURVE_OFFSET_RATIO;
    var dLat = b.lat - a.lat, dLng = b.lng - a.lng;
    var latPerKm = 1 / 111, lngPerKm = 1 / (111 * Math.cos((a.lat + b.lat) / 2 * Math.PI / 180) || 1);
    // 進行方向を平面近似（km単位）で表し、その左向きの単位ベクトルへ膨らみを乗せる
    var dyKm = dLat / latPerKm, dxKm = dLng / lngPerKm;
    var lenKm = Math.sqrt(dxKm * dxKm + dyKm * dyKm) || 1;
    var perpXKm = -dyKm / lenKm, perpYKm = dxKm / lenKm;
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var f = i / n;
      var bulge = Math.sin(Math.PI * f) * offsetKm;
      pts.push([
        a.lat + dLat * f + perpYKm * bulge * latPerKm,
        a.lng + dLng * f + perpXKm * bulge * lngPerKm
      ]);
    }
    return pts;
  }

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
    // 前後の地点から遠く離れたピン（違う場所のピンが残っている）は、地図上の点にしない。
    // 吹き出し（キャプション・写真）はそのまま出す＝「出来事」として扱う（isFarMapOutlier、2026-09-29）。
    var locatedIdx = [];
    s.forEach(function (st, i) { if (st.located) locatedIdx.push(i); });
    for (var oi = 1; oi < locatedIdx.length - 1; oi++) {
      var pI = locatedIdx[oi - 1], cI = locatedIdx[oi], nI = locatedIdx[oi + 1];
      if (isFarMapOutlier(s[pI], s[cI], s[nI])) {
        s[cI].located = false; s[cI].lat = null; s[cI].lng = null; s[cI].outlier = true;
      }
    }
    // 時刻の無い到着で、replayStopsの時点（座標がまだ分からない）ではmoveMinutes・後の予定という
    // 手がかりが無かった（estimateSource==='default'）ものを、座標が分かった今、飛行機で着いた先
    // （transport==='plane'、または移動手段が無く距離がREPLAY_PLANE_KM超）なら、飛行機の所要時間
    // （距離÷850km/h＋離着陸などの余裕60分、5分単位）で見積もり直す。日付は保存されている値のまま
    // 変えず、その日の0:00〜23:59に収め、前後の地点をまたがない範囲に収める（2026-09-29）
    var lastLocatedIdx = -1;
    s.forEach(function (st, i) {
      if (st.estimated && st.estimateSource === 'default' && st.located && lastLocatedIdx >= 0) {
        var prevSt = s[lastLocatedIdx];
        var km = distanceKm(prevSt, st);
        var isPlane = st.transport === 'plane' || (!st.transport && km > REPLAY_PLANE_KM);
        if (isPlane) {
          var flightMin = Math.round((km / REPLAY_FLIGHT_KMH * 60 + REPLAY_FLIGHT_BUFFER_MIN) / 5) * 5;
          var offsetHere = typeof st.offset === 'number' ? st.offset : baseOffset;
          var absArrival = prevSt.t + flightMin;
          var nextSt = s[i + 1];
          if (nextSt && absArrival > nextSt.t) absArrival = nextSt.t;
          var localMinute = Math.max(0, Math.min(23 * 60 + 59, Math.round(absArrival - st.dayIndex * 1440 + offsetHere - baseOffset)));
          st.minute = localMinute;
          st.t = st.dayIndex * 1440 + localMinute - (offsetHere - baseOffset);
        }
      }
      if (st.located) lastLocatedIdx = i;
    });
    // 日付変更線（経度180度）をまたいだら、そのあとの地点の経度を±360度して前の地点から続ける。
    // 香港→ニューヨークのように太平洋を越える飛行機は、弧を太平洋回りで引くので終わりが経度+286度になる。
    // ニューヨーク（-74度）をそのままにすると、そこから先は地図の「別の周回」に描かれ、カメラがニューヨークへ
    // 動くと、東京→香港→ニューヨークまでの足跡が見えなくなっていた（2026-09-27）
    var prevLng = null;
    s.forEach(function (st) {
      if (!st.located) return;
      if (prevLng !== null) {
        while (st.lng - prevLng > 180) st.lng -= 360;
        while (st.lng - prevLng < -180) st.lng += 360;
      }
      prevLng = st.lng;
    });

    var legs = [], lastLoc = -1;
    // 場所が変わったら移動にする。移動手段が入っていなければ車とみなす（ほとんどの移動は車、という声より。
    // 以前は移動手段が入っている区間だけを移動にしていたので、入れていないと青い道のりが出なかった）。
    // ただし遠い移動（REPLAY_PLANE_KM超、東京→沖縄など）は、車の道が無い・現実的でないので飛行機とみなす。
    // ごく近い移動（REPLAY_WALK_KM未満、大聖堂から近くの階段など）は徒歩とみなす（2026-09-26）。
    // 前の地点からREPLAY_STAY_KM未満しか離れていなければ、移動にはせず「同じ場所にとどまっている」とみなす
    // （空港の乗り継ぎ記録や、同じ場所を指す予定が続くときに座標がわずかにずれて登録されていても、実際には
    // 動いていないのでゼロ・極小距離の移動を作らない。そこにカメラが小さく寄せ直され、揺れて見えていた。
    // 前は座標が完全に一致するときだけ移動にしなかったが、近いだけで一致しない場合も同じ扱いにする。
    // 2026-09-29、docs/adr/0008）
    s.forEach(function (st, i) {
      if (!st.located) return;
      if (lastLoc >= 0) {
        var d = distanceKm(s[lastLoc], st);
        if (d >= REPLAY_STAY_KM) {
          var transport = st.transport || (d > REPLAY_PLANE_KM ? 'plane' : (d < REPLAY_WALK_KM ? 'walk' : 'car'));
          var leg = { from: lastLoc, to: i, transport: transport, assumed: !st.transport, moveSec: legMoveSeconds(d) };
          // 道のり（Worker「/route」）が届く・見つかるのを待たず、区間に入った瞬間から必ず線でつながるよう、
          // アイコンと同じ道のり（飛行機は弧、それ以外はやわらかい曲線）をここで先に作っておく。実際の道のりが
          // 届いたらこのpathを差し替える（fetchReplayRoutes）。「旅は全部必ずつなげてほしい」という声より
          // （2026-09-27、docs/adr/0008）。
          leg.path = transport === 'plane' ? planeArcPath(s[lastLoc], st) : gentleCurvePath(s[lastLoc], st);
          legs.push(leg);
        }
      }
      lastLoc = i;
    });
    // 移動の予定の移動手段は「次の移動」に付く（replayStopsのpendingTransport）。そのため「LAX→ラスベガス行きの
    // 飛行機」の予定にラスベガス空港の地図が入っていると、飛行機が空港→フラミンゴ（約5km）の区間に付き、
    // 街を一直線に飛び越えて見えていた（2026-09-27）。とても近い区間（REPLAY_PLANE_MIN_KM未満）の飛行機は
    // ありえないので、直前の区間が遠くて移動手段が決め打ち（assumed）なら飛行機をそちらへ移し、近い区間は
    // 車（ごく近ければ徒歩）として道のりをたどる。
    legs.forEach(function (l, k) {
      var d = distanceKm(s[l.from], s[l.to]);
      if (l.transport !== 'plane' || d >= REPLAY_PLANE_MIN_KM) return;
      var prev = legs[k - 1];
      if (prev && prev.to === l.from && prev.assumed && distanceKm(s[prev.from], s[prev.to]) >= REPLAY_PLANE_MIN_KM) {
        prev.transport = 'plane';
        prev.assumed = false;
        prev.path = planeArcPath(s[prev.from], s[prev.to]);
      }
      l.transport = d < REPLAY_WALK_KM ? 'walk' : 'car';
      l.assumed = true;
      l.path = gentleCurvePath(s[l.from], s[l.to]);
    });
    // 飛行機の移動は、距離によらずREPLAY_PLANE_MOVE_SEC。長い飛行機が4秒＋カメラの動き・着いたあとの一呼吸で
    // 5秒ほどかかり、長いという声より、全体で3秒ほどになるよう縮めた（2026-09-27）
    legs.forEach(function (l) { if (l.transport === 'plane') l.moveSec = Math.min(l.moveSec, REPLAY_PLANE_MOVE_SEC); });
    var legArrivingAt = {};
    legs.forEach(function (l) { legArrivingAt[l.to] = l; });

    var kf = [], r = 0;
    var tStart = Math.max(s[0].t - REPLAY_LEAD_MIN, s[0].dayIndex * 1440);
    kf.push({ t: tStart, r: 0 });
    r += (s[0].t - tStart) * REPLAY_SEC_PER_MIN;
    s.forEach(function (st, i) {
      st.r = r; // 乗り物が着いた瞬間（まだ吹き出しは出さない。次のREPLAY_ARRIVAL_PAUSE_SECの後に出す）
      kf.push({ t: st.t, r: r });
      var next = s[i + 1];
      // 最後の予定は、深夜でも時計が翌日（存在しない日）にはみ出さないよう、その日の23:59までにとどめる
      var gap = next ? Math.max(0, next.t - st.t) : Math.max(0, Math.min(REPLAY_DWELL_MIN, (st.dayIndex + 1) * 1440 - 1 - st.t));
      var moving = !!(next && legArrivingAt[i + 1]);
      // 移動の到着地点（travel.arriveLat/arriveLngから作った仮の地点、st.arrival）は、地図上の点・区間の
      // 到着先としては使うが、吹き出し（エピソード・写真）も到着の一時停止も出さず、乗り物がそのまま
      // 通り過ぎるだけにする（オーナーの指示。到着の時刻・時差の見積もり自体はreplayStopsのまま変えない。
      // 2026-09-29）
      if (st.arrival) {
        st.rCaptionStart = r;
        st.rDwellEnd = r;
        if (!next) return;
        r += moving ? legArrivingAt[i + 1].moveSec : Math.min(gap * REPLAY_SEC_PER_MIN, REPLAY_IDLE_CAP_SEC);
        return;
      }
      var dwell = moving ? Math.min(gap / 2, REPLAY_DWELL_MIN) : Math.min(gap, REPLAY_DWELL_MIN);
      // 着いてすぐではなく、カメラが収まるのを少し待ってから吹き出し（写真・エピソード）を出す（2026-09-27）
      // 区間で着いた地点は、カメラが着いた地点へ寄せ直して落ち着く（REPLAY_ARRIVAL_SETTLE_SEC）まで待つ
      r += legArrivingAt[i] ? REPLAY_ARRIVAL_SETTLE_SEC : REPLAY_ARRIVAL_PAUSE_SEC;
      st.rCaptionStart = r;
      var photoCount = Math.min((st.photos || []).length, REPLAY_MAX_PHOTOS);
      // 写真が無ければ固定3秒、写真があれば1枚2.5秒（最大4枚＝10秒）。文章の長さでは変えない（2026-09-27）
      // 写真1枚でも、写真が無いときと同じ3秒は見せる（2.5秒では短いという声より。2026-09-27）
      var minSec = photoCount > 0
        ? Math.max(REPLAY_MIN_CAPTION_SEC, Math.min(photoCount * REPLAY_SEC_PER_PHOTO, REPLAY_MAX_CAPTION_SEC))
        : REPLAY_MIN_CAPTION_SEC;
      // 吹き出しを見せている間（一時停止＋滞在）は、時計をこの予定の時刻のまま止める。以前はこの間も
      // 旅の時計が数分進んで見えていた（例：13:00の予定なのに13:08と表示）。吹き出しが消えたら、
      // 旅の時計をdwell分だけ一気に進めてから続きに移る（2026-09-27）。
      var captionSec = Math.max(dwell * REPLAY_SEC_PER_MIN, minSec);
      // 次へ移動するときは、カメラが動き出す少し前（REPLAY_CAPTION_HIDE_LEAD_SEC）に吹き出しを消すので、
      // その分を足して、見えている時間がminSecより短くならないようにする（58で消すのを早めたら、写真1枚・
      // エピソードだけの地点が1〜2秒で消えていた。2026-09-27）
      if (moving) captionSec += REPLAY_CAPTION_HIDE_LEAD_SEC;
      r += captionSec;
      kf.push({ t: st.t, r: r });
      // 吹き出しが消えた直後に、旅の時計をdwell分だけ一気に進める。同じrに2つの時刻（止まっていたst.tと、
      // 進んだst.t+dwell）を置くと、ちょうどそのrを指したときにどちらを返すか決まらない（最後の予定など、
      // このrで再生が止まるとき）ため、ごくわずかな実時間（見た目には分からない）だけ後ろにずらす
      r += REPLAY_JUMP_EPS;
      kf.push({ t: st.t + dwell, r: r });
      st.rDwellEnd = r;
      if (!next) return;
      var rest = gap - dwell;
      r += moving
        ? legArrivingAt[i + 1].moveSec
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
  // 移動手段ごとに、どのルート検索を使うか。電車・新幹線・地下鉄は線路のルート（BRouterのrailプロファイル、
  // 2026-09-27〜）、飛行機は弧（''＝ルート検索しない）。
  // ---- 日本の電車の道のり：OpenStreetMapの線路データから自分で最短経路を求める（2026-09-27） ----
  // BRouter（線路の検索サーバー）は新大阪→USJのように新幹線の線路へ吸い寄せられて大回りし、Googleの
  // 乗り換え案内は日本の電車の経路をAPIで返さない。そこで、2地点の周りの線路（Overpass APIで取る）を
  // 自分でつなぎ、線路の上の最短経路（ダイクストラ法）を求める。どの路線に乗ったかは分からないが、
  // 線路の上を通る最短の線になる。データが大きくなりすぎないよう、直線距離が短い区間だけで使う。
  var RAIL_LOCAL_MAX_KM = 30;      // これより遠い区間（新幹線など）は使わない
  var RAIL_LOCAL_SNAP_KM = 1.2;    // 出発地・到着地から、この範囲の線路の点を乗り降りの候補にする
  var RAIL_LOCAL_MAX_DETOUR = 3;   // 直線距離の3倍を超える経路は使わない（BRouterのガードと同じ）

  function isInJapan(p) {
    return !!p && p.lat >= 24 && p.lat <= 46 && p.lng >= 122.5 && p.lng <= 154;
  }

  // 線路を取る範囲（南,西,北,東）。直線距離の3割（最低2km）だけ周りに広げる
  function railBBox(a, b) {
    var padKm = Math.max(2, distanceKm(a, b) * 0.3);
    var dLat = padKm / 111, dLng = padKm / (111 * Math.cos((a.lat + b.lat) / 2 * Math.PI / 180));
    return [Math.min(a.lat, b.lat) - dLat, Math.min(a.lng, b.lng) - dLng, Math.max(a.lat, b.lat) + dLat, Math.max(a.lng, b.lng) + dLng]
      .map(function (v) { return Math.round(v * 1e5) / 1e5; });
  }

  function railOverpassQuery(bbox) {
    return '[out:json][timeout:25];way["railway"~"^(rail|subway|light_rail|narrow_gauge|monorail)$"]' +
      '["service"!~"^(yard|siding|spur)$"](' + bbox.join(',') + ');(._;>;);out skel qt;';
  }

  // Overpassの結果（elements：way と node）から、線路の点どうしのつながり（隣の点と距離km）を作る
  function railGraph(elements) {
    var nodes = {}, adj = {};
    (elements || []).forEach(function (e) { if (e.type === 'node') nodes[e.id] = { lat: e.lat, lng: e.lon }; });
    (elements || []).forEach(function (e) {
      if (e.type !== 'way' || !Array.isArray(e.nodes)) return;
      for (var i = 1; i < e.nodes.length; i++) {
        var u = e.nodes[i - 1], v = e.nodes[i];
        if (!nodes[u] || !nodes[v]) continue;
        var d = distanceKm(nodes[u], nodes[v]);
        (adj[u] = adj[u] || []).push([v, d]);
        (adj[v] = adj[v] || []).push([u, d]);
      }
    });
    return { nodes: nodes, adj: adj };
  }

  // 出発地・到着地からRAIL_LOCAL_SNAP_KM以内の線路の点を全部、乗り降りの候補にする（多始点のダイクストラ）。
  // 近い線路が新幹線（在来線とつながっていない）でも、少し先の在来線の点から乗れるので大回りしない。
  // 返すのは [[緯度,経度], ...]（出発地と到着地を両端に足したもの）か、見つからなければnull。
  function shortestRailPath(graph, a, b) {
    var ids = Object.keys(graph.adj);
    if (!ids.length) return null;
    var dist = {}, prev = {}, goal = {};
    var heap = [];
    function push(id, d) {
      heap.push([d, id]);
      var i = heap.length - 1;
      while (i > 0) { var p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; var t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p; }
    }
    function pop() {
      var top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        var i = 0;
        for (;;) {
          var l = 2 * i + 1, r = l + 1, m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          var t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m;
        }
      }
      return top;
    }
    ids.forEach(function (id) {
      var n = graph.nodes[id];
      var ds = distanceKm(a, n), dg = distanceKm(n, b);
      if (ds <= RAIL_LOCAL_SNAP_KM) { dist[id] = ds; prev[id] = null; push(id, ds); }
      if (dg <= RAIL_LOCAL_SNAP_KM) goal[id] = dg;
    });
    var best = null, bestCost = Infinity;
    while (heap.length) {
      var cur = pop(), d = cur[0], u = cur[1];
      if (d > dist[u] || d >= bestCost) continue;
      if (goal[u] !== undefined && d + goal[u] < bestCost) { bestCost = d + goal[u]; best = u; }
      (graph.adj[u] || []).forEach(function (e) {
        var nd = d + e[1];
        if (dist[e[0]] === undefined || nd < dist[e[0]]) { dist[e[0]] = nd; prev[e[0]] = u; push(String(e[0]), nd); }
      });
    }
    if (best === null) return null;
    var path = [], at = best;
    while (at !== null && at !== undefined) { var n = graph.nodes[at]; path.push([n.lat, n.lng]); at = prev[at]; }
    path.reverse();
    return { path: [[a.lat, a.lng]].concat(path, [[b.lat, b.lng]]), km: bestCost };
  }

  // Overpassの結果から道のりを求める（ガードつき）。使えなければnull
  function railPathFromOverpass(elements, a, b) {
    var straight = distanceKm(a, b);
    if (!(straight > 0) || straight > RAIL_LOCAL_MAX_KM) return null;
    var r = shortestRailPath(railGraph(elements), a, b);
    if (!r || r.km > straight * RAIL_LOCAL_MAX_DETOUR) return null;
    return r.path;
  }

  // 道のり（OSRM・Google・線路）は、出発地・到着地のいちばん近い道路や線路から始まり・終わる。山の上
  // （コルコバードの丘）や広い敷地の中の地点だと、道路の端がピンから離れていて、青い線がピンから始まらず
  // 「最初の部分が見えない」ように見えていた（2026-09-27）。道のりの両端がピンから離れていれば、ピンとの
  // 間を線でつなぐ（アイコンもピンから動き出す）。
  var PATH_JOIN_MIN_KM = 0.02;
  // 経度を-180〜180度に戻す
  function wrapLng(lng) {
    var x = ((lng + 180) % 360 + 360) % 360 - 180;
    return x === -180 && lng > 0 ? 180 : x;
  }
  // 線路の道のり（BRouter）の端が、出発地・到着地から離れすぎていないか。山の上の登山電車
  // （ゴルナーグラート鉄道など）で、到着地の近くの線路に乗れず、下の町の駅まで行ってから到着地へ
  // 直線で戻る線になっていた（スイス旅3日目、2026-09-27）。離れていてよいのは、直線距離の2割か
  // 0.5kmの大きい方まで（最大RAIL_LOCAL_SNAP_KM）
  function railPathEndsOk(path, a, b) {
    if (!Array.isArray(path) || path.length < 2 || !a || !b) return false;
    var allow = Math.min(RAIL_LOCAL_SNAP_KM, Math.max(0.5, distanceKm(a, b) * 0.2));
    var first = { lat: path[0][0], lng: path[0][1] }, last = { lat: path[path.length - 1][0], lng: path[path.length - 1][1] };
    return distanceKm(a, first) <= allow && distanceKm(last, b) <= allow;
  }
  function joinPathEnds(path, a, b) {
    if (!Array.isArray(path) || path.length < 2 || !a || !b) return path;
    var out = path.slice();
    var first = { lat: out[0][0], lng: out[0][1] }, last = { lat: out[out.length - 1][0], lng: out[out.length - 1][1] };
    if (distanceKm(a, first) > PATH_JOIN_MIN_KM) out.unshift([a.lat, a.lng]);
    if (distanceKm(last, b) > PATH_JOIN_MIN_KM) out.push([b.lat, b.lng]);
    return out;
  }

  function routeProfileFor(transport) {
    if (transport === 'car' || transport === 'taxi' || transport === 'bus') return 'car';
    if (transport === 'walk') return 'foot';
    if (transport === 'bicycle') return 'bike';
    if (transport === 'train' || transport === 'shinkansen' || transport === 'subway') return 'rail';
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
  // 移動の到着地点（st.arrival）は、飛行機の所要時間からの見積もりで日付が実際の並びより
  // 先に進むことがあり（例：出発日のうちの移動なのに翌日扱いになる）、これを基準にすると
  // 「その日いちばん最初の予定」が本当の1件目より早い、まだ前日の予定の合間の位置になって
  // しまう（例：2日目のボタンが、実際には1日目の飛行機の到着直後を指してしまう）。
  // 日の境目は、実際にその日の記録として残っている地点（通過点の到着ではないもの）だけで
  // 決める（2026-09-29）。
  var REPLAY_JUMP_LEAD_SEC = 0.4;
  function replayDayStarts(tl) {
    if (tl && tl._dayStartsCache) return tl._dayStartsCache;
    var out = [];
    (tl.stops || []).forEach(function (s) {
      if (s.arrival) return;
      if (out.length && out[out.length - 1].dayNumber === s.dayNumber) return;
      if (out.some(function (d) { return d.dayNumber === s.dayNumber; })) return;
      out.push({ dayNumber: s.dayNumber, date: s.date, r: Math.max(0, s.r - REPLAY_JUMP_LEAD_SEC) });
    });
    if (out.length) out[0].r = 0; // 1日目は最初から
    if (tl) tl._dayStartsCache = out;
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

  // 次の移動が、REPLAY_CAPTION_HIDE_LEAD_SEC以内に始まるか（＝吹き出し・写真を消しはじめる時刻か）。
  // 乗り物がいる間（区間の途中）は対象外
  function replayAboutToMove(tl, r) {
    for (var i = 0; i < tl.legs.length; i++) {
      var until = tl.legs[i].r0 - r;
      if (until > 0 && until <= REPLAY_CAPTION_HIDE_LEAD_SEC) return true;
      if (until > REPLAY_CAPTION_HIDE_LEAD_SEC) return false;
    }
    return false;
  }

  // 吹き出し・写真カードを「いま見せてよいか」（2026-09-30、オーナーの指示：乗り物が着いて、カメラが
  // 落ち着いてから出し、出発の前に消す）。st＝replayStateAt(tl, r)、flags＝画面側の状態
  //   flags.cameraMoving：カメラがアニメーション中／flags.aboutToMove：replayAboutToMove
  // 乗り物が区間を走っている間（st.icon）は、出発地・到着地どちらの吹き出しも出さない。
  function replayCaptionVisible(st, flags) {
    flags = flags || {};
    if (!st || st.captionIndex < 0) return false;
    if (st.icon) return false;
    if (flags.cameraMoving || flags.aboutToMove) return false;
    return true;
  }

  function replayStateAt(tl, r) {
    r = Math.max(0, Math.min(r, tl.totalReal));
    var t = replayRealToTrip(tl.keyframes, r);
    var s = tl.stops;
    var idx = -1;
    for (var i = 0; i < s.length; i++) { if (s[i].r <= r + 1e-9) idx = i; }
    // 吹き出しは、着いた瞬間（idxになった瞬間）ではなく、少し間を置いた rCaptionStart から出す（2026-09-27）。
    // 移動の到着地点（st.arrival）は吹き出しを出さず通り過ぎるだけなので対象にしない（2026-09-29）
    var captionIndex = idx >= 0 && !s[idx].arrival && r >= s[idx].rCaptionStart - 1e-9 && r <= s[idx].rDwellEnd + 1e-9 ? idx : -1;

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
    // 「何日目」は予定の日付（今いる予定＝最後に着いた予定。移動中は出発した予定）に合わせる。
    // 時計から数えると、香港16:20発→ニューヨーク19:05着（どちらも1日目の予定）の飛行中に香港の時計が
    // 0時を越え、「2日目」と出ていた（2026-09-27）。時計（hhmm）は現地時間のまま
    var dayNumber = cur && cur.dayNumber ? cur.dayNumber : localDay + 1;
    // ただし上のcur（最後に「着いた」予定）だけで決めると、日ボタンで日の最初の予定の少し手前
    // （REPLAY_JUMP_LEAD_SEC）へシークした直後は、まだその予定に着いていないので前日のまま
    // 表示されてしまう（例：2日目のボタンを押しても、着地の判定的にはまだ1日目という結果になる）。
    // 日の境目（replayDayStarts。到着の仮地点を除いた実際の予定を基準にした、日ごとの開始位置）を
    // 今のrと直接比べて、シーク先そのものが指す日を優先する（2026-09-29）
    var dayBounds = replayDayStarts(tl);
    for (var bi = 0; bi < dayBounds.length; bi++) {
      if (dayBounds[bi].r <= r + 1e-9) dayNumber = dayBounds[bi].dayNumber; else break;
    }
    return {
      t: t, dayNumber: dayNumber, hhmm: minuteToHHMM(localT - localDay * 1440),
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
    if (category === 'transport' || category === 'arrival') return '';
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
    // ★の横に評価の言葉を添える（以前は最後に「→ 〇〇」の行と、冒頭に評価の基準のまとまりを出していて、
    // 見た目がくどかった）
    var lines = [k.emoji + ' ' + k.label + ' ⭐' + (Math.round(rating.score * 10) / 10).toFixed(1) + '（' + reviewLevelLabel(kind, rating.score) + '）', block.label || '（名前なし）'];
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
        .map(function (it) {
          return it.label + ' ' + (it.currency && it.currency !== 'JPY'
            ? costCurrencySymbol(it.currency) + it.amount.toFixed(2) + '（' + yen(costItemJpy(it)) + '）'
            : yen(it.amount));
        });
      if (menu.length) lines.push('メニュー：' + menu.join('／'));
      if (entry.waitTime) lines.push('待ち時間：' + entry.waitTime);
    }
    if (r.other) lines.push('その他：' + r.other);
    appendEntryExtras(lines, entry);
    return lines.join('\n');
  }

  // 紹介文に、記録の「ひとこと」とURL（地図・お店のHP・その他）を添える（入っているものだけ）
  function appendEntryExtras(lines, entry) {
    if (entry.comment) lines.push('ひとこと：「' + entry.comment + '」');
    if (entry.mapUrl) lines.push('📍 ' + entry.mapUrl);
    if (entry.shopUrl) lines.push('🔗 ' + entry.shopUrl);
    if (entry.otherUrl) lines.push('🔗 ' + entry.otherUrl);
  }

  // 移動の記録の文章（★なし）。区間も会社も時刻も金額も無ければ''。
  function travelLogText(block, entry, arrOffset) {
    var t = entry.travel || {};
    var mode = transportLabel(block.transport);
    var amount = typeof t.amount === 'number' ? t.amount : entryCostTotal(entry);
    var route = t.from || t.to ? (t.from || '') + '→' + (t.to || '') : '';
    if (!route && !t.company && !t.depart && !t.arrive && !amount && !block.moveMinutes) return '';
    var emoji = { plane: '✈️', car: '🚗', taxi: '🚕', train: '🚃', shinkansen: '🚅', bus: '🚌', walk: '🚶', bicycle: '🚲' }[block.transport] || '🚃';
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
    appendEntryExtras(lines, entry);
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

  // ---------- 行ったことある旅先（国内・海外の地図。docs/adr/0017） ----------
  // 国名の表記ゆれのまとめ方は worker/src/visited-places.js の COUNTRY_ALIASES と同じ内容を
  // ここに複製している（サーバー側は/mylogが返す時点ですでに正規化済みの日本語名を使っているが、
  // 世界地図側は「ISO数値コード→Intl.DisplayNamesの生の国名」を同じ正規化にかけてから突き合わせる
  // 必要があるため。2つの配列がずれると国が塗られなくなるので、直すときは両方を直す）。
  var VISITED_COUNTRY_ALIASES = [
    ["日本", "日本国", "Japan", "にほん", "にっぽん"],
    ["アメリカ", "アメリカ合衆国", "米国", "アメリカ合衆国（米国）", "United States", "United States of America", "USA", "U.S.A.", "US", "U.S.", "Estados Unidos"],
    ["中国", "中華人民共和国", "China", "People's Republic of China", "中国大陸", "中国本土"],
    ["台湾", "中華民国", "中華民國", "臺灣", "Taiwan"],
    ["香港", "中華人民共和国香港特別行政区", "香港特別行政区", "Hong Kong"],
    ["マカオ", "中華人民共和国マカオ特別行政区", "マカオ特別行政区", "澳門", "Macao", "Macau"],
    ["韓国", "大韓民国", "South Korea", "Korea", "Republic of Korea", "한국", "대한민국"],
    ["北朝鮮", "朝鮮民主主義人民共和国", "North Korea"],
    ["イギリス", "英国", "グレートブリテン及び北アイルランド連合王国", "連合王国", "United Kingdom", "UK", "Great Britain"],
    ["ロシア", "ロシア連邦", "Russia"],
    ["ドイツ", "ドイツ連邦共和国", "Germany", "Deutschland"],
    ["フランス", "フランス共和国", "France"],
    ["イタリア", "イタリア共和国", "Italy", "Italia"],
    ["スペイン", "スペイン王国", "Spain", "España"],
    ["ポルトガル", "ポルトガル共和国", "Portugal"],
    ["オランダ", "オランダ王国", "Netherlands", "Nederland"],
    ["ベルギー", "ベルギー王国", "Belgium", "Belgique", "België"],
    ["スイス", "スイス連邦", "Switzerland", "Schweiz", "Suisse", "Svizzera"],
    ["オーストリア", "オーストリア共和国", "Austria"],
    ["ブラジル", "ブラジル連邦共和国", "Brazil", "Brasil"],
    ["アルゼンチン", "アルゼンチン共和国", "Argentina"],
    ["メキシコ", "メキシコ合衆国", "Mexico", "México"],
    ["カナダ", "Canada"],
    ["ペルー", "ペルー共和国", "Peru", "Perú"],
    ["チリ", "チリ共和国", "Chile"],
    ["オーストラリア", "オーストラリア連邦", "Australia"],
    ["ニュージーランド", "New Zealand"],
    ["タイ", "タイ王国", "Thailand", "ประเทศไทย"],
    ["ベトナム", "ベトナム社会主義共和国", "Vietnam", "Viet Nam", "Việt Nam"],
    ["フィリピン", "フィリピン共和国", "Philippines"],
    ["インドネシア", "インドネシア共和国", "Indonesia"],
    ["マレーシア", "Malaysia"],
    ["シンガポール", "シンガポール共和国", "Singapore"],
    ["インド", "インド共和国", "India"],
    ["エチオピア", "エチオピア連邦民主共和国", "Ethiopia"],
    ["アラブ首長国連邦", "UAE", "United Arab Emirates"],
    ["トルコ", "トルコ共和国", "Türkiye", "Turkey"],
    ["エジプト", "エジプト・アラブ共和国", "Egypt"],
    ["カタール", "カタール国", "Qatar"]
  ];
  var VISITED_KEEP_AS_IS = { "ドミニカ共和国": 1, "ドミニカ国": 1, "コンゴ共和国": 1, "コンゴ民主共和国": 1, "中央アフリカ共和国": 1 };
  var VISITED_FORMAL_SUFFIX_RE = /(連邦民主共和国|社会主義共和国|連邦共和国|人民共和国|共和国|合衆国|王国|連邦)$/;
  var VISITED_ALIAS_MAP = (function () {
    var m = {};
    VISITED_COUNTRY_ALIASES.forEach(function (names) {
      names.forEach(function (n) { m[String(n).normalize('NFKC').trim().toLowerCase()] = names[0]; });
    });
    return m;
  })();

  // Intl.DisplayNames('ja', {type:'region'}).of(alpha2) の返り値は実行環境（iOS Safari・古いICU等）
  // によって揺れることがあり、VISITED_COUNTRY_ALIASESに無い言い方（例：中国が「中国本土」など）だと
  // 一覧には出るのに地図が塗られず国旗も出ない、という壊れ方をする（2026-09-29〜、中国で発覚）。
  // 表記ゆれを追いかけるより、エンジン間で特に揺れやすい国だけalpha2から直接決め打ちにする方が確実。
  var VISITED_ALPHA2_NAME_FALLBACK = {
    CN: '中国', KR: '韓国', KP: '北朝鮮', TW: '台湾', US: 'アメリカ', GB: 'イギリス',
    RU: 'ロシア', VN: 'ベトナム', LA: 'ラオス', CZ: 'チェコ', NL: 'オランダ', AE: 'アラブ首長国連邦'
  };

  // ISO数値コード側の国名（Intl.DisplayNamesの生の出力や、世界地図データの国名）を、
  // /mylogが返す日本語の正規化済み国名（例：「アメリカ合衆国」→「アメリカ」）に揃える。
  function canonicalVisitedCountryName(name) {
    var raw = String(name || '').normalize('NFKC').trim();
    if (!raw) return '';
    var hit = VISITED_ALIAS_MAP[raw.toLowerCase()];
    if (hit) return hit;
    if (VISITED_KEEP_AS_IS[raw]) return raw;
    var short = raw.replace(VISITED_FORMAL_SUFFIX_RE, '');
    if (short && short !== raw && short.length >= 2) return VISITED_ALIAS_MAP[short.toLowerCase()] || short;
    return raw;
  }

  // 世界地図（TopoJSON、idはISO 3166-1 numeric）の各国を、/mylogの国名と突き合わせるための対応表を作る。
  // ids: トポロジーの各featureのid（数値コードの文字列）の配列
  // alpha2Table: vendor/geo/iso-numeric-alpha2.json の中身（{ "392": "JP", ... }）
  // 戻り値: { idToName: {id: 正規化した日本語国名}, nameToId: {正規化した日本語国名: id} }
  // Intl.DisplayNamesが無い環境（古いWebViewなど）では空の対応表を返し、世界地図は塗らずに一覧だけ出す。
  function buildCountryIsoIndex(ids, alpha2Table) {
    var idToName = {}, nameToId = {};
    if (typeof Intl === 'undefined' || !Intl.DisplayNames) return { idToName: idToName, nameToId: nameToId };
    var dn;
    try { dn = new Intl.DisplayNames(['ja'], { type: 'region' }); } catch (e) { return { idToName: idToName, nameToId: nameToId }; }
    (ids || []).forEach(function (id) {
      var a2 = alpha2Table && alpha2Table[id];
      if (!a2) return;
      var name = VISITED_ALPHA2_NAME_FALLBACK[String(a2).toUpperCase()];
      if (!name) {
        var raw;
        try { raw = dn.of(a2); } catch (e) { return; }
        if (!raw) return;
        name = canonicalVisitedCountryName(raw);
      }
      idToName[id] = name;
      if (!nameToId[name]) nameToId[name] = id; // 同じ国名に複数idが来ることは無い想定。最初のものを使う
    });
    return { idToName: idToName, nameToId: nameToId };
  }

  // 都道府県 → 8地方区分（北海道／東北／関東／中部／近畿／中国／四国／九州・沖縄）。
  // 一覧を地方ごとに見出しを付けて出すために使う（docs/adr/0017）。
  var VISITED_PREFECTURE_REGIONS = {
    '北海道': ['北海道'],
    '東北': ['青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県'],
    '関東': ['茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県'],
    '中部': ['新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県'],
    '近畿': ['三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県'],
    '中国': ['鳥取県', '島根県', '岡山県', '広島県', '山口県'],
    '四国': ['徳島県', '香川県', '愛媛県', '高知県'],
    '九州・沖縄': ['福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県']
  };
  var VISITED_REGION_ORDER = ['北海道', '東北', '関東', '中部', '近畿', '中国', '四国', '九州・沖縄'];
  var VISITED_PREFECTURE_TO_REGION = (function () {
    var m = {};
    VISITED_REGION_ORDER.forEach(function (region) {
      VISITED_PREFECTURE_REGIONS[region].forEach(function (pref) { m[pref] = region; });
    });
    return m;
  })();
  function regionForPrefecture(name) {
    return VISITED_PREFECTURE_TO_REGION[name] || null;
  }

  // ISO 3166-1 alpha-2 → 6大陸（アジア／ヨーロッパ／北米／南米／アフリカ／オセアニア）。
  // world-atlas（vendor/geo/countries-110m.json）に含まれる国・地域をひととおりカバーする、
  // このリポジトリ内だけの小さな対応表（外部ライブラリは使わない）。
  // 大陸をまたぐ国は一般的な区分に合わせた（例：ロシア＝ヨーロッパ、トルコ＝アジア、
  // エジプト＝アフリカ、ジョージア／アルメニア／アゼルバイジャン＝アジア）。
  var VISITED_CONTINENT_BY_ALPHA2 = {
    AD: 'ヨーロッパ', AE: 'アジア', AF: 'アジア', AG: '北米', AI: '北米', AL: 'ヨーロッパ',
    AM: 'アジア', AO: 'アフリカ', AQ: 'オセアニア', AR: '南米', AS: 'オセアニア', AT: 'ヨーロッパ',
    AU: 'オセアニア', AW: '北米', AX: 'ヨーロッパ', AZ: 'アジア', BA: 'ヨーロッパ', BB: '北米',
    BD: 'アジア', BE: 'ヨーロッパ', BF: 'アフリカ', BG: 'ヨーロッパ', BH: 'アジア', BI: 'アフリカ',
    BJ: 'アフリカ', BL: '北米', BM: '北米', BN: 'アジア', BO: '南米', BQ: '北米',
    BR: '南米', BS: '北米', BT: 'アジア', BV: 'アフリカ', BW: 'アフリカ', BY: 'ヨーロッパ',
    BZ: '北米', CA: '北米', CC: 'オセアニア', CD: 'アフリカ', CF: 'アフリカ', CG: 'アフリカ',
    CH: 'ヨーロッパ', CI: 'アフリカ', CK: 'オセアニア', CL: '南米', CM: 'アフリカ', CN: 'アジア',
    CO: '南米', CR: '北米', CU: '北米', CV: 'アフリカ', CW: '北米', CX: 'オセアニア',
    CY: 'ヨーロッパ', CZ: 'ヨーロッパ', DE: 'ヨーロッパ', DJ: 'アフリカ', DK: 'ヨーロッパ', DM: '北米',
    DO: '北米', DZ: 'アフリカ', EC: '南米', EE: 'ヨーロッパ', EG: 'アフリカ', EH: 'アフリカ',
    ER: 'アフリカ', ES: 'ヨーロッパ', ET: 'アフリカ', FI: 'ヨーロッパ', FJ: 'オセアニア', FK: '南米',
    FM: 'オセアニア', FO: 'ヨーロッパ', FR: 'ヨーロッパ', GA: 'アフリカ', GB: 'ヨーロッパ', GD: '北米',
    GE: 'アジア', GF: '南米', GG: 'ヨーロッパ', GH: 'アフリカ', GI: 'ヨーロッパ', GL: '北米',
    GM: 'アフリカ', GN: 'アフリカ', GP: '北米', GQ: 'アフリカ', GR: 'ヨーロッパ', GS: '南米',
    GT: '北米', GU: 'オセアニア', GW: 'アフリカ', GY: '南米', HK: 'アジア', HM: 'オセアニア',
    HN: '北米', HR: 'ヨーロッパ', HT: '北米', HU: 'ヨーロッパ', ID: 'アジア', IE: 'ヨーロッパ',
    IL: 'アジア', IM: 'ヨーロッパ', IN: 'アジア', IO: 'アジア', IQ: 'アジア', IR: 'アジア', IS: 'ヨーロッパ',
    IT: 'ヨーロッパ', JE: 'ヨーロッパ', JM: '北米', JO: 'アジア', JP: 'アジア', KE: 'アフリカ',
    KG: 'アジア', KH: 'アジア', KI: 'オセアニア', KM: 'アフリカ', KN: '北米', KP: 'アジア',
    KR: 'アジア', KW: 'アジア', KY: '北米', KZ: 'アジア', LA: 'アジア', LB: 'アジア', LC: '北米',
    LI: 'ヨーロッパ', LK: 'アジア', LR: 'アフリカ', LS: 'アフリカ', LT: 'ヨーロッパ', LU: 'ヨーロッパ',
    LV: 'ヨーロッパ', LY: 'アフリカ', MA: 'アフリカ', MC: 'ヨーロッパ', MD: 'ヨーロッパ', ME: 'ヨーロッパ',
    MF: '北米', MG: 'アフリカ', MH: 'オセアニア', MK: 'ヨーロッパ', ML: 'アフリカ', MM: 'アジア',
    MN: 'アジア', MO: 'アジア', MP: 'オセアニア', MQ: '北米', MR: 'アフリカ', MS: '北米',
    MT: 'ヨーロッパ', MU: 'アフリカ', MV: 'アジア', MW: 'アフリカ', MX: '北米', MY: 'アジア',
    MZ: 'アフリカ', NA: 'アフリカ', NC: 'オセアニア', NE: 'アフリカ', NF: 'オセアニア', NG: 'アフリカ',
    NI: '北米', NL: 'ヨーロッパ', NO: 'ヨーロッパ', NP: 'アジア', NR: 'オセアニア', NU: 'オセアニア',
    NZ: 'オセアニア', OM: 'アジア', PA: '北米', PE: '南米', PF: 'オセアニア', PG: 'オセアニア',
    PH: 'アジア', PK: 'アジア', PL: 'ヨーロッパ', PM: '北米', PN: 'オセアニア', PR: '北米',
    PS: 'アジア', PT: 'ヨーロッパ', PW: 'オセアニア', PY: '南米', QA: 'アジア', RE: 'アフリカ',
    RO: 'ヨーロッパ', RS: 'ヨーロッパ', RU: 'ヨーロッパ', RW: 'アフリカ', SA: 'アジア', SB: 'オセアニア',
    SC: 'アフリカ', SD: 'アフリカ', SE: 'ヨーロッパ', SG: 'アジア', SH: 'アフリカ', SI: 'ヨーロッパ',
    SJ: 'ヨーロッパ', SK: 'ヨーロッパ', SL: 'アフリカ', SM: 'ヨーロッパ', SN: 'アフリカ', SO: 'アフリカ',
    SR: '南米', SS: 'アフリカ', ST: 'アフリカ', SV: '北米', SX: '北米', SY: 'アジア',
    SZ: 'アフリカ', TC: '北米', TD: 'アフリカ', TF: 'アフリカ', TG: 'アフリカ', TH: 'アジア',
    TJ: 'アジア', TK: 'オセアニア', TL: 'アジア', TM: 'アジア', TN: 'アフリカ', TO: 'オセアニア',
    TR: 'アジア', TT: '北米', TV: 'オセアニア', TW: 'アジア', TZ: 'アフリカ', UA: 'ヨーロッパ',
    UG: 'アフリカ', UM: 'オセアニア', US: '北米', UY: '南米', UZ: 'アジア', VA: 'ヨーロッパ',
    VC: '北米', VE: '南米', VG: '北米', VI: '北米', VN: 'アジア', VU: 'オセアニア',
    WF: 'オセアニア', WS: 'オセアニア', XK: 'ヨーロッパ', YE: 'アジア', YT: 'アフリカ', ZA: 'アフリカ',
    ZM: 'アフリカ', ZW: 'アフリカ'
  };
  var VISITED_CONTINENT_ORDER = ['アジア', 'ヨーロッパ', '北米', '南米', 'アフリカ', 'オセアニア'];
  function continentForAlpha2(alpha2) {
    return VISITED_CONTINENT_BY_ALPHA2[String(alpha2 || '').toUpperCase()] || null;
  }

  // world-atlas（countries-110m.json）に図形が無い（＝idx.nameToIdに出てこない）ため、地図データからは
  // alpha2が引けない国名。香港・マカオはそれぞれ「中国」の図形に含まれてしまい、単独の図形を持たない
  // （2026-09-28〜、visited-places.jsのcanonicalCountryが中国と分けて数えるようになった分）。
  // これが無いとcontinentForAlpha2が引けず「その他」に落ちてしまうので、一覧では「アジア」・国旗🇭🇰🇲🇴で
  // 出せるよう、名前→alpha2を決め打ちで足す（drawVisitedWorldMapのvisitedCountryAlpha2ByNameに合流）。
  var EXTRA_COUNTRY_ALPHA2_BY_NAME = { '香港': 'HK', 'マカオ': 'MO' };

  // alpha-2コード（例："JP"）→ 国旗絵文字（例："🇯🇵"）。画像は使わず、Unicodeの
  // 地域表示記号（Regional Indicator Symbol、A=U+1F1E6）を2文字組み合わせて作る。
  function flagEmojiForAlpha2(alpha2) {
    var code = String(alpha2 || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) return '';
    var base = 0x1F1E6;
    var a = 'A'.charCodeAt(0);
    return String.fromCodePoint(base + (code.charCodeAt(0) - a)) + String.fromCodePoint(base + (code.charCodeAt(1) - a));
  }

  // 「count / total」を四捨五入した整数パーセントにする（totalが0以下なら0%）。
  function visitedPercentage(count, total) {
    if (!total || total <= 0) return 0;
    return Math.round((count / total) * 100);
  }

  // items を keyFn(item) の結果ごとに、order の並び順でグループ化する。
  // order に無いキー（null・未知の値も含む）は最後に「その他」としてまとめる（中身が無ければ出さない）。
  // 都道府県の地方分け・国の大陸分けの両方で使う汎用のヘルパー。
  function groupVisitedByOrder(items, keyFn, order) {
    var buckets = {};
    order.forEach(function (key) { buckets[key] = []; });
    var others = [];
    (items || []).forEach(function (item) {
      var key = keyFn(item);
      if (key && buckets[key]) buckets[key].push(item);
      else others.push(item);
    });
    var out = order.filter(function (key) { return buckets[key].length; }).map(function (key) {
      return { group: key, items: buckets[key] };
    });
    if (others.length) out.push({ group: 'その他', items: others });
    return out;
  }

  // 「行ったことある旅先」の一覧に出す、1つの場所（都道府県／国）の旅行一覧。
  // /mylogのdetails.prefectures・countriesの各要素（sources: [{tripId, tripTitle, dates, transit, excluded}]）
  // から、実際に数えている（乗り継ぎでも外してもいない）旅行だけを、出てくる順に重複なく拾う。
  // tripId（旅行を開くのに使う）・dates由来の年（表示用）も一緒に返す。
  function visitedPlaceTrips(item) {
    var out = [], seen = {};
    ((item && item.sources) || []).forEach(function (s) {
      if (s.transit || s.excluded) return;
      var id = s.tripId || '';
      if (seen[id]) return;
      seen[id] = 1;
      out.push({ tripId: id, tripTitle: s.tripTitle || '（無題の旅）', years: visitedYearsFromDates(s.dates) });
    });
    return out;
  }

  // sources[].datesの"YYYY-MM-DD"の並びから、年だけを重複なく出てくる順に拾う（無ければ空配列＝
  // 表示側で年を省く。旧データなど日付が無い場合を想定）。
  function visitedYearsFromDates(dates) {
    var out = [], seen = {};
    (dates || []).forEach(function (d) {
      var y = String(d || '').slice(0, 4);
      if (!/^\d{4}$/.test(y) || seen[y]) return;
      seen[y] = 1;
      out.push(y);
    });
    return out;
  }

  // 「旅行名（2026）」「旅行名（2026・2027）」「旅行名」（年が分からないときは省く）
  function visitedTripLabel(trip) {
    var years = trip.years && trip.years.length ? '（' + trip.years.join('・') + '）' : '';
    return trip.tripTitle + years;
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
  // opts.legend：trueなら、最後に評価の目安を注釈として付ける（既定は付けない）
  function buildTripPostText(trip, blocks, days, email, opts) {
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
    if (opts && opts.legend && usedKinds.length) {
      parts.push('※⭐の目安\n' + usedKinds.map(function (kind) {
        var k = REVIEW_KINDS[kind];
        return k.label + '　4.5〜' + k.levels[0] + '／4.0〜' + k.levels[1] + '／3.5〜' + k.levels[2] + '／3.0〜' + k.levels[3];
      }).join('\n'));
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

  // ---------- 自分のAIで整理（JSON貼り付け）（docs/adr/0015） ----------
  // 「音声・メモでまとめて記録する」の3つ目の入り口。ユーザーが自分のAI（ChatGPT・Claude・
  // Geminiなど）にbuildAiImportPromptの文面＋自分のメモを渡し、返ってきたJSONをここで
  // 読み取る。サーバー側の有料AI（voiceBlocksSchema/multiDayBlocksSchema、
  // worker/src/index.js）と同じBlockの形（date・time・label・category・transport・
  // entry{episode,mapUrl,shopUrl,costItems}）を受け付け、/trips/:id/memo-blocksという
  // 既存のAIなし取り込みエンドポイントにそのまま渡せるようにする（新しいエンドポイントは作らない）。
  var IMPORT_MAX_BLOCKS = 100; // worker側のMEMO_MAX_BLOCKSと合わせる
  var IMPORT_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  // AIの答えは「```json ... ```で囲む」「前後に説明文を付ける」など、指示してもよく起きる。
  // 文字列の中の { } は数えないよう、クォート・エスケープを見ながら最初に見つかった
  // { または [ に対応する閉じカッコまでを取り出す（一番外側のJSON本体だけを拾う）。
  function extractOutermostJson(text) {
    var s = String(text || '')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'");
    var fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
    if (fence) s = fence[1];
    var startObj = s.indexOf('{'), startArr = s.indexOf('[');
    var start = -1, openCh = '', closeCh = '';
    if (startObj === -1 && startArr === -1) return null;
    if (startArr === -1 || (startObj !== -1 && startObj < startArr)) { start = startObj; openCh = '{'; closeCh = '}'; }
    else { start = startArr; openCh = '['; closeCh = ']'; }
    var depth = 0, inStr = false, esc = false, end = -1;
    for (var i = start; i < s.length; i++) {
      var c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === openCh) depth++;
      else if (c === closeCh) { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) return null;
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
  }

  // trip: {startDate, endDate}。複数日の旅行はBlockごとにdateが旅行期間内であることを必須にし、
  // 1日（または日程未設定）の旅行はdateを省略できる（そのときは選択中の日をそのまま使う）。
  // 戻り値のblocksは、そのまま/trips/:id/memo-blocksに渡せる形。warningsは取り込みはしたが
  // 補正した項目、errorsは取り込めずに省いた項目（件数分の理由つき）。
  function parseImportedBlocksJson(text, trip) {
    var payload = extractOutermostJson(text);
    if (payload === null || payload === undefined) {
      return { blocks: [], warnings: [], errors: ['JSONを読み取れませんでした。AIの答え全体をそのまま貼り付けてください。'] };
    }
    var rawBlocks = Array.isArray(payload) ? payload
      : (payload && typeof payload === 'object' && Array.isArray(payload.blocks)) ? payload.blocks : null;
    if (!rawBlocks) return { blocks: [], warnings: [], errors: ['blocksの配列が見つかりませんでした。'] };
    if (!rawBlocks.length) return { blocks: [], warnings: [], errors: ['予定が1件も見つかりませんでした。'] };
    if (rawBlocks.length > IMPORT_MAX_BLOCKS) {
      return { blocks: [], warnings: [], errors: ['予定が多すぎます（' + IMPORT_MAX_BLOCKS + '件まで）。日を分けて取り込んでください。'] };
    }

    var tripDates = allDatesForTrip(trip, []).filter(function (d) { return d; });
    var multiDay = tripDates.length > 1;
    var defaultDate = (trip && trip.selectedDate) || tripDates[0] || '';
    var blocks = [], warnings = [], errors = [];

    rawBlocks.forEach(function (raw, i) {
      var n = i + 1;
      if (!raw || typeof raw !== 'object') { errors.push(n + '件目：形が正しくありません（オブジェクトではありません）。'); return; }
      var label = typeof raw.label === 'string' ? raw.label.trim().slice(0, 200) : '';
      if (!label) { errors.push(n + '件目：labelがありません。'); return; }

      var date = defaultDate;
      if (multiDay) {
        var d = typeof raw.date === 'string' ? raw.date.trim() : '';
        if (!d || tripDates.indexOf(d) === -1) {
          errors.push(n + '件目「' + label + '」：dateが旅行期間内にありません（' + (d || '(空)') + '）。');
          return;
        }
        date = d;
      } else if (typeof raw.date === 'string' && raw.date && tripDates.indexOf(raw.date) !== -1) {
        date = raw.date;
      }

      var category = CATEGORIES.some(function (c) { return c.key === raw.category; }) ? raw.category : '';
      if (!category) {
        warnings.push(n + '件目「' + label + '」：categoryが不明のため「その他」にしました。');
        category = 'other';
      }

      var transport = '';
      if (typeof raw.transport === 'string' && raw.transport) {
        if (TRANSPORTS.some(function (t) { return t.key === raw.transport; })) transport = raw.transport;
        else warnings.push(n + '件目「' + label + '」：transportが不明のため空にしました。');
      }

      var time = '';
      if (typeof raw.time === 'string' && raw.time && IMPORT_TIME_RE.test(raw.time)) time = raw.time;
      else if (raw.time) warnings.push(n + '件目「' + label + '」：timeの形式が正しくないため空にしました。');

      var entryData = (raw.entry && typeof raw.entry === 'object') ? raw.entry : {};
      var episode = typeof entryData.episode === 'string' ? entryData.episode.trim().slice(0, 4000) : '';
      var mapUrl = typeof entryData.mapUrl === 'string' ? entryData.mapUrl.trim().slice(0, 500) : '';
      var shopUrl = typeof entryData.shopUrl === 'string' ? entryData.shopUrl.trim().slice(0, 500) : '';

      var costItems = [];
      if (Array.isArray(entryData.costItems)) {
        entryData.costItems.forEach(function (ci, ci_i) {
          if (!ci || typeof ci !== 'object') return;
          var ciLabel = typeof ci.label === 'string' ? ci.label.trim().slice(0, 60) : '';
          var amount = ci.amount;
          if (!ciLabel || typeof amount !== 'number' || !isFinite(amount) || amount < 0) {
            warnings.push(n + '件目「' + label + '」：費用の内訳' + (ci_i + 1) + '件目を読み取れなかったので省きました。');
            return;
          }
          var item = { label: ciLabel, amount: amount };
          if (typeof ci.currency === 'string' && ci.currency.trim() && ci.currency.trim().toUpperCase() !== 'JPY') {
            if (/^[A-Za-z]{3}$/.test(ci.currency.trim())) {
              item.currency = ci.currency.trim().toUpperCase();
              item.amount = Math.round(amount * 100) / 100;
            } else {
              warnings.push(n + '件目「' + label + '」：通貨コードが不明のため円として扱いました。');
              item.amount = Math.round(amount);
            }
          } else {
            item.amount = Math.round(amount);
          }
          costItems.push(item);
        });
      }

      blocks.push({
        date: date, time: time, label: label, category: category, transport: transport,
        entry: { episode: episode, mapUrl: mapUrl, shopUrl: shopUrl, costItems: costItems }
      });
    });

    return { blocks: blocks, warnings: warnings, errors: errors };
  }

  // 「AIへのお願い文をコピー」で使う文面。サーバー側のvoicePrompt/multiDayPrompt
  // （worker/src/index.js）と同じ制約をユーザーの手元のAIに伝え、返ってきたJSONを
  // parseImportedBlocksJsonでそのまま読めるようにする。
  function buildAiImportPrompt(trip) {
    var tripDates = allDatesForTrip(trip, []).filter(function (d) { return d; });
    var multiDay = tripDates.length > 1;
    var rangeText = (trip && trip.startDate)
      ? (trip.startDate + (trip.endDate && trip.endDate !== trip.startDate ? '〜' + trip.endDate : ''))
      : '（未設定）';
    var categoryList = CATEGORIES.map(function (c) { return c.key + '（' + c.label + '）'; }).join(' / ');
    var transportList = TRANSPORTS.filter(function (t) { return t.key; }).map(function (t) { return t.key + '（' + t.label + '）'; }).join(' / ');
    var example = { blocks: [ Object.assign(
      multiDay ? { date: tripDates[0] || 'YYYY-MM-DD' } : {},
      {
        time: '10:00',
        label: '東京駅',
        category: 'transport',
        transport: 'shinkansen',
        entry: {
          episode: '新幹線で移動した',
          mapUrl: '',
          shopUrl: '',
          costItems: [ { label: '新幹線代', amount: 14000 }, { label: 'お土産', amount: 12.5, currency: 'USD' } ]
        }
      }
    ) ] };
    var lines = [
      'あなたは旅行記録アプリ「旅の足跡」のアシスタントです。下に貼る旅のメモを読んで、予定（Block）とその記録（Entry）の配列に分けてください。',
      '',
      'この旅行の日程：' + rangeText,
      multiDay
        ? ('複数日の旅行です。各予定のdateには、その出来事があった日をYYYY-MM-DD形式で必ず入れてください（' + tripDates.join('、') + 'のいずれか）。')
        : '1日（または日程未設定）の旅行なので、dateは省略してかまいません。',
      '',
      '出力はJSONのみにしてください。前置きや説明・コードブロック（```）は付けず、次の形だけを出してください（あくまで形の例です。内容はメモに合わせて考えてください）：',
      '',
      JSON.stringify(example, null, 2),
      '',
      'ルール：',
      '- categoryは次のいずれか一つだけ：' + categoryList,
      '- transportは移動手段がはっきり分かるときだけ次のいずれかを入れ、分からなければ空文字（""）にする：' + transportList,
      '- timeは24時間表記の"HH:MM"（例："09:30"）。はっきりしなければ空文字（""）にする（推測で作らない）',
      '- entry.costItemsは、具体的な金額が書かれているものだけ配列で入れる（無ければ空配列[]）。amountは円の整数（小数点なし）。海外通貨で書かれているときだけcurrency（ISO 4217、例："USD"）を付け、amountはその通貨での金額（例：12.5）にする',
      '- entry.episodeには、メモの内容をもとにした説明を書く（メモに書かれていないことを推測で付け足さない）',
      '- labelは短い見出し（体言止め）にする',
      '- 書かれた順番のとおりに配列を並べる',
      '',
      '旅のメモ：',
      '（ここに旅のメモを貼ってください）'
    ];
    return lines.join('\n');
  }

  // Blockの並べ替え（ドラッグ、initBlockDragReorder）で使う純粋関数。
  // 指の位置（ドラッグ中のBlockの中心Y座標）と、他のBlockの元の中心Y座標だけから
  // 「今どの順番に挿入されるか」を計算する。DOM操作を含まないのでnodeからも直接テストできる。
  function blockDragTargetIndex(draggedCenterY, otherCenters) {
    var count = 0;
    for (var i = 0; i < otherCenters.length; i++) {
      if (otherCenters[i] < draggedCenterY) count++;
    }
    return count;
  }

  // 上のblockDragTargetIndexで決まった挿入位置（targetIndex）にもとづき、他のBlockそれぞれを
  // どれだけずらす（translateY）べきかを配列で返す。gapIndexはドラッグ中のBlockが元々あった
  // 位置（othersの中でのすき間の位置）。
  function blockDragShifts(otherCount, targetIndex, gapIndex, draggedHeight) {
    var shifts = [];
    for (var i = 0; i < otherCount; i++) {
      if (targetIndex < gapIndex && i >= targetIndex && i < gapIndex) shifts.push(draggedHeight);
      else if (targetIndex > gapIndex && i >= gapIndex && i < targetIndex) shifts.push(-draggedHeight);
      else shifts.push(0);
    }
    return shifts;
  }

  // ---------- 動画でシェア（地図でふりかえるを、約15秒の縦動画にする。docs/adr/0020） ----------
  // 地図のタイル（OpenStreetMap）はDOMの<img>の集まりで録画できないので、動画は自前のcanvasに
  // 「タイル・線・ピン・字」を描いて作る。この節は、その描画に必要な「計算」だけを担う純粋関数
  // （Leaflet・DOM・canvasに依存しない）。描く処理・録画・共有は画面側（app.jsの後半）にある。
  // 何を・いつ出すかは、地図でふりかえるの時間割（buildReplayTimeline）から作る（replayと二重に持たない）。
  var VIDEO_W = 720, VIDEO_H = 1280, VIDEO_FPS = 30;
  var VIDEO_INTRO_SEC = 1.5;   // 旅行名と日付
  var VIDEO_ROUTE_SEC = 11.5;  // 旅の長さによらず、道のりの動画はこの秒数に収める
  var VIDEO_OUTRO_SEC = 2;     // アプリ名・URL
  var VIDEO_HEAD_SEC = 0.3;    // 道のりの最初のピンが立つまで
  var VIDEO_TAIL_SEC = 0.7;    // 最後のピンのあと、全体に引くまで
  var VIDEO_MAX_CAPTIONS = 7;  // 地名を出す数の上限（1つ1秒ほど見せたいので、11.5秒の半分ほどで7つ）
  var VIDEO_MIN_ZOOM = 2, VIDEO_MAX_ZOOM = 13; // 13より寄るとタイルが増えるので寄らない（OSMのタイルを取りすぎない）
  // 地図の「見せたい範囲」の余白（px）。上はSNSの表示に隠れやすく、下は吹き出しのカードが載る
  var VIDEO_PAD = { top: 230, right: 80, bottom: 420, left: 80 };
  var VIDEO_CAMERA_GROUP_SEC = 0.5; // これより短い区間はまとめて1つの見え方にする（カメラが細かく揺れないように）
  var VIDEO_PATH_MAX_POINTS = 300;  // 1区間の線の点の数の上限（毎コマ描くので間引く）

  // 緯度経度→ウェブメルカトルの「世界座標」（x, yとも0〜1。経度が±180を越えても連続）
  function mercatorWorld(lat, lng) {
    var s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180);
    return { x: (lng + 180) / 360, y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) };
  }
  function mercatorLatLng(x, y) {
    var n = Math.PI * (1 - 2 * y);
    return { lat: Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) * 180 / Math.PI, lng: x * 360 - 180 };
  }
  // ズームzoomでの、世界座標1.0あたりのピクセル数（タイル1枚は256px）
  function videoWorldScale(zoom) { return 256 * Math.pow(2, zoom); }

  function videoClamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function videoEase(u) { u = videoClamp(u, 0, 1); return u * u * (3 - 2 * u); }

  // 点（[lat, lng]の並び）がすべて画面の余白の内側に収まる、いちばん寄った見え方（世界座標の中心x,y・ズーム）。
  // 余白（pad）が上下左右で違うので、点の中心を「余白を除いた領域」の真ん中に置く
  function videoFitView(points, w, h, pad, minZoom, maxZoom) {
    pad = pad || { top: 0, right: 0, bottom: 0, left: 0 };
    if (!points || !points.length) return { x: 0.5, y: 0.5, zoom: minZoom };
    var minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    points.forEach(function (p) {
      var m = mercatorWorld(p[0], p[1]);
      if (m.x < minx) minx = m.x;
      if (m.x > maxx) maxx = m.x;
      if (m.y < miny) miny = m.y;
      if (m.y > maxy) maxy = m.y;
    });
    var availW = Math.max(1, w - pad.left - pad.right), availH = Math.max(1, h - pad.top - pad.bottom);
    var need = Math.max((maxx - minx) / availW, (maxy - miny) / availH); // 1pxあたりの世界座標の幅
    var zoom = need > 1e-12 ? Math.log(1 / (need * 256)) / Math.LN2 : maxZoom;
    zoom = videoClamp(zoom, minZoom, maxZoom);
    var scale = videoWorldScale(zoom);
    return {
      x: (minx + maxx) / 2 - ((pad.left - pad.right) / 2) / scale,
      y: (miny + maxy) / 2 - ((pad.top - pad.bottom) / 2) / scale,
      zoom: zoom
    };
  }

  // 緯度経度→画面のピクセル（見え方viewで、w×hの画面のとき）
  function videoProject(view, w, h, lat, lng) {
    var m = mercatorWorld(lat, lng), s = videoWorldScale(view.zoom);
    return { x: w / 2 + (m.x - view.x) * s, y: h / 2 + (m.y - view.y) * s };
  }

  // 見え方に必要なタイル。ズームは四捨五入した整数zで、小数ぶんはsize（タイル1枚の画面上の大きさ）で吸収する。
  // x, yは実際のタイル番号（経度は一周で折り返す）、px, pyは画面上の左上
  function videoViewTiles(view, w, h) {
    var z = videoClamp(Math.round(view.zoom), 0, 19);
    var n = Math.pow(2, z), size = 256 * Math.pow(2, view.zoom - z);
    var cx = view.x * n, cy = view.y * n;
    var tx0 = Math.floor(cx - (w / 2) / size), tx1 = Math.floor(cx + (w / 2) / size);
    var ty0 = Math.floor(cy - (h / 2) / size), ty1 = Math.floor(cy + (h / 2) / size);
    var list = [];
    for (var ty = ty0; ty <= ty1; ty++) {
      if (ty < 0 || ty >= n) continue;
      for (var tx = tx0; tx <= tx1; tx++) {
        list.push({ x: ((tx % n) + n) % n, y: ty, px: w / 2 + (tx - cx) * size, py: h / 2 + (ty - cy) * size });
      }
    }
    return { z: z, size: size, list: list };
  }

  // 0〜count-1から、端を含めて均等にmax個を選ぶ（多すぎる地名を間引くのに使う）
  function videoPickEvenly(count, max) {
    var out = [];
    if (count <= 0 || max <= 0) return out;
    if (count <= max) { for (var i = 0; i < count; i++) out.push(i); return out; }
    if (max === 1) return [0];
    for (var k = 0; k < max; k++) {
      var v = Math.round(k * (count - 1) / (max - 1));
      if (out.indexOf(v) === -1) out.push(v);
    }
    return out;
  }

  // 点が多い線を、両端を残して等間隔に間引く
  function videoThinPath(path, max) {
    if (!path || path.length <= max) return path;
    var out = [];
    for (var i = 0; i < max; i++) out.push(path[Math.round(i * (path.length - 1) / (max - 1))]);
    return out;
  }

  // 各地点の「着いてから出るまで」と、次の地点までの移動の時間割（秒）。
  // items: [{ dwell: 止まる秒数（地名を出す地点だけ）, moveWeight: 次の地点までの移動の重さ }]。
  // 止まる秒数の合計は全体の55%まで、残りを移動の重さで分ける。
  function videoSchedule(items, totalSec) {
    var n = items.length, arrive = [], leave = [];
    if (!n) return { arrive: arrive, leave: leave };
    var dw = items.map(function (it) { return Math.max(0, it.dwell || 0); });
    var sum = dw.reduce(function (a, b) { return a + b; }, 0);
    var scale = sum > totalSec * 0.55 ? totalSec * 0.55 / sum : 1;
    var weights = [], wsum = 0;
    for (var i = 0; i < n - 1; i++) { var w = Math.max(0, items[i].moveWeight || 0); weights.push(w); wsum += w; }
    if (wsum <= 0) { weights = weights.map(function () { return 1; }); wsum = weights.length; }
    var moveTotal = Math.max(totalSec * 0.2, totalSec - VIDEO_HEAD_SEC - VIDEO_TAIL_SEC - sum * scale);
    var t = VIDEO_HEAD_SEC;
    for (var k = 0; k < n; k++) {
      arrive.push(t);
      t += dw[k] * scale;
      leave.push(t);
      if (k < n - 1) t += wsum > 0 ? moveTotal * weights[k] / wsum : 0;
    }
    return { arrive: arrive, leave: leave };
  }

  // 「2025-09-11」「2025-09-18」→「2025.9.11〜9.18」。年をまたぐときは年も付ける
  function videoDateRange(start, end) {
    var a = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(start || '');
    if (!a) return '';
    var head = a[1] + '.' + Number(a[2]) + '.' + Number(a[3]);
    var b = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(end || '');
    if (!b || (b[1] === a[1] && Number(b[2]) === Number(a[2]) && Number(b[3]) === Number(a[3]))) return head;
    var tail = (b[1] === a[1] ? '' : b[1] + '.') + Number(b[2]) + '.' + Number(b[3]);
    return head + '〜' + tail;
  }

  // 幅maxWidthに収まるよう、text（旅行名や地名）を最大maxLines行に折り返す。measure(文字列)は描画側が渡す
  // 幅の計測関数。英数字の並びは途中で切らず、日本語は1文字ずつ切れる。入りきらなければ最後の行を「…」で終える
  function videoWrapLines(text, maxWidth, measure, maxLines) {
    var raw = String(text || '').replace(/\s+/g, ' ').trim();
    if (!raw) return [];
    var tokens = [];
    (raw.match(/[A-Za-z0-9'’.,\-]+|\s|[\s\S]/g) || []).forEach(function (tk) {
      if (tk.length > 1 && measure(tk) > maxWidth) tk.split('').forEach(function (c) { tokens.push(c); });
      else tokens.push(tk);
    });
    var lines = [], cur = '', i = 0;
    for (; i < tokens.length; i++) {
      var next = cur + tokens[i];
      if (cur && measure(next.replace(/\s+$/, '')) > maxWidth) {
        if (lines.length === maxLines - 1) break;
        lines.push(cur.replace(/\s+$/, ''));
        cur = tokens[i].replace(/^\s+/, '');
      } else {
        cur = next;
      }
    }
    if (i < tokens.length) {
      // 最後の行に入りきらなかった残りがある
      cur = cur.replace(/\s+$/, '');
      while (cur && measure(cur + '…') > maxWidth) cur = cur.slice(0, -1);
      lines.push(cur + '…');
    } else if (cur) {
      lines.push(cur.replace(/\s+$/, ''));
    }
    return lines;
  }

  // MediaRecorderで作れる形式を、SNSが受け付けやすい順（mp4→webm）に選ぶ。isSupported(mime)は
  // MediaRecorder.isTypeSupported。webmはXやInstagramが受け付けないことがあるので、isMp4で画面が知らせる
  function pickVideoMimeType(isSupported) {
    var list = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (var i = 0; i < list.length; i++) {
      var ok = false;
      try { ok = !!isSupported(list[i]); } catch (e) { ok = false; }
      if (ok) {
        var mp4 = list[i].indexOf('video/mp4') === 0;
        return { mime: list[i], type: mp4 ? 'video/mp4' : 'video/webm', ext: mp4 ? 'mp4' : 'webm', isMp4: mp4 };
      }
    }
    return null;
  }

  function videoFirstImageId(photos) {
    var list = photos || [];
    for (var i = 0; i < list.length; i++) { if (list[i] && !/\.(mp4|mov|m4v|webm)$/i.test(list[i])) return list[i]; }
    return '';
  }

  // 動画に使う地点（地図に点が出る地点。座標が分からない・外れ値の予定は出来事なので入らない）
  function videoLocatedStops(tl) {
    var out = [];
    ((tl && tl.stops) || []).forEach(function (s, i) { if (s.located) out.push(i); });
    return out;
  }

  // 地図でふりかえるの時間割（buildReplayTimelineの結果。道のりは届いたぶんだけ入っている）から、動画の絵コンテを作る。
  // opts: { photos: 記録の写真を入れる, title, dateText, maxZoom }。地点が2つ未満ならnull（動画にできない）。
  // - 地名は、replayが吹き出しを出す地点（到着の仮地点・見出しが空の地点は出さない）だけ。多いときは均等に間引く
  // - 写真あり: 写真のある地点は写真だけの吹き出しでも出す。費用・同行者・作った人・エピソード本文は使わない
  function buildVideoStory(tl, opts) {
    opts = opts || {};
    var idx = videoLocatedStops(tl);
    if (idx.length < 2) return null;
    var stops = tl.stops;
    var maxZoom = Math.min(VIDEO_MAX_ZOOM, typeof opts.maxZoom === 'number' ? opts.maxZoom : VIDEO_MAX_ZOOM);
    var cand = [], lastLabel = null;
    idx.forEach(function (si, k) {
      var s = stops[si];
      if (s.arrival) return;
      var label = String(s.label || '').replace(/\s+/g, ' ').trim();
      var photo = opts.photos ? videoFirstImageId(s.photos) : '';
      if (!label && !photo) return;
      if (label && label === lastLabel && !photo) return; // 同じ地名が続くときは1回だけ
      lastLabel = label || lastLabel;
      cand.push({ k: k, label: label, photo: photo });
    });
    var chosen = videoPickEvenly(cand.length, VIDEO_MAX_CAPTIONS).map(function (i) { return cand[i]; });
    var base = videoClamp(VIDEO_ROUTE_SEC * 0.5 / Math.max(1, chosen.length), 0.9, 1.6);
    var capByK = {};
    chosen.forEach(function (c) { capByK[c.k] = { label: c.label, photo: c.photo, dwell: c.photo ? Math.max(base, 1.4) : base }; });

    var segs = idx.slice(0, -1).map(function (si, k) {
      var a = stops[si], b = stops[idx[k + 1]];
      var leg = null;
      (tl.legs || []).forEach(function (l) { if (l.from === si && l.to === idx[k + 1]) leg = l; });
      var path = leg && leg.path && leg.path.length > 1 ? leg.path : [[a.lat, a.lng], [b.lat, b.lng]];
      var km = distanceKm(a, b);
      return {
        path: videoThinPath(path, VIDEO_PATH_MAX_POINTS), transport: leg ? leg.transport : 'car',
        moveWeight: km < REPLAY_STAY_KM ? 0 : 1 + Math.min(2, Math.log(1 + km) / Math.LN10)
      };
    });
    var sched = videoSchedule(idx.map(function (si, k) {
      return { dwell: capByK[k] ? capByK[k].dwell : 0, moveWeight: k < segs.length ? segs[k].moveWeight : 0 };
    }), VIDEO_ROUTE_SEC);
    var introSec = VIDEO_INTRO_SEC;
    var wps = idx.map(function (si, k) {
      var s = stops[si], cap = capByK[k];
      return {
        stopIndex: si, lat: s.lat, lng: s.lng, dayNumber: s.dayNumber || 1,
        arrive: sched.arrive[k], leave: sched.leave[k],
        caption: cap ? { label: cap.label, photo: cap.photo } : null
      };
    });
    segs.forEach(function (sg, k) { sg.moveStart = wps[k].leave; sg.moveEnd = wps[k + 1].arrive; });

    // カメラ：全体→最初の区間→…と、区間ごとに「その区間と次の区間が入る」見え方へ動く。地点で止まっている
    // あいだは動かさず（保持のキー）、動き出したら次の見え方へ。最後は全体に引く
    var allPoints = [];
    segs.forEach(function (sg) { allPoints = allPoints.concat(sg.path); });
    var overview = videoFitView(allPoints, VIDEO_W, VIDEO_H, VIDEO_PAD, VIDEO_MIN_ZOOM, maxZoom);
    var keys = [{ t: 0, x: overview.x, y: overview.y, zoom: overview.zoom },
      { t: introSec - 0.4, x: overview.x, y: overview.y, zoom: overview.zoom }];
    var k = 0, first = true;
    while (k < segs.length) {
      var j = k;
      while (j + 1 < segs.length && segs[j].moveEnd - segs[k].moveStart < VIDEO_CAMERA_GROUP_SEC) j++;
      var pts = [];
      for (var m = k; m <= Math.min(j + 1, segs.length - 1); m++) pts = pts.concat(segs[m].path);
      var v = videoFitView(pts, VIDEO_W, VIDEO_H, VIDEO_PAD, VIDEO_MIN_ZOOM, maxZoom);
      var span = segs[j].moveEnd - segs[k].moveStart;
      var tIn = first ? wps[0].arrive : segs[k].moveStart + 0.3 * span;
      var tOut = j + 1 < segs.length ? segs[j + 1].moveStart : wps[wps.length - 1].leave;
      keys.push({ t: introSec + tIn, x: v.x, y: v.y, zoom: v.zoom });
      if (tOut > tIn + 1e-6) keys.push({ t: introSec + tOut, x: v.x, y: v.y, zoom: v.zoom });
      first = false;
      k = j + 1;
    }
    keys.push({ t: introSec + VIDEO_ROUTE_SEC - 0.25, x: overview.x, y: overview.y, zoom: overview.zoom });
    var lastT = -1;
    keys.forEach(function (key) { if (key.t <= lastT) key.t = lastT + 1e-4; lastT = key.t; });

    return {
      w: VIDEO_W, h: VIDEO_H, fps: VIDEO_FPS,
      introSec: introSec, routeSec: VIDEO_ROUTE_SEC, outroSec: VIDEO_OUTRO_SEC,
      total: introSec + VIDEO_ROUTE_SEC + VIDEO_OUTRO_SEC,
      title: String(opts.title || '').trim(), dateText: opts.dateText || '',
      wps: wps, segs: segs, cameraKeys: keys, overview: overview,
      maxDay: wps.reduce(function (mx, w) { return Math.max(mx, w.dayNumber); }, 1),
      hasPhotos: chosen.some(function (c) { return !!c.photo; })
    };
  }

  // t秒時点のカメラ（キーの間はなめらかに）
  function videoCameraAt(story, t) {
    var keys = story.cameraKeys;
    if (t <= keys[0].t) return { x: keys[0].x, y: keys[0].y, zoom: keys[0].zoom };
    for (var i = 0; i < keys.length - 1; i++) {
      var a = keys[i], b = keys[i + 1];
      if (t <= b.t) {
        var e = videoEase((t - a.t) / Math.max(1e-9, b.t - a.t));
        return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, zoom: a.zoom + (b.zoom - a.zoom) * e };
      }
    }
    var l = keys[keys.length - 1];
    return { x: l.x, y: l.y, zoom: l.zoom };
  }

  // t秒時点の絵：カメラ、各区間の進み具合、立っているピン、今動いている先頭、何日目、地名の吹き出し、導入・締めの暗幕
  function videoFrameAt(story, t) {
    t = videoClamp(t, 0, story.total);
    var rt = t - story.introSec;
    var routeEnd = story.introSec + story.routeSec;
    var introAlpha = t < story.introSec ? (t > story.introSec - 0.4 ? (story.introSec - t) / 0.4 : 1) : 0;
    var outroAlpha = t > routeEnd ? Math.min(1, (t - routeEnd) / 0.4) : 0;
    var segs = story.segs.map(function (s, k) {
      var f = s.moveEnd > s.moveStart ? videoClamp((rt - s.moveStart) / (s.moveEnd - s.moveStart), 0, 1) : (rt >= s.moveEnd ? 1 : 0);
      return { k: k, f: rt < 0 ? 0 : f };
    });
    var pins = story.wps.map(function (w, k) {
      return { k: k, pop: rt >= w.arrive ? videoClamp((rt - w.arrive) / 0.3, 0, 1) : 0, captioned: !!w.caption };
    });
    var head = null;
    segs.forEach(function (sg) {
      if (head || !(sg.f > 0 && sg.f < 1)) return;
      var s = story.segs[sg.k], p = pathAt(s.path, sg.f).point, q = pathAt(s.path, Math.min(1, sg.f + 0.02)).point;
      head = { lat: p.lat, lng: p.lng, transport: s.transport, bearing: bearingDeg(p, q), seg: sg.k };
    });
    var day = story.wps[0].dayNumber;
    story.wps.forEach(function (w) { if (rt >= w.arrive) day = w.dayNumber; });
    var caption = null;
    story.wps.forEach(function (w, k) {
      if (caption || !w.caption || rt < w.arrive || rt > w.leave) return;
      var a = Math.min(1, (rt - w.arrive) / 0.18, (w.leave - rt) / 0.15);
      if (a > 0) caption = { k: k, label: w.caption.label, photo: w.caption.photo, alpha: videoClamp(a, 0, 1) };
    });
    return {
      phase: t < story.introSec ? 'intro' : (t < routeEnd ? 'route' : 'outro'),
      camera: videoCameraAt(story, t),
      introAlpha: introAlpha, introTextAlpha: Math.min(1, t / 0.25) * (introAlpha > 0 ? 1 : 0),
      outroAlpha: outroAlpha,
      segs: segs, pins: pins, head: head,
      day: day, showDay: story.maxDay > 1 && rt >= 0 && t < routeEnd,
      caption: caption
    };
  }

  // 動画で使う地図のタイル（重複なし）。録画の前に全部取っておく（録画中に足りなくならないように）。
  // 30fpsの全コマで必要な分を数える
  function videoTilesNeeded(story) {
    var seen = {}, out = [];
    var frames = Math.ceil(story.total * story.fps);
    for (var f = 0; f <= frames; f++) {
      var vt = videoViewTiles(videoCameraAt(story, f / story.fps), story.w, story.h);
      vt.list.forEach(function (tile) {
        var key = vt.z + '/' + tile.x + '/' + tile.y;
        if (!seen[key]) { seen[key] = true; out.push({ z: vt.z, x: tile.x, y: tile.y }); }
      });
    }
    return out;
  }

  var Core = {
    CATEGORIES: CATEGORIES,
    blockDragTargetIndex: blockDragTargetIndex,
    blockDragShifts: blockDragShifts,
    TRANSPORTS: TRANSPORTS,
    categoryLabel: categoryLabel,
    categoryColor: categoryColor,
    formatYen: formatYen,
    parseDate: parseDate,
    dateDiffDays: dateDiffDays,
    formatDateJp: formatDateJp,
    addDaysToDate: addDaysToDate,
    tripScheduleShift: tripScheduleShift,
    dayLabel: dayLabel,
    tripNights: tripNights,
    allDatesForTrip: allDatesForTrip,
    sortBlocks: sortBlocks,
    groupBlocksByDate: groupBlocksByDate,
    canUseBranches: canUseBranches,
    blocksInBranchWindow: blocksInBranchWindow,
    visibleBlocksForView: visibleBlocksForView,
    resolveViewAccountId: resolveViewAccountId,
    branchViewOptions: branchViewOptions,
    branchSummary: branchSummary,
    branchCardText: branchCardText,
    dayTimelineItems: dayTimelineItems,
    validateBranch: validateBranch,
    branchErrorText: branchErrorText,
    entryCostTotal: entryCostTotal,
    blockCostTotal: blockCostTotal,
    tripTotalCost: tripTotalCost,
    costItemJpy: costItemJpy,
    costItemHasRate: costItemHasRate,
    formatCostItemAmount: formatCostItemAmount,
    COST_CURRENCIES: COST_CURRENCIES,
    COST_CURRENCY_SYMBOLS: COST_CURRENCY_SYMBOLS,
    tripBalances: tripBalances,
    settlementPlan: settlementPlan,
    roundToUnit: roundToUnit,
    SETTLE_UNITS: SETTLE_UNITS,
    tripExpenseList: tripExpenseList,
    primaryLodgingName: primaryLodgingName,
    lodgingByNight: lodgingByNight,
    costBreakdownByPerson: costBreakdownByPerson,
    parseTags: parseTags,
    getTripIdFromSearch: getTripIdFromSearch,
    buildShareUrl: buildShareUrl,
    upsertTripIndexEntry: upsertTripIndexEntry,
    removeTripIndexEntry: removeTripIndexEntry,
    planHistoryRemoval: planHistoryRemoval,
    filterTrips: filterTrips,
    sortTrips: sortTrips,
    tripFilterOptions: tripFilterOptions,
    ratingSummary: ratingSummary,
    myRatingScore: myRatingScore,
    sortMyLogItems: sortMyLogItems,
    weatherLabel: weatherLabel,
    MANUAL_WEATHER_OPTIONS: MANUAL_WEATHER_OPTIONS,
    manualWeatherDisplay: manualWeatherDisplay,
    replayPlaceQuery: replayPlaceQuery,
    replayPlaceEntry: replayPlaceEntry,
    hasBrokenMapQuery: hasBrokenMapQuery,
    placeMapUrl: placeMapUrl,
    placeSelectionName: placeSelectionName,
    travelArrival: travelArrival,
    replayStops: replayStops,
    buildReplayTimeline: buildReplayTimeline,
    cameraMoveNeeded: cameraMoveNeeded,
    cameraMoveDecision: cameraMoveDecision,
    replayAboutToMove: replayAboutToMove,
    replayCaptionVisible: replayCaptionVisible,
    REPLAY_CAPTION_HIDE_LEAD_SEC: REPLAY_CAPTION_HIDE_LEAD_SEC,
    REPLAY_CAMERA_FLIGHT_SEC: REPLAY_CAMERA_FLIGHT_SEC,
    REPLAY_ARRIVAL_ZOOM_DELAY_SEC: REPLAY_ARRIVAL_ZOOM_DELAY_SEC,
    REPLAY_ARRIVAL_SETTLE_SEC: REPLAY_ARRIVAL_SETTLE_SEC,
    replayStateAt: replayStateAt,
    arcLatLng: arcLatLng,
    routeProfileFor: routeProfileFor,
    joinPathEnds: joinPathEnds,
    railPathEndsOk: railPathEndsOk,
    isInJapan: isInJapan,
    railBBox: railBBox,
    railOverpassQuery: railOverpassQuery,
    railGraph: railGraph,
    shortestRailPath: shortestRailPath,
    railPathFromOverpass: railPathFromOverpass,
    RAIL_LOCAL_MAX_KM: RAIL_LOCAL_MAX_KM,
    distanceKm: distanceKm,
    isFarMapOutlier: isFarMapOutlier,
    findFarMapOutlierBlockIds: findFarMapOutlierBlockIds,
    isRouteDetourTooLong: isRouteDetourTooLong,
    geocodeNearIndexes: geocodeNearIndexes,
    planeArcPath: planeArcPath,
    gentleCurvePath: gentleCurvePath,
    legMoveSeconds: legMoveSeconds,
    parseMemo: parseMemo,
    parseImportedBlocksJson: parseImportedBlocksJson,
    buildAiImportPrompt: buildAiImportPrompt,
    transportLabel: transportLabel,
    minutesText: minutesText,
    replayDayStarts: replayDayStarts,
    replayNeighborStop: replayNeighborStop,
    tzOffsetMinutes: tzOffsetMinutes,
    assignBlockZones: assignBlockZones,
    needsFreshLogin: needsFreshLogin,
    isLoginRequiredError: isLoginRequiredError,
    isPlaneMove: isPlaneMove,
    wrapLng: wrapLng,
    lodgingNightOptions: lodgingNightOptions,
    lodgingGroupBlocks: lodgingGroupBlocks,
    lodgingEditPlan: lodgingEditPlan,
    lodgingNights: lodgingNights,
    lodgingSummary: lodgingSummary,
    dayHasManualOrder: dayHasManualOrder,
    lodgingSummaryParts: lodgingSummaryParts,
    lodgingRangePlan: lodgingRangePlan,
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
    buildTripPostText: buildTripPostText,
    canonicalVisitedCountryName: canonicalVisitedCountryName,
    buildCountryIsoIndex: buildCountryIsoIndex,
    visitedPlaceTrips: visitedPlaceTrips,
    visitedYearsFromDates: visitedYearsFromDates,
    visitedTripLabel: visitedTripLabel,
    VISITED_REGION_ORDER: VISITED_REGION_ORDER,
    VISITED_PREFECTURE_REGIONS: VISITED_PREFECTURE_REGIONS,
    regionForPrefecture: regionForPrefecture,
    VISITED_CONTINENT_ORDER: VISITED_CONTINENT_ORDER,
    continentForAlpha2: continentForAlpha2,
    flagEmojiForAlpha2: flagEmojiForAlpha2,
    EXTRA_COUNTRY_ALPHA2_BY_NAME: EXTRA_COUNTRY_ALPHA2_BY_NAME,
    visitedPercentage: visitedPercentage,
    groupVisitedByOrder: groupVisitedByOrder,
    decideSwipe: decideSwipe,
    VIDEO_W: VIDEO_W, VIDEO_H: VIDEO_H, VIDEO_FPS: VIDEO_FPS, VIDEO_MAX_CAPTIONS: VIDEO_MAX_CAPTIONS, VIDEO_MAX_ZOOM: VIDEO_MAX_ZOOM,
    mercatorWorld: mercatorWorld,
    mercatorLatLng: mercatorLatLng,
    videoWorldScale: videoWorldScale,
    videoEase: videoEase,
    videoFitView: videoFitView,
    videoProject: videoProject,
    videoViewTiles: videoViewTiles,
    videoPickEvenly: videoPickEvenly,
    videoSchedule: videoSchedule,
    videoDateRange: videoDateRange,
    videoWrapLines: videoWrapLines,
    pickVideoMimeType: pickVideoMimeType,
    videoLocatedStops: videoLocatedStops,
    buildVideoStory: buildVideoStory,
    videoCameraAt: videoCameraAt,
    videoFrameAt: videoFrameAt,
    videoTilesNeeded: videoTilesNeeded
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
  var HIDDEN_TRIPS_KEY = 'tabilog:hidden-trips';
  var CURRENT_USER_KEY = 'tabilog:user';
  var MYLOG_FILTERS_KEY = 'tabilog:mylog-filters';

  function $(sel, root2) { return (root2 || document).querySelector(sel); }
  function $all(sel, root2) { return Array.prototype.slice.call((root2 || document).querySelectorAll(sel)); }

  // 通信待ちの間、空欄や「読み込み中…」の文字だけより、それらしい形のカードがぼんやり光っている
  // 方がAirbnbアプリのように「今読み込み中」と伝わりやすいので、シマー（光が流れる）スケルトンを出す
  // （マイログ・「行ったことある旅先」の初回読み込みで使う。2026-09-29〜。prefers-reduced-motionでは
  // CSS側でアニメーションを止め、ただの薄い塗りのまま出す）。
  // 旅行のカードがスクロールでふわっと浮かび上がる演出（Airbnbアプリを手本にした。2026-09-29〜）。
  // カードが画面に入ったタイミングで、下から（opacity 0→1・16px下から0へ）浮かび上がらせる。
  // 一度出現したカードは監視をやめる（IntersectionObserver#unobserve）ので、スクロールを
  // 行き来しても毎回は動かない。最初から画面内にあるカード同士は、同じ判定タイミングで
  // まとめて交差するので、その中でだけ少しずつ（40msずつ）ずらして動かす。
  // prefers-reduced-motion・IntersectionObserver非対応の環境では、演出そのものを付けない
  // （reveal-initクラスを付けないので、CSSのopacity: 0が一切効かず最初から普通に表示される）。
  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function revealCardsOnScroll(cards) {
    if (!cards || !cards.length) return;
    if (prefersReducedMotion() || typeof IntersectionObserver !== 'function') return;
    cards.forEach(function (c) { c.classList.add('reveal-init'); });
    var io = new IntersectionObserver(function (entries) {
      entries.filter(function (e) { return e.isIntersecting; }).forEach(function (entry, i) {
        var el = entry.target;
        setTimeout(function () { el.classList.add('reveal-in'); }, i * 40);
        io.unobserve(el);
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -5% 0px' });
    cards.forEach(function (c) { io.observe(c); });
  }

  // ---------- 旅行カードが丸ごと浮かび上がって詳細画面に広がる演出（Airbnb風のshared-element遷移、2026-09-29〜） ----------
  // FLIP（First・Last・Invert・Play）の考え方：タップされたカードの実際の見た目（写真部分・白い本体部分、
  // それぞれの位置・大きさ・角丸）をそのままコピーした「クローン」を2枚、position:fixedで重ねる。
  // 写真クローンはカードの写真の位置→詳細ヘッダーの大きいカバー写真（ビューポート高の約40%）へ、
  // 白本体クローンはカードの白い部分→写真の下に16px重なる角丸の白いシートへ、それぞれ別々に
  // CSSトランジションさせる（＝カードが「丸ごと」広がって見える。写真だけが薄い帯に縮む見え方の
  // 反省から2026-09-29に作り替えた）。本物の詳細画面は裏側でそのまま読み込み・描画を始める
  // （openTrip自体はアニメーションを待たない）。
  // 遷移中は、抜ける画面（ホーム／マイログの一覧）を「今見えていたとおりの見た目・スクロール位置」の
  // まま画面いっぱいに固定表示し続け、その上にクローン＋暗幕（ぼかし＋暗く）を重ねることで、
  // 「一覧だけがぼやけて暗くなり、カードだけが手前で広がる」というAirbnbアプリ同様の見た目にする
  // （freezeLeavingScreen）。入る画面（旅の詳細）は演出中ずっとopacity:0のまま隠しておき（＝詳細画面が
  // ぼかされて見えることは無い）、クローンが最終位置に達した瞬間だけフェード無しで即座に見せて
  // （revealEnteringScreen）、クローンをその場で消す（ピクセル的に同じ絵の上に本物が現れるだけなので
  // 継ぎ目が出ない）。タイトル・日程・参加者行はその直後に少しずつ間を空けてフェードイン＋浮き上がり
  // させる（playTripDetailStagger）。
  // 「戻る」で同じカードがまだ一覧に残っていれば、逆再生（詳細→カードの位置）してから画面を切り替える
  // （pendingCardOpenAnim、goHome参照）。
  // Web版では見え方が不自然という判断（アプリオーナー確認済み・2026-09-29）で、この演出は
  // iOSアプリ（Capacitor）内でのみ有効にする。Webはブラウザ・端末を問わずe2a3cf2以前と同じ
  // 「即座に画面が切り替わるだけ」の遷移に戻す（暗幕・クローン・画面固定は一切出さない）。ヘッダーの
  // レイアウト自体（大きいカバー写真＋白いシート）はWebでも同じCSSを使う（見た目だけ、動きは無し）。
  // isNativeApp()は都度呼ぶ関数なので、この判定も呼び出しごとに評価する（起動直後のCapacitor
  // 初期化タイミングに依存しないようにするため、値をキャッシュしない）。
  function CARD_EXPAND_ENABLED() {
    return isNativeApp() && !prefersReducedMotion();
  }
  var TRIP_OPEN_ANIM_MS = 450; // style.cssの.trip-open-cloneのtransition時間と揃える
  var TRIP_STAGGER_STEP_MS = 40;
  var TRIP_STAGGER_DUR_MS = 260;
  var pendingCardOpenAnim = null; // { cardEl, tripId } / 直前にカードのアニメーションで開いた旅行だけ覚える

  // 詳細ヘッダーの最終的な見た目（カバー写真・白いシートの位置と大きさ）を、タップした瞬間に
  // 同期で計算する。実際の詳細画面はこの時点ではまだ非表示（display:none）でgetBoundingClientRectが
  // 使えないため、実測はできない。その代わりstyle.cssのカバー写真の高さ計算式（clamp(220px, 40vh, 340px)）
  // と、シートのだいたいの高さ（見出し＋日程＋余白）をこちらでも同じ値で見積もる（誤差は数px程度で、
  // クローン→本物の入れ替わり時に気づかれない前提。将来style.css側の数値を変えたら、ここも合わせる）。
  function computeTripDetailHeaderTarget() {
    var vw = document.documentElement.clientWidth;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var heroH = Math.max(220, Math.min(340, vh * 0.4));
    var sheetOverlap = 16;
    var sheetEstH = 92; // タイトル1行＋日程1行＋シートのpadding程度の見積もり
    return {
      photoRect: { top: 0, left: 0, width: vw, height: heroH },
      sheetRect: { top: heroH - sheetOverlap, left: 0, width: vw, height: sheetEstH }
    };
  }

  // 詳細画面が実際にactiveになった後（＝本物のカバー写真・シートがDOMに描画された後）に、
  // 実測のヘッダー位置を読み取る。これが取れる場面（screenReady後）ではこちらを正として使う。
  function readTripDetailHeaderTarget() {
    var photoEl = $('#tripCoverPhoto');
    var sheetEl = $('.trip-cover-text');
    var hasPhoto = !!(photoEl && !photoEl.hidden);
    return {
      hasPhoto: hasPhoto,
      photoRect: hasPhoto ? photoEl.getBoundingClientRect() : null,
      sheetRect: sheetEl ? sheetEl.getBoundingClientRect() : null
    };
  }

  function setCloneRect(el, rect) {
    el.style.top = rect.top + 'px';
    el.style.left = rect.left + 'px';
    el.style.width = rect.width + 'px';
    el.style.height = rect.height + 'px';
  }

  // カードの現在の見た目（写真の有無・角丸・写真のURL、写真部分と白い本体部分それぞれの矩形）を
  // 読み取る。ホーム画面の大きい写真カード（.trip-card.has-photo）だけ「写真」を持ち、マイログの
  // 小さいサムネイル一覧カードは常に「写真なし」扱い（白いカードが広がるだけの演出になる）。
  function readTripCardVisual(cardEl) {
    var photoEl = cardEl.querySelector('.trip-card-photo');
    var bodyEl = photoEl ? cardEl.querySelector('.trip-card-info') : cardEl;
    var cardRadius = parseFloat(window.getComputedStyle(cardEl).borderRadius) || 0;
    return {
      hasPhoto: !!photoEl,
      photoUrl: photoEl ? photoEl.style.backgroundImage : '',
      photoRect: photoEl ? photoEl.getBoundingClientRect() : null,
      // 写真ありカードの本体（.trip-card-info）は写真の下でカードの下2つの角だけ丸い。
      // 写真なしカード（マイログの小さい一覧・写真のない旅行）はカード自体が本体で4つとも丸い。
      photoRadius: photoEl ? (cardRadius + 'px ' + cardRadius + 'px 0 0') : '',
      bodyRect: bodyEl.getBoundingClientRect(),
      bodyRadius: photoEl ? ('0 0 ' + cardRadius + 'px ' + cardRadius + 'px') : (cardRadius + 'px')
    };
  }

  // 抜ける画面（今アクティブな画面）を、今のスクロール位置のまま画面いっぱいに固定表示し続ける。
  // showScreen()が.activeクラスを付け替えると本来はdisplay:noneになって消えてしまうため、インライン
  // スタイルで強制的にdisplay:blockのposition:fixedへ切り替え、topをマイナスのスクロール量にすることで
  // 「見えていたとおりの位置」のまま静止させる（内容自体は動かない＝アニメーション中に動いて見えない）。
  // 戻す（unfreeze）と、あとはCSS本来の.screen{display:none}に任せて自然に消える。
  function freezeLeavingScreen(screenEl, scrollY) {
    if (!screenEl) return null;
    screenEl.style.display = 'block';
    screenEl.style.position = 'fixed';
    screenEl.style.left = '0';
    screenEl.style.right = '0';
    screenEl.style.top = (-scrollY) + 'px';
    screenEl.style.zIndex = '400'; // 暗幕(490)・クローン(500)より下
    return screenEl;
  }
  function unfreezeScreen(screenEl) {
    if (!screenEl) return;
    screenEl.style.display = '';
    screenEl.style.position = '';
    screenEl.style.left = '';
    screenEl.style.right = '';
    screenEl.style.top = '';
    screenEl.style.zIndex = '';
  }
  // 入る画面（旅の詳細／ホーム）をクローンの下で見えなくしておく。詳細画面がぼかされて見える瞬間を
  // 作らないため、演出が終わるまでは常にopacity:0（フェードでうっすら見せることもしない）。
  function hideEnteringScreen(screenEl) {
    if (!screenEl) return null;
    screenEl.style.transition = 'none';
    screenEl.style.opacity = '0';
    screenEl.style.pointerEvents = 'none';
    if (screenEl.dataset.screen === 'tripDetail') prepareTripDetailStagger(screenEl);
    return screenEl;
  }
  // クローンが最終位置に達した瞬間に、フェード無しで即座に本物を見せる（クローンの最終フレームと
  // ピクセル的に同じ絵の上に本物が現れるだけなので継ぎ目が出ない）。旅の詳細画面ならこの直後に
  // タイトル・日程・参加者行をstaggerでふわっと出す（playTripDetailStagger）。
  function revealEnteringScreen(screenEl) {
    if (!screenEl) return;
    screenEl.style.transition = 'none';
    screenEl.style.opacity = '1';
    screenEl.style.pointerEvents = '';
    void screenEl.offsetWidth; // reflow
    screenEl.style.transition = '';
    if (screenEl.dataset.screen === 'tripDetail') playTripDetailStagger(screenEl);
  }

  // staggerでふわっと出す対象（タイトル→日程→参加者行の順、40msずつ間を空ける）。あらかじめ
  // opacity:0・8px下にずらしておき（prepare）、本物が見えた直後に透明→表示・8px下→0へ動かす（play）。
  function tripDetailStaggerTargets() {
    return [$('#tripTitle'), $('#tripDates'), $('.companions-row')].filter(function (el) { return !!el; });
  }
  function prepareTripDetailStagger() {
    tripDetailStaggerTargets().forEach(function (el) {
      el.style.transition = 'none';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
    });
  }
  function playTripDetailStagger() {
    var targets = tripDetailStaggerTargets();
    targets.forEach(function (el, i) {
      void el.offsetWidth; // reflow：ここまでの初期状態を確定させてから動かす
      var delay = i * TRIP_STAGGER_STEP_MS;
      el.style.transition = 'opacity ' + TRIP_STAGGER_DUR_MS + 'ms ease ' + delay + 'ms, transform ' + TRIP_STAGGER_DUR_MS + 'ms ease ' + delay + 'ms';
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    });
    setTimeout(function () {
      targets.forEach(function (el) {
        el.style.transition = '';
        el.style.opacity = '';
        el.style.transform = '';
      });
    }, targets.length * TRIP_STAGGER_STEP_MS + TRIP_STAGGER_DUR_MS + 60);
  }

  // 白本体クローンの中に、カードのタイトル・日程をそのまま重ねる（本物のタイトルは演出が終わるまで
  // opacity:0のままなので、これが無いとシートがずっと空白の白い板に見えてしまう）。
  function addCloneText(bodyClone, titleText, dateText) {
    var textEl = document.createElement('div');
    textEl.className = 'trip-open-clone-text';
    var titleEl = document.createElement('div');
    titleEl.className = 'trip-title';
    titleEl.textContent = titleText || '';
    var datesEl = document.createElement('div');
    datesEl.className = 'trip-dates';
    datesEl.textContent = dateText || '';
    textEl.appendChild(titleEl);
    textEl.appendChild(datesEl);
    bodyClone.appendChild(textEl);
  }

  // カードをタップした瞬間：カードの位置からアニメーションを始め、実際のopenTrip自体はデータの
  // 読み込みを待たずにそのまま進める（読み込みが遅くても、演出は毎回同じ長さで終わる）。
  function openTripFromCard(cardEl, tripId, returnTo) {
    if (!CARD_EXPAND_ENABLED() || !cardEl || typeof cardEl.getBoundingClientRect !== 'function') {
      pendingCardOpenAnim = null;
      openTrip(tripId, returnTo);
      return;
    }
    var visual = readTripCardVisual(cardEl);
    if (!visual.bodyRect.width || !visual.bodyRect.height) { openTrip(tripId, returnTo); return; }
    var leavingScreen = $('.screen.active');
    var leavingScrollY = window.scrollY;
    var target = computeTripDetailHeaderTarget(); // 実測はまだできないので見積もり
    // 「広がるだけ・縮まない」を保証するため、見積もりがカードの現在の大きさより小さければ
    // カード側の大きさで底上げする（カードの内容が長くて見積もりより大きい、といったケースの保険）。
    // ただしsheetRect（白本体クローンの最終サイズ）は「タイトル・日程のシート」だけであるべきで、
    // 詳細画面の残り全部（写真の下〜画面の下まで）ではない。カードの本体（.trip-card-info等）が
    // シートの見積もりより多少大きくても、ここで底上げするのはあくまでシート1枚分の高さまで
    // （行き過ぎて画面下まで覆う大きさにはならない＝2026-09-29、白い板がでかすぎる不具合の修正）。
    target.photoRect.width = Math.max(target.photoRect.width, visual.photoRect ? visual.photoRect.width : 0);
    target.photoRect.height = Math.max(target.photoRect.height, visual.photoRect ? visual.photoRect.height : 0);
    target.sheetRect.width = Math.max(target.sheetRect.width, visual.bodyRect.width);
    target.sheetRect.height = Math.max(target.sheetRect.height, Math.min(visual.bodyRect.height, target.sheetRect.height * 1.6));

    var backdrop = document.createElement('div');
    backdrop.className = 'trip-open-backdrop';
    // 暗幕の上・クローンの下に重ねる--bg色のベタ塗り。演出の後半でこれを不透明にし、シートの下に
    // 見えている「ぼやけた一覧」を詳細画面と同じ地の色へすり替えておく（trip-open-bg-fade、
    // style.css参照。白本体クローンがシートの高さしか覆わないぶん、その下は最後までこちらが担当）。
    var bgFade = document.createElement('div');
    bgFade.className = 'trip-open-bg-fade';

    // 写真クローン：カードに写真があるときだけ作る（無ければ白本体クローンだけが広がる演出になる）
    var clonePhoto = null;
    if (visual.hasPhoto) {
      clonePhoto = document.createElement('div');
      clonePhoto.className = 'trip-open-clone trip-open-clone-photo';
      setCloneRect(clonePhoto, visual.photoRect);
      clonePhoto.style.borderRadius = visual.photoRadius;
      clonePhoto.style.backgroundImage = visual.photoUrl;
    }
    // 白本体クローン：カードの白い部分（写真ありなら.trip-card-info、無ければカード自体）
    var cloneBody = document.createElement('div');
    cloneBody.className = 'trip-open-clone trip-open-clone-body';
    setCloneRect(cloneBody, visual.bodyRect);
    cloneBody.style.borderRadius = visual.bodyRadius;
    var cardTitleEl = cardEl.querySelector('.trip-card-title');
    var cardDateEl = cardEl.querySelector('.trip-card-date');
    addCloneText(cloneBody, cardTitleEl ? cardTitleEl.textContent : '', cardDateEl ? cardDateEl.textContent : '');

    document.body.appendChild(backdrop);
    document.body.appendChild(bgFade);
    if (clonePhoto) document.body.appendChild(clonePhoto);
    document.body.appendChild(cloneBody);

    // クローンの見た目の動き（カード位置→詳細ヘッダーいっぱい）は、通信の完了を待たずにすぐ始める。
    // 一方、本物の詳細画面への切り替え（showScreen）はopenTrip内部のAPI応答を待つ非同期処理のため、
    // 「見た目のアニメーションが最短450ms経過」と「実際に画面が切り替わった」の両方が揃うまで待ってから、
    // 抜ける画面の固定表示（freeze）を解いて、詳細画面を即座に見せる（minDone/screenReady）。
    var minDone = false, screenReady = false, finished = false, enteringScreen = null;
    function finishIfReady() {
      if (finished || !minDone || !screenReady) return;
      finished = true;
      clearTimeout(safetyTimer);
      // 順番が重要：本物の詳細画面をフェード無しで即座に見せてから、同じフレームで暗幕・
      // ベタ塗り・クローンを消す。暗幕をフェードアウトさせながら後から消すと、消えるまでの
      // 数フレームだけ本物の詳細画面の上に暗幕（ぼかし＋暗く）が乗ったままになり、詳細画面が
      // ぼやけて見える不具合になる（2026-09-29修正）。ここではもう暗幕・クローンは不要な絵
      // （本物と同じ絵の上に重なっていただけ）なので、フェードさせずに即除去してよい。
      unfreezeScreen(leavingScreen);
      revealEnteringScreen(enteringScreen);
      backdrop.remove();
      bgFade.remove();
      if (clonePhoto) clonePhoto.remove();
      cloneBody.remove();
    }
    // 安全策：旅行が見つからない等でopenTripが失敗すると（catch側でalert→goHomeへ）、screenReadyが
    // 一生falseのままになり得るため、一定時間で強制的に後片付けする（暗幕・クローンが残り続けて
    // 操作不能になることを防ぐ）。通常はfinishIfReadyが先に動くのでここまで来ない。
    var safetyTimer = setTimeout(function () {
      if (finished) return;
      finished = true;
      unfreezeScreen(leavingScreen);
      backdrop.remove();
      bgFade.remove();
      if (clonePhoto) clonePhoto.remove();
      cloneBody.remove();
    }, 10000);

    openTrip(tripId, returnTo, function () {
      // 実際に旅の詳細画面へ切り替わった直後（renderTripDetailまで完了済み）。ここで初めて
      // 抜ける画面をfreezeする（通信が速く、この時点でまだアニメーション中でも問題ない）。
      freezeLeavingScreen(leavingScreen, leavingScrollY);
      enteringScreen = hideEnteringScreen($('.screen.active'));
      screenReady = true;
      finishIfReady();
    });
    pendingCardOpenAnim = { cardEl: cardEl, tripId: tripId };

    requestAnimationFrame(function () {
      void cloneBody.offsetHeight; // reflow。ここまでの初期位置をブラウザに確定させてから終了位置へ動かす
      backdrop.classList.add('show');
      bgFade.classList.add('show'); // 演出後半（CSS側のtransition-delayで225ms〜450ms）でグレーへ
      if (clonePhoto) {
        setCloneRect(clonePhoto, target.photoRect);
        clonePhoto.style.borderRadius = '0';
      }
      setCloneRect(cloneBody, target.sheetRect);
      cloneBody.style.borderRadius = '20px 20px 0 0';
    });

    setTimeout(function () { minDone = true; finishIfReady(); }, TRIP_OPEN_ANIM_MS);
  }

  // 「戻る」（← 戻るボタン／画面端スワイプ）のとき：直前にカードのアニメーションで開いた旅行と同じで、
  // かつそのカードがまだ画面上に残っていれば逆再生する。renderHomeTripList()が一覧を作り直すと
  // 古いカードは画面から外れる（document.body.containsが false になる）ので、そのときは
  // 素直に今までどおりの切り替えにする。doNavigateは実際の画面遷移（pushState・showScreen等）そのもの。
  function maybeAnimateTripCardClose(doNavigate) {
    var info = pendingCardOpenAnim;
    pendingCardOpenAnim = null;
    if (!info || !CARD_EXPAND_ENABLED() || !state.trip || state.trip.id !== info.tripId ||
      !document.body.contains(info.cardEl)) {
      doNavigate();
      return;
    }
    var cardVisual = readTripCardVisual(info.cardEl);
    if (!cardVisual.bodyRect.width || !cardVisual.bodyRect.height) { doNavigate(); return; }
    // 今表示中の本物の詳細画面（このあとdoNavigate()で消える直前）から、写真・シートの実際の位置を
    // 実測する。開くときと違ってこちらは今まさに画面上にあるので実測できる（見積もりに頼らない）。
    var start = readTripDetailHeaderTarget();
    if (!start.sheetRect) { doNavigate(); return; }

    var backdrop = document.createElement('div');
    backdrop.className = 'trip-open-backdrop show';
    // 開くときと違い、抜ける画面（frozenになる旅の詳細）はもともと本物の詳細画面そのものなので、
    // シートの下は最初から本物の--bg色（グレー＋カード）になっている。そのためbg-fadeは「戻る」開始時
    // から不透明（=グレーが透けて見える状態）にしておき、白本体クローンが縮んでいくあいだも
    // その下がずっと正しいグレーであり続けるようにする（trip-open-bg-fadeにtransitionは無くても
    // クラスの有無だけで即座に切り替わる。フェードが要るのは開くときの「ぼやけた一覧→グレー」だけで、
    // 戻るときは最初からグレーなのでフェードではなく最初からshowでよい）。
    var bgFade = document.createElement('div');
    bgFade.className = 'trip-open-bg-fade show';

    var clonePhoto = null;
    if (start.hasPhoto) {
      clonePhoto = document.createElement('div');
      clonePhoto.className = 'trip-open-clone trip-open-clone-photo';
      setCloneRect(clonePhoto, start.photoRect);
      clonePhoto.style.borderRadius = '0';
      clonePhoto.style.backgroundImage = $('#tripCoverPhoto').style.backgroundImage;
    }
    var cloneBody = document.createElement('div');
    cloneBody.className = 'trip-open-clone trip-open-clone-body';
    setCloneRect(cloneBody, start.sheetRect);
    cloneBody.style.borderRadius = '20px 20px 0 0';
    // 本物のタイトル・日程クローンを重ねておく（本物の詳細画面はこのあとdoNavigate()で消えるので、
    // 消える前に今の文字を読み取っておく）。カードへ戻り着くまでこの文字のまま縮む＝カードの文字と
    // 一瞬で入れ替わる（revealEnteringScreenの瞬間）。
    var detailTitleEl = $('#tripTitle');
    var detailDatesEl = $('#tripDates');
    addCloneText(cloneBody, detailTitleEl ? detailTitleEl.textContent : '', detailDatesEl ? detailDatesEl.textContent : '');

    document.body.appendChild(backdrop);
    document.body.appendChild(bgFade);
    if (clonePhoto) document.body.appendChild(clonePhoto);
    document.body.appendChild(cloneBody);

    var leavingScreen = $('.screen.active'); // 旅の詳細（このあとdoNavigate()でホーム等に切り替わる）
    var leavingScrollY = window.scrollY;
    doNavigate(); // 実際の画面切り替え（pushState・showScreen・renderHome等）
    var enteringScreen = hideEnteringScreen($('.screen.active'));
    freezeLeavingScreen(leavingScreen, leavingScrollY);

    requestAnimationFrame(function () {
      void cloneBody.offsetHeight;
      backdrop.classList.remove('show');
      if (clonePhoto) {
        if (cardVisual.hasPhoto) {
          setCloneRect(clonePhoto, cardVisual.photoRect);
          clonePhoto.style.borderRadius = cardVisual.photoRadius;
        } else {
          // 戻り先のカードに写真が無い（マイログの小さい一覧など）ときは、写真クローンの高さを
          // 0に潰してカードの上端に吸い込ませる
          setCloneRect(clonePhoto, {
            top: cardVisual.bodyRect.top, left: cardVisual.bodyRect.left,
            width: cardVisual.bodyRect.width, height: 0
          });
          clonePhoto.style.borderRadius = '0';
        }
      }
      setCloneRect(cloneBody, cardVisual.bodyRect);
      cloneBody.style.borderRadius = cardVisual.bodyRadius;
    });

    setTimeout(function () {
      // 開くときと同じ理由で、本物（ホーム／マイログ）を即座に見せるのと同じフレームで暗幕・
      // ベタ塗り・クローンを消す（暗幕の消滅を450msのtransitionに任せて別タイミングで消すと、
      // 本物がぼやけて見える数フレームができてしまう。2026-09-29修正）。
      unfreezeScreen(leavingScreen);
      revealEnteringScreen(enteringScreen);
      backdrop.remove();
      bgFade.remove();
      if (clonePhoto) clonePhoto.remove();
      cloneBody.remove();
    }, TRIP_OPEN_ANIM_MS);
  }

  function skeletonCardsHtml(n) {
    var card = '<div class="skeleton-card" aria-hidden="true">' +
      '<div class="skeleton-line skeleton-line-title"></div>' +
      '<div class="skeleton-line skeleton-line-sub"></div>' +
      '</div>';
    var out = '';
    for (var i = 0; i < (n || 3); i++) out += card;
    return '<div class="skeleton-wrap">' + out + '</div>';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 画面ごとのスクロール位置。記録・予定の編集から旅行の画面に戻ったとき、毎回いちばん上に戻ってしまい
  // 編集していた記録を探し直す必要があったため、旅行の画面・マイログ画面は離れたときの位置に戻す
  // （マイログは2026-09-28〜。旅行を開いてまた「← 戻る」で戻ったとき、スクロールした先のカードを
  // 探し直さなくて済むように）。別の旅行を開いたとき（openTrip）はいちばん上から。
  var screenScroll = {};
  var SCROLL_RESTORE_SCREENS = { tripDetail: 1, mylog: 1 };
  function showScreen(name) {
    var leaving = $('.screen.active');
    var leavingName = leaving && leaving.dataset.screen;
    if (leaving && leavingName !== name) screenScroll[leavingName] = window.scrollY;
    // タブバーの4画面同士を行き来するとき（例：マイログ→旅先一覧）だけクロスフェードを付ける。
    // 旅の詳細を開く／閉じる等、タブ以外に出入りする遷移では今までどおり一瞬で切り替える
    // （地図の再描画などが多い画面でアニメーションと被って重く見えないように）。
    var isTabSwitch = !!TABBAR_SCREENS[name] && !!leavingName && !!TABBAR_SCREENS[leavingName] && leavingName !== name;
    $all('.screen').forEach(function (s) {
      var entering = s.dataset.screen === name;
      s.classList.toggle('active', entering);
      s.classList.remove('tab-switch-in');
      if (entering && isTabSwitch) {
        // 直前のフレームでクラスを外しているので、再度付けたときにアニメーションが必ず最初から走る
        void s.offsetWidth;
        s.classList.add('tab-switch-in');
      }
    });
    var y = SCROLL_RESTORE_SCREENS[name] ? (screenScroll[name] || 0) : 0;
    window.scrollTo(0, y);
    // 呼び出し元がこのあと画面を描き直すので、描き終わった後にもう一度合わせる
    if (y) setTimeout(function () { if ($('.screen.active') && $('.screen.active').dataset.screen === name) window.scrollTo(0, y); }, 0);
    updateTabbar(name);
  }

  // ボトムタブバー（マイログ・旅先一覧・旅の足跡・プロフィール）の表示・ハイライトを、画面の
  // 切り替えのたびにここで一括して更新する（showScreenの呼び出し元がタブの状態を気にしなくてよいように）。
  // トップレベルの4画面だけで出し、旅の詳細・記録フォーム・地図でふりかえる・シート・ログインでは隠す。
  var TABBAR_SCREENS = { mylog: 1, visited: 1, home: 1, profile: 1 };
  function updateTabbar(name) {
    var bar = $('#tabbar');
    if (!bar) return;
    bar.classList.toggle('show', !!TABBAR_SCREENS[name]);
    $all('.tabbar-btn', bar).forEach(function (b) {
      b.classList.toggle('on', b.dataset.tab === name);
    });
  }

  // ページの一番下（上）でさらに引っぱっても、ページ全体を動かさない（2026-09-30、TestFlight 100の報告
  // 「一番下まで行くと下タブが浮かび上がる」）。ネイティブのbounces=falseとCSSのoverscroll-behaviorを
  // 入れても残ったため、JS側でも止める。端にいて、さらに端の向きへ指を動かしている間のtouchmoveだけ
  // preventDefaultする（端以外の通常スクロール・シート等の内側のスクロール・横スワイプには触れない）。
  (function installEdgeScrollGuard() {
    var startY = 0, startX = 0;
    function inInnerScroller(el) {
      for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
        if (el.scrollHeight > el.clientHeight + 1) {
          var oy = getComputedStyle(el).overflowY;
          if (oy === 'auto' || oy === 'scroll') return true;
        }
      }
      return false;
    }
    document.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      startY = e.touches[0].clientY; startX = e.touches[0].clientX;
    }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      if (e.touches.length !== 1 || e.defaultPrevented) return;
      var t = e.touches[0];
      var dy = t.clientY - startY, dx = t.clientX - startX;
      if (Math.abs(dy) < Math.abs(dx)) return;
      var root = document.scrollingElement || document.documentElement;
      var max = root.scrollHeight - window.innerHeight;
      var atBottom = window.scrollY >= max - 1 && dy < 0;
      var atTop = window.scrollY <= 0 && dy > 0;
      if ((atBottom || atTop) && !inInnerScroller(e.target)) e.preventDefault();
    }, { passive: false });
    // 念のため、行き過ぎたスクロール位置になっていたら端に戻す
    window.addEventListener('scroll', function () {
      var root = document.scrollingElement || document.documentElement;
      var max = Math.max(0, root.scrollHeight - window.innerHeight);
      if (window.scrollY > max + 1) window.scrollTo(window.scrollX, max);
    }, { passive: true });
  })();

  // タブ名から、その画面を開く処理そのものへ（ボトムタブバーのタップ・下のタブの横スワイプの
  // 両方から呼ぶ。2026-09-29〜）。マイログ・旅先一覧はログインが要る（未ログインならログイン画面へ）。
  function openTabScreen(name) {
    if (name === 'home') goHome();
    else if (name === 'mylog') { if (loadCurrentUser()) openMyLog(); else openLogin('mylog'); }
    else if (name === 'visited') { if (loadCurrentUser()) openVisitedPlaces(); else openLogin('visited'); }
    else if (name === 'profile') openProfile();
  }

  // ---------- 「旅先一覧」の国内⇄海外・「マイログ」評価したもののカテゴリを横スワイプで
  // 切り替える（2026-09-29〜。a4f2949でいったんボトムタブ4画面の行き来にも同じ仕組みを使ったが、
  // TestFlight 98でのオーナー報告「スワイプで国内海外を移動できるんだけど操作性がかなり悪い。
  // 地図を押しているとスワイプできない気がする」＋その後の「タブ同士がスワイプで切り替わるのは
  // やめてほしい（マイログ→旅先一覧なども含めて全部）」を受けて、同日中に構成を見直した。
  // タブ同士の行き来はボトムタブバーのタップだけにし、ここでの横スワイプは各画面の中
  // （国内⇄海外・評価したもののカテゴリ）だけに絞る。境界（最初/最後）でさらに同じ向きへ
  // スワイプしても、よそのタブへは流さず、指を離すと軽く跳ね返る（詳しくはCONTEXT.md参照）----------

  // カテゴリのピル・チップの行など、横スクロールする要素の上から始まったタッチは、この
  // スワイプの対象にしない（そちらの横スクロール・操作をそのまま優先させる）。クラス名を
  // 決め打ちにせず、実際に横にスクロールできる要素かどうか（scrollWidth>clientWidthかつ
  // overflow-xがauto/scroll）を辿って調べるので、マイログのカテゴリピル（.mylog-tabs）など、
  // この先増える横スクロール行にも決め打ちの追記なしで効く。
  // 地図（SVG）はスクロールしない静的な図なので、以前あった「SVGの上から始まったタッチは
  // 全部対象外」という決め打ちは外した（これが「地図を押しているとスワイプできない」の原因
  // だった）。地形の領域タップ自体はclick（wireVisitedMapRegions）で別に処理しており、
  // 指がほぼ動かなければ下のdecideSwipeがnullを返すのでタップはそのまま効く。
  function startsOnHorizontalScroller(target) {
    var el = target;
    while (el && el.nodeType === 1) {
      if (el.scrollWidth > el.clientWidth + 1) {
        var overflowX = window.getComputedStyle(el).overflowX;
        if (overflowX === 'auto' || overflowX === 'scroll') return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  // 横スワイプの純粋な向き判定（node testで検証：test/data.test.js）。dx・dyは指の合計移動量
  // （px）、dtは経過時間（ms）。斜めの動きを誤検知しないよう、横方向は|dx|が|dy|の1.2倍を超えた
  // ときだけ。誤動作なくタップと区別するため、40px以上動くか、短くても素早く弾くように動いた
  // （20px以上・速度0.35px/ms以上＝flick）ときだけ'left'/'right'を返し、それ以外はnull
  // （タップ・揺れ・迷いのある動きとみなして何もしない）。
  function decideSwipe(dx, dy, dt) {
    if (Math.abs(dx) <= Math.abs(dy) * 1.2) return null;
    var dist = Math.abs(dx);
    var v = dt > 0 ? dist / dt : 0;
    var committed = dist >= 40 || (dist >= 20 && v >= 0.35);
    if (!committed) return null;
    return dx < 0 ? 'left' : 'right';
  }

  // 横方向と判定するまでの最初のわずかな動き（この間はまだpreventDefaultしない＝縦スクロールを
  // 邪魔しない）と、方向判定の比率。decideSwipeの最終判定とは別に、指が今どちら向きに進んでいるかを
  // ドラッグ中の見た目（次に効く）に使うためだけの値。
  var TAB_SWIPE_DECIDE_PX = 8;
  var TAB_SWIPE_RATIO = 1.2;

  var tabSwipeState = null;
  // スワイプでコミット（区切りを跨いで切り替え）が起きた直後は、その一瞬あとに来る合成clickで
  // 地図の領域タップ（wireVisitedMapRegions）が誤発火しないよう、短い間だけclickを無視する。
  var tabSwipeClickGuardUntil = 0;

  // 指の動きに合わせて、ドラッグ中の画面をtranslateXで追従させる。次に切り替え先がある向きは
  // そのまま追従、無い向き（境界）はゴムのように重くする（ラバーバンド。伸びるほど動きが小さくなる
  // 曲線にして、大きく引っ張っても際限なく画面がはみ出さないようにする）。
  function updateTabSwipeTransform(el, dx, hasTarget) {
    var max = hasTarget ? 120 : 36;
    var eased = hasTarget ? dx : dx / 3;
    var sign = eased < 0 ? -1 : 1;
    var abs = Math.min(Math.abs(eased), max * 4);
    var out = sign * (max * abs) / (max + abs);
    el.style.transition = 'none';
    el.style.transform = 'translateX(' + out + 'px)';
  }
  // ドラッグ終わり：中身が切り替わっていれば「そのまま定位置へ収まる」、境界で跳ね返っただけなら
  // 「ゴムが戻る」。どちらも見た目は同じ（今の位置から0へ ease-out）。reduced-motionのときは
  // アニメーションせず即座に0へ戻す。
  function settleTabSwipe(el) {
    if (prefersReducedMotion()) { el.style.transition = ''; el.style.transform = ''; return; }
    el.style.transition = 'transform .2s ease-out';
    el.style.transform = 'translateX(0px)';
    window.setTimeout(function () {
      el.style.transition = '';
      el.style.transform = '';
    }, 220);
  }

  // el上の横スワイプの共通エンジン。onSwipe(dx, startTarget)は横スワイプとコミットできたときだけ
  // 呼び、実際に何かが切り替わったら真・境界で何もしなければ偽を返す（偽ならゴムが戻るだけの見た目
  // にする）。hasSwipeTarget(dir, startTarget)は、ドラッグ中に「その向きに切り替え先があるか」を
  // 返す任意の関数（見た目のラバーバンドの重さだけに使う。省略時は常に真＝追従）。
  // touch-action: pan-yをCSS側（style.css）で付け、縦スクロールはネイティブのまま、横方向の
  // ジェスチャーだけJS側に来るようにしている。
  function initTabSwipe(el, onSwipe, hasSwipeTarget) {
    if (!el) return;

    el.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { tabSwipeState = null; return; }
      var t = e.touches[0];
      if (t.clientX <= EDGE_SWIPE_BACK_PX || t.clientX >= window.innerWidth - EDGE_SWIPE_BACK_PX) {
        tabSwipeState = null;
        return;
      }
      if (startsOnHorizontalScroller(e.target)) { tabSwipeState = null; return; }
      tabSwipeState = { startX: t.clientX, startY: t.clientY, startT: e.timeStamp, decided: false, horizontal: false, target: e.target };
    }, { passive: true });

    el.addEventListener('touchmove', function (e) {
      if (!tabSwipeState || e.touches.length !== 1) return;
      var t = e.touches[0];
      var dx = t.clientX - tabSwipeState.startX;
      var dy = t.clientY - tabSwipeState.startY;
      if (!tabSwipeState.decided && (Math.abs(dx) > TAB_SWIPE_DECIDE_PX || Math.abs(dy) > TAB_SWIPE_DECIDE_PX)) {
        tabSwipeState.decided = true;
        tabSwipeState.horizontal = Math.abs(dx) > Math.abs(dy) * TAB_SWIPE_RATIO;
      }
      if (tabSwipeState.decided && tabSwipeState.horizontal) {
        e.preventDefault();
        var dir = dx < 0 ? 'left' : 'right';
        var hasTarget = hasSwipeTarget ? !!hasSwipeTarget(dir, tabSwipeState.target) : true;
        updateTabSwipeTransform(el, dx, hasTarget);
      }
    }, { passive: false });

    el.addEventListener('touchend', function (e) {
      if (!tabSwipeState) return;
      var ts = tabSwipeState;
      tabSwipeState = null;
      if (!ts.decided || !ts.horizontal) return;
      var t = e.changedTouches[0];
      var dx = t.clientX - ts.startX;
      var dy = t.clientY - ts.startY;
      var dt = e.timeStamp - ts.startT;
      var dir = decideSwipe(dx, dy, dt);
      var handled = dir && onSwipe(dx, ts.target);
      if (handled) tabSwipeClickGuardUntil = Date.now() + 400;
      settleTabSwipe(el);
    });

    el.addEventListener('touchcancel', function () { tabSwipeState = null; settleTabSwipe(el); });
  }

  // マイログの「評価したもの」のカテゴリ（アクティビティーログ・飯ログ…）の並び。ピルのクリックと
  // 同じCore.CATEGORIES（移動にまとめる種類は除く）を使う。
  function mylogCategoryOrder() {
    return Core.CATEGORIES.filter(function (c) { return !c.inMove; }).map(function (c) { return c.key; });
  }
  function mylogSwipeTargetIndex(dx) {
    var order = mylogCategoryOrder();
    var i = order.indexOf(state.myLogCategory);
    var dir = dx < 0 ? 1 : -1; // 左スワイプ＝次のカテゴリ、右スワイプ＝前のカテゴリ
    var j = i + dir;
    return { order: order, dir: dir, i: i, j: j, inRange: i >= 0 && j >= 0 && j < order.length };
  }
  // #mylogList（一覧）の上での横スワイプ：「評価したもの」のカテゴリを切り替える。最初・最後の
  // カテゴリでさらに同じ向きへスワイプしても、よそへは流さず何もしない（ゴムが戻るだけ）。
  function mylogResolveSwipe(dx) {
    var r = mylogSwipeTargetIndex(dx);
    if (!r.inRange) return false;
    state.myLogCategory = r.order[r.j];
    renderMyLog();
    var onTab = $('.mylog-tab.on', $('#mylogTabs'));
    if (onTab && onTab.scrollIntoView) onTab.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    animateSwipeList($('#mylogList'), r.dir);
    return true;
  }
  function mylogHasSwipeTarget(dir) {
    return mylogSwipeTargetIndex(dir === 'left' ? -1 : 1).inRange;
  }
  // スワイプでカテゴリ・タブが切り替わったとき、一覧をその向きへ短く滑らせながらふわっと出す
  // （2026-09-29〜）。prefers-reduced-motionのときはCSS側でアニメーションそのものを付けない。
  function animateSwipeList(el, dir) {
    if (!el) return;
    el.style.setProperty('--swipe-x', (dir > 0 ? 12 : -12) + 'px');
    el.classList.remove('list-switch-in');
    void el.offsetWidth;
    el.classList.add('list-switch-in');
  }
  // 「行ったことある旅先」の国内⇄海外スワイプ：すでにその側ならもう先が無いので何もしない
  // （ゴムが戻るだけ。以前はここからさらにタブ自体の切り替えに流していたが、2026-09-29〜、
  // タブ同士の行き来はボトムタブバーのタップだけにしたため廃止）。
  function visitedResolveSwipe(dx) {
    var goingLeft = dx < 0;
    var target = goingLeft ? 'overseas' : 'domestic';
    if (state.visitedTab === target) return false;
    state.visitedTab = target;
    state.visitedSel = null;
    renderVisitedPlaces();
    return true;
  }
  function visitedHasSwipeTarget(dir) {
    return state.visitedTab !== (dir === 'left' ? 'overseas' : 'domestic');
  }

  // ---------- ログイン状態（端末に保存する） ----------
  function loadCurrentUser() {
    try { return JSON.parse(localStorage.getItem(CURRENT_USER_KEY) || 'null'); } catch (e) { return null; }
  }
  function saveCurrentUser(u) { localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(u)); }
  function clearCurrentUser() { localStorage.removeItem(CURRENT_USER_KEY); }

  // メールでのログインは常に使えるため、ログイン機能自体は常に有効。
  // Apple・Google・LINEのボタンは、Workerに設定があるものだけ追加で出る（GET /auth/providers）。
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
    var searchBlocks = allBlocks();
    for (var i = 0; i < searchBlocks.length; i++) {
      var entries = searchBlocks[i].entries || [];
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

  // マイログ「参加した旅行」の絞り込み・並び順（ホーム画面のCore.filterTrips/sortTripsを再利用）。
  // ホーム画面側の絞り込みは画面を離れると消えるが、こちらは見る人ごとに端末へ覚えておく。
  function loadMylogFilters() {
    try {
      var v = JSON.parse(localStorage.getItem(MYLOG_FILTERS_KEY) || 'null');
      return v && typeof v === 'object' ? { companion: v.companion || '', year: v.year || '', sort: v.sort || '' } : { companion: '', year: '', sort: '' };
    } catch (e) { return { companion: '', year: '', sort: '' }; }
  }
  function saveMylogFilters(f) {
    try { localStorage.setItem(MYLOG_FILTERS_KEY, JSON.stringify(f)); } catch (e) { /* 保存できなくても致命的ではない */ }
  }
  // 選んだ旅行を「この端末の履歴」から消す（1件でも全件でも共通）。索引から外し、隠しリストへ足す。
  // サーバー上の旅行データには触れない。消した件数を返す。
  function removeTripsFromHistory(ids) {
    var plan = Core.planHistoryRemoval(loadMyTrips(), loadHiddenTripIds(), ids);
    localStorage.setItem(MY_TRIPS_KEY, JSON.stringify(plan.trips));
    saveHiddenTripIds(plan.hidden);
    return plan.removedIds.length;
  }
  function hideTripFromHistory() {
    if (!state.trip) return;
    if (!confirm('この旅行をホームの一覧（この端末の履歴）から消しますか？\n（旅行そのもの・サーバー上のデータは削除されません。共有URLを開けば、また一覧に戻ります）')) return;
    removeTripsFromHistory([state.trip.id]);
    goHome();
  }
  // 「旅行の履歴を整理」（旧「この端末の旅行の履歴を削除」）。tabilog:my-tripsはログイン状態と無関係の
  // 端末ローカルな索引（ログアウトしても消えない）なので、別アカウントに切り替えて試すときなどに
  // 前の旅行が残り続けて紛らわしい、という声を受けて追加した手動クリア機能。サーバー上の旅行
  // データ自体は削除しない。以前は全件消すだけで1件だけ消したい場合に対応できなかったため、
  // ボタンを押すとシートを開き、消す旅行を選べるようにした（「すべて消す」も同じシートから）。
  function openTripHistorySheet() {
    var trips = loadMyTrips();
    if (!trips.length) return;
    $('#tripHistoryList').innerHTML = trips.map(function (t) {
      var dateText = t.startDate ? Core.formatDateJp(t.startDate) + (t.endDate && t.endDate !== t.startDate ? ' 〜 ' + Core.formatDateJp(t.endDate) : '') : '';
      return '<label class="history-pick-row">' +
        '<input type="checkbox" class="history-pick-check" value="' + escapeHtml(t.id) + '">' +
        tripThumbHtml(t.coverPhotoId) +
        '<span class="history-pick-body"><span class="history-pick-title">' + escapeHtml(t.title || '（無題の旅行）') + '</span>' +
        (dateText ? '<span class="history-pick-date">' + escapeHtml(dateText) + '</span>' : '') + '</span></label>';
    }).join('');
    updateTripHistorySelection();
    $('#tripHistorySheet').hidden = false;
    document.body.classList.add('sheet-open');
  }
  function closeTripHistorySheet() {
    $('#tripHistorySheet').hidden = true;
    document.body.classList.remove('sheet-open');
  }
  function selectedTripHistoryIds() {
    return Array.prototype.map.call($('#tripHistoryList').querySelectorAll('.history-pick-check:checked'), function (c) { return c.value; });
  }
  function updateTripHistorySelection() {
    var n = selectedTripHistoryIds().length;
    var btn = $('#btnRemoveSelectedHistory');
    btn.disabled = n === 0;
    btn.textContent = '選んだ旅行を履歴から消す（' + n + '件）';
  }
  function finishTripHistoryRemoval(count) {
    closeTripHistorySheet();
    renderHomeTripList();
    showToast(count + '件を履歴から消しました');
  }
  function removeSelectedTripHistory() {
    var ids = selectedTripHistoryIds();
    if (!ids.length) return;
    if (!confirm(ids.length + '件の旅行をこの端末の履歴から消しますか？\n（旅行そのもの・サーバー上のデータは削除されません。URLを開けば、また一覧に戻ります）')) return;
    finishTripHistoryRemoval(removeTripsFromHistory(ids));
  }
  function clearTripHistory() {
    if (!confirm('この端末に保存されている「旅行の履歴」をすべて消しますか？\n（旅行そのもの・サーバー上のデータは削除されません。URLを知っていれば引き続き開けます）')) return;
    finishTripHistoryRemoval(removeTripsFromHistory(loadMyTrips().map(function (t) { return t.id; })));
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
    allBlocks().forEach(function (block) {
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

  // 精算の端数（丸め）単位は旅行ごとの設定（trip.settleUnit）で、参加者全員で共有する
  // （Walicaにならい1円／10円／100円から選べる。2026-09-27）。古い旅行データにはまだ
  // フィールドが無いことがあるので、無ければ1円扱いにする。
  function currentSettleUnit() {
    var u = state.trip && state.trip.settleUnit;
    return Core.SETTLE_UNITS.indexOf(u) !== -1 ? u : 1;
  }

  function renderSettleUnitPicker() {
    var unit = currentSettleUnit();
    $all('.settle-unit-opt', $('#settleUnitPicker')).forEach(function (btn) {
      btn.classList.toggle('on', Number(btn.dataset.unit) === unit);
    });
  }

  function saveSettleUnit(unit) {
    if (!state.trip || currentSettleUnit() === unit) return;
    var prevUnit = state.trip.settleUnit;
    state.trip.settleUnit = unit; // 保存前に反映し、タップの反応を速くする（失敗したら戻す）
    renderSettleUnitPicker();
    renderSettlement();
    api('/trips/' + encodeURIComponent(state.trip.id), 'PATCH', { settleUnit: unit })
      .then(function (trip) { state.trip = trip; rememberTrip(trip); })
      .catch(function () {
        state.trip.settleUnit = prevUnit;
        renderSettleUnitPicker();
        renderSettlement();
        alert('端数の単位を保存できませんでした。もう一度お試しください。');
      });
  }

  function renderSettlement() {
    var expenses = Core.tripExpenseList(allBlocks());
    var hasExpenses = expenses.length > 0;
    $('#settlementEmpty').hidden = hasExpenses;
    $('#settlementBody').hidden = !hasExpenses;
    renderSettleUnitPicker();
    if (!hasExpenses) return;

    var unit = currentSettleUnit();
    var balance = Core.tripBalances(state.trip, allBlocks());
    var names = Object.keys(balance).filter(function (n) { return Core.roundToUnit(balance[n], 1) !== 0; });
    // 貸し借りが無い（＝0円の）参加者も、参加していることが分かるよう一覧には残す
    (state.trip.companions || []).forEach(function (n) { if (names.indexOf(n) === -1) names.push(n); });

    $('#settlementBalances').innerHTML = names.map(function (name) {
      var yen = Core.roundToUnit(balance[name] || 0, 1);
      var cls = yen > 0 ? 'plus' : (yen < 0 ? 'minus' : '');
      var text = yen > 0 ? '+' + Core.formatYen(yen) + '（もらう）' : (yen < 0 ? '－' + Core.formatYen(-yen) + '（払う）' : '±¥0');
      return '<div class="balance-row ' + cls + '"><span class="name">' + escapeHtml(name) + '</span><span class="amount">' + escapeHtml(text) + '</span></div>';
    }).join('');

    var plan = Core.settlementPlan(balance, unit);
    var planEl = $('#settlementPlanList');
    if (!plan.length) {
      planEl.innerHTML = '<p class="empty">貸し借りはありません。</p>';
    } else {
      planEl.innerHTML = plan.map(function (p) {
        return '<div class="settle-plan-row"><span class="from">' + escapeHtml(p.from) + '</span>' + SETTLE_ARROW_ICON
          + '<span class="to">' + escapeHtml(p.to) + '</span><span class="amount">' + escapeHtml(Core.formatYen(p.amount)) + '</span></div>';
      }).join('');
    }
    var roundNote = $('#settlementRoundNote');
    roundNote.hidden = !(unit > 1 && plan.length);
    if (unit > 1 && plan.length) {
      roundNote.textContent = unit + '円単位に丸めています（受け取る人の合計が実際と少しずれることがあります）。';
    }

    $('#settlementExpenses').innerHTML = expenses.map(function (e) {
      var splitText = e.splitAmong.length > 1 ? e.splitAmong.join('・') + 'で割り勘' : e.paidBy + 'の分';
      var dateText = e.date ? e.date.slice(5).replace('-', '/') : '';
      return '<div class="expense-row">' +
        '<div class="expense-main"><span class="label">' + escapeHtml(e.label || '（内容未入力）') + '</span><span class="amount">' + escapeHtml(Core.formatCostItemAmount(e)) + '</span></div>' +
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
    blocks: [],               // みんなの予定（別行動の中の予定は含まない）
    branchBlocks: [],         // 別行動（自分だけの道）の中の予定（block.branchIdが空でないもの）
    branches: [],             // 別行動（{id, accountId, name, date, startTime, endTime, title}）。docs/adr/0021
    viewAccountId: '',        // 旅行の画面で「見ている道」の持ち主のaccountId。空文字＝みんな
    editingBranchId: '',      // 予定フォームで、別行動の中の予定を作る・直しているときの別行動のid
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
    linkCode: '',             // ソーシャルログインでメールが分からなかったとき、メールOTPで結びつける待ちのコード
    myLogItems: [],
    myLogTrips: [],
    myLogPlaces: { prefectures: [], countries: [], tripPlaces: [] },
    mylogFilters: loadMylogFilters(), // マイログ「参加した旅行」の絞り込み（誰と一緒か・年）・並び順。端末に記憶する
    visitedTab: 'domestic',   // 「行ったことある旅先」の選択中タブ（domestic|overseas）
    visitedSel: null,          // 「行ったことある旅先」で選んだ場所（{kind, name}）。地図・一覧の両方をハイライトする
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
    var revealCards = [];
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
      card.addEventListener('click', function () { openTripFromCard(card, t.id); });
      el.appendChild(card);
      revealCards.push(card);
    });
    revealCardsOnScroll(revealCards);
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
    // 直前にホームのカードのアニメーション（openTripFromCard）で開いた旅行を、そのままの
    // カードへ戻るなら逆再生する（maybeAnimateTripCardClose、そうでなければ即座にdoNavigateだけ呼ばれる）。
    maybeAnimateTripCardClose(function () {
      history.pushState(null, '', location.pathname);
      showScreen('home');
      renderHome();
    });
  }

  // ---------- 旅行を開く ----------
  // returnTo：この旅行の詳細画面から「← 戻る」／edge-swipe-backを押したときにどこへ戻るか（省略時は
  // ホーム。共有リンク・深いリンクから直接開いたときも省略＝ホームに戻る）。
  // 「行ったことある旅先」の一覧・地図の吹き出しから旅行名をタップして開いたとき（openTrip(id, 'visited')）、
  // マイログの「参加した旅行」カードから開いたとき（openTrip(id, 'mylog')）は、そのページに戻す
  // （2026-09-28〜。ボトムタブバー導入にあわせ、戻ったときに正しいタブがハイライトされるよう
  // showScreen自身がタブの見た目も更新する＝updateTabbar参照）。
  // onScreenReady：省略可。旅の詳細画面へ実際に切り替わった（showScreen＋renderTripDetail完了）
  // 直後に同期で呼ばれる。openTripFromCard（カードが浮かび上がって広がる演出）が、通信の完了を
  // 待たずに始めたアニメーションと、実際の画面切り替え（通信待ちで遅れる）のタイミングを
  // 合わせるために使う。それ以外の呼び出し元は今までどおり省略でよい。
  function openTrip(id, returnTo, onScreenReady) {
    if (!API_BASE) { apiNoticeCheck(); showScreen('home'); return; }
    api('/trips/' + encodeURIComponent(id)).then(function (data) {
      applyTripData(data, false);
      state.social = emptySocial();
      var dates = Core.allDatesForTrip(state.trip, state.blocks);
      state.selectedDate = dates[0] !== undefined ? dates[0] : '';
      rememberTrip(state.trip);
      history.pushState(null, '', Core.buildShareUrl(location.origin, location.pathname, id).replace(location.origin, ''));
      state.zoneInfo = { byBlock: {} };
      screenScroll.tripDetail = 0; // 別の旅行はいちばん上から
      state.tripReturnScreen = (returnTo === 'visited' || returnTo === 'mylog') ? returnTo : null;
      showScreen('tripDetail');
      renderTripDetail();
      loadSocial();
      loadTripZones();
      if (onScreenReady) onScreenReady();
    }).catch(function () {
      forgetTrip(id);
      alert('旅行が見つかりませんでした（削除された可能性があります）。一覧からも消しました。');
      goHome();
    });
  }

  // 旅の詳細（tripDetail）の「← 戻る」／edge-swipe-backの共通の戻り先判定（openTripのreturnTo、
  // 2026-09-28〜）。openTripで記録したtripReturnScreen（'visited'|'mylog'|null）に従って戻る。
  // showScreenが呼ばれることで、ボトムタブバーの見た目（updateTabbar）も自動で正しいタブに戻る。
  function returnFromTripDetail() {
    var target = state.tripReturnScreen;
    state.tripReturnScreen = null;
    if (target === 'visited') {
      showScreen('visited');
      renderVisitedPlaces();
      return;
    }
    if (target === 'mylog') {
      showScreen('mylog');
      renderMyLog();
      return;
    }
    goHome();
  }

  function refreshTrip() {
    return api('/trips/' + encodeURIComponent(state.trip.id)).then(function (data) {
      applyTripData(data, true);
      // 地図を足した・日程を変えたあとも時差を調べ直す。以前は旅行を開いたときにしか調べず、あとから入れた
      // 地図（ニューヨークの「英語表現の疑問」）が前の時差（ブラジル）のままだった（2026-09-27）。
      // 調べ終わったら並びと区切りを描き直す（loadTripZones）。調べた結果は端末に覚えているので通信は少ない
      loadTripZones();
    });
  }

  // ---------- 新規作成 ----------
  function openNewTripForm() {
    $('#ntTitle').value = '';
    $('#ntStart').value = '';
    $('#ntEnd').value = '';
    $('#ntEnd').min = '';
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
    $('#teEnd').min = trip.startDate || '';
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
    var newStart = $('#teStart').value, newEnd = $('#teEnd').value;
    // 日程を変えたら、予定もいっしょにずらすかを確かめる（2026-09-26。Core.tripScheduleShift）
    var shift = Core.tripScheduleShift(state.trip, newStart, newEnd, allBlocks());
    var shiftDays = 0;
    if (shift) {
      var dir = shift.days > 0 ? Math.abs(shift.days) + '日後' : Math.abs(shift.days) + '日前';
      var move = Core.formatDateJp(shift.firstFrom) + ' → ' + Core.formatDateJp(shift.firstTo);
      var msg = shift.reason === 'start'
        ? '開始日を変えました。予定（' + shift.count + '件）も同じだけ' + dir + 'にずらしますか？\n最初の予定：' + move
        : '予定が1日目（' + Core.formatDateJp(newStart) + '）からずれています。予定（' + shift.count + '件）をまとめて' + dir + 'にずらして、1日目からにそろえますか？\n最初の予定：' + move;
      if (confirm(msg + '\n\n「キャンセル」を選ぶと、日程だけを保存します。')) shiftDays = shift.days;
    }
    status.textContent = '保存中…';
    resolveCoverPhotoId().then(function (coverPhotoId) {
      var body = {
        title: title,
        startDate: newStart,
        endDate: newEnd,
        companions: Core.parseTags($('#teCompanions').value),
        tripType: $('#teTripType').value.trim(),
        coverPhotoId: coverPhotoId
      };
      if (shiftDays) body.shiftDays = shiftDays;
      return api('/trips/' + encodeURIComponent(state.trip.id), 'PATCH', body);
    }).then(function (trip) {
      // サーバーが実際にずらした日数（古いWorkerはshiftDaysを知らないので返さない）
      var shifted = trip.shiftedDays || 0;
      delete trip.shiftedDays;
      state.trip = trip;
      rememberTrip(trip);
      if (shiftDays && !shifted) alert('日程は保存しましたが、予定はずらせませんでした。少し時間をおいて、もう一度日程を保存してください。');
      // 予定・日ごとの情報の日付が変わったので、旅行ごと読み直す
      return shifted ? refreshTrip() : null;
    }).then(function () {
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
    return Core.lodgingSummary(groups) || Core.primaryLodgingName(state.blocks) || '未設定';
  }

  // 宿泊先の内訳（何泊目にどこへ泊まったか、全件）。統計カードの表示文字列（formatLodgingStat）は
  // 3行までしか出せない（.stat-card .valのline-clamp）ため、宿泊先が3件を超える旅行では
  // 全部を確認できなかった。統計カードの「宿泊先」をタップすると開閉する（DAY30〜）。
  var STAT_CHEVRON = '<svg class="stat-row-chev" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8l4 4 4-4"/></svg>';
  // 開いている詳細に合わせて、宿泊先・総費用の行の矢印（aria-expanded）をそろえる
  function syncStatRows() {
    var l = $('#btnShowLodgingBreakdown'), c = $('#btnShowCostBreakdown');
    if (l) l.setAttribute('aria-expanded', String(!$('#lodgingBreakdownPanel').hidden));
    if (c) c.setAttribute('aria-expanded', String(!$('#costBreakdownPanel').hidden));
  }
  function toggleLodgingBreakdown() {
    var panel = $('#lodgingBreakdownPanel');
    if (!panel.hidden) { panel.hidden = true; syncStatRows(); return; }
    $('#costBreakdownPanel').hidden = true;
    renderLodgingPanel();
    panel.hidden = false;
    syncStatRows();
  }
  // 宿泊先の内訳。1泊ずつ1行で出す（7泊目だけ直したい、が分かりやすいように。2026-09-27）。
  // 前の夜と同じ宿は名前を薄く出し、違う宿の夜には「同上」（前の夜の宿にそろえる）を出す
  function renderLodgingPanel() {
    var panel = $('#lodgingBreakdownPanel');
    lodgingNightList = Core.lodgingNights(state.trip, state.blocks);
    var primaryName = Core.primaryLodgingName(state.blocks);
    if (lodgingNightList.length) {
      panel.innerHTML = lodgingNightList.map(function (n, i) {
        var prev = lodgingNightList[i - 1];
        var cont = prev && prev.label && prev.label === n.label;
        var same = prev && prev.label && prev.label !== n.label;
        return '<div class="cost-breakdown-row lodging-row" role="button" tabindex="0" data-lodging-night="' + n.night + '">' +
          '<span class="lodging-night">' + n.night + '泊目<small>' + escapeHtml(formatNightDate(n.date)) + '</small></span>' +
          '<span class="lodging-name' + (cont ? ' cont' : '') + (n.label ? '' : ' none') + '">' + escapeHtml(n.label || '未定') + '</span>' +
          '<span class="lodging-actions">' +
          (same ? '<button type="button" class="lodging-row-same" data-lodging-same="' + n.night + '">同上</button>' : '') +
          '<span class="lodging-row-edit">' + (n.label ? '直す' : '入れる') + '</span></span></div>';
      }).join('');
    } else if (primaryName) {
      // 日帰りなど「泊」の無い旅行では日ごとの内訳が作れないため、宿泊カテゴリの見出しをそのまま出す
      panel.innerHTML = '<div class="cost-breakdown-row"><span class="name">宿泊先</span><span class="amount">' + escapeHtml(primaryName) + '</span></div>';
    } else {
      panel.innerHTML = '<p class="empty">宿泊カテゴリの予定がまだありません。</p>';
    }
    panel.insertAdjacentHTML('beforeend', lodgingFormHtml());
  }
  function formatNightDate(d) {
    var m = /^\d{4}-(\d{2})-(\d{2})$/.exec(d || '');
    return m ? Number(m[1]) + '/' + Number(m[2]) : '';
  }

  // ---------- 宿泊先を手で足す・直す（2026-09-27） ----------
  // 宿泊先は基本は「宿泊」の予定から読み取る。直すときは「n泊目〜m泊目をこの宿にする」として、その日の
  // 「宿泊」の予定（時刻なし）を足す・名前を変える（Core.lodgingRangePlan）。日程表・時差・地図でふりかえるにも使われる
  var lodgingPlaces = [], lodgingSession = '', lodgingChosen = null, lodgingNightList = [];
  function lodgingFormHtml() {
    if (!lodgingNightList.length) return '';
    var opts = function (id) {
      return '<select id="' + id + '" class="lodging-select">' + lodgingNightList.map(function (n) {
        return '<option value="' + n.night + '">' + n.night + '泊目（' + escapeHtml(formatNightDate(n.date)) + '）</option>';
      }).join('') + '</select>';
    };
    return '<button type="button" class="entry-add lodging-add-open" id="btnLodgingAddOpen">' + plusIcon() + '<span>宿泊先を追加</span></button>' +
      '<div class="lodging-add" id="lodgingAddForm" hidden>' +
      '<div class="lodging-add-title" id="lodgingAddTitle">宿泊先を追加</div>' +
      '<div class="field"><label for="lodgingAddName">宿の名前</label><input type="text" id="lodgingAddName" maxlength="200" placeholder="例：菊の家"></div>' +
      '<div class="field"><label for="lodgingAddFrom">泊まる夜</label><div class="lodging-range">' + opts('lodgingAddFrom') + '<span>〜</span>' + opts('lodgingAddTo') + '</div></div>' +
      '<div class="field"><label for="lodgingAddSearch">地図（任意）</label><div class="map-search-row"><input type="text" id="lodgingAddSearch" placeholder="宿の名前や住所で探す"><button type="button" class="btn ghost small" id="btnLodgingSearch">探す</button></div>' +
      '<div class="place-list" id="lodgingAddCandidates" hidden></div></div>' +
      '<p class="hint" id="lodgingAddStatus"></p>' +
      '<div class="lodging-add-actions"><button type="button" class="btn text" id="btnLodgingAddCancel">やめる</button>' +
      '<button type="button" class="btn primary" id="btnLodgingAddSave">保存する</button></div>' +
      '</div>';
  }
  // night：タップした夜（null＝「宿泊先を追加」）。範囲は、その夜から同じ宿が続く最後の夜まで
  function openLodgingForm(night) {
    var form = $('#lodgingAddForm');
    if (!form) return;
    var list = lodgingNightList;
    var start = night || (list.filter(function (n) { return !n.label; })[0] || list[list.length - 1]).night;
    var cur = list[start - 1];
    var end = start;
    while (list[end] && list[end].label === cur.label) end++;
    lodgingChosen = null; lodgingPlaces = [];
    $('#lodgingAddTitle').textContent = night && cur.label ? '宿泊先を直す' : '宿泊先を追加';
    $('#lodgingAddName').value = night ? cur.label : '';
    $('#lodgingAddFrom').value = String(start);
    $('#lodgingAddTo').value = String(end);
    $('#lodgingAddSearch').value = '';
    $('#lodgingAddCandidates').hidden = true;
    var block = cur.blockId ? (state.blocks || []).filter(function (b) { return b.id === cur.blockId; })[0] : null;
    var pe = night && block ? Core.replayPlaceEntry(block) : null;
    $('#lodgingAddStatus').textContent = night && cur.label ? (pe ? '地図が入っています。変えるときだけ探してください。' : '地図はまだ入っていません。') +
      '1泊だけ変えるときは、泊まる夜を「' + start + '泊目〜' + start + '泊目」にしてください。' : '';
    form.hidden = false;
    $('#btnLodgingAddOpen').hidden = true;
    $all('.lodging-row').forEach(function (r) {
      var k = Number(r.getAttribute('data-lodging-night'));
      r.classList.toggle('on', !!night && k >= start && k <= end);
    });
    if (form.scrollIntoView) form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function closeLodgingForm() {
    $('#lodgingAddForm').hidden = true;
    $('#btnLodgingAddOpen').hidden = false;
    $all('.lodging-row').forEach(function (r) { r.classList.remove('on'); });
  }
  function searchLodgingPlace() {
    var q = $('#lodgingAddSearch').value.trim() || $('#lodgingAddName').value.trim();
    if (!q) return;
    var status = $('#lodgingAddStatus'), list = $('#lodgingAddCandidates');
    status.textContent = '候補を探しています…';
    lodgingSession = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'pl-' + Date.now().toString(36);
    api('/places/search?q=' + encodeURIComponent(q) + '&session=' + encodeURIComponent(lodgingSession)).then(function (res) {
      lodgingPlaces = (res && res.places) || [];
      if (!lodgingPlaces.length) { list.hidden = true; status.textContent = '候補が見つかりませんでした。地図なしでも保存できます。'; return; }
      list.innerHTML = lodgingPlaces.map(function (p, i) {
        return '<div class="place-card" data-lodging-choice="' + i + '" role="button" tabindex="0"><span class="place-num">' + (i + 1) + '</span>' +
          '<div class="place-text"><div class="place-name">' + escapeHtml(p.name) + '</div>' +
          (p.address ? '<div class="place-address">' + escapeHtml(p.address) + '</div>' : '') + '</div><span class="place-pick">選択</span></div>';
      }).join('');
      list.hidden = false;
      status.textContent = '宿を選んでください。';
    }).catch(function () { status.textContent = '候補を取得できませんでした。地図なしでも保存できます。'; });
  }
  function chooseLodgingPlace(i) {
    var p = lodgingPlaces[i];
    if (!p) return;
    $all('[data-lodging-choice]', $('#lodgingAddCandidates')).forEach(function (el) {
      var on = el.getAttribute('data-lodging-choice') === String(i);
      el.classList.toggle('on', on);
      el.querySelector('.place-pick').textContent = on ? '選択中' : '選択';
    });
    if (!$('#lodgingAddName').value.trim()) $('#lodgingAddName').value = p.name || '';
    var need = !(isFinite(p.lat) && isFinite(p.lng)) && p.placeId;
    var req = need
      ? api('/places/details?id=' + encodeURIComponent(p.placeId) + '&session=' + encodeURIComponent(lodgingSession)).then(function (res) {
        if (res && res.found && isFinite(res.lat) && isFinite(res.lng)) { p.lat = res.lat; p.lng = res.lng; }
      }).catch(function () {})
      : Promise.resolve();
    lodgingChosen = req.then(function () {
      var url = Core.placeMapUrl(p, $('#lodgingAddSearch').value);
      $('#lodgingAddStatus').textContent = url ? '地図に「' + p.name + '」を入れます。' : '';
      return url || '';
    });
  }
  // 「from泊目〜to泊目をnameにする」を実行する（地図があれば泊まり始めの予定に入れる）
  function applyLodgingRange(from, to, name, mapUrl) {
    var plan = Core.lodgingRangePlan(state.trip, state.blocks, from, to, name);
    var user = loadCurrentUser(), author = (user && user.name) || '';
    var blockById = function (id) { return (state.blocks || []).filter(function (b) { return b.id === id; })[0]; };
    var mapOf = function (id) { var b = blockById(id), pe = b ? Core.replayPlaceEntry(b) : null; return pe ? pe.url : ''; };
    var addMap = function (block, url) {
      if (!url || !block) return null;
      var first = (block.entries || [])[0];
      return first
        ? api('/entries/' + encodeURIComponent(first.id), 'PATCH', { mapUrl: url })
        : api('/blocks/' + encodeURIComponent(block.id) + '/entries', 'POST', { mapUrl: url, author: author });
    };
    var jobs = plan.rename.map(function (id) { return api('/blocks/' + encodeURIComponent(id), 'PATCH', { label: name }); });
    plan.create.forEach(function (c) {
      var url = c.target ? mapUrl : mapOf(c.mapFrom);
      jobs.push(api('/trips/' + encodeURIComponent(state.trip.id) + '/blocks', 'POST', { date: c.date, time: '', label: c.label, category: 'lodging' })
        .then(function (block) { return addMap(block, url); }));
    });
    if (plan.target && mapUrl) jobs.push(addMap(blockById(plan.target), mapUrl));
    return Promise.all(jobs);
  }
  function saveLodging() {
    var name = $('#lodgingAddName').value.trim();
    var from = Number($('#lodgingAddFrom').value), to = Number($('#lodgingAddTo').value);
    var status = $('#lodgingAddStatus');
    if (!name) { status.textContent = '宿の名前を入れてください。'; return; }
    if (to < from) { status.textContent = '泊まる夜の終わりは、始まりより後にしてください。'; return; }
    status.textContent = '保存中…';
    $('#btnLodgingAddSave').disabled = true;
    (lodgingChosen || Promise.resolve('')).then(function (mapUrl) {
      return applyLodgingRange(from, to, name, mapUrl);
    }).then(function () {
      lodgingChosen = null; lodgingPlaces = [];
      return refreshTrip();
    }).then(function () {
      renderTripDetail();
      toggleLodgingBreakdown();
    }).catch(function () {
      status.textContent = '保存に失敗しました。もう一度お試しください。';
      $('#btnLodgingAddSave').disabled = false;
    });
  }
  // 「同上」：この夜から同じ宿が続く最後の夜までを、前の夜の宿にそろえる
  function sameAsAboveLodging(night) {
    var list = lodgingNightList, cur = list[night - 1], prev = list[night - 2];
    if (!cur || !prev || !prev.label) return;
    var end = night;
    while (list[end] && list[end].label === cur.label) end++;
    var btn = $('[data-lodging-same="' + night + '"]');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    applyLodgingRange(night, end, prev.label, '').then(function () { return refreshTrip(); }).then(function () {
      renderTripDetail();
      toggleLodgingBreakdown();
    }).catch(function () {
      if (btn) { btn.disabled = false; btn.textContent = '同上'; }
      alert('保存に失敗しました。もう一度お試しください。');
    });
  }

  // 総費用の内訳（誰が実際にいくら払ったか）。統計カードの「総費用」をタップすると開閉する。
  function toggleCostBreakdown() {
    var panel = $('#costBreakdownPanel');
    if (!panel.hidden) { panel.hidden = true; syncStatRows(); return; }
    $('#lodgingBreakdownPanel').hidden = true;
    var breakdown = Core.costBreakdownByPerson(allBlocks());
    var names = Object.keys(breakdown).sort(function (a, b) { return breakdown[b] - breakdown[a]; });
    panel.innerHTML = names.length
      ? names.map(function (name) {
          return '<div class="cost-breakdown-row"><span class="name">' + escapeHtml(name) + '</span><span class="amount">' + escapeHtml(Core.formatYen(breakdown[name])) + '</span></div>';
        }).join('')
      : '<p class="empty">まだ費用の記録がありません。</p>';
    panel.hidden = false;
    syncStatRows();
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
    // 「紹介文を作る」の入り口は一時的に隠す（FEATURES.post、2026-09-26〜。サーバー機能は残す）
    $('#btnOpenPost').hidden = !FEATURES.post;
    renderTripJoin();
    renderTripSocialBar();

    var lodging = formatLodgingStat(Core.lodgingByNight(trip, state.blocks));
    // 名前が長くても「ほか○か所」が切れないよう、別の行に出す（名前は2行まで）
    var lodgingParts = Core.lodgingSummaryParts(Core.lodgingByNight(trip, state.blocks));
    var total = Core.tripTotalCost(allBlocks());
    // 宿泊先・総費用は横幅いっぱいの行を縦に並べ、押すとその下に詳細が開く（日程は旅行名の下に
    // 「9泊10日」と出ているのでカードは出さない。2026-09-27）
    var lodgingPanel = $('#lodgingBreakdownPanel'), costPanel = $('#costBreakdownPanel');
    var stats = $('#tripStats');
    stats.innerHTML =
      '<button type="button" class="stat-row" id="btnShowLodgingBreakdown" aria-expanded="false"><span class="stat-row-lbl">宿泊先</span><span class="stat-row-val">' +
        (lodgingParts
          ? '<span class="lodging-val">' + escapeHtml(lodgingParts.main) + '</span>' + (lodgingParts.others ? '<span class="lodging-more">ほか' + lodgingParts.others + 'か所</span>' : '')
          : '<span class="lodging-val">' + escapeHtml(lodging) + '</span>') + '</span>' + STAT_CHEVRON + '</button>' +
      '<button type="button" class="stat-row" id="btnShowCostBreakdown" aria-expanded="false"><span class="stat-row-lbl">総費用</span><span class="stat-row-val"><span class="lodging-val">' +
        escapeHtml(Core.formatYen(total) || '¥0') + '</span></span>' + STAT_CHEVRON + '</button>';
    stats.insertBefore(lodgingPanel, $('#btnShowCostBreakdown'));
    stats.appendChild(costPanel);
    lodgingPanel.hidden = true;
    costPanel.hidden = true;
    $('#btnShowLodgingBreakdown').addEventListener('click', toggleLodgingBreakdown);
    if (!renderTripDetail.lodgingBound) {
      renderTripDetail.lodgingBound = true;
      $('#lodgingBreakdownPanel').addEventListener('click', function (e) {
        var t = e.target;
        if (t.closest('#btnLodgingAddOpen')) { openLodgingForm(null); $('#lodgingAddName').focus(); }
        else if (t.closest('[data-lodging-same]')) sameAsAboveLodging(Number(t.closest('[data-lodging-same]').getAttribute('data-lodging-same')));
        else if (t.closest('[data-lodging-night]')) openLodgingForm(Number(t.closest('[data-lodging-night]').getAttribute('data-lodging-night')));
        else if (t.closest('#btnLodgingAddCancel')) closeLodgingForm();
        else if (t.closest('#btnLodgingSearch')) searchLodgingPlace();
        else if (t.closest('#btnLodgingAddSave')) saveLodging();
        else if (t.closest('[data-lodging-choice]')) chooseLodgingPlace(Number(t.closest('[data-lodging-choice]').getAttribute('data-lodging-choice')));
      });
      $('#lodgingBreakdownPanel').addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && e.target.id === 'lodgingAddSearch') { e.preventDefault(); searchLodgingPlace(); }
        else if (e.key === 'Enter' && e.target.classList.contains('lodging-row')) { e.preventDefault(); openLodgingForm(Number(e.target.getAttribute('data-lodging-night'))); }
      });
    }
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
    // 参加済みでも押せるようにし、押すと参加をやめられる（2026-09-27。以前は押せず、やめられなかった）
    btn.disabled = false;
    btn.textContent = joined ? '参加済み' : '参加する';
    btn.classList.toggle('is-joined', !!joined);
    btn.setAttribute('aria-pressed', String(!!joined));
  }

  function handleJoinTrip() {
    var user = loadCurrentUser();
    if (!user) { openLogin('tripDetail'); return; }
    var joined = user.accountId && (state.members || []).some(function (m) { return m.accountId === user.accountId; });
    if (joined) { handleLeaveTrip(user); return; }
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

  function handleLeaveTrip(user) {
    if (!confirm('この旅行への参加をやめますか？\n\nアカウント参加の一覧から外れます。旅行や、あなたが書いた記録は消えません。あとからもう一度「参加する」を押せば戻れます。')) return;
    api('/trips/' + encodeURIComponent(state.trip.id) + '/leave', 'POST', { email: user.email })
      .then(function (res) {
        state.members = res.members || [];
        renderTripJoin();
      })
      .catch(function () {
        $('#tripDetailStatus').textContent = '参加をやめられませんでした。もう一度お試しください。';
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
    // いいね・コメントの入り口は一時的に隠す（FEATURES.social、2026-09-26〜。サーバー機能は残す）
    if (!FEATURES.social) { $('#tripSocialBar').innerHTML = ''; return; }
    if (state.trip) $('#tripSocialBar').innerHTML = socialButtonsHtml('trip', state.trip.id);
  }

  function renderSocial() {
    renderTripSocialBar();
    if (FEATURES.social) $all('.entry-social').forEach(function (el) { el.innerHTML = socialButtonsHtml('entry', el.dataset.entryId); });
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

  // アカウント系の画面（マイログ・行ったことある旅先・プロフィールなど）でログインが古いと分かったとき、
  // 古いログイン状態を消してログイン画面を開く。ログインし終わったら元の画面（returnTo）へ戻る。
  // すでにログイン画面が開いていれば開き直さない（同時に走った複数のAPIが一斉に401になっても1回だけ）。
  // 画面を開いたときの操作から呼ぶ。裏で走る自動の取得（ホームの旅行同期など）からは呼ばない。
  var RELOGIN_MESSAGE = '安全のため、もう一度ログインしてください';
  function forceRelogin(returnTo) {
    var user = loadCurrentUser();
    if (user) state.staleLoginUser = user; // ログイン画面のメール欄の入力補助にだけ使う
    clearCurrentUser();
    state.account = null;
    renderAccountRow();
    var active = $('.screen.active');
    if (!(active && active.dataset.screen === 'login')) openLogin(returnTo);
    $('#loginLead').textContent = RELOGIN_MESSAGE;
  }
  // 画面を開いたときのAPI失敗で呼ぶ：login_requiredなら再ログインへ案内してtrueを返す（呼び出し側は何もしない）
  function handleLoginRequired(e, returnTo) {
    if (!Core.isLoginRequiredError(e)) return false;
    // 返事が遅れて届いたとき、本人がもう別の画面へ移っていたら、ログイン画面に引き戻さない
    var active = $('.screen.active');
    var here = active && active.dataset.screen;
    if (here === returnTo || here === 'login') forceRelogin(returnTo);
    return true;
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
    var text = Core.buildTripPostText(state.trip, allBlocks(), state.days, user ? user.email : '', { legend: $('#postLegend').checked });
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
    $('#postLegend').addEventListener('change', openPostSheet); // 付ける・外すで作り直す（手で直した分は作り直しになる）
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
  // 外部のAIサービス（Cloudflare Workers AI・OpenAI・Google Cloud Vision）へ送信する
  // （Apple Guideline 5.1.1(i)/5.1.2(i)対応）。
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
      '内容の読み取り・文字起こしのために外部のAIサービス（Cloudflare・OpenAI・Google）へ送信します' +
      '（氏名・メールアドレスは送信しません）。\n' +
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
    $('#importJsonInput').value = '';
    $('#importJsonStatus').textContent = '';
    $('#importPreview').hidden = true;
    $('#importPreview').innerHTML = '';
    $('#btnImportJson').disabled = false;
    state.pendingImportBlocks = null;
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
        $('#btnGoToPlans').hidden = isNativeApp(); // iOSアプリでは購入の画面へ案内しない（3.1.1）
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
      else if (msg === 'output_too_long') $('#voiceEntryStatus').textContent = '内容が長すぎて、AIが整理しきれませんでした。何日かずつ・何回かに分けて入れてください。';
      else if (msg === 'ai_quota_exhausted') $('#voiceEntryStatus').textContent = 'AIの利用枠がいっぱいのため、今は使えません（運営側で対応します）。時間をおいてもう一度お試しください。';
      else if (msg === 'upstream_error') $('#voiceEntryStatus').textContent = 'AIのサービスにつながりませんでした（混み合っている・上限に達しているなど）。少し時間をおいてもう一度お試しください。';
      else if (msg === 'invalid_model_output') $('#voiceEntryStatus').textContent = 'うまく処理できませんでした。もう一度お試しください。';
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
      else if (msg === 'output_too_long') $('#textEntryStatus').textContent = '内容が長すぎて、AIが整理しきれませんでした。何日かずつ・何回かに分けて入れてください。';
      else if (msg === 'ai_quota_exhausted') $('#textEntryStatus').textContent = 'AIの利用枠がいっぱいのため、今は使えません（運営側で対応します）。時間をおいてもう一度お試しください。';
      else if (msg === 'upstream_error') $('#textEntryStatus').textContent = 'AIのサービスにつながりませんでした（混み合っている・上限に達しているなど）。少し時間をおいてもう一度お試しください。';
      else if (msg === 'invalid_model_output') $('#textEntryStatus').textContent = 'うまく処理できませんでした。もう一度お試しください。';
      else if (msg === 'premium_required' || msg === 'quota_exceeded') {
        $('#textEntryStatus').textContent = '今月のAIでの整理の回数を使い切りました。「10時 新宿」のように時刻で始まる行の形にすると、AIを使わず無料で取り込めます。';
      }
      else if (msg === 'login_required') { state.pendingMemoText = text; openLogin('voiceEntryForm'); }
      else $('#textEntryStatus').textContent = '失敗しました。もう一度お試しください。';
    });
  }

  // ---------- 自分のAIで整理（JSON貼り付け）（docs/adr/0015） ----------
  // 「AIへのお願い文をコピー」：クリップボードに書き込めない環境（一部のWebView等）では、
  // 隠しテキストエリアを選択状態にしてdocument.execCommand('copy')にフォールバックする
  // （copyShareLink・showZoneDiagnosticsと同じやり方）。
  function copyAiImportPrompt() {
    if (!state.trip) return;
    var text = Core.buildAiImportPrompt(state.trip);
    var done = function () { showToast('お願い文をコピーしました'); };
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); }
      catch (e) { alert('コピーできませんでした。表示された文章を選んでコピーしてください。\n\n' + text); }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  // 「取り込む」：まずCore.parseImportedBlocksJsonで読み取ってプレビューを見せるだけにし、
  // 実際にBlock/Entryを作るのは確認後（confirmImportJsonBlocks）にする。ログイン・AIの回数と
  // 無関係に使えるよう、既存のAIなし取り込みエンドポイント（/trips/:id/memo-blocks）だけを使う。
  function handleImportJson() {
    var text = $('#importJsonInput').value.trim();
    if (!text) { $('#importJsonStatus').textContent = '先にAIの答え（JSON）を貼り付けてください。'; return; }
    var result = Core.parseImportedBlocksJson(text, state.trip);
    renderImportPreview(result);
  }

  function renderImportPreview(result) {
    var el = $('#importPreview');
    if (!result.blocks.length) {
      state.pendingImportBlocks = null;
      el.hidden = true;
      el.innerHTML = '';
      $('#importJsonStatus').textContent = '取り込めませんでした：' + (result.errors[0] || '内容を確認してください。');
      return;
    }
    state.pendingImportBlocks = result.blocks;
    $('#importJsonStatus').textContent = '';
    var rows = result.blocks.map(function (b) {
      var costText = (b.entry.costItems || []).map(function (ci) {
        return ci.currency ? (ci.currency + ' ' + ci.amount) : Core.formatYen(ci.amount);
      }).join('・');
      return '<li>' + (b.time ? '<strong>' + escapeHtml(b.time) + '</strong> ' : '')
        + escapeHtml(b.label) + '（' + escapeHtml(Core.categoryLabel(b.category)) + '）'
        + (costText ? ' ' + escapeHtml(costText) : '') + '</li>';
    }).join('');
    var warnings = result.warnings.length
      ? '<p class="hint">' + result.warnings.map(escapeHtml).join('<br>') + '</p>' : '';
    var errors = result.errors.length
      ? '<p class="hint">省いた項目：<br>' + result.errors.map(escapeHtml).join('<br>') + '</p>' : '';
    el.innerHTML = '<p class="hint">この内容で作ります（' + result.blocks.length + '件）：</p>'
      + '<ul class="import-preview-list">' + rows + '</ul>'
      + warnings + errors
      + '<button class="btn primary wide" id="btnConfirmImportJson" type="button">この内容で取り込む</button>';
    el.hidden = false;
    $('#btnConfirmImportJson').addEventListener('click', confirmImportJsonBlocks);
  }

  // parseImportedBlocksJsonが読み取るcostItemsは、外貨（currency付き）でもrateを持たない
  // （自分のAIには外貨レートまで求めていないため）。手入力の行と同じく「初期値でレートを見せる」
  // 体験に揃え、レート抜けのまま合計・精算が黙って0円扱いになる事故を防ぐため、POSTする前に
  // /ratesから自動取得してrateを付けておく（renderCostItems内のensureRateForItemと同じAPI）。
  // 同じ通貨・日付の組み合わせは1回だけ取得し（複数の予定・費用行で繰り返されることが多いため）、
  // 取得に失敗した行はrate無し（=0円扱い、formatCostItemAmountが「レート未設定」と表示）のまま
  // 取り込みを続け、失敗した通貨コードを呼び出し側に返す（本人に記録を開いて直してもらうため）。
  function fetchRatesForImportBlocks(blocks, trip) {
    var tripDates = Core.allDatesForTrip(trip, []).filter(function (d) { return d; });
    var defaultDate = (trip && trip.selectedDate) || tripDates[0] || '';
    var rateReqs = {}; // key: "USD|2024-08-10" -> Promise<{ok, rate}>
    var failedCurrencies = [];
    var waits = [];
    blocks.forEach(function (b) {
      var blockDate = b.date || defaultDate;
      ((b.entry && b.entry.costItems) || []).forEach(function (item) {
        if (!item.currency || item.currency === 'JPY') return;
        if (typeof item.rate === 'number' && item.rate > 0) return;
        var key = item.currency + '|' + blockDate;
        if (!rateReqs[key]) {
          rateReqs[key] = api('/rates?date=' + encodeURIComponent(blockDate) + '&currency=' + encodeURIComponent(item.currency))
            .then(function (res) { return { ok: true, rate: res.rate }; })
            .catch(function () { return { ok: false }; });
        }
        waits.push(rateReqs[key].then(function (res) {
          if (res.ok) item.rate = res.rate;
          else if (failedCurrencies.indexOf(item.currency) === -1) failedCurrencies.push(item.currency);
        }));
      });
    });
    return Promise.all(waits).then(function () { return failedCurrencies; });
  }

  function confirmImportJsonBlocks() {
    var blocks = state.pendingImportBlocks;
    if (!blocks || !blocks.length || !state.trip) return;
    var user = loadCurrentUser();
    $('#btnImportJson').disabled = true;
    $('#importJsonStatus').textContent = '外貨のレートを確認しています…';
    fetchRatesForImportBlocks(blocks, state.trip).then(function (failedCurrencies) {
      $('#importJsonStatus').textContent = 'AIを使わずに取り込んでいます…（無料）';
      return api('/trips/' + encodeURIComponent(state.trip.id) + '/memo-blocks', 'POST', { blocks: blocks, author: (user && user.name) || '' })
        .then(function () { return refreshTrip(); })
        .then(function () {
          $('#btnImportJson').disabled = false;
          if (blocks[0] && blocks[0].date) state.selectedDate = blocks[0].date;
          $('#importJsonInput').value = '';
          $('#importPreview').hidden = true;
          $('#importPreview').innerHTML = '';
          state.pendingImportBlocks = null;
          showScreen('tripDetail');
          renderTripDetail();
          showToast('取り込みました');
          if (failedCurrencies.length) {
            alert(failedCurrencies.join('・') + 'のレートを取得できませんでした。記録を開いてレートを入れてください。');
          }
        });
    }).catch(function () {
      $('#btnImportJson').disabled = false;
      $('#importJsonStatus').textContent = '取り込みに失敗しました。もう一度お試しください。';
    });
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

  // ---------- 自分だけの道（別行動の分岐。docs/adr/0021） ----------
  // 旅行のデータは、みんなの予定（state.blocks）・別行動の中の予定（state.branchBlocks）・別行動そのもの
  // （state.branches）に分けて持つ。時差・宿泊・並べ替えなど「みんなの予定」を前提にした既存の機能は
  // state.blocksだけを見るので、そのまま動く。費用・アルバム・記録の検索は allBlocks()（両方）を見る。
  // 見せる予定の並びは、選んだ人（state.viewAccountId。空＝みんな）に応じて Core が決める。
  var BRANCH_VIEW_KEY_PREFIX = 'tabilog:branch-view:';
  var BRANCH_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 4-6 3-12 6"/></svg>';

  function loadBranchView(tripId) {
    try { return localStorage.getItem(BRANCH_VIEW_KEY_PREFIX + tripId) || ''; } catch (e) { return ''; }
  }
  function saveBranchView(tripId, accountId) {
    try {
      if (accountId) localStorage.setItem(BRANCH_VIEW_KEY_PREFIX + tripId, accountId);
      else localStorage.removeItem(BRANCH_VIEW_KEY_PREFIX + tripId);
    } catch (e) { /* 保存できなくても、その回の表示には困らない */ }
  }

  // サーバーから届いた旅行のデータを state に入れる。keepView：読み直し（refreshTrip）のときは、いま選んでいる人を保つ。
  function applyTripData(data, keepView) {
    state.trip = data.trip;
    var blocks = data.blocks || [];
    state.blocks = blocks.filter(function (b) { return !b.branchId; });
    state.branchBlocks = blocks.filter(function (b) { return b.branchId; });
    state.branches = data.branches || [];
    state.days = data.days || [];
    state.members = data.members || [];
    var wanted = keepView ? state.viewAccountId : loadBranchView(data.trip.id);
    state.viewAccountId = Core.resolveViewAccountId(wanted, state.branches);
  }

  function allBlocks() { return (state.blocks || []).concat(state.branchBlocks || []); }
  // 選んでいる人の道で見た、旅行全体の予定（地図でふりかえる・動画・時差の計算に使う）
  function activeBlocks() {
    return Core.visibleBlocksForView(state.blocks, state.branchBlocks, state.branches, state.viewAccountId);
  }
  function branchById(id) { return (state.branches || []).filter(function (b) { return b.id === id; })[0] || null; }
  function myAccountId() {
    var u = loadCurrentUser();
    return u && u.token && u.accountId ? u.accountId : '';
  }
  function amTripMember() {
    var me = myAccountId();
    return !!me && (state.members || []).some(function (m) { return m.accountId === me; });
  }
  function isMyBranch(branchId) {
    var br = branchById(branchId), me = myAccountId();
    return !!br && !!me && br.accountId === me;
  }
  // 画面から直せる予定か（別行動の中の予定は、持ち主だけ。サーバーでも同じ確認をしている）
  function canEditBlockUi(block) { return !block.branchId || isMyBranch(block.branchId); }
  function branchOwnerName(branch) {
    var m = (state.members || []).filter(function (x) { return x.accountId === branch.accountId; })[0];
    return (m && m.name) || branch.name || 'だれか';
  }

  function currentDayItems() {
    return Core.dayTimelineItems(state.blocks, state.branchBlocks, state.branches, state.viewAccountId, state.selectedDate || '');
  }
  function currentDayBlocks() {
    return currentDayItems().filter(function (i) { return i.type === 'block'; }).map(function (i) { return i.block; });
  }

  function setBranchView(accountId) {
    state.viewAccountId = Core.resolveViewAccountId(accountId, state.branches);
    if (state.trip) saveBranchView(state.trip.id, state.viewAccountId);
    renderDaySection();
  }

  // 「表示する道：みんな／○○」の切り替え。別行動がある旅行だけ出す
  function renderBranchSwitcher() {
    var el = $('#branchSwitcher');
    var opts = Core.branchViewOptions(state.branches, state.members);
    if (!opts.length) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    var chip = function (id, name) {
      return '<button type="button" class="branch-switch-chip' + (state.viewAccountId === id ? ' on' : '') + '" data-account="' + escapeHtml(id) + '">' + escapeHtml(name) + '</button>';
    };
    el.innerHTML = '<span class="branch-switch-label">表示する道</span>' + chip('', 'みんな') +
      opts.map(function (o) { return chip(o.accountId, o.name); }).join('');
    $all('.branch-switch-chip', el).forEach(function (b) {
      b.addEventListener('click', function () { setBranchView(b.dataset.account); });
    });
  }

  // ほかの人の別行動の小さなカード。押すとその人の道に切り替わる
  function renderBranchCard(branch) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'branch-card';
    var text = Core.branchCardText(Object.assign({}, branch, { name: branchOwnerName(branch) }), state.branchBlocks);
    b.innerHTML = BRANCH_ICON + '<span class="branch-card-text">' + escapeHtml(text) + '</span><span class="branch-card-go">この道を見る</span>';
    b.addEventListener('click', function () { setBranchView(branch.accountId); });
    return b;
  }

  // 選んだ人の別行動の見出し。持ち主（自分）には「予定を追加」「編集」を出す
  function renderBranchBand(branch) {
    var d = document.createElement('div');
    d.className = 'branch-band';
    d.innerHTML = BRANCH_ICON + '<span class="branch-band-text">' +
      escapeHtml(branchOwnerName(branch) + 'の別行動 ' + branch.startTime + '〜' + branch.endTime + (branch.title ? '（' + branch.title + '）' : '')) + '</span>';
    if (isMyBranch(branch.id)) {
      var add = document.createElement('button');
      add.type = 'button'; add.className = 'branch-band-btn'; add.textContent = '予定を追加';
      add.addEventListener('click', function () { openBlockForm(null, branch); });
      var edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'branch-band-btn'; edit.textContent = '編集';
      edit.addEventListener('click', function () { openBranchSheet(branch); });
      d.appendChild(add);
      d.appendChild(edit);
    }
    return d;
  }

  // タイムラインの下の「ここから別行動」。ログインしていない・参加していない人には、案内の文だけを出す
  function appendBranchAddArea(el) {
    if (!state.selectedDate) return;
    var user = loadCurrentUser();
    if (!Core.canUseBranches(user)) return; // 課金を始めたら、有料プランでない人はここで止まる
    var note = function (text) {
      var p = document.createElement('p');
      p.className = 'branch-hint';
      p.textContent = text;
      el.appendChild(p);
    };
    if (!user || !user.token) { note('ログインすると自分の別行動を追加できます'); return; }
    if (!amTripMember()) { note('この旅行に「参加する」と、自分の別行動を追加できます'); return; }
    var btn = document.createElement('button');
    btn.className = 'block-add branch-add';
    btn.innerHTML = BRANCH_ICON + '<span>ここから別行動</span>';
    btn.addEventListener('click', function () { openBranchSheet(null); });
    el.appendChild(btn);
  }

  // ---------- 別行動の追加・編集シート ----------
  var branchSheetTarget = null; // { id（編集のとき）, date }

  function defaultBranchRange(date) {
    var me = myAccountId();
    var starts = [13, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20];
    for (var i = 0; i < starts.length; i++) {
      var s = String(starts[i]).padStart(2, '0') + ':00', e = String(Math.min(23, starts[i] + 3)).padStart(2, '0') + ':00';
      if (!Core.validateBranch({ date: date, startTime: s, endTime: e }, state.branches, me)) return { start: s, end: e };
    }
    return { start: '', end: '' };
  }

  function openBranchSheet(branch) {
    var date = branch ? branch.date : state.selectedDate;
    if (!date) return;
    branchSheetTarget = { id: branch ? branch.id : '', date: date };
    var range = branch ? { start: branch.startTime, end: branch.endTime } : defaultBranchRange(date);
    $('#branchSheetTitle').textContent = branch ? '別行動を編集' : 'ここから別行動';
    $('#brDateText').textContent = Core.formatDateJp(date);
    $('#brStart').value = range.start;
    $('#brEnd').value = range.end;
    $('#brTitle').value = branch ? (branch.title || '') : '';
    $('#brStatus').textContent = '';
    $('#btnDeleteBranch').hidden = !branch;
    $('#branchSheet').hidden = false;
    document.body.classList.add('sheet-open');
  }

  function closeBranchSheet() {
    $('#branchSheet').hidden = true;
    document.body.classList.remove('sheet-open');
    branchSheetTarget = null;
  }

  function saveBranch() {
    if (!branchSheetTarget || !state.trip) return;
    var status = $('#brStatus');
    var target = branchSheetTarget;
    var me = myAccountId();
    var input = { date: target.date, startTime: $('#brStart').value || '', endTime: $('#brEnd').value || '', title: $('#brTitle').value.trim() };
    var reason = Core.validateBranch(input, state.branches, me, target.id);
    if (reason) { status.textContent = Core.branchErrorText(reason); return; }
    status.textContent = '保存中…';
    var req = target.id
      ? api('/branches/' + encodeURIComponent(target.id), 'PATCH', { startTime: input.startTime, endTime: input.endTime, title: input.title })
      : api('/trips/' + encodeURIComponent(state.trip.id) + '/branches', 'POST', input);
    req.then(function () { return refreshTrip(); }).then(function () {
      closeBranchSheet();
      // 作った・直したあとは、自分の道に切り替えて、その結果が見えるようにする
      state.viewAccountId = Core.resolveViewAccountId(me, state.branches);
      saveBranchView(state.trip.id, state.viewAccountId);
      renderTripDetail();
    }).catch(function (e) {
      if (Core.isLoginRequiredError(e)) { closeBranchSheet(); handleLoginRequired(e, 'tripDetail'); return; }
      status.textContent = Core.branchErrorText(e && e.message);
    });
  }

  function removeBranch() {
    if (!branchSheetTarget || !branchSheetTarget.id) return;
    if (!confirm('この別行動と、中の予定・記録をすべて削除しますか？')) return;
    var id = branchSheetTarget.id;
    api('/branches/' + encodeURIComponent(id), 'DELETE').then(function () { return refreshTrip(); }).then(function () {
      closeBranchSheet();
      saveBranchView(state.trip.id, state.viewAccountId);
      renderTripDetail();
    }).catch(function (e) {
      if (Core.isLoginRequiredError(e)) { closeBranchSheet(); handleLoginRequired(e, 'tripDetail'); return; }
      $('#brStatus').textContent = '削除に失敗しました。';
    });
  }

  // 「地図でふりかえる」「動画でシェア」に渡す予定：選んでいる人の道。時差はその並びで計算し直してから渡す
  function replayBlocks() {
    applyTripZones();
    return activeBlocks();
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
      // Blockの並べ替えドラッグ中（長押し待ちも含む）は「戻る」操作を割り込ませない
      if (blockDragState) { edgeSwipeBackState = null; return; }
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
    renderBranchSwitcher();
    renderTimeline(currentDayItems());
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

  // 場所（地名）はもう本人には入力させない。時差・マイログの訪れた国・自動配置のためだけに
  // 裏で使う（loadTripZonesのauto-place）。ここで見せるのは天気アイコンだけ（2026-09-26）。
  function renderDayWeather() {
    var btn = $('#dayWeather');
    $('#weatherEditPanel').hidden = true;
    if (!state.selectedDate) { btn.hidden = true; return; }
    btn.hidden = false;
    var info = findDayInfo(state.selectedDate);
    var manual = info && info.weatherManual ? Core.manualWeatherDisplay(info.weatherCode) : null;
    if (manual) {
      btn.classList.add('has-weather');
      btn.innerHTML = '<span aria-hidden="true">' + manual.icon + '</span> ' + escapeHtml(manual.label);
    } else {
      btn.classList.remove('has-weather');
      btn.textContent = '天気を選ぶ';
    }
    btn.onclick = function () { openWeatherEditPanel(info); };
  }

  function openWeatherEditPanel(info) {
    var panel = $('#weatherEditPanel');
    var manual = info && info.weatherManual ? Core.manualWeatherDisplay(info.weatherCode) : null;
    var picker = $('#weatherPicker');
    picker.querySelectorAll('.weather-picker-opt').forEach(function (el) {
      el.classList.toggle('on', manual ? el.dataset.code === String(manual.code) : el.dataset.code === '');
    });
    $('#weatherEditStatus').textContent = '';
    panel.hidden = false;
  }

  function saveWeatherEdit(codeStr) {
    if (!state.trip || !state.selectedDate) return;
    var status = $('#weatherEditStatus');
    var payload = { weatherCode: codeStr === '' ? null : Number(codeStr) };
    status.textContent = '保存中…';
    api('/trips/' + encodeURIComponent(state.trip.id) + '/days/' + encodeURIComponent(state.selectedDate) + '/weather', 'PATCH', payload)
      .then(function () { return refreshTrip(); })
      .then(function () {
        $('#weatherEditPanel').hidden = true;
        renderDayWeather();
      })
      .catch(function () { status.textContent = '保存に失敗しました。もう一度お試しください。'; });
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

  // 「🕒 ここから現地時間」の区切り。タップすると時差を手で直せる（openTzOverrideSheet、2026-09-29〜）
  function renderZoneDivider(block, base) {
    var div = document.createElement('button');
    div.type = 'button';
    div.className = 'zone-divider' + (block.tzOverride ? ' tz-overridden' : '');
    var from = base._tz === 'Asia/Tokyo' ? '日本' : '出発地';
    div.textContent = '🕒 ここから現地時間（' + zoneDisplayName(block._tz, block.date) + '・' + from + 'との時差 ' +
      Core.offsetDiffText(block._offset - base._offset) + '）';
    div.addEventListener('click', function () { openTzOverrideSheet(block.id); });
    return div;
  }

  // ---------- 時差の区切りを手で直す（docs/adr/0009。2026-09-29〜） ----------
  // 自動（地図の場所だけで決める）で間違っているときだけ、その予定1件の時差を手で直せる。
  // オーナー方針：「時差のところは人がいじれなくなっているので慎重に。間違っていたら削除くらいは
  // できてもいい。時間を変えられるのも、やりすぎない範囲で」（2026-09-29）。
  // 「その他…」で選べる主要なタイムゾーン（約20）。地図から出てこない場所へ行ったときの保険。
  var TZ_OVERRIDE_COMMON = [
    { tz: 'Asia/Tokyo', label: '日本（東京）' },
    { tz: 'Asia/Seoul', label: '韓国（ソウル）' },
    { tz: 'Asia/Shanghai', label: '中国（上海）' },
    { tz: 'Asia/Hong_Kong', label: '香港' },
    { tz: 'Asia/Taipei', label: '台湾（台北）' },
    { tz: 'Asia/Singapore', label: 'シンガポール' },
    { tz: 'Asia/Bangkok', label: 'タイ（バンコク）' },
    { tz: 'Asia/Dubai', label: 'ドバイ' },
    { tz: 'Asia/Kolkata', label: 'インド' },
    { tz: 'Europe/London', label: 'イギリス（ロンドン）' },
    { tz: 'Europe/Paris', label: 'フランス（パリ）' },
    { tz: 'Europe/Berlin', label: 'ドイツ（ベルリン）' },
    { tz: 'Europe/Rome', label: 'イタリア（ローマ）' },
    { tz: 'Europe/Moscow', label: 'ロシア（モスクワ）' },
    { tz: 'America/New_York', label: 'アメリカ東部（ニューヨーク）' },
    { tz: 'America/Chicago', label: 'アメリカ中部（シカゴ）' },
    { tz: 'America/Denver', label: 'アメリカ山岳部（デンバー）' },
    { tz: 'America/Los_Angeles', label: 'アメリカ西部（ロサンゼルス）' },
    { tz: 'Pacific/Honolulu', label: 'ハワイ' },
    { tz: 'America/Sao_Paulo', label: 'ブラジル（サンパウロ）' },
    { tz: 'Australia/Sydney', label: 'オーストラリア（シドニー）' },
    { tz: 'Pacific/Auckland', label: 'ニュージーランド（オークランド）' }
  ];

  var tzOverrideTarget = null;

  // この旅行に出てくる地図のタイムゾーン（重複なし。地図が求まった予定＝state.zoneInfo.byBlockの値）
  function tripPinnedZones() {
    var info = state.zoneInfo || {};
    var seen = {}, out = [];
    Object.keys(info.byBlock || {}).forEach(function (id) {
      var tz = info.byBlock[id];
      if (tz && !seen[tz]) { seen[tz] = true; out.push(tz); }
    });
    return out;
  }

  // タイムゾーン名から都市名らしきものを作る（Asia/Los_Angeles → Los Angeles）。選択肢の見出し用
  function tzCityLabel(tz) {
    var parts = (tz || '').split('/');
    return parts[parts.length - 1].replace(/_/g, ' ');
  }

  function openTzOverrideSheet(blockId) {
    var block = allBlocks().filter(function (b) { return b.id === blockId; })[0];
    if (!block) return;
    tzOverrideTarget = blockId;
    $('#tzOverrideStatus').textContent = '';
    renderTzOverrideMain(block);
    $('#tzOverrideSheet').hidden = false;
    document.body.classList.add('sheet-open');
  }

  function closeTzOverrideSheet() {
    $('#tzOverrideSheet').hidden = true;
    document.body.classList.remove('sheet-open');
    tzOverrideTarget = null;
  }

  function renderTzOverrideMain(block) {
    $('#tzOverrideCustom').hidden = true;
    $('#tzOverrideSheetNote').textContent =
      '自動では、地図の場所だけで時差を決めています。間違っているときだけ、この予定の時差を手で直せます。';
    var opts = $('#tzOverrideOptions');
    opts.innerHTML = '';
    var addBtn = function (text, onClick) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tz-override-opt';
      b.textContent = text;
      b.addEventListener('click', onClick);
      opts.appendChild(b);
      return b;
    };
    addBtn('この時差を取り消す（前の予定と同じ時間にする）', function () { saveTzOverride(block.id, 'inherit'); });
    addBtn('タイムゾーンを選ぶ', function () { renderTzOverrideZoneList(block); });
    if (block.tzOverride) addBtn('自動に戻す', function () { saveTzOverride(block.id, ''); });
  }

  function renderTzOverrideZoneList(block) {
    $('#tzOverrideCustom').hidden = true;
    var opts = $('#tzOverrideOptions');
    opts.innerHTML = '';
    var zones = tripPinnedZones().filter(function (tz) { return tz !== 'Asia/Tokyo'; });
    zones = ['Asia/Tokyo'].concat(zones);
    zones.forEach(function (tz) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tz-override-opt' + (block.tzOverride === tz ? ' on' : '');
      btn.textContent = tz === 'Asia/Tokyo' ? '日本' : tzCityLabel(tz);
      btn.addEventListener('click', function () { saveTzOverride(block.id, tz); });
      opts.appendChild(btn);
    });
    var other = document.createElement('button');
    other.type = 'button';
    other.className = 'tz-override-opt';
    other.textContent = 'その他…';
    other.addEventListener('click', function () { showTzOverrideCustomSelect(block); });
    opts.appendChild(other);
  }

  function showTzOverrideCustomSelect(block) {
    var wrap = $('#tzOverrideCustom');
    var sel = $('#tzOverrideCustomSelect');
    sel.innerHTML = TZ_OVERRIDE_COMMON.map(function (z) {
      return '<option value="' + escapeHtml(z.tz) + '"' + (block.tzOverride === z.tz ? ' selected' : '') + '>' + escapeHtml(z.label) + '</option>';
    }).join('');
    wrap.hidden = false;
    $('#btnApplyTzOverrideCustom').onclick = function () { saveTzOverride(block.id, sel.value); };
  }

  function saveTzOverride(blockId, value) {
    if (!state.trip) return;
    var status = $('#tzOverrideStatus');
    status.textContent = '保存中…';
    api('/blocks/' + encodeURIComponent(blockId), 'PATCH', { tzOverride: value || '' })
      .then(function () { return refreshTrip(); })
      .then(function () {
        closeTzOverrideSheet();
        renderDaySection();
      })
      .catch(function () { status.textContent = '保存できませんでした。もう一度お試しください。'; });
  }

  // ---------- 時差（docs/adr/0009） ----------
  // 予定ごとのタイムゾーンは、記録の地図の場所（座標がすぐ分かるものだけ）と、日ごとの場所（天気の場所）から
  // Worker（/timezone）に聞いて決める。旅行を開いたあと裏で調べ、分かったら並びと区切りを描き直す。
  // 結果は端末にも保存するので、2回目からは通信しない。
  var TZ_CACHE_KEY = 'tabilog:tz-cache';
  var DEVICE_TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } })();

  function applyTripZones() {
    if (!state.trip) return;
    var info = state.zoneInfo || { byBlock: {} };
    Core.applyBlockZones(state.blocks, Core.assignBlockZones(state.blocks, info.byBlock, DEVICE_TZ, info.byArrive));
    // 人ごとの道を見ているときは、その道の並び（別行動の予定を含む）で時差を計算し直す
    if (state.viewAccountId) {
      var visible = activeBlocks();
      Core.applyBlockZones(visible, Core.assignBlockZones(visible, info.byBlock, DEVICE_TZ, info.byArrive));
    }
  }

  function timezoneAt(lat, lng, cache) {
    var key = lat.toFixed(2) + ',' + lng.toFixed(2);
    if (cache[key]) return Promise.resolve(cache[key]);
    return api('/timezone?lat=' + lat.toFixed(4) + '&lng=' + lng.toFixed(4)).then(function (res) {
      if (res && res.timezone) cache[key] = res.timezone;
      return cache[key] || '';
    }).catch(function () { return ''; });
  }

  // 旅行を開いたあと裏で、①記録の地図の位置を調べ（座標入りはすぐ、住所・店名は1件ずつ）、
  // ②日ごとの場所が空いている日は、その日の最初の地図の位置から場所を自動で入れ（天気・マイログの
  // 訪れた国・時差のため。2026-09-26〜）、③予定・日ごとのタイムゾーンを決めて描き直す。
  // Nominatim（1秒1回まで）を使うものは、まとめて1件ずつ1.1秒空けて呼ぶ。
  var autoPlaceTried = {}; // この端末でこの画面を開いているあいだ、失敗した日を何度も試さない
  function loadTripZones() {
    if (!state.trip || !API_BASE) return Promise.resolve();
    var tripId = state.trip.id;
    var tzCache, geoCache;
    try { tzCache = JSON.parse(localStorage.getItem(TZ_CACHE_KEY) || '{}'); } catch (e) { tzCache = {}; }
    try { geoCache = JSON.parse(localStorage.getItem(GEOCODE_CACHE_KEY) || '{}'); } catch (e) { geoCache = {}; }
    var coordsByBlock = {}, pending = [];
    var stillHere = function () { return state.trip && state.trip.id === tripId; };
    var remember = function (q, res) {
      if (res && res.found) geoCache[q] = { lat: res.lat, lng: res.lng, at: Date.now() };
      return geoCache[q] && geoCache[q].lat !== undefined ? geoCache[q] : null;
    };
    // ① 座標がすぐ分かるものは同時に。entry.mapLat/mapLng（サーバーがすでに求めてある座標、Part A）が
    // あれば最優先で使い、/geocodeを呼ばない
    var quick = allBlocks().map(function (b) {
      var pe = Core.replayPlaceEntry(b);
      if (!pe) return null;
      var q = pe.url;
      if (typeof pe.lat === 'number' && typeof pe.lng === 'number') { coordsByBlock[b.id] = { lat: pe.lat, lng: pe.lng }; return null; }
      if (geoCache[q] && geoCache[q].lat !== undefined) { coordsByBlock[b.id] = geoCache[q]; return null; }
      return api('/geocode?quick=1&q=' + encodeURIComponent(q) + geocodeEntryParam(pe.entryId)).then(function (res) {
        if (res && res.pending) pending.push({ b: b, q: q, entryId: pe.entryId });
        else { var c = remember(q, res); if (c) coordsByBlock[b.id] = c; }
      }).catch(function () {});
    }).filter(Boolean);
    var wait = function (ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); };
    var saveCaches = function () {
      try { localStorage.setItem(TZ_CACHE_KEY, JSON.stringify(tzCache)); } catch (e) {}
      try { localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(geoCache)); } catch (e) {}
    };
    return Promise.all(quick).then(function () {
      // ①' 住所・店名だけのリンクは1件ずつ（以前はここを調べておらず、ロサンゼルスの時差が分からなかった）
      return pending.reduce(function (p, it) {
        return p.then(function (needWait) {
          if (!stillHere()) return false;
          return (needWait ? wait(1100) : Promise.resolve()).then(function () {
            var order = Core.sortBlocks(allBlocks());
            var stops = order.map(function (b) { return { date: b.date, transport: b.transport, coords: coordsByBlock[b.id] || null }; });
            return api(geocodeFullPath(it.q, it.b.label || '', stops, order.indexOf(it.b)) + geocodeEntryParam(it.entryId)).then(function (res) {
              var c = remember(it.q, res); if (c) coordsByBlock[it.b.id] = c;
              return !(res && res.cached);
            }).catch(function () { return false; });
          });
        });
      }, Promise.resolve(false));
    }).then(function () {
      // ② 日ごとの場所が空いている日を、その日の最初の地図の位置で埋める
      if (!stillHere()) return;
      var hasPlace = {};
      (state.days || []).forEach(function (d) { if (d.place) hasPlace[d.date] = true; });
      var firstByDate = {};
      Core.sortBlocks(state.blocks).forEach(function (b) {
        if (b.date && !firstByDate[b.date] && coordsByBlock[b.id]) firstByDate[b.date] = coordsByBlock[b.id];
      });
      var dates = Object.keys(firstByDate).filter(function (d) { return !hasPlace[d] && !autoPlaceTried[tripId + d]; });
      return dates.reduce(function (p, date, i) {
        return p.then(function () {
          if (!stillHere()) return;
          autoPlaceTried[tripId + date] = true;
          return (i ? wait(1100) : Promise.resolve()).then(function () {
            var c = firstByDate[date];
            return api('/trips/' + encodeURIComponent(tripId) + '/days/' + encodeURIComponent(date) + '/auto-place', 'POST', { lat: c.lat, lng: c.lng })
              .then(function (res) {
                if (!res || !res.day || !stillHere()) return;
                state.days = (state.days || []).filter(function (d) { return d.date !== date; }).concat([res.day]);
              }).catch(function () {});
          });
        });
      }, Promise.resolve());
    }).then(function () {
      // ③ タイムゾーン（記録の地図の場所だけで決める。docs/adr/0009、2026-09-29）
      if (!stillHere()) return;
      var byBlock = {}, byArrive = {};
      // 移動の予定の到着地の地図（2026-09-27〜）。座標が保存されていればそれを、無ければ/geocodeで求める
      var arriveJobs = allBlocks().map(function (b) {
        var a = Core.travelArrival(b);
        if (!a) return null;
        var coords = typeof a.lat === 'number' && typeof a.lng === 'number' ? Promise.resolve({ lat: a.lat, lng: a.lng })
          : geoCache[a.url] && geoCache[a.url].lat !== undefined ? Promise.resolve(geoCache[a.url])
          : api('/geocode?quick=1&q=' + encodeURIComponent(a.url)).then(function (res) { return remember(a.url, res); }).catch(function () { return null; });
        return coords.then(function (c) {
          if (!c) return;
          return timezoneAt(c.lat, c.lng, tzCache).then(function (tz) { if (tz) byArrive[b.id] = tz; });
        });
      }).filter(Boolean);
      var jobs = arriveJobs.concat(Object.keys(coordsByBlock).map(function (id) {
        var c = coordsByBlock[id];
        return timezoneAt(c.lat, c.lng, tzCache).then(function (tz) { if (tz) byBlock[id] = tz; });
      }));
      return Promise.all(jobs).then(function () {
        saveCaches();
        if (!stillHere()) return;
        state.zoneInfo = { byBlock: byBlock, byArrive: byArrive };
        if ($('.screen.active') && $('.screen.active').dataset.screen === 'tripDetail') renderDaySection();
      });
    }).then(function () { return backfillLodgingPlaceNames(); });
  }

  // 既存の宿泊の記録（v26＝map_place_name追加より前に座標だけ保存済みのもの）にも、あとから
  // 地図の場所の名前を入れる後追い（2026-09-30）。旅行を開くたび（loadTripZones）に、宿泊の予定の
  // 最初の記録で「地図URLはあるがmapPlaceNameがまだ無い」ものを、最大3件・1.1秒空けて順に
  // /geocode?...&name=1で調べる。この画面を開いているあいだ、同じ記録を何度も試さない
  // （lodgingNameTried）。座標はもう分かっている前提なので、ここでは名前だけを聞く・保存する
  // （worker側のgeocodeEntryNameOnlyは既存の座標を絶対に上書きしない）。
  var lodgingNameTried = {};
  function backfillLodgingPlaceNames() {
    if (!state.trip || !API_BASE) return Promise.resolve();
    var tripId = state.trip.id;
    var stillHere = function () { return state.trip && state.trip.id === tripId; };
    var wait = function (ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); };
    var targets = [];
    (state.blocks || []).forEach(function (b) {
      if (b.category !== 'lodging') return;
      var e = (b.entries || [])[0];
      if (!e || !e.id || !e.mapUrl || e.mapPlaceName) return;
      if (lodgingNameTried[e.id]) return;
      targets.push(e);
    });
    targets = targets.slice(0, 3);
    return targets.reduce(function (p, e, i) {
      return p.then(function () {
        if (!stillHere()) return;
        lodgingNameTried[e.id] = true;
        return (i ? wait(1100) : Promise.resolve()).then(function () {
          return api('/geocode?q=' + encodeURIComponent(e.mapUrl) + '&entry=' + encodeURIComponent(e.id) + '&name=1').then(function (res) {
            if (res && res.name && stillHere()) {
              e.mapPlaceName = res.name;
              if ($('.screen.active') && $('.screen.active').dataset.screen === 'tripDetail') renderTripDetail();
            }
          }).catch(function () {});
        });
      });
    }, Promise.resolve());
  }

  function renderTimeline(items) {
    var el = $('#timeline');
    el.innerHTML = '';
    // items：Core.dayTimelineItemsの結果（予定・ほかの人の別行動のカード・選んだ人の別行動の帯）
    var blocks = items.filter(function (i) { return i.type === 'block'; }).map(function (i) { return i.block; });
    if (!items.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'この日の記録はまだありません。下のボタンから追加できます。';
      el.appendChild(empty);
    }
    // 時差の違う場所に移ったところに「ここから現地時間（時差）」の区切りを入れる（docs/adr/0009）。
    // この日の最初の予定は、旅行全体の並びで直前の予定と比べる（前の日から続く移動のため）。
    var all = Core.sortBlocks(activeBlocks());
    var base = all.filter(function (b) { return typeof b._offset === 'number'; })[0];
    var prevOffset = null;
    if (blocks.length) {
      var at = all.indexOf(blocks[0]);
      for (var i = at - 1; i >= 0; i--) { if (typeof all[i]._offset === 'number') { prevOffset = all[i]._offset; break; } }
    }
    // 時差の区切りがある日（または手で並べた日）は、時刻のある予定も手で並べ替えられるようにする（2026-09-27）。
    // 時差をまたぐ日は、時刻どおりの並びが実際の順番と合わないことがあるため
    var dayDate = blocks.length ? blocks[0].date : '';
    var hasManual = Core.dayHasManualOrder(state.blocks, dayDate);
    var zoneChange = false, chkPrev = prevOffset;
    blocks.forEach(function (b) {
      if (typeof b._offset !== 'number') return;
      if (typeof chkPrev === 'number' && b._offset !== chkPrev) zoneChange = true;
      chkPrev = b._offset;
    });
    // 人ごとの道を見ているあいだは、並べ替え（みんなの予定の順番を変える操作）は出さない
    state.manualDay = !!dayDate && !state.viewAccountId && (hasManual || zoneChange);
    items.forEach(function (item) {
      if (item.type === 'card') { el.appendChild(renderBranchCard(item.branch)); return; }
      if (item.type === 'band') { el.appendChild(renderBranchBand(item.branch)); return; }
      var block = item.block;
      var dividerShown = false;
      if (base && typeof block._offset === 'number' && typeof prevOffset === 'number' && block._offset !== prevOffset) {
        el.appendChild(renderZoneDivider(block, base));
        dividerShown = true;
      }
      if (typeof block._offset === 'number') prevOffset = block._offset;
      el.appendChild(renderBlockEl(block, dividerShown));
    });
    if (state.manualDay) {
      // 手で並べた日は「自動の並びに戻す」、まだなら並べ替えられることの案内を出す
      var manualNote = document.createElement('div');
      manualNote.className = 'manual-order-note';
      manualNote.innerHTML = hasManual
        ? '<span>この日は手で並べた順番で表示しています。</span><button type="button" class="btn text" id="btnResetManualOrder">自動の並びに戻す</button>'
        : '<span>時差のある日は、⋮⋮ をドラッグすると時刻と関係なく並べ替えられます。</span>';
      el.appendChild(manualNote);
      var resetBtn = manualNote.querySelector('#btnResetManualOrder');
      if (resetBtn) resetBtn.addEventListener('click', function () { resetManualOrder(dayDate); });
    }
    var addBtn = document.createElement('button');
    addBtn.className = 'block-add';
    addBtn.innerHTML = plusIcon() + '<span>予定を追加</span>';
    addBtn.addEventListener('click', function () { openBlockForm(null); });
    el.appendChild(addBtn);
    appendBranchAddArea(el);

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

    // 時差の並びを調べるボタン。URLに ?zonedebug を付けたときだけ出す（実データで並びがおかしいときの調査用。2026-09-27）
    if (blocks.length && /[?&]zonedebug\b/.test(location.search || '')) {
      var diagBtn = document.createElement('button');
      diagBtn.className = 'zone-diag-btn';
      diagBtn.textContent = '時差の並びを調べる（開発用）';
      diagBtn.addEventListener('click', function () { showZoneDiagnostics(blocks[0].date); });
      el.appendChild(diagBtn);
    }
  }

  function zoneDiagnosticsText(date) {
    var info = state.zoneInfo || { byBlock: {} };
    var zones = Core.assignBlockZones(state.blocks, info.byBlock, DEVICE_TZ, info.byArrive);
    var short = function (tz) { return tz ? String(tz).replace(/^.*\//, '') : '-'; };
    var dates = (state.days || []).map(function (d) { return d.date; });
    var lines = ['device=' + DEVICE_TZ, 'day=' + date, 'loaded=' + !!info.byArrive];
    Core.sortBlocks(state.blocks).forEach(function (b, i) {
      var pe = Core.replayPlaceEntry(b), arr = Core.travelArrival(b);
      lines.push([
        'B' + i, (b.date || 'nodate').slice(5), b.time || '--:--', JSON.stringify(b.transport === undefined ? 'u' : b.transport), b.category || '', (b.label || '').slice(0, 16),
        'map=' + (pe ? (typeof pe.lat === 'number' ? pe.lat.toFixed(2) + ',' + pe.lng.toFixed(2) : 'url') : 'なし'),
        'own=' + short((info.byBlock || {})[b.id]),
        'arr=' + (arr ? (typeof arr.lat === 'number' ? '座標' : 'url') + '/' + short((info.byArrive || {})[b.id]) + '/' + (arr.time || '') : 'なし'),
        'mv=' + (b.moveMinutes || ''), 'c=' + (b.createdAt || '').slice(5, 16),
        'ov=' + (b.tzOverride || ''),
        '→' + short(zones[b.id])
      ].join(' '));
    });
    void dates;
    return lines.join('\n');
  }
  function showZoneDiagnostics(date) {
    var text = zoneDiagnosticsText(date);
    var wrap = document.createElement('div');
    wrap.className = 'zone-diag';
    var ta = document.createElement('textarea');
    ta.readOnly = true;
    ta.value = text;
    var copy = document.createElement('button');
    copy.className = 'btn primary wide';
    copy.textContent = 'コピーする';
    copy.addEventListener('click', function () {
      ta.select();
      var done = function () { copy.textContent = 'コピーしました'; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { try { document.execCommand('copy'); done(); } catch (e) {} });
      else { try { document.execCommand('copy'); done(); } catch (e) {} }
    });
    var close = document.createElement('button');
    close.className = 'btn ghost';
    close.textContent = '閉じる';
    close.addEventListener('click', function () { wrap.remove(); });
    wrap.appendChild(ta); wrap.appendChild(copy); wrap.appendChild(close);
    document.body.appendChild(wrap);
  }

  var DRAG_HANDLE_ICON = '<svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><circle cx="6" cy="5" r="1.4"/><circle cx="14" cy="5" r="1.4"/><circle cx="6" cy="10" r="1.4"/><circle cx="14" cy="10" r="1.4"/><circle cx="6" cy="15" r="1.4"/><circle cx="14" cy="15" r="1.4"/></svg>';
  var MOVE_ICON = '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10h12M11 6l4 4-4 4"/></svg>';
  var ALBUM_PLAY_ICON = '<svg width="26" height="26" viewBox="0 0 20 20" fill="currentColor"><path d="M6.5 4.5v11l9-5.5z"/></svg>';
  var SETTLE_ARROW_ICON = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10h13M11 6l5 4-5 4"/></svg>';

  function renderBlockEl(block, dividerShown) {
    var wrap = document.createElement('div');
    wrap.className = 'block' + (block.branchId ? ' branch-block' : '');
    wrap.dataset.blockId = block.id;
    // 別行動の中の予定は持ち主だけが直せる。ほかの人には見るだけ（サーバーでも同じ確認をしている）
    var editable = canEditBlockUi(block);

    var head = document.createElement('div');
    head.className = 'block-head' + (editable ? '' : ' readonly');
    head.innerHTML =
      // 時刻ありのBlockは常にその時刻の位置に固定するため、持ち手（ドラッグでの並べ替え）は
      // 時刻未設定のBlockにだけ出す
      (!block.branchId && !state.viewAccountId && (!block.time || state.manualDay) ? '<button type="button" class="block-drag-handle" aria-label="ならべかえる">' + DRAG_HANDLE_ICON + '</button>' : '') +
      (block.time ? '<span class="block-time">' + escapeHtml(block.time) + '</span>' : '') +
      '<span class="block-label">' + escapeHtml(block.label || Core.categoryLabel(block.category)) + '</span>' +
      '<span class="block-cat" style="background:color-mix(in oklch,' + Core.categoryColor(block.category) + ' 18%, white);color:' + Core.categoryColor(block.category) + '">' + escapeHtml(Core.categoryLabel(block.category)) + '</span>' +
      (block.category === 'transport' && (block.transport || block.moveMinutes)
        ? '<span class="block-move">' + (block.transport ? transportIconSvg(block.transport, 13) : '') +
          escapeHtml([Core.transportLabel(block.transport), block.moveMinutes ? '約' + Core.minutesText(block.moveMinutes) : ''].filter(Boolean).join('・')) + '</span>'
        : '');
    head.addEventListener('click', function (e) {
      if (e.target.closest('.block-drag-handle')) return;
      if (editable) openBlockForm(block);
    });
    wrap.appendChild(head);

    // 時差を手で直している（block.tzOverride）が、区切り（renderZoneDivider）が出ない予定
    // （直前と同じ時差に取り消した・区切りが元から出ない場所）にも、直したことが分かる印を出す
    // （2026-09-29〜。押すとdivierと同じ手直しシートを開ける）
    if (block.tzOverride && !dividerShown) {
      var tzNote = document.createElement('button');
      tzNote.type = 'button';
      tzNote.className = 'tz-overridden-note tz-overridden-note-inline';
      tzNote.textContent = '時差を手で直しています';
      tzNote.addEventListener('click', function (e) { e.stopPropagation(); openTzOverrideSheet(block.id); });
      wrap.appendChild(tzNote);
    }

    var entriesWrap = document.createElement('div');
    entriesWrap.className = 'entries';
    (block.entries || []).forEach(function (entry) {
      entriesWrap.appendChild(renderEntryEl(block, entry));
    });
    wrap.appendChild(entriesWrap);

    if (editable) {
      var addEntryBtn = document.createElement('button');
      addEntryBtn.className = 'entry-add';
      addEntryBtn.innerHTML = plusIcon() + '<span>' + ((block.entries || []).length ? '別の記録を追加（別行動など）' : '記録を追加') + '</span>';
      addEntryBtn.addEventListener('click', function (e) { e.stopPropagation(); openEntryForm(block.id, null); });
      wrap.appendChild(addEntryBtn);
    }

    return wrap;
  }

  // ---------- Blockの並べ替え（ドラッグ、時刻未設定のBlockだけ） ----------
  // 「感覚的に引っ張って場所を変えたい」という要望より。時刻ありのBlockは常にその時刻の
  // 位置で固定したいので、持ち手（.block-drag-handle）自体を時刻未設定のBlockにしか出していない。
  // iOSの標準的な並べ替え（連絡先など）に近い手触りを目指し、以下のようにしている（2026-09-29〜。
  // 「かなりしづらい」というオーナーからの声を受けて、それまでの「即ドラッグ開始＋挿入位置に
  // 細い線を出すだけ」の作りから作り直した）：
  // - 持ち手を押してから約350ms長押ししたときだけ持ち上がる（それより前に8pxを超えて指が
  //   動いたら、ふつうのスクロール操作に譲って並べ替えは始めない）
  // - つかんだBlockは指にtransformで追従し、他のBlockはtransformのトランジション（約150ms）で
  //   場所を譲る。どこに入るかはCore.blockDragTargetIndex／Core.blockDragShifts（純粋関数、
  //   テストあり）でそのつど計算する
  // - 画面の上下端（48px以内）に近づくと自動スクロールする（端に近いほど速い）
  // - 指を離すと、実際の挿入位置へ「着地」するアニメーションをしてから並び順を保存する
  // - マウス（デスクトップ）は長押し不要で、押したその場でつかむ
  var blockDragState = null;
  var BLOCK_DRAG_LONG_PRESS_MS = 350;
  var BLOCK_DRAG_MOVE_CANCEL_PX = 8;
  var BLOCK_DRAG_EDGE_PX = 48;
  var BLOCK_DRAG_MAX_SCROLL_PX = 16;

  function initBlockDragReorder() {
    var timelineEl = $('#timeline');

    function collectDraggables() {
      return Array.prototype.slice.call(timelineEl.querySelectorAll('.block'))
        .filter(function (el) { return el.querySelector('.block-drag-handle'); });
    }

    function autoScroll(state) {
      var y = state.lastClientY, vh = window.innerHeight, delta = 0;
      if (y < BLOCK_DRAG_EDGE_PX) delta = -Math.ceil((BLOCK_DRAG_EDGE_PX - y) / BLOCK_DRAG_EDGE_PX * BLOCK_DRAG_MAX_SCROLL_PX);
      else if (y > vh - BLOCK_DRAG_EDGE_PX) delta = Math.ceil((y - (vh - BLOCK_DRAG_EDGE_PX)) / BLOCK_DRAG_EDGE_PX * BLOCK_DRAG_MAX_SCROLL_PX);
      if (delta) window.scrollBy(0, delta);
    }

    function updateVisual(state) {
      var dy = (state.lastClientY + window.scrollY) - state.startPageY;
      state.draggedEl.style.transform = 'translateY(' + dy + 'px) scale(1.03)';

      var draggedCenter = state.draggedOrigCenter + dy;
      var otherCenters = state.others.map(function (o) { return o.center; });
      var targetIndex = Core.blockDragTargetIndex(draggedCenter, otherCenters);
      if (targetIndex !== state.targetIndex) {
        state.targetIndex = targetIndex;
        var shifts = Core.blockDragShifts(state.others.length, targetIndex, state.gapIndex, state.draggedHeight);
        state.others.forEach(function (o, i) {
          o.el.style.transform = shifts[i] ? 'translateY(' + shifts[i] + 'px)' : '';
        });
      }
    }

    function activate(state) {
      var draggableBlocks = collectDraggables();
      var origIdx = draggableBlocks.indexOf(state.draggedEl);
      if (origIdx === -1) { blockDragState = null; return; }

      var others = [];
      draggableBlocks.forEach(function (el, i) {
        if (i === origIdx) return;
        others.push({ el: el, center: el.offsetTop + el.offsetHeight / 2 });
      });

      state.phase = 'dragging';
      state.originalOrder = draggableBlocks.map(function (el) { return el.dataset.blockId; });
      state.others = others;
      state.gapIndex = origIdx;
      state.targetIndex = origIdx;
      state.draggedHeight = state.draggedEl.offsetHeight;
      state.draggedOrigCenter = state.draggedEl.offsetTop + state.draggedHeight / 2;
      state.startPageY = state.lastClientY + window.scrollY;

      try { state.handle.setPointerCapture(state.pointerId); } catch (err) {}
      state.draggedEl.classList.add('dragging');
      others.forEach(function (o) { o.el.classList.add('block-shift'); });
      try { if (navigator.vibrate) navigator.vibrate(10); } catch (err) {}

      // 「持ち上げた」感触を出すため、つかんだ瞬間だけ一瞬トランジション付きで拡大させる。
      // その後は毎フレームtransformを直接書き換えるので、追従が遅れないようトランジションを消す
      state.draggedEl.style.transition = 'transform 120ms ease, box-shadow 120ms ease';
      state.draggedEl.style.transform = 'translateY(0px) scale(1.03)';
      setTimeout(function () {
        if (blockDragState === state) state.draggedEl.style.transition = '';
      }, 130);

      state.rafId = requestAnimationFrame(function frame() {
        if (blockDragState !== state || state.phase !== 'dragging') return;
        autoScroll(state);
        updateVisual(state);
        state.rafId = requestAnimationFrame(frame);
      });
    }

    function releaseOthers(state) {
      state.others.forEach(function (o) { o.el.classList.remove('block-shift'); o.el.style.transform = ''; });
    }

    function settle(state) {
      cancelAnimationFrame(state.rafId);
      releaseOthers(state);

      var beforeRect = state.draggedEl.getBoundingClientRect();
      var addBtn = timelineEl.querySelector('.block-add');
      var anchor = state.targetIndex < state.others.length ? state.others[state.targetIndex].el : addBtn;
      state.draggedEl.style.transform = '';
      state.draggedEl.classList.remove('dragging');
      timelineEl.insertBefore(state.draggedEl, anchor);

      // 着地アニメーション：DOM移動でずれた見た目の分だけ逆向きにtransformをかけ、0へ戻す
      var afterRect = state.draggedEl.getBoundingClientRect();
      var deltaY = beforeRect.top - afterRect.top;
      if (deltaY) {
        var draggedEl = state.draggedEl;
        draggedEl.style.transition = 'none';
        draggedEl.style.transform = 'translateY(' + deltaY + 'px)';
        void draggedEl.offsetHeight; // 強制リフローしてから、トランジション付きで戻す
        draggedEl.classList.add('settling');
        requestAnimationFrame(function () {
          draggedEl.style.transition = '';
          draggedEl.style.transform = '';
        });
        draggedEl.addEventListener('transitionend', function handler() {
          draggedEl.classList.remove('settling');
          draggedEl.style.transition = '';
          draggedEl.removeEventListener('transitionend', handler);
        });
      }

      var finalOrder = collectDraggables().map(function (el) { return el.dataset.blockId; });
      if (finalOrder.join(',') !== state.originalOrder.join(',')) persistBlockOrder(finalOrder);
    }

    function cancelDrag(state) {
      cancelAnimationFrame(state.rafId);
      if (state.phase === 'dragging') {
        releaseOthers(state);
        state.draggedEl.classList.remove('dragging');
        state.draggedEl.style.transform = '';
        state.draggedEl.style.transition = '';
      }
    }

    timelineEl.addEventListener('pointerdown', function (e) {
      var handle = e.target.closest('.block-drag-handle');
      if (!handle) return;
      var draggedEl = handle.closest('.block');
      if (!draggedEl || blockDragState) return;
      e.preventDefault();

      var state = {
        phase: 'pending', handle: handle, draggedEl: draggedEl, pointerId: e.pointerId,
        startClientX: e.clientX, startClientY: e.clientY, lastClientY: e.clientY, timer: null
      };
      blockDragState = state;

      // マウスは長押し不要（デスクトップは押したその場でつかむ）。指はスクロールと区別するため
      // 長押しを待つ（この間に8pxを超えて動いたらpointermoveハンドラーが並べ替えを取り消す）
      if (e.pointerType === 'mouse') {
        activate(state);
      } else {
        state.timer = setTimeout(function () {
          if (blockDragState === state && state.phase === 'pending') activate(state);
        }, BLOCK_DRAG_LONG_PRESS_MS);
      }
    });

    timelineEl.addEventListener('pointermove', function (e) {
      if (!blockDragState || e.pointerId !== blockDragState.pointerId) return;
      var state = blockDragState;
      state.lastClientY = e.clientY;

      if (state.phase === 'pending') {
        var dx = e.clientX - state.startClientX, dy = e.clientY - state.startClientY;
        if (Math.sqrt(dx * dx + dy * dy) > BLOCK_DRAG_MOVE_CANCEL_PX) {
          clearTimeout(state.timer);
          blockDragState = null; // ふつうのスクロールに譲る
        }
        return;
      }
      if (state.phase === 'dragging') e.preventDefault();
    }, { passive: false });

    timelineEl.addEventListener('pointerup', function (e) {
      if (!blockDragState || e.pointerId !== blockDragState.pointerId) return;
      var state = blockDragState;
      blockDragState = null;
      try { state.handle.releasePointerCapture(state.pointerId); } catch (err) {}
      if (state.phase === 'pending') { clearTimeout(state.timer); return; }
      settle(state);
    });

    timelineEl.addEventListener('pointercancel', function (e) {
      if (!blockDragState || e.pointerId !== blockDragState.pointerId) return;
      var state = blockDragState;
      blockDragState = null;
      try { state.handle.releasePointerCapture(state.pointerId); } catch (err) {}
      if (state.phase === 'pending') { clearTimeout(state.timer); return; }
      cancelDrag(state);
    });

    // iOSの長押しコールアウト・右クリックメニューなどが割り込んでこないようにする
    timelineEl.addEventListener('contextmenu', function (e) {
      if (blockDragState) e.preventDefault();
    });
  }

  function resetManualOrder(date) {
    if (!state.trip || !date) return;
    api('/trips/' + encodeURIComponent(state.trip.id) + '/days/' + encodeURIComponent(date) + '/blocks/reorder', 'PATCH', { clear: true })
      .then(function () { return refreshTrip(); })
      .then(function () { renderDaySection(); })
      .catch(function () { alert('元に戻せませんでした。もう一度お試しください。'); });
  }

  function persistBlockOrder(blockIds) {
    if (!state.trip || !state.selectedDate) return;
    // 時差のある日（手で並べられる日）は、時刻に関係なくその日全体の並びとして保存する
    var body = state.manualDay ? { blockIds: blockIds, manual: true } : { blockIds: blockIds };
    api('/trips/' + encodeURIComponent(state.trip.id) + '/days/' + encodeURIComponent(state.selectedDate) + '/blocks/reorder', 'PATCH', body)
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
    // 別行動の中の記録は持ち主だけが直せる（ほかの人には写真を見るだけ）。別の予定への移動もみんなの予定だけ
    var editable = canEditBlockUi(block);
    var canMove = editable && !block.branchId;

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
          return '<div class="cost-line"><span>' + escapeHtml(it.label) + '</span><span>' + escapeHtml(Core.formatCostItemAmount(it)) + '</span></div>';
        }).join('') +
        '<div class="cost-line total"><span>計</span><span>' + escapeHtml(Core.formatYen(Core.entryCostTotal(entry))) + '</span></div>' +
        '</div>'
      : '';

    var metaBits = [];
    if (entry.waitTime) metaBits.push('<span>待ち時間 ' + escapeHtml(entry.waitTime) + '</span>');
    // 地図のリンクが壊れている（以前の不具合で query=undefined,undefined になった等）・URLでないときは、
    // 普通の「地図」リンクに見せず、直すよう案内する。押すと記録の編集が開き、見出しで場所を探し直せる。
    // 壊れた地図は、地図でふりかえる・時差でも使えない（場所が分からない）ため（2026-09-27）
    var mapUnusable = entry.mapUrl && (!/^https?:\/\//i.test(entry.mapUrl.trim()) || Core.hasBrokenMapQuery(entry.mapUrl.trim()));
    if (mapUnusable) metaBits.push('<span class="map-broken">地図の場所が読み取れません・押して直す</span>');
    else if (entry.mapUrl) metaBits.push('<a href="' + escapeHtml(entry.mapUrl) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">地図</a>');
    // この記録がその日いちばん最初の記録（＝Blockの代表の地図）で、前後の予定から800km以上離れた
    // ピンを持っている（かつ前後どうしは300km未満）ときは、ピンを間違えている可能性が高い
    // （例：別の都市に泊まっている日に、前の街の家のピンが残っていた）。押して直せるよう、記録の
    // 編集導線がある「地図」リンクのすぐ下に注意書きを出す（Core.findFarMapOutlierBlockIds、2026-09-29）。
    if (!mapUnusable && (block.entries || [])[0] === entry && Core.findFarMapOutlierBlockIds(state.blocks || [])[block.id]) {
      metaBits.push('<span class="map-far-outlier">この地図は前後の予定から遠く離れています（地図が違うかもしれません）</span>');
    }
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
      (canMove
        ? '<div class="entry-card-head">' +
            '<button type="button" class="entry-move-btn" aria-label="別の予定に移動">' + MOVE_ICON + '<span>移動</span></button>' +
            '<button type="button" class="entry-drag-handle" aria-label="ドラッグで別の予定に移動">' + DRAG_HANDLE_ICON + '</button>' +
          '</div>' +
          '<div class="entry-move-menu" hidden></div>'
        : '') +
      (entry.time ? '<div class="entry-time">' + escapeHtml(entry.time) + '</div>' : '') +
      (entry.episode ? '<div class="entry-episode">' + escapeHtml(entry.episode) + '</div>' : '') +
      (entry.comment ? '<div class="entry-comment">「' + escapeHtml(entry.comment) + '」</div>' : '') +
      photosHtml +
      videosHtml +
      '<div class="entry-author">記録：' + escapeHtml(entry.author || '匿名') + '</div>' +
      ratingHtml +
      costHtml +
      (metaBits.length ? '<div class="entry-meta">' + metaBits.join('') + '</div>' : '') +
      // いいね・コメントの行は一時的に隠す（FEATURES.social、2026-09-26〜。サーバー機能は残す）
      (FEATURES.social ? '<div class="entry-social" data-entry-id="' + escapeHtml(entry.id) + '">' + socialButtonsHtml('entry', entry.id) + '</div>' : '');

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
      if (editable) openEntryForm(block.id, entry);
    });
    if (canMove) {
      $('.entry-move-btn', card).addEventListener('click', function (e) {
        e.stopPropagation();
        toggleEntryMoveMenu(card, entry.id, block.id);
      });
    }
    return card;
  }

  // 「移動」ボタン：同じ日の他の予定を一覧で出し、選ぶとそこへ記録を移す
  // （指でのドラッグ操作がしづらい場合の代わり）。
  function toggleEntryMoveMenu(card, entryId, currentBlockId) {
    var menu = $('.entry-move-menu', card);
    var wasOpen = !menu.hidden;
    $all('.entry-move-menu').forEach(function (m) { m.hidden = true; m.innerHTML = ''; });
    if (wasOpen) return;

    // 移動先は、同じ日の、同じ別行動の中（みんなの予定どうし）の予定だけ
    var currentBlock = allBlocks().filter(function (b) { return b.id === currentBlockId; })[0];
    var targets = currentDayBlocks().filter(function (b) {
      return b.id !== currentBlockId && (b.branchId || '') === ((currentBlock && currentBlock.branchId) || '');
    });
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
      if (blockEl && (blockEl.dataset.blockId === entryDragState.sourceBlockId || blockEl.classList.contains('branch-block'))) blockEl = null;
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
    shinkansen: '<rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 10h14"/><circle cx="9" cy="13.5" r="1"/><circle cx="15" cy="13.5" r="1"/><path d="M8.5 17l-2.5 4M15.5 17l2.5 4"/>',
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
  // branch：別行動の中に新しい予定を作るときの、その別行動（編集のときは予定自身のbranchIdから決まる）
  function openBlockForm(block, branch) {
    state.editingBlockId = block ? block.id : null;
    var br = block && block.branchId ? branchById(block.branchId) : (branch || null);
    state.editingBranchId = br ? br.id : '';
    state.formCategory = block ? block.category : 'sightseeing';
    // 移動手段が保存されているのは種類「移動」のときだけ（以前のデータで他の種類に付いていても出さない）
    state.formTransport = block && block.category === 'transport' ? (block.transport || '') : '';
    // 以前のデータで、移動以外の予定に付いている「ここまでの移動手段」は、画面には出さないが、種類を
    // 変えない限り保存し直しても消さない（地図でふりかえるの乗り物に使っているため）
    state.formLegacyTransport = block && block.category !== 'transport' ? (block.transport || '') : '';
    var mm = block ? (block.moveMinutes || 0) : 0;
    $('#blkMoveHours').value = mm ? Math.floor(mm / 60) : '';
    $('#blkMoveMins').value = mm ? mm % 60 : '';
    $('#blkFormTitle').textContent = (br ? '別行動の予定を' : '予定を') + (block ? '編集' : '追加');
    $('#blkDate').value = br ? br.date : (block ? block.date : (state.selectedDate || new Date().toISOString().slice(0, 10)));
    // 別行動の中の予定は、別行動の日から動かせない（サーバーでも固定している）
    $('#blkDate').disabled = !!br;
    var branchNote = $('#blkBranchNote');
    branchNote.hidden = !br;
    branchNote.textContent = br ? branchOwnerName(br) + 'の別行動（' + br.startTime + '〜' + br.endTime + '）の中の予定です。時刻は、この時間帯の中で入れてください。' : '';
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
    // 「到着」も「移動」の隣に並ぶ通常のチップにする（以前は「移動」を選んだときの
    // 「出発｜到着」タブで選ぶ形だった。2026-09-27）
    el.innerHTML = Core.CATEGORIES.map(function (c) {
      var on = c.key === state.formCategory;
      return '<button type="button" class="cat-chip' + (on ? ' on' : '') + '" data-cat="' + c.key + '">' + escapeHtml(c.label) + '</button>';
    }).join('');
    $all('.cat-chip', el).forEach(function (b) {
      b.addEventListener('click', function () {
        state.formCategory = b.dataset.cat;
        // 種類を「移動」以外に変えたら、選んでいた移動手段（飛行機など）は消す。「到着」は移動手段を
        // 持たない（ここまでの移動手段は、直前の「移動」の予定から地図でふりかえるが引き継ぐ）
        if (state.formCategory !== 'transport') state.formTransport = '';
        state.formLegacyTransport = '';
        renderCategoryChips();
        renderTransportChips();
      });
    });
    // 移動手段・移動時間は、種類が「移動」のときだけ出す（「到着」も含めて他の種類では出さない。2026-09-27）
    var isTransportCat = state.formCategory === 'transport';
    $('#blkMoveFields').hidden = !isTransportCat;
    $('#blkMoveTimeWrap').hidden = !isTransportCat;
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
    // 別行動の中の予定の時刻は、別行動の時間帯の中に入れる（外だと、その人の道の並びと合わなくなるため）
    var editBranch = state.editingBranchId ? branchById(state.editingBranchId) : null;
    var timeVal = $('#blkTime').value || '';
    if (editBranch && timeVal && (timeVal < editBranch.startTime || timeVal > editBranch.endTime)) {
      status.textContent = '時刻は、別行動の時間帯（' + editBranch.startTime + '〜' + editBranch.endTime + '）の中で入れてください。';
      return;
    }
    status.textContent = '保存中…';
    var payload = {
      date: $('#blkDate').value || '',
      time: $('#blkTime').value || '',
      label: label,
      category: state.formCategory,
      // 移動手段を選べるのは種類が「移動」のときだけ。種類を切り替えたら選んでいた移動手段は消す
      // （以前のデータの「ここまでの移動手段」は、種類を変えない限りそのまま）
      transport: state.formCategory === 'transport' ? (state.formTransport || '') : (state.formLegacyTransport || ''),
      moveMinutes: state.formCategory === 'transport' ? readMoveMinutes() : 0
    };
    if (!state.editingBlockId && state.editingBranchId) payload.branchId = state.editingBranchId;
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
    }).catch(function (e) {
      status.textContent = e && e.message === 'forbidden' ? Core.branchErrorText('forbidden') : '保存に失敗しました。もう一度お試しください。';
    });
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
      if (it.currency) copy.currency = it.currency;
      if (typeof it.rate === 'number') copy.rate = it.rate;
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
    // 地図のURLがクライアント側の不具合で壊れて保存されたもの（query=undefined,undefinedなど）は、
    // そのまま出すと地図が開けないだけでなく、次に開いたときにも壊れたまま残ってしまう。
    // 欄を空にして、選び直してもらうよう案内する（2026-09-27、大阪旅行で見つかった不具合）
    var brokenMapUrl = !!(entry && entry.mapUrl && Core.hasBrokenMapQuery(entry.mapUrl));
    $('#entMapUrl').value = entry && !brokenMapUrl ? entry.mapUrl : '';
    $('#entShopUrl').value = entry ? entry.shopUrl : '';
    $('#entOtherUrl').value = entry ? entry.otherUrl : '';
    $('#entMoreFields').open = !!(entry && (entry.comment || entry.detail || entry.waitTime || entry.shopUrl || entry.otherUrl ||
      (entry.travel && Object.keys(entry.travel).length)));
    // 壊れた地図を直しに来たときは、予定の見出しで探せるよう検索欄に入れておく
    var formBlock = brokenMapUrl ? allBlocks().filter(function (b) { return b.id === blockId; })[0] : null;
    $('#entPlaceSearch').value = formBlock && formBlock.category !== 'transport' ? (formBlock.label || '') : '';
    $('#entMapPreview').hidden = true;
    $('#entPlaceCandidates').hidden = true;
    placeCandidates = []; placeChoice = '';
    selectedPlaceName = ''; selectedPlaceNameUrl = '';
    $('#entPlaceStatus').textContent = brokenMapUrl ? '地図のリンクが壊れていたので、選び直してください' : '';
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
    return allBlocks().filter(function (b) { return b.id === state.entryBlockId; })[0] || null;
  }

  // ---------- 移動の情報（紹介文用。docs/adr/0007） ----------
  // 移動の予定の記録だけに出す。★はつけない（誰が見ても同じ事実なので、記録そのものに持つ）。
  function renderTravelFields(entry) {
    var block = entryFormBlock();
    var isMove = !!(block && block.category === 'transport');
    // 「移動の情報」（出発地・到着地・会社・時刻・料金）は飛行機のときだけ出す。車・電車などは到着地の地図だけで
    // 足りるので、入力欄が多くて煩わしくならないようにする（2026-09-27）。隠していても、すでに入っている値は
    // 欄に残して、保存のときにそのまま送る（消えないように）
    $('#entTravelField').hidden = !(isMove && Core.isPlaneMove(block));
    $('#entArriveField').hidden = !isMove;
    // 移動の予定では、上の地図の欄は出発地、下の欄が到着地（2026-09-27〜）
    $('#entMapLabel').textContent = isMove ? '出発地の地図（任意）' : '地図のURL（任意）';
    $('#entArriveCandidates').hidden = true;
    $('#entArriveSearch').value = '';
    arrivePlaces = [];
    var t0 = (entry && entry.travel) || {};
    formArrive = { url: t0.arriveMapUrl || '', lat: t0.arriveLat, lng: t0.arriveLng };
    $('#entArriveMapUrl').value = isMove ? (t0.arriveMapUrl || '') : '';
    if (!isMove) return;
    var t = t0;
    $('#entTravelFrom').value = t.from || '';
    $('#entTravelTo').value = t.to || '';
    $('#entTravelCompany').value = t.company || '';
    $('#entTravelDepart').value = t.depart || '';
    $('#entTravelArrive').value = t.arrive || '';
    $('#entTravelAmount').value = typeof t.amount === 'number' ? t.amount : '';
    updateTravelDuration();
  }

  // 出発の時刻は、この予定自身の時刻を使う（2026-09-29〜、以前は「移動の情報」の中に別で
  // 出発時刻の欄があったが、入力を減らすため無くした。隠れた#entTravelDepartの欄は
  // 古い記録の値をそのまま保存し直すためだけに残してある）
  function updateTravelDuration() {
    var block = entryFormBlock();
    // 別行動の中の予定なら、同じ別行動の中で次の予定を探す（みんなの予定の並びには入っていない）
    var all = Core.sortBlocks(block && block.branchId
      ? (state.branchBlocks || []).filter(function (b) { return b.branchId === block.branchId; })
      : state.blocks);
    var next = block && all.indexOf(block) !== -1 ? all[all.indexOf(block) + 1] : null;
    var depOff = block ? block._offset : undefined, arrOff = next ? next._offset : undefined;
    var dep = block ? (block.time || '') : '', arr = $('#entTravelArrive').value;
    var d = Core.travelDurationText(dep, arr, depOff, arrOff);
    var info = Core.travelDuration(dep, arr, depOff, arrOff);
    var notes = [];
    if (typeof depOff === 'number' && typeof arrOff === 'number' && depOff !== arrOff) notes.push('時差' + Core.offsetDiffText(arrOff - depOff));
    if (info && info.dayShift) notes.push('到着は現地の' + (Core.dayShiftPrefix(info.dayShift) === '翌' ? '翌日' : Core.dayShiftPrefix(info.dayShift)));
    $('#entTravelDuration').textContent = d ? '所要時間：' + d + (notes.length ? '（' + notes.join('・') + '）' : '') : '';
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
    var arriveUrl = $('#entArriveMapUrl').value.trim();
    if (arriveUrl && !Core.hasBrokenMapQuery(arriveUrl)) {
      out.arriveMapUrl = arriveUrl;
      // 候補から選んだ座標は、URLがそのときのままなら一緒に保存する（手で書き換えたら座標は送らない）
      if (formArrive.url === arriveUrl && isFinite(formArrive.lat) && isFinite(formArrive.lng)) {
        out.arriveLat = formArrive.lat;
        out.arriveLng = formArrive.lng;
      }
    }
    return out;
  }

  // ---------- 到着地の地図（移動の予定だけ。2026-09-27〜） ----------
  // 出発地の地図（上の欄）と同じ場所の候補（Places API (New)）を使う。プレビューの地図は出さず、候補を選ぶと
  // 座標つきのURLが入る
  var arrivePlaces = [], arriveSession = '', arrivePending = null;
  var formArrive = { url: '', lat: null, lng: null };
  function searchArrivePlace() {
    var q = $('#entArriveSearch').value.trim();
    if (!q) return;
    var status = $('#entArriveStatus'), list = $('#entArriveCandidates');
    status.textContent = '候補を探しています…';
    arriveSession = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'pl-' + Date.now().toString(36);
    api('/places/search?q=' + encodeURIComponent(q) + '&session=' + encodeURIComponent(arriveSession)).then(function (res) {
      arrivePlaces = (res && res.places) || [];
      if (!arrivePlaces.length) {
        list.hidden = true;
        status.textContent = '候補が見つかりませんでした。地図のURLを直接貼り付けることもできます。';
        return;
      }
      list.innerHTML = '<div class="place-list-head"><span>到着地を選ぶ</span><span class="place-count">' + arrivePlaces.length + '件</span></div>' +
        arrivePlaces.map(function (p, i) {
          return '<div class="place-card" data-arrive-choice="' + i + '" role="button" tabindex="0"><span class="place-num">' + (i + 1) + '</span>' +
            '<div class="place-text"><div class="place-name">' + escapeHtml(p.name) + '</div>' +
            (p.address ? '<div class="place-address">' + escapeHtml(p.address) + '</div>' : '') + '</div><span class="place-pick">選択</span></div>';
        }).join('');
      list.hidden = false;
      status.textContent = '到着地を選んでください。';
    }).catch(function () { status.textContent = '候補を取得できませんでした。地図のURLを直接貼り付けることもできます。'; });
  }
  function chooseArrivePlace(i) {
    var p = arrivePlaces[i];
    if (!p) return;
    $all('[data-arrive-choice]', $('#entArriveCandidates')).forEach(function (el) {
      var on = el.getAttribute('data-arrive-choice') === String(i);
      el.classList.toggle('on', on);
      el.querySelector('.place-pick').textContent = on ? '選択中' : '選択';
    });
    var status = $('#entArriveStatus');
    var need = !(isFinite(p.lat) && isFinite(p.lng)) && p.placeId;
    var req = need
      ? api('/places/details?id=' + encodeURIComponent(p.placeId) + '&session=' + encodeURIComponent(arriveSession)).then(function (res) {
        if (res && res.found && isFinite(res.lat) && isFinite(res.lng)) { p.lat = res.lat; p.lng = res.lng; }
      }).catch(function () {})
      : Promise.resolve();
    if (need) status.textContent = '場所を確かめています…';
    arrivePending = req.then(function () {
      arrivePending = null;
      var url = Core.placeMapUrl(p, $('#entArriveSearch').value);
      if (!url) return;
      $('#entArriveMapUrl').value = url;
      formArrive = { url: url, lat: isFinite(p.lat) ? p.lat : null, lng: isFinite(p.lng) ? p.lng : null };
      status.textContent = '到着地に「' + p.name + '」を入れました。';
    });
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
    $('#entMoreSummary').textContent = 'もっと書く（ひとこと・詳細・URLなど）';
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
    var summary = $('#entMoreSummary');
    if (!k || !review) { el.hidden = true; summary.textContent = 'もっと書く（ひとこと・詳細・URLなど）'; return; }
    el.hidden = false;
    // ★以外の細かいレビュー項目は、たたんだ「詳細」の欄の中に出す。すでに書いてあれば開いておく
    summary.textContent = 'もっと書く（' + k.label + 'のレビュー・ひとこと・詳細など）';
    if (Object.keys(review).length) $('#entMoreFields').open = true;
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
  // 旅行ごとに「最後に選んだ通貨」を覚えておき、次の明細行の初期値にする（同じ旅行では
  // 同じ通貨の支払いが続くことが多いため。トリップをまたいだ使い回しはしない）。
  var LAST_COST_CURRENCY_PREFIX = 'tabilog:last-currency:';
  // 外貨のレートを取りに行っている最中のPromise（idxごと）。保存（saveEntry）はこれの完了を待ってから、
  // レートが入っているか確かめる（2026-09-27）
  var pendingRateFetches = {};
  function lastCostCurrencyForTrip() {
    if (!state.trip) return '';
    try { return localStorage.getItem(LAST_COST_CURRENCY_PREFIX + state.trip.id) || ''; } catch (e) { return ''; }
  }
  function rememberLastCostCurrency(code) {
    if (!state.trip) return;
    try { localStorage.setItem(LAST_COST_CURRENCY_PREFIX + state.trip.id, code); } catch (e) { /* 保存できなくても致命的ではない */ }
  }

  // 明細1行の.cost-rate-row（外貨のときだけ出す、レート表示・手直し欄）の要素参照。
  // renderCostItems()のたびに作り直す（立て替えパネルが行の間に挟まるため、
  // 「#entCostItemsの何番目の子か」では数えられない。行を作った時点の参照を直接持っておく）。
  var costRateRowEls = [];

  // 費用の明細（costItems）は、基本は「個人（またはそのサブグループ）が実際に払った金額」を
  // そのまま入れる（CONTEXT.md参照）。駐車場代など全体でまとめて払ったものを人数で割りたい
  // ときは、下記「立て替え」機能で全体の金額をそのまま入れ、払った人・割る人を選ぶ
  // （以前あった「全体費用÷人数」電卓は、金額欄の意味が「個人費用」と「全体の金額」の
  // どちらか曖昧になり、立て替え機能と併用すると二重に割ってしまう事故のもとだったため廃止した）。
  // 「立て替え」（誰が払った・誰と割るか）は任意項目。触らなければ、これまでどおり
  // 「本人の個人費用」として扱われ、割り勘の精算画面（貸し借り）には出てこない。
  //
  // 円以外の通貨（DAY31〜）：行ごとにcurrencyを選べる。円以外を選ぶと、その日（Blockの日付）の
  // レートを/ratesから自動取得し（本人が金額を直せるのと同様、レートも直せる。カード明細の
  // 実際のレートに合わせられるように）、精算はすべて円換算後の金額（costItemJpy）で行う。
  function renderCostItems() {
    var el = $('#entCostItems');
    el.innerHTML = '';
    costRateRowEls = [];
    var block = entryFormBlock();
    var blockDate = (block && block.date) || '';
    state.formCostItems.forEach(function (item, idx) {
      var row = document.createElement('div');
      row.className = 'cost-item-row';
      var payerLabel = item.paidBy ? (item.paidBy + 'が立替') : '立て替えを設定';
      var currency = item.currency || 'JPY';
      var isForeign = currency !== 'JPY';
      var isKnown = Core.COST_CURRENCIES.indexOf(currency) !== -1;
      var showOther = item._customCurrency || !isKnown;
      var selectVal = showOther ? '__other' : currency;
      var options = Core.COST_CURRENCIES.map(function (c) {
        return '<option value="' + c + '"' + (c === selectVal ? ' selected' : '') + '>' + (c === 'JPY' ? '円' : c) + '</option>';
      }).join('') + '<option value="__other"' + (selectVal === '__other' ? ' selected' : '') + '>その他</option>';
      // 375px幅のiPhoneで「内容・金額・通貨・×」を1行に詰め込むと金額欄が数文字幅まで潰れて
      // プレースホルダーが縦の線のようにしか見えなくなっていた（オーナー指摘）ため、
      // 1行目＝内容（幅いっぱい）、2行目＝金額・通貨・×、の2段に分ける（2026-09-28）。
      row.innerHTML =
        '<div class="cost-item-line1">' +
          '<input type="text" class="cost-item-label" placeholder="内容（例：そば）" value="' + escapeHtml(item.label) + '">' +
        '</div>' +
        '<div class="cost-item-line2">' +
          '<input type="number" class="cost-item-amount" min="0" step="' + (isForeign ? '0.01' : '1') + '" inputmode="decimal" placeholder="' + (isForeign ? '金額' : '円') + '" value="' + (typeof item.amount === 'number' && item.amount ? item.amount : '') + '">' +
          '<select class="cost-currency-select">' + options + '</select>' +
          '<input type="text" class="cost-currency-other" placeholder="例：ISK" maxlength="3" value="' + ((showOther && currency !== 'JPY') ? escapeHtml(currency) : '') + '"' + (showOther ? '' : ' hidden') + '>' +
          '<button type="button" aria-label="削除">×</button>' +
        '</div>' +
        '<div class="cost-rate-row" hidden></div>' +
        '<div class="cost-item-row-actions">' +
          '<button type="button" class="cost-payer-toggle' + (item.paidBy ? ' on' : '') + '" aria-label="立て替えを設定">' + escapeHtml(payerLabel) + '</button>' +
        '</div>';
      var inputs = row.querySelectorAll('input');
      var textInput = inputs[0], amountInput = inputs[1], otherInput = row.querySelector('.cost-currency-other');
      var currencySelect = row.querySelector('.cost-currency-select');
      var rateRow = row.querySelector('.cost-rate-row');
      costRateRowEls[idx] = rateRow;

      textInput.addEventListener('input', function (e) { state.formCostItems[idx].label = e.target.value; });
      amountInput.addEventListener('input', function (e) {
        var cur = state.formCostItems[idx];
        if ((cur.currency || 'JPY') === 'JPY') {
          cur.amount = Math.max(0, parseInt(e.target.value, 10) || 0);
        } else {
          var v = parseFloat(e.target.value);
          cur.amount = (isFinite(v) && v >= 0) ? v : 0;
        }
        renderCostTotal();
        updateRateRowConverted(idx);
      });

      function applyCurrency(code) {
        var cur = state.formCostItems[idx];
        var prev = cur.currency || 'JPY';
        delete cur._customCurrency;
        if (code === prev) { renderCostItems(); return; }
        cur.currency = code === 'JPY' ? undefined : code;
        delete cur.rate; delete cur._rateDate; delete cur._rateSource;
        cur.amount = code === 'JPY' ? Math.round(cur.amount || 0) : Math.round((cur.amount || 0) * 100) / 100;
        if (code !== 'JPY') rememberLastCostCurrency(code);
        renderCostItems();
      }

      currencySelect.addEventListener('change', function (e) {
        var v = e.target.value;
        if (v === '__other') {
          state.formCostItems[idx]._customCurrency = true;
          renderCostItems();
          return;
        }
        applyCurrency(v);
      });
      otherInput.addEventListener('input', function (e) {
        var code = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
        if (e.target.value !== code) e.target.value = code;
        if (code.length === 3) applyCurrency(code);
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
      ensureRateForItem(idx, blockDate);
    });
    renderCostTotal();
  }

  // rate入力欄以外は毎回作り直す（レート取得結果が変わったときだけ）が、換算後の金額（円）は
  // 金額欄・レート欄の入力のたびに変わるので、フォーカスを奪わないようテキストだけ差し替える。
  function updateRateRowConverted(idx) {
    var rateRow = costRateRowEls[idx];
    if (!rateRow) return;
    var el = rateRow.querySelector('.cost-rate-converted');
    if (el) el.textContent = '→ ' + Core.formatYen(Core.costItemJpy(state.formCostItems[idx]));
  }

  // 外貨の行だけ、その日（Blockの日付）のレートを/ratesから自動取得する。すでにrateを
  // 持っていれば（保存済みの記録を編集中、など）取り直さない＝本人が直した値を尊重する。
  function ensureRateForItem(idx, blockDate) {
    var item = state.formCostItems[idx];
    if (!item || !item.currency || item.currency === 'JPY') { buildRateRow(idx); return; }
    if (typeof item.rate === 'number' && item.rate > 0) { buildRateRow(idx); return; }
    buildRateRow(idx, { loading: true });
    // 保存（saveEntry）は、これが終わるまで待ってから外貨のレートが入っているか確かめる（2026-09-27）
    var req = api('/rates?date=' + encodeURIComponent(blockDate || '') + '&currency=' + encodeURIComponent(item.currency))
      .then(function (res) {
        var cur = state.formCostItems[idx];
        if (!cur || cur.currency !== item.currency) return; // その間に通貨を変え直していたら古い結果は捨てる
        cur.rate = res.rate;
        cur._rateDate = res.date;
        cur._rateSource = res.source;
        buildRateRow(idx);
        renderCostTotal();
      })
      .catch(function () { buildRateRow(idx, { failed: true }); });
    pendingRateFetches[idx] = req.then(function () { delete pendingRateFetches[idx]; }, function () { delete pendingRateFetches[idx]; });
  }

  // レート行の中身を（レート欄の入力中を除いて）丸ごと作り直す。
  function buildRateRow(idx, opts) {
    opts = opts || {};
    var rateRow = costRateRowEls[idx];
    if (!rateRow) return;
    var item = state.formCostItems[idx];
    var currency = item && item.currency;
    if (!item || !currency || currency === 'JPY') { rateRow.hidden = true; rateRow.innerHTML = ''; return; }
    rateRow.hidden = false;
    if (opts.loading) { rateRow.innerHTML = '<p class="hint">レートを取得中…</p>'; return; }
    var hasRate = typeof item.rate === 'number' && item.rate > 0;
    var warn = '';
    // 保存しようとしたのにレートが入っていないとき、行のすぐ下に出す（saveEntry。2026-09-27）
    if (opts.blockedSave) warn = 'レートを入れてください（1 ' + currency + ' = ◯円）';
    else if (opts.failed || !hasRate) warn = 'レートを取得できませんでした。手入力してください。';
    else if (item._rateSource === 'currency-api-latest') warn = 'この日のレートが無いため最新のレートです。明細に合わせて直してください。';
    var dateText = item._rateDate ? item._rateDate.slice(0, 4) + '/' + item._rateDate.slice(5, 7) + '/' + item._rateDate.slice(8, 10) : '';
    var rateLine = hasRate
      ? ('1 ' + currency + ' = ' + item.rate.toLocaleString('ja-JP', { maximumFractionDigits: 4 }) + '円' + (dateText ? '（' + dateText + 'のレート）' : ''))
      : ('1 ' + currency + ' のレートを入力してください');
    rateRow.innerHTML =
      '<div class="cost-rate-line">' + escapeHtml(rateLine) + '</div>' +
      '<div class="cost-rate-edit"><span>1 ' + escapeHtml(currency) + ' =</span>' +
      '<input type="number" class="cost-rate-input" step="0.0001" min="0" value="' + (hasRate ? item.rate : '') + '"><span>円</span></div>' +
      '<div class="cost-rate-converted">→ ' + escapeHtml(Core.formatYen(Core.costItemJpy(item))) + '</div>' +
      (warn ? '<p class="hint cost-rate-warn">' + escapeHtml(warn) + '</p>' : '');
    rateRow.querySelector('.cost-rate-input').addEventListener('input', function (e) {
      item.rate = parseFloat(e.target.value) || 0;
      updateRateRowConverted(idx);
      renderCostTotal();
    });
  }

  function renderCostTotal() {
    var total = state.formCostItems.reduce(function (s, it) { return s + Core.costItemJpy(it); }, 0);
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
      // レシート読み取り結果の通貨は、今このフォームで使っている通貨（この旅行で最後に選んだ
      // 通貨。無ければ円）に合わせる（読み取り自体はまだ通貨を判定していないため）。
      var scanCurrency = lastCostCurrencyForTrip();
      items.forEach(function (it) {
        var newItem = { label: (it.label || '').trim() };
        if (scanCurrency && scanCurrency !== 'JPY') {
          newItem.currency = scanCurrency;
          newItem.amount = Math.max(0, Math.round((it.amount || 0) * 100) / 100);
        } else {
          newItem.amount = Math.max(0, Math.round(it.amount || 0));
        }
        state.formCostItems.push(newItem);
      });
      renderCostItems();
      status.textContent = items.length + '件の明細を追加しました。内容を確認してください。';
    }).catch(function (e) {
      $('#btnScanReceipt').disabled = false;
      var msg = (e && e.message) || '';
      if (msg === 'server_not_configured') status.textContent = 'この機能はまだ使えません（サーバー側の設定が必要です）。';
      else if (msg === 'rate_limited') status.textContent = '少し時間をおいてからもう一度お試しください。';
      else if (msg === 'ai_quota_exhausted') status.textContent = 'AIの利用枠がいっぱいのため、今は読み取れません（運営側で対応します）。明細は手で入力できます。';
      else if (msg === 'invalid_model_output' || msg === 'upstream_error') status.textContent = 'うまく読み取れませんでした。もう一度お試しください。';
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
  // 候補は、プルダウンだと中身が見えず選びにくかったので、番号・名前・住所・「選択」ボタンのカードで並べる。
  var placeCandidates = [];
  var PLACE_GOOGLE = 'google';
  var placeChoice = ''; // 選んでいる候補の番号（文字列）か PLACE_GOOGLE
  // 「地図のURL」欄に自動で入れたURLと、そのとき選ばれていた場所の名前（Core.placeSelectionName）の組。
  // saveEntryのときに#entMapUrlがこのURLのままなら（＝保存前に手で書き換えていなければ）、
  // 名前も一緒に送る。手でURLを書き換えた・消したときは一致しなくなるので送らない（2026-09-29）
  var selectedPlaceName = '';
  var selectedPlaceNameUrl = '';
  var placeSessionToken = ''; // Places API (New) のAutocomplete〜Details一連の呼び出しをまとめる印（docs/adr/0011）
  // 座標を取りに行っている（ensureSelectedPlaceCoordsが返した）Promise。保存（saveEntry）は、これが
  // 終わるのを待ってから地図欄を確定させる（届く前に保存すると、座標付きの正しいURLではなく
  // 検索文字列のURLで保存されてしまうため。2026-09-27）
  var placeCoordsPending = null;

  // 検索を始めるたびに新しく作る（1検索＝1セッションのほうが、Autocompleteの無料枠の数え方に合うため）。
  // crypto.randomUUIDが無い古いWebViewのための保険であって、暗号的な強さは求めていない。
  function newPlaceSession() {
    placeSessionToken = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'pl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    return placeSessionToken;
  }

  // Places API (New) のAutocomplete候補は座標を持たない（placeIdだけ）ことがある。
  // 選ばれている候補にまだ座標が無ければ、選ばれた時点でだけ/places/detailsを呼んで座標を足す
  // （候補を並べる時点で全件のdetailsを呼ぶと、選ばれなかった分の無料枠を無駄に使ってしまうため）。
  function ensureSelectedPlaceCoords() {
    var p = selectedPlace();
    if (!p || (isFinite(p.lat) && isFinite(p.lng)) || !p.placeId) return Promise.resolve(p);
    var status = $('#entPlaceStatus');
    status.textContent = '場所を確かめています…';
    var req = api('/places/details?id=' + encodeURIComponent(p.placeId) + '&session=' + encodeURIComponent(placeSessionToken))
      .then(function (res) {
        // res.found でも座標が数値でなければ（壊れた応答の保険）、undefined/NaNのまま入れない
        if (res && res.found && isFinite(res.lat) && isFinite(res.lng)) {
          p.lat = res.lat;
          p.lng = res.lng;
          if (res.address && !p.address) p.address = res.address;
        }
        status.textContent = '';
        return p;
      }).catch(function () {
        status.textContent = '場所の座標を取得できませんでした。';
        return p;
      });
    placeCoordsPending = req.then(function (r) { placeCoordsPending = null; return r; });
    return req;
  }

  function renderPlaceCandidates(place) {
    var list = $('#entPlaceCandidates');
    // カード全体をタップして選べるように、data-place-choiceはカード自身に付ける（ボタンは見た目のラベルとして残す）。
    // 以前はボタンだけがタップの対象で、名前や住所の文字をタップしても選択が1番目のままだったため。
    var card = function (value, num, name, sub) {
      var on = placeChoice === value;
      return '<div class="place-card' + (on ? ' on' : '') + '" data-place-choice="' + value + '" role="button" tabindex="0">' +
        '<span class="place-num">' + num + '</span>' +
        '<div class="place-text"><div class="place-name">' + escapeHtml(name) + '</div>' +
        (sub ? '<div class="place-address">' + escapeHtml(sub) + '</div>' : '') + '</div>' +
        '<span class="place-pick">' + (on ? '選択中' : '選択') + '</span></div>';
    };
    list.innerHTML = '<div class="place-list-head"><span>候補から選ぶ</span><span class="place-count">' + placeCandidates.length + '件</span></div>' +
      placeCandidates.map(function (p, i) { return card(String(i), i + 1, p.name, p.address); }).join('') +
      card(PLACE_GOOGLE, '?', '候補にない場合', '「' + place + '」をGoogleマップで検索');
    list.hidden = false;
  }

  function showPlaceMapPreview() {
    var place = $('#entPlaceSearch').value.trim();
    if (!place) return;
    var list = $('#entPlaceCandidates');
    var status = $('#entPlaceStatus');
    status.textContent = '候補を探しています…';
    list.hidden = true;
    var session = newPlaceSession(); // 検索し直すたびに新しいセッション（Autocomplete〜Detailsの一連）にする
    api('/places/search?q=' + encodeURIComponent(place) + '&session=' + encodeURIComponent(session)).then(function (res) {
      placeCandidates = (res && res.places) || [];
      placeChoice = placeCandidates.length ? '0' : PLACE_GOOGLE;
      renderPlaceCandidates(place);
      status.textContent = placeCandidates.length
        ? '1番目の場所を地図に出しています。違う場所なら、候補から選び直してください。'
        : '候補が見つかりませんでした。Googleマップの検索結果を表示しています。';
      return ensureSelectedPlaceCoords();
    }).then(function () {
      previewSelectedPlace();
      applySelectedPlaceToMapUrl();
    }).catch(function () {
      // 候補が取れなくても、これまでどおりGoogleマップの検索結果は見られるようにする
      placeCandidates = [];
      placeChoice = PLACE_GOOGLE;
      list.hidden = true;
      status.textContent = '';
      previewSelectedPlace();
      applySelectedPlaceToMapUrl();
    });
  }

  function choosePlaceCandidate(value) {
    placeChoice = value;
    renderPlaceCandidates($('#entPlaceSearch').value.trim());
    ensureSelectedPlaceCoords().then(function () {
      previewSelectedPlace();
      applySelectedPlaceToMapUrl();
      var preview = $('#entMapPreview');
      if (preview && preview.scrollIntoView) preview.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  function selectedPlace() {
    return placeChoice === PLACE_GOOGLE || placeChoice === '' ? null : placeCandidates[Number(placeChoice)] || null;
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
      applySelectedPlaceToMapUrl(); // ピンで位置を直したら、地図欄のURLもその位置に更新する
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

  // 候補が選ばれるたび（検索直後の1番目の自動選択・候補カードのタップ・座標取得後・ピンを動かしたとき）に、
  // 自動で地図欄のURLを埋める（以前は「このURLを地図欄に入れる」ボタンを押す手順が要ったが、
  // 押し忘れて地図欄が空のまま保存されることがあったため、2026-09-26に自動化した）。
  // 座標がまだ無ければ（「Googleマップで検索」を選んでいるときなど）検索した文字列そのままで検索するURLにする。
  // 座標（p.lat/p.lng）が数値として揃っているときだけ座標のURLにする。まだ座標が届いていない・
  // 壊れているとき（undefined/NaN）は、検索した文字列そのままのURLにする（undefined/NaNを含む
  // URLは絶対に書き込まない。2026-09-27）
  function applySelectedPlaceToMapUrl() {
    var searchText = $('#entPlaceSearch').value;
    var place = selectedPlace();
    var url = Core.placeMapUrl(place, searchText);
    if (!url) return;
    $('#entMapUrl').value = url;
    selectedPlaceName = Core.placeSelectionName(place, searchText);
    selectedPlaceNameUrl = url;
  }

  // 外貨の行で、まだレートが（自動取得も手入力も）入っていないもの。保存を止める対象（2026-09-27）
  function costItemsMissingRate() {
    return state.formCostItems.map(function (it, idx) { return { it: it, idx: idx }; })
      .filter(function (x) { return x.it.currency && x.it.currency !== 'JPY' && !(typeof x.it.rate === 'number' && x.it.rate > 0); });
  }

  function saveEntry() {
    var status = $('#entFormStatus');
    if (!API_BASE) { status.textContent = 'サーバーが未設定のため保存できません。'; return; }
    status.textContent = '確認中…';
    // 座標を取りに行っている最中（候補を選んだ直後など）なら、届くのを待ってから地図欄を確定させる。
    // 待たずに保存すると、座標付きの正しいURLではなく検索文字列のURLで保存されてしまう（2026-09-27）
    var missingRate = costItemsMissingRate();
    Promise.all(
      [placeCoordsPending || Promise.resolve(), arrivePending || Promise.resolve()].concat(missingRate.map(function (x) { return pendingRateFetches[x.idx] || Promise.resolve(); }))
    ).then(function () {
      // 保険：候補を選んだのに地図欄が空のまま保存されそうなら、ここで埋める
      if (!$('#entMapUrl').value.trim() && selectedPlace()) applySelectedPlaceToMapUrl();
      // 外貨のレートが（待っても）入っていなければ、ここで保存を止め、行のすぐ下に案内を出す
      // （以前は「保存に失敗しました」という分かりにくい表示になっていた）
      var stillMissing = costItemsMissingRate();
      if (stillMissing.length) {
        stillMissing.forEach(function (x) { buildRateRow(x.idx, { blockedSave: true }); });
        status.textContent = 'レートを入れてください（1 ' + stillMissing[0].it.currency + ' = ◯円）';
        var rowEl = costRateRowEls[stillMissing[0].idx];
        if (rowEl && rowEl.scrollIntoView) rowEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      continueSaveEntry(status);
    });
  }

  function continueSaveEntry(status) {
    var author = $('#entAuthor').value.trim();
    // 新しく選んだ動画があるときは、アップロードに時間がかかることを添える（2026-09-27）
    status.textContent = (state.pendingVideos || []).length ? '保存中…（動画の保存は時間がかかります）' : '保存中…';

    var payload = {
      episode: $('#entEpisode').value.trim(),
      comment: $('#entComment').value.trim(),
      detail: $('#entDetail').value.trim(),
      costItems: state.formCostItems.filter(function (it) { return it.label.trim() || it.amount; })
        .map(function (it) {
          var currency = (it.currency && it.currency !== 'JPY') ? it.currency : undefined;
          var amount = currency ? Math.round((it.amount || 0) * 100) / 100 : Math.round(it.amount || 0);
          var out = { label: it.label.trim() || '費用', amount: amount };
          if (currency) out.currency = currency;
          if (currency && typeof it.rate === 'number' && it.rate > 0) out.rate = Math.round(it.rate * 10000) / 10000;
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
    if (!$('#entArriveField').hidden) payload.travel = readTravelFields();
    // 場所の名前は、地図欄が「候補を選んで自動で入れたURL」のままのときだけ送る（手でURLを
    // 書き換えたり消したりしたら selectedPlaceNameUrl と一致しなくなるので送らない。2026-09-29）
    if (selectedPlaceName && payload.mapUrl === selectedPlaceNameUrl) payload.mapPlaceName = selectedPlaceName;

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
    if (Core.needsFreshLogin(user)) { forceRelogin('mylog'); return; }
    showScreen('mylog');
    $('#mylogTripList').innerHTML = skeletonCardsHtml(2);
    $('#mylogList').innerHTML = skeletonCardsHtml(3);
    api('/mylog?email=' + encodeURIComponent(user.email)).then(function (data) {
      state.myLogItems = data.items || [];
      state.myLogTrips = data.trips || [];
      state.myLogPlaces = data.places || { prefectures: [], countries: [], tripPlaces: [] };
      renderMyLog();
    }).catch(function (e) {
      if (handleLoginRequired(e, 'mylog')) return;
      $('#mylogList').innerHTML = '<div class="empty">マイログの読み込みに失敗しました。</div>';
    });
    // プランの状態はプロフィール画面がメインだが、マイログ見出しのplanBadgeTop（残り回数の
    // 一目バッジ）もここで最新化しておく（renderPlanStatusはプロフィール画面のDOMも一緒に更新するが、
    // 今アクティブな画面がどちらでも副作用は無い）。
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
    // Appleの審査ガイドライン3.1.1（アプリ内課金の対象になる機能は、Appleの仕組み以外の購入導線を
    // アプリ内に出せない）のため、iOSアプリ内では「登録する」ボタン・支払い方法の変更（Stripeへの
    // 外部リンク）は出さない（2026-09-28〜。プロフィール画面には残り回数などの状況表示だけ残す）。
    var native = isNativeApp();
    manageBtn.hidden = native || account.plan === 'free';
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
    // iOSアプリの中では、有料プラン・回数券の購入（Stripe）を出さない（審査ガイドライン3.1.1）。
    if (!native) {
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
    }
    msgEl.textContent = '';
  }

  // iOSアプリ内ではlocation.originがcapacitor://localhostになってしまい、
  // Stripeへの戻り先URLとしては使えず、他の人と共有するリンクとしても開けない。
  // その場合は実際に公開しているWebサイトのURLを使う。
  function publicPageUrl() {
    if (isNativeApp()) return PUBLIC_WEB_BASE;
    // 新しいホスト（Cloudflare Pages）で動いているときだけ、今までどおり実際のURLを使う。
    // それ以外（まだGitHub Pagesで見ている・ローカルで動かしているなど）は、
    // 公開している最新のURL（PUBLIC_WEB_BASE）を使う。
    return location.hostname === 'tabinoashiato.pages.dev'
      ? location.origin + location.pathname
      : PUBLIC_WEB_BASE;
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
    }).catch(function (e) {
      if (handleLoginRequired(e, 'profile')) return;
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
    }).catch(function (e) {
      if (handleLoginRequired(e, 'profile')) return;
      msgEl.textContent = '支払い管理ページを開けませんでした。もう一度お試しください。';
    });
  }

  // ---------- プロフィール（Airbnbのプロフィール画面を手本にした、アカウントまわりのまとめ。2026-09-28〜） ----------
  // マイログと同じ /mylog を読んで、旅行数・評価件数・最初の旅行の年を集計するだけ（新しいAPIは無い）。
  function openProfile() {
    var user = loadCurrentUser();
    if (!user) { openLogin('profile'); return; }
    if (Core.needsFreshLogin(user)) { forceRelogin('profile'); return; }
    showScreen('profile');
    renderProfileIdentity(user);
    $('#profileStats').innerHTML = '';
    api('/mylog?email=' + encodeURIComponent(user.email)).then(function (data) {
      state.myLogItems = data.items || [];
      state.myLogTrips = data.trips || [];
      state.myLogPlaces = data.places || { prefectures: [], countries: [], tripPlaces: [] };
      renderProfileStats();
    }).catch(function (e) {
      if (handleLoginRequired(e, 'profile')) return;
      // 集計が読み込めなくても、名前・アバターやプラン・アカウント操作は使えるようにしておく
    });
    fetchAccountStatus().then(renderPlanStatus);
  }

  function avatarInitial(user) {
    var src = (user.name || user.email || '').trim();
    return src ? src.slice(0, 1).toUpperCase() : '？';
  }

  function renderProfileIdentity(user) {
    var avatar = $('#profileAvatar');
    if (user.picture) {
      avatar.innerHTML = '<img src="' + escapeHtml(user.picture) + '" alt="">';
    } else {
      avatar.innerHTML = '';
      avatar.textContent = avatarInitial(user);
    }
    $('#profileName').textContent = user.name || user.email || '';
  }

  // 「記録の年数」：参加した旅行のうち、いちばん古い出発日の年から今年まで（初年も1年と数える）
  function profileYearsSinceEarliestTrip(trips) {
    var years = (trips || [])
      .map(function (t) { return t.startDate ? Number(String(t.startDate).slice(0, 4)) : NaN; })
      .filter(function (y) { return !isNaN(y); });
    if (!years.length) return 0;
    var earliest = Math.min.apply(null, years);
    var current = new Date().getFullYear();
    return Math.max(1, current - earliest + 1);
  }

  function renderProfileStats() {
    var trips = state.myLogTrips || [];
    var items = state.myLogItems || [];
    var stats = [
      { num: trips.length, label: '旅行 ' + trips.length + '回' },
      { num: items.length, label: '評価 ' + items.length + '件' },
      { num: profileYearsSinceEarliestTrip(trips), label: '記録の年数 ' + profileYearsSinceEarliestTrip(trips) + '年' }
    ];
    $('#profileStats').innerHTML = stats.map(function (s) {
      return '<div class="profile-stat"><span class="profile-stat-label">' + escapeHtml(s.label) + '</span></div>';
    }).join('');
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
      state.mylogFilters = { companion: '', year: '', sort: '' };
      renderAccountRow();
      alert('アカウントを削除しました。');
      goHome();
    }).catch(function (e) {
      if (handleLoginRequired(e, 'profile')) return;
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
    renderMyLogTabs();
    renderMyLogSort();
    renderMyLogList();
  }

  // その旅行で訪れた都道府県・国のチップHTML（外す・戻すの操作つき）。
  // 旅行に場所がまだ無ければ何も出さない（空の帯を出すより、カードがシンプルな方が見やすいため）。
  // 外しても戻せるよう、チップは消さずに灰色＋「戻す」のまま残す
  // （2026-09-28〜。旧「マイログから外す」がアカウント全体に効いてしまい、片方の旅行だけから
  // 外したくても両方消えてしまう不具合の直し方。docs/adr/0016）。
  function tripPlaceChipsHtml(t) {
    if (!t) return '';
    var chip = function (kind, x) {
      var cls = 'trip-place-chip' + (x.excluded ? ' is-excluded' : '');
      return '<span class="' + cls + '">' +
        '<span class="trip-place-name">' + escapeHtml(x.name) + '</span>' +
        '<button type="button" class="trip-place-action" data-trip="' + escapeHtml(t.tripId) + '" data-kind="' + kind + '" data-name="' + escapeHtml(x.name) +
        '" data-mode="' + (x.excluded ? 'include' : 'exclude') + '">' + (x.excluded ? '戻す' : '外す') + '</button></span>';
    };
    var items = (t.prefectures || []).map(function (x) { return { kind: 'prefecture', x: x }; })
      .concat((t.countries || []).map(function (x) { return { kind: 'country', x: x }; }));
    // 外した場所（is-excluded）は目立たなくしたいので、一覧の最後に回す（戻すまでは埋もれて見えて
    // よい。2026-09-29〜。並び替えは表示だけで、外す・戻す自体の対象は変えない）。
    var kept = items.filter(function (i) { return !i.x.excluded; });
    var excluded = items.filter(function (i) { return i.x.excluded; });
    var chips = kept.concat(excluded).map(function (i) { return chip(i.kind, i.x); }).join('');
    return chips ? '<div class="trip-place-chips">' + chips + '</div>' : '';
  }

  function setMyLogTripPlaceMode(tripId, kind, name, mode, btn) {
    var user = loadCurrentUser();
    if (!user) { openLogin('mylog'); return; }
    btn.disabled = true;
    api('/mylog/trip-places', 'POST', { email: user.email, tripId: tripId, kind: kind, name: name, mode: mode }).then(function (res) {
      state.myLogPlaces = res.places || state.myLogPlaces;
      renderMyLogTrips();
    }).catch(function (e) {
      btn.disabled = false;
      if (handleLoginRequired(e, 'mylog')) return;
      alert(mode === 'exclude' ? '外せませんでした。通信状況を確認して、もう一度お試しください。' : '戻せませんでした。通信状況を確認して、もう一度お試しください。');
    });
  }

  // 「参加した旅行一覧」：アカウント参加者として参加した旅行そのものの一覧（Trip単位）。
  // 評価の細かいログ（下のカテゴリ別一覧）とは別物で、どの端末からログインしても同じ内容が見える。
  // 各カードの中に、その旅行で訪れた都道府県・国のチップも出す（旅行が増えるとページが長くなる
  // ため、前は別セクション「旅行ごとの訪れた場所」に分けていたのを2026-09-28にここへ統合した）。
  // チップの「外す」「戻す」はカード自体を開く操作とぶつからないよう、カードはボタンではなく
  // クリック／キー操作を自前で処理するdivにし、チップ側のクリックはstopPropagationで止める。
  // 誰と一緒か・年の絞り込み欄の選択肢を、実際に参加した旅行データから作り直す（ホーム画面の
  // renderTripFilterOptionsと同じ考え方・同じCore.tripFilterOptionsを使い回す。旅行区分は対象外）。
  function renderMyLogTripFilterOptions(allTrips) {
    var opts = Core.tripFilterOptions(allTrips);
    var f = state.mylogFilters;
    $('#mylogFilterCompanion').innerHTML = '<option value="">誰と一緒か：すべて</option>' +
      opts.companions.map(function (c) {
        return '<option value="' + escapeHtml(c) + '"' + (f.companion === c ? ' selected' : '') + '>' + escapeHtml(c) + '</option>';
      }).join('');
    $('#mylogFilterYear').innerHTML = '<option value="">年：すべて</option>' +
      opts.years.map(function (y) {
        return '<option value="' + escapeHtml(y) + '"' + (f.year === y ? ' selected' : '') + '>' + escapeHtml(y) + '年</option>';
      }).join('');
  }

  function renderMyLogTrips() {
    var el = $('#mylogTripList');
    var allTrips = state.myLogTrips || [];
    $('#mylogTripFilters').hidden = allTrips.length < 2; // 1件以下なら絞り込みは出さない（ホーム画面と同じ基準）
    if (allTrips.length >= 2) renderMyLogTripFilterOptions(allTrips);
    if (!allTrips.length) {
      el.innerHTML = '<div class="empty">まだ参加した旅行がありません。旅行のページで「参加する」を押すとここに表示されます。</div>';
      return;
    }
    // 絞り込み・並び順は表示する一覧だけに効く（「行ったことある旅先」の総計は全旅行のまま変わらない）
    var trips = Core.sortTrips(Core.filterTrips(allTrips, state.mylogFilters), state.mylogFilters.sort);
    $('#mylogSortTripOrder').value = state.mylogFilters.sort;
    if (!trips.length) {
      el.innerHTML = '<div class="empty">条件に一致する旅行がありません。</div>';
      return;
    }
    var placesByTrip = {};
    ((state.myLogPlaces && state.myLogPlaces.tripPlaces) || []).forEach(function (t) { placesByTrip[t.tripId] = t; });
    el.innerHTML = '';
    var revealCards = [];
    trips.forEach(function (t) {
      var card = document.createElement('div');
      card.className = 'trip-card';
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      var dateText = t.startDate ? Core.formatDateJp(t.startDate) + (t.endDate && t.endDate !== t.startDate ? ' 〜 ' + Core.formatDateJp(t.endDate) : '') : '';
      card.innerHTML =
        '<div class="trip-card-row">' +
        tripThumbHtml(t.coverPhotoId) +
        '<div class="trip-card-body">' +
        '<div class="trip-card-top"><div class="trip-card-title">' + escapeHtml(t.title) + '</div>' +
        (dateText ? '<span class="trip-card-date">' + escapeHtml(dateText) + '</span>' : '') + '</div>' +
        tripPlaceChipsHtml(placesByTrip[t.id]) +
        '</div></div>';
      var open = function () { openTripFromCard(card, t.id, 'mylog'); };
      card.addEventListener('click', function (e) {
        if (e.target.closest('.trip-place-action')) return;
        open();
      });
      card.addEventListener('keydown', function (e) {
        if (e.target.closest('.trip-place-action')) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
      $all('.trip-place-action', card).forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          setMyLogTripPlaceMode(btn.dataset.trip, btn.dataset.kind, btn.dataset.name, btn.dataset.mode, btn);
        });
      });
      el.appendChild(card);
      revealCards.push(card);
    });
    revealCardsOnScroll(revealCards);
  }

  function myLogCategoryOf(it) { return it.category === 'arrival' ? 'transport' : it.category; }
  function renderMyLogTabs() {
    var el = $('#mylogTabs');
    // 「到着」は「移動」のタブにまとめる（種類の選択と同じ。2026-09-27）
    el.innerHTML = Core.CATEGORIES.filter(function (c) { return !c.inMove; }).map(function (c) {
      var on = c.key === state.myLogCategory;
      var count = state.myLogItems.filter(function (it) { return myLogCategoryOf(it) === c.key; }).length;
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
      state.myLogItems.filter(function (it) { return myLogCategoryOf(it) === state.myLogCategory; }),
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

  // ---------- 行ったことある旅先（国内・海外の地図。docs/adr/0017） ----------
  // データは/mylogのplaces（マイログの「参加した旅行」と同じ集計。旅行ごとの外す/戻すも反映済み）を
  // そのまま使う。新しいAPIは作らない。地図はd3-geo + topojson-client（vendor/geo、ISC）で、
  // タイル画像を使わないインラインSVG。ネットに繋がらないiOSアプリ内でもオフラインで描ける。
  var visitedGeoLibsLoading = null;
  function loadVisitedGeoLibs() {
    // d3-array→d3-geo→topojson-clientの順で読み終わっているかを、名前空間があるかだけでなく
    // 実際に使う関数があるかまで見る（d3-arrayだけ読めてwindow.dが truthy になった状態で
    // 「読み込み済み」と誤判定し、d3.geoPathが無いまま地図を描こうとして例外→catchで
    // 「地図の読み込みに失敗しました」になる不具合の直し方。国内・海外タブを素早く切り替えたときに
    // 起きやすかった）。
    if (window.d3 && window.d3.geoPath && window.topojson && window.topojson.feature) return Promise.resolve();
    if (visitedGeoLibsLoading) return visitedGeoLibsLoading;
    var files = ['vendor/geo/d3-array.min.js', 'vendor/geo/d3-geo.min.js', 'vendor/geo/topojson-client.min.js'];
    visitedGeoLibsLoading = new Promise(function (resolve, reject) {
      var i = 0;
      function next() {
        if (i >= files.length) { resolve(); return; }
        var s = document.createElement('script');
        s.src = files[i++];
        s.onload = next;
        s.onerror = function () { visitedGeoLibsLoading = null; reject(new Error('geo_lib_load_failed')); };
        document.head.appendChild(s);
      }
      next();
    });
    return visitedGeoLibsLoading;
  }
  var visitedJapanTopoCache = null, visitedWorldTopoCache = null, visitedIsoAlpha2Cache = null;
  function loadVisitedJson(url, cacheKey) {
    var cache = { japan: visitedJapanTopoCache, world: visitedWorldTopoCache, iso: visitedIsoAlpha2Cache }[cacheKey];
    if (cache) return Promise.resolve(cache);
    return fetch(url).then(function (r) { return r.json(); }).then(function (d) {
      if (cacheKey === 'japan') visitedJapanTopoCache = d;
      else if (cacheKey === 'world') visitedWorldTopoCache = d;
      else visitedIsoAlpha2Cache = d;
      return d;
    });
  }

  function openVisitedPlaces() {
    var user = loadCurrentUser();
    if (!user) { openLogin('visited'); return; }
    if (Core.needsFreshLogin(user)) { forceRelogin('visited'); return; }
    showScreen('visited');
    $('#visitedPanel').innerHTML = skeletonCardsHtml(4);
    api('/mylog?email=' + encodeURIComponent(user.email)).then(function (data) {
      state.myLogPlaces = data.places || { prefectures: [], countries: [], tripPlaces: [], details: { prefectures: [], countries: [] } };
      renderVisitedPlaces();
    }).catch(function (e) {
      if (handleLoginRequired(e, 'visited')) return;
      $('#visitedPanel').innerHTML = '<div class="empty">読み込みに失敗しました。通信状況を確認して、もう一度お試しください。</div>';
    });
  }

  function visitedDetails() {
    var places = state.myLogPlaces || {};
    return places.details || { prefectures: [], countries: [] };
  }

  function renderVisitedPlaces() {
    $all('.visited-tab', $('#visitedTabs')).forEach(function (b) {
      b.classList.toggle('on', b.dataset.tab === state.visitedTab);
    });
    var details = visitedDetails();
    var panel = $('#visitedPanel');
    if (state.visitedTab === 'overseas') renderVisitedOverseas(panel, (details.countries || []).filter(function (x) { return x.status === 'visible'; }));
    else renderVisitedDomestic(panel, (details.prefectures || []).filter(function (x) { return x.status === 'visible'; }));
  }

  // 達成率のドーナツ（インラインSVG。stroke-dasharrayで円弧を作るだけなので、画像もライブラリも不要）
  function visitedDonutSvg(pct) {
    var size = 64, stroke = 9, r = (size - stroke) / 2, c = 2 * Math.PI * r;
    var offset = c * (1 - Math.max(0, Math.min(100, pct)) / 100);
    var cx = size / 2, cy = size / 2;
    return '<svg viewBox="0 0 ' + size + ' ' + size + '" class="visited-donut" aria-hidden="true">' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" class="visited-donut-bg" stroke-width="' + stroke + '" fill="none"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" class="visited-donut-fg" stroke-width="' + stroke + '" fill="none" ' +
      'stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + offset.toFixed(2) + '" ' +
      'transform="rotate(-90 ' + cx + ' ' + cy + ')" stroke-linecap="round"/>' +
      '<text x="' + cx + '" y="' + (cy + 4) + '" class="visited-donut-pct" text-anchor="middle">' + pct + '%</text>' +
      '</svg>';
  }

  // 集計カード（大きい数字＋ラベル＋ドーナツ）。国内は「2 / 47 都道府県」、海外は「3 か国」＋
  // 「国連加盟193か国中 ◯%」。カウントの数え方（旅行ごとの外す/戻すの反映など）は既存のまま変えない。
  function visitedTotalsCardHtml(fracHtml, pctSubLabel, pct) {
    return '<div class="visited-totals">' +
      visitedDonutSvg(pct) +
      '<div class="visited-totals-text">' +
      '<div class="visited-totals-frac">' + fracHtml + '</div>' +
      '<div class="visited-totals-pct">' + (pctSubLabel ? escapeHtml(pctSubLabel) + ' ' : '') + pct + '%</div>' +
      '</div></div>';
  }

  // 海外の国名→alpha2の対応表。世界地図データ（idx.nameToId）が読み終わってから埋まる
  // （地方・大陸ごとの一覧の見出しと国旗絵文字は、これが埋まってから出せる）。
  var visitedCountryAlpha2ByName = {};
  function visitedFlagForName(name) {
    var a2 = visitedCountryAlpha2ByName[name];
    return a2 ? Core.flagEmojiForAlpha2(a2) : '';
  }

  // 旅行名（年つき）をタップしたらその旅行を開けるリンクのHTML。押した瞬間は行の選択（クリック伝播）とは
  // 別扱いにしたいので、クリック側でstopPropagationする（wireVisitedTripLinks）。
  // 複数の旅行にまたがる場所は、新しい旅行が上に来るよう年（最大値）で降順に並べ、1行ずつ出す
  // （・でつなげると同じ場所に何度も行った人ほど読みにくくなるため）。年が分からない旅行は最後に回す。
  function visitedTripLinksHtml(trips) {
    if (!trips.length) return '記録が見つかりませんでした';
    var sorted = trips.map(function (t, i) { return { t: t, i: i }; }).sort(function (a, b) {
      var ay = (a.t.years && a.t.years.length) ? Math.max.apply(null, a.t.years.map(Number)) : -1;
      var by = (b.t.years && b.t.years.length) ? Math.max.apply(null, b.t.years.map(Number)) : -1;
      if (ay !== by) return by - ay;
      return a.i - b.i;
    }).map(function (x) { return x.t; });
    return '<div class="visited-trip-links">' + sorted.map(function (t) {
      return '<a href="#" class="visited-trip-link" data-trip-id="' + escapeHtml(t.tripId) + '">' + escapeHtml(Core.visitedTripLabel(t)) + '</a>';
    }).join('') + '</div>';
  }

  function wireVisitedTripLinks(root2) {
    $all('.visited-trip-link', root2).forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var id = a.dataset.tripId;
        if (id) openTrip(id, 'visited');
      });
    });
  }

  // 見出し右の「n / m」（都道府県：その地方の何県に行ったか）・「nか国」（大陸：か国数だけ）。
  function visitedGroupCountLabel(kind, group, count) {
    if (kind === 'prefecture') {
      var total = (Core.VISITED_PREFECTURE_REGIONS[group] || []).length;
      return count + ' / ' + total;
    }
    return count + 'か国';
  }

  // 場所の一覧HTML（都道府県／国のどちらも共通）。地方・大陸ごとに見出し（タイトル＋件数＋区切り線）を
  // 付けてグループ化し、選んだ場所は.onで背景だけを付けて強調する（インデントは全行共通のまま。
  // 2026-09-28〜：以前は選択中の行だけpaddingがずれて見えたため、パディングは.onでも変えない）。
  // 国は先頭に国旗絵文字を出す（showFlagがtrueのとき）。行の下には訪れた旅行名（年つき）のリンクを出す。
  function visitedGroupedListHtml(kind, groups, showFlag) {
    if (!groups.length) {
      return '<div class="empty">まだ訪れた場所がありません。旅行に地図付きの記録を入れると、ここに自動で集計されます。</div>';
    }
    var sel = state.visitedSel;
    return groups.map(function (g) {
      return '<div class="visited-group">' +
        '<div class="visited-group-header">' +
        '<span class="visited-group-title">' + escapeHtml(g.group) + '</span>' +
        '<span class="visited-group-count">' + escapeHtml(visitedGroupCountLabel(kind, g.group, g.items.length)) + '</span>' +
        '</div>' +
        '<div class="visited-list">' + g.items.map(function (x) {
          var trips = Core.visitedPlaceTrips(x);
          var on = sel && sel.kind === kind && sel.name === x.name;
          var flag = showFlag ? visitedFlagForName(x.name) : '';
          return '<div class="visited-row' + (on ? ' on' : '') + '" data-kind="' + kind + '" data-name="' + escapeHtml(x.name) + '">' +
            '<div class="visited-row-name">' + (flag ? '<span class="visited-row-flag">' + flag + '</span>' : '') + escapeHtml(x.name) + '</div>' +
            '<div class="visited-row-trips">' + visitedTripLinksHtml(trips) + '</div>' +
            '</div>';
        }).join('') + '</div>' +
        '</div>';
    }).join('');
  }

  function wireVisitedListRows(panel) {
    $all('.visited-row', panel).forEach(function (row) {
      row.addEventListener('click', function () {
        setVisitedSelection(row.dataset.kind, row.dataset.name);
      });
    });
    wireVisitedTripLinks(panel);
  }

  function setVisitedSelection(kind, name) {
    var sel = state.visitedSel;
    var same = sel && sel.kind === kind && sel.name === name;
    state.visitedSel = same ? null : { kind: kind, name: name };
    updateVisitedHighlight();
  }

  // 全部を作り直さず、選択中クラスの付け外しだけする（地図の再読み込みを避ける）。
  // キャプションは一覧の行の強調と重複して見えていたため、「選んだ場所」という小さな見出しを付けた
  // 選択サマリーとして出す（地図をタップしたときだけ使う人にも、選んだ場所がひと目で分かるように）。
  function updateVisitedHighlight() {
    var sel = state.visitedSel;
    $all('.visited-row').forEach(function (row) {
      row.classList.toggle('on', !!sel && row.dataset.kind === sel.kind && row.dataset.name === sel.name);
    });
    $all('.visited-region').forEach(function (region) {
      region.classList.toggle('on', !!sel && region.dataset.kind === sel.kind && region.dataset.name === sel.name);
    });
    var caption = $('#visitedCaption');
    if (!caption) return;
    if (!sel) { caption.hidden = true; caption.innerHTML = ''; return; }
    var list = sel.kind === 'country' ? (visitedDetails().countries || []) : (visitedDetails().prefectures || []);
    var item = list.filter(function (x) { return x.name === sel.name; })[0];
    var trips = item ? Core.visitedPlaceTrips(item) : [];
    caption.hidden = false;
    caption.innerHTML = '<div class="visited-caption-label">選んだ場所</div>' +
      '<div class="visited-caption-name">' + escapeHtml(sel.name) + '</div>' +
      '<div class="visited-caption-trips">' + visitedTripLinksHtml(trips) + '</div>';
    wireVisitedTripLinks(caption);
  }

  var VISITED_PREFECTURE_TOTAL = 47;
  // 国連加盟国数（193）を分母にする。オブザーバー国家（バチカン・パレスチナ）を含めた195で
  // 数えたい、という要望が来たら、ここを195に変えれば表示も一緒に変わる。
  var VISITED_COUNTRY_TOTAL = 193;

  function renderVisitedDomestic(panel, visited) {
    var pct = Core.visitedPercentage(visited.length, VISITED_PREFECTURE_TOTAL);
    var frac = '<strong>' + visited.length + '</strong> / ' + VISITED_PREFECTURE_TOTAL + ' <span class="visited-totals-unit">都道府県</span>';
    var groups = Core.groupVisitedByOrder(visited, function (x) { return Core.regionForPrefecture(x.name); }, Core.VISITED_REGION_ORDER);
    panel.innerHTML =
      visitedTotalsCardHtml(frac, '', pct) +
      '<div class="visited-map" id="visitedMapDomestic"><div class="empty">地図を読み込み中…</div></div>' +
      '<div class="visited-caption" id="visitedCaption" hidden></div>' +
      visitedGroupedListHtml('prefecture', groups, false) +
      '<p class="hint visited-credit">地図データ: simplify-japan-geojson（ricewin、CC BY 4.0）</p>';
    wireVisitedListRows(panel);
    drawVisitedJapanMap(visited);
  }

  function renderVisitedOverseas(panel, visited) {
    var pct = Core.visitedPercentage(visited.length, VISITED_COUNTRY_TOTAL);
    var frac = '<strong>' + visited.length + '</strong> <span class="visited-totals-unit">か国</span>';
    panel.innerHTML =
      visitedTotalsCardHtml(frac, '国連加盟' + VISITED_COUNTRY_TOTAL + 'か国中', pct) +
      '<div class="visited-map" id="visitedMapOverseas"><div class="empty">地図を読み込み中…</div></div>' +
      '<div class="visited-caption" id="visitedCaption" hidden></div>' +
      '<div class="visited-list-wrap" id="visitedListOverseas"><div class="empty">読み込み中…</div></div>';
    drawVisitedWorldMap(visited);
  }

  // 日本地図：北海道が上・沖縄が左下という普通の向きになるよう、中央経線を日本付近（東経136度）に
  // 合わせてから円錐図法をかける（rotateを省くとλ0=0度＝グリニッジ基準のまま回転してしまい、
  // 地図が斜めに描かれるのが元のバグだった）。fitWidthで幅いっぱいに広げ、沖縄は別枠のインセットに
  // 小さく出す（日本地図でよくある配置）。
  function drawVisitedJapanMap(visited) {
    var visitedNames = {};
    visited.forEach(function (x) { visitedNames[x.name] = true; });
    Promise.all([loadVisitedGeoLibs(), loadVisitedJson('vendor/geo/japan-prefectures.topojson', 'japan')]).then(function (r) {
      var container = $('#visitedMapDomestic');
      if (!container) return; // 読み込み中にタブが切り替わっていた
      var topo = r[1];
      var fc = topojson.feature(topo, topo.objects.japan);
      var okinawaFeature = fc.features.filter(function (f) { return f.properties.nam_ja === '沖縄県'; })[0];
      var mainFeatures = fc.features.filter(function (f) { return f.properties.nam_ja !== '沖縄県'; });
      var mainFC = { type: 'FeatureCollection', features: mainFeatures };

      var w = 320;
      var proj = d3.geoConicConformal().rotate([-136, 0]).parallels([30, 45]);
      proj.fitWidth(w, mainFC);
      var path = d3.geoPath(proj);
      var b = path.bounds(mainFC);
      var padTop = 6, padBottom = 6;
      var h = Math.ceil(b[1][1] - b[0][1]) + padTop + padBottom;
      h = Math.max(h, 8 + 78 + 8); // 左上の沖縄インセット（8,8,104x78）が収まる高さは必ず確保する
      var t = proj.translate();
      proj.translate([t[0], t[1] - b[0][1] + padTop]);
      path = d3.geoPath(proj);

      var sel = state.visitedSel;
      var mainSvg = mainFeatures.map(function (f) {
        var name = f.properties.nam_ja;
        var d = path(f);
        if (!d) return '';
        var isVisited = !!visitedNames[name];
        var on = isVisited && sel && sel.kind === 'prefecture' && sel.name === name;
        return '<path d="' + d + '" class="visited-region' + (isVisited ? ' is-visited' : '') + (on ? ' on' : '') + '"' +
          (isVisited ? ' data-kind="prefecture" data-name="' + escapeHtml(name) + '"' : '') + '><title>' + escapeHtml(name) + '</title></path>';
      }).join('');

      // 沖縄は別枠のインセットに出す。以前は下に大きく空いた枠（本土と重ならないよう高さを余分に
      // 取っていた）を置いていたが、見た目が「空白の四角」になってしまっていたため、本土の地図では
      // ふだん空いている左上（日本海側。北は北海道・南は九州で、左上そのものは海）に小さく収める形に
      // 直した（2026-09-28〜）。fitExtentで枠の内側いっぱいに島々を収め、小さくても見えるようにする。
      var insetSvg = '';
      if (okinawaFeature) {
        var insetPad = 8, insetW = 104, insetH = 78, innerPad = 6;
        var insetX = insetPad, insetY = insetPad;
        var okiFC = { type: 'FeatureCollection', features: [okinawaFeature] };
        var okiProj = d3.geoMercator().fitExtent(
          [[insetX + innerPad, insetY + innerPad], [insetX + insetW - innerPad, insetY + insetH - innerPad]],
          okiFC
        );
        var okiPath = d3.geoPath(okiProj);
        var name = okinawaFeature.properties.nam_ja;
        var isVisited = !!visitedNames[name];
        var on = isVisited && sel && sel.kind === 'prefecture' && sel.name === name;
        var d = okiPath(okinawaFeature);
        insetSvg = '<g class="visited-inset">' +
          '<rect x="' + insetX + '" y="' + insetY + '" width="' + insetW + '" height="' + insetH + '" class="visited-inset-box" rx="4"/>' +
          '<text x="' + (insetX + 5) + '" y="' + (insetY + 11) + '" class="visited-inset-label">沖縄</text>' +
          (d ? '<path d="' + d + '" class="visited-region' + (isVisited ? ' is-visited' : '') + (on ? ' on' : '') + '"' +
            (isVisited ? ' data-kind="prefecture" data-name="' + escapeHtml(name) + '"' : '') + '><title>' + escapeHtml(name) + '</title></path>' : '') +
          '</g>';
      }

      container.innerHTML = '<svg viewBox="0 0 ' + w + ' ' + h + '" class="visited-svg" role="img" aria-label="訪れた都道府県の地図">' +
        mainSvg + insetSvg + '</svg>';
      wireVisitedMapRegions(container);
    }).catch(function (e) {
      console.error('drawVisitedJapanMap failed', e);
      var container = $('#visitedMapDomestic');
      if (container) container.innerHTML = '<div class="empty">地図の読み込みに失敗しました。</div>';
    });
  }

  // 海外タブ：地図と一覧をそれぞれ別のtry/catchで描く（2026-09-28〜。オーナー報告：国内・海外タブを
  // 素早く切り替えたり海外タブのままリロードしたりすると「地図の読み込みに失敗しました」「一覧の
  // 読み込みに失敗しました」の両方が出ることがあった）。world-atlas（countries-110m.json）にはISOの
  // 数値IDが無い地域（コソボ・北キプロスなど）や、alpha2の対応表に無いID・日本語名がalpha2に変換できない
  // 国（香港など）が混ざっており、1つの地物の描画で例外が起きるとPromiseチェイン全体がcatchに落ちて
  // 地図・一覧の両方が失敗表示になっていた。1地物ごとのtry/catchで読み飛ばし、地図が失敗しても一覧は
  // 別で描く（逆も同様）。実際の例外はconsole.errorに出す（原因調査用）。
  function drawVisitedWorldMap(visited) {
    var visitedNames = {};
    visited.forEach(function (x) { visitedNames[x.name] = true; });
    Promise.all([loadVisitedGeoLibs(), loadVisitedJson('vendor/geo/countries-110m.json', 'world'), loadVisitedJson('vendor/geo/iso-numeric-alpha2.json', 'iso')]).then(function (r) {
      var container = $('#visitedMapOverseas');
      var listWrap = $('#visitedListOverseas');
      if (!container && !listWrap) return; // 読み込み中にタブが切り替わっていた
      var topo = r[1], alpha2Table = r[2];
      var idx = { idToName: {}, nameToId: {} };
      var fc = null;
      try {
        fc = topojson.feature(topo, topo.objects.countries);
        var ids = fc.features.map(function (f) { return f.id; });
        idx = Core.buildCountryIsoIndex(ids, alpha2Table);
      } catch (e) {
        console.error('drawVisitedWorldMap: topojson decode failed', e);
        fc = null;
      }
      visitedCountryAlpha2ByName = {};
      Object.keys(idx.nameToId).forEach(function (name) {
        visitedCountryAlpha2ByName[name] = alpha2Table[idx.nameToId[name]];
      });
      // 香港・マカオなど、world-atlasに図形が無く上のnameToIdからは引けない国名を決め打ちで補う
      // （EXTRA_COUNTRY_ALPHA2_BY_NAME参照。無いと一覧で「その他」に落ちてしまう）。
      Object.keys(Core.EXTRA_COUNTRY_ALPHA2_BY_NAME || {}).forEach(function (name) {
        if (!visitedCountryAlpha2ByName[name]) visitedCountryAlpha2ByName[name] = Core.EXTRA_COUNTRY_ALPHA2_BY_NAME[name];
      });

      if (container) {
        if (fc) {
          try {
            var w = 320, h = 190;
            var proj = d3.geoNaturalEarth1().fitSize([w, h], fc);
            var path = d3.geoPath(proj);
            var sel = state.visitedSel;
            var paths = fc.features.map(function (f) {
              try {
                var name = idx.idToName[f.id] || '';
                var d = path(f);
                if (!d) return '';
                var isVisited = !!(name && visitedNames[name]);
                var on = isVisited && sel && sel.kind === 'country' && sel.name === name;
                return '<path d="' + d + '" class="visited-region' + (isVisited ? ' is-visited' : '') + (on ? ' on' : '') + '"' +
                  (isVisited ? ' data-kind="country" data-name="' + escapeHtml(name) + '"' : '') +
                  '>' + (name ? '<title>' + escapeHtml(name) + '</title>' : '') + '</path>';
              } catch (eFeature) {
                console.error('drawVisitedWorldMap: skipped a feature', f && f.id, eFeature);
                return ''; // 1つの地物がおかしくても地図全体は描く
              }
            }).join('');
            container.innerHTML = '<svg viewBox="0 0 ' + w + ' ' + h + '" class="visited-svg" role="img" aria-label="訪れた国の地図">' + paths + '</svg>';
            wireVisitedMapRegions(container);
          } catch (eMap) {
            console.error('drawVisitedWorldMap: map render failed', eMap);
            container.innerHTML = '<div class="empty">地図の読み込みに失敗しました。</div>';
          }
        } else {
          container.innerHTML = '<div class="empty">地図の読み込みに失敗しました。</div>';
        }
      }

      if (listWrap) {
        try {
          // ISOの対応表に無い（地図で塗れない）国でも、集計（visited）に出ている場所は一覧からは
          // 絶対に落とさない（continentForAlphaが分からなければ「その他」に入る＝groupVisitedByOrder
          // 側の既定の挙動）。
          var groups = Core.groupVisitedByOrder(visited, function (x) {
            return Core.continentForAlpha2(visitedCountryAlpha2ByName[x.name]);
          }, Core.VISITED_CONTINENT_ORDER);
          listWrap.innerHTML = visitedGroupedListHtml('country', groups, true);
          wireVisitedListRows(listWrap);
        } catch (eList) {
          console.error('drawVisitedWorldMap: list render failed', eList);
          listWrap.innerHTML = '<div class="empty">一覧の読み込みに失敗しました。</div>';
        }
      }
    }).catch(function (e) {
      console.error('drawVisitedWorldMap failed', e);
      var container = $('#visitedMapOverseas');
      if (container) container.innerHTML = '<div class="empty">地図の読み込みに失敗しました。</div>';
      var listWrap = $('#visitedListOverseas');
      if (listWrap) listWrap.innerHTML = '<div class="empty">一覧の読み込みに失敗しました。</div>';
    });
  }

  function wireVisitedMapRegions(container) {
    $all('.visited-region.is-visited', container).forEach(function (el) {
      el.addEventListener('click', function (e) {
        // 国内⇄海外の横スワイプは地図の上から始めても効くようにした（initTabSwipe）ため、
        // スワイプがコミットした直後の一瞬だけ来る合成clickで領域タップが誤発火しないよう無視する。
        if (Date.now() < tabSwipeClickGuardUntil) { e.preventDefault(); e.stopPropagation(); return; }
        setVisitedSelection(el.dataset.kind, el.dataset.name);
      });
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
  // -v3（2026-09-26〜）：Worker側で海外の施設名（カタカナ）もウィキペディアで探せるようにしたので、
  // 以前「見つからない」と覚えた結果を捨てて調べ直す。
  // -v4（2026-09-26〜）：店名も座標も入らない共有リンク（内部番号のS2セルIDから座標を求める）に対応したので、
  // それまで「見つからない」だったものを調べ直す。
  // -v5（2026-09-26〜）：同じ名前の候補が複数あるとき、旅行のほかの場所に近いものを選ぶよう選び方を
  // 変えたので（「ユニバーサル」がユニバーサル・オーランド・リゾートになる、「赤レンガ倉庫」が敦賀になる、
  // といった取り違えの修正）、それまでの結果は捨てて調べ直す。
  // -v6（2026-09-26〜）：「近く」に飛行機をまたいだ先の場所（成田空港の出発に対して、すでに座標の分かって
  // いた海外のホテルなど）を渡してしまい、Worker側の距離ガードで正しい結果を弾いていた不具合を直したので
  // （docs/adr/0008）、その誤りが原因で「見つからない」と覚えていた結果を捨てて調べ直す。
  // -v7（2026-09-26〜）：地図のリンクから場所が分からないとき、見出し（hint）から場所を当てずっぽうに
  // 探すのをやめた（無関係な場所に飛ぶことがあったため。docs/adr/0008）。hintに影響されていたかもしれない
  // 以前の結果（見つかった・見つからなかったのどちらも）を捨てて調べ直す。
  // -v8（2026-09-27〜）：Google Text Searchに「近くの予定」をヒントとして渡す（locationBias）のを
  // やめ、near（近くの予定）による絞り込みも外した。同じ日に離れた場所（同名の別施設）があると、
  // そちらに引っ張られて間違った場所を選んでしまうことがあったため（docs/adr/0008・0011）。
  // それに影響されていたかもしれない以前の結果を捨てて調べ直す。
  var GEOCODE_CACHE_KEY = 'tabilog:geocode-cache-v8';
  try {
    localStorage.removeItem('tabilog:geocode-cache');
    localStorage.removeItem('tabilog:geocode-cache-v2');
    localStorage.removeItem('tabilog:geocode-cache-v3');
    localStorage.removeItem('tabilog:geocode-cache-v4');
    localStorage.removeItem('tabilog:geocode-cache-v5');
    localStorage.removeItem('tabilog:geocode-cache-v6');
    localStorage.removeItem('tabilog:geocode-cache-v7');
  } catch (e) {}
  // 住所・店名から探すときに添える「同じ旅行の前後の場所」の座標を、旅程順で並んだstops
  // （{ date, transport, coords }）から選ぶ（選び方自体はCore.geocodeNearIndexes、docs/adr/0008）。
  // Worker はこの近くを優先し、2000km以上離れた結果（同名の別の場所）は使わない。
  function geocodeNearParam(stops, i) {
    var near = Core.geocodeNearIndexes(stops, i);
    return near.length ? '&near=' + near.map(function (c) { return c.lat.toFixed(4) + ',' + c.lng.toFixed(4); }).join(';') : '';
  }
  function geocodeFullPath(q, hint, stops, i) {
    return '/geocode?q=' + encodeURIComponent(q) + (hint ? '&hint=' + encodeURIComponent(hint.slice(0, 100)) : '') + geocodeNearParam(stops, i);
  }
  // サーバーに座標を計算させた行き先(entry)を伝える。entryが分かるqだけ渡すと、サーバー側で
  // そのentryのmap_urlがqと一致するときだけ座標をD1に保存し、次回は/geocode自体呼ばなくてよくなる
  // （Part A、2026-09-26〜。docs/adr/0008・worker/README参照）。
  function geocodeEntryParam(entryId) {
    return entryId ? '&entry=' + encodeURIComponent(entryId) : '';
  }
  var GEOCODE_MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  // items：[{ q: 地図のURL, hint: 予定の見出し, date: 日付, transport: 予定自身の移動手段,
  //   entryId: その地図URLの元になった記録のid, lat/lng: サーバーがすでに求めてある座標（無ければnull） }]
  // （旅行の順）。返り値は { URL: {lat,lng} | null }。
  // onStart(todoCount)：サーバー保存済み座標にも端末キャッシュにも無く、これから実際に調べに行く件数を
  // 呼び出し側へ同期的に知らせる（0件なら呼び出し側は「初めて開くときは…」の補足を出さずに済む）。
  function geocodeQueries(items, onProgress, onStart) {
    var queries = items.map(function (it) { return it.q; });
    // 同じURLに対応するentryId・サーバー計算済み座標（複数箇所で同じリンクを使っていたら先勝ち）
    var entryByQuery = {}, knownByQuery = {};
    items.forEach(function (it) {
      if (!it.q) return;
      if (it.entryId && !entryByQuery[it.q]) entryByQuery[it.q] = it.entryId;
      if (typeof it.lat === 'number' && typeof it.lng === 'number' && !(it.q in knownByQuery)) {
        knownByQuery[it.q] = { lat: it.lat, lng: it.lng };
      }
    });
    var cache;
    try { cache = JSON.parse(localStorage.getItem(GEOCODE_CACHE_KEY) || '{}'); } catch (e) { cache = {}; }
    var now = Date.now(), result = {}, todo = [];
    queries.forEach(function (q) {
      if (!q || Object.prototype.hasOwnProperty.call(result, q) || todo.indexOf(q) !== -1) return;
      // サーバーにすでに保存された座標（entry.mapLat/mapLng）があれば最優先で使い、探しに行かない
      // （Part A：localStorageのキャッシュはあくまで2番目の層）
      if (knownByQuery[q]) { result[q] = knownByQuery[q]; cache[q] = { lat: knownByQuery[q].lat, lng: knownByQuery[q].lng, at: now }; return; }
      var c = cache[q];
      if (c && c.lat !== undefined) result[q] = { lat: c.lat, lng: c.lng };
      else if (c && now - c.at < GEOCODE_MISS_TTL_MS) result[q] = null;
      else todo.push(q);
    });
    if (onStart) onStart(todo.length);
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
      return api('/geocode?quick=1&q=' + encodeURIComponent(q) + geocodeEntryParam(entryByQuery[q])).then(function (res) {
        if (res && res.pending) pending.push(q); else record(q, res);
      }).catch(function () { result[q] = null; done++; });
    })).then(function () {
      // 2回目：住所・店名から探す必要があるものだけ、1件ずつ（Worker側のキャッシュに無かったときだけ1.1秒空ける）
      return pending.reduce(function (p, q) {
        return p.then(function (needWait) {
          return (needWait ? new Promise(function (ok) { setTimeout(ok, 1100); }) : Promise.resolve()).then(function () {
            // 前後の場所：1回目と、ここまでの2回目で分かった場所
            var stops = queries.map(function (x, idx) {
              return { date: items[idx] && items[idx].date, transport: items[idx] && items[idx].transport, coords: result[x] || null };
            });
            var i = queries.indexOf(q), hint = (items[i] && items[i].hint) || '';
            return api(geocodeFullPath(q, hint, stops, i) + geocodeEntryParam(entryByQuery[q])).then(function (res) {
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

  // 移動手段が車・タクシー・バス・徒歩・自転車・電車（新幹線・地下鉄含む）の区間は、実際の道路・線路に
  // 沿った道のりをWorker（/route）に聞き、その区間の path にする（Core.replayStateAt と線の描画が、
  // Core側で先に用意した「やわらかい曲線」の代わりにこれをたどる。docs/adr/0008）。
  // 取れなかった区間は、Core.buildReplayTimelineがあらかじめ用意したやわらかい曲線のまま（直線には戻さない。
  // 「旅は全部必ずつなげてほしい」という声より、2026-09-27）。
  // 車ルートが直線距離よりずっと長い（Core.isRouteDetourTooLong）ときは、歩行者専用の目的地（階段など）に
  // 車で大回りしている疑いがあるので、徒歩で調べ直す。それでも長ければ、やわらかい曲線に戻す（2026-09-26）。
  // 電車・新幹線・地下鉄（rail）は、BRouterの公開サーバーで線路が見つからないことがあるため、見つからなければ
  // 車の道のりを見た目の近似として使う（オーナー承認、2026-09-27）。それも見つからなければやわらかい曲線のまま。
  function routeQuery(profile, a, b) {
    return '/route?profile=' + profile +
      '&from=' + a.lat.toFixed(5) + ',' + Core.wrapLng(a.lng).toFixed(5) + '&to=' + b.lat.toFixed(5) + ',' + Core.wrapLng(b.lng).toFixed(5);
  }
  // 線路データ（OpenStreetMap、Overpass API）を取って、端末の中で線路の上の最短経路を求める。
  // 求めた線はこの端末に覚えておき、次からは線路データを取りに行かない。取れなければnull。
  var RAIL_PATH_CACHE_PREFIX = 'tabilog-railpath-v1:';
  var railPathTried = {};
  // 線路データはWorker（/rail-tracks）が代わりに取ってくる（54では端末から直接Overpassへ送っていたが、
  // iOSアプリで取れずに一直線のままだった疑いがあるため、ほかのAPIと同じ経路にまとめた。2026-09-27）。
  function localRailPath(a, b) {
    var key = RAIL_PATH_CACHE_PREFIX + [a.lat, a.lng, b.lat, b.lng].map(function (v) { return v.toFixed(4); }).join(',');
    try {
      var saved = localStorage.getItem(key);
      if (saved) return Promise.resolve(JSON.parse(saved));
    } catch (e) { /* 端末に保存できない環境では毎回求める */ }
    if (railPathTried[key]) return Promise.resolve(null); // この画面を開いているあいだ、失敗した区間を何度も試さない
    railPathTried[key] = true;
    return api('/rail-tracks?bbox=' + Core.railBBox(a, b).join(',')).then(function (data) {
      var path = Core.railPathFromOverpass(data && data.elements, a, b);
      if (path) { try { localStorage.setItem(key, JSON.stringify(path)); } catch (e) { /* 容量不足など */ } }
      return path;
    }).catch(function () { return null; });
  }

  function fetchReplayRoutes(tl, onRoute) {
    var jobs = tl.legs.filter(function (l) { return Core.routeProfileFor(l.transport); });
    // 近い区間から順に届くよう、再生の順番（区間の並び）のまま同時に聞く
    return Promise.all(jobs.map(function (l) {
      // 地点の経度は日付変更線をまたぐと±360度されている（buildReplayTimeline）。道のりは普通の経度で調べ、
      // 届いた道のりを同じだけずらして地点につなぐ
      var sa = tl.stops[l.from], sb = tl.stops[l.to];
      var shift = sa.lng - Core.wrapLng(sa.lng);
      var a = { lat: sa.lat, lng: sa.lng - shift }, b = { lat: sb.lat, lng: sb.lng - shift };
      var straightKm = Core.distanceKm(a, b);
      var profile = Core.routeProfileFor(l.transport);
      return api(routeQuery(profile, a, b)).catch(function () { return null; }).then(function (res) {
        var km = res && res.found ? (res.distance || 0) / 1000 : null;
        // 車で大回りしている疑いのときの徒歩での調べ直しは、foot自身とrail（電車・新幹線・地下鉄）には
        // 行わない：footはもともと徒歩の道のりなので該当なし、railは徒歩で置き換える意味が無い上、
        // Worker側のgetRouteがすでに「線路の長さが直線距離の3倍を超えたら見つからない扱い」にしている
        // （BRouterの公開サーバーへの問い合わせを1区間1回に抑えるため。docs/adr/0008）。
        if (res && res.found && profile !== 'foot' && profile !== 'rail' && Core.isRouteDetourTooLong(straightKm, km)) {
          // 車で大回りしている疑い。徒歩で調べ直す
          return api(routeQuery('foot', a, b)).catch(function () { return null; }).then(function (res2) {
            var km2 = res2 && res2.found ? (res2.distance || 0) / 1000 : null;
            return (res2 && res2.found && !Core.isRouteDetourTooLong(straightKm, km2)) ? res2 : null;
          });
        }
        // 線路の道のりが見つからないときは、車の道のり（道路）では代わりにしない。電車なのに道路を
        // 走るように見えて「動きが全部車っぽい」と言われたため（2026-09-27）。やわらかい曲線のまま見せ、
        // Worker側は見つからなかった結果を6時間しか覚えないので、あとで開き直せば線路で調べ直す。
        // 日本の近い区間（30km以内）だけは、線路データを取ってこの端末で最短経路を求める
        // （BRouterは新大阪→USJで大回りし、Googleは日本の電車を返さないため。Core.railPathFromOverpass）。
        // 海外でも、線路の道のりの端が出発地・到着地から離れすぎていれば（山の上の登山電車で、下の町の
        // 駅まで行ってしまう等）同じように線路データから求め直す。求められなければやわらかい曲線にする（2026-09-27）
        var railBad = profile === 'rail' && res && res.found && !Core.railPathEndsOk(res.path, a, b);
        if (profile === 'rail' && (!(res && res.found) || railBad) && straightKm <= Core.RAIL_LOCAL_MAX_KM &&
            (railBad || (Core.isInJapan(a) && Core.isInJapan(b)))) {
          return localRailPath(a, b).then(function (path) { return path ? { found: true, path: path } : (railBad ? null : res); });
        }
        if (railBad) return null;
        return res;
      }).then(function (res) {
        if (res && res.found && res.path && res.path.length > 1) {
          var path = shift ? res.path.map(function (p) { return [p[0], p[1] + shift]; }) : res.path;
          l.path = Core.joinPathEnds(path, tl.stops[l.from], tl.stops[l.to]);
          if (onRoute) onRoute(l);
        }
      });
    }));
  }

  var REPLAY_PLANE_DASH = '8 10';
  var REPLAY_CAMERA_LEAD_SEC = 0.9; // カメラの移動（0.8秒）が、区間の動き出しまでに終わるように
  var REPLAY_CAPTION_HIDE_LEAD_SEC = Core.REPLAY_CAPTION_HIDE_LEAD_SEC; // 写真の吹き出しは、カメラが動き出す少し前に消しておく
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
    $('#replayDays').hidden = true;
    updateReplayVideoButton(); // 準備ができるまでは動画ボタンを出さない（stopReplayでreplayはnullになっている）
    // 前の旅行の再生を開いたあと、この旅行の場所を探し終える（数秒かかりうる）までのあいだ、
    // 地図そのもの（stopReplayで線・マーカーは消しているが、タイルの表示位置＝カメラは前の旅行のまま）
    // が一瞬でも見えてしまわないよう、新しい旅行の地図ができるまで隠す（2026-09-26）。
    var mapEl = $('#replayMap');
    if (mapEl) mapEl.style.visibility = 'hidden';
    // 選んでいる人の道で再生する（みんな＝今までどおり。別行動の時間帯は、その人の予定のルートになる）
    var stops = Core.replayStops(state.trip, replayBlocks());
    var viewerEl = $('#replayViewer');
    var viewerBranch = state.viewAccountId ? (state.branches || []).filter(function (b) { return b.accountId === state.viewAccountId; })[0] : null;
    viewerEl.hidden = !viewerBranch;
    viewerEl.textContent = viewerBranch ? branchOwnerName(viewerBranch) + 'の道' : '';
    var status = $('#replayStatus');
    var statusSub = $('#replayStatusSub');
    statusSub.hidden = true;
    statusSub.textContent = '';
    if (!stops.length) { status.textContent = '日付の入った予定がまだありません。'; return; }
    status.textContent = '地図を準備しています…';
    var token = {};
    replayToken = token;
    // 「近く」の判定（Core.geocodeNearIndexes）に使う予定自身の移動手段は、replayStopsが持つ
    // 「到着した移動手段」（前の移動区間から引き継いだもの）ではなく、予定そのものの値を見る
    // （成田空港出発の区間＝飛行機を、間に挟まっているかどうかの判定に使うため。docs/adr/0008）。
    var blockById = {};
    allBlocks().forEach(function (b) { blockById[b.id] = b; });
    Promise.all([
      loadLeaflet(),
      geocodeQueries(stops.map(function (s) {
        return {
          q: s.query, hint: s.label, date: s.date, transport: (blockById[s.blockId] || {}).transport,
          entryId: s.entryId, lat: s.knownLat, lng: s.knownLng
        };
      }), function (done, total) {
        if (replayToken === token) status.textContent = '地図で場所を探しています…（' + done + '/' + total + '）';
      }, function (todoCount) {
        // まだ座標を1つも覚えていない（サーバー保存済み・端末キャッシュのどちらにも無い）場所が
        // 1つでもあるときだけ、初回だけ時間がかかることの補足を出す（全部わかっていれば出さない＝
        // 次回からはこの補足なしですぐ始まる）
        if (replayToken === token) { statusSub.hidden = !todoCount; statusSub.textContent = todoCount ? '初めて開くときは、場所を調べて覚えるので少し時間がかかります。次からはすぐに始まります。' : ''; }
      })
    ]).then(function (res) {
      if (replayToken !== token) return; // 準備中に閉じられた
      statusSub.hidden = true;
      var tl = Core.buildReplayTimeline(stops, res[1]);
      if (!tl.stops.some(function (s) { return s.located; })) {
        status.textContent = '地図に出せる場所が見つかりませんでした。記録の「地図」にGoogleマップの共有リンクを入れた予定が、地図の上で移動する目的地になります。';
        return;
      }
      // 道のりがそろうのを待たずに始める（以前は全区間の道のりを待ってから始めていて、準備が長かった）。
      // 道のりは裏で調べ、届いた区間から直線を道路に沿った青い線に切り替える
      status.textContent = '';
      startReplay(res[0], tl);
      replay.routesDone = fetchReplayRoutes(tl, function (l) {
        if (replayToken !== token || !replay || replay.tl !== tl) return;
        var set = replay.lines[tl.legs.indexOf(l)];
        if (set && set.plan) set.plan.setLatLngs(l.path);
        if (set) set.lastF = null; // 道のりが変わったので、進んだところの線も描き直す
        renderReplay();
      });
    }).catch(function () {
      if (replayToken === token) { status.textContent = '地図を読み込めませんでした。通信環境を確認してください。'; statusSub.hidden = true; }
    });
  }

  function startReplay(L, tl) {
    if (!replayMap) {
      // 線を描く範囲を画面の外まで広げておく（カメラが次の区間へ動くあいだに、道のりの端が切れて見えないように）
      replayMap = L.map($('#replayMap'), { zoomControl: false, renderer: L.svg({ padding: 1 }) });
      replayMap.attributionControl.setPrefix(false);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, keepBuffer: 6, // カメラが動いた先の地図を多めに読んでおく（端が灰色のまま見えないように）
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      }).addTo(replayMap);
    }
    // openReplayで隠した地図を、この旅行の中身（線・マーカー）ができた今、表示する（2026-09-26）
    var mapEl = $('#replayMap');
    if (mapEl) mapEl.style.visibility = '';
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
        icon: s.photos && s.photos.length
          ? L.divIcon({ className: '', html: '<div class="replay-photo-pin" style="background-image:url(\'' + escapeHtml(photoUrl(s.photos[0])) + '\')"></div>', iconSize: [40, 40], iconAnchor: [20, 20] })
          : L.divIcon({ className: '', html: '<div class="replay-dot"></div>', iconSize: [14, 14], iconAnchor: [7, 7] })
      });
    });
    // 移動の線はGoogleマップの道のりのような青（白い縁取り付き）。区間に入ったら、これから通る道のりを
    // 薄い青で先に見せ、進んだところまでを濃い青で伸ばしていく。飛行機は弧の点線（道のりはCore側で
    // 弧の点をあらかじめ作ってあるので、車などの実際の道のりと同じ仕組みで「これから通る道」を出せる。
    // 「飛び立った瞬間から全体を青く見せてほしい」という声より、2026-09-26に車と同じ扱いに揃えた）。
    tl.legs.forEach(function (l, k) {
      var plane = l.transport === 'plane';
      var full = l.path || null;
      replay.lines[k] = {
        // 飛行機の点線は、薄い青（これから通る道）と濃い青（進んだところ）で点線の間隔をそろえる。以前は
        // '6 8' と '8 10' で違っていたため、濃い青の点が薄い青の点からずれて見えていた（2026-09-27）。
        // 線の形（l.path）は両方同じなので、間隔がそろえば濃い青がぴったり重なる。
        // さらに、Leafletは線を描くときに画面の大きさに合わせて点を間引き（smoothFactor）、画面の外を
        // 切り落とす（clip）。全体の線と途中までの線とで間引き方・切り落とし方が変わると、点線の位置がずれて
        // 「薄い青の上に少しずれて濃い青が乗る」ように見えていた（56で間隔をそろえても残った。2026-09-27）。
        // 飛行機の線は点が少ない（弧の32点ほど）ので、間引きも切り落としもしない。
        plan: L.polyline(full || [], { color: ROUTE_BLUE, weight: plane ? 4 : 6, opacity: 0.45, interactive: false, lineCap: 'round', lineJoin: 'round', dashArray: plane ? REPLAY_PLANE_DASH : null, smoothFactor: plane ? 0 : 1, noClip: plane }),
        casing: plane ? null : L.polyline([], { color: '#FFFFFF', weight: 9, opacity: 0.95, interactive: false, lineCap: 'round', lineJoin: 'round' }),
        line: L.polyline([], { color: ROUTE_BLUE, weight: plane ? 4 : 6, opacity: 0.95, interactive: false, lineCap: 'round', lineJoin: 'round', dashArray: plane ? REPLAY_PLANE_DASH : null, smoothFactor: plane ? 0 : 1, noClip: plane }),
        planeLine: plane, lastF: null
      };
    });
    replay.mapAnimating = false;
    // 前の旅行の再生を閉じたときに透明のままになっていないよう、開くたびに必ず見える状態へ戻す
    (function () {
      var pane = replayOverlayPane();
      if (pane) { pane.style.transition = 'none'; pane.style.opacity = '1'; }
    })();
    if (!replayMap._replayAnimGuard) {
      replayMap._replayAnimGuard = true;
      // Leaflet（SVGレンダラー）は、ズームのアニメーション中に線の座標を更新すると、
      // アニメーションが終わる（moveend/zoomend）までタイルとずれた位置に描いてしまう
      // （地図全体が動いている最中に setLatLngs すると、そのフレームのズーム換算がまだ
      // 反映されていないため）。「区間の変わり目で地図がずれ、青い線が追いつかない」の原因。
      // アニメーション中は線の更新を止め（アイコンは動かし続ける）、終わったら1回だけ描き直す。
      //
      // それでも、アニメ中は線（overlayPaneのSVG）自体をLeafletがCSSのtransformで拡大縮小し続けるため、
      // 大きくズームするとき（例：飛行機で日本→アメリカのような広いflyToBounds）は線の太さもいっしょに
      // 拡大されてしまい、太い青の塊が地図を覆う「ゴースト」に見える不具合があった（利用者からの
      // スクリーンショットで確認）。対策として、アニメ開始（zoomstart/movestart）で線の入っている
      // overlayPane自体を一瞬透明にして隠し、終わった（zoomend/moveend）ら描き直してからフェードイン
      // する（2026-09-27）。乗り物のアイコン（マーカー）はmarkerPane側なので影響を受けず、そのまま
      // 動かし続けられる。
      // ただし、どの移動でも隠すと、区間が始まるたびのカメラ移動（0.8秒）のあいだ、これまでの道のりが
      // 全部消えて見えていた（「移動の開始の時に青い経路が全体的にうまく表示されない」2026-09-27）。
      // ゴーストが目立つのはズームが大きく変わるときだけなので、replayFlyToBoundsが「ズームが3段以上
      // 変わる」と判断したときだけ隠す（replay.hideLinesOnMove）。
      //
      // 2026-09-27〜：上の2つ（アニメ中は線を止める・大きくズームするときは線を隠す）をやめ、カメラが
      // 動いているあいだは毎コマ、線を地図の今の縮尺で描き直す（Leafletのレンダラーの_reset）。
      // CSSで拡大縮小された古い絵ではなく毎回正しい位置に描くので、ズームイン・アウトの途中でも道のりが
      // 地図の道路・線路と完全に重なり、太さも変わらない（「通った道は地図と完全に一致させたい」）。
      replayMap.on('zoomstart movestart', function () {
        if (!replay) return;
        replay.mapAnimating = true;
      });
      replayMap.on('zoom move', function () {
        // flyTo（再生のカメラ）の途中だけ。指でのピンチ（CSSのズームアニメ）はLeaflet自身が合わせる
        if (!replay || !replay.mapAnimating || replayMap._animatingZoom) return;
        var rd = replayMap.options.renderer;
        if (rd && rd._map && typeof rd._reset === 'function') rd._reset();
      });
      replayMap.on('zoomend moveend', function () {
        if (!replay) return;
        replay.mapAnimating = false;
        replay.cameraMoving = false;
        replay.cameraFlying = null;
        // アニメ中に「あとで」と預かった動かし先があれば、いまの見え方と比べて、まだ必要なら始める
        var pending = replay.cameraPending;
        replay.cameraPending = null;
        if (pending) replayCameraMove(pending.fit, pending.opts);
        renderReplay();
      });
    }
    resetReplayCamera();
    renderReplayDays();
    preloadNextReplayPhotos(-1);
    updateReplayVideoButton();
    $('#replayClock').hidden = false;
    $('#replayControls').hidden = false;
    renderReplay();
    setReplayPlaying(true);
  }

  // 地図のうち、上の時計と下の吹き出し・日ボタン・操作ボタンに隠れていない部分に収まるようにする余白。
  // 以前は画面全体の真ん中に合わせていたので、移動中の車や道のりが下のボタンの裏に隠れ、区間が変わるたびに
  // 地図が大きくずれて見えた。吹き出しは移動中は消えるので、下は日ボタン・操作ボタンの上端までを使う。
  function replayViewPadding() {
    var mapRect = $('#replayMap').getBoundingClientRect();
    var visibleRect = function (el) { return el && !el.hidden && el.offsetParent ? el.getBoundingClientRect() : null; };
    var clock = visibleRect($('#replayClock'));
    var top = clock ? clock.bottom - mapRect.top : 80;
    var bottomEdge = mapRect.bottom;
    [$('#replayDays'), $('#replayControls')].forEach(function (el) {
      var r = visibleRect(el);
      if (r) bottomEdge = Math.min(bottomEdge, r.top);
    });
    var bottom = mapRect.bottom - bottomEdge;
    if (bottom < 1) bottom = 130;
    // 地図が小さい端末でも、見える部分が高さの半分より狭くならないように
    var room = mapRect.height * 0.5;
    if (top + bottom > room) { var k = room / (top + bottom); top *= k; bottom *= k; }
    return { paddingTopLeft: [36, Math.round(top + 24)], paddingBottomRight: [36, Math.round(bottom + 24)] };
  }
  // アニメーションつきでboundsへ寄せる（途中も線は毎コマ描き直すので、隠さない）。
  var REPLAY_ARRIVAL_ZOOM_DELAY_SEC = 0.25; // 着陸してから着いた地点へズームし直すまでの間
  var REPLAY_TINY_LEG_KM = 0.4; // これより近い区間は、両端が見えていればカメラを動かさない（空港の中など）
  var REPLAY_SHORT_STAY_SEC = 1.2; // 着いてからこれ以内に次の遠い移動が始まるなら、着いた地点へ寄せない
  // 点がすべて、見える部分（吹き出し・操作ボタンを除いた部分）に入っているか
  function replayPointsInView(points, padOpts) {
    try {
      var size = replayMap.getSize();
      var tl = window.L.point(padOpts.paddingTopLeft), br = window.L.point(padOpts.paddingBottomRight);
      return points.every(function (p) {
        var c = replayMap.latLngToContainerPoint(p);
        return c.x >= tl.x && c.y >= tl.y && c.x <= size.x - br.x && c.y <= size.y - br.y;
      });
    } catch (e) { return false; }
  }
  // 点（1点でも、道のりでも）を見える部分に収めたときの、カメラの中心と縮尺（fitBoundsの結果そのもの）。
  // 以前は「区間の両端の真ん中・縮尺15」という目安を判定に使っていて、実際のカメラ（縮尺は整数刻みに丸められる）と
  // 食い違っていた。実際の結果で比べるので、もう合っているかを正しく判定できる。
  function replayFitFor(points, maxZoom) {
    var L = window.L, opts = replayViewPadding();
    opts.maxZoom = maxZoom;
    var b = L.latLngBounds(points);
    var cz = replayMap._getBoundsCenterZoom(b, opts); // flyToBounds／fitBoundsが内部で使うものと同じ計算
    var z = Math.min(maxZoom, cz.zoom);
    if (!isFinite(z)) z = maxZoom;
    return { lat: cz.center.lat, lng: cz.center.lng, zoom: z, points: points, pad: opts };
  }

  // 1点を見える部分の真ん中に出す（アニメーションなし。最初と、シーク先へ合わせるとき）
  function replayCenterOn(lat, lng, zoom) {
    var opts = replayViewPadding();
    opts.maxZoom = zoom; opts.animate = false;
    replayMap.fitBounds([[lat, lng], [lat, lng]], opts);
  }

  // カメラを動かすのは、この1か所だけ（2026-09-30）。区間の前・着いたあと・シークのどれから呼ばれても、
  // Core.cameraMoveDecision が「動かさない／アニメが終わってから／いま」を決める。
  //   fit ：replayFitFor の結果（動かしたい先）
  //   o.urgent：移動の直前で、間に合わせたいとき（アニメ中でも始め直す）
  // 以前は、直前の開始から600ms未満なら目的地が違っても黙って捨てて「済み」にしていた（wall-clock debounce）。
  // 捨てたカメラ移動は取り戻されず、次の区間で大きく動いて見えた。いまは捨てずに「あとで」と預かり、
  // アニメが終わった（moveend）ときに、まだ必要なら始める。
  function replayCameraMove(fit, o) {
    o = o || {};
    var c = replayMap.getCenter(), size = replayMap.getSize();
    var flying = replay.cameraFlying;
    var view = flying || { lat: c.lat, lng: c.lng, zoom: replayMap.getZoom() };
    var visible = !!(fit.points && fit.pad && replayPointsInView(fit.points, fit.pad));
    var decision = Core.cameraMoveDecision(view, fit, { flying: !!flying, urgent: !!o.urgent, viewWidthPx: size.x, alreadyVisible: visible });
    if (decision === 'skip') return false;
    if (decision === 'defer') { replay.cameraPending = { fit: fit, opts: o }; return false; }
    replay.cameraPending = null;
    replay.cameraFlying = { lat: fit.lat, lng: fit.lng, zoom: fit.zoom };
    replay.cameraMoving = true; // 吹き出しは、動いている間は出さない（moveendで戻す）
    replayMap.flyTo([fit.lat, fit.lng], fit.zoom, { duration: Core.REPLAY_CAMERA_FLIGHT_SEC });
    return true;
  }

  function resetReplayCamera() {
    var first = replay.tl.stops.filter(function (s) { return s.located; })[0];
    replayMap.stop();
    replayCenterOn(first.lat, first.lng, 13);
    replay.cameraFlying = null;
    replay.cameraPending = null;
    replay.cameraMoving = false;
    replay.lastLeg = -1;
    // 最初の地点にはもうカメラを合わせてあるので、着いたときにもう一度カメラを動かさない。以前は再生の
    // はじめに最初の地点へもう一度カメラが動き、吹き出しが「出て、一瞬消えて、また出る」ように見えていた
    // （大阪旅の「みなとみらい発」、2026-09-27）
    replay.lastStop = replay.tl.stops.indexOf(first);
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

  // sub：下に小さく添える一言（時差のときの「ここから現地時間」など）。1行ずつ途中で折り返さない
  function showReplayBanner(text, sub) {
    var el = $('#replayDayBanner');
    el.hidden = true;
    void el.offsetWidth; // アニメーションを最初から再生し直すため
    el.innerHTML = '<div class="replay-banner-main">' + escapeHtml(text) + '</div>' +
      (sub ? '<div class="replay-banner-sub">' + escapeHtml(sub) + '</div>' : '');
    el.hidden = false;
    clearTimeout(showReplayBanner.timer);
    showReplayBanner.timer = setTimeout(function () { el.hidden = true; }, 1600);
  }

  function setLayerVisible(layer, visible) {
    var has = replayLayer.hasLayer(layer);
    if (visible && !has) replayLayer.addLayer(layer);
    else if (!visible && has) replayLayer.removeLayer(layer);
  }

  // 道のり（線・到着済みの点）はぜんぶ既定のoverlayPane（Leafletの標準）に入っている。乗り物のアイコンは
  // markerPane（別のpane）なので、overlayPaneだけ隠してもアイコンは動かし続けられる。
  // ズームや移動のアニメ中に線の太さがCSSのtransformで拡大されて見える「ゴースト」対策（2026-09-27）。
  function replayOverlayPane() {
    return replayMap && replayMap.getPane ? replayMap.getPane('overlayPane') : null;
  }
  // 着いた地点の写真を吹き出しの上に出す。複数枚なら、吹き出しを出しているあいだに順に切り替える
  function showReplayCaptionPhotos(photos) {
    var el = $('#replayCaptionPhotos');
    clearInterval(showReplayCaptionPhotos.timer);
    if (!photos.length) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = photos.map(function (id, i) {
      return '<img src="' + escapeHtml(photoUrl(id)) + '" alt="" class="' + (i === 0 ? 'on' : '') + '" draggable="false">';
    }).join('') + (photos.length > 1 ? '<div class="replay-photo-dots">' + photos.map(function (_, i) { return '<span class="' + (i === 0 ? 'on' : '') + '"></span>'; }).join('') + '</div>' : '');
    if (photos.length < 2) return;
    var k = 0;
    showReplayCaptionPhotos.timer = setInterval(function () {
      if (!replay || !replay.playing) return;
      var imgs = $all('img', el), dots = $all('.replay-photo-dots span', el);
      if (!imgs.length) { clearInterval(showReplayCaptionPhotos.timer); return; }
      imgs[k].classList.remove('on'); dots[k].classList.remove('on');
      k = (k + 1) % imgs.length;
      imgs[k].classList.add('on'); dots[k].classList.add('on');
    }, REPLAY_PHOTO_SWITCH_MS);
  }
  var REPLAY_PHOTO_SWITCH_MS = 2500; // Core の REPLAY_SEC_PER_PHOTO と同じ

  // 次の地点の写真を先に読み込んでおく（着いた瞬間に写真が真っ白にならないように）
  function preloadNextReplayPhotos(index) {
    var next = replay && replay.tl.stops[index + 1];
    (next && next.photos || []).forEach(function (id) { var im = new Image(); im.src = photoUrl(id); });
  }

  function renderReplay() {
    var L = replay.L, tl = replay.tl, r = replay.r;
    var st = Core.replayStateAt(tl, r);

    $('#replayDay').textContent = st.dayNumber + '日目　' + replayShortDate(replay.dates[st.dayNumber - 1]);
    highlightReplayDay(st.dayNumber);
    $('#replayTime').textContent = st.hhmm;
    if (replay.lastOffsetDiff !== undefined && st.offsetDiff !== replay.lastOffsetDiff && replay.playing) {
      showReplayBanner('時差 ' + Core.offsetDiffText(st.offsetDiff - replay.lastOffsetDiff), 'ここから現地時間');
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
      // カメラが動いているあいだも線を伸ばす（毎コマ地図の今の縮尺で描き直しているので、地図とずれない。
      // startReplayの'zoom move'の説明を参照）。
      // 進み具合が変わらない区間（走り終わった区間など）は描き直さない。以前は毎フレーム全区間を描き直していて、
      // 長い飛行機の点線（東京→ロサンゼルス）が街を見る大きさで毎回描かれ、動きが重くなっていた（2026-09-27）
      if (f > 0 && set.lastF !== f) {
        var pts = replayLegPoints(l, f);
        // 飛行機の点線は、走っているあいだだけ画面の外を切り落とさない（薄い青と濃い青の点をそろえるため）。
        // 走り終わったら切り落とす：何千kmもある点線を街の大きさで丸ごと描くと、とても重いため
        if (set.planeLine) set.line.options.noClip = f < 1;
        set.line.setLatLngs(pts);
        if (set.casing) set.casing.setLatLngs(pts);
        set.lastF = f;
      } else if (f === 0 && set.lastF) {
        set.lastF = 0;
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

    // カメラ：移動が始まる少し前（REPLAY_CAMERA_LEAD_SEC）に、出発地と到着地が両方入るように動かし始める。
    // 移動が始まった瞬間に動かすと、カメラが動く0.8秒のあいだは線（SVG）を伸ばせない（地図とずれるため
    // 止めている）ので、動き出しの青い線が出ていないように見えていた（2026-09-27）。
    var legIndexForCamera = st.icon ? st.icon.legIndex : -1;
    if (legIndexForCamera < 0 && replay.playing) {
      for (var li = 0; li < tl.legs.length; li++) {
        var lead = tl.legs[li].r0 - r;
        if (lead > 0 && lead <= REPLAY_CAMERA_LEAD_SEC) { legIndexForCamera = li; break; }
        if (lead > REPLAY_CAMERA_LEAD_SEC) break;
      }
    }
    if (legIndexForCamera >= 0 && legIndexForCamera !== replay.lastLeg) {
      var leg = tl.legs[legIndexForCamera];
      var legFrom = tl.stops[leg.from], legTo = tl.stops[leg.to];
      var legPoints = leg.path && leg.path.length > 1 ? leg.path : [[legFrom.lat, legFrom.lng], [legTo.lat, legTo.lng]];
      // 空港の中など、ごく近い区間（REPLAY_TINY_LEG_KM未満）で両端がもう見えているなら、カメラを動かさない。
      // 乗り継ぎの空港（インチョン・チューリッヒ）で、ほぼ同じ場所の予定が続くたびに少しずつ寄せ直し、
      // 地図が手振れのように揺れていた（2026-09-27）
      var tinyLeg = Core.distanceKm(legFrom, legTo) < REPLAY_TINY_LEG_KM;
      // 飛行機のあとで大きく引いたままなら、街を見る大きさ（12）までは寄せる。以後の近い区間では動かさない
      var legMaxZoom = tinyLeg ? Math.max(12, Math.min(15, replayMap.getZoom())) : 15;
      var legFit = replayFitFor(legPoints, legMaxZoom);
      var tinyInView = tinyLeg && replayMap.getZoom() >= 10 && replayPointsInView([[legFrom.lat, legFrom.lng], [legTo.lat, legTo.lng]], legFit.pad);
      // 動かすかどうか（もう収まっている／アニメ中）は replayCameraMove（Core.cameraMoveDecision）が決める。
      // 移動の直前なので急ぎ（アニメ中でも始め直す）
      if (!tinyInView) replayCameraMove(legFit, { urgent: true });
      replay.lastLeg = legIndexForCamera;
      // 着いた地点に寄せる処理（下）が次のフレームで走ってこのカメラ移動を打ち消さないよう、着いた地点も済みにする
      if (!st.icon) replay.lastStop = st.stopIndex;
    } else if (!st.icon && st.stopIndex >= 0 && st.stopIndex !== replay.lastStop) {
      var arrived = tl.stops[st.stopIndex];
      var cameFromLeg = tl.legs.some(function (l) { return l.to === st.stopIndex; });
      // 長い移動（飛行機で日本→アメリカなど）のflyToBoundsは、両端が入るよう地図を大きく引いたまま。
      // その先の予定が地図の無い（座標が分からない）予定続きだと次の区間が作られず、広域のまま止まって
      // 見えてしまうため、着いた地点のズームが街を見る大きさ（目安10）より広いままなら、着いた地点へ寄せ直す
      // （次の区間があるかどうかによらない。2026-09-26）。
      var zoomedOut = replayMap.getZoom() < 10;
      var needZoom = arrived && arrived.located && replay.lastStop !== -2 && (!cameFromLeg || zoomedOut);
      // 乗り継ぎのように、着いてすぐ次の遠い移動（飛行機など）に出るなら、寄せずに引いたままにする。
      // 寄せた直後にまた大きく引くことになり、地図が揺れて見えていた（2026-09-27）
      if (needZoom && cameFromLeg && replay.playing) {
        var nextLeg = tl.legs.filter(function (l) { return l.from === st.stopIndex && l.r0 >= r; })[0];
        if (nextLeg && nextLeg.r0 - r < REPLAY_CAMERA_LEAD_SEC + REPLAY_SHORT_STAY_SEC) {
          var nextTo = tl.stops[nextLeg.to];
          if (nextTo && nextTo.located && Core.distanceKm(arrived, nextTo) >= 50) needZoom = false;
        }
      }
      // 飛行機などで引いた地図から寄せ直すときは、着いてすぐではなく少し（REPLAY_ARRIVAL_ZOOM_DELAY_SEC）
      // 間を空けてからズームする。着陸した瞬間にズームが始まり、早すぎると感じられたため（2026-09-27）。
      // 間を空けるあいだは lastStop を進めず、次のフレームでもう一度ここに来る
      if (needZoom && cameFromLeg && replay.playing && typeof arrived.r === 'number' && r - arrived.r < REPLAY_ARRIVAL_ZOOM_DELAY_SEC) {
        // まだ待つ
      } else {
        if (needZoom) {
          var arriveZoom = Math.max(replayMap.getZoom(), 12);
          replayCameraMove(replayFitFor([[arrived.lat, arrived.lng]], arriveZoom), { urgent: false });
        }
        replay.lastStop = st.stopIndex;
      }
    }

    // 吹き出し・写真カードは「乗り物が着いて（st.icon が無い）、カメラが落ち着いて（cameraMoving でない）、
    // 次の移動の直前（aboutToMove）でない」あいだだけ見せる（Core.replayCaptionVisible。2026-09-30）。
    // 中身の入れ替えは、出す時に行う（隠れている間に中身だけ変えても、出るときのアニメーションを頭からやり直す）。
    // Leafletのmovestartは画面の大きさが変わったとき（時計や操作ボタンが出て地図の大きさが変わる、など）にも
    // 一瞬出るため、隠す条件には再生が自分で動かしたカメラ（replay.cameraMoving）だけを使う（2026-09-27）
    var aboutToMove = replay.playing && !st.icon && Core.replayAboutToMove(tl, r);
    var capVisible = Core.replayCaptionVisible(st, { cameraMoving: replay.cameraMoving, aboutToMove: aboutToMove });
    var cap = $('#replayCaption');
    if (st.captionIndex !== replay.captionIndex) {
      replay.captionIndex = st.captionIndex;
      replay.captionShown = false; // 新しい吹き出し。出せる状態になったら、中身を入れてから出す
      var s0 = tl.stops[st.captionIndex];
      if (!s0) { cap.hidden = true; showReplayCaptionPhotos([]); }
    }
    if (capVisible && !replay.captionShown) {
      var s = tl.stops[st.captionIndex];
      $('#replayCaptionTime').textContent = s.estimated ? '' : minuteToHHMM(s.minute);
      $('#replayCaptionTitle').textContent = s.label;
      $('#replayCaptionLines').innerHTML = s.captions.map(function (c) { return '<div>' + escapeHtml(c) + '</div>'; }).join('');
      showReplayCaptionPhotos(s.photos || []);
      preloadNextReplayPhotos(st.captionIndex);
      cap.hidden = true;
      void cap.offsetWidth;
      cap.hidden = false;
      replay.captionShown = true;
    } else if (!capVisible && replay.captionShown) {
      // 出発の前・カメラが動く間は消す。同じ地点の吹き出しは、消したあと（一時停止のシークなどで）
      // 出せる状態に戻ったら、写真を頭からもう一度出す
      cap.hidden = true;
      showReplayCaptionPhotos([]);
      replay.captionShown = false;
    }
    cap.classList.remove('hide-for-move');

    $('#replayProgressBar').style.width = (tl.totalReal ? Math.min(100, r / tl.totalReal * 100) : 100) + '%';
  }

  var REPLAY_MAX_FRAME_SEC = 0.1;
  function replayTick(ts) {
    if (!replay || !replay.playing) return;
    // 1コマで進める時間は最大REPLAY_MAX_FRAME_SEC。端末が一瞬固まる（初めて開いたときに線路の道のりを
    // 計算する、写真を読み込む、など）と、以前はその時間ぶん再生が一気に飛び、吹き出しや写真が「一瞬出て
    // すぐ消える」ように見えていた（大阪旅の新大阪・ユニバ、2026-09-27）。固まった分は飛ばさず、続きから再生する
    if (replay.lastTs !== null) {
      var dt = Math.min(Math.max(0, (ts - replay.lastTs) / 1000), REPLAY_MAX_FRAME_SEC);
      replay.r = Math.min(replay.tl.totalReal, replay.r + dt);
    }
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
    // 前の区間で始まったflyTo（区間の変わり目・再生中のカメラ移動）が終わっていないまま次のシークで
    // fitBoundsすると、Leafletがその移動を中途半端な位置・縮尺で終わらせてしまい、乗り物や線が
    // 地図（タイル）と少しずれて見えていた。まず止めてから位置を合わせる。
    // stop()はmoveendを出すことがあるので、先に「あとで」の預かりとアニメ中の記録を捨てる（捨てないと、
    // moveendの処理が預かったカメラ移動を始めてしまう）
    replay.cameraPending = null;
    replay.cameraFlying = null;
    replayMap.stop();
    replay.r = Math.max(0, Math.min(replay.tl.totalReal, r));
    replay.lastOffsetDiff = undefined; // 飛んだ先で「時差」のバナーを出さない
    replay.captionIndex = -2;
    replay.lastDay = 0;
    var st = Core.replayStateAt(replay.tl, replay.r);
    if (st.here) replayCenterOn(st.here.lat, st.here.lng, replayMap.getZoom());
    // カメラの判定（Core.cameraMoveDecision）は、いつも地図の今の中心・縮尺と比べるので、シーク先で
    // 合わせ直した見え方がそのまま基準になる（以前は別に持った「目的地」を更新し忘れると誤判定していた）。
    // すでにここでカメラを合わせたので、直後のrenderReplayが「区間・地点が変わった」と勘違いして
    // もう一度（アニメつきで）カメラを動かさないよう、いま合わせた状態を済みにしておく。以前は
    // lastLeg/lastStopを-1/-2に戻していたため、シーク先が区間の途中だとrenderReplayがすぐさま
    // flyToBounds（0.8秒）を始めてしまい、止まったはずの地図がもう一度少しずれて動いて見えていた。
    replay.lastLeg = st.icon ? st.icon.legIndex : -1;
    replay.lastStop = st.stopIndex;
    // 止めたflyToのぶんズームアニメの途中状態（線を隠す・止める扱い）が残らないよう、
    // 描画に関わる状態をここでリセットしてから、新しい位置・縮尺で線を描き直す（renderReplayが行う）。
    replay.mapAnimating = false;
    replay.cameraMoving = false;
    var pane = replayOverlayPane();
    if (pane) { pane.style.transition = 'none'; pane.style.opacity = '1'; }
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
    replayToken = null; // これより後に届く/routeの返事（前の旅行の分）は無視させる
    if (replay) {
      replay.playing = false;
      if (replay.raf) cancelAnimationFrame(replay.raf);
    }
    replay = null;
    // 閉じる・戻る・別の旅行の再生を開くときは、前の旅行の線・マーカー・乗り物アイコンを地図から消す
    // （再生中の状態＝replayはnullにするだけでは、Leafletの地図に足した線・マーカー自体は残ってしまい、
    // 次に開いたときに一瞬前の旅行の地図に見えていた。2026-09-26）
    if (replayLayer) replayLayer.clearLayers();
  }

  function closeReplay() {
    // 動画を作っている最中に閉じたら、録画を止めてシートも閉じる（docs/adr/0020）
    if (rsv.busy) rsvCancel();
    rsv.busy = false;
    closeReplayVideoSheet();
    stopReplay();
    showScreen('tripDetail');
    renderTripDetail();
  }

  // ---------- 動画でシェア（地図でふりかえるを、縦の動画にして共有する。docs/adr/0020） ----------
  // 絵コンテ・カメラ・時間割はCore（buildVideoStory / videoFrameAt）が決める。ここは、それを自前のcanvasに
  // 描き（OpenStreetMapのタイル・線・ピン・字）、canvas.captureStream() + MediaRecorderで録画し、
  // 共有シート（無ければダウンロード）に渡す部分。地図の画面（Leaflet）は使わない：タイルは<img>の集まりで、
  // そのままでは録画できないため。
  // 出さないもの：費用・精算・同行者や記録した人の名前・メールアドレス・エピソード本文。旅行名・日付・地名（と、
  // 利用者が選んだときだけ写真）だけを使う。共有する文章のURLは、旅行のリンクではなくアプリのURL（旅行のリンクは
  // 編集もできてしまうので、SNSには絶対に載せない）。
  var VIDEO_FONT = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, sans-serif';
  var VIDEO_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'; // 地図でふりかえると同じタイル
  var VIDEO_TILE_LIMIT = 260;  // 1本の動画で取るタイルの上限（OSMのタイル利用ポリシーに配慮。超えたら寄りすぎないようにする）
  var VIDEO_TILE_CONCURRENCY = 6;
  var VIDEO_BITRATE = 3000000; // 3Mbps（15秒で5MBほど。地図は細かいので下げすぎない）
  var VIDEO_INK = '#1C1E21';
  var VIDEO_ACCENT = '#00BF8F';

  var videoTiles = {};       // 'z/x/y' → 読み込めた<img>、または'fail'（このあいだ使い回す）
  var videoPhotoImages = {}; // 写真ID → 読み込めた<img>（読めなかったものは入れない）
  var rsv = { busy: false, recording: false, token: null, recorder: null, blob: null, file: null, mime: null, objectUrl: '' };

  function videoShareText() { return 'この旅行の足跡をみんなに共有 #旅の足跡\n' + PUBLIC_WEB_BASE; }
  function videoAppHost() { return PUBLIC_WEB_BASE.replace(/^https?:\/\//, '').replace(/\/$/, ''); }

  // 動画にできるのは、地図に出せる場所が2か所以上あるとき。ボタンはふりかえりの準備ができてから出す
  function updateReplayVideoButton() {
    var btn = $('#btnReplayVideo'), hint = $('#rsvHint');
    if (!btn || !hint) return;
    if (!replay) { btn.hidden = true; hint.hidden = true; return; }
    var ok = Core.videoLocatedStops(replay.tl).length >= 2;
    btn.hidden = false;
    btn.disabled = !ok;
    hint.hidden = ok;
    hint.textContent = ok ? '' : '場所が2か所以上ないと動画にできません';
  }

  function rsvShowPanel(name) {
    ['options', 'progress', 'result'].forEach(function (p) { $('#rsv' + p.charAt(0).toUpperCase() + p.slice(1)).hidden = p !== name; });
  }
  function rsvSetProgress(frac, text) {
    var pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    $('#rsvPercent').textContent = pct + '%';
    $('#rsvBarFill').style.width = pct + '%';
    if (text) $('#rsvProgressText').textContent = text;
  }

  function openReplayVideoSheet() {
    if (!replay || Core.videoLocatedStops(replay.tl).length < 2) return;
    setReplayPlaying(false); // 動画を作っているあいだ、ふりかえりの地図は止めておく（重い処理を重ねない）
    rsvReleaseVideo();
    // この旅行に写真つきの場所が無ければ、写真の選択肢そのものを出さない
    var withPhotos = Core.buildVideoStory(replay.tl, { photos: true });
    $('#rsvPhotosRow').hidden = !(withPhotos && withPhotos.hasPhotos);
    $('#rsvPhotosNote').hidden = $('#rsvPhotosRow').hidden;
    $('#rsvPhotos').checked = false; // 同行者の顔が写ることがあるので、いつもOFFから
    $('#rsvStatus').textContent = '';
    rsvShowPanel('options');
    $('#rsvSheet').hidden = false;
    document.body.classList.add('sheet-open');
  }

  function rsvReleaseVideo() {
    var v = $('#rsvVideo');
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    if (rsv.objectUrl) { try { URL.revokeObjectURL(rsv.objectUrl); } catch (e) { /* 何もしない */ } }
    rsv.objectUrl = ''; rsv.blob = null; rsv.file = null;
  }

  function closeReplayVideoSheet() {
    if (rsv.busy) return; // 作っている最中は「キャンセル」だけで閉じる
    $('#rsvSheet').hidden = true;
    document.body.classList.remove('sheet-open');
    rsvReleaseVideo();
  }

  // 作っている途中で、キャンセル・画面を離れた・ふりかえりを閉じたとき
  function rsvCancel(message) {
    if (!rsv.busy) return;
    if (rsv.token) rsv.token.cancelled = true;
    if (rsv.recorder && rsv.recorder.state !== 'inactive') { try { rsv.recorder.stop(); } catch (e) { /* 何もしない */ } }
    if (message) showToast(message);
  }

  // 画面が表に出ている（document.hiddenでない）ときにtrueで解決する。キャンセルされたらfalse
  function videoWaitUntilVisible(token) {
    return new Promise(function (resolve) {
      if (!document.hidden) { resolve(true); return; }
      rsvSetProgress(0.45, '画面に戻ると録画を始めます');
      var timer = setInterval(function () {
        if (token.cancelled) { clearInterval(timer); resolve(false); return; }
        if (!document.hidden) { clearInterval(timer); resolve(true); }
      }, 300);
    });
  }

  function videoLoadImage(url, timeoutMs) {
    return new Promise(function (resolve) {
      var im = new Image(), done = false, timer = null;
      function fin(v) {
        if (done) return;
        done = true; clearTimeout(timer); im.onload = im.onerror = null; resolve(v);
      }
      timer = setTimeout(function () { fin(null); }, timeoutMs || 10000);
      // canvasに描いても汚れない（tainted）ように、CORSつきで読む。取れなかった画像は使わず、動画は続ける
      im.crossOrigin = 'anonymous';
      im.onload = function () { fin(im); };
      im.onerror = function () { fin(null); };
      im.src = url;
    });
  }

  // items（配列）をlimit個ずつ同時に処理する。worker(item)は必ずPromiseを返し、失敗しない
  function videoRunPool(items, limit, worker, onStep, token) {
    return new Promise(function (resolve) {
      var next = 0, active = 0, finished = 0;
      function step() {
        if (token.cancelled) { if (!active) resolve(); return; }
        while (active < limit && next < items.length) {
          active++;
          worker(items[next++]).then(function () {
            active--; finished++;
            onStep(finished, items.length);
            step();
          });
        }
        if (finished >= items.length) resolve();
      }
      step();
    });
  }

  function videoLoadTile(tile) {
    var key = tile.z + '/' + tile.x + '/' + tile.y;
    if (videoTiles[key] instanceof HTMLImageElement) return Promise.resolve();
    var url = VIDEO_TILE_URL.replace('{z}', tile.z).replace('{x}', tile.x).replace('{y}', tile.y);
    return videoLoadImage(url, 8000).then(function (im) { videoTiles[key] = im || 'fail'; });
  }

  function videoRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function videoDrawCover(ctx, img, x, y, w, h) {
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    var ir = iw / ih, r = w / h, sx, sy, sw, sh;
    if (ir > r) { sh = ih; sw = sh * r; sx = (iw - sw) / 2; sy = 0; }
    else { sw = iw; sh = sw / r; sx = 0; sy = (ih - sh) / 2; }
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  }

  function videoDrawMap(ctx, cam, W, H) {
    ctx.fillStyle = '#E8EBEF'; // タイルが取れなかったところは、ふりかえりの地図と同じ薄いグレー
    ctx.fillRect(0, 0, W, H);
    var vt = Core.videoViewTiles(cam, W, H);
    vt.list.forEach(function (t) {
      var img = videoTiles[vt.z + '/' + t.x + '/' + t.y], size = vt.size + 0.6; // 継ぎ目が出ないよう少し重ねる
      if (img instanceof HTMLImageElement) { ctx.drawImage(img, t.px, t.py, size, size); return; }
      // 取れていないタイルは、1〜3段引いたタイルを引き伸ばして代わりにする
      for (var d = 1; d <= 3 && vt.z - d >= 0; d++) {
        var parent = videoTiles[(vt.z - d) + '/' + (t.x >> d) + '/' + (t.y >> d)];
        if (parent instanceof HTMLImageElement) {
          var n = Math.pow(2, d), sub = 256 / n;
          ctx.drawImage(parent, (t.x % n) * sub, (t.y % n) * sub, sub, sub, t.px, t.py, size, size);
          return;
        }
      }
    });
  }

  function videoStrokePath(ctx, pts, proj, color, width, alpha, dash) {
    if (!pts.length) return;
    ctx.beginPath();
    pts.forEach(function (p, i) { var q = proj(p[0], p[1]); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
    ctx.setLineDash(dash || []);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  function videoDrawPin(ctx, x, y, scale, big) {
    var r = (big ? 16 : 12) * scale;
    ctx.save();
    ctx.shadowColor = 'rgba(20, 20, 30, 0.35)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3;
    ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2); ctx.fillStyle = '#FFFFFF'; ctx.fill();
    ctx.restore();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = VIDEO_ACCENT; ctx.fill();
  }

  function videoDrawCaption(ctx, cap, W) {
    var img = cap.photo ? videoPhotoImages[cap.photo] : null;
    var measure = function (s) { return ctx.measureText(s).width; };
    ctx.font = '700 44px ' + VIDEO_FONT;
    var lines = cap.label ? Core.videoWrapLines(cap.label, 530, measure, 2) : [];
    if (!lines.length && !img) return;
    var cardW = 600, x = (W - cardW) / 2, photoH = img ? 320 : 0, textH = lines.length ? 34 + lines.length * 54 : 0;
    var h = photoH + textH, y = 1010 - h + (1 - cap.alpha) * 28;
    ctx.save();
    ctx.globalAlpha = cap.alpha;
    ctx.shadowColor = 'rgba(20, 20, 30, 0.3)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 8;
    videoRoundRect(ctx, x, y, cardW, h, 32);
    ctx.fillStyle = '#FFFFFF'; ctx.fill();
    ctx.shadowColor = 'transparent';
    if (img) {
      ctx.save();
      videoRoundRect(ctx, x, y, cardW, h, 32); ctx.clip();
      videoDrawCover(ctx, img, x, y, cardW, photoH);
      ctx.restore();
    }
    ctx.fillStyle = VIDEO_INK; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.font = '700 44px ' + VIDEO_FONT;
    lines.forEach(function (l, i) { ctx.fillText(l, x + 36, y + photoH + 20 + 42 + i * 54); });
    ctx.restore();
  }

  function videoEaseOutBack(u) { var c = u - 1; return 1 + 2.7 * c * c * c + 1.7 * c * c; }

  // t秒時点の1コマをcanvasに描く
  function drawVideoFrame(ctx, story, t) {
    var W = story.w, H = story.h, fs = Core.videoFrameAt(story, t), cam = fs.camera;
    var proj = function (lat, lng) { return Core.videoProject(cam, W, H, lat, lng); };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    videoDrawMap(ctx, cam, W, H);

    // 道のり：区間に入ったら、これから通る道を薄い青で先に見せ、進んだところまでを白い縁取りの濃い青で伸ばす
    // （地図でふりかえると同じ見た目。飛行機は縁取りなしの点線）
    fs.segs.forEach(function (sg) {
      if (!(sg.f > 0)) return;
      var seg = story.segs[sg.k], plane = seg.transport === 'plane';
      var dash = plane ? [16, 18] : null;
      if (sg.f < 1) videoStrokePath(ctx, seg.path, proj, ROUTE_BLUE, plane ? 6 : 9, 0.4, dash);
      var prefix = Core.pathAt(seg.path, sg.f).prefix;
      if (!plane) videoStrokePath(ctx, prefix, proj, '#FFFFFF', 14, 0.95, null);
      videoStrokePath(ctx, prefix, proj, ROUTE_BLUE, plane ? 6 : 9, 0.95, dash);
    });
    fs.pins.forEach(function (p) {
      if (!p.pop) return;
      var w = story.wps[p.k], pt = proj(w.lat, w.lng);
      videoDrawPin(ctx, pt.x, pt.y, videoEaseOutBack(p.pop), p.captioned);
    });
    if (fs.head) {
      var hp = proj(fs.head.lat, fs.head.lng);
      ctx.beginPath(); ctx.arc(hp.x, hp.y, 17, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF'; ctx.shadowColor = 'rgba(20, 20, 30, 0.35)'; ctx.shadowBlur = 8; ctx.fill(); ctx.shadowColor = 'transparent';
      ctx.beginPath(); ctx.arc(hp.x, hp.y, 10, 0, Math.PI * 2); ctx.fillStyle = ROUTE_BLUE; ctx.fill();
    }

    if (fs.showDay) {
      var dayText = fs.day + '日目';
      ctx.font = '800 34px ' + VIDEO_FONT;
      var dw = ctx.measureText(dayText).width + 48;
      videoRoundRect(ctx, 36, 150, dw, 62, 31);
      ctx.fillStyle = 'rgba(28, 30, 33, 0.82)'; ctx.fill();
      ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(dayText, 60, 194);
    }
    if (fs.caption) videoDrawCaption(ctx, fs.caption, W);

    // 導入：旅行名と日付
    if (fs.introAlpha > 0) {
      ctx.fillStyle = 'rgba(20, 22, 26,' + (0.68 * fs.introAlpha) + ')';
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = Math.min(fs.introAlpha, fs.introTextAlpha);
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#FFFFFF';
      ctx.font = '800 68px ' + VIDEO_FONT;
      var tl = Core.videoWrapLines(story.title || '旅の記録', 600, function (s) { return ctx.measureText(s).width; }, 3);
      var top = 500 - (tl.length - 1) * 44;
      tl.forEach(function (l, i) { ctx.fillText(l, W / 2, top + i * 88); });
      var by = top + (tl.length - 1) * 88 + 44;
      ctx.fillStyle = VIDEO_ACCENT; ctx.fillRect(W / 2 - 36, by, 72, 6);
      if (story.dateText) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'; ctx.font = '600 40px ' + VIDEO_FONT;
        ctx.fillText(story.dateText, W / 2, by + 80);
      }
      ctx.globalAlpha = 1;
    }
    // 締め：アプリ名・ロゴ・URL
    if (fs.outroAlpha > 0) {
      ctx.fillStyle = 'rgba(20, 22, 26,' + (0.8 * fs.outroAlpha) + ')';
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = fs.outroAlpha;
      videoRoundRect(ctx, W / 2 - 88, 410, 176, 176, 48);
      ctx.fillStyle = VIDEO_ACCENT; ctx.fill();
      ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.font = '700 108px ' + VIDEO_FONT;
      ctx.fillText('旅', W / 2, 526);
      ctx.font = '800 68px ' + VIDEO_FONT;
      ctx.fillText('旅の足跡', W / 2, 690);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.88)'; ctx.font = '600 36px ' + VIDEO_FONT;
      ctx.fillText(videoAppHost(), W / 2, 756);
      ctx.globalAlpha = 1;
    }

    // OpenStreetMapのクレジット（タイルの利用条件。いつも右下に出す）
    ctx.font = '500 20px ' + VIDEO_FONT;
    var credit = '© OpenStreetMap contributors', cw = ctx.measureText(credit).width + 20;
    videoRoundRect(ctx, W - 16 - cw, 1150, cw, 32, 8);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.82)'; ctx.fill();
    ctx.fillStyle = '#333333'; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(credit, W - 26, 1173);
  }

  // canvasに描いたものを録画する。時間割はcanvasを描いた時刻（経過時間）で決めるので、端末が遅くて
  // コマが落ちても、動画の長さは変わらない（なめらかさだけが落ちる）
  function videoRecord(canvas, ctx, story, mime, token, onProgress) {
    return new Promise(function (resolve, reject) {
      var stream = canvas.captureStream(story.fps);
      var recorder;
      try { recorder = new MediaRecorder(stream, { mimeType: mime.mime, videoBitsPerSecond: VIDEO_BITRATE }); }
      catch (e) { recorder = new MediaRecorder(stream); }
      var chunks = [];
      rsv.recorder = recorder;
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onerror = function (e) { stream.getTracks().forEach(function (t) { t.stop(); }); reject(e && e.error ? e.error : new Error('recorder_error')); };
      recorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        resolve(token.cancelled ? null : new Blob(chunks, { type: mime.type }));
      };
      drawVideoFrame(ctx, story, 0);
      recorder.start(1000);
      var t0 = null;
      function tick(now) {
        if (token.cancelled) return;
        if (t0 === null) t0 = now;
        var t = (now - t0) / 1000;
        if (t >= story.total) {
          drawVideoFrame(ctx, story, story.total);
          onProgress(1);
          // 最後のコマが録画に入るのを少し待ってから止める
          setTimeout(function () { if (recorder.state !== 'inactive') recorder.stop(); }, 300);
          return;
        }
        drawVideoFrame(ctx, story, t);
        onProgress(t / story.total);
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }

  function startReplayVideo() {
    if (rsv.busy || !replay) return;
    var status = $('#rsvStatus');
    status.textContent = '';
    var canvas = document.createElement('canvas');
    if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) {
      status.textContent = 'この端末（ブラウザ）は動画の作成に対応していません。';
      return;
    }
    var mime = Core.pickVideoMimeType(function (m) { return MediaRecorder.isTypeSupported(m); });
    if (!mime) { status.textContent = 'この端末（ブラウザ）は動画の作成に対応していません。'; return; }
    var tl = replay.tl, trip = state.trip || {};
    var usePhotos = !$('#rsvPhotosRow').hidden && $('#rsvPhotos').checked;
    var token = { cancelled: false };
    rsv.token = token; rsv.busy = true; rsv.recording = false;
    rsvReleaseVideo();
    rsvShowPanel('progress');
    rsvSetProgress(0, 'ルートを確認しています…');
    var routesReady = replay.routesDone
      ? Promise.race([replay.routesDone.catch(function () {}), new Promise(function (r) { setTimeout(r, 8000); })])
      : Promise.resolve();
    var story, ctx;
    routesReady.then(function () {
      if (token.cancelled) return null;
      var dateText = Core.videoDateRange(trip.startDate || replay.dates[0], trip.endDate || replay.dates[replay.dates.length - 1]);
      var maxZoom = 13, tiles;
      // 寄りすぎるとタイルが増える。OSMに負担をかけないよう、上限を超えるときは寄る上限を下げる
      for (;;) {
        story = Core.buildVideoStory(tl, { photos: usePhotos, title: (trip.title || '旅の記録') + (state.viewAccountId && $('#replayViewer').textContent ? '（' + $('#replayViewer').textContent + '）' : ''), dateText: dateText, maxZoom: maxZoom });
        if (!story) throw new Error('no_story');
        tiles = Core.videoTilesNeeded(story);
        if (tiles.length <= VIDEO_TILE_LIMIT || maxZoom <= 4) break;
        maxZoom--;
      }
      canvas.width = story.w; canvas.height = story.h;
      ctx = canvas.getContext('2d');
      var photoIds = [];
      story.wps.forEach(function (w) { if (w.caption && w.caption.photo && photoIds.indexOf(w.caption.photo) === -1) photoIds.push(w.caption.photo); });
      // 準備（地図のタイルと写真を先に全部取る）は全体の45%、録画が残り
      var prep = function (frac) { rsvSetProgress(frac * 0.45, '地図を読み込んでいます…'); };
      prep(0);
      var jobs = tiles.map(function (t) { return { tile: t }; }).concat(photoIds.map(function (id) { return { photo: id }; }));
      return videoRunPool(jobs, VIDEO_TILE_CONCURRENCY, function (job) {
        if (job.tile) return videoLoadTile(job.tile);
        return videoLoadImage(photoUrl(job.photo), 10000).then(function (im) { if (im) videoPhotoImages[job.photo] = im; });
      }, function (done, total) { prep(done / total); }, token).then(function () {
        if (token.cancelled) return null;
        // 汚れたcanvas（CORSが通らない画像を描いたもの）は録画できない。始める前に確かめる
        drawVideoFrame(ctx, story, story.introSec + 3);
        try { ctx.getImageData(0, 0, 1, 1); } catch (e) { throw new Error('tainted'); }
        // 準備のあいだに別の画面・アプリへ移っていると、描画が止まったまま録画が進み、動画が
        // 15秒より長く間延びする（録画中の切り替えはvisibilitychangeで中止するが、録画を
        // 始める前から裏に回っていた場合は通知が来ない。2026-09-30、確認中に見つけた）。
        // 画面に戻ってから録画を始める。
        return videoWaitUntilVisible(token);
      }).then(function (ok) {
        if (!ok || token.cancelled) return null;
        rsv.recording = true;
        rsvSetProgress(0.45, '動画を作っています…');
        return videoRecord(canvas, ctx, story, mime, token, function (f) { rsvSetProgress(0.45 + f * 0.55, '動画を作っています…'); });
      });
    }).then(function (blob) {
      rsv.busy = false; rsv.recording = false;
      if (token.cancelled || !blob) { rsvShowPanel('options'); return; }
      if (!blob.size) throw new Error('empty');
      rsv.blob = blob; rsv.mime = mime;
      rsv.file = new File([blob], 'tabinoashiato-trip.' + mime.ext, { type: mime.type });
      rsv.objectUrl = URL.createObjectURL(blob);
      var v = $('#rsvVideo');
      v.src = rsv.objectUrl;
      var p = v.play(); if (p && p.catch) p.catch(function () {});
      var canFile = !!(navigator.canShare && navigator.canShare({ files: [rsv.file] }));
      $('#btnRsvShare').textContent = canFile ? '共有する' : '動画を保存する';
      $('#rsvResultNote').textContent = (mime.isMp4 ? '' : 'この端末ではWebM形式で作られました。XやInstagramなど、WebMを受け付けないSNSがあります。') +
        (canFile ? '' : ' このブラウザは動画の共有に対応していないため、保存して投稿してください（投稿用の文章はコピーします）。');
      rsvShowPanel('result');
    }).catch(function (err) {
      rsv.busy = false; rsv.recording = false;
      rsvShowPanel('options');
      $('#rsvStatus').textContent = err && err.message === 'tainted'
        ? '地図や写真の画像を取り込めませんでした。写真を外してもう一度お試しください。'
        : '動画を作れませんでした。通信環境を確認して、もう一度お試しください。';
    });
  }

  // 共有シートで動画を渡す（ボタンを押した直後でないと開けないので、動画ができた画面のボタンから）。
  // 対応していない（パソコンのブラウザなど）ときは、動画を保存し、投稿用の文章をクリップボードへ。
  function shareReplayVideo() {
    var file = rsv.file, text = videoShareText();
    if (!file) return;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], text: text }).catch(function (e) {
        if (e && e.name === 'AbortError') return; // 共有シートを閉じただけなので何もしない
        saveReplayVideo(text);
      });
      return;
    }
    saveReplayVideo(text);
  }

  function saveReplayVideo(text) {
    if (!rsv.blob) return;
    // iOSアプリ（WKWebView）ではダウンロードが動かない。共有シートに対応していなければ、ここでは何もできない
    if (isNativeApp()) { showToast('この環境では動画を共有できませんでした。'); return; }
    downloadBlob(rsv.blob, rsv.file.name);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { showToast('動画を保存しました。投稿用の文章をコピーしました'); }, function () { showToast('動画を保存しました'); });
    } else {
      showToast('動画を保存しました');
    }
  }

  // ---------- 初期化 ----------
  // ---------- 入力欄の×（中身を消す）ボタン ----------
  // URLなどを入れたあと消すのが面倒、という要望より。1行の入力欄（テキスト・URL・検索・メール・数字）は、
  // 中身があるあいだ常に右端に×を出す（フォーカスの有無に関係なく見える。iOS標準の消去ボタンと違い、
  // 「入っているかどうか」が離れた場所からでもひと目で分かるようにする狙い）。
  // 複数行の欄（エピソードなど）は、長文を一度に消してしまうと困るので対象にしない。
  //
  // 以前は画面に1つだけ置いたボタンをフォーカス中の欄の上に重ねて動かす方式だったが、
  // ・フォーカスが外れると消えてしまい、複数の欄を一括で見比べて消す、という本来の要望に合わなかった
  // ・iOSのキーボード表示でレイアウトが動いたあとに再計算されず、位置がずれることがあった
  // ため、欄ごとに×を埋め込む方式にした。ただし要素を直接足すと親の並び（検索欄の横並び・
  // 費用明細の2列など）の幅が崩れるので、入力欄を幅0のラッパーで包み、元の欄が持っていた
  // flexのサイズ指定（flex-grow/shrink/basis・min-width）をラッパー側に移してから、
  // 欄自体は width:100% でラッパーいっぱいに広げる（どのレイアウトの親でも崩れないようにするため）。
  var CLEARABLE_TYPES = ['text', 'url', 'search', 'email', 'number'];
  var CLEAR_WRAP_CLASS = 'ipt-clear-wrap';

  function isClearable(el) {
    return !!(el && el.tagName === 'INPUT' && CLEARABLE_TYPES.indexOf(el.type) !== -1 &&
      !el.readOnly && !el.disabled && !el.hasAttribute('data-no-clear'));
  }

  function wrapForClearButton(input) {
    if (!isClearable(input)) return;
    if (input.parentNode && input.parentNode.classList && input.parentNode.classList.contains(CLEAR_WRAP_CLASS)) return; // 対応済み
    var cs = window.getComputedStyle(input);
    var wrap = document.createElement('span');
    wrap.className = CLEAR_WRAP_CLASS;
    // 元の欄が親（flexの並び・グリッドなど）から受け取っていたサイズ指定を、そのままラッパーに引き継ぐ。
    wrap.style.flexGrow = cs.flexGrow;
    wrap.style.flexShrink = cs.flexShrink;
    wrap.style.flexBasis = cs.flexBasis;
    wrap.style.minWidth = cs.minWidth;
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.style.width = '100%';
    input.style.minWidth = '0';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'input-clear-btn';
    btn.setAttribute('aria-label', '入力を消す');
    btn.textContent = '×';
    btn.hidden = !input.value;
    // 押したときに入力欄からフォーカスが外れる前に処理する
    btn.addEventListener('pointerdown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', function () {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.focus();
      btn.hidden = true;
    });
    input.addEventListener('input', function () { btn.hidden = !input.value; });
    wrap.appendChild(btn);
  }

  function wrapClearableInputsIn(root) {
    if (!root || (root.nodeType !== 1 && root.nodeType !== 9)) return;
    if (root.nodeType === 1 && root.matches && root.matches('input')) wrapForClearButton(root);
    var inputs = root.querySelectorAll ? root.querySelectorAll('input') : [];
    for (var i = 0; i < inputs.length; i++) wrapForClearButton(inputs[i]);
  }

  // 欄の値を、フォームを開いたときの初期化などで input イベントを出さずに直接書き換えている箇所が
  // いくつかある（例：openEntryForm での #entPlaceSearch のリセット）。そうした変更を漏れなく拾うため、
  // 軽い間隔でも全欄の表示・非表示を値と突き合わせて直す（欄の数は多くないので負荷は無視できる）。
  function syncAllClearButtons() {
    var wraps = document.getElementsByClassName(CLEAR_WRAP_CLASS);
    for (var i = 0; i < wraps.length; i++) {
      var input = wraps[i].querySelector('input');
      var btn = wraps[i].querySelector('.input-clear-btn');
      if (input && btn) btn.hidden = !input.value;
    }
  }

  function initClearButtons() {
    wrapClearableInputsIn(document);
    // 費用明細・レビュー項目・移動の情報など、あとから描き足される欄にも効かせる
    var mo = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          if (added[j].nodeType === 1) wrapClearableInputsIn(added[j]);
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    setInterval(syncAllClearButtons, 300);
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
    $('#settleUnitPicker').addEventListener('click', function (e) {
      var b = e.target.closest('.settle-unit-opt');
      if (b) saveSettleUnit(Number(b.dataset.unit));
    });
    $('#filterCompanion').addEventListener('change', function (e) { state.homeFilters.companion = e.target.value; renderHomeTripList(); });
    $('#filterYear').addEventListener('change', function (e) { state.homeFilters.year = e.target.value; renderHomeTripList(); });
    $('#filterTripType').addEventListener('change', function (e) { state.homeFilters.tripType = e.target.value; renderHomeTripList(); });
    $('#sortTripOrder').addEventListener('change', function (e) { state.homeFilters.sort = e.target.value; renderHomeTripList(); });

    $('#mylogFilterCompanion').addEventListener('change', function (e) {
      state.mylogFilters.companion = e.target.value; saveMylogFilters(state.mylogFilters); renderMyLogTrips();
    });
    $('#mylogFilterYear').addEventListener('change', function (e) {
      state.mylogFilters.year = e.target.value; saveMylogFilters(state.mylogFilters); renderMyLogTrips();
    });
    $('#mylogSortTripOrder').addEventListener('change', function (e) {
      state.mylogFilters.sort = e.target.value; saveMylogFilters(state.mylogFilters); renderMyLogTrips();
    });
    $('#btnClearTripHistory').addEventListener('click', openTripHistorySheet);
    $('#btnClearAllHistory').addEventListener('click', clearTripHistory);
    $('#btnRemoveSelectedHistory').addEventListener('click', removeSelectedTripHistory);
    $('#btnCloseTripHistorySheet').addEventListener('click', closeTripHistorySheet);
    $('#btnCancelTripHistory').addEventListener('click', closeTripHistorySheet);
    $('#tripHistorySheet').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeTripHistorySheet(); });
    $('#tripHistoryList').addEventListener('change', updateTripHistorySelection);
    $('#btnScanReceipt').addEventListener('click', function () { if (!confirmAiDataSharing()) return; $('#receiptFileInput').click(); });
    $('#btnPlaceSearch').addEventListener('click', showPlaceMapPreview);
    $('#btnArriveSearch').addEventListener('click', searchArrivePlace);
    $('#entArriveSearch').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); searchArrivePlace(); } });
    $('#entArriveCandidates').addEventListener('click', function (e) {
      var c = e.target.closest('[data-arrive-choice]');
      if (c) chooseArrivePlace(Number(c.getAttribute('data-arrive-choice')));
    });
    $('#entPlaceCandidates').addEventListener('click', function (e) {
      var b = e.target.closest('[data-place-choice]');
      if (b) choosePlaceCandidate(b.dataset.placeChoice);
    });
    $('#entPlaceCandidates').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var b = e.target.closest('[data-place-choice]');
      if (!b) return;
      e.preventDefault();
      choosePlaceCandidate(b.dataset.placeChoice);
    });
    $('#btnMapZoomIn').addEventListener('click', function () { zoomPlaceFrame(1); });
    $('#btnMapZoomOut').addEventListener('click', function () { zoomPlaceFrame(-1); });
    $('#entPlaceSearch').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); showPlaceMapPreview(); }
    });
    $('#receiptFileInput').addEventListener('change', function (e) {
      var file = e.target.files[0];
      e.target.value = '';
      if (file) handleScanReceipt(file);
    });
    $('#btnCancelWeatherEdit').addEventListener('click', function () { $('#weatherEditPanel').hidden = true; });
    $('#weatherPicker').addEventListener('click', function (e) {
      var opt = e.target.closest('.weather-picker-opt');
      if (opt) saveWeatherEdit(opt.dataset.code);
    });
    initBlockDragReorder();
    initEntryDragMove();
    initDaySwipe();
    // マイログ・旅先一覧・プロフィールはボトムタブバーのトップレベル画面になったので、
    // 「← 戻る」／edge-swipe-back（画面端からのスワイプで戻る）はもう無い。タブ同士の行き来は
    // ボトムタブバーのタップだけ（2026-09-29〜。initTabSwipeは各画面の中の横スワイプだけに使う。
    // 旅の詳細（tripDetail）はこれまでどおりedge-swipe-backで戻る）。
    initTabSwipe($('#mylogList'), mylogResolveSwipe, mylogHasSwipeTarget);
    initTabSwipe(document.querySelector('[data-screen="visited"]'), visitedResolveSwipe, visitedHasSwipeTarget);
    initEdgeSwipeBack(document.querySelector('[data-screen="tripDetail"]'), returnFromTripDetail);
    document.addEventListener('click', function (e) {
      if (e.target.closest('.entry-card-head') || e.target.closest('.entry-move-menu')) return;
      $all('.entry-move-menu').forEach(function (m) { m.hidden = true; m.innerHTML = ''; });
    });

    $('#btnNewTrip').addEventListener('click', openNewTripForm);
    $('#btnCreateTrip').addEventListener('click', createTrip);
    // 出発日を選んだら、帰着日が空（または出発日より前）のときは出発日を入れておく。帰着日のカレンダーが
    // 今月（2026年9月など）から開いて、過去の旅行だと月をさかのぼり直す手間があったため（2026-09-27）。
    // 帰着日にはその日より前を選べないよう min も付ける
    [['#ntStart', '#ntEnd'], ['#teStart', '#teEnd']].forEach(function (pair) {
      var start = $(pair[0]), end = $(pair[1]);
      if (!start || !end) return;
      var sync = function () {
        end.min = start.value || '';
        if (start.value && (!end.value || end.value < start.value)) end.value = start.value;
      };
      start.addEventListener('change', sync);
      start.addEventListener('input', sync);
    });
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
    $('#btnReplayVideo').addEventListener('click', openReplayVideoSheet);
    $('#btnCloseRsv').addEventListener('click', closeReplayVideoSheet);
    $('#rsvSheet').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeReplayVideoSheet(); });
    $('#btnRsvStart').addEventListener('click', startReplayVideo);
    $('#btnRsvCancel').addEventListener('click', function () { rsvCancel('キャンセルしました'); });
    $('#btnRsvShare').addEventListener('click', shareReplayVideo);
    $('#btnRsvAgain').addEventListener('click', function () { rsvReleaseVideo(); rsvShowPanel('options'); });
    // 録画中に画面を離れると、ブラウザが描画を止めて動画が固まる。作り直せるよう中止する
    document.addEventListener('visibilitychange', function () {
      if (rsv.recording && document.hidden) rsvCancel('画面を離れたので、動画づくりを中止しました');
    });

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
    $('#btnCopyAiPrompt').addEventListener('click', copyAiImportPrompt);
    $('#btnImportJson').addEventListener('click', handleImportJson);

    $('#btnSaveBlock').addEventListener('click', saveBlock);
    $('#btnDeleteBlock').addEventListener('click', deleteBlock);

    $('#btnSaveEntry').addEventListener('click', saveEntry);
    $('#btnDeleteEntry').addEventListener('click', deleteEntry);
    $('#entTravelDepart').addEventListener('input', updateTravelDuration);
    $('#entTravelArrive').addEventListener('input', updateTravelDuration);
    $('#btnAddCostItem').addEventListener('click', function () {
      var newItem = { label: '', amount: 0 };
      var lastCur = lastCostCurrencyForTrip();
      if (lastCur && lastCur !== 'JPY') newItem.currency = lastCur;
      state.formCostItems.push(newItem);
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
        // 旅の詳細（tripDetail）の「← 戻る」だけは特別扱い：「行ったことある旅先」・マイログの
        // 旅行リンクから開いた旅行なら、そのページに戻す（returnFromTripDetail、openTripのreturnTo）。
        // それ以外のdata-back="home"（新しい旅を作る、など）はこれまでどおりホームへ。
        if (to === 'home' && b.classList.contains('back-btn') && state.tripReturnScreen) {
          returnFromTripDetail();
          return;
        }
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
    $all('.login-provider-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { startSocialLogin(btn.dataset.provider); });
    });
    $('#btnSocialCancel').addEventListener('click', cancelSocialWaiting);
    $('#btnSendOtp').addEventListener('click', handleSendOtp);
    $('#btnVerifyOtp').addEventListener('click', handleVerifyOtp);
    $('#btnResendOtp').addEventListener('click', handleSendOtp);
    $('#visitedTabs').addEventListener('click', function (e) {
      var btn = e.target.closest('.visited-tab');
      if (!btn) return;
      state.visitedTab = btn.dataset.tab;
      state.visitedSel = null;
      renderVisitedPlaces();
    });
    // プラン（音声入力プラン）はプロフィール画面に移した（2026-09-28〜、ボトムタブバー導入）
    $('#btnGoToPlans').addEventListener('click', function () {
      if (loadCurrentUser()) openProfile(); else openLogin('profile');
    });
    $('#planBadgeTop').addEventListener('click', function () {
      if (loadCurrentUser()) openProfile(); else openLogin('profile');
    });
    $('#btnManageBilling').addEventListener('click', startBillingPortal);
    $('#btnDeleteAccount').addEventListener('click', deleteMyAccount);
    initSocial();
    $('#btnCloseTzOverrideSheet').addEventListener('click', closeTzOverrideSheet);
    $('#tzOverrideSheet').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeTzOverrideSheet(); });
    // 自分だけの道（別行動）の追加・編集シート（docs/adr/0021）
    $('#btnCloseBranchSheet').addEventListener('click', closeBranchSheet);
    $('#btnCancelBranch').addEventListener('click', closeBranchSheet);
    $('#btnSaveBranch').addEventListener('click', saveBranch);
    $('#btnDeleteBranch').addEventListener('click', removeBranch);
    $('#branchSheet').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeBranchSheet(); });

    // ---------- ボトムタブバー（マイログ・旅先一覧・旅の足跡・プロフィール。2026-09-28〜） ----------
    // タップした瞬間だけ.popを付けてアイコンのバウンス演出をやり直させる（連続タップでも毎回動くよう、
    // 一度外してから付け直す＝reflowを挟んで同じアニメーションを再トリガーする定番の書き方）。
    $all('.tabbar-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var icon = btn.querySelector('.tabbar-icon');
        if (icon) {
          icon.classList.remove('pop');
          void icon.offsetWidth;
          icon.classList.add('pop');
        }
        openTabScreen(btn.dataset.tab);
      });
    });

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

    // 前回の途中状態（待機表示・メール確認の待ち）を消してから、使えるログイン方法を並べる
    state.linkCode = '';
    $('#socialWaiting').hidden = true;
    $('#socialLogin').hidden = false;
    $('#loginLinkNote').hidden = true;
    $('#emailLoginDivider').hidden = true;
    applyAuthProviders([]);
    api('/auth/providers').then(function (res) {
      applyAuthProviders((res && res.providers) || []);
    }).catch(function () {
      // 取れなくてもメールログインは使える
    });
    var existing = loadCurrentUser() || state.staleLoginUser;
    $('#loginName').value = (existing && existing.provider === 'email') ? existing.name : '';
    $('#loginEmail').value = (existing && existing.provider === 'email') ? existing.email : '';
    $('#loginOtpCode').value = '';
    $('#emailLoginForm').hidden = false;
    $('#emailOtpForm').hidden = true;
  }

  // メールでのログイン（OTP）。実際にメールで6桁のコードを送り、入力してもらうことで
  // 「メールの持ち主であること」をサーバー側で確認する（Apple・Google・LINEは
  // Workerが検証するので、これはそのうち「プロバイダーを使わない」方法）。
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
    var verifyBody = { email: email, code: code };
    if (state.linkCode) verifyBody.link = state.linkCode; // ソーシャルログインで受け取れなかったメールを、ここで結びつける
    api('/auth/email/verify', 'POST', verifyBody).then(function (res) {
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
  function ensureAccountAndProceed(user, opts) {
    saveCurrentUser(user);
    renderAccountRow();
    api('/accounts/ensure', 'POST', { email: user.email, name: user.name || '' }).then(function (account) {
      saveCurrentUser(Object.assign({}, loadCurrentUser(), { accountId: account.accountId }));
    }).catch(function () {
      // アカウントIDが取れなくてもログインは成立させる
    }).then(function () {
      // Webでプロバイダーから戻ってきた直後は、いま開いている画面（共有された旅行など）を動かさない
      if (opts && opts.stay) { renderAccountRow(); if (state.trip) loadSocial(); return; }
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
    } else if (target === 'visited' && loggedIn) {
      openVisitedPlaces();
    } else if (target === 'profile' && loggedIn) {
      openProfile();
    } else {
      goHome();
    }
  }

  // ---------- Apple・Google・LINEでのログイン（Worker側の認可コードフロー。docs/adr/0019） ----------
  // ブラウザ用のプロバイダーSDKは使わない。ログインの相手方（プロバイダー）とのやり取りは全部
  // Workerがやり、アプリは「開始URLを開く」→「使い捨てコードをセッションに交換する」だけ。
  var SOCIAL_NAMES = { apple: 'Apple', google: 'Google', line: 'LINE' };
  var LOGIN_RETURN_KEY = 'tabilog:login-return';

  function applyAuthProviders(list) {
    if (state.linkCode) return; // メール確認待ちの間はソーシャルボタンを出さない
    $all('.login-provider-btn').forEach(function (btn) {
      btn.hidden = list.indexOf(btn.dataset.provider) === -1;
    });
    $('#emailLoginDivider').hidden = list.length === 0;
  }

  function startSocialLogin(provider) {
    var base = API_BASE + '/auth/' + provider + '/start';
    if (isNativeApp()) {
      // iOSアプリ：WKWebViewの中ではGoogleなどがログインをブロックするので、システムのブラウザ（Safari）で
      // 開く。Workerのホストはcapacitor.config.jsonのallowNavigationに無いため、Capacitorが自動で
      // Safariに渡す（プラグインの追加は不要）。ログインが終わると、Workerが出す「アプリに戻る」ページが
      // tabilog://auth?code=…でこのアプリを起動する（listenForAppLinks→handleAuthAppUrl）。
      // ポーリングはしない：待ち合わせIDで結果を取りに行く方式は、IDを知る第三者にコードを盗まれる（docs/adr/0019）。
      showSocialWaiting(provider);
      window.open(base + '?return=app', '_blank');
      return;
    }
    // Web：このページごとプロバイダーへ移動し、終わると #auth=... を付けてこのページに戻ってくる
    try { sessionStorage.setItem(LOGIN_RETURN_KEY, state.loginReturnTo || 'home'); } catch (e) { /* 保存できなくても続行 */ }
    location.href = base + '?return=' + encodeURIComponent(location.origin + location.pathname + location.search);
  }

  function showSocialWaiting(provider) {
    $('#socialLogin').hidden = true;
    $('#emailLoginDivider').hidden = true;
    $('#emailLoginForm').hidden = true;
    $('#emailOtpForm').hidden = true;
    $('#socialWaiting').hidden = false;
    $('#socialWaitingText').textContent = 'ブラウザで' + (SOCIAL_NAMES[provider] || '') + 'のログインを進めてください。終わると自動でこのアプリに戻ります。戻らないときは、ブラウザの「旅の足跡アプリに戻る」ボタンを押してください。';
    $('#loginStatus').textContent = '';
  }

  function cancelSocialWaiting() {
    openLogin(state.loginReturnTo);
  }

  function openLoginRefreshProviders() {
    api('/auth/providers').then(function (res) { applyAuthProviders((res && res.providers) || []); }).catch(function () {});
  }

  function socialErrorMessage(error) {
    return error === 'cancelled' ? 'ログインをキャンセルしました。' : 'ログインに失敗しました。もう一度お試しください。';
  }

  // プロバイダーでの操作が終わった結果（アプリではtabilog://auth?…、Webでは#auth=…）を受け取る
  function handleSocialResult(kind, code, error, opts) {
    if (kind === 'error' || !code) {
      // ログイン画面に居るならそこに表示、Webで元の画面に戻ってきたときは画面を動かさずトーストで知らせる
      if ($('.screen[data-screen="login"]').classList.contains('active')) {
        cancelSocialWaitingKeepStatus();
        $('#loginStatus').textContent = socialErrorMessage(error);
      } else {
        showToast(socialErrorMessage(error));
      }
      return;
    }
    $('#loginStatus').textContent = 'ログインしています…';
    api('/auth/exchange', 'POST', { code: code }).then(function (res) {
      if (res && res.needEmail) { enterLinkMode(code, res); return; }
      ensureAccountAndProceed({ name: res.name || res.email, email: res.email, provider: res.provider || 'email', token: res.token || '' }, opts);
    }).catch(function () {
      if (!$('.screen[data-screen="login"]').classList.contains('active')) openLogin(state.loginReturnTo);
      $('#loginStatus').textContent = 'ログインの有効期限が切れました。もう一度お試しください。';
    });
  }

  function cancelSocialWaitingKeepStatus() {
    $('#socialWaiting').hidden = true;
    $('#socialLogin').hidden = false;
    $('#emailLoginForm').hidden = false;
    openLoginRefreshProviders();
  }

  // プロバイダーからメールアドレスを受け取れなかったとき：メールOTPで一度だけ確認してもらう。
  // 確認できたメールにこのプロバイダーの本人を結びつけ、次回からはそのプロバイダーだけで入れる。
  function enterLinkMode(code, info) {
    if (!$('.screen[data-screen="login"]').classList.contains('active')) openLogin(state.loginReturnTo);
    state.linkCode = code;
    $('#socialWaiting').hidden = true;
    $('#socialLogin').hidden = true;
    $('#emailLoginDivider').hidden = true;
    $('#loginLinkNote').textContent = (SOCIAL_NAMES[info.provider] || 'ログイン元') + 'からメールアドレスを受け取れなかったので、一度だけメールで確認します。確認できたら、次回からは' + (SOCIAL_NAMES[info.provider] || 'そのログイン') + 'だけでログインできます。';
    $('#loginLinkNote').hidden = false;
    $('#loginName').value = info.name || '';
    $('#loginEmail').value = '';
    $('#emailLoginForm').hidden = false;
    $('#emailOtpForm').hidden = true;
    $('#loginStatus').textContent = '';
  }

  // Webでプロバイダーから戻ってきたとき、URLのハッシュ（#auth=… / #auth_link=… / #auth_error=…）を処理する。
  // コードはURLに残さない（すぐ消す）。戻り値：ハッシュを処理した（＝ログインの続きをしている）か
  function handleAuthRedirectHash() {
    var m = /^#(auth|auth_link|auth_error)=([0-9A-Za-z_%-]+)$/.exec(location.hash || '');
    if (!m) return false;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* 消せなくても続行 */ }
    var target = 'home';
    try {
      var saved = sessionStorage.getItem(LOGIN_RETURN_KEY);
      sessionStorage.removeItem(LOGIN_RETURN_KEY);
      if (saved) target = saved;
    } catch (e) { /* 読めなくてもホームへ */ }
    state.loginReturnTo = target;
    var hasTrip = !!Core.getTripIdFromSearch(location.search);
    if (m[1] === 'auth_error') {
      handleSocialResult('error', '', decodeURIComponent(m[2]));
      return true;
    }
    handleSocialResult('session', m[2], '', { stay: hasTrip });
    return true;
  }

  // 起動時：ログイン状態にかかわらず、いつもどおりホーム/共有された旅行を表示する
  function enterApp() {
    renderAccountRow();
    checkBillingReturn();
    // メールの確認が必要なログイン（#auth_link）で戻ってきたときは、旅行の画面ではなくログイン画面を出すため、?trip=を外す
    if (/^#auth_link=/.test(location.hash) && location.search) {
      try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* 外せなくても続行 */ }
    }
    var tripId = Core.getTripIdFromSearch(location.search);
    if (tripId) openTrip(tripId);
    else { showScreen('home'); renderHome(); }
    handleAuthRedirectHash();
    listenForAppLinks();
    setupAppBanner();
  }

  // ---------- ユニバーサルリンク（iOSアプリ） ----------
  // 共有リンク（https://ainaraomakaseare-coder.github.io/my-app/apps/day07-tabilog/?trip=…）を
  // アプリを入れている人が開くと、Safariではなくこのアプリが起動する（ドメイン直下の
  // apple-app-site-associationと、CIで付けるAssociated Domainsの設定による）。
  // アプリの中身はcapacitor://localhost/で動いているので、location.searchには?trip=が載らない。
  // 代わりに@capacitor/appから開かれたURLを受け取り、その旅行を開く。
  // アプリが起動していなかった場合（コールドスタート）はappUrlOpenの通知を取り逃すため、
  // getLaunchUrl()でも起動時のURLを確認する。
  // Web版の案内バナーから来るカスタムURLスキーム（tabilog://open?trip=…）も同じ形で受け取れる。
  function tripIdFromUrl(url) {
    try { return Core.getTripIdFromSearch(new URL(url).search); } catch (e) { return ''; }
  }

  // ---------- アプリへの案内（Web版をiPhone/iPadで開いたとき） ----------
  // App StoreのIDは、index.htmlのSmart App Banner（apple-itunes-app）のapp-idから読む
  // （公開前はコメントアウトしてあるので空になり、どちらのバナーも出ない）。
  // Safariでは純正のバナーが出るので、自作のバナーはLINEなどのアプリ内ブラウザでだけ出す
  // （アプリ内ブラウザではユニバーサルリンクが効かず、純正バナーも出ないため）。
  // 「アプリで開く」はカスタムURLスキーム（tabilog://open?trip=…）でアプリを起動する。
  var APP_BANNER_DISMISSED_KEY = 'tabilog:app-banner-dismissed';

  function appStoreId() {
    var meta = document.querySelector('meta[name="apple-itunes-app"]');
    var m = meta && /app-id=(\d+)/.exec(meta.getAttribute('content') || '');
    return m ? m[1] : '';
  }

  function isIOSDevice() {
    return /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOSはMacのふりをする
  }

  function isInAppBrowser() {
    return /Line\/|FBAN|FBAV|Instagram|Twitter|MicroMessenger|CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
  }

  function setupAppBanner() {
    var id = appStoreId();
    if (!id || isNativeApp() || !isIOSDevice() || !isInAppBrowser()) return;
    try { if (localStorage.getItem(APP_BANNER_DISMISSED_KEY)) return; } catch (e) { /* 読めなければ出す */ }
    $('#appBannerGet').href = 'https://apps.apple.com/jp/app/id' + id;
    $('#appBannerOpen').addEventListener('click', function (e) {
      e.preventDefault();
      var tripId = Core.getTripIdFromSearch(location.search);
      location.href = 'tabilog://open' + (tripId ? '?trip=' + encodeURIComponent(tripId) : '');
    });
    $('#appBannerClose').addEventListener('click', function () {
      $('#appBanner').hidden = true;
      try { localStorage.setItem(APP_BANNER_DISMISSED_KEY, '1'); } catch (e) { /* 次回また出るだけ */ }
    });
    $('#appBanner').hidden = false;
  }

  // ログインの結果を運んでくるカスタムURL（tabilog://auth?code=… / ?link=… / ?error=…）。
  // Webの#auth=… / #auth_link=… / #auth_error=…と同じhandleSocialResultで処理する。
  // 戻り値：ログインの結果として処理したか
  function handleAuthAppUrl(url) {
    var u;
    try { u = new URL(url); } catch (e) { return false; }
    if (u.protocol !== 'tabilog:' || u.hostname !== 'auth') return false;
    var p = u.searchParams;
    state.loginReturnTo = state.loginReturnTo || 'home';
    if (p.get('error')) handleSocialResult('error', '', p.get('error'));
    else if (p.get('code')) handleSocialResult('session', p.get('code'), '');
    else if (p.get('link')) handleSocialResult('session', p.get('link'), ''); // exchangeがneedEmailを返し、メール確認へ進む
    else handleSocialResult('error', '', 'failed');
    return true;
  }

  function handleAppUrl(url) {
    if (!url || handleAuthAppUrl(url)) return;
    var id = tripIdFromUrl(url);
    if (id) openTrip(id);
  }

  function listenForAppLinks() {
    var App = isNativeApp() && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (!App) return;
    App.addListener('appUrlOpen', function (ev) { handleAppUrl(ev && ev.url); });
    App.getLaunchUrl().then(function (res) { handleAppUrl(res && res.url); }).catch(function () {});
  }

  // 画面下中央に出す小さな通知。約2.5秒でフェードして消える（トップ右のアイコンとの重複を
  // やめ、#tripDetailStatusのように気づかれにくい場所ではなく、必ず目に入る場所に出す。2026-09-26）。
  var toastTimer = null;
  function showToast(text) {
    var el = $('#toast');
    if (!el) return;
    clearTimeout(toastTimer);
    el.textContent = text;
    el.hidden = false;
    // 直前のフェードアウト中にもう一度呼ばれても、確実に表示状態からやり直す
    el.classList.remove('toast-hide');
    // 次のフレームで見た目のクラスを付け直し、フェードインをやり直せるようにする
    requestAnimationFrame(function () { el.classList.add('toast-show'); });
    toastTimer = setTimeout(function () {
      el.classList.remove('toast-show');
      el.classList.add('toast-hide');
      setTimeout(function () { el.hidden = true; el.classList.remove('toast-hide'); }, 300);
    }, 2500);
  }

  function copyShareLink() {
    if (!state.trip) return;
    // iOSアプリ内ではlocation.hrefがcapacitor://localhost/...になり、
    // 他の人に共有しても開けないリンクになってしまうため、その場合は
    // 実際に公開しているWebサイトのURLを組み立てる。
    var url = isNativeApp()
      ? Core.buildShareUrl(publicPageUrl(), '', state.trip.id)
      : location.href;
    // iOSアプリ・対応ブラウザではネイティブの共有シートを開く。それ以外（未対応ブラウザ）は
    // クリップボードにコピーする。どちらも必ずトースト（showToast）で結果を知らせる
    // （以前は#tripDetailStatusという気づかれにくい場所にだけ出していた。2026-09-26）。
    // text・urlを別々に渡すと、共有先（LINEなど）によってはurlフィールドを見ずtextだけを使う
    // ものがあり、メッセージにリンクが入らない不具合が起きていた（2026-09-29、TestFlight報告）。
    // urlをtextの中に含め、urlキー自体は渡さないことで、どの共有先でも必ずリンクが本文に乗る
    // ようにする（textを見る側はそのままリンク入りの本文になり、urlだけを見る側と重複表示にも
    // ならない）。
    var message = '旅の足跡で旅行を一緒に記録しよう\n' + url;
    if (navigator.share) {
      navigator.share({ title: state.trip.title || '旅の足跡', text: message })
        .catch(function (err) {
          // キャンセル（AbortError）は何もしない。共有シート自体が使えなかったときはコピーに切り替える
          if (!err || err.name !== 'AbortError') copyInviteUrl(message);
        });
      return;
    }
    copyInviteUrl(message);
  }

  // 招待メッセージ（本文＋リンク）をコピーする。クリップボードの許可が無い環境（アプリ内ブラウザなど）では、
  // 以前はprompt()に頼っていたが、prompt()も使えない環境では押しても何も起きないように
  // 見えていた（2026-09-30）。古いコピー方法（execCommand）も試し、それでもだめなら
  // メッセージを選んでコピーできる欄を画面に出す。
  function copyInviteUrl(text) {
    var done = function () { showToast('招待メッセージ（リンク付き）をコピーしました'); };
    var legacyCopy = function () {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) done(); else showInviteUrlBox(text);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(legacyCopy);
    } else {
      legacyCopy();
    }
  }

  function showInviteUrlBox(text) {
    var old = document.getElementById('inviteUrlBox');
    if (old) old.remove();
    var box = document.createElement('div');
    box.id = 'inviteUrlBox';
    box.className = 'invite-url-box';
    box.innerHTML = '<p>このメッセージをコピーして、一緒に行く人に送ってください</p>' +
      '<textarea rows="3" readonly></textarea>' +
      '<button type="button" class="chip-btn">閉じる</button>';
    var input = box.querySelector('textarea');
    input.value = text;
    input.addEventListener('focus', function () { input.select(); });
    box.querySelector('button').addEventListener('click', function () { box.remove(); });
    document.body.appendChild(box);
    input.focus();
    input.select();
  }

  document.addEventListener('DOMContentLoaded', init);
})(typeof window !== 'undefined' ? window : this);
