# ベイ日記 iOS配信計画
同じApple Developerアカウントで、独立したアプリ com.hiroyaapps.baydiary を準備する。
既存Web版を同梱し、端末内の記録、分析、共有、JSON移行を維持する。
順序: 同梱ビルド → ネイティブ共有 → Xcode構成/CI → TestFlight実機検証 → 公開AI/課金 → App Store審査。
公開の完了条件は署名済みビルドの実機確認とApp Store審査提出。WindowsでのWeb検証だけで完了としない。
AI公開サーバー、課金、署名権限、ストア登録は未完。秘密鍵をアプリやGitに含めない。
