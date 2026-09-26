'use strict';
/**
 * AI が書いた「SNSごとの投稿案」をまとめて貼ると、SNSごとの欄に振り分ける。
 *
 *   ## Instagram
 *   …本文…
 *   ## YouTube Shorts
 *   **タイトル**
 *   …
 *   **概要欄**
 *   …
 *
 * ★ AI（LLM）は使わない。見出しで切るだけの決まった処理にしてある。
 *   貼った文章を1文字も書き換えないため（「嘘を書かない」の点検を通った文を
 *   別の AI が言い換えると、点検の意味がなくなる）。お金もかからない。
 *
 * ★ 見出しの書き方の揺れは広めに拾う。
 *   「## Instagram」「【インスタ】」「■ X」「Threads：」など、AI によって書き方が違う。
 *   見出しと分かる印（# 【 ■ など）が無い行は、SNS名だけの1行のときに限って見出しとみなす。
 *   本文の途中に「X」とだけ書いた行が来ることは、まず無いので。
 *
 * ブラウザでは window.splitDrafts、Node（テスト）では require で使う。
 */
(function (root) {
  // 見出しの名前 → どのSNSか。小文字にして、空白を消してから引く。
  const NAMES = {
    instagram: 'instagram', insta: 'instagram', ig: 'instagram', 'インスタ': 'instagram', 'インスタグラム': 'instagram',
    'instagramリール': 'instagram', 'instagramreels': 'instagram', 'リール': 'instagram',
    tiktok: 'tiktok', 'ティックトック': 'tiktok',
    youtube: 'youtube', youtubeshorts: 'youtube', shorts: 'youtube', 'ユーチューブ': 'youtube',
    'youtubeショート': 'youtube', 'ショート': 'youtube',
    x: 'x', twitter: 'x', 'x(twitter)': 'x', 'x（twitter）': 'x', 'ツイッター': 'x', 'エックス': 'x',
    threads: 'threads', 'スレッズ': 'threads',
  };

  const MARK = /^\s*(?:#{1,6}|【|\[|■|□|◆|◇|▼|●|★)\s*/;

  /** 行が SNS の見出しなら、そのSNS名を返す。違えば null。 */
  function headingOf(line) {
    const hasMark = MARK.test(line);
    const name = line
      .replace(MARK, '')
      .replace(/[】\]]/g, '')
      .replace(/\*\*/g, '')
      .replace(/[:：]\s*$/, '')
      .replace(/\s+/g, '')
      .toLowerCase();
    if (!name) return null;
    const hit = NAMES[name];
    if (hit) return hit;
    // 名前の後ろにかっこ書きの補足がある形（「YouTube Shorts（タイトル／概要欄）」）も拾う。
    // ★ AI のチャット画面からコピーすると「##」が落ちるので、印が無くても拾う。
    //   ただし、かっこの後ろに文が続く行（「X（旧Twitter）で話題」）は本文なので拾わない。
    const paren = name.match(/^(.+?)[（(][^（()）]*[）)]$/);
    if (paren && NAMES[paren[1]]) return NAMES[paren[1]];
    // 印つきの見出しは、かっこが閉じていなくても名前で拾う（「## Instagram（リール」の書き損じ）
    if (hasMark) {
      const head = name.replace(/[（(].*$/, '');
      if (NAMES[head]) return NAMES[head];
    }
    return null;
  }

  /** 前後の空行を落とす（中の空行は残す。段落の区切りなので）。 */
  function trimBlock(lines) {
    let a = 0, b = lines.length;
    while (a < b && !lines[a].trim()) a++;
    while (b > a && !lines[b - 1].trim()) b--;
    return lines.slice(a, b).join('\n');
  }

  /**
   * YouTube の中の小見出し（「**タイトル**」「概要欄：」「【説明文】」など）を読む。
   * 小見出しなら { label: 'title'|'desc', rest: 同じ行の後ろに書いた中身 }、違えば null。
   *
   * ★ 見出しの言葉の直後が「行の終わり」か「：」のときだけ小見出しとみなす。
   *   「タイトルの付け方」のような本文の行を、小見出しと間違えないため。
   */
  function ytLabel(line) {
    const s = line.trim().replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').trim();
    const m = s.match(/^[【\[]?\s*(タイトル|概要欄|概要|説明文|説明)\s*[】\]]?\s*(?:[:：]\s*(.*))?$/);
    if (!m) return null;
    return { label: m[1] === 'タイトル' ? 'title' : 'desc', rest: (m[2] || '').trim() };
  }

  function splitYoutube(lines) {
    let title = [], desc = [], where = null, seenLabel = false;
    for (const line of lines) {
      const lab = ytLabel(line);
      if (lab) {
        where = lab.label; seenLabel = true;
        if (lab.rest) (where === 'title' ? title : desc).push(lab.rest);
        continue;
      }
      if (where === 'title') title.push(line);
      else if (where === 'desc') desc.push(line);
      else desc.push(line);   // 小見出しより前の行（いったん概要欄側に置く）
    }
    if (!seenLabel) {
      // 小見出しが無い：最初の1行をタイトル、残りを概要欄とみなす
      const body = trimBlock(desc).split('\n');
      return { title: (body[0] || '').replace(/\*\*/g, '').trim(), description: trimBlock(body.slice(1)) };
    }
    // タイトルは1行。2行以上あれば最初の空でない行だけを使い、残りは捨てずに概要欄の頭へ
    const t = trimBlock(title).split('\n');
    return { title: (t[0] || '').replace(/\*\*/g, '').trim(), description: trimBlock(desc) };
  }

  /**
   * まとめて貼った文章を、SNSごとに分ける。
   * 返すのは { instagram, tiktok, youtubeTitle, youtubeDescription, x, threads, found }。
   * 見つからなかったSNSは空文字。found は見つかったSNS名の並び。
   */
  function split(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = {};
    const found = [];
    let current = null;
    for (const line of lines) {
      const h = headingOf(line);
      if (h) {
        current = h;
        if (!blocks[h]) { blocks[h] = []; found.push(h); }
        continue;
      }
      if (current) blocks[current].push(line);
    }
    const yt = blocks.youtube ? splitYoutube(blocks.youtube) : { title: '', description: '' };
    return {
      instagram: blocks.instagram ? trimBlock(blocks.instagram) : '',
      tiktok: blocks.tiktok ? trimBlock(blocks.tiktok) : '',
      youtubeTitle: yt.title,
      youtubeDescription: yt.description,
      x: blocks.x ? trimBlock(blocks.x) : '',
      threads: blocks.threads ? trimBlock(blocks.threads) : '',
      found,
    };
  }

  /**
   * X の文字数（X の数え方）。
   *
   * ★ X は「280」を、日本語などは1文字＝2として数える。
   *   つまり日本語だけなら140文字が上限。JavaScript の length で数えると
   *   半分に見積もってしまい、X に送った時点で弾かれる。
   *   URL はどんな長さでも23として数える。
   */
  function xLength(text) {
    const s = String(text || '').replace(/https?:\/\/\S+/g, 'u'.repeat(23));
    let n = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      // 絵文字の見た目を変えるだけの付属記号は数えない（🎬️ の ️ や、肌の色の指定）
      if (c === 0xfe0f || c === 0x200d || (c >= 0x1f3fb && c <= 0x1f3ff)) continue;
      const light = (c <= 0x10ff) || (c >= 0x2000 && c <= 0x200d) ||
        (c >= 0x2010 && c <= 0x201f) || (c >= 0x2032 && c <= 0x2037);
      n += light ? 1 : 2;
    }
    return n;
  }

  const api = { split, xLength, headingOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.splitDrafts = api;
})(typeof window !== 'undefined' ? window : this);
