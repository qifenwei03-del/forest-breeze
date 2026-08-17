import type { ForestScene } from './ForestScene';
import { DEFAULT_CONFIG, REFERENCE_WIND_STRENGTH, type MovementMode } from './config';
import { clearSavedConfig, saveConfig, toConfigSnippet } from './settings';

interface SliderSpec {
  key:
    | 'windStrength'
    | 'windDirection'
    | 'animationSpeed'
    | 'movementScale'
    | 'fogStrength'
    | 'fogSpeed';
  label: string;
  min: number;
  max: number;
  step: number;
  suffix: string;
  decimals: number;
  apply: (scene: ForestScene, value: number) => void;
}

const SLIDERS: SliderSpec[] = [
  {
    key: 'windStrength',
    label: 'Wind Strength',
    min: 0,
    max: 1,
    step: 0.01,
    suffix: '',
    decimals: 2,
    apply: (s, v) => s.setWindStrength(v),
  },
  {
    key: 'windDirection',
    label: 'Wind Direction',
    min: 0,
    max: 360,
    step: 1,
    suffix: '°',
    decimals: 0,
    apply: (s, v) => s.setWindDirection(v),
  },
  {
    key: 'animationSpeed',
    label: 'Animation Speed',
    min: 0.1,
    max: 2,
    step: 0.01,
    suffix: '×',
    decimals: 2,
    apply: (s, v) => s.setAnimationSpeed(v),
  },
  {
    key: 'movementScale',
    label: 'Movement Scale',
    min: 0,
    max: 2,
    step: 0.01,
    suffix: '×',
    decimals: 2,
    apply: (s, v) => s.setMovementScale(v),
  },
  {
    key: 'fogStrength',
    label: 'Fog Strength',
    min: 0,
    max: 0.5,
    step: 0.005,
    suffix: '',
    decimals: 3,
    apply: (s, v) => s.setFogStrength(v),
  },
  {
    key: 'fogSpeed',
    label: 'Fog Speed',
    min: 0,
    max: 8,
    step: 0.1,
    suffix: '×',
    decimals: 2,
    apply: (s, v) => s.setFogSpeed(v),
  },
];

export interface DebugPanelHandle {
  /** 重新讀取 scene 的解析度資訊並更新顯示。 */
  refresh(): void;
  dispose(): void;
}

/** 切換面板顯示的按鍵。 */
const TOGGLE_KEY = 'e';

export function createDebugPanel(
  scene: ForestScene,
  notes: string[],
  savedOnLoad = false,
): DebugPanelHandle {
  const root = document.createElement('div');
  root.id = 'debug';
  // 預設隱藏，按 E 才顯示。
  root.classList.add('panel-hidden');

  const head = document.createElement('div');
  head.className = 'dbg-head';
  const headTitle = document.createElement('span');
  headTitle.textContent = 'DEBUG';
  const headToggle = document.createElement('span');
  headToggle.textContent = '−';
  head.append(headTitle, headToggle);

  const body = document.createElement('div');
  body.className = 'dbg-body';

  head.addEventListener('click', () => {
    const collapsed = root.classList.toggle('collapsed');
    headToggle.textContent = collapsed ? '+' : '−';
  });

  // ----- sliders -----
  const inputs = new Map<SliderSpec['key'], HTMLInputElement>();
  const readouts = new Map<SliderSpec['key'], HTMLElement>();

  for (const spec of SLIDERS) {
    const row = document.createElement('div');
    row.className = 'row';

    const label = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = spec.label;
    const value = document.createElement('b');
    label.append(name, value);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    // 從 scene 目前的狀態初始化，而不是硬讀 DEFAULT_CONFIG ——
    // 這樣 main.ts 先套用過的「已儲存設定」才會正確反映在滑桿上。
    input.value = String(scene.getConfig()[spec.key]);

    const render = () => {
      const v = Number(input.value);
      value.textContent = v.toFixed(spec.decimals) + spec.suffix;
    };
    render();

    input.addEventListener('input', () => {
      spec.apply(scene, Number(input.value));
      render();
      refresh();
    });

    row.append(label, input);
    body.appendChild(row);

    inputs.set(spec.key, input);
    readouts.set(spec.key, value);
  }

  // ----- movement mode -----
  const modeRow = document.createElement('div');
  modeRow.className = 'row';
  const modeLabel = document.createElement('label');
  const modeName = document.createElement('span');
  modeName.textContent = 'Movement Mode';
  modeLabel.appendChild(modeName);

  const modeSelect = document.createElement('select');
  for (const mode of ['SIMPLE', 'ADVANCED'] as const) {
    const option = document.createElement('option');
    option.value = mode;
    option.textContent = mode;
    modeSelect.appendChild(option);
  }
  modeSelect.value = scene.getConfig().movementMode;
  modeSelect.addEventListener('change', () => {
    scene.setMovementMode(modeSelect.value as MovementMode);
  });

  modeRow.append(modeLabel, modeSelect);
  body.appendChild(modeRow);

  // ----- mask on/off -----
  const checks = document.createElement('div');
  checks.className = 'checks';
  const maskInput = document.createElement('input');
  maskInput.type = 'checkbox';
  maskInput.id = 'dbg-mask';
  maskInput.checked = scene.getConfig().maskEnabled;
  const maskLabel = document.createElement('label');
  maskLabel.htmlFor = 'dbg-mask';
  maskLabel.textContent = maskInput.checked ? 'Mask ON' : 'Mask OFF';
  maskInput.addEventListener('change', () => {
    scene.setMaskEnabled(maskInput.checked);
    maskLabel.textContent = maskInput.checked ? 'Mask ON' : 'Mask OFF';
  });
  checks.append(maskInput, maskLabel);
  body.appendChild(checks);

  // ----- save / pause / reset -----
  const buttons = document.createElement('div');
  buttons.className = 'buttons';

  // 按鈕短暫顯示結果訊息後復原。timer 記下來，dispose 時要清掉。
  let flashTimer = 0;
  const flash = (btn: HTMLButtonElement, message: string, restore: string) => {
    if (flashTimer !== 0) window.clearTimeout(flashTimer);
    btn.textContent = message;
    flashTimer = window.setTimeout(() => {
      btn.textContent = restore;
      flashTimer = 0;
    }, 1400);
  };

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  saveBtn.title = '把目前滑桿數值存進 localStorage，並複製 config.ts 片段到剪貼簿';
  saveBtn.addEventListener('click', () => {
    const config = scene.getConfig();
    const stored = saveConfig(config);
    const snippet = toConfigSnippet(config);

    // 順便把可以直接貼回 config.ts 的片段複製到剪貼簿。
    // 剪貼簿可能因為權限或焦點而失敗，失敗不影響 localStorage 已經存好這件事。
    void navigator.clipboard?.writeText(snippet).catch(() => {
      console.info('[forest-breeze] 剪貼簿不可用，以下是設定片段：\n' + snippet);
    });
    console.info('[forest-breeze] 已儲存設定：\n' + snippet);

    flash(saveBtn, stored ? 'Saved ✓' : 'No storage', 'Save');
    savedNote.textContent = stored
      ? '已儲存：重新整理會自動套用'
      : '! localStorage 不可用，設定沒有存下來';
    savedNote.className = stored ? 'saved-note' : 'saved-note warn';
  });

  const pauseBtn = document.createElement('button');
  pauseBtn.textContent = 'Pause';
  pauseBtn.addEventListener('click', () => {
    const paused = !scene.getConfig().paused;
    scene.setPaused(paused);
    pauseBtn.textContent = paused ? 'Play' : 'Pause';
  });

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.title = '回到 config.ts 的預設值，並清除已儲存的設定';
  resetBtn.addEventListener('click', () => {
    // 同時清掉 localStorage，否則「Reset 之後重新整理又跑回舊的儲存值」會很莫名。
    clearSavedConfig();
    scene.reset();
    for (const spec of SLIDERS) {
      const input = inputs.get(spec.key)!;
      input.value = String(DEFAULT_CONFIG[spec.key]);
      readouts.get(spec.key)!.textContent =
        Number(input.value).toFixed(spec.decimals) + spec.suffix;
    }
    maskInput.checked = DEFAULT_CONFIG.maskEnabled;
    maskLabel.textContent = DEFAULT_CONFIG.maskEnabled ? 'Mask ON' : 'Mask OFF';
    modeSelect.value = DEFAULT_CONFIG.movementMode;
    pauseBtn.textContent = 'Pause';
    savedNote.textContent = '已清除儲存的設定';
    savedNote.className = 'saved-note';
    refresh();
  });

  buttons.append(saveBtn, pauseBtn, resetBtn);
  body.appendChild(buttons);

  const savedNote = document.createElement('div');
  savedNote.className = 'saved-note';
  savedNote.textContent = savedOnLoad ? '已套用儲存的設定' : '';
  body.appendChild(savedNote);

  // ----- resolution info -----
  const info = document.createElement('div');
  info.className = 'info';

  const infoRows = new Map<string, HTMLElement>();
  const infoKeys = [
    'Source texture',
    'Mask texture',
    'Canvas CSS',
    'Canvas internal',
    'Image on screen',
    'Image rendered at',
    'Texel sampling',
    'devicePixelRatio',
    'Render pixelRatio',
    'GPU max texture',
    'Max disp. GRAY',
    'Max disp. BLACK',
  ];
  for (const key of infoKeys) {
    const row = document.createElement('div');
    const k = document.createElement('em');
    k.style.fontStyle = 'normal';
    k.textContent = key;
    const v = document.createElement('span');
    row.append(k, v);
    info.appendChild(row);
    infoRows.set(key, v);
  }

  for (const note of notes) {
    const n = document.createElement('div');
    n.className = 'warn';
    n.style.display = 'block';
    n.textContent = note;
    info.appendChild(n);
  }

  body.appendChild(info);

  const refresh = () => {
    const m = scene.getMetrics();
    infoRows.get('Source texture')!.textContent = `${m.textureWidth} × ${m.textureHeight}`;
    infoRows.get('Mask texture')!.textContent = `${m.maskWidth} × ${m.maskHeight}`;
    infoRows.get('Canvas CSS')!.textContent = `${m.cssWidth} × ${m.cssHeight}`;
    infoRows.get('Canvas internal')!.textContent = `${m.bufferWidth} × ${m.bufferHeight}`;
    infoRows.get('Image on screen')!.textContent = `${m.displayWidth} × ${m.displayHeight}`;
    infoRows.get('Image rendered at')!.textContent = `${m.renderedImageWidth} px`;

    // >= 1 代表原生 2496 完全用得上；< 1 代表輸出端正在縮小、細節會掉。
    const sampling = infoRows.get('Texel sampling')!;
    sampling.textContent = `${m.samplingRatio.toFixed(2)}×`;
    sampling.style.color = m.samplingRatio >= 0.999 ? '#7fd48a' : '#ffb266';
    infoRows.get('devicePixelRatio')!.textContent = m.devicePixelRatio.toFixed(2);
    infoRows.get('Render pixelRatio')!.textContent = m.pixelRatio.toFixed(2);
    infoRows.get('GPU max texture')!.textContent = String(m.maxTextureSize);
    infoRows.get('Max disp. GRAY')!.textContent = `${m.effectiveMidPx.toFixed(2)} px`;
    infoRows.get('Max disp. BLACK')!.textContent = `${m.effectiveStrongPx.toFixed(2)} px`;
  };

  refresh();

  root.append(head, body);
  document.body.appendChild(root);

  // 不自己掛 window resize listener：直接接 ForestScene 的 resize 通知，
  // 保證 listener 只有一份，也保證顯示的數字和實際 canvas 尺寸同步。
  scene.onResized = refresh;

  // ----- 按 E 顯示／隱藏面板 -----
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() !== TOGGLE_KEY) return;
    // 讓 Ctrl+E / Cmd+E 之類的瀏覽器快捷鍵照常運作
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // 焦點在輸入元件時不攔截（滑桿本身用方向鍵操作，不受影響）
    const target = event.target as HTMLElement | null;
    if (target?.isContentEditable) return;
    const tag = target?.tagName;
    if (tag === 'INPUT' && (target as HTMLInputElement).type === 'text') return;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return;

    event.preventDefault();
    const nowHidden = root.classList.toggle('panel-hidden');
    // 從隱藏變成顯示時補一次數值，隱藏期間的 resize 才不會留下舊資料
    if (!nowHidden) refresh();
  };
  window.addEventListener('keydown', onKeyDown);

  return {
    refresh,
    dispose() {
      if (flashTimer !== 0) window.clearTimeout(flashTimer);
      window.removeEventListener('keydown', onKeyDown);
      scene.onResized = null;
      root.remove();
    },
  };
}

/** 給 README / console 用的說明字串，避免魔術數字散落各處。 */
export const AMPLITUDE_REFERENCE_NOTE =
  `位移像素數是在 windStrength = ${REFERENCE_WIND_STRENGTH} 時校準的；` +
  `實際位移 = 基準值 × (windStrength / ${REFERENCE_WIND_STRENGTH}) × movementScale。`;
