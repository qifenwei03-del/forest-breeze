import * as THREE from 'three';

/**
 * 可視化的 motion field。
 *
 * 一張覆蓋整張圖片的低解析向量場，每一格記錄該區域的
 *   - 運動方向（UV 空間的單位向量）
 *   - 振幅倍率
 *
 * 兩層的軸向偏移（TIER_AXIS_DEG）仍然疊在這個方向上，
 * 所以「GRAY 沿風向、BLACK 垂直於風向」的關係不會被破壞 ——
 * field 改的是「該區域的風往哪吹」。
 *
 * 座標約定
 * --------
 * grid[row][col]，row 0 = 圖片最上方（跟編輯器的螢幕座標一致，比較好推理）。
 * 但 shader 取樣的 uv.y = 1 才是圖片上方（照片 texture 是 flipY），
 * 所以 encode 時會把列順序反寫進 DataTexture，避免依賴 DataTexture 的 flipY 行為。
 *
 * 方向存的是 **UV 空間**：+y 朝上。編輯器的螢幕 +y 朝下，
 * 兩邊轉換時 y 要取負號。
 */

/** 每邊的格數。2496px 的圖 → 每格約 208px，落在「一簇葉子」的尺度。 */
export const GRID = 12;

/** 振幅倍率上限（0 = 該區完全不動）。 */
export const MAX_AMP = 2;

export interface MotionCell {
  /** UV 空間的方向，接近單位長度 */
  x: number;
  y: number;
  /** 0 – MAX_AMP */
  amp: number;
}

export interface MotionFieldJSON {
  grid: number;
  /** 每格三個數字：x, y, amp */
  cells: number[];
}

const STORAGE_KEY = 'forest-breeze:motion-field';

export class MotionField {
  readonly cells: MotionCell[][];
  readonly texture: THREE.DataTexture;
  private readonly data: Uint8Array<ArrayBuffer>;

  constructor() {
    this.cells = Array.from({ length: GRID }, () =>
      Array.from({ length: GRID }, () => ({ x: 1, y: 0, amp: 1 })),
    );
    // 明確給 ArrayBuffer：TS 5.7 之後 Uint8Array 帶泛型，
    // 不指定的 ArrayBufferLike 不能賦值給 DataTexture 要求的 BufferSource
    this.data = new Uint8Array(new ArrayBuffer(GRID * GRID * 4));
    this.texture = new THREE.DataTexture(this.data, GRID, GRID, THREE.RGBAFormat);
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    // 線性取樣 = 格與格之間平滑過渡，避免方向突變造成的局部應變
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.upload();
  }

  /** 把整個場設成同一個方向（度，0 = 由左往右）與振幅。 */
  fill(degrees: number, amp = 1): void {
    const rad = (degrees * Math.PI) / 180;
    const x = Math.cos(rad);
    const y = Math.sin(rad);
    for (const row of this.cells) for (const c of row) { c.x = x; c.y = y; c.amp = amp; }
    this.upload();
  }

  /**
   * 以筆刷塗改。
   * u, v 是圖片上的正規化座標（0..1，v = 0 在最上方，跟 row 一致）。
   * radius 也是正規化的。權重用 smoothstep，邊緣不會有硬接縫。
   */
  paint(u: number, v: number, radius: number, dirX: number, dirY: number, amp: number): void {
    const len = Math.hypot(dirX, dirY);
    const hasDir = len > 1e-4;
    const nx = hasDir ? dirX / len : 0;
    const ny = hasDir ? dirY / len : 0;

    for (let row = 0; row < GRID; row++) {
      const cv = (row + 0.5) / GRID;
      for (let col = 0; col < GRID; col++) {
        const cu = (col + 0.5) / GRID;
        const d = Math.hypot(cu - u, cv - v);
        if (d >= radius) continue;
        const t = 1 - d / radius;
        const w = t * t * (3 - 2 * t);          // smoothstep 權重
        const cell = this.cells[row][col];
        if (hasDir) {
          cell.x += (nx - cell.x) * w;
          cell.y += (ny - cell.y) * w;
          const l = Math.hypot(cell.x, cell.y);
          if (l > 1e-4) { cell.x /= l; cell.y /= l; }
        }
        cell.amp += (amp - cell.amp) * w;
      }
    }
    this.upload();
  }

  /** 讀取某個位置的內插值，給編輯器顯示數值用。 */
  sample(u: number, v: number): MotionCell {
    const col = Math.min(GRID - 1, Math.max(0, Math.floor(u * GRID)));
    const row = Math.min(GRID - 1, Math.max(0, Math.floor(v * GRID)));
    return this.cells[row][col];
  }

  /** 寫進 DataTexture。row 0（圖片上方）要落在 uv.y = 1，所以反序寫入。 */
  private upload(): void {
    for (let row = 0; row < GRID; row++) {
      const texRow = GRID - 1 - row;
      for (let col = 0; col < GRID; col++) {
        const c = this.cells[row][col];
        const i = (texRow * GRID + col) * 4;
        this.data[i] = Math.round((c.x * 0.5 + 0.5) * 255);
        this.data[i + 1] = Math.round((c.y * 0.5 + 0.5) * 255);
        this.data[i + 2] = Math.round(Math.min(1, Math.max(0, c.amp / MAX_AMP)) * 255);
        this.data[i + 3] = 255;
      }
    }
    this.texture.needsUpdate = true;
  }

  toJSON(): MotionFieldJSON {
    const cells: number[] = [];
    for (const row of this.cells)
      for (const c of row) cells.push(+c.x.toFixed(4), +c.y.toFixed(4), +c.amp.toFixed(3));
    return { grid: GRID, cells };
  }

  /** 套用序列化的資料。格數不符或資料損毀就整份忽略，回傳 false。 */
  fromJSON(json: unknown): boolean {
    if (typeof json !== 'object' || json === null) return false;
    const o = json as MotionFieldJSON;
    if (o.grid !== GRID || !Array.isArray(o.cells) || o.cells.length !== GRID * GRID * 3) return false;
    if (!o.cells.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;

    let i = 0;
    for (let row = 0; row < GRID; row++) {
      for (let col = 0; col < GRID; col++) {
        const x = o.cells[i++], y = o.cells[i++], amp = o.cells[i++];
        const len = Math.hypot(x, y);
        const cell = this.cells[row][col];
        cell.x = len > 1e-4 ? x / len : 1;
        cell.y = len > 1e-4 ? y / len : 0;
        cell.amp = Math.min(MAX_AMP, Math.max(0, amp));
      }
    }
    this.upload();
    return true;
  }

  save(): boolean {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.toJSON()));
      return true;
    } catch {
      return false;
    }
  }

  /** 從 localStorage 載入，回傳是否成功套用。 */
  load(): boolean {
    let raw: string | null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch { return false; }
    if (!raw) return false;
    try { return this.fromJSON(JSON.parse(raw)); } catch { return false; }
  }

  static clearSaved(): void {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* 沒得清就算了 */ }
  }

  dispose(): void {
    this.texture.dispose();
  }
}
