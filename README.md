# Forest Breeze

把一張高解析森林照片，用 WebGL / Three.js fragment shader 做成極輕微、極自然的微風動畫。
不是 AI image-to-video，也不重新生成畫面 —— 只對取樣座標做幾個像素的位移。

## 執行

```bash
npm install
```

```bash
npm run dev
```

打開 http://localhost:5173

## 天氣面板

左上角顯示台北市大安區的即時天氣。

資料來源：[Open-Meteo](https://open-meteo.com/) —— 免費、**不需要 API key**。
靜態網站放 key 等於公開，所以只能選免鑰的服務。

- 座標寫死（25.0326, 121.5435），**不使用 Geolocation**，不會向使用者要定位權限
- 兩個端點：`forecast`（溫度／風／雲量／氣壓／能見度／紫外線／日出日落）與
  `air-quality`（美國 AQI）
- 空氣品質失敗不影響其他欄位；整個面板失敗也不影響森林動畫，
  只會顯示錯誤狀態並每分鐘重試
- 正常情況每 10 分鐘更新一次（Open-Meteo 本身是每小時更新）

`visibility` / `uv_index` / `precipitation_probability` 在 Open-Meteo 只有 hourly 沒有 current，
所以程式會自己把 hourly 陣列對到目前這一小時。

面板是 `pointer-events: none`，不會擋到任何操作。
沒有 `backdrop-filter` 的瀏覽器會退回較深的底色，避免白字糊在亮霧上。

要換地點就改 `src/weather.ts` 的 `LOCATION`。

## 素材

兩張圖都放在 `public/`，尺寸必須完全相同：

| 檔案 | 用途 |
| --- | --- |
| `public/forest.png` | 原始高解析森林照片 |
| `public/movement-mask.png` | 移動程度控制 |

目前的素材是 **2496 × 2496**。
`public/` 底下的檔案由 Vite 原樣複製，不會被壓縮、不會被 resize。

換成 `.jpg` 只要改 `src/config.ts` 的 `ASSETS.forest`。

### 兩層的幅度與速度

兩層各自算自己的訊號，所以幅度與速度可以獨立控制：

| | 幅度上限 | 實測峰值 | 平均\|位移\| | 頻譜質心（速度） | 擺動方向 |
| --- | --- | --- | --- | --- | --- |
| BLACK（近景葉片） | 4.00 px | 2.99 px | 0.482 px | 1.82 次 / 8 秒 | 上下（風向 +90°） |
| GRAY（中景森林） | 2.60 px | 2.40 px | 0.545 px | 1.23 次 / 8 秒 | 左右（沿風向） |

GRAY 的振幅是 BLACK 的 **1.13×**、速度是 **0.68×** —— 略大而緩慢。
速度差來自 `sMid` 用一個專屬的 `slow` 成分（只有 k = 1 與 2，平均 k ≈ 1.25），
權重 0.80；`sStrong` 則保留 `fine`（k 到 13）。

方向由 `TIER_AXIS_DEG` 設定，單位是相對於風向的角度偏移。
兩層完全獨立，這也取代了舊的 `verticalRatio`。

### 一個像素只有一個運動

兩層的運動**不是相加**，而是內插：

```glsl
float total = clamp(wMid + wStrong, 0.0, 1.0);
float t = total > 1e-4 ? wStrong / total : 0.0;
vec2 axis = normalize(mix(uMidAxis, uStrongAxis, t));
vec2 offsetPx = axis * (total * mix(uMidAmpPx, uStrongAmpPx, t) * mix(sMid, sStrong, t));
```

原因：兩層的軸向是垂直的（GRAY 左右、BLACK 上下）。
相加會讓 mask 過渡帶的像素同時被「水平慢動」和「垂直快動」拉扯，
變成橢圓運動、方向不明確 —— 看起來就是沒在動。

畫面上方的框景樹枝特別嚴重：那是細碎剪影，被 mask 柔化平均之後
`wStrong` 只剩 0.65，其餘 0.35 來自 GRAY。

實測（真實 mask + 全部 noise 場，只取原始純黑像素）：

| | 平均位移 | wStrong |
| --- | --- | --- |
| 上半（細枝葉）改前 | 0.736 px | 0.650 |
| 下半（實心前景）改前 | 0.803 px | 0.974 |
| **上半 改後** | **0.816 px** | **0.702** |
| **下半 改後** | **0.812 px** | 0.975 |

上/下的位移比從 0.92× 變成 **1.00×**。
`MASK_SOFTEN_PX` 同時從 32 降到 20 —— 代價是 mask 邊界應變從 7.6% 升到 12.2%。

幅度比 BLACK / GRAY = **3.42×**，速度比 GRAY / BLACK = **2.53×**。

速度差來自兩組不同的諧波權重（`sStrong` 偏 `low`、`sMid` 偏 `fine`），
不是靠改時間軸 —— 兩層仍然共用同一個 `uPhase`，8 秒循環不受影響。

把「快」放在低振幅那一層對應變是有利的：應變 = 振幅 × 梯度，
高諧波的空間梯度較大，但 GRAY 只有 1.4px，所以 BLACK 的平均應變反而降到 0.78%。

### movement mask 極性

**白色 = 完全不動，灰色 = 中等，黑色 = 最大移動。**

| 顏色 | 對應區域 | 位移（見下方基準） |
| --- | --- | --- |
| WHITE | 天空、霧 | 0 px（數學上精確為 0） |
| GRAY | 中景／遠景森林 | ≤ 1 px |
| BLACK | 近景葉片、灌木、樹冠 | ≤ 3 px |

極性寫在 `src/config.ts` 的 `MASK_DARK_MEANS_MOVE`，改成 `false` 就會反過來。

## 霧氣飄移

只作用在 **WHITE（天空／霧）** 與 **GRAY（中景森林）** 兩層，BLACK（近景葉片）完全不受影響。
`fogStrength = 0` 時畫面逐像素等同原圖。

飄移的是**霧的濃度**，不是把照片的像素往右推 ——
單張非平鋪的照片無法真的無限平移，硬推會扯壞樹線邊緣。

實作是兩層往右漂移的 fbm 交叉淡化：兩層都以相同速度持續往右移動，
靠交替接手讓「連續單向漂移」和「8 秒精確循環」同時成立。

交叉淡化本身會讓霧的對比在週期中段掉到約 72%（每 8 秒「呼吸」一次）。
`fogFieldAt()` 裡除掉了 `1/sqrt((1-t)² + t²)` 這個解析包絡把它補平。

但這個補償只在兩層真的去相關時成立。`fogSpeed` 很小時兩層幾乎是同一個場，
混合根本不會降低變異數，照樣除反而會把中段**放大** 41%。
所以補償強度用 `smoothstep(0.0, 0.4, drift)` 跟著漂移距離走：

| fogSpeed | 0.0 | 0.5 | 1.0 | 2.0 | 3.0 |
| --- | --- | --- | --- | --- | --- |
| 對比平坦度 | 1.000 | 0.950 | 0.982 | 0.976 | 0.961 |

速度用 debug panel 的 **Fog Speed** 滑桿調（0 – 8.0×），
強度用 **Fog Strength**（0 – 0.50），兩者都會跟著 Save 一起存。
全速度範圍實測循環銜接誤差都在 1e-11 量級。

### 霧的著色模型

不是疊一層紗，而是**對比縮放** —— 真實的霧就是把畫面往霧色壓縮：

```glsl
float k = clamp(f * fogAmount * uFogContrast, -0.85, 0.85);
rgb = uFogColor + (rgb - uFogColor) * (1.0 - k);   // 對比
rgb = clamp(rgb * (1.0 + k * uFogLuma), 0.0, 1.0); // 亮度
```

`k > 0` 往霧色壓縮（霧變濃，對比下降），`k < 0` 從霧色推開（霧變薄，對比上升），
`k = 0` 逐像素等同原圖。

亮度那一項是必要的補充：天空本來就接近霧色，單靠對比縮放幾乎不動它。

相對原圖的最大通道變化量（fogStrength 0.28、|f| ≈ 0.45）：

| 取樣色 | 舊模型（疊紗） | 現在 |
| --- | --- | --- |
| 中景森林 暗綠 | 23.8 / 6.7 | **48.4 / 43.6** |
| 中景森林 亮綠 | 18.0 / 11.2 | **40.0 / 36.3** |
| 天空霧白 | 1.9 / 17.4 | **16.7 / 16.3** |
| 樹幹陰影 | 26.3 / 3.5 | **52.1 / 45.2** |

（每格是「霧變濃 / 霧變薄」兩個方向。單位 /255。）

`fogStrength` 拉到滑桿最大 0.50 時，暗部與亮部會碰到 clamp —— 那是刻意的保護，
正常使用的 0.28 不會。

參數在 `src/config.ts` 的 `FOG`：

| 參數 | 作用 |
| --- | --- |
| `whiteAmount` / `grayAmount` | 兩層各自的相對強度 |
| `color` | 霧色，取比天空再亮一點，讓濃／薄兩個方向都有變化空間 |
| `scale` | 空間頻率，越大團塊越碎 |
| `drift` | 一個 8 秒循環內往右漂移的距離，越大飄得越快 |

強度用 debug panel 的 **Fog Drift** 滑桿調（0 – 0.50），會跟著 Save 一起存。

## 為什麼會像水波／果凍，以及怎麼修的

變形的來源是**位移場的空間梯度**，也就是應變：

```
應變 ≈ 位移振幅 / noise 波長
```

應變 1% 代表相鄰 100px 的內容被拉扯 1px —— 肉眼讀成「變形」。
降到 0.3% 以下，肉眼讀成「這一塊整個平移了」。

三種觀感對應三個不同的空間尺度：

| 觀感 | 空間波長 | 成因 |
| --- | --- | --- |
| 水波 / 果凍 | ~80 px（小於一片葉子） | 輪廓內部被扭開 |
| **樹葉晃動** | **356 – 1470 px（一簇葉子）** | 一簇剛體平移，簇與簇不同步 |
| 布料在甩 | ~2000 px（大於整張圖） | 全圖同相位 |

另一個關鍵：**時間頻率不會造成應變，只有空間頻率會。**
應變是 `d(位移)/d(位置)`，時間項根本不出現在這個式子裡。
所以一簇葉子可以抖得很快（諧波到 k = 13，約 0.6 秒一次），
只要那一簇「整簇一起抖」。這就是「像葉子」而不是「像布」的差別。

| | 水波版 | 布料版 | 現在（ADVANCED） |
| --- | --- | --- | --- |
| 最大位移 | 4.24 px | 2.65 px | 3.01 px |
| 空間頻率 | 1.7 – 31 | 0.8 – 2.1 | 1.7 – 7.0 |
| 對應波長 | 80 – 1470 px | 1190 – 3100 px | 356 – 1470 px |
| 平均應變 | 3.31% | 0.31% | **0.88%** |
| 最大應變 | 23.1% | 1.65% | 6.75% |
| 高階諧波能量 | 33.1% | — | **30.7%** |

最後一列是重點：葉片抖動的時間豐富度幾乎完整保留（30.7% vs 33.1%），
但空間應變降了 3.8 倍。

水波版還有一個「每像素的擺動軸向抖動」，那是純變形、零平移貢獻，已經移除。

第二個來源是 **mask 的硬邊**，影響其實更大：
`movement-mask.png` 的葉片輪廓是硬邊的，位移會在 2 個 texel 內從 0 衝到滿值，
局部應變 **300%** —— 這才是「葉片輪廓呈波浪線」的直接成因。
`sampleMovement()` 用 5 點取樣把 mask 空間柔化（`MASK_SOFTEN_PX = 32`），
位移改成沿約 64px 平緩爬升，應變降到 4.7%。

注意柔化的只是「移動強度」，不是影像本身，所以 mask 邊界不會製造任何額外形變。

高頻 noise 不再直接位移 UV。它只被允許影響振幅與相位 ——
決定某一簇葉子動多少、什麼時候動，而不是把輪廓扭來扭去。

## Movement Mode

debug panel 的 **Movement Mode**，預設 `ADVANCED`。

| 模式 | 內容 |
| --- | --- |
| `ADVANCED` | 分簇的葉片晃動。空間場 f = 1.7 / 3.1 / 4.7 / 6.5 / 7.0（波長 356–1470px），時間諧波 k = 1,2,3,5,7,11,13。每一簇有自己的相位、振幅與「性格」（偏慢的大擺動 vs 偏碎的細抖）。 |
| `SIMPLE` | 只有極低頻的水平位移：一個 8 秒的主風（權重 0.85）+ 一個 4 秒的次要變化（0.15）。最保守，但整張圖幾乎同相位，觀感偏向「整片一起平移」。 |

垂直位移由 `AMPLITUDE.verticalRatio` 控制，**第一版是 0**（完全關閉）。
等水平風吹自然之後再考慮加到 0.05 以內。

## 位移量的基準

`AMPLITUDE.midPx` / `strongPx` 定義的是 **`windStrength = 0.15`（預設值）時**的最大位移像素數，
單位是**原生 texture 像素**（2496 那個尺度，不是螢幕像素）。

實際位移 = 基準值 × (windStrength / 0.15) × movementScale

所以：

- `windStrength = 0` → 位移精確為 0，畫面完全靜止
- `windStrength = 0.15` → GRAY 2 px、BLACK 6 px
- `windStrength = 0.30` → 兩倍

debug panel 的 `Max disp. GRAY` / `Max disp. BLACK` 會即時顯示目前的實際值。

## 調整 windStrength

- **暫時調**：右上角 debug panel 的 Wind Strength 滑桿
- **改預設值**：`src/config.ts` → `DEFAULT_CONFIG.windStrength`

覺得太弱就往上調。第一版刻意調得非常保守 —— 寧可太少，也不要出現水波或果凍感。

## 畫質：為什麼會覺得「傳上網頁之後變糊」

texture 從來沒有被降解析度 —— debug panel 的 `Source texture` 永遠是 2496 × 2496。
變糊發生在**輸出端**：

- 視窗 900 × 900 → canvas render buffer 也只有 900 × 900
- 2496 個 texel 要擠進 900 個像素，每個像素涵蓋 2.2 個 texel
- 而且 GPU 為了避免縮小時的鋸齒閃爍會取較低層 mipmap，看起來又更軟

`RENDER_QUALITY.mode = 'native-texture'`（預設）把 canvas render buffer 拉到
「圖片每邊至少有 2496 個像素」，shader 因此以 1:1 取樣原生 texture（走 mipmap level 0），
再交給瀏覽器合成縮到 CSS 尺寸 —— 也就是 supersampling，比 GPU 三線性縮圖銳利得多。

debug panel 的 **`Texel sampling`** 就是用來確認這件事的：

- **1.00× 或以上（綠色）** = 原生解析度完全用得上
- **小於 1（橘色）** = 輸出端正在縮小，細節會掉

### 但有件事再怎麼調都改不了

900 像素寬的顯示區域**物理上**無法呈現 2496 像素的細節。
supersampling 能做到的是「讓這 900 像素等同於原圖被好好縮圖後的樣子」，
而不是「在 900 像素裡看到 2496 像素的資訊」。

真的要看到完整細節，只有一個辦法：**把視窗放大 / 全螢幕**，讓顯示區域接近 2496 像素。
`Image rendered at` 那一列會告訴你目前實際渲染成幾像素。

### 如果太慢

`native-texture` 模式在 2496² 下每幀要算 623 萬個 fragment，內建顯示晶片可能吃不消。
掉幀的話把 `src/config.ts` 的 `RENDER_QUALITY.mode` 改成 `'device-pixels'`，
或把 `maxRenderSize` 從 4096 調低。

## 三種解析度是分開的

debug panel 會同時顯示這三個數字，用來確認原始 texture 沒有被偷偷降解析度：

| 項目 | 意義 |
| --- | --- |
| Source texture | 上傳到 GPU 的原生尺寸，永遠 = 圖檔尺寸 |
| Canvas internal | canvas render buffer = CSS 尺寸 × pixelRatio |
| Canvas CSS | 瀏覽器版面上的顯示尺寸 |
| Image on screen | contain 之後圖片實際佔用的 CSS 尺寸 |
| Image rendered at | 圖片在 render buffer 裡實際佔用幾個像素 |
| Texel sampling | render buffer 像素 ÷ 原生 texel，>= 1 才沒有損失 |

視窗縮小只會改變後三者。`Source texture` 永遠不變。

`TEXTURE_QUALITY.mipmaps` 預設開啟。mipmap **不會**降低來源解析度 ——
level 0 永遠是原生 2496×2496，level 1+ 只在「顯示尺寸 < texture 尺寸」時用來避免葉片縮小時的 aliasing 閃爍。
想要 100% 只用 level 0（會有明顯 shimmer），把它設成 `false`。

## 畫幅

**contain**：圖片永遠完整可見、維持原始比例（1:1），視窗比例不同時左右或上下留黑。
縮放發生在 vertex shader 的 `uQuadScale`，texture 本身完全不動，絕不 stretch。

## 8 秒無縫循環

時間只有一個變數 `uPhase ∈ [0, 1)`。shader 裡所有時間項都是

```
sin(2π · k · uPhase + 空間相位)      k ∈ {1, 2, 3, 5, 7}
```

`k` 全為整數 → `uPhase = 0` 與 `uPhase = 1` 的值與一階導數完全相同，
循環在數學上精確無縫。程式裡沒有 `if (t > 8) t = 0` 這種會跳格的寫法。

`animationSpeed` 只改變相位推進速率（等比縮短／拉長週期），不會造成跳動。

## 專案結構

```
index.html
package.json
tsconfig.json
vite.config.ts
public/
  forest.png
  movement-mask.png
src/
  main.ts            載入流程、錯誤處理
  ForestScene.ts     renderer / uniforms / resize / 單一 rAF loop
  DebugPanel.ts      debug UI
  textures.ts        texture 載入與取樣設定
  config.ts          所有可調參數
  vite-env.d.ts
  shaders/
    forest.vert.glsl   fullscreen quad + contain 縮放
    forest.frag.glsl   UV displacement 主體
    simplex2d.glsl     2D simplex noise（只用於空間變化，不參與時間軸）
```

## 建置

```bash
npm run build
```

會先跑 `tsc --noEmit`，型別錯誤會擋下建置。
