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
    const imgPath = c.avatarImg.replace(/^proposals\/avatars\//, 'avatars/');
    person.avatar = { img: imgPath };
    log.push('換了大頭照');
    // 有抓到人臉特徵值 → 加進 refs，讓他能在相簿裡被自動認出來。
    // 存成 {img, d}：matchPhotos 只吃 .d，avatar 顯示走 .img，兩者相容。
    if (c.faceDescriptor) {
      person.refs = person.refs || [];
      person.refs.push({ img: imgPath, d: c.faceDescriptor });
      log.push('（可自動辨識相簿）');
    }
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

  // 解除婚姻關係：兩邊都要拿掉，不然樹上會一邊有一邊沒有
  if (c.removeSpouse) {
    const ex = people.find((p) => p.id === c.removeSpouse);
    person.spouse = (person.spouse || []).filter((id) => id !== c.removeSpouse);
    if (ex) {
      ex.spouse = (ex.spouse || []).filter((id) => id !== person.id);
      log.push(`${person.name} 與 ${ex.name} 解除婚姻關係`);
    }
  }

  /*
   * 移除整個人。要一併清乾淨所有指向他的關係，否則樹會壞掉：
   *   - 別人的 spouse 還指著他 → 配偶不對稱
   *   - 小孩的 parents 還指著他 → 找不到父母、整房變孤兒
   * 小孩本身不刪（他們是真實存在的家人），只是父母欄位少掉這個人。
   */
  if (c.removePerson) {
    const gone = person.name;
    for (const p of people) {
      if (p === person) continue;
      if ((p.spouse || []).includes(person.id)) p.spouse = p.spouse.filter((id) => id !== person.id);
      if ((p.parents || []).includes(person.id)) p.parents = p.parents.filter((id) => id !== person.id);
    }
    const i = people.indexOf(person);
    people.splice(i, 1);
    log.push(`把 ${gone} 從族譜移除`);
    return log; // 人都沒了，後面不用再動他
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
            path: 'public/' + src.replace(/^proposals\/avatars\//, 'avatars/'),
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
    /*
     * ⚠️ 絕對不要在核准的 commit 訊息裡放 [skip ci]。
     * 我本來加它是為了不要觸發 GitHub Actions，但 Cloudflare Pages 也認這個標記，
     * 結果是：族譜資料正確寫進 GitHub 了，網站卻永遠不會更新。
     * Jay 改了三次名字都「沒有變」就是這個原因 —— 他每次都改對了，是網站沒重新部署。
     *
     * 而且本來就不需要擋：ingest workflow 只在 incoming/ 有變動時才跑，
     * 核准只動 public/data 和 public/avatars，根本不會觸發它。
     */
    const msg = action === 'approve'
      ? `feat(族譜): 採用 ${prop.submittedBy} 的修正 — ${log.join('、') || prop.targetName}`
      : `chore(族譜): 退回 ${prop.submittedBy} 對「${prop.targetName}」的修正`;
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
