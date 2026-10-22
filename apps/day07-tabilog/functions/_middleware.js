// 旅行の共有リンク（https://tabinoashiato.pages.dev/?trip=…）をLINE・X・メッセージなどに貼ったとき、
// 紹介カード（OGP）に旅行の名前とカバー写真を出す（2026-10-22〜）。
// index.htmlはアプリ全体の紹介カードのままにしておき、?trip=付きで読まれたときだけ、
// Cloudflare Pagesの関数がWorkerから旅行の名前・日程・カバー写真を取ってきてmetaタグを書き換える。
// 取れなかったとき（旅行が無い・Workerが遅い・古いWorkerで/previewが無い）は、何もせず元のページを返す。
// 関数が動くのは_routes.jsonで指定したトップページだけ（写真・JSなどの静的ファイルには使わない）。

var API_BASE = 'https://tabilog-api.hiroya-apps.workers.dev';
var SITE_ORIGIN = 'https://tabinoashiato.pages.dev';
var TRIP_ID_RE = /^trip_[A-Za-z0-9]{4,64}$/;
var FETCH_TIMEOUT_MS = 1500;

function formatDate(ymd, withYear) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m) return '';
  var md = Number(m[2]) + '/' + Number(m[3]);
  return withYear ? m[1] + '/' + md : md;
}

function dayCount(start, end) {
  var a = Date.parse(start + 'T00:00:00Z');
  var b = Date.parse(end + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b) || b < a) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

// 旅行の情報から、紹介カードに出す文言・画像を組み立てる（テストしやすいよう純粋関数にしてある）
export function buildTripPreview(trip) {
  var title = String(trip.title || '').trim().slice(0, 60);
  var start = trip.startDate || '';
  var end = trip.endDate || start;
  var range = '';
  if (formatDate(start, true)) {
    range = formatDate(start, true);
    if (end && end !== start && formatDate(end, false)) {
      range += '〜' + formatDate(end, end.slice(0, 4) !== start.slice(0, 4));
    }
    var days = dayCount(start, end);
    if (days > 1) range += '（' + days + '日間）';
  }
  var coverId = String(trip.coverPhotoId || '');
  return {
    title: title ? '「' + title + '」の旅行が共有されました' : '旅行が共有されました',
    description: (range ? range + 'の旅の記録です。' : '旅の記録です。') + 'タップすると旅の足跡で見られます。',
    image: /^[A-Za-z0-9_-]{1,100}$/.test(coverId) ? API_BASE + '/photos/' + encodeURIComponent(coverId) : '',
  };
}

async function fetchTrip(tripId) {
  try {
    var res = await fetch(API_BASE + '/trips/' + encodeURIComponent(tripId) + '/preview', {
      headers: { Origin: SITE_ORIGIN },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

function setContent(value) {
  return { element: function (el) { el.setAttribute('content', value); } };
}

export async function onRequest(context) {
  var request = context.request;
  var url = new URL(request.url);
  var tripId = url.searchParams.get('trip') || '';
  if (request.method !== 'GET' || !TRIP_ID_RE.test(tripId)) return context.next();

  var results = await Promise.all([context.next(), fetchTrip(tripId)]);
  var res = results[0];
  var trip = results[1];
  if (!trip || !res.ok || (res.headers.get('content-type') || '').indexOf('text/html') === -1) return res;

  var p = buildTripPreview(trip);
  var rewriter = new HTMLRewriter()
    .on('meta[property="og:title"]', setContent(p.title))
    .on('meta[property="og:description"]', setContent(p.description));
  if (p.image) {
    rewriter = rewriter
      .on('meta[property="og:image"]', setContent(p.image))
      .on('meta[property="og:image:width"]', { element: function (el) { el.remove(); } })
      .on('meta[property="og:image:height"]', { element: function (el) { el.remove(); } })
      .on('meta[name="twitter:card"]', setContent('summary_large_image'));
  }
  var out = rewriter.transform(res);
  // 旅行ごとに中身が変わるページなので、ブラウザ・CDNに同じものとして長く覚えさせない
  var headers = new Headers(out.headers);
  headers.set('cache-control', 'no-cache');
  return new Response(out.body, { status: out.status, headers: headers });
}
