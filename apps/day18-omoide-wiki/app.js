/*
 * おもいでWiki
 * サーバーなし・端末内保存のみ。複数人ぶんの記録はJSONの書き出し／読み込みで合体する。
 * データを扱う純粋な関数は window.OmoideWiki に集めてあり、node からもテストできる。
 */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'omoide-wiki:v1';

  // ---------- 基本ユーティリティ ----------

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function emptyStore() {
    return { wikis: {}, currentId: null };
  }

  function newWiki(type, title, subtitle) {
    var t = nowIso();
    return {
      id: uid('w'),
      type: type === 'group' ? 'group' : 'person',
      title: (title || '').trim(),
      subtitle: (subtitle || '').trim(),
      coverPhoto: null,
      infobox: [],
      overview: '',
      history: [],
      personality: [],
      favorites: [],
      skills: [],
      episodes: [],
      contributors: [],
      createdAt: t,
      updatedAt: t
    };
  }

  // 古いバージョンで作られたWiki（historyカテゴリ追加前など）を読み込んだときに
  // 配列が欠けていて落ちないよう、その場で埋める
  function normalizeWiki(w) {
    CATEGORY_ORDER.forEach(function (cat) {
      if (!Array.isArray(w[cat])) w[cat] = [];
    });
    if (!Array.isArray(w.infobox)) w.infobox = [];
    if (!Array.isArray(w.contributors)) w.contributors = [];
    return w;
  }

  function newEntry(text, author, prompt) {
    var t = nowIso();
    return { id: uid('e'), text: (text || '').trim(), author: (author || '').trim(), prompt: prompt || '', createdAt: t, updatedAt: t };
  }

  function newEpisode(data) {
    var t = nowIso();
    return {
      id: uid('ep'),
      title: (data.title || '').trim(),
      body: (data.body || '').trim(),
      photos: data.photos || [],
      author: (data.author || '').trim(),
      period: (data.period || '').trim(),
      trip: (data.trip || '').trim(),
      tags: data.tags || [],
      prompt: data.prompt || '',
      createdAt: t,
      updatedAt: t
    };
  }

  // ---------- 自由形式テキストの変換 ----------

  function parseInfoboxText(text) {
    var lines = (text || '').split('\n');
    var rows = [];
    lines.forEach(function (line) {
      var s = line.trim();
      if (!s) return;
      var i = s.search(/[:：]/);
      if (i === -1) {
        rows.push({ label: s, value: '' });
      } else {
        rows.push({ label: s.slice(0, i).trim(), value: s.slice(i + 1).trim() });
      }
    });
    return rows;
  }

  function infoboxToText(rows) {
    return (rows || []).map(function (r) { return r.label + ': ' + r.value; }).join('\n');
  }

  function parseTags(text) {
    return (text || '')
      .split(/[,、]/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  // ---------- マージ（複数人のJSONを1つに合体する） ----------

  function mergeEntryArrays(existing, incoming) {
    var byId = {};
    (existing || []).forEach(function (item) { byId[item.id] = item; });
    (incoming || []).forEach(function (item) {
      var cur = byId[item.id];
      if (!cur) {
        byId[item.id] = item;
      } else {
        var curTime = cur.updatedAt || cur.createdAt || '';
        var newTime = item.updatedAt || item.createdAt || '';
        if (newTime > curTime) byId[item.id] = item;
      }
    });
    return Object.keys(byId)
      .map(function (k) { return byId[k]; })
      .sort(function (a, b) { return (a.createdAt || '').localeCompare(b.createdAt || ''); });
  }

  function mergeWiki(existing, incoming) {
    return {
      id: existing.id,
      type: existing.type || incoming.type,
      title: existing.title || incoming.title,
      subtitle: existing.subtitle || incoming.subtitle,
      coverPhoto: existing.coverPhoto || incoming.coverPhoto || null,
      infobox: existing.infobox && existing.infobox.length ? existing.infobox : (incoming.infobox || []),
      overview: existing.overview || incoming.overview || '',
      history: mergeEntryArrays(existing.history, incoming.history),
      personality: mergeEntryArrays(existing.personality, incoming.personality),
      favorites: mergeEntryArrays(existing.favorites, incoming.favorites),
      skills: mergeEntryArrays(existing.skills, incoming.skills),
      episodes: mergeEntryArrays(existing.episodes, incoming.episodes),
      contributors: Array.from(new Set((existing.contributors || []).concat(incoming.contributors || []))),
      createdAt: existing.createdAt || incoming.createdAt || nowIso(),
      updatedAt: nowIso()
    };
  }

  function mergeImport(store, importedWikis) {
    var next = { wikis: {}, currentId: store.currentId };
    Object.keys(store.wikis).forEach(function (k) { next.wikis[k] = store.wikis[k]; });
    var addedCount = 0, mergedCount = 0;
    (importedWikis || []).forEach(function (w) {
      if (!w || !w.id) return;
      if (next.wikis[w.id]) {
        next.wikis[w.id] = mergeWiki(next.wikis[w.id], w);
        mergedCount++;
      } else {
        next.wikis[w.id] = normalizeWiki(w);
        addedCount++;
      }
    });
    return { store: next, added: addedCount, merged: mergedCount };
  }

  function parseImportPayload(jsonText) {
    var data = JSON.parse(jsonText);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.wikis)) return data.wikis;
    if (data && data.id && data.type) return [data];
    throw new Error('このファイルはおもいでWikiのデータではないようです');
  }

  function exportPayload(wikis) {
    return { schema: 'omoide-wiki', version: 1, exportedAt: nowIso(), wikis: wikis };
  }

  function addContributor(wiki, name) {
    var n = (name || '').trim();
    if (n && wiki.contributors.indexOf(n) === -1) wiki.contributors.push(n);
  }

  // ---------- ラベル・質問バンク ----------

  var LABELS = {
    person: { history: '生い立ち・経歴', personality: '人物像・性格', favorites: '好きなもの', skills: '特技', episodes: 'エピソード', kind: '人物' },
    group: { history: '沿革', personality: '雰囲気・カラー', favorites: '好きだったもの・定番', skills: '得意だったこと', episodes: '思い出エピソード', kind: 'サークル・チーム' }
  };

  var QUESTIONS = {
    person: {
      history: [
        '生まれはどこですか？（都道府県・市区町村、当時の様子も分かれば教えてください）',
        '生まれたときのエピソードで、家族から聞いている話はありますか？',
        '幼稚園・保育園はどこに通っていましたか？どんな子どもでしたか？',
        '小学校はどこですか？小学校時代の一番の思い出を教えてください',
        '小学校で仲の良かった友達や、印象に残っている先生はいましたか？',
        '中学校はどこですか？中学時代、一番打ち込んでいたことは何ですか？',
        '高校はどこですか？高校時代に忘れられない出来事はありますか？',
        '大学・専門学校、または最初の就職先はどこですか？そこを選んだ理由も教えてください',
        '初めての仕事、社会に出たころのことで覚えている出来事はありますか？',
        'これまでの人生で、一番大きな転機・決断だったと思う出来事は何ですか？'
      ],
      personality: [
        'その性格が一番はっきり出た、具体的な出来事を一つ教えてください',
        '「らしいな」と周りが思わず笑った・驚いた瞬間はありますか？そのときの状況も教えてください',
        'これまでで一番意外だった行動は何でしたか？何があってそうなったか教えてください',
        '誰かが困っているのを見て、実際にどう動いたか。覚えている場面を一つ教えてください',
        'その考え方を曲げなかった、具体的な出来事はありますか？'
      ],
      favorites: [
        '一番好きな食べ物と、それを好きになったきっかけの出来事を教えてください',
        '心に残っている音楽・映画・本と、それに出会ったときの状況を教えてください',
        'その場所が好きになった、具体的なきっかけや思い出はありますか？',
        '休日に実際にあった、印象に残っている一日を一つ教えてください（どこで何をしたか）',
        'そのこだわりが表れた、具体的な出来事はありますか？'
      ],
      skills: [
        'その特技を発揮して、周りが驚いた・助かった具体的な場面を教えてください',
        '実際に頼られて力を発揮した出来事を一つ教えてください',
        '若いころ打ち込んでいた、具体的な出来事（大会・発表・挫折など）はありますか？',
        '誰かに実際に教えたときの、印象に残っている場面はありますか？'
      ],
      episodes: [
        '一番思い出に残っている出来事を教えてください',
        'その人らしいと感じたエピソードはありますか？',
        '一緒に笑った・泣いた出来事はありますか？',
        '旅行や特別な日の思い出はありますか？',
        'もし最後に一言伝えるとしたら、何を伝えたいですか？'
      ]
    },
    group: {
      history: [
        'いつ、どうやって結成されましたか？きっかけを教えてください',
        '名前の由来はありますか？',
        '最初の頃はどんな活動をしていましたか？',
        '活動場所や活動内容は、時期によってどう変わっていきましたか？',
        '一番人数が多かった・少なかった時期はいつですか？そのころの様子は？',
        '存続にかかわるような、大きな転機はありましたか？',
        '今の姿になるまでで、一番大きく変わったと思う出来事は何ですか？'
      ],
      personality: [
        'その雰囲気が一番出ていた、具体的な場面を一つ教えてください',
        '外から見た印象と違うと感じた、具体的な出来事はありますか？',
        '新入りが最初に驚いた、実際にあった出来事はありますか？',
        '揉めごとが起きたときの、実際の出来事とその収まり方を教えてください'
      ],
      favorites: [
        'みんなが好きだった場所・店での、印象に残っている出来事はありますか？',
        '定番の遊び・恒例行事で、実際にあった出来事を一つ教えてください',
        'よく歌っていた歌にまつわる、具体的な思い出はありますか？',
        'その合言葉やあだ名が生まれた、きっかけの出来事を教えてください'
      ],
      skills: [
        'その得意なことを発揮して、周りが驚いた具体的な出来事を教えてください',
        '大会や本番で実力を発揮した、そのときの出来事を教えてください',
        'その技やコツが後輩に伝わった、具体的な場面はありますか？'
      ],
      episodes: [
        '一番の思い出に残っている出来事を教えてください',
        '伝説になっているエピソードはありますか？',
        '合宿や旅行での出来事を教えてください',
        '一番笑った・一番泣いた瞬間はいつでしたか？',
        '後輩や仲間に伝えたいことはありますか？'
      ]
    }
  };

  var CATEGORY_ORDER = ['history', 'personality', 'favorites', 'skills', 'episodes'];

  function buildInterviewQueue(type) {
    var bank = QUESTIONS[type] || QUESTIONS.person;
    var queue = [];
    CATEGORY_ORDER.forEach(function (cat) {
      (bank[cat] || []).forEach(function (q) { queue.push({ category: cat, question: q, depth: 0 }); });
    });
    return queue;
  }

  // 「お金がかかってもいいのでしっかり深掘ってほしい」という要望を受け、
  // 1話題あたりの上限を引き上げている（Worker側もそれに合わせて質問の質を上げている）
  var MAX_AI_DEPTH = 6;

  // ---------- 旅行・イベント単位でエピソードをまとめる ----------

  function groupEpisodesByTrip(episodes) {
    var order = [];
    var byTrip = {};
    episodes.forEach(function (ep) {
      var key = ep.trip || '';
      if (!byTrip[key]) { byTrip[key] = []; order.push(key); }
      byTrip[key].push(ep);
    });

    function newestOf(list) {
      return list.reduce(function (m, e) { return (e.createdAt || '') > m ? e.createdAt : m; }, '');
    }
    function byNewest(a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); }

    var namedKeys = order.filter(function (k) { return k; })
      .sort(function (a, b) { return newestOf(byTrip[b]).localeCompare(newestOf(byTrip[a])); });

    var groups = namedKeys.map(function (k) {
      return { trip: k, episodes: byTrip[k].slice().sort(byNewest) };
    });
    if (byTrip['']) {
      groups.push({ trip: '', episodes: byTrip[''].slice().sort(byNewest) });
    }
    return groups;
  }

  // ---------- 容量の目安 ----------

  function estimateBytes(store) {
    try {
      return JSON.stringify(store).length;
    } catch (e) {
      return 0;
    }
  }

  var STORAGE_WARN_BYTES = 4 * 1000 * 1000;

  // ---------- 公開（テスト可能な部分） ----------

  var Core = {
    STORAGE_KEY: STORAGE_KEY,
    STORAGE_WARN_BYTES: STORAGE_WARN_BYTES,
    uid: uid,
    nowIso: nowIso,
    emptyStore: emptyStore,
    newWiki: newWiki,
    normalizeWiki: normalizeWiki,
    newEntry: newEntry,
    newEpisode: newEpisode,
    parseInfoboxText: parseInfoboxText,
    infoboxToText: infoboxToText,
    parseTags: parseTags,
    mergeEntryArrays: mergeEntryArrays,
    mergeWiki: mergeWiki,
    mergeImport: mergeImport,
    parseImportPayload: parseImportPayload,
    exportPayload: exportPayload,
    addContributor: addContributor,
    estimateBytes: estimateBytes,
    groupEpisodesByTrip: groupEpisodesByTrip,
    LABELS: LABELS,
    QUESTIONS: QUESTIONS,
    CATEGORY_ORDER: CATEGORY_ORDER,
    buildInterviewQueue: buildInterviewQueue
  };

  root.OmoideWiki = Core;

  // ==========================================================
  // ここから下はブラウザでの画面操作。node からの require では走らない。
  // ==========================================================
  if (typeof document === 'undefined') return;

  var store = emptyStore();
  var currentWikiId = null;
  var interviewQueue = [];
  var interviewIndex = 0;
  var aiThreadHistory = [];
  var pendingEpisodePhotos = [];
  var pendingCoverPhoto = null;
  var entryTab = 'all';
  var micControllers = {};

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function loadStore() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyStore();
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.wikis) return emptyStore();
      Object.keys(parsed.wikis).forEach(function (k) { normalizeWiki(parsed.wikis[k]); });
      return parsed;
    } catch (e) {
      return emptyStore();
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (e) {
      alert('保存に失敗しました。端末の空き容量、または写真の枚数を確認してください。\n' + e.message);
    }
  }

  function currentWiki() {
    return store.wikis[currentWikiId] || null;
  }

  function showScreen(name) {
    $all('.screen').forEach(function (s) { s.classList.toggle('active', s.dataset.screen === name); });
    window.scrollTo(0, 0);
  }

  // ---------- ホーム ----------

  function renderHome() {
    var list = $('#wikiList');
    var wikis = Object.keys(store.wikis).map(function (k) { return store.wikis[k]; })
      .sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); });

    if (!wikis.length) {
      list.innerHTML = '<div class="empty">まだ何もありません。「＋ 新しく作る」から始めてください。</div>';
      return;
    }

    list.innerHTML = '';
    wikis.forEach(function (w) {
      var card = document.createElement('button');
      card.className = 'wiki-card';
      var count = countAll(w);
      var thumb = w.coverPhoto ? 'style="background-image:url(' + w.coverPhoto + ')"' : '';
      card.innerHTML =
        '<span class="thumb" ' + thumb + '>' + (w.coverPhoto ? '' : (w.type === 'group' ? '🎪' : '🧑')) + '</span>' +
        '<span class="meta">' +
          '<span class="name">' + escapeHtml(w.title || '（名前未設定）') + '</span>' +
          '<span class="sub">' + escapeHtml(w.subtitle || '') + '</span>' +
          '<span class="tag">' + (LABELS[w.type].kind) + '・記録' + count + '件</span>' +
        '</span>';
      card.addEventListener('click', function () { openDash(w.id); });
      list.appendChild(card);
    });
  }

  function homeStatus(msg) {
    var el = $('#homeStatus');
    if (el) el.textContent = msg || '';
  }

  // ---------- 新規作成 ----------

  function resetNewForm() {
    $('#newTitle').value = '';
    $('#newSubtitle').value = '';
    $all('input[name=newType]').forEach(function (r) { r.checked = r.value === 'person'; });
  }

  function createWiki() {
    var type = $('input[name=newType]:checked').value;
    var title = $('#newTitle').value.trim();
    if (!title) { alert('名前を入力してください'); return; }
    var subtitle = $('#newSubtitle').value.trim();
    var w = newWiki(type, title, subtitle);
    store.wikis[w.id] = w;
    store.currentId = w.id;
    persist();
    resetNewForm();
    openDash(w.id);
  }

  // ---------- ダッシュボード ----------

  function openDash(id) {
    currentWikiId = id;
    store.currentId = id;
    persist();
    entryTab = 'all';
    renderDash();
    showScreen('dash');
  }

  function renderDash() {
    var w = currentWiki();
    if (!w) { showScreen('home'); return; }
    var L = LABELS[w.type];
    $('#dashTitle').textContent = w.title || '（名前未設定）';
    $('#dashSubtitle').textContent = w.subtitle || (w.type === 'group' ? 'サークル・チームの思い出を集めています' : 'ひとりの人生を記録しています');

    var tabs = [['all', 'すべて']].concat(CATEGORY_ORDER.map(function (c) { return [c, L[c]]; }));
    var tabsEl = $('#entryTabs');
    tabsEl.innerHTML = '';
    tabs.forEach(function (t) {
      var b = document.createElement('button');
      b.textContent = t[1] + '（' + (t[0] === 'all' ? countAll(w) : w[t[0]].length) + '）';
      b.className = t[0] === entryTab ? 'active' : '';
      b.addEventListener('click', function () { entryTab = t[0]; renderDash(); });
      tabsEl.appendChild(b);
    });

    renderEntryList(w);
    maybeWarnStorage();
  }

  function countAll(w) {
    return CATEGORY_ORDER.reduce(function (sum, cat) { return sum + (w[cat] ? w[cat].length : 0); }, 0);
  }

  function renderEntryList(w) {
    var listEl = $('#entryList');
    var cats = entryTab === 'all' ? CATEGORY_ORDER : [entryTab];
    var rows = [];
    cats.forEach(function (cat) {
      w[cat].forEach(function (item) { rows.push({ cat: cat, item: item }); });
    });
    rows.sort(function (a, b) { return (b.item.createdAt || '').localeCompare(a.item.createdAt || ''); });

    if (!rows.length) {
      listEl.innerHTML = '<div class="empty">まだ記録がありません。「質問で深掘りする」か「エピソードを追加する」から書き足せます。</div>';
      return;
    }

    listEl.innerHTML = '';
    rows.forEach(function (r) {
      var L = LABELS[w.type];
      var el = document.createElement('div');
      el.className = 'entry-item';
      var bodyHtml, thumbsHtml = '';
      if (r.cat === 'episodes') {
        var it = r.item;
        bodyHtml = (it.title ? '<b>' + escapeHtml(it.title) + '</b><br>' : (it.prompt ? '<b>' + escapeHtml(it.prompt) + '</b><br>' : '')) + escapeHtml(it.body);
        if (it.photos && it.photos.length) {
          thumbsHtml = '<div class="thumbs">' + it.photos.slice(0, 4).map(function (p) { return '<img src="' + p + '">'; }).join('') + '</div>';
        }
      } else {
        bodyHtml = (r.item.prompt ? '<b>' + escapeHtml(r.item.prompt) + '</b><br>' : '') + escapeHtml(r.item.text);
      }
      el.innerHTML =
        '<div class="body">' + bodyHtml + '</div>' + thumbsHtml +
        '<div class="foot"><span>' + escapeHtml(L[r.cat]) + (r.item.author ? '・' + escapeHtml(r.item.author) : '') +
          (r.item.trip ? '・' + escapeHtml(r.item.trip) : '') +
          (r.item.period ? '・' + escapeHtml(r.item.period) : '') + '</span><button data-cat="' + r.cat + '" data-id="' + r.item.id + '">削除</button></div>';
      el.querySelector('button').addEventListener('click', function () {
        if (!confirm('この記録を削除しますか？')) return;
        deleteEntry(r.cat, r.item.id);
      });
      listEl.appendChild(el);
    });
  }

  function deleteEntry(cat, id) {
    var w = currentWiki();
    w[cat] = w[cat].filter(function (i) { return i.id !== id; });
    w.updatedAt = nowIso();
    persist();
    renderDash();
  }

  function maybeWarnStorage() {
    var bytes = estimateBytes(store);
    var note = $('#homeStatus');
    if (bytes > STORAGE_WARN_BYTES) {
      // ダッシュボードには専用の場所がないため、削除確認と兼ねている foot 領域は使わずコンソールに残す程度に留める
      console.warn('保存データが大きくなっています（約' + Math.round(bytes / 1e6) + 'MB）。書き出してバックアップすることをおすすめします。');
    }
  }

  // ---------- 音声（音声入力・読み上げ） ----------

  var VOICE_PREF_KEY = 'omoide-wiki:voicePref';

  // 一度「音声で会話する」をオンにしたら、次にインタビューを開いたときも
  // 覚えておく（毎回オンにし直す手間をなくす）。初回は音声を主役にしたいのでON。
  function loadVoicePref() {
    try {
      var v = localStorage.getItem(VOICE_PREF_KEY);
      return v === null ? true : v === 'on';
    } catch (e) {
      return true;
    }
  }
  function saveVoicePref(on) {
    try { localStorage.setItem(VOICE_PREF_KEY, on ? 'on' : 'off'); } catch (e) { /* 保存できなくても致命的ではない */ }
  }

  var AI_DEEPEN_PREF_KEY = 'omoide-wiki:aiDeepenPref';

  // Workerを公開した人は「費用がかかってもしっかり深掘りしてほしい」という前提のはずなので、
  // トグルが見える状態（＝Worker設定済み）なら初回からONにしておく
  function loadAiDeepenPref() {
    try {
      var v = localStorage.getItem(AI_DEEPEN_PREF_KEY);
      return v === null ? true : v === 'on';
    } catch (e) {
      return true;
    }
  }
  function saveAiDeepenPref(on) {
    try { localStorage.setItem(AI_DEEPEN_PREF_KEY, on ? 'on' : 'off'); } catch (e) { /* 保存できなくても致命的ではない */ }
  }

  function supportsRecognition() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }
  function supportsSynthesis() {
    return !!window.speechSynthesis;
  }

  function createMicController(textareaEl, btnEl, statusEl) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      btnEl.disabled = true;
      statusEl.textContent = 'このブラウザは音声入力に対応していません。文字で入力してください。';
      return { start: function () {}, stop: function () {}, isOn: function () { return false; } };
    }
    var recog = new SR();
    recog.lang = 'ja-JP';
    recog.interimResults = true;
    recog.continuous = true;
    var on = false;
    var baseText = '';

    recog.onresult = function (event) {
      var finalChunk = '', interimChunk = '';
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var res = event.results[i];
        if (res.isFinal) finalChunk += res[0].transcript;
        else interimChunk += res[0].transcript;
      }
      if (finalChunk) {
        baseText = (baseText ? baseText + '\n' : '') + finalChunk;
        textareaEl.value = baseText;
      }
      statusEl.textContent = on ? ('聞き取り中… ' + interimChunk) : '';
    };
    recog.onerror = function (e) {
      statusEl.textContent = e.error === 'not-allowed' ? 'マイクの使用が許可されていません。' : '音声入力でエラーが発生しました（' + e.error + '）。';
      on = false;
      btnEl.classList.remove('on');
    };
    recog.onend = function () {
      if (on) {
        // 無音が続くとブラウザ側が自動終了することがあるため、続けたい場合は再開する
        try { recog.start(); } catch (e) { /* 既に開始中などは無視 */ }
      } else {
        btnEl.classList.remove('on');
        statusEl.textContent = '';
      }
    };

    return {
      start: function () {
        baseText = textareaEl.value;
        on = true;
        btnEl.classList.add('on');
        try { recog.start(); } catch (e) { /* already started */ }
      },
      stop: function () {
        on = false;
        try { recog.stop(); } catch (e) {}
        btnEl.classList.remove('on');
        statusEl.textContent = '';
      },
      isOn: function () { return on; }
    };
  }

  // マイクボタンのクリック監視は画面初期化時に一度だけ登録し、
  // 質問が変わるたびに micControllers[key] の中身だけ差し替える
  // （毎回 addEventListener し直すとボタンにリスナーが積み重なってしまうため）
  function bindMicButton(key, btnEl) {
    btnEl.addEventListener('click', function () {
      var ctrl = micControllers[key];
      if (!ctrl) return;
      if (ctrl.isOn()) ctrl.stop(); else ctrl.start();
    });
  }

  function setMicController(key, textareaEl, btnEl, statusEl) {
    if (micControllers[key]) micControllers[key].stop();
    var ctrl = createMicController(textareaEl, btnEl, statusEl);
    micControllers[key] = ctrl;
    return ctrl;
  }

  function stopAllMics() {
    Object.keys(micControllers).forEach(function (k) { micControllers[k].stop(); });
  }

  function speak(text, onend) {
    if (!supportsSynthesis()) { if (onend) onend(); return; }
    window.speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    if (onend) u.onend = onend;
    window.speechSynthesis.speak(u);
  }

  // ---------- インタビュー ----------

  function getAiEndpoint() {
    var meta = document.querySelector('meta[name="omoide-ai-endpoint"]');
    var url = meta && meta.content.trim();
    return url || '';
  }

  // 回答内容を読んで、追加の深掘り質問を1つだけ作ってもらう。
  // Worker未設定・通信失敗・12秒以内に応答なしのいずれでも null を返し、
  // インタビュー自体は止めずに次の固定質問へ進める。
  function fetchAiFollowUp(payload) {
    var endpoint = getAiEndpoint();
    if (!endpoint) return Promise.resolve(null);
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 12000) : null;
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.ok ? res.json() : null;
    }).catch(function () {
      if (timer) clearTimeout(timer);
      return null;
    }).then(function (data) {
      return (data && typeof data.followUp === 'string') ? data : null;
    });
  }

  function setInterviewBusy(busy, msg) {
    $('#btnSaveQ').disabled = busy;
    $('#btnSkipQ').disabled = busy;
    $('#qMicStatus').textContent = msg || '';
  }

  function startInterview() {
    var w = currentWiki();
    interviewQueue = buildInterviewQueue(w.type);
    interviewIndex = 0;
    aiThreadHistory = [];
    $('#ivAuthor').value = '';
    $('#voiceModeToggle').checked = loadVoicePref();
    var note = $('#voiceSupportNote');
    note.textContent = supportsRecognition()
      ? (supportsSynthesis() ? '' : '※ このブラウザは質問の読み上げに対応していません（音声入力はできます）')
      : '※ このブラウザは音声入力・読み上げに対応していないようです。文字で入力してください。';

    var aiEndpoint = getAiEndpoint();
    $('#aiDeepenBlock').hidden = !aiEndpoint;
    $('#aiDeepenToggle').checked = aiEndpoint ? loadAiDeepenPref() : false;
    $('#aiDeepenStatus').textContent = aiEndpoint
      ? '回答ごとにAIが次の質問を考えます（数秒かかることがあります・少額のAPI利用料が発生します）'
      : '';

    showScreen('interview');
    renderInterviewQuestion();
  }

  function renderInterviewQuestion() {
    var w = currentWiki();
    var L = LABELS[w.type];
    var q = interviewQueue[interviewIndex];
    if (q.depth === 0) aiThreadHistory = [];
    $('#interviewProgress').style.width = Math.min(100, Math.round((interviewIndex / interviewQueue.length) * 100)) + '%';
    $('#qCategory').textContent = L[q.category] + (q.dynamic ? '・AIの深掘り' : '') + '（' + (interviewIndex + 1) + ' / ' + interviewQueue.length + '）';
    $('#qText').textContent = q.question;
    $('#qAnswer').value = '';
    setInterviewBusy(false, '');

    var ctrl = setMicController('interview', $('#qAnswer'), $('#qMicBtn'), $('#qMicStatus'));
    if ($('#voiceModeToggle').checked) {
      speak(q.question, function () { ctrl.start(); });
    }
  }

  function advanceInterview() {
    interviewIndex++;
    if (interviewIndex >= interviewQueue.length) {
      window.speechSynthesis && window.speechSynthesis.cancel();
      alert('質問は以上です。またいつでも「質問で深掘りする」から続きができます。');
      openDash(currentWikiId);
      return;
    }
    renderInterviewQuestion();
  }

  function saveInterviewAnswer(skip) {
    stopAllMics();
    var w = currentWiki();
    var q = interviewQueue[interviewIndex];
    var text = $('#qAnswer').value.trim();
    var author = $('#ivAuthor').value.trim();

    if (skip || !text) {
      advanceInterview();
      return;
    }

    if (q.category === 'episodes') {
      w.episodes.push(newEpisode({ body: text, author: author, prompt: q.question }));
    } else {
      w[q.category].push(newEntry(text, author, q.question));
    }
    addContributor(w, author);
    w.updatedAt = nowIso();
    persist();

    aiThreadHistory.push({ q: q.question, a: text });
    if (aiThreadHistory.length > 4) aiThreadHistory = aiThreadHistory.slice(-4);

    var wantsAi = $('#aiDeepenToggle').checked && getAiEndpoint() && q.depth < MAX_AI_DEPTH;
    if (!wantsAi) {
      advanceInterview();
      return;
    }

    setInterviewBusy(true, 'AIが次の質問を考えています…');
    fetchAiFollowUp({
      subjectName: w.title || (w.type === 'group' ? 'このサークル・チーム' : 'この人'),
      subjectType: w.type,
      categoryLabel: LABELS[w.type][q.category],
      question: q.question,
      answer: text,
      history: aiThreadHistory.slice(0, -1),
      depth: q.depth
    }).then(function (result) {
      if (result && !result.done && result.followUp) {
        interviewQueue.splice(interviewIndex + 1, 0, {
          category: q.category, question: result.followUp, depth: q.depth + 1, dynamic: true
        });
      }
      advanceInterview();
    });
  }

  // ---------- エピソード追加 ----------

  function fileToCompressedDataURL(file, maxDim, quality) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = reject;
      reader.onload = function () {
        var img = new Image();
        img.onerror = reject;
        img.onload = function () {
          var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          var w = Math.max(1, Math.round(img.width * scale));
          var h = Math.max(1, Math.round(img.height * scale));
          var canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function refreshEpisodePhotoPreview() {
    renderPhotoPreview('#epPhotoPreview', pendingEpisodePhotos, function (i) {
      pendingEpisodePhotos.splice(i, 1);
      refreshEpisodePhotoPreview();
    });
  }

  function resetEpisodeForm() {
    $('#epTitle').value = '';
    $('#epBody').value = '';
    $('#epPeriod').value = '';
    $('#epTrip').value = '';
    $('#epAuthor').value = '';
    $('#epTags').value = '';
    $('#epPhotos').value = '';
    $('#epMicStatus').textContent = '';
    pendingEpisodePhotos = [];
    refreshEpisodePhotoPreview();
  }

  function renderPhotoPreview(sel, photos, onRemove) {
    var el = $(sel);
    el.innerHTML = '';
    photos.forEach(function (src, i) {
      var wrap = document.createElement('span');
      wrap.className = 'rm';
      wrap.innerHTML = '<img src="' + src + '"><button>×</button>';
      wrap.querySelector('button').addEventListener('click', function () { onRemove(i); });
      el.appendChild(wrap);
    });
  }

  function openEpisodeForm() {
    resetEpisodeForm();
    setMicController('episode', $('#epBody'), $('#epMicBtn'), $('#epMicStatus'));
    showScreen('episode');
  }

  function saveEpisode() {
    var w = currentWiki();
    var title = $('#epTitle').value.trim();
    var body = $('#epBody').value.trim();
    if (!title && !body) { alert('タイトルか本文のどちらかは入力してください'); return; }
    var author = $('#epAuthor').value.trim();
    var ep = newEpisode({
      title: title, body: body, photos: pendingEpisodePhotos.slice(),
      author: author, period: $('#epPeriod').value.trim(), trip: $('#epTrip').value.trim(),
      tags: parseTags($('#epTags').value)
    });
    w.episodes.push(ep);
    addContributor(w, author);
    w.updatedAt = nowIso();
    persist();
    stopAllMics();
    openDash(w.id);
  }

  // ---------- 基本情報編集 ----------

  function openProfileForm() {
    var w = currentWiki();
    $('#pfTitle').value = w.title;
    $('#pfSubtitle').value = w.subtitle;
    $('#pfInfobox').value = infoboxToText(w.infobox);
    $('#pfOverview').value = w.overview;
    $('#pfCover').value = '';
    pendingCoverPhoto = null;
    renderPhotoPreview('#pfCoverPreview', w.coverPhoto ? [w.coverPhoto] : [], function () {
      pendingCoverPhoto = 'REMOVE';
      renderPhotoPreview('#pfCoverPreview', [], function () {});
    });
    showScreen('profile');
  }

  function saveProfile() {
    var w = currentWiki();
    w.title = $('#pfTitle').value.trim() || w.title;
    w.subtitle = $('#pfSubtitle').value.trim();
    w.infobox = parseInfoboxText($('#pfInfobox').value);
    w.overview = $('#pfOverview').value.trim();
    if (pendingCoverPhoto === 'REMOVE') w.coverPhoto = null;
    else if (pendingCoverPhoto) w.coverPhoto = pendingCoverPhoto;
    w.updatedAt = nowIso();
    persist();
    openDash(w.id);
  }

  // ---------- 完成ページ ----------

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function episodeCardHtml(ep) {
    var title = ep.title || ep.prompt || '（無題）';
    var img = ep.photos && ep.photos[0] ? '<img src="' + ep.photos[0] + '">' : '';
    var more = ep.photos && ep.photos.length > 1 ? '（他' + (ep.photos.length - 1) + '枚）' : '';
    return '<div class="wp-card">' + img +
      '<div class="wp-card-body"><div class="wp-card-title">' + escapeHtml(title) + '</div>' +
      '<p class="wp-card-text">' + escapeHtml(ep.body) + '</p>' +
      '<div class="wp-card-meta"><span>' + escapeHtml(ep.period || '') + more + '</span><span>' + escapeHtml(ep.author || '') + '</span></div></div></div>';
  }

  function renderWikiPage(w) {
    var L = LABELS[w.type];
    var page = $('#wikiPage');
    var html = '';
    html += '<div class="wp-head"><p class="kind">' + L.kind + '</p><h1>' + escapeHtml(w.title || '（名前未設定）') + '</h1>' +
      (w.subtitle ? '<p class="sub">' + escapeHtml(w.subtitle) + '</p>' : '') + '</div>';

    html += '<div class="wp-body"><div class="wp-main">';

    var tocItems = [['sec-overview', '概要']]
      .concat(CATEGORY_ORDER.filter(function (c) { return c !== 'episodes'; }).map(function (c) { return ['sec-' + c, L[c]]; }))
      .concat([['sec-episodes', L.episodes + '・アルバム']]);
    html += '<nav class="wp-toc"><div class="wp-toc-title">目次</div><ol>' +
      tocItems.map(function (t) { return '<li><a href="#' + t[0] + '">' + escapeHtml(t[1]) + '</a></li>'; }).join('') +
      '</ol></nav>';

    html += '<section id="sec-overview"><h2>概要</h2><p>' + (w.overview ? escapeHtml(w.overview) : autoOverview(w)) + '</p></section>';

    CATEGORY_ORDER.filter(function (c) { return c !== 'episodes'; }).forEach(function (cat) {
      html += '<section id="sec-' + cat + '"><h2>' + L[cat] + '</h2>';
      if (!w[cat].length) {
        html += '<p class="wp-empty">まだ記録がありません。</p>';
      } else {
        html += '<ul class="wp-list">' + w[cat].map(function (it) {
          return '<li>' + (it.prompt ? '<div class="q">' + escapeHtml(it.prompt) + '</div>' : '') +
            escapeHtml(it.text) + (it.author ? '<div class="who">' + escapeHtml(it.author) + 'より</div>' : '') + '</li>';
        }).join('') + '</ul>';
      }
      html += '</section>';
    });

    html += '<section id="sec-episodes"><h2>' + L.episodes + '・アルバム</h2>';
    if (!w.episodes.length) {
      html += '<p class="wp-empty">まだエピソードがありません。</p>';
    } else {
      var groups = groupEpisodesByTrip(w.episodes);
      if (groups.length === 1 && !groups[0].trip) {
        html += '<div class="wp-album">' + groups[0].episodes.map(episodeCardHtml).join('') + '</div>';
      } else {
        html += groups.map(function (g) {
          var heading = g.trip ? escapeHtml(g.trip) : 'その他のエピソード';
          return '<h3 class="wp-trip-title">' + heading + '</h3><div class="wp-album">' +
            g.episodes.map(episodeCardHtml).join('') + '</div>';
        }).join('');
      }

      html += '<h2 style="margin-top:22px">年表（記録した順）</h2><ul class="wp-timeline">' +
        w.episodes.slice().sort(function (a, b) { return (a.createdAt || '').localeCompare(b.createdAt || ''); }).map(function (ep) {
          return '<li>' + (ep.period ? '<span class="period">' + escapeHtml(ep.period) + '</span>' : '') +
            escapeHtml(ep.title || ep.prompt || ep.body.slice(0, 24)) + '</li>';
        }).join('') + '</ul>';
    }
    html += '</section>';

    html += '</div><div class="wp-side">';
    html += '<div class="wp-infobox">';
    html += '<div class="wp-infobox-title">' + escapeHtml(w.title || '（名前未設定）') + '</div>';
    if (w.coverPhoto) html += '<img class="wp-infobox-photo" src="' + w.coverPhoto + '">';
    html += w.infobox.length ? w.infobox.map(function (r) {
      return '<div class="row"><div class="k">' + escapeHtml(r.label) + '</div><div class="v">' + escapeHtml(r.value) + '</div></div>';
    }).join('') : '<div class="row"><div class="v wp-empty">プロフィール表は未入力です</div></div>';
    html += '</div>';
    html += '<div class="contrib"><b>寄稿してくれた人</b>' + (w.contributors.length ? escapeHtml(w.contributors.join('、')) : 'まだいません') + '</div>';
    html += '</div></div>';

    var categoryTags = [L.kind].concat(groupEpisodesByTrip(w.episodes).map(function (g) { return g.trip; }).filter(Boolean));
    html += '<div class="wp-categories"><b>カテゴリ：</b>' +
      categoryTags.map(function (t) { return '<span class="tag">' + escapeHtml(t) + '</span>'; }).join('') + '</div>';

    page.innerHTML = html;
  }

  function autoOverview(w) {
    var total = countAll(w);
    if (!total) return '<span class="wp-empty">まだ記録がありません。質問に答えるかエピソードを追加すると、ここに概要が育っていきます。</span>';
    return escapeHtml((w.type === 'group' ? 'このサークル・チーム' : 'この人') + 'について、これまでに ' + total + ' 件の記録が集まっています。' +
      (w.contributors.length ? '（寄稿者 ' + w.contributors.length + ' 人）' : ''));
  }

  // ---------- 書き出し・読み込み ----------

  function download(filename, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportCurrentWiki() {
    var w = currentWiki();
    download((w.title || 'wiki') + '.json', JSON.stringify(exportPayload([w]), null, 2));
  }

  function importFiles(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    var readers = files.map(function (f) {
      return f.text ? f.text() : new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () { resolve(r.result); };
        r.onerror = reject;
        r.readAsText(f);
      });
    });
    Promise.all(readers).then(function (texts) {
      var allWikis = [];
      var badFiles = 0;
      texts.forEach(function (t) {
        try { allWikis = allWikis.concat(parseImportPayload(t)); }
        catch (e) { badFiles++; }
      });
      var result = mergeImport(store, allWikis);
      store = result.store;
      persist();
      renderHome();
      homeStatus('読み込み完了：新規 ' + result.added + '件 / 合体 ' + result.merged + '件' + (badFiles ? '（読めなかったファイル ' + badFiles + '件）' : ''));
    }).catch(function (e) {
      homeStatus('読み込みに失敗しました：' + e.message);
    });
  }

  function deleteCurrentWiki() {
    var w = currentWiki();
    if (!confirm('「' + (w.title || 'この記録') + '」を削除します。書き出したJSONがなければ元に戻せません。よろしいですか？')) return;
    delete store.wikis[w.id];
    store.currentId = null;
    persist();
    showScreen('home');
    renderHome();
  }

  // ---------- 初期化 ----------

  function init() {
    store = loadStore();

    $('#btnNewWiki').addEventListener('click', function () { resetNewForm(); showScreen('new'); });
    $('#btnCreateWiki').addEventListener('click', createWiki);
    $('#btnImport').addEventListener('click', function () { $('#fileImport').click(); });
    $('#fileImport').addEventListener('change', function (e) { importFiles(e.target.files); e.target.value = ''; });

    bindMicButton('interview', $('#qMicBtn'));
    bindMicButton('episode', $('#epMicBtn'));
    $('#voiceModeToggle').addEventListener('change', function (e) { saveVoicePref(e.target.checked); });
    $('#aiDeepenToggle').addEventListener('change', function (e) { saveAiDeepenPref(e.target.checked); });

    $('#tileInterview').addEventListener('click', startInterview);
    $('#tileEpisode').addEventListener('click', openEpisodeForm);
    $('#tileProfile').addEventListener('click', openProfileForm);
    $('#tileView').addEventListener('click', function () { renderWikiPage(currentWiki()); showScreen('view'); });

    $('#btnSkipQ').addEventListener('click', function () { saveInterviewAnswer(true); });
    $('#btnSaveQ').addEventListener('click', function () { saveInterviewAnswer(false); });

    $('#epPhotos').addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files);
      Promise.all(files.map(function (f) { return fileToCompressedDataURL(f, 1280, 0.72); })).then(function (urls) {
        pendingEpisodePhotos = pendingEpisodePhotos.concat(urls);
        refreshEpisodePhotoPreview();
      });
    });
    $('#btnSaveEpisode').addEventListener('click', saveEpisode);

    $('#pfCover').addEventListener('change', function (e) {
      var f = e.target.files[0];
      if (!f) return;
      fileToCompressedDataURL(f, 1000, 0.75).then(function (url) {
        pendingCoverPhoto = url;
        renderPhotoPreview('#pfCoverPreview', [url], function () {
          pendingCoverPhoto = 'REMOVE';
          renderPhotoPreview('#pfCoverPreview', [], function () {});
        });
      });
    });
    $('#btnSaveProfile').addEventListener('click', saveProfile);

    $('#btnExportWiki').addEventListener('click', exportCurrentWiki);
    $('#btnDeleteWiki').addEventListener('click', deleteCurrentWiki);
    $('#btnPrint').addEventListener('click', function () { window.print(); });

    $all('.back').forEach(function (b) {
      b.addEventListener('click', function () {
        stopAllMics();
        window.speechSynthesis && window.speechSynthesis.cancel();
        showScreen(b.dataset.back);
        if (b.dataset.back === 'home') renderHome();
        if (b.dataset.back === 'dash') renderDash();
      });
    });

    renderHome();
  }

  document.addEventListener('DOMContentLoaded', init);
})(typeof window !== 'undefined' ? window : this);
