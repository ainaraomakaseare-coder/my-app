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
  const FAMILY = '"Noto Sans JP","Hiragino Kaku Gothic ProN","Yu Gothic","Meiryo",sans-serif';
  const WEIGHTS = {
    web:      { body: 350, answer: 500 },   // 実測に一致する値
    fallback: { body: 400, answer: 600 },   // 端末のフォントは Regular/Bold しか無いことが多い
  };
  let weights = WEIGHTS.fallback;
  let fontSource = '端末のフォント';

  /** Webフォントが使えるか確かめる。使えれば実測どおりの太さで描ける。 */
  async function ensureFont() {
    try {
      if (!document.fonts || !document.fonts.load) throw new Error('no font api');
      await Promise.race([
        Promise.all([
          document.fonts.load('350 40px "Noto Sans JP"', '転職'),
          document.fonts.load('500 31px "Noto Sans JP"', '広まる'),
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

    const k = SPEC.kicker, t = SPEC.title;
    drawTracked(ctx, k.x, baselineForTop(ctx, draft.kicker || '', k, k.inkTop), draft.kicker || '', k, INK);

    const right = drawTracked(
      ctx, t.x, baselineForTop(ctx, draft.title || '', t, t.inkTop), draft.title || '', t, INK);
    ctx.fillStyle = RED;
    ctx.fillRect(t.x - 1, SPEC.rule.y, Math.round(right) + 3 - (t.x - 1), SPEC.rule.h);

    const boxes = [];
    (draft.rows || []).forEach((row, i) => {
      const cy = SPEC.tops[i] + SPEC.box.h / 2;
      const base = baselineForCenter(ctx, row.question, SPEC.row, cy);

      drawTracked(ctx, SPEC.row.numX, base, (i + 1) + '、', { ...SPEC.row, track: 0 }, INK);
      const qEnd = drawTracked(ctx, SPEC.row.qX, base, row.question, SPEC.row, INK);

      ctx.font = font(SPEC.answer);
      const aw = inkSpan(ctx, row.answer, SPEC.answer).width;
      const bx = Math.round(qEnd) + SPEC.box.gap;
      const bw = Math.round(aw) + SPEC.box.padX * 2;
      const by = Math.round(cy - SPEC.box.h / 2);

      ctx.strokeStyle = INK;
      ctx.lineWidth = SPEC.box.line;
      roundRect(ctx, bx + 1, by + 1, bw - 2, SPEC.box.h - 2, SPEC.box.radius);
      ctx.stroke();

      // 答えは実物では行の中心より 2px 上に乗る（実測）
      const abase = baselineForCenter(ctx, row.answer, SPEC.answer, cy - 2);
      boxes.push({ bx, bw, base: abase, answer: row.answer, aw });
    });
    return boxes;
  }

  /** 答えは枠の中央に置く。右寄せではない。 */
  function drawAnswer(ctx, box, nChars) {
    if (nChars <= 0) return;
    ctx.font = font(SPEC.answer);
    drawTracked(ctx, box.bx + (box.bw - box.aw) / 2, box.base,
      box.answer.slice(0, nChars), SPEC.answer, RED);
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

      const stream = out.captureStream(SPEC.fps);
      const chunks = [];
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2500000 });
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onerror = (e) => reject(e.error || new Error('録画に失敗しました。'));
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: mime });
        resolve({ blob, mime, ext: mime.indexOf('mp4') >= 0 ? 'mp4' : 'webm' });
      };

      const t0 = performance.now();
      rec.start();
      (function tick() {
        const t = (performance.now() - t0) / 1000;
        if (t >= SPEC.duration) {
          drawAt(ctx, base, boxes, SPEC.duration);
          setTimeout(() => rec.stop(), 120);   // 最後のコマを取りこぼさない
          if (onProgress) onProgress(1);
          return;
        }
        drawAt(ctx, base, boxes, t);
        if (onProgress) onProgress(t / SPEC.duration);
        requestAnimationFrame(tick);
      })();
    });
  }

  window.Reel = { SPEC, W, H, drawBase, drawAt, poster, record, pickMime, newCanvas,
                  ensureFont, fontSource: () => fontSource };
})();
