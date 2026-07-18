/*
 * 守門：/data/people.json 含全家族的名字與親屬關係，只有登入過的人才能讀。
 *
 * 這支只跑在 /data/* 路徑（Cloudflare Pages 目錄式 middleware），
 * 所以不會拖慢照片載入。faces.json / faces.bin 不含名字，放行。
 *
 * 沒登入去讀 people.json → 401，前端會顯示登入頁。
 */

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sign(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return b64url(new Uint8Array(sig));
}

export async function validSession(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)chou_sess=([^;]+)/);
  if (!m) return false;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return false;
  if (sig !== (await sign(env.ADMIN_PASSWORD, payload))) return false;
  try {
    const d = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
    return d.exp > Date.now();
  } catch { return false; }
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  if (url.pathname === '/data/people.json') {
    if (!(await validSession(request, env))) {
      return new Response(JSON.stringify({ error: 'need login' }), {
        status: 401, headers: { 'content-type': 'application/json' },
      });
    }
  }
  return next();
}
