// 同梱するWeb版の中身と、アプリの設定を確かめる（npm test が先に npm run build する）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

test('Web版の決まったファイルと橋渡しだけを同梱する', async () => {
  assert.deepEqual((await fs.readdir('www')).sort(), ['app.js', 'core.js', 'icon-180.png', 'icon-512.png', 'index.html', 'native.js', 'privacy.html', 'style.css', 'tv-shops.json', 'vendor']);
  assert.deepEqual((await fs.readdir('www/vendor/leaflet')).sort(), ['LICENSE', 'leaflet.css', 'leaflet.js']);
  const html = await fs.readFile('www/index.html', 'utf8');
  assert.ok(html.indexOf('src="native.js"') < html.indexOf('src="core.js"'), 'native.js は core.js より前');
  assert.ok(html.indexOf('src="core.js"') < html.indexOf('src="app.js"'));
  assert.doesNotMatch(html, /rel="manifest"/);
  assert.match(html, /viewport-fit=cover/);
  for (const f of ['app.js', 'core.js', 'native.js']) new vm.Script(await fs.readFile('www/' + f, 'utf8'));
});

test('ローカルのサーバーを使わず、同梱したファイルだけで動く設定', async () => {
  const c = JSON.parse(await fs.readFile('capacitor.config.json', 'utf8'));
  assert.equal(c.appId, 'com.hiroyaapps.gohanashiato');
  assert.equal(c.appName, 'ごはんの足跡');
  assert.equal(c.webDir, 'www');
  assert.equal(c.server, undefined);
  assert.equal(c.ios.contentInset, 'never');
});
