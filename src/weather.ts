/**
 * 台北市大安區的即時天氣。
 *
 * 資料來源：Open-Meteo（https://open-meteo.com/）
 *   - 免費、不需 API key。靜態網站放 key 等於公開，所以只能選免鑰的服務。
 *   - 有 CORS 標頭，可以直接從瀏覽器打。
 *   - 座標寫死，不使用 Geolocation —— 不需要向使用者要定位權限。
 */

/** 台北市大安區。 */
export const LOCATION = {
  name: '台北市 大安區',
  latitude: 25.0326,
  longitude: 121.5435,
  timezone: 'Asia/Taipei',
};

export interface WeatherData {
  /** 攝氏 */
  temperature: number;
  apparentTemperature: number;
  /** 天氣描述，例如「晴朗」 */
  condition: string;
  /** km/h */
  windSpeed: number;
  /** 例如「東南」 */
  windDirection: string;
  /** % */
  humidity: number;
  /** % */
  precipitationProbability: number;
  /** mm */
  precipitation: number;
  /** km */
  visibility: number;
  /** hPa */
  pressure: number;
  /** % */
  cloudCover: number;
  uvIndex: number;
  uvLevel: string;
  /** HH:MM */
  sunrise: string;
  sunset: string;
  aqi: number | null;
  aqiLevel: string | null;
  /** 這份資料的觀測時間 */
  observedAt: Date;
}

/** WMO weather code → 中文描述。 */
const CONDITIONS: Record<number, string> = {
  0: '晴朗',
  1: '大致晴朗',
  2: '局部多雲',
  3: '陰天',
  45: '有霧',
  48: '霧淞',
  51: '毛毛雨',
  53: '毛毛雨',
  55: '毛毛雨',
  56: '凍毛毛雨',
  57: '凍毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '凍雨',
  67: '凍雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '霰',
  80: '陣雨',
  81: '陣雨',
  82: '強陣雨',
  85: '陣雪',
  86: '陣雪',
  95: '雷雨',
  96: '雷雨伴冰雹',
  99: '雷雨伴冰雹',
};

const COMPASS = ['北', '東北', '東', '東南', '南', '西南', '西', '西北'];

function windDirectionLabel(degrees: number): string {
  // 每 45° 一段，+22.5 讓邊界落在區間中間
  const index = Math.round(((degrees % 360) + 360) % 360 / 45) % 8;
  return COMPASS[index];
}

function uvLevelLabel(uv: number): string {
  if (uv < 3) return '低';
  if (uv < 6) return '中等';
  if (uv < 8) return '高';
  if (uv < 11) return '過高';
  return '危險';
}

/** 美國 AQI 分級。 */
function aqiLevelLabel(aqi: number): string {
  if (aqi <= 50) return '良好';
  if (aqi <= 100) return '普通';
  if (aqi <= 150) return '敏感族群不健康';
  if (aqi <= 200) return '不健康';
  if (aqi <= 300) return '非常不健康';
  return '危害';
}

/** 從 ISO 時間字串取 HH:MM。Open-Meteo 已經回傳當地時間，不需要再換算。 */
function hhmm(iso: string): string {
  const t = iso.split('T')[1] ?? '';
  return t.slice(0, 5);
}

async function getJson(url: string, signal: AbortSignal): Promise<any> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * 抓取天氣。
 *
 * 分成兩個端點：
 *   - forecast     溫度、風、雲量、氣壓、能見度、紫外線、日出日落
 *   - air-quality  空氣品質
 *
 * 空氣品質失敗不影響主要資料 —— 天氣還是照常顯示，AQI 那一格留白。
 */
export async function fetchWeather(signal: AbortSignal): Promise<WeatherData> {
  const common = `latitude=${LOCATION.latitude}&longitude=${LOCATION.longitude}&timezone=${encodeURIComponent(LOCATION.timezone)}`;

  const forecastUrl =
    `https://api.open-meteo.com/v1/forecast?${common}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,' +
    'weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m' +
    // visibility / uv_index / precipitation_probability 只有 hourly 有，要自己對時間
    '&hourly=visibility,uv_index,precipitation_probability' +
    '&daily=sunrise,sunset&forecast_days=1';

  const airUrl =
    `https://air-quality-api.open-meteo.com/v1/air-quality?${common}&current=us_aqi`;

  // 空氣品質單獨處理，失敗不拖垮整個面板
  const [forecast, air] = await Promise.all([
    getJson(forecastUrl, signal),
    getJson(airUrl, signal).catch(() => null),
  ]);

  const cur = forecast.current;

  // hourly 陣列對到「目前這一小時」
  const times: string[] = forecast.hourly?.time ?? [];
  const currentHour = String(cur.time).slice(0, 13); // YYYY-MM-DDTHH
  let idx = times.findIndex((t) => t.startsWith(currentHour));
  if (idx < 0) idx = 0;

  const pick = (arr: unknown, fallback = 0): number => {
    const v = Array.isArray(arr) ? arr[idx] : undefined;
    return typeof v === 'number' ? v : fallback;
  };

  const uv = pick(forecast.hourly?.uv_index);
  const aqiRaw = air?.current?.us_aqi;
  const aqi = typeof aqiRaw === 'number' ? Math.round(aqiRaw) : null;

  return {
    temperature: cur.temperature_2m,
    apparentTemperature: cur.apparent_temperature,
    condition: CONDITIONS[cur.weather_code] ?? '—',
    windSpeed: cur.wind_speed_10m,
    windDirection: windDirectionLabel(cur.wind_direction_10m),
    humidity: cur.relative_humidity_2m,
    precipitationProbability: pick(forecast.hourly?.precipitation_probability),
    precipitation: cur.precipitation,
    // API 給的是公尺
    visibility: pick(forecast.hourly?.visibility) / 1000,
    pressure: cur.pressure_msl,
    cloudCover: cur.cloud_cover,
    uvIndex: uv,
    uvLevel: uvLevelLabel(uv),
    sunrise: hhmm(forecast.daily?.sunrise?.[0] ?? ''),
    sunset: hhmm(forecast.daily?.sunset?.[0] ?? ''),
    aqi,
    aqiLevel: aqi === null ? null : aqiLevelLabel(aqi),
    observedAt: new Date(cur.time),
  };
}
