'use strict';
/**
 * Claude in Chrome に貼る、分析部隊①収集の指示文。
 *
 * ★ もとは docs/research/CHROME_COLLECT.md に直接書いてあった。
 *   ここに1つにまとめて、画面の「Chrome用の指示文をコピー」ボタンと
 *   ドキュメントの両方から同じ文面を使う（コピペのズレを無くす）。
 *
 * ★ AI（LLM）は使わない。決まった文字列を組み立てるだけ。
 *
 * ブラウザでは window.ResearchPrompts、Node（テスト）では require で使う。
 */
(function (root) {
  const KEYWORDS = {
    ai: 'AI 初心者 / ChatGPT 使い方 / AIでアプリ作ってみた / 生成AI 便利ツール / AI 副業 初心者',
    career: '転職 20代 / 第二新卒 / 退職 伝え方 / 面接 落ちる / 転職エージェント 本音',
  };

  const GENRE_CODE = { ai: 'ai', career: 'career' };

  const EXAMPLE = {
    ai: {
      account: 'AI副業ラボ', followers: 4300, posted_at: '2026-09-15', views: 88000,
      likes: 3200, comments: 140, saves: 900,
      format: 'screen', first_line: 'ChatGPTだけでアプリを1本作ってみた',
      hook: 'コード書けなくてもアプリ作れます', duration: 58, cta: '保存して',
      topic: 'AIでアプリ作ってみた', questions: ['どのプランを使ってますか?'],
    },
    career: {
      account: '元人事のキャリア相談室', followers: 8200, posted_at: '2026-09-10', views: 210000,
      likes: 9800, comments: 320, saves: 1500,
      format: 'talking', first_line: '第二新卒で辞めるとき、伝え方で損してる人が多い',
      hook: 'その退職理由、面接で聞かれたら詰みます', duration: 42, cta: '保存して',
      topic: '退職 伝え方', questions: ['円満退職ってどこまで気にすべき?', '引き止められたらどうすればいい?'],
    },
  };

  /** 見本のJSON（1本ぶん）。値は架空 — @example_user は出力に含めない。 */
  function exampleJson(genre) {
    const e = EXAMPLE[genre];
    return JSON.stringify({
      platform: 'tiktok',
      genre: GENRE_CODE[genre],
      url: 'https://www.tiktok.com/@example_user/video/7345612398712345678',
      account: { name: e.account, handle: '@example_user', followers: e.followers, followers_source: 'screen' },
      posted_at: e.posted_at,
      collected_at: '2026-09-28',
      metrics: { views: e.views, likes: e.likes, comments: e.comments, saves: e.saves, shares: null },
      metrics_source: 'screen',
      content: {
        format: e.format, first_line: e.first_line, hook: e.hook,
        duration_sec: e.duration, cta: e.cta, topic: e.topic,
      },
      demand: { comment_questions: e.questions },
    }, null, 2);
  }

  /**
   * Claude in Chrome に貼る指示文を作る。
   * @param genre  'ai' | 'career'
   * @param appUrl このアプリのURL（location.origin）。集め終わったあとの取り込み先として文中に入れる
   */
  function chromePrompt(genre, appUrl) {
    const g = KEYWORDS[genre] ? genre : 'ai';
    const keywords = KEYWORDS[g];
    const url = String(appUrl || '');

    return `あなたはブラウザで実在の投稿を確認できるエージェントです。
次のキーワードで、TikTok・X（Twitter）・Instagram・Threads をそれぞれ検索してください。

キーワード: ${keywords}

条件:
- 直近30日以内に投稿されたものだけ
- 再生数（見えない投稿は「いいね数」）÷ フォロワー数 が 10 倍以上を目安に選ぶ
- フォロワー数が10万人未満のアカウントを優先する
- 各プラットフォームにつき12件を目安に（無理に埋めない。条件に合わないなら件数は減らしてよい。ぜったいに水増ししない）

各投稿について、次のJSONの形で1本ずつ記録してください。
数字は必ず「今、画面に表示されている値」をそのまま整数に変換したものだけを使う
（例: 1.2万 → 12000）。表示されていない項目は null にする。0 や推測を入れない。

- hook: 冒頭およそ2秒に出ている画面の文字・話している第一声（テキスト投稿は1行目）。一字一句そのまま
- first_line: タイトルか投稿の1行目。一字一句そのまま
- cta: 投稿の締めにある呼びかけ（保存して／フォロー／プロフへ／コメントして）。無ければ null
- topic: その投稿を見つけたときの検索キーワード（上のキーワードのどれか）
- demand.comment_questions: コメント欄にある質問を最大3件、一字一句そのまま（任意項目、無ければ配列を空にする）

JSONの型（フィールドの意味）:
{
  "platform": "youtube|tiktok|x|instagram|threads",
  "genre": "${GENRE_CODE[g]}",
  "url": "投稿の実URL",
  "account": { "name": "表示名", "handle": "@handle", "followers": 数値かnull, "followers_source": "screen" },
  "posted_at": "YYYY-MM-DD かnull",
  "collected_at": "今日の日付 YYYY-MM-DD",
  "metrics": { "views": 数値かnull, "likes": 数値かnull, "comments": 数値かnull, "saves": 数値かnull, "shares": 数値かnull },
  "metrics_source": "screen",
  "content": {
    "format": "talking|voice|screen|text|slides|post|other|unknown",
    "first_line": "タイトルか1行目",
    "hook": "冒頭の文言",
    "duration_sec": 秒数かnull,
    "cta": "締めの呼びかけかnull",
    "topic": "見つけたときの検索キーワード"
  },
  "demand": { "comment_questions": ["質問1", "質問2"] }
}

形の見本（値は架空。**この見本は出力に含めない**。@example_user は出力しない。同じ形で、実際に見た投稿だけを書く）:
${exampleJson(g)}

厳守事項:
- ログイン操作・フォロー・いいね・コメント・DM は一切しない
- 広告（PR/Sponsored表示のある投稿）は開かない
- 非公開アカウントや年齢制限のある投稿はスキップする
- 公開されているアカウント名・ハンドル以外の個人情報は含めない

出力は上記JSONの配列だけ。説明文やコードフェンスは付けない。

集め終わったら、同じブラウザで投稿卓NEO（${url}）を開き、
『のび』画面の『Chromeの結果を取り込む』欄に JSON 配列をそのまま貼り、『取り込む』を押す。
表示された受理・却下の件数をそのまま報告する。`;
  }

  const api = { chromePrompt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ResearchPrompts = api;
})(typeof window !== 'undefined' ? window : this);
