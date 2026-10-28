# ごはんの足跡 iOS

Web版（`apps/gohan-ashiato`）をそのまま同梱するCapacitor 8のiPhoneアプリ。Bundle ID は `com.hiroyaapps.gohanashiato`。旅の足跡・観戦日記と同じApple Developerアカウントを使う。

## Web版との違い

- 写真は `@capacitor/camera` の `pickImages` で選ぶ。iPhoneのWebViewはファイルとして渡す写真から位置情報を消すため、プラグインが返すexif（撮影日時・GPS）を使う（旅の足跡と同じ方法）。「撮る」ボタン（カメラ）もアプリだけに出す。カメラで撮った写真は位置が無いことが多いので、その場合は現在地を取る
- 書き出しは、ファイルを一時フォルダに書いて共有メニューで保存先を選ぶ（WebViewではダウンロードができないため）
- それ以外（保存場所＝端末内のlocalStorage／IndexedDB、近くのお店の候補など）はWeb版と同じコード
- iPhone専用（`TARGETED_DEVICE_FAMILY=1`）

`src/native.mjs` が `window.GohanNative = { Camera, Filesystem, Share }` を用意し、Web版の `app.js` はそれがあればアプリとして動く。

## ローカル

Node.js 22以降。`npm ci` → `npm test`（同梱物とAPI署名のテスト）→ `npx cap add ios && node scripts/configure-ios.mjs`。`ios/` と `www/` は毎回作り直すのでGitに入れない。コンパイル・署名はMac（Xcode 26以降）かGitHub Actionsで行う。

## GitHub Actions（ワークフロー「ごはんの足跡 iOS」）

PRとmainへのpushで、署名なしのシミュレータービルドと起動確認（スクリーンショットは成果物の `build/qa/`）。手動実行（workflow_dispatch）で次を選ぶ:

| destination | すること |
| --- | --- |
| simulator | 署名なしでビルドしてシミュレーターで起動確認 |
| setup | App Store Connect APIで Bundle ID を登録し、App Store Connectにアプリがあるか確認（Macは使わない） |
| testflight | 配信用プロファイルをAPIで用意（無ければ作る）→ 署名 → TestFlightへアップロード |

使うSecretは旅の足跡・うちの家事と共通のリポジトリSecret（`IOS_DIST_CERTIFICATE_P12_BASE64`・`IOS_DIST_CERTIFICATE_PASSWORD`・`APPLE_TEAM_ID`・`APPSTORE_CONNECT_API_KEY_ID`・`APPSTORE_CONNECT_API_ISSUER_ID`・`APPSTORE_CONNECT_API_PRIVATE_KEY`）。アプリ専用のプロファイルSecretは要らない（`scripts/asc.mjs` がAPIで作る）。APIキーにプロファイル作成の権限（Admin／App Manager）が無い場合は setup・testflight が403で止まる。

## 初めて配信するまでの手順

1. Actionsで destination=setup を実行（Bundle IDの登録）
2. App Store Connect（人の作業）：マイApp →「＋」→ 新規App。名前「ごはんの足跡」（使われていたら別名）、言語 日本語、バンドルID `com.hiroyaapps.gohanashiato`、SKU は任意（例 gohanashiato）
3. Actionsで destination=testflight を実行 → 10〜30分ほどでTestFlightに出る
4. 知人に配る：TestFlightの「外部テスト」グループを作ってビルドを追加（初回はAppleのベータ審査あり）、メールで招待か公開リンク。TestFlightのビルドは90日で期限切れになるので、長く使ってもらうならApp Storeで公開する（プライバシーポリシーのURL・スクリーンショット・説明文が必要）

## 実機で確認すること

写真を選んだときに撮影日時と場所が入るか／近くのお店の候補が出るか／「撮る」→ 現在地／アプリを終了・再起動しても記録と写真が残るか／書き出し→ファイルに保存→読み込み。
