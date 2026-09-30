# Apple・Google・LINEのログインを、Worker側で検証する「認可コードフロー」に作り替える

それまでのGoogle／Appleログインは、ブラウザ用のJavaScriptライブラリ（Google Identity Services・Sign in with Apple JS）が返したidトークンを**アプリ側で読み取るだけ**の簡易版だった（サーバーでは検証しない）。クライアントIDも空のまま（`index.html`のmetaタグ）だったので、実際にはボタンが出ていなかった。さらに、iOSアプリ（CapacitorのWKWebView）の中ではGoogleがOAuthログインをブロックするため、iOSアプリで実質使えるログインは**メール（OTP）だけ**だった。

オーナーの要望：「メール・Apple・Google・LINEの4つでログインできるようにしたい。WebでもiOSアプリでも」。あわせて、メールOTP以外も**サーバーで本人確認する**ことにした（クライアントが送ってきた「私はこのメールの人です」を信じない）。

**決めたこと**：

- **ブラウザ用のSDKは使わず、Worker（Cloudflare）が「認可コードフロー」を全部やる**。`GET /auth/<google|apple|line>/start`でstate・nonce（とPKCE）をD1に置いてプロバイダーへ302 → プロバイダーが`/auth/<provider>/callback`に認可コードを返す（Appleだけ`response_mode=form_post`なのでPOST）→ Workerがトークンエンドポイントでコードをidトークンに交換 → iss・aud・exp・nonceを確認 → 結果をアプリに渡す。アプリは開始URLを開くだけで、プロバイダー固有のコードを持たない。純粋な部分（URL組み立て・idトークンの確認・結びつけの判断・AppleのJWT署名）は`worker/src/oauth.js`に分け、`worker/test/oauth.test.mjs`で単体テストする。
- **アカウントは今までどおりメールアドレスがキー**のまま（メールキーのテーブル群は触らない）。新しい`auth_identities(provider, subject, email)`で「このプロバイダーのこの人は、このメールのアカウント」を結びつけるだけ。結びつけの判断（`decideIdentity`）：①既にidentityがあればそのメール、②なければ「プロバイダーが確認済みメールを返した」なら**そのメールのアカウントと同一人物として扱い**（同じメールの既存アカウントがあればそこに入り、無ければ新規作成）identityを作る、③メールが分からない（LINEでメール権限が無いなど）なら**メールOTPで一度だけ確認してもらい**、確認できたメールにidentityを結びつける（次回からはそのプロバイダーだけで入れる）。これはオーナーが選んだ方針。
- **セッショントークンをURLに載せない**。認可の結果は「使い捨てコード」（乱数・DBにはハッシュだけ・5分・1回だけ）で渡し、アプリが`POST /auth/exchange`でセッションに交換する（返す形はメールOTPの`/auth/email/verify`と同じ`{email, name, token}`、`issueSession`をそのまま使う）。Webは`<戻り先>#auth=<コード>`（メール確認が必要なときは`#auth_link=<コード>`、失敗・キャンセルは`#auth_error=…`）にリダイレクトし、アプリ側はハッシュを`history.replaceState`ですぐ消す。ハッシュはサーバーには送られず、Referer にも載らない。
- **iOSアプリはシステムのブラウザ（Safari）でログインし、カスタムURLスキーム`tabilog://auth?…`でアプリに結果を渡す**。Googleが埋め込みWebViewを拒否するため。アプリは`/auth/<provider>/start?return=app`をSafariで開くだけ（アプリ側で作るIDは無い）。ログインが終わると、Workerが（Webと同じ）使い捨てコードを作り、「旅の足跡アプリに戻る」ページを返す。このページは開いた瞬間に`tabilog://auth?code=<コード>`（メール確認が要るときは`?link=<コード>`、失敗は`?error=<理由>`）へ移動してアプリを起動し、起動しなかったときのために大きなボタン（同じURL）も出す。アプリは`@capacitor/app`の`appUrlOpen`／`getLaunchUrl`（共有リンクの受け取りに既にある）でこのURLを受け、Webの`#auth=`と同じ処理でコードをセッションに交換する。スキーム`tabilog`は共有リンク用（`tabilog://open?trip=…`）にInfo.plistへ登録済みで、ホスト部分（`auth`／`open`）で区別する。**新しいプラグインは追加していない**（Workerのホストは`capacitor.config.json`の`allowNavigation`に無いので、`window.open`でCapacitorが自動的にSafariへ渡す）が、アプリ側のJSが変わるのでiOSの再ビルドは要る。
  - **ポーリング方式は採用しなかった（最初の実装で使ったが、脆弱性のため廃止）**：アプリが作った`req`を開始URLに付け、Workerが結果を`req`の下に置いてアプリが`GET /auth/poll?req=…`で取りに行く方式だと、`req`は開始URLを作る人が自由に決められる。攻撃者が自分の`req`で開始URLを作って被害者に踏ませ、被害者がログインすると、攻撃者が`poll`を叩くだけで被害者の使い捨てコード（＝セッション）を受け取れてしまう。コードは「ログインを終えた端末のブラウザ」にだけ渡すべきなので、その端末が自分でアプリを起動するカスタムURLスキームを使う。（ユニバーサルリンクは、ページ内のスクリプトによる自動遷移ではアプリが起動しないことがあるため、確実に起動できるカスタムURLスキームを選んだ。）
- **Worker側の設定がある方式だけ、ログイン画面にボタンを出す**（`GET /auth/providers`）。ログイン画面の順番は「Apple・Google・LINE・メール」。App Store Review Guideline 4.8（他社ログインを提供するなら、Sign in with Appleも同格で用意する）は、Appleを必ず並べることで満たす。Appleが未設定のままGoogleやLINEだけ設定する、という状態にはしないこと（README参照）。
- **戻り先（`return`）は許可リスト（`ALLOWED_ORIGIN`）のOriginだけ**（`parseReturnTarget`）。開発用にhttp://localhostだけ通す。`https://x.pages.dev@evil.com`のようなuserinfoや前方一致のすり抜けは拒否する（テストあり）。`return`には`?trip=…`まで含めたページのURLを渡し、共有された旅行を開いたままログインから戻れるようにした。
- **idトークンの署名（JWKS）検証は省いた**。idトークンはプロバイダーのトークンエンドポイントから、こちらのclient_secret付きのTLS通信で**直接**受け取るもので、ブラウザ経由で渡ってきたものではない。OpenID Connectの仕様は、この場合に署名検証を省いてよいとしている。代わりにiss・aud・exp・nonceは必ず確かめる（`checkIdTokenClaims`）。JWKSの取得とキャッシュはfetchが1回増え、Workers無料枠（1リクエスト50回）と複雑さに見合わないと判断した。
- **Appleの`client_secret`は、`.p8`の秘密鍵からWebCryptoでES256のJWTを自分で署名して作る**（`buildAppleClientSecret`。有効期限5分・都度作成。テストで公開鍵による署名検証まで行っている）。npmパッケージは使わない。
- **設定値**：vars `GOOGLE_CLIENT_ID`・`APPLE_SERVICES_ID`・`APPLE_TEAM_ID`・`APPLE_KEY_ID`・`LINE_CHANNEL_ID`、secrets `GOOGLE_CLIENT_SECRET`・`APPLE_PRIVATE_KEY`・`LINE_CHANNEL_SECRET`。コールバックURLはWorker自身のOrigin（`https://tabilog-api.hiroya-apps.workers.dev/auth/<provider>/callback`）。`wrangler.jsonc`にはIDを書かず、オーナーが各コンソールで登録したあとに設定する。すべて無料。
- **新しいアカウントの名前はプロバイダーの表示名**。ただし既にアカウントに名前があれば上書きしない（`/auth/exchange`が既存の名前を優先して返す）。Appleは名前を初回のPOSTの`user`パラメータでしか渡さないので、初回に取れなければ空になり、その場合はメールアドレスが表示名の代わりになる（従来と同じ）。
- **アカウント削除（`/accounts/delete`）で`auth_identities`も消す**。削除→再登録の特典の抜け道を作らない考え方は従来と同じ（accounts行は残し、identityだけ消す）。
- **新しいテーブル**（migrations/0028）：`auth_identities`、`auth_states`（state・nonce・PKCEを10分だけ）、`auth_codes`（使い捨てコード）。期限切れの行は`/auth/<provider>/start`のたびにまとめて消す（専用の定期処理は作らない）。
- `/auth/<provider>/start`・`/callback`はブラウザのページ移動（Originがプロバイダー側になる。Appleのform_postでは`appleid.apple.com`）なので、既存のOrigin許可チェックの対象から外した。代わりにstate（使い捨て・10分・プロバイダー一致）とnonce・認可コードで守る。

**気をつけること（リスクとして受け入れたもの）**：

- **LINEのメールは「確認済み」として扱う**（idトークンに`email_verified`が無いため）。LINEは登録時にメールの確認を求めるが、Googleの`email_verified`のような明示的な保証ではない。メールが同じなら同一アカウントとする方針の上に成り立つので、LINEに他人のメールアドレスを登録した人がその人のアカウントに入れてしまう可能性はゼロではない。気になるなら、LINEだけ常にメールOTPを挟む形に変えられる（`extractProfile`の`verified`をfalseにするだけ）。
- **Appleの「メールを非公開」を選んだ人**は、`xxxx@privaterelay.appleid.com`という中継アドレスが返るので、既存のメールアカウントとは**別アカウント**になる（そのアドレス宛てのメールは中継されるので、ログイン自体はできる）。
- **Appleのトークン取り消し**：Appleは、Sign in with Appleで作ったアカウントの削除時にトークンをREST APIで取り消すことを求めている。今回はrefresh tokenを保存していないので取り消しはしていない。審査で指摘されたら、コード交換時に`refresh_token`を保存して`/auth/revoke`を呼ぶ処理を足す必要がある。
- **`REQUIRE_SESSION`は今回オンにしていない**。確認したところ、`release/tabilog-1.1.0`のapp.jsは`authHeaders()`で`authorization: Bearer <token>`を`api()`・`nativeApi()`・`postBinary()`のすべてに付けており（それ以外の`fetch`は写真の取得・外部の地図データなど、アカウント操作ではないもの）、iOSアプリ側はトークン必須に切り替えても送れる状態になっている。あとは1.1.0以降のアプリが行き渡ってから切り替えるかどうかの判断だけが残る（この機能が入るまでは、iOSアプリのユーザーは実質メールOTPでしか入れず、そのトークンは同じく送られていた）。

**見送ったこと**：

- **ブラウザ用のGoogle／Apple／LINE SDKを使い続ける**（クライアントで完結する簡易版。サーバーで本人確認できず、iOSのWebViewでは動かない）。
- **iOSにGoogle・LINEのネイティブSDKを組み込む**（Capacitorのプラグインとビルド手順の変更が要る。審査・保守の負担が大きい）。Safariで開いてカスタムURLスキームで戻す方式なら、プラグイン無しで3社とも同じ仕組みで動く。`@capacitor/browser`（アプリ内Safariシート）も、追加すればビルドの手順が変わるので使わなかった。
- **アカウントのキーをメールアドレスからアカウントIDに変える**（ratings・sessions・accountsなどメール前提のテーブルが多く、影響が大きい。identityの表を1枚足すだけで4つの方式を同じアカウントにまとめられる）。
- **同じ人が複数のメールを持つ場合の名寄せ・アカウント統合UI**：メールが違えば別アカウント（従来どおり）。

## 追記（2026-09-30）：アカウント削除時にSign in with Appleのトークンを取り消す

### 背景
App Storeのガイドライン5.1.1(v)とAppleの要件では、Sign in with Appleで作ったアカウントをアプリ内から削除するとき、
Appleのトークン取り消しAPI（`POST https://appleid.apple.com/auth/revoke`）でトークンを無効にすることが求められる。
これまでの削除処理（`deleteAccount`）は`auth_identities`を消すだけで、Apple側にはトークンが残ったままだった。

### 決めたこと
- Appleのコールバックでトークンエンドポイントが返す`refresh_token`を、`auth_identities.refresh_token`列に保存する
  （`migrations/0029_apple_refresh_token.sql`。`NOT NULL DEFAULT ''`）。**Appleのときだけ**保存し、Google・LINEは保存しない
  （取り消しの義務があるのはAppleだけで、持たなくてよいものは持たない）。
- ログインのたびに最新のrefresh_tokenで上書きする（Appleは古いものも有効なままだが、最新のものを取り消せば十分）。
- アカウント削除時、そのメールに結びついたAppleの行のうち`refresh_token`が空でないものについて、
  `client_id`（`APPLE_SERVICES_ID`）・`client_secret`（ログインと同じES256のJWT）・`token`・`token_type_hint=refresh_token`を
  フォーム形式で送る。`auth_identities`を消す**前**に行う。
- 取り消しに失敗しても（通信エラー・Appleのエラー）**アカウント削除は止めない**。`apple_revoke_failed`（`status`付き）をログに出して続ける。
  ユーザーが削除できなくなるほうが、規約上も体験上も悪いため。
- 1つのアイデンティティにつきAppleへの通信は1回。Workers無料プランのsubrequest上限（50回）に対して十分小さい。
- 純粋な部分（本文の組み立て・対象の選別・取り消しの繰り返し）は`oauth.js`に置き、`worker/test/oauth.test.mjs`でfetchを差し替えてテストする。

### refresh_tokenをD1にそのまま保存してよい理由
refresh_tokenだけでは使えない。Appleのトークンを更新・取り消しするには、**うちのApple秘密鍵（`APPLE_PRIVATE_KEY`）で署名した
client_secret**が必要で、その鍵はWorkerのsecretにしか無い。つまりD1のデータが漏れてもトークン単体では悪用できない。
暗号化して保存する手もあるが、暗号鍵をどこに置くかという同じ問題が残るため、複雑さに見合わないと判断した。

### 制限・注意
- **この対応より前にAppleでログインした人**は`refresh_token`が空のまま（後から取り出す方法が無い）。取り消せないのでスキップする。
  その人が再びAppleでログインすれば保存され、以後は取り消せる。
- メールの確認コードで結びつけたAppleの行（待ちコード経由）は、ログインの流れ上refresh_tokenを持たないので、この時点では取り消せない。
- **migration 0029より先にデプロイしても壊れない**：保存のUPDATEが「no such column」で失敗してもログインは続け、
  削除時の取得も失敗したら「取り消すものなし」として続ける。ただし列が無い間はトークンが保存されないので、
  先にmigrationを実行する（migration → deploy）。

### 反映手順
```sh
cd apps/day07-tabilog/worker
npx wrangler d1 execute tabilog-db --remote --command "ALTER TABLE auth_identities ADD COLUMN refresh_token TEXT NOT NULL DEFAULT '';"
npx wrangler deploy
```
