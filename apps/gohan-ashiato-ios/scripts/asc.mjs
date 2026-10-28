// App Store Connect API で、Bundle ID と App Store配信用プロファイルを用意する（手作業でのプロファイル作成・
// Secret登録を不要にするため）。秘密の値は表示しない。
//   node scripts/asc.mjs bundle                 Bundle IDが無ければ登録し、App Store Connectのアプリがあるか確かめる
//   node scripts/asc.mjs profile <証明書のシリアル> <出力先.mobileprovision>
//                                               その証明書入りの配信用プロファイルを探す（無ければ作る）
// 環境変数: API_KEY_ID, API_ISSUER_ID, API_PRIVATE_KEY（.p8の中身）
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

export const BUNDLE_ID = 'com.hiroyaapps.gohanashiato';
export const APP_NAME = 'ごはんの足跡';
const PROFILE_NAME = 'Gohan Ashiato App Store';
const API = 'https://api.appstoreconnect.apple.com/v1';

function required(name) {
  const v = process.env[name] || '';
  if (!v.trim()) throw new Error('Missing required secret: ' + name);
  return v;
}
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
export function makeToken(keyId, issuer, privateKey, now = Math.floor(Date.now() / 1000)) {
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: issuer, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: privateKey.replace(/\\n/g, '\n'), dsaEncoding: 'ieee-p1363' });
  return head + '.' + body + '.' + b64url(sig);
}
// 証明書のシリアル番号を比べられる形に（大文字・先頭の0なし・区切りなし）
export function normSerial(s) { return String(s || '').replace(/^serial=/i, '').replace(/[^0-9a-f]/gi, '').toUpperCase().replace(/^0+/, ''); }

let token = '';
async function api(method, path, body) {
  if (!token) token = makeToken(required('API_KEY_ID').trim(), required('API_ISSUER_ID').trim(), required('API_PRIVATE_KEY'));
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const detail = (data.errors || []).map(e => e.detail || e.title).join(' / ');
    throw new Error(method + ' ' + path.split('?')[0] + ' failed: ' + res.status + ' ' + detail);
  }
  return data;
}

async function findBundle() {
  const r = await api('GET', '/bundleIds?filter[identifier]=' + BUNDLE_ID + '&limit=20');
  return (r.data || []).find(b => b.attributes.identifier === BUNDLE_ID) || null;
}

async function ensureBundle() {
  let bundle = await findBundle();
  if (bundle) console.log('Bundle ID already registered: ' + BUNDLE_ID);
  else {
    bundle = (await api('POST', '/bundleIds', { data: { type: 'bundleIds', attributes: { identifier: BUNDLE_ID, name: 'Gohan Ashiato', platform: 'IOS' } } })).data;
    console.log('Registered Bundle ID: ' + BUNDLE_ID);
  }
  const apps = await api('GET', '/apps?filter[bundleId]=' + BUNDLE_ID);
  if ((apps.data || []).length) console.log('App Store Connect app exists: ' + apps.data[0].attributes.name + ' (' + apps.data[0].id + ')');
  else console.log('::warning::App Store Connect にまだアプリがありません。「マイApp」→「＋」→「新規App」で、バンドルID ' + BUNDLE_ID + ' を選んで作成してください。');
  return bundle;
}

async function ensureProfile(serial, out) {
  const want = normSerial(serial);
  const certs = await api('GET', '/certificates?filter[certificateType]=DISTRIBUTION,IOS_DISTRIBUTION&limit=200');
  const cert = (certs.data || []).find(c => normSerial(c.attributes.serialNumber) === want);
  if (!cert) throw new Error('The distribution certificate in IOS_DIST_CERTIFICATE_P12_BASE64 was not found in this team (or has been revoked).');
  const bundle = await findBundle();
  if (!bundle) throw new Error('Bundle ID ' + BUNDLE_ID + ' is not registered yet. Run the workflow with destination=setup first.');
  const profiles = await api('GET', '/bundleIds/' + bundle.id + '/profiles?limit=50');
  let content = '';
  for (const p of profiles.data || []) {
    const a = p.attributes;
    if (a.profileType !== 'IOS_APP_STORE' || a.name !== PROFILE_NAME) continue;
    const pc = await api('GET', '/profiles/' + p.id + '/certificates?limit=50');
    const ok = a.profileState === 'ACTIVE' && new Date(a.expirationDate) > new Date(Date.now() + 86400000) && (pc.data || []).some(c => c.id === cert.id);
    if (ok && !content) { content = a.profileContent; console.log('Using existing profile ' + PROFILE_NAME); }
    else { await api('DELETE', '/profiles/' + p.id); console.log('Removed outdated profile ' + p.id); }
  }
  if (!content) {
    const created = await api('POST', '/profiles', { data: { type: 'profiles', attributes: { name: PROFILE_NAME, profileType: 'IOS_APP_STORE' }, relationships: { bundleId: { data: { type: 'bundleIds', id: bundle.id } }, certificates: { data: [{ type: 'certificates', id: cert.id }] } } } });
    content = created.data.attributes.profileContent;
    console.log('Created profile ' + PROFILE_NAME);
  }
  await fs.writeFile(out, Buffer.from(content, 'base64'), { mode: 0o600 });
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'bundle') await ensureBundle();
    else if (cmd === 'profile' && a && b) await ensureProfile(a, b);
    else throw new Error('usage: asc.mjs bundle | profile <serial> <out>');
  } catch (e) {
    console.error('::error::' + e.message);
    process.exit(1);
  }
}
