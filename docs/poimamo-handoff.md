# ポイまも 引き継ぎ（2026-09-18）

- 対象：`apps/day24-poimamo/`。HTML単体＋Anthropic画像読み取り用Cloudflare Worker。
- 元の会話：https://claude.ai/code/session_01TnMgvURj11b2x4MZXc7Umn
- PR #35までの複数スクショ（最大6枚）、新規/更新レビュー統合、カレンダー連携を最新mainから取り込み済み。
- 作業ブランチ：`codex/poimamo-monthly-points`。
- 最新要望：「7月 ○ポイント」を失効月ごとの内訳として読み取る（ユーザー確認済み）。
- 変更：Workerの抽出結果に `expiryMonth` を追加。月末計算はフロント側。年不明時は月情報を確認画面と保存時のメモに残し、ユーザーが日付を入力する。月別行を合算・省略しない。獲得履歴は対象外。
- 検証：logic.test.js 106件、ui.smoke.js 57件が通過。AI APIはモックしており実画像の認識精度は未検証。
- 未完了：GitHub公開・Worker再デプロイ・実際に問題が起きたスクショでの確認。現時点ではローカル変更のみ。
- APIキーはWorker secret。ログや引き継ぎ資料に載せない。ポイント画像は保存・キャッシュしない。
- 全体企画の古い `docs/handoff.md` は他アプリの情報も含むため、ポイまもの再開では本資料と `docs/logs/day27.md` を優先する。
