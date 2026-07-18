/*
 * 家族聚會公佈欄 ＋ 回覆出席（RSVP） — Cloudflare Pages Function
 *
 * 存 public/data/events.json（GitHub 當資料庫，[skip ci] 免部署，前端走這支 API 讀）。
 * 建立聚會＝管理員（ADMIN_PASSWORD）；回覆出席＝登入的家人（讀 session cookie 的 who）。
 */

const FILE = 'public/data/events.json';

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
    headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'chou-family-album', 'content-type': 'application/json' },
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
function repoOf(env) { const [owner, repo] = String(env.GH_REPO).split('/'); return { owner, repo, branch: env.GH_BRANCH || 'main' }; }

export async function onRequestGet({ request, env }) {
  if (!(await readSession(request, env))) return json({ error: 'need login' }, 401);
  try {
    const { owner, repo, branch } = repoOf(env);
    const f = await gh(env, `/repos/${owner}/${repo}/contents/${FILE}?ref=${branch}`);
    const data = f ? JSON.parse(b64ToText(f.content)) : { events: [] };
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' } });
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
    const isAdmin = body.adminPassword && safeEqual(String(body.adminPassword), String(env.ADMIN_PASSWORD));

    const { owner, repo, branch } = repoOf(env);
    let result, lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const ref = await gh(env, `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
        const baseSha = ref.object.sha;
        const baseCommit = await gh(env, `/repos/${owner}/${repo}/git/commits/${baseSha}`);
        const fileRes = await gh(env, `/repos/${owner}/${repo}/contents/${FILE}?ref=${branch}`);
        const data = fileRes ? JSON.parse(b64ToText(fileRes.content)) : { events: [] };
        data.events = data.events || [];

        let msg;
        if (action === 'create') {
          if (!isAdmin) return json({ error: '只有管理員能新增聚會' }, 403);
          const title = clean(body.title).slice(0, 60);
          if (!title) return json({ error: '請填聚會名稱' }, 400);
          const ev = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            title,
            when: clean(body.when).slice(0, 60),
            where: clean(body.where).slice(0, 80),
            note: clean(body.note).slice(0, 300),
            by: who, at: new Date().toISOString().slice(0, 10),
            rsvps: {},
          };
          data.events.unshift(ev);
          result = { event: ev };
          msg = `events: 新增聚會「${title}」 [skip ci]`;
        } else if (action === 'rsvp') {
          const ev = data.events.find((e) => e.id === String(body.id || ''));
          if (!ev) return json({ error: '這個聚會不在了' }, 404);
          const status = ['yes', 'no', 'maybe'].includes(body.status) ? body.status : null;
          ev.rsvps = ev.rsvps || {};
          if (status) ev.rsvps[who] = status; else delete ev.rsvps[who];
          result = { id: ev.id, status };
          msg = `events: ${who} 回覆出席 [skip ci]`;
        } else if (action === 'delete') {
          if (!isAdmin) return json({ error: '只有管理員能刪除聚會' }, 403);
          const before = data.events.length;
          data.events = data.events.filter((e) => e.id !== String(body.id || ''));
          if (data.events.length === before) return json({ error: '這個聚會不在了' }, 404);
          result = { deleted: body.id };
          msg = `events: 刪除聚會 [skip ci]`;
        } else {
          return json({ error: '不支援的動作' }, 400);
        }

        const blob = await gh(env, `/repos/${owner}/${repo}/git/blobs`, 'POST', { content: textToB64(JSON.stringify(data, null, 2)), encoding: 'base64' });
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
