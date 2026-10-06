// Publishable, isolated UI preview. Never connects to the real Supabase project.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'preview-dist');
let html = await readFile(resolve(root, 'omoide.html'), 'utf8');
const bootstrap = function () {
  const room = 'demo-community', me = 'demo-admin';
  const key = 'omoide_design_preview_v1';
  const names = ['はる', 'ゆい', 'そうた', 'りん', 'なつ', 'あおい', 'けん', 'さき'];
  const stories = ['文化祭で司会を担当した', '収録前にマイクを忘れた', 'ラジオ番組を作った', '夜通し映像を編集した', 'ラテアートに挑戦した', '新人スタッフの研修を担当した', 'お店の看板を描いた', '新メニューを提案した'];
  const colors = ['#b49bda', '#e2a9ae', '#83bdb4', '#e5bf82', '#8bade0', '#acbd88', '#c4a8d3', '#e6ad85'];
  const fresh = () => ({
    invitesEnabled: true,
    people: names.map((name, i) => ({ id: 'demo-person-' + i, room_id: room, name, nickname: '',
      tags: [i < 4 ? '放送研究会' : 'バイト先', '大学'], hobbies: [i % 2 ? '映画' : '音楽'],
      photo_urls: ['https://preview.invalid/storage/v1/object/public/photos/avatar-' + i],
      episodes: [{ id: 'episode-' + i, text: stories[i], createdAt: '2026-10-01T00:00:00Z' }], history: [],
      created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z'
    })),
    binder_members: [{ room_id: room, user_id: me, display_name: 'あなた（デモ管理者）', role: 'admin', status: 'active', joined_at: '2026-10-01' },
      { room_id: room, user_id: 'demo-member', display_name: '参加者サンプル', role: 'member', status: 'active', joined_at: '2026-10-02' }],
    quiz_scores: [], tag_notes: [],
    binder_fictional_episodes: [{ id: 'fiction-demo', room_id: room, text: '文化祭の本番中、突然ペンギンがスタジオに現れた', tags: ['放送研究会'], created_by: me, created_at: '2026-10-01' }]
  });
  let data;
  try { data = JSON.parse(localStorage.getItem(key)) || fresh(); } catch { data = fresh(); }
  const persist = () => { try { localStorage.setItem(key, JSON.stringify(data)); } catch {} };
  window.previewStorage = {
    getItem(k) { try { return localStorage.getItem('omoide_preview:' + k); } catch { return null; } },
    setItem(k, v) { try { localStorage.setItem('omoide_preview:' + k, v); } catch {} },
    removeItem(k) { try { localStorage.removeItem('omoide_preview:' + k); } catch {} }
  };
  window.previewStorage.setItem('omoide_room_id_v1', room);
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: me } } } }),
      signInAnonymously: async () => ({ data: { user: { id: me } } })
    },
    from(table) {
      let operation = 'select', payload, single = false, filters = [], start = 0, end = Infinity;
      const query = {
        select() { return this; }, eq(k, v) { filters.push(row => row[k] === v); return this; },
        order() { return this; }, range(a, b) { start = a; end = b + 1; return this; }, limit(n) { end = n; return this; },
        maybeSingle() { single = true; return this; }, single() { single = true; return this; },
        insert(rows) { operation = 'insert'; payload = rows; return this; },
        upsert(row) { operation = 'upsert'; payload = row; return this; },
        update(row) { operation = 'update'; payload = row; return this; },
        delete() { operation = 'delete'; return this; },
        then(resolve, reject) {
          try {
            let rows = data[table] || [];
            let selected = rows.filter(row => filters.every(filter => filter(row)));
            if (operation === 'insert') {
              selected = (Array.isArray(payload) ? payload : [payload]).map(row => ({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...row }));
              rows.push(...selected);
            } else if (operation === 'update') selected.forEach(row => Object.assign(row, payload));
            else if (operation === 'delete') rows = rows.filter(row => !selected.includes(row));
            else if (operation === 'upsert') {
              const existing = rows.find(row => row.room_id === payload.room_id && (payload.user_id ? row.user_id === payload.user_id : row.tag_name === payload.tag_name));
              if (existing) Object.assign(existing, payload); else rows.push({ ...payload });
              selected = [existing || payload];
            }
            data[table] = rows;
            if (operation !== 'select') persist();
            selected = selected.slice(start, end);
            return Promise.resolve({ data: JSON.parse(JSON.stringify(single ? (selected[0] || null) : selected)), error: null }).then(resolve, reject);
          } catch (error) { return Promise.resolve({ data: null, error }).then(resolve, reject); }
        }
      };
      return query;
    },
    async rpc(name, args) {
      let result = null;
      const code = 'demo-' + Math.random().toString(36).slice(2, 10);
      if (name === 'binder_get_invite_status') result = data.invitesEnabled;
      else if (name === 'binder_set_invites_enabled') { data.invitesEnabled = args.p_enabled; result = { enabled: args.p_enabled, invite_code: args.p_enabled ? code : null }; }
      else if (name === 'binder_remove_member') { const member = data.binder_members.find(row => row.user_id === args.p_user); if (member) member.status = 'removed'; result = code; }
      else if (name === 'binder_rotate_invite') result = code;
      else if (name === 'binder_set_display_name') data.binder_members[0].display_name = args.p_name;
      else if (name === 'binder_join_room') result = room;
      else if (name === 'binder_create_room') result = { room_id: room, invite_code: code };
      persist();
      return { data: result, error: null };
    },
    storage: { from: () => ({
      async download(path) {
        const index = Number(path.replace('avatar-', '')) || 0;
        const color = colors[index % colors.length];
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300"><rect width="300" height="300" fill="${color}"/><circle cx="150" cy="118" r="60" fill="#f6dbc5"/><path d="M88 108q-5-75 64-74 65 4 63 83l-27-37-91 36z" fill="#443849"/><path d="M45 300q0-115 105-115t105 115" fill="#faf8fc"/><circle cx="129" cy="120" r="4" fill="#443849"/><circle cx="171" cy="120" r="4" fill="#443849"/><path d="M134 146q16 15 32 0" fill="none" stroke="#a56565" stroke-width="4"/><text x="150" y="265" text-anchor="middle" font-family="sans-serif" font-size="26" fill="#443849">${names[index % names.length]}</text></svg>`;
        return { data: new Blob([svg], { type: 'image/svg+xml' }), error: null };
      },
      async upload() { return { error: { message: '確認版では写真のアップロードは利用できません。' } }; },
      getPublicUrl(path) { return { data: { publicUrl: 'https://preview.invalid/storage/v1/object/public/photos/' + path } }; },
      async remove() { return { data: [], error: null }; }
    }) }
  };
  window.supabase = { createClient: () => client };
  window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('resetPreview').addEventListener('click', () => {
      if (!confirm('確認版の変更をリセットしますか？')) return;
      localStorage.removeItem(key);
      Object.keys(localStorage).filter(k => k.startsWith('omoide_preview:')).forEach(k => localStorage.removeItem(k));
      location.reload();
    });
  });
};
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase[^>]+><\/script>/, '');
html = html.replace(/var SUPABASE_URL = "[^"]+";/, 'var SUPABASE_URL = "https://preview.invalid";');
html = html.replace(/var SUPABASE_ANON_KEY = "[^"]+";/, 'var SUPABASE_ANON_KEY = "preview-only";');
html = html.replace(/\blocalStorage\b/g, 'previewStorage');
html = html.replace('</head>', `<meta name="robots" content="noindex,nofollow"><style>.previewBanner{position:relative;z-index:1000;background:#514165;color:#fff;padding:12px 16px;text-align:center;font:13px/1.6 sans-serif}.previewBanner button{margin-left:10px;background:transparent;border:1px solid #cabdd9;color:#fff;border-radius:8px;padding:5px 10px}</style></head>`);
html = html.replace('<body>', `<body><div class="previewBanner"><strong>デザイン・操作の確認版</strong> · 架空のサンプルです。変更はこのブラウザ内のみ保存され、他の人には共有されません。<button id="resetPreview" type="button">リセット</button></div><script>(${bootstrap.toString()})();</script>`);
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'omoide.html'), html);
console.log('Built isolated preview-dist/omoide.html');
