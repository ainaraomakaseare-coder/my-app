#!/usr/bin/env node
// 開発時間を記録する。Claude Code のフックから呼ばれる。
//
//   node .claude/hooks/timelog.js mark <イベント名>   時刻を1行書き足す
//   node .claude/hooks/timelog.js report [YYYY-MM-DD] その日の集計を出す
//
// 記録先は .claude/time/YYYY-MM-DD.jsonl（gitignore 済み）。
// 「AI稼働時間」は、あなたが送信してから Claude が応答し終えるまでの合計。
// あなたが入力している時間と考えている時間は入らない。

const fs = require('fs');
const path = require('path');

const timeDir = path.join(__dirname, '..', 'time');

function localDateKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function hhmm(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function duration(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function mark(event) {
  const now = new Date();
  const input = readStdin();
  const line = JSON.stringify({
    t: now.toISOString(),
    event,
    session: input.session_id || 'unknown',
  });
  fs.mkdirSync(timeDir, { recursive: true });
  fs.appendFileSync(path.join(timeDir, `${localDateKey(now)}.jsonl`), line + '\n');

  if (event === 'start') {
    const reminder =
      '【開発ログ】この作業の時間は .claude/time/ に自動で記録されています。' +
      '管理リポジトリ 30days-30apps の docs/logs/dayNN.md がまだ無ければ、' +
      'docs/logs/TEMPLATE.md をコピーして作り、開発開始時刻を記入してください。' +
      '終了時は `node .claude/hooks/timelog.js report` の結果をログに書き写します。' +
      '計測できなかった項目は推測で埋めず「正確な計測不可」と書いてください。';
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: reminder },
      })
    );
  }
}

function report(dateKey) {
  const key = dateKey || localDateKey(new Date());
  const file = path.join(timeDir, `${key}.jsonl`);
  if (!fs.existsSync(file)) {
    console.log(`${key} の記録はありません（${file} が無い）。`);
    console.log('この日の時間は「正確な計測不可」と書いてください。');
    return;
  }

  const events = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map((e) => ({ ...e, at: new Date(e.t) }))
    .sort((a, b) => a.at - b.at);

  if (events.length === 0) {
    console.log(`${key} の記録が空です。「正確な計測不可」と書いてください。`);
    return;
  }

  const pending = new Map();
  const spans = [];
  for (const e of events) {
    if (e.event === 'prompt') pending.set(e.session, e.at);
    if (e.event === 'stop' && pending.has(e.session)) {
      spans.push(e.at - pending.get(e.session));
      pending.delete(e.session);
    }
  }

  const first = events[0].at;
  const last = events[events.length - 1].at;
  const aiMs = spans.reduce((a, b) => a + b, 0);
  const longest = spans.length ? Math.max(...spans) : 0;
  const sessions = new Set(events.map((e) => e.session)).size;

  console.log(`=== ${key} の時間 ===`);
  console.log(`開発開始      ${hhmm(first)}`);
  console.log(`最後の記録    ${hhmm(last)}`);
  console.log(`実時間        ${duration(last - first)}`);
  console.log('');
  console.log(`AI稼働（近似） ${duration(aiMs)}`);
  console.log(`やり取り       ${spans.length} 回 / セッション ${sessions} 個`);
  if (spans.length) console.log(`最長の1回      ${duration(longest)}`);
  console.log('');
  console.log('AI稼働は「送信してから応答し終えるまで」の合計です。あなたが入力・');
  console.log('検討している時間は入っていません。ただし Claude Code は内部の計算時間を');
  console.log('出さないため、これは応答時間の合計＝近似値です。ログにもそう書いてください。');
  console.log('人間の作業時間は実時間そのままではありません。休憩や別作業を引いた値を');
  console.log('自分で記入してください。分からなければ「正確な計測不可」とします。');
}

const [, , cmd, arg] = process.argv;
if (cmd === 'mark') mark(arg || 'unknown');
else if (cmd === 'report') report(arg);
else {
  console.error('使い方: timelog.js mark <event> | timelog.js report [YYYY-MM-DD]');
  process.exit(1);
}
