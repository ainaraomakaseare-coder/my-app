# 投稿卓 NEO

Instagram / YouTube / X / TikTok への投稿を1か所で登録し、**指定した日本時間になったら
クラウド側が自動で投稿する**アプリ。**自分のPCは閉じていて構いません。**

DAY8 の「投稿卓」（自分のPCの中だけで動くローカルアプリ）をクラウドへ引っ越したもの。

## 何が変わったか

| | DAY8 投稿卓 | DAY11 投稿卓 NEO |
|---|---|---|
| 動く場所 | 自分のPC（`127.0.0.1`） | クラウド（Vercel + Supabase） |
| 予約投稿 | **アプリを起動している間だけ** | **PCを閉じていても動く** |
| データ | `data/posts.json`（PCの中） | Postgres |
| 動画・画像 | `data/media/`（PCの中） | Supabase Storage |
| 公開URL | Cloudflare トンネル（**起動のたびに貼り直し**） | 署名付きURL（**貼り直し不要**） |
| ログイン | 不要（自分しか触れないため） | **合言葉が必須**（世界中からURLを叩けるため） |
| 対応SNS | Instagram のみ実投稿 | **4つすべて実投稿** |
| 投稿先の単位 | SNS | **アカウント**（同じSNSに複数繋げる） |

## 仕組み

```
[ブラウザ] ──合言葉──> [Vercel] 画面・投稿処理
                          ↕
                     [Supabase] DB ＋ 動画置き場
                          ↑
        毎分「時間ですよ」と叩く（Supabase Cron）
                          ↓
      [Instagram] [YouTube] [X] [TikTok]
```

**時計係と作業係を分けている**のがこの設計の要点です。Vercel の無料プランのタイマーは
1日1回しか鳴らせないため、「毎分の見張り」だけを Supabase に任せています。

### 予約時刻が来たときに起きること

```
20:00  コンテナを作る    → 「作った」と記録して終了
20:01  変換終わった？    → まだ → 終了
20:02  変換終わった？    → 終わった → 終了
20:03  公開する          → 成功
```

**1分に1手ずつ進めます。** クラウドのサーバーには実行時間の上限があるので、
動画の変換を待ち続けると途中で切られてしまいます。どこまで進んだかを毎回 DB に
書いておくので、途中で落ちても次の1分が続きからやり直します。

### 同じ投稿を二度送らない仕組み

仕事を取るのは、この SQL 1文だけです。

```sql
update post_targets
   set status = 'processing', claimed_at = now(), attempt = attempt + 1
 where id = $1 and status = 'queued'      -- queued のときだけ更新される
returning *;
```

「探す」と「取ったと記録する」が同じ1文で起きるため、2つの処理が同時に来ても
**勝てるのは必ず片方だけ**です。返り値が空なら、もう片方が先に取ったということ。

さらに保険が3つあります。

1. `unique (post_id, network)` — 同じ投稿×同じSNSの行は物理的に2つ作れない
2. 外部IDを**送る前に**保存する — 途中で落ちても作り直さず、続きから
3. `processing` のまま10分動かない行は `queued` に戻す（失敗回数は増えたまま）

### 同じSNSに複数のアカウントを繋げる

投稿先の単位は「SNS」ではなく「連携アカウント」です。企画用とアフィリエイト用の
ように、同じ Instagram でも別々のアカウントとして扱えます。

```
☑ Instagram（企画用）
☐ Instagram（アフィリ用）
☑ YouTube（30日30アプリ）
☐ X（@hiroya_ainara）
```

接続したときに SNS 側から表示名を取ってくるので、複数繋いでも画面で見分けられます。
同じアカウントを繋ぎ直したときは行が増えず、上書きされます。

### 失敗したアカウントだけ再実行する

状態は**アカウントごとに独立**しています。

```
Instagram（企画用）：成功   ← 触らない
YouTube            ：成功   ← 触らない
X                  ：失敗   ← これだけ queued に戻す
```

だから再実行を押しても、成功済みのSNSへ二重投稿されることはありません。
自動再試行は3回まで（1分 → 5分 → 15分）。それ以降は手動を待ちます。

### 日本時間がずれない仕組み

| 場所 | 扱い |
|---|---|
| 入力 | 日本時間で入力（`2026-09-01 20:00`） |
| 保存 | `+09:00` を明示して UTC に直す（`2026-09-01T11:00:00Z`） |
| 判定 | `scheduled_at <= now()` ——両辺 UTC なので比較が正しい |
| 表示 | `Asia/Tokyo` を明示して整形 |

PCは日本時間、Vercel は海外、Supabase は UTC とバラバラなので、
**ブラウザやサーバーの地域設定に一切頼らず**、変換を自分で書いています。

## SNSごとの到達点

| | 認証 | ファイルの渡し方 | 今日できること | 料金 |
|---|---|---|---|---|
| Instagram | トークン（60日） | **公開URLを渡す** | **公開投稿** | 無料 |
| YouTube | OAuth 2.0 | 再開可能アップロード | **非公開でアップロード** → Studio で公開 | 無料 |
| X | OAuth 2.0 (PKCE) | 分割アップロード | **公開投稿** | **1件 約2.3円** |
| TikTok | OAuth 2.0 | 分割アップロード | **アプリの下書きに届く** → アプリで公開 | 無料 |

**YouTube と TikTok が最後まで自動にならないのは、こちらの実装の都合ではありません。**

- YouTube は、監査を通るまで API 経由の動画が非公開に固定されます
- TikTok は、審査前のアプリに `video.publish`（直接投稿）を提供せず、
  `video.upload`（下書き送信）だけが使えます

TikTok の下書き方式では、仕様上キャプションを一緒に送れません。
アプリに登録した TikTok 用の本文は履歴に残るので、公開時にそこからコピーします。

**X だけは `media.write` の権限が別途必要**です。よく紹介される4つの権限だけだと、
テキストは投稿できるのに動画で 403 になります。

## 準備

### 1. Supabase

1. プロジェクトを作る（リージョンは Tokyo）
2. SQL Editor で [`supabase/schema.sql`](supabase/schema.sql) を実行
3. Storage で **`media`** バケットを作る（**Public は OFF**）
4. 拡張を入れる

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
```

### トークンの寿命

| 連携 | 仕組み | 画面の表示 |
|---|---|---|
| YouTube / X / TikTok | 引換券（リフレッシュトークン）を持つので、入場券は自動で取り直す | **自動更新** |
| Instagram（長期） | トークン自体が60日もつ | 期限を表示 |
| Instagram（短期） | 交換できていないと1時間で切れる | 期限が不明と表示 |

Instagram を60日にするには `IG_APP_SECRET` が必要です。無くても短期トークンのまま動きます。

### 2. Vercel の環境変数

| Key | 中身 |
|---|---|
| `SUPABASE_URL` | `https://〇〇.supabase.co` |
| `SUPABASE_SERVICE_KEY` | secret / service_role キー |
| `APP_PASSWORD` | アプリに入るための合言葉 |
| `SESSION_SECRET` | ログイン状態の署名用（ランダムな文字列） |
| `CRON_SECRET` | Cron の入口の鍵（ランダムな文字列） |
| `IG_APP_SECRET` | Instagram の長期トークン交換用 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | YouTube |
| `X_CLIENT_ID` / `X_CLIENT_SECRET` | X |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | TikTok |

**環境変数は次のデプロイから効きます。** 追加したら再デプロイしてください。

### 3. 毎分の見張りを立てる

```sql
select cron.schedule(
  'toukoutaku-neo-worker', '* * * * *',
  $$
  select net.http_post(
    url     := 'https://〇〇.vercel.app/api/worker',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-key','＜CRON_SECRET＞'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
  $$
);
```

繋がったか確認：

```sql
select status_code, content from net._http_response order by created desc limit 3;
```

`200` なら成功。`401` は鍵違い、`404` はデプロイされているブランチ違い。

### 3-2. 毎晩の数字の取り込みを立てる

分析用です。フォロワー数や再生数を1日1回書き留めます。

```sql
select cron.schedule(
  'toukoutaku-neo-insights', '30 14 * * *',      -- 日本時間 23:30（UTC 14:30）
  $$
  select net.http_post(
    url     := 'https://〇〇.vercel.app/api/insights',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-key','＜CRON_SECRET＞'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 50000
  );
  $$
);
```

**★ cron の時刻は UTC です。** 日本時間の 23:30 は UTC の 14:30。
ここを間違えると、取り込みの時刻が9時間ずれます（動きはするので気づきにくい）。

**★ 23時台にしているのは、その日のぶんを取り切るためです。**
21時に投稿したものが、その日のうちにどれだけ伸びたかが残ります。

**★ どのSNSのAPIも「いまの値」しか返しません。** 履歴はくれないので、
毎日こちらで書き留めないと、あとから伸びは分かりません。
**始めた日より前のことは、永久に分かりません。** 早く立てるほど得です。

何度流しても壊れません（同じ日に2回動いても、行は増えず後の値で上書きされます）。
手で今すぐ1回動かしたいときは：

```sql
select net.http_post(
  url     := 'https://〇〇.vercel.app/api/insights',
  headers := jsonb_build_object('Content-Type','application/json','x-cron-key','＜CRON_SECRET＞'),
  body    := '{}'::jsonb,
  timeout_milliseconds := 50000
);
-- 少し待ってから
select status_code, content from net._http_response order by created desc limit 1;
```

`content` に、アカウントごとに何が取れたかが日本語で入っています。
取れなかったものは理由も入るので、権限の不足はここで分かります。

### 4. コールバックURL

各SNSの開発者画面に登録します。**クエリを付けない形**にしてあります
（Google・TikTok・X はクエリ付きのURIを弾くことがあるため）。

```
https://〇〇.vercel.app/api/connect/youtube
https://〇〇.vercel.app/api/connect/tiktok
https://〇〇.vercel.app/api/connect/x
```

## 秘密情報の扱い

- **コードには何も書かない。** 変数名だけが載ります
- 鍵は Vercel の環境変数、OAuth のトークンは DB の `sns_tokens`
- 全テーブルで RLS を有効にし、**許可ルールを1つも作っていない**
  （＝サービスロールキーを持つサーバー以外は1行も読めない）
- 動画のバケットは非公開。Instagram に渡すときだけ**2時間で切れるURL**を発行
- 画面に返すトークンは**先頭6文字だけ**
- ログにトークンを出さない
- `/api/worker` は秘密の鍵を持つリクエストしか受け付けない

## テスト

```
npm test
```

DAY8 から引き継いだ19件と、クラウド版の17件。ネットワークには出ません。
二重投稿の検証は、**同じ1分のうちに2回叩いて、各SNSへの呼び出しが1回きりであること**を
実際に数えています。

## まだできないこと

- YouTube / TikTok への**公開**投稿（どちらも審査待ち）
- カルーセル投稿、ストーリーズ
- 投稿の分析（いいね数など）
- 複数人での利用（合言葉は1つだけ）
- 他人のアカウントへの投稿（Meta / TikTok の審査が必要）
- 50MB を超える動画（Supabase 無料プランの上限）

## ローカル版（DAY8）

`server.js` は DAY8 のローカル版です。`node server.js` で今も動きます。
クラウド版は `api/` 以下と `lib/` を使います。
