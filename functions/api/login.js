/*
 * 家族登入 — Cloudflare Pages Function
 *
 * 三道驗證（光有密碼不夠，要證明真的是家人）：
 *   1. 家族密碼 = FAMILY_PASSWORD
 *   2. 自己的名字在族譜裡
 *   3. 爸媽擇一的名字對得上（族譜上沒父母的，可用另一半或小孩）
 *
 * 通過 → 發一個簽章過的 session cookie（HttpOnly，30 天），
 * 之後 /data/people.json、/api/people 這些含名字的資料才讀得到。
 *
 * 用意：就算網址外流，陌生人也只看到登入頁，拿不到家族的名字與親屬關係
 * （這正是詐騙會拿來用的資料）。
 */

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });

function safeEqual(a, b) {
  const ea = new TextEncoder().encode(String(a)), eb = new TextEncoder().encode(String(b));
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

const cleanName = (s) => String(s || '').replace(/[\x00-\x1f\x7f<>]/g, '').trim().slice(0, 30);

// —— session cookie 簽章（跟 _middleware.js 用同一套） ——
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
async function validSession(request, env) { return !!(await readSession(request, env)); }

async function loadPeople(env) {
  const [owner, repo] = String(env.GH_REPO).split('/');
  const branch = env.GH_BRANCH || 'main';
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/public/data/people.json?ref=${branch}`,
    { headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github.raw', 'user-agent': 'chou-family-album' } }
  );
  if (!res.ok) throw new Error('讀取族譜失敗');
  return JSON.parse(await res.text());
}

// GET /api/login → 我登入了嗎？（前端 main() 用它決定要不要顯示登入頁）
export async function onRequestGet({ request, env }) {
  // ?logout=1 → 清掉 cookie 登出
  if (new URL(request.url).searchParams.get('logout')) {
    return json({ ok: false, loggedOut: true }, 200, {
      'set-cookie': 'chou_sess=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    });
  }
  const sess = await readSession(request, env);
  return json({ ok: !!sess, who: sess ? sess.who : null });
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.FAMILY_PASSWORD || !env.ADMIN_PASSWORD || !env.GH_TOKEN || !env.GH_REPO) {
      return json({ error: '網站還沒設定好' }, 500);
    }
    const form = await request.formData();
    const pw = String(form.get('password') || '');
    const name = cleanName(form.get('name'));
    const relative = cleanName(form.get('relative'));

    if (!safeEqual(pw, env.FAMILY_PASSWORD)) return json({ error: '家族密碼不對' }, 401);
    if (!name) return json({ error: '請輸入你的名字' }, 400);
    if (!relative) return json({ error: '請在第二格填一位家人的名字（父母／另一半／小孩皆可）' }, 400);

    const data = await loadPeople(env);
    const people = data.people || [];
    const byId = new Map(people.map((p) => [p.id, p]));

    const person = people.find((p) => p.name === name);
    if (!person) {
      return json({ error: `族譜裡找不到「${name}」。請確認名字寫法，或請管理員把你加進族譜。` }, 403);
    }

    /*
     * 第二格：填「你的配偶姓名」；沒有配偶就填「爸爸或媽媽的姓名」。
     * 這樣嫁進／娶進周家的人也進得來——他們的配偶一定在族譜裡（原本硬要填自己父母，
     * 但他們父母不在族譜、又看不到族譜，就被卡死了，這是 Jay 回報的問題）。
     */
    const spouseNames = (person.spouse || []).map((id) => byId.get(id)).filter(Boolean).map((p) => p.name);
    const parentNames = (person.parents || []).map((id) => byId.get(id)).filter(Boolean).map((p) => p.name);
    const accept = [...spouseNames, ...parentNames];
    if (accept.length) {
      if (!accept.includes(relative)) {
        return json({ error: '第二格對不上。請填「你的配偶姓名」；沒有配偶的話，填你爸爸或媽媽的姓名。' }, 403);
      }
    } else {
      // 極少數：配偶和父母都不在族譜 → 放寬成「填另一位在族譜的家人」，才不會被鎖在外面
      if (relative === name || !people.some((p) => p.name === relative)) {
        return json({ error: '第二格請填一位在族譜裡的周家家人名字（跟你自己不同名）。' }, 403);
      }
    }

    // 發 session cookie
    const exp = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const payload = b64url(new TextEncoder().encode(JSON.stringify({ exp, who: name })));
    const sig = await sign(env.ADMIN_PASSWORD, payload);
    const cookie = `chou_sess=${payload}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`;

    return json({ ok: true, who: name }, 200, { 'set-cookie': cookie });
  } catch (err) {
    return json({ error: String(err.message || err).slice(0, 200) }, 500);
  }
}
