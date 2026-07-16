/*
 * 幫族譜上的人標記人臉，並自動挑一張最好看的當大頭照。
 *
 * 下面這份對照表是人工指認出來的（Jay 指出誰是誰 → 用 scripts/faces-of.js 把臉編號裁出來對照
 * → 再用 scripts/check-pair.js 驗證同一個人在不同照片間的距離夠近才敢寫）。
 * faceIdx 是 faces.json 裡 faces 陣列的索引。
 *
 * ⚠️ faceIdx 會因為重新建置而改變（照片順序變了就全部跑掉），
 * 所以這支腳本只是「一次性把人臉特徵值寫進 people.json」的工具。
 * 寫進去之後，people.json 裡存的是特徵值本身，不依賴索引，重建也不會壞。
 *
 * 用法：node scripts/label.js
 */
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const DATA = path.join(PUBLIC, 'data');

// 人 → 他的臉在哪幾個 faceIdx（多標幾張不同角度，比對會更準）
const LABELS = {
  'zhou-fen': [606, 565, 822],        // 周粉：餐敍 _18 / _13 / _41
  'zhou-yuechun': [610, 561],         // 周月春：_18 / _13（紅背心）
  'huang-zhaorui': [558],             // 黃昭瑞：_13 右邊長輩
  'huang-yuwen': [607, 564],          // 黃裕文：_18 後排右邊 / _13
  'huang-yuren': [608, 559],          // 黃裕仁：_18 後排左邊 / _13
  'zhou-yuezu': [817],                // 周月足：_41 周粉後面
  'ma-shunjin': [816],                // 馬順進：_41 右邊長輩
  'ma-chengxin': [820],               // 馬成新：_41 左邊條紋衣
  'ma-zhaojun': [824],                // 馬肇均：_41 小男生
  'ma-weiwei': [818],                 // 馬惟薇：_41 小女生
};

const MATCH_THRESHOLD = 0.40; // 跟前端一致
const sizePenalty = (px) => (px < 64 ? 0.08 : px < 88 ? 0.04 : 0);

/*
 * 大頭照用更嚴的門檻（不是 0.40）。
 * 理由：大頭照掛錯人比大頭照不好看嚴重得多 —— 第一版用 0.40 挑，
 * 結果馬肇均（男孩）的大頭照抓到他妹妹馬惟薇的臉。小孩子的臉本來就像，
 * 兄妹更像，照片又是壓縮過的，0.40 根本分不開。
 * 找不到夠確定的就退回用「人工指認的那張臉」，那張一定是對的。
 */
const AVATAR_MAX_DIST = 0.30;

const faces = JSON.parse(fs.readFileSync(path.join(DATA, 'faces.json'), 'utf8'));
const bin = fs.readFileSync(path.join(DATA, 'faces.bin'));
const desc = new Float32Array(bin.buffer, bin.byteOffset, bin.length / 4);
const people = JSON.parse(fs.readFileSync(path.join(DATA, 'people.json'), 'utf8'));

const at = (i) => desc.subarray(i * 128, i * 128 + 128);
const dist = (a, b) => { let s = 0; for (let i = 0; i < 128; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); };
const round5 = (v) => +v.toFixed(5);

/**
 * 大頭照挑選：要「最美最漂亮」，實務上就是
 *   臉大（清楚）＋ 偵測信心高（正面、沒被遮、沒糊）＋ 不要太邊邊角角
 * 偵測信心對側臉/閉眼/被擋住會明顯掉下來，所以它其實是很好的「上相」指標。
 */
function avatarScore(f) {
  const sizeScore = Math.min(f.px / 200, 1);       // 200px 以上就夠大了，再大沒加分
  const clarity = Math.pow(f.s, 2);                // 信心平方 → 拉開正面與側臉的差距
  const cx = f.b[0] + f.b[2] / 2, cy = f.b[1] + f.b[3] / 2;
  const centered = 1 - Math.min(Math.hypot(cx - 0.5, cy - 0.45) * 1.2, 0.5); // 靠近畫面中央的通常是主角
  return sizeScore * 0.45 + clarity * 0.4 + centered * 0.15;
}

let labelled = 0;
for (const person of people.people) {
  const idxs = LABELS[person.id];
  if (!idxs) continue;

  // 1. 把指認到的臉寫成參考特徵值
  person.refs = idxs.map((i) => {
    const f = faces.faces[i];
    const photo = faces.photos[f.p];
    return { p: photo.w, b: f.b, d: Array.from(at(i)).map(round5) };
  });

  // 2. 從全部照片裡找出這個人，挑一張最上相的當大頭照
  const refs = idxs.map((i) => at(i));
  const cands = [];
  for (let i = 0; i < faces.faces.length; i++) {
    const f = faces.faces[i];
    if (!f.q) continue;
    let min = Infinity;
    for (const r of refs) { const d = dist(r, at(i)); if (d < min) min = d; }
    if (min > AVATAR_MAX_DIST) continue;
    cands.push({ i, f, d: min, score: avatarScore(f) });
  }
  cands.sort((a, b) => b.score - a.score);

  // 人工指認的那幾張，一定是本人，拿來當保底
  const fallback = idxs
    .map((i) => ({ i, f: faces.faces[i], d: 0, score: avatarScore(faces.faces[i]) }))
    .sort((a, b) => b.score - a.score)[0];

  const best = cands[0] && cands[0].score > fallback.score ? cands[0] : fallback;
  const photo = faces.photos[best.f.p];
  person.avatar = { p: photo.w, b: best.f.b };
  console.log(
    `${person.name.padEnd(5)} 標 ${idxs.length} 張 · 夠確定的候選 ${String(cands.length).padStart(3)} 張 · ` +
    `大頭照 ${photo.a}/${photo.src.slice(-10)} ${String(best.f.px).padStart(3)}px 信心${best.f.s} ` +
    `距離${best.d.toFixed(2)}${best === fallback ? ' (用人工指認那張)' : ''}`
  );
  labelled++;
}

fs.writeFileSync(path.join(DATA, 'people.json'), JSON.stringify(people, null, 2));

const noFace = people.people.filter((p) => !p.refs || !p.refs.length);
console.log(`\n已標記 ${labelled} 人`);
if (noFace.length) {
  console.log(`還沒有大頭照（照片裡還沒指認出來）：${noFace.map((p) => p.name).join('、')}`);
}
