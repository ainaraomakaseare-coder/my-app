# Claude in Chrome で①収集をする

YouTube はアプリが API で自動で集める。TikTok / X / Instagram / Threads は
ログインが要るので、**Claude in Chrome**（ブラウザで動くエージェント）に
本人のアカウントで見てもらい、結果を JSON で出してもらう。

## 手順

1. アプリの「のび」画面 →「分析部隊（一気に回す）」カード →
   **「Chrome用の指示文をコピー」**を押す（ジャンルはカード上部の選択肢に従う）。
   指示文の本体は `public/research-prompts.js` の `chromePrompt(genre, appUrl)` に
   まとまっている（このファイルには本文を置かない。ズレを防ぐため）。
2. Chrome で Claude in Chrome を開き（ログイン済みの状態で）、コピーした指示文を貼る。
3. Claude in Chrome が各プラットフォームを検索して、JSON 配列だけを返す。
4. 指示文の最後に書いてあるとおり、同じブラウザでアプリの「のび」画面に戻り、
   「Chromeの結果を取り込む」欄に JSON 配列をそのまま貼って「取り込む」を押す。
   受理・却下の件数がその場に出る（内部では下の②プロンプトと同じ点検を、
   `lib/benchmark.js` の `checkAll` が行っている）。

   ボタンを使わずコマンドラインで取り込みたいときは、これまでどおり

   ```
   node scripts/benchmark-intake.js <ファイル.json | -> [--genre ai|career] [--date YYYY-MM-DD] [--dry-run]
   ```

   も使える（`-` で標準入力から読む）。

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

## ②プロンプトの中身

指示文は `public/research-prompts.js` の `chromePrompt('ai' | 'career', appUrl)` が
組み立てる。**出力は JSON 配列だけ**（説明文やコードフェンス無し）にしてもらう。
JSON のスキーマは `lib/benchmark.js` の `checkItem` が点検する型と同じ。
キーワードやジャンルの文言はジャンルごとに違うので、実際に何を貼ったか確かめたいときは
ボタンでコピーした文面か、`public/research-prompts.js` を直接見る。

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

これは指示文の「形の見本」と同じ架空の値（`@example_user`）。**この見本は出力に含めない**
（実際に取り込むときは、実在の投稿の値に置き換えたものを渡す）。

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
