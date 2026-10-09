import { createPrivateKey, sign } from 'node:crypto';

// Only this app is eligible for changes; never log credentials or contact values.
const APP = '6819331432';
const mode = process.env.METADATA_MODE || 'inspect';
if (!['inspect', 'repair', 'support', 'select-build'].includes(mode)) throw new Error('unsupported_mode');
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = `${encode({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' })}.${encode({ iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' })}`;
const signature = sign('sha256', Buffer.from(unsigned), { key: createPrivateKey(process.env.ASC_PRIVATE_KEY), dsaEncoding: 'ieee-p1363' }).toString('base64url');
const token = `${unsigned}.${signature}`;
async function api(path, method = 'GET', data, allowMissing = false) {
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(45000)
  });
  if (allowMissing && response.status === 404) return { data: null };
  const body = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    // Error details may echo personal input. Keep only HTTP status and machine codes.
    throw new Error(JSON.stringify({ operation: `${method} ${path.split('?')[0]}`, status: response.status, codes: (body.errors || []).map(e => e.code) }));
  }
  return body;
}
const report = { app: APP, mode, changed: [], limitations: ['App Privacy publication requires the App Store Connect website.'] };
const app = await api(`/v1/apps/${APP}?fields[apps]=contentRightsDeclaration`);
const versions = await api(`/v1/apps/${APP}/appStoreVersions?filter[platform]=IOS&filter[versionString]=1.0.0&limit=10`);
if (versions.data.length !== 1) throw new Error('expected_one_ios_version');
const version = versions.data[0];
if (!['PREPARE_FOR_SUBMISSION', 'REJECTED', 'METADATA_REJECTED', 'DEVELOPER_REJECTED'].includes(version.attributes.appStoreState) && mode !== 'inspect') throw new Error('version_not_editable');
if (mode === 'select-build') {
  const number = process.env.ASC_BUILD_NUMBER || '';
  if (!/^\d+$/.test(number)) throw new Error('invalid_build_number');
  const builds = await api(`/v1/builds?filter[app]=${APP}&filter[version]=${number}&filter[preReleaseVersion.version]=1.0.0&filter[preReleaseVersion.platform]=IOS&limit=10`);
  if (builds.data.length !== 1) throw new Error('expected_one_matching_build');
  const build = builds.data[0];
  if (build.attributes.processingState !== 'VALID' || build.attributes.expired) throw new Error('build_not_ready');
  if (build.attributes.usesNonExemptEncryption !== false) throw new Error('encryption_declaration_required');
  await api(`/v1/appStoreVersions/${version.id}/relationships/build`, 'PATCH', { data: { type: 'builds', id: build.id } });
  report.changed.push('selected_general_release_build');
}
const selectedBuild = await api(`/v1/appStoreVersions/${version.id}/build`, 'GET', undefined, true);
report.build = selectedBuild.data ? { number: selectedBuild.data.attributes.version, state: selectedBuild.data.attributes.processingState } : null;
const beta = await api(`/v1/apps/${APP}/betaAppReviewDetail`, 'GET', undefined, true);
let review = await api(`/v1/appStoreVersions/${version.id}/appStoreReviewDetail`, 'GET', undefined, true);
const contactFields = ['contactFirstName', 'contactLastName', 'contactPhone', 'contactEmail'];
report.version = { version: version.attributes.versionString, state: version.attributes.appStoreState };
report.contact = { complete: contactFields.every(key => !!review.data?.attributes[key]?.trim()), missing: contactFields.filter(key => !review.data?.attributes[key]?.trim()), betaSourceComplete: contactFields.every(key => !!beta.data?.attributes[key]?.trim()) };

if (mode === 'repair') {
  const changes = Object.fromEntries(contactFields.filter(key => !review.data?.attributes[key]?.trim() && beta.data?.attributes[key]?.trim()).map(key => [key, beta.data.attributes[key]]));
  if (Object.keys(changes).length) {
    if (review.data) review = await api(`/v1/appStoreReviewDetails/${review.data.id}`, 'PATCH', { data: { type: 'appStoreReviewDetails', id: review.data.id, attributes: changes } });
    else review = await api('/v1/appStoreReviewDetails', 'POST', { data: { type: 'appStoreReviewDetails', attributes: changes, relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } } } } });
    report.changed.push('review_contact_from_existing_beta_contact');
  }
  if (app.data.attributes.contentRightsDeclaration !== 'USES_THIRD_PARTY_CONTENT') {
    await api(`/v1/apps/${APP}`, 'PATCH', { data: { type: 'apps', id: APP, attributes: { contentRightsDeclaration: 'USES_THIRD_PARTY_CONTENT' } } });
    report.changed.push('content_rights_user_confirmed_permission');
  }
}

let schedule = await api(`/v1/apps/${APP}/appPriceSchedule?include=baseTerritory,manualPrices`, 'GET', undefined, true);
if (mode === 'repair' && !schedule.data) {
  let points = await api(`/v1/apps/${APP}/appPricePoints?filter[territory]=JPN&limit=200`);
  let free = points.data.find(point => Number(point.attributes.customerPrice) === 0);
  while (!free && points.links?.next) {
    const next = new URL(points.links.next); if (next.origin !== 'https://api.appstoreconnect.apple.com') throw new Error('invalid_pagination_origin');
    points = await api(next.pathname + next.search); free = points.data.find(point => Number(point.attributes.customerPrice) === 0);
  }
  if (!free) throw new Error('japan_free_price_not_found');
  await api('/v1/appPriceSchedules', 'POST', {
    data: { type: 'appPriceSchedules', relationships: { app: { data: { type: 'apps', id: APP } }, baseTerritory: { data: { type: 'territories', id: 'JPN' } }, manualPrices: { data: [{ type: 'appPrices', id: '${omoide-free}' }] } } },
    included: [{ type: 'appPrices', id: '${omoide-free}', attributes: { startDate: null, endDate: null }, relationships: { appPricePoint: { data: { type: 'appPricePoints', id: free.id } } } }]
  });
  report.changed.push('free_price_japan_base');
  schedule = await api(`/v1/apps/${APP}/appPriceSchedule?include=baseTerritory,manualPrices`);
}
report.price = { schedulePresent: !!schedule.data, baseTerritory: schedule.data?.relationships.baseTerritory?.data?.id || null, manualPrices: schedule.included?.filter(row => row.type === 'appPrices').length || 0 };

const localizations = await api(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=50`);
const japanese = localizations.data.find(row => row.attributes.locale === 'ja');
if (!japanese) throw new Error('japanese_localization_missing');
if (mode === 'support') {
  const support = 'https://ainaraomakaseare-coder.github.io/my-app/omoide-binder-support.html';
  const publicPage = await fetch(support, { signal: AbortSignal.timeout(45000) });
  if (!publicPage.ok) throw new Error('support_page_not_live');
  const html = await publicPage.text();
  if (!html.includes('mailto:') || html.includes('公開前の下書き')) throw new Error('support_contact_not_published');
  await api(`/v1/appStoreVersionLocalizations/${japanese.id}`, 'PATCH', { data: { type: 'appStoreVersionLocalizations', id: japanese.id, attributes: { supportUrl: support } } });
  report.changed.push('japanese_support_url');
}
const checkedReview = await api(`/v1/appStoreVersions/${version.id}/appStoreReviewDetail`, 'GET', undefined, true);
const checkedApp = await api(`/v1/apps/${APP}?fields[apps]=contentRightsDeclaration`);
const checkedLocale = await api(`/v1/appStoreVersionLocalizations/${japanese.id}?fields[appStoreVersionLocalizations]=supportUrl`);
report.contact.complete = contactFields.every(key => !!checkedReview.data?.attributes[key]?.trim());
report.contact.missing = contactFields.filter(key => !checkedReview.data?.attributes[key]?.trim());
report.contentRights = checkedApp.data.attributes.contentRightsDeclaration;
report.supportUrl = checkedLocale.data.attributes.supportUrl || null;
report.reviewAccess = {
  notesPresent: !!checkedReview.data?.attributes.notes?.trim(),
  demoAccountRequired: checkedReview.data?.attributes.demoAccountRequired ?? null,
  demoCredentialsComplete: ['demoAccountName', 'demoAccountPassword'].every(key => !!checkedReview.data?.attributes[key]?.trim())
};
console.log(JSON.stringify(report));
