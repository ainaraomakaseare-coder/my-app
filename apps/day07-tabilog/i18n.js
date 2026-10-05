/*
 * 多言語化（i18n）の土台。日本語が元の文章で、繁体字中国語（台湾）を追加で持つ。
 *
 *   I18N.lang          'ja' | 'zh-Hant'
 *   I18N.t(ja, vars)   日本語の文章を、いまの言語の文章にして返す。{key} は vars[key] に置き換える。
 *                      辞書に無ければ日本語のまま返す（常に文字列）。
 *   I18N.add(obj)      辞書（日本語→繁体字）に追加する。i18n/zh-Hant-*.js から呼ぶ。
 *   I18N.setLang(l)    言語を保存してページを再読み込みする。
 *   I18N.translateDom(root)  root以下のテキスト・placeholder・aria-label・title・alt・ボタンのvalueを辞書で置き換える。
 *
 * 読み込み順：i18n.js → i18n/zh-Hant-*.js → app.js。app.jsはI18Nが無くても（node のテストなど）日本語のまま動く。
 */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'tabilog.lang';

  function detectLang() {
    try {
      var saved = root.localStorage && root.localStorage.getItem(STORAGE_KEY);
      if (saved === 'ja' || saved === 'zh-Hant') return saved;
    } catch (e) { /* localStorageが使えない環境 */ }
    var nav = root.navigator || {};
    var langs = nav.languages && nav.languages.length ? nav.languages : [nav.language || ''];
    for (var i = 0; i < langs.length; i++) {
      if (/^zh-(TW|HK|MO|Hant)/i.test(langs[i] || '')) return 'zh-Hant';
    }
    return 'ja';
  }

  var I18N = {
    lang: detectLang(),
    dict: {},
    add: function (obj) {
      for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) I18N.dict[k] = obj[k];
    },
    t: function (ja, vars) {
      var s = String(ja);
      if (I18N.lang === 'zh-Hant' && Object.prototype.hasOwnProperty.call(I18N.dict, s)) s = I18N.dict[s];
      if (!vars) return s;
      return s.replace(/\{(\w+)\}/g, function (m, k) {
        return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
      });
    },
    setLang: function (l) {
      try { root.localStorage.setItem(STORAGE_KEY, l === 'zh-Hant' ? 'zh-Hant' : 'ja'); } catch (e) { /* 保存できなくても再読み込みはする */ }
      if (root.location) root.location.reload();
    },
    translateDom: translateDom
  };

  // 空白（改行・インデント）をひとつの半角スペースにして、前後を落としたもの（辞書の鍵の形）
  function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }
  function lookup(s) {
    var k = norm(s);
    if (!k) return null;
    return Object.prototype.hasOwnProperty.call(I18N.dict, k) ? I18N.dict[k] : null;
  }

  var ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1 };

  function translateElementAttrs(el) {
    var i, v, tr;
    for (i = 0; i < ATTRS.length; i++) {
      v = el.getAttribute(ATTRS[i]);
      if (v) { tr = lookup(v); if (tr !== null) el.setAttribute(ATTRS[i], tr); }
    }
    var tag = el.tagName;
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'BUTTON' || (tag === 'INPUT' && (type === 'button' || type === 'submit'))) {
      v = el.getAttribute('value');
      if (v) { tr = lookup(v); if (tr !== null) el.setAttribute('value', tr); }
    }
  }

  function translateDom(rootNode) {
    if (I18N.lang !== 'zh-Hant') return;
    var doc = root.document;
    if (!doc) return;
    rootNode = rootNode || doc.body || doc.documentElement;
    if (!rootNode) return;

    // 要素の属性（rootNode自身を含む）
    if (rootNode.nodeType === 1 && !SKIP_TAGS[rootNode.tagName]) translateElementAttrs(rootNode);
    var els = rootNode.querySelectorAll ? rootNode.querySelectorAll('[placeholder],[aria-label],[title],[alt],button[value],input[type=button],input[type=submit]') : [];
    for (var i = 0; i < els.length; i++) translateElementAttrs(els[i]);

    // テキストノード
    var nodes = [];
    if (rootNode.nodeType === 3) {
      nodes.push(rootNode);
    } else {
      var walker = doc.createTreeWalker(rootNode, 4 /* NodeFilter.SHOW_TEXT */, null, false);
      var n;
      while ((n = walker.nextNode())) {
        var p = n.parentNode;
        if (p && SKIP_TAGS[p.tagName]) continue;
        nodes.push(n);
      }
    }
    nodes.forEach(function (node) {
      var raw = node.nodeValue;
      var tr = lookup(raw);
      if (tr === null) return;
      var lead = /^\s*/.exec(raw)[0], trail = /\s*$/.exec(raw)[0];
      node.nodeValue = lead + tr + trail;
    });
  }

  function translatePageMeta() {
    var doc = root.document;
    if (!doc || I18N.lang !== 'zh-Hant') return;
    var meta = doc.querySelector('meta[name="description"]');
    if (meta) { var d = lookup(meta.getAttribute('content') || ''); if (d !== null) meta.setAttribute('content', d); }
    var tt = lookup(doc.title || '');
    if (tt !== null) doc.title = tt;
  }

  root.I18N = I18N;
  if (root.document) {
    root.document.documentElement.lang = I18N.lang === 'zh-Hant' ? 'zh-Hant' : 'ja';
    root.document.addEventListener('DOMContentLoaded', function () {
      translateDom(root.document.body);
      translatePageMeta();
    });
  }
})(typeof window !== 'undefined' ? window : this);
