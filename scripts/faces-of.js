/*
 * 把某張照片裡偵測到的臉全部裁出來、編號排成一張圖，方便用眼睛指認誰是誰。
 * 用法：node scripts/faces-of.js <照片檔名的一部分>
 * 例：  node scripts/faces-of.js 餐敍_260716_41
 * 產出 faces-of.jpg，每格左下角是「臉的編號 尺寸」。
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PUBLIC = path.join(__dirname, '..', 'public');
const faces = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'faces.json'), 'utf8'));

const needle = process.argv[2];
if (!needle) { console.error('要給照片檔名的一部分'); process.exit(1); }

const hits = faces.photos
  .map((p, i) => ({ p, i }))
  .filter(({ p }) => p.src.includes(needle) || (p.o || '').includes(needle));

if (!hits.length) { console.error('找不到照片：' + needle); process.exit(1); }
if (hits.length > 1) {
  console.error('符合的照片不只一張，講清楚一點：');
  hits.forEach(({ p }) => console.error('  ' + p.a + '  ' + p.src));
  process.exit(1);
}

const { p: photo, i: pi } = hits[0];
const list = faces.faces.map((f, idx) => ({ f, idx })).filter(({ f }) => f.p === pi);

console.log(`照片：${photo.a} / ${photo.src}`);
console.log(`偵測到 ${list.length} 張臉（q=1 代表夠清楚、可以拿來認人）\n`);
list.forEach(({ f, idx }, n) => {
  console.log(`  #${n}  faceIdx=${idx}  ${f.px}px  信心 ${f.s}  ${f.q ? '可比對' : '太小/太糊，只能顯示'}  位置 x=${(f.b[0] * 100).toFixed(0)}% y=${(f.b[1] * 100).toFixed(0)}%`);
});

const CELL = 150, COLS = 6;
const ROWS = Math.ceil(list.length / COLS);

(async () => {
  const file = path.join(PUBLIC, photo.w);
  const meta = await sharp(file).metadata();
  const tiles = [];

  for (let n = 0; n < list.length; n++) {
    const { f, idx } = list[n];
    const [x, y, w, h] = f.b;
    const side = Math.round(Math.max(w * meta.width, h * meta.height) * 1.6);
    const left = Math.max(0, Math.min(meta.width - side, Math.round((x + w / 2) * meta.width - side / 2)));
    const top = Math.max(0, Math.min(meta.height - side, Math.round((y + h / 2) * meta.height - side / 2)));
    const buf = await sharp(file)
      .extract({ left, top, width: Math.min(side, meta.width - left), height: Math.min(side, meta.height - top) })
      .resize(CELL, CELL, { fit: 'fill' })
      .composite([{
        input: Buffer.from(`<svg width="${CELL}" height="${CELL}">
          <rect x="0" y="${CELL - 20}" width="${CELL}" height="20" fill="black"/>
          <text x="4" y="${CELL - 5}" font-family="monospace" font-size="13" fill="#0f0">#${n}  ${f.px}px${f.q ? '' : ' 糊'}</text>
        </svg>`),
        top: 0, left: 0,
      }])
      .toBuffer();
    tiles.push({ input: buf, left: (n % COLS) * CELL, top: Math.floor(n / COLS) * CELL });
  }

  await sharp({ create: { width: CELL * COLS, height: CELL * ROWS, channels: 3, background: '#111' } })
    .composite(tiles).jpeg({ quality: 92 })
    .toFile(path.join(__dirname, '..', 'faces-of.jpg'));
  console.log('\n→ faces-of.jpg');
})();
