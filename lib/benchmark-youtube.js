'use strict';
/**
 * YouTube Shorts の「伸びている」動画を、Data API v3 で自動で集める。
 *
 * 分析部隊の①収集にあたる（lib/benchmark.js の頭のコメント参照）。
 * ほかのSNS（TikTok など）は Claude in Chrome が画面を見て集めるが、
 * YouTube はすでに読み取り権限（youtube.readonly）が繋がっていて、
 * 呼び出しも無料枠に収まるので、アプリが API で自動収集する。
 *
 * ★ ここが作るのは lib/benchmark.js の型に合う「素材」だけ。
 *   良し悪しの判断（伸びているかどうか）は checkAll に任せる。
 * ★ 冒頭2秒（hook）はAPIからは見えない。分からないものを埋めない
 *   （CLAUDE.md の「嘘を書かない」）ので、常に空文字のまま返す。
 */

const google = require('./google');
const benchmark = require('./benchmark');

const YT = 'https://www.googleapis.com/youtube/v3';
const RECENT_DAYS = 30;          // 「直近」とみなす日数。search の publishedAfter に使う。
const MAX_DURATION_SEC = 180;    // これより長い動画は Shorts らしくないので落とす。

// ジャンルごとの検索語。多いほど幅は広がるが、その分クォータを使う。
const QUERIES = {
  ai: ['AI 初心者', 'ChatGPT 使い方', 'AI アプリ 作ってみた', '生成AI 便利', 'AI ツール おすすめ'],
  career: ['転職 20代', '第二新卒 転職', '退職 伝え方', '面接 落ちる', '転職エージェント'],
};

/** 配列を size 件ずつに割る（videos.list / channels.list は id を50件までしか渡せない）。 */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 数字らしきものを Number にする。無ければ null（0で埋めない）。 */
function numOrNull(v) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/** レスポンス本文をなるべく落とさずに読む。JSONでなくても raw.raw に文字列で残す。 */
async function safeJson(res) {
  const text = await res.text().catch(() => '');
  try { return JSON.parse(text); } catch (_) { return { raw: text }; }
}

/**
 * lib/insights.js の youtubeError() と同じ翻訳。
 * ★ 生の Google のエラーをそのまま利用者に見せない。日本語のメッセージ＋直し方（hint）にする。
 *   throw ではなく Error を作って返す（呼び出し側が ok:false に詰め替える）。
 */
function youtubeError(res, raw) {
  const err = (raw && raw.error && raw.error.errors && raw.error.errors[0]) || {};
  const reason = err.reason || '';

  if (res.status === 401) {
    const e = new Error('YouTube の認証が切れています。');
    e.hint = '「連携設定」から接続し直してください。';
    e.raw = raw;
    return e;
  }
  if (reason === 'quotaExceeded' || (res.status === 403 && /quota/i.test(JSON.stringify(raw)))) {
    const e = new Error('YouTube API の1日の利用枠を使い切りました。');
    e.hint = '日付が変わるまで待ってください。';
    e.raw = raw;
    return e;
  }
  const e = new Error(`YouTube が ${res.status} を返しました。`);
  e.hint = (err.message || JSON.stringify(raw)).slice(0, 300);
  e.raw = raw;
  return e;
}

/** ISO 8601 の動画長（例: PT1M5S）を秒に直す。読めなければ null。 */
function parseDuration(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ''));
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const h = Number(m[1] || 0);
  const mnt = Number(m[2] || 0);
  const s = Number(m[3] || 0);
  return h * 3600 + mnt * 60 + s;
}

/** UTC の日時文字列を、日本時間の暦日（YYYY-MM-DD）にする。 */
function toJstDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  const y = jst.getUTCFullYear();
  const mo = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const da = String(jst.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

/** 題名＋説明文から「#タグ」を拾う。重複を除き、最大10個まで。 */
function extractHashtags(text) {
  const re = /#([^\s#　]+)/g;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(String(text || ''))) && out.length < 10) {
    const tag = '#' + m[1];
    const key = tag.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(tag); }
  }
  return out;
}

async function getJson(url, token, fetchImpl) {
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  const raw = await safeJson(res);
  if (!res.ok) throw youtubeError(res, raw);
  return raw;
}

/**
 * ジャンル1つぶん収集する。
 *
 * ★ 1つの API 呼び出しが失敗しても、ここまでに集めた分を消さずに ok:false で返す。
 *   （lib/insights.js と同じ考え方：呼び出す側が「今回は取れなかった」と分かればよい）
 */
async function collect(genre, options) {
  const { account, db, fetchImpl = fetch, now = new Date(), limit = 50 } = options || {};

  const queries = QUERIES[genre];
  if (!queries) {
    const e = new Error(`genre は ${Object.keys(QUERIES).join(' / ')} のどれか`);
    e.userError = true;
    throw e;
  }

  let token;
  try {
    token = await google.accessTokenFor(account, db);
  } catch (e) {
    return { ok: false, error: e.message, hint: e.hint, raw: e.raw || null, quota: 0 };
  }

  let quota = 0;
  const publishedAfter = new Date(now.getTime() - RECENT_DAYS * 86400000).toISOString();

  try {
    // --- ① search: クエリごとに動画IDを探す。最初に見つけたクエリを topic として覚える。
    const topicByVideoId = new Map();
    const orderedIds = [];
    for (const q of queries) {
      const url = `${YT}/search?` + new URLSearchParams({
        part: 'snippet',
        type: 'video',
        videoDuration: 'short',
        order: 'viewCount',
        publishedAfter,
        regionCode: 'JP',
        relevanceLanguage: 'ja',
        maxResults: '25',
        q,
      });
      const raw = await getJson(url, token, fetchImpl);
      quota += 100; // search.list は1回100ユニット
      for (const item of raw.items || []) {
        const id = item.id && item.id.videoId;
        if (!id) continue;
        if (!topicByVideoId.has(id)) {
          topicByVideoId.set(id, q);
          orderedIds.push(id);
        }
      }
    }

    // --- ② videos.list: 詳細・統計・長さ ---
    const videos = [];
    for (const ids of chunk(orderedIds, 50)) {
      if (!ids.length) continue;
      const url = `${YT}/videos?` + new URLSearchParams({
        part: 'snippet,statistics,contentDetails', id: ids.join(','),
      });
      const raw = await getJson(url, token, fetchImpl);
      quota += 1; // videos.list は1回1ユニット
      videos.push(...(raw.items || []));
    }

    // --- ③ channels.list: 登録者数 ---
    const channelIds = [...new Set(videos.map((v) => v.snippet && v.snippet.channelId).filter(Boolean))];
    const channelById = new Map();
    for (const ids of chunk(channelIds, 50)) {
      if (!ids.length) continue;
      const url = `${YT}/channels?` + new URLSearchParams({
        part: 'statistics,snippet', id: ids.join(','),
      });
      const raw = await getJson(url, token, fetchImpl);
      quota += 1; // channels.list も1回1ユニット
      for (const c of raw.items || []) channelById.set(c.id, c);
    }

    // --- レコード組み立て（lib/benchmark.js の型に合わせる） ---
    const collectedAt = toJstDate(now.toISOString());
    const records = [];
    for (const v of videos) {
      const durationSec = parseDuration(v.contentDetails && v.contentDetails.duration);
      // ★ Shorts のつもりで検索しても、長さで弾く（180秒より長いものは対象外）。
      if (durationSec === null || durationSec > MAX_DURATION_SEC) continue;

      const ch = channelById.get(v.snippet && v.snippet.channelId);
      const chStats = (ch && ch.statistics) || {};
      // ★ hiddenSubscriberCount が true の非公開チャンネルは、無理に推測せず null。
      const hidden = chStats.hiddenSubscriberCount === true;
      const followers = hidden ? null : numOrNull(chStats.subscriberCount);

      const s = v.statistics || {};
      const title = (v.snippet && v.snippet.title) || '';
      const description = (v.snippet && v.snippet.description) || '';

      const account_ = {
        name: (v.snippet && v.snippet.channelTitle) || (ch && ch.snippet && ch.snippet.title) || '',
        handle: (ch && ch.snippet && ch.snippet.customUrl) || null,
        followers,
      };
      if (Number.isInteger(followers)) account_.followers_source = 'api';

      records.push({
        platform: 'youtube',
        genre,
        url: `https://www.youtube.com/shorts/${v.id}`,
        account: account_,
        posted_at: v.snippet && v.snippet.publishedAt ? toJstDate(v.snippet.publishedAt) : null,
        collected_at: collectedAt,
        metrics: {
          views: numOrNull(s.viewCount),
          likes: numOrNull(s.likeCount),         // 非公開なら無い＝null（0にしない）
          comments: numOrNull(s.commentCount),   // コメント欄を閉じていると無い
          saves: null,   // YouTube API に保存数は無い
          shares: null,  // YouTube API に共有数は無い
        },
        metrics_source: 'api',
        content: {
          first_line: title,
          hook: '',      // ★ 冒頭2秒はAPIから見えない。捏造せず空のまま。
          duration_sec: durationSec,
          format: 'unknown', // ★ 作りは画面を見ないと分からない。ここでは決め打ちしない。
          topic: topicByVideoId.get(v.id) || '',
          cta: null,
          hashtags: extractHashtags(title + '\n' + description),
        },
        note: '',
      });
    }

    const checked = benchmark.checkAll(records);
    const viewsOf = (item) => (item.metrics && Number.isInteger(item.metrics.views)) ? item.metrics.views : -1;
    const accepted = checked.accepted.slice().sort((a, b) => {
      if (a.ratio === null && b.ratio === null) return viewsOf(b.item) - viewsOf(a.item);
      if (a.ratio === null) return 1;   // のび率が出せないものは後ろへ
      if (b.ratio === null) return -1;
      if (b.ratio !== a.ratio) return b.ratio - a.ratio;
      return viewsOf(b.item) - viewsOf(a.item);
    });

    return {
      genre,
      collected_at: collectedAt,
      queries,
      items: accepted.slice(0, limit).map((a) => a.item),
      summary: checked.summary,
      rejected: checked.rejected,
      quota,
    };
  } catch (e) {
    if (e.userError) throw e;
    return { ok: false, error: e.message, hint: e.hint, raw: e.raw || null, quota };
  }
}

module.exports = { QUERIES, collect, parseDuration, toJstDate, extractHashtags };
