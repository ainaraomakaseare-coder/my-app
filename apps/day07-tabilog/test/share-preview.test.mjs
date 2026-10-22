// 共有リンクの紹介カード（functions/_middleware.js の buildTripPreview）のテスト。
// 実行: node test/share-preview.test.mjs
import assert from 'node:assert/strict';
import { buildTripPreview } from '../functions/_middleware.js';

const p1 = buildTripPreview({ title: '沖縄家族旅行', startDate: '2026-06-27', endDate: '2026-06-29', coverPhotoId: 'photo_abc123' });
assert.equal(p1.title, '「沖縄家族旅行」の旅行が共有されました');
assert.equal(p1.description, '2026/6/27〜6/29（3日間）の旅の記録です。タップすると旅の足跡で見られます。');
assert.equal(p1.image, 'https://tabilog-api.hiroya-apps.workers.dev/photos/photo_abc123');

// 日帰り・カバー写真なし
const p2 = buildTripPreview({ title: '鎌倉', startDate: '2026-05-03', endDate: '2026-05-03', coverPhotoId: '' });
assert.equal(p2.description, '2026/5/3の旅の記録です。タップすると旅の足跡で見られます。');
assert.equal(p2.image, '');

// 年をまたぐ
const p3 = buildTripPreview({ title: '年越し', startDate: '2026-12-30', endDate: '2027-01-02' });
assert.equal(p3.description, '2026/12/30〜2027/1/2（4日間）の旅の記録です。タップすると旅の足跡で見られます。');

// 名前・日程が無い、写真IDが変な形
const p4 = buildTripPreview({ title: '  ', startDate: '', endDate: '', coverPhotoId: '../x' });
assert.equal(p4.title, '旅行が共有されました');
assert.equal(p4.description, '旅の記録です。タップすると旅の足跡で見られます。');
assert.equal(p4.image, '');

console.log('share-preview: all passed');
