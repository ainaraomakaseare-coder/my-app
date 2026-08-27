# 輸入ブラックジャック

海外の特殊なルールを取り入れたブラックジャック。1台の端末を回して遊びます。HTML1枚で動き、ビルドもサーバーも要りません。

作ったときの要件は `requirements.md` にあります。

```
node test/bj.rules.test.js   # ルールと点の計算
node test/bj.ui.smoke.js     # 実ブラウザでの画面の流れ（要 playwright）
```
