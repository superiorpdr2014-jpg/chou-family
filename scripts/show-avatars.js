/*
 * 驗證用：左邊是「人工指認的那張臉」（一定是本人），右邊是「自動挑的大頭照」。
 * 兩邊擺一起，一眼就能看出有沒有認錯人。
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PUBLIC = path.join(__dirname, '..', 'public');
const people = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'people.json'), 'utf8'));
const list = people.people.filter((p) => p.avatar && p.refs && p.refs.length);

const CELL = 150, GAP = 6, PAIR = CELL * 2 + GAP, COLS = 3;
const ROWS = Math.ceil(list.length / COLS);
const PAD = 30;

async function crop(file, box, label, tint) {
  const meta = await sharp(file).metadata();
  const [x, y, w, h] = box;
  const side = Math.round(Math.max(w * meta.width, h * meta.height) * 1.35);
  const cx = (x + w / 2) * meta.width, cy = (y + h / 2) * meta.height;
  const left = Math.max(0, Math.min(meta.width - side, Math.round(cx - side / 2)));
  const top = Math.max(0, Math.min(meta.height - side, Math.round(cy - side / 2)));
  return sharp(file)
    .extract({ left, top, width: Math.min(side, meta.width - left), height: Math.min(side, meta.height - top) })
    .resize(CELL, CELL, { fit: 'fill' })
    .composite([{
      input: Buffer.from(`<svg width="${CELL}" height="${CELL}">
        <rect x="0" y="${CELL - 20}" width="${CELL}" height="20" fill="rgba(0,0,0,.8)"/>
        <text x="5" y="${CELL - 5}" font-family="sans-serif" font-size="13" fill="${tint}">${label}</text>
      </svg>`),
      top: 0, left: 0,
    }])
    .toBuffer();
}

(async () => {
  const tiles = [];
  for (let n = 0; n < list.length; n++) {
    const p = list[n];
    const col = n % COLS, row = Math.floor(n / COLS);
    const ox = col * (PAIR + PAD) + PAD / 2;
    const oy = row * (CELL + PAD) + PAD;

    tiles.push({ input: await crop(path.join(PUBLIC, p.refs[0].p), p.refs[0].b, '指認:' + p.name, '#ff0'), left: ox, top: oy });
    tiles.push({ input: await crop(path.join(PUBLIC, p.avatar.p), p.avatar.b, '大頭照', '#0f0'), left: ox + CELL + GAP, top: oy });
  }

  await sharp({
    create: { width: COLS * (PAIR + PAD) + PAD, height: ROWS * (CELL + PAD) + PAD, channels: 3, background: '#222' },
  })
    .composite(tiles).jpeg({ quality: 92 })
    .toFile(path.join(__dirname, '..', 'avatars.jpg'));
  console.log('→ avatars.jpg（左=人工指認 右=自動挑的大頭照，兩邊該是同一個人）');
})();
