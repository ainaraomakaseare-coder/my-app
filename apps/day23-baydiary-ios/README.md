# ベイ日記 iOSアプリ化

`apps/day23-baydiary/`（Web版のベイ日記）を、[Capacitor](https://capacitorjs.com/) でiOSアプリの器に包み、GitHub Actions上のMac（クラウド）でビルドしてTestFlight（→App Store）に送る仕組みです。**Macを持っていなくてもビルドできます**（ビルド作業はすべてGitHub Actionsのmacosランナー上で行われます）。仕組みは`apps/day07-tabilog-ios/`（旅の足跡のiOS化）と同じで、そちらで一度つまずいた箇所（署名まわり）はあらかじめ踏まえてあります。

見た目・データはすべてWeb版（`apps/day23-baydiary/`）と共通です。このフォルダには「Web版をアプリとして包むための設定」だけが入っていて、`ios/` というネイティブのXcodeプロジェクトは**リポジトリには入れず、ビルドのたびにCI上で作り直します**。

アプリアイコン・起動画面（スプラッシュ）は `resources/icon.png`（1024×1024）・`resources/splash.png`（2732×2732）として、ベイ日記のチケット風デザイン（紺・クリーム・レンガ色）に合わせて用意済みです。ビルド時に `@capacitor/assets` が自動的に各サイズへ書き出します（差し替えたい場合はこの2枚を上書きしてください）。

## 費用（すでに旅の足跡でApple Developer Programに登録済みなら、追加費用なし）

- **Apple Developer Program：年間99ドル**。ただし**旅の足跡（DAY26）で既に登録済みのはず**なので、同じアカウントでベイ日記も配布でき、追加の年会費は発生しません
- GitHub Actionsのmacosランナー：パブリックリポジトリなら無料枠で足りることがほとんどです

## 旅の足跡と共有できるもの・できないもの

Apple Developerアカウントは1つで複数のアプリを配布できるため、以下は**旅の足跡のセットアップ時に作ったものをそのまま使い回せます**（GitHubシークレットも同じ名前で既に登録されているはずなので、追加作業は不要です）。

| 項目 | 使い回せる？ |
|---|---|
| Apple Developer Programの登録 | 使い回せる |
| Team ID（`APPLE_TEAM_ID`） | 使い回せる |
| App Store Connect APIキー（`APPSTORE_CONNECT_API_KEY_ID`・`APPSTORE_CONNECT_API_ISSUER_ID`・`APPSTORE_CONNECT_API_PRIVATE_KEY`） | 使い回せる（App Manager権限はアカウント内の全アプリに効く） |
| 配布用証明書（`IOS_DIST_CERTIFICATE_P12_BASE64`・`IOS_DIST_CERTIFICATE_PASSWORD`） | 使い回せる（証明書はアカウント単位） |
| **Bundle ID** | **使い回せない**（ベイ日記専用に新しく作る：`com.hiroyaapps.baydiary`） |
| **プロビジョニングプロファイル** | **使い回せない**（Bundle IDごとに別物。新しいシークレット`IOS_BAYDIARY_PROVISIONING_PROFILE_BASE64`として登録する） |
| **App Store Connect上のアプリの箱** | **使い回せない**（アプリごとに新規作成） |

つまり、下記の手順のうち **1〜3は旅の足跡で済んでいれば飛ばしてOK**です。**4・5・6がベイ日記で新しく必要な作業**です。

## 進め方（Appleの管理画面での作業が中心です）

**ここから先は、Appleの管理画面（developer.apple.com・appstoreconnect.apple.com）でご自身のApple IDを使って行う作業です。私（Claude）が代わりに行うことはできません。** 一緒に画面を見ながら進めましょう。

### 1. Apple Developer Programに登録する（旅の足跡で済んでいれば不要）

`apps/day07-tabilog-ios/README.md` の手順1を参照してください。

### 2〜3. App Store ConnectのAPIキー・Team ID（旅の足跡で済んでいれば不要）

`apps/day07-tabilog-ios/README.md` の手順2・3で作ったものをそのまま使います。GitHubシークレットに既に `APPLE_TEAM_ID`・`APPSTORE_CONNECT_API_KEY_ID`・`APPSTORE_CONNECT_API_ISSUER_ID`・`APPSTORE_CONNECT_API_PRIVATE_KEY` が登録されていれば、そのままで大丈夫です。

### 4. ベイ日記専用のBundle IDを登録する

1. https://developer.apple.com/account/resources/identifiers/list を開く
2. 「+」→「App IDs」→「App」
3. Description：`ベイ日記`（何でもよい）
4. Bundle ID：「Explicit」で `com.hiroyaapps.baydiary` と入力
5. Capabilities：特にチェック不要（Sign in with Appleなどは使っていません）
6. 「Continue」→「Register」

### 5. App Store Connectでアプリの箱を作る

1. https://appstoreconnect.apple.com/apps → 「+」→「新規App」
2. プラットフォーム：iOS
3. 名前：ベイ日記（他の人が使っていなければそのまま使えます）
4. 主言語：日本語
5. Bundle ID：手順4で登録した `com.hiroyaapps.baydiary` を選択
6. SKU：何でもよい（例：`baydiary001`）

説明文・キーワード・データ収集の申告内容などの下書きは `app-store-listing.md` にまとめてあります。コピーして使ってください。プライバシーポリシーのURLは `../day23-baydiary/privacy.html`（公開後は `https://ainaraomakaseare-coder.github.io/my-app/apps/day23-baydiary/privacy.html`）です。

### 6. ベイ日記専用のプロビジョニングプロファイルを作る

1. https://developer.apple.com/account/resources/profiles/list を開く
2. 「+」→「App Store」（配布用）を選択
3. App ID：手順4で登録した `com.hiroyaapps.baydiary` を選択
4. 証明書：旅の足跡のときに作った配布用証明書（Apple Distribution）を選択
5. Profile Name：`baydiary-appstore`（ワークフロー内の名前と一致させる必要があります。変える場合は `.github/workflows/baydiary-ios-build.yml` 内の`baydiary-appstore`も合わせて変更してください）
6. 「Generate」→ ダウンロード（`.mobileprovision`ファイル）

ダウンロードしたファイルをbase64化して、GitHubシークレットに登録します。

```
base64 -i baydiary_App_Store.mobileprovision | pbcopy
```

（Macでの例。上記コマンドでクリップボードにコピーされます。WindowsやLinuxでは `certutil -encode` や `base64` コマンドを適宜使ってください）

このリポジトリの Settings → Secrets and variables → Actions → 「New repository secret」で、以下を登録してください。

| シークレット名 | 値 |
|---|---|
| `IOS_BAYDIARY_PROVISIONING_PROFILE_BASE64` | 上記でコピーしたbase64文字列 |

### 7. ビルドを実行する

このリポジトリの「Actions」タブ →「ベイ日記 iOS ビルド & TestFlightアップロード」→「Run workflow」ボタンで手動実行します。成功すると、数分〜数十分後にTestFlightにビルドが表示されます（App Store Connect側でのメール審査待ちが入ることもあります）。

### 8. TestFlightで確認 → 本審査へ

1. App Store Connect →対象アプリ→「TestFlight」タブでビルドを内部テスターに配布し、実機で動作確認
2. 問題なければ「App Store」タブから、スクリーンショット・説明文・プライバシーポリシーURLなどを入力して審査に提出

## 正直にお伝えしておきたいこと

このワークフロー（`.github/workflows/baydiary-ios-build.yml`）は、旅の足跡（`day07-tabilog-ios`）で実際に確立した仕組みをそのまま流用したものですが、**ベイ日記自体でのビルドはまだ一度も検証していません**。Bundle ID・プロビジョニングプロファイル名などの細部で、初回実行時にエラーが出る可能性があります。実行してみて、エラーが出たら一緒に直していきましょう。

写真添付まわり（カメラ利用の説明文）は旅の足跡での学びをあらかじめ反映済みですが、実機での動作確認はまだできていません。

## まだ用意していないもの

- **スクリーンショット**：App Store Connectへの申請に必要です。実機かPlaywrightのスクリーンショットで用意しましょう
- 上記の手順4〜6（Bundle ID登録・App Store Connectのアプリ作成・プロビジョニングプロファイル作成）は、まだ実施していません。必要になったタイミングで一緒に進めましょう
