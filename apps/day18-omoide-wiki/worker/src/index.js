/*
 * おもいでWiki AI深掘りWorker。
 * 固定質問への回答を読み、内容に応じた追加質問を1つだけ作って返す。
 * 個人の話す内容を扱うため、DAY05のドラマ王Workerと違いキャッシュはしない
 * （使い回す意味がなく、個人的な回答をCloudflareのキャッシュに残したくないため）。
 */
const OPENAI_URL = "https://api.openai.com/v1/responses";
const MAX_HISTORY = 4;

// Web版（GitHub Pages）・手元での確認（localhost）・iOSアプリ（Capacitor）の3つからの通信を受け付ける。
// iOSアプリの中のページは、設定や版によって https://localhost か capacitor://localhost のどちらかになる。
function isAllowedOrigin(origin, allowed) {
  return origin === allowed
    || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "")
    || /^(capacitor|ionic):\/\/localhost$/.test(origin || "");
}

function cors(origin, allowed) {
  const ok = isAllowedOrigin(origin, allowed);
  return {
    "access-control-allow-origin": ok ? origin : allowed,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "vary": "Origin",
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function validTurn(t) {
  return t && typeof t.q === "string" && t.q.length <= 300
    && typeof t.a === "string" && t.a.length <= 4000;
}

function validInput(x) {
  return x
    && typeof x.subjectName === "string" && x.subjectName.length >= 1 && x.subjectName.length <= 100
    && (x.subjectType === "person" || x.subjectType === "group")
    && typeof x.categoryLabel === "string" && x.categoryLabel.length >= 1 && x.categoryLabel.length <= 40
    && typeof x.question === "string" && x.question.length >= 1 && x.question.length <= 300
    && typeof x.answer === "string" && x.answer.length >= 1 && x.answer.length <= 4000
    && Array.isArray(x.history) && x.history.length <= MAX_HISTORY && x.history.every(validTurn)
    && Number.isInteger(x.depth) && x.depth >= 0 && x.depth <= 10
    && (x.profile === undefined || (typeof x.profile === "string" && x.profile.length <= 1000))
    && (x.askedQuestions === undefined || (
      Array.isArray(x.askedQuestions) && x.askedQuestions.length <= 200
      && x.askedQuestions.every(q => typeof q === "string" && q.length <= 300)
    ));
}

function schema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["done", "followUp"],
    properties: {
      done: { type: "boolean" },
      followUp: { type: "string", maxLength: 140 },
    },
  };
}

// 個人のWikiだけ、Wikipediaの「来歴」に載る事実を補う観点を先頭に足す（サークル・チームは今回の見直しの対象外）
const FACT_ANGLES = [
  "正式名称・固有名詞（「地元の高校」「会社」「友達」のようにぼかされている、学校名・会社名・部署名・店名・地名・人名）",
  "いつのことか（西暦の年・そのときの年齢・続いた期間）",
  "所属・役職・肩書・担当（部活のポジション、会社での役職、任された役割など）",
  "数字で表せること（人数、順位、記録、期間など）",
  "結果とその後（大会の結果、受賞、昇進、周りからの評価など）",
  "その時期の前後にあった人生の節目で、まだ聞けていないもの（進学・就職・転職・結婚・出産・引っ越し・家を建てた・ペットを迎えた・大病を乗り越えた・孫の誕生など）",
];

const ANGLES = [
  "いつ、どこでの出来事か（具体的な日時・場所）",
  "そのとき一緒にいた人や、その時期によく一緒にいた友人・仲間との関係",
  "そのときの気持ち・心境の変化",
  "そのきっかけになった出来事・決断の理由",
  "一番良かったこと・嬉しかったことと、一番つらかった・悲しかったこと",
  "印象に残っている言葉やセリフ",
  "その出来事のあと、何がどう変わったか",
  "記憶に残っている細かい情景（見た景色、聞いた音、食べたものなど）",
  "似たようなことが他の時期にもあったか",
  "その人の趣味・特技・夢中になっていることについて、まだ聞けていない話（始めたきっかけ、のめり込んだ出来事、それを通じて出会った人など）",
  "生まれ年・結成年などから分かる時代に、日本で流行っていた具体的なテレビ番組・音楽・芸能人・グループなどを挙げて、好きだったか尋ねる（年代がプロフィール表や会話から推測できる場合のみ）",
];

function prompt(data) {
  const who = data.subjectType === "group" ? "サークルやチームの思い出" : "その人の人生";
  const history = data.history.map(t => `質問「${t.q}」→回答「${t.a}」`).join("\n");
  const len = data.answer.length;
  const isPerson = data.subjectType === "person";
  const isFavorites = isPerson && (data.categoryLabel === "好きなもの" || data.categoryLabel === "特技");
  const angles = isPerson ? FACT_ANGLES.concat(ANGLES) : ANGLES;
  return [
    `あなたは「${who}」をもっともっと深く知っていきたい、プロのインタビュアーです。話し相手は「${data.subjectName}」について話しています。`,
    "この記録は、あとで家族が読み返したときに「こんなにいろいろな経験をしてきた、豊かな人生だったんだ」と実感できるように残すものです。抽象的な感想で終わらせず、いつ・どこで・誰と・何をしたという具体的な場面（旅行ならどこに行ったか、など）が1つでも多く残るように質問してください。",
    isPerson && !isFavorites ? "この記録は最終的に、本物のWikipediaの記事のような形にまとめます。Wikipediaの記事には「何年に」「どこの（正式名称）」「何をして」「どんな役職・立場で」「どんな結果だったか」という事実が欠かせません。直前の回答でこれらがぼかされている・抜けている場合（例：「地元の高校に行った」「会社に入った」「大会で優勝した」のように、名前・年・大会名などが無い）は、まずその抜けている事実を1つか2つ、自然な会話の流れで聞き出してください（例：「その高校はなんという学校でしたか？何年ごろ卒業されました？」）。事実がそろっている場合は、そのときの出来事・気持ち・その後などのエピソードを深掘りしてください。回答やこれまでのやり取りにすでに出てきた事実を聞き直さないこと。" : "",
    isFavorites ? "今は本人の好きなもの・得意なことの話です。ここでは事実を集めるよりも、話している本人が気持ちよくなって『もっと話したい！』と感じることを最優先にしてください。心から興味を持った聞き手として、どこがたまらなく好きなのか、ハマったきっかけ、一番の思い出、人にすすめるならどこか、それをしているときの気分、などを聞き、好きなものを思う存分『語ってもらう』聞き方にすること。相づちでは本人の好きなものを一緒に面白がり、共感や驚きをしっかり伝えること。作品名・店名・チーム名などが抜けていれば、話の流れで自然に聞いてもよい。" : "",
    isPerson && !isFavorites
      ? "直前の回答を読み、以下の「深掘りの観点」の中から、今の回答にとって一番足りないもの・一番ネタになりそうなものを1つ選んでください（上の方針どおり、事実が抜けていれば事実を補う観点を優先）。趣味・特技の話が出てきたら積極的に深掘りしてください。"
      : "直前の回答を読み、以下の「深掘りの観点」の中から、今の回答にとって一番ネタになりそうなもの（具体的なエピソードとして語れそうなもの）を1つ選んでください。趣味・特技の話が出てきたら積極的に深掘りしてください。",
    "深掘りの観点：\n" + angles.map(a => "・" + a).join("\n"),
    "選んだ観点に沿って、追加質問を1つ作ってください。ただし、いきなり質問文だけを出すのではなく、直前の回答を受けた短い相づちや感想（「それは大変でしたね」「いいですね」「へえ、〇〇だったんですね」など）を一言添えてから、自然に質問へつなげてください。友人と雑談しているような、温かく自然な話し言葉にすること（100文字程度まで）。「〜について教えてください」のような機械的な言い回しは避け、普段の会話で聞くような聞き方にすること。箇条書きや記号は使わないこと。",
    "答える側が『それ聞かれるの嬉しいな、もっと話したいな』とウキウキ・ワクワクした気持ちになるような、明るく前のめりな聞き方にすること。関心・驚き・楽しみが伝わる言葉選びを心がけ、事務的・機械的な響きは避けること。",
    isPerson
      ? "深掘りを続けるかどうか：回答が短くても、名前・年などWikipediaに載せたい事実が抜けている、または好きなものをもっと語ってもらえそうなら、深掘りしてください（done は false）。「覚えていない」「特にない」「言いたくない」のように、答えられない・答えたくない様子なら、無理に聞かず done を true にしてください。回答が具体的でエピソードや感情が豊富な場合は、まだ聞ける観点が残っていれば done を false にして積極的に深掘りを続けてください。"
      : "深掘りを続けるかどうかは、直前の回答の分量・具体性で判断してください。回答がごく短い・情報が薄い（相槌程度、数文字〜十数文字など）場合は、無理に深掘りせず done を true にしてください。反対に、回答が具体的でエピソードや感情が豊富に語られている場合は、まだ聞ける観点が残っていれば done を false にして積極的に深掘りを続けてください。",
    isPerson
      ? `今の回答の文字数：${len}文字（${len < 15 ? "短い回答。事実が抜けていれば補う質問を、答えられない様子なら done に" : len < 40 ? "やや短め。抜けている事実や、もっと語ってもらえる余地がないか確かめる" : "十分な分量があるので、深掘りの余地を積極的に探ってよい"}）`
      : `今の回答の文字数：${len}文字（${len < 15 ? "かなり短いので、無理に深掘りしないほうがよい" : len < 40 ? "やや短め" : "十分な分量があるので、深掘りの余地を積極的に探ってよい"}）`,
    `この話題はすでに${data.depth}回深掘りしています。${data.depth >= 6 ? "十分な回数なので、余程ネタがなければ done にしてください。" : ""}`,
    data.profile ? `プロフィール表：\n${data.profile}\n（生年月日や結成年などがここに書かれていれば、その時代に日本で流行っていた具体的な番組・音楽・芸能人を挙げて「〇〇はお好きでしたか？」のように尋ねると喜ばれます。年代が分からない・自信が持てない場合は、無理に使わず他の観点にしてください。不確かな年代で古すぎる／新しすぎるものを挙げるのは避けること）` : "",
    `カテゴリ：${data.categoryLabel}`,
    `今の質問：${data.question}`,
    `今の回答：${data.answer}`,
    history ? `これまでのやり取り：\n${history}` : "",
    (data.askedQuestions && data.askedQuestions.length)
      ? "【重要】このカテゴリではすでに以下の質問を聞いています。同じ内容・ほぼ同じ聞き方の質問は絶対に繰り返さないでください（記録が増えて見返せなくなり、同じことを何度も聞かれたと本人を困らせてしまいます）。ここに出てくる話題から自然に派生する、まだ聞けていない新しい角度の質問であれば問題ありません：\n"
        + data.askedQuestions.map(q => "・" + q).join("\n")
      : "",
  ].filter(Boolean).join("\n");
}

const COMPOSE_CATS = ["history", "personality", "favorites", "skills"];

function validComposeItem(it) {
  return it && typeof it.text === "string" && it.text.length <= 4000
    && (it.prompt === undefined || it.prompt === null || (typeof it.prompt === "string" && it.prompt.length <= 300));
}

function validComposeEpisode(it) {
  return it && typeof it.id === "string" && it.id.length >= 1 && it.id.length <= 50
    && typeof it.title === "string" && it.title.length <= 200
    && typeof it.body === "string" && it.body.length >= 1 && it.body.length <= 4000;
}

// 「質問100個でもいい」という要望があるため、件数の上限は厚めに取っている。
function validComposeInput(x) {
  if (!x || typeof x.subjectName !== "string" || x.subjectName.length < 1 || x.subjectName.length > 100) return false;
  if (x.subjectType !== "person" && x.subjectType !== "group") return false;
  if (typeof x.overview !== "string" || x.overview.length > 2000) return false;
  if (!x.sections || typeof x.sections !== "object") return false;
  for (const cat of COMPOSE_CATS) {
    const arr = x.sections[cat];
    if (arr === undefined) continue;
    if (!Array.isArray(arr) || arr.length > 150 || !arr.every(validComposeItem)) return false;
  }
  if (x.episodes !== undefined) {
    if (!Array.isArray(x.episodes) || x.episodes.length > 150 || !x.episodes.every(validComposeEpisode)) return false;
  }
  return true;
}

function composeSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["overview", "history", "personality", "favorites", "skills", "episodes"],
    properties: {
      overview: { type: "string", maxLength: 800 },
      history: { type: "string", maxLength: 4000 },
      personality: { type: "string", maxLength: 2000 },
      favorites: { type: "string", maxLength: 2000 },
      skills: { type: "string", maxLength: 2000 },
      episodes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "text"],
          properties: {
            id: { type: "string", maxLength: 50 },
            text: { type: "string", maxLength: 4000 },
          },
        },
      },
    },
  };
}

const COMPOSE_LABELS = { history: "生い立ち・経歴", personality: "人物像・性格", favorites: "好きなもの", skills: "特技" };

const COMPOSE_INPUT_BUDGET = 24000; // 費用が青天井にならないよう、モデルへ渡す総文字数に上限を設ける

function composePrompt(data) {
  const who = data.subjectType === "group" ? "サークルやチームの記録" : "人物の記録";
  let budget = COMPOSE_INPUT_BUDGET;
  const sectionsText = COMPOSE_CATS.map(cat => {
    const items = data.sections[cat] || [];
    if (!items.length) return `【${COMPOSE_LABELS[cat]}】(記録なし)`;
    const lines = [];
    for (const it of items) {
      const line = `・${it.prompt ? "[" + it.prompt + "] " : ""}${it.text}`;
      if (budget - line.length < 0) { lines.push("・（文字数の都合でこれ以降は省略）"); break; }
      budget -= line.length;
      lines.push(line);
    }
    return `【${COMPOSE_LABELS[cat]}】\n` + lines.join("\n");
  }).join("\n\n");
  const episodes = data.episodes || [];
  const episodesText = episodes.length ? episodes.map(ep => {
    const line = `[id: ${ep.id}]${ep.title ? " タイトル: " + ep.title : ""}\n本文: ${ep.body}`;
    if (budget - line.length < 0) return null;
    budget -= line.length;
    return line;
  }).filter(Boolean).join("\n\n") : "";
  return [
    `あなたはWikipedia編集者です。以下は「${data.subjectName}」という${who}についての、聞き取り調査の生の回答（一問一答）です。`,
    "これを、実際のWikipedia記事のような、自然につながった文章に書き直してください。",
    "【厳守】回答に書かれていない事実を創作しないこと。話し言葉の言い回しは整えてよいが、内容を勝手に膨らませたり誇張したりしないこと。地名・年・固有名詞は原文どおりに保つこと。",
    "一人称（「私は」など）ではなく、三人称のWikipedia記事の文体（「〜である」「〜という」）に整えること。",
    "history（生い立ち・経歴）だけは特別な形式にすること：年代順の箇条書きにし、各行を「・」で始めること。分かる範囲で時期（西暦・年齢・「高校1年」など）を行の先頭に含めること。結婚・引っ越し・転職・留学など、人生の節目となる出来事はそれぞれ独立した1行に分け、複数の出来事を1つの文に圧縮しないこと（例：「結婚後は○○に住んだのち、△△へ転居した」のようにまとめず、結婚は結婚の行、転居は転居の行として分ける）。",
    "personality・favorites・skillsは、それぞれ2〜6文程度の自然な文章にまとめること（箇条書きにしないこと）。関連する回答同士は1つの流れにつなげてよい。記録が無い項目は空文字（\"\"）にすること。",
    "overviewは、全体を読んで100〜200字程度で要約すること（箇条書きにせず、文章で）。",
    data.overview ? `本人が書いた概要（参考。書き直してよい）：${data.overview}` : "",
    sectionsText,
    episodesText
      ? "【エピソード】以下は音声入力による書き起こしを含むため、「まあ」「えーっと」などのフィラーや、言い直し・不自然な区切りが残っていることがあります。事実や言い回しのニュアンスは変えずに、読みやすい自然な文章に整えてください（こちらは一人称のままでよく、Wikipedia文体への変換は不要です）。episodesには、渡された各エピソードについてidと整えた本文（text）を1件ずつ返してください。\n" + episodesText
      : "",
  ].filter(Boolean).join("\n");
}

function outputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output || []) {
    if (item.type !== "message") continue;
    for (const part of item.content || []) {
      if (part.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  return "";
}

/* ---- 読み上げ（Gemini TTS）---- */
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const TTS_MAX_CHARS = 400;

function validTtsInput(x) {
  return x && typeof x.text === "string" && x.text.trim().length >= 1 && x.text.length <= TTS_MAX_CHARS;
}

// Geminiは生のPCM（16bit・モノラル）を返すことがあるため、ブラウザでそのまま鳴らせるWAVに包む
function pcmToWav(pcm, sampleRate) {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function audioFromGemini(response) {
  for (const cand of response.candidates || []) {
    for (const part of (cand.content && cand.content.parts) || []) {
      const inline = part.inlineData || part.inline_data;
      if (!inline || !inline.data) continue;
      const mime = (inline.mimeType || inline.mime_type || "").toLowerCase();
      const bytes = base64ToBytes(inline.data);
      if (mime.includes("wav")) return { bytes, mime: "audio/wav" };
      if (mime.includes("l16") || mime.includes("pcm") || !mime) {
        const rate = Number((mime.match(/rate=(\d+)/) || [])[1]) || 24000;
        return { bytes: pcmToWav(bytes, rate), mime: "audio/wav" };
      }
      return { bytes, mime };
    }
  }
  return null;
}

async function requestGeminiSpeech(env, text, voiceName) {
  const model = env.GEMINI_TTS_MODEL || "gemini-3.8-flash-lite-tts";
  const generationConfig = { responseModalities: ["AUDIO"] };
  if (voiceName) generationConfig.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName } } };
  return fetch(`${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig }),
  });
}

async function handleTts(data, env, headers) {
  if (!env.GEMINI_API_KEY) return json({ error: "tts_not_configured" }, 503, headers);
  if (!validTtsInput(data)) return json({ error: "invalid_input" }, 400, headers);
  const text = data.text.trim();
  let upstream = await requestGeminiSpeech(env, text, env.GEMINI_TTS_VOICE);
  // 声の名前がモデル側で使えなくなっていても読み上げ自体は止めないよう、声の指定なしで1回だけやり直す
  if (upstream.status === 400 && env.GEMINI_TTS_VOICE) upstream = await requestGeminiSpeech(env, text, "");
  if (!upstream.ok) {
    console.error(JSON.stringify({ event: "gemini_tts_error", status: upstream.status, body: (await upstream.text()).slice(0, 500) }));
    // アプリ側で「なぜ標準の声に切り替わったか」を表示できるよう、Geminiの利用上限だけは区別して返す
    if (upstream.status === 429) return json({ error: "gemini_rate_limited" }, 429, headers);
    return json({ error: "upstream_error", upstreamStatus: upstream.status }, 502, headers);
  }
  const audio = audioFromGemini(await upstream.json());
  if (!audio) return json({ error: "invalid_model_output" }, 502, headers);
  return new Response(audio.bytes, {
    status: 200,
    headers: { "content-type": audio.mime, "cache-control": "no-store", ...headers },
  });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("origin") || "";
    const headers = cors(origin, env.ALLOWED_ORIGIN);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, headers);
    if (!isAllowedOrigin(origin, env.ALLOWED_ORIGIN)) {
      console.error(JSON.stringify({ event: "origin_not_allowed", origin }));
      return json({ error: "origin_not_allowed" }, 403, headers);
    }
    let data;
    try { data = await request.json(); } catch { return json({ error: "invalid_json" }, 400, headers); }

    /* 個人の回答内容はキャッシュしない。接続元単位でのみレート制限する。 */
    const actor = request.headers.get("cf-connecting-ip") || "anonymous";

    // 読み上げは質問のたびに呼ばれるため、AI深掘りとは別枠のレート制限にしている
    if (data && data.action === "tts") {
      const ttsLimited = await env.TTS_RATE_LIMITER.limit({ key: actor });
      if (!ttsLimited.success) return json({ error: "rate_limited" }, 429, headers);
      return handleTts(data, env, headers);
    }

    if (!env.OPENAI_API_KEY) return json({ error: "server_not_configured" }, 503, headers);
    const limited = await env.AI_RATE_LIMITER.limit({ key: actor });
    if (!limited.success) return json({ error: "rate_limited" }, 429, headers);

    if (data && data.action === "compose") {
      if (!validComposeInput(data)) return json({ error: "invalid_input" }, 400, headers);
      const upstream = await fetch(OPENAI_URL, {
        method: "POST",
        headers: { "authorization": `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: env.OPENAI_MODEL || "gpt-5.6-sol",
          input: composePrompt(data),
          // まとめ直しは「書き直し」寄りの作業なので、深掘り質問ほどの推論は要らない。
          // 記録が増えるほど時間がかかりやすいため、速さを優先している。
          reasoning: { effort: "low" },
          max_output_tokens: 3000,
          store: false,
          text: { format: { type: "json_schema", name: "compose", strict: true, schema: composeSchema() } },
        }),
      });
      if (!upstream.ok) {
        console.error(JSON.stringify({ event: "openai_error", status: upstream.status }));
        return json({ error: "upstream_error" }, 502, headers);
      }
      const response = await upstream.json();
      let composed;
      try { composed = JSON.parse(outputText(response)); }
      catch { return json({ error: "invalid_model_output" }, 502, headers); }
      return json(composed, 200, headers);
    }

    if (!validInput(data)) return json({ error: "invalid_input" }, 400, headers);

    const upstream = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { "authorization": `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || "gpt-5.6-sol",
        input: prompt(data),
        reasoning: { effort: "medium" },
        max_output_tokens: 800,
        store: false,
        text: { format: { type: "json_schema", name: "follow_up", strict: true, schema: schema() } },
      }),
    });
    if (!upstream.ok) {
      console.error(JSON.stringify({ event: "openai_error", status: upstream.status }));
      return json({ error: "upstream_error" }, 502, headers);
    }
    const response = await upstream.json();
    let parsed;
    try { parsed = JSON.parse(outputText(response)); }
    catch { return json({ error: "invalid_model_output" }, 502, headers); }

    return json(parsed, 200, headers);
  },
};
