# Tripを自由記述の文字列ではなく、idを持つ実体にする

当初、EpisodeのTrip所属は`episode.trip`という自由記述の文字列で表現し、同じ文字列を持つEpisode同士を`groupEpisodesByTrip`でその場でグルーピングしていた。しかしユーザーから「エピソードは旅行の中のエピソードだから、階層としてはその持ち方にしてほしい」という指摘を受けた。

文字列マッチには実害もあった：表記ゆれ（全角/半角、末尾の年の有無など）で同じ旅行のはずが別グループに分かれる、旅行名を直したい時に全Episodeを個別に編集する必要がある、Episodeが1件もない旅行を先に作っておけない、など。

そこで`Trip`を`{id, title, createdAt, updatedAt}`を持つ実体にし、`wiki.trips`に保持。`episode.trip`（文字列）は`episode.tripId`（参照）に置き換えた。エピソード追加フォームは自由記述の入力欄のまま（`<datalist>`で既存の旅行名を補完するのみ）とし、保存時に`findOrCreateTrip`で名前が一致する既存Tripを探すか、無ければ新規作成してtripIdを解決する。UIの複雑化は避けつつ、データの持ち方だけを実体化した。

既存データ（`episode.trip`文字列のみを持つ旧形式）は`normalizeWiki`で読み込み時に自動移行する（同じ文字列は1つのTripにまとめ、`episode.trip`は削除する）。
