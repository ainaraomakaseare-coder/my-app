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
      stops: [],
      stopDetails: [],
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
    return { id: uid('t'), title: (title || '').trim(), period: (period || '').trim(), startDate: '', endDate: '', lodging: '', createdAt: t, updatedAt: t };
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

  // 「過ごした一日」＝旅行の中の時系列の記録。モデルコース（お手本の予定）ではなく、
  // 実際に過ごした行程をあとから記録するためのもの。
  // 大項目（Stop）＝日付・時間・種類だけを持つ、タイムラインの1コマ（「14:00 到着」など）。
  function newStop(data) {
    var t = nowIso();
    return {
      id: uid('st'),
      tripId: data.tripId || '',
      date: (data.date || '').trim(),
      time: (data.time || '').trim(),
      timeLabel: (data.timeLabel || '').trim(),
      type: (data.type || '').trim(),
      createdAt: t,
      updatedAt: t
    };
  }

  // 小項目（StopDetail）＝1つのStopの中で、誰か1人（またはグループ）が実際に体験した内容。
  // 別行動した場合は、同じStopに複数のStopDetailをぶら下げればよい。
  function newStopDetail(data) {
    var t = nowIso();
    return {
      id: uid('sd'),
      stopId: data.stopId || '',
      author: (data.author || '').trim(),
      episode: (data.episode || '').trim(),
      comment: (data.comment || '').trim(),
      photos: data.photos || [],
      pricePerPerson: data.pricePerPerson || '',
      priceBreakdown: data.priceBreakdown || [],
      waitTime: (data.waitTime || '').trim(),
      mapUrl: (data.mapUrl || '').trim(),
      shopUrl: (data.shopUrl || '').trim(),
      ratings: data.ratings || [],
      createdAt: t,
      updatedAt: t
    };
  }

  // その時系列（Stop）に属するエピソード（StopDetail）を、日付・時刻の順に並べて返す
  function stopsForTrip(wiki, tripId) {
    return (wiki.stops || []).filter(function (s) { return s.tripId === tripId; })
      .slice()
      .sort(function (a, b) {
        var ak = (a.date || '') + 'T' + (a.time || '');
        var bk = (b.date || '') + 'T' + (b.time || '');
        return ak.localeCompare(bk);
      });
  }

  function detailsForStop(wiki, stopId) {
    return (wiki.stopDetails || []).filter(function (d) { return d.stopId === stopId; })
      .slice()
      .sort(function (a, b) { return (a.createdAt || '').localeCompare(b.createdAt || ''); });
  }

  // 小項目（StopDetail）に、誰か1人の評価（1〜5）を付ける・上書きする。
  // 「評価はそれぞれの人ができるように」という要望のため、同じ名前の人が
  // もう一度評価すると、新しい評価で上書きする（連打で無限に増えないように）。
  function rateStopDetail(detail, author, score) {
    var name = (author || '').trim();
    var s = Number(score);
    if (!name || !s || s < 1 || s > 5) return detail;
    var existing = detail.ratings.filter(function (r) { return r.author === name; })[0];
    if (existing) { existing.score = s; }
    else { detail.ratings.push({ author: name, score: s }); }
    detail.updatedAt = nowIso();
    return detail;
  }

  function averageRating(detail) {
    var ratings = (detail && detail.ratings) || [];
    if (!ratings.length) return null;
    var sum = ratings.reduce(function (s, r) { return s + r.score; }, 0);
    return Math.round((sum / ratings.length) * 10) / 10;
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
    if (!Array.isArray(w.stops)) w.stops = [];
    if (!Array.isArray(w.stopDetails)) w.stopDetails = [];
    w.stopDetails.forEach(function (d) {
      if (!Array.isArray(d.ratings)) d.ratings = [];
      if (!Array.isArray(d.priceBreakdown)) d.priceBreakdown = [];
    });
    // 旧バージョン（旅行を自由記述の文字列で持っていた）のエピソードを、
    // 旅行エンティティ＋tripId参照の形に変換する
    w.episodes.forEach(function (ep) {
      if (ep.tripId === undefined) ep.tripId = '';
      if (typeof ep.trip === 'string' && ep.trip.trim() && !ep.tripId) {
        ep.tripId = findOrCreateTrip(w, ep.trip);
      }
      delete ep.trip;
    });
    // 開始日・終了日（startDate/endDate）・宿泊先（lodging）追加前に作られた旅行にも欄を補う
    w.trips.forEach(function (tr) {
      if (tr.startDate === undefined) tr.startDate = '';
      if (tr.endDate === undefined) tr.endDate = '';
      if (tr.lodging === undefined) tr.lodging = '';
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
      stops: mergeEntryArrays(existing.stops, incoming.stops),
      stopDetails: mergeEntryArrays(existing.stopDetails, incoming.stopDetails),
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
      // 本物のWikipediaの「来歴」のように、学校名・会社名・年・役職など、記事の骨組みになる事実を聞く。
      // 言い回しを変えても答え済みの判定はkeyで行うため、keyは変えないこと。
      history: [
        { key: 'birth-place', text: 'まずは基本から！生まれた場所を教えてください（都道府県・市区町村まで分かると嬉しいです）' },
        { key: 'birth-date', text: '生年月日を教えてください（西暦・元号どちらでも大丈夫です）' },
        { key: 'name-origin', text: 'お名前の由来や、名付けた人を知っていますか？昔からのあだ名や呼ばれ方もあれば教えてください' },
        { key: 'family-of-origin', text: '育った家族のことを教えてください。ご両親のお仕事や、きょうだいは何人で何番目でしたか？' },
        { key: 'birth-story', text: '生まれたときのエピソードで、家族から聞いている面白い話はありますか？' },
        { key: 'blood-type', text: '血液型は何ですか？分かれば教えてください' },
        { key: 'kindergarten', text: '通っていた幼稚園・保育園の名前を教えてください！当時どんな子どもだったかも聞かせてください' },
        { key: 'elementary-school', text: '小学校の名前と、入学した年を教えてください。小学校時代の一番の思い出もぜひ！' },
        { key: 'elementary-friends', text: '小学校で仲の良かった友達や、忘れられない先生の名前は覚えていますか？どんな人でしたか？' },
        { key: 'junior-high', text: '中学校の名前を教えてください。入っていた部活や、一番夢中になっていたことは何でしたか？' },
        { key: 'club-achievements', text: '部活や習いごとで、大会の成績・賞・級や段など、形に残った結果はありますか？何年のことかも教えてください' },
        { key: 'high-school', text: '高校の名前と、何科・どのコースだったかを教えてください。高校時代の忘れられない出来事もぜひ！' },
        { key: 'high-school-friends', text: '高校で仲の良かった友達や、よく一緒にいた人は誰でしたか？その人たちとの思い出も教えてください' },
        { key: 'coming-of-age', text: '成人式はどこで、どんなふうに迎えましたか？一緒にいた人や、その日の思い出も聞かせてください' },
        { key: 'leaving-home', text: '初めて実家を出て暮らし始めたのはいつ、どこでしたか？そのころの暮らしぶりも教えてください' },
        { key: 'college-or-job', text: '高校のあと、進んだ大学・専門学校（学部・学科まで）や就職先を教えてください。そこを選んだ理由も！' },
        { key: 'college-good-bad', text: 'そこに入って一番良かったこと、そして一番つらかった・悲しかったこと、それぞれ聞かせてください' },
        { key: 'college-circle', text: '大学・専門学校で入っていたサークル・部活・ゼミの名前を教えてください。そこで仲の良かった人や出来事も！' },
        { key: 'part-time-job', text: 'アルバイトは何をしていましたか？お店や会社の名前と、そこで印象に残っている出来事を教えてください' },
        { key: 'first-job', text: '最初に働いた会社・職場の名前と、入った年、最初に担当した仕事を教えてください' },
        { key: 'first-big-purchase', text: '初めて自分のお金で買った大きな買い物（車・バイクなど）は何でしたか？買ったときのワクワクも聞かせてください' },
        { key: 'first-overseas', text: '初めて海外に行ったのはいつ、どこでしたか？そのときの驚きや思い出も教えてください' },
        { key: 'career', text: 'その後の仕事の歩みを、古い順に教えてください。会社名・部署や役職・だいたいの年を分かる範囲で！' },
        { key: 'job-change', text: '転職・独立・転勤など、仕事の大きな変化はありましたか？何年に、どうしてそうしたのかも教えてください' },
        { key: 'work-achievement', text: '仕事で一番誇れる成果や、任された大きな仕事は何ですか？何年ごろのことかも教えてください' },
        { key: 'qualifications-awards', text: '取った資格や免許、表彰されたことはありますか？取った年も分かれば教えてください' },
        { key: 'marriage', text: '結婚した年と、お相手との出会い（馴れ初め）を教えてください' },
        { key: 'children', text: 'お子さんやお孫さんについて、生まれた年やお名前など、話せる範囲で教えてください' },
        { key: 'home', text: '家を建てた・買った、あるいは長く暮らした家の思い出はありますか？いつ、どこだったかも教えてください' },
        { key: 'pets', text: '一緒に暮らしたペットはいますか？名前や、家に来た年、思い出のエピソードも聞かせてください' },
        { key: 'moving', text: '住んだことのある場所を、古い順に教えてください。引っ越しのきっかけも分かれば！' },
        { key: 'grandchildren', text: '初めてお孫さんが生まれたのはいつですか？そのときの気持ちも聞かせてください' },
        { key: 'illness', text: '大きな病気やけがを乗り越えた経験はありますか？（話せる範囲で大丈夫です）' },
        { key: 'community', text: '地域の活動やボランティア、入っていた会や団体はありますか？そこでの役割も教えてください' },
        { key: 'retirement', text: '仕事に区切りをつけた（退職した）のはいつですか？そのときの気持ちや、その後の暮らしも聞かせてください' },
        { key: 'milestone-birthday', text: '還暦や古希など、節目の誕生日はどんなふうに迎えましたか？誰にどうお祝いしてもらいましたか？' },
        { key: 'turning-point', text: 'これまでの人生で、一番大きな転機・決断だったと思う出来事は何ですか？何年ごろのことですか？' }
      ],
      personality: [
        { key: 'personality-summary', text: '自分の性格をひとことで言うと、どんな感じだと思いますか？そう思うきっかけになった具体的な出来事も、あわせて聞かせてください！' },
        { key: 'personality-surprise-laugh', text: '「らしいな」と周りが思わず笑った・驚いた瞬間はありますか？そのときの状況も聞かせてください' },
        { key: 'personality-unexpected-action', text: 'これまでで一番意外だった行動は何でしたか？何があってそうなったか、ぜひ教えてください' },
        { key: 'personality-helped-someone', text: '誰かが困っているのを見て、実際にどう動いたか。覚えている場面を一つ教えてください' },
        { key: 'personality-belief', text: '「これだけは譲れない」という信念や考え方はありますか？それを貫いた具体的な出来事も教えてください' },
        { key: 'personality-influence', text: '人生で一番影響を受けた人は誰ですか？（家族・先生・有名人など）どんな影響を受けましたか？' },
        { key: 'personality-motto', text: '座右の銘や、よく口にする言葉・口ぐせはありますか？' }
      ],
      // 好きなものは「事実を聞く」より「気持ちよく語ってもらう」ことを優先する聞き方にしている
      favorites: [
        { key: 'favorite-food', text: '一番好きな食べ物は何ですか？どこがたまらなく好きなのか、思う存分語ってください！' },
        { key: 'favorite-song', text: '一番好きな曲と、歌っている人を教えてください！その曲のどこにグッとくるのか、ぜひ聞かせてください' },
        { key: 'favorite-movie-book', text: '何度でも人にすすめたくなる映画や本はありますか？タイトルと、どこが最高なのかを聞かせてください！' },
        { key: 'favorite-fan', text: '応援しているチームや、夢中になった有名人はいますか？好きになった瞬間のこと、ぜひ聞かせてください！' },
        { key: 'favorite-place', text: '一番好きな場所はどこですか？そこにいると、どんな気分になれますか？' },
        { key: 'favorite-holiday', text: '最高だった休日の一日を教えてください！朝から晩まで、どこで何をしましたか？' },
        { key: 'favorite-commitment', text: '「これにはちょっとうるさいよ」というこだわりはありますか？ぜひ熱く語ってください！' },
        { key: 'favorite-hobby', text: '今ハマっていることは何ですか？その魅力を、知らない人にも伝わるように教えてください！' },
        { key: 'favorite-recommend', text: '好きなものの中で「これだけは一度味わってほしい！」と人にすすめたいものはありますか？' },
        { key: 'favorite-happy-moment', text: 'どんなときに一番「幸せだなあ」と感じますか？' }
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
        startDate: tr.startDate || '',
        endDate: tr.endDate || '',
        lodging: tr.lodging || '',
        episodes: eps,
        sortKey: eps.length ? newestOf(eps) : (tr.updatedAt || tr.createdAt || '')
      };
    }).sort(function (a, b) { return b.sortKey.localeCompare(a.sortKey); });

    var groups = named.map(function (g) {
      return { trip: g.trip, tripId: g.tripId, period: g.period, startDate: g.startDate, endDate: g.endDate, lodging: g.lodging, episodes: g.episodes, sortKey: g.sortKey };
    });
    if (byTripId['']) {
      groups.push({ trip: '', tripId: '', period: '', startDate: '', endDate: '', lodging: '', episodes: byTripId[''].slice().sort(byNewest), sortKey: '' });
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

  // "2023-08-10" や "2023-08-10T14:00" のような日付・日時入力(input type=datetime-local)の
  // 値を「2023年8月10日」「2023年8月10日 14:00」に整形する
  function formatDateJa(isoDateTime) {
    var bits = (isoDateTime || '').split('T');
    var parts = (bits[0] || '').split('-');
    if (parts.length !== 3) return '';
    var text = Number(parts[0]) + '年' + Number(parts[1]) + '月' + Number(parts[2]) + '日';
    if (bits[1]) text += ' ' + bits[1].slice(0, 5);
    return text;
  }

  // 旅行グループ（groupEpisodesByTripの返り値の1件）の表示用の日時文字列。
  // 開始日時・終了日時が入力されていればそちらを優先し、無ければ自由記述のperiodにフォールバックする。
  // 同じ日の中の時間帯（例：結婚式が14時〜18時）なら、日付を繰り返さず時刻だけつなげる。
  function tripDateLabel(g) {
    if (g.startDate) {
      var startDatePart = g.startDate.split('T')[0];
      var endDatePart = g.endDate ? g.endDate.split('T')[0] : '';
      if (g.endDate && g.endDate !== g.startDate) {
        if (endDatePart === startDatePart) {
          var startTime = (g.startDate.split('T')[1] || '').slice(0, 5);
          var endTime = (g.endDate.split('T')[1] || '').slice(0, 5);
          if (startTime && endTime) return formatDateJa(startDatePart) + ' ' + startTime + '〜' + endTime;
        }
        return formatDateJa(g.startDate) + '〜' + formatDateJa(g.endDate);
      }
      return formatDateJa(g.startDate);
    }
    return g.period || '';
  }

  // 年代でのまとめ表示に使う西暦。開始日があればその年を優先し、無ければperiodの自由記述から推測する。
  function tripSortYear(g) {
    if (g.startDate) {
      var y = Number(g.startDate.slice(0, 4));
      if (y) return y;
    }
    return tripYear(g.period);
  }

  function yearToEraLabel(year) {
    return year ? (Math.floor(year / 10) * 10) + '年代' : '時期不明';
  }

  function monthDayOf(isoDate) {
    return isoDate ? isoDate.slice(5, 10) : ''; // "MM-DD"
  }

  // 旅行の期間（startDate〜endDate、endDateが無ければ単日）が、指定した月日（年は問わない）に
  // 重なっているか。年をまたぐ期間（例：12/28〜1/3）にも対応する。
  function dateRangeIncludesMonthDay(startDate, endDate, monthDay) {
    if (!startDate) return false;
    var start = monthDayOf(startDate);
    var end = endDate ? monthDayOf(endDate) : start;
    if (start <= end) return monthDay >= start && monthDay <= end;
    return monthDay >= start || monthDay <= end;
  }

  // 今日の月日を"MM-DD"で返す。端末のローカルタイムゾーンで判定する（UTC基準のnowIso()だと
  // 日本時間の日付とずれることがあるため、Dateのローカルgetter（getMonth/getDate）を使う）。
  function todayMonthDay() {
    var d = new Date();
    var mm = d.getMonth() + 1;
    var dd = d.getDate();
    return (mm < 10 ? '0' + mm : '' + mm) + '-' + (dd < 10 ? '0' + dd : '' + dd);
  }

  // 「今日は何の日」：過去の旅行の中から、今日と同じ月日（年は問わない）に重なるものを探す
  function onThisDayTrips(wiki, monthDay) {
    return (wiki.trips || []).filter(function (tr) {
      return dateRangeIncludesMonthDay(tr.startDate, tr.endDate, monthDay);
    });
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
    newStop: newStop,
    newStopDetail: newStopDetail,
    stopsForTrip: stopsForTrip,
    detailsForStop: detailsForStop,
    rateStopDetail: rateStopDetail,
    averageRating: averageRating,
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
    formatDateJa: formatDateJa,
    tripDateLabel: tripDateLabel,
    tripSortYear: tripSortYear,
    yearToEraLabel: yearToEraLabel,
    dateRangeIncludesMonthDay: dateRangeIncludesMonthDay,
    onThisDayTrips: onThisDayTrips,
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

  // Lucide（https://lucide.dev, ISC License）のパスだけを持ち、ビルドなしでSVGアイコンとして描く
  var ICONS = {
    'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'plus': '<path d="M5 12h14"/><path d="M12 5v14"/>',
    'mic': '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
    'camera': '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
    'square-pen': '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>',
    'book-open': '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    'luggage': '<path d="M6 20a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2"/><path d="M8 18V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v14"/><path d="M10 20h4"/><circle cx="16" cy="20" r="2"/><circle cx="8" cy="20" r="2"/>',
    'printer': '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
    'pencil': '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    'calendar': '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
    'banknote': '<rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
    'clock': '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    'map-pin': '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
    'external-link': '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    'download': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    'upload': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
    'trash': '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>'
  };

  function icon(name) {
    return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  function hydrateIcons() {
    $all('[data-icon]').forEach(function (el) { el.innerHTML = icon(el.dataset.icon); });
  }

  // 1件のWikiの読み込み（normalizeWiki）が予期せず失敗しても、他のWikiまで
  // 巻き込んで消えてしまわないよう、Wikiごとに個別にtry/catchする。
  // （以前はここで1つでも例外が出ると、保存されている全Wikiが見えなくなっていた）
  function loadStore() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyStore();
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.wikis) return emptyStore();
      Object.keys(parsed.wikis).forEach(function (k) {
        try { normalizeWiki(parsed.wikis[k]); }
        catch (e) { console.error('Wikiの読み込みに失敗しました（id: ' + k + '）。このWikiだけ復旧できませんでした。', e); }
      });
      return parsed;
    } catch (e) {
      console.error('保存データの読み込みに失敗しました。', e);
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
        '<span class="thumb" ' + thumb + '>' + (w.coverPhoto ? '' : escapeHtml(avatarInitial(w.title))) + '</span>' +
        '<span class="meta">' +
          '<span class="name">' + escapeHtml(w.title || '（名前未設定）') + '</span>' +
          '<span class="sub">' + escapeHtml(w.subtitle || '') + '</span>' +
          '<span class="tag">' + (LABELS[w.type].kind) + '・記録' + count + '件</span>' +
        '</span>' + icon('chevron-right');
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

  function speakWithBrowser(text, onend) {
    if (!supportsSynthesis()) { if (onend) onend(); return; }
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    if (onend) u.onend = onend;
    window.speechSynthesis.speak(u);
  }

  // 読み上げはWorker経由のGemini TTSを優先し、使えないときはブラウザ標準の音声に切り替える。
  // 1つの<audio>を使い回すのは、iPhoneなどで「最初のタップで一度鳴らした要素」しか後から再生できないため。
  var ttsAudio = null;
  var ttsUnavailable = false; // Worker側にGeminiのキーが無いと分かったら、このページを開いている間は試さない
  var speakToken = 0;
  var SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

  function unlockTtsAudio() {
    if (ttsAudio) return;
    ttsAudio = new Audio();
    ttsAudio.src = SILENT_WAV;
    var p = ttsAudio.play();
    if (p && p.catch) p.catch(function () {});
  }

  function stopSpeaking() {
    speakToken++;
    if (ttsAudio) { ttsAudio.pause(); ttsAudio.onended = null; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  // 標準の声に切り替わった理由。画面に出して、原因（キー未登録・利用上限など）が分かるようにする
  var TTS_FALLBACK_REASONS = {
    tts_not_configured: 'WorkerにGeminiのAPIキーが登録されていません',
    gemini_rate_limited: 'Geminiの利用回数の上限に達しました（無料枠の上限の可能性があります）',
    rate_limited: '読み上げの回数がアプリ側の上限（1分30回）に達しました',
    upstream_error: 'Gemini側でエラーが起きました',
    timeout: 'Geminiの応答に時間がかかりすぎました',
    network: 'Workerに接続できませんでした',
    play_blocked: 'ブラウザが音声の再生を止めました（画面を一度タップすると直ることがあります）'
  };
  var lastTtsError = '';

  function fetchSpeechOnce(text) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 15000) : null;
    return fetch(getAiEndpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'tts', text: text }),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      var type = res.headers.get('content-type') || '';
      if (res.ok && type.indexOf('audio/') === 0) return res.blob().then(function (blob) { return { blob: blob }; });
      return res.json().catch(function () { return {}; }).then(function (body) {
        return { error: body.error || 'upstream_error', status: body.upstreamStatus || res.status };
      });
    }).catch(function (e) {
      if (timer) clearTimeout(timer);
      return { error: e && e.name === 'AbortError' ? 'timeout' : 'network' };
    });
  }

  function fetchSpeech(text) {
    if (!getAiEndpoint() || ttsUnavailable) return Promise.resolve(null);
    return fetchSpeechOnce(text).then(function (r) {
      // 一時的な失敗（混雑・通信の瞬断など）は、少し待って1回だけやり直す
      if (r.blob || r.error === 'tts_not_configured' || r.error === 'invalid_input') return r;
      return new Promise(function (resolve) { setTimeout(resolve, 1500); }).then(function () { return fetchSpeechOnce(text); });
    }).then(function (r) {
      if (r.blob) return r.blob;
      // キーが本当に未登録のときだけ、このページを開いている間はGeminiを試さない
      if (r.error === 'tts_not_configured') ttsUnavailable = true;
      lastTtsError = r.error + (r.status ? '（コード' + r.status + '）' : '');
      console.warn('Geminiの読み上げに失敗したため、ブラウザ標準の声に切り替えました：' + lastTtsError);
      return null;
    });
  }

  function showTtsNote(errorKey) {
    var el = $('#ttsNote');
    if (!el) return;
    if (!errorKey) { el.textContent = ''; return; }
    var key = errorKey.split('（')[0];
    el.textContent = 'Geminiの声が使えなかったため、ブラウザ標準の声で読み上げています。理由：' +
      (TTS_FALLBACK_REASONS[key] || errorKey) + (errorKey.indexOf('（') !== -1 ? errorKey.slice(errorKey.indexOf('（')) : '');
  }

  // 作った音声は質問文ごとに覚えておき、同じ質問を読むときは作り直さない（待ち時間も費用も減る）
  var speechCache = {};
  var speechCacheOrder = [];
  var SPEECH_CACHE_MAX = 20;

  function getSpeech(text) {
    if (speechCache[text]) return speechCache[text];
    var p = fetchSpeech(text).then(function (blob) {
      if (!blob && speechCache[text] === p) delete speechCache[text];
      return blob;
    });
    speechCache[text] = p;
    speechCacheOrder.push(text);
    if (speechCacheOrder.length > SPEECH_CACHE_MAX) delete speechCache[speechCacheOrder.shift()];
    return p;
  }

  // 今の質問を読んでいる間に、次の質問の音声を先に作っておく
  function prefetchSpeech(text) {
    if (!text || !getAiEndpoint() || ttsUnavailable || speechCache[text]) return;
    getSpeech(text);
  }

  function speak(text, onend, onwaiting) {
    stopSpeaking();
    var token = speakToken;
    var fallback = function (reason) {
      if (token !== speakToken) return;
      if (getAiEndpoint()) showTtsNote(reason || lastTtsError);
      speakWithBrowser(text, onend);
    };
    var pending = getSpeech(text);
    var waitingTimer = onwaiting ? setTimeout(function () { if (token === speakToken) onwaiting(true); }, 300) : null;
    pending.then(function (blob) {
      if (waitingTimer) clearTimeout(waitingTimer);
      if (token !== speakToken) return;
      if (onwaiting) onwaiting(false);
      if (!blob) { fallback(); return; }
      showTtsNote('');
      if (!ttsAudio) ttsAudio = new Audio();
      var url = URL.createObjectURL(blob);
      ttsAudio.onended = function () {
        URL.revokeObjectURL(url);
        if (token === speakToken && onend) onend();
      };
      ttsAudio.src = url;
      var played = ttsAudio.play();
      if (played && played.catch) played.catch(function () { URL.revokeObjectURL(url); fallback('play_blocked'); });
    });
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
      speak(q.question, function () { ctrl.start(); }, function (waiting) {
        $('#qMicStatus').textContent = waiting ? '読み上げを準備しています…' : '';
      });
      var next = interviewQueue[interviewIndex + 1];
      getSpeech(q.question).then(function () { if (next) prefetchSpeech(next.question); });
    }
  }

  // 直前の質問に戻る。すでに保存されていた回答があれば取り消し（削除）、
  // テキストボックスに戻して書き直せるようにする。「戻る」＝取り消して答え直す、という設計。
  function goToPreviousQuestion() {
    if (!interviewHistory.length) return;
    stopAllMics();
    stopSpeaking();
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
      stopSpeaking();
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
    stopSpeaking();
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

  // 「今日は何の日」：今日と同じ月日の旅行が過去にあれば、一覧の上に出す
  function renderOnThisDay(w) {
    var el = $('#tripsOnThisDay');
    var trips = onThisDayTrips(w, todayMonthDay());
    if (!trips.length) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="on-this-day"><div class="on-this-day-title">' + icon('calendar') + '今日は何の日</div><ul>' +
      trips.map(function (tr) {
        var year = tr.startDate ? tr.startDate.slice(0, 4) : '';
        return '<li data-trip-id="' + tr.id + '">' + (year ? year + '年 ' : '') + escapeHtml(tr.title) + '</li>';
      }).join('') + '</ul></div>';
    $all('#tripsOnThisDay [data-trip-id]').forEach(function (li) {
      li.addEventListener('click', function () { openTripDetail(li.dataset.tripId); });
    });
  }

  function renderTripsList() {
    var w = currentWiki();
    renderOnThisDay(w);
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
      var era = yearToEraLabel(tripSortYear(g));
      if (!byEra[era]) { byEra[era] = []; eraOrder.push(era); }
      byEra[era].push(g);
    });
    eraOrder.sort(function (a, b) {
      if (a === '時期不明') return 1;
      if (b === '時期不明') return -1;
      return parseInt(b, 10) - parseInt(a, 10);
    });
    // 各年代の中では、開始日が分かっているものを新しい順に（分からないものは元の並び順のまま）
    eraOrder.forEach(function (era) {
      byEra[era].sort(function (a, b) {
        if (a.startDate && b.startDate) return b.startDate.localeCompare(a.startDate);
        if (a.startDate) return -1;
        if (b.startDate) return 1;
        return 0;
      });
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
        var dateLabel = tripDateLabel(g);
        if (dateLabel) subParts.push(dateLabel);
        subParts.push(participants.length ? participants.join('、') : '参加者は未記録');
        var card = document.createElement('button');
        card.className = 'wiki-card';
        card.innerHTML =
          '<span class="thumb" ' + (thumb ? 'style="background-image:url(' + thumb + ')"' : '') + '>' + (thumb ? '' : icon('luggage')) + '</span>' +
          '<span class="meta">' +
            '<span class="name">' + escapeHtml(g.trip) + '</span>' +
            '<span class="sub">' + escapeHtml(subParts.join('・')) + '</span>' +
            '<span class="tag">エピソード' + g.episodes.length + '件</span>' +
          '</span>' + icon('chevron-right');
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
    var dateLabel = tripDateLabel(group);
    $('#tripDetailPeriod').textContent = dateLabel ? ('時期：' + dateLabel) : '';
    $('#tripDetailLodging').textContent = group.lodging ? ('宿泊先：' + group.lodging) : '';
    var participants = tripParticipants(group.episodes);
    $('#tripDetailParticipants').textContent = participants.length
      ? ('だれがいたか：' + participants.join('、'))
      : '「その場にいた人」はまだ記録されていません';
    var sorted = group.episodes.slice().sort(function (a, b) { return (a.createdAt || '').localeCompare(b.createdAt || ''); });
    $('#tripDetailEpisodes').innerHTML = sorted.map(episodeCardHtml).join('');
    closeTripEditForm();
    renderStopsTimeline(tripId);
    closeStopForm();
    closeStopDetailForm();
  }

  // 旅行の名前・開始日時・終了日時・宿泊先はTripという1つの実体で持っているため、
  // ここで直せば紐づく全エピソードに反映される。カレンダー要素として使えるよう、
  // 日時はprompt()ではなくinput type=datetime-localで入力する。
  function openTripEditForm() {
    var w = currentWiki();
    var trip = w.trips.filter(function (t) { return t.id === currentTripKey; })[0];
    if (!trip) return;
    $('#tripEditName').value = trip.title;
    $('#tripEditStart').value = trip.startDate || '';
    $('#tripEditEnd').value = trip.endDate || '';
    $('#tripEditLodging').value = trip.lodging || '';
    $('#tripEditForm').hidden = false;
    $('#btnRenameTrip').hidden = true;
  }

  function closeTripEditForm() {
    $('#tripEditForm').hidden = true;
    $('#btnRenameTrip').hidden = false;
  }

  function saveTripEdit() {
    var w = currentWiki();
    var trip = w.trips.filter(function (t) { return t.id === currentTripKey; })[0];
    if (!trip) return;
    var name = $('#tripEditName').value.trim();
    if (!name) { alert('旅行・イベント名を入力してください'); return; }
    var start = $('#tripEditStart').value;
    var end = $('#tripEditEnd').value;
    if (start && end && end < start) { alert('終了日時は開始日時より後にしてください'); return; }
    trip.title = name;
    trip.startDate = start;
    trip.endDate = end;
    trip.lodging = $('#tripEditLodging').value.trim();
    trip.updatedAt = nowIso();
    persist();
    renderTripDetail(currentTripKey);
  }

  // ---------- 過ごした一日（Stop＝大項目／StopDetail＝小項目） ----------
  // モデルコースではなく実際に過ごした記録。大項目（日時・タイミング・種類）の下に、
  // 小項目（誰が・何をしたか）を複数ぶら下げられるので、別行動した時間帯も
  // 同じ大項目の中に記録を分けて残せる。

  var pendingStopDetailPhotos = [];
  var pendingDetailStopId = null;

  function avatarInitial(name) {
    var s = (name || '').trim();
    return s ? s.charAt(0) : '?';
  }

  function avatarColor(name) {
    var s = String(name || '?');
    var hash = 0;
    for (var i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    return 'hsl(' + (hash % 360) + ', 32%, 40%)';
  }

  function stopHeaderLabel(stop) {
    var when = formatDateJa(stop.date + (stop.time ? ('T' + stop.time) : ''));
    return when || '日時未記入';
  }

  function yen(v) {
    var n = Number(v);
    return (v === '' || v == null || isNaN(n)) ? escapeHtml(String(v == null ? '' : v)) : n.toLocaleString('ja-JP');
  }

  function stopDayLabel(date) {
    var p = (date || '').split('-');
    if (p.length !== 3) return '日付未記入';
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return formatDateJa(date) + '（' + '日月火水木金土'.charAt(d.getDay()) + '）';
  }

  function stopDetailHtml(detail) {
    var photosHtml = detail.photos && detail.photos.length
      ? '<div class="thumbs">' + detail.photos.slice(0, 4).map(function (p) { return '<img src="' + p + '" alt="">'; }).join('') + '</div>'
      : '';
    var metaBits = [];
    if (detail.pricePerPerson !== '' && detail.pricePerPerson != null) metaBits.push('<span class="stop-meta-item">' + icon('banknote') + '一人 ' + yen(detail.pricePerPerson) + '円</span>');
    if (detail.waitTime) metaBits.push('<span class="stop-meta-item">' + icon('clock') + '待ち ' + escapeHtml(detail.waitTime) + '</span>');
    if (detail.mapUrl) metaBits.push('<a class="stop-meta-item stop-link" href="' + escapeHtml(detail.mapUrl) + '" target="_blank" rel="noopener">' + icon('map-pin') + '地図</a>');
    if (detail.shopUrl) metaBits.push('<a class="stop-meta-item stop-link" href="' + escapeHtml(detail.shopUrl) + '" target="_blank" rel="noopener">' + icon('external-link') + 'お店のHP</a>');
    var breakdownHtml = detail.priceBreakdown && detail.priceBreakdown.length
      ? '<details class="stop-breakdown"><summary>明細を見る</summary><dl>' +
        detail.priceBreakdown.map(function (b) { return '<div><dt>' + escapeHtml(b.label || '') + '</dt><dd>' + yen(b.amount) + '円</dd></div>'; }).join('') +
        '</dl></details>'
      : '';
    var avg = averageRating(detail);
    var ratingCount = (detail.ratings || []).length;
    var avgHtml = avg != null
      ? ('<span class="stop-rating-avg">★' + avg + '（' + ratingCount + '件）</span>')
      : '<span class="stop-rating-avg is-empty">まだ評価がありません</span>';
    return '<div class="stop-detail">' +
      '<div class="stop-detail-avatar" style="background:' + avatarColor(detail.author) + '">' + escapeHtml(avatarInitial(detail.author)) + '</div>' +
      '<div class="stop-detail-body">' +
      '<div class="stop-detail-author">' + escapeHtml(detail.author || '名前未記入') + '</div>' +
      (detail.episode ? '<p class="stop-detail-text">' + escapeHtml(detail.episode) + '</p>' : '') +
      (detail.comment ? '<p class="stop-detail-comment">' + escapeHtml(detail.comment) + '</p>' : '') +
      photosHtml +
      (metaBits.length ? '<div class="stop-detail-meta">' + metaBits.join('') + '</div>' : '') +
      breakdownHtml +
      '<div class="stop-rating">' + avgHtml +
      '<form class="stop-rate-form" data-detail-id="' + detail.id + '">' +
      '<input type="text" class="rate-name" placeholder="お名前" aria-label="評価する人の名前" required>' +
      '<select class="rate-score" aria-label="点数">' +
      [5, 4, 3, 2, 1].map(function (n) { return '<option value="' + n + '">★' + n + '</option>'; }).join('') +
      '</select>' +
      '<button type="submit" class="btn outline small">評価する</button>' +
      '</form>' +
      '</div>' +
      '</div>' +
      '</div>';
  }

  function stopCardHtml(w, stop) {
    var details = detailsForStop(w, stop.id);
    return '<li class="stop-card">' +
      '<div class="stop-time">' + escapeHtml(stop.time || '—') + '</div>' +
      '<div class="stop-main">' +
      '<div class="stop-card-head">' +
      '<span class="stop-label">' + escapeHtml(stop.timeLabel || '予定') + '</span>' +
      (stop.type ? '<span class="stop-type">' + escapeHtml(stop.type) + '</span>' : '') +
      '</div>' +
      (details.length ? '<div class="stop-detail-list">' + details.map(stopDetailHtml).join('') + '</div>' : '') +
      '<button class="btn text small add-detail-btn" data-stop-id="' + stop.id + '">' + icon('plus') + '記録を追加（別行動もOK）</button>' +
      '</div>' +
      '</li>';
  }

  // 日付ごとに見出しを立て、その中で時刻を左端にそろえて並べる（「その日どう過ごしたか」を縦に読めるように）
  function renderStopsTimeline(tripId) {
    var w = currentWiki();
    var stops = stopsForTrip(w, tripId);
    if (!stops.length) {
      $('#stopsTimeline').innerHTML = '<p class="stop-empty">まだ予定が記録されていません。「予定を追加」から始めましょう。</p>';
      return;
    }
    var days = [];
    stops.forEach(function (s) {
      var last = days[days.length - 1];
      if (!last || last.date !== s.date) days.push({ date: s.date, stops: [s] });
      else last.stops.push(s);
    });
    $('#stopsTimeline').innerHTML = days.map(function (d) {
      return '<div class="stop-day"><h3 class="stop-day-heading">' + escapeHtml(stopDayLabel(d.date)) + '</h3>' +
        '<ol class="stop-list">' + d.stops.map(function (s) { return stopCardHtml(w, s); }).join('') + '</ol></div>';
    }).join('');
  }

  function openStopForm() {
    $('#stopDate').value = '';
    $('#stopTime').value = '';
    $('#stopTimeLabel').value = '';
    $('#stopType').value = '';
    $('#stopFormWrap').hidden = false;
  }

  function closeStopForm() {
    $('#stopFormWrap').hidden = true;
  }

  function saveStop() {
    var w = currentWiki();
    var date = $('#stopDate').value;
    if (!date) { alert('日付を入力してください'); return; }
    var stop = newStop({
      tripId: currentTripKey,
      date: date,
      time: $('#stopTime').value,
      timeLabel: $('#stopTimeLabel').value,
      type: $('#stopType').value
    });
    w.stops.push(stop);
    w.updatedAt = nowIso();
    persist();
    closeStopForm();
    renderStopsTimeline(currentTripKey);
  }

  function refreshStopDetailPhotoPreview() {
    renderPhotoPreview('#sdPhotoPreview', pendingStopDetailPhotos, function (i) {
      pendingStopDetailPhotos.splice(i, 1);
      refreshStopDetailPhotoPreview();
    });
  }

  function openStopDetailForm(stopId) {
    pendingDetailStopId = stopId;
    var w = currentWiki();
    var stop = w.stops.filter(function (s) { return s.id === stopId; })[0];
    $('#stopDetailFormTarget').textContent = stop ? ('「' + stopHeaderLabel(stop) + (stop.timeLabel ? '　' + stop.timeLabel : '') + '」への記録') : '';
    $('#sdAuthor').value = '';
    $('#sdEpisode').value = '';
    $('#sdComment').value = '';
    $('#sdPhotos').value = '';
    $('#sdPrice').value = '';
    $('#sdWait').value = '';
    $('#sdMapUrl').value = '';
    $('#sdShopUrl').value = '';
    $('#sdBreakdownRows').innerHTML = '';
    pendingStopDetailPhotos = [];
    refreshStopDetailPhotoPreview();
    $('#stopDetailFormWrap').hidden = false;
    $('#stopDetailFormWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function closeStopDetailForm() {
    pendingDetailStopId = null;
    $('#stopDetailFormWrap').hidden = true;
  }

  function addBreakdownRow() {
    var row = document.createElement('div');
    row.className = 'field-row breakdown-row';
    row.innerHTML = '<div class="field"><input type="text" class="bd-label" placeholder="例：入場料"></div>' +
      '<div class="field"><input type="number" class="bd-amount" min="0" placeholder="円"></div>' +
      '<button type="button" class="btn ghost small bd-remove" aria-label="この明細を削除">' + icon('trash') + '</button>';
    row.querySelector('.bd-remove').addEventListener('click', function () { row.remove(); });
    $('#sdBreakdownRows').appendChild(row);
  }

  function collectBreakdownRows() {
    return $all('#sdBreakdownRows .breakdown-row').map(function (row) {
      var label = row.querySelector('.bd-label').value.trim();
      var amountRaw = row.querySelector('.bd-amount').value;
      return { label: label, amount: amountRaw === '' ? '' : Number(amountRaw) };
    }).filter(function (b) { return b.label || b.amount !== ''; });
  }

  function saveStopDetail() {
    if (!pendingDetailStopId) return;
    var w = currentWiki();
    var author = $('#sdAuthor').value.trim();
    var episode = $('#sdEpisode').value.trim();
    if (!author) { alert('記録した人の名前を入力してください'); return; }
    var priceRaw = $('#sdPrice').value;
    var detail = newStopDetail({
      stopId: pendingDetailStopId,
      author: author,
      episode: episode,
      comment: $('#sdComment').value.trim(),
      photos: pendingStopDetailPhotos.slice(),
      pricePerPerson: priceRaw === '' ? '' : Number(priceRaw),
      priceBreakdown: collectBreakdownRows(),
      waitTime: $('#sdWait').value.trim(),
      mapUrl: $('#sdMapUrl').value.trim(),
      shopUrl: $('#sdShopUrl').value.trim()
    });
    w.stopDetails.push(detail);
    addContributor(w, author);
    w.updatedAt = nowIso();
    persist();
    closeStopDetailForm();
    renderStopsTimeline(currentTripKey);
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
        ? (formatDateTimeJa(w.composedAt) + 'にAIがまとめた文章です。各項目の「元の回答を見る」からいつでも元のやり取りを確認できます。')
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
    hydrateIcons();
    document.addEventListener('pointerdown', unlockTtsAudio, { once: true });

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
    $('#btnRenameTrip').addEventListener('click', openTripEditForm);
    $('#btnSaveTripEdit').addEventListener('click', saveTripEdit);
    $('#btnCancelTripEdit').addEventListener('click', closeTripEditForm);
    $('#btnAddTripEpisode').addEventListener('click', function () { openEpisodeForm(currentTripKey); });

    $('#btnAddStop').addEventListener('click', openStopForm);
    $('#btnSaveStop').addEventListener('click', saveStop);
    $('#btnCancelStop').addEventListener('click', closeStopForm);
    $('#btnAddBreakdownRow').addEventListener('click', addBreakdownRow);
    $('#btnSaveStopDetail').addEventListener('click', saveStopDetail);
    $('#btnCancelStopDetail').addEventListener('click', closeStopDetailForm);
    $('#sdPhotos').addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files);
      Promise.all(files.map(function (f) { return fileToCompressedDataURL(f, 1280, 0.72); })).then(function (urls) {
        pendingStopDetailPhotos = pendingStopDetailPhotos.concat(urls);
        refreshStopDetailPhotoPreview();
      });
    });
    $('#stopsTimeline').addEventListener('click', function (e) {
      var btn = e.target.closest('.add-detail-btn');
      if (btn) openStopDetailForm(btn.dataset.stopId);
    });
    $('#stopsTimeline').addEventListener('submit', function (e) {
      var form = e.target.closest('.stop-rate-form');
      if (!form) return;
      e.preventDefault();
      var w = currentWiki();
      var detail = w.stopDetails.filter(function (d) { return d.id === form.dataset.detailId; })[0];
      if (!detail) return;
      var name = form.querySelector('.rate-name').value.trim();
      var score = Number(form.querySelector('.rate-score').value);
      if (!name) { alert('お名前を入力してください'); return; }
      rateStopDetail(detail, name, score);
      persist();
      renderStopsTimeline(currentTripKey);
    });

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
        stopSpeaking();
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
