# おもいでWiki AI Worker

OpenAI APIキーをブラウザへ公開せず、インタビューの回答内容に応じた追加の深掘り質問を1つ作って返すCloudflare Workerです。DAY05のドラマ王Workerと同じ構成ですが、個人的な回答を扱うため**キャッシュはしません**（レート制限のみ）。

## 公開

```sh
cd apps/day18-omoide-wiki/worker
npx wrangler secret put OPENAI_API_KEY
npx wrangler deploy
```

DAY05のドラマ王Workerと同じOpenAI APIキーを使い回せます（同じ `wrangler secret put` を、このWorkerに対しても一度実行するだけです）。

公開できたら、公開されたURL（`https://omoide-wiki-ai.<あなたのサブドメイン>.workers.dev` の形）を `../index.html` の `omoide-ai-endpoint` メタタグの `content` に設定してください。空のままなら、AI深掘り機能はアプリ側で自動的に無効化され、通常の固定質問インタビューだけで動きます。

公開URLは `https://omoide-wiki-ai.hiroya-apps.workers.dev` です（2026-09-11 公開）。`../index.html` の `omoide-ai-endpoint` メタタグに設定済みです。

## AIでまとめる（compose）

このWorkerはもう1つ、`action: "compose"` を付けたリクエストで「一問一答の生の回答を、Wikipedia記事のような自然な文章に書き直す」エンドポイントも兼ねています（新しいWorkerを増やさず、同じキャッシュなし・レート制限つきの構成を使い回しています）。回答に書かれていない事実を創作しないこと、三人称のWikipedia文体に整えることを厳守するよう指示しています。

## 質問の読み上げ（Gemini TTS）

`action: "tts"` を付けたリクエストで、インタビューの質問文を Google AI Studio の Gemini TTS で読み上げた音声（WAV）を返します。ブラウザ標準の読み上げより自然な声にするためのものです。

```sh
cd apps/day18-omoide-wiki/worker
npx wrangler secret put GEMINI_API_KEY   # Google AI Studioで作ったキーを貼り付ける
npx wrangler deploy
```

- モデルは `wrangler.jsonc` の `GEMINI_TTS_MODEL`（初期値 `gemini-3.8-flash-lite-tts`）、声は `GEMINI_TTS_VOICE`（初期値 `Sulafat`）で変えられます。コードを直す必要はなく、書き換えて `npx wrangler deploy` し直すだけです
- 声の名前がモデル側で使えなかった場合は、声の指定なしで1回だけやり直します
- 1回に読み上げるのは400文字まで。読み上げだけ別枠で、接続元ごとに1分30回までのレート制限をかけています
- `GEMINI_API_KEY` が未登録のときは503を返し、アプリはブラウザ標準の読み上げに自動で戻ります
- Geminiは音声を生のPCMで返すことがあるため、Worker側でWAVに包んでから返しています

費用の目安（2026年9月時点、第三者の記事による。公式の料金ページで確認してください）：Flash-Lite TTSは出力音声100万トークンあたり6ドル（2027年1月から12ドル）。音声1秒＝25トークンなので、質問1つ（約6秒・150トークン）でおよそ0.14円、100問でおよそ14円です（1ドル＝150円で計算）。

## 深掘りの作り方

質問を丸投げでAIに作らせるのではなく、「深掘りの観点（日時・場所、一緒にいた人、そのときの気持ち、きっかけ、印象的な言葉、その後の変化、細かい情景、他にも似たことがあったか）」をあらかじめ決めておき、**その中から今の回答にとって一番ネタになりそうな観点をAIに選ばせて**質問を作らせています。完全に自由な深掘りにすると話が散らかりやすいため、聞く材料はこちらで決め、「どれを深掘りするか」だけをAIに判断させる形にしました。

## 費用を抑える仕組み（ただし「費用がかかってもしっかり深掘りしたい」という要望を優先しています）

- 個人の回答はキャッシュしません（使い回す意味がないため）
- 接続元ごとに1分10回までのレート制限
- 出力トークンの上限を800に制限し、返す内容も「追加質問1つ」だけに絞っている
- フロント側で1つの話題につき深掘りは最大6往復までに制限（Worker側が`done`を返さなくても、フロントが強制的に打ち切ります）
- 質問の質を優先し、モデルの reasoning effort は medium（DAY05のドラマ王と同じ水準）にしています。安さより深掘りの質を優先したい場合の設定です

OpenAI APIキーは `wrangler.jsonc` の通常変数へ書かず、必ず `OPENAI_API_KEY` secretとして登録してください。
