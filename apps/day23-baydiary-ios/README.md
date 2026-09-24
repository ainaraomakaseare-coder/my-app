# ベイ日記 iOS

配信準備中。Web版を同梱するCapacitor 8アプリです。Bundle ID案は com.hiroyaapps.baydiary。既存の「旅の足跡」と同じApple Developerアカウントを使用しますが、アプリ登録・配信プロファイルは別です。

## 現在の範囲

観戦記録・年度/月/球場/大会別の分析・結果画像・JSON取込を同梱。PNGとバックアップJSONはiOS共有シートから保存/送信します。オンラインフォントは同梱時に除去し、端末フォントを使います。OpenAIキーや開発サーバーは含めません。

iOSテスト版のAI読み取りは無効です。PCのlocalhostサーバーには接続しません。公開HTTPS APIと認証・利用枠管理が完成した時点で src/native.mjs の extractMemo を置き換え、送信先・送信内容を表示して明示的同意を得るUIを追加します。既存Web版のAIは引き続き利用可能です。

無料50試合/追加50試合100円/分析Plusは計画段階で、購入も利用枠もまだ実装されていません。このビルドは内部テスト用であり、App Store提出可能な完成版ではありません。

## ローカル準備

Node.js 22以降。npm ci → npm run ios:add（初回のみ）、以降 npm run sync。npm test で共有と同梱チェック。ios/ と www/ は再生成するためGit対象外です。

Macでは Xcode 26以降で ios/App/App.xcodeproj を開きます。依存管理はSwift Package Manager。iOS 15以降が対象です。Windowsでは生成・同期まで可能ですが、Xcodeでのコンパイル/署名/実機実行はできません。

## GitHub Actions

専用ワークフロー BayDiary iOS を workflow_dispatch で実行します。
- simulator: 秘密鍵不要でシミュレーター用App.appを生成。
- testflight: 同じ開発者チームで署名し、TestFlightへアップロード。App Store一般公開/審査提出は行いません。

新しいアプリをApple Developer/App Store Connectに登録し、専用App Store配信プロファイルを作成して、次のSecretsを設定してください。値をチャット・Git・HTMLに貼らないでください。

| Secret | 内容 |
| --- | --- |
| BAYDIARY_PROVISIONING_PROFILE_BASE64 | com.hiroyaapps.baydiary 専用のApp Store配信プロファイル |
| IOS_DIST_CERTIFICATE_P12_BASE64 | 既存アカウントのApple Distribution証明書（秘密鍵を含む） |
| IOS_DIST_CERTIFICATE_PASSWORD | p12パスワード |
| APPLE_TEAM_ID | 同じApple DeveloperチームのID |
| APPSTORE_CONNECT_API_KEY_ID | App Store Connect APIキーID |
| APPSTORE_CONNECT_API_ISSUER_ID | Issuer ID |
| APPSTORE_CONNECT_API_PRIVATE_KEY | .p8秘密鍵 |

既存証明書とAPIキーの再利用は権限と有効期限を確認して行います。既存の旅の足跡のプロファイルは再利用できません。専用profileのBundle ID/Team ID/有効期限/配信種別はビルド時に検査します。CI環境名は baydiary-build / baydiary-testflight。GitHubへの書込権限が必要です。現接続はREADなのでローカル準備までです。

## データ移行と実機検証

Web版とiOS版の保存領域は別です。Web版「設定→書き出す」で写真込みのJSONを保存し、iOS版で読み込んでください。ブラウザのデータを自動移行はしません。

実機で必須: 写真添付→アプリ強制終了→再起動後の復元、更新後の記録保持、PNGを写真/LINE等へ共有、写真込みJSONのファイル保存/復元、共有キャンセル、大きなバックアップ、横向き・iPad、機内モード。

現在の記録はWebViewのlocalStorage、写真はIndexedDBです。端末内保存の実機保持検証が未完です。大きなJSONはbase64変換でメモリを使うため実機で上限を確認してください。重要な記録はJSONバックアップを維持してください。

## 公開前の残件

tasks/todo.md と STORE-LISTING.md を参照。AI公開基盤、課金、実機検証、公開プライバシーポリシー/サポートURL、スクリーンショットとプライバシー申告が残っています。将来AIを有効化する際は現在の端末内処理のみのプライバシーマニフェスト/説明も見直してください。

参照: [Capacitor環境要件](https://capacitorjs.com/docs/getting-started/environment-setup)、[Filesystemプライバシー要件](https://capacitorjs.com/docs/apis/filesystem)、[Appleビルドアップロード](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds)、[App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)。

## iPhone向けネイティブ画面

native/BayDiaryViewController.swift にUIKitのタブバーと単一Capacitor画面を実装しています。SF Symbols、選択時の触覚フィードバック、入力画面でのタブ非表示、ネイティブとWebの選択状態同期に対応。SceneDelegateとStoryboardの両起動経路を構成スクリプトで更新します。再生成してもSwiftソースを失いません。

src/ios.css は端末フォント・相対文字サイズ・ダークモード・44pt以上の操作領域・モーション抑制に対応。全画面をSwiftUIに書き直したものではなく、UIKitの操作部と既存Webの記録/分析画面を組み合わせた構成です。SwiftコードはWindowsでコンパイルできないため、クラウドXcodeの検証が完了するまではネイティブ動作確認済みとは扱いません。

開発ブランチへのpushで署名不要のシミュレータービルドを行います。TestFlight送信は従来どおり明示的なworkflow_dispatchのみです。
