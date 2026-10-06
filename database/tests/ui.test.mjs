import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { parseHTML } from 'linkedom';

const html = await readFile(new URL('../../omoide.html', import.meta.url), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const admin = '00000000-0000-0000-0000-000000000001';
const member = '00000000-0000-0000-0000-000000000002';
const room = 'community-a';
const settle = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve)); };

async function app({ role = 'admin', saved = true, people, fiction = [], initialStorage = [], knownPeople = [] } = {}) {
  const { window, document } = parseHTML(html);
  const state = { role, status: 'active', confirms: true, signIns: 0, calls: [], writes: [], delayedPeople: null, invitesEnabled: true };
  const userId = role === 'admin' ? admin : member;
  const storage = new Map(saved ? [['omoide_room_id_v1', room]] : []);
  initialStorage.forEach(([key, value]) => storage.set(key, value));
  const members = [
    { user_id: admin, display_name: '運営', role: 'admin', status: 'active', joined_at: '2026-10-01' },
    { user_id: member, display_name: '<img src=x onerror=alert(1)>', role: 'member', status: 'active', joined_at: '2026-10-02' }
  ];
  let interval;
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: userId } } } }),
      signInAnonymously: async () => { state.signIns++; return { data: { user: { id: userId } } }; }
    },
    from(table) {
      let single = false;
      const query = {
        select() { return this; }, eq() { return this; }, order() { return this; }, range() { return this; }, limit() { return this; },
        maybeSingle() { single = true; return this; },
        upsert(row) { state.writes.push({ table, row }); return this; },
        insert(row) { state.writes.push({ table, row }); return this; },
        then(resolve, reject) {
          const response = () => {
            if (table === 'binder_members') return { data: single ? { role: state.role, status: state.status, display_name: 'Test user' } : members };
            if (table === 'people') return { data: people || [{ id: 'p1', name: 'Profile name', photo_urls: [], tags: [], created_at: '2026-10-01' }] };
            if (table === 'quiz_scores') return { data: single ? (knownPeople.length ? { known_people: knownPeople } : null) : [] };
            if (table === 'binder_fictional_episodes') return { data: fiction };
            return { data: [] };
          };
          if (table === 'people' && state.delayedPeople) return state.delayedPeople.then(resolve, reject);
          return Promise.resolve(response()).then(resolve, reject);
        }
      };
      return query;
    },
    async rpc(name, args) {
      state.calls.push({ name, args });
      if (name === 'binder_get_invite_status') return state.statusLookupError
        ? { error: { message: 'offline' } } : { data: state.invitesEnabled };
      if (name === 'binder_set_invites_enabled') {
        if (state.inviteMutationError) return { error: { message: 'offline' } };
        state.invitesEnabled = args.p_enabled;
        return { data: { enabled: state.invitesEnabled, invite_code: state.invitesEnabled ? 'resumed-invite' : null } };
      }
      if (name === 'binder_remove_member') members[1].status = 'removed';
      if (name === 'binder_join_room') return { data: room };
      if (name === 'binder_create_room') return { data: { room_id: room, invite_code: 'new-invite' } };
      return { data: 'new-invite' };
    }
  };
  const localStorage = { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) };
  Object.assign(window, {
    supabase: { createClient: () => client }, localStorage,
    scrollTo() {}, confirm: () => state.confirms, prompt: () => 'New community'
  });
  window.HTMLElement.prototype.scrollIntoView = function () {};
  const sandbox = {
    window, document, localStorage, crypto: webcrypto, URL, TextEncoder, console,
    navigator: { clipboard: { writeText: async () => {} } },
    confirm: window.confirm, prompt: window.prompt,
    setTimeout: () => 1, clearTimeout() {},
    setInterval: fn => { interval = fn; return 1; }, clearInterval: () => { interval = null; },
    Map, Set, Blob
  };
  vm.runInNewContext(script, sandbox, { filename: 'omoide.html' });
  await settle();
  return { document, window, state, storage, tick: async () => { await interval?.(); await settle(); }, client };
}

test('saved member session restores without creating a new identity; admin UI stays hidden', async () => {
  const a = await app({ role: 'member' });
  assert.equal(a.state.signIns, 0);
  assert.equal(a.document.getElementById('gateOverlay').hidden, true);
  assert.equal(a.document.getElementById('manageMembersBtn').hidden, true);
  assert.match(a.document.getElementById('grid').textContent, /Profile name/);
  a.document.getElementById('manageMembersBtn').click();
  await settle();
  assert.equal(a.document.getElementById('memberAdmin').hidden, true);
});

test('admin can cancel removal or confirm it and receive replacement invite', async () => {
  const a = await app();
  a.document.getElementById('manageMembersBtn').click();
  await settle();
  assert.equal(a.document.getElementById('memberAdmin').hidden, false);
  assert.equal(a.document.querySelectorAll('.memberRemove').length, 1);
  assert.equal(a.document.querySelectorAll('#memberList img').length, 0, 'member names are text, not HTML');
  a.state.confirms = false;
  a.document.querySelector('.memberRemove').click();
  await settle();
  assert.equal(a.state.calls.filter(c => c.name === 'binder_remove_member').length, 0);
  a.state.confirms = true;
  a.document.querySelector('.memberRemove').click();
  await settle();
  assert.equal(a.state.calls.filter(c => c.name === 'binder_remove_member').length, 1);
  assert.equal(a.state.calls.find(c => c.name === 'binder_remove_member').args.p_user, member);
  assert.equal(a.document.getElementById('inviteCodeValue').value, 'new-invite');
  assert.equal(a.document.querySelectorAll('.memberRemove').length, 0);
  assert.match(a.document.getElementById('memberList').textContent, /退出済み/);
});

test('revocation while detail is open clears visible data, quiz cache and stored room', async () => {
  const a = await app({ role: 'member' });
  a.document.getElementById('detailPanel').hidden = false;
  a.document.getElementById('detailInner').innerHTML = '<p>private details</p>';
  a.storage.set(`omoide_quiz_v1:${room}:${member}`, 'private quiz results');
  a.state.status = 'removed';
  await a.tick();
  assert.equal(a.document.getElementById('gateOverlay').hidden, false);
  assert.equal(a.document.getElementById('app').hidden, true);
  assert.equal(a.document.getElementById('detailInner').textContent, '');
  assert.equal(a.document.getElementById('grid').textContent, '');
  assert.match(a.document.getElementById('gateError').textContent, /退出済み/);
  assert.equal(a.storage.has(`omoide_quiz_v1:${room}:${member}`), false);
  assert.equal(a.storage.has('omoide_room_id_v1'), false);
});

test('a response started before revocation cannot put private data back on screen', async () => {
  const a = await app({ role: 'member' });
  let resolvePeople;
  a.state.delayedPeople = new Promise(resolve => { resolvePeople = resolve; });
  await a.tick(); // loadPeople is now in flight
  a.state.status = 'removed';
  await a.tick();
  resolvePeople({ data: [{ id: 'stale', name: 'STALE_PRIVATE_DATA', photo_urls: [] }] });
  await settle();
  assert.equal(a.document.getElementById('grid').textContent, '');
  assert.equal(a.document.getElementById('gateOverlay').hidden, false);
});

test('new community creation gives admin a shareable invite', async () => {
  const a = await app({ saved: false });
  a.document.getElementById('gateDisplayName').value = '運営';
  a.document.getElementById('gateCreate').click();
  await settle();
  assert.equal(a.state.calls[0].name, 'binder_create_room');
  assert.equal(a.document.getElementById('inviteCodeValue').value, 'new-invite');
  assert.equal(a.document.getElementById('memberAdmin').hidden, false);
});

test('admin can cancel, pause new participants and resume with a fresh invite', async () => {
  const a = await app();
  a.document.getElementById('manageMembersBtn').click();
  await settle();
  const button = a.document.getElementById('pauseInviteBtn');
  assert.equal(button.disabled, false);
  assert.match(button.textContent, /一時停止/);
  a.state.confirms = false;
  button.click();
  await settle();
  assert.equal(a.state.calls.filter(c => c.name === 'binder_set_invites_enabled').length, 0);
  a.state.confirms = true;
  button.click();
  await settle();
  assert.equal(a.state.invitesEnabled, false);
  assert.match(a.document.getElementById('inviteStatus').textContent, /停止/);
  assert.equal(a.document.getElementById('inviteResult').hidden, true);
  assert.equal(a.document.getElementById('rotateInviteBtn').disabled, true);
  assert.equal(a.document.querySelectorAll('.memberRemove').length, 1, 'existing members remain available for individual removal');
  // Removing an existing member while paused must not show a usable invitation.
  a.document.querySelector('.memberRemove').click();
  await settle();
  assert.equal(a.document.getElementById('inviteResult').hidden, true);
  assert.match(a.document.getElementById('inviteStatus').textContent, /停止/);
  button.click();
  await settle();
  assert.equal(a.state.invitesEnabled, true);
  assert.equal(a.document.getElementById('inviteCodeValue').value, 'resumed-invite');
  assert.equal(a.document.getElementById('rotateInviteBtn').disabled, false);
});

test('failed pause does not announce success; unreadable status disables invitation controls', async () => {
  const a = await app();
  a.document.getElementById('manageMembersBtn').click();
  await settle();
  a.state.inviteMutationError = true;
  a.document.getElementById('pauseInviteBtn').click();
  await settle();
  assert.equal(a.state.invitesEnabled, true);
  assert.match(a.document.getElementById('inviteStatus').textContent, /参加受付中/);
  assert.match(a.document.getElementById('memberAdminStatus').textContent, /確認できません/);
  a.state.statusLookupError = true;
  a.document.getElementById('manageMembersBtn').click();
  await settle();
  assert.equal(a.document.getElementById('pauseInviteBtn').disabled, true);
  assert.equal(a.document.getElementById('rotateInviteBtn').disabled, true);
  assert.match(a.document.getElementById('inviteStatus').textContent, /確認できていません/);
});

const groupedPeople = [
  { id: 'a', name: '青木', tags: ['放送研究会'], episodes: [{ text: '録音機を忘れた' }] },
  { id: 'b', name: '井上', tags: ['放送研究会'], episodes: [{ text: '駅の階段で靴が脱げた' }] },
  { id: 'c', name: '上田', tags: ['放送研究会', 'バイト先'], episodes: [{ text: '旅行で財布をなくした' }] },
  { id: 'd', name: '江口', tags: ['放送研究会'], episodes: [{ text: '朝まで脚本を書いた' }] },
  { id: 'e', name: '大野', tags: ['バイト先'], episodes: [{ text: '初日にエプロンを破った' }] },
  { id: 'f', name: '加藤', tags: ['大学'], episodes: [{ text: '試験会場を間違えた' }] },
  { id: 'g', name: '木村', tags: ['秘密の区分'], visibility: { tags: false } },
  { id: 'h', name: '久保', tags: [] }
].map(person => ({ ...person, photo_urls: [], created_at: '2026-10-01' }));

async function chooseLevel(a, value) {
  const select = a.document.getElementById('quizLevel');
  Object.defineProperty(select, 'value', { configurable: true, writable: true, value });
  select.dispatchEvent(new a.window.Event('change', { bubbles: true }));
  await settle();
}

test('intermediate uses four names while advanced offers every eligible name and keeps none during search', async () => {
  const a = await app({ people: groupedPeople });
  await chooseLevel(a, 'intermediate');
  a.document.querySelector('[data-quiz-mode="episode"]').click();
  await settle();
  assert.equal(a.document.querySelectorAll('.quizOption').length, 4);
  assert.equal(a.document.querySelector('.noneChoice'), null);
  assert.equal(a.document.getElementById('quizNameSearch'), null);
  await chooseLevel(a, 'advanced');
  a.document.querySelector('[data-quiz-mode="episode"]').click();
  await settle();
  assert.equal(a.document.querySelectorAll('.quizOption').length, 9);
  const search = a.document.getElementById('quizNameSearch');
  search.value = '青木';
  search.dispatchEvent(new a.window.Event('input'));
  assert.deepEqual([...a.document.querySelectorAll('.quizOption')].filter(el => !el.hidden).map(el => el.textContent).sort(), ['そんな人いない', '青木'].sort());
  await answerLabel(a, '青木');
  assert.equal([...a.document.querySelectorAll('.quizOption')].some(el => el.hidden), false);
});

test('answers are credited to their level and cancelled level changes preserve the session', async () => {
  const a = await app({ people: groupedPeople });
  await chooseLevel(a, 'intermediate');
  a.document.querySelector('[data-quiz-mode="episode"]').click();
  await settle();
  const text = a.document.querySelector('.quizClue').textContent;
  const owner = groupedPeople.find(person => person.episodes?.some(ep => ep.text === text));
  await answerLabel(a, owner.name);
  const first = a.state.writes.filter(write => write.table === 'quiz_scores').at(-1).row;
  assert.equal(first.level_scores.intermediate.correctCount, 1);
  assert.deepEqual([...first.level_scores.intermediate.knownPeople], [owner.id]);
  assert.equal(first.level_scores.advanced, undefined);
  a.state.confirms = false;
  await chooseLevel(a, 'advanced');
  assert.equal(a.document.getElementById('quizLevel').value, 'intermediate');
  assert.match(a.document.getElementById('quizSession').textContent, /中級/);
  a.state.confirms = true;
  await chooseLevel(a, 'advanced');
  a.document.querySelector('[data-quiz-mode="episode"]').click();
  await settle();
  await answerLabel(a, 'そんな人いない');
  const latest = a.state.writes.filter(write => write.table === 'quiz_scores').at(-1).row;
  assert.equal(latest.level_scores.intermediate.correctCount, 1);
  assert.equal(latest.level_scores.advanced.answerCount, 1);
  assert.equal(latest.level_scores.advanced.knownPeople.length, 0);
});

function groupRow(a, tag) {
  return [...a.document.querySelectorAll('.quizScopeGroup')].find(row => row.querySelector('span').textContent === tag);
}
async function chooseGroup(a, tag, checked = true) {
  const input = groupRow(a, tag).querySelector('input');
  input.checked = checked;
  input.dispatchEvent(new a.window.Event('change', { bubbles: true }));
  await settle();
}

test('quiz scope keeps questions and every distractor within the selected category', async () => {
  const a = await app({ people: groupedPeople });
  a.document.getElementById('startQuizBtn').click();
  assert.equal(a.document.getElementById('quizSession').hidden, true, 'home shortcut lets learner choose categories first');
  a.document.getElementById('quizScopeNone').click();
  await chooseGroup(a, '放送研究会');
  a.document.querySelector('[data-quiz-mode="episode"]').click();
  await settle();
  assert.deepEqual(new Set([...a.document.querySelectorAll('.quizOption')].map(el => el.textContent)), new Set(['青木', '井上', '上田', '江口', 'そんな人いない']));
  assert.match(a.document.getElementById('quizSession').textContent, /出題範囲：上級 · 放送研究会/);
  assert.equal(a.document.getElementById('quizScopeGroups').textContent.includes('秘密の区分'), false);
  const key = `omoide_quiz_scope_v1:${room}:${admin}`;
  assert.deepEqual(JSON.parse(a.storage.get(key)), { all: false, tags: ['放送研究会'], untagged: false });
});

test('multiple categories count a shared person once, and category progress includes prior correct answers', async () => {
  const a = await app({ people: groupedPeople, knownPeople: ['c', 'c', 'deleted-person'] });
  a.document.getElementById('quizScopeNone').click();
  await chooseGroup(a, '放送研究会');
  await chooseGroup(a, 'バイト先');
  assert.match(a.document.getElementById('quizScopeSummary').textContent, /覚えた 1 \/ 5人/);
  assert.match(groupRow(a, '放送研究会').textContent, /覚えた 1 \/ 4人/);
  assert.match(groupRow(a, 'バイト先').textContent, /覚えた 1 \/ 2人/);
});

test('empty or small category never broadens to unrelated people', async () => {
  const a = await app({ people: groupedPeople });
  a.document.getElementById('quizScopeNone').click();
  a.document.querySelector('[data-quiz-mode="episode"]').click();
  await settle();
  assert.equal(a.document.querySelectorAll('.quizOption').length, 0);
  assert.match(a.document.getElementById('quizScopeSummary').textContent, /0 \/ 0人/);
  await chooseGroup(a, '大学');
  a.document.querySelector('[data-quiz-mode="episode"]').click();
  await settle();
  assert.equal(a.document.querySelectorAll('.quizOption').length, 0);
  assert.match(a.document.getElementById('quizSession').textContent, /2人以上/);
});

test('saved category choice restores for the same room/user and does not cross user boundaries', async () => {
  const key = `omoide_quiz_scope_v1:${room}:${admin}`;
  const initialStorage = [[key, JSON.stringify({ all: false, tags: ['バイト先'], untagged: false })]];
  const a = await app({ people: groupedPeople, initialStorage });
  assert.match(a.document.getElementById('quizScopeSummary').textContent, /^バイト先：覚えた 0 \/ 2人/);
  const b = await app({ role: 'member', people: groupedPeople, initialStorage });
  assert.match(b.document.getElementById('quizScopeSummary').textContent, /^すべての区分/);
});

test('changing scope mid-quiz needs confirmation; cancelling preserves the active quiz', async () => {
  const a = await app({ people: groupedPeople });
  a.document.querySelector('[data-quiz-mode="episode"]').click();
  await settle();
  const original = a.document.getElementById('quizSession').innerHTML;
  a.state.confirms = false;
  a.document.getElementById('quizScopeNone').click();
  assert.equal(a.document.getElementById('quizSession').innerHTML, original);
  assert.match(a.document.getElementById('quizScopeSummary').textContent, /^すべての区分/);
  a.state.confirms = true;
  a.document.getElementById('quizScopeNone').click();
  assert.equal(a.document.getElementById('quizSession').hidden, true);
  assert.equal(a.document.getElementById('quizSession').innerHTML, '');
  assert.equal(a.document.getElementById('quizModeGrid').hidden, false);
});

async function answerLabel(a, label) {
  const button = [...a.document.querySelectorAll('.quizOption')].find(el => el.textContent === label);
  assert.ok(button, `missing answer ${label}`);
  button.click();
  await settle();
}

test('none-of-the-people is an option for real episodes but is not the correct answer', async () => {
  const a = await app({ people: groupedPeople });
  a.document.querySelector('[data-quiz-mode="episode"]').click();
  await settle();
  await answerLabel(a, 'そんな人いない');
  assert.equal(a.document.querySelector('.noneChoice').classList.contains('incorrect'), true);
  assert.notEqual(a.document.querySelector('.quizOption.correct').textContent, 'そんな人いない');
  assert.equal(a.document.getElementById('knownPeopleCount').textContent, '0');
});

test('explicit fiction answers none without adding a fictional person to known people', async () => {
  const people = groupedPeople.slice(0, 4).map(p => ({ ...p, episodes: [] }));
  const a = await app({ people, fiction: [{ id: 'f1', text: '月の裏でチーズを作った', tags: ['放送研究会'] }] });
  a.document.querySelector('[data-quiz-mode="episode"]').click();
  await settle();
  assert.equal(a.document.querySelectorAll('.quizOption').length, 5);
  await answerLabel(a, 'そんな人いない');
  assert.match(a.document.getElementById('quizFeedback').textContent, /^正解！.*架空/);
  assert.equal(a.document.getElementById('knownPeopleCount').textContent, '0');
  const score = a.state.writes.find(write => write.table === 'quiz_scores').row;
  assert.equal(score.correct_count, 1);
  assert.equal(score.known_people.length, 0);
});

test('identifying a real episode still adds that person once and locks repeat answers', async () => {
  const a = await app({ people: groupedPeople });
  a.document.querySelector('[data-quiz-mode="episode"]').click();
  await settle();
  const text = a.document.querySelector('.quizClue').textContent;
  const owner = groupedPeople.find(p => p.episodes?.some(ep => ep.text === text));
  await answerLabel(a, owner.name);
  assert.equal(a.document.getElementById('knownPeopleCount').textContent, '1');
  await answerLabel(a, owner.name);
  assert.equal(a.document.getElementById('knownPeopleCount').textContent, '1');
  const score = a.state.writes.find(write => write.table === 'quiz_scores').row;
  assert.equal(score.known_people[0], owner.id);
  assert.equal(score.correct_count, 1);
});

test('true/false combines registered and fictional stories and never increments known-person count', async () => {
  const a = await app({ people: groupedPeople.slice(0, 1), fiction: [{ id: 'f1', text: '月の裏でチーズを作った', tags: ['放送研究会'] }] });
  a.document.querySelector('[data-quiz-mode="truefalse"]').click();
  await settle();
  const seen = new Set();
  for (let i = 0; i < 2; i++) {
    const clue = a.document.querySelector('.quizClue').textContent;
    const isFiction = clue.includes('チーズ');
    seen.add(isFiction);
    assert.equal(a.document.querySelectorAll('.quizOption').length, 2);
    await answerLabel(a, isFiction ? '× 架空の話' : '○ 実話として登録された話');
    assert.match(a.document.getElementById('quizFeedback').textContent, /^正解！/);
    assert.equal(a.document.getElementById('knownPeopleCount').textContent, '0');
    a.document.getElementById('nextQuizBtn').click();
    await settle();
  }
  assert.equal(seen.size, 2);
});

test('both user-supplied examples are false practice questions with no score writes', async () => {
  const a = await app();
  a.document.querySelector('[data-quiz-mode="sample-truefalse"]').click();
  await settle();
  const clues = [];
  for (let i = 0; i < 2; i++) {
    clues.push(a.document.querySelector('.quizClue').textContent);
    await answerLabel(a, '× 架空の話');
    assert.match(a.document.getElementById('quizFeedback').textContent, /^正解！.*架空/);
    a.document.getElementById('nextQuizBtn').click();
    await settle();
  }
  assert.ok(clues.some(text => text.includes('ゲノム') && text.includes('恵比寿')));
  assert.ok(clues.some(text => text.includes('エンゼルス')));
  assert.equal(a.state.writes.length, 0);
});

test('fiction obeys selected categories and conflicting registered text is not labelled false', async () => {
  const a = await app({ people: groupedPeople, fiction: [
    { id: 'f1', text: '出題してはいけない他区分の話', tags: ['バイト先'] },
    { id: 'f2', text: '録音機を忘れた', tags: ['放送研究会'] }
  ] });
  a.document.getElementById('quizScopeNone').click();
  await chooseGroup(a, '放送研究会');
  a.document.querySelector('[data-quiz-mode="truefalse"]').click();
  await settle();
  for (let i = 0; i < 4; i++) {
    assert.equal(a.document.querySelector('.quizClue').textContent.includes('他区分'), false);
    await answerLabel(a, '○ 実話として登録された話');
    assert.match(a.document.getElementById('quizFeedback').textContent, /^正解！/);
    a.document.getElementById('nextQuizBtn').click();
    await settle();
  }
});

test('fiction editor persists examples only to the fictional question bank', async () => {
  const a = await app();
  a.document.getElementById('fictionExampleOne').click();
  a.document.getElementById('saveFictionBtn').click();
  await settle();
  assert.equal(a.state.writes.length, 1);
  assert.equal(a.state.writes[0].table, 'binder_fictional_episodes');
  assert.match(a.state.writes[0].row.text, /ゲノム.*恵比寿/);
});

test('person -> episode shows four stories in scope and credits the matched person', async () => {
  const a = await app({ people: groupedPeople });
  a.document.getElementById('quizScopeNone').click();
  await chooseGroup(a, '放送研究会');
  a.document.querySelector('[data-quiz-mode="person-episode"]').click();
  await settle();
  assert.match(a.document.querySelector('.quizPrompt').textContent, /この人にあったエピソード/);
  const owner = groupedPeople.find(person => person.name === a.document.querySelector('.quizClue').textContent);
  assert.ok(owner);
  assert.deepEqual(new Set([...a.document.querySelectorAll('.quizOption')].map(el => el.textContent)), new Set(groupedPeople.slice(0, 4).map(p => p.episodes[0].text)));
  await answerLabel(a, owner.episodes[0].text);
  assert.match(a.document.getElementById('quizFeedback').textContent, /^正解！/);
  assert.equal(a.document.getElementById('knownPeopleCount').textContent, '1');
  assert.equal(a.state.writes.find(write => write.table === 'quiz_scores').row.known_people[0], owner.id);
});

test('person -> episode excludes ambiguous, hidden, name-revealing and same-owner alternatives', async () => {
  const people = groupedPeople.slice(0, 5).map(p => ({ ...p, episodes: [...p.episodes, { text: '全員に共通する同じ話' }, { text: p.name + 'という名前で呼ばれた' }] }));
  people[0].episodes.push({ text: '追加の本人だけの話' });
  people[4].visibility = { episodes: false, photo: false };
  const a = await app({ people });
  a.document.querySelector('[data-quiz-mode="person-episode"]').click();
  await settle();
  const owner = people.find(p => p.name === a.document.querySelector('.quizClue').textContent);
  const choices = [...a.document.querySelectorAll('.quizOption')].map(el => el.textContent);
  assert.equal(choices.length, 4);
  assert.equal(choices.filter(text => owner.episodes.some(ep => ep.text === text)).length, 1);
  assert.equal(choices.some(text => text.includes('全員') || text.includes('という名前')), false);
  assert.equal(choices.includes(people[4].episodes[0].text), false);
  assert.notEqual(owner.id, people[4].id);
});

test('person -> episode does not invent alternatives when fewer than four shared stories exist', async () => {
  const people = groupedPeople.slice(0, 4).map((p, i) => ({ ...p, episodes: i === 0 ? [] : p.episodes }));
  const a = await app({ people });
  a.document.querySelector('[data-quiz-mode="person-episode"]').click();
  await settle();
  assert.equal(a.document.querySelectorAll('.quizOption').length, 0);
  assert.match(a.document.getElementById('quizSession').textContent, /4人以上/);
});

test('mixed mode includes both directions without asking the same story twice', async () => {
  const a = await app({ people: groupedPeople.slice(0, 4) });
  a.document.querySelector('[data-quiz-mode="mixed"]').click();
  await settle();
  const prompts = [], stories = new Set();
  for (let i = 0; i < 10 && a.document.querySelector('.quizPrompt'); i++) {
    const prompt = a.document.querySelector('.quizPrompt').textContent;
    prompts.push(prompt);
    const clue = a.document.querySelector('.quizClue')?.textContent || '';
    a.document.querySelector('.quizOption').click();
    await settle();
    const story = prompt.includes('この人にあったエピソード')
      ? a.document.querySelector('.quizOption.correct').textContent
      : groupedPeople.flatMap(p => p.episodes || []).find(ep => clue.includes(ep.text))?.text;
    if (story) { assert.equal(stories.has(story), false); stories.add(story); }
    a.document.getElementById('nextQuizBtn').click();
    await settle();
  }
  assert.ok(prompts.some(p => p.includes('この人にあったエピソード')));
  assert.ok(prompts.some(p => p.includes('このエピソードの人は誰')));
});
