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
