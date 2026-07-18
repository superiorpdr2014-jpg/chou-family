/*
 * 周氏大家族的點點滴滴
 *
 * 全部在瀏覽器裡跑，沒有後端。人臉特徵值在建置時就算好存成 faces.bin，
 * 使用者上傳照片時只在自己的手機/電腦上算特徵值再比對，照片不會傳到任何伺服器。
 */

/* ============ 設定 ============ */

/*
 * 歐氏距離門檻：越小越嚴格。
 *
 * 這幾個數字是實測出來的（scripts/probe.js + 人眼檢查比對結果），不是抄預設值。
 *
 * face-api 官方建議 0.6，但那是給高解析度正面照用的。我們的照片是 LINE 壓過的
 * （原圖只有 1478px 寬），實測結果：
 *   0.40 以內  → 幾乎都是同一個人
 *   0.40~0.46 → 開始混進小孩、老先生、其他中年女性（而且都是大臉，不是糊掉的小臉，
 *               純粹是模型在這種畫質下的鑑別極限）
 *   0.46 以上  → 比對到的是「長相類型」而不是身分
 * 一家人本來就長得像，混淆比一般情況更嚴重，所以門檻壓得比官方建議低很多。
 */
const STRICTNESS = {
  strict: { label: '嚴格', value: 0.35, note: '幾乎不會認錯，但會漏掉一些' },
  normal: { label: '標準', value: 0.40, note: '建議值' },
  loose: { label: '寬鬆', value: 0.46, note: '找得多，但會混到長得像的親人' },
};

// 「可能是你」的緩衝帶：超過門檻但還在這個範圍內的，另外列出讓人自己判斷
const MAYBE_BAND = 0.07;

/*
 * 臉越小，特徵值噪音越大，就要越近才算數。
 * 不這樣做的話，合照裡 40px 的糊臉會跟每個人都「很像」，整個比對就廢了。
 */
function sizePenalty(px) {
  if (px < 64) return 0.08;
  if (px < 88) return 0.04;
  return 0;
}

// 拿來當「這是我」的基準臉，品質要夠，不然找出來的都是垃圾
const REF_MIN_PX = 70;
const REF_MIN_SCORE = 0.6;

const MODEL_URL = 'models';
const IS_ADMIN = new URLSearchParams(location.search).has('admin');

/* ============ 狀態 ============ */

const S = {
  albums: null,      // albums.json
  faces: null,       // faces.json
  desc: null,        // Float32Array，全部特徵值接在一起
  people: [],        // people.json 的名冊
  photoAlbum: {},    // 全域照片索引 → album 物件
  modelsReady: false,
  modelsLoading: null,
  // 找自己用
  finder: { faces: [], picked: new Set(), image: null },
  strictness: 'normal',
  // 燈箱用
  lb: { list: [], idx: 0, showFaces: false },
  // 管理模式草稿
  draft: loadDraft(),
  // 我是誰（登入的名字）＋互動資料
  me: null,
  interactions: {},   // "相簿id/name" → { h:[名字], c:[{id,by,text,at}] }
  events: null,
};

/** 這張照片的互動 key（跨重建穩定） */
function photoKey(pi) {
  const photo = S.faces.photos[pi];
  if (!photo) return null;
  const m = (photo.w || photo.t || '').match(/\/([^/]+)\.webp$/);
  return m ? `${photo.a}/${m[1]}` : null;
}

/* ============ 小工具 ============ */

const $ = (sel) => document.querySelector(sel);
const view = () => $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

function fmtDate(d) {
  if (!d) return '';
  const p = d.split('-');
  return p.length === 3 ? `${p[0]}.${p[1]}.${p[2]}` : p.join('.');
}

/** 取第 i 張臉的 128 維特徵值 */
function descAt(i) {
  return S.desc.subarray(i * 128, i * 128 + 128);
}

function distance(a, b) {
  let sum = 0;
  for (let i = 0; i < 128; i++) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum);
}

function loadDraft() {
  try { return JSON.parse(localStorage.getItem('chou-draft') || '{"people":[]}'); }
  catch { return { people: [] }; }
}
function saveDraft() {
  localStorage.setItem('chou-draft', JSON.stringify(S.draft));
}

/* ============ 資料載入 ============ */

async function loadData() {
  // no-cache = 每次跟伺服器確認有沒有新版；沒變就回 304，不會真的重傳。
  // 不這樣做的話，新增相簿或改了族譜，家人的瀏覽器會一直顯示舊的，
  // 而且他們根本不知道要清快取。
  const get = (url) => fetch(url, { cache: 'no-cache' });
  const [albums, faces, binBuf, peopleRes] = await Promise.all([
    get('data/albums.json').then((r) => r.json()),
    get('data/faces.json').then((r) => r.json()),
    get('data/faces.bin').then((r) => r.arrayBuffer()),
    get('data/people.json'),
  ]);
  // people.json 有登入牆守著，session 過期會回 401 → 退回登入頁
  if (peopleRes.status === 401) { const e = new Error('need login'); e.needLogin = true; throw e; }
  const people = await peopleRes.json().catch(() => ({ people: [] }));
  S.albums = albums;
  S.faces = faces;
  S.desc = new Float32Array(binBuf);
  S.people = people.people || [];

  // 管理模式下把還沒 commit 的草稿疊上去，方便繼續標
  if (IS_ADMIN && S.draft.people.length) {
    const byName = new Map(S.people.map((p) => [p.name, p]));
    for (const dp of S.draft.people) {
      const ex = byName.get(dp.name);
      if (ex) ex.refs = [...ex.refs, ...dp.refs];
      else S.people.push(dp);
    }
  }

  for (const a of albums.albums) for (const p of a.photos) S.photoAlbum[p.i] = a;

  // 互動資料（愛心/留言）＋聚會——失敗就當空的，不影響看照片
  try {
    const ir = await fetch('/api/interactions', { cache: 'no-cache' });
    if (ir.ok) S.interactions = await ir.json();
  } catch { /* 沒關係 */ }
  try {
    const er = await fetch('/api/events', { cache: 'no-cache' });
    if (er.ok) S.events = (await er.json()).events || [];
  } catch { /* 沒關係 */ }

  const totalFaces = faces.count;
  $('#footer-stats').textContent =
    `${albums.albums.length} 本相簿 · ${faces.photos.length} 張照片 · 辨識出 ${totalFaces} 張人臉`;

  refreshPeopleInBackground();
}

/*
 * 靜態的 people.json 要等 Cloudflare 重新部署（2~4 分）才會更新，
 * 但 Jay 核准修正後希望馬上看得到。所以：
 *   靜態檔先畫（快，走 CDN）→ 背景跟 GitHub 要最新的 → 真的有變才重畫。
 * 這樣畫面不會因為多這一次請求而變慢，但幾秒內就會跟上最新資料。
 * /api/people 掛了就當作沒事發生，繼續用靜態檔 —— 族譜不能因此消失。
 */
async function refreshPeopleInBackground() {
  try {
    const res = await fetch('/api/people', { cache: 'no-store' });
    if (!res.ok) return;
    const fresh = await res.json();
    if (!fresh.people || !fresh.people.length) return;

    const same = JSON.stringify(fresh.people.map((p) => [p.id, p.name, p.spouse, p.parents, p.avatar]))
      === JSON.stringify(S.people.map((p) => [p.id, p.name, p.spouse, p.parents, p.avatar]));
    if (same) return;

    S.people = fresh.people;
    // 只有正在看族譜/人物頁時才需要重畫，其他頁重畫會打斷使用者
    const page = location.hash.replace(/^#\/?/, '').split('/')[0];
    if (page === 'people' || page === 'tree' || page === 'person') route();
  } catch { /* 網路或 GitHub 出問題就算了，靜態檔還在 */ }
}

/** 人臉模型很大（約 12MB），只有真的要辨識時才載 */
async function ensureModels(onProgress) {
  if (S.modelsReady) return;
  if (S.modelsLoading) return S.modelsLoading;
  S.modelsLoading = (async () => {
    onProgress && onProgress('載入人臉辨識模型…');
    await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    S.modelsReady = true;
  })();
  return S.modelsLoading;
}

/* ============ 人臉比對 ============ */

/**
 * 拿參考特徵值去比對全部照片
 * @param {Float32Array[]} refs 參考人臉（可多張，取最近的那張算）
 * @param {number} threshold 基準門檻，實際門檻會依臉的大小再收緊
 * @param {boolean} includeMaybe 要不要一起帶回「可能是你」的
 * @returns [{photo, dist, album, faceIdx, tier}] 依相似度排序
 */
function matchPhotos(refs, threshold, includeMaybe = false) {
  const best = new Map(); // photoIdx → {margin, dist, faceIdx}
  for (let i = 0; i < S.faces.faces.length; i++) {
    const f = S.faces.faces[i];
    if (!f.q) continue; // 太小/太模糊的臉不參與比對

    const d = descAt(i);
    let min = Infinity;
    for (const r of refs) { const dist = distance(r, d); if (dist < min) min = dist; }

    const limit = threshold - sizePenalty(f.px);
    const margin = min - limit;           // <=0 代表確定，0~MAYBE_BAND 代表可能
    if (margin > (includeMaybe ? MAYBE_BAND : 0)) continue;

    const prev = best.get(f.p);
    if (!prev || margin < prev.margin) best.set(f.p, { margin, dist: min, faceIdx: i });
  }
  return [...best.entries()]
    .map(([p, v]) => ({
      photo: S.faces.photos[p], pi: p,
      dist: v.dist, margin: v.margin, faceIdx: v.faceIdx,
      tier: v.margin <= 0 ? 'sure' : 'maybe',
      album: S.photoAlbum[p],
    }))
    .sort((a, b) => a.margin - b.margin);
}

/** 把比對結果依相簿分組，照年代由新到舊 */
function groupByAlbum(matches) {
  const groups = new Map();
  for (const m of matches) {
    if (!m.album) continue;
    if (!groups.has(m.album.id)) groups.set(m.album.id, { album: m.album, items: [] });
    groups.get(m.album.id).items.push(m);
  }
  return [...groups.values()].sort((a, b) => (b.album.date || '').localeCompare(a.album.date || ''));
}

/** 從圖片裁出人臉小圖（含一點邊，看起來比較舒服） */
function cropFace(imgEl, box, size = 168) {
  const [x, y, w, h] = box;
  const iw = imgEl.naturalWidth || imgEl.width;
  const ih = imgEl.naturalHeight || imgEl.height;
  const pad = 0.35;
  const cx = (x + w / 2) * iw, cy = (y + h / 2) * ih;
  const side = Math.max(w * iw, h * ih) * (1 + pad);
  const sx = Math.max(0, cx - side / 2), sy = Math.max(0, cy - side / 2);
  const sw = Math.min(side, iw - sx), sh = Math.min(side, ih - sy);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.drawImage(imgEl, sx, sy, sw, sh, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.85);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('圖片載入失敗'));
    img.src = src;
  });
}

/* ============ 畫面：首頁 ============ */

function renderHome() {
  const albums = S.albums.albums;
  const totalPhotos = S.faces.photos.length;

  // 最近的聚會（2025 年起），每本挑人臉最多的那張＝大合照
  const recent = albums
    .filter((a) => a.date && a.date >= '2025-01-01')
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .map((a) => {
      const shot = a.photos.slice().sort((p, q) => (q.nf || 0) - (p.nf || 0))[0];
      return shot ? { album: a, photo: shot } : null;
    })
    .filter(Boolean);

  // 即將到來的聚會（沒填日期的也算「待定」照樣公佈），最近的排前面
  const t = new Date();
  const todayStr = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  const upcoming = (S.events || [])
    .filter((e) => !e.when || String(e.when).slice(0, 10) >= todayStr)
    .sort((a, b) => String(a.when || '9999').localeCompare(String(b.when || '9999')))
    .slice(0, 4);

  view().innerHTML = `
    <section class="home-banner">
      <img src="home-banner.jpg" alt="周氏大家族大合照">
      <div class="home-banner-cap">
        <h1>周氏大家族的點點滴滴</h1>
        <p>${albums.length} 本相簿、${totalPhotos} 張照片，記錄我們一起走過的日子。</p>
        <div class="hero-actions">
          <a class="hero-cta hero-cta-solid" href="#/people">尋找家人照片 →</a>
        </div>
      </div>
    </section>

    <div class="wrap" style="padding-top:0">
      <section class="findme">
        <div class="findme-emoji">🔍</div>
        <h2>找出自己的照片</h2>
        <p>上傳一張自己的照片，系統會自動比對每一本相簿，<br>找出每個時期、每場聚會裡有你的合影。</p>
        <a class="hero-cta hero-cta-solid" href="#/find">找出我的照片 →</a>
      </section>
    </div>

    ${upcoming.length ? `
    <div class="wrap" style="padding-top:0; padding-bottom:0">
      <div class="section-head" style="display:flex; justify-content:space-between; align-items:flex-end; gap:1rem; flex-wrap:wrap">
        <div>
          <h2>📣 即將到來的家族聚會</h2>
          <p>點進去回覆你會不會到</p>
        </div>
        <a class="btn btn-ghost btn-sm" href="#/board">看全部聚會 →</a>
      </div>
      <div class="upcoming">
        ${upcoming.map((ev) => {
          const yes = Object.values(ev.rsvps || {}).filter((s) => s === 'yes').length;
          return `<a class="upcoming-card" href="#/board">
            <div class="up-when">🗓️ ${esc(fmtEventWhen(ev.when) || '時間待定')}</div>
            <div class="up-title">${esc(ev.title)}</div>
            ${ev.where ? `<div class="up-where">📍 ${esc(ev.where)}</div>` : ''}
            <div class="up-rsvp">${yes ? `已有 ${yes} 位會到` : '還沒有人回覆'} · 點我回覆 →</div>
          </a>`;
        }).join('')}
      </div>
    </div>` : ''}

    ${recent.length ? `
    <div class="wrap" style="padding-bottom:0">
      <div class="section-head">
        <h2>最近的家族聚會</h2>
        <p>大家一起拍的大合照</p>
      </div>
      <div class="recent-shots">
        ${recent.map((r) => `
          <a class="recent-shot" href="#/album/${r.album.id}">
            <img src="${r.photo.w}" alt="${esc(r.album.title)}" loading="lazy">
            <div class="recent-cap">
              <span class="recent-date">${fmtDate(r.album.date)}</span>
              <span class="recent-title">${esc(r.album.title)}</span>
            </div>
          </a>`).join('')}
      </div>
    </div>` : ''}

    <section class="film-band" aria-label="家族影片">
      <div class="film-frame"><div id="yt-film"></div></div>
      <div class="film-fade film-fade-top"></div>
      <div class="film-fade film-fade-bottom"></div>
    </section>

    <div class="wrap">
      <div class="section-head" style="display:flex; justify-content:space-between; align-items:flex-end; gap:1rem; flex-wrap:wrap">
        <div>
          <h2>相簿</h2>
          <p>依時間排序，最新的在前面</p>
        </div>
        <a class="btn btn-ghost btn-sm" href="#/upload">＋ 上傳照片</a>
      </div>
      <div class="albums">
        ${albums.map((a) => `
          <a class="album-card" href="#/album/${a.id}">
            <div class="album-cover"><img src="${a.cover}" alt="${esc(a.title)}" loading="lazy"></div>
            <div class="album-body">
              <div class="album-date">${fmtDate(a.date)}</div>
              <div class="album-title">${esc(a.title)}</div>
              <div class="album-meta">${a.count} 張照片</div>
            </div>
          </a>`).join('')}
      </div>
    </div>`;

  mountFilmPlayer();
}

/*
 * 首頁影片：用 YouTube IFrame API 播，讓「每次循環都從 0:57 開始」。
 * 純 iframe 的 loop 一定從 0:00 起，做不到指定秒數循環，所以改用 API：
 * 影片播完(ENDED) → seekTo(57) 再 play。靜音才能自動播放。
 */
const FILM_START = 57;
function mountFilmPlayer() {
  if (!document.getElementById('yt-film')) return;
  const make = () => {
    const host = document.getElementById('yt-film');
    if (!host || !(window.YT && window.YT.Player)) return;
    if (S.ytPlayer) { try { S.ytPlayer.destroy(); } catch (e) {} }
    S.ytPlayer = new window.YT.Player('yt-film', {
      videoId: 'lb_ecsvOSOY',
      playerVars: {
        autoplay: 1, mute: 1, controls: 0, start: FILM_START,
        playsinline: 1, modestbranding: 1, rel: 0, disablekb: 1, fs: 0, showinfo: 0,
      },
      events: {
        onReady: (e) => { e.target.mute(); e.target.seekTo(FILM_START, true); e.target.playVideo(); },
        onStateChange: (e) => {
          if (e.data === window.YT.PlayerState.ENDED) { e.target.seekTo(FILM_START, true); e.target.playVideo(); }
        },
      },
    });
  };
  if (window.YT && window.YT.Player) { make(); return; }
  // API 還沒載入：載一次，載好會呼叫 onYouTubeIframeAPIReady
  window.onYouTubeIframeAPIReady = make;
  if (!document.getElementById('yt-api')) {
    const s = document.createElement('script');
    s.id = 'yt-api'; s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  }
}

/* ============ 畫面：單一相簿 ============ */

function renderAlbum(id) {
  const a = S.albums.albums.find((x) => x.id === id);
  if (!a) return renderNotFound();

  view().innerHTML = `
    <div class="wrap">
      <a class="back-link" href="#/">← 回到相簿</a>
      <div class="section-head" style="display:flex; justify-content:space-between; align-items:flex-end; gap:1rem; flex-wrap:wrap">
        <div>
          <div class="album-date">${fmtDate(a.date)}</div>
          <h2>${esc(a.title)}</h2>
          <p>${a.count} 張照片</p>
        </div>
        <span style="display:flex; gap:.5rem; flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" id="album-rename">✎ 改名稱</button>
          <a class="btn btn-sm" href="#/upload/${encodeURIComponent(a.id)}">＋ 加照片到這本</a>
          <button class="btn btn-ghost btn-sm" id="album-delete" style="color:#b3402f">🗑 申請刪除整本</button>
        </span>
      </div>
      <div class="grid" id="album-grid">
        ${a.photos.map((p, i) => `
          <button class="tile" data-i="${i}">
            <img src="${p.t}" alt="${esc(a.title)} ${i + 1}" loading="lazy">
            ${p.nf ? `<span class="tile-badge">${p.nf} 人</span>` : ''}
          </button>`).join('')}
      </div>
    </div>`;

  $('#album-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('.tile');
    if (btn) openLightbox(a.photos.map((p) => p.i), +btn.dataset.i);
  });
  $('#album-rename').addEventListener('click', () => openAlbumRename(a));
  $('#album-delete').addEventListener('click', () => openAlbumDeleteRequest(a));
}

/** 家人申請刪除整本相簿（走管理員核准流程） */
function openAlbumDeleteRequest(album) {
  showFaceSheet(`
    <h3>申請刪除整本「${esc(album.title)}」</h3>
    <p class="hint">這會刪掉整本相簿共 ${album.count} 張照片。送出後管理員看過核准才會真的刪。</p>
    <div class="edit-grid" style="margin-top:.75rem">
      <label class="fld"><span>你是誰？</span>
        <input class="input" id="ad-by" placeholder="你的名字" value="${esc(localStorage.getItem('chou-name') || '')}"></label>
      <label class="fld"><span>家族密碼</span>
        <input class="input" id="ad-pw" type="password" value="${esc(localStorage.getItem('chou-pw') || '')}"></label>
    </div>
    <div style="display:flex; gap:.5rem; align-items:center; margin-top:1rem; flex-wrap:wrap">
      <button class="btn" id="ad-send">送出申請</button>
      <button class="btn btn-ghost" id="ad-cancel">取消</button>
      <span class="muted" id="ad-msg"></span>
    </div>`);
  $('#ad-cancel').addEventListener('click', closeFaceSheet);
  $('#ad-send').addEventListener('click', async () => {
    const by = $('#ad-by').value.trim();
    const pw = $('#ad-pw').value;
    if (!by) return toast('請填你的名字');
    if (!pw) return toast('請輸入家族密碼');
    localStorage.setItem('chou-name', by);
    localStorage.setItem('chou-pw', pw);
    $('#ad-send').disabled = true; $('#ad-msg').textContent = '送出中…';
    const fd = new FormData();
    fd.append('password', pw); fd.append('submittedBy', by);
    fd.append('albumId', album.id); fd.append('deleteAlbum', '1');
    try {
      const r = await fetch('/api/propose', { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '送出失敗');
      showFaceSheet(`<h3>收到了 🙏</h3><p class="hint">刪除申請已送出，管理員核准後就會刪掉整本相簿。</p>
        <div style="margin-top:1rem"><button class="btn" id="ad-ok">好</button></div>`);
      $('#ad-ok').addEventListener('click', closeFaceSheet);
    } catch (err) { $('#ad-send').disabled = false; $('#ad-msg').textContent = ''; toast(err.message, 5000); }
  });
}

/** 家人改相簿名稱（走待審流程） */
function openAlbumRename(album) {
  showFaceSheet(`
    <h3>幫「${esc(album.title)}」改名</h3>
    <p class="hint">送出後管理員看過核准才會更新。</p>
    <div class="edit-grid" style="margin-top:.75rem">
      <label class="fld"><span>新的相簿名稱</span>
        <input class="input" id="ar-title" value="${esc(album.title)}" maxlength="30"></label>
      <label class="fld"><span>你是誰？</span>
        <input class="input" id="ar-by" placeholder="你的名字" value="${esc(localStorage.getItem('chou-name') || '')}"></label>
      <label class="fld"><span>家族密碼</span>
        <input class="input" id="ar-pw" type="password" value="${esc(localStorage.getItem('chou-pw') || '')}"></label>
    </div>
    <div style="display:flex; gap:.5rem; align-items:center; margin-top:1rem; flex-wrap:wrap">
      <button class="btn" id="ar-send">送出</button>
      <button class="btn btn-ghost" id="ar-cancel">取消</button>
      <span class="muted" id="ar-msg"></span>
    </div>`);
  $('#ar-cancel').addEventListener('click', closeFaceSheet);
  $('#ar-send').addEventListener('click', async () => {
    const title = $('#ar-title').value.trim();
    const by = $('#ar-by').value.trim();
    const pw = $('#ar-pw').value;
    if (!title) return toast('請填新名稱');
    if (!by) return toast('請填你的名字');
    if (!pw) return toast('請輸入家族密碼');
    if (title === album.title) return toast('名稱沒有改變');
    localStorage.setItem('chou-name', by);
    localStorage.setItem('chou-pw', pw);
    $('#ar-send').disabled = true; $('#ar-msg').textContent = '送出中…';
    const fd = new FormData();
    fd.append('password', pw); fd.append('submittedBy', by);
    fd.append('albumId', album.id); fd.append('albumTitle', title);
    try {
      const r = await fetch('/api/propose', { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '送出失敗');
      showFaceSheet(`<h3>收到了 🙏</h3><p class="hint">改名已送出，管理員核准後就會更新。</p>
        <div style="margin-top:1rem"><button class="btn" id="ar-ok">好</button></div>`);
      $('#ar-ok').addEventListener('click', closeFaceSheet);
    } catch (err) { $('#ar-send').disabled = false; $('#ar-msg').textContent = ''; toast(err.message, 5000); }
  });
}

/* ============ 畫面：找自己 ============ */

function renderFind() {
  view().innerHTML = `
    <div class="wrap">
      <div class="finder">
        <div class="section-head">
          <h2>找出我的照片</h2>
          <p>上傳一張有你的照片，選出你的臉，就會把所有相簿裡有你的合影找出來。<br>
             照片只在你自己的裝置上處理，不會上傳到任何地方。</p>
        </div>

        <div class="dropzone" id="dz">
          <div class="dz-icon">📷</div>
          <h3>點這裡選一張照片</h3>
          <p>或把照片拖進來 · 支援 JPG / PNG</p>
          <input type="file" id="file" accept="image/*" hidden>
        </div>

        <div class="steps" id="steps"></div>
      </div>
    </div>`;

  const dz = $('#dz');
  const file = $('#file');
  dz.addEventListener('click', () => file.click());
  file.addEventListener('change', () => file.files[0] && handleUpload(file.files[0]));
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault(); dz.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) handleUpload(f);
  });
}

async function handleUpload(fileObj) {
  const steps = $('#steps');
  steps.innerHTML = `<div class="panel"><div class="loading"><span class="spinner"></span><span id="prog">讀取照片…</span></div><div class="progress"><i id="bar"></i></div></div>`;
  const setProg = (msg, pct) => {
    const p = $('#prog'); const b = $('#bar');
    if (p) p.textContent = msg;
    if (b && pct != null) b.style.width = pct + '%';
  };

  try {
    setProg('載入人臉辨識模型…（第一次比較久）', 10);
    await ensureModels();

    setProg('讀取照片…', 40);
    const url = URL.createObjectURL(fileObj);
    const img = await loadImage(url);
    S.finder.image = img;

    setProg('偵測人臉…', 60);
    const res = await faceapi
      .detectAllFaces(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3, maxResults: 60 }))
      .withFaceLandmarks()
      .withFaceDescriptors();

    if (!res.length) {
      steps.innerHTML = `<div class="panel"><h3>這張照片裡找不到人臉</h3>
        <p class="hint">換一張臉拍得清楚一點、正面一點的照片試試。</p></div>`;
      return;
    }

    S.finder.faces = res.map((r) => {
      const b = r.detection.box;
      return {
        box: [b.x / img.naturalWidth, b.y / img.naturalHeight, b.width / img.naturalWidth, b.height / img.naturalHeight],
        px: Math.round(b.width),
        score: r.detection.score,
        descriptor: r.descriptor,
      };
    });
    // 臉大的排前面，通常是主角
    S.finder.faces.sort((a, b) => b.px - a.px);

    // 太小/太模糊的臉當基準會找出一堆錯的人，直接擋掉
    const usable = S.finder.faces.filter((f) => f.px >= REF_MIN_PX && f.score >= REF_MIN_SCORE);
    if (!usable.length) {
      const b = S.finder.faces[0];
      const why = b.px < REF_MIN_PX
        ? `最大的那張臉只有 ${b.px} 像素寬，太小了（至少要 ${REF_MIN_PX} 像素）`
        : `臉夠大，但拍得不夠清楚 — 可能是側臉、被遮住或糊掉了`;
      steps.innerHTML = `<div class="panel">
        <h3>這張照片沒辦法拿來認人</h3>
        <p class="hint">找到 ${S.finder.faces.length} 張臉，但${why}。
          用這種臉去找，會找出一堆不是你的照片，所以先擋下來。<br>
          請換一張<b>正面、清楚、臉佔畫面比較大</b>的照片 — 自拍或半身照最好。</p>
        <div style="margin-top:1rem"><button class="btn btn-ghost" id="reset">換一張照片</button></div>
      </div>`;
      $('#reset').addEventListener('click', renderFind);
      return;
    }

    S.finder.picked = new Set([0]); // 預設選最大那張臉
    renderFacePicker();
  } catch (err) {
    console.error(err);
    steps.innerHTML = `<div class="panel"><h3>處理失敗</h3><p class="hint">${esc(err.message)}</p></div>`;
  }
}

function renderFacePicker() {
  const faces = S.finder.faces;
  const crops = faces.map((f) => cropFace(S.finder.image, f.box));
  const ok = (f) => f.px >= REF_MIN_PX && f.score >= REF_MIN_SCORE;
  const weak = faces.filter((f) => !ok(f)).length;

  $('#steps').innerHTML = `
    <div class="panel">
      <h3>哪一張是你？</h3>
      <p class="hint">可以複選 — 選越多張你的臉（不同角度、不同年代），找得越準。
        ${weak ? `<br>有 ${weak} 張臉太小或太模糊，沒辦法拿來認人，已經淡掉不能選。` : ''}</p>
      <div class="facepick" id="picker">
        ${crops.map((src, i) => `
          <button data-i="${i}" class="${S.finder.picked.has(i) ? 'on' : ''} ${ok(faces[i]) ? '' : 'weak'}"
                  ${ok(faces[i]) ? '' : `disabled title="這張臉只有 ${faces[i].px} 像素寬，太模糊了"`}>
            <img src="${src}" alt="人臉 ${i + 1}">
          </button>`).join('')}
      </div>
    </div>

    <div class="panel">
      <h3>比對設定</h3>
      <p class="hint">家人長得像，如果找到不是你的照片，改成「嚴格」再找一次。</p>
      <div class="strictness">
        <div class="seg" id="seg">
          ${Object.entries(STRICTNESS).map(([k, v]) => `
            <button data-k="${k}" class="${S.strictness === k ? 'on' : ''}">${v.label}</button>`).join('')}
        </div>
        <span class="muted" id="seg-note">${STRICTNESS[S.strictness].note}</span>
      </div>
      <div style="margin-top:1.25rem; display:flex; gap:.5rem; flex-wrap:wrap;">
        <button class="btn" id="go">開始尋找</button>
        <button class="btn btn-ghost" id="reset">換一張照片</button>
      </div>
    </div>

    <div id="results"></div>`;

  $('#picker').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const i = +b.dataset.i;
    if (S.finder.picked.has(i)) S.finder.picked.delete(i); else S.finder.picked.add(i);
    b.classList.toggle('on');
    $('#go').disabled = S.finder.picked.size === 0;
  });

  $('#seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.strictness = b.dataset.k;
    [...$('#seg').children].forEach((c) => c.classList.toggle('on', c === b));
    $('#seg-note').textContent = STRICTNESS[S.strictness].note;
  });

  $('#go').addEventListener('click', runFind);
  $('#reset').addEventListener('click', renderFind);
}

function runFind() {
  const refs = [...S.finder.picked].map((i) => S.finder.faces[i].descriptor);
  if (!refs.length) return toast('先選一張你的臉');

  const threshold = STRICTNESS[S.strictness].value;
  const all = matchPhotos(refs, threshold, true);
  const sure = all.filter((m) => m.tier === 'sure');
  const maybe = all.filter((m) => m.tier === 'maybe');
  const box = $('#results');

  if (!all.length) {
    box.innerHTML = `<div class="empty">
      <h3>沒有找到你的照片</h3>
      <p>試試看改成「寬鬆」，或換一張臉更大、更清楚的照片。</p></div>`;
    box.scrollIntoView({ block: 'start' });
    return;
  }

  const groupsHtml = (matches) => groupByAlbum(matches).map((g) => `
    <div class="result-group">
      <h3>
        <span class="rg-date">${fmtDate(g.album.date)}</span>
        ${esc(g.album.title)}
        <span class="rg-count">${g.items.length} 張</span>
      </h3>
      <div class="grid">
        ${g.items.map((m) => `
          <button class="tile" data-pi="${m.pi}">
            <img src="${m.photo.t}" alt="" loading="lazy">
          </button>`).join('')}
      </div>
    </div>`).join('');

  const sureGroups = groupByAlbum(sure);

  box.innerHTML = `
    <div class="section-head" style="margin-top:1rem;">
      <h2>${sure.length ? `找到 ${sure.length} 張有你的照片` : '沒有很確定的結果'}</h2>
      ${sure.length ? `<p>橫跨 ${sureGroups.length} 個相簿 · 依相似度排序</p>` : ''}
    </div>
    ${groupsHtml(sure)}
    ${maybe.length ? `
      <details class="maybe">
        <summary>還有 ${maybe.length} 張「可能是你」 — 系統不太確定，點開自己看看</summary>
        ${groupsHtml(maybe)}
      </details>` : ''}`;

  const order = all.map((m) => m.pi);
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('.tile');
    if (btn) openLightbox(order, order.indexOf(+btn.dataset.pi));
  });

  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ============ 族譜 ============ */

/** 把名冊整理成「誰是誰的小孩」的結構 */
function buildFamily() {
  const byId = new Map(S.people.map((p) => [p.id, p]));
  const childrenOf = new Map(); // 「爸id+媽id」（排序過）→ [小孩]
  for (const p of S.people) {
    const par = (p.parents || []).filter((id) => byId.has(id));
    if (!par.length) continue;
    const key = [...par].sort().join('+');
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(p);
  }
  return { byId, childrenOf };
}

/** 這個人有幾張照片（沒登記人臉就是 0） */
function photoCount(person) {
  if (!person.refs || !person.refs.length) return 0;
  const refs = person.refs.map((r) => Float32Array.from(r.d));
  return matchPhotos(refs, STRICTNESS.normal.value).length;
}

function personCardHtml(p) {
  const n = photoCount(p);
  const initial = (p.name || '?').trim().charAt(0);
  const av = avatarOf(p);
  // 卡片下面不寫稱呼 —— 樹本身就畫出關係了，再寫一次只是雜訊，還會把卡片撐高
  return `
    <a class="tp ${p.gender === 'F' ? 'f' : p.gender === 'M' ? 'm' : ''}" href="#/person/${encodeURIComponent(p.id)}">
      <span class="tp-av" ${av ? `data-crop="${esc(JSON.stringify(av))}"` : ''}>${av ? '' : esc(initial)}</span>
      <span class="tp-txt">
        <span class="tp-name">${esc(p.name)}</span>
        <span class="tp-sub">${n ? n + ' 張照片' : ''}</span>
      </span>
    </a>`;
}

/**
 * 大頭照，優先序：
 *   1. 家人自己上傳的獨立照片 {img}
 *   2. 建置時從相簿照片挑好的臉 {p, b}
 *   3. 退回第一張人工指認的臉
 */
function avatarOf(p) {
  if (p.avatar && p.avatar.img) return p.avatar;
  if (p.avatar && p.avatar.p) return p.avatar;
  if (p.refs && p.refs.length) return p.refs[0];
  return null;
}

/** 遞迴畫一個家庭：一對夫妻（或單身）＋他們的小孩。收合的那房只畫夫妻，不畫底下。 */
function familyNodeHtml(person, ctx, seen) {
  if (seen.has(person.id)) return '';
  seen.add(person.id);

  const spouses = (person.spouse || []).map((id) => ctx.byId.get(id)).filter((s) => s && !seen.has(s.id));
  spouses.forEach((s) => seen.add(s.id));
  const members = [person, ...spouses];

  // 小孩：先找「這對夫妻」的，找不到再找只登記單親的
  const coupleKey = members.map((m) => m.id).sort().join('+');
  let kids = ctx.childrenOf.get(coupleKey) || [];
  if (!kids.length) kids = ctx.childrenOf.get(person.id) || [];

  // 夫妻共用一張卡片、中間一條分隔線 —— 之前用一條細線連兩張卡，
  // 那條線只有 2px 寬肉眼看不到，夫妻看起來就跟兄弟姊妹一模一樣
  const coupleHtml = members.map(personCardHtml).join('');

  // 全部直接攤開，不做展開/收合 —— Jay：手機跟電腦都要一次看到全部
  const below = kids.length ? `
    <div class="branch">
      ${kids.map((k) => `<div class="child">${familyNodeHtml(k, ctx, seen)}</div>`).join('')}
    </div>` : '';

  return `<div class="node"><div class="couple">${coupleHtml}</div>${below}</div>`;
}

function renderTree() {
  if (!S.people.length) {
    view().innerHTML = `
      <div class="wrap"><div class="empty">
        <h3>族譜還沒建立</h3>
        <p>現在可以先用「<a href="#/find">找出我的照片</a>」上傳照片來找自己。</p>
      </div></div>`;
    return;
  }

  const ctx = buildFamily();
  // 樹根：沒有登記父母的人。但如果配偶那邊有父母，就讓他跟著配偶一起出現，不要自己當一棵樹
  const roots = S.people.filter((p) =>
    !(p.parents || []).filter((id) => ctx.byId.has(id)).length &&
    !(p.spouse || []).some((sid) => ((ctx.byId.get(sid) || {}).parents || []).length)
  );

  const seen = new Set();
  const trees = roots.map((r) => familyNodeHtml(r, ctx, seen)).filter(Boolean);

  // 有登記名字但接不上的人（還沒填關係），另外列出來，不要讓他們消失
  const orphans = S.people.filter((p) => !seen.has(p.id));

  view().innerHTML = `
    <section class="people-banner">
      <img src="people-banner.jpg" alt="周氏大家族大合照" loading="eager">
      <div class="people-banner-cap">
        <h2>家族成員</h2>
        <p>${S.people.length} 位家人 · 點任何一個人看他的照片</p>
      </div>
    </section>
    <div class="wrap">
      <div class="tree-scroll">
        <div class="tree">${trees.join('')}</div>
      </div>
      ${orphans.length ? `
        <div class="section-head" style="margin-top:3rem">
          <h2 style="font-size:1.1rem">還沒接上關係</h2>
          <p>這些家人還沒填上一代/下一代的關係</p>
        </div>
        <div class="tree"><div class="couple">${orphans.map(personCardHtml).join('')}</div></div>` : ''}
      <p class="muted" style="margin-top:2.5rem; font-size:.85rem">
        資料有錯或缺人？點進那個人的頁面就可以修正。
      </p>
    </div>`;

  hydrateAvatars();
}

/** 頭像是從照片裡把臉裁出來的，等畫面畫好再補上 */
function hydrateAvatars() {
  for (const el of document.querySelectorAll('[data-crop]')) {
    let ref;
    try { ref = JSON.parse(el.dataset.crop); } catch { continue; }
    if (!ref) continue;
    // 家人自己上傳的照片：整張當頭像，不用裁臉
    if (ref.img) {
      el.style.backgroundImage = `url(${ref.img})`;
      el.textContent = '';
      continue;
    }
    if (!ref.p) continue;
    loadImage(ref.p).then((img) => {
      el.style.backgroundImage = `url(${cropFace(img, ref.b, 160)})`;
      el.textContent = '';
    }).catch(() => {});
  }
}

function renderPerson(id) {
  const person = S.people.find((p) => p.id === id) || S.people.find((p) => p.name === id);
  if (!person) return renderNotFound();

  const ctx = buildFamily();
  const refs = (person.refs || []).map((r) => Float32Array.from(r.d));
  const matches = refs.length ? matchPhotos(refs, STRICTNESS.normal.value) : [];
  const groups = groupByAlbum(matches);

  const rel = [];
  const parents = (person.parents || []).map((i) => ctx.byId.get(i)).filter(Boolean);
  const spouses = (person.spouse || []).map((i) => ctx.byId.get(i)).filter(Boolean);
  const kids = S.people.filter((p) => (p.parents || []).includes(person.id));
  const link = (p) => `<a href="#/person/${encodeURIComponent(p.id)}">${esc(p.name)}</a>`;
  if (parents.length) rel.push(`父母：${parents.map(link).join('、')}`);
  if (spouses.length) rel.push(`配偶：${spouses.map(link).join('、')}`);
  if (kids.length) rel.push(`子女：${kids.map(link).join('、')}`);

  const av = avatarOf(person);
  view().innerHTML = `
    <div class="wrap">
      <a class="back-link" href="#/people">← 回到家族成員</a>
      <div class="person-head">
        <span class="person-av" ${av ? `data-crop="${esc(JSON.stringify(av))}"` : ''}>${av ? '' : esc((person.name || '?').charAt(0))}</span>
        <div class="section-head" style="margin:0">
          <h2>${esc(person.name)}</h2>
          ${person.note ? `<p>${esc(person.note)}</p>` : ''}
          ${rel.length ? `<p style="margin-top:.5rem">${rel.join(' ｜ ')}</p>` : ''}
        </div>
      </div>
      <p style="margin:-.75rem 0 1.5rem">
        <button class="btn btn-ghost btn-sm" id="edit-open">✎ 修正這個人的資料</button>
      </p>
      <div id="edit-box"></div>
      ${matches.length ? `<p class="muted" style="margin-bottom:1.5rem">找到 ${matches.length} 張照片，橫跨 ${groups.length} 個相簿</p>` : ''}
      <div id="pres">
        ${groups.map((g) => `
          <div class="result-group">
            <h3>
              <span class="rg-date">${fmtDate(g.album.date)}</span>
              ${esc(g.album.title)}
              <span class="rg-count">${g.items.length} 張</span>
            </h3>
            <div class="grid">
              ${g.items.map((m) => `
                <button class="tile" data-pi="${m.pi}">
                  <img src="${m.photo.t}" alt="" loading="lazy">
                </button>`).join('')}
            </div>
          </div>`).join('')}
      </div>
      ${!matches.length ? `<div class="empty">
        <h3>還沒認出他的照片</h3>
        <p>${refs.length ? '相簿裡目前找不到他。' : '還沒登記他的臉，所以沒辦法從照片裡認出來。'}<br>
           在照片上用管理模式點他的臉命名，或請他自己來「<a href="#/find">找出我的照片</a>」。</p>
      </div>` : ''}
    </div>`;

  hydrateAvatars();
  $('#edit-open').addEventListener('click', () => renderEditForm(person));

  const order = matches.map((m) => m.pi);
  $('#pres').addEventListener('click', (e) => {
    const btn = e.target.closest('.tile');
    if (btn) openLightbox(order, order.indexOf(+btn.dataset.pi));
  });
}

/* ============ 家人修正族譜資料 ============ */

function renderEditForm(person) {
  const box = $('#edit-box');
  if (box.dataset.open) { box.innerHTML = ''; delete box.dataset.open; return; }
  box.dataset.open = '1';

  box.innerHTML = `
    <div class="panel" style="margin-bottom:1.5rem">
      <h3>修正「${esc(person.name)}」的資料</h3>
      <p class="hint">送出後會先進待審清單，管理員看過才會更新到族譜上。<b>沒填的欄位不會動到。</b></p>

      <div class="edit-grid">
        <label class="fld">
          <span>名字寫錯了？</span>
          <input class="input" id="ed-name" placeholder="${esc(person.name)}" maxlength="20">
        </label>
        <label class="fld">
          <span>換一張大頭照</span>
          <input class="input" id="ed-avatar" type="file" accept="image/*">
          <p class="hint" style="margin:.4rem 0 0">
            用<b>正面、清楚</b>的人臉照片，框住他的頭。這樣系統才能自動在相簿裡認出他、
            他也才找得到自己的合影。
          </p>
          <div id="ed-crop" hidden></div>
        </label>
        <label class="fld">
          <span>新增另一半</span>
          <input class="input" id="ed-spouse" placeholder="配偶的名字" maxlength="20">
        </label>
        <label class="fld">
          <span>新增小孩（一行一個）</span>
          <textarea class="input" id="ed-kids" rows="3" placeholder="小孩的名字&#10;有多個就換行"></textarea>
        </label>
        ${(person.spouse || []).length ? `
        <label class="fld">
          <span>解除婚姻關係</span>
          <select class="input" id="ed-unspouse">
            <option value="">不用動</option>
            ${person.spouse.map((sid) => {
              const s = S.people.find((x) => x.id === sid);
              return s ? `<option value="${esc(sid)}">跟「${esc(s.name)}」解除（離婚／分開）</option>` : '';
            }).join('')}
          </select>
        </label>` : ''}
        <label class="fld">
          <span>把這個人從族譜移除</span>
          <select class="input" id="ed-remove">
            <option value="">不用動</option>
            <option value="1">移除「${esc(person.name)}」</option>
          </select>
        </label>
        <label class="fld">
          <span>你是誰？</span>
          <input class="input" id="ed-by" placeholder="你的名字" maxlength="20" value="${esc(localStorage.getItem('chou-name') || '')}">
        </label>
        <label class="fld">
          <span>家族密碼</span>
          <input class="input" id="ed-pw" type="password" value="${esc(localStorage.getItem('chou-pw') || '')}">
        </label>
      </div>

      <div style="margin-top:1.25rem; display:flex; gap:.5rem; align-items:center; flex-wrap:wrap">
        <button class="btn" id="ed-send">送出修正</button>
        <button class="btn btn-ghost" id="ed-cancel">取消</button>
        <span class="muted" id="ed-msg"></span>
      </div>
    </div>`;

  $('#ed-cancel').addEventListener('click', () => { box.innerHTML = ''; delete box.dataset.open; });
  $('#ed-send').addEventListener('click', () => submitEdit(person));

  // 選了大頭照 → 出現方框裁切工具
  S.avatarCrop = null;
  $('#ed-avatar').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) setupAvatarCrop(file);
    else { $('#ed-crop').hidden = true; S.avatarCrop = null; }
  });
}

/*
 * 大頭照裁切：選了照片後，蓋一個可拖曳、可縮放的方框，讓家人框住人頭。
 * 手機是主戰場，所以用 pointer events（滑鼠和觸控都吃）。
 */
function setupAvatarCrop(file) {
  const wrap = $('#ed-crop');
  wrap.hidden = false;
  wrap.innerHTML = `<div class="crop-loading">讀取照片…</div>`;

  const url = URL.createObjectURL(file);
  loadImage(url).then((img) => {
    S.avatarCrop = { img, file };
    wrap.innerHTML = `
      <div class="crop-stage" id="crop-stage">
        <img class="crop-img" id="crop-img" src="${url}" alt="">
        <div class="crop-shade"></div>
        <div class="crop-box" id="crop-box">
          <span class="crop-handle"></span>
        </div>
      </div>
      <p class="hint" style="margin:.4rem 0 0">點一下頭的位置，圓框就會移過去；拖動可微調，拉右下角圓鈕縮放。</p>`;

    const stage = $('#crop-stage');
    const cbox = $('#crop-box');
    const handle = cbox.querySelector('.crop-handle');
    const imgTag = $('#crop-img');

    /*
     * 手機上圖片排版慢，requestAnimationFrame 觸發時 clientHeight 常常還是 0，
     * 之前用 stage.style.height=0 把整個裁切區壓沒了（照片不見）。
     * 改成：不強制 stage 高度（讓圖片自然撐開），而且等圖片真的有尺寸了才算框，
     * 沒尺寸就重試（img 的 onload 或輪詢，最多等 2 秒）。
     */
    const startInit = (tries) => {
      const iw = imgTag.clientWidth;
      const ih = imgTag.clientHeight;
      if ((!iw || !ih) && tries < 40) { requestAnimationFrame(() => startInit(tries + 1)); return; }
      initBox(iw || 1, ih || 1);
    };
    imgTag.addEventListener('load', () => startInit(0));
    if (imgTag.complete) startInit(0);

    function initBox(iw, ih) {
      // 預設方框：置中、邊長取短邊的 60%
      let size = Math.round(Math.min(iw, ih) * 0.6);
      let x = Math.round((iw - size) / 2);
      let y = Math.round((ih - size) / 3); // 稍微偏上，頭通常在上半部
      const apply = () => {
        cbox.style.left = x + 'px'; cbox.style.top = y + 'px';
        cbox.style.width = size + 'px'; cbox.style.height = size + 'px';
        S.avatarCrop.rect = { x: x / iw, y: y / ih, size: size / iw, iw, ih };
      };
      apply();

      const clamp = () => {
        size = Math.max(48, Math.min(size, iw, ih));
        x = Math.max(0, Math.min(x, iw - size));
        y = Math.max(0, Math.min(y, ih - size));
      };

      const imgEl = $('#crop-img');
      let mode = null, sx = 0, sy = 0, ox = 0, oy = 0, osize = 0;

      const onMove = (e) => {
        if (!mode) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (mode === 'resize') size = osize + Math.max(dx, dy);
        else { x = ox + dx; y = oy + dy; }
        clamp(); apply();
      };
      const onUp = (e) => {
        mode = null;
        try { stage.releasePointerCapture(e.pointerId); } catch {}
        stage.removeEventListener('pointermove', onMove);
        stage.removeEventListener('pointerup', onUp);
        stage.removeEventListener('pointercancel', onUp);
      };
      /*
       * 綁在整個裁切區（stage 有 touch-action:none，手機拖框才不會捲到頁面）：
       *   按右下角圓鈕 → 縮放
       *   按框外任一處 → 框中心跳到手指位置（手機「點頭」就對位，最直覺）
       *   按框內      → 直接拖曳
       * setPointerCapture 讓手指移出框外時事件還收得到，拖曳才不會斷。
       */
      stage.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        mode = (e.target === handle) ? 'resize' : 'move';
        if (mode === 'move' && !cbox.contains(e.target)) {
          const rect = imgEl.getBoundingClientRect();
          x = (e.clientX - rect.left) - size / 2;
          y = (e.clientY - rect.top) - size / 2;
          clamp(); apply();
        }
        sx = e.clientX; sy = e.clientY; ox = x; oy = y; osize = size;
        try { stage.setPointerCapture(e.pointerId); } catch {}
        stage.addEventListener('pointermove', onMove);
        stage.addEventListener('pointerup', onUp);
        stage.addEventListener('pointercancel', onUp);
      });
    }
  }).catch(() => { wrap.innerHTML = `<p class="hint">照片讀取失敗，換一張試試。</p>`; });
}

/** 把裁切框內容畫成正方形 canvas，回傳 {blob, canvas} */
async function getCroppedAvatar(size = 400) {
  const c = S.avatarCrop;
  if (!c || !c.rect || !c.img) return null;
  const { img, rect } = c;
  const nw = img.naturalWidth, nh = img.naturalHeight;
  const sx = rect.x * nw, sy = rect.y * nh, sSize = rect.size * nw;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, size, size);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  return { blob, canvas };
}

/*
 * 從上傳的原圖抓臉的特徵值。
 * ⚠️ 一定要在「原圖」上偵測，不是在裁切的小方框上 ——
 * 家人可能把框拉很緊只框到五官，那樣人臉偵測器（需要額頭/下巴等邊界）會抓不到。
 * 所以：在整張原圖上找所有臉 → 挑中心落在裁切框內的那張（多張就取最大的）。
 * 這樣不管框多緊都認得到。
 */
async function descriptorFromCrop() {
  const c = S.avatarCrop;
  if (!c || !c.rect || !c.img) return null;
  await ensureModels();

  const results = await faceapi
    .detectAllFaces(c.img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.4, maxResults: 20 }))
    .withFaceLandmarks().withFaceDescriptors();
  if (!results.length) return null;

  const nw = c.img.naturalWidth, nh = c.img.naturalHeight;
  const rx = c.rect.x, ry = c.rect.y, rs = c.rect.size; // 都是 0~1（相對原圖寬）
  const rsH = rs * nw / nh; // 框在高度方向的相對值
  const cxCrop = rx + rs / 2, cyCrop = ry + rsH / 2;

  let best = null, bestScore = -1;
  for (const r of results) {
    const b = r.detection.box;
    const fcx = (b.x + b.width / 2) / nw, fcy = (b.y + b.height / 2) / nh;
    const inside = fcx >= rx && fcx <= rx + rs && fcy >= ry && fcy <= ry + rsH;
    // 框內優先；框內的挑臉最大的；沒有框內的就挑離框中心最近的
    const dist = Math.hypot(fcx - cxCrop, fcy - cyCrop);
    const score = inside ? 10 + b.width * b.height : -dist;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best ? Array.from(best.descriptor).map((v) => +v.toFixed(5)) : null;
}

async function submitEdit(person) {
  const name = $('#ed-name').value.trim();
  const spouse = $('#ed-spouse').value.trim();
  const kids = $('#ed-kids').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const unspouse = $('#ed-unspouse') ? $('#ed-unspouse').value : '';
  const remove = $('#ed-remove').value;
  const by = $('#ed-by').value.trim();
  const pw = $('#ed-pw').value;
  const file = $('#ed-avatar').files[0];

  if (!pw) return toast('請輸入家族密碼');
  if (!by) return toast('請填你的名字，讓管理員知道是誰改的');
  if (!name && !spouse && !kids.length && !file && !unspouse && !remove) return toast('沒有填任何要改的東西');
  if (remove && !confirm(`確定要把「${person.name}」整個從族譜移除嗎？\n（要管理員核准才會真的移除）`)) return;

  /*
   * 重複名字檢查：新增配偶/小孩時，如果族譜裡已經有同名的人，
   * 問清楚是「連結現有這一位」還是「真的另外新增一個同名的人」，
   * 避免像先前那樣冒出重複的王法程。
   */
  let linkSpouseId = '';
  let addSpouseName = spouse;
  if (spouse) {
    const ex = S.people.find((p) => p.name === spouse && p.id !== person.id);
    if (ex) {
      if (confirm(`族譜裡已經有「${spouse}」了。\n\n按「確定」＝直接連結這一位當配偶（避免重複，通常選這個）。\n按「取消」＝這是另一個剛好同名的新的人，另外新增。`)) {
        linkSpouseId = ex.id; addSpouseName = '';
      }
    }
  }

  const newKids = [];
  const linkKidIds = [];
  for (const kid of kids) {
    const ex = S.people.find((p) => p.name === kid && p.id !== person.id);
    if (ex && confirm(`族譜裡已經有「${kid}」了。\n\n按「確定」＝把這一位連結成 ${person.name} 的小孩（避免重複）。\n按「取消」＝這是另一個剛好同名的新的人，另外新增。`)) {
      linkKidIds.push(ex.id);
    } else {
      newKids.push(kid);
    }
  }

  localStorage.setItem('chou-pw', pw);
  localStorage.setItem('chou-name', by);

  $('#ed-send').disabled = true;
  $('#ed-msg').textContent = '送出中…';

  const fd = new FormData();
  fd.append('password', pw);
  fd.append('submittedBy', by);
  fd.append('target', person.id);
  fd.append('targetName', person.name);
  if (name) fd.append('name', name);
  if (addSpouseName) fd.append('addSpouse', addSpouseName);
  if (linkSpouseId) fd.append('linkSpouse', linkSpouseId);
  if (newKids.length) fd.append('addChildren', JSON.stringify(newKids));
  if (linkKidIds.length) fd.append('linkChildren', JSON.stringify(linkKidIds));
  if (unspouse) fd.append('removeSpouse', unspouse);
  if (remove) fd.append('removePerson', '1');

  // 大頭照：用裁切後的方框當顯示照，並跑一次人臉辨識抓特徵值，
  // 這樣上傳的照片也能讓這個人在相簿裡被自動認出來
  if (file && S.avatarCrop) {
    const cropped = await getCroppedAvatar();
    if (cropped) {
      fd.append('avatar', cropped.blob, 'avatar.jpg');
      try {
        $('#ed-msg').textContent = '辨識人臉中…';
        const descriptor = await descriptorFromCrop();
        if (descriptor) fd.append('faceDescriptor', JSON.stringify(descriptor));
      } catch { /* 抓不到臉沒關係，大頭照還是會換，只是不能自動辨識 */ }
      $('#ed-msg').textContent = '送出中…';
    }
  }
  try {
    const res = await fetch('/api/propose', { method: 'POST', body: fd });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || '送出失敗');
    $('#edit-box').innerHTML = `
      <div class="panel" style="margin-bottom:1.5rem">
        <h3>收到了，謝謝你 🙏</h3>
        <p class="hint">你的修正已經送出，管理員看過確認後就會更新到族譜上。</p>
      </div>`;
  } catch (err) {
    $('#ed-send').disabled = false;
    $('#ed-msg').textContent = '';
    toast(err.message, 5000);
  }
}

/* ============ 畫面：家族聚會公佈欄 ＋ 回覆出席 ============ */

/** 把 datetime-local 值（2026-09-15T12:00）排成好看的中文；舊的自由文字照原樣顯示 */
function fmtEventWhen(w) {
  if (!w) return '';
  const m = String(w).match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return w;
  const [, y, mo, d, hh, mm] = m;
  const wd = '日一二三四五六'[new Date(+y, +mo - 1, +d).getDay()];
  let s = `${+y}/${+mo}/${+d}（${wd}）`;
  if (hh != null) {
    const H = +hh;
    const ampm = H === 12 ? '中午' : H === 0 ? '凌晨' : H < 12 ? '上午' : H < 18 ? '下午' : '晚上';
    const h12 = H % 12 === 0 ? 12 : H % 12;
    s += ` ${ampm} ${h12}:${mm}`;
  }
  return s;
}

/** 從族譜找出「我」這一戶：自己＋配偶＋上一代（父母）＋下一代（子女） */
function familyUnitOf(name) {
  const me = S.people.find((p) => p.name === name);
  if (!me) return null;
  const byId = new Map(S.people.map((p) => [p.id, p]));
  const nm = (id) => (byId.get(id) || {}).name;
  return {
    self: me.name,
    spouse: (me.spouse || []).map(nm).filter(Boolean),
    parents: (me.parents || []).map(nm).filter(Boolean),
    children: S.people.filter((p) => (p.parents || []).includes(me.id)).map((p) => p.name),
  };
}

/** 會到 → 跳出「還有誰一起來」，幫家裡長輩/小孩一起勾（他們不用自己登入） */
function openHouseholdRsvp(ev) {
  const unit = S.me ? familyUnitOf(S.me) : null;
  if (!unit) { submitHouseholdRsvp(ev, { [S.me || '我']: 'yes' }); return; }  // 族譜找不到就只設自己
  const rsvps = ev.rsvps || {};
  const row = (n, locked) => `
    <label class="hh-row">
      <input type="checkbox" data-name="${esc(n)}" ${locked ? 'checked disabled' : (rsvps[n] === 'yes' ? 'checked' : '')}>
      <span>${esc(n)}</span>${locked ? '<em>你</em>' : ''}
    </label>`;
  const group = (title, names) => names.length ? `<div class="hh-title">${title}</div>${names.map((n) => row(n, false)).join('')}` : '';

  showFaceSheet(`
    <h3>「${esc(ev.title)}」還有誰一起來？</h3>
    <p class="hint">幫家裡的長輩和小孩一起勾選，他們就不用自己登入了。</p>
    <div class="hh-list">
      ${row(unit.self, true)}
      ${group('另一半', unit.spouse)}
      ${group('上一代（父母）', unit.parents)}
      ${group('下一代（子女）', unit.children)}
    </div>
    <div style="display:flex; gap:.5rem; margin-top:1rem">
      <button class="btn" id="hh-send">確認會到</button>
      <button class="btn btn-ghost" id="hh-cancel">取消</button>
    </div>`);
  $('#hh-cancel').addEventListener('click', closeFaceSheet);
  $('#hh-send').addEventListener('click', () => {
    const people = { [unit.self]: 'yes' };
    document.querySelectorAll('.hh-list input[data-name]').forEach((cb) => {
      if (cb.disabled) return;
      people[cb.dataset.name] = cb.checked ? 'yes' : '__none__';
    });
    submitHouseholdRsvp(ev, people);
  });
}

async function submitHouseholdRsvp(ev, people) {
  try {
    const r = await fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'rsvp', id: ev.id, people }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '失敗');
    ev.rsvps = d.rsvps || ev.rsvps;
    closeFaceSheet();
    renderBoard();
  } catch (err) { toast(err.message, 4000); }
}

/** 管理員登入（給非待審頁的地方用，例如聚會頁要新增聚會） */
function unlockAdmin(onOk) {
  showFaceSheet(`
    <h3>管理員登入</h3>
    <p class="hint">輸入管理員密碼，就能新增與管理聚會。</p>
    <div style="margin-top:.75rem"><input class="input" id="ua-pw" type="password" placeholder="管理員密碼"></div>
    <div style="display:flex; gap:.5rem; align-items:center; margin-top:1rem">
      <button class="btn" id="ua-go">登入</button>
      <button class="btn btn-ghost" id="ua-cancel">取消</button>
      <span class="muted" id="ua-msg"></span>
    </div>`);
  $('#ua-cancel').addEventListener('click', closeFaceSheet);
  const go = async () => {
    const pw = $('#ua-pw').value;
    if (!pw) return;
    $('#ua-go').disabled = true; $('#ua-msg').textContent = '確認中…';
    try {
      const r = await fetch('/api/review?password=' + encodeURIComponent(pw));
      if (!r.ok) throw new Error('密碼不對');
      sessionStorage.setItem('chou-admin', pw);
      closeFaceSheet();
      if (onOk) onOk();
    } catch (e) { $('#ua-go').disabled = false; $('#ua-msg').textContent = ''; toast(e.message, 3000); }
  };
  $('#ua-go').addEventListener('click', go);
  $('#ua-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

async function renderBoard() {
  view().innerHTML = `<div class="wrap"><div class="loading"><span class="spinner"></span>載入中…</div></div>`;
  let data = { events: [] };
  try {
    const r = await fetch('/api/events', { cache: 'no-cache' });
    if (r.ok) data = await r.json();
  } catch { /* 空的就空的 */ }
  S.events = data.events || [];
  const isAdmin = !!sessionStorage.getItem('chou-admin');

  const rsvpCard = (ev) => {
    const rsvps = ev.rsvps || {};
    const names = (st) => Object.keys(rsvps).filter((n) => rsvps[n] === st);
    const yes = names('yes'), maybe = names('maybe'), no = names('no');
    const mine = S.me ? rsvps[S.me] : null;
    const btn = (st, label) => `<button class="rsvp-btn ${mine === st ? 'on ' + st : ''}" data-id="${esc(ev.id)}" data-st="${st}">${label}</button>`;
    return `
      <div class="event-card" data-id="${esc(ev.id)}">
        <div class="event-head">
          <h3>${esc(ev.title)}</h3>
          ${isAdmin ? `<button class="event-del" data-id="${esc(ev.id)}" title="刪除">🗑</button>` : ''}
        </div>
        <div class="event-meta">
          ${ev.when ? `<span>🗓️ ${esc(fmtEventWhen(ev.when))}</span>` : ''}
          ${ev.where ? `<span>📍 ${esc(ev.where)}</span>` : ''}
        </div>
        ${ev.note ? `<p class="event-note">${esc(ev.note)}</p>` : ''}
        <div class="rsvp-row">${btn('yes', '✅ 我會到')}${btn('maybe', '🤔 再看看')}${btn('no', '🙏 不克出席')}</div>
        <div class="rsvp-tally">
          <b>${yes.length}</b> 位會到${yes.length ? '：' + yes.map(esc).join('、') : ''}
          ${maybe.length ? ` · ${maybe.length} 位再看看` : ''}
          ${no.length ? ` · ${no.length} 位不克` : ''}
        </div>
      </div>`;
  };

  view().innerHTML = `
    <div class="wrap">
      <div class="section-head" style="display:flex; justify-content:space-between; align-items:flex-end; gap:1rem; flex-wrap:wrap">
        <div>
          <h2>家族聚會</h2>
          <p>聚餐、活動看這裡，順手回覆你會不會到。</p>
        </div>
        ${isAdmin ? '' : '<button class="btn btn-ghost btn-sm" id="ev-admin">🔑 管理員新增聚會</button>'}
      </div>
      ${isAdmin ? `
        <div class="panel" style="margin-bottom:1.5rem">
          <h3 style="margin:0 0 .6rem">新增一場聚會</h3>
          <div class="edit-grid">
            <label class="fld"><span>名稱</span><input class="input" id="ev-title" placeholder="例：中秋家族聚餐"></label>
            <label class="fld"><span>日期與時間</span><input class="input" id="ev-when" type="datetime-local"></label>
            <label class="fld"><span>地點</span><input class="input" id="ev-where" placeholder="例：樹林陶板屋"></label>
            <label class="fld"><span>備註（可留空）</span><input class="input" id="ev-note" placeholder="例：停車場在B2"></label>
          </div>
          <div style="margin-top:.8rem"><button class="btn" id="ev-add">發布聚會</button> <span class="muted" id="ev-msg"></span></div>
        </div>` : ''}
      <div id="event-list">
        ${S.events.length ? S.events.map(rsvpCard).join('') : '<div class="empty"><h3>目前沒有安排中的聚會</h3><p>有聚會時會公佈在這裡。</p></div>'}
      </div>
    </div>`;

  // 回覆出席
  $('#event-list').addEventListener('click', async (e) => {
    const rb = e.target.closest('.rsvp-btn');
    const db = e.target.closest('.event-del');
    if (rb) {
      const ev = S.events.find((x) => x.id === rb.dataset.id);
      if (!ev) return;
      if (rb.dataset.st === 'yes') { openHouseholdRsvp(ev); return; }   // 會到 → 順便幫家人勾選
      // 再看看/不克：只設自己（再點一次＝取消）
      const status = (ev.rsvps && ev.rsvps[S.me] === rb.dataset.st) ? null : rb.dataset.st;
      try {
        const r = await fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'rsvp', id: ev.id, status }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || '失敗');
        ev.rsvps = d.rsvps || ev.rsvps || {};
        renderBoard();
      } catch (err) { toast(err.message, 4000); }
    } else if (db) {
      if (!confirm('刪除這場聚會？')) return;
      try {
        const r = await fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', id: db.dataset.id, adminPassword: sessionStorage.getItem('chou-admin') }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || '刪除失敗');
        S.events = S.events.filter((x) => x.id !== db.dataset.id);
        renderBoard();
      } catch (err) { toast(err.message, 4000); }
    }
  });

  if (!isAdmin) $('#ev-admin').addEventListener('click', () => unlockAdmin(renderBoard));

  if (isAdmin) $('#ev-add').addEventListener('click', async () => {
    const title = $('#ev-title').value.trim();
    if (!title) return toast('請填聚會名稱');
    $('#ev-add').disabled = true; $('#ev-msg').textContent = '發布中…';
    try {
      const r = await fetch('/api/events', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'create', title, when: $('#ev-when').value.trim(), where: $('#ev-where').value.trim(), note: $('#ev-note').value.trim(), adminPassword: sessionStorage.getItem('chou-admin') }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '發布失敗');
      renderBoard();
    } catch (err) { $('#ev-add').disabled = false; $('#ev-msg').textContent = ''; toast(err.message, 4000); }
  });
}

/* ============ 畫面：一起認人（把不認識的臉交給大家認） ============ */

function renderIdentify() {
  view().innerHTML = `
    <div class="wrap">
      <div class="section-head">
        <h2>一起認人</h2>
        <p>這些照片裡有還沒認出來的家人。點開照片、再點臉上的方框，就能幫忙標名字——認得越多，「找出我的照片」就越準。</p>
      </div>
      <div class="loading"><span class="spinner"></span>整理中…</div>
    </div>`;

  // 讓 spinner 先畫出來，再做比較重的計算
  setTimeout(() => {
    const faces = S.faces.faces;
    const unknownByPhoto = new Map();
    for (let i = 0; i < faces.length; i++) {
      if (!faces[i].q) continue;        // 太小/太糊的臉不列入
      if (whoIs(i)) continue;           // 已經認得出來的跳過
      const pi = faces[i].p;
      unknownByPhoto.set(pi, (unknownByPhoto.get(pi) || 0) + 1);
    }
    const list = [...unknownByPhoto.entries()].sort((a, b) => b[1] - a[1]).slice(0, 48);

    const body = list.length ? `
      <div class="grid" id="idg">
        ${list.map(([pi, n]) => {
          const photo = S.faces.photos[pi];
          const album = S.photoAlbum[pi];
          return `<button class="tile" data-pi="${pi}" title="${esc(album ? album.title : '')}">
            <img src="${photo.t}" loading="lazy" alt="">
            <span class="tile-badge">${n} 個待認</span>
          </button>`;
        }).join('')}
      </div>` : '<div class="empty"><h3>太棒了，大家都認完了！</h3><p>目前沒有待認的家人。</p></div>';

    view().innerHTML = `
      <div class="wrap">
        <div class="section-head">
          <h2>一起認人</h2>
          <p>這些照片裡有還沒認出來的家人。點開照片、再點臉上的方框，就能幫忙標名字——認得越多，「找出我的照片」就越準。</p>
        </div>
        ${body}
      </div>`;

    const g = $('#idg');
    if (g) g.addEventListener('click', (e) => {
      const b = e.target.closest('.tile');
      if (!b) return;
      const pi = +b.dataset.pi;
      S.lb.showFaces = true;
      $('#lb-toggle-faces').textContent = '隱藏人臉';
      openLightbox([pi], 0);
      toast('點臉上的方框，就能幫忙標名字 🙌', 3500);
    });
  }, 30);
}

/* ============ 畫面：待審清單（只有 Jay 用） ============ */

function renderReview() {
  view().innerHTML = `
    <div class="wrap">
      <div class="finder">
        <div class="section-head">
          <h2>待審的修正</h2>
          <p>家人提出的族譜修正，你看過按核准才會更新到族譜上。</p>
        </div>
        <div class="panel">
          <div class="field">
            <input class="input" id="rv-pw" type="password" placeholder="管理員密碼"
                   value="${esc(sessionStorage.getItem('chou-admin') || '')}">
            <button class="btn" id="rv-load">看待審清單</button>
          </div>
        </div>
        <div id="rv-list" style="margin-top:1.5rem"></div>
      </div>
    </div>`;

  $('#rv-load').addEventListener('click', loadProposals);
  if (sessionStorage.getItem('chou-admin')) loadProposals();
}

async function loadProposals() {
  const pw = $('#rv-pw').value;
  if (!pw) return toast('請輸入管理員密碼');
  const box = $('#rv-list');
  box.innerHTML = `<div class="loading"><span class="spinner"></span>載入中…</div>`;
  try {
    const res = await fetch('/api/review?password=' + encodeURIComponent(pw));
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || '載入失敗');
    sessionStorage.setItem('chou-admin', pw);

    if (!out.proposals.length) {
      box.innerHTML = `<div class="empty"><h3>目前沒有待審的修正</h3></div>`;
      return;
    }
    box.innerHTML = out.proposals.map((p) => {
      const c = p.changes || {};
      const rows = [];
      if (c.name) rows.push(`名字改成「<b>${esc(c.name)}</b>」`);
      if (c.avatarImg) rows.push(`換大頭照`);
      if (c.addSpouse) rows.push(`新增配偶「<b>${esc(c.addSpouse)}</b>」`);
      if (c.addChildren) rows.push(`新增小孩「<b>${esc(c.addChildren.join('、'))}</b>」`);
      if (c.linkSpouse) {
        const s = S.people.find((x) => x.id === c.linkSpouse);
        rows.push(`連結現有的「<b>${esc(s ? s.name : c.linkSpouse)}</b>」當配偶`);
      }
      if (c.linkChildren) {
        const names = c.linkChildren.map((id) => (S.people.find((x) => x.id === id) || {}).name || id);
        rows.push(`連結現有的「<b>${esc(names.join('、'))}</b>」當小孩`);
      }
      if (c.removeSpouse) {
        const ex = S.people.find((x) => x.id === c.removeSpouse);
        rows.push(`⚠️ 解除跟「<b>${esc(ex ? ex.name : c.removeSpouse)}</b>」的婚姻關係`);
      }
      if (c.removePerson) rows.push(`🔴 <b>把這個人從族譜整個移除</b>`);
      if (c.tagRef) rows.push(`在照片上標記了一張<b>${esc(p.targetName || '')}</b>的臉（之後會自動認出他）`);
      if (c.albumRename) rows.push(`相簿改名成「<b>${esc(c.albumRename)}</b>」`);
      if (c.deletePhoto) rows.push(`🔴 <b>刪除一張照片</b>（相簿 ${esc(c.deletePhoto.albumId)}）`);
      if (c.deleteAlbum) rows.push(`🔴 <b>刪除整本相簿</b>（${esc(c.deleteAlbum)}）`);
      return `
        <div class="panel" style="margin-bottom:1rem" data-id="${esc(p.id)}">
          <h3>${esc(p.targetName || p.target)}</h3>
          <p class="hint">${esc(p.submittedBy)} 於 ${esc(p.submittedAt)} 提出</p>
          ${c.avatarImg ? `<img src="https://raw.githubusercontent.com/superiorpdr2014-jpg/chou-family/main/${esc(c.avatarImg)}" alt="" style="width:90px;height:90px;object-fit:cover;border-radius:50%;margin:.5rem 0;background:#eee">` : ''}
          ${c.deletePhoto ? `<img src="photos/${esc(c.deletePhoto.albumId)}/t/${esc(c.deletePhoto.name)}.webp" alt="" style="width:110px;height:110px;object-fit:cover;border-radius:8px;margin:.5rem 0;background:#eee">` : ''}
          <ul style="margin:.5rem 0 1rem; padding-left:1.2rem">${rows.map((r) => `<li>${r}</li>`).join('')}</ul>
          <div style="display:flex; gap:.5rem; flex-wrap:wrap">
            <button class="btn btn-sm" data-act="approve">核准</button>
            <button class="btn btn-ghost btn-sm" data-act="reject">退回</button>
          </div>
        </div>`;
    }).join('');

    box.onclick = async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const panel = btn.closest('[data-id]');
      const id = panel.dataset.id;
      const action = btn.dataset.act;
      if (action === 'approve' && !confirm('確定要核准這筆？如果是刪除，照片刪掉就找不回來了。')) return;
      btn.disabled = true;
      try {
        const res = await fetch('/api/review', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: $('#rv-pw').value, id, action }),
        });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error || '失敗');
        panel.innerHTML = `<p class="muted">${action === 'approve' ? '✅ 已採用：' + (out.log || []).join('、') : '已退回'}</p>`;
        // 立刻把新資料抓進來，這樣點回族譜就是最新的，不用等部署
        if (action === 'approve') setTimeout(refreshPeopleInBackground, 1500);
      } catch (err) {
        btn.disabled = false;
        toast(err.message, 5000);
      }
    };
  } catch (err) {
    box.innerHTML = `<div class="empty"><h3>載入失敗</h3><p>${esc(err.message)}</p></div>`;
  }
}

/* ============ 畫面：上傳照片 ============ */

function renderUpload(presetAlbumId) {
  const albums = S.albums.albums;
  const savedPw = localStorage.getItem('chou-pw') || '';
  const savedName = localStorage.getItem('chou-name') || '';
  // 從某本相簿點「加照片到這本」進來的話，預選那本
  const preset = presetAlbumId ? albums.find((a) => a.id === presetAlbumId) : null;

  view().innerHTML = `
    <div class="wrap">
      <div class="finder">
        <div class="section-head">
          <h2>上傳照片</h2>
          <p>把你手上的家族照片加進來。上傳後會自動跑人臉辨識，<b>幾分鐘後就會出現在相簿裡</b>，
             家人也就能從那些照片裡找到自己。</p>
        </div>

        <div class="panel">
          <h3>你是誰</h3>
          <p class="hint">會記在上傳紀錄裡，讓大家知道這些照片是誰提供的。</p>
          <div class="field">
            <input class="input" id="up-name" placeholder="你的名字" value="${esc(savedName)}" maxlength="20">
          </div>
        </div>

        <div class="panel">
          <h3>家族密碼</h3>
          <p class="hint">跟管理員要。設密碼是因為網站是公開的，不擋的話陌生人也能往相簿丟東西。</p>
          <div class="field">
            <input class="input" id="up-pw" type="password" placeholder="家族密碼" value="${esc(savedPw)}">
          </div>
        </div>

        <div class="panel">
          <h3>要放進哪一本相簿？</h3>
          <div class="field" style="margin-bottom:.75rem">
            <select class="input" id="up-album">
              <option value="__new__">＋ 建立新相簿</option>
              ${albums.map((a) => `<option value="${esc(a.dir)}" ${preset && preset.id === a.id ? 'selected' : ''}>${fmtDate(a.date)} ${esc(a.title)}</option>`).join('')}
            </select>
          </div>
          <div id="up-new">
            <p class="hint">新相簿要有日期和名稱，例如「2025-01-01」＋「新年聚餐」。</p>
            <div class="field">
              <input class="input" id="up-date" type="date" style="max-width:12rem">
              <input class="input" id="up-title" placeholder="相簿名稱，例如 新年聚餐" maxlength="30">
            </div>
          </div>
        </div>

        <div class="panel">
          <h3>選照片</h3>
          <p class="hint">一次最多 40 張、單張 12MB 以內。<b>有原檔請直接傳原檔</b> —— 畫質越好，人臉認得越準。</p>
          <div class="dropzone" id="up-dz" style="padding:2rem 1rem">
            <div class="dz-icon">📤</div>
            <h3 id="up-dz-label">點這裡選照片</h3>
            <p>或把照片拖進來</p>
            <input type="file" id="up-files" accept="image/*" multiple hidden>
          </div>
          <div id="up-preview" class="facepick" style="margin-top:1rem"></div>
        </div>

        <div class="panel">
          <div style="display:flex; gap:.5rem; flex-wrap:wrap; align-items:center">
            <button class="btn" id="up-go" disabled>開始上傳</button>
            <span class="muted" id="up-status"></span>
          </div>
          <div class="progress" id="up-progress" hidden><i id="up-bar"></i></div>
        </div>
      </div>
    </div>`;

  const sel = $('#up-album');
  const newBox = $('#up-new');
  const fileInput = $('#up-files');
  const dz = $('#up-dz');
  let picked = [];

  const syncNew = () => { newBox.style.display = sel.value === '__new__' ? '' : 'none'; };
  sel.addEventListener('change', syncNew);
  syncNew();

  const setFiles = (list) => {
    picked = [...list].filter((f) => f.type.startsWith('image/')).slice(0, 40);
    $('#up-dz-label').textContent = picked.length ? `已選 ${picked.length} 張` : '點這裡選照片';
    $('#up-go').disabled = !picked.length;
    const box = $('#up-preview');
    box.innerHTML = picked.slice(0, 12).map((f) => `<button type="button" disabled><img src="${URL.createObjectURL(f)}" alt=""></button>`).join('')
      + (picked.length > 12 ? `<span class="muted" style="align-self:center">…還有 ${picked.length - 12} 張</span>` : '');
  };

  dz.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => setFiles(fileInput.files));
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); setFiles(e.dataTransfer.files); });

  $('#up-go').addEventListener('click', async () => {
    const name = $('#up-name').value.trim();
    const pw = $('#up-pw').value;
    if (!pw) return toast('請先輸入家族密碼');
    if (!picked.length) return toast('還沒選照片');

    let albumDir = sel.value;
    if (albumDir === '__new__') {
      const date = $('#up-date').value;      // YYYY-MM-DD
      const title = $('#up-title').value.trim();
      if (!date) return toast('請選新相簿的日期');
      if (!title) return toast('請幫新相簿取個名字');
      albumDir = date.replace(/-/g, '') + title;
    }

    localStorage.setItem('chou-pw', pw);
    localStorage.setItem('chou-name', name);

    const fd = new FormData();
    fd.append('password', pw);
    fd.append('album', albumDir);
    fd.append('uploader', name || '家人');
    for (const f of picked) fd.append('files', f, f.name);

    $('#up-go').disabled = true;
    $('#up-progress').hidden = false;
    $('#up-bar').style.width = '30%';
    $('#up-status').textContent = `上傳中… ${picked.length} 張`;

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const out = await res.json();
      $('#up-bar').style.width = '100%';
      if (!res.ok) throw new Error(out.error || '上傳失敗');

      $('#steps') && ($('#steps').innerHTML = '');
      view().querySelector('.finder').innerHTML = `
        <div class="empty">
          <h3>上傳成功 — ${out.count} 張</h3>
          <p>照片已經收進「${esc(out.album)}」。<br>
             系統正在跑人臉辨識，<b>大約 3~5 分鐘後</b>重新整理相簿就會看到。</p>
          <p style="margin-top:1.5rem">
            <a class="btn" href="#/upload" onclick="setTimeout(()=>location.reload(),50)">再傳一批</a>
            <a class="btn btn-ghost" href="#/">回到相簿</a>
          </p>
        </div>`;
    } catch (err) {
      $('#up-progress').hidden = true;
      $('#up-go').disabled = false;
      $('#up-status').textContent = '';
      toast(err.message, 5000);
    }
  });
}

function renderNotFound() {
  view().innerHTML = `<div class="wrap"><div class="empty"><h3>找不到這一頁</h3>
    <p><a href="#/">回首頁</a></p></div></div>`;
}

/* ============ 燈箱 ============ */

function openLightbox(list, idx) {
  S.lb.list = list;
  S.lb.idx = idx;
  $('#lightbox').hidden = false;
  document.body.style.overflow = 'hidden';
  showPhoto();
}

function closeLightbox() {
  $('#lightbox').hidden = true;
  document.body.style.overflow = '';
}

/** 申請刪除當前這張照片（走管理員核准流程） */
function requestPhotoDelete(pi) {
  const photo = S.faces.photos[pi];
  if (!photo) return;
  const albumId = photo.a;
  const m = (photo.w || photo.t || '').match(/\/([^/]+)\.webp$/);
  const name = m ? m[1] : null;
  if (!name) return toast('無法辨識這張照片');
  const album = S.albums.albums.find((a) => a.id === albumId);
  const albumTitle = album ? album.title : '';
  showFaceSheet(`
    <h3>申請刪除這張照片</h3>
    <p class="hint">來自「${esc(albumTitle)}」。送出後管理員看過核准才會真的刪掉。</p>
    <div class="edit-grid" style="margin-top:.75rem">
      <label class="fld"><span>你是誰？</span>
        <input class="input" id="pd-by" placeholder="你的名字" value="${esc(localStorage.getItem('chou-name') || '')}"></label>
      <label class="fld"><span>家族密碼</span>
        <input class="input" id="pd-pw" type="password" value="${esc(localStorage.getItem('chou-pw') || '')}"></label>
    </div>
    <div style="display:flex; gap:.5rem; align-items:center; margin-top:1rem; flex-wrap:wrap">
      <button class="btn" id="pd-send">送出申請</button>
      <button class="btn btn-ghost" id="pd-cancel">取消</button>
      <span class="muted" id="pd-msg"></span>
    </div>`);
  $('#pd-cancel').addEventListener('click', closeFaceSheet);
  $('#pd-send').addEventListener('click', async () => {
    const by = $('#pd-by').value.trim();
    const pw = $('#pd-pw').value;
    if (!by) return toast('請填你的名字');
    if (!pw) return toast('請輸入家族密碼');
    localStorage.setItem('chou-name', by);
    localStorage.setItem('chou-pw', pw);
    $('#pd-send').disabled = true; $('#pd-msg').textContent = '送出中…';
    const fd = new FormData();
    fd.append('password', pw); fd.append('submittedBy', by);
    fd.append('albumId', albumId); fd.append('deletePhotoName', name);
    try {
      const r = await fetch('/api/propose', { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '送出失敗');
      showFaceSheet(`<h3>收到了 🙏</h3><p class="hint">刪除申請已送出，管理員核准後就會刪掉。</p>
        <div style="margin-top:1rem"><button class="btn" id="pd-ok">好</button></div>`);
      $('#pd-ok').addEventListener('click', closeFaceSheet);
    } catch (err) { $('#pd-send').disabled = false; $('#pd-msg').textContent = ''; toast(err.message, 5000); }
  });
}

/* ============ 照片互動：愛心 ❤ ＋ 留言 💬 ============ */

/** 依 S.interactions 更新目前這張的愛心/留言鈕外觀 */
function updateSocialButtons(pi) {
  const key = photoKey(pi);
  const it = (key && S.interactions[key]) || { h: [], c: [] };
  const hearts = it.h || [], comments = it.c || [];
  const mine = S.me && hearts.includes(S.me);
  const hb = $('#lb-heart');
  hb.firstChild.textContent = mine ? '❤️ ' : '🤍 ';
  hb.classList.toggle('on', !!mine);
  $('#lb-heart-n').textContent = hearts.length || '';
  $('#lb-comment-n').textContent = comments.length || '';
}

async function toggleHeart(pi) {
  const key = photoKey(pi);
  if (!key) return;
  const it = S.interactions[key] || (S.interactions[key] = { h: [], c: [] });
  it.h = it.h || [];
  // 樂觀更新：先動畫面，再送出
  const had = S.me && it.h.includes(S.me);
  if (had) it.h = it.h.filter((n) => n !== S.me); else it.h.push(S.me || '家人');
  updateSocialButtons(pi);
  try {
    const r = await fetch('/api/interactions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'heart', key }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '失敗');
    // 以伺服器回來的數字為準（避免多裝置不同步）
  } catch (err) {
    // 失敗就還原
    if (had) it.h.push(S.me || '家人'); else it.h = it.h.filter((n) => n !== S.me);
    updateSocialButtons(pi);
    toast(err.message, 4000);
  }
}

/** 留言：用底部面板列出＋輸入 */
function openComments(pi) {
  const key = photoKey(pi);
  if (!key) return;
  const render = () => {
    const it = S.interactions[key] || { h: [], c: [] };
    const comments = it.c || [];
    showFaceSheet(`
      <h3>留言 · 回憶</h3>
      <div class="cmt-list" id="cmt-list">
        ${comments.length ? comments.map((c) => `
          <div class="cmt" data-cid="${esc(c.id)}">
            <div class="cmt-head"><b>${esc(c.by)}</b><span>${esc(c.at)}</span></div>
            <div class="cmt-text">${esc(c.text)}</div>
            ${(c.by === S.me || sessionStorage.getItem('chou-admin')) ? `<button class="cmt-del" data-cid="${esc(c.id)}">刪除</button>` : ''}
          </div>`).join('') : '<p class="hint">還沒有人留言，來寫下第一句回憶吧。</p>'}
      </div>
      <div class="cmt-input">
        <input class="input" id="cmt-text" placeholder="寫下這張照片的回憶…" maxlength="500">
        <button class="btn" id="cmt-send">送出</button>
      </div>`);

    $('#cmt-send').addEventListener('click', async () => {
      const text = $('#cmt-text').value.trim();
      if (!text) return toast('留言不能空白');
      $('#cmt-send').disabled = true;
      try {
        const r = await fetch('/api/interactions', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'comment', key, text }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || '送出失敗');
        const it = S.interactions[key] || (S.interactions[key] = { h: [], c: [] });
        it.c = it.c || []; it.c.push(d.comment);
        updateSocialButtons(pi);
        render();
      } catch (err) { $('#cmt-send').disabled = false; toast(err.message, 4000); }
    });
    $('#cmt-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#cmt-send').click(); });

    $('#cmt-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('.cmt-del');
      if (!btn) return;
      if (!confirm('刪掉這則留言？')) return;
      const cid = btn.dataset.cid;
      try {
        const r = await fetch('/api/interactions', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'uncomment', key, cid, adminPassword: sessionStorage.getItem('chou-admin') || undefined }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || '刪除失敗');
        const it = S.interactions[key]; if (it) it.c = (it.c || []).filter((x) => x.id !== cid);
        updateSocialButtons(pi);
        render();
      } catch (err) { toast(err.message, 4000); }
    });
  };
  render();
}

function showPhoto() {
  const pi = S.lb.list[S.lb.idx];
  const photo = S.faces.photos[pi];
  const album = S.photoAlbum[pi];
  const img = $('#lb-img');
  img.src = photo.w;
  img.alt = photo.src;

  $('#lb-caption').textContent =
    `${album ? album.title + ' · ' : ''}${fmtDate(album && album.date)} — ${S.lb.idx + 1} / ${S.lb.list.length}`;

  const dl = $('#lb-download');
  dl.href = photo.o || photo.w;
  dl.setAttribute('download', photo.src || 'photo.jpg');

  // 申請刪除這張照片（送出後要管理員核准才會真的刪）
  const del = $('#lb-delete');
  del.onclick = () => requestPhotoDelete(pi);

  updateSocialButtons(pi);

  $('#lb-faces').innerHTML = '';
  img.onload = () => drawFaceBoxes(pi);
  if (img.complete) drawFaceBoxes(pi);

  // 預先載下一張，翻頁比較順
  const next = S.lb.list[S.lb.idx + 1];
  if (next != null) new Image().src = S.faces.photos[next].w;
}

function drawFaceBoxes(pi) {
  const layer = $('#lb-faces');
  layer.classList.toggle('on', S.lb.showFaces);
  if (!S.lb.showFaces) { layer.innerHTML = ''; return; }

  const faces = [];
  for (let i = 0; i < S.faces.faces.length; i++) if (S.faces.faces[i].p === pi) faces.push(i);

  layer.innerHTML = faces.map((i) => {
    const f = S.faces.faces[i];
    const [x, y, w, h] = f.b;
    const who = whoIs(i);
    // 顯示人臉時每張臉都可以點：認得出的 → 看那個人；認不出的 → 標記給某位家人
    const label = who ? esc(who) : (f.q ? '＋ 標記' : '');
    return `<div class="lb-face ${who ? 'named' : ''} ${f.q ? 'taggable' : ''}" data-fi="${i}"
      style="left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%">
      ${label ? `<span class="lbl">${label}</span>` : ''}
    </div>`;
  }).join('');
}

/** 這張臉是誰？拿名冊比對。認不出來就回 null，寧可不標也不要標錯。 */
function whoIsPerson(faceIdx) {
  const f = S.faces.faces[faceIdx];
  if (!f.q) return null;
  const d = descAt(faceIdx);
  const limit = STRICTNESS.strict.value - sizePenalty(f.px);
  let best = null, bestDist = limit;
  for (const p of S.people) {
    for (const r of (p.refs || [])) {
      if (!r.d) continue;
      const dist = distance(Float32Array.from(r.d), d);
      if (dist < bestDist) { bestDist = dist; best = p; }
    }
  }
  return best;
}
function whoIs(faceIdx) {
  const p = whoIsPerson(faceIdx);
  return p ? p.name : null;
}

/* ============ 在照片上標記人臉 → 家族成員 ============ */

/** 認得出的臉：選單 —— 看這個人 / 標記給別人（認錯時更正） */
function openFaceMenu(faceIdx, person) {
  showFaceSheet(`
    <h3>這是 ${esc(person.name)}？</h3>
    <div style="display:flex; gap:.5rem; flex-wrap:wrap; margin-top:1rem">
      <a class="btn" href="#/person/${encodeURIComponent(person.id)}" id="fs-view">看 ${esc(person.name)} 的資料與關係</a>
      <button class="btn btn-ghost" id="fs-retag">認錯了，標記給別人</button>
    </div>`);
  $('#fs-view').addEventListener('click', closeFaceSheet);
  $('#fs-retag').addEventListener('click', () => openFaceTag(faceIdx, person));
}

/** 標記面板：把這張臉指定給某位家族成員 */
function openFaceTag(faceIdx, current) {
  const opts = S.people
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.note ? '（' + esc(p.note) + '）' : ''}</option>`)
    .join('');

  showFaceSheet(`
    <h3>這張臉是誰？</h3>
    <p class="hint">選出這是族譜裡的哪一位，送出馬上生效，系統之後就會在別的照片裡自動認出他。</p>
    <div class="edit-grid" style="margin-top:.75rem">
      <label class="fld">
        <span>是這位家人</span>
        <select class="input" id="fs-person"><option value="">請選擇…</option>${opts}</select>
      </label>
    </div>
    <div style="display:flex; gap:.5rem; align-items:center; margin-top:1rem; flex-wrap:wrap">
      <button class="btn" id="fs-send">標記</button>
      <button class="btn btn-ghost" id="fs-cancel">取消</button>
      <span class="muted" id="fs-msg"></span>
    </div>`);

  if (current) $('#fs-person').value = current.id;
  $('#fs-cancel').addEventListener('click', closeFaceSheet);
  $('#fs-send').addEventListener('click', () => submitFaceTag(faceIdx));
}

async function submitFaceTag(faceIdx) {
  const personId = $('#fs-person').value;
  if (!personId) return toast('請選一位家人');

  const f = S.faces.faces[faceIdx];
  const photo = S.faces.photos[f.p];
  const person = S.people.find((p) => p.id === personId);
  // 這張臉的位置、特徵值都已經在建置時算好了，直接送
  const ref = { p: photo.w, b: f.b, d: Array.from(descAt(faceIdx)).map((v) => +v.toFixed(5)) };

  $('#fs-send').disabled = true;
  $('#fs-msg').textContent = '標記中…';

  try {
    const res = await fetch('/api/tag', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personId, ref }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || '標記失敗');
    // 本機也加上這筆 ref，讓辨識馬上生效（不用等重新載入）
    if (person && !out.dup) { person.refs = person.refs || []; person.refs.push(ref); }
    closeFaceSheet();
    toast(`已標記為 ${person ? person.name : ''} ✓`, 3000);
    // 若正在看燈箱，重畫人臉框（剛標的臉會變成「認得出」）
    if (!$('#lightbox').hidden && S.lb.showFaces) drawFaceBoxes(S.lb.list[S.lb.idx]);
  } catch (err) {
    $('#fs-send').disabled = false;
    $('#fs-msg').textContent = '';
    toast(err.message, 5000);
  }
}

function showFaceSheet(html) {
  let sheet = $('#face-sheet');
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'face-sheet';
    sheet.className = 'face-sheet';
    sheet.innerHTML = `<div class="face-sheet-bg"></div><div class="face-sheet-card"></div>`;
    document.body.appendChild(sheet);
    sheet.querySelector('.face-sheet-bg').addEventListener('click', closeFaceSheet);
  }
  sheet.querySelector('.face-sheet-card').innerHTML = html;
  sheet.hidden = false;
}
function closeFaceSheet() { const s = $('#face-sheet'); if (s) s.hidden = true; }

/* ============ 管理模式：標記人名 ============ */

function initAdmin() {
  if (!IS_ADMIN) return;
  const bar = document.createElement('div');
  bar.className = 'admin-bar';
  bar.innerHTML = `
    <span>管理模式 — 打開任一張照片按「顯示人臉」，點人臉就能命名。
      <b id="draft-count">草稿 ${S.draft.people.length} 人</b></span>
    <span style="display:flex;gap:.5rem">
      <a class="btn btn-sm" href="#/review" style="text-decoration:none">待審的修正</a>
      <button class="btn btn-sm" id="admin-export">匯出 people.json</button>
      <button class="btn btn-sm btn-ghost" id="admin-clear" style="color:#fff;border-color:rgba(255,255,255,.3)">清空草稿</button>
    </span>`;
  document.body.insertBefore(bar, $('#topbar').nextSibling);

  $('#admin-export').addEventListener('click', exportPeople);
  $('#admin-clear').addEventListener('click', () => {
    if (!confirm('確定清空所有還沒匯出的標記草稿？')) return;
    S.draft = { people: [] };
    saveDraft();
    location.reload();
  });

  // 點燈箱裡的人臉 → 命名
  $('#lb-faces').addEventListener('click', (e) => {
    const el = e.target.closest('.lb-face');
    if (!el) return;
    nameFace(+el.dataset.fi);
  });

  S.lb.showFaces = true;
}

function nameFace(faceIdx) {
  const f = S.faces.faces[faceIdx];
  const photo = S.faces.photos[f.p];
  const current = whoIs(faceIdx);
  const name = prompt('這張臉是誰？（留空取消）', current || '');
  if (!name || !name.trim()) return;

  const ref = {
    p: photo.w,
    b: f.b,
    d: Array.from(descAt(faceIdx)).map((v) => +v.toFixed(5)),
  };

  let person = S.draft.people.find((p) => p.name === name.trim());
  if (!person) { person = { name: name.trim(), refs: [] }; S.draft.people.push(person); }
  person.refs.push(ref);
  saveDraft();

  // 讓當下畫面立刻反映
  let live = S.people.find((p) => p.name === name.trim());
  if (!live) { live = { name: name.trim(), refs: [] }; S.people.push(live); }
  live.refs.push(ref);

  $('#draft-count').textContent = `草稿 ${S.draft.people.length} 人`;
  drawFaceBoxes(f.p);
  toast(`已標記：${name.trim()}（${person.refs.length} 張參考臉）`);
}

function exportPeople() {
  if (!S.draft.people.length) return toast('草稿是空的，還沒標記任何人');
  // 跟已經在 people.json 裡的合併
  fetch('data/people.json').then((r) => r.json()).catch(() => ({ people: [] })).then((existing) => {
    const out = { people: [] };
    const byName = new Map();
    for (const p of [...(existing.people || []), ...S.draft.people]) {
      if (!byName.has(p.name)) { const np = { name: p.name, refs: [] }; byName.set(p.name, np); out.people.push(np); }
      byName.get(p.name).refs.push(...p.refs);
    }
    out.people.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));

    const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'people.json';
    a.click();
    toast(`已匯出 ${out.people.length} 個人 — 存到 public/data/people.json 再 push`);
  });
}

/* ============ 路由 ============ */

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [page, arg] = hash.split('/');
  window.scrollTo(0, 0);

  if (!page) return renderHome();
  if (page === 'album' && arg) return renderAlbum(arg);
  if (page === 'find') return renderFind();
  if (page === 'upload') return renderUpload(arg ? decodeURIComponent(arg) : null);
  if (page === 'people' || page === 'tree') return renderTree();
  if (page === 'board') return renderBoard();
  if (page === 'identify') return renderIdentify();
  if (page === 'review') return renderReview();
  if (page === 'person' && arg) return renderPerson(decodeURIComponent(arg));
  renderNotFound();
}

/* ============ 啟動 ============ */

function initLightbox() {
  $('#lb-close').addEventListener('click', closeLightbox);
  $('#lb-prev').addEventListener('click', () => { S.lb.idx = (S.lb.idx - 1 + S.lb.list.length) % S.lb.list.length; showPhoto(); });
  $('#lb-next').addEventListener('click', () => { S.lb.idx = (S.lb.idx + 1) % S.lb.list.length; showPhoto(); });
  $('#lb-toggle-faces').addEventListener('click', () => {
    S.lb.showFaces = !S.lb.showFaces;
    $('#lb-toggle-faces').textContent = S.lb.showFaces ? '隱藏人臉' : '顯示人臉';
    drawFaceBoxes(S.lb.list[S.lb.idx]);
  });
  $('#lb-stage').addEventListener('click', (e) => { if (e.target.id === 'lb-stage') closeLightbox(); });
  $('#lb-heart').addEventListener('click', () => toggleHeart(S.lb.list[S.lb.idx]));
  $('#lb-comment').addEventListener('click', () => openComments(S.lb.list[S.lb.idx]));

  // 點人臉框 → 認得出就去看那個人，認不出就標記給某位家人
  $('#lb-faces').addEventListener('click', (e) => {
    const el = e.target.closest('.lb-face.taggable');
    if (!el) return;
    const fi = +el.dataset.fi;
    const person = whoIsPerson(fi);
    if (person) openFaceMenu(fi, person);
    else openFaceTag(fi, null);
  });

  document.addEventListener('keydown', (e) => {
    if ($('#lightbox').hidden) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') $('#lb-prev').click();
    if (e.key === 'ArrowRight') $('#lb-next').click();
  });

  // 手機滑動翻頁
  let x0 = null;
  $('#lb-stage').addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  $('#lb-stage').addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 60) (dx > 0 ? $('#lb-prev') : $('#lb-next')).click();
    x0 = null;
  }, { passive: true });
}

/* ============ 登入牆 ============ */

/** 檢查有沒有登入。/api/whoami 只回 {ok} 很便宜。 */
async function isLoggedIn() {
  try {
    const r = await fetch('/api/login', { method: 'GET', cache: 'no-store' });
    if (!r.ok) return false;
    const d = await r.json();
    S.me = d.who || null;
    return !!d.ok;
  } catch { return false; }
}

function renderLogin() {
  document.body.classList.add('locked');
  let scr = document.getElementById('login-screen');
  if (!scr) {
    scr = document.createElement('div');
    scr.id = 'login-screen';
    document.body.appendChild(scr);
  }
  scr.innerHTML = `
    <img class="login-bg" src="photos/20250503/w/0004.webp" alt="">
    <div class="login-shade"></div>
    <div class="login-card">
      <h1>周氏大家族</h1>
      <p class="login-sub">這是家人專屬的相簿。<br>為了保護大家的隱私，請確認你是家人。</p>
      <div class="login-form">
        <input class="input" id="lg-name" placeholder="你的名字" autocomplete="off">
        <input class="input" id="lg-rel" placeholder="爸爸或媽媽的名字（擇一）" autocomplete="off">
        <input class="input" id="lg-pw" type="password" placeholder="家族密碼">
        <button class="btn" id="lg-go">進入相簿</button>
        <p class="login-hint" id="lg-msg">族譜上沒有你父母的話，可以填另一半或小孩的名字。</p>
      </div>
    </div>`;

  const submit = async () => {
    const name = document.getElementById('lg-name').value.trim();
    const rel = document.getElementById('lg-rel').value.trim();
    const pw = document.getElementById('lg-pw').value;
    if (!name || !rel || !pw) { document.getElementById('lg-msg').textContent = '三個欄位都要填喔。'; return; }
    const btn = document.getElementById('lg-go');
    btn.disabled = true; document.getElementById('lg-msg').textContent = '確認中…';
    try {
      const fd = new FormData();
      fd.append('name', name); fd.append('relative', rel); fd.append('password', pw);
      const r = await fetch('/api/login', { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '登入失敗');
      // 把名字記起來，之後上傳/修正表單自動帶入
      localStorage.setItem('chou-name', name);
      localStorage.setItem('chou-pw', pw);
      location.reload();
    } catch (err) {
      btn.disabled = false;
      document.getElementById('lg-msg').textContent = err.message;
    }
  };
  document.getElementById('lg-go').addEventListener('click', submit);
  scr.querySelectorAll('.input').forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }));
}

async function main() {
  // 先過登入牆：沒登入只看得到登入頁，拿不到族譜的名字與關係
  if (!(await isLoggedIn())) { renderLogin(); return; }
  document.body.classList.remove('locked');

  view().innerHTML = `<div class="wrap"><div class="loading"><span class="spinner"></span>載入相簿…</div></div>`;
  try {
    await loadData();
  } catch (e) {
    // 中途 session 失效（例如過期）→ 回登入頁
    if (e && e.needLogin) { renderLogin(); return; }
    view().innerHTML = `<div class="wrap"><div class="empty"><h3>載入失敗</h3><p>${esc(e.message)}</p></div></div>`;
    return;
  }
  initLightbox();
  initAdmin();
  const lo = document.getElementById('logout-link');
  if (lo) lo.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!confirm('要登出嗎？下次要重新輸入名字和密碼。')) return;
    await fetch('/api/login?logout=1').catch(() => {});
    location.reload();
  });
  window.addEventListener('hashchange', route);
  route();
}

main();
