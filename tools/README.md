# 会話ログの書き出し

Claude Code との会話を、記事に貼れる Markdown にして Zip にまとめる道具。

```
python3 tools/export-claude-logs.py --list      # 何が残っているか見る
python3 tools/export-claude-logs.py             # 全部を Zip に出す
```

Python 3 だけで動く。追加のインストールは要らない。

## どこのログを読むのか

Claude Code は端末で動かしたセッションの生ログを

```
~/.claude/projects/<作業場所のパスを - に潰したもの>/<セッションID>.jsonl
```

に残している。この道具はそれを読む。**まず `--list` を叩いて、書き出せる会話が
あるかを確かめること。** 何も出てこないなら、その端末にログが無いということ。

クラウドで動かしたセッション（デスクトップアプリや claude.ai/code から開いたもの）は
入れ物ごと片付けられるので、手元のディスクにログは残らない。その場合は
claude.ai/code で当のセッションを開いて読むしかない。

## よく使う形

記事の下書きにするなら、道具の呼び出しを落とすと会話だけが残って読みやすい。

```
python3 tools/export-claude-logs.py --no-tools --out note-draft.zip
```

期間やプロジェクトで絞る。

```
python3 tools/export-claude-logs.py --project my-app --since 2026-08-25
```

## 指定できるもの

| 指定 | すること |
|---|---|
| `--list` | 書き出さず一覧だけ見る |
| `--project 名前` | 作業場所の名前で絞る（部分一致） |
| `--session ID` | セッションIDの頭で絞る |
| `--since` / `--until` | `YYYY-MM-DD` で期間を絞る |
| `--no-tools` | 道具の呼び出しと結果を落とす |
| `--thinking` | Claude の思考も含める |
| `--sidechain` | サブエージェントの会話も含める |
| `--raw` | 元の `.jsonl` も同梱する |
| `--max-chars N` | 道具の入出力の上限文字数（既定 2000、`0` で無制限） |
| `--out` | 出力する Zip の名前 |
| `--root` | ログの置き場を変える（既定 `~/.claude/projects`） |

## Zip の中身

```
index.md                       セッションの一覧表
sessions/20260903-0355-f5e2b95f.md    1セッション1ファイル
raw/<セッションID>.jsonl        --raw を付けたときだけ
```

各セッションの Markdown は、日時・作業場所・ブランチ・発言数を頭に置いてから
やりとりを順に並べる。道具の呼び出しと結果は `<details>` で畳んであるので、
読むときは会話だけが目に入り、必要なところだけ開けばいい。

## 気をつけること

ログには**打ち込んだものが全部入っている**。環境変数、鍵、他人の名前、
とりあえず貼り付けたファイルの中身。公開する前に一度は目を通すこと。
