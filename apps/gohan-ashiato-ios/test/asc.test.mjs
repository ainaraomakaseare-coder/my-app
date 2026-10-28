// App Store Connect API の署名（JWT）と証明書シリアルの比べ方
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeToken, normSerial, BUNDLE_ID } from '../scripts/asc.mjs';

test('ES256のJWTを作り、公開鍵で検証できる', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const t = makeToken('KEY123', 'issuer-1', pem, 1000);
  const [h, b, s] = t.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY123', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(b, 'base64url')), { iss: 'issuer-1', iat: 1000, exp: 1900, aud: 'appstoreconnect-v1' });
  assert.ok(crypto.verify('sha256', Buffer.from(h + '.' + b), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  // Secretに改行が \n の文字で入っていても読める
  assert.ok(makeToken('K', 'I', pem.replace(/\n/g, '\\n')));
});

test('証明書のシリアルは大文字・先頭0なしで比べる', () => {
  assert.equal(normSerial('serial=0a1B2c'), 'A1B2C');
  assert.equal(normSerial('A1:B2:C3'), 'A1B2C3');
  assert.equal(normSerial('0A1B2C'), normSerial('a1b2c'));
});

test('Bundle ID', () => assert.equal(BUNDLE_ID, 'com.hiroyaapps.gohanashiato'));
