import { ForestScene } from './ForestScene';
import { createDebugPanel } from './DebugPanel';
import { createWeatherPanel } from './WeatherPanel';
import { createFallbackMask, loadMaskTexture, loadPhotoTexture, type LoadedTexture } from './textures';
import { ASSETS } from './config';
import { loadSavedConfig } from './settings';

const container = document.getElementById('app');
const status = document.getElementById('status');

if (!container || !status) {
  throw new Error('index.html 缺少 #app 或 #status 元素');
}

function assetUrl(file: string): string {
  return `${import.meta.env.BASE_URL}${file}`;
}

function showError(title: string, detail: string): void {
  status!.className = 'error';
  status!.innerHTML = '';
  const h = document.createElement('div');
  h.textContent = `⚠ ${title}`;
  const d = document.createElement('div');
  d.style.color = '#c9c9c9';
  d.style.marginTop = '6px';
  d.style.whiteSpace = 'pre-wrap';
  d.textContent = detail;
  status!.append(h, d);
}

async function boot(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. forest.jpg —— 沒有它就沒有畫面，載入失敗直接停止
  // -------------------------------------------------------------------------
  status!.textContent = `Loading ${ASSETS.forest} …`;

  let photo: LoadedTexture;
  try {
    photo = await loadPhotoTexture(assetUrl(ASSETS.forest));
  } catch {
    showError(
      `無法載入 ${ASSETS.forest}`,
      `請把高解析森林照片放在：\n  public/${ASSETS.forest}\n\n` +
        `dev server 會以 /${ASSETS.forest} 提供這個檔案。`,
    );
    return;
  }

  // -------------------------------------------------------------------------
  // 2. movement-mask.png —— 載入失敗時退化成「全黑 mask = 完全不動」，不讓頁面崩潰
  // -------------------------------------------------------------------------
  status!.textContent = `Loading ${ASSETS.mask} …`;

  const notes: string[] = [];
  let mask: LoadedTexture;
  try {
    mask = await loadMaskTexture(assetUrl(ASSETS.mask));
    if (mask.width !== photo.width || mask.height !== photo.height) {
      notes.push(
        `! mask 尺寸 ${mask.width}×${mask.height} 與照片 ${photo.width}×${photo.height} 不同`,
      );
    }
  } catch {
    mask = createFallbackMask();
    notes.push('! movement-mask.png 載入失敗，已改用全黑 mask（畫面靜止）');
    console.warn(
      `[forest-breeze] 找不到 public/${ASSETS.mask}，改用全黑 mask，畫面會維持靜止。`,
    );
  }

  // -------------------------------------------------------------------------
  // 3. 建立場景
  // -------------------------------------------------------------------------
  let scene: ForestScene;
  try {
    scene = new ForestScene(container!, photo, mask);
  } catch (err) {
    showError(
      'WebGL 初始化失敗',
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  // 套用上次按 Save 存下來的設定（如果有的話）。
  // 必須在建立 debug panel 之前，panel 的滑桿是從 scene 目前狀態初始化的。
  const saved = loadSavedConfig();
  if (saved) {
    scene.applyConfig(saved);
  }

  const metrics = scene.getMetrics();
  if (
    metrics.textureWidth > metrics.maxTextureSize ||
    metrics.textureHeight > metrics.maxTextureSize
  ) {
    notes.push(
      `! 圖片 ${metrics.textureWidth}px 超過 GPU 上限 ${metrics.maxTextureSize}px`,
    );
    console.error(
      `[forest-breeze] forest.jpg (${metrics.textureWidth}×${metrics.textureHeight}) ` +
        `超過此 GPU 的 MAX_TEXTURE_SIZE (${metrics.maxTextureSize})，無法上傳。`,
    );
  }

  const panel = createDebugPanel(scene, notes, saved !== null);
  // 天氣面板獨立運作：讀取失敗只會顯示錯誤狀態並重試，不影響森林動畫。
  const weather = createWeatherPanel();
  scene.start();

  status!.className = 'hidden';

  console.info(
    `[forest-breeze] source texture ${metrics.textureWidth}×${metrics.textureHeight} ` +
      `(mipmap level 0 = 原生解析度) | canvas buffer ${metrics.bufferWidth}×${metrics.bufferHeight} ` +
      `| dpr ${metrics.devicePixelRatio}`,
  );

  // HMR：換檔時銷毀舊場景，避免累積 RAF loop / resize listener / WebGL context
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      weather.dispose();
      panel.dispose();
      scene.dispose();
    });
  }
}

void boot();
