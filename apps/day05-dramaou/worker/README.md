# ドラマ王 AI Worker

OpenAI APIキーをブラウザへ公開せず、ドラマの記事材料から四択問題を生成するCloudflare Workerです。

## 公開

```sh
cd apps/day05-dramaou/worker
npx wrangler secret put OPENAI_API_KEY
npx wrangler deploy
```

公開後、表示されたWorker URLを `../index.html` の `drama-ai-endpoint` メタタグへ設定します。

同じ作品の生成結果はCloudflare Cache APIへ24時間保存します。Workerが未設定・失敗・12秒で応答しない場合、フロントは従来の作り置き問題と記事ベース問題へ自動的に戻ります。

