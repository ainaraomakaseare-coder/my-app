'use strict';
/**
 * lib/benchmark-facts.js（集めた記録から「事実」だけを機械で計算する部分）を確かめる。
 *
 * ★ 守りたいのは3つ。
 *   1. 出す数字はぜんぶ入力から数えたもので、勝手に作った数字が混ざらない
 *      （CLAUDE.md 決めごと1。ここが分析②③の土台になるので、いちばん固く見る）
 *   2. 「伸びている」（growing）とそれ以外（rest）で作りを比べられる形になっている
 *   3. 入力（items・own）を書き換えない
 *
 *   node test/benchmark-facts.test.js
 */
const assert = require('assert');
const bf = require('../lib/benchmark-facts');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); failed++; }
}

// ---------------------------------------------------------------------------
// 12本ぶんの合成データ（サイズ・形式・冒頭・呼びかけ・テーマ・質問・null ratio を混ぜる）
// ---------------------------------------------------------------------------

function item(over) {
  return Object.assign({
    genre: 'career',
    metrics_source: 'screen',
    posted_at: '2026-09-01',
    collected_at: '2026-09-28',
    content: {},
    demand: { comment_questions: [] },
  }, over);
}

const url = (n) => `https://example.com/p${n}`;

const ITEMS = [
  item({ // 1: tiktok / growing(50) / 数字 / 保存 / 転職20代
    platform: 'tiktok', url: url(1),
    account: { name: 'A', followers: 1000 },
    metrics: { views: 50000, likes: 1000 }, ratio: 50,
    content: { format: 'talking', first_line: '第二新卒で辞めるとき', hook: '5つのコツを紹介します', duration_sec: 42, cta: '保存して', topic: '転職 20代' },
    demand: { comment_questions: ['転職エージェントは無料?', '円満退職ってどこまで気にすべき?'] },
  }),
  item({ // 2: instagram / growing(40) / 問いかけ / フォロー / 転職20代 / シリーズ
    platform: 'instagram', url: url(2),
    account: { name: 'B', followers: 500 },
    metrics: { views: 20000, likes: 800 }, ratio: 40,
    content: { format: 'screen', first_line: 'DAY5 の記録', hook: 'これ知ってる?', duration_sec: 200, cta: 'フォローしてね', topic: '転職 20代' },
  }),
  item({ // 3: x / rest(3) / hook空 / cta無し / 転職20代
    platform: 'x', url: url(3),
    account: { name: 'C', followers: 2000 },
    metrics: { views: 6000, likes: 300 }, ratio: 3,
    content: { format: 'post', first_line: '普通のタイトル', hook: '', duration_sec: null, cta: null, topic: '転職 20代' },
    demand: { comment_questions: ['退職代行って実際どうなの?'] },
  }),
  item({ // 4: threads / ratio null（フォロワー不明） / 否定・警告 / プロフ / その他 / シリーズ(#3)
    platform: 'threads', url: url(4),
    account: { name: 'D', followers: null }, // ratio は計算できない
    metrics: { views: 800, likes: 50 }, ratio: null,
    content: { format: 'slides', first_line: '#3 損する前に', hook: '損する前に見て', duration_sec: 15, cta: 'プロフから見てね', topic: '' },
  }),
  item({ // 5: youtube / growing(15) / 否定・警告(NG) / コメント / AIツール / シリーズ(第7回)
    platform: 'youtube', url: url(5),
    account: { name: 'E', followers: 10000 },
    metrics: { views: 150000, likes: 3000 }, ratio: 15,
    content: { format: 'voice', first_line: '第7回まとめ', hook: 'これはNG行動です', duration_sec: 90, cta: 'コメントで教えて', topic: 'AIツール' },
    demand: { comment_questions: ['AIツールは無料で使える?', '商用利用しても平気?', 'スマホだけで完結する?'] },
  }),
  item({ // 6: youtube / rest(2) / hook不一致 / cta無し / 退職理由
    platform: 'youtube', url: url(6),
    account: { name: 'F', followers: 20000 },
    metrics: { views: 40000, likes: 500 }, ratio: 2,
    content: { format: 'talking', first_line: '退職理由の伝え方', hook: '面接で落ちる人の特徴', duration_sec: 25, cta: null, topic: '退職理由' },
    demand: { comment_questions: ['退職理由は本当のこと言うべき？'] }, // 全角？（正規化で他と同じ扱いになる）
  }),
  item({ // 7: tiktok / rest(3) / 否定・警告(危険) / 保存 / 退職理由
    platform: 'tiktok', url: url(7),
    account: { name: 'G', followers: 3000 },
    metrics: { views: 9000, likes: 400 }, ratio: 3,
    content: { format: 'talking', first_line: '退職理由バレる伝え方', hook: 'それ、危険です', duration_sec: 50, cta: '保存してね', topic: '退職理由' },
    demand: { comment_questions: ['退職理由は本当のこと言うべき?', '会社にバレる可能性ある?'] },
  }),
  item({ // 8: instagram / rest(3) / hook空 / コメント / 退職理由 / シリーズ(パート2)
    platform: 'instagram', url: url(8),
    account: { name: 'H', followers: 1500 },
    metrics: { views: 4500, likes: 200 }, ratio: 3,
    content: { format: 'post', first_line: 'パート2 続き', hook: '', duration_sec: null, cta: 'コメントして', topic: '退職理由' },
    demand: { comment_questions: ['退職理由は本当のこと言うべき?'] },
  }),
  item({ // 9: x / ratio null（再生数不明） / 問いかけ / cta無し / その他
    platform: 'x', url: url(9),
    account: { name: 'I', followers: null },
    metrics: { views: null, likes: 500 }, ratio: null,
    content: { format: 'other', first_line: '普通の投稿', hook: '知ってる?', duration_sec: null, cta: null, topic: '' },
  }),
  item({ // 10: threads / rest(1) / 否定・警告(後悔) / 保存 / AIツール
    platform: 'threads', url: url(10),
    account: { name: 'J', followers: 100000 },
    metrics: { views: 100000, likes: 900 }, ratio: 1,
    content: { format: 'talking', first_line: '通常タイトル', hook: '絶対後悔します', duration_sec: 8, cta: '保存', topic: 'AIツール' },
  }),
  item({ // 11: youtube / growing(500・最大) / 結論先出し / プロフ / AI副業
    platform: 'youtube', url: url(11),
    account: { name: 'K', followers: 200 },
    metrics: { views: 100000, likes: 5000 }, ratio: 500,
    content: { format: 'screen', first_line: '答えは一つ', hook: 'これだけでOK', duration_sec: 600, cta: 'プロフのリンクから', topic: 'AI副業' },
  }),
  item({ // 12: tiktok / ratio null（再生数不明） / hook不一致 / その他cta / その他
    platform: 'tiktok', url: url(12),
    account: { name: 'L', followers: 50 },
    metrics: { views: null, likes: 80 }, ratio: null,
    content: { format: 'unknown', first_line: 'テスト投稿', hook: '普通の冒頭です', duration_sec: null, cta: '気に入ったら教えてね', topic: '' },
  }),
];

const OWN = {
  accounts: [{ network: 'threads', label: 'ひろや', followers: 500 }],
  posts: [
    { network: 'threads', title: '投稿A', url: 'u1', posted_at: '2026-09-01', metrics: { views: 100, likes: 5, comments: 1 } },
    { network: 'threads', title: '投稿B', url: 'u2', posted_at: '2026-09-05', metrics: null },
    { network: 'threads', title: '投稿C', url: 'u3', posted_at: '2026-09-10', metrics: { views: 300, likes: 9, comments: 2 } },
    { network: 'threads', title: '投稿D', url: 'u4', posted_at: '2026-09-15', metrics: { views: 500, likes: 20, comments: 5 } },
    { network: 'threads', title: '投稿E', url: 'u5', posted_at: '2026-09-20', metrics: null },
  ],
  own_format: { format: 'text', duration_sec: 16.8, note: '文字の穴埋め6問' },
};

(async () => {
  // ---------------------------------------------------------------- 分類器（単体）
  await check('hookTypes: 数字が入っていれば 数字', () => {
    assert.deepStrictEqual(bf.hookTypes('5つの理由'), ['数字']);
  });
  await check('hookTypes: 空文字は何にも当てはまらない（[]）', () => {
    assert.deepStrictEqual(bf.hookTypes(''), []);
  });
  await check('hookTypes: 複数の型に同時に当てはまる', () => {
    const types = bf.hookTypes('必見！5つのコツ');
    assert.ok(types.includes('数字'));
    assert.ok(types.includes('呼びかけ'));
  });
  await check('ctaType: 保存/フォロー/プロフ/コメント/なし/その他', () => {
    assert.strictEqual(bf.ctaType('保存してね'), '保存');
    assert.strictEqual(bf.ctaType('フォローよろしく'), 'フォロー');
    assert.strictEqual(bf.ctaType('プロフ見てね'), 'プロフ');
    assert.strictEqual(bf.ctaType('リンクはこちら'), 'プロフ');
    assert.strictEqual(bf.ctaType('コメントで教えて'), 'コメント');
    assert.strictEqual(bf.ctaType(null), 'なし');
    assert.strictEqual(bf.ctaType(''), 'なし');
    assert.strictEqual(bf.ctaType('気になったら見てね'), 'その他');
  });
  await check('durationBucket: 秒数の区分', () => {
    assert.strictEqual(bf.durationBucket(10), '〜15秒');
    assert.strictEqual(bf.durationBucket(30), '〜30秒');
    assert.strictEqual(bf.durationBucket(60), '〜60秒');
    assert.strictEqual(bf.durationBucket(61), '60秒超');
    assert.strictEqual(bf.durationBucket(null), '不明');
  });
  await check('isSeries: DAY・第・#・日目・パート・Part を拾う', () => {
    assert.ok(bf.isSeries('DAY14 の記録'));
    assert.ok(bf.isSeries('第7回まとめ'));
    assert.ok(bf.isSeries('#3 損する前に'));
    assert.ok(bf.isSeries('12日目の記録'));
    assert.ok(bf.isSeries('パート2 続き'));
    assert.ok(bf.isSeries('Part3 まとめ'));
    assert.ok(!bf.isSeries('普通のタイトル'));
  });

  // ---------------------------------------------------------------- facts()（本体）
  const before = JSON.parse(JSON.stringify(ITEMS));
  const ownBefore = JSON.parse(JSON.stringify(OWN));
  const out = bf.facts(ITEMS, OWN, { genre: 'career', now: new Date('2026-09-28T00:00:00Z') });

  await check('入力（items・own）を書き換えない', () => {
    assert.deepStrictEqual(ITEMS, before);
    assert.deepStrictEqual(OWN, ownBefore);
  });

  await check('genre と generated_at', () => {
    assert.strictEqual(out.genre, 'career');
    assert.strictEqual(out.generated_at, '2026-09-28T00:00:00.000Z');
  });

  await check('n: 件数・伸びている数・SNS内訳', () => {
    assert.strictEqual(out.n.total, 12);
    assert.strictEqual(out.n.growing, 4); // 50,40,15,500 の4件
    assert.deepStrictEqual(out.n.byPlatform, { tiktok: 3, instagram: 2, x: 2, threads: 2, youtube: 3 });
  });

  await check('ratio: 中央値・p75・最大値（ratio が無いものは数えない）', () => {
    // 非nullの ratio: 1,2,3,3,3,15,40,50,500 (9件)
    assert.strictEqual(out.ratio.median, 3);
    assert.strictEqual(out.ratio.p75, 40);
    assert.strictEqual(out.ratio.max, 500);
  });

  await check('formats: growing と rest で分けて数える', () => {
    assert.deepStrictEqual(out.formats.growing, { talking: 1, screen: 2, voice: 1 });
    assert.deepStrictEqual(out.formats.rest, { post: 2, slides: 1, talking: 3, other: 1, unknown: 1 });
  });

  await check('durations: 長さの区分ごとの数', () => {
    assert.deepStrictEqual(out.durations.growing, { '〜60秒': 1, '60秒超': 3 });
    assert.deepStrictEqual(out.durations.rest, { '不明': 4, '〜15秒': 2, '〜30秒': 1, '〜60秒': 1 });
  });

  await check('hooks: 出どころの規則（rules）が見える', () => {
    assert.ok(out.hooks.rules['数字']);
    assert.ok(out.hooks.rules['問いかけ']);
    assert.ok(out.hooks.rules['否定・警告']);
    assert.ok(out.hooks.rules['呼びかけ']);
    assert.ok(out.hooks.rules['結論先出し']);
  });

  await check('hooks: growing / rest の多重カウントと「空」', () => {
    assert.deepStrictEqual(out.hooks.growing, { '数字': 1, '問いかけ': 1, '否定・警告': 1, '結論先出し': 1 });
    assert.deepStrictEqual(out.hooks.rest, { '空': 2, '否定・警告': 3, '問いかけ': 1 });
  });

  await check('ctas: growing / rest の呼びかけの型', () => {
    assert.deepStrictEqual(out.ctas.growing, { '保存': 1, 'フォロー': 1, 'コメント': 1, 'プロフ': 1 });
    assert.deepStrictEqual(out.ctas.rest, { 'なし': 3, 'プロフ': 1, '保存': 2, 'コメント': 1, 'その他': 1 });
  });

  await check('series: シリーズ物らしさの growing / rest', () => {
    assert.strictEqual(out.series.growing, 2); // DAY5, 第7回
    assert.strictEqual(out.series.rest, 2);    // #3, パート2
    assert.ok(out.series.rule.length > 0);
  });

  await check('topics: グループ化・件数・中央値・サンプルURL', () => {
    const t = out.topics.find((x) => x.topic === '転職 20代');
    assert.strictEqual(t.total, 3);
    assert.strictEqual(t.growing, 2);
    assert.strictEqual(t.questions, 2); // item1・item3 に質問あり（item2は無し）
    assert.strictEqual(t.medianRatio, 40); // [3,40,50] の中央値
    assert.deepStrictEqual(t.sampleUrls, [url(1), url(2), url(3)]); // ratio降順

    const other = out.topics.find((x) => x.topic === 'その他');
    assert.strictEqual(other.total, 3); // topicが空の3件（4,9,12）
    assert.strictEqual(other.medianRatio, null); // 全部 ratio null

    const taishoku = out.topics.find((x) => x.topic === '退職理由');
    assert.strictEqual(taishoku.total, 3);
    assert.strictEqual(taishoku.growing, 0);
    assert.strictEqual(taishoku.questions, 3);
  });

  await check('topics: growing 降順・同着は total 降順で並ぶ', () => {
    assert.strictEqual(out.topics[0].topic, '転職 20代'); // growing=2 がいちばん上
    assert.strictEqual(out.topics[0].growing, 2);
    // growing=0 の2つ（その他・退職理由）はいちばん後ろに集まる
    const last2 = out.topics.slice(-2).map((t) => t.topic).sort();
    assert.deepStrictEqual(last2, ['その他', '退職理由'].sort());
  });

  await check('openings: 需要はあるが供給が少ないテーマだけを拾う', () => {
    assert.strictEqual(out.openings.length, 2);
    const topics = out.openings.map((o) => o.topic).sort();
    assert.deepStrictEqual(topics, ['転職 20代', '退職理由'].sort());
    const a = out.openings.find((o) => o.topic === '転職 20代');
    assert.strictEqual(a.reason, '「転職 20代」は全体で3件しか集まっていないのに、伸びているものが2件、コメントの質問がある投稿が2件ある。供給より需要が大きい。');
    const b = out.openings.find((o) => o.topic === '退職理由');
    assert.strictEqual(b.reason, '「退職理由」は全体で3件しか集まっていないのに、伸びているものが0件、コメントの質問がある投稿が3件ある。供給より需要が大きい。');
    // 出さないテーマ（AIツール・AI副業）が紛れ込んでいない
    assert.ok(!topics.includes('AIツール'));
    assert.ok(!topics.includes('AI副業'));
  });

  await check('top: ratio降順（同着は再生数降順）で並ぶ', () => {
    assert.strictEqual(out.top.length, 12); // 12件しかないので15件には届かない
    assert.strictEqual(out.top[0].url, url(11)); // ratio 500 が最大
    assert.strictEqual(out.top[0].ratio, 500);
    // ratio=3 の同着（item7:9000 > item3:6000 > item8:4500）
    const idx7 = out.top.findIndex((t) => t.url === url(7));
    const idx3 = out.top.findIndex((t) => t.url === url(3));
    const idx8 = out.top.findIndex((t) => t.url === url(8));
    assert.ok(idx7 < idx3 && idx3 < idx8, '再生数の多い順になっていない');
  });

  await check('top: ratio が無いものは、再生数の多い順で後ろに埋める', () => {
    const tail = out.top.slice(-3).map((t) => t.url);
    assert.deepStrictEqual(tail, [url(4), url(9), url(12)]); // views: 800, null, null
    for (const t of out.top.slice(-3)) assert.strictEqual(t.ratio, null);
  });

  await check('top: 1件ぶんの中身', () => {
    const first = out.top[0];
    assert.strictEqual(first.platform, 'youtube');
    assert.strictEqual(first.account, 'K');
    assert.strictEqual(first.followers, 200);
    assert.strictEqual(first.views, 100000);
    assert.strictEqual(first.format, 'screen');
    assert.strictEqual(first.hook, 'これだけでOK');
    assert.strictEqual(first.first_line, '答えは一つ');
    assert.strictEqual(first.duration_sec, 600);
    assert.strictEqual(first.cta, 'プロフのリンクから');
    assert.strictEqual(first.topic, 'AI副業');
  });

  await check('questions: 表記ゆれ（全角/半角の？・末尾の?）をまとめて数える', () => {
    const top = out.questions[0];
    assert.strictEqual(top.text, '退職理由は本当のこと言うべき');
    assert.strictEqual(top.count, 3);
    assert.deepStrictEqual(top.urls, [url(6), url(7), url(8)]);
    assert.ok(out.questions.length <= 20);
    assert.strictEqual(out.questions.length, 8); // 重複の1本を除いて distinct 8本
  });

  await check('own: 自分の投稿の要約（metricsが無い投稿は中央値に入れない）', () => {
    assert.deepStrictEqual(out.own.accounts, [{ network: 'threads', label: 'ひろや', followers: 500 }]);
    assert.strictEqual(out.own.posts, 5);
    assert.strictEqual(out.own.withMetrics, 3);
    assert.strictEqual(out.own.medianViews, 300); // [100,300,500] の中央値
    assert.deepStrictEqual(out.own.format, OWN.own_format);
    assert.deepStrictEqual(out.own.titles, ['投稿E', '投稿D', '投稿C', '投稿B', '投稿A']); // 新しい順
  });

  await check('caveats: 件数が少ない・偏った群・常に出す注意', () => {
    assert.ok(out.caveats.includes('集めた数が少ないので傾向は参考程度'));
    assert.ok(out.caveats.includes('伸びている は5件未満なので比較しない')); // growing=4件
    assert.ok(!out.caveats.some((c) => c.includes('伸びていない'))); // rest=8件は5件以上
    assert.ok(out.caveats.includes('他人の完走率・視聴時間は見えない'));
    assert.ok(!out.caveats.some((c) => c.includes('自分の投稿'))); // own はある
  });

  await check('own が無ければ own:null と、その旨の注意が付く', () => {
    const out2 = bf.facts(ITEMS, null, { genre: 'career' });
    assert.strictEqual(out2.own, null);
    assert.ok(out2.caveats.some((c) => c.includes('自分の投稿')));
  });

  await check('groupが0件のときは「5件未満」の注意を出さない（比べる相手が無い）', () => {
    const allGrowing = ITEMS.filter((it) => it.ratio !== null && it.ratio >= 10);
    const out3 = bf.facts(allGrowing, null, { genre: 'career' });
    assert.strictEqual(out3.n.growing, allGrowing.length);
    assert.ok(!out3.caveats.some((c) => c.includes('伸びていない')));
  });

  await check('facts()は入力に無い数字を作らない（スポットチェック）', () => {
    // n.total は items.length と必ず一致する
    assert.strictEqual(out.n.total, ITEMS.length);
    // ratio.max は実際に入っている ratio の最大値と一致する
    const maxRatio = Math.max(...ITEMS.map((it) => it.ratio).filter((r) => r !== null));
    assert.strictEqual(out.ratio.max, maxRatio);
    // n.byPlatform の合計は total と一致する
    const sum = Object.values(out.n.byPlatform).reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, out.n.total);
  });

  await check('空配列でも落ちない（何も集まっていないとき）', () => {
    const out4 = bf.facts([], null, { genre: 'ai' });
    assert.strictEqual(out4.n.total, 0);
    assert.strictEqual(out4.ratio.median, null);
    assert.strictEqual(out4.ratio.max, null);
    assert.deepStrictEqual(out4.topics, []);
    assert.deepStrictEqual(out4.openings, []);
    assert.deepStrictEqual(out4.top, []);
    assert.deepStrictEqual(out4.questions, []);
  });

  console.log(`\n${passed} 件成功 / ${failed} 件失敗`);
  if (failed) process.exit(1);
})();
