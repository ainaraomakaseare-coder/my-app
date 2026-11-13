// App Store Connect の提出前のバージョン（日本語）に、store-listing.json の説明文・プロモーション用テキスト・キーワードと
// スクリーンショットを入れ、TestFlightの一番新しいビルドを選ぶ。「審査用に追加」「審査へ提出」はしない。
// 却下されたあと（REJECTED など）のバージョンも対象。同じ内容なら何も変えないので、何度動かしてもよい。
// スクリーンショットは、入っている画像と中身（MD5）が違えば全部入れ替える。
// 使い方: node scripts/update-store-listing.mjs check|apply
// 環境変数: API_KEY_ID, API_ISSUER_ID, API_PRIVATE_KEY（.p8の中身）
import {createHash} from 'node:crypto';
import {readFileSync, appendFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeToken} from './asc.mjs';

const mode = process.argv[2] === 'apply' ? 'apply' : 'check';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const listing = JSON.parse(readFileSync(join(root, 'store-listing.json'), 'utf8'));
// App Storeのバージョンは store-listing.json の versionString（例 1.0）、ビルドのバージョンは package.json の version（例 1.0.0）
const buildVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const APP_ID = '6828318944';
const API = 'https://api.appstoreconnect.apple.com';
// 文面・画像・ビルドを変えられるバージョンの状態
const EDITABLE = ['PREPARE_FOR_SUBMISSION', 'REJECTED', 'METADATA_REJECTED', 'DEVELOPER_REJECTED', 'INVALID_BINARY'];

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
const del = (p) => request(p, {method: 'DELETE'});

const lines = [`## ごはんの足跡 App Store の掲載内容（${mode}）`];
const say = (s) => { lines.push('- ' + s); console.log(s); };
const done = () => {
  lines.push('- 「審査用に追加」「審査へ提出」はしていません');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  // Actionsの画面のまとめ（annotation）にも出す
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=ごはんの足跡 掲載内容（${mode}）::` + lines.slice(1).join('%0A'));
};

// 1. バージョン
const versions = (await get(`/v1/apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&limit=20`)).data;
const stateOf = (v) => v.attributes.appVersionState || v.attributes.appStoreState;
const version = versions.find((v) => v.attributes.versionString === listing.versionString && EDITABLE.includes(stateOf(v)));
if (!version) throw new Error(`変更できる ${listing.versionString} が見つかりません：` + versions.map((v) => `${v.attributes.versionString}(${stateOf(v)})`).join(', '));
say(`バージョン ${listing.versionString}：${stateOf(version)}`);

// 2. 説明文・プロモーション用テキスト・キーワード
const loc = (await get(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)).data.find((l) => l.attributes.locale === listing.locale);
if (!loc) throw new Error(`バージョン ${listing.versionString} に ${listing.locale} の欄がありません`);
const want = {description: listing.description.join('\n'), promotionalText: listing.promotionalText, keywords: listing.keywords};
const changed = Object.keys(want).filter((k) => (loc.attributes[k] || '') !== want[k]);
if (!changed.length) say('説明文・プロモーション用テキスト・キーワード：変更なし');
else {
  say(`変える欄：${changed.join(', ')}`);
  if (mode === 'apply') await patch(`/v1/appStoreVersionLocalizations/${loc.id}`, {type: 'appStoreVersionLocalizations', id: loc.id, attributes: want});
}

// 3. スクリーンショット
const {displayType, files} = listing.screenshots;
const images = files.map((file) => {
  const bytes = readFileSync(join(root, file));
  return {file, fileName: file.split('/').pop(), bytes, md5: createHash('md5').update(bytes).digest('hex')};
});
let set = (await get(`/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets`)).data.find((s) => s.attributes.screenshotDisplayType === displayType);
const existing = set ? (await get(`/v1/appScreenshotSets/${set.id}/appScreenshots`)).data : [];
const same = existing.length === images.length && existing.every((s, i) => s.attributes.sourceFileChecksum === images[i].md5);
if (same) say(`スクリーンショット（${displayType}）：${existing.length}枚、変更なし`);
else {
  say(`スクリーンショット（${displayType}）：いま${existing.length}枚 → ${images.length}枚に入れ替え`);
  if (mode === 'apply') {
    for (const s of existing) await del(`/v1/appScreenshots/${s.id}`);
    if (!set) {
      set = (await post('/v1/appScreenshotSets', {
        type: 'appScreenshotSets',
        attributes: {screenshotDisplayType: displayType},
        relationships: {appStoreVersionLocalization: {data: {type: 'appStoreVersionLocalizations', id: loc.id}}},
      })).data;
    }
    for (const img of images) {
      const shot = (await post('/v1/appScreenshots', {
        type: 'appScreenshots',
        attributes: {fileName: img.fileName, fileSize: img.bytes.length},
        relationships: {appScreenshotSet: {data: {type: 'appScreenshotSets', id: set.id}}},
      })).data;
      for (const op of shot.attributes.uploadOperations) {
        const headers = Object.fromEntries((op.requestHeaders || []).map((h) => [h.name, h.value]));
        const res = await fetch(op.url, {method: op.method, headers, body: img.bytes.subarray(op.offset, op.offset + op.length)});
        if (!res.ok) throw new Error(`${img.fileName} のアップロードに失敗（${res.status}）`);
      }
      await patch(`/v1/appScreenshots/${shot.id}`, {type: 'appScreenshots', id: shot.id, attributes: {uploaded: true, sourceFileChecksum: img.md5}});
      // Apple側の画像チェックが終わるのを待つ（サイズ違いなどはここで分かる）
      let ok = false;
      for (let i = 0; i < 30 && !ok; i++) {
        const st = (await get(`/v1/appScreenshots/${shot.id}`)).data.attributes.assetDeliveryState;
        if (st?.state === 'COMPLETE') ok = true;
        else if (st?.state === 'FAILED') throw new Error(`${img.fileName}：${(st.errors || []).map((e) => e.description || e.code).join('; ') || 'Appleで処理に失敗'}`);
        else await new Promise((r) => setTimeout(r, 2000));
      }
      console.log(`✓ ${img.fileName}`);
    }
  }
}

// 4. ビルド：TestFlightで処理が終わった（VALID）一番新しいもの
const builds = (await get(`/v1/builds?filter[app]=${APP_ID}&filter[preReleaseVersion.version]=${buildVersion}&filter[processingState]=VALID&sort=-uploadedDate&limit=1`)).data;
if (!builds.length) throw new Error(`${buildVersion} の使えるビルドがTestFlightにありません`);
const latest = builds[0];
const current = (await get(`/v1/appStoreVersions/${version.id}/build`)).data;
if (current?.id === latest.id) say(`ビルド：${latest.attributes.version}、変更なし`);
else {
  say(`ビルド：${current ? current.attributes.version : 'なし'} → ${latest.attributes.version}`);
  if (mode === 'apply') await patch(`/v1/appStoreVersions/${version.id}/relationships/build`, {type: 'builds', id: latest.id});
}
done();
