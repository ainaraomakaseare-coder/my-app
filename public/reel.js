'use strict';
/**
 * 縦型動画とX用の画像2枚を、ブラウザの中で組み立てる。
 *
 * ★ なぜサーバーではなくブラウザなのか
 *   このアプリは元々「動画はブラウザから Supabase へ直接送る」設計になっている
 *   （Vercel は1リクエスト4.5MBまでしか受け取れないため）。
 *   描くのもブラウザでやれば、その流れにそのまま乗る。サーバーに ffmpeg を
 *   積む必要がなく、費用もかからない。
 *
 * ★ 数値の出どころ
 *   すべて実物の動画（reel_09）を1コマずつ測って逆算した値。
 *   線の量と幅を実物と突き合わせて詰めてある（比 0.95〜1.01、幅の差 ±3px）。
 */

(function () {
  const W = 720, H = 1280;
  const BG = '#FBF7EF', INK = '#0D0903', RED = '#B73029';

  // 実物の書体は特定できていない。実測（線の量と幅）でいちばん近いのが
  // DemiLight 相当のゴシックで、答えだけ Medium 相当で太い。
  //
  // ★ 端末のフォント任せにすると、見る人の環境で太さが変わってしまう。
  //   Webフォントを読み込んで固定する。届かないときだけ端末のフォントに落とし、
  //   その場合は太さの刻みが粗いので重みを振り直す（下の WEIGHTS）。
  //
  // ★ 「黒字の漢字が細い」の正体。
  //   端末のフォント（Hiragino / Yu Gothic / Meiryo 等）は、太さの刻みが
  //   Regular と Bold の2つしか無いことが多い。350〜550くらいまでは
  //   ぜんぶ同じ「Regular」に丸められ、600に達して初めて「Bold」になる
  //   ————これを実際に描いて画素で数えて確認した（350〜550は同じ濃さ、
  //   600からだけ濃さが4割増える）。
  //   黒字（body）は 400、赤字（answer）は 600 だったので、
  //   赤字だけが太字の側に入り、黒字は「太くしたつもり」のまま
  //   細いRegularに丸められていた。だから赤字は太いのに黒字だけ細い、
  //   という見え方になっていた。
  //   黒字も 600 に載せることで、Webフォントが読めない環境でも
  //   確実に太字として描く。
  const FAMILY = '"Noto Sans JP","Hiragino Kaku Gothic ProN","Yu Gothic","Meiryo",sans-serif';
  const WEIGHTS = {
    web:      { body: 500, answer: 600 },   // 実測 350/500 より一段太く。Webフォントは指定どおり細かく効く
    fallback: { body: 600, answer: 700 },   // 600未満は Regular に丸められる端末が多いので、600以上に揃える
  };
  let weights = WEIGHTS.fallback;
  let fontSource = '端末のフォント';

  /** Webフォントが使えるか確かめる。使えれば実測どおりの太さで描ける。 */
  async function ensureFont() {
    try {
      if (!document.fonts || !document.fonts.load) throw new Error('no font api');
      await Promise.race([
        Promise.all([
          document.fonts.load('500 40px "Noto Sans JP"', '転職'),   // body の実際の太さ
          document.fonts.load('600 31px "Noto Sans JP"', '広まる'),   // answer の実際の太さ
        ]),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
      ]);
      // ★ document.fonts.check は端末に同名のフォントがあっても true を返す。
      //   それでは「Webフォントが効いている」ことの確認にならないので、
      //   読み込まれた FontFace が実際に登録されているかを見る。
      let loaded = false;
      document.fonts.forEach((f) => {
        if (f.family.replace(/["']/g, '') === 'Noto Sans JP' && f.status === 'loaded') loaded = true;
      });
      if (!loaded) throw new Error('not a webfont');
      weights = WEIGHTS.web;
      fontSource = 'Noto Sans JP（Webフォント）';
    } catch (e) {
      weights = WEIGHTS.fallback;
      fontSource = '端末のフォント（Webフォントが読めませんでした）';
    }
    return fontSource;
  }

  const SPEC = {
    kicker: { size: 34, role: 'body', track: 2, x: 44, inkTop: 172 },
    title:  { size: 40, role: 'body', track: 4, x: 44, inkTop: 221 },
    rule:   { y: 274, h: 4 },
    row:    { size: 32, role: 'body', track: 4, numX: 45, qX: 111 },
    answer: { size: 31, role: 'answer', track: 6 },
    box:    { h: 59, gap: 15, padX: 22, radius: 3, line: 2 },
    tops:   [316, 441, 566, 690, 816, 940],
    appear: [1.3, 3.8, 6.3, 8.8, 11.3, 13.8],
    charStep: 0.12,
    duration: 16.8,
    fps: 30,
  };

  /**
   * 墨を置いてよい右端。実物の右余白44pxから。
   *
   * ★ 文字が長いときは、はみ出させずに縮めて収める。
   *   台本を書くモデルには「15字以内」と頼んであるが、実際には守られない。
   *   守られなかったときに切れて読めなくなるより、小さくても全部見えるほうがよい。
   *   （見切れると穴埋めの答えが読めず、動画の意味がなくなる）
   */
  const RIGHT = W - 44;

  /**
   * 縮みの下限は2段ある。
   *
   * ★ READABLE … ここまでなら読める、という線。0.75倍＝32pxが24px。
   *   点検（lib/draft-rules.js）はこの線を基準に、
   *   これより縮めないと入らない台本を error として止める。
   *   つまり「小さくて読めない動画」は、そもそも公開まで進まない。
   *
   * ★ HARD … 切るよりはマシ、という最後の線。
   *   点検を通り抜けた台本や、下書きとして作った動画まで
   *   READABLE で頭打ちにすると、右が切れて読めなくなる。
   *   切るくらいなら小さくする。「全部表示されないと意味がない」ため。
   *
   * ★ 0.55 を READABLE にしていたのが間違いだった。
   *   32px が 18px になり、しかも6行そろえて縮めるので、
   *   長い行が1本あるだけで全部が小さくなっていた。
   */
  const READABLE_SCALE = 0.75;
  const HARD_MIN_SCALE = 0.45;

  /**
   * タイトルの下の赤い線は、文字の右端より3px長く引く（実物どおり）。
   * ★ タイトルを右端ぴったりに縮めると、この線だけがはみ出す。
   *   線のぶんを見込んで、タイトルはその手前で止める。
   */
  const RULE_OVERHANG = 3;

  /** 大きさと字間を、同じ割合でまとめて縮める。 */
  const scaled = (s, k) => (k === 1 ? s : Object.assign({}, s, { size: s.size * k, track: s.track * k }));

  /** x から置いたとき、墨の右端が right に収まる倍率。 */
  function fitScale(ctx, text, spec, x, right) {
    if (!text) return 1;
    const rightAt = (k) => {
      const sp = scaled(spec, k);
      ctx.font = font(sp);
      return x + inkSpan(ctx, text, sp).width;
    };
    if (rightAt(1) <= right) return 1;

    let lo = HARD_MIN_SCALE, hi = 1;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (rightAt(mid) <= right) lo = mid; else hi = mid;
    }
    return lo;
  }

  /** 問い＋答えの枠を置いたときの、枠の右端。 */
  function rowRight(ctx, row, k) {
    const q = scaled(SPEC.row, k), a = scaled(SPEC.answer, k);
    ctx.font = font(q);
    const qw = inkSpan(ctx, row.question || '', q).width;
    ctx.font = font(a);
    const aw = inkSpan(ctx, row.answer || '', a).width;
    return SPEC.row.qX + qw + SPEC.box.gap + aw + SPEC.box.padX * 2;
  }

  /** その行を丸ごと右端に収める倍率。問いと答えは同じだけ縮める。 */
  function rowScale(ctx, row) {
    if (rowRight(ctx, row, 1) <= RIGHT) return 1;
    let lo = HARD_MIN_SCALE, hi = 1;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (rowRight(ctx, row, mid) <= RIGHT) lo = mid; else hi = mid;
    }
    return lo;
  }

  /**
   * 6行ぜんぶに使う、ひとつの倍率。いちばん長い行に合わせる。
   *
   * ★ 行ごとに変えると、大きい行と小さい行が混ざって不格好になる。
   *   実物は6行とも同じ大きさで、そこが読みやすさを作っている。
   *   長い行が1本あれば全体が小さくなるが、そろっているほうがまだ読める。
   */
  function rowsScale(ctx, rows) {
    let k = 1;
    for (const row of rows || []) k = Math.min(k, rowScale(ctx, row));
    return k;
  }

  const font = (s) => `${weights[s.role]} ${s.size}px ${FAMILY}`;

  /** 字間を入れて並べたときの、墨が乗る範囲。 */
  function inkSpan(ctx, text, s) {
    if (!text) return { left: 0, width: 0 };
    let pen = 0;
    for (let i = 0; i < text.length - 1; i++) pen += ctx.measureText(text[i]).width + s.track;
    const first = ctx.measureText(text[0]);
    const last = ctx.measureText(text[text.length - 1]);
    const left = -first.actualBoundingBoxLeft;
    return { left, width: pen + last.actualBoundingBoxRight - left };
  }

  /** 字間を空けて1文字ずつ置く。戻り値は墨の右端。 */
  function drawTracked(ctx, x, baseline, text, s, color) {
    ctx.font = font(s);
    ctx.fillStyle = color;
    ctx.textBaseline = 'alphabetic';
    let pen = x - inkSpan(ctx, text, s).left;
    let right = pen;
    for (const ch of text) {
      ctx.fillText(ch, pen, baseline);
      right = pen + ctx.measureText(ch).actualBoundingBoxRight;
      pen += ctx.measureText(ch).width + s.track;
    }
    return right;
  }

  /** 墨の上端を inkTop に合わせるためのベースライン。 */
  function baselineForTop(ctx, text, s, inkTop) {
    ctx.font = font(s);
    return inkTop + ctx.measureText(text).actualBoundingBoxAscent;
  }

  /** その行の墨が centerY を中心に来るベースライン。 */
  function baselineForCenter(ctx, text, s, centerY) {
    ctx.font = font(s);
    const m = ctx.measureText(text);
    return centerY + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else {
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
  }

  /**
   * 答え以外をすべて描き、枠の位置を返す。
   * 毎コマ描き直すと重いので、下地は1回だけ作って使い回す。
   */
  function drawBase(ctx, draft) {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    const kicker = draft.kicker || '', title = draft.title || '';
    const k = scaled(SPEC.kicker, fitScale(ctx, kicker, SPEC.kicker, SPEC.kicker.x, RIGHT));
    const t = scaled(SPEC.title,
      fitScale(ctx, title, SPEC.title, SPEC.title.x, RIGHT - RULE_OVERHANG));

    drawTracked(ctx, k.x, baselineForTop(ctx, kicker, k, k.inkTop), kicker, k, INK);

    const right = drawTracked(
      ctx, t.x, baselineForTop(ctx, title, t, t.inkTop), title, t, INK);
    ctx.fillStyle = RED;
    ctx.fillRect(t.x - 1, SPEC.rule.y,
      Math.round(right) + RULE_OVERHANG - (t.x - 1), SPEC.rule.h);

    const boxes = [];
    // ★ 6行そろえて縮める。番号は縮めない（列がガタつくと読みにくい）。
    const rk = rowsScale(ctx, draft.rows);
    const q = scaled(SPEC.row, rk), ans = scaled(SPEC.answer, rk);

    (draft.rows || []).forEach((row, i) => {
      const cy = SPEC.tops[i] + SPEC.box.h / 2;
      const base = baselineForCenter(ctx, row.question, q, cy);

      drawTracked(ctx, SPEC.row.numX, baselineForCenter(ctx, '1', SPEC.row, cy),
        (i + 1) + '、', { ...SPEC.row, track: 0 }, INK);
      const qEnd = drawTracked(ctx, SPEC.row.qX, base, row.question, q, INK);

      ctx.font = font(ans);
      const aw = inkSpan(ctx, row.answer, ans).width;
      const bx = Math.round(qEnd) + SPEC.box.gap;
      const bw = Math.round(aw) + SPEC.box.padX * 2;
      const by = Math.round(cy - SPEC.box.h / 2);

      ctx.strokeStyle = INK;
      ctx.lineWidth = SPEC.box.line;
      roundRect(ctx, bx + 1, by + 1, bw - 2, SPEC.box.h - 2, SPEC.box.radius);
      ctx.stroke();

      // 答えは実物では行の中心より 2px 上に乗る（実測）
      const abase = baselineForCenter(ctx, row.answer, ans, cy - 2);
      boxes.push({ bx, bw, base: abase, answer: row.answer, aw, spec: ans });
    });
    return boxes;
  }

  /** 答えは枠の中央に置く。右寄せではない。 */
  function drawAnswer(ctx, box, nChars) {
    if (nChars <= 0) return;
    // ★ 縮めた行は、答えも同じだけ縮める。下地で測った枠と食い違わせない。
    const s = box.spec || SPEC.answer;
    ctx.font = font(s);
    drawTracked(ctx, box.bx + (box.bw - box.aw) / 2, box.base,
      box.answer.slice(0, nChars), s, RED);
  }

  /** t 秒時点の絵を描く。 */
  function drawAt(ctx, base, boxes, t) {
    ctx.drawImage(base, 0, 0);
    boxes.forEach((box, i) => {
      if (t < SPEC.appear[i]) return;
      const n = Math.min(box.answer.length, Math.floor((t - SPEC.appear[i]) / SPEC.charStep) + 1);
      drawAnswer(ctx, box, n);
    });
  }

  function newCanvas() {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    return c;
  }

  /** X用の画像。filled=false なら空欄、true なら答え入り。 */
  function poster(draft, filled) {
    const c = newCanvas(), ctx = c.getContext('2d');
    const boxes = drawBase(ctx, draft);
    if (filled) boxes.forEach((b) => drawAnswer(ctx, b, b.answer.length));
    return c;
  }

  /** 使える形式を選ぶ。mp4 が取れるならそちら。 */
  function pickMime() {
    const list = [
      'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4',
      'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm',
    ];
    for (const m of list) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  /**
   * 実時間で1回再生しながら録る。16.8秒かかる。
   * onProgress(0..1) で進み具合を返す。
   *
   * ★ TikTok の frame_rate_check_failed 対策。
   *   以前は captureStream(30) を requestAnimationFrame で駆動していた。
   *   ところが rAF は画面の描画周期（実測：約60Hz＝16.7ms間隔）で呼ばれ、
   *   captureStream に渡した「30fps」とはズレている。この差をブラウザが
   *   内部で間引くときの詰め方が不揃いで、実際に録ってみると同じ時刻の
   *   コマが2枚できることがあった（ffmpeg で「non monotonically
   *   increasing dts: 84 >= 84」として検出）。コマ間隔が均一でない動画は、
   *   TikTok の取り込み時の検査で弾かれる。
   *
   *   captureStream(0)（手動モード）にして、コマを渡すタイミングを
   *   自分で決める。setTimeout を「開始時刻＋n×コマ間隔」で毎回
   *   計算し直す（前のコマからの相対時間にしない）ことで、
   *   イベントループの遅れが積み重ならないようにしてある。
   */
  function record(draft, onProgress) {
    return new Promise((resolve, reject) => {
      if (!window.MediaRecorder) return reject(new Error('このブラウザは動画の書き出しに対応していません。'));
      const mime = pickMime();
      if (!mime) return reject(new Error('このブラウザは動画の書き出しに対応していません。'));

      const base = newCanvas();
      const boxes = drawBase(base.getContext('2d'), draft);

      const out = newCanvas();
      const ctx = out.getContext('2d');
      drawAt(ctx, base, boxes, 0);

      // ★ 手動モードに対応していないブラウザ（Firefox・Safari等）は、
      //   前どおり自動キャプチャに戻す。動かなくなるよりはまし。
      //   このアプリは元から「Chrome か Edge で」と案内しているので、
      //   そちらでは常に手動モードが使われる。
      const manualStream = out.captureStream(0);
      const track = manualStream.getVideoTracks()[0];
      const manual = typeof track.requestFrame === 'function';
      const stream = manual ? manualStream : out.captureStream(SPEC.fps);
      const pushFrame = manual ? () => track.requestFrame() : () => {};

      const chunks = [];
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2500000 });
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onerror = (e) => reject(e.error || new Error('録画に失敗しました。'));
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: mime });
        resolve({ blob, mime, ext: mime.indexOf('mp4') >= 0 ? 'mp4' : 'webm' });
      };

      const stepMs = 1000 / SPEC.fps;
      const t0 = performance.now();
      let stopped = false;

      rec.start();
      pushFrame();   // 最初のコマ（t=0）を必ず1枚押し出す

      (function schedule(n) {
        const delay = Math.max(0, t0 + n * stepMs - performance.now());
        setTimeout(() => {
          if (stopped) return;
          const t = (performance.now() - t0) / 1000;
          if (t >= SPEC.duration) {
            drawAt(ctx, base, boxes, SPEC.duration);
            pushFrame();
            stopped = true;
            setTimeout(() => rec.stop(), 120);   // 最後のコマを取りこぼさない
            if (onProgress) onProgress(1);
            return;
          }
          drawAt(ctx, base, boxes, t);
          pushFrame();
          if (onProgress) onProgress(t / SPEC.duration);
          schedule(n + 1);
        }, delay);
      })(1);
    });
  }

  window.Reel = { SPEC, W, H, RIGHT, READABLE_SCALE, HARD_MIN_SCALE,
                  drawBase, drawAt, poster, record, pickMime,
                  newCanvas, rowScale, rowsScale, fitScale,
                  ensureFont, fontSource: () => fontSource };
})();
