# 1.3.0 申請の準備メモ（2026-10-08）

1.2.0（審査待ち）からの変更をまとめた版。回数券（消耗型のアプリ内課金）を初めて出す。
最初の消耗型アプリ内課金は、新しいアプリのバージョンと一緒に審査に出す必要がある（App Store Connectの表示）。

## 手順

1. 【あなた】1.2.0の審査が通るのを待つ（前のバージョンの審査中は、次のバージョンを審査に出せない）
2. 【ClaudeがChromeで】回数券10回・30回それぞれの「審査に関する情報」にスクリーンショットを登録する
   （TestFlightの「マイページ →『今月の残り回数』」で、回数券を買う欄が見えている画面）
3. 【ClaudeがChromeで】「Appのプライバシー」に「購入」→「購入履歴」を追加して公開する
   - 用途：アプリの機能／本人と結びつく：はい／トラッキング：いいえ
   - 購入の記録（アカウントID・商品・取引ID・日時）はRevenueCat経由でサーバーに届く（privacy.htmlの2-2）
4. 【ClaudeがChromeで】「＋バージョン」→ 1.3.0 を作り、TestFlightの最新ビルドを選ぶ
5. 下の「このバージョンの新機能」を入れる。スクリーンショットは1.2.0のものを引き継ぐ
6. 日本語の説明文に、回数券の値段の一文を足す（下の「説明文に足す文」）
7. 「アプリ内課金とサブスクリプション」の欄で、回数券10回・30回をこのバージョンに付ける
8. 審査メモを入れて、審査に提出する

## ★ サーバーの設定（REVENUECAT_ACCEPT_SANDBOX）の外す時期

`worker/wrangler.jsonc` の `REVENUECAT_ACCEPT_SANDBOX: "true"` は、テスト購入（SANDBOX）でも回数を足す設定。
**審査中はオンのままにする。** App Reviewの人はテスト購入で確かめるので、オフだと「買ったのに回数が増えない」で落とされる。
審査に通ったあと、公開する直前に消してデプロイする（バージョンは「手動でリリース」にしておく）。

## このバージョンの新機能

### 日本語
```
・AIの回数券（10回・30回）を追加しました。月の無料回数を使い切っても、音声入力やメモ・スクショのAI整理を続けて使えます
・マイページの「AIの残り回数」に、回数券の残りもまとめて表示するようにしました
・使い方ガイドを、下のタブの並びの順に案内するようにしました
・電波がない場所でも旅行を見られ、変更は電波が戻ったら送るようにしました
・そのほか細かな不具合を直しました
```

## 説明文に足す文（日本語）

```
AIの回数券（10回 500円／30回 1,200円）：月の無料回数を使い切ったあとに1回ずつ使われます。有効期限はありません。
```

値段を変えたときは、この文も直す。アプリの中の値段はStoreKitが返すものをそのまま出している（決め打ちしない）。

## 審査メモ（App Review Information）

```
旅の足跡 is a shared travel journal. A trip is opened with its share link; anyone with the link can view and add records without an account. Sign-in (Sign in with Apple, Google, LINE, or email code) is only needed for likes/comments, My Log and the AI features.

This version adds consumable in-app purchases ("回数券" = AI usage tickets: 10 uses / 30 uses). Each signed-in account gets 3 free AI uses per month for voice input and for AI organizing of memos/screenshots. Purchased tickets are used one at a time after the monthly free uses run out. They do not expire.

How to find the purchase: sign in (Sign in with Apple is fine) → tab bar "マイページ" (My Page, rightmost) → "AIの残り回数" (AI uses left) → the sheet shows "回数券を買う" (Buy tickets) with the prices and two buttons. After purchasing, "回数券の残り" (Tickets left) increases within a few seconds.

Purchases are processed by Apple (StoreKit, via RevenueCat). There is no other payment method in the app and no links to external purchases.
```

## メモ

- TestFlight（Sandbox）では、値段がドルで出ることがある（購入の確認画面は¥500）。本番の日本のストアでは円で出る
- 購入画面が出なかった原因は、RevenueCatの `configure()` がPromiseを返さなかったこと（#135で修正）
