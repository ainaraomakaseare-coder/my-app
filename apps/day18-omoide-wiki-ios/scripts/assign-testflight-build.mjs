import {createPrivateKey, sign} from 'node:crypto';

const appId = '6815641976';
const groupId = 'c4a9e7a0-bf0c-49f5-84b8-6d570ce8386c';
const expectedGroupName = 'HI hiro';
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

const token = createToken();

async function request(url, options = {}) {
  const response = await fetch(url, {
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
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const details = data?.errors?.map((error) => `${error.code}: ${error.detail}`).join('; ');
    throw new Error(`App Store Connect API ${response.status}${details ? `: ${details}` : ''}`);
  }
  return data;
}

const group = await request(
  `https://api.appstoreconnect.apple.com/v1/betaGroups/${groupId}?include=app&fields[betaGroups]=name,isInternalGroup&fields[apps]=name,bundleId`,
);
if (group?.data?.attributes?.name !== expectedGroupName) {
  throw new Error('The selected TestFlight group name did not match. No build was assigned.');
}
if (group?.data?.attributes?.isInternalGroup !== true) {
  throw new Error('The selected TestFlight group is not an internal testing group. No build was assigned.');
}
if (group?.included?.find((item) => item.type === 'apps')?.id !== appId) {
  throw new Error('The selected TestFlight group does not belong to おもいでWiki. No build was assigned.');
}

const buildUrl = new URL('https://api.appstoreconnect.apple.com/v1/builds');
buildUrl.searchParams.set('filter[app]', appId);
buildUrl.searchParams.set('filter[expired]', 'false');
buildUrl.searchParams.set('fields[builds]', 'version,uploadedDate,expirationDate,expired,processingState');
buildUrl.searchParams.set('sort', '-uploadedDate');
buildUrl.searchParams.set('limit', '50');
const builds = await request(buildUrl);
const availableBuilds = (builds?.data ?? [])
  .filter((build) => build.attributes?.processingState === 'VALID' && build.attributes?.expired === false)
  .sort((left, right) => Date.parse(right.attributes.uploadedDate) - Date.parse(left.attributes.uploadedDate));
const latestBuild = availableBuilds[0];
if (!latestBuild) {
  throw new Error('No processed, unexpired build is available for TestFlight.');
}

const existing = await request(
  `https://api.appstoreconnect.apple.com/v1/betaGroups/${groupId}/relationships/builds?limit=200`,
);
if (existing?.data?.some((build) => build.id === latestBuild.id)) {
  console.log(`Build ${latestBuild.attributes.version} is already assigned to ${expectedGroupName}.`);
  process.exit(0);
}

await request(`https://api.appstoreconnect.apple.com/v1/betaGroups/${groupId}/relationships/builds`, {
  method: 'POST',
  body: JSON.stringify({data: [{type: 'builds', id: latestBuild.id}]}),
});

const verified = await request(
  `https://api.appstoreconnect.apple.com/v1/betaGroups/${groupId}/relationships/builds?limit=200`,
);
if (!verified?.data?.some((build) => build.id === latestBuild.id)) {
  throw new Error('Apple did not confirm the build assignment.');
}

console.log(`Build ${latestBuild.attributes.version} is now available to the ${expectedGroupName} internal testers.`);
