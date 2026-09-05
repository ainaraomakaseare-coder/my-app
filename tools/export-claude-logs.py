#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Claude Code の会話ログを読める Markdown にして Zip にまとめる。

Claude Code はセッションごとの生ログを
    ~/.claude/projects/<パスを - に置き換えたもの>/<セッションID>.jsonl
に JSON Lines で残している。そのままでは記事に使えないので、
発言を人間の読む順に並べ直し、道具の呼び出しは折りたたんで書き出す。

    実行: python3 tools/export-claude-logs.py --list
          python3 tools/export-claude-logs.py --project my-app
"""

import argparse
import datetime as dt
import json
import os
import re
import sys
import zipfile

HOME_PROJECTS = os.path.expanduser("~/.claude/projects")

# 会話には出さない裏方の差し込み
SYSTEM_REMINDER = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)


# ---- 読み込み --------------------------------------------------------------

def find_logs(root, project=None, session=None):
    """~/.claude/projects の下から .jsonl を集める。"""
    if not os.path.isdir(root):
        return []
    found = []
    for encoded in sorted(os.listdir(root)):
        d = os.path.join(root, encoded)
        if not os.path.isdir(d):
            continue
        # ディレクトリ名は cwd の / を - に潰したもの。my-app のような
        # 元からハイフンを含む名前は戻せないので、目安として持つだけにして
        # 本当の作業場所はログ本文の cwd から拾う。
        cwd = "/" + encoded.strip("-").replace("-", "/")
        if project and project.lower() not in encoded.lower():
            continue
        for name in sorted(os.listdir(d)):
            if not name.endswith(".jsonl"):
                continue
            sid = name[:-6]
            if session and not sid.startswith(session):
                continue
            found.append({"path": os.path.join(d, name), "id": sid, "cwd": cwd})
    return found


def read_entries(path):
    """壊れた行は黙って飛ばす。書きかけで落ちたセッションがあるため。"""
    out = []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
    return out


def parse_ts(s):
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone()
    except ValueError:
        return None


# ---- 中身の取り出し --------------------------------------------------------

def clean(text):
    text = SYSTEM_REMINDER.sub("", text or "")
    return text.strip()


def blocks_of(entry):
    """message.content を必ずブロックの一覧にして返す。"""
    msg = entry.get("message") or {}
    content = msg.get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict)]
    return []


def fence(text, lang=""):
    """中に ``` があっても壊れないよう囲いを伸ばす。"""
    longest = max([len(m) for m in re.findall(r"`+", text or "")] or [0])
    bar = "`" * max(3, longest + 1)
    return bar + lang + "\n" + (text or "") + "\n" + bar


def cut(text, limit):
    if limit <= 0 or len(text) <= limit:
        return text
    return text[:limit] + "\n… (以下 %d 文字省略)" % (len(text) - limit)


def tool_head(name, inp):
    """道具の呼び出しを一行で表す。"""
    if not isinstance(inp, dict):
        return name
    for key in ("description", "file_path", "path", "pattern", "command", "prompt"):
        v = inp.get(key)
        if isinstance(v, str) and v.strip():
            v = " ".join(v.split())
            return "%s · %s" % (name, v[:80])
    return name


def tool_body(name, inp, limit):
    if not isinstance(inp, dict):
        return ""
    if name == "Bash" and "command" in inp:
        return fence(cut(str(inp["command"]), limit), "bash")
    dumped = json.dumps(inp, ensure_ascii=False, indent=2)
    return fence(cut(dumped, limit), "json")


def result_text(block, limit):
    c = block.get("content")
    if isinstance(c, str):
        text = c
    elif isinstance(c, list):
        parts = []
        for b in c:
            if isinstance(b, dict) and b.get("type") == "text":
                parts.append(b.get("text") or "")
            elif isinstance(b, dict) and b.get("type") == "image":
                parts.append("(画像)")
        text = "\n".join(parts)
    else:
        text = ""
    return cut(clean(text), limit)


# ---- Markdown に組み直す ---------------------------------------------------

def render_session(entries, meta, opts):
    lines = []
    names = {}  # tool_use_id -> 道具の名前

    started = meta["started"]
    ended = meta["ended"]
    lines.append("# %s のセッション" % (started.strftime("%Y-%m-%d %H:%M") if started else "日時不明"))
    lines.append("")
    lines.append("- セッションID: `%s`" % meta["id"])
    lines.append("- 作業場所: `%s`" % meta["cwd"])
    if meta["branch"]:
        lines.append("- ブランチ: `%s`" % meta["branch"])
    if started and ended:
        mins = int((ended - started).total_seconds() // 60)
        lines.append("- 時間: %s 〜 %s（%d分）"
                     % (started.strftime("%H:%M"), ended.strftime("%H:%M"), mins))
    lines.append("- 発言: あなた %d / Claude %d" % (meta["n_user"], meta["n_asst"]))
    lines.append("")
    lines.append("---")
    lines.append("")

    for e in entries:
        kind = e.get("type")

        if kind == "summary" and e.get("summary"):
            lines.append("> **これまでの要約**: %s" % clean(str(e["summary"])))
            lines.append("")
            continue

        if kind not in ("user", "assistant"):
            continue
        if e.get("isMeta"):
            continue
        if e.get("isSidechain") and not opts.sidechain:
            continue

        ts = parse_ts(e.get("timestamp"))
        stamp = ts.strftime("%H:%M") if ts else ""
        side = "（下働き）" if e.get("isSidechain") else ""
        blocks = blocks_of(e)

        # 道具の名前を控えておく
        for b in blocks:
            if b.get("type") == "tool_use":
                names[b.get("id")] = b.get("name") or "tool"

        said = []   # 本文
        used = []   # 折りたたむもの

        for b in blocks:
            t = b.get("type")

            if t == "text":
                text = clean(b.get("text") or "")
                if text:
                    said.append(text)

            elif t == "thinking":
                if opts.thinking:
                    text = clean(b.get("thinking") or "")
                    if text:
                        used.append("<details>\n<summary>💭 考えていたこと</summary>\n\n%s\n\n</details>"
                                    % cut(text, opts.max_chars))

            elif t == "tool_use":
                if opts.no_tools:
                    continue
                name = b.get("name") or "tool"
                body = tool_body(name, b.get("input"), opts.max_chars)
                used.append("<details>\n<summary>🔧 %s</summary>\n\n%s\n\n</details>"
                            % (tool_head(name, b.get("input")), body))

            elif t == "tool_result":
                if opts.no_tools:
                    continue
                name = names.get(b.get("tool_use_id"), "tool")
                text = result_text(b, opts.max_chars)
                if not text:
                    continue
                used.append("<details>\n<summary>📄 %s の結果</summary>\n\n%s\n\n</details>"
                            % (name, fence(text)))

        if not said and not used:
            continue

        # 道具の結果は user の行として記録されるが、話者はあなたではない。
        # 本文のない結果だけの行は、直前の Claude の発言にそのまま続ける。
        bare_result = kind == "user" and not said
        if not bare_result:
            who = "👤 あなた" if kind == "user" else "🤖 Claude"
            lines.append("### %s%s — %s" % (who, side, stamp))
            lines.append("")
        for text in said:
            lines.append(text)
            lines.append("")
        for block in used:
            lines.append(block)
            lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def summarize(entries, log):
    started = ended = None
    branch = ""
    cwd = log["cwd"]
    n_user = n_asst = 0
    first_prompt = ""

    for e in entries:
        ts = parse_ts(e.get("timestamp"))
        if ts:
            if started is None or ts < started:
                started = ts
            if ended is None or ts > ended:
                ended = ts
        branch = e.get("gitBranch") or branch
        cwd = e.get("cwd") or cwd

        if e.get("isMeta") or e.get("isSidechain"):
            continue
        if e.get("type") == "user":
            texts = [clean(b.get("text") or "") for b in blocks_of(e) if b.get("type") == "text"]
            texts = [t for t in texts if t]
            if texts:
                n_user += 1
                if not first_prompt:
                    first_prompt = " ".join(texts[0].split())[:120]
        elif e.get("type") == "assistant":
            if any(b.get("type") == "text" and clean(b.get("text") or "") for b in blocks_of(e)):
                n_asst += 1

    return {
        "id": log["id"], "cwd": cwd, "path": log["path"],
        "started": started, "ended": ended, "branch": branch,
        "n_user": n_user, "n_asst": n_asst, "first_prompt": first_prompt,
    }


# ---- 入り口 ----------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description="Claude Code の会話ログを Markdown にして Zip にまとめる")
    p.add_argument("--root", default=HOME_PROJECTS, help="ログの置き場（既定: ~/.claude/projects）")
    p.add_argument("--project", help="作業場所の名前で絞る（部分一致）")
    p.add_argument("--session", help="セッションIDの頭で絞る")
    p.add_argument("--since", help="この日以降だけ出す（YYYY-MM-DD）")
    p.add_argument("--until", help="この日までを出す（YYYY-MM-DD）")
    p.add_argument("--out", help="出力する Zip（既定: claude-logs-<日時>.zip）")
    p.add_argument("--list", action="store_true", dest="just_list", help="中身を出さず一覧だけ見る")
    p.add_argument("--no-tools", action="store_true", help="道具の呼び出しと結果を落とす（記事の下書き向き）")
    p.add_argument("--thinking", action="store_true", help="Claude の思考も含める")
    p.add_argument("--sidechain", action="store_true", help="サブエージェントの会話も含める")
    p.add_argument("--raw", action="store_true", help="元の .jsonl も Zip に同梱する")
    p.add_argument("--max-chars", type=int, default=2000, help="道具の入出力の上限文字数（0で無制限）")
    opts = p.parse_args()

    logs = find_logs(opts.root, opts.project, opts.session)
    if not logs:
        print("ログが見つかりません: %s" % opts.root, file=sys.stderr)
        if opts.project:
            print("--project の指定を外して試してください。", file=sys.stderr)
        return 1

    since = dt.datetime.strptime(opts.since, "%Y-%m-%d").date() if opts.since else None
    until = dt.datetime.strptime(opts.until, "%Y-%m-%d").date() if opts.until else None

    sessions = []
    for log in logs:
        entries = read_entries(log["path"])
        if not entries:
            continue
        meta = summarize(entries, log)
        day = meta["started"].date() if meta["started"] else None
        if since and (day is None or day < since):
            continue
        if until and (day is None or day > until):
            continue
        if meta["n_user"] == 0 and meta["n_asst"] == 0:
            continue
        sessions.append((meta, entries))

    if not sessions:
        print("条件に合うセッションがありません。", file=sys.stderr)
        return 1

    sessions.sort(key=lambda s: s[0]["started"] or dt.datetime.min.replace(tzinfo=dt.timezone.utc))

    if opts.just_list:
        print("%-16s %-8s %-28s %s" % ("日時", "発言", "作業場所", "最初の一言"))
        for meta, _ in sessions:
            when = meta["started"].strftime("%Y-%m-%d %H:%M") if meta["started"] else "?"
            print("%-16s %-8s %-28s %s"
                  % (when, "%d/%d" % (meta["n_user"], meta["n_asst"]),
                     os.path.basename(meta["cwd"]), meta["first_prompt"]))
        print("\n%d セッション" % len(sessions))
        return 0

    out = opts.out or ("claude-logs-%s.zip" % dt.datetime.now().strftime("%Y%m%d-%H%M%S"))

    index = ["# Claude Code 会話ログ", "",
             "書き出し: %s" % dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
             "対象: %d セッション" % len(sessions), "",
             "| 日時 | 作業場所 | 発言 | 最初の一言 | ファイル |",
             "|---|---|---|---|---|"]

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for meta, entries in sessions:
            day = meta["started"].strftime("%Y%m%d-%H%M") if meta["started"] else "unknown"
            name = "sessions/%s-%s.md" % (day, meta["id"][:8])
            z.writestr(name, render_session(entries, meta, opts))
            if opts.raw:
                z.write(meta["path"], "raw/%s.jsonl" % meta["id"])
            index.append("| %s | %s | %d/%d | %s | [%s](%s) |"
                         % (meta["started"].strftime("%Y-%m-%d %H:%M") if meta["started"] else "?",
                            os.path.basename(meta["cwd"]),
                            meta["n_user"], meta["n_asst"],
                            meta["first_prompt"].replace("|", "\\|"),
                            os.path.basename(name), name))
        z.writestr("index.md", "\n".join(index) + "\n")

    print("%s を作りました（%d セッション、%.1f KB）"
          % (out, len(sessions), os.path.getsize(out) / 1024.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
