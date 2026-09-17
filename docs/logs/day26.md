# DAY 26：旅の足跡（有料サブスク実装＋App Store配信）

**新しい挑戦**：初めての有料サブスク課金（Stripe）の実装と、初めてのiOSアプリのストア配信（TestFlight）

DAY20（旅の足跡）の続きです。ログイン・音声認識までがDAY20、そこに有料プラン（Stripe決済）とiOSアプリとしての配信（TestFlight）を積み増したのがこのDAYです。セッションが長期間・複数回にまたがっているため、時間はほとんど「正確な計測不可」ですが、つまずきと解決の中身はできるだけ具体的に残します。

## 時間

| | |
|---|---|
| 開発開始 | 正確な計測不可（複数セッションにまたがる） |
| 開発終了 | 正確な計測不可 |
| 人間作業 | 正確な計測不可（Stripe・Apple Developer・App Store Connectでの手作業、スクリーンショットでの都度確認が多数） |
| AI実稼働 | 正確な計測不可。目安として、iOSアプリのビルド（GitHub Actions）だけで**17回**実行している |
| AI待機 | 正確な計測不可 |

AI実稼働にはユーザーの入力時間・回答待ち時間を含めません。正確に取れなかった項目は空欄にせず「正確な計測不可」と書きます。

## 使用モデル

| モデル | 作業内容 |
|---|---|
| Claude（Claude Code、本セッション） | Stripe決済の実装、iOSビルドの不具合調査・修正、アプリアイコンのデザイン、ドキュメント整理 |

## 使ったサービス・作ったアカウント一覧

動画の台本用に、今回新しく関わったサービスをまとめます。

| サービス | 何のために使ったか | 状態 |
|---|---|---|
| **Stripe** | 音声入力の有料プラン（ベーシック月300円／プレミア＋月1000円／回数券買い切り500円）の決済・サブスク管理 | **テスト（サンドボックス）モードのみ**。実際の課金は発生していない |
| **Apple Developer Program** | iOSアプリを実機・TestFlightで配信するための開発者登録 | 登録・本人確認済み（年額の費用が発生する契約。金額は別途ユーザー確認） |
| **App Store Connect** | アプリの登録、TestFlightでのテスター配布、ビルド自動署名用のAPIキー発行 | 登録済み。APIキー（Issuer ID・Key ID・秘密鍵）をGitHub Actionsのsecretsに登録 |
| **TestFlight** | ビルドしたiOSアプリを実機にインストールしてテストする仕組み | 内部テストグループを作成し、テスターとして自分を招待 |
| **GitHub Actions** | iOSアプリのビルド（Xcodeでのアーカイブ作成）とTestFlightへの自動アップロード | 既存のワークフローを17回実行してデバッグ |

（Cloudflare・Resend・独自ドメインhiroya-apps.netは、DAY20の続きの中で既に用意していたものをそのまま使っています）

## 費用

| 項目 | 金額 |
|---|---|
| AI利用料金 | 正確な計測不可（本セッションのClaude利用分） |
| Stripe | 0円（テストモードのみ。本番切り替え・実際の課金は未実施） |
| Apple Developer Program | 別途ユーザー確認（年額契約。このセッションでは新規購入していない） |
| その他 | 0円 |

## 実施作業

### Stripe決済の実装
- Cloudflare Worker側にfetch()でStripe REST APIを直接呼ぶ形で実装（npm SDKは使わず、既存のOpenAI連携と同じスタイル）
- Checkout Session作成（`POST /billing/checkout`）、Webhookでの`checkout.session.completed`処理、D1へのプラン・利用回数の保存
- 音声入力エンドポイントで、プランの月間上限・回数券の残数をチェックする仕組みを追加
- 解約導線が無かったため、Stripeのカスタマーポータル（`POST /billing/portal`）を追加。マイログ画面に「支払い方法の変更・解約はこちら」ボタンを設置
- 無料プランにも月2回＋新規登録時3回分のボーナス（初月だけ実質5回）を付与するよう変更

### iOSアプリのTestFlight配信
- 実機のUDID未登録が原因だった署名エラーを解消し、8回目のビルドでようやくTestFlightアップロードに成功
- ログイン（メールOTPのコード送信）がiOSアプリ内だけ失敗する不具合を、CapacitorHttpプラグイン経由のネイティブ通信に切り替えて解消
- 入力欄タップ時に画面が強制的にズームしてしまう不具合を、font-sizeを16px以上にすることで解消
- Stripe決済ページの作成がiOSアプリ内だけ失敗する不具合（`location.origin`が`capacitor://localhost`になり、Stripeが不正なURLとして拒否）を修正
- Stripeアカウント側の仕様変更（Managed Payments機能）で決済ページ作成が失敗する不具合を修正
- 決済ページがアプリ内で完結せずSafariに飛び出してしまう不具合を、`capacitor.config.json`の`allowNavigation`設定で解消
- 旅行の共有リンクをアプリ内でコピーすると`capacitor://localhost`という他人には開けないリンクになる不具合を修正
- 本番用のアプリアイコン（開いた本から足跡が飛び出すモチーフ、明るい黄色系）を新規デザインして差し替え

## エラー・つまずき

- iOSの自動署名が「Your team has no devices from which to generate a provisioning profile」で7回連続失敗。原因の切り分けに、コマンドライン引数の変更・プロジェクトファイルの書き換え・APIキー権限の変更など複数の仮説を順に試したが、最終的な原因は「実機のUDIDをApple Developerアカウントに1台も登録していなかったこと」という、エラーメッセージが最初から示唆していたシンプルな内容だった
- ログインコード送信の失敗原因を`wrangler tail`で調査した際、「OPTIONS（プリフライト）は届くが本体のPOSTが届かない」という状態が続き、CapacitorHttpプラグインを有効化しただけでは解決しなかった。実際にはfetch()の自動差し替えが効いておらず、`window.Capacitor.Plugins.CapacitorHttp.request()`を明示的に呼ぶコードに書き換えて初めて解決した
- Stripeの決済ページ作成エラー（`upstream_error`）を`wrangler tail`で追いかけたところ、Stripeアカウント側の「Managed Payments」という機能がデフォルトで有効になっており、こちらが指定していた`automatic_tax: false`と衝突していたことが判明。Stripe側の仕様変更に途中で気づかされた形
- 同じ不具合を何度直しても直らず、最終的に判明した原因は「ユーザーのPCのgit操作が、pushしているブランチ（main）とは別の古いブランチのままで、`wrangler deploy`が毎回古いコードをデプロイし続けていた」こと。修正が一度も反映されていなかった
- 「入力欄をタップするとズームしたままになる」不具合を、最初はWKWebViewのズーム状態の持ち越しだと誤診断し、ズーム自体を無効化する対症療法をした。実際の原因は特定のCSS（`.email-login-form input`のfont-size）が16px未満だったことで、後から見つかった

## 解決方法

- iOSの署名エラーは、Windows用の公式「Apple Devices」アプリでiPhoneのUDIDを取得し、Apple Developerアカウントに登録することで解決した
- ログイン不具合は、fetch()の自動差し替えに頼らず、`window.Capacitor.Plugins.CapacitorHttp.request()`を明示的に呼ぶ実装に変更して解決した
- Stripeの決済エラーは、`automatic_tax`パラメータ自体を送らない形に変更して回避した
- 古いブランチにデプロイし続けていた問題は、ローカルの未コミット差分（データベースID）を安全に退避（`git stash`）した上で正しい`main`ブランチへ切り替え、差分を戻すことで解決した
- ズームの不具合は、原因になっていたCSSのfont-sizeを16px以上に直すことで根本解決した

## 今日できるようになったこと

- Cloudflare WorkerからStripeのREST APIを直接呼んで、サブスク決済・Webhook処理・解約導線までを一通り実装する
- `wrangler tail`でリアルタイムログ（Originヘッダー・レスポンスステータス・Stripeのエラー本文）を見ながら、CapacitorのCORS制約・Stripe側の仕様変更という2種類の別々の原因を切り分ける
- CapacitorのWKWebViewが抱える複数の既知の制約（クロスオリジンPOSTの制約、外部ドメインへのナビゲーションがSafariに飛ぶ、入力欄タップ時の強制ズーム）を、それぞれ違う仕組み（CapacitorHttp・allowNavigation・font-size）で解決する
- Apple Developerの実機登録から、GitHub Actionsでの自動署名・TestFlightアップロードまで、iOSアプリを実機に配信する一連の流れを組み立てる
- AI（ヘッドレスブラウザでのSVGレンダリング）で本番用のアプリアイコンをデザインし、iOSのアイコン生成パイプラインに組み込む

## 今日の動画で使えるポイント

1. 「エラーメッセージが最初から答えを言っていた」典型例（実機未登録）に、複数の仮説を順に試してからようやくたどり着いた過程はそのまま動画になる
2. 同じ修正を4〜5回試しても直らなかった原因が、実はコードではなく「ユーザーのPCが違うブランチにいた」という開発環境側の問題だった、という切り分けの難しさが伝わる場面
3. 「Safariに逃げるのを直したら、逆にAppleの審査的にはリスクが増えた」という、1つの不具合を直すと別の問題（ストアポリシー）が見えてくる展開
4. Stripe側の仕様変更（Managed Payments）に、こちらは何もしていないのに急にエラーが出るようになった、外部サービス側の変化に振り回される実例

## DAY RESULT

```
DAY 26 RESULT
アプリ：旅の足跡
人間：正確な計測不可
AI：正確な計測不可（iOSビルドは17回実行）
費用：0円（Stripeはテストモードのみ。Apple Developer Programの年額費用は別途確認）
今日できるようになったこと
・Cloudflare WorkerからStripeを直接呼ぶサブスク決済・解約導線の実装
・CapacitorのWKWebView特有の制約（CORS・Safari誘導・強制ズーム）を切り分けて解決
・Apple Developerの実機登録からTestFlight配信までの一連の流れ
つまずいたこと
・iOS署名エラーの原因が「実機UDID未登録」という単純な内容にたどり着くまで7回失敗
・修正が反映されない原因が、実はユーザーのPCが違うブランチのままだったこと
・Stripe側の仕様変更（Managed Payments）に途中で気づかされた
あと4 apps
```
