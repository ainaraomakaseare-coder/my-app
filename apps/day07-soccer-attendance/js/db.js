// Supabase との通信。ライブラリは使わず、素の fetch だけで書いています。
//
// このアプリはテーブルを直接触りません。db/schema.sql で作った「関数」だけを呼びます。
// 呼び先は  <プロジェクトURL>/rest/v1/rpc/<関数名>  です。
//
// 接続先は index.html / admin.html の <meta> タグから読みます。
// publishable キーはブラウザに配る前提のキーなので、ここに書いて公開して構いません。
// 守っているのはキーの秘密ではなく、データベース側の RLS と、
// 関数の中でトークンを確かめている処理の方です（README 参照）。

(function () {
  function meta(name) {
    var el = document.querySelector('meta[name="' + name + '"]');
    return el ? String(el.getAttribute('content') || '').trim() : '';
  }

  // Supabase の管理画面は URL を https://xxxx.supabase.co/rest/v1/ の形で見せる。
  // このアプリは /rest/v1/rpc/... を自分で付けるため、付いていたら外す。
  function tidy(u) {
    return String(u || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  }

  // テストから差し替えられるように、window.APP_CONFIG があればそちらを優先する。
  var override = window.APP_CONFIG || {};

  var cfg = {
    url: tidy(override.SUPABASE_URL || meta('soccer-supabase-url')),
    key: override.SUPABASE_ANON_KEY || meta('soccer-supabase-key'),
  };

  window.DB = {
    ready: function () {
      return Boolean(cfg.url && cfg.key);
    },

    async rpc(fn, args) {
      if (!this.ready()) {
        throw new Error(
          '接続先が設定されていません。index.html と admin.html の ' +
          'soccer-supabase-url / soccer-supabase-key の meta タグを埋めてください。'
        );
      }

      let res;
      try {
        res = await fetch(cfg.url + '/rest/v1/rpc/' + fn, {
          method: 'POST',
          headers: {
            apikey: cfg.key,
            Authorization: 'Bearer ' + cfg.key,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(args || {}),
        });
      } catch (e) {
        throw new Error('データベースに繋がりませんでした。通信環境を確認してください。');
      }

      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch (e) { /* JSONでない */ }

      if (!res.ok) {
        const msg = (body && (body.message || body.hint || body.details)) || text || ('HTTP ' + res.status);
        throw new Error(msg);
      }
      return body;
    },
  };
})();
