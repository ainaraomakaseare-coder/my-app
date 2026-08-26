/* 人狼アプリ 本体
   ・親機（GM卓）が進行を持つ。ゲームの状態はこの端末の localStorage に入る。
   ・各参加者の役職は URL のうしろ（#より後ろ）に入れてQRで配る。
     #より後ろはサーバーに送られないので、どこかに記録が残ることがない。
   ・サーバーを使わないので、公開しても運用費が発生しない。 */
(function () {
  'use strict';

  var STORE_KEY = 'jinro.game.v1';

  var ROLES = {
    villager: { name: '村人',   team: 'village', desc: '特別な能力はありません。議論で人狼を見つけてください。' },
    wolf:     { name: '人狼',   team: 'wolf',    desc: '夜に村人をひとり襲撃します。昼は村人のふりをしてください。' },
    seer:     { name: '占い師', team: 'village', desc: '夜にひとりを占うと、その人が人狼かどうかが分かります。' },
    knight:   { name: '騎士',   team: 'village', desc: '夜にひとりを守ります。守った人はその夜、襲撃されません。' },
    medium:   { name: '霊媒師', team: 'village', desc: '処刑された人が人狼だったかどうかが分かります。' },
    madman:   { name: '狂人',   team: 'wolf',    desc: '人狼陣営です。占われても「人狼ではない」と出ます。人狼が誰かは分かりません。' }
  };
  var ROLE_ORDER = ['villager', 'wolf', 'seer', 'knight', 'medium', 'madman'];

  // ---------- URLに載せるための変換 ----------
  function b64urlEncode(str) {
    var utf8 = unescape(encodeURIComponent(str));
    return btoa(utf8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(str) {
    var s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return decodeURIComponent(escape(atob(s)));
  }
  function packPayload(obj) { return b64urlEncode(JSON.stringify(obj)); }
  function unpackPayload(str) { return JSON.parse(b64urlDecode(str)); }

  function baseUrl() {
    return location.origin + location.pathname;
  }

  // ---------- 画面まわりの小道具 ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function showQr(container, text) {
    container.innerHTML = '';
    try {
      var modules = QR.encode(text);
      container.innerHTML = QR.toSvg(modules, { dark: '#12131a', light: '#ffffff' });
    } catch (e) {
      container.appendChild(el('p', 'warn', 'QRコードを作れませんでした：' + e.message));
    }
  }

  // ================================================================
  //  参加者の画面
  // ================================================================
  function renderPlayerView(payload) {
    var data;
    try { data = unpackPayload(payload); }
    catch (e) { return renderBroken('役職のデータを読み取れませんでした。親機からもう一度QRを表示してもらってください。'); }

    var role = ROLES[data.r];
    if (!role) return renderBroken('知らない役職が入っていました。');

    $('gmView').hidden = true;
    $('playerView').hidden = false;
    document.body.classList.add('is-player');

    $('coverName').textContent = data.n;
    $('roleFor').textContent = data.n + ' さんの役職';
    $('roleName').textContent = role.name;
    $('roleName').className = 'rolecard-role team-' + role.team;
    $('roleTeam').textContent = role.team === 'wolf' ? '人狼陣営' : '村人陣営';
    $('roleTeam').className = 'rolecard-team team-' + role.team;
    $('roleDesc').textContent = role.desc;

    if (data.f && data.f.length) {
      $('roleMates').hidden = false;
      var list = $('matesList');
      list.innerHTML = '';
      data.f.forEach(function (m) { list.appendChild(el('li', null, m)); });
    }

    $('playerNote').textContent = 'この画面は自分だけで見てください。閉じても、同じQR（またはリンク）からまた開けます。';

    $('revealBtn').addEventListener('click', function () {
      $('roleCover').hidden = true;
      $('roleBody').hidden = false;
    });
    $('hideBtn').addEventListener('click', function () {
      $('roleBody').hidden = true;
      $('roleCover').hidden = false;
    });
  }

  function renderResultView(payload) {
    var data;
    try { data = unpackPayload(payload); }
    catch (e) { return renderBroken('結果のデータを読み取れませんでした。'); }

    $('gmView').hidden = true;
    $('resultView').hidden = false;
    document.body.classList.add('is-player');

    var kindLabel = data.t === 'medium' ? '霊媒の結果' : '占いの結果';
    $('resCoverTitle').textContent = kindLabel + '（' + data.d + '日目）';
    $('resKind').textContent = kindLabel;
    $('resTarget').textContent = data.n;
    var v = $('resVerdict');
    v.textContent = data.w ? '人狼' : '人狼ではない';
    v.className = 'verdict ' + (data.w ? 'is-wolf' : 'is-human');

    $('resRevealBtn').addEventListener('click', function () {
      $('resCover').hidden = true;
      $('resBody').hidden = false;
    });
    $('resHideBtn').addEventListener('click', function () {
      $('resBody').hidden = true;
      $('resCover').hidden = false;
    });
  }

  function renderBroken(msg) {
    document.body.innerHTML = '<div class="wrap narrow"><div class="panel center"><p class="warn">' +
      msg.replace(/</g, '&lt;') + '</p><p><a class="btn btn-ghost" href="' + baseUrl() + '">最初の画面へ</a></p></div></div>';
  }

  // ================================================================
  //  親機（GM卓）
  // ================================================================
  var game = null;

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(game)); } catch (e) { /* 保存できなくても続行 */ }
  }
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function clearSave() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* 無視 */ }
  }

  function showScreen(id) {
    var screens = document.querySelectorAll('#gmView .screen');
    for (var i = 0; i < screens.length; i++) screens[i].classList.remove('active');
    $(id).classList.add('active');
    $('resetBtn').hidden = (id === 'scSetup');
    window.scrollTo(0, 0);
  }

  // ---------- 設定画面 ----------
  function parseNames() {
    var lines = $('namesInput').value.split('\n')
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
    return lines;
  }

  function roleCounts() {
    var counts = {};
    ROLE_ORDER.forEach(function (key) {
      var input = $('cnt_' + key);
      counts[key] = input ? (parseInt(input.value, 10) || 0) : 0;
    });
    return counts;
  }

  function buildRoleRows() {
    var box = $('roleRows');
    box.innerHTML = '';
    ROLE_ORDER.forEach(function (key) {
      var r = ROLES[key];
      var row = el('div', 'rolerow');
      var label = el('div', 'rolerow-label');
      label.appendChild(el('span', 'rolerow-name team-' + r.team, r.name));
      label.appendChild(el('span', 'rolerow-desc', r.desc));
      row.appendChild(label);

      var ctl = el('div', 'stepper');
      var minus = el('button', 'stepbtn', '−');
      var input = el('input', 'stepval');
      input.type = 'number';
      input.min = '0';
      input.value = '0';
      input.id = 'cnt_' + key;
      input.inputMode = 'numeric';
      var plus = el('button', 'stepbtn', '＋');
      minus.addEventListener('click', function () {
        input.value = Math.max(0, (parseInt(input.value, 10) || 0) - 1);
        refreshSetup();
      });
      plus.addEventListener('click', function () {
        input.value = (parseInt(input.value, 10) || 0) + 1;
        refreshSetup();
      });
      input.addEventListener('input', refreshSetup);
      ctl.appendChild(minus); ctl.appendChild(input); ctl.appendChild(plus);
      row.appendChild(ctl);
      box.appendChild(row);
    });
  }

  function recommend(n) {
    // 人数に応じた無難な構成
    var c = { villager: 0, wolf: 0, seer: 0, knight: 0, medium: 0, madman: 0 };
    if (n < 3) return c;
    c.seer = 1;
    c.wolf = n <= 6 ? 1 : (n <= 10 ? 2 : 3);
    if (n >= 7) c.knight = 1;
    if (n >= 8) c.medium = 1;
    if (n >= 9) c.madman = 1;
    var used = c.wolf + c.seer + c.knight + c.medium + c.madman;
    c.villager = Math.max(0, n - used);
    return c;
  }

  function refreshSetup() {
    var names = parseNames();
    var n = names.length;
    var counts = roleCounts();
    var total = ROLE_ORDER.reduce(function (s, k) { return s + counts[k]; }, 0);

    $('playerCount').textContent = n + '人';
    $('roleTotal').textContent = total;
    $('roleNeed').textContent = n;

    var warn = $('setupWarn');
    var ok = true;
    var msg = '';

    if (n < 3) { ok = false; msg = '3人以上の名前を入れてください。'; }
    else if (total !== n) { ok = false; msg = '役職の合計（' + total + '）と参加人数（' + n + '）が合っていません。'; }
    else if (counts.wolf < 1) { ok = false; msg = '人狼が0人です。1人以上にしてください。'; }
    else if (counts.wolf * 2 >= n) { ok = false; msg = '人狼が多すぎます。開始した瞬間に人狼の勝ちになってしまいます。'; }

    warn.hidden = ok;
    warn.textContent = msg;
    $('startBtn').disabled = !ok;
    return ok;
  }

  function startGame() {
    if (!refreshSetup()) return;
    var names = parseNames();
    var counts = roleCounts();

    var pool = [];
    ROLE_ORDER.forEach(function (key) {
      for (var i = 0; i < counts[key]; i++) pool.push(key);
    });
    shuffle(pool);

    var players = names.map(function (name, i) {
      return { id: i, name: name, role: pool[i], alive: true };
    });

    game = {
      players: players,
      day: 1,
      phase: 'distribute',
      distIndex: 0,
      opts: {
        firstNightPeace: $('optFirstNight').checked,
        noSameGuard: $('optNoSameGuard').checked
      },
      night: null,
      lastGuard: null,
      lastExecuted: null,
      lastVictim: null,
      winner: null
    };
    save();
    renderDistribute();
  }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // ---------- 役職配布 ----------
  function playerLink(p) {
    var mates = [];
    if (p.role === 'wolf') {
      mates = game.players
        .filter(function (o) { return o.role === 'wolf' && o.id !== p.id; })
        .map(function (o) { return o.name; });
    }
    var payload = { v: 1, n: p.name, r: p.role };
    if (mates.length) payload.f = mates;
    return baseUrl() + '#p=' + packPayload(payload);
  }

  function renderDistribute() {
    showScreen('scDistribute');
    var i = game.distIndex;
    var p = game.players[i];
    $('distProgress').textContent = (i + 1) + '人目 / ' + game.players.length + '人';
    $('distName').textContent = p.name + ' さん';
    var link = playerLink(p);
    showQr($('distQr'), link);
    $('distPrevBtn').disabled = (i === 0);
    $('distNextBtn').textContent = (i === game.players.length - 1) ? '全員配り終わった → 夜へ' : '読み取った → 次の人';

    $('copyLinkBtn').onclick = function () {
      copyText(link, $('copyLinkBtn'));
    };
    save();
  }

  function copyText(text, btn) {
    var done = function () {
      var old = btn.textContent;
      btn.textContent = 'コピーしました';
      setTimeout(function () { btn.textContent = old; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }
  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { window.prompt('このリンクを本人に送ってください', text); }
    document.body.removeChild(ta);
  }

  // ---------- 夜 ----------
  function alivePlayers() {
    return game.players.filter(function (p) { return p.alive; });
  }
  function aliveWithRole(role) {
    return game.players.filter(function (p) { return p.alive && p.role === role; });
  }

  function nightSteps() {
    var steps = [];
    var peaceful = game.opts.firstNightPeace && game.day === 1;
    if (!peaceful && aliveWithRole('wolf').length) steps.push('wolf');
    if (!peaceful && aliveWithRole('knight').length) steps.push('knight');
    if (aliveWithRole('seer').length) steps.push('seer');
    if (aliveWithRole('medium').length && game.lastExecuted != null) steps.push('medium');
    return steps;
  }

  function beginNight() {
    game.phase = 'night';
    game.night = { steps: nightSteps(), index: 0, attack: null, guard: null, divine: null };
    save();
    renderNight();
  }

  function renderNight() {
    showScreen('scNight');
    var n = game.night;
    $('nightTitle').textContent = game.day + '日目の夜';
    $('nightQrPanel').hidden = true;
    $('nightSkipBtn').hidden = true;

    if (n.index >= n.steps.length) return resolveNight();

    var step = n.steps[n.index];
    var targets = $('nightTargets');
    targets.innerHTML = '';

    var config = {
      wolf:   { label: '人狼の番', prompt: '人狼は誰を襲撃しますか？', actors: aliveWithRole('wolf') },
      knight: { label: '騎士の番', prompt: '騎士は誰を守りますか？',   actors: aliveWithRole('knight') },
      seer:   { label: '占い師の番', prompt: '占い師は誰を占いますか？', actors: aliveWithRole('seer') },
      medium: { label: '霊媒師の番', prompt: '霊媒師に結果を渡します。', actors: aliveWithRole('medium') }
    }[step];

    $('nightStepLabel').textContent = (n.index + 1) + ' / ' + n.steps.length + '　' + config.label;
    var actorNames = config.actors.map(function (p) { return p.name; }).join('・');
    $('nightPrompt').textContent = config.prompt + (actorNames ? '（' + actorNames + '）' : '');

    if (step === 'medium') {
      var executed = game.players[game.lastExecuted];
      var payload = { v: 1, t: 'medium', d: game.day, n: executed.name, w: executed.role === 'wolf' };
      showNightQr('霊媒師のスマホでQRを読み取ってください。', baseUrl() + '#r=' + packPayload(payload), function () {
        n.index++; save(); renderNight();
      });
      return;
    }

    var candidates = alivePlayers();
    if (step === 'wolf') {
      // 人狼は仲間を襲撃できない
      candidates = candidates.filter(function (p) { return p.role !== 'wolf'; });
    }
    if (step === 'knight' && game.opts.noSameGuard && game.lastGuard != null) {
      candidates = candidates.filter(function (p) { return p.id !== game.lastGuard; });
    }

    if (!candidates.length) {
      $('nightPrompt').textContent = '選べる相手がいません。次へ進んでください。';
      $('nightSkipBtn').hidden = false;
      $('nightSkipBtn').textContent = '次へ';
      $('nightSkipBtn').onclick = function () { n.index++; save(); renderNight(); };
      return;
    }

    candidates.forEach(function (p) {
      var b = el('button', 'target', p.name);
      b.addEventListener('click', function () { onNightPick(step, p); });
      targets.appendChild(b);
    });
  }

  function onNightPick(step, target) {
    var n = game.night;
    if (step === 'wolf') {
      n.attack = target.id;
      n.index++; save(); renderNight();
    } else if (step === 'knight') {
      n.guard = target.id;
      game.lastGuard = target.id;
      n.index++; save(); renderNight();
    } else if (step === 'seer') {
      n.divine = target.id;
      var payload = { v: 1, t: 'divine', d: game.day, n: target.name, w: target.role === 'wolf' };
      showNightQr('占い師のスマホでQRを読み取ってください。', baseUrl() + '#r=' + packPayload(payload), function () {
        n.index++; save(); renderNight();
      });
    }
  }

  function showNightQr(prompt, url, onDone) {
    $('nightTargets').innerHTML = '';
    $('nightQrPanel').hidden = false;
    $('nightQrPrompt').textContent = prompt;
    showQr($('nightQr'), url);
    $('nightQrDoneBtn').onclick = onDone;
  }

  function resolveNight() {
    var n = game.night;
    var victim = null;
    if (n.attack != null && n.attack !== n.guard) victim = n.attack;
    if (victim != null) game.players[victim].alive = false;
    game.lastVictim = victim;
    game.phase = 'dawn';
    save();

    if (checkWin()) return;
    renderDawn();
  }

  function renderDawn() {
    showScreen('scDawn');
    $('dawnTitle').textContent = (game.day) + '日目の朝';
    if (game.lastVictim == null) {
      $('dawnMsg').textContent = '誰も襲撃されませんでした。';
    } else {
      $('dawnMsg').textContent = game.players[game.lastVictim].name + ' さんが無残な姿で発見されました。';
    }
    fillAliveList($('dawnAlive'));
  }

  function fillAliveList(ul) {
    ul.innerHTML = '';
    game.players.forEach(function (p) {
      var li = el('li', p.alive ? '' : 'dead', p.name + (p.alive ? '' : '（死亡）'));
      ul.appendChild(li);
    });
  }

  // ---------- 議論 ----------
  var timerId = null, timerLeft = 180, timerRunning = false;

  function renderDay() {
    game.phase = 'day';
    save();
    showScreen('scDay');
    $('dayCount').textContent = game.day + '日目　生存 ' + alivePlayers().length + '人';
    fillAliveList($('dayAlive'));
    stopTimer();
    timerLeft = 180;
    paintTimer();
  }

  function paintTimer() {
    var m = Math.floor(timerLeft / 60), s = timerLeft % 60;
    $('timer').textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    $('timer').classList.toggle('is-up', timerLeft === 0);
  }
  function stopTimer() {
    if (timerId) clearInterval(timerId);
    timerId = null;
    timerRunning = false;
    $('timerBtn').textContent = '開始';
  }
  function toggleTimer() {
    if (timerRunning) { stopTimer(); return; }
    timerRunning = true;
    $('timerBtn').textContent = '一時停止';
    timerId = setInterval(function () {
      timerLeft = Math.max(0, timerLeft - 1);
      paintTimer();
      if (timerLeft === 0) stopTimer();
    }, 1000);
  }

  // ---------- 投票 ----------
  function renderVote() {
    game.phase = 'vote';
    save();
    showScreen('scVote');
    var box = $('voteTargets');
    box.innerHTML = '';
    alivePlayers().forEach(function (p) {
      var b = el('button', 'target', p.name);
      b.addEventListener('click', function () { doExecute(p.id); });
      box.appendChild(b);
    });
  }

  function doExecute(id) {
    if (id == null) {
      game.lastExecuted = null;
      showScreen('scExec');
      $('execMsg').textContent = '同票のため、今日は誰も処刑されませんでした。';
      $('execNextBtn').onclick = nextNight;
      save();
      return;
    }
    game.players[id].alive = false;
    game.lastExecuted = id;
    save();
    showScreen('scExec');
    $('execMsg').textContent = game.players[id].name + ' さんが処刑されました。';
    $('execNextBtn').onclick = function () {
      if (checkWin()) return;
      nextNight();
    };
  }

  function nextNight() {
    game.day++;
    beginNight();
  }

  // ---------- 勝敗 ----------
  function checkWin() {
    var alive = alivePlayers();
    var wolves = alive.filter(function (p) { return p.role === 'wolf'; }).length;
    var others = alive.length - wolves;

    if (wolves === 0) return finish('village');
    if (wolves >= others) return finish('wolf');
    return false;
  }

  function finish(winner) {
    game.winner = winner;
    game.phase = 'result';
    save();
    showScreen('scResult');
    $('winTitle').textContent = winner === 'wolf' ? '人狼の勝ち' : '村人の勝ち';
    $('winTitle').className = 'team-' + winner;
    $('winMsg').textContent = winner === 'wolf'
      ? '人狼が村を支配しました。'
      : '村人が人狼を全員見つけ出しました。';

    var ul = $('revealList');
    ul.innerHTML = '';
    game.players.forEach(function (p) {
      var r = ROLES[p.role];
      var li = el('li', p.alive ? '' : 'dead');
      li.appendChild(el('span', 'rv-name', p.name));
      li.appendChild(el('span', 'rv-role team-' + r.team, r.name));
      li.appendChild(el('span', 'rv-state', p.alive ? '生存' : '死亡'));
      ul.appendChild(li);
    });
    return true;
  }

  // ---------- 復帰 ----------
  function resume(saved) {
    game = saved;
    switch (game.phase) {
      case 'distribute': return renderDistribute();
      case 'night':      return renderNight();
      case 'dawn':       return renderDawn();
      case 'day':        return renderDay();
      case 'vote':       return renderVote();
      case 'result':     return finish(game.winner);
      default:           return showScreen('scSetup');
    }
  }

  // ---------- 起動 ----------
  function initGm() {
    $('gmView').hidden = false;
    buildRoleRows();

    $('namesInput').addEventListener('input', refreshSetup);
    $('addRowBtn').addEventListener('click', refreshSetup);
    $('autoBtn').addEventListener('click', function () {
      var n = parseNames().length;
      var c = recommend(n);
      ROLE_ORDER.forEach(function (k) { $('cnt_' + k).value = c[k]; });
      refreshSetup();
    });
    $('startBtn').addEventListener('click', startGame);

    $('distPrevBtn').addEventListener('click', function () {
      if (game.distIndex > 0) { game.distIndex--; renderDistribute(); }
    });
    $('distNextBtn').addEventListener('click', function () {
      if (game.distIndex < game.players.length - 1) { game.distIndex++; renderDistribute(); }
      else beginNight();
    });

    $('dawnNextBtn').addEventListener('click', renderDay);
    $('dayVoteBtn').addEventListener('click', function () { stopTimer(); renderVote(); });
    $('voteNoneBtn').addEventListener('click', function () { doExecute(null); });
    $('timerBtn').addEventListener('click', toggleTimer);
    $('timerPlus').addEventListener('click', function () { timerLeft += 60; paintTimer(); });
    $('timerMinus').addEventListener('click', function () { timerLeft = Math.max(0, timerLeft - 60); paintTimer(); });
    $('againBtn').addEventListener('click', function () { clearSave(); location.reload(); });
    $('resetBtn').addEventListener('click', function () {
      if (confirm('進行中のゲームを消して最初からやり直しますか？')) { clearSave(); location.reload(); }
    });

    var saved = load();
    if (saved && saved.players && saved.phase !== 'result') {
      if (confirm('前回のゲームが途中で残っています。続きから始めますか？')) return resume(saved);
      clearSave();
    }
    showScreen('scSetup');
    refreshSetup();
  }

  function boot() {
    var hash = location.hash || '';
    if (hash.indexOf('#p=') === 0) return renderPlayerView(hash.slice(3));
    if (hash.indexOf('#r=') === 0) return renderResultView(hash.slice(3));
    initGm();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
