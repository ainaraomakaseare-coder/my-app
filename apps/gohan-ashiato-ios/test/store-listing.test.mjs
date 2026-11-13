// App Store に入れる文面（store-listing.json）が Apple の上限に収まり、スクリーンショットが 6.1/6.3インチのPNGか確かめる
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const listing = JSON.parse(await fs.readFile(new URL('../store-listing.json', import.meta.url), 'utf8'));
const chars = (s) => [...s].length;

test('文字数の上限に収まる', () => {
  assert.ok(chars(listing.promotionalText) <= 170, 'プロモーション用テキストは170文字まで');
  assert.ok(chars(listing.description.join('\n')) <= 4000, '説明文は4000文字まで');
  assert.ok(chars(listing.keywords) <= 100, 'キーワードは100文字まで');
  assert.doesNotMatch(listing.keywords, /\s/, 'キーワードはカンマ区切りで空白なし');
  // Appleが受け付けない記号（2026-10-31、★で 409 INVALID_CHARACTERS）
  for (const t of [listing.description.join('\n'), listing.promotionalText, listing.keywords]) assert.doesNotMatch(t, /[★☆]/);
  assert.match(listing.versionString, /^\d+\.\d+(\.\d+)?$/);
});

test('スクリーンショットは 6.1/6.3インチ（1179x2556）のPNG、3〜10枚', async () => {
  const {displayType, files} = listing.screenshots;
  assert.equal(displayType, 'APP_IPHONE_61');
  assert.ok(files.length >= 3 && files.length <= 10);
  for (const file of files) {
    const png = await fs.readFile(new URL('../' + file, import.meta.url));
    assert.equal(png.subarray(1, 4).toString(), 'PNG', file);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1179, 2556], file);
    assert.equal(png[25] & 4, 0, file + ' に透明（アルファ）がない');
  }
});
