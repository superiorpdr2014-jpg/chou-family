/*
 * 家人提出族譜修正 — Cloudflare Pages Function
 *
 * 家人不能直接改族譜，只能「提案」：這裡把提案 commit 到 GitHub 的 proposals/，
 * Jay 在 ?admin 的待審頁看過、按核准，才會真的套用到 people.json。
 * 族譜是家族紀錄，改錯輩分很難發現也很難救，所以要有人把關。
 *
 * 需要的環境變數跟 upload.js 一樣：FAMILY_PASSWORD / GH_TOKEN / GH_REPO / GH_BRANCH
 */

const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

function safeEqual(a, b) {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

function sniffImage(bytes) {
  const b = new Uint8Array(bytes);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return '.png';
  const ascii = (i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return '.webp';
  if (ascii(4, 'ftyp')) return '.heic';
  return null;
}

/** 人名：擋掉控制字元和標記語法，中文要留著 */
function cleanName(s) {
  return String(s || '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 20);
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
  if (!res.ok) throw new Error(`GitHub ${method} ${url} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.FAMILY_PASSWORD || !env.GH_TOKEN || !env.GH_REPO) {
      return json({ error: '網站還沒設定好，請聯絡管理員。' }, 500);
    }
    const form = await request.formData();
    if (!safeEqual(String(form.get('password') || ''), String(env.FAMILY_PASSWORD))) {
      return json({ error: '密碼不對' }, 401);
    }

    const target = String(form.get('target') || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 60);
    if (!target) return json({ error: '不知道要改誰' }, 400);

    const submittedBy = cleanName(form.get('submittedBy')) || '家人';
    const changes = {};
    const name = cleanName(form.get('name'));
    if (name) changes.name = name;

    const addSpouse = cleanName(form.get('addSpouse'));
    if (addSpouse) changes.addSpouse = addSpouse;

    const kidsRaw = form.get('addChildren');
    if (kidsRaw) {
      try {
        const kids = JSON.parse(String(kidsRaw)).map(cleanName).filter(Boolean).slice(0, 12);
        if (kids.length) changes.addChildren = kids;
      } catch { /* 格式壞掉就當沒填 */ }
    }

    // 解除婚姻關係（離婚／分開）
    const removeSpouse = String(form.get('removeSpouse') || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 60);
    if (removeSpouse) changes.removeSpouse = removeSpouse;

    // 整個人移除
    if (form.get('removePerson')) changes.removePerson = true;

    // 在照片上標記人臉：把某張已偵測到的臉指定給這個人。
    // ref = { p: 照片路徑, b: 臉框, d: 128 維特徵值 } —— 位置和特徵值前端都已備好。
    const tagRaw = form.get('tagRef');
    if (tagRaw) {
      try {
        const t = JSON.parse(String(tagRaw));
        if (t && typeof t.p === 'string' && Array.isArray(t.b) && t.b.length === 4
            && Array.isArray(t.d) && t.d.length === 128 && t.d.every((n) => typeof n === 'number')) {
          changes.tagRef = { p: t.p.slice(0, 200), b: t.b.map(Number), d: t.d };
        }
      } catch { /* 壞掉就當沒有 */ }
    }

    // 提案編號：時間戳只是為了排序好看，隨機碼才是避免撞號的關鍵
    const rand = Math.random().toString(36).slice(2, 8);
    const id = `${Date.now()}-${rand}`;

    const files = [];
    const avatar = form.get('avatar');
    if (avatar && avatar.arrayBuffer) {
      const buf = await avatar.arrayBuffer();
      if (buf.byteLength > MAX_AVATAR_BYTES) return json({ error: '大頭照超過 8MB' }, 400);
      const ext = sniffImage(buf.slice(0, 16));
      if (!ext) return json({ error: '大頭照看起來不是圖片' }, 400);
      const path = `proposals/avatars/${id}${ext}`;
      files.push({ path, content: toBase64(buf) });
      changes.avatarImg = path;

      // 前端在瀏覽器裡對裁切後的臉算好的 128 維特徵值，
      // 核准後會加進這個人的 refs，讓他能在相簿裡被自動認出來
      const desc = form.get('faceDescriptor');
      if (desc) {
        try {
          const arr = JSON.parse(String(desc));
          if (Array.isArray(arr) && arr.length === 128 && arr.every((n) => typeof n === 'number')) {
            changes.faceDescriptor = arr;
          }
        } catch { /* 壞掉就當沒有，大頭照還是會換 */ }
      }
    }

    if (!Object.keys(changes).length) return json({ error: '沒有填任何要改的東西' }, 400);

    const proposal = {
      id, target,
      targetName: cleanName(form.get('targetName')),
      submittedBy,
      submittedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      changes,
    };
    files.push({
      path: `proposals/${id}.json`,
      content: toBase64(new TextEncoder().encode(JSON.stringify(proposal, null, 2))),
    });

    // 一次 commit（提案 JSON + 大頭照）
    const [owner, repo] = String(env.GH_REPO).split('/');
    const branch = env.GH_BRANCH || 'main';
    const ref = await gh(env, `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
    const baseSha = ref.object.sha;
    const baseCommit = await gh(env, `/repos/${owner}/${repo}/git/commits/${baseSha}`);

    const tree = [];
    for (const f of files) {
      const blob = await gh(env, `/repos/${owner}/${repo}/git/blobs`, 'POST', { content: f.content, encoding: 'base64' });
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const newTree = await gh(env, `/repos/${owner}/${repo}/git/trees`, 'POST', { base_tree: baseCommit.tree.sha, tree });
    const commit = await gh(env, `/repos/${owner}/${repo}/git/commits`, 'POST', {
      /*
       * 這裡的 [skip ci] 是對的：提案只是躺在 proposals/，網站內容沒變，不用重新部署。
       * ⚠️ 但核准那支(review.js)絕對不能放 —— Cloudflare Pages 也認這個標記，
       *    放了就會「資料寫進去了、網站卻不更新」。踩過一次了。
       */
      message: `proposal: ${submittedBy} 提議修正「${proposal.targetName || target}」 [skip ci]`,
      tree: newTree.sha,
      parents: [baseSha],
    });
    await gh(env, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, 'PATCH', { sha: commit.sha });

    return json({ ok: true, id });
  } catch (err) {
    console.error(err);
    return json({ error: '送出失敗：' + (err.message || String(err)).slice(0, 200) }, 500);
  }
}
