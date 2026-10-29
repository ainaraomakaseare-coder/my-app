#!/usr/bin/env node
/*
 * テレビの店（tv-shops.json）に、番組の公式ページから新しい回の飲食店を足す。
 *
 *   node apps/gohan-ashiato/scripts/collect-tv-shops.mjs [--dry-run] [--file <tv-shops.json>]
 *
 * - 読むのは番組・テレビ局の公式ページだけ。各番組について tv-shops.json にある最新の放送日より新しい回だけを読む
 * - 実行時に各サイトの robots.txt を読み、このスクリプトの User-Agent と「*」で禁止されたパスは読まない
 * - 読むのは1秒に1回まで（国土地理院の住所検索も同じ）
 * - 既にある店は変えない。同じ店（店名＋番地）が出たら appearances を足す
 * - ぶらり途中下車の旅は飲食店以外も多いので、自信のないものは足さずに「確認待ち」として出力に並べる
 * - 標準出力に Markdown（番組ごとの追加件数・確認待ち・読めなかったページ）を書く。そのままPRの本文に使える
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const USER_AGENT = 'gohan-ashiato-tvshops/1.0 (+https://github.com/ainaraomakaseare-coder/my-app)';
const UA_TOKEN = 'gohan-ashiato-tvshops';
const INTERVAL_MS = 1100;
const GSI = 'https://msearch.gsi.go.jp/address-search/AddressSearch?q=';

// ---------------------------------------------------------------- 文字の整え

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', Eacute: 'É', aacute: 'á', Aacute: 'Á', egrave: 'è', acirc: 'â', ccedil: 'ç', ouml: 'ö', uuml: 'ü', times: '×', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–' };
export function decodeEntities(s) {
  return String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, k) => ENT[k] || m);
}
export const clean = s => decodeEntities(s).replace(/\s+/g, ' ').trim();
// タグを外して行に分ける
export function htmlText(h) {
  return decodeEntities(String(h || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|dt|dd|h\d|tr|section)>/gi, '\n').replace(/<[^>]*>/g, ' '))
    .split('\n').map(s => s.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean);
}
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export function jaDate(s) {
  const m = String(s || '').match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  return m ? ymd(m[1], m[2], m[3]) : '';
}
const station = s => { s = clean(s).replace(/\s+/g, ''); return s ? (/駅$/.test(s) ? s : s + '駅') : ''; };

// 同じ店かどうか：店名（記号・空白を除く）と、住所の建物名より前（都県名を除き、丁目・番・号をハイフンに）
const norm = s => String(s || '').normalize('NFKC').toLowerCase();
export const nameKey = s => norm(s).replace(/[\s・･\-‐－'’"”!！?？.。、,()（）「」]/g, '');
export const addrKey = s => norm(s).split(/[\s　]/)[0].replace(/^(東京都|神奈川県|千葉県|埼玉県)/, '').replace(/丁目|番地?|号/g, '-').replace(/[‐－ー−]/g, '-').replace(/-+$/, '');
export const shopKey = s => nameKey(s.name) + '|' + addrKey(s.address);

// ---------------------------------------------------------------- robots.txt

export function parseRobots(txt) {
  const groups = []; let cur = null, lastWasAgent = false;
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase()); lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (k === 'allow' || k === 'disallow')) cur.rules.push({ allow: k === 'allow', path: v });
    }
  }
  return groups;
}
const ruleRe = p => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
// そのグループの規則で禁止か（一番長く合う規則が勝つ。同じ長さなら Allow）
function disallowedBy(rules, p) {
  let best = null;
  for (const r of rules) {
    if (!r.path) continue;
    if (!ruleRe(r.path).test(p)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !!best && !best.allow;
}
// このスクリプトの名前のグループと「*」のグループの、どちらかで禁止されていれば読まない
export function robotsAllows(groups, urlPath, token = UA_TOKEN) {
  const mine = groups.filter(g => g.agents.some(a => a !== '*' && token.toLowerCase().includes(a)));
  const star = groups.filter(g => g.agents.includes('*'));
  return ![...mine, ...star].some(g => disallowedBy(g.rules, urlPath));
}

// ---------------------------------------------------------------- 取得（1秒に1回まで・robots確認つき）

export function makeFetcher({ log }) {
  const robots = {}; let last = 0;
  const wait = async () => { const w = last + INTERVAL_MS - Date.now(); if (w > 0) await new Promise(r => setTimeout(r, w)); last = Date.now(); };
  async function raw(url) {
    await wait();
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    return res;
  }
  return async function get(url) {
    const u = new URL(url);
    if (!(u.origin in robots)) {
      try {
        const r = await raw(u.origin + '/robots.txt');
        robots[u.origin] = r.ok ? parseRobots(await r.text()) : [];
      } catch (e) { robots[u.origin] = []; }
    }
    if (!robotsAllows(robots[u.origin], u.pathname + u.search)) { log.blocked.push(url); return null; }
    try {
      const r = await raw(url);
      if (!r.ok) { log.failed.push(`${url}（HTTP ${r.status}）`); return null; }
      return await r.text();
    } catch (e) { log.failed.push(`${url}（${e.message}）`); return null; }
  };
}

// ---------------------------------------------------------------- 吉田類の酒場放浪記・おんな酒場放浪記（BS-TBS）

// 店リスト（/sakaba/map/xml/shop_list.xml など）
export function parseSakabaList(xml) {
  return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
    const t = k => clean((m[1].match(new RegExp('<' + k + '>([\\s\\S]*?)</' + k + '>')) || [])[1] || '').replace(/^<!\[CDATA\[|\]\]>$/g, '');
    const title = t('title'), tm = title.match(/^(.*?)\s*「(.+)」\s*$/);
    return { aired: jaDate(t('oa')), num: +t('num') || 0, link: t('link'), area: t('area'), closed: t('closed') === 'on',
      title, station: tm ? tm[1] : '', name: tm ? tm[2] : title };
  });
}
// 各店のページから本命の店の住所（「立ち寄り」の店の住所は取らない）
export function parseSakabaShop(html) {
  const blk = (String(html).match(/id="shop-name"[\s\S]*?(?=>\s*立ち寄り\s*<|class="shop-notice")/) || [''])[0];
  const lines = htmlText(blk);
  for (const l of lines) {
    const m = l.match(/^住\s*所\s*[：:]\s*(.+?)\s*(?:電\s*話|営\s*業|定休日|$)/);
    if (m) return { address: clean(m[1]) };
  }
  return { address: '' };
}

// ---------------------------------------------------------------- 町中華で飲ろうぜ（BS-TBS）

export function parseMachichukaList(xml) {
  return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
    const t = k => ((m[1].match(new RegExp('<' + k + '>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</' + k + '>')) || [])[1] || '').trim();
    const oa = t('oa');
    return { oaDate: oa.length >= 8 ? ymd(oa.slice(0, 4), +oa.slice(4, 6), +oa.slice(6, 8)) : '', title: clean(t('title')), link: t('link') };
  }).filter(o => o.link);
}
// 店のページ：「店名」「場所」「放送回」「初回放送日」の見出しの次の行
export function parseMachichukaStore(html) {
  const lines = htmlText(html);
  const after = k => { const i = lines.indexOf(k); return i >= 0 && lines[i + 1] ? lines[i + 1] : ''; };
  const ep = after('放送回');
  return { name: clean(after('店名')), address: clean(after('場所')), aired: jaDate(after('初回放送日')), area: (ep.match(/「(.+?)編」/) || [])[1] || '' };
}

// ---------------------------------------------------------------- ぶらり途中下車の旅（日本テレビ）

// 公式の articles.js は「var articles = [...]」。実行せず、JSONとして読む
export function parseBurariArticles(jsText) {
  const t = String(jsText);
  const s = t.indexOf('['), e = t.lastIndexOf(']');
  if (s < 0 || e < s) throw new Error('記事の配列が見つからない');
  const list = JSON.parse(t.slice(s, e + 1));
  const out = [], seen = {};
  for (const a of list) {
    const body = (a && a.data && a.data.body) || '';
    if (!/【所番地】/.test(body)) continue;
    const aired = jaDate((body.match(/\d{4}年\d{1,2}月\d{1,2}日放送/) || [''])[0]);
    if (!aired) continue;
    const url = `https://www.ntv.co.jp/burari/articles/${a.content_id}${a.item_id}.html`;
    const lines = htmlText(body);
    lines.forEach((l, i) => {
      if (!l.startsWith('【所番地】')) return;
      let head = -1;
      for (let k = i - 1; k >= Math.max(0, i - 12); k--) if (/（[^（）]*駅）$/.test(lines[k])) { head = k; break; }
      if (head < 0) return;
      const hm = lines[head].match(/^(.*)（([^（）]*駅)）$/);
      const name = clean(hm[1]).replace(/^-->\s*/, '');
      if (seen[name + aired]) return; // 同じ回の予告と放送後の記事
      seen[name + aired] = 1;
      let end = lines.findIndex((x, k) => k > i && /（[^（）]*駅）$/.test(x)); if (end < 0) end = lines.length;
      const rest = lines.slice(i, end);
      const hp = clean((rest.find(x => x.startsWith('【ホームページ】')) || '').replace('【ホームページ】', ''));
      out.push({ aired, url, title: clean(a.data.title), name, station: clean(hm[2]), address: clean(l.replace('【所番地】', '')),
        desc: clean(lines.slice(head + 1, i).filter(x => !x.startsWith('【') && !/駅」|徒歩/.test(x)).join(' ')), homepage: /^https:\/\//.test(hp) ? hp : '' });
    });
  }
  return out;
}

// 飲食店かどうか（2026-10-29に手で分けたときの基準をコードにしたもの）
//   food   … 店名が飲食店の言葉で、店名にも説明にも飲食店でない施設・品物の言葉が無い
//   unsure … 店名か説明に食べ物の言葉がある（説明だけのもの・施設の言葉が混ざるもの） → 足さずに「確認待ち」
//   no     … 食べ物の言葉が無い（庭園・神社・雑貨店・工房など）
const NAME_FOOD = /料理|食堂|うどん|そば|蕎麦|ラーメン|らーめん|らぁ麺|拉麺|中華|餃子|カレー|カフェ|喫茶|珈琲|コーヒー|酒場|居酒屋|立呑|立ち飲み|焼き?鳥|やきとり|寿司|鮨|天ぷら|とんかつ|ハンバーグ|ステーキ|焼肉|ホルモン|定食|弁当|パン|ベーカリー|ベーグル|スコーン|ケーキ|スイーツ|菓子|甘味|ジェラート|パフェ|クレープ|ピザ|ピッツェリア|パスタ|イタリアン|トラットリア|オステリア|フレンチ|ビストロ|バル|ダイニング|レストラン|割烹|丼|海鮮|鰻|うなぎ|おでん|お好み焼|もんじゃ|たこ焼|かき氷|バーガー|BURGER|BURRITO|BAKE|PIZZ|cafe|caf[ée]|coffee|kitchen|dining|restaurant|bistro|trattoria|bakery|\bbar\b/i;
const ANY_FOOD = /料理|食|うどん|そば|蕎麦|ラーメン|らーめん|麺|中華|餃子|カレー|カフェ|喫茶|珈琲|コーヒー|酒|居酒屋|焼|寿司|鮨|天ぷら|とんかつ|ハンバーグ|ステーキ|ホルモン|弁当|パン|ベーグル|スコーン|ケーキ|スイーツ|菓子|甘|ジェラート|アイス|パフェ|クレープ|ピザ|パスタ|イタリアン|フレンチ|ビストロ|バル|レストラン|丼|海鮮|鰻|うなぎ|おでん|たこ焼|団子|餅|大福|プリン|チョコ|ドーナツ|メニュー|味わ|グルメ|ランチ|かき氷|サンド|バーガー|チーズ|ビール|ワイン|茶|豆腐|味噌|出汁|フライ|角煮|点心|ジンギスカン|叉焼|BBQ|バーベキュー|粥|スープ|ジュース|ヨーグルト|饅|果物|フルーツ|カルボナーラ|cafe|caf[ée]|coffee|kitchen|dining|restaurant|bakery|\bbar\b/i;
const NOT_FOOD = /美術館|博物館|資料館|庭園|神社|寺|公園|ギャラリー|工房|教室|体験|製作所|産業|ホテル|旅館|農園|ファーム|牧場|記念館|水族館|動物園|劇場|陶芸|雑貨|セレクトショップ|窯|醸造所|展望|直売|道の駅|複合|施設|商業|摘み取り|収穫|食器|キッチン用品|調理器具|照明|バッグ|財布|アクセサリー|デニム|銭湯|手ぬぐい|アパレル|アロマ|展$/i;
export function classifyBurari(e) {
  const both = e.name + ' ' + e.desc;
  if (NAME_FOOD.test(e.name) && e.desc && !NOT_FOOD.test(both)) return 'food';
  if (ANY_FOOD.test(both)) return 'unsure';
  return 'no';
}

// ---------------------------------------------------------------- 国土地理院の住所検索

export function geoQuery(address) {
  return String(address).normalize('NFKC').split(/[\s　]/)[0].replace(/（.*$|\(.*$/, '');
}
// 先頭の候補が同じ市区町村のときだけ使う（住所の一部だけが合った別の場所を避ける）
export function pickGeo(results, q) {
  const city = (q.replace(/^.{2,3}?[都道府県]/, '').replace(/^.+?郡/, '').replace(/ケ/g, 'ヶ').match(/^.+?[市区町村]/) || [''])[0];
  const r = Array.isArray(results) && results[0];
  if (!r || !r.geometry || !String(r.properties && r.properties.title).normalize('NFKC').replace(/ケ/g, 'ヶ').includes(city)) return null;
  const [lng, lat] = r.geometry.coordinates;
  return { lat: +(+lat).toFixed(6), lng: +(+lng).toFixed(6) };
}

// ---------------------------------------------------------------- 番組ごとの集め方

const PROGRAMS = [
  { program: '吉田類の酒場放浪記', channel: 'BS-TBS', kind: 'sakaba', base: 'https://bs.tbs.co.jp/sakaba', list: 'https://bs.tbs.co.jp/sakaba/map/xml/shop_list.xml', idPrefix: 'sakaba' },
  { program: 'おんな酒場放浪記', channel: 'BS-TBS', kind: 'sakaba', base: 'https://bs.tbs.co.jp/onnasakaba', list: 'https://bs.tbs.co.jp/onnasakaba/map/xml/shop_list.xml', idPrefix: 'onnasakaba' },
  { program: '町中華で飲ろうぜ', channel: 'BS-TBS', kind: 'machichuka', list: 'https://bs.tbs.co.jp/machichuka/xml/shop.xml', idPrefix: 'machichuka' },
  { program: 'ぶらり途中下車の旅', channel: '日本テレビ', kind: 'burari', list: 'https://www.ntv.co.jp/burari/articles.js', idPrefix: 'burari' }
];

// 番組の新しい回から、足す候補の店を作る（{ shops, pending }）
async function collectProgram(p, since, until, get) {
  const shops = [], pending = [];
  const appearance = (aired, title, url) => ({ program: p.program, channel: p.channel, aired, title, url });
  const listText = await get(p.list);
  if (!listText) return { shops, pending };
  if (p.kind === 'sakaba') {
    for (const it of parseSakabaList(listText)) {
      if (!it.aired || it.aired <= since || it.aired > until || it.closed || it.area === '特別編' || !it.link) continue;
      const url = p.base + '/shop/' + it.link;
      const html = await get(url); if (!html) continue;
      const { address } = parseSakabaShop(html);
      if (!address) { pending.push({ program: p.program, name: it.name, aired: it.aired, url, reason: '住所が載っていない' }); continue; }
      shops.push({ id: p.idPrefix + '-' + it.num, name: clean(it.name), address, station: station(it.station), genre: '酒場', links: [],
        appearances: [appearance(it.aired, '#' + it.num + ' ' + it.title, url)], sources: [url] });
    }
  } else if (p.kind === 'machichuka') {
    for (const it of parseMachichukaList(listText)) {
      if (!it.oaDate || it.oaDate <= since || it.oaDate > until) continue;
      const url = new URL(it.link, 'https://bs.tbs.co.jp').href;
      const html = await get(url); if (!html) continue;
      const s = parseMachichukaStore(html);
      if (!s.name || !s.address || !s.aired) { pending.push({ program: p.program, name: s.name || it.title, aired: s.aired || it.oaDate, url, reason: '店名・場所・放送日のどれかが読めない' }); continue; }
      shops.push({ id: p.idPrefix + '-' + url.replace(/\/$/, '').split('/').pop(), name: s.name, address: s.address, station: /[・、]/.test(s.area) ? '' : station(s.area), genre: '町中華', links: [],
        appearances: [appearance(s.aired, it.title, url)], sources: [url] });
    }
  } else if (p.kind === 'burari') {
    let entries;
    try { entries = parseBurariArticles(listText); } catch (e) { return { shops, pending, error: 'articles.js を読めない（' + e.message + '）' }; }
    const perDay = {};
    for (const e of entries) {
      if (e.aired <= since || e.aired > until) continue;
      if (!/[都道府県市区町村郡]/.test(e.address) || /活動|・.+[市区町村]/.test(e.address)) { pending.push({ program: p.program, name: e.name, aired: e.aired, url: e.url, reason: '所番地が住所の形でない：' + e.address }); continue; }
      const c = classifyBurari(e);
      if (c === 'no') continue;
      if (c === 'unsure') { pending.push({ program: p.program, name: e.name, aired: e.aired, url: e.url, reason: '飲食店か分からない：' + e.desc.slice(0, 60) }); continue; }
      const day = e.aired.replace(/-/g, ''); perDay[day] = (perDay[day] || 0) + 1;
      shops.push({ id: p.idPrefix + '-' + day + '-' + perDay[day], name: e.name, address: e.address, station: e.station, genre: '',
        links: e.homepage ? [{ label: 'お店の公式サイト', url: e.homepage }] : [], appearances: [appearance(e.aired, e.title, e.url)], sources: [e.url] });
    }
  }
  return { shops, pending };
}

// 各番組の最新の放送日
export function latestAired(data) {
  const m = {};
  for (const s of data.shops || []) for (const a of s.appearances || []) if (a.program && a.aired && (!m[a.program] || a.aired > m[a.program])) m[a.program] = a.aired;
  return m;
}

// 候補を今のリストに足す（既存の店は変えず、同じ店なら appearances と sources を足す）
export function mergeShops(data, candidates, today) {
  const byKey = {}, ids = new Set(data.shops.map(s => s.id));
  data.shops.forEach(s => { byKey[shopKey(s)] = s; });
  const added = [], appended = [];
  for (const c of candidates) {
    const hit = byKey[shopKey(c)];
    if (hit) {
      const newApps = c.appearances.filter(a => !hit.appearances.some(x => x.url === a.url));
      if (!newApps.length) continue;
      hit.appearances.push(...newApps);
      hit.appearances.sort((a, b) => a.aired < b.aired ? 1 : a.aired > b.aired ? -1 : 0);
      c.sources.forEach(u => { if (!hit.sources.includes(u)) hit.sources.push(u); });
      appended.push({ shop: hit, appearances: newApps });
      continue;
    }
    let id = c.id, n = 2;
    while (ids.has(id)) id = c.id + '-' + n++;
    ids.add(id);
    const s = { id, name: c.name, address: c.address, station: c.station, genre: c.genre, lat: null, lng: null, links: c.links,
      appearances: c.appearances, sources: c.sources, checkedAt: today };
    data.shops.push(s); byKey[shopKey(s)] = s; added.push(s);
  }
  return { added, appended };
}

// ---------------------------------------------------------------- Markdown の出力

export function report({ perProgram, added, appended, pending, log, dryRun, since }) {
  const L = [];
  L.push('## テレビの店の自動追加' + (dryRun ? '（--dry-run：tv-shops.json は書き換えていない）' : ''));
  L.push('');
  L.push('| 番組 | 前回までの最新の放送日 | 新しく足した店 | 既存の店に足した放送回 | 確認待ち |');
  L.push('|---|---|---|---|---|');
  for (const p of perProgram) L.push(`| ${p.program} | ${since[p.program] || 'なし'} | ${p.added} | ${p.appended} | ${p.pending} |`);
  L.push('');
  L.push(`合計：新しい店 ${added.length}件、既存の店への放送回 ${appended.length}件、確認待ち ${pending.length}件`);
  if (added.length) {
    L.push('', '### 足した店', '');
    added.forEach(s => L.push(`- ${s.name}（${s.address}）${s.lat === null ? ' ※位置が見つからない' : ''} — ${s.appearances[0].program} ${s.appearances[0].aired} [公式](${s.appearances[0].url})`));
  }
  if (appended.length) {
    L.push('', '### 既存の店に足した放送回', '');
    appended.forEach(x => x.appearances.forEach(a => L.push(`- ${x.shop.name} — ${a.program} ${a.aired} [公式](${a.url})`)));
  }
  L.push('', '### 確認待ち（足していない。飲食店なら手で足す）', '');
  if (pending.length) pending.forEach(x => L.push(`- ${x.program} ${x.aired}「${x.name}」 — ${x.reason} [公式](${x.url})`));
  else L.push('- なし');
  L.push('', '### 読めなかったページ', '');
  const bad = [...log.blocked.map(u => `- robots.txt で禁止のため読んでいない：${u}`), ...log.failed.map(u => `- 読めなかった：${u}`), ...log.errors.map(u => `- ${u}`)];
  L.push(...(bad.length ? bad : ['- なし']));
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- 実行

function todayJst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

export async function main(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dryRun = argv.includes('--dry-run');
  const fi = argv.indexOf('--file');
  const file = fi >= 0 ? path.resolve(argv[fi + 1]) : path.join(here, '..', 'tv-shops.json');
  const today = todayJst();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const since = latestAired(data);
  const log = { blocked: [], failed: [], errors: [] };
  const get = makeFetcher({ log });

  const perProgram = [], candidates = [], pending = [];
  for (const p of PROGRAMS) {
    const r = await collectProgram(p, since[p.program] || '0000-00-00', today, get);
    if (r.error) log.errors.push(`${p.program}：${r.error}`);
    candidates.push(...r.shops); pending.push(...r.pending);
    perProgram.push({ program: p.program, candidates: r.shops, pending: r.pending.length });
  }
  const { added, appended } = mergeShops(data, candidates, today);
  // 新しい店だけ位置を調べる
  for (const s of added) {
    const q = geoQuery(s.address);
    const txt = await get(GSI + encodeURIComponent(q));
    let pt = null;
    try { pt = pickGeo(JSON.parse(txt || '[]'), q); } catch (e) {}
    if (pt) { s.lat = pt.lat; s.lng = pt.lng; }
  }
  perProgram.forEach(p => {
    p.added = added.filter(s => s.appearances[0].program === p.program).length;
    p.appended = appended.reduce((n, x) => n + x.appearances.filter(a => a.program === p.program).length, 0);
  });
  if (!dryRun && (added.length || appended.length)) {
    data.updatedAt = today;
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  }
  process.stdout.write(report({ perProgram, added, appended, pending, log, dryRun, since }));
  return { added, appended, pending, log };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(e); process.exit(1); });
}
