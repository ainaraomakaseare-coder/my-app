# テレビの店の取得テスト用の断片

`scripts/collect-tv-shops.mjs` の解析部分を確かめるための、番組の公式ページの**形だけ**を写した断片です（2026-10-29に見たページの構造）。
店名・住所・放送日などの事実だけを残し、番組の説明文はテスト用の短い文に置き換えています。画像は入れていません。

- `sakaba_shop_list.xml` … BS-TBS 吉田類の酒場放浪記の店リスト（`/sakaba/map/xml/shop_list.xml`）
- `sakaba_shop_1325.html` … 同じく各店のページ（本命の店と「立ち寄り」の店に住所がある）
- `onnasakaba_shop_628.html` … おんな酒場放浪記の各店ページ（説明文の中に「立ち寄り」という言葉がある回）
- `machichuka_shop.xml` / `machichuka_store_0430-02.html` … 町中華で飲ろうぜの店リストと店のページ
- `burari_articles.js` … 日本テレビ ぶらり途中下車の旅の記事データ（`/burari/articles.js`）
