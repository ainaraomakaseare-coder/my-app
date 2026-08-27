# このリポジトリについて

「AIアプリ開発初心者が30日で30アプリ作る」企画のリポジトリです。**アプリのコードと企画の記録の両方**が入っています。

```
apps/dayNN-アプリ名/   各日のアプリ（1アプリ1フォルダ）
docs/                  企画のルール・ロードマップ・日次ログ
index.html             全アプリへのトップページ
.claude/               開発時間を自動で記録するフック
```

**作業を始める前に `docs/progress.md` を読んでください。** その日のアプリ・新しい挑戦・今の状況がそこにあります。企画の全体像は `docs/handoff.md`、企画のルールは `docs/CLAUDE.md` です。

## 記録の場所

日次ログは必ず `docs/logs/dayNN.md` に書きます。アプリのフォルダには置かないでください。30日分を最終日に集計するので、散らばると集められません。

開発を始めるときは、まず `docs/logs/TEMPLATE.md` をコピーして `docs/logs/dayNN.md` を作り、**開始時刻を書いてから**手を動かします。終了時は `node .claude/hooks/timelog.js report` の結果を書き写します。

## 置き場所について

いま2つの方式が混ざっています。DAY3〜6 はこのリポジトリの `apps/` 以下、DAY7（サッカー出欠管理）は別リポジトリ [`day07-soccer-attendance`](https://github.com/ainaraomakaseare-coder/day07-soccer-attendance) です。

DAY6 の時点では新規リポジトリを作る権限が無く（`403 Resource not accessible by integration`）`apps/` にまとめましたが、DAY7 で**人が GitHub の画面から作れば別リポジトリにできる**ことが分かりました。どちらに寄せるかは未決です。詳細と経緯は `docs/progress.md` の「置き場所の決めごと」にあります。

別リポジトリにする場合は `docs/templates/app-repo/` の中身（`CLAUDE.md` と `.claude/`）をそのリポジトリの直下にコピーしてください。

## 開発を手伝うときのお願い

要件が曖昧なら先に質問する／大型なら機能を分割する／初心者に分かる言葉で説明する／エラーやつまずきも記録に残す／費用が発生する場合は着手前に伝える／APIキーや秘密情報をコードやGitHubに出さない。

計測できなかった時間や費用は、推測で埋めずに「正確な計測不可」と書きます。

詳しくは `docs/CLAUDE.md`。
