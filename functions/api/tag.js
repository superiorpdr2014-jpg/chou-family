/*
 * 直接把一張臉標記給某位家族成員 — Cloudflare Pages Function
 *
 * Jay 指定：認人標記「不用經過管理員同意」，所以這支直接寫進 people.json 的 refs
 * （不像刪除/改名走提案）。只有登入的家人能標；身分讀 session cookie 的 who。
 *
 * 只能標給「已存在的家族成員」（前端是下拉選單），不能在這裡新增人 → 不會被亂建人。
 * commit 帶 [skip ci]：people.json 靠 /api/people 即時讀，不用每次標都重新部署。
 */

const FILE = 'public/data/people.json';

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
function repoOf(env) { const [owner, repo] = String(env.GH_REPO).split('/'); return { owner, repo, branch: env.GH_BRANCH || 'main' }; }

/** 檢查前端送來的 ref 合法（避免塞壞資料進 people.json） */
function validRef(ref) {
  if (!ref || typeof ref !== 'object') return null;
  const p = typeof ref.p === 'string' ? ref.p.slice(0, 120) : null;
  const b = Array.isArray(ref.b) && ref.b.length === 4 && ref.b.every((n) => typeof n === 'number') ? ref.b.map((n) => +n.toFixed(5)) : null;
  const d = Array.isArray(ref.d) && ref.d.length === 128 && ref.d.every((n) => typeof n === 'number') ? ref.d.map((n) => +n.toFixed(5)) : null;
  if (!p || !b || !d) return null;
  return { p, b, d };
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.GH_TOKEN || !env.GH_REPO || !env.ADMIN_PASSWORD) return json({ error: '網站還沒設定好' }, 500);
    const sess = await readSession(request, env);
    if (!sess) return json({ error: '請先登入' }, 401);

    const body = await request.json();
    const personId = String(body.personId || '').replace(/[^a-zA-Z0-9一-鿿_-]/g, '').slice(0, 60);
    const ref = validRef(body.ref);
    if (!personId) return json({ error: '沒有指定要標記給誰' }, 400);
    if (!ref) return json({ error: '這張臉的資料不完整' }, 400);

    const { owner, repo, branch } = repoOf(env);
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const refG = await gh(env, `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
        const baseSha = refG.object.sha;
        const baseCommit = await gh(env, `/repos/${owner}/${repo}/git/commits/${baseSha}`);
        const fileRes = await gh(env, `/repos/${owner}/${repo}/contents/${FILE}?ref=${branch}`);
        const data = fileRes ? JSON.parse(b64ToText(fileRes.content)) : { people: [] };
        const person = (data.people || []).find((p) => p.id === personId);
        if (!person) return json({ error: '找不到這位家族成員' }, 404);
        person.refs = person.refs || [];
        // 同一張臉別重複標（用 p+box 判斷）
        const dup = person.refs.some((r) => r.p === ref.p && Array.isArray(r.b) && r.b[0] === ref.b[0] && r.b[1] === ref.b[1]);
        if (!dup) person.refs.push(ref);

        const blob = await gh(env, `/repos/${owner}/${repo}/git/blobs`, 'POST', { content: textToB64(JSON.stringify(data, null, 2) + '\n'), encoding: 'base64' });
        const tree = await gh(env, `/repos/${owner}/${repo}/git/trees`, 'POST', { base_tree: baseCommit.tree.sha, tree: [{ path: FILE, mode: '100644', type: 'blob', sha: blob.sha }] });
        const commit = await gh(env, `/repos/${owner}/${repo}/git/commits`, 'POST', { message: `tag: ${sess.who || '家人'} 標記 ${person.name} 的臉 [skip ci]`, tree: tree.sha, parents: [baseSha] });
        await gh(env, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, 'PATCH', { sha: commit.sha });
        return json({ ok: true, personId, name: person.name, refs: person.refs.length, dup });
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
