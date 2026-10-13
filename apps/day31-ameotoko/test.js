const assert = require('assert');
const { applyAction, validateApplication, daysUntil, judge, summarize, rank } = require('./logic.js');
const P = ['A', 'B', 'C'];
const base = { type: 'outdoor', participants: P, wet: ['A'], pointedOut: false, sunApproved: false };

assert.strictEqual(judge({ ...base, result: 'rain' }).deltas.A, -2);
assert.strictEqual(judge({ ...base, result: 'rain' }).deltas.B, 0);
assert.strictEqual(judge({ ...base, result: 'rain', pointedOut: true }).deltas.A, -4);
assert.strictEqual(judge({ ...base, result: 'cancel' }).deltas.A, -4);
assert.strictEqual(judge({ ...base, type: 'big', result: 'rain' }).deltas.A, -5);
assert.strictEqual(judge({ ...base, type: 'big', result: 'cancel', pointedOut: true }).deltas.A, -14);
assert.strictEqual(judge({ ...base, type: 'big', result: 'flight' }).deltas.A, -10);
assert.strictEqual(judge({ ...base, result: 'flight' }).valid, false);
assert.strictEqual(judge({ ...base, result: 'sunny' }).deltas.A, 0); // 未申請は加点なし
assert.strictEqual(judge({ ...base, result: 'sunny', sunApproved: true }).deltas.B, 1);
assert.strictEqual(judge({ ...base, type: 'big', result: 'sunny', sunApproved: true }).deltas.C, 3);
assert.strictEqual(judge({ ...base, result: 'indoor' }).deltas.A, 0);
assert.strictEqual(Object.keys(judge({ ...base, result: 'indoor' }).counted).length, 0);
assert.strictEqual(judge({ ...base, participants: ['A'], result: 'rain' }).valid, false);
assert.strictEqual(judge({ ...base, wet: [], result: 'rain' }).valid, false);

const s = summarize([
  { ...base, result: 'rain', approvedBy: 'B' },
  { ...base, result: 'sunny', sunApproved: true, approvedBy: 'B' },
  { ...base, result: 'indoor', approvedBy: 'B' },
  { ...base, result: 'rain' }, // 未承認は集計されない
]);
const a = s.find((x) => x.name === 'A');
assert.deepStrictEqual([a.score, a.total, a.rain, a.rate], [-1, 2, 1, 50]);
assert.strictEqual(rank(100, 1).title, '判定中');
assert.strictEqual(rank(100, 5).title, '伝説の雨男');
assert.strictEqual(daysUntil('2026-10-24', '2026-10-14'), 10);
const app = { date: '2026-10-24', participants: P };
assert.strictEqual(validateApplication(app, '2026-10-14'), '');
assert.notStrictEqual(validateApplication(app, '2026-10-15'), '');
assert.strictEqual(validateApplication({ ...app, unapplied: true }, '2026-10-23'), '');
assert.notStrictEqual(validateApplication({ ...app, participants: ['A'] }, '2026-10-01'), '');
assert.strictEqual(judge({ ...base, result: 'sunny', sunApproved: true, unapplied: true }).deltas.A, 0);
assert.strictEqual(summarize([{ ...base, result: null }]).length, 0);
// 共有操作：申請→結果→承認
let st = { members: P, events: [] };
const T = '2026-10-14';
st = applyAction(st, { type: 'addEvent', by: 'A', event: { date: '2026-10-14', title: 'x', type: 'outdoor', participants: ['A', 'B'], unapplied: true } }, T).state;
const id = st.events[0].id;
assert.ok(applyAction(st, { type: 'addEvent', event: { date: '2026-10-15', type: 'outdoor', participants: ['A', 'B'] } }, T).error);
assert.ok(applyAction(st, { type: 'setResult', id, by: 'Z', result: 'sunny' }, T).error);
st = applyAction(st, { type: 'setResult', id, by: 'A', result: 'rain', wet: ['A'] }, T).state;
assert.strictEqual(summarize(st.events).length, 0);
assert.ok(applyAction(st, { type: 'approve', id, by: 'A' }, T).error);
assert.ok(applyAction(st, { type: 'approve', id, by: 'B' }, T).error); // 参加者は承認不可
st = applyAction(st, { type: 'approve', id, by: 'C' }, T).state;
assert.strictEqual(summarize(st.events).find((x) => x.name === 'A').score, -2);
console.log('OK');
