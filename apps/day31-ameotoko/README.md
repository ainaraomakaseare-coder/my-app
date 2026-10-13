# 雨男決定戦

放研の雨男ランキング。①イベントを10日前までに申請 → ②当日に天気の結果を入れる → ③参加者以外の人が「承認」するとランキングに反映。

- 画面だけでも動きます（`config.js` が空なら、その端末内だけに保存）。
- みんなで共有するには、下の手順で共有サーバー（Cloudflare Worker＋KV、無料枠）を1回だけデプロイします。

## 共有サーバーのデプロイ（1回だけ）

```bash
cd apps/day31-ameotoko/worker
npx wrangler kv namespace create STATE
```

出てきた `id` を `wrangler.toml` の `REPLACE_WITH_KV_ID` に貼って:

```bash
npx wrangler deploy
```

表示された `https://ameotoko-api.○○.workers.dev` を `config.js` の `AMEOTOKO_API` に入れて、公開し直します。

## 仕様メモ

- 誰でも見て・変更できる（公平のため）。名前は「あなたは誰？」の自己申告で、なりすましは防げません。
- 承認は「そのイベントの参加者以外の1人」（全員が参加者だと承認できる人がいないので、メンバー全員が出るイベントには向きません）。必要人数を変えたいときは `logic.js` の `approve` を直します。
- テスト: `node test.js`
