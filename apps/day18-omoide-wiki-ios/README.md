# おもいでWiki iOSアプリ化

`apps/day18-omoide-wiki/`（Web版のおもいでWiki）を [Capacitor](https://capacitorjs.com/) でiOSアプリの器に包み、GitHub Actions上のMac（クラウド）でビルドして TestFlight に送る仕組みです。**Macを持っていなくてもビルドできます。**

仕組みは旅の足跡（`apps/day07-tabilog-ios/`、DAY26）とまったく同じです。見た目・データ・動きはすべてWeb版と共通で、このフォルダには「Web版をアプリとして包むための設定」だけが入っています。ネイティブの `ios/` フォルダはリポジトリに入れず、ビルドのたびにCI上で作り直します。

- Bundle ID：`com.hiroyaapps.omoidewiki`
- アプリ名：おもいでWiki
- ワークフロー：`.github/workflows/omoide-wiki-ios-build.yml`（手動実行のみ）
- アイコン・起動画面：`resources/icon.png`（1024×1024）・`resources/splash.png`（2732×2732）。ビルド時に各サイズへ自動で書き出されます

## 費用

- Apple Developer Program（年99ドル）：旅の足跡と同じアカウントを使うので**追加費用なし**
- GitHub Actionsのmacosランナー：公開リポジトリなら無料枠で足ります

## Web版から変えている点（アプリの中でだけ効く）

- **JSONの書き出し**：アプリの中ではブラウザのダウンロードが動かないため、一時フォルダにファイルを書いてからiPhoneの共有シート（AirDrop・「ファイル」に保存・LINEなど）を開きます（`@capacitor/filesystem`・`@capacitor/share`）
- **印刷 / PDFで保存**：アプリの中では `window.print()` が動かないため、ボタンを隠しています
- **`server.iosScheme` を `https`** にしています。Capacitor既定の `capacitor://` だと「安全なページ」と見なされず、マイクなどが使えないため（旅の足跡で発生）。**あとから変えると、アプリ内に保存したデータが見えなくなる**（保存場所がページのアドレスごとに分かれているため）ので、変えないでください
- Info.plistに、マイク・音声認識・カメラの利用目的の説明文を入れています（無いと許可を求められずに止まる、またはアプリが落ちる）

## あなたにやってもらう作業（Appleの管理画面）

旅の足跡のときに作った**配布用証明書とApp Store ConnectのAPIキーは、そのまま使い回せます**（GitHubのシークレットも登録済み）。新しく必要なのは、このアプリ用の「Bundle ID」「プロビジョニングプロファイル」「App Store Connectのアプリの箱」の3つです。

### 1. Bundle IDを登録する

1. https://developer.apple.com/account/resources/identifiers/list を開く
2. 「+」→「App IDs」→「App」を選んで続ける
3. Description：`omoide wiki`（半角英数字なら何でもよい）
4. Bundle ID：「Explicit」を選び、`com.hiroyaapps.omoidewiki` と入力
5. Capabilities は何もチェックしなくてよい →「Continue」→「Register」

### 2. プロビジョニングプロファイルを作る

1. https://developer.apple.com/account/resources/profiles/list を開く
2. 「+」→ Distribution の「**App Store Connect**」を選んで続ける
3. App ID：手順1の `com.hiroyaapps.omoidewiki` を選ぶ
4. 証明書：**旅の足跡で使っている「Apple Distribution」の証明書**を選ぶ（複数あるときは、有効期限がいちばん新しいもの）
5. Provisioning Profile Name：**`omoide-wiki-appstore`**（ビルドの設定がこの名前を探すので、1文字も変えないでください）
6. 「Generate」→「Download」で `.mobileprovision` ファイルを保存

### 3. プロファイルをGitHubに登録する

PowerShellで次を実行すると、ファイルの中身が文字（base64）に変換されてクリップボードにコピーされます（ファイル名は保存したものに合わせてください）。

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\omoide-wiki-appstore.mobileprovision")) | Set-Clipboard
```

GitHubのこのリポジトリ → Settings → Secrets and variables → Actions →「New repository secret」

| シークレット名 | 値 |
|---|---|
| `OMOIDE_IOS_PROVISIONING_PROFILE_BASE64` | さきほどコピーした文字を貼り付け |

### 4. App Store Connectでアプリの箱を作る

1. https://appstoreconnect.apple.com/apps →「+」→「新規App」
2. プラットフォーム：iOS
3. 名前：おもいでWiki（他の人が使っていたら登録できないので、そのときは相談してください）
4. プライマリ言語：日本語
5. バンドルID：`com.hiroyaapps.omoidewiki` を選ぶ
6. SKU：`omoidewiki001`（何でもよい）
7. ユーザアクセス：フルアクセス

### 5. ビルドする

GitHubのこのリポジトリ →「Actions」タブ →「おもいでWiki iOS ビルド & TestFlightアップロード」→「Run workflow」（ブランチは `main`）。20〜30分ほどで終わり、成功すると少し後にApp Store ConnectのTestFlightにビルドが出てきます。

失敗したら、赤くなったステップのログを送ってください。旅の足跡でも8回目で通ったので、1回で通らなくても普通です。

### 6. iPhoneに入れる

1. App Store Connect → おもいでWiki →「TestFlight」タブ →「内部テスト」にグループを作り、自分（と家族のApple ID）を追加
2. iPhoneに「TestFlight」アプリ（App Storeにある無料アプリ）を入れる
3. 届いた招待からおもいでWikiをインストール

## 実機で確かめてほしいこと

iOSアプリの中（WKWebView）でしか分からないことがあるので、次を試して、ダメだったものを教えてください。

1. Wikiを作って、アプリを完全に閉じて開き直しても残っているか
2. インタビューで「音声で会話する」をオンにして、質問が**Geminiの声で**読み上げられるか
3. マイクボタンを押して話すと、**文字になるか**（いちばん心配な点。アプリの中ではブラウザの音声認識が使えない可能性があり、その場合はiPhone標準の音声認識を使う部品に差し替えます）
4. 写真を添えられるか（「写真ライブラリ」「写真を撮る」の両方）
5. 「JSONで書き出す」で共有シートが出て、「ファイル」に保存できるか
6. AIの深掘り・「AIでまとめる」が動くか

## このあと（App Storeで一般公開するとき）

TestFlightで問題が無くなったら、一般公開の審査に向けて次を用意します。

- 回答をOpenAI・Google（Gemini）に送っていることを説明し、同意をもらう画面（Appleの審査ガイドライン 5.1.2）
- プライバシーポリシーのページ
- 説明文・スクリーンショット（「Wikipedia」は他社の商標なので、説明文には使わない）
