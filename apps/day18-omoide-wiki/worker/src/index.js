/*
 * おもいでWiki AI深掘りWorker。
 * 固定質問への回答を読み、内容に応じた追加質問を1つだけ作って返す。
 * 個人の話す内容を扱うため、DAY05のドラマ王Workerと違いキャッシュはしない
 * （使い回す意味がなく、個人的な回答をCloudflareのキャッシュに残したくないため）。
 */
const OPENAI_URL = "https://api.openai.com/v1/responses";
const MAX_HISTORY = 4;

function cors(origin, allowed) {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "");
  const ok = origin === allowed || local;
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
    && (x.profile === undefined || (typeof x.profile === "string" && x.profile.length <= 1000));
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
  return [
    `あなたは「${who}」をもっともっと深く知っていきたい、プロのインタビュアーです。話し相手は「${data.subjectName}」について話しています。`,
    "この記録は、あとで家族が読み返したときに「こんなにいろいろな経験をしてきた、豊かな人生だったんだ」と実感できるように残すものです。抽象的な感想で終わらせず、いつ・どこで・誰と・何をしたという具体的な場面（旅行ならどこに行ったか、など）が1つでも多く残るように質問してください。",
    "直前の回答を読み、以下の「深掘りの観点」の中から、今の回答にとって一番ネタになりそうなもの（具体的なエピソードとして語れそうなもの）を1つ選んでください。趣味・特技の話が出てきたら積極的に深掘りしてください。",
    "深掘りの観点：\n" + ANGLES.map(a => "・" + a).join("\n"),
    "選んだ観点に沿って、追加質問を1つ作ってください。ただし、いきなり質問文だけを出すのではなく、直前の回答を受けた短い相づちや感想（「それは大変でしたね」「いいですね」「へえ、〇〇だったんですね」など）を一言添えてから、自然に質問へつなげてください。友人と雑談しているような、温かく自然な話し言葉にすること（80文字程度まで）。「〜について教えてください」のような機械的な言い回しは避け、普段の会話で聞くような聞き方にすること。箇条書きや記号は使わないこと。",
    "答える側が『それ聞かれるの嬉しいな、もっと話したいな』とウキウキ・ワクワクした気持ちになるような、明るく前のめりな聞き方にすること。関心・驚き・楽しみが伝わる言葉選びを心がけ、事務的・機械的な響きは避けること。",
    "深掘りを続けるかどうかは、直前の回答の分量・具体性で判断してください。回答がごく短い・情報が薄い（相槌程度、数文字〜十数文字など）場合は、無理に深掘りせず done を true にしてください。反対に、回答が具体的でエピソードや感情が豊富に語られている場合は、まだ聞ける観点が残っていれば done を false にして積極的に深掘りを続けてください。",
    `今の回答の文字数：${len}文字（${len < 15 ? "かなり短いので、無理に深掘りしないほうがよい" : len < 40 ? "やや短め" : "十分な分量があるので、深掘りの余地を積極的に探ってよい"}）`,
    `この話題はすでに${data.depth}回深掘りしています。${data.depth >= 6 ? "十分な回数なので、余程ネタがなければ done にしてください。" : ""}`,
    data.profile ? `プロフィール表：\n${data.profile}\n（生年月日や結成年などがここに書かれていれば、その時代に日本で流行っていた具体的な番組・音楽・芸能人を挙げて「〇〇はお好きでしたか？」のように尋ねると喜ばれます。年代が分からない・自信が持てない場合は、無理に使わず他の観点にしてください。不確かな年代で古すぎる／新しすぎるものを挙げるのは避けること）` : "",
    `カテゴリ：${data.categoryLabel}`,
    `今の質問：${data.question}`,
    `今の回答：${data.answer}`,
    history ? `これまでのやり取り：\n${history}` : "",
  ].filter(Boolean).join("\n");
}

const COMPOSE_CATS = ["history", "personality", "favorites", "skills"];

function validComposeItem(it) {
  return it && typeof it.text === "string" && it.text.length <= 4000
    && (it.prompt === undefined || it.prompt === null || (typeof it.prompt === "string" && it.prompt.length <= 300));
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
  return true;
}

function composeSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["overview", "history", "personality", "favorites", "skills"],
    properties: {
      overview: { type: "string", maxLength: 800 },
      history: { type: "string", maxLength: 3000 },
      personality: { type: "string", maxLength: 2000 },
      favorites: { type: "string", maxLength: 2000 },
      skills: { type: "string", maxLength: 2000 },
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
  return [
    `あなたはWikipedia編集者です。以下は「${data.subjectName}」という${who}についての、聞き取り調査の生の回答（一問一答）です。`,
    "これを、実際のWikipedia記事のような、自然につながった文章に書き直してください。",
    "【厳守】回答に書かれていない事実を創作しないこと。話し言葉の言い回しは整えてよいが、内容を勝手に膨らませたり誇張したりしないこと。地名・年・固有名詞は原文どおりに保つこと。",
    "一人称（「私は」など）ではなく、三人称のWikipedia記事の文体（「〜である」「〜という」）に整えること。",
    "各項目は2〜6文程度の自然な文章にまとめること。関連する回答同士は1つの流れにつなげてよい。記録が無い項目は空文字（\"\"）にすること。",
    "overviewは、全体を読んで100〜200字程度で要約すること。",
    data.overview ? `本人が書いた概要（参考。書き直してよい）：${data.overview}` : "",
    sectionsText,
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

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("origin") || "";
    const headers = cors(origin, env.ALLOWED_ORIGIN);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, headers);
    if (origin !== env.ALLOWED_ORIGIN && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return json({ error: "origin_not_allowed" }, 403, headers);
    }
    if (!env.OPENAI_API_KEY) return json({ error: "server_not_configured" }, 503, headers);

    let data;
    try { data = await request.json(); } catch { return json({ error: "invalid_json" }, 400, headers); }

    /* 個人の回答内容はキャッシュしない。接続元単位でのみレート制限する。 */
    const actor = request.headers.get("cf-connecting-ip") || "anonymous";
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
