# research/ に入るもの

分析部隊（①収集 → ②分析 → ③企画）の成果物置き場。ジャンル（`ai` / `career`）
ごとにフォルダを分ける。

```
research/<genre>/<date>.json            … ①収集（scripts/benchmark-intake.js が作る）
research/<genre>/<date>-analysis.md     … ②分析（分析担当が作る）
research/<genre>/<date>-plan.md         … ③企画（企画担当が作る）
```

- `<date>.json` は `{ genre, date, items }` の形。`items` は `lib/benchmark.js`
  の `checkItem` を通った投稿の記録（他人の投稿は公開情報のみ）。
- 集め方は `docs/research/CHROME_COLLECT.md` を参照。
- ここに入るのは公開されている情報だけ（アカウント名・ハンドル・画面に出ている
  数字・投稿本文）。ログインが要る個人情報やDMの中身は入れない。
