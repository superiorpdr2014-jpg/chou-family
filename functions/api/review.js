/*
 * 待審清單 / 核准 / 退回 — Cloudflare Pages Function（只有 Jay 用）
 *
 * GET  /api/review?password=...            列出待審提案
 * POST /api/review  {password, id, action} action = approve | reject
 *
 * ⚠️ 這支會真的改動 people.json，所以用 ADMIN_PASSWORD，
 *    跟家人上傳用的 FAMILY_PASSWORD 分開 —— 家族密碼是要發給一大家子的，
 *    等於半公開，不能拿它來當「可以改族譜」的鑰匙。
 *
 * 環境變數：ADMIN_PASSWORD / GH_TOKEN / GH_REPO / GH_BRANCH
 */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

function safeEqual(a, b) {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
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
  if (!res.ok) throw new Error(`GitHub ${method} ${url} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const b64ToText = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
const textToB64 = (t) => {
  const bytes = new TextEncoder().encode(t);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};

function repoOf(env) {
  const [owner, repo] = String(env.GH_REPO).split('/');
  return { owner, repo, branch: env.GH_BRANCH || 'main' };
}

/** 列出 proposals/ 底下的提案 */
async function listProposals(env) {
  const { owner, repo, branch } = repoOf(env);
  const dir = await gh(env, `/repos/${owner}/${repo}/contents/proposals?ref=${branch}`);
  if (!dir) return [];
  const out = [];
  for (const f of dir) {
    if (f.type !== 'file' || !f.name.endsWith('.json')) continue;
    const file = await gh(env, `/repos/${owner}/${repo}/contents/${encodeURIComponent(f.path)}?ref=${branch}`);
    try { out.push(JSON.parse(b64ToText(file.content))); } catch { /* 壞掉的提案就跳過 */ }
  }
  return out.sort((a, b) => String(b.id).localeCompare(String(a.id)));
}

/** 產生新人的 id。中文沒辦法自動轉拼音，用流水號就好 —— id 只是內部識別碼 */
function newId(people, seed) {
  let n = 1;
  let id;
  do { id = `p-${seed}-${n++}`; } while (people.some((p) => p.id === id));
  return id;
}

/** 把提案套用到 people.json 的內容上 */
function applyProposal(data, prop) {
  const people = data.people;
  const person = people.find((p) => p.id === prop.target);
  if (!person) throw new Error(`族譜裡找不到 ${prop.target}`);
  const c = prop.changes || {};
  const seed = String(prop.id).split('-')[0];
  const log = [];

  if (c.name && c.name !== person.name) {
    log.push(`${person.name} → ${c.name}`);
    person.name = c.name;
  }

  if (c.avatarImg) {
    person.avatar = { img: c.avatarImg.replace(/^proposals\//, 'avatars/') };
    log.push('換了大頭照');
  }

  if (c.addSpouse) {
    const id = newId(people, seed);
    people.push({ id, name: c.addSpouse, note: `${person.name}的配偶`, spouse: [person.id], parents: [], refs: [] });
    person.spouse = [...(person.spouse || []), id];
    log.push(`新增配偶 ${c.addSpouse}`);
  }

  if (c.addChildren && c.addChildren.length) {
    // 小孩的父母要同時掛上這個人和他的配偶，不然樹上會變成單親
    const parents = [person.id, ...(person.spouse || [])];
    for (const kidName of c.addChildren) {
      const id = newId(people, seed);
      people.push({ id, name: kidName, note: `${person.name}的小孩`, spouse: [], parents, refs: [] });
      log.push(`新增小孩 ${kidName}`);
    }
  }

  return log;
}

export async function onRequestGet({ request, env }) {
  const pw = new URL(request.url).searchParams.get('password') || '';
  if (!env.ADMIN_PASSWORD) return json({ error: '還沒設定管理員密碼' }, 500);
  if (!safeEqual(pw, String(env.ADMIN_PASSWORD))) return json({ error: '密碼不對' }, 401);
  try {
    return json({ ok: true, proposals: await listProposals(env) });
  } catch (err) {
    return json({ error: String(err.message || err).slice(0, 200) }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.ADMIN_PASSWORD || !env.GH_TOKEN || !env.GH_REPO) {
      return json({ error: '網站還沒設定好' }, 500);
    }
    const body = await request.json();
    if (!safeEqual(String(body.password || ''), String(env.ADMIN_PASSWORD))) {
      return json({ error: '密碼不對' }, 401);
    }
    const id = String(body.id || '').replace(/[^0-9a-z-]/gi, '');
    const action = body.action === 'approve' ? 'approve' : 'reject';
    if (!id) return json({ error: '沒有指定提案' }, 400);

    const { owner, repo, branch } = repoOf(env);
    const propFile = await gh(env, `/repos/${owner}/${repo}/contents/proposals/${id}.json?ref=${branch}`);
    if (!propFile) return json({ error: '找不到這個提案（可能已經處理過了）' }, 404);
    const prop = JSON.parse(b64ToText(propFile.content));

    const ref = await gh(env, `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
    const baseSha = ref.object.sha;
    const baseCommit = await gh(env, `/repos/${owner}/${repo}/git/commits/${baseSha}`);

    const tree = [];
    let log = [];

    if (action === 'approve') {
      const pf = await gh(env, `/repos/${owner}/${repo}/contents/public/data/people.json?ref=${branch}`);
      const data = JSON.parse(b64ToText(pf.content));
      log = applyProposal(data, prop);
      tree.push({
        path: 'public/data/people.json', mode: '100644', type: 'blob',
        sha: (await gh(env, `/repos/${owner}/${repo}/git/blobs`, 'POST',
          { content: textToB64(JSON.stringify(data, null, 2) + '\n'), encoding: 'base64' })).sha,
      });

      // 大頭照從 proposals/avatars/ 搬到 public/avatars/（網站才讀得到）
      if (prop.changes && prop.changes.avatarImg) {
        const src = prop.changes.avatarImg;
        const img = await gh(env, `/repos/${owner}/${repo}/contents/${encodeURIComponent(src)}?ref=${branch}`);
        if (img) {
          tree.push({
            path: 'public/' + src.replace(/^proposals\//, 'avatars/'),
            mode: '100644', type: 'blob',
            sha: (await gh(env, `/repos/${owner}/${repo}/git/blobs`, 'POST', { content: img.content, encoding: 'base64' })).sha,
          });
          tree.push({ path: src, mode: '100644', type: 'blob', sha: null }); // 刪掉暫存的
        }
      }
    } else if (prop.changes && prop.changes.avatarImg) {
      tree.push({ path: prop.changes.avatarImg, mode: '100644', type: 'blob', sha: null });
    }

    // 處理完就把提案刪掉（sha: null = 刪除）
    tree.push({ path: `proposals/${id}.json`, mode: '100644', type: 'blob', sha: null });

    const newTree = await gh(env, `/repos/${owner}/${repo}/git/trees`, 'POST', { base_tree: baseCommit.tree.sha, tree });
    const msg = action === 'approve'
      ? `feat(族譜): 採用 ${prop.submittedBy} 的修正 — ${log.join('、') || prop.targetName} [skip ci]`
      : `chore(族譜): 退回 ${prop.submittedBy} 對「${prop.targetName}」的修正 [skip ci]`;
    const commit = await gh(env, `/repos/${owner}/${repo}/git/commits`, 'POST', {
      message: msg, tree: newTree.sha, parents: [baseSha],
    });
    await gh(env, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, 'PATCH', { sha: commit.sha });

    return json({ ok: true, action, log });
  } catch (err) {
    console.error(err);
    return json({ error: String(err.message || err).slice(0, 200) }, 500);
  }
}
