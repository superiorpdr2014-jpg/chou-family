/*
 * 刪除一張照片 — Cloudflare Pages Function（只有管理員能用）
 *
 * 為什麼要管理員密碼、不走家人提案流程：刪照片是不可逆的破壞性動作，
 * 跟改名字不一樣。沿用審核頁那把 ADMIN_PASSWORD，等於只有 Jay 能刪。
 *
 * 做兩件事：
 *   1. 一個 commit：從 albums.json 拿掉這張、順手修正張數與封面，
 *      並刪掉 o/w/t 三個圖檔。這個 commit 沒有 [skip ci]，
 *      所以 Cloudflare 會重新部署 → 相簿裡「馬上」看不到這張。
 *   2. 盡力觸發 ingest 這個 GitHub Actions 重建 faces.json/faces.bin
 *      （把這張臉的特徵值也清掉，否則「找出我的照片」還會比對到已刪的照片）。
 *      重建那套索引很麻煩，交給 build.js 做最穩，不在這裡自己重編。
 *      觸發失敗（權杖沒有 actions 權限）也沒關係，相簿本身已經正確，
 *      只是臉部索引晚點才乾淨。
 *
 * 需要的環境變數：ADMIN_PASSWORD、GH_TOKEN、GH_REPO、GH_BRANCH(可省)。
 */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

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
  if (!res.ok) throw new Error(`GitHub ${method} ${url} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const b64ToText = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.ADMIN_PASSWORD || !env.GH_TOKEN || !env.GH_REPO) {
      return json({ error: '網站還沒設定好' }, 500);
    }
    const body = await request.json();
    if (!safeEqual(String(body.password || ''), String(env.ADMIN_PASSWORD))) {
      return json({ error: '管理員密碼不對' }, 401);
    }

    // 允許中文：build.js 遇到怪年份會用相簿名當 id（含中文），這種也要能刪
    const albumId = String(body.albumId || '').replace(/[^a-zA-Z0-9一-鿿-]/g, '').slice(0, 60);
    const name = String(body.name || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    if (!albumId || !name) return json({ error: '沒有指定要刪哪張照片' }, 400);

    const [owner, repo] = String(env.GH_REPO).split('/');
    const branch = env.GH_BRANCH || 'main';

    // 讀 albums.json
    const af = await gh(env, `/repos/${owner}/${repo}/contents/public/data/albums.json?ref=${branch}`);
    if (!af) return json({ error: '讀不到相簿資料' }, 500);
    const albums = JSON.parse(b64ToText(af.content));

    const album = (albums.albums || []).find((a) => a.id === albumId);
    if (!album) return json({ error: '找不到這本相簿' }, 404);
    const photo = (album.photos || []).find((p) => p.name === name);
    if (!photo) return json({ error: '這張照片已經不在了' }, 404);

    // 要刪的圖檔（albums.json 的路徑相對於 public/，repo 裡要加 public/ 前綴）
    const filesToDelete = [photo.o, photo.w, photo.t]
      .filter(Boolean)
      .map((rel) => 'public/' + rel.replace(/^public\//, ''));

    // 從相簿拿掉這張
    album.photos = album.photos.filter((p) => p.name !== name);
    album.count = album.photos.length;
    // 重算封面：優先挑人臉最多的（跟 build.js 一致）
    let cover = album.photos[0];
    for (const p of album.photos) if ((p.nf || 0) > (cover ? cover.nf || 0 : 0)) cover = p;
    album.cover = cover ? cover.t : null;
    // 相簿空了就整本移除（build.js 也會濾掉 count=0 的）
    if (!album.photos.length) {
      albums.albums = albums.albums.filter((a) => a.id !== albumId);
    }

    // 組一個 commit：更新 albums.json + 刪掉三個圖檔
    const ref = await gh(env, `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
    const baseSha = ref.object.sha;
    const baseCommit = await gh(env, `/repos/${owner}/${repo}/git/commits/${baseSha}`);

    const blob = await gh(env, `/repos/${owner}/${repo}/git/blobs`, 'POST', {
      content: toBase64(new TextEncoder().encode(JSON.stringify(albums))), encoding: 'base64',
    });
    const tree = [{ path: 'public/data/albums.json', mode: '100644', type: 'blob', sha: blob.sha }];
    for (const path of filesToDelete) tree.push({ path, mode: '100644', type: 'blob', sha: null }); // sha:null = 刪除

    const newTree = await gh(env, `/repos/${owner}/${repo}/git/trees`, 'POST', { base_tree: baseCommit.tree.sha, tree });
    // ⚠️ 不要放 [skip ci]，否則 Cloudflare 不會重新部署，相簿不會更新
    const commit = await gh(env, `/repos/${owner}/${repo}/git/commits`, 'POST', {
      message: `photo: 刪除「${album.title || albumId}」的一張照片`,
      tree: newTree.sha, parents: [baseSha],
    });
    await gh(env, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, 'PATCH', { sha: commit.sha });

    // 盡力重建臉部索引（失敗不影響相簿已經正確這件事）
    let reindex = 'requested';
    try {
      const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/ingest.yml/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.GH_TOKEN}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'chou-family-album',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ref: branch }),
      });
      if (!r.ok) reindex = 'skipped';
    } catch { reindex = 'skipped'; }

    return json({ ok: true, albumEmptied: !album.photos.length, reindex });
  } catch (err) {
    return json({ error: '刪除失敗：' + (err.message || String(err)).slice(0, 200) }, 500);
  }
}
