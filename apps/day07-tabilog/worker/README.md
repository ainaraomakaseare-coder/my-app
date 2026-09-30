# 旅の足跡 API Worker

旅行（trip）と、その中の「大項目（block：いつ・どこで・何をする時間か）」「小項目（entry：そのときの一人ひとりの記録）」をCloudflare D1に、写真の実体はCloudflare R2に保存するAPIです。基本的な保存・共有にはAIを呼び出さず、費用はAPI利用料ではなくD1・R2のストレージ・リクエスト量にかかります。**唯一「音声でまとめて記録する」機能だけ、OpenAIを呼び出します**（後述）。

## これがDAY7でやっていること

これまでのアプリ（NHKチンチロ・輸入ブラックジャック・ドラマ王・人狼・おもいでWiki）はすべて、保存先が**この端末のブラウザの中（localStorage）だけ**でした。旅の足跡は初めて、**データが自分の端末を離れてサーバー側に残る**構成にしています。これにより、

- 旅行のURLを家族に送るだけで、送られた側もその場で見たり書き足したりできる（JSONファイルのやり取りが不要）
- 端末やブラウザを変えても、同じURLを開けば同じ記録が見られる

という、これまでのアプリではできなかったことができます。かわりに、**サーバーの公開作業（wranglerでのデプロイ）と、費用への注意**が新たに必要になります。

## 閲覧・読み書きにアカウントは要らない（評価だけ例外）

旅行を作ると `trip_xxxxxxxx` という推測しづらいIDが発行され、**そのIDを含むURLを知っている人なら誰でもログイン不要で読み書きできます**（Googleドキュメントの「リンクを知っている全員が編集可」に近い方式）。家族・少人数グループでURLを送り合って使う前提の、簡易的な共有です。第三者に広く公開するような使い方には向きません。

**「評価（★1〜5）」と「マイログ」だけ、ログイン（Google/Apple）が必須です。** 評価は「誰が付けたか」を区別する必要があるための例外で、閲覧や記録の追加はログインの有無に関わらず今までどおりです。評価のrater_emailはクライアントが送ってきた値をサーバーは検証せずそのまま使います（このAPI全体と同じ、トークン検証をしない簡易的な仕組みです）。

## 公開手順

```sh
cd apps/day07-tabilog/worker
npx wrangler d1 create tabilog-db
# 出力された database_id を wrangler.jsonc の REPLACE_WITH_YOUR_DATABASE_ID に貼り付ける
npx wrangler d1 execute tabilog-db --remote --file=schema.sql
npx wrangler r2 bucket create tabilog-photos
npx wrangler deploy
```

公開できたら、公開されたURL（`https://tabilog-api.<あなたのサブドメイン>.workers.dev` の形）を `../index.html` の `tabilog-api-endpoint` メタタグの `content` に設定してください。空のままだと、旅の足跡はサーバーに保存できず「サーバーが未設定です」という案内だけが出ます（このアプリは保存そのものがサーバー前提のため、DAY05・DAY18のAI機能のような「未設定でも他の機能は使える」状態にはなりません）。

公開URLは `https://tabilog-api.hiroya-apps.workers.dev` です（2026-09-12 公開）。`../index.html` の `tabilog-api-endpoint` メタタグに設定済みです。R2の利用開始にあたり、Cloudflareダッシュボードでのサブスクリプション登録（支払い方法の登録。無料枠内なら請求額は0円）も完了しています。

### データの持ち方を変えたとき（スキーマ更新）

記録を「大項目（block）」「小項目（entry）」の2階層に変更した際、`schema.sql` の中身も変わりました（旧`episodes`テーブルを廃止し、`blocks`・`entries`を追加）。**一度公開したあとにこのファイルを直した場合は、以下の2つを両方やり直してください**（片方だけだと動きません）。

```sh
npx wrangler d1 execute tabilog-db --remote --file=schema.sql
npx wrangler deploy
```

（2026-09-12 追記）entriesに「詳細（detail）」「動画（video_ids）」を追加した際も、同じくentriesテーブルを作り直しています。**それまでに保存していた記録（小項目）は消えます**（旅行・予定は残ります）。試作段階のためこの方式にしています。

（2026-09-12 追記・評価機能）「評価（ratings）」テーブルを追加しました。こちらは新しいテーブルを追加するだけで、既存の`trips`・`blocks`・`entries`の中身は変わりません（`DROP TABLE`なし＝**今までの記録は消えません**）。上と同じ2つのコマンドを実行するだけで反映できます。

（2026-09-13 追記・日ごとの天気機能）「日ごとの場所・天気（day_infos）」テーブルを追加しました。こちらも新しいテーブルの追加のみで、既存データへの影響はありません。上と同じ2つのコマンドで反映できます。実機で動作確認済みです（Open-Meteoへの実際の通信も含めて動いています）。

（2026-09-13 追記・降水量による判定）day_infosに`precip_sum`（降水量）列を追加しました。**この列だけは`CREATE TABLE`ではなく`ALTER TABLE ADD COLUMN`で追加しているため、schema.sqlをもう一度実行するとこの1行だけ「列が既にあります」というエラーになります**（他の行はすべて再実行しても安全です）。既に反映済みなので、次にschema.sqlを実行する用事ができたときは、この`ALTER TABLE day_infos ADD COLUMN precip_sum REAL;`の行だけ削除してから実行してください（このREADMEにその旨のコメントも書いてあります）。

（2026-09-13 追記・メールログインOTP）メールでのログインを「その場で入力するだけ」から「実際にメールでコードを送って確認する」方式に変えたため、`email_otps`テーブルを追加しました。新しいテーブルの追加のみで、既存データへの影響はありません。上と同じ2つのコマンドで反映できます。**加えて、メール送信サービス（Resend）のAPIキーをシークレットとして登録しないと、メールログインが動きません**（未設定でもエラーにはならず、その旨のメッセージが表示されるだけです）。設定方法は `../README.md` の「③メールログイン（OTP）の設定」を参照してください。

（2026-09-13 追記・アカウント参加者）参加者（companions、テキストのみ）とは別に、ログイン中の本人が「参加する」を押すことでアカウントを旅行に紐付けられるようにしたため、`accounts`（アカウント、6桁のアカウントIDを発行）・`trip_members`（Trip×アカウントの紐付け）の2テーブルを追加しました。どちらも新しいテーブルの追加のみで、既存データへの影響はありません。上と同じ2つのコマンドで反映できます。

（2026-09-13 追記・音声でまとめて記録する機能）新しいテーブルは追加していません（既存のblocks・entriesにそのまま保存する）。ただし**この機能を使うには、OpenAIのAPIキーの登録と、AI呼び出し用のレート制限（`AI_RATE_LIMITER`）の追加設定が必要**です。設定方法は下の「音声でまとめて記録する機能の設定」を参照してください。

（2026-09-14 追記・音声入力の文字起こし保存）実機での動作確認で、使っているモデルが音声を直接聞く方式（audio input）に対応していないことが判明（`"Audio input is not available."`というエラー）。Whisperで先に文字起こしし、そのテキストを元に予定・記録へ分割する2段階の構成に変更した。あわせて、文字起こし自体をday_infosに保存するため`voice_transcript`列を追加した。**この列だけは`CREATE TABLE`ではなく`ALTER TABLE ADD COLUMN`で追加しているため、schema.sqlをもう一度実行するとこの1行だけ「列が既にあります」というエラーになります**（他の行はすべて再実行しても安全です）。反映済みになったら、`ALTER TABLE day_infos ADD COLUMN voice_transcript TEXT NOT NULL DEFAULT '';`の行だけ削除してから次回実行してください（`precip_sum`のときと同じ注意点です）。

### サンプルデータを消したいとき

開発・動作確認で作った旅行データ（サンプル）を全部消したい場合は、以下を実行してください。**元に戻せないので注意してください。**

```sh
npx wrangler d1 execute tabilog-db --remote --file=reset-sample-data.sql
```

`trips`・`blocks`・`entries`・`ratings`・`day_infos`のデータが全件削除されます（テーブルの定義自体は変わりません）。

### 音声でまとめて記録する機能の設定

「音声でまとめて記録する」ボタン（旅行詳細画面、日の予定一覧の下）を使うには、以下の設定が必要です。**未設定でもエラーにはならず、押すと「音声入力はまだ使えません」という案内が出るだけです**（他の機能には影響しません）。

1. `apps/day18-omoide-wiki/`ですでにOpenAIのAPIキーを使っている場合は、同じキーをそのまま使えます（新規に取得する必要はありません）。まだの場合は https://platform.openai.com/ でAPIキーを発行してください
2. `apps/day07-tabilog/worker/` で以下を実行し、Workerにシークレットとして登録する

```sh
npx wrangler secret put OPENAI_API_KEY
```

3. `wrangler.jsonc` に、AI呼び出し専用のレート制限（`AI_RATE_LIMITER`、1分間に10回まで）をすでに追加してあります。反映するには `npx wrangler deploy` を実行してください（初回のratelimits追加時のみ、Cloudflareダッシュボード側で有効化の確認が必要になる場合があります）
4. （任意）モデル名を変えたい場合は `OPENAI_MODEL` という名前でシークレットまたは環境変数を追加してください（設定しなければ既定のモデルを使います）

費用は「1回の音声入力＝1回のAI呼び出し」の従量課金です。話す長さ・内容量によって金額は変わるため、正確な金額は実際にOpenAIの利用状況ページで確認してください（見込みが立つまでは、ときどき使用量を確認することをおすすめします）。

## 費用について（無料枠に収める方針）

このアプリは「無料枠に収まる構成にしてほしい」という要望で作っています。2026年9月時点のCloudflare無料枠の目安は次のとおりです（変更される可能性があるので、実際の請求前に公式のPricingページも確認してください）。

| サービス | 無料枠の目安 | このアプリでの使われ方 |
|---|---|---|
| D1（データベース） | 5GB保存・1日あたり読み取り数百万行 | 旅行・予定・記録のテキストデータ（写真の実体は含まない） |
| R2（写真の保存） | 10GB保存・下り転送は無料 | 圧縮後の写真（1枚あたり最大2MB程度に制限） |
| Workers（API本体） | 1日10万リクエスト | 上記へのアクセス |

家族・少人数での利用であれば、この無料枠を超える可能性は低いと考えられます。**ただし利用者が大きく増えたり、写真を大量に載せたりすると無料枠を超えて費用が発生する可能性があります。** 費用が心配な場合は、Cloudflareダッシュボードで使用量を定期的に確認してください。

## 費用を抑える仕組み

- 写真はクライアント側（ブラウザ）で縮小・圧縮してからアップロードし、Worker側でも1枚2MBを超えるものは拒否する
- 書き込み系（POST・PATCH・DELETE）には接続元ごとに1分30回までのレート制限をかけている（無関係な大量アクセスでの浪費を防ぐ）
- 画像の配信には長期キャッシュ用のヘッダーを付け、同じ写真への再リクエストを減らす
- AI呼び出し（音声でまとめて記録する機能）には、さらに接続元ごとに1分10回までの別枠のレート制限（`AI_RATE_LIMITER`）をかけている（費用が発生する機能のため、書き込み全体より厳しめにしている）

## APIキーについて

保存・共有・評価・天気取得・メールログインといった基本機能は、外部のAI APIを呼ばずに動きます。**「音声でまとめて記録する」機能だけ**、`OPENAI_API_KEY`（OpenAIのAPIキー）をシークレットとして必要とします（設定方法は上の「音声でまとめて記録する機能の設定」を参照）。設定しなくても、他の機能には一切影響しません。

## 地図でふりかえる（2026-09-25 追加）

予定に「移動手段」（`blocks.transport`）を持たせ、`GET /geocode?q=<地名>`（地名→緯度経度。Nominatim→Open-Meteoの順に探し、結果はCache APIに30日キャッシュ）を追加した。どちらもAPIキー不要・無料。

**反映手順（順番厳守）**：列を追加する一度きりのマイグレーションを、**`wrangler deploy`より先に**実行する。逆順だと予定の作成・保存がSQLエラーで失敗する。

```
git pull
npx wrangler d1 execute tabilog-db --remote --command "ALTER TABLE blocks ADD COLUMN transport TEXT NOT NULL DEFAULT '';"
npx wrangler deploy
```

反映できたかは `npx wrangler d1 execute tabilog-db --remote --command "PRAGMA table_info(blocks);"` の結果に`transport`があるかで確認できる。

## セッション・いいね・コメント（2026-09-25 追加）

ログイン後の本人確認をセッショントークンにし（docs/adr/0005）、旅行・記録へのいいね・コメント・通報・ブロックを追加した（docs/adr/0006）。

**反映手順（順番厳守）**：新しいテーブル（`sessions`・`likes`・`comments`・`user_blocks`・`comment_reports`）を**`wrangler deploy`より先に**作る。逆順だと、ログイン（コードの確認）がSQLエラーで失敗する。テーブルを足すだけなので既存データには影響しない。

```
git pull
npx wrangler d1 execute tabilog-db --remote --file migrations/0016_sessions_social.sql
npx wrangler deploy
```

`migrations/0016_sessions_social.sql`は今回の5つのテーブルの`CREATE TABLE IF NOT EXISTS`だけを抜き出したもの（`schema.sql`の先頭には古い`DROP TABLE IF EXISTS episodes`が残っているので、本番では全体を実行しない）。何度実行しても既存データは変わらない。

**通報の通知先**：`npx wrangler secret put REPORT_NOTIFY_EMAIL`で運営者のメールアドレスを登録すると、コメントが通報されたときにResend経由でメールが届く（`RESEND_API_KEY`はログイン用に設定済みのものを使う）。`wrangler.jsonc`は公開リポジトリに入っているので、メールアドレスはそこに書かずsecretにする。

**トークン必須への切り替え**：1.1.0以降のiOSアプリが行き渡ったら、`vars`に`"REQUIRE_SESSION": "1"`を足して`wrangler deploy`する。以後、トークンを送らない古いアプリからのアカウント操作は拒否される。

## 紹介文のレビュー項目・移動の情報（2026-09-25 追加）

評価にレビュー項目（ratings.review）、記録に移動の情報（entries.travel）の列を足した（docs/adr/0007）。**wrangler deployより先に** migrations/0017_review_travel.sql を本番で1回だけ実行する（逆順だと評価・記録の保存がSQLエラーになる）。

```
npx wrangler d1 execute tabilog-db --remote --file migrations/0017_review_travel.sql
```

## 場所の候補検索（2026-09-25 追加）

記録フォームの「場所名で検索」は、以前はGoogleマップが一番上に出した場所しか選べなかった。`GET /places/search?q=`でNominatimから最大8件（重要度の高い順）を返し、プルダウンで選べるようにした。どれも小さな同名地区なら、Open-Meteoの市区町村を先に出す。選んだ候補は座標入りの地図URL（`?api=1&query=緯度,経度`）になるので、地図でふりかえるでもその場所へぴったり移動する。DBの変更は無い。

## 道のり（青い線）と、場所の準備の高速化（2026-09-25 追加）

`GET /route?profile=car|foot|bike&from=緯度,経度&to=緯度,経度` で、OpenStreetMapのルート検索（routing.openstreetmap.de、無料・APIキー不要）から道路に沿った道のりを返す（30日キャッシュ、1500km超は調べない）。`GET /geocode?quick=1` はNominatimを使わないと分からないものを `{ pending: true }` で返す。どちらもDBの変更は無い（docs/adr/0008）。

### 電車・新幹線・地下鉄の道のり（2026-09-27 追加）

`profile=rail`（電車・新幹線・地下鉄用）は、道路専用のOSRMではなく[BRouter](https://brouter.de/)の公開サーバー（`https://brouter.de/brouter?lonlats=経度,緯度|経度,緯度&profile=rail&alternativeidx=0&format=geojson`）を使う（`getRoute`内の`brouterToBody`）。アプリを識別できるUser-Agentを付け、12秒でタイムアウト（`AbortController`）。返す形（`{ found, path, distance }`）と30日キャッシュは他のprofileと同じ。座標の間引き（`downsamplePoints`）は`worker/src/geo-decode.js`に切り出してあり、`worker/test/geo-decode.test.mjs`で単体テストできる。

BRouterの公開サーバーへの問い合わせは1区間1回・結果はキャッシュのみ（他の旅行の先読みはしない）というフェアユースを守る。応答が失敗・タイムアウトした、線路の長さ（`properties["track-length"]`）が直線距離の3倍を超えた、または始点・終点がBRouterの返す座標から5km以上ずれた（駅が遠い＝候補違いの疑い）ときは`found:false`にして、クライアント側の直線（または優しい弧）に任せる。距離の上限（1500km超は調べない）は他のprofileと共通。詳しくはdocs/adr/0008の2026-09-27追記を参照。

## 時差（2026-09-25 追加）

`GET /timezone?lat=&lng=` で場所のタイムゾーン名（例：Europe/London）を返す（Open-Meteo、無料・APIキー不要、30日キャッシュ）。DBの変更は無い（docs/adr/0009）。

## 移動の予定の移動時間（2026-09-26 追加）

予定に移動時間（blocks.move_minutes、分）の列を足した。予定の種類が「移動」のときだけ、移動手段と一緒に入力する。**wrangler deployより先に** migrations/0018_block_move_minutes.sql を本番で1回だけ実行する（逆順だと予定の作成・保存がSQLエラーになる）。

```
npx wrangler d1 execute tabilog-db --remote --file migrations/0018_block_move_minutes.sql
```

## メモの取り込み（2026-09-26 追加）

AIを使わない取り込み（`POST /trips/:id/memo-blocks`）と、メモをAIで整理した回数の列（accounts.memo_uses_this_period）を足した。**wrangler deployより先に** migrations/0019_memo_uses.sql を本番で1回だけ実行する（逆順だとアカウントの確認・メモの整理がSQLエラーになる）。

```
npx wrangler d1 execute tabilog-db --remote --file migrations/0019_memo_uses.sql
```

## 日ごとの場所の自動入力（2026-09-26 追加）

`POST /trips/:id/days/:date/auto-place`（{lat, lng}）で、日ごとの場所が空いている日に、位置から町・都道府県・国と天気を入れる。DBの変更は無い（wrangler deployだけでよい）。

## 海外の施設名から場所を探す（2026-09-26 追加）

本番の地図リンク57件のうち18件で場所が分からなかった（「ドジャースタジアム」「リオデジャネイロ空港」などカタカナの施設名。OpenStreetMapは海外の施設を日本語名で探すのが苦手）。`GET /geocode` に `hint=<予定の見出し>`・`near=緯度,経度;緯度,経度`（同じ旅行の前後の場所）を足し、住所・店名だけのリンクは次の順で探す：①Nominatim（前後の場所の近くを優先）→②日本語版ウィキペディアで題名（転送元を含む）が合う記事の座標（記事に無ければウィキデータの位置）→③「町＋空港」は町のまわりでいちばん大きな空港→④空白で区切った一部。前後の場所から2000km（名前全体が題名と合ったときは5000km）以上離れた結果は使わない。リンクに名前が無いとき（Googleの内部番号だけ）は見出しで同じように探す。キャッシュの鍵は `v4`（hint・nearを含む）。DBの変更は無い。無料・APIキー不要。

`GET /places/search`（記録フォームの「場所名で検索」の候補）も、Nominatimの候補が3件未満のときはウィキペディアの記事の場所、「町＋空港」ならそのまわりでいちばん大きな空港を候補の先頭に足す（キャッシュの鍵は `v4`）。候補は番号・名前・住所・「選択」ボタンのカードで並べる。

## 場所の候補検索・レシート読み取りをGoogleに切り替え（2026-09-26 追加）

`GOOGLE_API_KEY`（Places API (New)とCloud Vision APIの2つだけに制限したキー）を設定すると、以下の2つの機能がGoogleを使うようになる。**無い・失敗した・0件だったときは今までどおりの仕組みに自動で戻る**ので、`wrangler deploy`だけで反映でき、DBの変更は無い（docs/adr/0011）。

```sh
npx wrangler secret put GOOGLE_API_KEY
```

- `GET /places/search`：Places API (New)のAutocompleteを先に試す。座標を返さないため、候補に`placeId`だけが入ることがある。クライアントは検索し直すたびに`session=`（`crypto.randomUUID()`）を付けて送る。Googleの結果はCache APIに置いていない（利用規約が長期間のキャッシュを推奨していないため）。
- `GET /places/details?id=<placeId>&session=<token>`（新規）：座標の無い候補を「選択」したときに呼ぶ。Place Details Essentials（`location, displayName, formattedAddress`のみ。Pro以上のフィールドは足していない）を聞き、`{found, name, address, lat, lng}`を返す。`id`は`^[A-Za-z0-9_-]{10,300}$`で検証する。
- `POST /receipts/scan`：Cloud Vision（`DOCUMENT_TEXT_DETECTION`）でレシートの文字を読み取り、`src/receipt-parse.js`の`parseReceiptText`（ルールベース。`node worker/test/receipt-parse.test.mjs`で単体テストできる）で品目に分ける。**音声入力・テキストメモと共有する利用回数の枠（`checkVoiceQuota`）は消費しない**（無料プランでも使える）。失敗したときだけ今までどおりOpenAIに回す（2026-09-27〜、そのときも枠は消費しない。レシート読み取りは無料）。ログイン必須・`AI_RATE_LIMITER`はどちらの経路でも変えていない。

無料枠・費用の目安は docs/adr/0011 に記載。オーナーがGCP側のクォータで1日の上限（Autocomplete/Place Details/Visionそれぞれ）と予算アラートを設定済み。

## OpenAI→Cloudflare Workers AIの切り替えを比べる試作（2026-09-26 追加）

音声の文字起こし・メモの整理で使っているOpenAIを、同じCloudflare上で使えるWorkers AIに切り替えられないか比べるための、**管理者だけが使えるエンドポイント**を追加した（docs/adr/0012）。本番の処理（音声入力・メモの整理・レシート読み取り）は一切変更していない。

**設定（このエンドポイントを使うにはトークンの登録が必須。未設定だと`/ai-compare`は常に404で、存在しないのと同じに見える）**：

```sh
npx wrangler secret put AI_COMPARE_TOKEN
npx wrangler deploy
```

`wrangler.jsonc`に`"ai": { "binding": "AI" }`を追加済み（Workers AIバインディング自体は追加しただけでは費用が発生しない）。

**比較スクリプトの使い方**（`worker/scripts/ai-compare.mjs`。秘密情報はスクリプトに書かず環境変数から渡す）：

```sh
# メモの整理を比べる（textFilePathはUTF-8のテキストファイル）
COMPARE_URL=https://tabilog-api.hiroya-apps.workers.dev/ai-compare \
COMPARE_TOKEN=（wrangler secret putで設定した値）\
node scripts/ai-compare.mjs memo ./sample-memo.txt

# 音声の文字起こしを比べる（webm/mp4/mp3/wav/oggのいずれか）
COMPARE_URL=https://tabilog-api.hiroya-apps.workers.dev/ai-compare \
COMPARE_TOKEN=（wrangler secret putで設定した値）\
node scripts/ai-compare.mjs voice ./sample-voice.webm
```

比較対象のモデルはWorkers AIの`@cf/openai/whisper-large-v3-turbo`（音声認識）・`@cf/qwen/qwen3-30b-a3b-fp8`・`@cf/openai/gpt-oss-120b`（メモの整理）。無料枠・単価の目安はdocs/adr/0012に記載。何も保存せず、利用者の音声・テキストの内容はログにも出さない。ローカルの`wrangler dev --local`ではCloudflareへのログインが無いとWorkers AIの呼び出し自体が失敗することがあるが、その場合`workersAi`側がエラーになるだけで、`/ai-compare`自体が404にならないことは確認できる。

## 音声の文字起こしをCloudflare Workers AIに切り替え（2026-09-28 追加）

上記の比較試作（docs/adr/0012）を経て、本番の音声文字起こしをOpenAI（Whisper）からCloudflare Workers AI（`@cf/openai/whisper-large-v3-turbo`）に切り替えた。予定・記録への整理（`organizeTextIntoBlocks`）は精度優先で引き続きOpenAIのまま。

- `transcribeAudioForProduction`（`worker/src/index.js`）が新しい呼び出し口。まずWorkers AIを試し、例外が出た・結果が空文字だったときだけ今までどおりOpenAIにフォールバックする。呼び出し元（`createBlocksFromVoice`／`createBlocksFromVoiceMultiDay`）はこの関数を呼ぶだけで、フォールバックの有無を意識しない
- フォールバック要否の判定（`isUsableTranscript`）は純粋関数として`worker/src/transcribe-provider.js`に切り出し、`node worker/test/transcribe-provider.test.mjs`で単体テストできる
- 文字起こしがほぼ無料になったため、無料プランの音声入力の月間上限（`PLAN_MONTHLY_LIMIT.free`）を月2回→月10回に引き上げた（basicも10回→20回、premium_plusは50回のまま。詳細はdocs/adr/0004・0012の2026-09-28追記）
- `/ai-compare`（`mode=voice`）はそのまま残しており、モデル変更時などの比較に引き続き使える

（2026-09-26 追記・地図のURLのS2セルID対応）テーブルの変更は無し。GoogleマップのURLの中には、
「共有」からの短縮リンクを展開すると店名も座標も入らず`data=!4m2!3m1!1s0x…:0x…`や`ftid=0x…:0x…`だけが
残るものがある（例：ユニオンステーション、ステーキの夕食）。コロンの前の16進数がその場所のS2セルIDに
なっていることが多いと分かったため、`worker/src/geo-decode.js`に`s2ToLatLng`（S2セルID→緯度経度）・
`extractFeatureS2`（URLからそのIDを取り出す）を追加し、`parseMapUrl`で座標が直接読めないときの手がかりとして
使うようにした（単体テスト：`node worker/test/geo-decode.test.mjs`）。これに伴い`/geocode`のキャッシュの鍵を
v4→v5に、クライアント（`app.js`）のlocalStorageのキャッシュキーもv3→v4に上げてあり、以前「見つからない」と
覚えた結果は自動的に調べ直される。

（2026-09-26 追記・同じ名前の場所の取り違えを修正）テーブルの変更は無し。国内旅行なのに「日ごとの場所」に
時差が入る不具合と、記録の地図の場所が別の同名の場所に化ける不具合の2つを直した。

- **日ごとの場所（天気取得。`PUT /trips/:id/days/:date`）**：「ユニバーサル」のような略した施設名を、
  これまでOpen-Meteoの地名データ（自治体・行政区分中心。POI・施設は持たない）だけで探していたため、
  日本のユニバーサル・スタジオ・ジャパンが無く、同じ名前の海外の地名（ユニバーサル・オーランド・リゾート、
  アメリカ）に化け、国内旅行なのに時差が入ってしまうことがあった（2026-09-26、大阪旅行で発生。実際に
  `lat=28.4744, lon=-81.4683`＝フロリダ州オーランドになっていた）。「地図でふりかえる」と同じくNominatim
  （施設名にも強い）を先に試すようにし、旅行のほかの日にすでに分かっている場所（`day_infos`テーブルの
  同じ`trip_id`の行）を手掛かり（near）にして、Nominatim・Open-Meteoを合わせた候補の中からいちばん近い
  ものを選ぶようにした。手掛かりが無い（旅行の最初の日など）ときも、Nominatimを先に試すようにしただけで
  今回の実例（「ユニバーサル」）は直っている。
- **記録の地図（`GET /geocode`・`geocodePlaceName`・`wikipediaPlace`）**：「赤レンガ倉庫」のような、複数の
  都市にある同名の場所で、Nominatimの重要度（importance）が同じくらい・あるいは正しい方の候補が低いだけ
  （横浜赤レンガ倉庫の実データは信号機・バス停などの点にしか無く、重要度がほぼ0）だと、無関係な方
  （敦賀市の「赤レンガ倉庫」）が選ばれてしまうことがあった（実例：`みなとみらい発`の記録の地図URLが
  `35.6619607,136.0745531`＝福井県敦賀市になっていた）。near（同じ旅行の前後の場所）があるときは、
  重要度に関わらずnearにいちばん近い候補を信用するようにした（`pickNominatimCandidate`）。ウィキペディアの
  記事（`wikipediaPlace`）も、題名の合い方が同じ順位の候補どうし（部分一致がふたつなど）はnearにいちばん
  近いものを選ぶ（`pickWikiHit`）。ただし題名がそのまま合った候補（完全一致）は距離を見ずに常に優先する。
- 距離で選ぶ純粋な部分（`distanceKm`・`nearestCandidate`・`pickNominatimCandidate`・`pickWikiHit`・
  `pickGeoNamesCandidate`・`placeNameRank`）は`worker/src/geo-decode.js`に切り出し、nodeで単体テストできる
  ようにした（`node worker/test/geo-decode.test.mjs`）。
- 選び方を変えたので、`/geocode`のキャッシュの鍵をv5→v6に、クライアントのlocalStorageのキャッシュキーも
  v4→v5に上げてあり、以前の結果（取り違えていたものを含む）は自動的に調べ直される。DBのスキーマ変更は無い。

## 地図でふりかえるの準備を速くする：座標のD1保存＋Google Text Search（2026-09-26 追加）

「地図でふりかえる」を開くたびに、記録の地図URLを毎回Nominatim・ウィキペディア等でre-geocodeしていた
（Cache APIは無料だがcoloごとに別で、キャッシュの鍵も探し方を変えるたびに上げ直していたため、実質
毎回に近かった）のを、1回だけで済むようにした（docs/adr/0011）。**wrangler deployより先に**本番環境で
1回だけ実行すること（逆順だと記録の保存がSQLエラーになる）。

```sh
npx wrangler d1 execute tabilog-db --remote --file migrations/0020_entry_map_coords.sql
```

- `entries`に`map_lat`・`map_lng`・`map_geocoded_url`（その座標がどの`map_url`に対するものか）・
  `map_geocoded_at`を追加した（`migrations/0020_entry_map_coords.sql`）。トリップ・記録のAPIは、
  `map_geocoded_url`が今の`map_url`と一致するときだけ`mapLat`/`mapLng`を返す（地図のリンクを編集したら
  一致しなくなり、古い座標を返さず調べ直させる）。
- 記録の保存（`createEntry`/`updateEntry`）は、地図URLが新規に付いた・変わった・まだ座標を求めていない
  ときだけ、`ctx.waitUntil`で座標を裏計算してD1に書く（保存の返事は待たせない。`backgroundGeocodeEntry`）。
  この判定は純粋関数`entryNeedsGeocode`（`worker/src/geo-decode.js`）に切り出し、
  `worker/test/geo-decode.test.mjs`で単体テストできる。
- 既存データ（作成済みの記録）の座標も後追いで埋まるよう、`GET /geocode`に`entry=<entryId>`を付けて呼ぶと、
  座標が求まったとき、そのentryの`map_url`が今回のクエリ（`q`）と一致するときだけD1に保存する。`entry`は
  `ent_`+32桁16進の形式でなければ無視する（`isValidEntryId`。他人の行を書き換えられないよう、形式検証＋
  `map_url`一致の両方を見る）。クライアント（`app.js`の`geocodeQueries`・`loadTripZones`）は、記録に
  `mapLat`/`mapLng`があればそれを直接使って`/geocode`を呼ばず、無ければ`&entry=`を付けて呼ぶ。端末の
  localStorageキャッシュは、サーバー保存済み座標の次の層として残している。
- `GOOGLE_API_KEY`があるときは、座標もS2セルIDも無い、名前・住所だけの地図リンクをNominatimより先に
  Google Places API (New)のText Search Essentials（`POST /v1/places:searchText`、
  `X-Goog-FieldMask: places.id`のみ＝IDだけを返す無料・無制限のSKU）→候補の先頭1件だけPlace Details
  Essentials（`X-Goog-FieldMask: location`のみ）で探す（`googleTextSearchPlace`）。キーが無い・失敗・0件
  のときはこれまでどおりNominatim等のチェーンに回る（`geocodePlaceName`の先頭に追加）。Googleの結果は
  Cache APIに置かず、D1（entryの行）に保存する。
  **2026-09-27訂正**：以前はここで近くの場所（`nears`）を`locationBias`として送り、結果を`nearOk`
  ガードにも通していたが、誤動作が見つかったため外した（下の追記を参照）。

## Google Text Searchに近くの場所のヒントを渡すのをやめる・古い座標を自動でやり直す（2026-09-27 追加）

実例（大阪旅行）：「みなとみらい発」ブロック（横浜、その日は新幹線で大阪へ移動する行程）の地図URL
`https://www.google.com/maps/search/?api=1&query=赤レンガ倉庫`が、本番のDBに大阪の同名施設の座標
（34.6517, 135.4366）として保存されていた。原因は`googleTextSearchPlace`が近くの場所（`nears`。
この日は大阪のホテル）を`locationBias`としてGoogleに送っていたため、Text Searchが「近くにある」
大阪の赤レンガ倉庫を1位にしてしまい、`nearOk`ガード（近いので通ってしまう）もそれを弾けなかったこと。

- `googleTextSearchPlace`から`locationBias`を送るのをやめた（`nears`引数自体を廃止）。Googleの既定の
  ランキング（知名度・関連度）は、有名なほう（横浜の赤レンガ倉庫）を正しく1位にするため、素直に
  Top1件を信用する。
- `geocodePlaceName`のGoogle Text Searchの結果には`nearOk`（近くの予定との距離ガード）を適用しない。
  near guard・タイブレークは、Nominatim・ウィキペディアの予備チェーンにだけ残す。
- 既存の誤った座標を自動的にやり直すため、`geo-decode.js`に`MAP_COORDS_VALID_SINCE =
  "2026-09-27T00:00:00Z"`を追加した。`entryNeedsGeocode`に第4引数`geocodedAt`を足し、それが
  `MAP_COORDS_VALID_SINCE`より前（またはまだ無い）なら、地図URLが変わっていなくても再取得が必要と
  判定する。`rowToEntry`も同じ基準で、`map_geocoded_at >= MAP_COORDS_VALID_SINCE`のときだけ
  `mapLat`/`mapLng`を返す（それより前のものは「まだ座標が無い」扱いにし、次の保存・再取得で
  上書きされるまで古い座標をクライアントに渡さない）。単体テスト：`worker/test/geo-decode.test.mjs`。
- `/geocode`のCache APIの鍵をv7→v8に、クライアントのlocalStorageのキャッシュキーも`-v7`→`-v8`に
  上げた（以前nearに引っ張られていたかもしれない結果を捨てて調べ直す）。DBのスキーマ変更は無い。
- 詳しくはdocs/adr/0011（本編）・docs/adr/0008（実例の記録）を参照。

## 見出し（hint）からの当てずっぽうをやめた（2026-09-26 追加）

地図のリンクに座標も店名も入らない（Googleの内部番号だけの共有リンク、`query=undefined,undefined`の
ように壊れて保存されたリンクなど）とき、これまでは予定の見出し（`hint`。例：「ユニバーサル」）を手がかりに
場所を推測していた（`geocodeMapUrl`）。しかしこれは「リンクの中身」ではなく「見出しの文字列だけからの
当てずっぽう」で、ありふれた見出しだと無関係な場所に化けることがあったため、ユーザーの方針で
やめた（docs/adr/0008）。

- `geocodeMapUrl`から、`hint`を使った`geocodePlaceName`呼び出しを削除した。リンクの中の文字列（店名・
  住所）からの検索（Google Text Search・Nominatim・ウィキペディア）はこれまでどおり使う。
- `GET /geocode`の`hint=`パラメータ自体は、古いクライアントが送ってきても壊れないよう受け取るが、
  もう使わない（`geocodeForReplay`）。`backgroundGeocodeEntry`・`createEntry`/`updateEntry`も
  予定の見出し（block.label）を渡さなくなった。
- リンクから場所が分からない予定は「場所の分からない出来事」のまま扱い、地図でふりかえるの乗り物は
  直前の地点にとどまる（`Core.buildReplayTimeline`は元から`located: false`をそのまま扱えるので変更なし）。
- 結果が変わりうるので、`/geocode`のCache APIの鍵をv6→v7に、クライアントのlocalStorageのキャッシュ
  キーもv6→v7に上げた。
- クライアント側（`app.js`の`replayPlaceEntry`）で、`query=undefined,undefined`のように壊れた地図
  リンクは地図が無いのと同じに扱うようにし（そのブロックには`/geocode`自体を呼ばない）、`replayPlaceQuery`
  にテストを足した（`test/data.test.js`）。DBのスキーマ変更は無い。

## 日程を変えたら予定もいっしょにずらす（2026-09-26 追加）

旅行の開始日を変えても、予定（blocks）の日付は元のままで、日程の外に取り残されていた（ロサンゼルス旅で
7/3開始→6/26開始に変えたとき）。`PATCH /trips/:id`に`shiftDays`（整数、±3660日まで）を付けると、
旅行の更新と同じbatchで、その旅行の予定と日ごとの情報（day_infos）の日付をまとめてずらす（`shiftTripDateStatements`）。
DBのスキーマ変更は無い（migrationは不要）。

- 何日ずらすかはクライアントの`Core.tripScheduleShift`が決め、`confirm`で本人に確かめてから送る。
  開始日を変えたときは同じ日数だけ、開始日は同じでも予定が日程の外にはみ出しているときは最初の予定を1日目にそろえる。
- day_infosは`UNIQUE(trip_id, date)`・`id = trip_id + "_" + date`なので、いったん日付に`#`を付けて退避してから入れ直す。
- 自動で取った天気は元の日付のものなので消し、`ctx.waitUntil`で新しい日付の天気を取り直す（`refetchShiftedWeather`）。
  手で直した天気・場所・音声の文字起こしは、その旅の「○日目」の記録としてそのまま移す。
- 古いWorkerは`shiftDays`を無視する。そのときは返事に`shiftedDays`が無いので、アプリは「予定はずらせませんでした」と出す。

## 日ごとの天気を本人が選ぶだけにし、場所の入力欄をなくす（2026-09-26 追加）

「場所（市区町村名など）を入力→Open-Meteoで自動取得」だった天気を、天気アイコン（☀️晴れ／🌤️晴れ時々くもり／☁️くもり／🌧️雨／⛈️雷雨／❄️雪／なし）を選ぶだけの操作に変えた。「ユニバーサル」がオーランドの天気になる、といった「どの粒度で地名を入れればいいか分からない」問題を、入力欄自体を無くすことで解消した（docs/adr/0013）。

- **DBの変更は無い**。既存の`day_infos.weather_code`・`weather_manual`列をそのまま使う。`MANUAL_WEATHER_CODES`を旧来の10種（快晴／晴れ／曇り／霧／霧雨／雨／雪／にわか雨／にわか雪／雷雨）から、アプリの6アイコンに対応する`[1, 2, 3, 61, 71, 95]`に絞った。気温（temp_max/temp_min）はもう手動入力では受け付けない（送られてきても無視してNULLにする）。
- `PATCH /trips/:id/days/:date/weather`：`weatherCode`に上の6種以外の整数を渡すと`400`。**`weatherCode: null`を渡すと「なし」＝選択解除**（`weather_code=NULL, weather_manual=0`に戻す）。呼び出し時に`day_infos`行が無ければ（まだ地図つきの記録が無い日）、場所は空のまま新しく行を作る。
- `autoSetDayPlace`（`POST /trips/:id/days/:date/auto-place`）・`refetchShiftedWeather`（日程を変えたときの天気の取り直し）は、**もうOpen-Meteoの天気取得を呼ばない**。天気を表示に使わなくなったので、裏で取りに行く意味が無くなったため。`fetchDailyWeather`関数自体と、旧`PUT /trips/:id/days/:date`（`setDayPlace`、場所を手入力する昔のエンドポイント）は消さずに残してある（古いクライアント互換・他機能からの参照のため）。

## 電車・新幹線・地下鉄も線路に沿った道のりで見せる：BRouterのrailプロファイル（2026-09-27 追加）

これまで電車・新幹線は「線路のルートを出せる無料サービスが無い」という理由で、地図でふりかえるでは直線
のままだった。[BRouter](https://brouter.de/)の公開サーバーがrailプロファイル（線路優先のルーティング）を
提供していることを確認した（新横浜(139.6173,35.5075)→新大阪(135.5003,34.7334)で200・約3.5秒・4950点・
`track-length` 489772mを確認済み）ため、`GET /route`に`profile=rail`を追加した（他のプロファイルは
docs/adr/0008参照）。

- `getRoute`は`profile=rail`のときOSRM（道路専用）ではなく
  `https://brouter.de/brouter?lonlats=<経度>,<緯度>|<経度>,<緯度>&profile=rail&alternativeidx=0&format=geojson`
  を呼ぶ（`brouterToBody`）。10秒でタイムアウト（`AbortController`）、アプリを識別できるUser-Agentを
  付け、結果は既存と同じCache API・30日キャッシュ、同じ`{found, path, distance}`の形で返す。点の間引き
  （最大約400点、最後の点は必ず残す）はOSRM用のロジックと共通化し、`downsamplePoints`として
  `geo-decode.js`に切り出した（純粋関数、`worker/test/geo-decode.test.mjs`で単体テスト）。
- ガード：始点・終点がBRouterの返す座標から5km以上離れている（駅が遠い＝候補違いの疑い）、または
  線路の長さ（`properties["track-length"]`。無ければ座標列から自前で積算）が直線距離の3倍を超えている
  （駅すら無い場所に無理にスナップした疑い）ときは`found:false`にする。距離の上限（1500km）は他の
  プロファイルと共通。
- BRouterは無料の公開サービスで、フェアユースを守るため1区間1回だけ問い合わせ、結果は上記のとおり
  Cache APIに30日置く。他の旅行の先読み（prefetch）はしない。
- クライアント（`app.js`）：`Core.routeProfileFor`が`train`・`shinkansen`・`subway`を`'rail'`に対応させ、
  `fetchReplayRoutes`の「車で大回りしすぎたら徒歩で調べ直す」ロジックは`profile === 'car'`のときだけに
  絞った（`rail`はWorker側の線路長ガードで代わりに担保する）。DBのスキーマ変更は無い（docs/adr/0008）。

## 精算の端数（丸め）単位を選べるようにする（2026-09-27 追加）

Walicaのように、精算画面で丸め単位を1円／10円／100円から選べるようにした。旅行メンバー全員で共有する
設定なので、`trips.settle_unit`（`migrations/0021_trip_settle_unit.sql`）として旅行本体に持たせる
（既存の旅行はDEFAULT 1のまま変わらない）。**wrangler deployより先に**本番環境で1回だけ実行すること
（逆順だと旅行の更新がSQLエラーになる）。

```
npx wrangler d1 execute tabilog-db --remote --file migrations/0021_trip_settle_unit.sql
```

- `validTripInput`：`settleUnit`を渡す場合は`[1, 10, 100]`のいずれかのみ許可（それ以外は`400`）。
- `GET /trips/:id`・`PATCH /trips/:id`のレスポンスに`settleUnit`を追加（未設定・旧データは`1`）。
- 既存の`PATCH /trips/:id`（旅行の編集）で、他のフィールドと同様に`settleUnit`だけを送っても更新できる
  （編集できる人＝旅行のリンクを知っている人なら誰でも変更できる。従来の権限と同じ）。
- 精算方法そのもの（`Core.settlementPlan(balance, unit)`）は、貸し借りのマッチング自体は端数のない
  実残高のまま行い、**最後に送金額だけをunit単位に丸める**（Walicaの実際の送金額と突き合わせて確認済み。
  詳しくは`CONTEXT.md`の「割り勘」節を参照）。マッチング前に丸めてしまうと、各人の丸め誤差が積み上がり、
  受け取る人の合計が実際の残高と数円ずれるだけでなく、送金の組み合わせによっては送金漏れが起きていた。

## 費用の明細に外貨を入れられるようにする（2026-09-27 追加）

海外旅行で現地通貨のまま費用を入れられるようにした（`docs/adr/0014-multi-currency.md`）。costItemに
`currency`（ISO 4217、例："USD"）・`rate`（1`currency`あたりの円）を追加できる（どちらも任意。省略時は
これまでどおり円）。**精算はすべて円で行う**（`Core.costItemJpy`で円換算してから合計・貸し借りを計算する。
`CONTEXT.md`の「費用の明細の通貨・レート」節を参照）。DBのスキーマ変更は無い（`cost_items`列は元々
JSON文字列なので、新しいフィールドを持つcostItemもそのまま保存できる。マイグレーション不要）。

- `validCostItems`：`currency`を渡す場合は`/^[A-Z]{3}$/`（ISO 4217の3文字コード）、`amount`は0以上
  1,000,000以下で小数第2位まで（円の費用行はこれまでどおり整数のみ）、`rate`は`0 < rate < 1,000,000`
  を必須にした。`currency`を渡さない（省略）costItemは、これまでどおり`amount`が整数円のみ（後方互換）。
- `GET /rates?date=YYYY-MM-DD&currency=XXX` → `{ currency, date, rate, source }`。ログイン不要（他の
  読み取り系エンドポイントと同じ）。レートは2段構えで取得する：
  1. **Frankfurter**（ECB基準レート、`https://api.frankfurter.dev/`、APIキー不要）。約30通貨・過去日にも
     対応。週末・休場日を指定すると直前の営業日のレートが返る（レスポンスの`date`で分かる。`source: "ecb"`）。
  2. Frankfurterが対応していない通貨（ARSなど）は、フォールバックとして**fawazahmed0/currency-api**
     （jsDelivr配信、`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api`）を使う。日付ごとのバージョン
     （`@YYYY.M.D`、先頭ゼロなし。2024-03-02以降のみ存在）でまず試し（`source: "currency-api"`）、
     無ければ`@latest`を使う（`source: "currency-api-latest"`。この場合だけアプリ側で
     「この日のレートが無いため最新のレートです。明細に合わせて直してください」と警告を出す）。
  - `currency === "JPY"`は`rate: 1`を即返す（換算不要）。
  - 結果は`caches.default`に日付・通貨ごとにキャッシュする（過去日は30日、今日の日付はまだ更新され得る
    ので6時間）。外部APIへのfetchは8秒でタイムアウトする。ソースの組み立て・レスポンスの解釈・
    キャッシュキー計算は純粋関数として`src/rates.js`に切り出し、nodeで単体テストできる
    （`node worker/test/rates.test.mjs`）。
- レートは、フォームで本人が編集できる（カード会社の実際の決済レートに合わせられるように）。

## マイログ「訪れた都道府県・国」を旅行ごとに外す・戻す（2026-09-28 追加）

TestFlightのフィードバックで、「アメリカ」をブラジル・アルゼンチン旅行のマイログから外すつもりで
「マイログから外す」を押したら、別の旅行（ワールドカップ・大谷観戦旅）のアメリカも一緒に消えてしまい、
戻す方法も無いという指摘があった。原因は`mylog_place_overrides`（v23）がアカウント単位（旅行をまたいだ
グローバル）にhide/showを持っていたこと。旅行単位の表に作り直した。

```
npx wrangler d1 execute tabilog-db --remote --command "CREATE TABLE IF NOT EXISTS mylog_trip_place_overrides (account_id TEXT NOT NULL, trip_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (account_id, trip_id, kind, name))"
```

（`--file migrations/0024_...sql`でのインポートは認証エラーになったため、`--command`形式を使った。
同じSQLは`migrations/0024_mylog_trip_place_overrides.sql`にも置いてある。）

- `mylog_trip_place_overrides(account_id, trip_id, kind, name, created_at)`：ある旅行から、ある場所を
  「外した」という記録だけを持つ（v23と違い`mode`は無い＝外すことしかできない。戻すのは行を消すだけ）。
- `worker/src/visited-places.js`の`aggregateVisitedPlaces`は、`overrides`（v23・グローバル）ではなく
  `tripOverrides: [{ tripId, kind, name }]`を受け取るようになった。ある場所は「出てくる全部の旅行で
  外されている」ときだけ総計（`prefectures`/`countries`）から落ちる。旅行ごとの一覧を
  `tripPlaces: [{ tripId, tripTitle, prefectures: [{name, excluded}], countries: [{name, excluded}] }]`
  として新しく返す（乗り継ぎだけの場所は含めない）。
- **v23の`mylog_place_overrides`テーブル・`POST /mylog/places`エンドポイントは削除していない**（古い
  アプリがまだ呼ぶ可能性があるため）。ただし`getVisitedPlaces`はこのテーブルをもう読まない＝
  書き込みはエラーにならず成功するが、マイログの集計には一切反映されない（旧版で「外した」つもりの
  場所は再び表示される。docs/adr/0016）。
- 新しいエンドポイント`POST /mylog/trip-places`（`{ email, tripId, kind, name, mode: 'exclude'|'include' }`）
  で旅行ごとに外す・戻す。認証は既存のマイログ系エンドポイントと同じ`resolveEmail`。アカウントがそのマイログの
  持ち主であること、指定した`tripId`がそのアカウントの参加旅行（`trip_members`）であることを確認する。
- UI（`app.js`）：マイログ画面の「訪れた都道府県・国」は総計のまま残しつつ、その上に旅行ごとの一覧
  （`renderMyLogTripPlaces`）を追加した。旅行ごとのチップに「外す」ボタンがあり、外すとチップは
  灰色になり「戻す」ボタンに変わる（消えない＝いつでも戻せる）。総計側からグローバルな
  「マイログから外す」ボタンは削除した。
- `node worker/test/visited-places.test.mjs`に、片方の旅行だけ外しても総計に残ること・両方の旅行で
  外すと総計から落ちること・戻す（overrideを外す）と元の結果に一致することのテストを追加した。
  一度取得・入力した`rate`はアプリ側で覚えておき、通貨を変えない限り取り直さない。

## マイログの「訪れた都道府県・国」：day_infosより記録の地図の座標を優先する（2026-09-28 追加）

オーナー報告：大阪旅行（USJ・新大阪・甲子園・赤レンガ倉庫などを回った旅行）のマイログに「大阪府」が
出ない。原因は、集計が`day_infos`（1日1か所しか持てない、手入力・旧自動配置の場所）だけを見ていたこと。
2026-09-19の`day_infos`行が、過去の誤った自動配置でフロリダ（ユニバーサル・オーランド）の座標を
持ったままになっており、その日はUSJに行っていたにもかかわらず「アメリカ」として（誤って）扱われ、
実際に訪れた大阪府は`day_infos`のどの行にも記録されていなかった。

- 情報源を入れ替えた。**主＝記録の地図の座標**（`entries.map_lat`/`map_lng`、
  `MAP_COORDS_VALID_SINCE`＝2026-09-27以降に求めたものだけ。geo-decode.js参照）を
  `reverseGeocode`（既存、Nominatim）で都道府県・国に変換したもの（`mapVisits`と呼んでいる）。
  1日に複数の記録があれば、複数の都道府県・国を正しく持てる（大阪の日に兵庫にも寄っていれば両方出る）。
  **従＝`day_infos`**（1日1か所）は、mapVisitsが無い日の補完としてだけ使う
  （`filterFallbackDayRows`、`worker/src/visited-places.js`）：
  1. 同じ日にmapVisitsがあれば、その`day_infos`行は丸ごと無視する（今回のフロリダの誤りはこれで消える）。
  2. `admin1`・`country`が両方空の行は無視する（何も分からないので補完のしようがない）。
  3. その旅行のどのmapVisitsからも1000km（`DAY_FALLBACK_MAX_KM`）以上離れている行は無視する
     （mapVisitsが1件も無い日でも、明らかにおかしい座標は信用しない）。
- 座標→都道府県・国の変換はNominatimのReverse（1秒1回まで）を使うため、キャッシュ（`caches.default`、
  3桁に丸めた座標をキーに90日）に無い新しい地点だけ、間隔を空けて呼ぶ。`GET /mylog`を遅くしすぎない
  よう、1回の呼び出しで使う待ち時間の合計に上限（8秒、`REVERSE_GEOCODE_BUDGET_MS`）を設け、
  超えた分は今回は諦める＝次にマイログを開いたときに、キャッシュが埋まった分からeventually complete
  で揃っていく（`resolveMapPointPlaces`）。
- `aggregateVisitedPlaces`の`days`は、`transit`（乗り継ぎ・空港だけの記録か）をmapVisits側は
  自分の記録が属するBlockから直接確定させて渡す（`isTransitBlock`）。`day_infos`側（フォールバック）
  は、これまでどおりBlockの地図座標との突き合わせで判定する（`d.transit`がbooleanでなければ
  従来の判定にフォールバックする）。
- `node worker/test/visited-places.test.mjs`に`haversineKm`（既知の距離で確認）・
  `filterFallbackDayRows`（同日mapVisitsがある行・admin1/country空の行・1000km以上離れた行が
  正しく落ちること、旅行をまたいで影響しないこと）・mapVisitsが1日に複数の場所を持てること、
  のテストを追加した。
- 実際のトリップJSON（`GET /trips/:id`）を取得しての確認は、このセッションでは本番データへの
  読み取りアクセスの権限が下りず行えていない（Claude Codeの自動モードの分類器が「本番の読み取り」
  として拒否した）。オーナーが実機・ブラウザで確認するか、権限を許可したうえで再確認をお願いしたい。

## 本番障害：GET /mylogが「Too many subrequests」で落ちる（2026-09-28 追加）

上の「day_infosより記録の地図の座標を優先する」変更をデプロイしたところ、本番で`GET /mylog`が
`Error: Too many subrequests by single Worker invocation.`で丸ごと落ち、ロールバックした。
Workers Free（1回のWorker呼び出しにつき50サブリクエストまで。fetchだけでなくCache APIの
match/putも1回ずつ数える）に対し、`resolveMapPointPlaces`が旅行の地点数だけCache APIの
match・put・Nominatimのfetchを行っていたため、地点数の多い旅行（例：ヨーロッパ周遊）で
上限を超えていた。

```
npx wrangler d1 execute tabilog-db --remote --command "ALTER TABLE entries ADD COLUMN map_admin1 TEXT"
npx wrangler d1 execute tabilog-db --remote --command "ALTER TABLE entries ADD COLUMN map_country TEXT"
```

（`--file migrations/0025_entry_map_region.sql`でのインポートは認証エラーになったため、上の
`--command`形式を使った。同じSQLは`migrations/0025_entry_map_region.sql`にも置いてある。）

- `entries`に`map_admin1`・`map_country`（座標から求めた都道府県・国）を追加した。座標を求める
  タイミング（`backgroundGeocodeEntry`＝記録の保存時の裏処理、`GET /geocode?entry=...`＝
  「地図でふりかえる」を開いたときの裏処理）に、都道府県・国も1回だけ`reverseGeocode`して
  一緒に保存する。`GET /mylog`は基本的にこの列を読むだけになり、Cache API・Nominatimの
  呼び出しをほぼ無くした。
- `getVisitedPlaces`（`worker/src/index.js`）を書き直した：entries×blocksの問い合わせを
  1回のIN batchにまとめ（以前は2回に分けていた）、`resolveMapPointPlaces`（Cache API＋
  バックグラウンドでの継続解決）は削除。まだ`map_admin1`/`map_country`が埋まっていない
  古い行（この変更より前に座標だけ保存されたもの）だけ、1リクエストにつき最大3地点まで
  その場で`reverseGeocode`して書き戻す（`resolveStaleEntryRegions`。1秒1回の間隔を守る）。
  `GET /mylog`全体のサブリクエスト数は、最大でも15前後に収まる見積もり（内訳はコードコメント参照）。
- `migrations/0025`を実行する前のDB（`map_admin1`/`map_country`列が無い）でも、`ALTER TABLE`が
  無い前提のSQLへ自動でフォールバックし、`day_infos`だけを使った集計（＝この変更より前の状態）を
  続ける。列が無いことによる例外で`GET /mylog`全体が落ちることは無い。
- 加えて、`getVisitedPlaces`の呼び出し自体を`try/catch`で包んだ。これから先、同じ場所（または
  似た理由）で例外が起きても、`GET /mylog`は`items`（付けた評価の一覧）・`trips`（参加した旅行）
  までは必ず返し、`places`（訪れた都道府県・国・旅行ごとのチップ）だけが空になる。今回のように
  マイログの一覧そのものが開けなくなる事態は防げる（失敗時は`{event:"mylog_visited_places_error"}`
  という1行のJSONを`console.error`する）。
- Belgium：オーナー報告。「スイス・ベルギー旅行（2025）」に行ったのに、「行ったことある旅先」の
  海外一覧では「ベルギー」に「記録が見つかりませんでした」と出て、総計にも含まれなかった。
  `COUNTRY_ALIASES`（`worker/src/visited-places.js`・`app.js`の`VISITED_COUNTRY_ALIASES`、
  2つは同じ内容を複製している）にベルギーの表記ゆれ（「ベルギー王国」「Belgium」「Belgique」
  「België」）が無かったため。あわせてスイスの表記ゆれ（「Schweiz」「Suisse」「Svizzera」）も
  追加した。総計（`prefectures`/`countries`）はもともと`tripPlaces`（旅行ごとの一覧）の和集合として
  作る構造になっている（`aggregateVisitedPlaces`のコメント参照）ため、**ある場所が総計に出るのに
  出典の旅行が0件、ということは構造上起こらない**（このアプリの他の国・都道府県も同じ）。
  `node worker/test/visited-places.test.mjs`にベルギー・スイスの表記ゆれのテストを追加した。
- `GET /mylog`の`places.tripPlaces`（旅行ごとのチップ）は、`migrations/0025`を実行する前でも
  `day_infos`だけから作られる形で必ず返る（空にはならない・古いクライアントもそのまま読める）。
  マイログ画面の旅行カードのチップ（`renderMyLogTrips`・`tripPlaceChipsHtml`、`app.js`）は
  `places.tripPlaces`があればそのまま描く作りに以前からなっているため、この変更でクライアント側の
  修正は不要だった（ロールバックしていた古いWorkerが`tripPlaces`自体を返していなかったのが、
  チップが消えていた直接の原因）。

## 宿泊先の名前を地図の場所名から出す（2026-09-29 追加）

トップの「宿泊先」（`Core.primaryLodgingName`）・宿泊の内訳（`Core.lodgingByNight`）が、宿泊の予定の
見出し（block.label）をそのまま出していたため、音声入力などで見出しが「ホテルに帰宅」「宿に戻る」の
ような一般的な文言だけになった記録では、意味の無い表示になっていた（オーナー報告）。

```
npx wrangler d1 execute tabilog-db --remote --command "ALTER TABLE entries ADD COLUMN map_place_name TEXT"
```

（`--file migrations/0026_entry_map_place_name.sql`は、0024・0025のときと同じ認証エラーが起きる
見込みのため、上の`--command`形式を使うこと。同じSQLは`migrations/0026_entry_map_place_name.sql`にも
置いてある。）

- `entries`に`map_place_name`（座標と同時に求めた、その場所の人が読める名前）を追加した。座標を
  求めるタイミング（`backgroundGeocodeEntry`・`GET /geocode?entry=...`）に、都道府県・国と同じく
  1回だけ求めて保存する（`saveEntryGeocodeResult`。3段階のフォールダウンで、`migrations/0025`・
  `0026`のどちらか片方だけ・どちらも未実行のDBでも、無い列を除いたSQLへ自動で切り替えて保存する）。
- 名前の求め方：①地図URL自体（`/maps/place/<名前>/`、または座標でない`query=<名前>`。
  `mapUrlPlaceName`）を最優先し、②それが無く`GOOGLE_API_KEY`があるときだけ、Google Text Searchで
  座標を求めるのに使っている`googleTextSearchPlace`のPlace Details呼び出しに`displayName`を
  ついでに追加で聞く（FieldMaskを`location`→`location,displayName`にしただけで、呼び出し回数は
  増えない＝Essentials無料枠のまま）。壊れた地図URL（`hasBrokenMapQuery`）からは名前を取らない。
- `GET /entries`系のAPI（`rowToEntry`）は、座標を返す条件（`map_geocoded_url`が今の`map_url`と
  一致・座標が数値・`MAP_COORDS_VALID_SINCE`以降）と同じときだけ`mapPlaceName`も一緒に返す
  （座標と名前は同時に求めた対だから）。
- クライアント（`app.js`）：`Core.primaryLodgingName`は宿泊の予定を順に見て、`entries[0].mapPlaceName`
  があればそれを、無ければ見出しが一般的な文言（`Core.isGenericLodgingLabel`。正規表現は
  `/^(ホテル|宿|旅館|部屋)(に|へ)?(帰宅|戻る|帰る|到着|チェックイン)?$|帰宅|戻る|へ$/`。
  「ホテルニューオータニ」のような実在の名前は誤って外さない）でなければその見出しを使う、を
  最初に見つかった1件で決める（見つからなければ、これまでどおり最初の見出しをそのまま出す）。
  `Core.lodgingByNight`（何泊目にどこへ泊まったか）も同じ優先順位にした。ただし、その夜の中で
  あとに一般的な文言だけのBlock（同じ宿での「宿に戻る」）が来ても、先に分かった名前を上書きしない
  ようにした（`test/data.test.js`の`lodgingByNight: 同じ日の後のBlockが「宿に戻る」のような
  一般的な見出しでも、先の宿の名前を消さない`が、まさにこの以前の不具合の再現テスト）。
- `node --check`・`node test/data.test.js`・`node worker/test/*.mjs`はすべて通した。**本番へのデプロイ
  ＋上のマイグレーション適用が必要**（`worker/src/index.js`と`migrations/0026`をwranglerで反映しないと、
  Google Places側の呼び出しを増やしただけで名前は保存されない）。

**追記（2026-09-30）既存の宿泊の記録にも名前を後から入れる**：上の変更は座標をこれから求める
記録（新しい記録・地図URLを編集した記録）にしか効かない。オーナーの現在の旅行はすでに座標が
保存済み（`map_geocoded_url`が今の`map_url`と一致）のため、再度ジオコーディングされる機会が無く、
「ホテルに帰宅」のままになる。これを直すため、軽い後追いを足した。

- `GET /geocode?q=<地図URL>&entry=<記録のid>&name=1`（新設、`geocodeEntryNameOnly`）：指定した記録に
  すでに座標が保存済み（`map_url`・`map_geocoded_url`がqと一致し、座標が数値）で、まだ
  `map_place_name`が無いときだけ、名前だけを求めて保存する。**座標は絶対に上書きしない**。
  名前は①URL自体（`mapUrlPlaceName`。短縮URLの展開に最大1回fetch）→②`GOOGLE_API_KEY`があれば
  Google Text Search＋Place Details（`googleTextSearchPlace`、最大2回fetch）の順。
  `mapUrlPlaceName`は`geo-decode.js`へ移し（純粋関数、単体テスト化のため）、`index.js`からは
  そちらをimportする形にした。
- クライアント（`app.js`）：旅行を開くたび（`loadTripZones`）に`backfillLodgingPlaceNames`を呼ぶ。
  宿泊の予定のうち、最初の記録に地図URLはあるが`mapPlaceName`がまだ無いものを最大3件、1.1秒空けて
  順に上のAPIへ聞き、見つかった名前をその場でstate.blocksに反映して`renderTripDetail`し直す。
  この画面を開いているあいだは同じ記録を二度試さない（`lodgingNameTried`）。
- `worker/test/geo-decode.test.mjs`に`mapUrlPlaceName`のテスト（`/place/<名前>/`・`query=<名前>`・
  座標のqueryは名前にしない・壊れたURLは名前を取らない、など）を追加した。
- **本番へのデプロイが必要**（クライアント・Worker両方）。マイグレーションは上の0026のみで、
  新しい列は追加していない。

## 時差は地図の場所だけで決め、区切りは手で直せる（2026-09-29 追加）

`docs/adr/0009`を改訂した。以前は「見出しの文言」「その日の場所」「予定を入れた順」など、地図以外の
手がかりも組み合わせて時差を推測していたが、オーナーから「マップが正。マップ入れてなかったら前の予定と
一緒で大丈夫。勝手に推測するのはやめてほしい（ラスベガスのニューヨークニューヨークというホテルを
ニューヨークと判断されたらややこしい）」との方針が出た（2026-09-29）。これを受けて、Core側の時差の
決め方（`assignBlockZones`）を、地図（記録の地図・移動の到着地の地図）と、地図が無い予定が引き継ぐ
「直前の予定」だけのシンプルな仕組みに作り直した（`orderZonesByCandidates`・`walkDay`・`segmentZones`・
`withoutZoneOutliers`・`startZoneFor`・`isGroundMove`は削除。前後から遠く離れたピンを無視する
`isFarMapOutlier`／`findFarMapOutlierBlockIds`はそのまま残した＝これは地図の座標どうしの距離で
決める、地図に基づく判定のため）。

あわせて、「時差のところは人がいじれなくなっているので慎重に。間違っていたら削除くらいはできてもいい。
時間を変えられるのも、やりすぎない範囲で」というオーナーの言葉どおり、「🕒 ここから現地時間」の区切りを
タップすると、その予定だけ時差を手で直せるようにした（`renderZoneDivider`・`openTzOverrideSheet`、
`app.js`）。

```
npx wrangler d1 execute tabilog-db --remote --command "ALTER TABLE blocks ADD COLUMN tz_override TEXT"
```

（`--file migrations/0027_block_tz_override.sql`は、0024〜0026のときと同じ認証エラーが起きる見込みの
ため、上の`--command`形式を使うこと。同じSQLは`migrations/0027_block_tz_override.sql`にも置いてある。）

- `blocks`に`tz_override`（TEXT）を追加した。値はNULL・空文字＝自動（地図の場所だけで決める）、
  `'inherit'`＝直前の予定と同じにする（区切りを消す）、それ以外はIANAのタイムゾーン名
  （例：`America/Los_Angeles`）。`PATCH /blocks/:id`で受け取り（`TZ_OVERRIDE_RE`で検証。
  `^[A-Za-z_]+(/[A-Za-z0-9_+-]+){1,2}$`または`'inherit'`）、列がまだ無い環境では書き込みだけ
  失敗を握りつぶす（`manual_order`と同じtry/catchのパターン）ので、マイグレーション未適用でも
  他の操作は壊れない（ただし直した時差はマイグレーション適用まで保存されない＝毎回自動に戻る）。
  `GET`系（`rowToBlock`）は`tzOverride`として返す。
- クライアント（`app.js`）の`Core.assignBlockZones`は、地図より`block.tzOverride`を優先する。
  `renderZoneDivider`はボタンになり、タップすると`openTzOverrideSheet`が開いて
  「この時差を取り消す（前の予定と同じ時間にする）」「タイムゾーンを選ぶ」（この旅行に出てくる
  地図のタイムゾーン＋日本＋「その他…」で約20の主要タイムゾーンから選べる）「自動に戻す」
  （直した値があるときだけ）を選べる。直した予定・区切りには「時差を手で直しています」の注記を出す。
  保存は`PATCH /blocks/:id`に`{tzOverride}`を送るだけ（他のフィールドは変えない）。
- `test/data.test.js`に、ラスベガスの「ニューヨークニューヨーク」ホテル（地図はラスベガス）が
  見出しに関わらずロサンゼルス時間のままになること、`tzOverride: 'inherit'`で区切りが消えること、
  IANA名の`tzOverride`でその時差になることのテストを追加した。
- `node --check`・`node test/data.test.js`・`node worker/test/*.mjs`はすべて通した。**本番への
  デプロイ＋上のマイグレーション適用が必要**。マイグレーション未適用の間は、時差の区切りは
  これまでどおり地図だけの自動判定になり（手直しは保存されない）、既存の時差の並び自体は変わらない。

## ソーシャルログイン（Apple・Google・LINE）の準備（2026-09-30 追加）

Apple・Google・LINEでログインできるようにした（docs/adr/0019）。ブラウザ用のSDKは使わず、Worker（このフォルダ）が各社とやり取りして本人確認する。**3つとも無料**（Google Cloudの認証情報の作成・LINE Developersのチャネル作成は無料。Appleは、すでに払っているApple Developer Programの年会費に含まれ、追加費用は無い）。

**登録しなくても壊れない**：Workerに設定があるログイン方法だけが、ログイン画面にボタンとして出る（`GET /auth/providers`）。1つも設定しなければ今までどおりメールログインだけ。**ただしApp Storeで公開するアプリでは、Googleなど他社ログインを出すなら「Appleでサインイン」も必ず一緒に出す**（Review Guideline 4.8）。Appleを登録する前にGoogleやLINEだけ公開しないこと。

以下、URLの `https://tabilog-api.hiroya-apps.workers.dev` はWorkerの公開URL（コールバックURL＝各社に登録する「戻ってくる先」）。**一文字でも違うとログインが失敗する**ので、コピーして貼り付けること。

### 手順0：デプロイ前にD1へテーブルを作る（順番厳守）

新しいテーブルを`wrangler deploy`**より先に**作る（逆順だと、ログイン画面を開いたときにSQLエラーになる）。テーブルを足すだけなので既存データには影響しない。**このオーナーの環境では`--file`が失敗するため、`--command`で1つずつ流す**（何度実行しても安全な`CREATE TABLE IF NOT EXISTS`）。中身は`migrations/0028_social_login.sql`と同じ。

```sh
cd apps/day07-tabilog/worker
npx wrangler d1 execute tabilog-db --remote --command "CREATE TABLE IF NOT EXISTS auth_identities (provider TEXT NOT NULL, subject TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (provider, subject));"
npx wrangler d1 execute tabilog-db --remote --command "CREATE INDEX IF NOT EXISTS idx_auth_identities_email ON auth_identities(email);"
npx wrangler d1 execute tabilog-db --remote --command "CREATE TABLE IF NOT EXISTS auth_states (state TEXT PRIMARY KEY, provider TEXT NOT NULL, return_to TEXT NOT NULL, nonce TEXT NOT NULL, code_verifier TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL, created_at TEXT NOT NULL);"
npx wrangler d1 execute tabilog-db --remote --command "CREATE TABLE IF NOT EXISTS auth_codes (code_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL, created_at TEXT NOT NULL);"
```

### 手順0b：Appleトークンの取り消し用の列を足す（アカウント削除対応。migration → deploy の順）

アカウント削除時にSign in with Appleのトークンを取り消す（App Storeガイドライン5.1.1(v)。docs/adr/0019の追記）ため、Appleのrefresh_tokenを保存する列を足す。**`wrangler deploy`より先に**1回だけ実行する（このオーナーの環境では`--file`が認証エラーになるので`--command`で）。

```sh
cd apps/day07-tabilog/worker
npx wrangler d1 execute tabilog-db --remote --command "ALTER TABLE auth_identities ADD COLUMN refresh_token TEXT NOT NULL DEFAULT '';"
npx wrangler deploy
```

先にdeployしてしまってもログインや削除は壊れない（列が無いあいだはトークンを保存しないだけ）。ただしその間にAppleでログインした人は取り消せなくなるので、順番は守る。対応前にログインした人のトークンは無いため取り消せない（再ログインで保存される）。取り消しに失敗した場合はログに`apple_revoke_failed`が出るが、アカウント削除は続行される。

### 手順1：Google（Google Cloud Console）

1. https://console.cloud.google.com/ を開き、プロジェクトを選ぶ（無ければ作る。すでにGoogleマップ用のAPIキーを作ったプロジェクトでよい）
2. 「APIとサービス」→「OAuth同意画面」（新しい画面では「Google Auth Platform」→「ブランディング／対象」）
   - User Type：**外部**
   - アプリ名：旅の足跡／ユーザーサポートメール・デベロッパーの連絡先：自分のメールアドレス
   - スコープは追加しなくてよい（`openid`・`email`・`profile`はもともと使える）
   - **公開ステータスを「テスト」から「本番環境」（アプリを公開）に変える**。「テスト」のままだと、テストユーザーに登録した人しかログインできない。今回のスコープは審査（検証）が要らない種類なので、ボタンを押すだけで公開できる
3. 「認証情報」→「認証情報を作成」→「OAuth クライアント ID」
   - アプリケーションの種類：**ウェブ アプリケーション**
   - 名前：tabilog-worker（何でもよい）
   - 「承認済みのリダイレクト URI」に追加：`https://tabilog-api.hiroya-apps.workers.dev/auth/google/callback`（「承認済みのJavaScript生成元」は空でよい）
4. 作成すると「クライアントID」（`〇〇〇.apps.googleusercontent.com`）と「クライアントシークレット」が出る。IDは`wrangler.jsonc`の`vars`へ、シークレットは下の`wrangler secret put`で登録する

### 手順2：Apple（Apple Developer）

前提：Apple Developer Programに登録済み（iOSアプリの配布に必要なので済んでいるはず）。

1. https://developer.apple.com/account/resources/identifiers/list を開き、iOSアプリのApp ID（`com.hiroyaapps.tabilog`）を開いて「**Sign in with Apple**」にチェックが入っているか確認する（無ければ入れて保存）
2. 同じ画面の「Identifiers」→「+」→「**Services IDs**」で新規作成
   - Description：旅の足跡 Web／Identifier：`com.hiroyaapps.tabilog.web`（**これが`APPLE_SERVICES_ID`**。アプリのBundle IDとは別の名前にする）
   - 作成後、そのServices IDを開いて「Sign in with Apple」にチェック→「Configure」
     - Primary App ID：`com.hiroyaapps.tabilog`
     - Domains and Subdomains：`tabilog-api.hiroya-apps.workers.dev`
     - Return URLs：`https://tabilog-api.hiroya-apps.workers.dev/auth/apple/callback`
   - 保存（Continue → Save）。ドメイン確認用のファイルのアップロードを求められた場合は、そのまま進めず相談すること（Workerの`workers.dev`ドメインには置けないため、その場合は別の方法を考える）
3. 「Keys」→「+」→ 名前（例：tabilog-signin）→「**Sign in with Apple**」にチェック→「Configure」でPrimary App IDに`com.hiroyaapps.tabilog`を選ぶ→ Continue → Register
   - **`.p8`ファイルのダウンロードは1回しかできない**。必ず保存して、Gitには入れない（`AuthKey_XXXXXXXXXX.p8`）
   - 画面に出る10桁の**Key ID**（`APPLE_KEY_ID`）を控える
4. 右上のアカウント名の横、または「Membership details」にある10桁の**Team ID**（`APPLE_TEAM_ID`）を控える

### 手順3：LINE（LINE Developers）

1. https://developers.line.biz/console/ にLINEアカウントでログイン
2. 「プロバイダー」を作成（名前は何でもよい。例：hiroya-apps）
3. そのプロバイダーの中で「新規チャネル作成」→「**LINEログイン**」
   - チャネルの種類：LINEログイン／アプリタイプ：**ウェブアプリ**
   - チャネル名：旅の足跡／チャネル説明・メールアドレス：自分のもの
4. 作成したチャネルの「チャネル基本設定」に**チャネルID**（`LINE_CHANNEL_ID`）と**チャネルシークレット**（`LINE_CHANNEL_SECRET`）がある
5. 「LINEログイン設定」タブの「コールバックURL」に追加：`https://tabilog-api.hiroya-apps.workers.dev/auth/line/callback`
6. **チャネルの公開**：右上のステータスが「開発中」だと、そのチャネルの管理者・テスターしかログインできない。準備ができたら「公開」に切り替える
7. （任意）**メールアドレスの取得権限**：「チャネル基本設定」の「OpenID Connect」欄にある「メールアドレス取得権限」の「申請」から、利用目的の説明とプライバシーポリシーのURL（`https://tabinoashiato.pages.dev/privacy.html`）を出して申請する。承認されるとLINEログインのときにメールアドレスが返り、同じメールのアカウントに自動でつながる。**承認されていない（または申請していない）間は、LINEでログインした人に一度だけメールの確認コードを入力してもらう**（次回からはLINEだけで入れる）ので、アプリは申請なしでも動く

### 手順4：Workerに設定を入れる

`wrangler.jsonc`の`vars`に、IDのほう（秘密ではないもの）を書く。使う方式の分だけでよい。

```jsonc
"vars": {
  "ALLOWED_ORIGIN": "…そのまま…",
  "GOOGLE_CLIENT_ID": "（手順1のクライアントID）.apps.googleusercontent.com",
  "APPLE_SERVICES_ID": "com.hiroyaapps.tabilog.web",
  "APPLE_TEAM_ID": "（手順2のTeam ID）",
  "APPLE_KEY_ID": "（手順2のKey ID）",
  "LINE_CHANNEL_ID": "（手順3のチャネルID）"
}
```

秘密のほうは`wrangler.jsonc`に書かず、`secret put`で登録する（実行すると入力欄が出るので貼り付けてEnter）。

```sh
cd apps/day07-tabilog/worker
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put LINE_CHANNEL_SECRET
# Appleの.p8：中身（-----BEGIN PRIVATE KEY----- から -----END PRIVATE KEY----- まで）をそのまま登録する
# bash（Git Bash）の場合：
npx wrangler secret put APPLE_PRIVATE_KEY < AuthKey_XXXXXXXXXX.p8
# PowerShellの場合（`<`が使えないので、パイプで渡す）：
Get-Content -Raw AuthKey_XXXXXXXXXX.p8 | npx wrangler secret put APPLE_PRIVATE_KEY
```

そのあとデプロイする（手順0のテーブル作成が済んでいること）。

```sh
npx wrangler deploy
```

### 手順5：動作確認

1. `https://tabilog-api.hiroya-apps.workers.dev/auth/providers` をブラウザで開く。`{"providers":["apple","google","line"]}`のように、設定した方式だけが出ればWorker側は認識できている（出ない方式は、varsかsecretのどれかが抜けている。AppleはID・Team・Key・秘密鍵の4つ、GoogleとLINEはIDとシークレットの2つがそろって初めて出る）
2. Web版（https://tabinoashiato.pages.dev/）の「ログインする」から、各ボタンでログインしてみる。ログイン後にホームへ戻り、名前が出れば成功
3. iOSアプリ（TestFlight）でも試す。ボタンを押すとSafariが開き、ログインが終わったら「ログインできました。旅の足跡アプリに戻ってください」と出るので、アプリに戻る（自動でログイン完了になる）
4. うまくいかないとき：Cloudflareのダッシュボード→Workers→tabilog-api→ログで`social_login_failed`を探す。`reason`に`token_http_400`（コールバックURL・シークレットの不一致）、`id_token_bad_aud`（IDの取り違え）、`client_secret_failed`（Appleの秘密鍵の貼り付け違い）などが出る

### アカウントのつながり方

- メールアドレス・Apple・Google・LINEのどれで入っても、**確認済みのメールアドレスが同じなら同じアカウント**（旅行・マイログ・プランは共通）。
- LINEなどでメールが受け取れないときは、ログイン後にメールの確認コード入力が一度だけ入る。確認したメールに、そのLINEの人が結びつく。
- Appleで「メールを非表示」を選んだ人は、Apple専用の中継アドレスが使われるため、普段のメールとは**別のアカウント**になる。
- アカウントを削除すると、そのアカウントに結びついたログイン情報（`auth_identities`）も消える。Appleで入っていた人は、消す前にAppleのトークン取り消しAPIも呼ぶ（失敗しても削除は続ける）。

### REQUIRE_SESSION（トークン必須）の準備状況

`release/tabilog-1.1.0`ブランチのapp.jsを確認したところ、`authHeaders()`が`authorization: Bearer <token>`を`api()`・`nativeApi()`・`postBinary()`のすべてに付けており、iOSアプリ（1.1.0）側はトークン必須に切り替えても送れる状態。**切り替える（`vars`に`"REQUIRE_SESSION": "1"`）かどうかは、1.0.x以前の古いアプリが使われなくなったかを見て別途判断する**（この作業ではオンにしていない）。

## スクショから予定を作る（2026-09-30 追加、docs/adr/0022）

旅行詳細の「スクショから予定を作る」（画像を最大10枚→予定の候補→確認画面→追加）に必要な設定です。**新しいシークレットや`wrangler.jsonc`の変更・DBのマイグレーションはありません**（すべて既存のものを使います）。

- `GOOGLE_API_KEY`：レシート読み取り・場所の候補検索で使っているものと同じキー。**このキーで Cloud Vision API と Places API (New) の両方が有効**である必要があります（Visionは`DOCUMENT_TEXT_DETECTION`、Placesは Text Search）。どちらかが無効・キーが無いと、この機能は`server_not_configured`（503）を返し、画面に「まだ使えません」と出ます。
- `OPENAI_API_KEY`：音声・メモのAI整理と同じキー。
- `AI_RATE_LIMITER`：既存のもの（1分に10回）を使います。回数の枠は「メモのAI整理」を1回の取り込みにつき1回使います（`memo_uses_this_period`、使い切ったら回数券）。
- **GCPのクォータに注意**：Cloud Visionは月1,000枚まで無料、超えると1,000枚あたり約$1.5。1回の取り込みで最大10枚使います。GCPで「Visionの1日の上限」を30枚などに絞っていると、10枚の取り込みは3回で尽きて`vision_failed`になります。機能を出す前に、1日の上限と予算アラートを決めてください。Places Text Searchは名前・住所・座標を聞くため Pro の単価帯です（1回の取り込みで最大12回）。
- **サブリクエスト**：Workers Freeは1リクエスト50回まで。1回の取り込みは Vision 1＋OpenAI 1＋場所検索 最大12＋D1 約10＝約24回（最大でも約35回）で、`worker/src/screenshot-import.js`の`estimateSubrequests`で数えています。
- ローカルの確認：`node worker/test/screenshot-import.test.mjs`（純粋関数）と`node worker/test/screenshot-handler.test.mjs`（Workerの入口から通し。D1・Vision・OpenAI・Placesはモックで、有料APIは呼びません）。
