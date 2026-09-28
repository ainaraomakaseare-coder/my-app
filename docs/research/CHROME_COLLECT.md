# Claude in Chrome で①収集をする

YouTube はアプリが API で自動で集める。TikTok / X / Instagram / Threads は
ログインが要るので、**Claude in Chrome**（ブラウザで動くエージェント）に
本人のアカウントで見てもらい、結果を JSON で出してもらう。

## 手順

1. Chrome で Claude in Chrome を開く（ログイン済みの状態で）。
2. 下の「②プロンプト」から、いま集めたいジャンル（`ai` か `career`）の
   コードブロックをまるごとコピーして貼る。
3. Claude in Chrome が各プラットフォームを検索して、JSON 配列だけを返す。
4. その JSON を、**Claude Code のこのチャットに貼るか**、ファイルに保存して
   パスを伝える。
5. 取り込みスクリプトを流す。

   ```
   node scripts/benchmark-intake.js <ファイル.json | -> [--genre ai|career] [--date YYYY-MM-DD] [--dry-run]
   ```

   `-` を渡すと標準入力から読む。ジャンルが JSON の中に書いてあれば
   `--genre` は省略できる（record ごとに genre が違えば自動でファイルを分ける）。
   まず `--dry-run` で受理・却下の内訳を見てから、本番で書き込むとよい。

## ①収集で押さえること

| 何を | なぜ |
| --- | --- |
| 数字は画面の表示そのまま（`metrics_source: 'screen'`） | 推測やAPI値との混同を防ぐ（CLAUDE.md 決めごと1） |
| フォロワー数 ÷ ではなく「再生数 ÷ フォロワー数」で選ぶ | 大アカウントの絶対数に釣られない。いまの自分の規模に近い伸び方を見る |
| hook（冒頭）・first_line・cta を一字一句そのまま | 分析で真似るのは「言い回し」であって数字ではない |
| コメント欄の質問（demand.comment_questions） | 次に書く企画のネタそのもの |
| 見えなかった数字は null | 0 は「0 だった」という意味になってしまう |

### 分かっている限界

- 他人の投稿は完了率・視聴維持率が見えない（自分の投稿にしか無い指標）。
- X / Threads は「いいね」は出ても「再生数」が出ない投稿がある（写真投稿など）。
- 画面の数字はどのSNSも丸め表示（「1.2万」など）。`parseCount()` で整数に戻すが、
  厳密な実数ではない。

## ②プロンプト

Claude in Chrome に貼る。**出力は JSON 配列だけ**（説明文やコードフェンス無し）
にしてもらう。JSON のスキーマは `lib/benchmark.js` の `checkItem` が点検する型と
同じ。

### FORMATS（content.format に入れる値と意味）

- `talking` … 顔出しで話す
- `voice` … 顔なし・声で解説
- `screen` … 画面収録（操作を見せる）
- `text` … 文字＋BGM（読ませる）
- `slides` … 画像スライド・カルーセル
- `post` … 文章だけの投稿
- `other` … その他
- `unknown` … 分からない

### JSON の形（1本ぶん、これが通る例）

```json
{
  "platform": "tiktok",
  "genre": "career",
  "url": "https://www.tiktok.com/@example_user/video/7345612398712345678",
  "account": {
    "name": "元人事のキャリア相談室",
    "handle": "@example_user",
    "followers": 8200,
    "followers_source": "screen"
  },
  "posted_at": "2026-09-10",
  "collected_at": "2026-09-28",
  "metrics": {
    "views": 210000,
    "likes": 9800,
    "comments": 320,
    "saves": 1500,
    "shares": null
  },
  "metrics_source": "screen",
  "content": {
    "format": "talking",
    "first_line": "第二新卒で辞めるとき、伝え方で損してる人が多い",
    "hook": "その退職理由、面接で聞かれたら詰みます",
    "duration_sec": 42,
    "cta": "保存して"
  },
  "demand": {
    "comment_questions": [
      "円満退職ってどこまで気にすべき?",
      "引き止められたらどうすればいい?"
    ]
  }
}
```

各項目の意味:

- `platform`: `youtube` / `tiktok` / `x` / `instagram` / `threads` のどれか
- `genre`: `ai` か `career`
- `url`: 投稿の実URL（そのSNSのドメインであること）
- `account.name` / `account.handle`: 表示名かハンドル（どちらか一方でよい）
- `account.followers`: フォロワー数（見えなければ null）。見えたら `account.followers_source` に `screen` を入れる
- `posted_at`: 投稿日（YYYY-MM-DD）。見えなければ null
- `collected_at`: 今日（確かめた日、YYYY-MM-DD）
- `metrics.views/likes/comments/saves/shares`: 画面表示の数字を整数にしたもの。見えない項目は null（少なくとも views か likes のどちらかは必要）
- `metrics_source`: 数字を1つでも入れたら `screen`
- `content.format`: 上の FORMATS のキーのどれか
- `content.first_line`: タイトルか1行目（一字一句そのまま）
- `content.hook`: 冒頭2秒の画面文言・第一声（テキスト投稿なら1行目）。一字一句そのまま
- `content.duration_sec`: 動画の秒数。無ければ null
- `content.cta`: 締めの呼びかけ（保存して／フォロー／プロフへ／コメントして）。無ければ null
- `content.topic`: 見つけたときの検索キーワード
- `demand.comment_questions`: コメント欄の質問（最大3件、一字一句そのまま）。任意項目

### プロンプト（ai：ひろや｜AI初心者30日30アプリ）

```
あなたはブラウザで実在の投稿を確認できるエージェントです。
次のキーワードで、TikTok・X（Twitter）・Instagram・Threads をそれぞれ検索してください。

キーワード: AI 初心者 / ChatGPT 使い方 / AIでアプリ作ってみた / 生成AI 便利ツール / AI 副業 初心者

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
  "genre": "ai",
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

形の見本（値は架空。**この見本は出力に含めない**。同じ形で、実際に見た投稿だけを書く）:
{
  "platform": "tiktok",
  "genre": "ai",
  "url": "https://www.tiktok.com/@example_user/video/7345612398712345678",
  "account": { "name": "AI副業ラボ", "handle": "@example_user", "followers": 4300, "followers_source": "screen" },
  "posted_at": "2026-09-15",
  "collected_at": "2026-09-28",
  "metrics": { "views": 88000, "likes": 3200, "comments": 140, "saves": 900, "shares": null },
  "metrics_source": "screen",
  "content": { "format": "screen", "first_line": "ChatGPTだけでアプリを1本作ってみた", "hook": "コード書けなくてもアプリ作れます", "duration_sec": 58, "cta": "保存して", "topic": "AIでアプリ作ってみた" },
  "demand": { "comment_questions": ["どのプランを使ってますか?"] }
}

厳守事項:
- ログイン操作・フォロー・いいね・コメント・DM は一切しない
- 広告（PR/Sponsored表示のある投稿）は開かない
- 非公開アカウントや年齢制限のある投稿はスキップする
- 公開されているアカウント名・ハンドル以外の個人情報は含めない

出力は上記JSONの配列だけ。説明文やコードフェンスは付けない。
```

### プロンプト（career：転職のホンネまとめ）

```
あなたはブラウザで実在の投稿を確認できるエージェントです。
次のキーワードで、TikTok・X（Twitter）・Instagram・Threads をそれぞれ検索してください。

キーワード: 転職 20代 / 第二新卒 / 退職 伝え方 / 面接 落ちる / 転職エージェント 本音

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
  "genre": "career",
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

形の見本（値は架空。**この見本は出力に含めない**。同じ形で、実際に見た投稿だけを書く）:
{
  "platform": "tiktok",
  "genre": "career",
  "url": "https://www.tiktok.com/@example_user/video/7345612398712345678",
  "account": { "name": "元人事のキャリア相談室", "handle": "@example_user", "followers": 8200, "followers_source": "screen" },
  "posted_at": "2026-09-10",
  "collected_at": "2026-09-28",
  "metrics": { "views": 210000, "likes": 9800, "comments": 320, "saves": 1500, "shares": null },
  "metrics_source": "screen",
  "content": { "format": "talking", "first_line": "第二新卒で辞めるとき、伝え方で損してる人が多い", "hook": "その退職理由、面接で聞かれたら詰みます", "duration_sec": 42, "cta": "保存して", "topic": "退職 伝え方" },
  "demand": { "comment_questions": ["円満退職ってどこまで気にすべき?", "引き止められたらどうすればいい?"] }
}

厳守事項:
- ログイン操作・フォロー・いいね・コメント・DM は一切しない
- 広告（PR/Sponsored表示のある投稿）は開かない
- 非公開アカウントや年齢制限のある投稿はスキップする
- 公開されているアカウント名・ハンドル以外の個人情報は含めない

出力は上記JSONの配列だけ。説明文やコードフェンスは付けない。
```
