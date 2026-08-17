import { DEFAULT_CONFIG, type MovementMode, type WindConfig } from './config';

const STORAGE_KEY = 'forest-breeze:wind-config';

/**
 * 會被儲存的欄位。
 *
 * 刻意不存 `paused` —— 存下暫停狀態會讓下次開啟時畫面是凍結的，
 * 那不是「儲存現在的動態」想要的結果。
 */
export type SavedConfig = Omit<WindConfig, 'paused'>;

interface Range {
  min: number;
  max: number;
}

/** 與 debug panel 的滑桿範圍一致。 */
const RANGES: Record<keyof Omit<SavedConfig, 'maskEnabled' | 'movementMode'>, Range> = {
  windStrength: { min: 0, max: 1 },
  windDirection: { min: 0, max: 360 },
  animationSpeed: { min: 0.1, max: 2 },
  movementScale: { min: 0, max: 2 },
  fogStrength: { min: 0, max: 0.5 },
  fogSpeed: { min: 0, max: 8 },
};

/**
 * 只接受「真的是有限數字」的值，其餘一律回退。
 *
 * 不用 Number(value) 做轉換：Number(null)、Number('')、Number([]) 全都是 0，
 * 會被誤判成合法數值然後夾到範圍下限，而不是回到預設值。
 * 我們寫進去的一定是 number，所以非 number 就代表資料損毀。
 */
function clampNumber(value: unknown, range: Range, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, value));
}

/**
 * 讀取已儲存的設定。
 * 任何損毀／型別不對的欄位都會退回程式碼裡的預設值，不會讓頁面壞掉。
 * 回傳 null 代表沒有存過。
 */
export function loadSavedConfig(): SavedConfig | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // 無痕模式等情況下 localStorage 會丟例外
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const o = parsed as Record<string, unknown>;
  return {
    windStrength: clampNumber(o.windStrength, RANGES.windStrength, DEFAULT_CONFIG.windStrength),
    windDirection: clampNumber(o.windDirection, RANGES.windDirection, DEFAULT_CONFIG.windDirection),
    animationSpeed: clampNumber(o.animationSpeed, RANGES.animationSpeed, DEFAULT_CONFIG.animationSpeed),
    movementScale: clampNumber(o.movementScale, RANGES.movementScale, DEFAULT_CONFIG.movementScale),
    fogStrength: clampNumber(o.fogStrength, RANGES.fogStrength, DEFAULT_CONFIG.fogStrength),
    fogSpeed: clampNumber(o.fogSpeed, RANGES.fogSpeed, DEFAULT_CONFIG.fogSpeed),
    movementMode:
      o.movementMode === 'SIMPLE' || o.movementMode === 'ADVANCED'
        ? (o.movementMode as MovementMode)
        : DEFAULT_CONFIG.movementMode,
    maskEnabled: typeof o.maskEnabled === 'boolean' ? o.maskEnabled : DEFAULT_CONFIG.maskEnabled,
  };
}

/** 寫入設定。回傳是否成功（localStorage 可能不可用或已滿）。 */
export function saveConfig(config: Readonly<WindConfig>): boolean {
  const payload: SavedConfig = {
    windStrength: config.windStrength,
    windDirection: config.windDirection,
    animationSpeed: config.animationSpeed,
    movementScale: config.movementScale,
    fogStrength: config.fogStrength,
    fogSpeed: config.fogSpeed,
    movementMode: config.movementMode,
    maskEnabled: config.maskEnabled,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/** 清除已儲存的設定，回到程式碼裡的預設值。 */
export function clearSavedConfig(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 沒得清就算了 */
  }
}

/** 產生可以直接貼回 src/config.ts 的片段。 */
export function toConfigSnippet(config: Readonly<WindConfig>): string {
  return [
    'export const DEFAULT_CONFIG: WindConfig = {',
    `  windStrength: ${config.windStrength},`,
    `  windDirection: ${config.windDirection},`,
    `  animationSpeed: ${config.animationSpeed},`,
    `  movementScale: ${config.movementScale},`,
    `  fogStrength: ${config.fogStrength},`,
    `  fogSpeed: ${config.fogSpeed},`,
    `  movementMode: '${config.movementMode}',`,
    `  maskEnabled: ${config.maskEnabled},`,
    '  paused: false,',
    '};',
  ].join('\n');
}
