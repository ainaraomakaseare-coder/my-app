'use strict';
/**
 * 運用アカウント（運用ライン）の出し入れ。
 *
 * ★ ここは「混ぜない」ための土台。
 *   ひろやの企画用と、転職のキュレーション用では、投稿文の書き方そのものが違う。
 *   「使ってみました」は、ひろや側では本当のことで、転職側では嘘になる。
 *   だから運用アカウントに validation_profile を持たせて、点検規則ごと切り替える。
 *
 * ★ 消すのは慎重に。
 *   連携先や投稿がぶら下がったまま消すと、それらの所属が消える。
 *   所属が空になると DB側の見張り（assert_target_matches_group）は素通りするので、
 *   「消したら誤爆を止められなくなった」という一番まずい状態になる。
 *   ぶら下がりがあるうちは消させない。
 */

const db = require('./db');
const rules = require('./draft-rules');
const handoff = require('./handoff');

const MAX_LABEL = 40;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 画面にそのまま出してよい、利用者向けの断り。 */
function bad(message, hint) {
  const e = new Error(message);
  e.userError = true;
  if (hint) e.hint = hint;
  return e;
}

function normalizeLabel(raw) {
  const label = String(raw == null ? '' : raw).trim();
  if (!label) throw bad('運用アカウントの名前を入れてください。');
  if (label.length > MAX_LABEL) throw bad(`名前は${MAX_LABEL}文字までにしてください。`);
  return label;
}

/**
 * 点検規則の選択。
 *
 * ★ 空欄のときは curator（きびしい方）にする。
 *   間違えて personal にすると、一人称の体験談が素通りしてしまう。
 *   迷ったら止まる側に倒す。
 */
function normalizeProfile(raw) {
  const id = String(raw == null ? '' : raw).trim();
  if (!id) return rules.CURATOR.id;
  if (!rules.PROFILES[id]) {
    throw bad(`点検の型「${id}」は知りません。`,
      '選べるのは ' + Object.keys(rules.PROFILES).join(' / ') + ' です。');
  }
  return id;
}

/**
 * 使う機能。
 *
 * ★ ジャンルによって要る道具が違う。転職は文案も動画も自動で作るが、
 *   AI初心者側はいま自分で書いている。全部に同じ画面を出すと邪魔になり、
 *   消してしまうと戻せない。だから切り替えにする。
 *
 * ★ この2つが独立していれば、必要な組み合わせは全部言える。
 *     {writes, videos} … 転職
 *     {}               … いまのAI初心者
 *     {writes}         … 文案は書くが動画は作らない（将来のAI初心者）
 */
const FEATURES = {
  writes: { id: 'writes', label: '文案を自動で書く',
            note: 'ネタから6行と各SNSの本文を作ります。「まとめて仕込む」もここが要ります。' },
  videos: { id: 'videos', label: '動画を自動で作る',
            note: '縦型16.8秒の穴埋め動画と、X用の画像2枚を作ります。' },
};

function normalizeFeatures(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw bad('使う機能の指定が正しくありません。');

  const out = [];
  for (const f of raw) {
    const id = String(f || '').trim();
    if (!FEATURES[id]) {
      throw bad(`「${id}」は使う機能の指定に使えません。`,
        '指定できるのは ' + Object.keys(FEATURES).join(' / ') + ' だけです。');
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** 画面の選択肢に出すための一覧。 */
const featureChoices = () => Object.values(FEATURES);

function profileChoices() {
  return Object.values(rules.PROFILES).map((p) => ({ id: p.id, label: p.label }));
}

/**
 * 自動投稿を許すSNSの一覧。
 *
 * ★ 知らない名前は黙って捨てる、ではなく断る。
 *   'instgram' のような打ち間違いを捨ててしまうと、
 *   許可したつもりで許可されていない状態に気づけない。
 *
 * ★ そもそも TikTok と YouTube は、許可のあるなしに関わらず
 *   下書き・非公開までしか進まない。ここに入れても意味がないので断る。
 */
function normalizeAutoNetworks(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw bad('自動投稿するSNSの指定が正しくありません。');

  const out = [];
  for (const n of raw) {
    const name = String(n || '').trim();
    if (!handoff.isPublishing(name)) {
      throw bad(`「${name}」は自動投稿の指定に使えません。`,
        '指定できるのは ' + handoff.PUBLISHING_NETWORKS.join(' / ') +
        ' だけです（TikTok と YouTube は、指定しなくても下書き・非公開までしか進みません）。');
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function requireId(id) {
  if (!id || !UUID.test(String(id))) throw bad('どの運用アカウントか指定されていません。');
  return String(id);
}

// ---------------------------------------------------------------------------

const list = () => db.listGroups();

async function create(body) {
  const label = normalizeLabel(body.label);
  const validation_profile = normalizeProfile(body.validation_profile);
  // ★ 既定は「どこにも自動投稿しない」。新しい運用ラインは安全な側から始める。
  const auto_publish_networks = normalizeAutoNetworks(body.auto_publish_networks);
  const features = normalizeFeatures(body.features);

  const existing = await db.listGroups();
  if (existing.some((g) => g.label === label)) {
    throw bad(`「${label}」はもうあります。`, '見分けがつかなくなるので、別の名前にしてください。');
  }

  return {
    group: await db.insertGroup({ label, validation_profile, auto_publish_networks, features }),
  };
}

async function update(id, body) {
  const gid = requireId(id);
  const groups = await db.listGroups();
  const current = groups.find((g) => g.id === gid);
  if (!current) throw bad('その運用アカウントは見つかりません。');

  const patch = {};
  if (body.label !== undefined) {
    patch.label = normalizeLabel(body.label);
    if (groups.some((g) => g.id !== gid && g.label === patch.label)) {
      throw bad(`「${patch.label}」はもうあります。`);
    }
  }
  if (body.validation_profile !== undefined) {
    patch.validation_profile = normalizeProfile(body.validation_profile);
  }
  if (body.auto_publish_networks !== undefined) {
    patch.auto_publish_networks = normalizeAutoNetworks(body.auto_publish_networks);
  }
  if (body.features !== undefined) patch.features = normalizeFeatures(body.features);
  if (!Object.keys(patch).length) throw bad('変えるものがありません。');

  return { group: await db.updateGroup(gid, patch) };
}

/**
 * 消す。
 * 連携先か投稿がぶら下がっていたら断る。先に付け替えてもらう。
 */
async function remove(id) {
  const gid = requireId(id);
  const refs = await db.countGroupRefs(gid);

  if (refs.accounts || refs.posts) {
    const parts = [];
    if (refs.accounts) parts.push(`連携先が${refs.accounts}件`);
    if (refs.posts) parts.push(`投稿が${refs.posts}件`);
    throw bad(
      `この運用アカウントには${parts.join('、')}ぶら下がっています。先に付け替えてください。`,
      '所属が空のまま消すと、投稿先の取り違えを止められなくなります。'
    );
  }

  await db.deleteGroup(gid);
  return { deleted: gid };
}

module.exports = {
  MAX_LABEL, UUID, bad,
  FEATURES,
  normalizeLabel, normalizeProfile, profileChoices, normalizeAutoNetworks,
  normalizeFeatures, featureChoices,
  list, create, update, remove,
};
