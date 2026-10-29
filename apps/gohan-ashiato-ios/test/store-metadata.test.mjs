// App Store の申請に入力する中身（store-metadata.json）が、Appleの文字数の上限や画像のサイズに収まっているかを確かめる
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const meta = JSON.parse(await fs.readFile('store-metadata.json', 'utf8'));
const text = v => (Array.isArray(v) ? v.join('\n') : v);
const chars = s => [...s].length;

test('文字数の上限に収まる', () => {
  assert.ok(chars(meta.name) <= 30, '名前は30文字まで');
  assert.ok(chars(meta.subtitle) <= 30, 'サブタイトルは30文字まで');
  assert.ok(chars(meta.promotionalText) <= 170, 'プロモーション用テキストは170文字まで');
  assert.ok(chars(text(meta.description)) <= 4000, '説明文は4000文字まで');
  assert.ok(chars(text(meta.reviewNotes)) <= 4000, '審査メモは4000文字まで');
  assert.ok(Buffer.byteLength(meta.keywords) <= 100 || chars(meta.keywords) <= 100, 'キーワードは100文字まで');
  assert.doesNotMatch(meta.keywords, /\s/, 'キーワードはカンマ区切りで空白なし');
  assert.doesNotMatch(meta.keywords, /ごはんの足跡/, 'アプリ名はキーワードに入れなくてよい');
});

test('アプリの設定と食い違いがない', async () => {
  const cap = JSON.parse(await fs.readFile('capacitor.config.json', 'utf8'));
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
  assert.equal(meta.bundleId, cap.appId);
  assert.equal(meta.name, cap.appName);
  assert.equal(meta.versionString, pkg.version);
  for (const k of ['privacyPolicyUrl', 'supportUrl', 'marketingUrl']) assert.match(meta[k], /^https:\/\//, k);
  assert.match(meta.privacyPolicyUrl, /\/apps\/gohan-ashiato\/privacy\.html$/);
  await fs.access('../gohan-ashiato/privacy.html');
});

test('スクリーンショットは 6.5インチ（1284x2778）のPNG', async () => {
  const set = meta.screenshotSets.find(s => s.displayType === 'APP_IPHONE_65');
  assert.ok(set && set.screenshots.length >= 3 && set.screenshots.length <= 10);
  for (const file of set.screenshots) {
    const png = await fs.readFile(file);
    assert.equal(png.subarray(1, 4).toString(), 'PNG', file);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1284, 2778], file);
    assert.equal(png[25] & 4, 0, file + ' に透明（アルファ）がない');
  }
});
