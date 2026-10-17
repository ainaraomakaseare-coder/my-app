// 雨男判定のルール計算（レギュレーション準拠）。画面とは独立させてテストできるようにしてある。
const POINTS = {
  outdoor: { sunny: 1, rain: -2, cancel: -4 },
  big: { sunny: 3, rain: -5, cancel: -7, flight: -10 },
};
const LABELS = {
  outdoor: '野外イベント（野球観戦・モルック・フェスなど）',
  big: '大きなイベント（旅行など）',
};

// event: {type, result, participants[], wet[], pointedOut, sunApproved}
// result: sunny | rain | cancel | flight | indoor（雨だが屋内で遂行＝変動なし）
// 戻り値: {valid, error, deltas:{name:点}, counted:{name:{rain:bool}}}
const APPLY_DAYS = 10; // 晴れポイントの事前申請は当日のこの日数前まで

function daysUntil(dateStr, todayStr) {
  const u = (d) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd); };
  return Math.round((u(dateStr) - u(todayStr)) / 86400000);
}

// 申請内容のチェック。unapplied=true は急な予定（申請なし・晴れ加点なし）
function validateApplication(ev, todayStr) {
  if (!ev.date) return '日付を入れてください';
  if (!ev.participants || ev.participants.length < 2) return '判定対象は放研人が2名以上参加したイベントのみです';
  if (!ev.unapplied && daysUntil(ev.date, todayStr) < APPLY_DAYS) {
    return `申請は当日の${APPLY_DAYS}日前までです（${APPLY_DAYS}日以内の予定は「申請なし」で登録できますが、晴れポイントは付きません）`;
  }
  return '';
}

function judge(ev) {
  const table = POINTS[ev.type];
  if (!table) return { valid: false, error: '種類が不正です' };
  if (!ev.participants || ev.participants.length < 2) {
    return { valid: false, error: '判定対象は放研人が2名以上参加したイベントのみです' };
  }
  const deltas = {};
  const counted = {};
  ev.participants.forEach((n) => { deltas[n] = 0; });

  if (ev.result === 'indoor') return { valid: true, deltas, counted };
  if (ev.result === 'flight' && ev.type !== 'big') {
    return { valid: false, error: '欠航は大きなイベントのみ選べます' };
  }
  if (ev.result === 'sunny') {
    ev.participants.forEach((n) => {
      counted[n] = { rain: false };
      if (ev.sunApproved && !ev.unapplied) deltas[n] = table.sunny; // 晴れポイントは事前申請＋運営確認が必須
    });
    return { valid: true, deltas, counted };
  }
  const wet = (ev.wet || []).filter((n) => ev.participants.includes(n));
  if (wet.length === 0) return { valid: false, error: '濡れた人（雨と判定された人）を選んでください' };
  const base = table[ev.result];
  const pts = ev.pointedOut ? base * 2 : base; // 他者に指摘された雨天は2倍の減点
  ev.participants.forEach((n) => { counted[n] = { rain: wet.includes(n) }; });
  wet.forEach((n) => { deltas[n] = pts; });
  return { valid: true, deltas, counted };
}

function summarize(events) {
  const stats = {};
  const get = (n) => (stats[n] = stats[n] || { name: n, score: 0, total: 0, rain: 0 });
  events.forEach((ev) => {
    if (!ev.result || !ev.approvedBy) return; // 結果未入力・未承認は集計しない
    const r = judge(ev);
    if (!r.valid) return;
    Object.keys(r.deltas).forEach((n) => { get(n).score += r.deltas[n]; });
    Object.keys(r.counted).forEach((n) => {
      const s = get(n);
      s.total += 1;
      if (r.counted[n].rain) s.rain += 1;
    });
  });
  return Object.values(stats).map((s) => ({
    ...s,
    rate: s.total ? Math.round((s.rain / s.total) * 100) : null,
  }));
}

function rank(rate, total) {
  if (rate === null || total < 3) return { title: '判定中', note: '3イベント以上で判定します' };
  if (rate >= 80) return { title: '伝説の雨男', note: '雨雲が先回りして待っています' };
  if (rate >= 60) return { title: '雨男', note: '傘は常に持ち歩きましょう' };
  if (rate >= 40) return { title: '雨男予備軍', note: '半々。気象庁もお手上げ' };
  if (rate >= 20) return { title: 'ほぼ晴れ男', note: '雨は気のせいかも' };
  return { title: '晴れ男', note: 'あなたがいれば野球は成立します' };
}

// 共有状態への操作。画面（端末内モード）とWorker（共有モード）の両方で同じものを使う。
// 戻り値: {state} または {error}。誰でも編集できる（公平のため）が、承認は結果を入れた人以外に限る。
function applyAction(state, a, today) {
  const st = JSON.parse(JSON.stringify(state));
  st.members = st.members || [];
  st.events = st.events || [];
  const ev = a.id ? st.events.find((e) => String(e.id) === String(a.id)) : null;
  switch (a.type) {
    case 'addMember': {
      const n = String(a.name || '').trim().slice(0, 12);
      if (!n) return { error: '名前を入れてください' };
      if (!st.members.includes(n)) st.members.push(n);
      break;
    }
    case 'removeMember':
      if (st.events.some((e) => e.participants.includes(a.name))) return { error: '記録に使われているメンバーは削除できません' };
      st.members = st.members.filter((m) => m !== a.name);
      break;
    case 'addEvent': {
      const e = a.event || {};
      const clean = { id: Date.now() + Math.floor(Math.random() * 1000), date: e.date, title: String(e.title || '').slice(0, 30),
        type: e.type, participants: (e.participants || []).filter((n) => st.members.includes(n)), unapplied: !!e.unapplied,
        result: null, appliedBy: a.by || null };
      if (!POINTS[clean.type]) return { error: '種類が不正です' };
      const msg = validateApplication(clean, today);
      if (msg) return { error: msg };
      st.events.push(clean);
      break;
    }
    case 'setResult': {
      if (!ev) return { error: 'イベントが見つかりません' };
      if (!st.members.includes(a.by)) return { error: '「あなたは誰？」を選んでください' };
      if (daysUntil(ev.date, today) > 0) return { error: '結果は当日から入れられます' };
      const next = { ...ev, result: a.result, wet: a.wet || [], pointedOut: !!a.pointedOut, sunApproved: !!a.sunApproved };
      const j = judge(next);
      if (!j.valid) return { error: j.error };
      Object.assign(ev, next, { enteredBy: a.by, approvedBy: null });
      break;
    }
    case 'approve':
      if (!ev || !ev.result) return { error: '承認する結果がありません' };
      if (!st.members.includes(a.by)) return { error: '「あなたは誰？」を選んでください' };
      if (ev.participants.includes(a.by) || a.by === ev.enteredBy) return { error: '承認できるのは、そのイベントの参加者以外の人です' };
      ev.approvedBy = a.by;
      break;
    case 'remove':
      st.events = st.events.filter((e) => String(e.id) !== String(a.id));
      break;
    default:
      return { error: '不明な操作です' };
  }
  return { state: st };
}

if (typeof module !== 'undefined') module.exports = { applyAction, validateApplication, daysUntil, APPLY_DAYS, judge, summarize, rank, POINTS, LABELS };
