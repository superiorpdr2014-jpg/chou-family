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
};

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
  const [albums, faces, binBuf, people] = await Promise.all([
    get('data/albums.json').then((r) => r.json()),
    get('data/faces.json').then((r) => r.json()),
    get('data/faces.bin').then((r) => r.arrayBuffer()),
    get('data/people.json').then((r) => r.json()).catch(() => ({ people: [] })),
  ]);
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

  const totalFaces = faces.count;
  $('#footer-stats').textContent =
    `${albums.albums.length} 本相簿 · ${faces.photos.length} 張照片 · 辨識出 ${totalFaces} 張人臉`;
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
  const cover = 'photos/2024427/w/0014.webp';
  const totalPhotos = S.faces.photos.length;

  view().innerHTML = `
    <section class="hero">
      <img class="hero-img" src="${cover}" alt="周氏大家族合照">
      <div class="hero-shade"></div>
      <div class="hero-inner">
        <h1>周氏大家族的點點滴滴</h1>
        <p>${albums.length} 本相簿、${totalPhotos} 張照片，記錄我們一起走過的日子。<br>上傳一張自己的照片，就能找出每個時期有你的合影。</p>
        <a class="hero-cta" href="#/find">找出我的照片 →</a>
      </div>
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
}

/* ============ 畫面：單一相簿 ============ */

function renderAlbum(id) {
  const a = S.albums.albums.find((x) => x.id === id);
  if (!a) return renderNotFound();

  view().innerHTML = `
    <div class="wrap">
      <a class="back-link" href="#/">← 回到相簿</a>
      <div class="section-head">
        <div class="album-date">${fmtDate(a.date)}</div>
        <h2>${esc(a.title)}</h2>
        <p>${a.count} 張照片</p>
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
  return `
    <a class="tp ${p.gender === 'F' ? 'f' : p.gender === 'M' ? 'm' : ''}" href="#/person/${encodeURIComponent(p.id)}">
      <span class="tp-av" ${av ? `data-crop="${esc(JSON.stringify(av))}"` : ''}>${av ? '' : esc(initial)}</span>
      <span class="tp-name">${esc(p.name)}</span>
      <span class="tp-sub">${n ? n + ' 張照片' : (p.note ? esc(p.note) : '還沒認照片')}</span>
    </a>`;
}

/** 大頭照：優先用建置時挑好的那張，沒有就退回第一張指認的臉 */
function avatarOf(p) {
  if (p.avatar && p.avatar.p) return p.avatar;
  if (p.refs && p.refs.length) return p.refs[0];
  return null;
}

/** 遞迴畫一個家庭：一對夫妻（或單身）＋他們的小孩 */
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

  const coupleHtml = members.map(personCardHtml).join('<span class="tp-eq"></span>');

  const kidsHtml = kids.length ? `
    <div class="branch">
      ${kids.map((k) => `<div class="child">${familyNodeHtml(k, ctx, seen)}</div>`).join('')}
    </div>` : '';

  return `<div class="node"><div class="couple">${coupleHtml}</div>${kidsHtml}</div>`;
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

  // 有登記名字但接不上樹的人（還沒填關係），另外列出來，不要讓他們消失
  const orphans = S.people.filter((p) => !seen.has(p.id));

  view().innerHTML = `
    <div class="wrap">
      <div class="section-head">
        <h2>族譜</h2>
        <p>${S.people.length} 位家人 · 點任何一個人，看他的照片</p>
      </div>
      <div class="tree-scroll">
        <div class="tree">${trees.join('')}</div>
      </div>
      ${orphans.length ? `
        <div class="section-head" style="margin-top:3rem">
          <h2 style="font-size:1.1rem">還沒接上族譜</h2>
          <p>這些家人還沒填上一代/下一代的關係</p>
        </div>
        <div class="tree"><div class="couple">${orphans.map(personCardHtml).join('')}</div></div>` : ''}
      <p class="muted" style="margin-top:2.5rem; font-size:.85rem">
        族譜還不完整？<a href="#/upload">上傳照片</a>時可以順便登記自己和家人的關係。
      </p>
    </div>`;

  hydrateAvatars();

  // 樹比螢幕寬的時候，預設捲到中間，不然一打開只看到最左邊那一房。
  // 要等瀏覽器排版完才知道 scrollWidth，直接設會拿到 0。
  requestAnimationFrame(() => {
    const sc = $('.tree-scroll');
    if (sc) sc.scrollLeft = (sc.scrollWidth - sc.clientWidth) / 2;
  });
}

/** 頭像是從照片裡把臉裁出來的，等畫面畫好再補上 */
function hydrateAvatars() {
  for (const el of document.querySelectorAll('[data-crop]')) {
    let ref;
    try { ref = JSON.parse(el.dataset.crop); } catch { continue; }
    if (!ref || !ref.p) continue;
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
      <a class="back-link" href="#/people">← 回到族譜</a>
      <div class="person-head">
        <span class="person-av" ${av ? `data-crop="${esc(JSON.stringify(av))}"` : ''}>${av ? '' : esc((person.name || '?').charAt(0))}</span>
        <div class="section-head" style="margin:0">
          <h2>${esc(person.name)}</h2>
          ${person.note ? `<p>${esc(person.note)}</p>` : ''}
          ${rel.length ? `<p style="margin-top:.5rem">${rel.join(' ｜ ')}</p>` : ''}
        </div>
      </div>
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

  const order = matches.map((m) => m.pi);
  $('#pres').addEventListener('click', (e) => {
    const btn = e.target.closest('.tile');
    if (btn) openLightbox(order, order.indexOf(+btn.dataset.pi));
  });
}

/* ============ 畫面：上傳照片 ============ */

function renderUpload() {
  const albums = S.albums.albums;
  const savedPw = localStorage.getItem('chou-pw') || '';
  const savedName = localStorage.getItem('chou-name') || '';

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
          <p class="hint">跟 Jay 要。設密碼是因為網站是公開的，不擋的話陌生人也能往相簿丟東西。</p>
          <div class="field">
            <input class="input" id="up-pw" type="password" placeholder="家族密碼" value="${esc(savedPw)}">
          </div>
        </div>

        <div class="panel">
          <h3>要放進哪一本相簿？</h3>
          <div class="field" style="margin-bottom:.75rem">
            <select class="input" id="up-album">
              <option value="__new__">＋ 建立新相簿</option>
              ${albums.map((a) => `<option value="${esc(a.dir)}">${fmtDate(a.date)} ${esc(a.title)}</option>`).join('')}
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
    return `<div class="lb-face ${who ? 'named' : ''}" data-fi="${i}"
      style="left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%">
      ${who ? `<span class="lbl">${esc(who)}</span>` : IS_ADMIN ? '<span class="lbl">點我命名</span>' : ''}
    </div>`;
  }).join('');
}

/** 這張臉是誰？拿名冊比對。認不出來就回 null，寧可不標也不要標錯。 */
function whoIs(faceIdx) {
  const f = S.faces.faces[faceIdx];
  if (!f.q) return null;
  const d = descAt(faceIdx);
  const limit = STRICTNESS.strict.value - sizePenalty(f.px);
  let best = null, bestDist = limit;
  for (const p of S.people) {
    for (const r of p.refs) {
      const dist = distance(Float32Array.from(r.d), d);
      if (dist < bestDist) { bestDist = dist; best = p.name; }
    }
  }
  return best;
}

/* ============ 管理模式：標記人名 ============ */

function initAdmin() {
  if (!IS_ADMIN) return;
  const bar = document.createElement('div');
  bar.className = 'admin-bar';
  bar.innerHTML = `
    <span>管理模式 — 打開任一張照片按「顯示人臉」，點人臉就能命名。
      <b id="draft-count">草稿 ${S.draft.people.length} 人</b></span>
    <span style="display:flex;gap:.5rem">
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
  if (page === 'upload') return renderUpload();
  if (page === 'people' || page === 'tree') return renderTree();
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

async function main() {
  view().innerHTML = `<div class="wrap"><div class="loading"><span class="spinner"></span>載入相簿…</div></div>`;
  try {
    await loadData();
  } catch (e) {
    view().innerHTML = `<div class="wrap"><div class="empty"><h3>載入失敗</h3><p>${esc(e.message)}</p></div></div>`;
    return;
  }
  initLightbox();
  initAdmin();
  window.addEventListener('hashchange', route);
  route();
}

main();
