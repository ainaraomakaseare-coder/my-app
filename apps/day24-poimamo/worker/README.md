# ポイまも AI Worker

Anthropic（Claude）のAPIキーをブラウザに公開せず、スクリーンショット画像から「サービス名・ポイントの種類・残高・失効日」を読み取って返すCloudflare Workerです。DAY05のドラマ検定・DAY18のおもいでWikiと同じ構成ですが、個人のポイント画面という機微な画像を扱うため**キャッシュはしません**（レート制限のみ）。

**このリポジトリの開発環境（Claude Codeのセッション）にはCloudflareへのデプロイ権限がありません。** 以下のコマンドはご自身の端末・アカウントで実行してください。

## 公開

```sh
cd apps/day24-poimamo/worker
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy
```

Anthropicの[コンソール](https://console.anthropic.com/)で発行したAPIキーを`ANTHROPIC_API_KEY`として登録します。DAY05・DAY18はOpenAIのキーでしたが、こちらはAnthropic（Claude）のキーが必要です（別のキーです）。

公開できたら、公開されたURL（`https://poimamo-ai.<あなたのサブドメイン>.workers.dev` の形）を `../index.html` の `poimamo-ai-endpoint` メタタグの `content` に設定してください。**空のままなら、スクショ読み取り機能はアプリ側で自動的に無効化され、手入力だけで使えます。**

`wrangler.jsonc` の `ratelimits[0].namespace_id`（`72400`）は、Cloudflareアカウント内で他のWorkerのレート制限と重複しない適当な数字であれば構いません。既に別のWorkerで同じ番号を使っている場合はデプロイ時にエラーになるので、その場合は別の番号に変更してください。

## 費用について

1回の読み取りごとに、画像1枚分の入力トークンと数百トークン程度の出力の料金がかかります（モデルは既定で費用の低いClaude Haiku 4.5）。個人の利用であれば1回あたりごくわずかですが、**費用が発生する機能である**ことは着手前に伝えたとおりです。心配な場合は`wrangler.jsonc`の`ratelimits`で回数制限をさらに絞ってください。

## 読み取りの作り方

「AIに自由に読み取らせて自然文で返す」のではなく、Anthropicのtool use（`extract_point_info`という名前の構造化ツール）を使い、`program`・`pointType`・`balance`・`expiryDate`・`confidence`の5項目だけを固定フォーマットで返させています。画面によっては「期間限定ポイント」と「通常ポイント」が両方表示されていることがあるため、その場合は期間限定ポイントを優先するようプロンプトで指示しています。

画像に書かれた文字列が指示文のように見えても、それに従わずデータとしてのみ扱うよう明示しています（スクリーンショットという外部由来の内容を鵜呑みにしないため）。

AIの読み取り結果は、アプリ側で必ずフォームに表示してユーザーが確認・修正してから保存する設計です（Workerも、呼び出し元のアプリ側も、読み取り結果を自動で保存することはありません）。

APIキーは`wrangler.jsonc`の通常変数へ書かず、必ず`ANTHROPIC_API_KEY`をsecretとして登録してください。
