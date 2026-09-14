# タスク一覧：音声入力のStripe課金化

計画の全体像は `tasks/plan.md` を参照。

## Phase 1: データの土台

### Task 1: accountsテーブルにプラン・利用状況の列を追加する
**説明**：`accounts`テーブルに、契約プラン・利用回数・回数券残数・Stripe連携用IDを持たせる。
**受け入れ条件**：
- [ ] `plan`（'free'|'basic'|'premium_plus'）・`plan_period_start`（暦月リセットの基準）・`voice_uses_this_period`・`ticket_credits`・`stripe_customer_id`・`stripe_subscription_id`の列がある
- [ ] 既存データに影響しない（`ALTER TABLE`で追加、デフォルト値あり）
**検証**：
- [ ] `node --check worker/src/index.js`
- [ ] schema.sqlの一時的なALTER文の扱いは、既存のprecip_sum/voice_transcriptと同じ慣習に従う
**依存**：なし
**想定ファイル**：`worker/schema.sql`

### Task 2: Stripe秘密情報をCloudflare Workerのシークレットとして登録する
**説明**：`STRIPE_SECRET_KEY`・`STRIPE_WEBHOOK_SECRET`をwranglerのシークレットとして登録する手順をユーザーに案内する（実行はユーザー自身のPCで）。
**受け入れ条件**：
- [ ] `npx wrangler secret put STRIPE_SECRET_KEY`が完了している
- [ ] コード・GitHubにキーが一切書かれていない
**検証**：
- [ ] `npx wrangler secret list`でキー名が見える（値は見えない）
**依存**：なし
**想定ファイル**：なし（手順の案内のみ）

## Checkpoint: Phase 1
- [ ] schema.sqlの変更をユーザーのD1に反映（`npx wrangler d1 execute tabilog-db --remote --file=schema.sql`）
- [ ] シークレット登録済み

## Phase 2: 決済セッションの作成

### Task 3: Checkout Session作成エンドポイントを実装する
**説明**：`POST /billing/checkout`を新設。ログイン中のアカウント（email）と選んだプラン（basic/premium_plus/ticket）を受け取り、対応するPrice IDでStripeのCheckout Sessionを作成し、`session.url`を返す。
**受け入れ条件**：
- [ ] `fetch()`で`https://api.stripe.com/v1/checkout/sessions`を呼ぶ（npm SDK不使用）
- [ ] `mode`はサブスク（basic/premium_plus）なら`subscription`、回数券なら`payment`
- [ ] Checkout Studioで確定した固定パラメータ（`ui_mode: hosted_page`など）をすべて含む
- [ ] `client_reference_id`または`metadata`にアカウントのemailを含める（Webhookで誰の購入か特定するため）
**検証**：
- [ ] `node --check worker/src/index.js`
- [ ] テストモードで実際にレスポンスの`url`にアクセスし、Stripeの決済画面が出る
**依存**：Task 1, Task 2
**想定ファイル**：`worker/src/index.js`

### Task 4: フロントに「プレミアムに登録する」導線を追加する
**説明**：マイログ画面などに、現在のプラン表示とプラン選択・購入ボタンを追加。ボタン押下でTask 3のエンドポイントを呼び、返ってきたURLへリダイレクトする。
**受け入れ条件**：
- [ ] 未ログイン時はログイン画面へ誘導する
- [ ] 3つのプラン（ベーシック・プレミア＋・回数券）が選べる
- [ ] 押すとStripeの決済画面へ遷移する
**検証**：
- [ ] Playwrightで、ボタン押下後にリダイレクト先のURLが変わることを確認（実際のStripe決済完了まではテストしない）
**依存**：Task 3
**想定ファイル**：`index.html`, `app.js`, `style.css`

## Checkpoint: Phase 2
- [ ] テストモードで実際にStripeの決済画面まで到達できる

## Phase 3: Webhookでの反映

### Task 5: Webhookエンドポイントと署名検証を実装する
**説明**：`POST /billing/webhook`を新設。`stripe-signature`ヘッダーを`STRIPE_WEBHOOK_SECRET`で検証してからイベントを処理する。
**受け入れ条件**：
- [ ] 署名が不正なリクエストは400で拒否する
- [ ] 署名検証はWeb Crypto API（`crypto.subtle`）で実装する（Workerで動くこと前提。npm SDK不使用）
**検証**：
- [ ] `node --check worker/src/index.js`
- [ ] Stripeダッシュボードの「Webhookをテスト送信」機能で200が返る
**依存**：Task 2
**想定ファイル**：`worker/src/index.js`

### Task 6: checkout.session.completedでaccountsにプラン・回数券を反映する
**説明**：Webhookで購入完了イベントを受けたら、`client_reference_id`のemailに対応するaccountsの`plan`／`ticket_credits`を更新する。
**受け入れ条件**：
- [ ] サブスク購入なら`plan`と`stripe_subscription_id`を更新し、`voice_uses_this_period`を0にリセット
- [ ] 回数券購入なら`ticket_credits`に10を加算
**検証**：
- [ ] Stripeのテスト送信で、実際にD1の該当行が更新される
**依存**：Task 5
**想定ファイル**：`worker/src/index.js`

### Task 7: 解約イベントでプランを無料に戻す
**説明**：`customer.subscription.deleted`を受けたら、該当accountsの`plan`を'free'に戻す（回数券の残数はそのまま）。
**受け入れ条件**：
- [ ] 解約後は音声入力ができなくなる（Task 8と連動して確認）
**検証**：
- [ ] Stripeのテスト送信で確認
**依存**：Task 6
**想定ファイル**：`worker/src/index.js`

## Checkpoint: Phase 3
- [ ] Webhookで実際にaccountsのプランが更新されることを確認

## Phase 4: 音声入力の制限

### Task 8: 音声入力エンドポイントにログイン必須化・プラン確認・利用回数消費を実装する
**説明**：`POST /trips/:id/days/:date/voice-entries`に、呼び出し元のemail（新しいヘッダーかmetaに含める）を必須にし、プラン・回数券の残りを確認してから処理する。使ったら回数を消費する。
**受け入れ条件**：
- [ ] 未ログイン・無料プランは`403`＋分かりやすいエラーコードを返す
- [ ] 月の上限（10 or 50）を超えたら`403`
- [ ] サブスクの残り優先、無ければ回数券を消費
- [ ] 暦月が変わっていたら`voice_uses_this_period`を0にリセットしてから判定する
**検証**：
- [ ] `node test/data.test.js`
- [ ] `NODE_PATH=/opt/node22/lib/node_modules node test/voice.smoke.js`（新しい制限のケースを追加）
**依存**：Task 1
**想定ファイル**：`worker/src/index.js`, `app.js`

### Task 9: フロント側に「ログイン・プレミアムが必要です」の案内を追加する
**説明**：音声入力ボタンを押したときに、ログインしていない／プランが足りない場合の案内画面を出す（Task 4の購入導線に誘導する）。
**受け入れ条件**：
- [ ] エラーコードごとに適切な文言が出る
**検証**：
- [ ] `NODE_PATH=/opt/node22/lib/node_modules node test/voice.smoke.js`
**依存**：Task 8, Task 4
**想定ファイル**：`app.js`, `index.html`

## Checkpoint: Phase 4
- [ ] 無料アカウントでは音声入力が使えない／プラン契約中は上限まで使える／上限超えで案内が出ることをPlaywrightで確認

## Phase 5: 仕上げ

### Task 10: STRIPE_INTEGRATION_TODO.mdを作成する
**受け入れ条件**：
- [ ] 本番用キーへの切り替え手順、Webhook URLの本番登録手順、Price IDの本番作成手順を記載
**依存**：Task 3-9
**想定ファイル**：`apps/day07-tabilog/STRIPE_INTEGRATION_TODO.md`

### Task 11: ドキュメント更新
**受け入れ条件**：
- [ ] `docs/adr/0004`に実装内容を追記
- [ ] `CONTEXT.md`にプラン・利用回数まわりの用語を追記
**依存**：Task 3-9
**想定ファイル**：`CONTEXT.md`, `docs/adr/0004-voice-monetization-plan.md`

## Checkpoint: 完了
- [ ] テストスイート全件通過
- [ ] ユーザーにテストモードでの一連の流れを確認してもらう
