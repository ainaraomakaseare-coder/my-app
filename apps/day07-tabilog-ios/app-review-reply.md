# App Review への返信（Guideline 3.1.1 - In-App Purchase、2026-09-30）

「アプリの外で購入した有料コンテンツにアプリからアクセスできるなら、アプリ内課金（In-App Purchase）を実装する必要がある」という指摘への返信です。
下の英文を **「App Reviewに返信」** に貼り、新しいビルドを提出するときは **「App Review に関する情報」→「メモ」欄** にも貼ります。

前提：この返信は、有料プラン・回数券の販売停止を入れた版（Worker のデプロイ済み・Web版とiOSアプリが同じ内容）を提出するときに使います。**Workerのデプロイ前に返信しないでください**（サーバー側が古いままだと、Webで購入済みの人の上限が上がったままになるため）。

## 返信文（英語）

```
Hello, and thank you for the review.

Regarding Guideline 3.1.1: we have discontinued all paid plans and credit purchases, on every platform (the iOS app and the web version). Nothing is sold outside the app any more, and the app does not unlock anything that was purchased elsewhere.

What changed:
- All paid subscription plans (Basic and Premium+) and the paid credit packs (ticket bundles) have been removed. No purchase screen, plan-selection screen, payment link or billing-management link exists in the iOS app or on the web.
- The server no longer accepts purchases. The checkout, billing-portal and credit-purchase endpoints return an error (HTTP 410, "billing_disabled"), and the payment webhook is ignored, so no account can be upgraded.
- The server now applies the same free allowance to every account, regardless of any plan value stored earlier: 10 voice-input uses and 10 memo/screenshot AI-organizing uses per month. Nobody has a higher limit, and no purchased entitlement exists anywhere.
- The small number of "bonus uses" shown in the app are a free welcome bonus for new accounts. They cannot be bought and are not related to any payment.
- The app has no paid content or features. All features are free for all users, and the app does not ask for any payment information. The privacy policy has been updated accordingly.
- When the monthly free allowance is used up, the app only says that the allowance resets on the 1st of next month. It does not link to or mention any purchase.

If we offer paid features in the future, we will do so only through In-App Purchase.

Thank you for your time.
```

## 日本語訳（自分用の確認）

```
ご審査ありがとうございます。

Guideline 3.1.1 について：有料プランと回数券の購入を、すべてのプラットフォーム（iOSアプリとWeb版）で廃止しました。アプリの外で販売しているものはなく、アプリは他の場所で購入されたものを解除することもありません。

変更点：
- 有料の月額プラン（ベーシック、プレミア＋）と、有料の回数券（買い切りの回数パック）をすべて削除しました。iOSアプリにもWeb版にも、購入画面・プラン選択画面・支払いへのリンク・支払い管理へのリンクはありません。
- サーバーは購入を受け付けません。決済ページ・支払い管理・回数券の購入の入口はエラー（HTTP 410 "billing_disabled"）を返し、決済のWebhookは無視されるため、アカウントがアップグレードされることはありません。
- サーバーは、以前保存されたプランの値に関係なく、すべてのアカウントに同じ無料の回数を適用します。音声入力は月10回、メモ・スクショのAI整理は月10回です。これより多い上限を持つ人はおらず、購入によって得られた権利はどこにも存在しません。
- アプリに表示される少数の「おまけの回数」は、新規アカウントへの無料の登録特典です。購入することはできず、支払いとは無関係です。
- アプリに有料のコンテンツや機能はありません。すべての機能をすべてのユーザーが無料で使え、支払い情報も求めません。プライバシーポリシーもそれに合わせて更新しました。
- 月の無料の回数を使い切ったときは、来月1日に回数が戻ることだけを表示し、購入への案内やリンクは出しません。

将来、有料の機能を提供する場合は、アプリ内課金（In-App Purchase）のみを使います。

よろしくお願いいたします。
```

## 提出前のチェック

- [ ] Worker をデプロイした（`/billing/checkout` が 410 を返す、`/accounts/ensure` の `plan` が `free`）
- [ ] Web版（Cloudflare Pages）をデプロイした（iOSアプリはWeb版と同じファイルを同梱するが、新しいビルドを作るときにもこの版を含める）
- [ ] 実機で、プロフィール画面に「プラン」「購入」の文言が無く、「あと○回（月10回まで）」だけが出ている
- [ ] App Store Connect の説明文・キーワード・スクリーンショットに、有料プラン・回数券・課金の表記が無い
