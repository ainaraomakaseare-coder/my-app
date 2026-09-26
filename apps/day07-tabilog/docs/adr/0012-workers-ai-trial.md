# OpenAIからCloudflare Workers AIへの切り替えを試す（比較のみ、まだ切り替えない）

このアプリで唯一AIを呼び出す機能（音声の文字起こし・メモの整理）は、これまでOpenAI（Whisper・Responses API）だけを使ってきた。Workerは元々Cloudflare上で動いているため、同じCloudflareのWorkers AIに切り替えれば、無料枠（Neurons）の範囲で使える可能性がある。ただし精度・レイテンシがOpenAIと同等かは試していないため、**まず本番を切り替えず、管理者だけが結果を見比べられる試作を用意した**（2026-09-26）。

**決めたこと**：
- 管理者専用の `POST /ai-compare` を追加した。Workerのシークレット `AI_COMPARE_TOKEN` を設定していない、またはヘッダー `x-compare-token` が一致しないときは、機能が存在しないかのように **404** を返す（403にすると「有効なエンドポイントがある」ことを教えてしまうため）
- `mode=memo`：メモ整理のプロンプト・JSONスキーマ（`voicePrompt`/`multiDayPrompt`・`voiceBlocksSchema`/`multiDayBlocksSchema`。既存のOpenAI用の処理と完全に同じ関数を再利用）を使い、OpenAI（既存の`organizeTextIntoBlocks`）と、Workers AIの2モデル（`@cf/qwen/qwen3-30b-a3b-fp8`・`@cf/openai/gpt-oss-120b`）を並行で呼び、結果と所要時間（ms）を返す
- `mode=voice`：既存のWhisper（OpenAI、`whisper-1`）と、Workers AIの `@cf/openai/whisper-large-v3-turbo` の両方に同じ音声を渡し、文字起こしと所要時間を返す
- 何も保存しない・D1やR2に一切書き込まない・利用者の音声やテキストの内容はログに出さない（エラー時もエラー種別だけを記録する）
- 本番の`createBlocksFromVoice`・`createBlocksFromText`・`createBlocksFromMemo`・`createBlocksFromVoiceMultiDay`・`createBlocksFromTextMultiDay`・`scanReceipt`は一切変更していない（今までどおりOpenAI/Google側を使う）。利用回数の枠（`checkVoiceQuota`/`consumeVoiceQuota`・`PLAN_MONTHLY_LIMIT`・`MEMO_MONTHLY_LIMIT`）も変えていない

**Workers AIの無料枠・単価（2026-09-26に公式ページで確認）**：

| 項目 | 内容 |
|---|---|
| 無料枠 | 全プラン共通で1日1万Neurons |
| 超えたら | 1,000 Neuronsあたり$0.011 |
| `@cf/openai/whisper-large-v3-turbo` | 音声1分あたり約46.63 Neurons（約$0.0005/分） |
| `@cf/qwen/qwen3-30b-a3b-fp8` | 入力$0.051/M・出力$0.335/M |
| `@cf/openai/gpt-oss-120b` | 入力$0.35/M・出力$0.75/M |

参考として`@cf/meta/llama-3.3-70b-instruct-fp8-fast`も候補に挙がったが、今回の比較エンドポイントでは日本語の構造化出力の精度を優先して上記2モデル（qwen3-30b・gpt-oss-120b）に絞った。モデルIDはCloudflareのモデル一覧ページ（`https://developers.cloudflare.com/workers-ai/models/`）で確認できたが、各モデルの入力スキーマの詳細（`response_format`のJSON Schema対応の有無など）は個別ページのリンク先スキーマファイルまでは確認できておらず未検証。そのため`organizeTextIntoBlocksWithWorkersAi`では、まず`response_format: { type: "json_schema", ... }`付きで呼び、失敗したら「JSON以外を返さないこと」という指示だけを足したプロンプトで再試行し、それでもJSONとして読めない出力はコードブロック記法（```json）も含めて防御的にパースする実装にしている。

**今後の判断の進め方**：
1. 実際に運用中の音声・メモをいくつか使って（本人の同意のもと、または自分自身のテストデータで）`/ai-compare`の結果を見比べる
2. 精度が十分（OpenAIと大きく変わらない）なら、無料プランのユーザーだけ先にWorkers AIに切り替える案を検討する（有料プランは当面OpenAIのまま様子を見る）。無料プランの月間上限（`PLAN_MONTHLY_LIMIT.free`・`MEMO_MONTHLY_LIMIT.free`）も、Workers AIの方が安ければ増やせる可能性がある
3. Workers AIの呼び出しが失敗したときはOpenAIにフォールバックする方針にする（呼び出し順を「まずWorkers AI、失敗したらOpenAI」にし、失敗時だけ今までどおり回数の枠を消費する、という`docs/adr/0011`のGoogle Vision切り替えと同じパターンを踏襲する想定）
4. 上記が固まってから、本番の`createBlocksFromVoice`等を実際に切り替えるASDR（この0012の続き、または新しいADR）を書く

**見送ったこと**：
- 本番エンドポイントの切り替え自体（この試作はあくまで比較のためだけ）
- 3モデル目以降（`llama-3.3-70b-instruct-fp8-fast`等）を`/ai-compare`に含めること（比較対象を絞ってまず2モデルで様子を見る）
- レシート読み取り（Vision）のWorkers AI版（今回のスコープは音声・メモの整理のみ）
