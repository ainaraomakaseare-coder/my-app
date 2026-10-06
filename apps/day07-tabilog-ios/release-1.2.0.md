# 1.2.0 申請の準備メモ（2026-10-06）

1.1.0（App Storeで公開中）からの変更をまとめた版。回数券（アプリ内課金）は入れない。回数券は有料アプリ契約が有効になってから 1.3.0 で出す。

## 手順

1. 【Claude】このブランチをmainに入れ、GitHub Actions「旅の足跡 iOS ビルド & TestFlightアップロード」をmainで実行する（バージョン1.2.0）
2. 【あなた】TestFlightで新しいビルドを入れて、ホーム・旅行の詳細・マイページ・チュートリアル・言語の切り替えを触って確認する
3. 【あなた or ClaudeがChromeで】App Store Connectで「＋バージョン」→ 1.2.0 を作る
4. 1.2.0 にビルドを選び、下の「このバージョンの新機能」を入れる
5. スクリーンショットを差し替える（iPhone 6.9インチ枠に `appstore-ja.zip`、iPad 13インチ枠に `appstore-ipad-ja.zip`）
6. ローカライズを追加：「繁体字中国語」「英語（米国）」。説明文などは `appstore-zh-hant.md`・`appstore-en.md`、スクリーンショットは `appstore-zh-Hant.zip`・`appstore-ipad-zh-Hant.zip`（英語の画像はまだ無いので、英語は日本語の画像を使うか、作るまで待つ）
7. App のプライバシーは変更なし（AIの読み取りは以前から申告済みの範囲。回数券を入れる1.3.0で「購入」を追加する）
8. 審査に提出。審査メモは下の文面

## このバージョンの新機能

### 日本語
```
・繁體中文と英語に対応しました（端末の言語で自動で切り替わり、マイページからも選べます）
・マイページを、アイコンで選べる形に作り直しました
・はじめて使う方向けに、3ステップの使い方ガイドを追加しました
・文字を読みやすいフォントに統一し、大きさを見直しました
・スクショから予定を作るとき、画像を選ぶボタンを分かりやすくしました
・メモの取り込みで「東京駅から山形駅へ」のような移動を判定し、到着時刻から移動時間を入れるようにしました
・そのほか細かな不具合を直しました
```

### 繁體中文
```
・新增繁體中文與英文介面（會依手機語言自動切換，也可在「我的頁面」選擇）
・重新設計「我的頁面」，用圖示就能找到想用的功能
・為第一次使用的人加入 3 步驟的使用說明
・統一為更好讀的字型並調整字級
・從截圖建立行程時，「選擇圖片」按鈕更清楚
・修正其他小問題
```

### English
```
- Now available in Traditional Chinese and English (follows your device language; you can also switch in My Page)
- Redesigned My Page with simple icon shortcuts
- A short 3-step guide for first-time users
- Easier-to-read fonts and sizes
- Clearer "Choose images" button when creating plans from screenshots
- Bug fixes and improvements
```

## 審査メモ（App Review Information）

```
旅の足跡 is a shared travel journal. A trip is opened with its share link; anyone with the link can view and add records without an account. Sign-in (Sign in with Apple, Google, LINE, or email code) is only needed for likes/comments, My Log and the AI import features.

This version adds Traditional Chinese and English localization, a redesigned My Page, a first-run tutorial and typography updates. There are no in-app purchases in this version, and the app does not offer or link to any purchases.

To test without signing in: tap "＋ 新しい旅を記録する" (Record a new trip), enter a name and dates, and add plans and records.
```
