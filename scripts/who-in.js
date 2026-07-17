/*
 * 已經認識的人，在某張照片裡是哪一張臉？
 * 用法：node scripts/who-in.js <照片檔名的一部分>
 * 拿 people.json 裡已登記的特徵值去比，順便驗證人工指認的位置對不對。
 */
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const faces = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'faces.json'), 'utf8'));
const bin = fs.readFileSync(path.join(PUBLIC, 'data', 'faces.bin'));
const desc = new Float32Array(bin.buffer, bin.byteOffset, bin.length / 4);
const people = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'people.json'), 'utf8'));

const at = (i) => desc.subarray(i * 128, i * 128 + 128);
const dist = (a, b) => { let s = 0; for (let i = 0; i < 128; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); };

const needle = process.argv[2];
const hit = faces.photos.map((p, i) => ({ p, i })).find(({ p }) => p.src.includes(needle));
if (!hit) { console.error('找不到照片'); process.exit(1); }

const list = faces.faces.map((f, idx) => ({ f, idx })).filter(({ f }) => f.p === hit.i);
console.log(`照片 ${hit.p.src}\n`);

const known = people.people.filter((p) => p.refs && p.refs.length);
for (const person of known) {
  const refs = person.refs.map((r) => Float32Array.from(r.d));
  let best = null;
  list.forEach(({ f, idx }, n) => {
    let min = Infinity;
    for (const r of refs) { const d = dist(r, at(idx)); if (d < min) min = d; }
    if (!best || min < best.d) best = { d: min, n, f };
  });
  const verdict = best.d < 0.35 ? '✅ 就是他' : best.d < 0.45 ? '⚠️ 可能' : '❌ 不在這張照片裡';
  console.log(
    `${person.name.padEnd(4)} → #${String(best.n).padEnd(2)} 距離 ${best.d.toFixed(3)} ` +
    `位置 x=${(best.f.b[0] * 100).toFixed(0)}% y=${(best.f.b[1] * 100).toFixed(0)}%  ${verdict}`
  );
}
