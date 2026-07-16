/*
 * 周氏大家族相簿 — 建置腳本
 *
 * 做三件事：
 *   1. 把來源相簿的照片壓成網頁版 (2048px) + 縮圖 (480px)，原圖照抄一份保存
 *   2. 對每張照片跑人臉偵測，算出 128 維特徵值
 *   3. 產出 data/albums.json + data/faces.json + data/faces.bin
 *
 * 用法：node scripts/build.js [來源資料夾]
 * 預設來源：photos-source/
 *
 * 已處理過的照片會跳過（依檔名+大小+修改時間快取），所以新增相簿後重跑很快。
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
const { setWasmPaths } = require('@tensorflow/tfjs-backend-wasm');

const ROOT = path.join(__dirname, '..');
const SRC = process.argv[2] || path.join(ROOT, 'photos-source');
const PUBLIC = path.join(ROOT, 'public');
const MODELS = path.join(PUBLIC, 'models');
const DATA = path.join(PUBLIC, 'data');
const PHOTOS = path.join(PUBLIC, 'photos');
const CACHE_FILE = path.join(ROOT, '.build-cache.json');
const WASM_DIR = path.join(ROOT, 'node_modules', '@tensorflow', 'tfjs-backend-wasm', 'dist') + path.sep;

const WEB_WIDTH = 2048;   // 燈箱看的大圖
const THUMB_WIDTH = 480;  // 相簿格子縮圖
const DETECT_WIDTH = 1600; // 人臉偵測用的解析度（合照人臉小，不能太低）
const MIN_CONFIDENCE = 0.3;
const KEEP_ORIGINALS = true;

// 能不能拿來比對身分的品質門檻。
// 實測（scripts/probe.js）：合照裡 40px 以下的臉，特徵值幾乎是雜訊，
// 會跟每個人都「很像」，把整個比對搞爛。寧可漏掉也不要認錯人。
const MATCH_MIN_PX = 48;
const MATCH_MIN_SCORE = 0.5;

const IMAGE_EXT = /\.(jpe?g|png|webp|heic)$/i;

// ---------- 小工具 ----------

const log = (...a) => console.log(...a);

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

/** 從資料夾名解析日期與標題，例如 "20190929二房辦聚會" → 2019-09-29 + "二房辦聚會" */
function parseAlbumName(name) {
  const m = name.match(/^(\d+)\s*(.*)$/);
  if (!m) return { id: slug(name), date: null, title: name };
  const digits = m[1];
  // LINE 匯出的資料夾常帶一段 "_260716" 的匯出日期，那不是標題的一部分
  // 例：「20170610_260716 黃裕文婚禮」→「黃裕文婚禮」
  const rest = m[2].replace(/^_\d+/, '').replace(/^[_\-\s]+/, '').trim();
  let y = null, mo = null, d = null;
  if (digits.length === 8) { y = digits.slice(0, 4); mo = digits.slice(4, 6); d = digits.slice(6, 8); }
  else if (digits.length === 7) { y = digits.slice(0, 4); mo = digits.slice(4, 5); d = digits.slice(5, 7); }
  else if (digits.length === 6) { y = digits.slice(0, 4); mo = digits.slice(4, 6); }
  else if (digits.length === 4) { y = digits; }
  const valid = y && +y >= 1900 && +y <= 2100 && (!mo || (+mo >= 1 && +mo <= 12)) && (!d || (+d >= 1 && +d <= 31));
  if (!valid) return { id: slug(name), date: null, title: name };
  const date = [y, mo && String(+mo).padStart(2, '0'), d && String(+d).padStart(2, '0')].filter(Boolean).join('-');
  return { id: digits, date, title: rest || null, year: +y };
}

function slug(s) {
  return s.replace(/[^a-zA-Z0-9一-龥]+/g, '-').replace(/^-|-$/g, '') || 'album';
}

/** 自然排序：_2 要排在 _10 前面 */
function naturalCompare(a, b) {
  return a.localeCompare(b, 'zh-Hant', { numeric: true, sensitivity: 'base' });
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}

// ---------- 人臉辨識 ----------

async function initFaceApi() {
  setWasmPaths(WASM_DIR);
  await faceapi.tf.setBackend('wasm');
  await faceapi.tf.ready();
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODELS);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS);
  log(`人臉模型載入完成 (backend: ${faceapi.tf.getBackend()})`);
}

/** 回傳該張照片的人臉：位置用 0~1 相對座標，才能對應到任何尺寸 */
async function detectFaces(buffer) {
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize({ width: DETECT_WIDTH, withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const tensor = faceapi.tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]);
  try {
    const results = await faceapi
      .detectAllFaces(tensor, new faceapi.SsdMobilenetv1Options({ minConfidence: MIN_CONFIDENCE, maxResults: 100 }))
      .withFaceLandmarks()
      .withFaceDescriptors();

    return results.map((r) => {
      const b = r.detection.box;
      return {
        box: [
          +(b.x / info.width).toFixed(5),
          +(b.y / info.height).toFixed(5),
          +(b.width / info.width).toFixed(5),
          +(b.height / info.height).toFixed(5),
        ],
        score: +r.detection.score.toFixed(3),
        descriptor: Array.from(r.descriptor),
      };
    });
  } finally {
    tensor.dispose();
  }
}

// ---------- 主流程 ----------

async function main() {
  if (!fs.existsSync(SRC)) {
    // 沒有來源照片，但資料已經建好了 —— 這是在 Cloudflare 之類的地方跑到的情況
    // （原始照片是 gitignored 的，本來就不會在那裡）。直接放行，別把部署搞掛。
    if (fs.existsSync(path.join(DATA, 'albums.json'))) {
      log(`沒有來源資料夾 ${SRC}，但 public/data 已經有建好的資料 — 跳過建置。`);
      log(`（部署不需要重跑建置，照片和特徵值都已經在 repo 裡了。）`);
      return;
    }
    console.error(`找不到來源資料夾：${SRC}`);
    console.error(`把相簿資料夾放進 photos-source/，或用 node scripts/build.js "來源路徑"`);
    process.exit(1);
  }

  await initFaceApi();
  ensureDir(DATA);
  ensureDir(PHOTOS);

  const cache = loadCache();
  const nextCache = {};

  const albumDirs = fs.readdirSync(SRC)
    .filter((n) => fs.statSync(path.join(SRC, n)).isDirectory())
    .sort(naturalCompare);

  const albums = [];
  const allFaces = [];   // {photo: globalPhotoIndex, box, score}
  const descriptors = []; // Float32Array(128) 一一對應 allFaces
  const photoIndex = []; // 全域照片清單，faces.json 用
  let processed = 0, skipped = 0;

  for (const dirName of albumDirs) {
    const meta = parseAlbumName(dirName);
    const albumDir = path.join(SRC, dirName);
    const files = fs.readdirSync(albumDir)
      .filter((f) => IMAGE_EXT.test(f))
      .sort(naturalCompare);
    if (!files.length) continue;

    const outW = path.join(PHOTOS, meta.id, 'w');
    const outT = path.join(PHOTOS, meta.id, 't');
    const outO = path.join(PHOTOS, meta.id, 'o');
    ensureDir(outW); ensureDir(outT);
    if (KEEP_ORIGINALS) ensureDir(outO);

    const photos = [];
    log(`\n[${meta.id}] ${meta.title || meta.date || dirName} — ${files.length} 張`);

    for (let i = 0; i < files.length; i++) {
      const srcPath = path.join(albumDir, files[i]);
      const st = fs.statSync(srcPath);
      const key = `${meta.id}/${files[i]}`;
      const stamp = `${st.size}-${Math.floor(st.mtimeMs)}`;
      const name = String(i + 1).padStart(4, '0');
      const webRel = `photos/${meta.id}/w/${name}.webp`;
      const thumbRel = `photos/${meta.id}/t/${name}.webp`;
      const origRel = KEEP_ORIGINALS ? `photos/${meta.id}/o/${name}${path.extname(files[i]).toLowerCase()}` : null;

      const cached = cache[key];
      let entry;

      if (cached && cached.stamp === stamp && fs.existsSync(path.join(PUBLIC, webRel))) {
        entry = cached.entry;
        skipped++;
      } else {
        const buffer = fs.readFileSync(srcPath);
        const img = sharp(buffer).rotate();
        const info = await img.metadata();

        await sharp(buffer).rotate()
          .resize({ width: WEB_WIDTH, withoutEnlargement: true })
          .webp({ quality: 85 })
          .toFile(path.join(PUBLIC, webRel));

        await sharp(buffer).rotate()
          .resize({ width: THUMB_WIDTH, height: THUMB_WIDTH, fit: 'cover', position: 'attention', withoutEnlargement: true })
          .webp({ quality: 75 })
          .toFile(path.join(PUBLIC, thumbRel));

        if (KEEP_ORIGINALS) fs.copyFileSync(srcPath, path.join(PUBLIC, origRel));

        const faces = await detectFaces(buffer);
        // EXIF 轉正後的長寬
        const rotated = info.orientation && info.orientation >= 5;
        const w = rotated ? info.height : info.width;
        const h = rotated ? info.width : info.height;

        entry = { name, src: files[i], w, h, faces };
        processed++;
        process.stdout.write(`  ${i + 1}/${files.length} ${files[i]} → ${faces.length} 張臉\r`);
      }

      nextCache[key] = { stamp, entry };

      const gi = photoIndex.length;
      photoIndex.push({
        a: meta.id,
        w: webRel,
        t: thumbRel,
        o: origRel,
        src: entry.src,
        dim: [entry.w, entry.h],
      });
      // 臉在偵測解析度下的實際像素寬 — 決定這張臉的特徵值可不可信
      const detW = Math.min(entry.w, DETECT_WIDTH);
      for (const f of entry.faces) {
        const px = Math.round(f.box[2] * detW);
        allFaces.push({
          p: gi,
          b: f.box,
          s: f.score,
          px,
          q: px >= MATCH_MIN_PX && f.score >= MATCH_MIN_SCORE ? 1 : 0,
        });
        descriptors.push(f.descriptor);
      }
      photos.push({ i: gi, w: webRel, t: thumbRel, o: origRel, src: entry.src, dim: [entry.w, entry.h], nf: entry.faces.length });
    }

    // 封面：優先挑人臉最多的那張（通常是大合照）
    let cover = photos[0];
    for (const p of photos) if (p.nf > (cover.nf || 0)) cover = p;

    albums.push({
      id: meta.id,
      title: meta.title || (meta.date ? meta.date.replace(/-/g, '.') : dirName),
      date: meta.date,
      year: meta.year || null,
      dir: dirName,
      count: photos.length,
      cover: cover.t,
      photos,
    });
    log(`  完成 ${photos.length} 張，共 ${photos.reduce((s, p) => s + p.nf, 0)} 張臉` + ' '.repeat(30));
  }

  // 防呆：來源資料夾是唯一真相，少放了相簿就會被洗掉。
  // 家族照片洗掉了很難救，所以寧可停下來問。
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(DATA, 'albums.json'), 'utf8'));
    const nowIds = new Set(albums.map((a) => a.id));
    const missing = (prev.albums || []).filter((a) => !nowIds.has(a.id));
    if (missing.length && !process.argv.includes('--force')) {
      console.error(`\n⚠️  停下來了 — 這些相簿之前有、但這次來源資料夾裡找不到：\n`);
      for (const m of missing) console.error(`      ${m.id}  ${m.title}（${m.count} 張）`);
      console.error(`\n   照這樣建下去，這 ${missing.length} 本相簿會從網站上消失。`);
      console.error(`   來源資料夾：${SRC}`);
      console.error(`\n   → 如果是漏放了，把相簿補回來源資料夾再跑一次。`);
      console.error(`   → 如果真的要移除，加上 --force：npm run build -- --force\n`);
      process.exit(1);
    }
  } catch { /* 第一次建置沒有舊檔，正常 */ }

  // 依日期由新到舊
  albums.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // 特徵值存成二進位，比 JSON 小很多也快
  const buf = Buffer.alloc(descriptors.length * 128 * 4);
  descriptors.forEach((d, i) => {
    for (let j = 0; j < 128; j++) buf.writeFloatLE(d[j], (i * 128 + j) * 4);
  });
  fs.writeFileSync(path.join(DATA, 'faces.bin'), buf);

  fs.writeFileSync(path.join(DATA, 'albums.json'), JSON.stringify({
    title: '周氏大家族的點點滴滴',
    generated: new Date().toISOString().slice(0, 10),
    albums,
  }));

  const usable = allFaces.filter((f) => f.q).length;
  fs.writeFileSync(path.join(DATA, 'faces.json'), JSON.stringify({
    dim: 128,
    count: allFaces.length,
    usable,
    minPx: MATCH_MIN_PX,
    photos: photoIndex,
    faces: allFaces,
  }));

  if (!fs.existsSync(path.join(DATA, 'people.json'))) {
    fs.writeFileSync(path.join(DATA, 'people.json'), JSON.stringify({ people: [] }, null, 2));
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(nextCache));

  log(`\n────────────────────────────`);
  log(`相簿 ${albums.length} 本、照片 ${photoIndex.length} 張、人臉 ${allFaces.length} 張`);
  log(`可用於比對的臉 ${usable} 張（${(usable / allFaces.length * 100).toFixed(0)}%，其餘太小或太模糊，只顯示不比對）`);
  log(`新處理 ${processed} 張，快取跳過 ${skipped} 張`);
  log(`faces.bin ${(buf.length / 1048576).toFixed(1)} MB`);
}

main().catch((e) => { console.error('\n建置失敗：', e); process.exit(1); });
