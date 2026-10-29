// App Store Connect の「1.0 提出準備中」（日本語）に、store-screenshots/gohan-ashiato-1〜5.png を入れる。
// 「審査用に追加」「審査へ提出」はしない。すでに画像が入っていたら何も変えない（手で入れたものを消さないため）。
// 使い方: node scripts/upload-screenshots.mjs check|apply
// 環境変数: API_KEY_ID, API_ISSUER_ID, API_PRIVATE_KEY（.p8の中身）
// アップロードの手順は apps/day23-baydiary-ios/scripts/prepare-app-store-draft.mjs と同じ。
import {createHash} from 'node:crypto';
import {readFileSync, appendFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeToken} from './asc.mjs';

const mode = process.argv[2] === 'apply' ? 'apply' : 'check';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_ID = '6828318944';
const LOCALE = 'ja';
const DISPLAY_TYPE = 'APP_IPHONE_61'; // 6.1/6.3インチ（1179×2556）
const FILES = [1, 2, 3, 4, 5].map((i) => `store-screenshots/gohan-ashiato-${i}.png`);
const API = 'https://api.appstoreconnect.apple.com';

for (const n of ['API_KEY_ID', 'API_ISSUER_ID', 'API_PRIVATE_KEY']) {
  if (!(process.env[n] || '').trim()) throw new Error('Missing required secret: ' + n);
}
let token = '', tokenAt = 0;
async function request(path, options = {}) {
  if (!token || Date.now() - tokenAt > 10 * 60 * 1000) {
    token = makeToken(process.env.API_KEY_ID.trim(), process.env.API_ISSUER_ID.trim(), process.env.API_PRIVATE_KEY);
    tokenAt = Date.now();
  }
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    ...options,
    headers: {Authorization: `Bearer ${token}`, Accept: 'application/json', ...(options.body ? {'Content-Type': 'application/json'} : {})},
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`API ${res.status}: ${(data?.errors || []).map((e) => `${e.code}: ${e.detail}`).join('; ')}`);
  return data;
}
const get = (p) => request(p);
const post = (p, data) => request(p, {method: 'POST', body: JSON.stringify({data})});
const patch = (p, data) => request(p, {method: 'PATCH', body: JSON.stringify({data})});

const report = (lines) => {
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
};

const versions = (await get(`/v1/apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&limit=20`)).data;
const stateOf = (v) => v.attributes.appVersionState || v.attributes.appStoreState;
const version = versions.find((v) => stateOf(v) === 'PREPARE_FOR_SUBMISSION');
if (!version) throw new Error('「提出準備中」のバージョンが見つかりません：' + versions.map((v) => `${v.attributes.versionString}(${stateOf(v)})`).join(', '));
const loc = (await get(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)).data.find((l) => l.attributes.locale === LOCALE);
if (!loc) throw new Error(`バージョン ${version.attributes.versionString} に日本語（${LOCALE}）の欄がありません`);
const sets = (await get(`/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets`)).data;
let set = sets.find((s) => s.attributes.screenshotDisplayType === DISPLAY_TYPE);
const existing = set ? (await get(`/v1/appScreenshotSets/${set.id}/appScreenshots`)).data : [];
console.log(`バージョン ${version.attributes.versionString}／${DISPLAY_TYPE}：いま${existing.length}枚`);

if (mode === 'check') process.exit(0);
if (existing.length) {
  report([`## ごはんの足跡 スクリーンショット`, `- すでに${existing.length}枚入っているため変更なし`]);
  process.exit(0);
}
if (!set) {
  set = (await post('/v1/appScreenshotSets', {
    type: 'appScreenshotSets',
    attributes: {screenshotDisplayType: DISPLAY_TYPE},
    relationships: {appStoreVersionLocalization: {data: {type: 'appStoreVersionLocalizations', id: loc.id}}},
  })).data;
}
for (const file of FILES) {
  const bytes = readFileSync(join(root, file));
  const fileName = file.split('/').pop();
  const shot = (await post('/v1/appScreenshots', {
    type: 'appScreenshots',
    attributes: {fileName, fileSize: bytes.length},
    relationships: {appScreenshotSet: {data: {type: 'appScreenshotSets', id: set.id}}},
  })).data;
  for (const op of shot.attributes.uploadOperations) {
    const headers = Object.fromEntries((op.requestHeaders || []).map((h) => [h.name, h.value]));
    const res = await fetch(op.url, {method: op.method, headers, body: bytes.subarray(op.offset, op.offset + op.length)});
    if (!res.ok) throw new Error(`${fileName} のアップロードに失敗（${res.status}）`);
  }
  await patch(`/v1/appScreenshots/${shot.id}`, {
    type: 'appScreenshots', id: shot.id,
    attributes: {uploaded: true, sourceFileChecksum: createHash('md5').update(bytes).digest('hex')},
  });
  // Apple側の画像チェックが終わるのを待つ（サイズ違いなどはここで分かる）
  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) {
    const st = (await get(`/v1/appScreenshots/${shot.id}`)).data.attributes.assetDeliveryState;
    if (st?.state === 'COMPLETE') ok = true;
    else if (st?.state === 'FAILED') throw new Error(`${fileName}：${(st.errors || []).map((e) => e.description || e.code).join('; ') || 'Appleで処理に失敗'}`);
    else await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`✓ ${fileName}`);
}
report([`## ごはんの足跡 スクリーンショット`, `- ${DISPLAY_TYPE} に${FILES.length}枚をアップロード（「審査用に追加」はしていない）`]);
