/*
 * 周氏大家族相簿 — 建置腳本
 *
 * 唯一真相是 public/photos/<相簿>/o/ 裡的原圖 + public/data/ 裡建好的資料，
 * 兩者都在 repo 裡。這很重要：家人從網站上傳的照片只會進 GitHub、不會在 Jay 的電腦裡，
 * 如果建置以本機資料夾為準，本機跑一次就會把家人上傳的洗掉。
 *
 * 照片有兩個入口，都是「匯入」而不是「來源」：
 *   photos-source/  ← Jay 自己丟相簿資料夾進來
 *   incoming/       ← 家人從網站上傳的（GitHub Actions 會跑到）
 * 匯入過的就會從入口移走，之後一律以 public/photos/<相簿>/o/ 為準。
 *
 * 已經處理過的照片會直接沿用 public/data 裡的既有結果（那份資料本身就是快取，
 * 而且它是 commit 進 repo 的，所以本機和 GitHub Actions 上跑出來一模一樣）。
 *
 * 用法：
 *   node scripts/build.js              一般用法
 *   node scripts/build.js --rebuild    強制全部重算（換模型或改參數時用）
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
const { setWasmPaths } = require('@tensorflow/tfjs-backend-wasm');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const MODELS = path.join(PUBLIC, 'models');
const DATA = path.join(PUBLIC, 'data');
const PHOTOS = path.join(PUBLIC, 'photos');
const WASM_DIR = path.join(ROOT, 'node_modules', '@tensorflow', 'tfjs-backend-wasm', 'dist') + path.sep;

// 照片入口（匯入後會清空）
const INBOXES = [path.join(ROOT, 'photos-source'), path.join(ROOT, 'incoming')];

const FORCE_REBUILD = process.argv.includes('--rebuild');

const WEB_WIDTH = 2048;   // 燈箱看的大圖
const THUMB_WIDTH = 480;  // 相簿格子縮圖
const DETECT_WIDTH = 1600; // 人臉偵測用的解析度（合照人臉小，不能太低）
const MIN_CONFIDENCE = 0.3;

// 能不能拿來比對身分的品質門檻。
// 實測（scripts/probe.js）：合照裡 40px 以下的臉，特徵值幾乎是雜訊，
// 會跟每個人都「很像」，把整個比對搞爛。寧可漏掉也不要認錯。
const MATCH_MIN_PX = 48;
const MATCH_MIN_SCORE = 0.5;

const IMAGE_EXT = /\.(jpe?g|png|webp|heic)$/i;

// ---------- 小工具 ----------

const log = (...a) => console.log(...a);
const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });

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

// ---------- 人臉辨識 ----------

let faceApiReady = false;
async function initFaceApi() {
  if (faceApiReady) return;
  setWasmPaths(WASM_DIR);
  await faceapi.tf.setBackend('wasm');
  await faceapi.tf.ready();
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODELS);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS);
  faceApiReady = true;
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

// ---------- 讀既有資料（它本身就是快取） ----------

function loadExisting() {
  const albums = new Map();  // id → {id, title, date, year, dir, photos: [entry]}
  try {
    const prevAlbums = JSON.parse(fs.readFileSync(path.join(DATA, 'albums.json'), 'utf8'));
    const prevFaces = JSON.parse(fs.readFileSync(path.join(DATA, 'faces.json'), 'utf8'));
    const bin = fs.readFileSync(path.join(DATA, 'faces.bin'));
    const desc = new Float32Array(bin.buffer, bin.byteOffset, bin.length / 4);

    // 每張臉的特徵值照全域索引排，要先照 photo 分組回去
    const facesByPhoto = new Map();
    prevFaces.faces.forEach((f, i) => {
      if (!facesByPhoto.has(f.p)) facesByPhoto.set(f.p, []);
      facesByPhoto.get(f.p).push({
        box: f.b, score: f.s,
        descriptor: Array.from(desc.subarray(i * 128, i * 128 + 128)),
      });
    });

    for (const a of prevAlbums.albums) {
      const entry = { ...a, photos: [] };
      for (const p of a.photos) {
        const photo = prevFaces.photos[p.i];
        entry.photos.push({
          name: p.name || path.basename(p.w, '.webp'),
          src: p.src,
          w: photo.dim[0], h: photo.dim[1],
          faces: facesByPhoto.get(p.i) || [],
        });
      }
      albums.set(a.id, entry);
    }
  } catch { /* 第一次建置，沒有舊資料 */ }
  return albums;
}

// ---------- 匯入：把入口資料夾的照片搬進 public/photos/<相簿>/o/ ----------

function importInboxes(albums) {
  let imported = 0;

  for (const inbox of INBOXES) {
    if (!fs.existsSync(inbox)) continue;
    const dirs = fs.readdirSync(inbox).filter((n) => {
      try { return fs.statSync(path.join(inbox, n)).isDirectory(); } catch { return false; }
    });

    for (const dirName of dirs) {
      const meta = parseAlbumName(dirName);
      const albumDir = path.join(inbox, dirName);
      const files = fs.readdirSync(albumDir).filter((f) => IMAGE_EXT.test(f)).sort(naturalCompare);
      if (!files.length) continue;

      let album = albums.get(meta.id);
      if (!album) {
        album = { id: meta.id, title: meta.title || (meta.date ? meta.date.replace(/-/g, '.') : dirName), date: meta.date, year: meta.year || null, dir: dirName, photos: [] };
        albums.set(meta.id, album);
        log(`  新相簿：${album.title}`);
      }

      const haveSrc = new Set(album.photos.map((p) => p.src));
      // 接續既有編號，不要蓋掉別人
      let next = album.photos.reduce((mx, p) => Math.max(mx, +p.name || 0), 0) + 1;
      const outO = path.join(PHOTOS, meta.id, 'o');
      ensureDir(outO);

      for (const f of files) {
        if (haveSrc.has(f)) continue; // 這張已經匯入過了
        const name = String(next++).padStart(4, '0');
        fs.copyFileSync(path.join(albumDir, f), path.join(outO, name + path.extname(f).toLowerCase()));
        album.photos.push({ name, src: f, w: 0, h: 0, faces: null }); // faces=null → 待處理
        haveSrc.add(f);
        imported++;
      }

      // incoming 是家人上傳的暫存區，收完就清掉；photos-source 是 Jay 自己的資料夾，留著
      if (inbox.endsWith('incoming')) {
        for (const f of files) { try { fs.unlinkSync(path.join(albumDir, f)); } catch {} }
        try { fs.rmdirSync(albumDir); } catch {}
      }
    }
  }
  return imported;
}

// ---------- 主流程 ----------

async function main() {
  ensureDir(DATA);
  ensureDir(PHOTOS);

  const albums = loadExisting();
  log(`既有：${albums.size} 本相簿`);

  const imported = importInboxes(albums);
  if (imported) log(`匯入 ${imported} 張新照片`);

  if (FORCE_REBUILD) {
    log('--rebuild：全部重算');
    for (const a of albums.values()) for (const p of a.photos) p.faces = null;
  }

  // 找出需要處理的照片：沒有人臉資料的，或衍生圖不見的
  const todo = [];
  for (const album of albums.values()) {
    for (const p of album.photos) {
      const webPath = path.join(PHOTOS, album.id, 'w', p.name + '.webp');
      if (p.faces == null || !fs.existsSync(webPath)) todo.push({ album, p });
    }
  }

  if (todo.length) {
    await initFaceApi();
    log(`需要處理 ${todo.length} 張照片…`);
  }

  let done = 0;
  for (const { album, p } of todo) {
    const outO = path.join(PHOTOS, album.id, 'o');
    const orig = fs.readdirSync(outO).find((f) => path.basename(f, path.extname(f)) === p.name);
    if (!orig) { console.warn(`  ⚠️ 找不到原圖 ${album.id}/${p.name}，跳過`); continue; }

    const buffer = fs.readFileSync(path.join(outO, orig));
    const info = await sharp(buffer).metadata();

    ensureDir(path.join(PHOTOS, album.id, 'w'));
    ensureDir(path.join(PHOTOS, album.id, 't'));

    await sharp(buffer).rotate()
      .resize({ width: WEB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 85 })
      .toFile(path.join(PHOTOS, album.id, 'w', p.name + '.webp'));

    await sharp(buffer).rotate()
      .resize({ width: THUMB_WIDTH, height: THUMB_WIDTH, fit: 'cover', position: 'attention', withoutEnlargement: true })
      .webp({ quality: 75 })
      .toFile(path.join(PHOTOS, album.id, 't', p.name + '.webp'));

    p.faces = await detectFaces(buffer);
    const rotated = info.orientation && info.orientation >= 5;
    p.w = rotated ? info.height : info.width;
    p.h = rotated ? info.width : info.height;

    done++;
    process.stdout.write(`  ${done}/${todo.length} ${album.id}/${p.src} → ${p.faces.length} 張臉        \r`);
  }
  if (done) log('');

  // ---------- 產出資料 ----------

  const albumList = [...albums.values()].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const photoIndex = [];
  const allFaces = [];
  const descriptors = [];

  for (const album of albumList) {
    album.photos.sort((a, b) => naturalCompare(a.name, b.name));
    const outPhotos = [];

    for (const p of album.photos) {
      const gi = photoIndex.length;
      const origFile = (() => {
        try { return fs.readdirSync(path.join(PHOTOS, album.id, 'o')).find((f) => path.basename(f, path.extname(f)) === p.name); }
        catch { return null; }
      })();
      const rel = (sub, ext) => `photos/${album.id}/${sub}/${p.name}${ext}`;

      photoIndex.push({
        a: album.id,
        w: rel('w', '.webp'),
        t: rel('t', '.webp'),
        o: origFile ? `photos/${album.id}/o/${origFile}` : null,
        src: p.src,
        dim: [p.w, p.h],
      });

      const detW = Math.min(p.w, DETECT_WIDTH);
      for (const f of p.faces || []) {
        const px = Math.round(f.box[2] * detW);
        allFaces.push({ p: gi, b: f.box, s: f.score, px, q: px >= MATCH_MIN_PX && f.score >= MATCH_MIN_SCORE ? 1 : 0 });
        descriptors.push(f.descriptor);
      }

      outPhotos.push({
        i: gi, name: p.name,
        w: rel('w', '.webp'), t: rel('t', '.webp'),
        o: origFile ? `photos/${album.id}/o/${origFile}` : null,
        src: p.src, dim: [p.w, p.h], nf: (p.faces || []).length,
      });
    }

    // 封面：優先挑人臉最多的那張（通常是大合照）
    let cover = outPhotos[0];
    for (const p of outPhotos) if (p.nf > (cover?.nf || 0)) cover = p;

    album.out = {
      id: album.id, title: album.title, date: album.date, year: album.year,
      dir: album.dir, count: outPhotos.length,
      cover: cover ? cover.t : null,
      photos: outPhotos,
    };
  }

  const buf = Buffer.alloc(descriptors.length * 128 * 4);
  descriptors.forEach((d, i) => {
    for (let j = 0; j < 128; j++) buf.writeFloatLE(d[j], (i * 128 + j) * 4);
  });
  fs.writeFileSync(path.join(DATA, 'faces.bin'), buf);

  fs.writeFileSync(path.join(DATA, 'albums.json'), JSON.stringify({
    title: '周氏大家族的點點滴滴',
    generated: new Date().toISOString().slice(0, 10),
    albums: albumList.filter((a) => a.out.count).map((a) => a.out),
  }));

  const usable = allFaces.filter((f) => f.q).length;
  fs.writeFileSync(path.join(DATA, 'faces.json'), JSON.stringify({
    dim: 128, count: allFaces.length, usable, minPx: MATCH_MIN_PX,
    photos: photoIndex, faces: allFaces,
  }));

  if (!fs.existsSync(path.join(DATA, 'people.json'))) {
    fs.writeFileSync(path.join(DATA, 'people.json'), JSON.stringify({ people: [] }, null, 2));
  }

  log(`\n────────────────────────────`);
  log(`相簿 ${albumList.length} 本、照片 ${photoIndex.length} 張、人臉 ${allFaces.length} 張`);
  log(`可用於比對的臉 ${usable} 張（${(usable / (allFaces.length || 1) * 100).toFixed(0)}%，其餘太小或太模糊，只顯示不比對）`);
  log(`這次新處理 ${done} 張，其餘沿用既有資料`);
  log(`faces.bin ${(buf.length / 1048576).toFixed(1)} MB`);
}

main().catch((e) => { console.error('\n建置失敗：', e); process.exit(1); });
