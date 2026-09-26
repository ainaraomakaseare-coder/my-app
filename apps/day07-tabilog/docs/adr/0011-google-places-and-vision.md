# 場所の候補検索とレシート読み取りを、Google（Places API (New)・Cloud Vision）に切り替える

これまで場所の候補検索はNominatim・ウィキペディア・空港の組み合わせ（無料・APIキー不要）、レシート読み取りはOpenAI（音声入力と共通の利用回数の枠）を使っていた。オーナーがGoogle Cloudのプロジェクト・請求先アカウントを用意し、2026-09-26にAPIキー（Places API (New)とCloud Vision APIの2つだけに制限）を発行した。

**決めたこと**：
- **場所の候補検索**（`GET /places/search`、`searchPlaces`）：`GOOGLE_API_KEY`があるときは、まずPlaces API (New)のAutocomplete（`POST /v1/places:autocomplete`）を試す。返るのは`placeId`・名前・住所だけで座標は無いため、候補を「選択」した時点で新しい`GET /places/details`（`placeDetails`）を呼び、Place Details Essentials（`X-Goog-FieldMask: location,displayName,formattedAddress`。Pro以上のフィールドは足さない＝無料枠の単価を変えない）で座標を取る。Autocomplete〜Detailsの一連は`sessionToken`（クライアントが検索し直すたびに`crypto.randomUUID()`で新しく作る）でまとめ、Session Usageの範囲でAutocomplete分の無料枠を消費しないようにする。Googleが失敗した・0件だったとき、または`GOOGLE_API_KEY`が無いときは、これまでどおりNominatim・ウィキペディア・空港の予備に回る。Googleの結果はCache APIに置かない（利用規約が長期間のキャッシュを推奨していないため）。
- **レシート読み取り**（`POST /receipts/scan`、`scanReceipt`）：`GOOGLE_API_KEY`があるときはCloud Vision（`DOCUMENT_TEXT_DETECTION`、`imageContext.languageHints: ["ja"]`）で文字を読み取り、`parseReceiptText`（`worker/src/receipt-parse.js`）というルールベースの処理で品目（品目名・金額）に分ける。単価が安く無料枠もあるため、**音声入力・テキストメモと共有する利用回数の枠（`checkVoiceQuota`/`consumeVoiceQuota`）は消費しない**（無料プランでも使えるようになる）。Visionが失敗した・読み取れなかった・`GOOGLE_API_KEY`が無いときは、これまでどおりOpenAIに回す（そのときは今までどおり枠を消費する）。ログイン必須（`resolveEmail`）・`AI_RATE_LIMITER`はどちらの経路でも変えない。
- 返す形はどちらの機能も今までと同じ（場所の候補は`{name, address, lat, lng}`または`{name, address, placeId}`の配列、レシートは`{items: [{label, amount}]}`）にして、クライアント側の変更を最小限にする。

**無料枠（2026-09-26に公式ページで確認）**：

| API | 使うもの | 無料枠 | 超えたら |
|---|---|---|---|
| Places API (New) | Autocomplete Requests | 月1万回 | $2.83/1000 |
| Places API (New) | Place Details Essentials（location等） | 月1万回 | $5/1000 |
| Places API (New) | Autocomplete Session Usage | 無制限 | ― |
| Cloud Vision | DOCUMENT_TEXT_DETECTION | 月1,000枚 | $1.50/1000 |

無料枠を大きく超えないよう、GCP側のクォータでオーナーが1日の上限（例：Autocomplete 300/日、Place Details 300/日、Vision 30/日）と予算アラートを設定している。キーは2つのAPIだけに制限してあり、コード・GitHubには一切書かない（`npx wrangler secret put GOOGLE_API_KEY`）。

**見送ったこと**：
- Autocompleteの座標を候補一覧の時点で全件取得すること（Place Detailsの呼び出し回数が増え、無料枠を余計に消費するため。選ばれた1件だけ取る）。
- レシートの合計金額を別項目として返すこと（今のスキーマ・クライアントが品目の配列だけを使っているため、形を変えるとクライアント側の変更が増える。`parseReceiptText`内部では合計行を読み飛ばすだけで、値は使っていない）。
- Place Detailsのフィールドをlocation以外にも広げること（評価・営業時間などPro以上の単価になるフィールドは、今の機能（座標を地図URLに入れるだけ）には不要）。
