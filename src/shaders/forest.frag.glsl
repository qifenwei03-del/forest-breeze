//
// Forest breeze — fragment shader UV displacement
//
// 設計重點
// --------
// 1. 這是「取樣座標位移」，不是「像素重繪」。原圖每一個 texel 都原封不動，
//    只是被讀取的位置移動了幾個 pixel，所以高解析細節完全保留。
//
// 2. 時間只有一個變數：uPhase ∈ [0, 1)。
//    所有時間項都是 sin(2π · k · uPhase + 空間相位)，k 為整數。
//    → uPhase = 0 與 uPhase = 1 的值與導數完全相同，8 秒循環在數學上無縫。
//    絕對沒有 "if (t > 8) t = 0" 這種會跳格的寫法。
//
// 3. 空間變化（每一簇葉子的相位／振幅差異）來自 static 2D simplex noise，
//    它不隨時間變化，所以不會有 flicker，也不會每幀重新亂數。
//
//
// 為什麼之前像水波／果凍，以及這一版怎麼修
// ----------------------------------------
// 變形的來源是「位移場的空間梯度」，也就是應變 ≈ 位移振幅 / noise 波長。
//
//   舊版：振幅 6px，noise 頻率 23–31（波長約 90px）→ 應變 7%   ← 這就是水波感
//   本版：振幅 3px，noise 頻率 1.2–4.5（波長 550–2000px）→ 應變 0.15–0.5%
//
// 應變降到 1% 以下時，肉眼會把它讀成「這一塊整個平移了」，而不是「這一塊在變形」。
// 這是本次修正的核心，不是靠把數值調小硬壓。
//
// 第二個來源：movement-mask.png 是硬邊的。
// 位移在葉片輪廓上會從 0 跳到滿值、只跨 2 個 texel，局部應變超過 100% ——
// 這正是「葉片輪廓呈波浪線」的直接成因。
// 所以 mask 改用多點取樣做空間柔化（見 sampleMovement）。
//
// 高頻 noise 不再直接位移 UV。它只被允許影響「振幅」與「相位」，
// 也就是決定某一簇葉子動多少、什麼時候動，而不是把輪廓扭來扭去。
//
//
// Mask 極性
// ---------
//   BLACK = 最大移動（近景葉片）
//   GRAY  = 中等移動（中景／遠景森林）
//   WHITE = 完全不動（天空／霧）
// shader 先把 luminance 換算成 movement 值（uMaskInvert = 1 時 movement = 1 - lum），
// 之後所有判斷都用 movement。
// smoothstep(staticStart, staticEnd, movement) 在 movement <= staticStart 時
// 回傳「精確的 0.0」，不是趨近 0，所以靜止區的 duv 是精確的 vec2(0.0)。
//
// contain 模式：quad 由 vertex shader 縮到視窗內，所以 vUv 直接就是完整的 0..1。
//
// simplex2d.glsl 會在 TypeScript 端被 prepend 到這個檔案前面（提供 snoise）。
//

varying vec2 vUv;

uniform sampler2D uTexture;        // forest.jpg / forest.png（原生解析度）
uniform sampler2D uMask;           // movement-mask.png（原生解析度）

uniform vec2  uTexResolution;      // 原生像素尺寸，例如 (2496, 2496)
uniform vec2  uHalfTexel;          // 0.5 / uTexResolution

uniform float uPhase;              // 0..1，循環相位
uniform vec2  uMidAxis;            // GRAY 的擺動軸向（單位向量）
uniform vec2  uStrongAxis;         // BLACK 的擺動軸向（單位向量）
uniform float uWindStrength;       // 0..1
uniform float uWindReference;      // 振幅校準基準（config.REFERENCE_WIND_STRENGTH）
uniform float uMovementScale;      // 0..2
uniform float uMovementMode;       // 0 = SIMPLE, 1 = ADVANCED
uniform float uUseMask;            // 1 = 使用 mask，0 = 全畫面視為最大移動
uniform float uMaskInvert;         // 1 = 黑色代表最大移動
uniform vec2  uMaskSoften;         // mask 柔化半徑，UV 單位

uniform float uMidAmpPx;           // GRAY 最大位移（texture pixel，在 uWindReference 下）
uniform float uStrongAmpPx;        // BLACK 最大位移

uniform vec4  uMaskEdges;          // (staticStart, staticEnd, strongStart, strongEnd)

uniform float uFogStrength;        // 0 = 關閉，畫面逐像素等同原圖
uniform float uFogWhiteAmount;     // WHITE（天空／霧）的相對強度
uniform float uFogGrayAmount;      // GRAY（中景森林）的相對強度
uniform vec3  uFogColor;           // 霧色，與輸出同一色彩空間
uniform float uFogContrast;        // 對比縮放倍率
uniform float uFogLuma;            // 亮度變化比例（讓接近霧色的天空也看得出來）
uniform float uFogScale;           // 空間頻率
uniform float uFogDrift;           // 一個循環內往右漂移的距離

const float TAU = 6.283185307179586;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

/** 訊號正規化增益。多諧波疊加後實際峰值只有約 0.775，這裡把它拉回 1.0。後面有 clamp。 */
const float SIGNAL_GAIN = 1.29;

/**
 * 單一諧波。k 必須是整數，這是 8 秒循環精確無縫的唯一條件。
 * ph 是空間相位（來自 static noise），可以是任意實數，不影響週期性。
 */
float harm(float k, float p, float ph) {
  return sin(TAU * (k * p + ph));
}

/** 波形塑形：峰值稍尖、中段稍飽滿，像陣風而不是等幅擺動。極值仍為 ±1。 */
float shape(float x) {
  return x * (1.35 - 0.35 * x * x);
}

/**
 * 讀取 mask 並換算成 movement 值（0 = 不動，1 = 最大移動）。
 *
 * 用 5 點取樣做空間柔化。mask 是硬邊的，直接取樣會讓位移在葉片輪廓上
 * 只跨 2 個 texel 就從 0 衝到滿值 —— 那個局部應變就是輪廓波浪感的來源。
 * 柔化之後位移沿著約 2×半徑的距離平緩爬升。
 *
 * 注意：這裡柔化的只是「移動強度」，不是影像本身。
 * mask 邊界因此不會製造任何額外形變。
 */
float sampleMovement(vec2 uv) {
  if (uUseMask <= 0.5) return 1.0;

  vec2 r = uMaskSoften;
  float lum =
      dot(texture2D(uMask, uv).rgb, LUMA) * 0.36
    + dot(texture2D(uMask, uv + vec2( r.x,  r.y)).rgb, LUMA) * 0.16
    + dot(texture2D(uMask, uv + vec2(-r.x,  r.y)).rgb, LUMA) * 0.16
    + dot(texture2D(uMask, uv + vec2( r.x, -r.y)).rgb, LUMA) * 0.16
    + dot(texture2D(uMask, uv + vec2(-r.x, -r.y)).rgb, LUMA) * 0.16;

  return mix(lum, 1.0 - lum, uMaskInvert);
}

/** 霧的空間結構。兩個八度就夠了 —— 霧本來就是軟的，細節多了反而像雜訊。 */
float fogFbm(vec2 q) {
  return 0.62 * snoise(q)
       + 0.38 * snoise(q * 2.17 + vec2(19.7, 4.3));
}

/**
 * 往右漂移的霧場，回傳約 -1 .. 1。
 *
 * 單張非平鋪的照片沒辦法真的無限往右平移，所以這裡疊兩層：
 * 兩層都以相同速度持續往右移動，用 smoothstep 交叉淡化交替接手。
 *   w = 0 時看 a = fogFbm(q)
 *   w → 1 時看 b = fogFbm(q)   ← 與 w = 0 完全相同
 * 值與一階導數都連續，所以 8 秒循環仍然無縫，而視覺上是持續單向漂移。
 *
 * 取樣點是 q - drift * w：往左取樣 = 圖案往右移動。
 */
float fogFieldAt(vec2 q, float p, float drift) {
  float w = fract(p);
  vec2 d = vec2(drift, 0.0);
  float a = fogFbm(q - d * w);
  float b = fogFbm(q - d * (w - 1.0));

  float t = smoothstep(0.0, 1.0, w);

  // 兩個幾乎不相關的場混合，變異數會是 (1-t)² + t²，在 t = 0.5 掉到一半，
  // 看起來就是霧的對比每 8 秒「呼吸」一次。這裡直接除掉那個包絡把它補平。
  // norm 只跟 t 有關，t(0) = 0、t(1) = 1 且兩端導數為 0，所以循環仍然連續。
  //
  // 但這只在兩層真的去相關時成立。drift 很小時 a 與 b 幾乎是同一個場，
  // 混合根本不會降低變異數 —— 這時若照樣除，反而會把中段放大 41%
  // （fogSpeed = 0 時實測起伏 0.707）。所以補償強度要跟著 drift 走。
  // 實測閾值 0.4：drift 0 → 1.000（不補償）、0.6 → 0.982、1.2 → 0.976、1.8 → 0.961。
  float decorr = smoothstep(0.0, 0.4, drift);
  float norm = mix(1.0, inversesqrt((1.0 - t) * (1.0 - t) + t * t), decorr);

  return mix(a, b, t) * norm;
}

void main() {
  // contain 模式下 quad 已經被縮放過，vUv 就是完整的 texture UV。
  vec2 uv = vUv;

  // 長寬比校正，避免非正方形圖片的空間紋理被拉長。風與霧共用。
  float aspect = uTexResolution.x / uTexResolution.y;
  vec2 auv = vec2(uv.x * aspect, uv.y);

  // ---------------------------------------------------------------------
  // Mask。一律在「未位移」的 uv 取樣 ——
  // 這是靜止區域絕對穩定的關鍵：不動的像素永遠讀到自己位置的 mask 值。
  // ---------------------------------------------------------------------
  float movement = sampleMovement(uv);

  // mSoft: 靜止 -> 中等 的權重（GRAY 與 BLACK 都是 1）
  // mHard: 中等 -> 最大 的權重（只有 BLACK 是 1）
  float mSoft = smoothstep(uMaskEdges.x, uMaskEdges.y, movement);
  float mHard = smoothstep(uMaskEdges.z, uMaskEdges.w, movement);
  float wMid    = mSoft - mHard;   // 因為 staticEnd < strongStart，這個值恆 >= 0
  float wStrong = mHard;

  vec2 duv = vec2(0.0);

  float gate = max(wMid, wStrong) * uWindStrength * uMovementScale;

  if (gate > 0.0) {
    float p = uPhase;

    // 兩層分開算：幅度 BLACK > GRAY，速度 GRAY > BLACK。
    // 上一版兩層共用同一個訊號，所以速度必定相同。
    float sStrong = 0.0;   // BLACK：近景葉片，幅度大、速度慢
    float sMid    = 0.0;   // GRAY ：中景森林，幅度小、速度快

    // -------------------------------------------------------------------
    // ADVANCED：分簇的葉片晃動（預設模式）。
    //
    // 這裡的核心觀念：**時間頻率不會造成應變，只有空間頻率會。**
    // 應變 = d(位移)/d(位置)，時間項再快也不出現在這個式子裡。
    //
    // 所以一簇葉子可以抖得很快（k 到 13，約 0.6 秒一次），
    // 只要那一簇「整簇一起抖」—— 也就是空間相位在簇內幾乎一致。
    // 這就是「像葉子」與「像布」的差別：
    //   像布   = 空間頻率太低，整張圖同一個相位
    //   像水波 = 空間頻率太高，單片葉子輪廓內部就被扭開
    //   像葉子 = 空間頻率落在「一簇葉子」的尺度（波長 300–500px）
    //
    // 空間場全部落在簇尺度：
    //   pA f=1.7 → 波長 1470px   大區陣風
    //   pD f=3.1 → 波長  805px   振幅擾動
    //   pE f=4.7 → 波長  531px   簇性格
    //   pB f=6.5 → 波長  384px   簇相位
    //   pC f=7.0 → 波長  356px   細葉相位（舊版是 31，波長 80px = 水波的來源）
    // 舊版還有一個每像素的軸向抖動，那是純變形、零平移貢獻，已經移除。
    // -------------------------------------------------------------------
    if (uMovementMode > 0.5) {
      float pA = snoise(auv * 1.7 + vec2(11.3,  4.1));
      float pB = snoise(auv * 6.5 + vec2(31.7, 19.2));
      float pC = snoise(auv * 7.0 + vec2( 3.9, 47.5));
      float pD = snoise(auv * 3.1 + vec2(57.4, 71.8));
      float pE = snoise(auv * 4.7 + vec2(88.1, 23.6));

      // 每一簇的「性格」：0 = 偏慢的大擺動（樹冠），1 = 偏碎的細抖（小葉叢）
      float character = pE * 0.5 + 0.5;
      float ampVar = 0.45 + 0.55 * (pD * 0.5 + 0.5);

      // 低頻：樹枝擺動
      float low = shape(0.58 * harm(1.0, p, pA * 0.5)
                      + 0.27 * harm(2.0, p, pD * 0.5 + 0.19)
                      + 0.15 * harm(3.0, p, pB * 0.5 + 0.62));

      // 中頻：枝葉
      float med = shape(0.50 * harm(2.0, p, pB * 0.5)
                      + 0.30 * harm(3.0, p, pA * 0.5 + 0.41)
                      + 0.20 * harm(5.0, p, pC * 0.5 + 0.88));

      // 高頻：細葉抖動。時間上很快（1.6s / 1.14s / 0.73s / 0.62s），
      // 但空間相位來自簇尺度的 pB / pC / pE，所以是「整簇一起抖」。
      float fine = shape(0.40 * harm( 5.0, p, pC * 0.5)
                       + 0.28 * harm( 7.0, p, pB * 0.5 + 0.73)
                       + 0.19 * harm(11.0, p, pE * 0.5 + 0.31)
                       + 0.13 * harm(13.0, p, pC * 0.5 + 0.57));

      // 陣風包絡：安靜的時間長，陣風偶爾才衝高
      float gust = 0.52 * harm(1.0, p, pD * 0.5)
                 + 0.31 * harm(2.0, p, pA * 0.5 + 0.21)
                 + 0.17 * harm(3.0, p, pB * 0.5 + 0.67);
      float gustEnv = 0.10 + 0.90 * pow(0.5 + 0.5 * gust, 1.6);

      // GRAY 專用的「更慢」成分：只有 k = 1 與 2（8 秒 / 4 秒），平均 k ≈ 1.25
      float slow = shape(0.75 * harm(1.0, p, pA * 0.5)
                       + 0.25 * harm(2.0, p, pD * 0.5 + 0.19));

      // -----------------------------------------------------------------
      // 兩層用不同的諧波權重，速度因此不同。每組權重和都是 1，|s| <= 1。
      //
      //   slow 的平均諧波 k ≈ 1.25  （8 秒 / 4 秒）
      //   low  的平均諧波 k ≈ 1.6   （8 秒 / 4 秒 / 2.7 秒）
      //   med  的平均諧波 k ≈ 2.9   （4 秒 / 2.7 秒 / 1.6 秒）
      //   fine 的平均諧波 k ≈ 7.7   （1.6 / 1.14 / 0.73 / 0.62 秒）
      //
      // BLACK 保留 fine → 較快；GRAY 幾乎只用 slow → 更慢但振幅更大。
      // 實測頻譜質心 1.82 vs 1.23 次/8秒。
      //
      // cVar 保留簇與簇之間的性格差異，幅度收窄到 ±0.08，
      // 不會蓋過層級之間的速度差。加減相消，所以權重和仍然是 1。
      // -----------------------------------------------------------------
      float cVar = (character - 0.5) * 0.16;

      sStrong = clamp(SIGNAL_GAIN * gustEnv * (
            (0.60 - cVar) * low
          +  0.30         * med
          + (0.10 + cVar) * fine), -1.0, 1.0) * ampVar;

      sMid = clamp(SIGNAL_GAIN * gustEnv * (
             0.80         * slow
          + (0.17 - cVar) * low
          +  0.03         * med
          +  cVar         * fine), -1.0, 1.0) * ampVar;

    } else {
      // -----------------------------------------------------------------
      // SIMPLE：一個很慢的主風（8 秒）+ 一個更小的次要水平變化（4 秒）。
      // 空間場全部極低頻（波長 1190–3100px），所以整張圖幾乎同相位。
      // 最保守，但觀感偏向「整片一起平移」而不是葉子在晃。
      // -----------------------------------------------------------------
      float rGust  = snoise(auv * 0.8 + vec2(31.7, 19.2));
      float rPhase = snoise(auv * 1.2 + vec2(11.3,  4.1));
      float rAmp   = snoise(auv * 2.1 + vec2(57.4, 71.8));

      float regionAmp = 0.30 + 0.70 * (rAmp * 0.5 + 0.5);
      float env = 0.625 + 0.375 * sin(TAU * (1.0 * p + rGust * 0.5));

      float primary   = sin(TAU * (1.0 * p + rPhase * 0.5));
      float secondary = sin(TAU * (2.0 * p + rGust  * 0.5 + 0.37));
      float tertiary  = sin(TAU * (3.0 * p + rAmp   * 0.5 + 0.61));

      // 同樣讓 GRAY 比 BLACK 快，只是諧波少很多
      sStrong = (0.85 * primary + 0.15 * secondary) * regionAmp * env;
      sMid    = (0.35 * primary + 0.40 * secondary + 0.25 * tertiary) * regionAmp * env;
    }

    // -------------------------------------------------------------------
    // 位移，單位 = 原生 texture pixel。
    //
    // 一個像素只有「一個」運動，方向／振幅／訊號在兩層之間內插。
    //
    // 之前是把兩層的運動直接相加。但兩層的軸向是垂直的（GRAY 左右、BLACK 上下），
    // 相加會變成橢圓運動 —— 在 mask 柔化過的過渡帶（細枝葉尤其明顯，
    // 實測上半的 wStrong 只有 0.65，其餘 0.35 來自 GRAY）
    // 那個像素會同時被水平慢動與垂直快動拉扯，運動性格被稀釋、看起來就沒在動。
    //
    // 改成內插之後，過渡帶是「介於兩層之間的單一運動」，方向明確。
    // -------------------------------------------------------------------
    float total = clamp(wMid + wStrong, 0.0, 1.0);
    float t = total > 1e-4 ? wStrong / total : 0.0;

    vec2 axisRaw = mix(uMidAxis, uStrongAxis, t);
    float axisLen = length(axisRaw);
    vec2 axis = axisLen > 1e-4 ? axisRaw / axisLen : uMidAxis;

    vec2 offsetPx = axis * (total * mix(uMidAmpPx, uStrongAmpPx, t) * mix(sMid, sStrong, t));

    // px -> uv，再套上使用者的強度控制。
    // uWindStrength = 0 時，這裡精確為 vec2(0.0)。
    duv = (offsetPx / uTexResolution)
        * (uWindStrength / uWindReference)
        * uMovementScale;
  }

  // ---------------------------------------------------------------------
  // 取樣。clamp 到半個 texel 內側，配合 ClampToEdgeWrapping，
  // 保證邊緣不會出現透明區、黑邊或 wrap 過去的錯誤像素。
  //
  // 這一行的 texture2D 位於 uniform control flow（不在任何 if 裡面），
  // 所以 mipmap 的 derivative 是良好定義的，不會產生接縫。
  // ---------------------------------------------------------------------
  vec2 sampleUv = clamp(uv + duv, uHalfTexel, vec2(1.0) - uHalfTexel);

  vec3 rgb = texture2D(uTexture, sampleUv).rgb;

  // ---------------------------------------------------------------------
  // 霧氣飄移。
  //
  // 只作用在 WHITE（1.0 - mSoft）與 GRAY（wMid）兩層，
  // BLACK 的近景葉片兩個權重都是 0，完全不受影響。
  //
  // 霧場取樣用未位移的 uv —— 霧是獨立的大氣層，不該跟著樹葉一起被風推。
  // ---------------------------------------------------------------------
  float fogMask = (1.0 - mSoft) * uFogWhiteAmount + wMid * uFogGrayAmount;
  float fogAmount = uFogStrength * fogMask;

  if (fogAmount > 0.0) {
    float f = fogFieldAt(auv * uFogScale, uPhase, uFogDrift);

    // -------------------------------------------------------------------
    // 以「對比」為模型，而不是疊一層紗。
    //
    // 真實的霧就是把畫面往霧色壓縮 —— 對比下降；霧散開則對比回來。
    // 一個對稱的縮放同時涵蓋兩個方向：
    //
    //   k > 0：往霧色壓縮  → 霧變濃，對比下降
    //   k < 0：從霧色推開  → 霧變薄，對比上升
    //   k = 0：完全等同原圖，逐像素相同
    //
    // 這比舊的「mix 往霧色靠 + 壓暗」明顯得多，因為它縮放的是整個對比範圍，
    // 而不是只在亮部加一層幾乎看不見的白。
    // -------------------------------------------------------------------
    float k = clamp(f * fogAmount * uFogContrast, -0.85, 0.85);

    // 對比：往霧色壓縮 / 從霧色推開
    rgb = uFogColor + (rgb - uFogColor) * (1.0 - k);

    // 亮度：天空本來就接近霧色，光靠對比縮放幾乎不動它
    //（實測只有 1.9/255）。這一項讓接近霧色的區域也看得出濃淡變化。
    rgb = clamp(rgb * (1.0 + k * uFogLuma), 0.0, 1.0);
  }

  gl_FragColor = vec4(rgb, 1.0);
}
