# たびログ iOSアプリ化

`apps/day07-tabilog/`（Web版のたびログ）を、[Capacitor](https://capacitorjs.com/) でiOSアプリの器に包み、GitHub Actions上のMac（クラウド）でビルドしてTestFlight（→App Store）に送る仕組みです。**Macを持っていなくてもビルドできます**（ビルド作業はすべてGitHub Actionsのmacosランナー上で行われます）。

見た目・データはすべてWeb版（`apps/day07-tabilog/`）と共通です。このフォルダには「Web版をアプリとして包むための設定」だけが入っていて、`ios/` というネイティブのXcodeプロジェクトは**リポジトリには入れず、ビルドのたびにCI上で作り直します**（中身が大きい・環境依存のファイルのため）。

## 費用（必ず発生するもの）

- **Apple Developer Program：年間99ドル（約1万5千円）**。App Storeで配布する以上、これは避けられません
- GitHub Actionsのmacosランナー：パブリックリポジトリなら無料枠で足りることがほとんどです（消費が早いランナーなので、有料アカウント・プライベートリポジトリの場合は使用量に注意してください）

## 進め方（Appleの管理画面での作業が中心です）

**ここから先は、Appleの管理画面（developer.apple.com・appstoreconnect.apple.com）でご自身のApple IDを使って行う作業です。私（Claude）が代わりに行うことはできません。** 一緒に画面を見ながら進めましょう。

### 1. Apple Developer Programに登録する

1. https://developer.apple.com/programs/enroll/ を開く
2. お持ちのApple IDでサインイン
3. 「個人（Individual）」として登録（法人でなければこちらで十分です）
4. 年間99ドルを支払う（クレジットカード）
5. 本人確認が入ることがあり、承認まで数時間〜1日程度かかる場合があります

### 2. App Store ConnectでAPIキーを作る（CIが自動アップロードするために使う）

1. https://appstoreconnect.apple.com/access/api を開く
2. 「キー」タブ →「+」で新しいキーを作成。名前は何でもよい（例：`tabilog-ci`）
3. アクセス権限は「App Manager」を選択
4. 作成すると以下の3つが手に入ります。これをこの後GitHubに登録します
   - **Key ID**（例：`ABCD123456`）
   - **Issuer ID**（画面上部に表示されている、ハイフン区切りの長いID）
   - **秘密鍵ファイル（.p8）**：ダウンロードは1回きりなので、無くさないよう保管してください

### 3. Team IDを確認する

https://developer.apple.com/account の「Membership」ページに表示されている10桁の英数字が Team ID です。

### 4. App Store Connectでアプリの箱を作る

1. https://appstoreconnect.apple.com/apps → 「+」→「新規App」
2. プラットフォーム：iOS
3. 名前：たびログ（他の人が使っていなければそのまま使えます。使われていたら別名にする必要があります）
4. Bundle ID：`com.hiroyaapps.tabilog`（`capacitor.config.json` と同じ値にする。事前に developer.apple.com の「Identifiers」からこのBundle IDを登録しておく必要があります）
5. SKU：何でもよい（例：`tabilog001`）

### 5. GitHubにシークレットを登録する

このリポジトリの Settings → Secrets and variables → Actions → 「New repository secret」で、以下を1つずつ登録してください。

| シークレット名 | 値 |
|---|---|
| `APPLE_TEAM_ID` | 手順3で確認した10桁のTeam ID |
| `APPSTORE_CONNECT_API_KEY_ID` | 手順2のKey ID |
| `APPSTORE_CONNECT_API_ISSUER_ID` | 手順2のIssuer ID |
| `APPSTORE_CONNECT_API_PRIVATE_KEY` | 手順2でダウンロードした`.p8`ファイルの中身をテキストエディタで開いて、そのまま貼り付け（`-----BEGIN PRIVATE KEY-----`から`-----END PRIVATE KEY-----`まで全部） |

### 6. ビルドを実行する

このリポジトリの「Actions」タブ →「たびログ iOS ビルド & TestFlightアップロード」→「Run workflow」ボタンで手動実行します。成功すると、数分〜数十分後にTestFlightにビルドが表示されます（App Store Connect側でのメール審査待ちが入ることもあります）。

### 7. TestFlightで確認 → 本審査へ

1. App Store Connect →対象アプリ→「TestFlight」タブでビルドを内部テスターに配布し、実機で動作確認
2. 問題なければ「App Store」タブから、スクリーンショット・説明文・プライバシーポリシーURLなどを入力して審査に提出

## 正直にお伝えしておきたいこと

このワークフロー（`.github/workflows/tabilog-ios-build.yml`）は、実際にXcodeでのビルドを一度も検証していない**たたき台**です。iOSの証明書まわりの設定は細かい部分でつまずきやすく、Apple Developer Programに登録してシークレットを設定したあとに実行してみて、エラーが出たら一緒に直していく前提で用意しています。うまく1回で通るとは限らないことをご了承ください。

## まだ用意していないもの

- **アプリアイコン**（1024×1024のApp Store用アイコンなど、複数サイズ必要）：Web版の簡易アイコンのままでは審査に必要な形式に足りません
- **スクリーンショット・説明文・プライバシーポリシーページ**：App Store Connectへの申請に必要です
- これらは次のステップとして、必要になったタイミングで一緒に用意しましょう
