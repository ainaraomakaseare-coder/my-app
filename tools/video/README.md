# 動画の道具（tools/video）

縦型ショート動画を、顔の録画と設定ファイル（JSON）から作る。本人のPCで動かす道具で、
投稿卓（Vercel）には載らない（`vercel.json` は `api/*.js` と `public/` しか使わない）。

## 用意
- Node（arm64 ネイティブで確認）
- ffmpeg（winget の Gyan.FFmpeg。場所が違うときは環境変数 `FFMPEG` で指定）
- `npm install`（この道具の中だけ。`@huggingface/transformers` を使う。投稿卓本体には依存を足していない）
- 文字起こしのモデルは初回に `models/hf/` へダウンロードされる（無料・PCの中だけで動く）
- 作業は `work/<日>/` で（設定・切り出した画像・カード・字幕が並ぶ）。`node_modules/`・`models/`・`work/` は git に入れない

## 流れ
1. `node segments.mjs <顔の録画> work/<日>/segments.json` … 無音で区切って区間ごとに文字起こし。言い直しのテイクが分かる
2. 最後のテイクを選んで設定を書く（例は `examples/`）
3. `node make-video.mjs work/<日>/<日>.json --cards` … カードだけ作って見る
4. `node make-video.mjs work/<日>/<日>.json` … 書き出す
5. 書き出した動画を `segments.mjs` で聞き直し、余計な声が入っていないか確かめる → 本人に見せる

全体をまとめて起こしたいときは `node transcribe.mjs <動画> [出力] [--limit 秒]`。

## 設定の形
`make-video.mjs` の頭のコメントに全部書いてある。要点：

| キー | 意味 |
|---|---|
| `source` / `out` | 顔の録画 / 書き出し先 |
| `crop` | `{w,h,x,y}` 録画から縦 9:16 に切り抜く位置 |
| `padHead` / `padTail` | 切れ目の余白（既定 0.2 / 0.4 秒。本人の指摘で広めにした） |
| `header` | カードの見出し |
| `cards` | `shot`（画像・`box`）/ `list`（一覧）/ `clip`（画面録画・`from` `to` `speed` `blur`） |
| `segments` | `{from, to, lines: [[秒, 字幕], …], show, tel, joined}` |

`examples/` の設定は本人のPCのパスをそのまま残している（どう書いたかの見本）。

編集のルール（最後のテイクが正・専門用語を避ける・友達はぼかす など）は `docs/HANDOFF.md` の4章。
