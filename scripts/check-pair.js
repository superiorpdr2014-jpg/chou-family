// 驗證兩個 faceIdx 是不是同一個人（距離越小越像）
const fs = require('fs');
const path = require('path');
const PUBLIC = path.join(__dirname, '..', 'public');
const faces = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'faces.json'), 'utf8'));
const bin = fs.readFileSync(path.join(PUBLIC, 'data', 'faces.bin'));
const desc = new Float32Array(bin.buffer, bin.byteOffset, bin.length / 4);
const at = (i) => desc.subarray(i * 128, i * 128 + 128);
const dist = (a, b) => { let s = 0; for (let i = 0; i < 128; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); };

const pairs = JSON.parse(process.argv[2]);
for (const [label, a, b] of pairs) {
  const d = dist(at(a), at(b));
  const verdict = d < 0.35 ? '✅ 同一人（很確定）' : d < 0.45 ? '⚠️ 大概同一人' : '❌ 不同人';
  console.log(`${label.padEnd(28)} 距離 ${d.toFixed(3)}  ${verdict}`);
}
