# 「行ったことある旅先」ページを新設し、日本地図・世界地図で訪れた場所を塗る

オーナー要望：マイログの「訪れた都道府県・国」（チップの一覧）を、地図で見られる専用ページに分ける。ホーム画面のアカウント行（清水・マイログ・ログアウト）に4つ目のリンク「行ったことある旅先」を足し、国内／海外の2タブで日本地図・世界地図を塗る（2026-09-28）。

**決めたこと**：

- **新しいAPIは作らない**。既存の`GET /mylog`が返す`places.details`（`prefectures`/`countries`、旅行ごとの外す/戻すが反映済み）をそのまま使う（`worker/src/visited-places.js`の`aggregateVisitedPlaces`）。ページを開くたびに`/mylog`を呼び直す（マイログ画面を経由しなくても単独で開ける）。
- **マイログからの移動**：マイログ画面にあった「訪れた都道府県・国」（総計・読み取り専用）セクションを丸ごと新しい`data-screen="visited"`へ移す。マイログには「参加した旅行」の各カード内チップ（外す・戻す操作つき、`renderMyLogTrips`／`tripPlaceChipsHtml`）だけが残る。
- **地図はタイル画像を使わないインラインSVG**。iOSアプリはCapacitorが静的ファイルを同梱するだけでオフラインでも動くべきで、OpenStreetMapタイルのような外部取得は不要・不向き（地図でふりかえる機能のLeaflet＋OSMタイルとは別の割り切り）。TopoJSONの座標をd3-geoで投影しSVGの`<path d>`に変換する。
- **ライブラリ**（`vendor/geo/`、すべてnpm経由でCDNを介さず取得。UMDビルドをそのまま使う）：
  - `d3-array` 3.2.4（ISC）… d3-geoが内部で使うAdder（面積計算の誤差抑制）・range・merge。d3-geoのUMDはブラウザ環境で「自分自身を第2引数として渡す」実装になっており、d3-arrayを**先に**読み込んでグローバルの`d3`にぶら下げておかないと`fitSize`などが壊れる（動作確認済み）。
  - `d3-geo` 3.1.1（ISC）… 投影（`geoConicConformal`／`geoNaturalEarth1`）と`geoPath`。
  - `topojson-client` 3.1.0（ISC）… TopoJSON→GeoJSONの`feature()`。
  - `i18n-iso-countries` 7.14.0（MIT）から、ISO 3166-1 numeric→alpha-2の対応表だけを`iso-numeric-alpha2.json`として抜き出して同梱（パッケージ全体は187言語分の名前データを持ち重いため、使うのは`codes.json`の対応表のみ）。
- **地図データ**：
  - 世界地図＝npm `world-atlas@2.0.2`の`countries-110m.json`（ISC。Natural EarthのデータをTopoJSON化したもの、idがISO 3166-1 numeric）。110m解像度のため、香港・マカオなど一部の小さな地域は単独の図形として含まれない（既知の制限）。
  - 日本地図＝GitHub `ricewin/simplify-japan-geojson`の`TopoJson/prefecture.json`（**CC BY 4.0**）を、`npx mapshaper -simplify 10% keep-shapes -clean`でこのアプリ用にさらに簡略化。47都道府県すべて`properties.nam_ja`を持ち、`worker/src/visited-places.js`の`JP_PREFECTURES`と綴りが完全一致することを確認済み（例：「大阪府」「東京都」「北海道」）。ページ下部にCC BY 4.0のクレジット表示（「地図データ: simplify-japan-geojson（ricewin、CC BY 4.0）」）を出す。
  - ファイルサイズ（`vendor/geo/`、合計約236KB。目標の300KB以内）：`countries-110m.json` 107,761B・`d3-geo.min.js` 36,329B・`d3-array.min.js` 17,204B・`japan-prefectures.topojson` 64,841B・`topojson-client.min.js` 7,169B・`iso-numeric-alpha2.json` 2,751B。各ライブラリ・データの出典とライセンス全文は`vendor/geo/LICENSE`にまとめた。
- **国名の突き合わせ**：`/mylog`が返す国名はすでにサーバー側（`canonicalCountry`）で正規化済み（例：「アメリカ」「韓国」）。世界地図側は、TopoJSONの各国のid（ISO numeric）→`iso-numeric-alpha2.json`でalpha-2→`Intl.DisplayNames(['ja'], {type:'region'})`で日本語の生名を得て、**同じ正規化ロジック**（`canonicalVisitedCountryName`、`app.js`に`VISITED_COUNTRY_ALIASES`として複製）にかけてから名前で突き合わせる（`buildCountryIsoIndex`）。2箇所のエイリアス表がずれると「マイログでは数えているのに世界地図では塗られない」国が出るため、直すときは両方（`worker/src/visited-places.js`の`COUNTRY_ALIASES`と`app.js`の`VISITED_COUNTRY_ALIASES`）を直す必要がある。`node`（このNode 24環境）・主要ブラウザとも`Intl.DisplayNames`はビルトインのICUデータで日本語ロケールに対応済みで、追加データの同梱は不要と確認した。
- **UI**：都道府県／国の一覧タップと、地図の塗られた領域タップの両方で同じ場所を選択状態にする（`state.visitedSel`、`setVisitedSelection`／`updateVisitedHighlight`）。選択すると一覧の行・地図の領域の両方をハイライトし、地図の上に小さなキャプション（場所名＋訪れた旅行名）を出す（「小さなポップオーバー」の要望を、独立した吹き出しUIではなくこの形で満たした。実装・スタイルが単純で、地図の再描画を伴わない）。
- **ヘッダー行**：アカウント行（`#accountRow`）に4つ目のリンクを足すと375px幅で折り返してしまうため、この行だけ`font-size`を12.5px→11pxに、`gap`を8px→6pxに詰め、名前（`#accountName`）・ログインを促す文言（`#loginPromptRow`のspan）に`text-overflow: ellipsis`を付けて必要なら省略記号で切るようにした（`.account-row`／`.account-row span`）。

**避けたこと**：地図データのプリミティブな塗り分けをタイル方式（Leaflet＋GeoJSON overlay）にすること（今回のLeafletはOSMタイルに依存しており、オフライン向きでない。地図でふりかえる機能とは目的が違うため、あえて別実装にした）。1MB超の高解像度データ（`countries-10m.json`や`prefecture.json`の生データ）をそのまま同梱すること（目標300KB以内に収まらないため、110m解像度・mapshaperでの簡略化を選んだ）。世界地図の全角の州・準州まで塗ること（このアプリの「国」はあくまで国単位で、`aggregateVisitedPlaces`も国単位でしか集計していない）。
