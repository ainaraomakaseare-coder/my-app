/* 最小限のQRコード生成器（バイトモード / 誤り訂正レベルL / バージョン1〜20）
   外部ライブラリを使わずに済ませるために自前で実装している。
   参加者に役職を配るとき、URLをQRにして各自のスマホのカメラで読んでもらう。 */
(function (global) {
  'use strict';

  // ---- GF(256) の掛け算表。リード・ソロモン符号の計算に使う ----
  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function mul(a, b) {
    return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
  }

  function genPoly(degree) {
    var p = [1];
    for (var i = 0; i < degree; i++) {
      var np = new Array(p.length + 1);
      for (var k = 0; k < np.length; k++) np[k] = 0;
      for (var j = 0; j < p.length; j++) {
        np[j] ^= p[j];
        np[j + 1] ^= mul(p[j], EXP[i]);
      }
      p = np;
    }
    return p;
  }

  function rsEncode(data, ecLen) {
    var gen = genPoly(ecLen);
    var buf = new Uint8Array(data.length + ecLen);
    buf.set(data);
    for (var i = 0; i < data.length; i++) {
      var factor = buf[i];
      if (factor !== 0) {
        for (var j = 0; j < gen.length; j++) buf[i + j] ^= mul(gen[j], factor);
      }
    }
    return buf.slice(data.length);
  }

  // ---- バージョンごとの構成（誤り訂正レベルL）----
  // [1ブロックあたりの誤り訂正語数, グループ1のブロック数, その語数, グループ2のブロック数, その語数]
  var SPEC = {
    1:  [7,  1, 19,  0, 0],
    2:  [10, 1, 34,  0, 0],
    3:  [15, 1, 55,  0, 0],
    4:  [20, 1, 80,  0, 0],
    5:  [26, 1, 108, 0, 0],
    6:  [18, 2, 68,  0, 0],
    7:  [20, 2, 78,  0, 0],
    8:  [24, 2, 97,  0, 0],
    9:  [30, 2, 116, 0, 0],
    10: [18, 2, 68,  2, 69],
    11: [20, 4, 81,  0, 0],
    12: [24, 2, 92,  2, 93],
    13: [26, 4, 107, 0, 0],
    14: [30, 3, 115, 1, 116],
    15: [22, 5, 87,  1, 88],
    16: [24, 5, 98,  1, 99],
    17: [28, 1, 107, 5, 108],
    18: [30, 5, 120, 1, 121],
    19: [28, 3, 113, 4, 114],
    20: [28, 3, 107, 5, 108]
  };

  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66],
    15: [6, 26, 48, 70], 16: [6, 26, 50, 74], 17: [6, 30, 54, 78],
    18: [6, 30, 56, 82], 19: [6, 30, 58, 86], 20: [6, 34, 62, 90]
  };

  function dataCapacity(version) {
    var s = SPEC[version];
    return s[1] * s[2] + s[3] * s[4];
  }

  // ---- ビット列を組み立てる ----
  function BitBuffer() {
    this.bits = [];
  }
  BitBuffer.prototype.put = function (value, length) {
    for (var i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };

  function buildData(bytes, version) {
    var buf = new BitBuffer();
    buf.put(4, 4); // バイトモード
    buf.put(bytes.length, version < 10 ? 8 : 16);
    for (var i = 0; i < bytes.length; i++) buf.put(bytes[i], 8);

    var capacityBits = dataCapacity(version) * 8;
    // 終端子
    var terminator = Math.min(4, capacityBits - buf.bits.length);
    for (var t = 0; t < terminator; t++) buf.bits.push(0);
    // バイト境界まで詰める
    while (buf.bits.length % 8 !== 0) buf.bits.push(0);

    var out = new Uint8Array(dataCapacity(version));
    for (var b = 0; b < buf.bits.length; b += 8) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | buf.bits[b + k];
      out[b / 8] = v;
    }
    // 埋め草
    var pad = [0xec, 0x11];
    for (var p = buf.bits.length / 8, n = 0; p < out.length; p++, n++) {
      out[p] = pad[n % 2];
    }
    return out;
  }

  function interleave(data, version) {
    var s = SPEC[version];
    var ecLen = s[0];
    var blocks = [];
    var offset = 0;
    var g;
    for (g = 0; g < s[1]; g++) {
      blocks.push(data.slice(offset, offset + s[2]));
      offset += s[2];
    }
    for (g = 0; g < s[3]; g++) {
      blocks.push(data.slice(offset, offset + s[4]));
      offset += s[4];
    }
    var ecBlocks = blocks.map(function (blk) {
      return rsEncode(blk, ecLen);
    });

    var result = [];
    var maxData = Math.max(s[2], s[4]);
    var i, j;
    for (i = 0; i < maxData; i++) {
      for (j = 0; j < blocks.length; j++) {
        if (i < blocks[j].length) result.push(blocks[j][i]);
      }
    }
    for (i = 0; i < ecLen; i++) {
      for (j = 0; j < ecBlocks.length; j++) result.push(ecBlocks[j][i]);
    }
    return result;
  }

  // ---- матрица（モジュール配置）----
  function createMatrix(version) {
    var size = version * 4 + 17;
    var m = [];
    var reserved = [];
    for (var r = 0; r < size; r++) {
      m.push(new Array(size).fill(null));
      reserved.push(new Array(size).fill(false));
    }

    function setFn(r, c, v) {
      m[r][c] = v;
      reserved[r][c] = true;
    }

    // 位置検出パターン（3隅）
    function finder(row, col) {
      for (var dr = -1; dr <= 7; dr++) {
        for (var dc = -1; dc <= 7; dc++) {
          var rr = row + dr, cc = col + dc;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          var inRing =
            (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
            (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
          var inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          setFn(rr, cc, inRing || inCore ? 1 : 0);
        }
      }
    }
    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);

    // タイミングパターン
    for (var i = 8; i < size - 8; i++) {
      setFn(6, i, i % 2 === 0 ? 1 : 0);
      setFn(i, 6, i % 2 === 0 ? 1 : 0);
    }

    // 位置合わせパターン
    var centers = ALIGN[version];
    var lastCenter = centers.length - 1;
    for (var a = 0; a < centers.length; a++) {
      for (var b = 0; b < centers.length; b++) {
        // 位置検出パターンと重なる3隅にだけは置かない。
        // タイミングパターン上に中心が来る場合は「置く」のが正しい（上書きしてよい）。
        if ((a === 0 && b === 0) ||
            (a === 0 && b === lastCenter) ||
            (a === lastCenter && b === 0)) continue;
        var cr = centers[a], cc2 = centers[b];
        for (var dr2 = -2; dr2 <= 2; dr2++) {
          for (var dc2 = -2; dc2 <= 2; dc2++) {
            var on = Math.max(Math.abs(dr2), Math.abs(dc2)) !== 1;
            setFn(cr + dr2, cc2 + dc2, on ? 1 : 0);
          }
        }
      }
    }

    // 常に黒のモジュール
    setFn(size - 8, 8, 1);

    // 形式情報の場所を予約
    for (var k = 0; k < 9; k++) {
      if (!reserved[8][k]) { m[8][k] = 0; reserved[8][k] = true; }
      if (!reserved[k][8]) { m[k][8] = 0; reserved[k][8] = true; }
    }
    for (var k2 = 0; k2 < 8; k2++) {
      if (!reserved[8][size - 1 - k2]) { m[8][size - 1 - k2] = 0; reserved[8][size - 1 - k2] = true; }
      if (!reserved[size - 1 - k2][8]) { m[size - 1 - k2][8] = 0; reserved[size - 1 - k2][8] = true; }
    }

    // バージョン情報（7以上）
    if (version >= 7) {
      var vinfo = versionBits(version);
      for (var p = 0; p < 18; p++) {
        var bit = (vinfo >> p) & 1;
        var rr2 = Math.floor(p / 3);
        var cc3 = p % 3;
        setFn(rr2, size - 11 + cc3, bit);
        setFn(size - 11 + cc3, rr2, bit);
      }
    }

    return { modules: m, reserved: reserved, size: size };
  }

  function versionBits(version) {
    var v = version << 12;
    for (var i = 0; i < 6; i++) {
      if ((v >> (17 - i)) & 1) v ^= 0x1f25 << (5 - i);
    }
    return (version << 12) | v;
  }

  function formatBits(maskPattern) {
    // 誤り訂正レベル L のビットは 01
    var data = (0x01 << 3) | maskPattern;
    var v = data << 10;
    for (var i = 0; i < 5; i++) {
      if ((v >> (14 - i)) & 1) v ^= 0x537 << (4 - i);
    }
    return ((data << 10) | v) ^ 0x5412;
  }

  function maskFn(pattern, r, c) {
    switch (pattern) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
    return false;
  }

  function placeData(grid, codewords) {
    var m = grid.modules, reserved = grid.reserved, size = grid.size;
    var bitIndex = 0;
    var totalBits = codewords.length * 8;
    var upward = true;

    for (var right = size - 1; right > 0; right -= 2) {
      if (right === 6) right = 5; // タイミングパターンの列は飛ばす
      for (var step = 0; step < size; step++) {
        var row = upward ? size - 1 - step : step;
        for (var pair = 0; pair < 2; pair++) {
          var col = right - pair;
          if (reserved[row][col]) continue;
          var bit = 0;
          if (bitIndex < totalBits) {
            bit = (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
            bitIndex++;
          }
          m[row][col] = bit;
        }
      }
      upward = !upward;
    }
  }

  function applyMaskAndFormat(grid, pattern) {
    var size = grid.size;
    var out = [];
    for (var r = 0; r < size; r++) out.push(grid.modules[r].slice());

    for (r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (!grid.reserved[r][c] && maskFn(pattern, r, c)) out[r][c] ^= 1;
      }
    }

    var fmt = formatBits(pattern);
    for (var i = 0; i < 15; i++) {
      var bit = (fmt >> i) & 1;
      // 左上
      if (i < 6) out[8][i] = bit;
      else if (i === 6) out[8][7] = bit;
      else if (i === 7) out[8][8] = bit;
      else if (i === 8) out[7][8] = bit;
      else out[14 - i][8] = bit;
      // 右上・左下
      if (i < 8) out[8][size - 1 - i] = bit;
      else out[size - 15 + i][8] = bit;
    }
    out[size - 8][8] = 1;
    return out;
  }

  function penalty(m) {
    var size = m.length;
    var score = 0;
    var r, c, run, i;

    // 規則1：同色の連続
    for (r = 0; r < size; r++) {
      run = 1;
      for (c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) { run++; }
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (c = 0; c < size; c++) {
      run = 1;
      for (r = 1; r < size; r++) {
        if (m[r][c] === m[r - 1][c]) { run++; }
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }

    // 規則2：2x2の同色ブロック
    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        var v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }

    // 規則3：位置検出パターンに似た並び
    var pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    var pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function matches(arr, start, pat) {
      for (var k = 0; k < 11; k++) if (arr[start + k] !== pat[k]) return false;
      return true;
    }
    for (r = 0; r < size; r++) {
      for (c = 0; c + 11 <= size; c++) {
        if (matches(m[r], c, pat1) || matches(m[r], c, pat2)) score += 40;
      }
    }
    for (c = 0; c < size; c++) {
      var col = [];
      for (r = 0; r < size; r++) col.push(m[r][c]);
      for (r = 0; r + 11 <= size; r++) {
        if (matches(col, r, pat1) || matches(col, r, pat2)) score += 40;
      }
    }

    // 規則4：黒の比率
    var dark = 0;
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) dark += m[r][c];
    var ratio = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

    return score;
  }

  function encodeUtf8(str) {
    var out = [];
    var encoded = unescape(encodeURIComponent(str));
    for (var i = 0; i < encoded.length; i++) out.push(encoded.charCodeAt(i));
    return out;
  }

  /* 文字列をQRのモジュール配列（0/1の二次元配列）にする */
  function encode(text) {
    var bytes = encodeUtf8(text);
    var version = 0;
    for (var v = 1; v <= 20; v++) {
      var header = 4 + (v < 10 ? 8 : 16);
      if (bytes.length * 8 + header <= dataCapacity(v) * 8) { version = v; break; }
    }
    if (!version) throw new Error('データが長すぎてQRコードに入りません（' + bytes.length + 'バイト）');

    var data = buildData(bytes, version);
    var codewords = interleave(data, version);
    var grid = createMatrix(version);
    placeData(grid, codewords);

    var best = null, bestScore = Infinity;
    for (var p = 0; p < 8; p++) {
      var candidate = applyMaskAndFormat(grid, p);
      var s = penalty(candidate);
      if (s < bestScore) { bestScore = s; best = candidate; }
    }
    return best;
  }

  /* モジュール配列をSVG文字列にする */
  function toSvg(modules, options) {
    options = options || {};
    var quiet = options.quiet == null ? 4 : options.quiet;
    var size = modules.length;
    var total = size + quiet * 2;
    var dark = options.dark || '#000000';
    var light = options.light || '#ffffff';

    var path = '';
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (modules[r][c]) {
          path += 'M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z';
        }
      }
    }
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total +
      '" shape-rendering="crispEdges" width="100%" height="100%">' +
      '<rect width="' + total + '" height="' + total + '" fill="' + light + '"/>' +
      '<path d="' + path + '" fill="' + dark + '"/></svg>'
    );
  }

  global.QR = { encode: encode, toSvg: toSvg };
})(window);
