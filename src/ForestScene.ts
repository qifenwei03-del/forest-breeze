import * as THREE from 'three';

import noiseSrc from './shaders/simplex2d.glsl?raw';
import vertexSrc from './shaders/forest.vert.glsl?raw';
import fragmentBodySrc from './shaders/forest.frag.glsl?raw';

import {
  AMPLITUDE,
  DEFAULT_CONFIG,
  FOG,
  LOOP_DURATION,
  MASK_DARK_MEANS_MOVE,
  MASK_EDGES,
  MASK_SOFTEN_PX,
  TIER_AXIS_DEG,
  MAX_PIXEL_RATIO,
  RENDER_QUALITY,
  REFERENCE_WIND_STRENGTH,
  TEXTURE_QUALITY,
  type MovementMode,
  type WindConfig,
} from './config';
import type { LoadedTexture } from './textures';

/** simplex2d.glsl 提供 snoise()，必須排在使用它的 forest.frag.glsl 前面。 */
const fragmentSrc = `${noiseSrc}\n${fragmentBodySrc}`;

export interface SceneMetrics {
  textureWidth: number;
  textureHeight: number;
  maskWidth: number;
  maskHeight: number;
  cssWidth: number;
  cssHeight: number;
  bufferWidth: number;
  bufferHeight: number;
  pixelRatio: number;
  devicePixelRatio: number;
  maxTextureSize: number;
  /** 目前參數下 GRAY 區域的最大位移（原生 texture pixel）。 */
  effectiveMidPx: number;
  /** 目前參數下 BLACK 區域的最大位移（原生 texture pixel）。 */
  effectiveStrongPx: number;
  /** contain 後圖片實際佔用的 CSS 尺寸。 */
  displayWidth: number;
  displayHeight: number;
  /** 圖片在 render buffer 裡實際佔用的像素寬度。 */
  renderedImageWidth: number;
  /**
   * render buffer 像素 ÷ 原生 texel。
   * >= 1 代表原生解析度完全用得上（取樣時走 mipmap level 0）；
   * < 1 代表在縮小，細節在輸出端就損失了。
   */
  samplingRatio: number;
}

export class ForestScene {
  readonly renderer: THREE.WebGLRenderer;

  private readonly container: HTMLElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;

  private readonly photo: LoadedTexture;
  private readonly mask: LoadedTexture;

  private readonly config: WindConfig;

  private rafId = 0;
  private running = false;
  private disposed = false;
  private lastTimestamp = 0;
  /** 循環相位，永遠保持在 [0, 1)。 */
  private phase = 0;
  /** 暫停狀態下只有參數變更才需要重繪。 */
  private needsRender = true;

  private readonly handleResize = () => this.resize();
  private readonly resizeObserver: ResizeObserver;

  /**
   * devicePixelRatio 改變（跨螢幕拖曳、瀏覽器縮放）不會觸發 resize 事件，
   * 也不會觸發 ResizeObserver —— CSS 尺寸沒變。
   * 沒有這個監聽，canvas 會一直卡在舊的 pixelRatio。
   * matchMedia 查詢綁定的是「當下這個 dppx」，所以每次變動後要重新綁一次。
   */
  private dprQuery: MediaQueryList | null = null;

  private readonly handleDprChange = () => {
    this.watchPixelRatio();
    this.resize();
  };

  private watchPixelRatio(): void {
    this.dprQuery?.removeEventListener('change', this.handleDprChange);
    if (this.disposed) {
      this.dprQuery = null;
      return;
    }
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener('change', this.handleDprChange);
    this.dprQuery = query;
  }

  /** resize 完成後的通知（debug panel 用來刷新解析度資訊）。 */
  onResized: (() => void) | null = null;

  constructor(container: HTMLElement, photo: LoadedTexture, mask: LoadedTexture) {
    this.container = container;
    this.photo = photo;
    this.mask = mask;
    this.config = { ...DEFAULT_CONFIG };

    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // fullscreen quad 沒有幾何邊緣，MSAA 只會浪費頻寬
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.setClearColor(0x000000, 1);
    // ShaderMaterial 不注入 colorspace chunk，這裡明確標示「輸出不做轉換」。
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;

    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.photo.texture.anisotropy = Math.min(TEXTURE_QUALITY.anisotropy, maxAniso);

    this.container.appendChild(this.renderer.domElement);

    this.geometry = new THREE.PlaneGeometry(2, 2);

    this.material = new THREE.ShaderMaterial({
      vertexShader: vertexSrc,
      fragmentShader: fragmentSrc,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      uniforms: {
        uTexture: { value: this.photo.texture },
        uMask: { value: this.mask.texture },
        uTexResolution: { value: new THREE.Vector2(this.photo.width, this.photo.height) },
        uQuadScale: { value: new THREE.Vector2(1, 1) },
        uHalfTexel: {
          value: new THREE.Vector2(0.5 / this.photo.width, 0.5 / this.photo.height),
        },
        uPhase: { value: 0 },
        uMidAxis: { value: new THREE.Vector2(1, 0) },
        uStrongAxis: { value: new THREE.Vector2(0, 1) },
        uWindStrength: { value: this.config.windStrength },
        uWindReference: { value: REFERENCE_WIND_STRENGTH },
        uMovementScale: { value: this.config.movementScale },
        uUseMask: { value: this.config.maskEnabled ? 1 : 0 },
        uMaskInvert: { value: MASK_DARK_MEANS_MOVE ? 1 : 0 },
        uMaskSoften: {
          value: new THREE.Vector2(
            MASK_SOFTEN_PX / this.photo.width,
            MASK_SOFTEN_PX / this.photo.height,
          ),
        },
        uMovementMode: { value: this.config.movementMode === 'ADVANCED' ? 1 : 0 },
        uMidAmpPx: { value: AMPLITUDE.midPx },
        uStrongAmpPx: { value: AMPLITUDE.strongPx },
        uFogStrength: { value: this.config.fogStrength },
        uFogWhiteAmount: { value: FOG.whiteAmount },
        uFogGrayAmount: { value: FOG.grayAmount },
        uFogColor: { value: new THREE.Vector3(...FOG.color) },
        uFogContrast: { value: FOG.contrast },
        uFogLuma: { value: FOG.luma },
        uFogScale: { value: FOG.scale },
        uFogDrift: { value: FOG.drift * this.config.fogSpeed },
        uMaskEdges: {
          value: new THREE.Vector4(
            MASK_EDGES.staticStart,
            MASK_EDGES.staticEnd,
            MASK_EDGES.strongStart,
            MASK_EDGES.strongEnd,
          ),
        },
      },
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    this.setWindDirection(this.config.windDirection);
    this.resize();

    // ResizeObserver 負責容器尺寸變化，包含「初次 layout 之前寬高還是 0」的情況
    // ——這時 resize() 會提早 return，必須靠 observer 在 layout 完成後補上。
    this.resizeObserver = new ResizeObserver(this.handleResize);
    this.resizeObserver.observe(this.container);

    // window resize 負責 ResizeObserver 看不到的事：跨螢幕移動造成 devicePixelRatio 改變。
    // 兩者呼叫同一個 resize()，不會產生第二條路徑，也不會產生第二個 animation loop。
    window.addEventListener('resize', this.handleResize);
    this.watchPixelRatio();
  }

  // -------------------------------------------------------------------------
  // 尺寸
  // -------------------------------------------------------------------------

  /**
   * 三種解析度是獨立的：
   *   1. texture resolution  = photo.width / photo.height（永遠不變，永遠是原生）
   *   2. canvas 內部 buffer   = cssSize * pixelRatio（下面計算）
   *   3. canvas CSS 顯示尺寸  = 由 CSS 100%/100% 決定
   * 這個方法只動 2 和 3，完全不碰 1。
   */
  /**
   * 決定 canvas render buffer 相對於 CSS 尺寸的倍率。
   *
   * 'native-texture' 模式的目標：圖片在 render buffer 裡至少要有 photo.width 個像素，
   * 這樣 shader 才是以 1:1（或放大）取樣原生 texture，用得到 mipmap level 0。
   * 之後瀏覽器把 canvas 合成縮到 CSS 尺寸，等同 supersampling。
   *
   * 注意：這裡調整的自始至終只有 canvas 的像素數，texture 永遠是原生解析度。
   */
  private computePixelRatio(cssWidth: number, cssHeight: number, quad: THREE.Vector2): number {
    const deviceRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    if (RENDER_QUALITY.mode !== 'native-texture') return deviceRatio;

    // 圖片實際佔用的 CSS 尺寸（contain 之後）
    const fittedCssWidth = cssWidth * quad.x;
    const fittedCssHeight = cssHeight * quad.y;
    if (fittedCssWidth <= 0 || fittedCssHeight <= 0) return deviceRatio;

    // 要讓圖片每邊都有原生 texel 那麼多的 render buffer 像素，需要的倍率
    const needed = Math.max(
      this.photo.width / fittedCssWidth,
      this.photo.height / fittedCssHeight,
    );

    // 不要比 devicePixelRatio 還低，否則高 DPI 螢幕反而變糊
    let ratio = Math.max(deviceRatio, needed);

    // 夾到設定上限與 GPU 上限（兩邊都要看，取較嚴格者）
    const hardLimit = Math.min(
      RENDER_QUALITY.maxRenderSize,
      this.renderer.capabilities.maxTextureSize,
    );
    const longestCss = Math.max(cssWidth, cssHeight);
    ratio = Math.min(ratio, hardLimit / longestCss);

    // 極端窄視窗時上面的夾擠可能算出小於 1 的值，至少維持 1:1
    return Math.max(ratio, 1);
  }

  private resize(): void {
    if (this.disposed) return;

    const cssWidth = this.container.clientWidth || window.innerWidth;
    const cssHeight = this.container.clientHeight || window.innerHeight;
    // 分頁還沒 layout（或視窗被縮到 0）時先跳過；ResizeObserver 會在尺寸出現後再叫一次。
    if (cssWidth === 0 || cssHeight === 0) return;

    // contain：把 quad 等比縮到視窗內，整張圖完整可見、永遠維持原始比例（1:1），
    // 多出來的部分留給 renderer 的黑色 clear color。texture 本身完全不動，也不會被 stretch。
    // 必須先算 quad —— 下面的渲染解析度要用它決定圖片實際佔多少 CSS 像素。
    const texAspect = this.photo.width / this.photo.height;
    const screenAspect = cssWidth / cssHeight;
    const quad = this.material.uniforms.uQuadScale.value as THREE.Vector2;
    if (screenAspect > texAspect) {
      // 畫面比圖片寬 → 高度撐滿，左右留黑
      quad.set(texAspect / screenAspect, 1);
    } else {
      // 畫面比圖片高 → 寬度撐滿，上下留黑
      quad.set(1, screenAspect / texAspect);
    }

    this.renderer.setPixelRatio(this.computePixelRatio(cssWidth, cssHeight, quad));
    this.renderer.setSize(cssWidth, cssHeight, true);

    this.needsRender = true;
    this.onResized?.();
  }

  // -------------------------------------------------------------------------
  // 動畫迴圈（整個程式只有這一個 requestAnimationFrame 迴圈）
  // -------------------------------------------------------------------------

  private readonly tick = (timestamp: number) => {
    if (this.disposed) {
      this.rafId = 0;
      return;
    }
    this.rafId = requestAnimationFrame(this.tick);

    const dt =
      this.lastTimestamp === 0
        ? 0
        : Math.min((timestamp - this.lastTimestamp) / 1000, 0.1); // 分頁切回來時避免大跳
    this.lastTimestamp = timestamp;

    if (!this.config.paused) {
      // phase 連續累加後取小數部分。
      // 因為 shader 的時間項全是整數諧波，phase 由 0.999… 跨到 0.0 時
      // 每一項的值與導數都完全連續 —— 這就是「真正可循環」的意思。
      this.phase += (dt * this.config.animationSpeed) / LOOP_DURATION;
      this.phase -= Math.floor(this.phase);
      this.material.uniforms.uPhase.value = this.phase;
      this.needsRender = true;
    }

    if (this.needsRender) {
      this.renderer.render(this.scene, this.camera);
      this.needsRender = false;
    }
  };

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastTimestamp = 0;
    this.rafId = requestAnimationFrame(this.tick);
  }

  // -------------------------------------------------------------------------
  // 參數（只更新既有 uniform 的數值，不重建 material，不重建 texture）
  // -------------------------------------------------------------------------

  setWindStrength(v: number): void {
    this.config.windStrength = v;
    this.material.uniforms.uWindStrength.value = v;
    this.needsRender = true;
  }

  /**
   * 風向。兩層的實際軸向 = 風向 + 各自的 TIER_AXIS_DEG 偏移，
   * 所以 GRAY 與 BLACK 可以擺在不同方向（目前是左右 vs 上下）。
   */
  setWindDirection(degrees: number): void {
    this.config.windDirection = degrees;
    const toVec = (deg: number) => {
      const rad = ((degrees + deg) * Math.PI) / 180;
      return [Math.cos(rad), Math.sin(rad)] as const;
    };
    const [mx, my] = toVec(TIER_AXIS_DEG.mid);
    const [sx, sy] = toVec(TIER_AXIS_DEG.strong);
    (this.material.uniforms.uMidAxis.value as THREE.Vector2).set(mx, my);
    (this.material.uniforms.uStrongAxis.value as THREE.Vector2).set(sx, sy);
    this.needsRender = true;
  }

  setAnimationSpeed(v: number): void {
    this.config.animationSpeed = v;
  }

  setMovementScale(v: number): void {
    this.config.movementScale = v;
    this.material.uniforms.uMovementScale.value = v;
    this.needsRender = true;
  }

  /**
   * 霧氣漂移速度倍率。
   *
   * 直接改 uFogDrift（一個循環內漂移的距離）。
   * 交叉淡化的無縫性與 drift 大小無關 —— 兩層永遠相差剛好一個 drift，
   * w = 1 時必定回到 w = 0 的狀態，所以速度可以自由調整而不破壞 8 秒循環。
   */
  setFogSpeed(v: number): void {
    this.config.fogSpeed = v;
    this.material.uniforms.uFogDrift.value = FOG.drift * v;
    this.needsRender = true;
  }

  setMovementMode(mode: MovementMode): void {
    this.config.movementMode = mode;
    this.material.uniforms.uMovementMode.value = mode === 'ADVANCED' ? 1 : 0;
    this.needsRender = true;
  }

  setFogStrength(v: number): void {
    this.config.fogStrength = v;
    this.material.uniforms.uFogStrength.value = v;
    this.needsRender = true;
  }

  setMaskEnabled(enabled: boolean): void {
    this.config.maskEnabled = enabled;
    this.material.uniforms.uUseMask.value = enabled ? 1 : 0;
    this.needsRender = true;
  }

  setPaused(paused: boolean): void {
    this.config.paused = paused;
  }

  /** 套用一組（可能只有部分欄位的）設定，例如從 localStorage 讀回來的值。 */
  applyConfig(partial: Partial<WindConfig>): void {
    if (partial.windStrength !== undefined) this.setWindStrength(partial.windStrength);
    if (partial.windDirection !== undefined) this.setWindDirection(partial.windDirection);
    if (partial.animationSpeed !== undefined) this.setAnimationSpeed(partial.animationSpeed);
    if (partial.movementScale !== undefined) this.setMovementScale(partial.movementScale);
    if (partial.fogStrength !== undefined) this.setFogStrength(partial.fogStrength);
    if (partial.fogSpeed !== undefined) this.setFogSpeed(partial.fogSpeed);
    if (partial.movementMode !== undefined) this.setMovementMode(partial.movementMode);
    if (partial.maskEnabled !== undefined) this.setMaskEnabled(partial.maskEnabled);
    if (partial.paused !== undefined) this.setPaused(partial.paused);
  }

  reset(): void {
    this.phase = 0;
    this.material.uniforms.uPhase.value = 0;
    this.setWindStrength(DEFAULT_CONFIG.windStrength);
    this.setWindDirection(DEFAULT_CONFIG.windDirection);
    this.setAnimationSpeed(DEFAULT_CONFIG.animationSpeed);
    this.setMovementScale(DEFAULT_CONFIG.movementScale);
    this.setFogStrength(DEFAULT_CONFIG.fogStrength);
    this.setFogSpeed(DEFAULT_CONFIG.fogSpeed);
    this.setMovementMode(DEFAULT_CONFIG.movementMode);
    this.setMaskEnabled(DEFAULT_CONFIG.maskEnabled);
    this.setPaused(DEFAULT_CONFIG.paused);
    this.needsRender = true;
  }

  getConfig(): Readonly<WindConfig> {
    return this.config;
  }

  getMetrics(): SceneMetrics {
    const canvas = this.renderer.domElement;
    const gain = (this.config.windStrength / REFERENCE_WIND_STRENGTH) * this.config.movementScale;
    const quad = this.material.uniforms.uQuadScale.value as THREE.Vector2;
    return {
      textureWidth: this.photo.width,
      textureHeight: this.photo.height,
      maskWidth: this.mask.width,
      maskHeight: this.mask.height,
      cssWidth: Math.round(canvas.clientWidth),
      cssHeight: Math.round(canvas.clientHeight),
      bufferWidth: canvas.width,
      bufferHeight: canvas.height,
      pixelRatio: this.renderer.getPixelRatio(),
      devicePixelRatio: window.devicePixelRatio || 1,
      maxTextureSize: this.renderer.capabilities.maxTextureSize,
      effectiveMidPx: AMPLITUDE.midPx * gain,
      effectiveStrongPx: AMPLITUDE.strongPx * gain,
      displayWidth: Math.round(canvas.clientWidth * quad.x),
      displayHeight: Math.round(canvas.clientHeight * quad.y),
      renderedImageWidth: Math.round(canvas.width * quad.x),
      samplingRatio: (canvas.width * quad.x) / this.photo.width,
    };
  }

  // -------------------------------------------------------------------------
  // 釋放
  // -------------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;

    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }

    this.resizeObserver.disconnect();
    window.removeEventListener('resize', this.handleResize);
    this.dprQuery?.removeEventListener('change', this.handleDprChange);
    this.dprQuery = null;
    this.onResized = null;

    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.photo.texture.dispose();
    this.mask.texture.dispose();
    this.renderer.dispose();

    const canvas = this.renderer.domElement;
    canvas.parentNode?.removeChild(canvas);
  }
}
