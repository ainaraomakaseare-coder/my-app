/*
 * セッション（docs/adr/0005）といいね・コメント（docs/adr/0006）のAPIを、ローカルのWorkerに対して確かめる。
 * 本番には触れない。実行手順（worker/で）：
 *   npx wrangler d1 execute tabilog-db --local --file schema.sql
 *   npx wrangler d1 execute tabilog-db --local --command "INSERT INTO trips (id,title,created_at,updated_at) VALUES ('t1','テスト旅','x','x'); INSERT INTO blocks (id,trip_id,created_at,updated_at) VALUES ('b1','t1','x','x'); INSERT INTO entries (id,block_id,created_at,updated_at) VALUES ('e1','b1','x','x'); INSERT INTO trips (id,title,created_at,updated_at) VALUES ('t2','別の旅','x','x'); INSERT INTO email_otps (email,code,name,expires_at,created_at) VALUES ('a@example.com','111111','Aさん','2099-01-01T00:00:00Z','x'),('b@example.com','222222','Bさん','2099-01-01T00:00:00Z','x');"
 *   npx wrangler dev --local --port 8799   （別のターミナルで）
 *   node test/social.api.mjs
 */
const B = 'http://127.0.0.1:8799';
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) pass++; else { fail++; console.log('  NG  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
async function call(method, path, body, token, extraHeaders) {
  const headers = Object.assign({}, body !== undefined ? { 'content-type': 'application/json' } : {}, token ? { authorization: 'Bearer ' + token } : {}, extraHeaders || {});
  const res = await fetch(B + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

// --- セッション ---
const va = await call('POST', '/auth/email/verify', { email: 'a@example.com', code: '111111' });
check('OTP確認でトークンが発行される', va.status === 200 && /^[0-9a-f]{64}$/.test(va.data.token), va);
const A = va.data.token;
const vb = await call('POST', '/auth/email/verify', { email: 'b@example.com', code: '222222' });
const Bt = vb.data.token;
await call('POST', '/accounts/ensure', { email: 'a@example.com', name: 'Aさん' }, A);
await call('POST', '/accounts/ensure', { email: 'b@example.com', name: 'Bさん' }, Bt);

const spoof = await call('POST', '/accounts/ensure', { email: 'b@example.com', name: 'なりすまし' }, A);
check('トークンと違うメールアドレスは拒否（403）', spoof.status === 403, spoof);
const legacy = await call('GET', '/mylog?email=a%40example.com');
check('移行期間中はトークン無しでも従来どおり動く', legacy.status === 200, legacy.status);
const mylogTok = await call('GET', '/mylog', undefined, A);
check('トークンだけでマイログが読める', mylogTok.status === 200, mylogTok);
const badTok = await call('GET', '/mylog', undefined, 'f'.repeat(64));
check('でたらめなトークンは本人扱いにならない', badTok.status === 401, badTok);

// --- いいね ---
const likeNoAuth = await call('PUT', '/trips/t1/likes', { targetType: 'trip', targetId: 't1' });
check('いいねはトークン必須', likeNoAuth.status === 401, likeNoAuth);
const likeA = await call('PUT', '/trips/t1/likes', { targetType: 'trip', targetId: 't1' }, A);
check('旅行にいいね', likeA.status === 200 && likeA.data.count === 1, likeA);
await call('PUT', '/trips/t1/likes', { targetType: 'trip', targetId: 't1' }, A);
const likeB = await call('PUT', '/trips/t1/likes', { targetType: 'entry', targetId: 'e1' }, Bt);
check('記録にいいね', likeB.status === 200 && likeB.data.count === 1, likeB);
const likeOther = await call('PUT', '/trips/t2/likes', { targetType: 'entry', targetId: 'e1' }, A);
check('別の旅行の記録にはいいねできない', likeOther.status === 404, likeOther);

let soc = await call('GET', '/trips/t1/social', undefined, A);
check('同じ人が2回いいねしても1件', soc.data.likes['trip:t1'].count === 1 && soc.data.likes['trip:t1'].liked === true, soc.data.likes);
check('自分がいいねしていない記録はliked=false', soc.data.likes['entry:e1'].liked === false, soc.data.likes);

// --- コメント ---
const cA = await call('POST', '/trips/t1/comments', { targetType: 'entry', targetId: 'e1', body: '最高の旅だったね' }, A);
check('記録にコメント', cA.status === 201 && cA.data.name === 'Aさん', cA);
const cB = await call('POST', '/trips/t1/comments', { targetType: 'trip', targetId: 't1', body: 'また行こう' }, Bt);
check('旅行にコメント', cB.status === 201, cB);
const bad = await call('POST', '/trips/t1/comments', { targetType: 'trip', targetId: 't1', body: 'お前しね' }, Bt);
check('明らかな暴言は保存しない', bad.status === 422 && bad.data.error === 'inappropriate', bad);
const empty = await call('POST', '/trips/t1/comments', { targetType: 'trip', targetId: 't1', body: '   ' }, Bt);
check('空のコメントは保存しない', empty.status === 400, empty);

soc = await call('GET', '/trips/t1/social');
check('ログインしていなくてもコメントは読める', soc.status === 200 && soc.data.comments.length === 2, soc.data);
check('コメントにメールアドレスは含まれない', !JSON.stringify(soc.data).includes('@example.com'), soc.data);

const delOther = await call('DELETE', '/comments/' + cB.data.id, undefined, A);
check('他人のコメントは消せない', delOther.status === 403, delOther);

// --- 通報・ブロック ---
const rep = await call('POST', '/comments/' + cB.data.id + '/report', { reason: 'テスト' }, A);
check('通報できる', rep.status === 200, rep);
soc = await call('GET', '/trips/t1/social', undefined, A);
check('通報したコメントは自分には見えなくなる', !soc.data.comments.some((c) => c.id === cB.data.id), soc.data.comments);
const socB = await call('GET', '/trips/t1/social', undefined, Bt);
check('他の人には見える', socB.data.comments.some((c) => c.id === cB.data.id), socB.data.comments);

const cA2 = await call('POST', '/trips/t1/comments', { targetType: 'trip', targetId: 't1', body: 'Aの2つ目' }, A);
const blk = await call('PUT', '/user-blocks', { accountId: cA2.data.accountId }, Bt);
check('ブロックできる', blk.status === 200, blk);
const socB2 = await call('GET', '/trips/t1/social', undefined, Bt);
check('ブロックした相手のコメントは見えなくなる', !socB2.data.comments.some((c) => c.accountId === cA2.data.accountId), socB2.data.comments);
const selfBlk = await call('PUT', '/user-blocks', { accountId: socB2.data.accountId }, Bt);
check('自分自身はブロックできない', selfBlk.status === 400, selfBlk);

const delMine = await call('DELETE', '/comments/' + cA2.data.id, undefined, A);
check('自分のコメントは消せる', delMine.status === 200, delMine);

// --- アカウント削除で、その人のいいね・コメント・セッションが消える ---
const delAcc = await call('POST', '/accounts/delete', { email: 'a@example.com' }, A);
check('アカウント削除', delAcc.status === 200, delAcc);
soc = await call('GET', '/trips/t1/social', undefined, Bt);
check('削除した人のコメントが消える', !soc.data.comments.some((c) => c.id === cA.data.id), soc.data.comments);
check('削除した人のいいねが消える', !soc.data.likes['trip:t1'], soc.data.likes);
const afterDel = await call('GET', '/mylog', undefined, A);
check('削除した人のトークンは使えなくなる', afterDel.status === 401, afterDel);

// --- ログアウト ---
await call('POST', '/auth/logout', {}, Bt);
const afterLogout = await call('PUT', '/trips/t1/likes', { targetType: 'trip', targetId: 't1' }, Bt);
check('ログアウトしたトークンは使えない', afterLogout.status === 401, afterLogout);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
