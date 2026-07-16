/*
 * 探針：驗證人臉比對的準確度，用來決定品質門檻。
 * 用法：node scripts/probe.js [臉的最小像素] [最低信心] [參考臉索引]
 * 產出 probe.jpg — 距離最近的 48 張臉拼貼，直接用眼睛看是不是同一個人。
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const MIN_PX = +(process.argv[2] || 0);
const MIN_SCORE = +(process.argv[3] || 0);
const REF_ARG = process.argv[4];

const PUBLIC = path.join(__dirname, '..', 'public');
const faces = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'faces.json'), 'utf8'));
const bin = fs.readFileSync(path.join(PUBLIC, 'data', 'faces.bin'));
const desc = new Float32Array(bin.buffer, bin.byteOffset, bin.length / 4);

const pxOf = (f) => Math.round(f.b[2] * Math.min(faces.photos[f.p].dim[0], 1600));
const at = (i) => desc.subarray(i * 128, i * 128 + 128);
const dist = (a, b) => { let s = 0; for (let i = 0; i < 128; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); };

// 參考臉：預設挑最大的那張（一定夠清楚）
let ref = REF_ARG ? +REF_ARG : null;
if (ref == null) {
  let bestPx = 0;
  faces.faces.forEach((f, i) => { const px = pxOf(f); if (px > bestPx && f.s > 0.9) { bestPx = px; ref = i; } });
}
console.log(`參考臉 #${ref} — ${pxOf(faces.faces[ref])}px, 信心 ${faces.faces[ref].s}, 照片 ${faces.photos[faces.faces[ref].p].w}`);
console.log(`門檻：臉 >= ${MIN_PX}px，信心 >= ${MIN_SCORE}`);

const r = at(ref);
const rows = [];
for (let i = 0; i < faces.faces.length; i++) {
  const f = faces.faces[i];
  const px = pxOf(f);
  if (px < MIN_PX || f.s < MIN_SCORE) continue;
  rows.push({ i, d: dist(r, at(i)), px, s: f.s, f });
}
rows.sort((a, b) => a.d - b.d);
console.log(`候選 ${rows.length} 張臉；距離 < 0.45 的有 ${rows.filter(x => x.d < 0.45).length} 張，< 0.53 的有 ${rows.filter(x => x.d < 0.53).length} 張`);

const CELL = 120, COLS = 8, ROWS = 6;
const pick = rows.slice(0, COLS * ROWS);

(async () => {
  const tiles = [];
  for (let n = 0; n < pick.length; n++) {
    const { f, d, px } = pick[n];
    const photo = faces.photos[f.p];
    const file = path.join(PUBLIC, photo.w);
    const meta = await sharp(file).metadata();
    const [x, y, w, h] = f.b;
    const side = Math.round(Math.max(w * meta.width, h * meta.height) * 1.3);
    const left = Math.max(0, Math.min(meta.width - side, Math.round((x + w / 2) * meta.width - side / 2)));
    const top = Math.max(0, Math.min(meta.height - side, Math.round((y + h / 2) * meta.height - side / 2)));
    const buf = await sharp(file)
      .extract({ left, top, width: Math.min(side, meta.width - left), height: Math.min(side, meta.height - top) })
      .resize(CELL, CELL, { fit: 'fill' })
      .composite([{
        input: Buffer.from(`<svg width="${CELL}" height="${CELL}">
          <rect x="0" y="${CELL - 16}" width="${CELL}" height="16" fill="black"/>
          <text x="3" y="${CELL - 4}" font-family="monospace" font-size="11" fill="#0f0">${d.toFixed(3)} ${px}px</text>
        </svg>`),
        top: 0, left: 0,
      }])
      .toBuffer();
    tiles.push({ input: buf, left: (n % COLS) * CELL, top: Math.floor(n / COLS) * CELL });
  }

  await sharp({ create: { width: CELL * COLS, height: CELL * ROWS, channels: 3, background: '#111' } })
    .composite(tiles)
    .jpeg({ quality: 92 })
    .toFile(path.join(__dirname, '..', 'probe.jpg'));
  console.log('→ probe.jpg');
})();
