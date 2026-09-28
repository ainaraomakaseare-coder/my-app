// App Store Connect に、観戦日記の申請の下書きを入力する（apps/day18-omoide-wiki-ios の同名スクリプトを流用）。
// 「審査へ提出」は押さない（最後の確認と提出は人がやる）。
//
// 使い方: node prepare-app-store-draft.mjs check   … いまの状態を読むだけ（何も書き換えない）
//         node prepare-app-store-draft.mjs apply   … 下書きを入力する
// 入力する中身は ../store-metadata.json。何度実行しても同じ結果になるように作ってある。
//
// API では入力できないもの（「Appのプライバシー」、価格と配信地域、審査の連絡先）は、
// 最後に「手で入力するもの」として表示する。
import {createHash, createPrivateKey, sign} from 'node:crypto';
import {readFileSync, appendFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const mode = process.argv[2] === 'apply' ? 'apply' : 'check';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const meta = JSON.parse(readFileSync(join(root, 'store-metadata.json'), 'utf8'));
const API = 'https://api.appstoreconnect.apple.com';

const keyId = process.env.APP_STORE_CONNECT_API_KEY_ID;
const issuerId = process.env.APP_STORE_CONNECT_API_ISSUER_ID;
const privateKey = process.env.APP_STORE_CONNECT_API_PRIVATE_KEY;
if (!keyId || !issuerId || !privateKey) {
  throw new Error('App Store Connect API credentials are not configured.');
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function createToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({alg: 'ES256', kid: keyId, typ: 'JWT'}));
  const payload = base64url(JSON.stringify({iss: issuerId, iat: now, exp: now + 900, aud: 'appstoreconnect-v1'}));
  const message = `${header}.${payload}`;
  const signature = sign('sha256', Buffer.from(message), {
    key: createPrivateKey(privateKey),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${message}.${signature}`;
}

// トークンは15分で切れるので、10分ごとに作り直す
let token = createToken();
let tokenAt = Date.now();

async function request(path, options = {}) {
  if (Date.now() - tokenAt > 10 * 60 * 1000) {
    token = createToken();
    tokenAt = Date.now();
  }
  const response = await fetch(path.startsWith('http') ? path : API + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body ? {'Content-Type': 'application/json'} : {}),
      ...options.headers,
    },
  });
  if (response.status === 204) return null;
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const details = data?.errors?.map((e) => `${e.code}: ${e.detail}`).join('; ');
    const error = new Error(`API ${response.status}${details ? `: ${details}` : ''}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const get = (path) => request(path);
const post = (path, data, included) => request(path, {method: 'POST', body: JSON.stringify(included ? {data, included} : {data})});
const patch = (path, data) => request(path, {method: 'PATCH', body: JSON.stringify({data})});

const done = [];
const failed = [];
const manual = [];

// 1つの手順が失敗しても、関係のない残りの手順は続ける
async function step(label, fn) {
  try {
    const note = await fn();
    done.push(`${label}${note ? `：${note}` : ''}`);
    console.log(`✓ ${label}${note ? `：${note}` : ''}`);
  } catch (e) {
    failed.push(`${label}：${e.message}`);
    console.log(`✗ ${label}：${e.message}`);
  }
}

const appId = meta.appId;
const locale = meta.locale;
const joinLines = (v) => (Array.isArray(v) ? v.join('\n') : v);

// ---------- いまの状態を読む ----------
const app = (await get(`/v1/apps/${appId}`)).data;
console.log(`アプリ：${app.attributes.name}（${app.attributes.bundleId}）主言語=${app.attributes.primaryLocale}`);

const versions = (await get(`/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=20`)).data;
const EDITABLE = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'];
const stateOf = (v) => v.attributes.appVersionState || v.attributes.appStoreState;
for (const v of versions) console.log(`バージョン：${v.attributes.versionString}（${stateOf(v)}）`);
let version = versions.find((v) => EDITABLE.includes(stateOf(v)));

const appInfos = (await get(`/v1/apps/${appId}/appInfos`)).data;
const infoStateOf = (i) => i.attributes.state || i.attributes.appStoreState;
for (const i of appInfos) console.log(`App情報：${i.id}（${infoStateOf(i)}）`);
const appInfo = appInfos.find((i) => !['READY_FOR_DISTRIBUTION', 'READY_FOR_SALE', 'REPLACED_WITH_NEW_INFO'].includes(infoStateOf(i))) || appInfos[0];

const buildsRes = await get(`/v1/builds?filter[app]=${appId}&filter[expired]=false&sort=-uploadedDate&limit=10&include=preReleaseVersion`);
const preRelease = Object.fromEntries((buildsRes.included || []).filter((x) => x.type === 'preReleaseVersions').map((x) => [x.id, x.attributes.version]));
const builds = buildsRes.data.map((b) => ({
  id: b.id,
  number: Number(b.attributes.version),
  state: b.attributes.processingState,
  marketing: preRelease[b.relationships?.preReleaseVersion?.data?.id] || '?',
}));
for (const b of builds) console.log(`ビルド：${b.marketing} (${b.number}) ${b.state}`);
const build = builds.find((b) => b.state === 'VALID' && b.number >= meta.minBuildNumber);

if (mode === 'check') {
  if (version) {
    const locs = (await get(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)).data;
    console.log(`編集できるバージョンの言語：${locs.map((l) => l.attributes.locale).join(', ') || 'なし'}`);
    for (const l of locs) {
      const sets = (await get(`/v1/appStoreVersionLocalizations/${l.id}/appScreenshotSets?include=appScreenshots`)).data;
      for (const s of sets) console.log(`  スクリーンショット ${l.attributes.locale} ${s.attributes.screenshotDisplayType}：${s.relationships?.appScreenshots?.data?.length ?? '?'}枚`);
    }
  } else {
    console.log('編集できるバージョンがありません（apply で作ります）');
  }
  if (appInfo) {
    const age = (await get(`/v1/appInfos/${appInfo.id}/ageRatingDeclaration`)).data;
    console.log(`年齢制限の項目：${Object.keys(age?.attributes || {}).join(', ')}`);
  }
  console.log(build ? `申請に使うビルド：${build.marketing} (${build.number})` : `ビルド(${meta.minBuildNumber})以降で処理済みのものがまだありません`);
  process.exit(0);
}

// ---------- ここから入力 ----------
await step('バージョンを用意', async () => {
  if (!version) {
    version = (await post('/v1/appStoreVersions', {
      type: 'appStoreVersions',
      attributes: {platform: 'IOS', versionString: meta.versionString},
      relationships: {app: {data: {type: 'apps', id: appId}}},
    })).data;
    return `${meta.versionString} を新しく作成`;
  }
  if (version.attributes.versionString !== meta.versionString) {
    const before = version.attributes.versionString;
    await patch(`/v1/appStoreVersions/${version.id}`, {type: 'appStoreVersions', id: version.id, attributes: {versionString: meta.versionString}});
    return `${before} → ${meta.versionString}（ビルドの番号に合わせた）`;
  }
  return `${meta.versionString}（入力済み）`;
});

await step('App情報の言語（名前・サブタイトル・プライバシーポリシーURL）', async () => {
  const attrs = {name: meta.name, subtitle: meta.subtitle, privacyPolicyUrl: meta.privacyPolicyUrl};
  const locs = (await get(`/v1/appInfos/${appInfo.id}/appInfoLocalizations`)).data;
  const loc = locs.find((l) => l.attributes.locale === locale);
  if (loc) {
    await patch(`/v1/appInfoLocalizations/${loc.id}`, {type: 'appInfoLocalizations', id: loc.id, attributes: attrs});
    return '更新';
  }
  await post('/v1/appInfoLocalizations', {
    type: 'appInfoLocalizations',
    attributes: {locale, ...attrs},
    relationships: {appInfo: {data: {type: 'appInfos', id: appInfo.id}}},
  });
  return `日本語（${locale}）を追加`;
});

await step('主言語を日本語に・コンテンツの権利', async () => {
  const attributes = {contentRightsDeclaration: 'DOES_NOT_USE_THIRD_PARTY_CONTENT'};
  if (app.attributes.primaryLocale !== locale) attributes.primaryLocale = locale;
  await patch(`/v1/apps/${appId}`, {type: 'apps', id: appId, attributes});
  return attributes.primaryLocale ? `${app.attributes.primaryLocale} → ${locale}` : '日本語（設定済み）';
});

await step('カテゴリ', async () => {
  await patch(`/v1/appInfos/${appInfo.id}`, {
    type: 'appInfos',
    id: appInfo.id,
    relationships: {
      primaryCategory: {data: {type: 'appCategories', id: meta.primaryCategory}},
      secondaryCategory: {data: {type: 'appCategories', id: meta.secondaryCategory}},
    },
  });
  return `${meta.primaryCategory} / ${meta.secondaryCategory}`;
});

// 年齢制限：すべて「なし」「いいえ」。Apple側で質問が増えることがあるので、
// いま返ってきた項目のうち、答え方が分かるものだけに答える
const AGE_NONE = ['alcoholTobaccoOrDrugUseOrReferences', 'contests', 'gamblingSimulated', 'gunsOrOtherWeapons', 'horrorOrFearThemes',
  'matureOrSuggestiveThemes', 'medicalOrTreatmentInformation', 'profanityOrCrudeHumor', 'sexualContentGraphicAndNudity',
  'sexualContentOrNudity', 'violenceCartoonOrFantasy', 'violenceRealistic', 'violenceRealisticProlongedGraphicOrSadistic'];
const AGE_FALSE = ['gambling', 'unrestrictedWebAccess', 'lootBox', 'messagingAndChat', 'parentalControls', 'ageAssurance',
  'userGeneratedContent', 'advertising', 'healthOrWellnessTopics', 'socialMedia', 'seventeenPlus'];
await step('年齢制限（すべて「なし」）', async () => {
  const age = (await get(`/v1/appInfos/${appInfo.id}/ageRatingDeclaration`)).data;
  const keys = Object.keys(age.attributes || {});
  const answers = {};
  for (const k of keys) {
    if (AGE_NONE.includes(k)) answers[k] = 'NONE';
    else if (AGE_FALSE.includes(k)) answers[k] = false;
  }
  const unknown = keys.filter((k) => !(k in answers) && age.attributes[k] === null && !/override|kidsAgeBand|Url|gracRating|socialMediaAgeRestricted/i.test(k));
  try {
    await patch(`/v1/ageRatingDeclarations/${age.id}`, {type: 'ageRatingDeclarations', id: age.id, attributes: answers});
  } catch (e) {
    // まとめて送って断られたら、1項目ずつ送ってどれが原因か分かるようにする
    const bad = [];
    for (const [k, v] of Object.entries(answers)) {
      try {
        await patch(`/v1/ageRatingDeclarations/${age.id}`, {type: 'ageRatingDeclarations', id: age.id, attributes: {[k]: v}});
      } catch (e2) {
        bad.push(`${k}（${e2.message}）`);
      }
    }
    if (bad.length) throw new Error(`答えられなかった項目：${bad.join(' / ')}`);
  }
  if (unknown.length) manual.push(`年齢制限のうち、このスクリプトが知らない質問：${unknown.join(', ')}（App Store Connectで「なし／いいえ」を選ぶ）`);
  return `${Object.keys(answers).length}項目`;
});

let versionLoc = null;
await step('説明文・キーワード・プロモーション用テキスト・URL', async () => {
  const attrs = {
    description: joinLines(meta.description),
    keywords: meta.keywords,
    promotionalText: meta.promotionalText,
    supportUrl: meta.supportUrl,
    marketingUrl: meta.marketingUrl,
  };
  const locs = (await get(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)).data;
  versionLoc = locs.find((l) => l.attributes.locale === locale);
  if (versionLoc) {
    await patch(`/v1/appStoreVersionLocalizations/${versionLoc.id}`, {type: 'appStoreVersionLocalizations', id: versionLoc.id, attributes: attrs});
    return '更新';
  }
  versionLoc = (await post('/v1/appStoreVersionLocalizations', {
    type: 'appStoreVersionLocalizations',
    attributes: {locale, ...attrs},
    relationships: {appStoreVersion: {data: {type: 'appStoreVersions', id: version.id}}},
  })).data;
  return `日本語（${locale}）を追加`;
});

// 審査の連絡先（氏名・電話・メール）は公開したくないので、GitHubのSecretsから受け取る
const CONTACT_SECRETS = {
  contactFirstName: 'APP_REVIEW_CONTACT_FIRST_NAME',
  contactLastName: 'APP_REVIEW_CONTACT_LAST_NAME',
  contactPhone: 'APP_REVIEW_CONTACT_PHONE',
  contactEmail: 'APP_REVIEW_CONTACT_EMAIL',
};
const contact = Object.fromEntries(Object.entries(CONTACT_SECRETS).map(([k, env]) => [k, process.env[env]]));
const missingContact = Object.keys(CONTACT_SECRETS).filter((k) => !contact[k]).map((k) => CONTACT_SECRETS[k]);
await step('審査メモ（ログイン不要・試し方）と連絡先', async () => {
  const attributes = {notes: joinLines(meta.reviewNotes), demoAccountRequired: false};
  for (const [k, v] of Object.entries(contact)) if (v) attributes[k] = v.trim();
  if (missingContact.length) manual.push(`審査の連絡先：GitHubのSecretsに ${missingContact.join(', ')} が未登録`);
  let detail = null;
  try {
    detail = (await get(`/v1/appStoreVersions/${version.id}/appStoreReviewDetail`)).data;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  if (detail) {
    // 一度作ったあとは、更新のたびに連絡先4つがそろっていないとAppleに断られる
    if (missingContact.length) return '審査メモは入力済み。連絡先はSecretsを登録してから入力';
    await patch(`/v1/appStoreReviewDetails/${detail.id}`, {type: 'appStoreReviewDetails', id: detail.id, attributes});
    return '更新';
  }
  await post('/v1/appStoreReviewDetails', {
    type: 'appStoreReviewDetails',
    attributes,
    relationships: {appStoreVersion: {data: {type: 'appStoreVersions', id: version.id}}},
  });
  return '追加';
});

await step('著作権', async () => {
  const copyright = (process.env.APP_STORE_COPYRIGHT || '').trim();
  if (!copyright) {
    manual.push('著作権：GitHubのSecretsに APP_STORE_COPYRIGHT が未登録');
    return 'Secrets 未登録のためスキップ';
  }
  await patch(`/v1/appStoreVersions/${version.id}`, {type: 'appStoreVersions', id: version.id, attributes: {copyright}});
  return '入力';
});

// 価格：無料。すでに価格が決まっていたら触らない
await step('価格（無料）', async () => {
  let schedule = null;
  try {
    schedule = (await get(`/v1/apps/${appId}/appPriceSchedule`)).data;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  if (schedule) return '設定済みのため変更なし';
  const points = (await get(`/v1/apps/${appId}/appPricePoints?filter[territory]=${meta.baseTerritory}&limit=200`)).data;
  const free = points.find((p) => Number(p.attributes.customerPrice) === 0);
  if (!free) throw new Error('無料（0円）の価格が見つかりません');
  await post('/v1/appPriceSchedules', {
    type: 'appPriceSchedules',
    relationships: {
      app: {data: {type: 'apps', id: appId}},
      baseTerritory: {data: {type: 'territories', id: meta.baseTerritory}},
      manualPrices: {data: [{type: 'appPrices', id: '${free}'}]},
    },
  }, [{
    type: 'appPrices',
    id: '${free}',
    attributes: {startDate: null},
    relationships: {appPricePoint: {data: {type: 'appPricePoints', id: free.id}}},
  }]);
  return '無料に設定';
});

// 配信地域：日本だけ。すでに決まっていたら、日本が入っているかだけ確かめる
await step('配信地域（日本）', async () => {
  let availability = null;
  try {
    availability = (await get(`/v1/apps/${appId}/appAvailabilityV2`)).data;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  if (!availability) {
    await post('/v2/appAvailabilities', {
      type: 'appAvailabilities',
      attributes: {availableInNewTerritories: false},
      relationships: {
        app: {data: {type: 'apps', id: appId}},
        territoryAvailabilities: {data: meta.territories.map((t) => ({type: 'territoryAvailabilities', id: '${' + t + '}'}))},
      },
    }, meta.territories.map((t) => ({
      type: 'territoryAvailabilities',
      id: '${' + t + '}',
      attributes: {available: true, releaseDate: null, preOrderEnabled: false},
      relationships: {territory: {data: {type: 'territories', id: t}}},
    })));
    return `${meta.territories.join(', ')} だけに設定`;
  }
  const list = [];
  let next = `/v2/appAvailabilities/${availability.id}/territoryAvailabilities?include=territory&limit=200`;
  while (next) {
    const page = await get(next);
    list.push(...page.data);
    next = page.links?.next || null;
  }
  const on = list.filter((t) => t.attributes.available).map((t) => t.relationships?.territory?.data?.id);
  for (const t of meta.territories) {
    if (on.includes(t)) continue;
    const item = list.find((x) => x.relationships?.territory?.data?.id === t);
    if (!item) throw new Error(`${t} の配信設定が見つかりません`);
    await patch(`/v1/territoryAvailabilities/${item.id}`, {type: 'territoryAvailabilities', id: item.id, attributes: {available: true}});
  }
  return `設定済み（配信中の地域：${on.length}か所。日本以外が入っていたら画面で外してください）`;
});

await step(`申請に使うビルド（${meta.minBuildNumber}以降の最新）`, async () => {
  if (!build) throw new Error(`ビルド(${meta.minBuildNumber})以降で処理済みのものが見つかりません。TestFlightに出てから、もう一度実行してください`);
  if (build.marketing !== meta.versionString) throw new Error(`ビルドのバージョン（${build.marketing}）が ${meta.versionString} と違います`);
  await patch(`/v1/appStoreVersions/${version.id}/relationships/build`, {type: 'builds', id: build.id});
  return `${build.marketing} (${build.number})`;
});

async function uploadScreenshot(setId, file) {
  const bytes = readFileSync(join(root, file));
  const fileName = file.split('/').pop();
  const shot = (await post('/v1/appScreenshots', {
    type: 'appScreenshots',
    attributes: {fileName, fileSize: bytes.length},
    relationships: {appScreenshotSet: {data: {type: 'appScreenshotSets', id: setId}}},
  })).data;
  for (const op of shot.attributes.uploadOperations) {
    const headers = Object.fromEntries((op.requestHeaders || []).map((h) => [h.name, h.value]));
    const res = await fetch(op.url, {method: op.method, headers, body: bytes.subarray(op.offset, op.offset + op.length)});
    if (!res.ok) throw new Error(`${fileName} のアップロードに失敗（${res.status}）`);
  }
  await patch(`/v1/appScreenshots/${shot.id}`, {
    type: 'appScreenshots',
    id: shot.id,
    attributes: {uploaded: true, sourceFileChecksum: createHash('md5').update(bytes).digest('hex')},
  });
  // Apple側で画像のチェックが終わるのを待つ（サイズ違いなどはここで分かる）
  for (let i = 0; i < 30; i++) {
    const state = (await get(`/v1/appScreenshots/${shot.id}`)).data.attributes.assetDeliveryState;
    if (state?.state === 'COMPLETE') return;
    if (state?.state === 'FAILED') throw new Error(`${fileName}：${(state.errors || []).map((e) => e.description || e.code).join('; ') || 'Appleで処理に失敗'}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

for (const {displayType, screenshots} of meta.screenshotSets) {
  await step(`スクリーンショット（${displayType}）`, async () => {
    if (!versionLoc) throw new Error('日本語の説明文の欄が作れなかったため、スクリーンショットも入れられません');
    const sets = (await get(`/v1/appStoreVersionLocalizations/${versionLoc.id}/appScreenshotSets`)).data;
    let set = sets.find((s) => s.attributes.screenshotDisplayType === displayType);
    if (!set) {
      set = (await post('/v1/appScreenshotSets', {
        type: 'appScreenshotSets',
        attributes: {screenshotDisplayType: displayType},
        relationships: {appStoreVersionLocalization: {data: {type: 'appStoreVersionLocalizations', id: versionLoc.id}}},
      })).data;
    }
    const existing = (await get(`/v1/appScreenshotSets/${set.id}/appScreenshots`)).data;
    // 手で入れた画像を消さないよう、すでに何か入っていたら触らない
    if (existing.length) return `すでに${existing.length}枚入っているため変更なし`;
    for (const file of screenshots) await uploadScreenshot(set.id, file);
    return `${screenshots.length}枚をアップロード`;
  });
}

manual.push('「Appのプライバシー」：APIキーでは入力できないため、画面で「データの収集なし」を選んで公開する');
manual.push('すべて確認したら、右上の「審査用に追加」→「審査へ提出」');

const lines = [
  `## ${meta.name} 申請の下書き（${mode}）`,
  '',
  '### 入力できたもの',
  ...done.map((d) => `- ${d}`),
  '',
  ...(failed.length ? ['### うまくいかなかったもの', ...failed.map((f) => `- ${f}`), ''] : []),
  '### App Store Connect で手で入力するもの',
  ...manual.map((m) => `- ${m}`),
];
console.log('\n' + lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
if (failed.length) process.exit(1);
