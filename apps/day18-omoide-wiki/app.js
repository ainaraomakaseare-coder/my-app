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
      trips: [],
      contributors: [],
      skippedKeys: [],
      createdAt: t,
      updatedAt: t
    };
  }

  // 旅行・イベントは、エピソードが所属する親エンティティ（1つの旅行に複数のエピソードがぶら下がる）。
  // 自由記述の文字列でエピソードをゆるく束ねる方式だと、表記ゆれ（全角/半角・末尾の年など）で
  // 同じ旅行のはずが別グループに分かれてしまう問題があったため、idを持つ実体にした。
  function newTrip(title, period) {
    var t = nowIso();
    return { id: uid('t'), title: (title || '').trim(), period: (period || '').trim(), createdAt: t, updatedAt: t };
  }

  // 旅行名の文字列から、既存の旅行（完全一致）を探す。無ければ新しく作ってwiki.tripsに足す。
  // 空文字なら「どの旅行にも属さない」ことを表す空文字のtripIdを返す。
  // periodを渡すと、その旅行にまだ時期が設定されていない場合に補う（エピソードの
  // 「いつ頃」欄から、旅行の時期を都度入力しなくても自動的に埋まるようにするため）。
  function findOrCreateTrip(wiki, title, period) {
    var name = (title || '').trim();
    if (!name) return '';
    var found = wiki.trips.filter(function (tr) { return tr.title === name; })[0];
    if (found) {
      if (!found.period && period && period.trim()) {
        found.period = period.trim();
        found.updatedAt = nowIso();
      }
      return found.id;
    }
    var tr = newTrip(name, period);
    wiki.trips.push(tr);
    return tr.id;
  }

  function tripTitle(wiki, tripId) {
    if (!tripId) return '';
    var tr = wiki.trips.filter(function (t) { return t.id === tripId; })[0];
    return tr ? tr.title : '';
  }

  // 古いバージョンで作られたWiki（historyカテゴリ追加前など）を読み込んだときに
  // 配列が欠けていて落ちないよう、その場で埋める
  function normalizeWiki(w) {
    CATEGORY_ORDER.forEach(function (cat) {
      if (!Array.isArray(w[cat])) w[cat] = [];
    });
    if (!Array.isArray(w.infobox)) w.infobox = [];
    if (!Array.isArray(w.contributors)) w.contributors = [];
    if (!Array.isArray(w.skippedKeys)) w.skippedKeys = [];
    if (!Array.isArray(w.trips)) w.trips = [];
    // 旧バージョン（旅行を自由記述の文字列で持っていた）のエピソードを、
    // 旅行エンティティ＋tripId参照の形に変換する
    w.episodes.forEach(function (ep) {
      if (ep.tripId === undefined) ep.tripId = '';
      if (typeof ep.trip === 'string' && ep.trip.trim() && !ep.tripId) {
        ep.tripId = findOrCreateTrip(w, ep.trip);
      }
      delete ep.trip;
    });
    return w;
  }

  function newEntry(text, author, prompt, questionKey, photos) {
    var t = nowIso();
    return { id: uid('e'), text: (text || '').trim(), author: (author || '').trim(), prompt: prompt || '', questionKey: questionKey || '', photos: photos || [], createdAt: t, updatedAt: t };
  }

  function newEpisode(data) {
    var t = nowIso();
    return {
      id: uid('ep'),
      title: (data.title || '').trim(),
      body: (data.body || '').trim(),
      photos: data.photos || [],
      author: (data.author || '').trim(),
      participants: data.participants || [],
      period: (data.period || '').trim(),
      tripId: data.tripId || '',
      tags: data.tags || [],
      prompt: data.prompt || '',
      questionKey: data.questionKey || '',
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

  // プロフィール表（infobox）は別画面で手入力する任意項目のため、埋めていない人も多い。
  // 年代に応じた話題提案（AIの追い質問）に使うため、インタビューで答えた生年月日・血液型も
  // あわせて渡す（infoboxへの転記をユーザーに強いらないようにするため）。
  var PROFILE_HISTORY_KEYS = ['birth-date', 'blood-type'];
  function buildProfileContext(w) {
    var parts = [];
    var infoboxText = infoboxToText(w.infobox);
    if (infoboxText) parts.push(infoboxText);
    (w.history || []).forEach(function (e) {
      if (PROFILE_HISTORY_KEYS.indexOf(e.questionKey) !== -1 && e.text) {
        parts.push((e.prompt || e.questionKey) + ': ' + e.text);
      }
    });
    return parts.join('\n');
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
      trips: mergeEntryArrays(existing.trips, incoming.trips),
      contributors: Array.from(new Set((existing.contributors || []).concat(incoming.contributors || []))),
      skippedKeys: Array.from(new Set((existing.skippedKeys || []).concat(incoming.skippedKeys || []))),
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
      normalizeWiki(w); // 古い形式（旅行が自由記述の文字列など）のデータでも安全にマージできるようにする
      if (next.wikis[w.id]) {
        next.wikis[w.id] = mergeWiki(next.wikis[w.id], w);
        mergedCount++;
      } else {
        next.wikis[w.id] = w;
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

  // 質問は {key, text} の形。key は言い回しを変えても不変にしておき、
  // 「一度答えた質問はもう聞かない」判定を文言の一致ではなくkeyの一致で行うため
  // （言い回しを調整するたびに既に答えた質問が再度出てきてしまうのを防ぐ）。
  var QUESTIONS = {
    person: {
      history: [
        { key: 'birth-place', text: 'まずは基本から聞かせてください！生まれはどこですか？（都道府県・市区町村、当時の様子も分かれば嬉しいです）' },
        { key: 'birth-story', text: '生まれたときのエピソードで、家族から聞いている面白い話はありますか？' },
        { key: 'birth-date', text: '生年月日を教えてください（西暦・元号どちらでも大丈夫です）' },
        { key: 'blood-type', text: '血液型は何ですか？分かれば教えてください' },
        { key: 'kindergarten', text: '幼稚園・保育園はどこに通っていましたか？当時どんな子どもだったか、ぜひ聞かせてください！' },
        { key: 'elementary-school', text: '小学校はどこですか？小学校時代の一番の思い出、教えてください！' },
        { key: 'elementary-friends', text: '小学校で仲良かった友達や、忘れられない先生はいましたか？' },
        { key: 'junior-high', text: '中学校はどこですか？当時、一番夢中になっていたことは何ですか？' },
        { key: 'high-school', text: '高校はどこですか？高校時代の忘れられない出来事、聞かせてください！' },
        { key: 'high-school-friends', text: '高校で仲良かった友達や、当時よく一緒にいた人は誰でしたか？その人たちとの楽しい思い出があれば教えてください' },
        { key: 'college-or-job', text: '大学・専門学校、または最初の就職先はどこですか？そこを選んだ理由もぜひ聞かせてください' },
        { key: 'college-good-bad', text: 'そこに入って一番良かったこと、そして一番つらかった・悲しかったこと、それぞれ聞かせてください' },
        { key: 'college-circle', text: '大学・専門学校でサークルや部活、ゼミなどはありましたか？そこでの仲良かった人や楽しかった出来事を教えてください' },
        { key: 'part-time-job', text: 'アルバイト先で仲良くなった人や、印象に残っている出来事はありますか？' },
        { key: 'first-job', text: '初めての仕事、社会に出たころのこと。覚えている出来事があればぜひ！' },
        { key: 'marriage', text: '結婚した思い出はありますか？時期や、馴れ初めのエピソードも聞かせてください' },
        { key: 'children', text: 'お子さんやご家族が増えた思い出はありますか？そのときの気持ちも聞かせてください' },
        { key: 'moving', text: '引っ越しをした思い出はありますか？いつ、どこからどこへ、そのきっかけも聞かせてください' },
        { key: 'retirement', text: '仕事に区切りをつけた（退職した）ときのことを覚えていますか？そのときの気持ちも聞かせてください' },
        { key: 'turning-point', text: 'これまでの人生で、一番大きな転機・決断だったと思う出来事は何ですか？' }
      ],
      personality: [
        { key: 'personality-summary', text: '自分の性格をひとことで言うと、どんな感じだと思いますか？そう思うきっかけになった具体的な出来事も、あわせて聞かせてください！' },
        { key: 'personality-surprise-laugh', text: '「らしいな」と周りが思わず笑った・驚いた瞬間はありますか？そのときの状況も聞かせてください' },
        { key: 'personality-unexpected-action', text: 'これまでで一番意外だった行動は何でしたか？何があってそうなったか、ぜひ教えてください' },
        { key: 'personality-helped-someone', text: '誰かが困っているのを見て、実際にどう動いたか。覚えている場面を一つ教えてください' },
        { key: 'personality-belief', text: '「これだけは譲れない」という信念や考え方はありますか？それを貫いた具体的な出来事も教えてください' }
      ],
      favorites: [
        { key: 'favorite-food', text: '一番好きな食べ物は何ですか？それを好きになったきっかけの出来事も聞かせてください' },
        { key: 'favorite-song', text: '一番好きな曲を1つ挙げるとしたら何ですか？好きになったきっかけや、聴くと思い出す出来事を教えてください' },
        { key: 'favorite-movie-book', text: '心に残っている映画・本はありますか？それに出会ったときの状況も聞かせてください' },
        { key: 'favorite-place', text: '一番好きな場所はどこですか？そこが好きになった具体的なきっかけや思い出も聞かせてください' },
        { key: 'favorite-holiday', text: '休日に実際にあった、印象に残っている一日を一つ教えてください（どこで何をしたか）' },
        { key: 'favorite-commitment', text: '「ここだけは譲れない」というこだわりはありますか？それが表れた具体的な出来事も教えてください' },
        { key: 'favorite-hobby', text: '今ハマっている趣味や、時間を忘れて没頭できることは何ですか？始めたきっかけも聞かせてください！' }
      ],
      skills: [
        { key: 'skill-best', text: '得意なこと・自信のあることは何ですか？一番の武器だと思うものをぜひ教えてください！' },
        { key: 'skill-hobby-start', text: '今までで一番のめり込んだ趣味や特技は何ですか？始めたきっかけもぜひ聞かせてください' },
        { key: 'skill-surprised-others', text: '得意なことを発揮して、周りが驚いた・助かった具体的な場面はありますか？' },
        { key: 'skill-relied-on', text: '実際に頼られて力を発揮した出来事を一つ教えてください' },
        { key: 'skill-youth-devotion', text: '若いころ打ち込んでいた、具体的な出来事（大会・発表・挫折など）はありますか？' },
        { key: 'skill-taught-someone', text: '誰かに実際に教えたときの、印象に残っている場面はありますか？' }
      ],
      episodes: [
        { key: 'episode-most-memorable', text: '一番思い出に残っている出来事を教えてください' },
        { key: 'episode-typical', text: 'その人らしいと感じたエピソードはありますか？' },
        { key: 'episode-laugh-cry', text: '一緒に笑った・泣いた出来事はありますか？' },
        { key: 'episode-trip', text: '印象に残っている旅行はありますか？どこに行って、誰と、何をしたか教えてください' },
        { key: 'episode-last-message', text: 'もし最後に一言伝えるとしたら、何を伝えたいですか？' }
      ]
    },
    group: {
      history: [
        { key: 'group-founding', text: 'いつ、どうやって結成されましたか？きっかけを教えてください' },
        { key: 'group-name-origin', text: '名前の由来はありますか？' },
        { key: 'group-early-activity', text: '最初の頃はどんな活動をしていましたか？' },
        { key: 'group-activity-change', text: '活動場所や活動内容は、時期によってどう変わっていきましたか？' },
        { key: 'group-member-count', text: '一番人数が多かった・少なかった時期はいつですか？そのころの様子は？' },
        { key: 'group-turning-point', text: '存続にかかわるような、大きな転機はありましたか？' },
        { key: 'group-biggest-change', text: '今の姿になるまでで、一番大きく変わったと思う出来事は何ですか？' }
      ],
      personality: [
        { key: 'group-atmosphere', text: 'このサークル・チームらしい雰囲気が一番出ていたと思う、具体的な場面を一つ教えてください' },
        { key: 'group-outside-impression', text: '外から見た印象と違うと感じた、具体的な出来事はありますか？' },
        { key: 'group-newcomer-surprise', text: '新入りが最初に驚いた、実際にあった出来事はありますか？' },
        { key: 'group-conflict', text: '揉めごとが起きたときの、実際の出来事とその収まり方を教えてください' }
      ],
      favorites: [
        { key: 'group-favorite-place', text: 'みんなが好きだった場所・店での、印象に残っている出来事はありますか？' },
        { key: 'group-tradition', text: '定番の遊び・恒例行事で、実際にあった出来事を一つ教えてください' },
        { key: 'group-song-memory', text: 'よく歌っていた歌にまつわる、具体的な思い出はありますか？' },
        { key: 'group-catchphrase', text: '合言葉やあだ名はありましたか？生まれたきっかけの出来事も教えてください' }
      ],
      skills: [
        { key: 'group-skill-surprise', text: 'みんなが得意としていたことを発揮して、周りが驚いた具体的な出来事を教えてください' },
        { key: 'group-skill-competition', text: '大会や本番で実力を発揮した、そのときの出来事を教えてください' },
        { key: 'group-skill-taught-juniors', text: '得意なことのコツが後輩に伝わった、具体的な場面はありますか？' }
      ],
      episodes: [
        { key: 'group-episode-memorable', text: '一番の思い出に残っている出来事を教えてください' },
        { key: 'group-episode-legend', text: '伝説になっているエピソードはありますか？' },
        { key: 'group-episode-trip', text: '合宿や旅行はどこに行きましたか？そのときの出来事も教えてください' },
        { key: 'group-episode-laugh-cry', text: '一番笑った・一番泣いた瞬間はいつでしたか？' },
        { key: 'group-episode-message', text: '後輩や仲間に伝えたいことはありますか？' }
      ]
    }
  };

  var CATEGORY_ORDER = ['history', 'personality', 'favorites', 'skills', 'episodes'];

  // questionKey導入より前に、言い回しを変更したことがある質問の「旧文言」。
  // 該当キーの質問に、旧文言のままの回答（questionKeyを持たない）が残っている場合、
  // 新しい文言と一致しなくても「答え済み」として扱う（過去に実際に答えてもらった質問を
  // 二度と聞かないようにするため。新しく追加するときは、書き換える直前の文言をそのまま追加する）。
  var LEGACY_QUESTION_TEXT = {
    'birth-place': ['生まれはどこですか？（都道府県・市区町村、当時の様子も分かれば教えてください）'],
    'birth-story': ['生まれたときのエピソードで、家族から聞いている話はありますか？'],
    'kindergarten': ['幼稚園・保育園はどこに通っていましたか？どんな子どもでしたか？'],
    'elementary-school': ['小学校はどこですか？小学校時代の一番の思い出を教えてください'],
    'elementary-friends': ['小学校で仲の良かった友達や、印象に残っている先生はいましたか？'],
    'junior-high': ['中学校はどこですか？中学時代、一番打ち込んでいたことは何ですか？'],
    'high-school': ['高校はどこですか？高校時代に忘れられない出来事はありますか？'],
    'high-school-friends': ['高校で仲の良かった友達や、当時よく一緒にいた人は誰ですか？その人たちとの思い出があれば教えてください'],
    'college-or-job': ['大学・専門学校、または最初の就職先はどこですか？そこを選んだ理由も教えてください'],
    'college-good-bad': ['そこに入って一番良かったことと、一番つらかった・悲しかったことをそれぞれ教えてください'],
    'college-circle': ['大学・専門学校でサークルや部活、ゼミなどはありましたか？そこで仲の良かった人や出来事を教えてください'],
    'first-job': ['初めての仕事、社会に出たころのことで覚えている出来事はありますか？'],
    'personality-summary': ['その性格が一番はっきり出た、具体的な出来事を一つ教えてください'],
    'personality-surprise-laugh': ['「らしいな」と周りが思わず笑った・驚いた瞬間はありますか？そのときの状況も教えてください'],
    'personality-unexpected-action': ['これまでで一番意外だった行動は何でしたか？何があってそうなったか教えてください'],
    'personality-belief': ['その考え方を曲げなかった、具体的な出来事はありますか？'],
    'favorite-food': ['一番好きな食べ物と、それを好きになったきっかけの出来事を教えてください'],
    'favorite-movie-book': ['心に残っている映画・本と、それに出会ったときの状況を教えてください'],
    'favorite-place': ['その場所が好きになった、具体的なきっかけや思い出はありますか？'],
    'favorite-commitment': ['そのこだわりが表れた、具体的な出来事はありますか？'],
    'skill-hobby-start': ['その趣味・特技を始めたきっかけや、のめり込んだ出来事があれば聞かせてください'],
    'skill-surprised-others': ['その特技を発揮して、周りが驚いた・助かった具体的な場面を教えてください'],
    'group-atmosphere': ['その雰囲気が一番出ていた、具体的な場面を一つ教えてください'],
    'group-catchphrase': ['その合言葉やあだ名が生まれた、きっかけの出来事を教えてください'],
    'group-skill-surprise': ['その得意なことを発揮して、周りが驚いた具体的な出来事を教えてください'],
    'group-skill-taught-juniors': ['その技やコツが後輩に伝わった、具体的な場面はありますか？']
  };

  // wiki を渡すと、そのカテゴリで既に答えた質問を除く。判定はまず questionKey の一致で行い
  // （言い回しを変えても同じ質問として認識するため）、questionKeyが無い古い記録（key導入前に
  // 保存されたもの）は本文の一致で補う。これにより、一度答えた固定質問がインタビューを
  // 開き直しても、言い回しを調整したあとでも繰り返されない。
  // 「この質問はとばす」で明示的にスキップされた質問（skippedKeys）も除く。答えていなくても、
  // 「もう聞かないでほしい」という意思表示として永続的に扱う。
  function buildInterviewQueue(type, wiki) {
    var bank = QUESTIONS[type] || QUESTIONS.person;
    var queue = [];
    var skipped = (wiki && wiki.skippedKeys) || [];
    CATEGORY_ORDER.forEach(function (cat) {
      var items = wiki && wiki[cat] ? wiki[cat] : [];
      var askedKeys = items.map(function (e) { return e.questionKey; }).filter(Boolean);
      var askedTexts = items.map(function (e) { return e.prompt; }).filter(Boolean);
      (bank[cat] || []).forEach(function (q) {
        if (askedKeys.indexOf(q.key) !== -1) return;
        if (askedTexts.indexOf(q.text) !== -1) return;
        if (skipped.indexOf(q.key) !== -1) return;
        var legacyTexts = LEGACY_QUESTION_TEXT[q.key];
        if (legacyTexts && legacyTexts.some(function (t) { return askedTexts.indexOf(t) !== -1; })) return;
        queue.push({ category: cat, question: q.text, key: q.key, depth: 0 });
      });
    });
    return queue;
  }

  // 「お金がかかってもいいのでしっかり深掘ってほしい」という要望を受け、
  // 1話題あたりの上限を引き上げている（Worker側もそれに合わせて質問の質を上げている）
  var MAX_AI_DEPTH = 6;

  // ---------- 旅行・イベント単位でエピソードをまとめる ----------

  // wiki（trips配列とepisodes配列を持つ）を渡すと、旅行・イベントごとにエピソードをまとめる。
  // エピソードが1件も無い旅行（作ったばかりのもの）も、ここに含めて返す。
  function groupEpisodesByTrip(wiki) {
    var episodes = wiki.episodes || [];
    var trips = wiki.trips || [];
    var byTripId = {};
    episodes.forEach(function (ep) {
      var key = ep.tripId || '';
      if (!byTripId[key]) byTripId[key] = [];
      byTripId[key].push(ep);
    });

    function newestOf(list) {
      return list.reduce(function (m, e) { return (e.createdAt || '') > m ? e.createdAt : m; }, '');
    }
    function byNewest(a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); }

    var named = trips.map(function (tr) {
      var eps = (byTripId[tr.id] || []).slice().sort(byNewest);
      return {
        trip: tr.title,
        tripId: tr.id,
        period: tr.period || '',
        episodes: eps,
        sortKey: eps.length ? newestOf(eps) : (tr.updatedAt || tr.createdAt || '')
      };
    }).sort(function (a, b) { return b.sortKey.localeCompare(a.sortKey); });

    var groups = named.map(function (g) { return { trip: g.trip, tripId: g.tripId, period: g.period, episodes: g.episodes }; });
    if (byTripId['']) {
      groups.push({ trip: '', tripId: '', period: '', episodes: byTripId[''].slice().sort(byNewest) });
    }
    return groups;
  }

  // 旅行の時期（自由記述）から西暦4桁を推測する。年代（2020年代、など）で
  // まとめて表示するために使う。見つからなければnullを返す。
  function tripYear(period) {
    var m = (period || '').match(/(19|20)\d{2}/);
    return m ? Number(m[0]) : null;
  }

  function tripEraLabel(period) {
    var year = tripYear(period);
    return year ? (Math.floor(year / 10) * 10) + '年代' : '時期不明';
  }

  // 「だれがいたか」を、エピソードの「書いた人」＋「その場にいた人」から重複なく集める
  function tripParticipants(episodes) {
    var seen = {};
    var names = [];
    (episodes || []).forEach(function (ep) {
      [ep.author].concat(ep.participants || []).forEach(function (n) {
        n = (n || '').trim();
        if (!n || seen[n]) return;
        seen[n] = true;
        names.push(n);
      });
    });
    return names;
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
    newTrip: newTrip,
    findOrCreateTrip: findOrCreateTrip,
    parseInfoboxText: parseInfoboxText,
    infoboxToText: infoboxToText,
    buildProfileContext: buildProfileContext,
    parseTags: parseTags,
    mergeEntryArrays: mergeEntryArrays,
    mergeWiki: mergeWiki,
    mergeImport: mergeImport,
    parseImportPayload: parseImportPayload,
    exportPayload: exportPayload,
    addContributor: addContributor,
    estimateBytes: estimateBytes,
    groupEpisodesByTrip: groupEpisodesByTrip,
    tripParticipants: tripParticipants,
    tripTitle: tripTitle,
    tripYear: tripYear,
    tripEraLabel: tripEraLabel,
    LABELS: LABELS,
    QUESTIONS: QUESTIONS,
    CATEGORY_ORDER: CATEGORY_ORDER,
    buildInterviewQueue: buildInterviewQueue,
    askedQuestionTexts: askedQuestionTexts
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
  var sessionAnswered = 0;
  var lastBreakCheckpoint = 0;
  var BREAK_EVERY = 15;
  var aiThreadHistory = [];
  var interviewHistory = []; // 「前の質問に戻る」用。各ステップで {index, category, entryId, text} を積む
  var pendingEpisodePhotos = [];
  var pendingCoverPhoto = null;
  var pendingInterviewPhotos = [];
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
        if (r.item.photos && r.item.photos.length) {
          thumbsHtml = '<div class="thumbs">' + r.item.photos.slice(0, 4).map(function (p) { return '<img src="' + p + '">'; }).join('') + '</div>';
        }
      }
      el.innerHTML =
        '<div class="body">' + bodyHtml + '</div>' + thumbsHtml +
        '<div class="foot"><span>' + escapeHtml(L[r.cat]) + (r.item.author ? '・' + escapeHtml(r.item.author) : '') +
          (r.item.tripId ? '・' + escapeHtml(tripTitle(w, r.item.tripId)) : '') +
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

  // 「〜でした、次」のように話し終わりに言うと、ボタンを押さなくても次へ進める。
  // お年寄りなど、画面の操作より声だけで完結させたい人のための仕組み。
  var NEXT_COMMAND_RE = /(次へ|次の質問|つぎ|次)\s*[。、,.]?\s*$/;

  function createMicController(textareaEl, btnEl, statusEl, onNext) {
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
      var triggered = false;
      if (finalChunk && onNext) {
        var m = finalChunk.match(NEXT_COMMAND_RE);
        if (m) {
          finalChunk = finalChunk.slice(0, m.index).trim();
          triggered = true;
        }
      }
      if (finalChunk) {
        baseText = (baseText ? baseText + '\n' : '') + finalChunk;
        textareaEl.value = baseText;
      }
      statusEl.textContent = on ? ('聞き取り中… ' + interimChunk) : (triggered ? '「次」と聞こえたので次へ進みます…' : '');
      if (triggered) {
        // recog.onresult の実行中に recog.stop() を呼ぶと不安定になることがあるため、一呼吸おく
        setTimeout(function () { onNext(); }, 0);
      }
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

  function setMicController(key, textareaEl, btnEl, statusEl, onNext) {
    if (micControllers[key]) micControllers[key].stop();
    var ctrl = createMicController(textareaEl, btnEl, statusEl, onNext);
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

  // 一問一答の生の回答を、AIにWikipedia記事のような自然な文章へ書き直してもらう。
  // 質問への追い質問より処理が重いので、タイムアウトを長めに取っている。
  // 成否だけでなく理由も返す（{ ok:true, data } または { ok:false, reason }）。
  // 「うまくいきませんでした」しか分からないと原因を切り分けられないため。
  function fetchAiCompose(payload) {
    var endpoint = getAiEndpoint();
    if (!endpoint) return Promise.resolve({ ok: false, reason: 'Workerが設定されていません' });
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 60000) : null;
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      if (res.status === 429) return { ok: false, reason: 'レート制限（1分あたりの上限）を超えました。1分ほど待ってからもう一度お試しください' };
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          return { ok: false, reason: 'サーバーエラー（' + res.status + (body && body.error ? '：' + body.error : '') + '）' };
        });
      }
      return res.json().then(function (data) {
        return (data && typeof data.overview === 'string')
          ? { ok: true, data: data }
          : { ok: false, reason: 'AIの応答を正しく読み取れませんでした' };
      });
    }).catch(function (e) {
      if (timer) clearTimeout(timer);
      return { ok: false, reason: (e && e.name === 'AbortError') ? '時間切れ（応答に時間がかかりすぎました）' : '通信エラー（' + (e && e.message ? e.message : '不明') + '）' };
    });
  }

  function composeWikiWithAi(w) {
    var endpoint = getAiEndpoint();
    if (!endpoint) {
      alert('AIでまとめるには、先にWorkerを公開してください（worker/README.md を参照）。');
      return;
    }
    var btn = $('#btnCompose');
    btn.disabled = true;
    var originalLabel = btn.textContent;
    btn.textContent = 'AIがまとめています…';
    $('#composeNote').textContent = '';

    var sections = {};
    ['history', 'personality', 'favorites', 'skills'].forEach(function (cat) {
      sections[cat] = (w[cat] || []).map(function (e) { return { prompt: e.prompt, text: e.text }; });
    });
    var episodes = (w.episodes || [])
      .filter(function (ep) { return ep.body; })
      .map(function (ep) { return { id: ep.id, title: ep.title, body: ep.body }; });

    fetchAiCompose({
      action: 'compose',
      subjectName: w.title || (w.type === 'group' ? 'このサークル・チーム' : 'この人'),
      subjectType: w.type,
      overview: w.overview || '',
      sections: sections,
      episodes: episodes
    }).then(function (result) {
      btn.disabled = false;
      btn.textContent = originalLabel;
      if (!result.ok) {
        alert('うまくまとめられませんでした。\n\n理由：' + result.reason);
        return;
      }
      w.composed = result.data;
      w.composedAt = nowIso();
      (result.data.episodes || []).forEach(function (item) {
        var ep = w.episodes.filter(function (e) { return e.id === item.id; })[0];
        if (ep && item.text) ep.composedBody = item.text;
      });
      persist();
      renderWikiPage(w);
    });
  }

  function setInterviewBusy(busy, msg) {
    $('#btnSaveQ').disabled = busy;
    $('#btnSkipQ').disabled = busy;
    $('#btnPrevQ').disabled = busy || interviewHistory.length === 0;
    $('#qMicStatus').textContent = msg || '';
  }

  // 既に答えた固定質問を飛ばした結果、その場で聞くことが無くなったら、
  // ヒアリングマスターのようにAIへ「ここまでの内容を踏まえて、まだ聞けていない
  // 話を引き出す質問」を考えてもらい、インタビューを終わらせずに育て続ける。
  function buildWikiDigest(w) {
    var L = LABELS[w.type];
    var parts = [];
    if (w.overview) parts.push('概要: ' + w.overview);
    CATEGORY_ORDER.forEach(function (cat) {
      var items = (w[cat] || []).slice(-5);
      if (!items.length) return;
      parts.push(L[cat] + ':\n' + items.map(function (e) {
        var text = e.text || e.body || '';
        return '・' + (e.prompt ? '[' + e.prompt + '] ' : '') + text.slice(0, 200);
      }).join('\n'));
    });
    return parts.join('\n\n').slice(0, 3000);
  }

  // そのカテゴリで、これまでに聞いた質問文の一覧（重複なし）。
  // buildWikiDigestは直近5件の「回答内容」しか渡せないため、記録が増えるほど
  // AIが同じ質問を再生成してしまう問題があった。質問文自体は短いので、
  // こちらは件数を絞らずできるだけ多く渡し、「何を聞いたか」を正確に伝える。
  var ASKED_QUESTIONS_BUDGET = 4000;
  function askedQuestionTexts(w, cat) {
    var seen = {};
    var list = [];
    (w[cat] || []).forEach(function (e) {
      var q = (e.prompt || '').trim();
      if (!q || seen[q]) return;
      seen[q] = true;
      list.push(q);
    });
    var budget = ASKED_QUESTIONS_BUDGET;
    var kept = [];
    for (var i = 0; i < list.length; i++) {
      if (budget - list[i].length < 0) break;
      budget -= list[i].length;
      kept.push(list[i]);
    }
    return kept;
  }

  function pickGrowthCategory(w) {
    var best = CATEGORY_ORDER[0], bestCount = Infinity;
    CATEGORY_ORDER.forEach(function (cat) {
      var n = (w[cat] || []).length;
      if (n < bestCount) { bestCount = n; best = cat; }
    });
    return best;
  }

  function growQueueWithAi(w) {
    var cat = pickGrowthCategory(w);
    var L = LABELS[w.type];
    var digest = buildWikiDigest(w);
    return fetchAiFollowUp({
      subjectName: w.title || (w.type === 'group' ? 'このサークル・チーム' : 'この人'),
      subjectType: w.type,
      categoryLabel: L[cat],
      question: '（決まった質問には答え終えました。ヒアリングマスターとして、ここまでの内容全体を踏まえ、まだ聞けていない具体的な話を引き出す質問を1つ考えてください。年代や時期を絞って深く聞くのも歓迎します）',
      answer: digest || '（まだ記録がありません。まずは基本的なことから聞いてください）',
      history: [],
      depth: 0,
      profile: buildProfileContext(w),
      askedQuestions: askedQuestionTexts(w, cat)
    }).then(function (result) {
      if (result && !result.done && result.followUp) {
        interviewQueue.push({ category: cat, question: result.followUp, depth: 0, dynamic: true, grown: true });
        return true;
      }
      return false;
    });
  }

  function startInterview() {
    var w = currentWiki();
    interviewQueue = buildInterviewQueue(w.type, w);
    interviewIndex = -1;
    sessionAnswered = 0;
    lastBreakCheckpoint = 0;
    aiThreadHistory = [];
    interviewHistory = [];
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
    advanceInterview();
  }

  function renderInterviewQuestion(prefillText) {
    var w = currentWiki();
    var L = LABELS[w.type];
    var q = interviewQueue[interviewIndex];
    if (q.depth === 0) aiThreadHistory = [];
    $('#interviewProgress').style.width = Math.min(100, Math.round((interviewIndex / interviewQueue.length) * 100)) + '%';
    $('#qCategory').textContent = L[q.category] + (q.dynamic ? '・AIの深掘り' : '') + '（' + (interviewIndex + 1) + ' / ' + interviewQueue.length + '）';
    $('#qText').textContent = q.question;
    $('#qAnswer').value = prefillText || '';
    $('#qPhotos').value = '';
    pendingInterviewPhotos = [];
    refreshInterviewPhotoPreview();
    setInterviewBusy(false, '');

    var ctrl = setMicController('interview', $('#qAnswer'), $('#qMicBtn'), $('#qMicStatus'), function () {
      if (!$('#btnSaveQ').disabled) saveInterviewAnswer(false);
    });
    if ($('#voiceModeToggle').checked) {
      speak(q.question, function () { ctrl.start(); });
    }
  }

  // 直前の質問に戻る。すでに保存されていた回答があれば取り消し（削除）、
  // テキストボックスに戻して書き直せるようにする。「戻る」＝取り消して答え直す、という設計。
  function goToPreviousQuestion() {
    if (!interviewHistory.length) return;
    stopAllMics();
    window.speechSynthesis && window.speechSynthesis.cancel();
    var last = interviewHistory.pop();
    var w = currentWiki();
    if (last.entryId) {
      var arr = w[last.category] || [];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].id === last.entryId) { arr.splice(i, 1); break; }
      }
      sessionAnswered = Math.max(0, sessionAnswered - 1);
      w.updatedAt = nowIso();
      persist();
    }
    if (aiThreadHistory.length) aiThreadHistory.pop();
    interviewIndex = last.index;
    renderInterviewQuestion(last.text);
  }

  function advanceInterview() {
    // 何問か答えるごとに、続けるかどうかを聞く（お年寄りなど、長く話すと疲れる人のための一区切り）
    if (sessionAnswered > 0 && sessionAnswered !== lastBreakCheckpoint && sessionAnswered % BREAK_EVERY === 0) {
      lastBreakCheckpoint = sessionAnswered;
      window.speechSynthesis && window.speechSynthesis.cancel();
      var keepGoing = confirm(
        'ここまでで' + sessionAnswered + '問お答えいただきました。少し休憩しますか？\n\n' +
        '「OK」で続ける／「キャンセル」で今日はここまでにする（答えた内容はもう保存されているので、続きはまた今度できます）'
      );
      if (!keepGoing) {
        finishInterview('今日はここまでにしましょう。お疲れさまでした。続きはまた今度、「質問で深掘りする」から始められます。');
        return;
      }
    }

    interviewIndex++;
    if (interviewIndex < interviewQueue.length) {
      renderInterviewQuestion();
      return;
    }
    // 決まった質問を使い切った。AIで深掘りがオンならヒアリングマスターとして質問を育て続ける
    if ($('#aiDeepenToggle').checked && getAiEndpoint()) {
      setInterviewBusy(true, 'AIが次に聞くことを考えています…');
      growQueueWithAi(currentWiki()).then(function (grew) {
        if (grew) { renderInterviewQuestion(); }
        else { finishInterview(); }
      });
      return;
    }
    finishInterview();
  }

  function finishInterview(message) {
    window.speechSynthesis && window.speechSynthesis.cancel();
    alert(message || '決まっている質問には答え終えました。またいつでも「質問で深掘りする」から続きができます。');
    openDash(currentWikiId);
  }

  function saveInterviewAnswer(skip) {
    stopAllMics();
    var w = currentWiki();
    var q = interviewQueue[interviewIndex];
    var text = $('#qAnswer').value.trim();
    var author = $('#ivAuthor').value.trim();

    if (skip || !text) {
      // 明示的に「とばす」を押した固定質問は、二度と聞かないよう永続的に記憶する
      // （答えていなくても「もう聞かないでほしい」という意思表示として扱う）
      if (skip && q.key && w.skippedKeys.indexOf(q.key) === -1) {
        w.skippedKeys.push(q.key);
        persist();
      }
      interviewHistory.push({ index: interviewIndex, category: q.category, entryId: null, text: text });
      advanceInterview();
      return;
    }

    var savedEntry;
    if (q.category === 'episodes') {
      savedEntry = newEpisode({ body: text, author: author, prompt: q.question, questionKey: q.key, photos: pendingInterviewPhotos.slice() });
      w.episodes.push(savedEntry);
    } else {
      savedEntry = newEntry(text, author, q.question, q.key, pendingInterviewPhotos.slice());
      w[q.category].push(savedEntry);
    }
    interviewHistory.push({ index: interviewIndex, category: q.category, entryId: savedEntry.id, text: text });
    addContributor(w, author);
    w.updatedAt = nowIso();
    persist();
    sessionAnswered++;

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
      depth: q.depth,
      profile: buildProfileContext(w),
      askedQuestions: askedQuestionTexts(w, q.category)
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

  function refreshInterviewPhotoPreview() {
    renderPhotoPreview('#qPhotoPreview', pendingInterviewPhotos, function (i) {
      pendingInterviewPhotos.splice(i, 1);
      refreshInterviewPhotoPreview();
    });
  }

  function resetEpisodeForm() {
    $('#epTitle').value = '';
    $('#epBody').value = '';
    $('#epPeriod').value = '';
    $('#epTrip').value = '';
    $('#epParticipants').value = '';
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

  // 旅行の詳細画面から「＋ このイベントにエピソードを追加」で開いたときは、そのTripを覚えておき、
  // 保存後もダッシュボードではなく同じ旅行の詳細画面に戻る（旅行の中のエピソード、という
  // 階層を、保存後の遷移でも一貫させるため）。
  var episodeFormReturnTripId = null;

  function openEpisodeForm(prefillTripId) {
    resetEpisodeForm();
    var w = currentWiki();
    $('#epTripList').innerHTML = w.trips.map(function (tr) {
      return '<option value="' + escapeHtml(tr.title) + '">';
    }).join('');
    episodeFormReturnTripId = prefillTripId || null;
    if (prefillTripId) $('#epTrip').value = tripTitle(w, prefillTripId);
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
      author: author, period: $('#epPeriod').value.trim(), tripId: findOrCreateTrip(w, $('#epTrip').value.trim(), $('#epPeriod').value.trim()),
      participants: parseTags($('#epParticipants').value),
      tags: parseTags($('#epTags').value)
    });
    w.episodes.push(ep);
    addContributor(w, author);
    w.updatedAt = nowIso();
    persist();
    stopAllMics();
    if (episodeFormReturnTripId) { openTripDetail(episodeFormReturnTripId); return; }
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
    var bodyHtml = '<p class="wp-card-text">' + escapeHtml(ep.composedBody || ep.body) + '</p>' +
      (ep.composedBody
        ? '<details class="wp-raw-toggle"><summary>元の文章を見る</summary><p class="wp-card-text">' + escapeHtml(ep.body) + '</p></details>'
        : '');
    return '<div class="wp-card">' + img +
      '<div class="wp-card-body"><div class="wp-card-title">' + escapeHtml(title) + '</div>' +
      bodyHtml +
      '<div class="wp-card-meta"><span>' + escapeHtml(ep.period || '') + more + '</span><span>' + escapeHtml(ep.author || '') + '</span></div></div></div>';
  }

  // ---------- 旅行・イベントでまとめる画面 ----------

  var currentTripKey = null;

  function renderTripsList() {
    var w = currentWiki();
    var listEl = $('#tripsList');
    var groups = groupEpisodesByTrip(w).filter(function (g) { return g.trip; });
    if (!groups.length) {
      listEl.innerHTML = '<div class="empty">まだ「旅行・イベント名」をつけたエピソードがありません。「エピソードを追加する」で旅行・イベント名と「いつ頃」を入力すると、ここにカレンダーのように年代別でまとまります。</div>';
      return;
    }

    // 年代（2020年代、など）ごとにまとめる。groupsは既に新しい順のため、その順のまま振り分ける。
    var eraOrder = [];
    var byEra = {};
    groups.forEach(function (g) {
      var era = tripEraLabel(g.period);
      if (!byEra[era]) { byEra[era] = []; eraOrder.push(era); }
      byEra[era].push(g);
    });
    eraOrder.sort(function (a, b) {
      if (a === '時期不明') return 1;
      if (b === '時期不明') return -1;
      return parseInt(b, 10) - parseInt(a, 10);
    });

    listEl.innerHTML = '';
    eraOrder.forEach(function (era) {
      var heading = document.createElement('h2');
      heading.className = 'trips-era-heading';
      heading.textContent = era;
      listEl.appendChild(heading);

      byEra[era].forEach(function (g) {
        var thumb = '';
        for (var i = 0; i < g.episodes.length; i++) {
          if (g.episodes[i].photos && g.episodes[i].photos[0]) { thumb = g.episodes[i].photos[0]; break; }
        }
        var participants = tripParticipants(g.episodes);
        var subParts = [];
        if (g.period) subParts.push(g.period);
        subParts.push(participants.length ? participants.join('、') : '参加者は未記録');
        var card = document.createElement('button');
        card.className = 'wiki-card';
        card.innerHTML =
          '<span class="thumb" ' + (thumb ? 'style="background-image:url(' + thumb + ')"' : '') + '>' + (thumb ? '' : '🧳') + '</span>' +
          '<span class="meta">' +
            '<span class="name">' + escapeHtml(g.trip) + '</span>' +
            '<span class="sub">' + escapeHtml(subParts.join('・')) + '</span>' +
            '<span class="tag">エピソード' + g.episodes.length + '件</span>' +
          '</span>';
        card.addEventListener('click', function () { openTripDetail(g.tripId); });
        listEl.appendChild(card);
      });
    });
  }

  function openTripDetail(tripId) {
    currentTripKey = tripId;
    renderTripDetail(tripId);
    showScreen('tripDetail');
  }

  function renderTripDetail(tripId) {
    var w = currentWiki();
    var group = groupEpisodesByTrip(w).filter(function (g) { return g.tripId === tripId; })[0];
    if (!group) { renderTripsList(); showScreen('trips'); return; }
    $('#tripDetailTitle').textContent = group.trip;
    $('#tripDetailPeriod').textContent = group.period ? ('時期：' + group.period) : '';
    var participants = tripParticipants(group.episodes);
    $('#tripDetailParticipants').textContent = participants.length
      ? ('だれがいたか：' + participants.join('、'))
      : '「その場にいた人」はまだ記録されていません';
    var sorted = group.episodes.slice().sort(function (a, b) { return (a.createdAt || '').localeCompare(b.createdAt || ''); });
    $('#tripDetailEpisodes').innerHTML = sorted.map(episodeCardHtml).join('');
  }

  // 旅行の名前・時期はTripという1つの実体で持っているため、ここで直せば紐づく全エピソードに反映される
  function renameCurrentTrip() {
    var w = currentWiki();
    var trip = w.trips.filter(function (t) { return t.id === currentTripKey; })[0];
    if (!trip) return;
    var name = prompt('旅行・イベント名を入力してください', trip.title);
    if (name === null) return;
    name = name.trim();
    if (!name) return;
    var period = prompt('時期を入力してください（例：2023年8月・任意、年代別のまとめ表示に使います）', trip.period || '');
    if (period === null) return;
    period = period.trim();
    if (name === trip.title && period === (trip.period || '')) return;
    trip.title = name;
    trip.period = period;
    trip.updatedAt = nowIso();
    persist();
    renderTripDetail(currentTripKey);
  }

  function formatDateTimeJa(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日' + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
  }

  function rawEntryListHtml(items) {
    if (!items.length) return '<p class="wp-empty">まだ記録がありません。</p>';
    return '<ul class="wp-list">' + items.map(function (it) {
      var photosHtml = it.photos && it.photos.length
        ? '<div class="thumbs">' + it.photos.slice(0, 4).map(function (p) { return '<img src="' + p + '">'; }).join('') + '</div>'
        : '';
      return '<li>' + (it.prompt ? '<div class="q">' + escapeHtml(it.prompt) + '</div>' : '') +
        escapeHtml(it.text) + photosHtml + (it.author ? '<div class="who">' + escapeHtml(it.author) + 'より</div>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  // AIでまとめた文章のうち、「・」で始まる行が複数あれば箇条書き（年譜など）として、
  // それ以外は通常の文章として表示する。
  function composedTextHtml(text) {
    var lines = text.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    var isBulleted = lines.length > 1 && lines.every(function (l) { return /^[・\-]/.test(l); });
    if (isBulleted) {
      return '<ul class="wp-compose-list">' + lines.map(function (l) {
        return '<li>' + escapeHtml(l.replace(/^[・\-]\s*/, '')) + '</li>';
      }).join('') + '</ul>';
    }
    return '<p>' + escapeHtml(text) + '</p>';
  }

  // AIでまとめた文章があればそれを本文にし、元の一問一答は<details>で折りたたんで残す。
  // まとめていなければ、これまでどおり一問一答をそのまま並べる。
  function sectionBodyHtml(w, cat) {
    var items = w[cat] || [];
    var composedText = w.composed && w.composed[cat];
    if (composedText) {
      return composedTextHtml(composedText) +
        (items.length ? '<details class="wp-raw-toggle"><summary>元の回答を見る（' + items.length + '件）</summary>' + rawEntryListHtml(items) + '</details>' : '');
    }
    return rawEntryListHtml(items);
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

    var overviewText = (w.composed && w.composed.overview) ? w.composed.overview : (w.overview || '');
    html += '<section id="sec-overview"><h2>概要</h2><p>' + (overviewText ? escapeHtml(overviewText) : autoOverview(w)) + '</p></section>';

    CATEGORY_ORDER.filter(function (c) { return c !== 'episodes'; }).forEach(function (cat) {
      html += '<section id="sec-' + cat + '"><h2>' + L[cat] + '</h2>' + sectionBodyHtml(w, cat) + '</section>';
    });

    html += '<section id="sec-episodes"><h2>' + L.episodes + '・アルバム</h2>';
    if (!w.episodes.length) {
      html += '<p class="wp-empty">まだエピソードがありません。</p>';
    } else {
      var groups = groupEpisodesByTrip(w);
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

    var categoryTags = [L.kind].concat(groupEpisodesByTrip(w).map(function (g) { return g.trip; }).filter(Boolean));
    html += '<div class="wp-categories"><b>カテゴリ：</b>' +
      categoryTags.map(function (t) { return '<span class="tag">' + escapeHtml(t) + '</span>'; }).join('') + '</div>';

    page.innerHTML = html;

    var note = $('#composeNote');
    if (note) {
      note.textContent = w.composed
        ? ('✨ ' + formatDateTimeJa(w.composedAt) + 'にAIがまとめた文章です。各項目の「元の回答を見る」からいつでも元のやり取りを確認できます。')
        : '';
    }
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
    $('#tileEpisode').addEventListener('click', function () { openEpisodeForm(); });
    $('#tileProfile').addEventListener('click', openProfileForm);
    $('#tileView').addEventListener('click', function () {
      renderWikiPage(currentWiki());
      $('#btnCompose').hidden = !getAiEndpoint();
      showScreen('view');
    });
    $('#tileTrips').addEventListener('click', function () {
      renderTripsList();
      showScreen('trips');
    });
    $('#btnRenameTrip').addEventListener('click', renameCurrentTrip);
    $('#btnAddTripEpisode').addEventListener('click', function () { openEpisodeForm(currentTripKey); });

    $('#btnPrevQ').addEventListener('click', goToPreviousQuestion);
    $('#btnSkipQ').addEventListener('click', function () { saveInterviewAnswer(true); });
    $('#btnSaveQ').addEventListener('click', function () { saveInterviewAnswer(false); });

    $('#epPhotos').addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files);
      Promise.all(files.map(function (f) { return fileToCompressedDataURL(f, 1280, 0.72); })).then(function (urls) {
        pendingEpisodePhotos = pendingEpisodePhotos.concat(urls);
        refreshEpisodePhotoPreview();
      });
    });
    $('#qPhotos').addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files);
      Promise.all(files.map(function (f) { return fileToCompressedDataURL(f, 1280, 0.72); })).then(function (urls) {
        pendingInterviewPhotos = pendingInterviewPhotos.concat(urls);
        refreshInterviewPhotoPreview();
      });
    });
    $('#btnSaveEpisode').addEventListener('click', saveEpisode);
    $('#btnEpisodeBack').addEventListener('click', function () {
      stopAllMics();
      if (episodeFormReturnTripId) { openTripDetail(episodeFormReturnTripId); return; }
      showScreen('dash');
      renderDash();
    });

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
    $('#btnCompose').addEventListener('click', function () { composeWikiWithAi(currentWiki()); });

    $all('.back').forEach(function (b) {
      b.addEventListener('click', function () {
        stopAllMics();
        window.speechSynthesis && window.speechSynthesis.cancel();
        showScreen(b.dataset.back);
        if (b.dataset.back === 'home') renderHome();
        if (b.dataset.back === 'dash') renderDash();
        if (b.dataset.back === 'trips') renderTripsList();
      });
    });

    renderHome();
  }

  document.addEventListener('DOMContentLoaded', init);
})(typeof window !== 'undefined' ? window : this);
