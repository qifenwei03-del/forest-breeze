import type { ForestScene } from './ForestScene';
import { fetchWeather, LOCATION, type WeatherData } from './weather';

/**
 * 面板在正方形圖片中的版面比例。
 *
 * 面板要跟著「圖片」走而不是視窗 —— 圖片是 contain 置中的，
 * 視窗比例不同時左右或上下會留黑，釘在視窗角落會跑到黑邊上。
 *
 * inset + width 加起來剛好落在圖片的左上 1/4 內（0.025 + 0.446 = 0.471 < 0.5）。
 */
const LAYOUT = {
  /** 距離圖片邊緣的內縮，佔圖片邊長的比例。 */
  inset: 0.025,
  /** 面板寬度，佔圖片邊長的比例。 */
  width: 0.446,
  /**
   * 基準字級佔圖片邊長的比例。面板內部全部用 em，
   * 所以整張卡片會跟著圖片等比縮放，版面比例在任何視窗大小都一樣。
   */
  fontScale: 0.0142,
  /** 字級下限，避免視窗極小時完全看不清。 */
  minFontPx: 7,
};

/** 每隔多久重新抓一次（毫秒）。Open-Meteo 的資料本來就是每小時更新，10 分鐘足夠。 */
const REFRESH_MS = 10 * 60 * 1000;

/** 抓取失敗後的重試間隔。 */
const RETRY_MS = 60 * 1000;

export interface WeatherPanelHandle {
  dispose(): void;
}

/** 14px 線條圖示，stroke 用 currentColor。 */
const ICONS = {
  wind: 'M3 8h9a2.5 2.5 0 1 0-2.5-2.5M3 12h13a2.5 2.5 0 1 1-2.5 2.5M3 16h7',
  humidity: 'M10 2.5S4.5 8.5 4.5 12a5.5 5.5 0 0 0 11 0c0-3.5-5.5-9.5-5.5-9.5z',
  rainChance: 'M6 3.5v4M10 2v5.5M14 3.5v4M4 11h12M7 14l-1 3M10 14l-1 3M13 14l-1 3',
  rainAmount: 'M5.5 9.5a4 4 0 0 1 8-1 3 3 0 0 1 .5 6h-8a3 3 0 0 1-.5-5zM7 17l-.7 1.5M10 17l-.7 1.5M13 17l-.7 1.5',
  visibility: 'M1.5 10S4.5 4.5 10 4.5 18.5 10 18.5 10 15.5 15.5 10 15.5 1.5 10 1.5 10z M10 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  pressure: 'M10 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14z M10 10l3.5-3',
  windDir: 'M3 17L17 3M17 3v6M17 3h-6',
  cloud: 'M6 15h8.5a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.6 1.3A3.2 3.2 0 0 0 6 15z',
  uv: 'M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z M10 1.5v2M10 16.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4',
  sunrise: 'M3 16h14M10 3v6M7 6l3-3 3 3M5.5 12.5a4.5 4.5 0 0 1 9 0',
  sunset: 'M3 16h14M10 9V3M7 6l3 3 3-3M5.5 12.5a4.5 4.5 0 0 1 9 0',
  air: 'M2 7h9a2.5 2.5 0 1 0-2.5-2.5M2 11h12a2.5 2.5 0 1 1-2.5 2.5M2 15h7a2 2 0 1 1-2 2',
} as const;

function icon(path: string): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', path);
  svg.appendChild(p);
  return svg;
}

/** 面板上的一格：圖示 + 標籤 + 數值。 */
interface Cell {
  key: string;
  label: string;
  iconPath: string;
  /** 回傳 [主要文字, 次要文字?]。次要文字用比較淡的樣式。 */
  value: (w: WeatherData) => [string, string?];
}

const CELLS: Cell[] = [
  { key: 'wind', label: '風速', iconPath: ICONS.wind, value: (w) => [`${Math.round(w.windSpeed)} km/h`] },
  { key: 'humidity', label: '濕度', iconPath: ICONS.humidity, value: (w) => [`${Math.round(w.humidity)}%`] },
  { key: 'pop', label: '降雨機率', iconPath: ICONS.rainChance, value: (w) => [`${Math.round(w.precipitationProbability)}%`] },
  { key: 'precip', label: '降雨量', iconPath: ICONS.rainAmount, value: (w) => [`${w.precipitation.toFixed(1).replace(/\.0$/, '')} mm`] },
  { key: 'vis', label: '能見度', iconPath: ICONS.visibility, value: (w) => [`${Math.round(w.visibility)} km`] },
  { key: 'pressure', label: '氣壓', iconPath: ICONS.pressure, value: (w) => [`${Math.round(w.pressure)} hPa`] },
  { key: 'windDir', label: '風向', iconPath: ICONS.windDir, value: (w) => [w.windDirection] },
  { key: 'cloud', label: '雲量', iconPath: ICONS.cloud, value: (w) => [`${Math.round(w.cloudCover)}%`] },
  { key: 'uv', label: '紫外線指數', iconPath: ICONS.uv, value: (w) => [`${Math.round(w.uvIndex)}`, w.uvLevel] },
  { key: 'sunrise', label: '日出', iconPath: ICONS.sunrise, value: (w) => [w.sunrise] },
  { key: 'sunset', label: '日落', iconPath: ICONS.sunset, value: (w) => [w.sunset] },
  { key: 'aqi', label: '空氣品質', iconPath: ICONS.air, value: (w) => (w.aqi === null ? ['—'] : [w.aqiLevel!, String(w.aqi)]) },
];

/**
 * 左上角的天氣面板。
 *
 * 抓取失敗不會影響森林動畫 —— 面板自己顯示錯誤狀態並定時重試。
 */
export function createWeatherPanel(scene: ForestScene): WeatherPanelHandle {
  const root = document.createElement('div');
  root.id = 'weather';
  root.setAttribute('aria-live', 'polite');

  // ---- 標題列 ----
  const place = document.createElement('div');
  place.className = 'wx-place';
  place.textContent = LOCATION.name;

  const head = document.createElement('div');
  head.className = 'wx-head';
  const temp = document.createElement('div');
  temp.className = 'wx-temp';
  const cond = document.createElement('div');
  cond.className = 'wx-cond';
  head.append(temp, cond);

  const feels = document.createElement('div');
  feels.className = 'wx-feels';

  // ---- 資料格 ----
  const grid = document.createElement('div');
  grid.className = 'wx-grid';
  const valueNodes = new Map<string, { main: HTMLElement; sub: HTMLElement }>();

  for (const cell of CELLS) {
    const item = document.createElement('div');
    item.className = 'wx-cell';

    const label = document.createElement('div');
    label.className = 'wx-label';
    label.append(icon(cell.iconPath), document.createTextNode(cell.label));

    const value = document.createElement('div');
    value.className = 'wx-value';
    const main = document.createElement('span');
    const sub = document.createElement('span');
    sub.className = 'wx-sub';
    value.append(main, sub);

    item.append(label, value);
    grid.appendChild(item);
    valueNodes.set(cell.key, { main, sub });
  }

  const status = document.createElement('div');
  status.className = 'wx-status';
  status.textContent = '載入中…';

  root.append(place, head, feels, grid, status);
  document.body.appendChild(root);

  // ---- 版面：對齊圖片而不是視窗 ----
  const layout = () => {
    const m = scene.getMetrics();
    // 圖片是正方形（contain），取短邊即可
    const size = Math.min(m.displayWidth, m.displayHeight);
    if (size <= 0) return;
    // 圖片在 canvas 裡是置中的
    const originX = (m.cssWidth - m.displayWidth) / 2;
    const originY = (m.cssHeight - m.displayHeight) / 2;
    const inset = size * LAYOUT.inset;

    root.style.left = `${Math.round(originX + inset)}px`;
    root.style.top = `${Math.round(originY + inset)}px`;
    root.style.width = `${Math.round(size * LAYOUT.width)}px`;
    root.style.fontSize = `${Math.max(size * LAYOUT.fontScale, LAYOUT.minFontPx).toFixed(2)}px`;
  };

  layout();
  const unsubscribeResize = scene.onResize(layout);

  // ---- 載入流程 ----
  let controller: AbortController | null = null;
  let timer = 0;
  let disposed = false;

  const render = (w: WeatherData) => {
    temp.textContent = `${Math.round(w.temperature)}°`;
    cond.textContent = w.condition;
    feels.textContent = `體感 ${Math.round(w.apparentTemperature)}°`;
    for (const cell of CELLS) {
      const [main, subText] = cell.value(w);
      const node = valueNodes.get(cell.key)!;
      node.main.textContent = main;
      node.sub.textContent = subText ?? '';
    }
    root.classList.add('wx-ready');
    status.textContent = `更新於 ${w.observedAt.toTimeString().slice(0, 5)}`;
    status.classList.remove('wx-error');
  };

  const schedule = (delay: number) => {
    if (disposed) return;
    if (timer !== 0) window.clearTimeout(timer);
    timer = window.setTimeout(load, delay);
  };

  async function load(): Promise<void> {
    if (disposed) return;
    controller?.abort();
    controller = new AbortController();
    try {
      render(await fetchWeather(controller.signal));
      schedule(REFRESH_MS);
    } catch (err) {
      if (disposed || (err instanceof DOMException && err.name === 'AbortError')) return;
      status.textContent = '天氣資料讀取失敗，稍後重試';
      status.classList.add('wx-error');
      console.warn('[forest-breeze] 天氣資料讀取失敗：', err);
      schedule(RETRY_MS);
    }
  }

  void load();

  return {
    dispose() {
      disposed = true;
      if (timer !== 0) window.clearTimeout(timer);
      controller?.abort();
      unsubscribeResize();
      root.remove();
    },
  };
}
