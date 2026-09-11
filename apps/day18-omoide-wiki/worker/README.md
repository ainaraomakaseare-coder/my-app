# おもいでWiki AI Worker

OpenAI APIキーをブラウザへ公開せず、インタビューの回答内容に応じた追加の深掘り質問を1つ作って返すCloudflare Workerです。DAY05のドラマ王Workerと同じ構成ですが、個人的な回答を扱うため**キャッシュはしません**（レート制限のみ）。

## 公開

```sh
cd apps/day18-omoide-wiki/worker
npx wrangler secret put OPENAI_API_KEY
npx wrangler deploy
```

DAY05のドラマ王Workerと同じOpenAI APIキーを使い回せます（同じ `wrangler secret put` を、このWorkerに対しても一度実行するだけです）。

公開できたら、公開されたURL（`https://omoide-wiki-ai.<あなたのサブドメイン>.workers.dev` の形）を `../index.html` の `omoide-ai-endpoint` メタタグの `content` に設定してください。空のままなら、AI深掘り機能はアプリ側で自動的に無効化され、通常の固定質問インタビューだけで動きます。

## 費用を抑える仕組み

- 個人の回答はキャッシュしません（使い回す意味がないため）
- 接続元ごとに1分10回までのレート制限
- 出力トークンの上限を800に制限し、返す内容も「追加質問1つ」だけに絞っている
- フロント側でも1つの話題につき深掘りは最大3往復までに制限（Worker側が`done`を返さなくても、フロントが強制的に打ち切ります）

OpenAI APIキーは `wrangler.jsonc` の通常変数へ書かず、必ず `OPENAI_API_KEY` secretとして登録してください。
