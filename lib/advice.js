'use strict';
/**
 * 集めた数字から、言えることだけを書く。
 *
 * ★ ここでいちばん大事なのは「言わないこと」を決めること。
 *   20本・20日ぶんのデータで「21時より20時が伸びる」のような話をすると、
 *   偶然の差を法則として読んでしまう。もっともらしい分析文を書くのは簡単だが、
 *   それはこのアプリが投稿文に課している「嘘を書かない」を、
 *   こちら側が破ることになる。
 *
 * ★ だから、どの気づきにも
 *     ・根拠になった数字
 *     ・何本ぶんの話か
 *     ・確かなのか、まだ言えないのか
 *   を必ず添える。「差が小さいのでまだ何とも言えません」も、そのまま出す。
 *
 * ★ 順番も大事。
 *   「数字が取れていない」は「どの投稿が伸びたか」より先に出す。
 *   取れていないまま傾向の話をしても、直しようがない。
 */

/** 確からしさ。画面の見た目もこれで変える。 */
const SURE = 'sure';       // 数えれば分かること。順位、増減、本数
const WEAK = 'weak';       // 傾向はあるが、本数が足りない
const BLOCKED = 'blocked'; // 数字が取れていない。直せば分かる

const NET_LABEL = { instagram: 'Instagram', youtube: 'YouTube', x: 'X', tiktok: 'TikTok' };
const netName = (n) => NET_LABEL[n] || n;

/**
 * これだけ本数が無いと、投稿どうしの比較はしない。
 *
 * ★ 5本。少ないと思われるかもしれないが、これは「比べ始めてよい下限」であって
 *   「これだけあれば言い切れる」ではない。5〜9本のあいだは、
 *   よほど差が開いていない限り WEAK として出す。
 */
const MIN_POSTS_TO_COMPARE = 5;
const ENOUGH_POSTS = 10;

/**
 * 上位が中央値の何倍なら「差がある」と見るか。
 *
 * ★ 平均ではなく中央値と比べる。1本だけ跳ねた投稿があると、
 *   平均はそれに引っぱられて、残り全部が「平均以下」に見えてしまう。
 */
const CLEAR_GAP = 2;

// ---------------------------------------------------------------------------

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

function median(list) {
  const xs = list.filter((v) => num(v) !== null).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

const jp = (n) => (num(n) === null ? '—' : Number(n).toLocaleString('ja-JP'));

function say(kind, confidence, headline, detail, numbers) {
  return { kind, confidence, headline, detail: detail || '', numbers: numbers || [] };
}

// ---------------------------------------------------------------------------
// 1. まず、数字が取れているか
// ---------------------------------------------------------------------------

/**
 * ★ これを最初に出す。
 *   取れていないものがあるまま「Instagram は伸びていません」と言うと、
 *   伸びていないのか、測れていないのかが区別できない。
 */
function collectionFindings(accounts) {
  const out = [];
  const broken = accounts.filter((a) => a.latest && a.latest.ok === false);
  const never = accounts.filter((a) => !a.latest);

  for (const a of broken) {
    out.push(say('collection', BLOCKED,
      `${netName(a.network)}「${a.label || a.account_name || ''}」の数字が取れていません`,
      a.latest.error || '理由が分かりません。',
      [`最後に試したのは ${a.latest.taken_on}`]));
  }

  if (never.length) {
    out.push(say('collection', BLOCKED,
      `${never.length}件の連携で、まだ一度も数字を取れていません`,
      '繋いだ直後は、次の取り込み（毎晩）を待ってください。'
      + '翌日になっても出ない場合は、権限が足りていない可能性があります。',
      never.map((a) => `${netName(a.network)}「${a.label || a.account_name || ''}」`)));
  }

  // 取れない項目がある（権限しだいで欠ける。Instagram のフォロワー数など）
  for (const a of accounts) {
    if (!a.latest || a.latest.ok === false) continue;
    const missing = [];
    if (num(a.latest.followers) === null) missing.push('フォロワー数');
    if (a.network === 'youtube' && num(a.latest.views) === null) missing.push('総再生数');
    if (missing.length) {
      out.push(say('collection', BLOCKED,
        `${netName(a.network)}「${a.label || a.account_name || ''}」は${missing.join('・')}が返ってきません`,
        'つながってはいるので、権限が足りていない可能性が高いです。'
        + '「連携設定」の接続テストで、返ってきた中身を確かめられます。',
        []));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. フォロワーの伸び
// ---------------------------------------------------------------------------

/**
 * ★ 比べるのは「直近7日」と「その前の7日」。
 *   前日比だと1日の揺れをそのまま読んでしまい、
 *   月初からの累計だと直近の変化が薄まる。
 *
 * ★ 14日ぶん揃うまでは、増減だけ言って比較はしない。
 *   「先週より鈍っています」は、先週のデータがあって初めて言える。
 */
function followerFindings(account) {
  const days = (account.days || [])
    .filter((d) => d.ok !== false && num(d.followers) !== null)
    .sort((a, b) => (a.taken_on < b.taken_on ? -1 : 1));

  const who = `${netName(account.network)}「${account.label || account.account_name || ''}」`;

  if (days.length < 2) {
    return [say('followers', WEAK, `${who}のフォロワーの増減は、まだ分かりません`,
      '2日ぶん揃うと、増えたか減ったかが出ます。数字は毎晩1回ためています。',
      days.length ? [`いまは ${jp(days[0].followers)}人`] : [])];
  }

  const last = days[days.length - 1];
  const out = [];

  const pick = (backFrom, backTo) => {
    const end = days[days.length - 1 - backFrom];
    const start = days[days.length - 1 - backTo];
    return end && start && end !== start ? { start, end } : null;
  };

  const week = pick(0, Math.min(7, days.length - 1));
  if (week) {
    const diff = week.end.followers - week.start.followers;
    const span = daysBetween(week.start.taken_on, week.end.taken_on) || 1;
    const perDay = diff / span;
    out.push(say('followers', SURE,
      `${who}は${span}日で ${diff >= 0 ? '+' : ''}${jp(diff)}人`,
      diff === 0
        ? '動いていません。'
        : `1日あたり ${perDay >= 0 ? '+' : ''}${perDay.toFixed(1)}人のペースです。`,
      [`${week.start.taken_on} ${jp(week.start.followers)}人 → ${week.end.taken_on} ${jp(last.followers)}人`]));

    // 前の期間と比べる
    const prev = pick(Math.min(7, days.length - 1), Math.min(14, days.length - 1));
    if (prev && prev.start !== prev.end) {
      const prevDiff = prev.end.followers - prev.start.followers;
      const prevSpan = daysBetween(prev.start.taken_on, prev.end.taken_on) || 1;
      const prevPerDay = prevDiff / prevSpan;
      const faster = perDay - prevPerDay;
      // ★ 1日あたり0.5人未満の差は、揺れと区別がつかない。言い切らない。
      if (Math.abs(faster) < 0.5) {
        out.push(say('followers', WEAK, `${who}のペースは、前の期間とほぼ同じです`,
          '差が小さいので、速くなったとも遅くなったとも言えません。',
          [`直近 1日 ${perDay.toFixed(1)}人 / その前 1日 ${prevPerDay.toFixed(1)}人`]));
      } else {
        out.push(say('followers', days.length >= 14 ? SURE : WEAK,
          `${who}のペースは${faster > 0 ? '速く' : '遅く'}なっています`,
          days.length >= 14 ? '' : '（まだ14日ぶん揃っていないので、参考程度に）',
          [`直近 1日 ${perDay.toFixed(1)}人 / その前 1日 ${prevPerDay.toFixed(1)}人`]));
      }
    }
  }
  return out;
}

function daysBetween(a, b) {
  const t = (s) => new Date(s + 'T00:00:00+09:00').getTime();
  return Math.round((t(b) - t(a)) / 86400000);
}

// ---------------------------------------------------------------------------
// 3. どの投稿が伸びたか
// ---------------------------------------------------------------------------

/**
 * ★ 順位そのものは数えれば分かるので SURE。
 *   ただし「だから次はこう書くべき」は言わない。それは本数が要る。
 *
 * ★ 全部が似た数字なら、順位を出しても意味がない。
 *   上位が中央値の2倍に届かないうちは「差が小さい」と言う。
 */
function postFindings(network, posts) {
  const scored = posts
    .map((p) => ({ ...p, score: num(p.views) !== null ? p.views : num(p.likes) }))
    .filter((p) => p.score !== null)
    .sort((a, b) => b.score - a.score);

  const unit = posts.some((p) => num(p.views) !== null) ? '再生' : 'いいね';
  const who = netName(network);

  if (!scored.length) {
    return [say('posts', BLOCKED, `${who}は、投稿ごとの数字がまだありません`,
      '公開済みの投稿が無いか、数字を取れていません。', [])];
  }
  if (scored.length < MIN_POSTS_TO_COMPARE) {
    return [say('posts', WEAK, `${who}は${scored.length}本ぶんしかありません`,
      `${MIN_POSTS_TO_COMPARE}本たまると、伸びた投稿と伸びなかった投稿を比べられます。`,
      scored.map((p) => `${p.title}：${jp(p.score)}${unit}`))];
  }

  const mid = median(scored.map((p) => p.score));
  const top = scored[0];
  const bottom = scored[scored.length - 1];
  const out = [];

  const clear = mid > 0 && top.score >= mid * CLEAR_GAP;
  const enough = scored.length >= ENOUGH_POSTS;

  if (!clear) {
    out.push(say('posts', WEAK, `${who}は、どの投稿も似たような数字です`,
      'いちばん伸びた投稿でも、真ん中の2倍に届いていません。'
      + 'いまの差は偶然の範囲と区別がつかないので、'
      + '「この切り口が効いた」とは言えません。',
      [`いちばん上 ${jp(top.score)}${unit} / 真ん中 ${jp(mid)}${unit} / いちばん下 ${jp(bottom.score)}${unit}`]));
    return out;
  }

  out.push(say('posts', SURE, `${who}でいちばん伸びたのは「${top.title}」`,
    `真ん中の投稿の ${(top.score / mid).toFixed(1)}倍です。`
    + (enough ? '' : `ただし${scored.length}本ぶんなので、次の数本で入れ替わる可能性があります。`),
    scored.slice(0, 3).map((p, i) => `${i + 1}位 ${p.title}：${jp(p.score)}${unit}`)));

  out.push(say('posts', enough ? SURE : WEAK, `${who}でいちばん伸びなかったのは「${bottom.title}」`,
    '伸びた回と見比べて、切り口の違いを探すところからです。',
    scored.slice(-3).reverse().map((p) => `${p.title}：${jp(p.score)}${unit}`)));

  return out;
}

// ---------------------------------------------------------------------------
// 4. 止まっているもの
// ---------------------------------------------------------------------------

/**
 * ★ これがいちばん実用的な指摘になりやすい。
 *   TikTok と YouTube は手で公開する運用なので、
 *   「送ったまま忘れている」が普通に起きる。
 *   伸び方の分析より先に、出ていない投稿を出すほうが効く。
 */
function stalledFindings(stalled) {
  if (!stalled || !stalled.length) return [];
  return [say('stalled', SURE,
    `手渡しのまま止まっている投稿が${stalled.length}本あります`,
    '下書きには届いていますが、まだ公開されていません。'
    + '公開しないと数字が付かないので、分析にも出てきません。',
    stalled.slice(0, 5).map((s) => `${netName(s.network)}：${s.title}`))];
}

// ---------------------------------------------------------------------------

/**
 * 全部まとめる。
 *
 * data = {
 *   accounts: [{ id, network, label, account_name, latest, days:[…] }],
 *   postsByNetwork: { youtube: [{title, views, likes}], … },
 *   stalled: [{ network, title }],
 * }
 */
function observations(data) {
  const accounts = (data && data.accounts) || [];
  const byNet = (data && data.postsByNetwork) || {};
  const out = [];

  if (!accounts.length) {
    return [say('collection', BLOCKED, 'まだ連携がありません',
      '「連携設定」でSNSを繋ぐと、翌日から数字がたまり始めます。', [])];
  }

  out.push(...collectionFindings(accounts));
  out.push(...stalledFindings(data && data.stalled));

  for (const a of accounts) {
    if (a.latest && a.latest.ok === false) continue;   // 取れていないものは上で言った
    out.push(...followerFindings(a));
  }
  for (const [network, posts] of Object.entries(byNet)) {
    if (posts && posts.length) out.push(...postFindings(network, posts));
  }

  // ★ 直せること（BLOCKED）を先、次に確かなこと、最後にまだ言えないこと。
  const rank = { [BLOCKED]: 0, [SURE]: 1, [WEAK]: 2 };
  return out.sort((x, y) => rank[x.confidence] - rank[y.confidence]);
}

module.exports = {
  SURE, WEAK, BLOCKED,
  MIN_POSTS_TO_COMPARE, ENOUGH_POSTS, CLEAR_GAP,
  median, daysBetween, netName,
  collectionFindings, followerFindings, postFindings, stalledFindings,
  observations,
};
