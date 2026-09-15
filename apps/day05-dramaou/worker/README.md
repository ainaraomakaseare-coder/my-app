# ドラマ王 AI Worker

OpenAI APIキーをブラウザへ公開せず、ドラマの記事材料から四択問題を生成するCloudflare Workerです。

## 公開

```sh
cd apps/day05-dramaou/worker
npx wrangler secret put OPENAI_API_KEY
npx wrangler deploy
```

公開URLは `https://dramaou-ai.hiroya-apps.workers.dev` です。`../index.html` の `drama-ai-endpoint` メタタグに設定しています。

同じ作品の生成結果はCloudflare Cache APIへ24時間保存します。Workerが未設定・失敗・12秒で応答しない場合、フロントは従来の作り置き問題と記事ベース問題へ自動的に戻ります。

キャッシュミス時は接続元ごとに1分10回までに制限します。OpenAI APIキーは `wrangler.jsonc` の通常変数へ書かず、必ず `OPENAI_API_KEY` secretとして登録します。
