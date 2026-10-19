# 1.4.0 申請の準備メモ（2026-10-17）

1.3.0（ビルド121、回数券つき）からの変更をまとめた版。

## このバージョンの新機能

### 日本語
```
・記録の時刻に「今」ボタンを付けました。押すと今の時刻が入ります
・地図の欄に「現在地を入れる」ボタンを付けました。今いる場所の地図をそのまま記録に入れられます
・マイログの評価の高い1〜3位に、金・銀・銅のメダルが付くようにしました
・年表から旅行を開くときの動きを、なめらかにしました
・「←」で戻ったとき、ホームの旅行一覧がすぐ見えるようにしました
・「地図でふりかえる」で、時差のある飛行機の到着や、宿から翌日の予定への動きが自然になりました
・音声・メモで入れた飛行機や電車の移動が1件にまとまり、所要時間も入るようにしました
・そのほか細かな不具合を直しました
```

### English
```
- Added a "Now" button to the record time. Tap it to fill in the current time
- Added "Use current location" to the map field, so you can add a map of where you are right now
- Your top 3 rated places in My Log now get gold, silver and bronze medals
- Opening a trip from the timeline is now smoother
- Going back with "←" now shows your trip list on the home screen right away
- "Replay on map" now moves more naturally for flights across time zones and from your hotel to the next day
- Flights and trains added by voice or memo now become a single trip with the travel time filled in
- Other small bug fixes
```

### 繁體中文
```
・紀錄的時間新增「現在」按鈕，按下即可填入現在的時間
・地圖欄新增「填入目前位置」按鈕，可以直接把所在地的地圖加進紀錄
・我的足跡中評分最高的前三名，會掛上金・銀・銅牌
・從年表開啟旅行時的動作更流暢了
・用「←」返回時，會馬上看到首頁的旅行列表
・「在地圖上回顧」中，跨時區的航班抵達和從住宿到隔天行程的移動更自然了
・用語音或備忘錄加入的航班和火車移動會整合成一筆，並自動填入所需時間
・修正了其他小問題
```

## 申請前に直すところ（App Store Connect）

- **Appのプライバシー**：「現在地を入れる」で緯度経度を記録に保存するので、「位置情報 → 正確な位置情報」を追加する
  （用途：アプリの機能／本人と結びつく：はい／トラッキング：いいえ）。1.3.0までは「位置情報：しない」だった
- AIの無料回数（月5回、#148）はWorker側の設定なので、Workerのデプロイが済んでいれば新機能に書いてよい。済んでいなければ書かない
