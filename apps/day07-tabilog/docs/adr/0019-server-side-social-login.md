# Apple・Google・LINEのログインを、Worker側で検証する「認可コードフロー」に作り替える

それまでのGoogle／Appleログインは、ブラウザ用のJavaScriptライブラリ（Google Identity Services・Sign in with Apple JS）が返したidトークンを**アプリ側で読み取るだけ**の簡易版だった（サーバーでは検証しない）。クライアントIDも空のまま（`index.html`のmetaタグ）だったので、実際にはボタンが出ていなかった。さらに、iOSアプリ（CapacitorのWKWebView）の中ではGoogleがOAuthログインをブロックするため、iOSアプリで実質使えるログインは**メール（OTP）だけ**だった。

オーナーの要望：「メール・Apple・Google・LINEの4つでログインできるようにしたい。WebでもiOSアプリでも」。あわせて、メールOTP以外も**サーバーで本人確認する**ことにした（クライアントが送ってきた「私はこのメールの人です」を信じない）。

**決めたこと**：

- **ブラウザ用のSDKは使わず、Worker（Cloudflare）が「認可コードフロー」を全部やる**。`GET /auth/<google|apple|line>/start`でstate・nonce（とPKCE）をD1に置いてプロバイダーへ302 → プロバイダーが`/auth/<provider>/callback`に認可コードを返す（Appleだけ`response_mode=form_post`なのでPOST）→ Workerがトークンエンドポイントでコードをidトークンに交換 → iss・aud・exp・nonceを確認 → 結果をアプリに渡す。アプリは開始URLを開くだけで、プロバイダー固有のコードを持たない。純粋な部分（URL組み立て・idトークンの確認・結びつけの判断・AppleのJWT署名）は`worker/src/oauth.js`に分け、`worker/test/oauth.test.mjs`で単体テストする。
- **アカウントは今までどおりメールアドレスがキー**のまま（メールキーのテーブル群は触らない）。新しい`auth_identities(provider, subject, email)`で「このプロバイダーのこの人は、このメールのアカウント」を結びつけるだけ。結びつけの判断（`decideIdentity`）：①既にidentityがあればそのメール、②なければ「プロバイダーが確認済みメールを返した」なら**そのメールのアカウントと同一人物として扱い**（同じメールの既存アカウントがあればそこに入り、無ければ新規作成）identityを作る、③メールが分からない（LINEでメール権限が無いなど）なら**メールOTPで一度だけ確認してもらい**、確認できたメールにidentityを結びつける（次回からはそのプロバイダーだけで入れる）。これはオーナーが選んだ方針。
- **セッショントークンをURLに載せない**。認可の結果は「使い捨てコード」（乱数・DBにはハッシュだけ・5分・1回だけ）で渡し、アプリが`POST /auth/exchange`でセッションに交換する（返す形はメールOTPの`/auth/email/verify`と同じ`{email, name, token}`、`issueSession`をそのまま使う）。Webは`<戻り先>#auth=<コード>`（メール確認が必要なときは`#auth_link=<コード>`、失敗・キャンセルは`#auth_error=…`）にリダイレクトし、アプリ側はハッシュを`history.replaceState`ですぐ消す。ハッシュはサーバーには送られず、Referer にも載らない。
- **iOSアプリはシステムのブラウザ（Safari）でログインし、結果をポーリングで受け取る**。Googleが埋め込みWebViewを拒否するため。アプリが自分で作った`req`（ランダム32文字）を`/auth/<provider>/start?return=app&req=…`に渡してSafariで開き、ログインが終わるとWorkerが`auth_native_results`に結果（コード）を置いて「ログインできました。アプリに戻ってください」ページを出す。アプリは`GET /auth/poll?req=…`を2秒ごと（アプリに戻った瞬間にもすぐ）、最大5分聞き、読んだ結果は消える。**Capacitorのプラグインは追加していない**（Workerのホストは`capacitor.config.json`の`allowNavigation`に無いので、`window.open`でCapacitorが自動的にSafariへ渡す）ため、iOSのビルド手順は変わらない。
- **Worker側の設定がある方式だけ、ログイン画面にボタンを出す**（`GET /auth/providers`）。ログイン画面の順番は「Apple・Google・LINE・メール」。App Store Review Guideline 4.8（他社ログインを提供するなら、Sign in with Appleも同格で用意する）は、Appleを必ず並べることで満たす。Appleが未設定のままGoogleやLINEだけ設定する、という状態にはしないこと（README参照）。
- **戻り先（`return`）は許可リスト（`ALLOWED_ORIGIN`）のOriginだけ**（`parseReturnTarget`）。開発用にhttp://localhostだけ通す。`https://x.pages.dev@evil.com`のようなuserinfoや前方一致のすり抜けは拒否する（テストあり）。`return`には`?trip=…`まで含めたページのURLを渡し、共有された旅行を開いたままログインから戻れるようにした。
- **idトークンの署名（JWKS）検証は省いた**。idトークンはプロバイダーのトークンエンドポイントから、こちらのclient_secret付きのTLS通信で**直接**受け取るもので、ブラウザ経由で渡ってきたものではない。OpenID Connectの仕様は、この場合に署名検証を省いてよいとしている。代わりにiss・aud・exp・nonceは必ず確かめる（`checkIdTokenClaims`）。JWKSの取得とキャッシュはfetchが1回増え、Workers無料枠（1リクエスト50回）と複雑さに見合わないと判断した。
- **Appleの`client_secret`は、`.p8`の秘密鍵からWebCryptoでES256のJWTを自分で署名して作る**（`buildAppleClientSecret`。有効期限5分・都度作成。テストで公開鍵による署名検証まで行っている）。npmパッケージは使わない。
- **設定値**：vars `GOOGLE_CLIENT_ID`・`APPLE_SERVICES_ID`・`APPLE_TEAM_ID`・`APPLE_KEY_ID`・`LINE_CHANNEL_ID`、secrets `GOOGLE_CLIENT_SECRET`・`APPLE_PRIVATE_KEY`・`LINE_CHANNEL_SECRET`。コールバックURLはWorker自身のOrigin（`https://tabilog-api.hiroya-apps.workers.dev/auth/<provider>/callback`）。`wrangler.jsonc`にはIDを書かず、オーナーが各コンソールで登録したあとに設定する。すべて無料。
- **新しいアカウントの名前はプロバイダーの表示名**。ただし既にアカウントに名前があれば上書きしない（`/auth/exchange`が既存の名前を優先して返す）。Appleは名前を初回のPOSTの`user`パラメータでしか渡さないので、初回に取れなければ空になり、その場合はメールアドレスが表示名の代わりになる（従来と同じ）。
- **アカウント削除（`/accounts/delete`）で`auth_identities`も消す**。削除→再登録の特典の抜け道を作らない考え方は従来と同じ（accounts行は残し、identityだけ消す）。
- **新しいテーブル**（migrations/0028）：`auth_identities`、`auth_states`（state・nonce・PKCEを10分だけ）、`auth_codes`（使い捨てコード）、`auth_native_results`（アプリ用の受け渡し）。期限切れの行は`/auth/<provider>/start`のたびにまとめて消す（専用の定期処理は作らない）。
- `/auth/<provider>/start`・`/callback`はブラウザのページ移動（Originがプロバイダー側になる。Appleのform_postでは`appleid.apple.com`）なので、既存のOrigin許可チェックの対象から外した。代わりにstate（使い捨て・10分・プロバイダー一致）とnonce・認可コードで守る。

**気をつけること（リスクとして受け入れたもの）**：

- **LINEのメールは「確認済み」として扱う**（idトークンに`email_verified`が無いため）。LINEは登録時にメールの確認を求めるが、Googleの`email_verified`のような明示的な保証ではない。メールが同じなら同一アカウントとする方針の上に成り立つので、LINEに他人のメールアドレスを登録した人がその人のアカウントに入れてしまう可能性はゼロではない。気になるなら、LINEだけ常にメールOTPを挟む形に変えられる（`extractProfile`の`verified`をfalseにするだけ）。
- **Appleの「メールを非公開」を選んだ人**は、`xxxx@privaterelay.appleid.com`という中継アドレスが返るので、既存のメールアカウントとは**別アカウント**になる（そのアドレス宛てのメールは中継されるので、ログイン自体はできる）。
- **Appleのトークン取り消し**：Appleは、Sign in with Appleで作ったアカウントの削除時にトークンをREST APIで取り消すことを求めている。今回はrefresh tokenを保存していないので取り消しはしていない。審査で指摘されたら、コード交換時に`refresh_token`を保存して`/auth/revoke`を呼ぶ処理を足す必要がある。
- **`REQUIRE_SESSION`は今回オンにしていない**。確認したところ、`release/tabilog-1.1.0`のapp.jsは`authHeaders()`で`authorization: Bearer <token>`を`api()`・`nativeApi()`・`postBinary()`のすべてに付けており（それ以外の`fetch`は写真の取得・外部の地図データなど、アカウント操作ではないもの）、iOSアプリ側はトークン必須に切り替えても送れる状態になっている。あとは1.1.0以降のアプリが行き渡ってから切り替えるかどうかの判断だけが残る（この機能が入るまでは、iOSアプリのユーザーは実質メールOTPでしか入れず、そのトークンは同じく送られていた）。

**見送ったこと**：

- **ブラウザ用のGoogle／Apple／LINE SDKを使い続ける**（クライアントで完結する簡易版。サーバーで本人確認できず、iOSのWebViewでは動かない）。
- **iOSにGoogle・LINEのネイティブSDKを組み込む**（Capacitorのプラグインとビルド手順の変更が要る。審査・保守の負担が大きい）。Safariで開いてポーリングする方式なら、プラグイン無しで3社とも同じ仕組みで動く。`@capacitor/browser`（アプリ内Safariシート）も、追加すればビルドの手順が変わるので使わなかった。
- **ユニバーサルリンクやカスタムURLスキームでアプリに自動で戻す**：ログイン完了ページのボタン（`https://tabinoashiato.pages.dev/`のユニバーサルリンク）とポーリングで足りる。ポーリングなので、ユーザーが自分でアプリに戻っても、ボタンで戻っても動く。
- **アカウントのキーをメールアドレスからアカウントIDに変える**（ratings・sessions・accountsなどメール前提のテーブルが多く、影響が大きい。identityの表を1枚足すだけで4つの方式を同じアカウントにまとめられる）。
- **同じ人が複数のメールを持つ場合の名寄せ・アカウント統合UI**：メールが違えば別アカウント（従来どおり）。
