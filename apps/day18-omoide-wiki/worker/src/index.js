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
    && Number.isInteger(x.depth) && x.depth >= 0 && x.depth <= 10;
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
];

function prompt(data) {
  const who = data.subjectType === "group" ? "サークルやチームの思い出" : "その人の人生";
  const history = data.history.map(t => `質問「${t.q}」→回答「${t.a}」`).join("\n");
  return [
    `あなたは「${who}」をじっくり深掘りする、しっかり者の聞き手です。話し相手は「${data.subjectName}」について話しています。`,
    "直前の回答を読み、以下の「深掘りの観点」の中から、今の回答にとって一番ネタになりそうなもの（具体的なエピソードとして語れそうなもの）を1つ選んでください。",
    "深掘りの観点：\n" + ANGLES.map(a => "・" + a).join("\n"),
    "選んだ観点に沿って、自然な追加質問を1つ作ってください。音声で読み上げられるので、話し言葉で短く（60文字程度まで）。箇条書きや記号、前置きは使わないこと。",
    "まだ観点の多くが手つかずで、深掘りする余地があるなら積極的に質問を続けてください。すべての観点が出尽くし、これ以上聞くことがなければ done を true にし、followUp は空文字にしてください。",
    `この話題はすでに${data.depth}回深掘りしています。${data.depth >= 6 ? "十分な回数なので、余程ネタがなければ done にしてください。" : ""}`,
    `カテゴリ：${data.categoryLabel}`,
    `今の質問：${data.question}`,
    `今の回答：${data.answer}`,
    history ? `これまでのやり取り：\n${history}` : "",
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
    if (!validInput(data)) return json({ error: "invalid_input" }, 400, headers);

    /* 個人の回答内容はキャッシュしない。接続元単位でのみレート制限する。 */
    const actor = request.headers.get("cf-connecting-ip") || "anonymous";
    const limited = await env.AI_RATE_LIMITER.limit({ key: actor });
    if (!limited.success) return json({ error: "rate_limited" }, 429, headers);

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
