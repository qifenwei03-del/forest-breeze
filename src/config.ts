/**
 * 全域參數。所有「可調整」的東西都集中在這裡。
 */

/** 動畫循環長度（秒）。整個 shader 的時間項都是這個週期的整數諧波，所以循環是數學上精確的。 */
export const LOOP_DURATION = 8.0;

/**
 * 振幅的校準基準風速。
 *
 * AMPLITUDE.grayPx / whitePx 定義的是「當 windStrength === REFERENCE_WIND_STRENGTH 時」
 * 的最大位移像素數。shader 內部乘上 (windStrength / REFERENCE_WIND_STRENGTH)。
 *
 * 這樣才能同時滿足兩個需求：
 *   - 預設 windStrength = 0.15
 *   - 預設狀態下 GRAY ≈ 1–3px、WHITE ≈ 3–8px（native texture resolution）
 * 並且 windStrength = 0 時位移精確為 0。
 */
export const REFERENCE_WIND_STRENGTH = 0.15;

/**
 * Mask 極性。
 *
 * true  = 黑色最會動、白色完全不動（本專案採用，符合提供的 movement-mask.png：
 *         天空／霧是白色，樹葉是黑色）
 * false = 相反
 *
 * shader 內部一律換算成 movement 值：
 *   movement = 1.0（最大移動） / 0.5（中等） / 0.0（完全不動）
 */
export const MASK_DARK_MEANS_MOVE = true;

/** 最大位移（單位：原生 texture 像素），在 REFERENCE_WIND_STRENGTH 下量測。 */
export const AMPLITUDE = {
  /** 中間層（GRAY，中景／遠景森林）。振幅略大於 BLACK，但速度更慢。 */
  midPx: 2.6,
  /**
   * 最大移動層（本專案的 BLACK，近景葉片、灌木、樹冠）。實測峰值約 4.9px。
   *
   * 應變參考（水波感的門檻）：
   *   4.0 → 平均 0.78% / 最大 4.89%
   *   6.5 → 平均 1.26% / 最大 7.94%   ← 目前
   *   8.0 → 平均 1.55% / 最大 9.77%
   * 對照：會看起來像水波的那一版是平均 3.31% / 最大 23.05%。
   */
  strongPx: 6.5,
};

/**
 * 每一層各自的擺動軸向，單位是「相對於風向的角度偏移」。
 *
 *   0°  = 沿著風向（windDirection = 0 時就是水平左右）
 *   90° = 垂直於風向（上下擺動）
 *
 * 兩層可以完全獨立，這也取代了舊的 verticalRatio。
 */
export const TIER_AXIS_DEG = {
  /** GRAY（中景森林）：左右。 */
  mid: 0,
  /** BLACK（近景葉片）：上下。 */
  strong: 90,
};

/**
 * Mask 的空間柔化半徑（原生 texture 像素）。
 *
 * 這是「葉片輪廓呈波浪線」的關鍵修正。
 * movement-mask.png 是硬邊的：位移在葉片輪廓上會從 0 跳到滿值，
 * 只跨 2 個 texel —— 局部應變超過 100%，看起來就是輪廓在扭。
 *
 * 對 mask 做多點取樣柔化，讓位移沿著約 2×softenPx 的距離平緩爬升。
 * 應變 ≈ 位移 / (2 × softenPx)。
 *
 * 但半徑不能太大：mask 上細碎的葉片剪影（例如畫面上方的框景樹枝）
 * 周圍都是靜止的白色天空，半徑一大就會被平均掉，
 * 那一區的 wStrong 掉下來，運動性格被 GRAY 稀釋。
 * 實測上半純黑區的 wStrong：半徑 32 → 0.65，半徑 20 → 0.73。
 */
export const MASK_SOFTEN_PX = 20;


/**
 * 分段邊界，作用在換算後的 movement 值上（不是原始 luminance）。
 *   x,y = 「完全不動」-> 「中等」的過渡（movement <= x 時位移精確為 0）
 *   z,w = 「中等」    -> 「最大」的過渡
 *
 * 以本專案的極性來說：movement 0.0 = WHITE、0.5 = GRAY、1.0 = BLACK。
 */
export const MASK_EDGES = {
  staticStart: 0.1,
  staticEnd: 0.42,
  strongStart: 0.58,
  strongEnd: 0.9,
};

/** canvas render buffer 的 devicePixelRatio 上限。只影響 canvas，不影響 texture 解析度。 */
export const MAX_PIXEL_RATIO = 2;

/**
 * 渲染解析度策略。
 *
 * 這是「畫質看起來有沒有掉」的關鍵，而且和 texture 解析度是兩回事。
 *
 * texture 永遠是原生 2496×2496，但如果 canvas render buffer 只有 900×900，
 * 那 2496 個 texel 要擠進 900 個像素，細節在輸出端就沒了 ——
 * 而且 GPU 為了避免縮小時的鋸齒會去取較低層 mipmap，看起來會更軟。
 *
 * 'native-texture'（預設，High Quality）
 *   把 render buffer 拉高到「圖片每邊至少有 photo.width 個像素」，
 *   也就是以 1:1 取樣原生 texture（用得到 mipmap level 0），
 *   再交給瀏覽器合成時縮到 CSS 尺寸 —— 等同 supersampling，比 GPU 三線性縮圖銳利得多。
 *
 * 'device-pixels'
 *   只跟隨 devicePixelRatio。省效能，但畫面小於圖片時就會看到細節損失。
 */
export const RENDER_QUALITY = {
  mode: 'native-texture' as 'native-texture' | 'device-pixels',
  /**
   * render buffer 每邊的硬上限。
   * 避免在超大視窗 + 超高解析素材時產生離譜的 fragment 量。
   * 實際還會再被 GPU 的 MAX_RENDERBUFFER_SIZE 夾一次。
   */
  maxRenderSize: 4096,
};

/**
 * Texture 取樣品質。
 *
 * 重要：mipmaps 不會降低來源解析度。
 * mipmap level 0 永遠是原生的 4096×4096；level 1+ 只在「顯示尺寸小於 texture 尺寸」
 * 時被使用，用來避免葉片縮小時的 aliasing 閃爍。
 * 想要 100% 只用 level 0（會有明顯 shimmer），把 mipmaps 設成 false。
 */
export const TEXTURE_QUALITY = {
  mipmaps: true,
  anisotropy: 16,
};

/**
 * 素材檔名（相對於 public/）。
 * 目前的來源檔是無損 PNG（2496×2496），所以副檔名是 .png；
 * 換成 forest.jpg 只要改這裡即可，其餘程式不需要動。
 */
export const ASSETS = {
  forest: 'forest.png',
  mask: 'movement-mask.png',
};

/**
 * 霧氣飄移。
 *
 * 只作用在 WHITE（天空／霧）與 GRAY（中景森林）兩層，BLACK（近景葉片）完全不受影響。
 *
 * 這是「霧的濃度」在飄移，不是把照片的像素往右推 ——
 * 單張非平鋪的照片無法真的無限平移，硬推會扯壞樹線邊緣。
 * 實作是兩層往右漂移的 fbm 交叉淡化：兩層都持續往右移動，
 * 靠交替接手讓「連續漂移」和「8 秒精確循環」同時成立。
 *
 * strength = 0 時畫面逐像素等同原圖。
 */
export const FOG = {
  /** WHITE（天空／霧）區域的相對強度。 */
  whiteAmount: 1.0,
  /** GRAY（中景森林）區域的相對強度。霧在中景比在天空更看得出來，所以壓低一點。 */
  grayAmount: 0.55,
  /** 霧的顏色，sRGB 0..1，與輸出同一個色彩空間。取比天空再亮一點，讓兩個方向都有變化空間。 */
  color: [0.95, 0.96, 0.96] as [number, number, number],
  /**
   * 對比縮放倍率。
   *
   * 霧的模型是「把畫面往霧色壓縮」= 對比下降，反向則是對比上升。
   * 這個值放大 fogStrength 對對比的影響，是讓霧變明顯最直接的旋鈕。
   * 太高會讓暗部壓死或亮部溢出（shader 內有 clamp 保護）。
   */
  contrast: 1.8,
  /**
   * 亮度變化比例。
   *
   * 天空本來就接近霧色，單靠對比縮放幾乎不動它（實測只有 1.9/255）。
   * 這一項讓接近霧色的區域也看得出濃淡，實測可以拉到約 9/255。
   */
  luma: 0.25,
  /** 空間頻率。越大霧的團塊越小、越碎。 */
  scale: 2.0,
  /**
   * 一個 8 秒循環內往右漂移的基準距離（noise 空間單位）。
   * 實際漂移距離 = drift × fogSpeed。
   *
   * 交叉淡化的循環無縫性與這個值無關 ——
   * 兩層永遠相差剛好一個 drift，w = 1 時必定回到 w = 0 的狀態，
   * 所以速度可以自由調整。
   */
  drift: 0.6,
};

/**
 * 位移模式。
 *
 * ADVANCED（預設）分簇的葉片晃動。空間場落在「一簇葉子」的尺度
 *                （波長 356–1470px），時間上保留 k = 1..13 的快速抖動。
 *                時間頻率不造成應變，所以一簇葉子可以抖得很快而不變形。
 * SIMPLE         只用極低頻的水平位移：一個很慢的主風 + 一個更小的次要變化。
 *                最保守，但整張圖幾乎同相位，觀感偏向「整片一起平移」。
 */
export type MovementMode = 'SIMPLE' | 'ADVANCED';

export interface WindConfig {
  /** 0.00 – 1.00。0 = 完全靜止。 */
  windStrength: number;
  /** 度。0 = 由左往右。 */
  windDirection: number;
  /** 0.1 – 2.0。時間推進倍率（會等比縮短／拉長 8 秒循環，但循環仍然無縫）。 */
  animationSpeed: number;
  /** 0.0 – 2.0。位移振幅的整體倍率。 */
  movementScale: number;
  /** 0.00 – 0.50。霧氣濃度變化的強度。0 = 關閉，畫面逐像素等同原圖。 */
  fogStrength: number;
  /** 0.0 – 8.0。霧氣往右漂移的速度倍率。0 = 霧的形狀靜止（但濃度仍會隨相位變化）。 */
  fogSpeed: number;
  /** 位移模式。 */
  movementMode: MovementMode;
  /** false = 忽略 mask，整張圖都當成 WHITE 處理（debug 用）。 */
  maskEnabled: boolean;
  /** true = 凍結時間。 */
  paused: boolean;
}

/**
 * 預設值 = 實際調校後的結果。
 *
 * 注意 windStrength 與 movementScale 的合成增益：
 *   (1.00 / REFERENCE_WIND_STRENGTH) × 1.69 = (1.00 / 0.15) × 1.69 ≈ 11.27×
 * 所以實際位移上限是 AMPLITUDE 宣告值的 11.27 倍：
 *   GRAY  2.6 px × 11.27 ≈ 29 px
 *   BLACK 6.5 px × 11.27 ≈ 73 px
 * 配合 animationSpeed 0.24×（循環長度 8 / 0.24 ≈ 33 秒）變成大幅度但極慢的移動。
 */
export const DEFAULT_CONFIG: WindConfig = {
  windStrength: 1.0,
  windDirection: 15,
  animationSpeed: 0.24,
  movementScale: 1.69,
  fogStrength: 0.42,
  fogSpeed: 4.7,
  movementMode: 'ADVANCED',
  maskEnabled: true,
  paused: false,
};
