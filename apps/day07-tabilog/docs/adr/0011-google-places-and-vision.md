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
| Places API (New) | Text Search Essentials（IDのみ。`places.id`だけのFieldMask） | 無制限 | ― |
| Cloud Vision | DOCUMENT_TEXT_DETECTION | 月1,000枚 | $1.50/1000 |

無料枠を大きく超えないよう、GCP側のクォータでオーナーが1日の上限（例：Autocomplete 300/日、Place Details 300/日、Vision 30/日）と予算アラートを設定している。キーは2つのAPIだけに制限してあり、コード・GitHubには一切書かない（`npx wrangler secret put GOOGLE_API_KEY`）。

**見送ったこと**：
- Autocompleteの座標を候補一覧の時点で全件取得すること（Place Detailsの呼び出し回数が増え、無料枠を余計に消費するため。選ばれた1件だけ取る）。
- レシートの合計金額を別項目として返すこと（今のスキーマ・クライアントが品目の配列だけを使っているため、形を変えるとクライアント側の変更が増える。`parseReceiptText`内部では合計行を読み飛ばすだけで、値は使っていない）。
- Place Detailsのフィールドをlocation以外にも広げること（評価・営業時間などPro以上の単価になるフィールドは、今の機能（座標を地図URLに入れるだけ）には不要）。

**2026-09-26 追記（地図でふりかえるの準備を速くする：座標のD1保存＋Google Text Search）**：

「地図でふりかえる」を開くたびに、記録の地図URLを毎回Nominatim・ウィキペディア等でre-geocodeしていたのを、1回だけで済むようにした。

- **座標をD1に保存する**（`worker/migrations/0020_entry_map_coords.sql`）：`entries`に`map_lat`・`map_lng`・`map_geocoded_url`（その座標がどの`map_url`に対するものか）・`map_geocoded_at`を追加した。トリップ・記録のAPIは、`map_geocoded_url`が今の`map_url`と一致するときだけ`mapLat`/`mapLng`を返す（リンクを編集したら一致しなくなり、古い座標を返さず調べ直す）。
- **記録の保存時に裏で計算**（`createEntry`/`updateEntry`）：地図URLが新規に付いた・変わった・まだ座標を求めていないときだけ、`ctx.waitUntil`で座標を裏計算してD1に書く（保存の返事は待たせない。予定の見出し=labelをヒントに使う）。判定は純粋関数`entryNeedsGeocode`（`worker/src/geo-decode.js`、`worker/test/geo-decode.test.mjs`で単体テスト）。
- **既存データの後追い保存**：`GET /geocode`に`entry=<entryId>`を付けて呼ぶと、座標が求まったとき、そのentryの`map_url`が今回のクエリ（`q`）と一致する場合だけD1に保存する（`entry`は`ent_`+32桁16進の形式でなければ無視。`isValidEntryId`で検証）。クライアント（`app.js`の`geocodeQueries`・`loadTripZones`）は、記録に`mapLat`/`mapLng`があればそれを直接使って`/geocode`を呼ばず、無ければ`&entry=`を付けて呼ぶ。端末のlocalStorageキャッシュはその次の層として残す。
- **Google Text Search（`GOOGLE_API_KEY`があるときだけ）**：座標もS2セルIDも無い、名前・住所だけの地図リンクは、Nominatimより先にPlaces API (New)のText Search Essentials（`POST /v1/places:searchText`、`X-Goog-FieldMask: places.id`のみ＝IDのみ・無料無制限のSKU）→ 候補の先頭1件だけPlace Details Essentials（`X-Goog-FieldMask: location`のみ）で座標を取る（`googleTextSearchPlace`）。キーが無い・失敗・quotaエラー・0件のときは、これまでどおりNominatim等のチェーンに回る。予定の見出し（hint）をたよりに探すときも同じ経路を使う。Googleの結果はCache APIに置かず、D1（entryの行）に保存する。
  **2026-09-27訂正**：以前はここに近くの場所（`nears`）による`locationBias`（半径50km）と`nearOk`ガードをかけていたが、実例（大阪旅行）で誤動作を確認したため外した。詳細は下の追記を参照。

**2026-09-27 追記（Google Text SearchのlocationBias/near guardを外す・古い座標の自動やり直し）**：

実例（大阪旅行）：「みなとみらい発」ブロック（横浜、その日は新幹線で大阪へ移動する行程）の地図URLが`https://www.google.com/maps/search/?api=1&query=赤レンガ倉庫`だったが、本番のDBには`mapLat/mapLng`として34.6517, 135.4366（大阪の同名の赤レンガ倉庫）が入っていた。原因は`geocodePlaceName`→`googleTextSearchPlace`が、near（同じ日の大阪のホテルなど）を`locationBias`としてGoogleに送っていたため、Text Searchが「近くにある」大阪の赤レンガ倉庫を1位にしてしまい、それを`nearOk`ガードが（近いので）そのまま通していたこと。

**決めたこと**：
- `googleTextSearchPlace`は`locationBias`を送らない（`nears`引数自体を廃止）。Googleの既定のランキング（知名度・関連度）は、有名なほう（横浜の赤レンガ倉庫）を正しく1位にするため、素直にTop1件を信用する。
- `geocodePlaceName`のGoogle Text Searchの結果には`nearOk`（近くの予定との距離ガード）を適用しない。near guard・タイブレークは、②以降のNominatim/ウィキペディアの予備チェーンにだけ残す（そちらは施設名の曖昧さがGoogleより大きく、近さによる足切りが引き続き有効なため）。
- **既存の誤った座標を自動的にやり直す**：`geo-decode.js`に`MAP_COORDS_VALID_SINCE = "2026-09-27T00:00:00Z"`を追加。`entryNeedsGeocode(oldMapUrl, geocodedUrl, newMapUrl, geocodedAt)`に第4引数`geocodedAt`を足し、`geocodedAt`が無い・`MAP_COORDS_VALID_SINCE`より前なら（URLが変わっていなくても）再取得が必要と判定する。`rowToEntry`（`worker/src/index.js`）も同じ基準で、`map_geocoded_at >= MAP_COORDS_VALID_SINCE`のときだけ`mapLat/mapLng`を返す（それより前のものは「まだ座標が無い」扱いにして、次の保存・再取得で上書きされるまでクライアントに古い座標を渡さない）。単体テストは`worker/test/geo-decode.test.mjs`。
- キャッシュキーを1つ進めた：サーバーの`/geocode`のCache APIキーを`v7`→`v8`、クライアントの`GEOCODE_CACHE_KEY`（localStorage）を`tabilog:geocode-cache-v7`→`-v8`にし、古いバージョンのキーは読み込み時に削除する。

反映手順（**wrangler deployより先に**本番環境で1回だけ実行すること。逆順だと記録の保存がSQLエラーになる）：

```sh
npx wrangler d1 execute tabilog-db --remote --file migrations/0020_entry_map_coords.sql
```
