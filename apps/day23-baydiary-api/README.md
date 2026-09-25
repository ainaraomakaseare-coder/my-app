# 観戦日記 AI読み取りAPI（Vercel）

「メモから一括登録」画面の「AIで読み取る」ボタンが呼び出す、公開用のバックエンドです。`apps/day23-baydiary/`（Web版）にはサーバーが無いため、この機能だけ別にVercelへデプロイします。

やっていることは`apps/day23-baydiary/server.cjs`（開発用ローカルサーバー）とほぼ同じで、`apps/day23-baydiary/index.html`の中の変換ルール（`TEAMS`・`MEMO_SCHEMA`・`memoInstructions()`）をそのまま読み込んで使います。二重管理を避けるため、ルールのコピーは持たせていません。

## 費用について

- OpenAI API（`gpt-4o-mini`）の利用料金がかかります。1回の読み取りで数円程度が目安ですが、実際の課金は入力メモの長さ次第です
- Vercelの無料プラン（Hobby）とVercel KVの無料枠内であれば、ホスティング自体の追加費用はかかりません
- 悪用・使いすぎを防ぐため、**端末ごとに生涯3回まで**に制限しています（`api/memo-extract.js`の`DEVICE_LIFETIME_LIMIT`）

## セットアップ手順

### 1. OpenAIのAPIキーを取得する

1. https://platform.openai.com/ でアカウントを作成
2. 「Billing」で支払い方法を登録（軽い利用なら月数百円程度が目安です）
3. 「API keys」で新しいキーを発行してコピーしておく

### 2. Vercelプロジェクトを作る

1. https://vercel.com/ でGitHubアカウント連携してログイン
2. 「Add New」→「Project」→このリポジトリ（`ainaraomakaseare-coder/my-app`）を選択
3. **Root Directory** を `apps/day23-baydiary-api` に設定
4. 「Settings」→「Build and Deployment」の中にある **「Include source files outside of the Root Directory in the Build」** を **オン** にする（`apps/day23-baydiary/index.html`を読みに行くために必須です）
5. 「Environment Variables」に `OPENAI_API_KEY` を追加し、手順1のキーを貼り付ける
6. デプロイを実行

### 3. Vercel KV（利用回数の記録用）を追加する

1. デプロイしたプロジェクトの「Storage」タブ →「Create Database」→「KV」を選択して作成
2. 作成したKVを、このプロジェクトに接続（Connect Project）する。これで`KV_REST_API_URL`・`KV_REST_API_TOKEN`などの環境変数が自動的に追加されます
3. 環境変数を追加した後は、プロジェクトを一度再デプロイしてください（Deployments →最新のものの「...」→「Redeploy」）

### 4. デプロイ後のURLをアプリ側に設定する

デプロイが終わると `https://なにか.vercel.app` のようなURLが発行されます。

- **Web版**（GitHub Pages）：`apps/day23-baydiary/index.html`の`<meta name="baydiary-api-base" content="">`に、そのURLを入れてください（例：`content="https://baydiary-api.vercel.app"`）
- **iOS版**：`apps/day23-baydiary-ios/src/native.mjs`の`API_BASE`定数を同じURLに変更してください

どちらも、このリポジトリを編集してコミット・プッシュする必要があります（Claudeに頼めばすぐ直せます）。

## テスト

```
node test/memo-extract.test.cjs
```

OpenAI・Vercel KVへの実際の接続は行わず、すべてモック（差し替え）でテストします。
