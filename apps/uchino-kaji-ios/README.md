# うちの家事 iOS

家事カレンダーをCapacitorでiOSアプリとして配布します。Web画面を端末に同梱し、共有データはSites上のAPIへHTTPSで同期します。ログインは不要で、家ごとに発行する秘密付き共有URLを利用します。

- Bundle ID: `com.hiroyaapps.uchinokaji`
- iOSビルド: GitHub ActionsのmacOS runner（Mac不要）
- ビルドコマンド: `npm ci` → `npm run ios:add` → TestFlight upload
- TestFlight送信は手動実行だけ。App Store一般公開や審査提出は行いません。
- GitHub Secretsは `IOS_DIST_CERTIFICATE_P12_BASE64`, `IOS_DIST_CERTIFICATE_PASSWORD`, `KAJI_PROVISIONING_PROFILE_BASE64`, `APPLE_TEAM_ID`, `APPSTORE_CONNECT_API_KEY_ID`, `APPSTORE_CONNECT_API_ISSUER_ID`, `APPSTORE_CONNECT_API_PRIVATE_KEY` を参照します。
- 証明書とApp Store Connect APIキーは既存アプリと共有し、専用のプロビジョニングプロファイルを使います。
- 年間開発者会費以外の有料サービスは使いません。リポジトリをpublicで運用する場合GitHub Actions標準macOS runnerは無料です。
