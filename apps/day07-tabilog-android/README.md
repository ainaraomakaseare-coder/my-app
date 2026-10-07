# 旅の足跡 Androidアプリ化

iOS版（`../day07-tabilog-ios/`）と同じく、Web版（`../day07-tabilog/`）を [Capacitor](https://capacitorjs.com/) で包んだAndroidアプリです。見た目・データはWeb版と共通で、このフォルダには「Androidアプリとして包むための設定」だけが入っています。

`android/`（Android Studioのプロジェクト）はリポジトリに入れず、GitHub Actions（`.github/workflows/tabilog-android-build.yml`）がビルドのたびに `npx cap add android` で作り直します。マイク・カメラの権限、`tabilog://` のURLスキーム、バージョン、署名の設定は `scripts/patch-android.py` が毎回足します（iOSでCIがInfo.plistに足しているもののAndroid版）。

- **Capacitorは8系**：Google Playは2026年8月31日から、新しいアプリにAndroid 16（API 36）対応を求めている。Capacitor 6（iOS版が使っている版）では足りないため、Android版だけ先に8系にしている。iOS版も上げるときは別に確かめる
- アイコン・起動画面は、iOS版の `resources/icon.png`・`splash.png` をCIでコピーして使う
- 回数券のアプリ内課金はまだ入っていない（`app.js` はiOSのときだけ購入画面を出す）。Android版でも売るときは、Google Playの「アプリ内アイテム」とRevenueCatのPlay Storeアプリを用意してから

## 費用

- **Google Play Console：25ドル（1回だけ）**
- GitHub Actionsの `ubuntu-latest`：パブリックリポジトリなら無料

## 公開までの流れ

1. **Play Consoleに登録**（あなた）：https://play.google.com/console/signup →「個人」→ 25ドル → 本人確認
2. **アプリを作る**（あなた）：https://play.google.com/console →「アプリを作成」（名前「旅の足跡」、日本語、アプリ、無料）
3. **アップロード用の鍵を作り、GitHubに登録**（あなた。下の「署名の鍵」）
4. **ビルド**：GitHubの Actions →「旅の足跡 Android ビルド」→「Run workflow」。できた `tabilog-android-release-aab` の中の `.aab` を使う
5. **内部テスト**：Play Console →「テスト」→「内部テスト」→ 新しいリリースに `.aab` を上げる（最初の1回は手で上げる）。「Google Playによるアプリ署名」はそのまま使う
6. **クローズドテスト**：12人以上に14日間続けて使ってもらう（2023年11月以降に作った個人アカウントは必須。https://support.google.com/googleplay/android-developer/answer/14151465 ）
7. **本番へのアクセスを申請** → 審査 → 公開

ストアの掲載情報・データセーフティ・コンテンツのレーティングなどの入力内容は、iOS版の `../day07-tabilog-ios/app-store-listing.md` を元に用意する。

## 署名の鍵（アップロード鍵）

Google Playに上げる `.aab` は、自分で作った「アップロード鍵」で署名する必要があります（実際にユーザーに配るときの署名はGoogleが行う）。

1. PCにJava（JDK）が無ければ入れる：https://adoptium.net/
2. ターミナル（PowerShell）で鍵を作る。聞かれたパスワードと名前は控えておく
   ```
   keytool -genkeypair -v -keystore tabilog-upload.keystore -alias tabilog -keyalg RSA -keysize 2048 -validity 10000
   ```
3. 鍵ファイルを文字列にする（PowerShell）
   ```
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("tabilog-upload.keystore")) | Set-Clipboard
   ```
4. https://github.com/ainaraomakaseare-coder/my-app/settings/secrets/actions で次の4つを登録

   | シークレット名 | 値 |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | 3.でコピーした文字列 |
   | `ANDROID_KEYSTORE_PASSWORD` | 2.で決めたキーストアのパスワード |
   | `ANDROID_KEY_ALIAS` | `tabilog` |
   | `ANDROID_KEY_PASSWORD` | 2.で決めた鍵のパスワード（聞かれなかったらキーストアと同じ） |

5. `tabilog-upload.keystore` はリポジトリに入れず、パスワードと一緒に安全な場所に保管する（無くしてもGoogleに頼めば作り直せるが、手間がかかる）

## ログインについて

Google・Apple・LINEのログインは、iOS版と同じくアプリの中で開くブラウザ（Androidでは Chrome Custom Tabs、`@capacitor/browser`）で行い、終わると `tabilog://auth?…` でアプリに戻る。このURLスキームは `scripts/patch-android.py` がAndroidManifestに登録する。
