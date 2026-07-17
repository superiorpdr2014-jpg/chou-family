# 周氏大家族的點點滴滴

家族相簿網站。每張照片都預先做過人臉辨識，家人上傳一張自己的照片、選出自己的臉，
就能找出所有相簿裡有他的合影。

**全部在瀏覽器裡跑，沒有後端、沒有資料庫。** 家人上傳的照片只在自己的手機/電腦上處理，
不會傳到任何伺服器。

---

## 照片怎麼進到網站

有兩條路，殊途同歸 —— 都會進到 `public/photos/<相簿>/o/`，那裡才是唯一真相。

### A. 家人自己從網站上傳（全自動）

家人開 **網站 → 上傳照片**，輸入家族密碼，選相簿、選照片、送出。
接下來全自動，沒人需要做任何事：

```
家人上傳 → Cloudflare Function 驗密碼 → 照片 commit 進 incoming/
        → GitHub Actions 自動跑人臉辨識建置 → commit 回 public/
        → Cloudflare 自動部署 → 3~5 分鐘後照片出現在相簿裡
```

### B. Jay 自己在電腦上加（適合一次丟一大批）

1. 把相簿資料夾丟進 `photos-source/`，命名格式 `日期 + 名稱`：

   ```
   photos-source/
     20250101新年聚餐/
   ```

   日期支援 `YYYYMMDD`（20181020）或 `YYYYMDD`（2024427）。名稱可留空。

2. `npm run build`
3. `git add -A && git commit -m "新增相簿：新年聚餐" && git push`

---

## ⚠️ 唯一真相是 repo，不是你的電腦

`public/photos/<相簿>/o/` 裡的原圖 **＋** `public/data/` 裡建好的資料，
兩份都在 repo 裡，這兩份合起來就是整個網站的真相。

`photos-source/` 和 `incoming/` **只是入口**，不是來源：
建置會把裡面的照片「匯入」到 `public/photos/`，之後就不再看它們。

這件事很重要 —— **家人上傳的照片只會進 GitHub，不會出現在你電腦的 `photos-source/` 裡**。
如果建置是以你的本機資料夾為準，你在本機跑一次 build 就會把家人上傳的照片全部洗掉。
現在的設計不會有這個問題：本機和 GitHub Actions 跑出來的結果完全一致。

建置本身沒有另外的快取檔 —— `public/data/` 那份資料本身就是快取。
已經算過人臉的照片會直接沿用結果，所以重跑很快，只有新照片要花時間。
真的要全部重算（例如換模型或改參數）：`npm run build -- --rebuild`

---

## 家人怎麼修正族譜（改名字／加配偶／加小孩／換大頭照）

家人在**族譜點任何一個人 → 按「✎ 修正這個人的資料」**，填家族密碼送出。

**送出後不會直接生效** —— 族譜是家族紀錄，改錯輩分很難發現也很難救，所以一定經過你：

```
家人送出 → commit 到 proposals/ → 你在 #/review 看過 → 按核准 → 才寫進 people.json
```

你的待審頁：**網站 `#/review`**（或 `?admin` 模式的工具列有入口），輸入 `ADMIN_PASSWORD` 就看得到清單，
每筆可以「核准」或「退回」。核准後 Cloudflare 會自動部署，重新整理就看得到。

家人上傳的大頭照會存成 `public/avatars/`，跟從相簿裁出來的臉並存 —— 有上傳的優先。

---

## 怎麼幫家人的臉標名字

標好名字之後，家人在「家人」頁就能直接用名字找照片，不用上傳照片。

1. 網址後面加 `?admin` 打開管理模式：

   ```
   https://chou-family.pages.dev/?admin
   ```

2. 隨便打開一張照片 → 按「顯示人臉」→ 點某張臉 → 輸入名字。
   同一個人多標幾張（不同角度、不同年代）會準很多。

3. 標完按上方的「**匯出 people.json**」，把下載到的檔案蓋掉
   `public/data/people.json`，然後 commit + push。

標記草稿存在瀏覽器的 localStorage，關掉分頁不會不見，但**沒匯出就不會上線**。

---

## 關於辨識準確度（重要，別誤會）

這批照片是 LINE 相簿匯出的，**原圖只有 1478px 寬**，四十幾個人的大合照裡
一張臉常常只有 40~60 像素。這對人臉辨識來說是很吃緊的條件，實測結果：

| 設定 | 找到的量 | 實際狀況 |
|---|---|---|
| 嚴格 | 少 | 幾乎不會認錯，但會漏掉不少 |
| **標準（預設）** | 中 | **約八成正確**，可能混進一兩位長相神似的長輩 |
| 寬鬆 | 多 | 約七成，會混進小孩、其他長輩 |

所以網站的設計是**寧可漏掉也不要認錯**：

- 臉小於 48 像素、或偵測信心低於 0.5 的臉**不參與比對**（只在「顯示人臉」時框出來）。
  這種臉的特徵值基本上是雜訊，會跟每個人都「很像」，不擋掉整個比對會爛掉。
- 臉越小，門檻越嚴（`sizePenalty`）。
- 上傳的照片如果臉太小或太模糊，會直接擋下來要求換一張，不會硬找。
- 不太確定的結果放在「**可能是你**」區塊，讓家人自己認，而不是假裝很準。

距離門檻（0.35 / 0.40 / 0.46）是實際跑 `scripts/probe.js` 把比對結果裁出來
用眼睛一張張看出來的，不是 face-api 的預設值 0.6 —— 0.6 那個數字是給高解析度
正面照用的，套在這批照片上會把整個家族都認成同一個人。

**以後如果有畫質好的照片（原檔、非 LINE 壓縮），準確度會明顯提升。**

### 想自己重新校準門檻

```bash
node scripts/probe.js [最小臉像素] [最低信心] [參考臉編號]
# 例：node scripts/probe.js 64 0.6
```

會產生 `probe.jpg` — 距離最近的 48 張臉拼貼，每格標著距離和臉的像素大小，
直接用眼睛看在哪個距離開始混進別人，就知道門檻該設多少。

---

## 檔案結構

```
scripts/
  build.js      建置：壓圖 + 人臉偵測 + 產出資料
  probe.js      校準工具：把比對結果裁出來用眼睛檢查
public/         ← 這個資料夾就是網站本體（Cloudflare Pages 的根目錄）
  index.html
  app.js        前端全部邏輯（路由/相簿/燈箱/比對/管理模式）
  styles.css
  vendor/       face-api.js（瀏覽器版，已內含 tfjs）
  models/       人臉模型權重，約 13MB，只有用到辨識時才載
  data/
    albums.json 相簿與照片清單
    faces.json  每張臉的位置、大小、品質
    faces.bin   每張臉的 128 維特徵值（Float32，接在一起）
    people.json 人名名冊（管理模式匯出的）
  photos/<相簿>/
    w/  網頁版 2048px
    t/  縮圖 480px
    o/  原圖
```

## 部署

- **原始碼**：GitHub `superiorpdr2014-jpg/chou-family`
- **網站**：https://chou-family.pages.dev （Cloudflare Pages）
  - Build output directory：`public`
  - Build command：**留空**（照片和辨識資料都已經建好 commit 在 repo 裡，不需要在雲端建置）
- push 到 `main` 就會自動更新

### 上傳功能需要的環境變數

在 Cloudflare Pages → 專案 → **Settings → Environment variables** 設這幾個
（Production 和 Preview 都要）：

| 變數 | 值 | 說明 |
|---|---|---|
| `FAMILY_PASSWORD` | 你自己訂 | 家人上傳照片、提出族譜修正時要輸入 |
| `ADMIN_PASSWORD` | **另外訂一組** | 只有你知道，用來核准修正 |
| `GH_TOKEN` | GitHub 權杖 | 要有這個 repo 的 **Contents: Read and write** 權限 |
| `GH_REPO` | `superiorpdr2014-jpg/chou-family` | |
| `GH_BRANCH` | `main` | 可省略 |

⚠️ `ADMIN_PASSWORD` 一定要跟 `FAMILY_PASSWORD` 不一樣。家族密碼要發給一大家子，
等於半公開；它能上傳照片、提修正（都會經過你），但**不能拿來當「可以直接改族譜」的鑰匙**。

`GH_TOKEN` 在 GitHub → Settings → Developer settings → **Fine-grained tokens** 建，
Repository access 只選 `chou-family` 這一個，權限只給 **Contents: Read and write**。
設成 Secret（Cloudflare 的 Encrypt 選項），不要外流 —— 它能寫入這個 repo。
