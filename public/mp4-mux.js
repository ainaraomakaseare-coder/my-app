'use strict';
/**
 * H.264 のコマを並べて、MP4 ファイル1本に詰める（音声なし）。
 *
 * ★ なぜ自前で詰めるのか。
 *   動画は以前、画面で実時間どおりに再生しながら MediaRecorder で録っていた。
 *   この方式は、ブラウザの手が止まるとコマの時刻がずれる。
 *     - 録画中に主スレッドが詰まる → コマ間隔が揃わず TikTok の frame_rate_check_failed
 *     - タブが裏に回る → タイマーが間引かれて録画が止まる（まとめて仕込むで20本中13本が失敗）
 *   WebCodecs の VideoEncoder なら、各コマに時刻を自分で付けて書き出せる。
 *   実時間を待たないので、裏のタブでも止まらず、どのコマもきっちり 1/30 秒になる。
 *   ただし VideoEncoder は「コマの中身」を返すだけで、MP4 の箱には詰めてくれない。
 *   npm の部品は増やさない決まりなので、必要な箱だけをここで組み立てる。
 *
 * ★ 作る箱は、再生・取り込みに要る最小限。
 *   ftyp → moov（索引）→ mdat（中身）の順。索引を先に置くと、
 *   全部を読み込む前に再生を始められる（Instagram などの取り込みで無難）。
 *   チャンクは1つだけにする。16.8秒・数MBの動画なので、分ける理由が無い。
 *
 * ブラウザでは window.Mp4Mux、Node（テスト）では require で使う。
 */
(function (root) {
  const enc = (s) => Array.from(s, (c) => c.charCodeAt(0));

  function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
  function u16(n) { return [(n >>> 8) & 255, n & 255]; }

  /** 箱を1つ作る。中身は数の配列か Uint8Array の並び。 */
  function box(type, ...parts) {
    const body = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
    const size = 8 + body.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(size);
    out.set(u32(size), 0);
    out.set(enc(type), 4);
    let at = 8;
    for (const p of body) { out.set(p, at); at += p.length; }
    return out;
  }
  const full = (type, version, flags, ...parts) =>
    box(type, [version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255], ...parts);

  const MATRIX = [
    ...u32(0x00010000), ...u32(0), ...u32(0),
    ...u32(0), ...u32(0x00010000), ...u32(0),
    ...u32(0), ...u32(0), ...u32(0x40000000),
  ];

  /**
   * @param o.width, o.height  画面の大きさ
   * @param o.fps              1秒のコマ数（整数）。すべてのコマを同じ長さにする
   * @param o.avcC             エンコーダが返す decoderConfig.description（AVCDecoderConfigurationRecord）
   * @param o.samples          [{ data: Uint8Array（長さ前置きの NAL 列）, key: boolean }] を表示順に
   * @returns Uint8Array（MP4 ファイルの中身）
   */
  function mux(o) {
    const { width, height, fps, samples } = o;
    const avcC = o.avcC instanceof Uint8Array ? o.avcC : new Uint8Array(o.avcC || []);
    if (!samples || !samples.length) throw new Error('コマがありません。');
    if (!avcC.length) throw new Error('H.264 の設定（avcC）がありません。');
    if (!samples[0].key) throw new Error('最初のコマがキーフレームではありません。');

    // ★ 1コマ = 1000、1秒 = fps×1000。30fps なら 30000 刻みで、どのコマもちょうど 1/30 秒。
    const timescale = fps * 1000;
    const delta = 1000;
    const mediaDuration = samples.length * delta;
    const movieTimescale = 1000;
    const movieDuration = Math.round(mediaDuration * movieTimescale / timescale);

    const ftyp = box('ftyp', enc('isom'), u32(0x200), enc('isom'), enc('iso2'), enc('avc1'), enc('mp41'));

    const mvhd = full('mvhd', 0, 0,
      u32(0), u32(0), u32(movieTimescale), u32(movieDuration),
      u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0),
      MATRIX, new Array(24).fill(0), u32(2));

    const tkhd = full('tkhd', 0, 3,
      u32(0), u32(0), u32(1), u32(0), u32(movieDuration),
      u32(0), u32(0), u16(0), u16(0), u16(0), u16(0),
      MATRIX, u32(width << 16), u32(height << 16));

    const mdhd = full('mdhd', 0, 0,
      u32(0), u32(0), u32(timescale), u32(mediaDuration), u16(0x55c4) /* und */, u16(0));
    const hdlr = full('hdlr', 0, 0, u32(0), enc('vide'), u32(0), u32(0), u32(0), enc('VideoHandler'), [0]);

    const vmhd = full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0));
    const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));

    const avc1 = box('avc1',
      new Array(6).fill(0), u16(1),                 // 予約・データ参照番号
      u16(0), u16(0), u32(0), u32(0), u32(0),       // 予約
      u16(width), u16(height),
      u32(0x00480000), u32(0x00480000), u32(0),     // 72dpi・予約
      u16(1), new Array(32).fill(0),                // 1サンプル1コマ・圧縮器名（空）
      u16(0x0018), u16(0xffff),                     // 色深度・予約
      box('avcC', avcC));
    const stsd = full('stsd', 0, 0, u32(1), avc1);

    const stts = full('stts', 0, 0, u32(1), u32(samples.length), u32(delta));
    const keys = [];
    samples.forEach((s, i) => { if (s.key) keys.push(i + 1); });
    const stss = full('stss', 0, 0, u32(keys.length), ...keys.map(u32));
    const stsc = full('stsc', 0, 0, u32(1), u32(1), u32(samples.length), u32(1));
    const stsz = full('stsz', 0, 0, u32(0), u32(samples.length), ...samples.map((s) => u32(s.data.length)));

    // 中身の位置（stco）は moov の大きさに依るが、moov の大きさは位置の値に依らない（4バイト固定）。
    // 仮の0で一度組み、大きさが決まってから本物の値で組み直す。
    const build = (offset) => {
      const stco = full('stco', 0, 0, u32(1), u32(offset));
      const stbl = box('stbl', stsd, stts, stss, stsc, stsz, stco);
      const minf = box('minf', vmhd, dinf, stbl);
      const mdia = box('mdia', mdhd, hdlr, minf);
      const trak = box('trak', tkhd, mdia);
      return box('moov', mvhd, trak);
    };
    const moovSize = build(0).length;
    const dataBytes = samples.reduce((a, s) => a + s.data.length, 0);
    const moov = build(ftyp.length + moovSize + 8);

    const out = new Uint8Array(ftyp.length + moov.length + 8 + dataBytes);
    let at = 0;
    out.set(ftyp, at); at += ftyp.length;
    out.set(moov, at); at += moov.length;
    out.set(u32(8 + dataBytes), at); out.set(enc('mdat'), at + 4); at += 8;
    for (const s of samples) { out.set(s.data, at); at += s.data.length; }
    return out;
  }

  const api = { mux };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Mp4Mux = api;
})(typeof window !== 'undefined' ? window : this);
