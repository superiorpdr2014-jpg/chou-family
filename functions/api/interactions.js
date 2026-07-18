/*
 * 照片互動：愛心 ❤ ＋ 留言 💬 — Cloudflare Pages Function
 *
 * 存在 GitHub 的 public/data/interactions.json（跟全站一樣用 GitHub 當資料庫）。
 * 家族用量不大，這樣就夠；量真的變大再換 Cloudflare D1。
 *
 * 身分：直接讀登入的 session cookie（裡面有 who＝登入的名字），
 * 不用再要一次密碼，也不能冒名——cookie 有 HMAC 簽章。
 *
 * key = "相簿id/照片name"（跨重建都穩定，不像全域索引會位移）。
 * 寫入 commit 都帶 [skip ci]：互動不改靜態網站內容（前端走這支 API 讀），不用重新部署。
 */

const FILE = 'public/data/interactions.json';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sign(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return b64url(new Uint8Array(sig));
}
async function readSession(request, env) {
  if (!env.ADMIN_PASSWORD) return null;
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)chou_sess=([^;]+)/);
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig || sig !== (await sign(env.ADMIN_PASSWORD, payload))) return null;
  try {
    const d = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
    return d.exp > Date.now() ? d : null;
  } catch { return null; }
}
function safeEqual(a, b) {
  const ea = new TextEncoder().encode(String(a)), eb = new TextEncoder().encode(String(b));
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

async function gh(env, url, method = 'GET', body) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'chou-family-album',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${method} ${url} → ${res.status} ${(await res.text()).slice(0, 160)}`);
  return res.json();
}
const b64ToText = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
const textToB64 = (t) => { const b = new TextEncoder().encode(t); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => String(s || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
const cleanKey = (s) => String(s || '').replace(/[^a-zA-Z0-9一-鿿_/-]/g, '').slice(0, 80);

function repoOf(env) {
  const [owner, repo] = String(env.GH_REPO).split('/');
  return { owner, repo, branch: env.GH_BRANCH || 'main' };
}

async function loadData(env) {
  const { owner, repo, branch } = repoOf(env);
  const f = await gh(env, `/repos/${owner}/${repo}/contents/${FILE}?ref=${branch}`);
  return f ? JSON.parse(b64ToText(f.content)) : {};
}

// GET /api/interactions → 全部互動（登入才給，因為含名字）
export async function onRequestGet({ request, env }) {
  if (!(await readSession(request, env))) return json({ error: 'need login' }, 401);
  try {
    return new Response(JSON.stringify(await loadData(env)), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' },
    });
  } catch (err) {
    return json({ error: String(err.message || err).slice(0, 160) }, 502);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.GH_TOKEN || !env.GH_REPO || !env.ADMIN_PASSWORD) return json({ error: '網站還沒設定好' }, 500);
    const sess = await readSession(request, env);
    if (!sess) return json({ error: '請先登入' }, 401);
    const who = clean(sess.who) || '家人';

    const body = await request.json();
    const action = String(body.action || '');
    const key = cleanKey(body.key);
    if (!key) return json({ error: '沒有指定照片' }, 400);
    const isAdmin = body.adminPassword && safeEqual(String(body.adminPassword), String(env.ADMIN_PASSWORD));

    const { owner, repo, branch } = repoOf(env);
    let result;
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const ref = await gh(env, `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
        const baseSha = ref.object.sha;
        const baseCommit = await gh(env, `/repos/${owner}/${repo}/git/commits/${baseSha}`);
        const fileRes = await gh(env, `/repos/${owner}/${repo}/contents/${FILE}?ref=${branch}`);
        const data = fileRes ? JSON.parse(b64ToText(fileRes.content)) : {};
        const entry = data[key] || { h: [], c: [] };
        entry.h = entry.h || []; entry.c = entry.c || [];

        let msg;
        if (action === 'heart') {
          const i = entry.h.indexOf(who);
          if (i >= 0) { entry.h.splice(i, 1); result = { hearted: false }; }
          else { entry.h.push(who); result = { hearted: true }; }
          result.count = entry.h.length;
          msg = `interactions: ${who} ${result.hearted ? '愛心' : '收回愛心'} [skip ci]`;
        } else if (action === 'comment') {
          const text = clean(body.text).slice(0, 500);
          if (!text) return json({ error: '留言不能空白' }, 400);
          const c = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, by: who, text, at: new Date().toISOString().slice(0, 16).replace('T', ' ') };
          entry.c.push(c);
          result = { comment: c };
          msg = `interactions: ${who} 留言 [skip ci]`;
        } else if (action === 'uncomment') {
          const cid = String(body.cid || '');
          const idx = entry.c.findIndex((x) => x.id === cid);
          if (idx < 0) return json({ error: '留言不在了' }, 404);
          if (entry.c[idx].by !== who && !isAdmin) return json({ error: '只能刪自己的留言' }, 403);
          entry.c.splice(idx, 1);
          result = { removed: cid };
          msg = `interactions: 刪留言 [skip ci]`;
        } else {
          return json({ error: '不支援的動作' }, 400);
        }

        data[key] = entry;
        const blob = await gh(env, `/repos/${owner}/${repo}/git/blobs`, 'POST', { content: textToB64(JSON.stringify(data)), encoding: 'base64' });
        const tree = await gh(env, `/repos/${owner}/${repo}/git/trees`, 'POST', { base_tree: baseCommit.tree.sha, tree: [{ path: FILE, mode: '100644', type: 'blob', sha: blob.sha }] });
        const commit = await gh(env, `/repos/${owner}/${repo}/git/commits`, 'POST', { message: msg, tree: tree.sha, parents: [baseSha] });
        await gh(env, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, 'PATCH', { sha: commit.sha });
        return json({ ok: true, ...result });
      } catch (e) {
        lastErr = e;
        if (/not a fast forward|\b422\b/i.test(String(e.message || e))) { await sleep(250 + attempt * 250); continue; }
        throw e;
      }
    }
    throw lastErr;
  } catch (err) {
    return json({ error: String(err.message || err).slice(0, 160) }, 500);
  }
}
