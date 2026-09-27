// App Store Connect の「Appのプライバシー」を入力して公開する。
//
// 「Appのプライバシー」は、GitHub Actions で使っている App Store Connect API（APIキー）では入力できず、
// Apple ID でログインした画面からしか変えられない。そこで、パソコンでブラウザ（Edge）を開き、
// 本人がログインしたら、その画面の中から App Store Connect 自身が使っている通信で入力する。
// Apple ID のパスワードや確認コードは、本人がブラウザに直接入れるだけで、このスクリプトは読まない。
//
// 使い方（Windows の PowerShell）:
//   cd apps\day18-omoide-wiki-ios\scripts\app-privacy
//   npm install
//   node set-app-privacy.mjs
// 入力する中身は ../../store-metadata.json の appPrivacy。何度実行しても同じ結果になる。
import {chromium} from 'playwright-core';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const meta = JSON.parse(readFileSync(join(here, '..', '..', 'store-metadata.json'), 'utf8'));
// テストでは偽のサーバーに向けられるようにしている（ふだんは指定しない）
const BASE = process.env.ASC_BASE || 'https://appstoreconnect.apple.com';
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

async function launch() {
  const options = {headless: process.env.HEADLESS === '1'};
  if (process.env.BROWSER_PATH) return chromium.launch({...options, executablePath: process.env.BROWSER_PATH});
  // Windows なら Edge が必ず入っているので、ブラウザを新しくダウンロードしなくて済む
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({...options, channel});
    } catch {
      // 次の候補を試す
    }
  }
  throw new Error('Edge も Chrome も見つかりませんでした');
}

const browser = await launch();
const page = await browser.newPage();

// ログインした画面の中から、App Store Connect の画面と同じ通信を送る
async function api(method, path, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await page.evaluate(async ({method, url, body}) => {
        const res = await fetch(url, {
          method,
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'X-Csrf-Itc': '[asc-ui]',
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        return {status: res.status, json};
      }, {method, url: `${BASE}/iris/v1/${path}`, body});
    } catch (e) {
      // ログイン直後など、画面が切り替わった瞬間は通信が中断されるので、少し待ってやり直す
      if (attempt === 2) throw e;
      await page.waitForTimeout(1500);
    }
  }
}

function check(res, what) {
  if (res.status >= 200 && res.status < 300) return res.json;
  const details = res.json?.errors?.map((e) => `${e.code}: ${e.detail}`).join('; ');
  throw new Error(`${what}に失敗しました（${res.status}${details ? `：${details}` : ''}）`);
}

try {
  await page.goto(`${BASE}/apps`);
  console.log('');
  console.log('開いたブラウザで、App Store Connect に Apple ID でログインしてください。');
  console.log('（2ステップ確認のコードも、ブラウザに入れてください。ログインが終わると自動で続きます）');
  console.log('');

  // ログインが終わるまで待つ（アプリの情報が読めるようになったらログイン済み）
  const started = Date.now();
  let app = null;
  while (Date.now() - started < LOGIN_TIMEOUT_MS) {
    const res = await api('GET', `apps/${meta.appId}`).catch(() => null);
    if (res?.status === 200) {
      app = res.json.data;
      break;
    }
    await page.waitForTimeout(3000);
  }
  if (!app) throw new Error('15分待ってもログインが終わりませんでした。もう一度実行してください');
  if (app.attributes?.bundleId !== meta.bundleId) {
    throw new Error(`アプリが違います（${app.attributes?.bundleId}）。何も変更していません`);
  }
  console.log(`ログインを確認しました：${app.attributes.name}`);

  // 入力したい組み合わせ。1件ごとに「種類・用途・ユーザーとの紐づき」の3つをそろえて入れる
  // （種類×用途と、種類×紐づきを別々の件にすると、公開のときに「欠けている」と断られる）
  const key = (c, p, d) => `${c}|${p || ''}|${d || ''}`;
  const wanted = [];
  for (const item of meta.appPrivacy) {
    for (const p of item.purposes) {
      for (const d of item.protections) wanted.push({category: item.category, purpose: p, dataProtection: d});
    }
  }
  const wantedKeys = wanted.map((w) => key(w.category, w.purpose, w.dataProtection)).sort();

  const current = check(await api('GET', `apps/${meta.appId}/dataUsages?include=category,purpose,dataProtection&limit=500`), 'いまの設定の読み込み').data || [];
  const rel = (u, name) => u.relationships?.[name]?.data?.id;
  const currentKeys = current.map((u) => key(rel(u, 'category'), rel(u, 'purpose'), rel(u, 'dataProtection'))).sort();
  console.log(`いまの設定：${currentKeys.length ? currentKeys.join(' / ') : 'なし'}`);

  if (JSON.stringify(currentKeys) === JSON.stringify(wantedKeys)) {
    console.log('入力済みです（変更なし）');
  } else {
    // 途中まで入っている設定があれば、いったん消してから入れ直す
    for (const u of current) check(await api('DELETE', `appDataUsages/${u.id}`), '古い設定の削除');
    for (const w of wanted) {
      const relationships = {app: {data: {type: 'apps', id: meta.appId}}};
      if (w.category) relationships.category = {data: {type: 'appDataUsageCategories', id: w.category}};
      if (w.purpose) relationships.purpose = {data: {type: 'appDataUsagePurposes', id: w.purpose}};
      if (w.dataProtection) relationships.dataProtection = {data: {type: 'appDataUsageDataProtections', id: w.dataProtection}};
      check(await api('POST', 'appDataUsages', {data: {type: 'appDataUsages', relationships}}), `${key(w.category, w.purpose, w.dataProtection)} の入力`);
    }
    console.log(`入力しました：${wantedKeys.join(' / ')}`);
  }

  // 入力しただけでは下書きのままなので、「公開」まで行う（これで審査に出せる状態になる）
  const state = check(await api('GET', `apps/${meta.appId}/dataUsagePublishState`), '公開状態の読み込み').data;
  if (state.attributes?.published) {
    console.log('公開済みです');
  } else {
    check(await api('PATCH', `appDataUsagesPublishState/${state.id}`, {
      data: {type: 'appDataUsagesPublishState', id: state.id, attributes: {published: true}},
    }), '公開');
    console.log('公開しました');
  }
  console.log('');
  console.log('完了しました。App Store Connect の「Appのプライバシー」の画面で確認できます。');
} catch (e) {
  console.error('');
  console.error(`うまくいきませんでした：${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
