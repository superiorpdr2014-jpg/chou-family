/*
 * 直接從 GitHub 讀最新的 people.json — Cloudflare Pages Function
 *
 * 為什麼需要這支：
 * people.json 是靜態檔，Jay 核准修正後雖然馬上寫進 GitHub，但網站要等
 * Cloudflare 重新部署（2~4 分鐘）才會更新。Jay 希望核准完馬上看得到。
 *
 * 這支繞過部署，直接跟 GitHub 要最新的。前端的用法是「靜態檔先顯示、
 * 這支在背景抓最新版蓋掉」，所以畫面不會因為多這一次請求而變慢。
 *
 * 快取 20 秒：家人同時開網站時不會每個人都打一次 GitHub API
 * （API 有 5000 次/小時的限制），但又夠即時。
 */

const CACHE_SECONDS = 20;

// 跟 _middleware.js / login.js 同一套 session 驗證（含名字的資料要登入才給）
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sign(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return b64url(new Uint8Array(sig));
}
async function validSession(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)chou_sess=([^;]+)/);
  if (!m) return false;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig || sig !== (await sign(env.ADMIN_PASSWORD, payload))) return false;
  try {
    const d = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
    return d.exp > Date.now();
  } catch { return false; }
}

export async function onRequestGet({ env, request }) {
  if (!env.GH_TOKEN || !env.GH_REPO) {
    return new Response(JSON.stringify({ error: 'not configured' }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  }
  if (!(await validSession(request, env))) {
    return new Response(JSON.stringify({ error: 'need login' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
  }

  // Cloudflare 邊緣快取：同一個地區的家人共用，20 秒內只打一次 GitHub
  const cache = caches.default;
  const key = new Request(new URL('/api/people', request.url).toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;

  const [owner, repo] = String(env.GH_REPO).split('/');
  const branch = env.GH_BRANCH || 'main';

  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/public/data/people.json?ref=${branch}`,
      {
        headers: {
          authorization: `Bearer ${env.GH_TOKEN}`,
          accept: 'application/vnd.github.raw',   // 直接要原始內容，不用自己解 base64
          'user-agent': 'chou-family-album',
        },
      }
    );
    if (!res.ok) throw new Error('GitHub ' + res.status);

    const body = await res.text();
    const out = new Response(body, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': `public, max-age=${CACHE_SECONDS}`,
      },
    });
    await cache.put(key, out.clone());
    return out;
  } catch (err) {
    // GitHub 掛了或額度用完 → 讓前端自己退回用靜態檔，不要整個族譜消失
    return new Response(JSON.stringify({ error: String(err.message || err) }), {
      status: 502, headers: { 'content-type': 'application/json' },
    });
  }
}
