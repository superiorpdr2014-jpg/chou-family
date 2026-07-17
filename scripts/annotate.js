/*
 * 把臉的編號直接標回照片上，方便跟 Jay 對「誰是誰」。
 * 用法：node scripts/annotate.js <照片檔名的一部分>
 * 產出 annotated.jpg
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PUBLIC = path.join(__dirname, '..', 'public');
const faces = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'faces.json'), 'utf8'));

const needle = process.argv[2];
const hit = faces.photos.map((p, i) => ({ p, i })).find(({ p }) => p.src.includes(needle));
if (!hit) { console.error('找不到照片'); process.exit(1); }

const list = faces.faces.map((f, idx) => ({ f, idx })).filter(({ f }) => f.p === hit.i);

(async () => {
  const file = path.join(PUBLIC, hit.p.w);
  const meta = await sharp(file).metadata();
  const W = meta.width, H = meta.height;

  const boxes = list.map(({ f }, n) => {
    const [x, y, w, h] = f.b;
    const bx = Math.round(x * W), by = Math.round(y * H);
    const bw = Math.round(w * W), bh = Math.round(h * H);
    return `
      <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="none" stroke="#00ff00" stroke-width="3"/>
      <rect x="${bx}" y="${by - 30}" width="46" height="30" fill="#00ff00"/>
      <text x="${bx + 5}" y="${by - 8}" font-family="sans-serif" font-size="24" font-weight="bold" fill="#000">${n}</text>`;
  }).join('');

  await sharp(file)
    .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}">${boxes}</svg>`), top: 0, left: 0 }])
    .jpeg({ quality: 92 })
    .toFile(path.join(__dirname, '..', 'annotated.jpg'));
  console.log('→ annotated.jpg（' + list.length + ' 張臉）');
})();
