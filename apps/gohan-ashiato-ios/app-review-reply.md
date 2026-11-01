# ごはんの足跡：App Review への返信案（Guideline 4.3 Spam ／ 4.2.6、2026-10-31）

ビルド 1.0.0 (6) が「4.3 Spam（よくある食事記録アプリと区別がつかない）」「4.2.6（テンプレートや自動生成サービスで作ったアプリ）」で却下されました。

## おすすめの進め方

**返信だけで再審査を頼むのではなく、テレビの店・行きたいリストの入った新しいビルドを出し、その提出に返信を添えるのがおすすめです。**

- 却下されたビルド6は「写真で食事を記録する」機能だけで、Appleの言う「すでにたくさんある食事日記」にそのまま当てはまります。
- 今のmainには PR #198 の「テレビ」タブ（番組で紹介された581店を一覧・地図で見る）と「行きたい」タブが入っています。これは他の食事記録アプリにない機能で、返信で一番強く言えるところです。
- Appleは「大きな変更なしに再提出すると、また却下される」と書いています。ビルド6のまま返信しても、Q3（他のアプリにない価値）に答えられる中身が弱いです。

### 手順
1. 今のmainから新しいビルド 1.0.0 (22) をTestFlightへ上げる（10/31に済み）
2. 説明文・プロモーション用テキスト・スクリーンショットを「テレビで紹介された店を探す・行きたい店を貯める・行ったら記録」の順に作り直す（今は記録が先頭）
3. TestFlightで何人かに試してもらい、Q4に書ける感想を集める（**ここは実際の話しか書けません**）
4. バージョン1.0の「ビルド」を新しいものに差し替え、下の英文を「App Reviewに返信」と「App Reviewに関する情報 → メモ」の両方に入れて再提出

### 気をつけたいところ
- **Q6・Q7が一番の弱点です。** 同じアカウントの「旅の足跡」も「写真から日時と場所を入れて記録する」アプリで、Exifの読み取りコード・見た目・お店検索のサーバー（Worker）を共有しています。Appleは「旅の足跡の機能追加で足りるのでは」と見ている可能性があります。正直に書いたうえで、目的と使い方の違いをはっきり書く必要があります。
- 4.2.6 は「テンプレートや自動生成サービスで作ったもの」が対象です。ごはんの足跡は、ひろやさん自身がAIのコーディング支援を使いながら書いたアプリで、販売されているテンプレートや作成サービスは使っていません。ここは事実どおりに書きます。
- **［ ］の部分はひろやさんにしか分からないので、埋めるか削ってください。** 推測では書いていません。

---

## 返信文（英語）

```
Hello, and thank you for reviewing Gohan no Ashiato (ごはんの足跡). We have made significant changes in build 22 and would like to answer each question below.

1. What the app does and the problem it solves
Gohan no Ashiato helps people in Japan find restaurants that appeared on TV food and travel programs, keep a list of places they want to visit, and record their visits.
Many people see a restaurant on a TV program, think "I want to go there", and then forget the name or cannot find it again. The information is spread across each program's website, usually as a list of episodes, not as a map. The app solves this in three steps:
- The "テレビ" (TV) tab shows 581 restaurants that appeared on Japanese TV programs between November 2024 and October 2026 (such as "Burari Tochu Gesha no Tabi", "Machi Chuka de Yarouze" and "Yoshida Rui no Sakaba Horoki"), in a list and on a map. Users can filter by program and sort by distance from where they are now. Each restaurant shows the program name, the broadcast date, and links to the program's official page and the restaurant's own page. The list is collected only from each program's official website and is updated every week.
- The "行きたい" (Want to go) tab is the user's own list of places to visit. Users can add a restaurant from the TV list, search by name, or add their current location, and keep a note such as which program they saw it on. The list can be filtered by "nearest", "not visited yet" and "seen on TV".
- When the user visits, "行った記録をつける" opens a record form with the restaurant name and location already filled in. The record keeps the photo, date, time, dish, price, rating and notes. The app then marks the place as visited automatically, and the "お店" (Restaurants) tab shows how many times the user visited each place, their average rating and total spending.
All data is stored only on the device. No account is needed.

2. Intended users
People in Japan, mainly in their 30s to 60s, who watch TV food and travel programs and like eating out on weekends or during trips, especially at local, independent restaurants (small Chinese restaurants, izakaya and bars) rather than chains. They want to remember the places they saw on TV, find the ones near where they are today, and keep a simple diary of what they ate there.

3. What need it addresses that existing apps do not
- Restaurant review apps (such as Tabelog or Google Maps) are organized around ratings and reviews from other people. They do not tell users which restaurants appeared on which TV program, and users have to search for each name one by one.
- TV program websites list restaurants by episode, but do not offer a map, sorting by distance, or a way to save and track visits.
- Food diary apps only record meals the user has already eaten. They do not help users decide where to go next.
Gohan no Ashiato connects these three steps (discover on TV, save, record the visit) in one app, and shows TV-featured restaurants near the user's current location, which we have not found in other apps.

4. Beta testing
We did not run a public beta. I installed each build from TestFlight on my own iPhone and used it as an everyday user before submitting.
During this testing I found that the list of nearby restaurants did not appear when I added a record, so the suggestions could not be used. I fixed the server and the app so that nearby restaurants now appear reliably from the photo's location or the current location. This fix is included in build 22.

5. Standalone product or part of a suite
It is a standalone product. Our developer account also publishes other apps: Tabi no Ashiato (a travel diary), [Kansen Nikki (a diary for baseball games attended), Omoide Wiki, ...（公開中・審査中のアプリを書いてください）]. The closest one is Tabi no Ashiato, which records trips: the places visited during a trip, grouped by trip and shown on a map. Gohan no Ashiato is about everyday restaurants: finding places from TV programs, keeping a want-to-go list, and recording dishes, prices and ratings. Tabi no Ashiato has no TV restaurant list, no want-to-go list and no per-restaurant statistics, and Gohan no Ashiato has no trips.

6. Could it be an in-app purchase or feature of another app
We considered adding it to Tabi no Ashiato, but decided against it. Tabi no Ashiato is organized around trips (a start and end date, and places within each trip). Gohan no Ashiato is used every day near home, and is organized around restaurants and a want-to-go list. Putting both into one app would make both harder to use, and the users are different: many people who eat out every week do not keep travel diaries.

7. Shared code or assets with other apps on our account
Yes, some parts are shared:
- The code that reads the date, time and location from a photo's Exif data is the same as in Tabi no Ashiato.
- The small server that returns nearby restaurants and searches for a restaurant by name (on Cloudflare Workers, using the Google Places API) is shared with Tabi no Ashiato. The app sends only latitude and longitude, or the search text.
- The visual style (colors and layout) is similar to Tabi no Ashiato.
- Map display uses Leaflet and OpenStreetMap, as in Tabi no Ashiato.
The TV restaurant list, the want-to-go list, visit detection, the records with dishes, prices and ratings, the per-restaurant statistics, and all screens are specific to Gohan no Ashiato.

8. Shared code with third-party apps
No. Apart from standard open-source frameworks and libraries (Capacitor and Leaflet), the app does not use any third-party template, SDK or content library.

9. Created for a client or third party
No. The app was designed and developed by me, the account holder, as a personal project. I wrote the code myself with the help of an AI coding assistant. No commercial template or app generation service was used. The TV restaurant information comes from each program's official website, with links back to the source.

Thank you for your time.
```

## 日本語訳（自分用の確認）

```
1. アプリの内容と解決する問題
テレビのグルメ・旅番組で紹介された店を探し、行きたい店を貯め、行ったら記録するアプリです。
番組で見た店に「行きたい」と思っても、名前を忘れたり探し直せなかったりします。情報は番組ごとのサイトに回ごとに載っているだけで、地図ではありません。
・「テレビ」タブ：2024年11月〜2026年10月に放送された番組で紹介された581店を一覧と地図で見られる。番組で絞り込み、今いる場所から近い順に並べられる。番組名・放送日・番組の公式ページ・お店の公式ページを表示。番組の公式サイトだけから集め、毎週更新。
・「行きたい」タブ：自分の行きたい場所のリスト。テレビの店から、名前の検索で、今いる場所で足せる。どの番組で見たかなどのメモも残せる。「近い順」「まだ行ってない」「テレビで見た」で絞り込める。
・行ったら「行った記録をつける」で、店名と位置が入った記録フォームが開く。写真・日時・料理・値段・評価・メモを残す。行ったかどうかは自動で付き、「お店」タブで店ごとの回数・平均評価・合計金額が見られる。
データは端末内だけ。アカウント不要。

2. 対象
テレビのグルメ・旅番組を見て、週末や旅行で外食するのが好きな、日本の30〜60代くらいの人。チェーンより町中華や酒場など地元の個人店が好き。

3. 既存アプリにない点
・食べログやGoogleマップは他人の評価が中心で、どの番組に出た店かは分からず、1店ずつ名前で探すしかない。
・番組サイトは回ごとの一覧で、地図・近い順・行ったかの記録がない。
・食事記録アプリは食べた後の記録だけで、次にどこへ行くかは助けない。
「テレビで知る→貯める→行って記録」を1つにつなぎ、今いる場所の近くのテレビの店を出すアプリは見当たらない。

4. ベータテスト：（実際の内容を記入）

5. 単独か、シリーズか
単独のアプリ。同じアカウントに旅の足跡など。一番近い旅の足跡は「旅」を単位にした記録。ごはんの足跡は日常の店・テレビの店・行きたいリスト・料理と値段と評価。お互いにない機能がある。

6. 他のアプリの機能追加にできないか
旅の足跡に入れることも考えたが、旅（期間と、その中の場所）が単位のアプリに、毎日の外食と行きたいリストを入れると両方使いにくくなる。利用者も違う。

7. 自分の他のアプリと共有している部分
ある：写真のExif読み取りコード、近くの店・店名検索のサーバー（Cloudflare Workers、Google Places API）、見た目の雰囲気、地図（Leaflet・OpenStreetMap）。
テレビの店・行きたいリスト・行ったかの判定・料理と値段と評価の記録・店ごとの集計・全画面はごはんの足跡だけのもの。

8. 第三者のアプリとの共有：なし（CapacitorとLeafletなど標準のオープンソースのみ）

9. 依頼主などのために作ったか
いいえ。アカウントの持ち主である私が個人で企画・開発した。AIのコーディング支援を使いながら自分でコードを書いた。市販のテンプレートや自動生成サービスは使っていない。テレビの店の情報は番組の公式サイトから集め、出典へリンクしている。
```

## 提出前のチェック

- [ ] 新しいビルドに「テレビ」「行きたい」タブが入っていて、iPhone実機で開ける
- [ ] スクリーンショットの1枚目がテレビの店（地図）になっている
- [ ] 説明文とプロモーション用テキストがテレビの店・行きたいリストから始まる
- [ ] Q4・Q5の［ ］を実際の内容で埋めた（分からないところは削った）
- [ ] 「App Reviewに関する情報 → メモ」にも同じ英文を入れた
- [ ] Appのプライバシー：店名検索の文字を送るようになったので、「データの収集なし」のままでよいか確認（サーバーは保存しない）
- [ ] 「テレビの店は毎週更新」と書いているので、Settings → Actions → General の「Allow GitHub Actions to create and approve pull requests」がオンになっている
