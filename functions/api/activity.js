/*
 * 家人動態記錄（後台）— Cloudflare Pages Function（只有管理員能看）
 *
 * 不用另外做一套 log：家人的每個動作本來就會變成一筆 git commit，訊息裡有「誰做了什麼」。
 * 這支就是讀 GitHub 的 commit 歷史，解析成好讀的動態清單。連過去的動作都涵蓋到。
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

/** 把一行 commit 訊息解析成 { icon, who, text, system } */
function parse(msg) {
  msg = msg.replace(/\s*\[skip ci\]\s*$/, '').trim();
  let m;
  if ((m = msg.match(/^tag:\s*(.+?)\s*標記\s*(.+?)\s*的臉/)))
    return { icon: '🏷️', who: m[1], text: `標記了一張 ${m[2]} 的臉` };
  if ((m = msg.match(/^proposal:\s*(.+?)\s*提議(.+)$/)))
    return { icon: '✏️', who: m[1], text: `提議${m[2]}`, pending: true };
  if ((m = msg.match(/^feat\(族譜\):\s*採用\s*(.+?)\s*的修正\s*—\s*(.+)$/)))
    return { icon: '✅', who: '管理員', text: `採用了 ${m[1]} 的修正：${m[2]}` };
  if ((m = msg.match(/^chore\(族譜\):\s*退回\s*(.+?)\s*對「(.+?)」/)))
    return { icon: '↩️', who: '管理員', text: `退回了 ${m[1]} 對「${m[2]}」的修正` };
  if ((m = msg.match(/^interactions:\s*(.+?)\s*(收回愛心|愛心|留言|刪留言)/))) {
    const map = { '愛心': '按了愛心', '收回愛心': '收回了愛心', '留言': '留言了', '刪留言': '刪了一則留言' };
    return { icon: m[2].includes('愛心') ? '❤️' : '💬', who: m[1], text: map[m[2]] || m[2] };
  }
  if ((m = msg.match(/^events:\s*(.+?)\s*(新增聚會|回覆出席\(含家人\)|回覆出席|刪除聚會)/))) {
    const map = { '新增聚會': '新增了一場聚會', '回覆出席': '回覆了出席', '回覆出席(含家人)': '幫全家回覆了出席', '刪除聚會': '刪除了一場聚會' };
    return { icon: '📣', who: m[1], text: map[m[2]] || m[2] };
  }
  if ((m = msg.match(/^photos:\s*(.+?)\s*上傳了\s*(\d+)\s*張到「(.+?)」/)))
    return { icon: '📷', who: m[1], text: `上傳了 ${m[2]} 張照片到「${m[3]}」` };
  if ((m = msg.match(/^photo:\s*刪除「(.+?)」的一張照片/)))
    return { icon: '🗑️', who: '管理員', text: `刪除了「${m[1]}」的一張照片` };
  if (/^feat\(chou|^tweak\(chou|^fix\(chou|^chore:\s*re-trigger|^chore:\s*移除認人測試/.test(msg))
    return { icon: '🛠️', who: '網站', text: '網站功能更新', system: true };
  if (/收進.*重建|重建辨識|chore:\s*收進/.test(msg))
    return { icon: '⚙️', who: '系統', text: '收進新照片、重建人臉辨識', system: true };
  return { icon: '•', who: '', text: msg, system: true };
}

export async function onRequestGet({ request, env }) {
  if (!env.ADMIN_PASSWORD || !env.GH_TOKEN || !env.GH_REPO) return json({ error: '網站還沒設定好' }, 500);
  const pw = new URL(request.url).searchParams.get('password') || '';
  if (!safeEqual(pw, String(env.ADMIN_PASSWORD))) return json({ error: '密碼不對' }, 401);

  const [owner, repo] = String(env.GH_REPO).split('/');
  const branch = env.GH_BRANCH || 'main';
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits?sha=${branch}&per_page=100`, {
      headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'chou-family-album' },
    });
    if (!res.ok) throw new Error('GitHub ' + res.status);
    const commits = await res.json();
    const items = commits.map((c) => {
      const first = String(c.commit.message || '').split('\n')[0];
      const p = parse(first);
      return { sha: c.sha.slice(0, 7), date: c.commit.author.date, ...p };
    });
    return json({ items });
  } catch (err) {
    return json({ error: String(err.message || err).slice(0, 160) }, 502);
  }
}
