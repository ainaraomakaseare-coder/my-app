# 30日で30アプリ

AIアプリ開発初心者が、30日で30個のアプリを作る記録。

- **アプリ** … `apps/dayNN-アプリ名/`
- **企画の記録** … `docs/`（ルール・ロードマップ・日次ログ）

トップページ `index.html` から各アプリを開けます。

## 入っているアプリ

| DAY | アプリ | 場所 | 新しい挑戦 |
|---|---|---|---|
| 3 | NHKチンチロ | `apps/day03-chinchiro/` | GitHub連携／AIに要件定義をさせる |
| 4 | 輸入ブラックジャック | `apps/day04-blackjack/` | 特殊で複雑なルールをAIに理解させる |
| 5 | ドラマ検定 | `apps/day05-dramaou/` | 外部から情報を取ってくる |
| 6 | 人狼 | `apps/day06-jinro/` | インターネットに公開する／複数の端末で使う |

DAY1（くじ引き）と DAY2（ミリオネア）はまだ入っていません。手元にコードがあれば `apps/day01-kujibiki/` `apps/day02-millionaire/` として追加してください。

## テスト

アプリごとに `test/` があります。

```
node apps/day03-chinchiro/test/rules.test.js
node apps/day04-blackjack/test/bj.rules.test.js
node apps/day05-dramaou/test/quiz.test.js
node apps/day06-jinro/test/qr.test.js
```

`ui.smoke.js` は実ブラウザを使うので playwright が要ります。
