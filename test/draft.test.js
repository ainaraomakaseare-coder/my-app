'use strict';
/**
 * ネットワークに出ずに、投稿文の点検と生成の骨組みを確かめる。
 * Claude を呼ぶ部分だけ偽物に差し替えて、その手前まで全部通す。
 *
 *   node test/draft.test.js
 */
const assert = require('assert');

const rules = require('../lib/draft-rules');
const scope = require('../lib/account-scope');
const gen = require('../lib/draft-generate');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['ok', name]); }
  catch (err) { results.push(['NG', name + ' → ' + err.message]); }
}

/** 実物の reel_09。ここが通らなくなったら点検が厳しすぎる。 */
const reel09 = {
  kicker: '不安な人へ!?',
  title: '転職活動がバレにくい進め方',
  rows: [
    { question: '職場で話す人ほど', answer: '広まる' },
    { question: '同僚に相談すると', answer: '伝わる' },
    { question: '急に有給を取ると', answer: '目立つ' },
    { question: 'SNSで書く人ほど', answer: '特定される' },
    { question: '服装が変わると', answer: '察される' },
    { question: 'いちばん確実なのは', answer: '黙ること' },
  ],
  igCaption: '5番がいちばん刺さる…。第二新卒の口コミを集めた結果です。他にもあったらコメントで教えてください',
  ttCaption: '5番がいちばん刺さる…。第二新卒の口コミを集めた結果です',
  xText: '「転職活動がバレにくい進め方」6つ、答え合わせ。3番が意外と知られてないと思う。',
  hashtags: ['#転職活動', '#第二新卒', '#転職したい', '#退職', '#社会人3年目', '#キャリア'],
  tone: 'calm',
  hasAffiliateLink: false,
};
const draft = (over) => Object.assign({}, reel09, over || {});

/** ひろや側。本人の実践記録なので一人称で書くのが正しい。 */
const personal = draft({
  kicker: '12日目!?',
  title: '音声入力アプリを作った',
  igCaption: '今日は音声入力アプリを作ってみました。詰まったのは3番です',
  ttCaption: '12日目。音声入力アプリを作ってみました',
  xText: '12日目。音声入力アプリを作ってみました。',
});

(async () => {
  // ---- 既存の投稿が通ること ------------------------------------------------

  await check('reel_09 は指摘ゼロ', () => {
    assert.deepStrictEqual(rules.validateDraft(reel09), []);
  });

  // ---- 一人称の体験（最大の事故ポイント） ----------------------------------

  await check('代名詞＋過去形を弾く', () => {
    const f = rules.findingsOf(draft({ igCaption: '私も転職しました' }), 'first-person-experience');
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].severity, 'error');
  });

  await check('代名詞がなくても「登録してみました」は体験', () => {
    const f = rules.findingsOf(draft({ igCaption: 'エージェントに登録してみました' }), 'first-person-experience');
    assert.strictEqual(f.length, 1);
  });

  await check('「作ってみました」も体験（動詞を列挙しないので拾える）', () => {
    const f = rules.findingsOf(draft({ igCaption: 'アプリを作ってみました' }), 'first-person-experience');
    assert.strictEqual(f.length, 1);
  });

  await check('「私も引き止められました」も体験', () => {
    const f = rules.findingsOf(draft({ igCaption: '私も引き止められました' }), 'first-person-experience');
    assert.strictEqual(f.length, 1);
  });

  await check('「自分を否定しないで」は体験ではない', () => {
    const d = draft({ igCaption: '自分を否定しないでください、という声がありました' });
    assert.deepStrictEqual(rules.findingsOf(d, 'first-person-experience'), []);
  });

  // ---- 出典のない数値・断定 ------------------------------------------------

  await check('「利用者の8割が」を弾く', () => {
    assert.ok(rules.findingsOf(draft({ igCaption: '利用者の8割が満足' }), 'unsourced-number').length > 0);
  });

  await check('「6つ」「3番」は数値ではない', () => {
    assert.deepStrictEqual(rules.findingsOf(reel09, 'unsourced-number'), []);
  });

  await check('成果と結びついた断定は error', () => {
    const f = rules.findingsOf(draft({ igCaption: '登録すれば必ず年収が上がります' }), 'absolute-claim');
    assert.strictEqual(f[0].severity, 'error');
  });

  await check('「いちばん確実なのは」を誤検出しない', () => {
    assert.deepStrictEqual(rules.findingsOf(reel09, 'absolute-claim'), []);
  });

  // ---- 出典の断り ----------------------------------------------------------

  await check('キャプションに断りがなければ error', () => {
    const f = rules.findingsOf(draft({ igCaption: '5番がいちばん刺さる…。' }), 'missing-sourcing');
    assert.strictEqual(f.length, 1);
  });

  await check('X用の本文には断りを求めない', () => {
    const f = rules.findingsOf(draft({ xText: '6つ、答え合わせ。' }), 'missing-sourcing');
    assert.deepStrictEqual(f, []);
  });

  // ---- PR表記 --------------------------------------------------------------

  await check('案件つきで表記がなければ error', () => {
    assert.ok(rules.findingsOf(draft({ hasAffiliateLink: true }), 'missing-pr-label').length > 0);
  });

  await check('#PR があれば通る', () => {
    const d = draft({
      hasAffiliateLink: true,
      igCaption: '口コミを集めた結果です #PR',
      ttCaption: '口コミを集めた結果です #PR',
    });
    assert.deepStrictEqual(rules.findingsOf(d, 'missing-pr-label'), []);
  });

  // ---- 画面に収まるか ------------------------------------------------------

  // --------------------------------------------- 断りが落ちていたら、足す
  //
  // ★ 頼み方を強めてもモデルは書き落とす。落ちたぶんが下書きで止まると、
  //   毎日1本を20日続ける運用がそこで途切れる。
  const gen = require('../lib/draft-generate');

  await check('断りが無ければ、末尾に一文足す', () => {
    const d = { igCaption: '5番がいちばん刺さる', ttCaption: '5番がいちばん刺さる' };
    const added = gen.ensureSourcing(d, rules.CURATOR);
    assert.strictEqual(added.length, 2, 'Instagram と TikTok の両方に足すべき');
    assert.ok(rules.hasSourcing(d.igCaption), d.igCaption);
    assert.ok(rules.hasSourcing(d.ttCaption));
  });

  await check('足したことは黙っていない（画面に出す）', () => {
    const d = { igCaption: 'なにか' };
    const added = gen.ensureSourcing(d, rules.CURATOR);
    assert.strictEqual(added[0].rule, 'sourcing-added');
    assert.ok(/足しました/.test(added[0].message));
    assert.strictEqual(added[0].severity, 'warning', '足したのに止めてしまっている');
  });

  await check('もともと断りがあれば、触らない', () => {
    const d = { igCaption: '第二新卒の口コミを集めた結果です' };
    const before = d.igCaption;
    assert.deepStrictEqual(gen.ensureSourcing(d, rules.CURATOR), []);
    assert.strictEqual(d.igCaption, before);
  });

  await check('句点が無ければ足してから続ける', () => {
    const d = { igCaption: 'コメントで教えてください' };
    gen.ensureSourcing(d, rules.CURATOR);
    assert.ok(/ください。ネットで/.test(d.igCaption), d.igCaption);
    const d2 = { igCaption: 'コメントで教えて…' };
    gen.ensureSourcing(d2, rules.CURATOR);
    assert.ok(/…ネットで/.test(d2.igCaption), d2.igCaption);
  });

  // ★ ひろや側は本人の実践記録なので、断りは要らない。勝手に足さない。
  await check('ひろや側には足さない', () => {
    const d = { igCaption: '12日目。音声入力アプリを作った' };
    const before = d.igCaption;
    assert.deepStrictEqual(gen.ensureSourcing(d, rules.PERSONAL), []);
    assert.strictEqual(d.igCaption, before);
  });

  await check('足したあとは、検査に引っかからない', () => {
    const d = draft({ igCaption: '5番がいちばん刺さる', ttCaption: '5番がいちばん刺さる' });
    gen.ensureSourcing(d, rules.CURATOR);
    assert.deepStrictEqual(rules.findingsOf(d, 'missing-sourcing'), []);
    assert.ok(!rules.hasBlocking(rules.validateDraft(d)), 'まだ止まっている');
  });

  // ------------------------------------------------------- 本文が空にならないか
  //
  // ★ 実際に起きた不具合の再現。投稿された本文が「#toukoutakuneo」という
  //   ハッシュタグ1語だけになっていた。原因は igCaption が空のまま検査を
  //   素通りしていたこと（`text && ...` は空文字が falsy なので、
  //   「無ければ見ない」がそのまま「合格」になっていた）。
  await check('igCaption が空だと止める（ハッシュタグだけの投稿になる不具合の再現）', () => {
    const d = draft({ igCaption: '' });
    const f = rules.findingsOf(d, 'empty-caption');
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].severity, 'error');
    assert.ok(/本文が空です/.test(f[0].message));
    assert.ok(rules.hasBlocking(rules.validateDraft(d)), '止めていない（この不具合の核心）');
  });

  await check('igCaption が短すぎても止める（実質ハッシュタグしか無い状態）', () => {
    const d = draft({ igCaption: 'いいね' });   // 3字。ハッシュタグと大差ない
    const f = rules.findingsOf(d, 'empty-caption');
    assert.strictEqual(f.length, 1);
    assert.ok(/短すぎます/.test(f[0].message));
  });

  await check('空白だけの本文も、空として扱う', () => {
    const d = draft({ ttCaption: '　　\n　' });
    assert.strictEqual(rules.findingsOf(d, 'empty-caption').length, 1);
  });

  await check('ttCaption・xText も同じように見る', () => {
    assert.strictEqual(rules.findingsOf(draft({ ttCaption: '' }), 'empty-caption').length, 1);
    assert.strictEqual(rules.findingsOf(draft({ xText: '' }), 'empty-caption').length, 1);
  });

  await check('中身のある本文なら、何も言わない', () => {
    assert.deepStrictEqual(rules.findingsOf(reel09, 'empty-caption'), []);
  });

  // ★ 「本文が空」でも「ハッシュタグ側は正常」なら、そのまま投稿される本文が
  //   ハッシュタグだけになる、という組み合わせを確かめる（実際に起きた形）。
  await check('本文が空でハッシュタグだけあると、投稿される本文がハッシュタグのみになる（だから止める）', () => {
    const empty = '';
    const posted = rules.captionWithTags(empty, ['#toukoutakuneo'], 'instagram');
    assert.strictEqual(posted, '#toukoutakuneo', 'これが実際に起きていた見え方');
    // ↑ この形そのものを許してしまうのが不具合なので、生成の検査側で止める。
    assert.ok(rules.hasBlocking(rules.validateDraft(draft({ igCaption: empty }))));
  });

  await check('ensureSourcing は空文字には足さない（空欄チェックに任せる）', () => {
    const gen = require('../lib/draft-generate');
    const d = { igCaption: '' };
    const added = gen.ensureSourcing(d, rules.CURATOR);
    assert.deepStrictEqual(added, []);
    assert.strictEqual(d.igCaption, '', '空欄に断りだけ足しても中身のある本文にはならない');
  });

  // ----------------------------------------- 穴埋めとして成り立っているか
  //
  // ★ ここが「赤字と黒字が2回繰り返している」の正体だった。
  //   答えが問いの中に既に入っていると、同じ語が黒と赤で2回出る。
  //   直す前は、この形が「指摘なし」で素通りしていた。
  await check('答えが問いの中にもう出ていたら止める', () => {
    const rows = reel09.rows.slice();
    rows[0] = { question: '職場で話す人ほど広まる', answer: '広まる' };
    const f = rules.findingsOf(draft({ rows }), 'answer-in-question');
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].severity, 'error');
    assert.ok(/2回/.test(f[0].message), 'なぜ駄目かを言っていない');
    assert.ok(rules.hasBlocking(rules.validateDraft(draft({ rows }))), '止めていない');
  });

  await check('実物の6行は、重複として引っかからない', () => {
    assert.deepStrictEqual(rules.findingsOf(reel09, 'answer-in-question'), []);
  });

  // ★ 問いが言い切りだと、答えが付け足しに見えて穴埋めにならない。
  await check('問いが言い切りで終わっていたら止める', () => {
    const rows = reel09.rows.slice();
    rows[0] = { question: '同僚に相談すると。', answer: '伝わる' };
    const f = rules.findingsOf(draft({ rows }), 'question-not-open');
    assert.strictEqual(f[0].severity, 'error');
    assert.ok(/答えに続く形/.test(f[0].message), '直し方を言っていない');
  });

  await check('「〜ほど」「〜すると」で切ってあれば通る', () => {
    assert.deepStrictEqual(rules.findingsOf(reel09, 'question-not-open'), []);
  });

  await check('問いが長ければ知らせる（止めはしない）', () => {
    const rows = reel09.rows.slice();
    rows[0] = { question: 'いちばん確実で安全なのは', answer: '黙る' };
    const f = rules.findingsOf(draft({ rows }), 'question-too-wide');
    assert.strictEqual(f[0].severity, 'warning');
  });

  // ★ 縮む下限を上げたので、止める長さも連動して下がる。
  //   0.55 倍は 32px が 18px になり、スマホでは読めなかった。
  await check('縮む下限は 0.75。20字ぶんを超えたら止める', () => {
    assert.strictEqual(rules.MIN_SCALE, 0.75);
    assert.strictEqual(rules.MAX_ROW_FIT, 20);

    const rows = reel09.rows.slice();
    rows[0] = { question: 'あ'.repeat(14), answer: 'いいいいい' };     // 19字 → 縮めて収まる
    assert.strictEqual(rules.findingsOf(draft({ rows }), 'row-too-wide')[0].severity, 'warning');

    rows[0] = { question: 'あ'.repeat(18), answer: 'いいいい' };       // 22字 → 収まらない
    assert.strictEqual(rules.findingsOf(draft({ rows }), 'row-too-wide')[0].severity, 'error');
  });

  await check('書き直しは3回まで（点検を厳しくしたぶん、諦めさせない）', () => {
    assert.strictEqual(require('../lib/draft-generate').MAX_ATTEMPTS, 3);
  });

  // ------------------------------------------------------- 縮めて収める境目
  //
  // ★ reel.js は長い行を 0.55倍まで縮めて収める。
  //   その範囲なら「小さくなるが全部見える」ので warning、
  //   超えると本当に切れるので error。ここが reel.js の MIN_SCALE と連動している。
  await check('少しだけ超えたぶんは warning（縮めれば入る）', () => {
    const rows = reel09.rows.slice();
    rows[0] = { question: 'あ'.repeat(14), answer: 'いいいいい' };   // 19字ぶん
    const f = rules.findingsOf(draft({ rows }), 'row-too-wide');
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].severity, 'warning');
    assert.ok(/小さくして収めます/.test(f[0].message));
  });

  await check('タイトルも同じ境目で分かれる', () => {
    const warn = rules.findingsOf(draft({ title: 'あ'.repeat(16) }), 'title-too-wide');
    assert.strictEqual(warn[0].severity, 'warning');
    const err = rules.findingsOf(draft({ title: 'あ'.repeat(24) }), 'title-too-wide');
    assert.strictEqual(err[0].severity, 'error');
  });

  // ★ 「黒字の漢字が細い」の実測結果を、コードとして固定する。
  //   端末のフォントは太さ600未満だとぜんぶ同じRegularに丸められる
  //   （350〜550を実際に描いて画素で数え、濃さが変わらないことを確認済み）。
  //   黒字（body）を600未満に戻すと、この不具合がそのまま再発する。
  await check('黒字（body）は端末フォントでも太字になる600以上にしてある', () => {
    const fs = require('fs');
    const reel = fs.readFileSync(__dirname + '/../public/reel.js', 'utf8');
    const fb = reel.match(/fallback:\s*\{\s*body:\s*([0-9]+)/);
    assert.ok(fb, 'reel.js に fallback.body が無い');
    assert.ok(Number(fb[1]) >= 600,
      `fallback.body が ${fb[1]} 。600未満だと端末フォントで細いRegularに丸められる`);
  });

  // ------------------------------------------------ TikTok のコマ間隔（frame_rate_check_failed）
  //
  // ★ 実際に起きた不具合。TikTok が「TikTok 側で動画の処理に失敗しました。
  //   次の一手：frame_rate_check_failed」を返していた。
  //
  //   実際に16.8秒フルで録って、mp4の中身（moof/trun の sample_duration）を
  //   直接読んで確かめた。原因は requestAnimationFrame（実測：約60Hz）で
  //   captureStream(30) を駆動していたこと。指定した30fpsとズレていて、
  //   ブラウザが間引くときに同じ時刻のコマが2枚できることがあった
  //   （ffmpegが「non monotonically increasing dts: 84 >= 84」と警告）。
  //
  //   captureStream(0)（手動モード）にして、setTimeout で自分がコマの
  //   間隔を管理するように直した。直したあとは、473〜480コマの大半が
  //   33.3ms前後にきれいに揃うことを確認した（重複は解消）。
  //   ※ エンコード処理自体がJSの実行を一瞬止めることによる単発の飛びは
  //     timeslice を変えても残ったため、ブラウザ内部の処理と判断し、
  //     完全には消せていない。TikTok側の判定が完全に通るとは言い切れない。
  await check('コマの間隔は自分で管理する（requestAnimationFrame に任せない）', () => {
    const fs = require('fs');
    const reel = fs.readFileSync(__dirname + '/../public/reel.js', 'utf8');
    const record = reel.slice(reel.indexOf('function record('), reel.indexOf('function record(') + 3000);
    assert.ok(/captureStream\(0\)/.test(record),
      '手動モード（captureStream(0)）になっていない');
    assert.ok(/requestFrame/.test(record),
      'requestFrame でコマを押し出していない');
    assert.ok(!/requestAnimationFrame/.test(record),
      'requestAnimationFrame に戻っている（60Hzとのズレが再発する）');
  });

  await check('コマの間隔は t0 からの絶対時刻で計算する（遅れを積み上げない）', () => {
    const fs = require('fs');
    const reel = fs.readFileSync(__dirname + '/../public/reel.js', 'utf8');
    const record = reel.slice(reel.indexOf('function record('), reel.indexOf('function record(') + 3000);
    // ★ setTimeout(fn, 前回間隔) のように「前回からの相対時間」で刻むと、
    //   1回1回の遅れがそのまま積み重なる。t0 + 押し出した枚数*刻み から
    //   逆算する形になっているかを見る。
    assert.ok(/t0\s*\+\s*\w+\s*\*\s*stepMs/.test(record),
      '絶対時刻から逆算する形になっていない（遅れが積み重なる）');
  });

  // ★ 実機で送ってもらった本物の失敗動画を調べたら、16.8秒の録画中に
  //   1〜1.6秒の詰まりが4回もあり（動画全体の36%）、手元の検証環境
  //   （H.264のエンコーダが無くVP9で代用されていた）では1回しか
  //   再現できていなかった不具合が見つかった。
  //
  //   「詰まった分をあとでまとめて押し出す」も試したが、実測で
  //   効かないと分かった（requestFrame() を間を空けずに何度呼んでも、
  //   ブラウザは1枚のコマにまとめてしまう）ので取り下げ済み。
  //   一度失われた実時間ぶんのコマは水増しできないため、エンコードの
  //   負荷そのものを下げる方向（ビットレートを下げる）で対策している。
  await check('動画のビットレートを下げて、エンコードの負荷を減らしている', () => {
    const fs = require('fs');
    const reel = fs.readFileSync(__dirname + '/../public/reel.js', 'utf8');
    const record = reel.slice(reel.indexOf('function record('), reel.indexOf('function record(') + 3500);
    const m = record.match(/videoBitsPerSecond:\s*([0-9]+)/);
    assert.ok(m, 'videoBitsPerSecond が見当たらない');
    assert.ok(Number(m[1]) <= 1500000,
      'ビットレートが下がっていない（詰まりを減らす狙いが反映されていない）');
  });

  // ★ 利用者から送ってもらった2件目の失敗ファイルは、16.8秒のはずの
  //   録画がまるごと1回・35秒の詰まりに飲み込まれ、コマが2枚（空欄が
  //   35秒→いきなり全部埋まって終了）しか無かった。これでは中身自体が
  //   壊れており、Instagramに投稿してもTikTokに投稿しても意味が無い。
  //   詰まりの根本原因（タブのバックグラウンド化・PCのスリープ等、
  //   この検証環境では再現できない）を直せない以上、せめて「壊れた動画を
  //   検知したら、その場で止めてエラーにする」形になっているかを見る。
  await check('録画中に大きく詰まったら、壊れた動画のまま進まずに中断する', () => {
    const fs = require('fs');
    const reel = fs.readFileSync(__dirname + '/../public/reel.js', 'utf8');
    const start = reel.indexOf('function record(');
    const record = reel.slice(start, start + 3500);
    assert.ok(/STALL_MS/.test(record), 'STALL_MS によるしきい値判定が無い');
    assert.ok(/lateBy\s*>\s*STALL_MS/.test(record) || />\s*STALL_MS/.test(record),
      '遅れの大きさをしきい値と比べていない');
    assert.ok(/reject\(/.test(record.slice(record.indexOf('STALL_MS'))),
      '詰まりを検知しても reject していない（壊れた動画のまま進んでしまう）');
  });

  // ★ コマ間隔を手動にしても、ページで最初の録画だけ11コマ目あたりで
  //   詰まることが実測で分かった（同じページで2回録ると、1回目だけ詰まり
  //   2回目は綺麗に30fpsになる＝ブラウザ側エンコーダの初期化コストらしい）。
  //   本番の録画の前に、捨てる小さな録画で一度温めておくことで、
  //   本番の16.8秒からその詰まりを追い出している。
  await check('本番の録画の前に、エンコーダを一度温めている', () => {
    const fs = require('fs');
    const reel = fs.readFileSync(__dirname + '/../public/reel.js', 'utf8');
    assert.ok(/function\s+warmupEncoder/.test(reel), 'warmupEncoder が無い');
    assert.ok(/function\s+ensureWarm/.test(reel), 'ensureWarm が無い');
    const start = reel.indexOf('function record(');
    const record = reel.slice(start, start + 500);
    assert.ok(/ensureWarm\(/.test(record),
      '本番の録画が ensureWarm を経由していない（詰まりが本番に残る）');
  });

  await check('赤字（answer）は黒字より太いままにしてある（見分けの階層）', () => {
    const fs = require('fs');
    const reel = fs.readFileSync(__dirname + '/../public/reel.js', 'utf8');
    const web = reel.match(/web:\s*\{\s*body:\s*([0-9]+),\s*answer:\s*([0-9]+)/);
    const fb = reel.match(/fallback:\s*\{\s*body:\s*([0-9]+),\s*answer:\s*([0-9]+)/);
    assert.ok(Number(web[2]) > Number(web[1]), 'Webフォントで赤字が黒字より太くない');
    assert.ok(Number(fb[2]) > Number(fb[1]), '端末フォントで赤字が黒字より太くない');
  });

  await check('縮める境目は reel.js の MIN_SCALE から出している', () => {
    const fs = require('fs');
    const reel = fs.readFileSync(__dirname + '/../public/reel.js', 'utf8');
    const m = reel.match(/READABLE_SCALE\s*=\s*([0-9.]+)/);
    assert.ok(m, 'reel.js に READABLE_SCALE が無い');
    assert.strictEqual(Number(m[1]), rules.MIN_SCALE,
      '点検と描画で「読める大きさ」の線が食い違っている');

    // ★ 描画側はもっと下まで縮める余地を持っていること。
    //   READABLE で頭打ちにすると、そこを超える台本は右が切れる。
    //   切るくらいなら小さくする（全部表示されないと意味がないため）。
    const hard = reel.match(/HARD_MIN_SCALE\s*=\s*([0-9.]+)/);
    assert.ok(hard, 'reel.js に HARD_MIN_SCALE が無い');
    assert.ok(Number(hard[1]) < rules.MIN_SCALE,
      '最後の逃げ道が無い。長い台本で右が切れる');
  });

  // ------------------------------------------------------------ ハッシュタグ
  await check('# の付け忘れを直し、重複と空を落とす', () => {
    assert.deepStrictEqual(
      rules.normalizeHashtags(['転職', '#転職', ' #第二新卒 ', '', null, '＃退職']),
      ['#転職', '#第二新卒', '#退職']);
  });

  await check('キャプションの後ろに、行を空けて足す', () => {
    const out = rules.captionWithTags('口コミを集めました', ['#転職', '#第二新卒'], 'instagram');
    assert.strictEqual(out, '口コミを集めました\n\n#転職 #第二新卒');
  });

  // ★ X は多いと読まれない。ここだけ2個で切る。
  await check('X だけは2個までにする', () => {
    const out = rules.captionWithTags('答え合わせ', ['#a', '#b', '#c', '#d'], 'x');
    assert.strictEqual(out, '答え合わせ\n\n#a #b');
  });

  await check('ハッシュタグが少ないと warning（止めはしない）', () => {
    const f = rules.findingsOf(draft({ hashtags: ['#転職'] }), 'too-few-hashtags');
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].severity, 'warning');
    assert.ok(!rules.hasBlocking(rules.validateDraft(draft({ hashtags: ['#転職'] }))),
      'ハッシュタグ不足で止めてしまっている');
  });

  // ★ #PR はハッシュタグ側に入れるのが実務。本文だけ見ていると、
  //   正しく付けてあるのに弾いてしまう。
  await check('PR表記はハッシュタグに入っていても通る', () => {
    const d = draft({ hasAffiliateLink: true, hashtags: ['#PR', '#転職', '#第二新卒'] });
    assert.deepStrictEqual(rules.findingsOf(d, 'missing-pr-label'), []);
  });

  await check('PR表記がどこにも無ければ、案件つきは止まる', () => {
    const d = draft({ hasAffiliateLink: true, hashtags: ['#転職', '#第二新卒', '#退職'] });
    const f = rules.findingsOf(d, 'missing-pr-label');
    assert.strictEqual(f.length, 2, 'Instagram と TikTok の両方で言うべき');
    assert.ok(rules.hasBlocking(rules.validateDraft(d)));
  });

  await check('ハッシュタグは出させる形の必須に入っている', () => {
    const gen = require('../lib/draft-generate');
    assert.ok(gen.SCHEMA.required.includes('hashtags'), '必須になっていない');
    assert.ok(gen.SCHEMA.properties.hashtags, '欄が無い');
  });

  await check('問い＋答えが15字ぶんを超えると warning', () => {
    const rows = reel09.rows.slice();
    rows[0] = { question: '職場でうっかり話してしまうと', answer: '一気に広まる' };
    const f = rules.findingsOf(draft({ rows }), 'row-too-wide');
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].severity, 'warning');
  });

  await check('半角英数は半分の幅で数える（SNSの行は通る）', () => {
    assert.deepStrictEqual(rules.findingsOf(reel09, 'row-too-wide'), []);
  });

  await check('6行でなければ error', () => {
    const f = rules.findingsOf(draft({ rows: reel09.rows.slice(0, 5) }), 'row-count');
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].severity, 'error');
  });

  // ---- 運用アカウントごとの規則 --------------------------------------------

  await check('ひろや側では一人称を弾かない', () => {
    assert.deepStrictEqual(rules.validateDraft(personal, rules.PERSONAL), []);
  });

  await check('同じ投稿をキュレーター規則にかけると弾かれる', () => {
    const f = rules.validateDraft(personal, rules.CURATOR);
    assert.ok(f.some((x) => x.rule === 'first-person-experience'));
  });

  await check('数値と断定はどちらの規則でも弾く', () => {
    const d = Object.assign({}, personal, { igCaption: '利用者の8割が満足しています' });
    assert.ok(rules.findingsOf(d, 'unsourced-number', rules.PERSONAL).length > 0);
  });

  await check('知らないプロファイルは安全側に倒れる', () => {
    assert.strictEqual(rules.profileFor('なにこれ').id, 'curator');
  });

  // ---- 投稿先の取り違え ----------------------------------------------------

  const affi = { id: 'a1', group_id: 'g_affi', network: 'instagram', label: 'アフィリ用' };
  const kikaku = { id: 'a2', group_id: 'g_kikaku', network: 'instagram', label: '企画用' };
  const xAffi = { id: 'a3', group_id: 'g_affi', network: 'x', label: 'アフィリ用' };

  await check('選んだ運用アカウントの連携先しか出さない', () => {
    assert.deepStrictEqual(scope.accountsFor('g_affi', [affi, kikaku, xAffi]).map((a) => a.id), ['a1', 'a3']);
  });

  await check('同じ運用アカウントなら通す', () => {
    assert.strictEqual(scope.checkTarget({ group_id: 'g_affi' }, affi), null);
  });

  await check('別の運用アカウントへは出さない', () => {
    const issue = scope.checkTarget({ group_id: 'g_affi' }, kikaku);
    assert.strictEqual(issue.code, 'cross-account');
    assert.ok(issue.message.includes('企画用'));
  });

  await check('案件リンクつきの投稿は X に出せない（A8の掲載対象外）', () => {
    const issue = scope.checkTarget({ group_id: 'g_affi', hasAffiliateLink: true }, xAffi);
    assert.strictEqual(issue.code, 'affiliate-not-allowed');
  });

  await check('案件リンクなしなら X に出せる', () => {
    assert.strictEqual(scope.checkTarget({ group_id: 'g_affi', hasAffiliateLink: false }, xAffi), null);
  });

  await check('期限切れの連携先には出さない', () => {
    const dead = Object.assign({}, affi, { expires_at: '2020-01-01T00:00:00Z' });
    assert.strictEqual(scope.checkTarget({ group_id: 'g_affi' }, dead).code, 'expired');
  });

  await check('別アカウントかつ期限切れなら、別アカウントを先に言う', () => {
    const dead = Object.assign({}, kikaku, { expires_at: '2020-01-01T00:00:00Z' });
    assert.strictEqual(scope.checkTarget({ group_id: 'g_affi' }, dead).code, 'cross-account');
  });

  await check('複数の投稿先をまとめて見る（api/posts.js の呼び方）', () => {
    const issues = scope.checkTargets({ group_id: 'g_affi' }, [affi, kikaku]);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].accountId, 'a2');
  });

  await check('全部そろっていれば指摘なし', () => {
    assert.deepStrictEqual(scope.checkTargets({ group_id: 'g_affi' }, [affi, xAffi]), []);
  });

  await check('投稿先が空でも落ちない', () => {
    assert.deepStrictEqual(scope.checkTargets({ group_id: 'g_affi' }, []), []);
  });

  // ---- 生成 → 点検 → 作り直し ----------------------------------------------

  const clean = {
    kicker: '迷ってる人へ!?',
    title: '引き止められたときの返し方',
    rows: [
      { question: 'その場で答えると', answer: '覆る' },
      { question: '口約束のままだと', answer: '消える' },
      { question: '理由を蒸し返すと', answer: '長引く' },
      { question: '退職日を動かすと', answer: '延びる' },
      { question: '条件交渉に乗ると', answer: '残される' },
      { question: 'いちばん確実なのは', answer: '記録' },
    ],
    igCaption: '引き止めは一度はある、という声が多かったです',
    ttCaption: '引き止めは一度はある、という声が多かったです',
    xText: '6つ、答え合わせ。',
    tone: 'calm',
  };
  const dirty = Object.assign({}, clean, { igCaption: '私も引き止められました' });
  const topic = { topicId: 'N03', title: '引き止められたときの受け答え', tone: 'calm', groupId: 'g_affi' };

  /** 用意した順に返すだけの偽物。何を渡されたかを記録する。 */
  function stub(queue) {
    const seen = [];
    return {
      seen,
      generate: async (t, previous, attempt) => {
        seen.push({ topic: t, previous, attempt });
        const next = queue.shift();
        if (!next) throw new Error('呼ばれすぎです');
        return next;
      },
    };
  }

  await check('一度で通れば1回しか呼ばない', async () => {
    const s = stub([clean]);
    const r = await gen.generateDraft(topic, { generate: s.generate });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.attempts, 1);
    assert.strictEqual(s.seen.length, 1);
  });

  // ★ この不具合の、生成ループを通した再現。1回目に空の本文が返ってきても、
  //   下書きのまま止まらず、指摘を添えて書き直しをかけることを確かめる。
  await check('本文が空で返ってきたら作り直し、次の依頼にその指摘を渡す', async () => {
    const empty = Object.assign({}, clean, { igCaption: '' });
    const s = stub([empty, clean]);
    const r = await gen.generateDraft(topic, { generate: s.generate });
    assert.strictEqual(r.ok, true, '書き直し後も通らないままになっている');
    assert.strictEqual(r.attempts, 2);
    assert.strictEqual(s.seen[1].previous.findings.some((f) => f.rule === 'empty-caption'), true,
      '空だったことを次の依頼に伝えていない');
  });

  await check('空のまま3回続けば、下書きとして止まる（消えて無くなりはしない）', async () => {
    const empty = Object.assign({}, clean, { igCaption: '' });
    const s = stub([empty, empty, empty]);
    const r = await gen.generateDraft(topic, { generate: s.generate });
    assert.strictEqual(r.ok, false);
    assert.ok(r.findings.some((f) => f.rule === 'empty-caption'), '理由が指摘に残っていない');
  });

  await check('呼び出し側が決める値を差し込む', async () => {
    const s = stub([clean]);
    const r = await gen.generateDraft(topic, { generate: s.generate });
    assert.strictEqual(r.draft.topicId, 'N03');
    assert.strictEqual(r.draft.groupId, 'g_affi');
    assert.strictEqual(r.draft.hasAffiliateLink, false);
  });

  await check('error が出たら作り直す', async () => {
    const s = stub([dirty, clean]);
    const r = await gen.generateDraft(topic, { generate: s.generate });
    assert.strictEqual(r.attempts, 2);
    assert.strictEqual(r.ok, true);
  });

  await check('作り直しのときは、何が悪かったかを渡す', async () => {
    const s = stub([dirty, clean]);
    await gen.generateDraft(topic, { generate: s.generate });
    assert.strictEqual(s.seen[0].previous, null);
    assert.ok(s.seen[1].previous.findings.some((f) => f.rule === 'first-person-experience'));
  });

  await check('直らなければ、最後の結果と指摘を返す（投げない）', async () => {
    const s = stub([dirty, dirty, dirty]);
    const r = await gen.generateDraft(topic, { generate: s.generate, maxAttempts: 3 });
    assert.strictEqual(r.attempts, 3);
    assert.strictEqual(r.ok, false);
    assert.ok(r.findings.some((f) => f.rule === 'first-person-experience'));
  });

  await check('生成が例外を投げても、作り直しに進む', async () => {
    let n = 0;
    const generate = async () => {
      n += 1;
      if (n === 1) throw new Error('JSONが壊れていた');
      return clean;
    };
    const r = await gen.generateDraft(topic, { generate });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.attempts, 2);
  });

  await check('warning だけなら作り直さない', async () => {
    // ★ 15字ぶん。タイトルの上限14を1つだけ超える＝縮めて収まる長さ。
    //   ここを長くしすぎると error になって、この試験の意味が変わる。
    const wide = Object.assign({}, clean, { title: '引き止められたときの上手な返し方' });
    const s = stub([wide]);
    const r = await gen.generateDraft(topic, { generate: s.generate });
    assert.strictEqual(s.seen.length, 1);
    assert.strictEqual(r.ok, true);
    assert.ok(r.findings.every((f) => f.severity === 'warning'));
  });

  await check('案件つきで PR表記が無ければ作り直す', async () => {
    const withPr = Object.assign({}, clean, {
      igCaption: '引き止めは一度はある、という声が多かったです #PR',
      ttCaption: '引き止めは一度はある、という声が多かったです #PR',
    });
    const s = stub([clean, withPr]);
    const r = await gen.generateDraft(Object.assign({}, topic, { hasAffiliateLink: true }), { generate: s.generate });
    assert.strictEqual(s.seen.length, 2);
    assert.strictEqual(r.ok, true);
  });

  // ---- リクエストの組み立て ------------------------------------------------

  await check('Claude には構造化出力の形で投げている', () => {
    const p = gen.buildParams(topic, null, 'anthropic');
    assert.strictEqual(p.model, 'claude-opus-5');
    assert.strictEqual(p.output_config.format.type, 'json_schema');
    assert.strictEqual(p.output_config.format.schema.properties.rows.minItems, 6);
    assert.strictEqual(p.system[0].cache_control.type, 'ephemeral');
  });

  await check('OpenAI にも同じ中身を、あちらの形で投げている', () => {
    const p = gen.buildParams(topic, null, 'openai');
    assert.strictEqual(p.response_format.type, 'json_schema');
    assert.strictEqual(p.response_format.json_schema.strict, true);
    assert.strictEqual(p.messages[0].role, 'system');
    assert.ok(p.messages[0].content.includes('キュレーター'), '前置きが入っていない');
    assert.strictEqual(p.messages[1].content, gen.buildUserMessage(topic, null));
  });

  // ★ strict モードは minItems を受け付けない。残すと 400 で弾かれる。
  //   行数は draft-rules の row-count が見るので、縛りが消えるわけではない。
  await check('OpenAI 向けでは、通らない語を落としている', () => {
    const p = gen.buildParams(topic, null, 'openai');
    const rows = p.response_format.json_schema.schema.properties.rows;
    assert.ok(!('minItems' in rows) && !('maxItems' in rows), 'minItems が残っている');
    assert.strictEqual(rows.items.additionalProperties, false, '入れ子の縛りまで落ちている');
    assert.deepStrictEqual(rows.items.required, ['question', 'answer']);
    // 元のスキーマは触っていない
    assert.strictEqual(gen.SCHEMA.properties.rows.minItems, 6);
  });

  await check('案件つきのときは X に載せないよう伝える', () => {
    const msg = gen.buildUserMessage(Object.assign({}, topic, { hasAffiliateLink: true }), null);
    assert.ok(msg.includes('X は A8.net の掲載対象外'));
  });

  await check('まとめ生成は custom_id を付ける', () => {
    const reqs = gen.buildBatchRequests([topic, Object.assign({}, topic, { topicId: 'N05' })]);
    assert.deepStrictEqual(reqs.map((r) => r.custom_id), ['N03', 'N05']);
  });

  const bad = results.filter((r) => r[0] === 'NG');
  for (const [mark, name] of results) console.log(`  ${mark === 'ok' ? '✓' : '✗'} ${name}`);
  console.log(`\n  ${results.length - bad.length} / ${results.length} 件成功`);
  process.exit(bad.length ? 1 : 0);
})();
