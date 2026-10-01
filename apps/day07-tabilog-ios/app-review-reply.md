# App Review への返信（Guideline 4 - Design、ログイン、2026-10-01）

ビルド103への「ログイン・登録のために既定のブラウザ（Safari）へ移動させるのは体験が悪い」という指摘への返信です。
修正したビルドを提出するときに、下の英文を **「App Reviewに返信」** と **「App Review に関する情報」→「メモ」欄** に貼ります。

修正内容：Apple・Google・LINEでのログインを、標準のSafari（別アプリ）ではなく、アプリの中で開くSafariの画面
（SFSafariViewController、`@capacitor/browser`）で開くようにした。ログインが終わると画面が閉じてアプリに戻る。
メールでのログイン・登録は、もともとアプリの中だけで完結している。アカウント削除は「プロフィール」→「アカウントを削除する」。

## 返信文（英語）

```
Hello, and thank you for the review.

Regarding Guideline 4 - Design: we have revised the app so that users can sign in and register entirely within the app.

- Sign in with Apple, Google and LINE now opens inside the app using SFSafariViewController, as suggested. Users stay in the app, can verify the page URL and SSL certificate, and the sheet closes automatically when sign-in is complete. The app no longer switches to the default web browser.
- Sign-in and registration with an email address (a one-time code sent by email) is done entirely in the app's own screens.
- Account deletion is available in the app: Profile tab > "アカウントを削除する" (Delete account).

Thank you for your time.
```

## 日本語訳（自分用の確認）

```
ご審査ありがとうございます。

Guideline 4 - Design について：ログインとアカウント登録をアプリの中だけで行えるように修正しました。

- Apple・Google・LINEでのログインは、ご案内いただいたSFSafariViewControllerで、アプリの中で開くようにしました。利用者はアプリから離れず、ページのURLとSSL証明書を確認でき、ログインが終わると画面は自動で閉じます。既定のブラウザに切り替わることはなくなりました。
- メールアドレスでのログイン・登録（メールで届く確認コード）は、アプリ自身の画面だけで完結します。
- アカウントの削除はアプリの中から行えます：「プロフィール」タブ →「アカウントを削除する」。

よろしくお願いいたします。
```

## 提出前のチェック

- [ ] 修正したビルドをTestFlightで入れ、Apple・Google・LINEのボタンを押すと、アプリの中にSafariの画面が下から出る（Safariのアプリに切り替わらない）
- [ ] ログインを終えると、その画面が閉じてアプリに戻り、ログインできている
- [ ] ログインの途中で左上の「完了」を押すと、ログイン画面に戻る
- [ ] iPadでも同じように動く（審査はiPad Air 11インチで行われた）

---

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
