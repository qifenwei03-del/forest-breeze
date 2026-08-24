import type { ForestScene } from './ForestScene';
import type { WeatherPanelHandle } from './WeatherPanel';
import { GRID, MAX_AMP, MotionField } from './motionField';

/**
 * 可視化的 motion field 編輯器。按 A 進入／離開。
 *
 * 疊在圖片上的 canvas：
 *   - 每一格畫一支箭頭，方向 = 該區的風向，長度與顏色 = 振幅倍率
 *   - 拖曳 = 筆刷，滑動的方向就是塗上去的風向（所見即所得）
 *   - 不在編輯模式時 pointer-events: none，完全不影響瀏覽
 *
 * 座標：canvas 與圖片對齊（左上為原點）。
 * 螢幕 +y 朝下，field 存的是 UV 空間（+y 朝上），所以讀寫時 y 要取負號。
 */

const TOGGLE_KEY = 'a';

/** 筆刷預設值。radius 是相對圖片邊長的比例。 */
const BRUSH = {
  radius: 0.12,
  minRadius: 0.03,
  maxRadius: 0.4,
  amp: 1.0,
  /** 滑鼠位移小於這個量（相對圖片邊長）就不更新方向，只塗振幅 */
  minDragForDirection: 0.004,
};

export interface MotionFieldEditorHandle {
  dispose(): void;
}

export function createMotionFieldEditor(
  scene: ForestScene,
  weather?: WeatherPanelHandle,
): MotionFieldEditorHandle {
  const field = scene.motionField;

  // 開場：先用存檔；沒有存檔就用目前的全域風向鋪平
  //（鋪平後的行為與「沒有 field」逐像素相同，所以啟用它不會改變畫面）
  const hadSaved = field.load();
  if (!hadSaved) field.fill(scene.getConfig().windDirection, 1);
  scene.setMotionFieldEnabled(true);

  const canvas = document.createElement('canvas');
  canvas.id = 'mf-canvas';
  const ctx = canvas.getContext('2d')!;

  const panel = document.createElement('div');
  panel.id = 'mf-panel';

  document.body.append(canvas, panel);

  let active = false;
  let brushRadius = BRUSH.radius;
  let brushAmp = BRUSH.amp;
  /** 圖片在畫面上的矩形（CSS px） */
  let rect = { x: 0, y: 0, size: 1 };
  let pointer: { x: number; y: number } | null = null;
  let painting = false;
  /** 平滑後的滑鼠速度，用來決定塗上的方向 */
  const vel = { x: 0, y: 0 };
  let last: { x: number; y: number } | null = null;

  // ------------------------------------------------------------- 版面
  const layout = () => {
    const m = scene.getMetrics();
    const size = Math.min(m.displayWidth, m.displayHeight);
    if (size <= 0) return;
    rect = {
      x: (m.cssWidth - m.displayWidth) / 2,
      y: (m.cssHeight - m.displayHeight) / 2,
      size,
    };
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.left = rect.x + 'px';
    canvas.style.top = rect.y + 'px';
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  };

  // ------------------------------------------------------------- 繪製
  /** 0 = 灰（不動）、1 = 綠、2 = 橘 */
  const ampColor = (amp: number) => {
    const t = Math.min(1, amp / MAX_AMP);
    const hue = 150 - t * 130;
    const sat = 20 + t * 70;
    return 'hsl(' + hue.toFixed(0) + ', ' + sat.toFixed(0) + '%, 62%)';
  };

  const draw = () => {
    const S = rect.size;
    ctx.clearRect(0, 0, S, S);
    if (!active) return;

    const cell = S / GRID;

    // 格線
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    for (let i = 1; i < GRID; i++) {
      ctx.moveTo(i * cell, 0);
      ctx.lineTo(i * cell, S);
      ctx.moveTo(0, i * cell);
      ctx.lineTo(S, i * cell);
    }
    ctx.stroke();

    // 箭頭
    const maxLen = cell * 0.42;
    ctx.lineCap = 'round';
    for (let row = 0; row < GRID; row++) {
      for (let col = 0; col < GRID; col++) {
        const c = field.cells[row][col];
        const cx = (col + 0.5) * cell;
        const cy = (row + 0.5) * cell;
        const len = maxLen * (0.1 + 0.9 * Math.min(1, c.amp / MAX_AMP));
        // UV +y 朝上 → 螢幕 y 取負號
        const dx = c.x * len;
        const dy = -c.y * len;
        const color = ampColor(c.amp);

        const a = Math.atan2(dy, dx);
        const h = Math.max(3.5, len * 0.34);
        const headL = cx + dx - h * Math.cos(a - 0.42);
        const headLY = cy + dy - h * Math.sin(a - 0.42);
        const headR = cx + dx - h * Math.cos(a + 0.42);
        const headRY = cy + dy - h * Math.sin(a + 0.42);

        const strokeArrow = () => {
          ctx.beginPath();
          ctx.moveTo(cx - dx, cy - dy);
          ctx.lineTo(cx + dx, cy + dy);
          ctx.stroke();
        };
        const fillHead = () => {
          ctx.beginPath();
          ctx.moveTo(cx + dx, cy + dy);
          ctx.lineTo(headL, headLY);
          ctx.lineTo(headR, headRY);
          ctx.closePath();
          ctx.fill();
        };

        // 深色描邊：森林很亮又很雜，純色箭頭在上面幾乎看不到
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.lineWidth = 4;
        strokeArrow();
        ctx.lineWidth = 2.6;
        fillHead();

        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1.8;
        strokeArrow();
        fillHead();

        // 振幅接近 0 的格子標一個點，免得誤認成「箭頭只是很短」
        if (c.amp < 0.04) {
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.beginPath();
          ctx.arc(cx, cy, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // 筆刷範圍
    if (pointer) {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(pointer.x, pointer.y, brushRadius * S, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.beginPath();
      ctx.arc(pointer.x, pointer.y, 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  };

  // ------------------------------------------------------------- 面板
  const info = document.createElement('div');
  info.className = 'mf-info';

  const mkSlider = (
    label: string,
    min: number,
    max: number,
    step: number,
    value: number,
    fmt: (v: number) => string,
    onInput: (v: number) => void,
  ) => {
    const row = document.createElement('div');
    row.className = 'mf-row';
    const lab = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = label;
    const out = document.createElement('b');
    out.textContent = fmt(value);
    lab.append(name, out);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      out.textContent = fmt(v);
      onInput(v);
      draw();
    });
    row.append(lab, input);
    return row;
  };

  const title = document.createElement('div');
  title.className = 'mf-title';
  title.textContent = 'MOTION FIELD';

  const hint = document.createElement('div');
  hint.className = 'mf-hint';
  hint.textContent = '在圖上拖曳，滑動方向就是塗上的風向';

  const radiusRow = mkSlider(
    '筆刷大小', BRUSH.minRadius, BRUSH.maxRadius, 0.005, brushRadius,
    (v) => Math.round(v * 100) + '%',
    (v) => { brushRadius = v; },
  );
  const ampRow = mkSlider(
    '筆刷振幅', 0, MAX_AMP, 0.05, brushAmp,
    (v) => v.toFixed(2) + '×',
    (v) => { brushAmp = v; },
  );

  let flashTimer = 0;
  const flash = (btn: HTMLButtonElement, msg: string, restore: string) => {
    if (flashTimer !== 0) window.clearTimeout(flashTimer);
    btn.textContent = msg;
    flashTimer = window.setTimeout(() => {
      btn.textContent = restore;
      flashTimer = 0;
    }, 1400);
  };

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  saveBtn.title = '存進 localStorage，並複製 JSON 到剪貼簿';
  saveBtn.addEventListener('click', () => {
    const ok = field.save();
    const json = JSON.stringify(field.toJSON());
    void navigator.clipboard?.writeText(json).catch(() => {
      console.info('[forest-breeze] 剪貼簿不可用，motion field JSON：\n' + json);
    });
    console.info('[forest-breeze] motion field JSON：\n' + json);
    flash(saveBtn, ok ? 'Saved ✓' : 'No storage', 'Save');
  });

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.title = '整個場鋪平成目前的 Wind Direction，並清除存檔';
  resetBtn.addEventListener('click', () => {
    MotionField.clearSaved();
    field.fill(scene.getConfig().windDirection, 1);
    scene.markMotionFieldDirty();
    draw();
    flash(resetBtn, 'Reset ✓', 'Reset');
  });

  const buttons = document.createElement('div');
  buttons.className = 'mf-buttons';
  buttons.append(saveBtn, resetBtn);

  const onLabel = document.createElement('label');
  onLabel.className = 'mf-check';
  const onInput = document.createElement('input');
  onInput.type = 'checkbox';
  onInput.checked = true;
  onInput.addEventListener('change', () => {
    scene.setMotionFieldEnabled(onInput.checked);
  });
  onLabel.append(onInput, document.createTextNode('Field ON'));

  // 天氣面板開關。狀態由 WeatherPanel 自己存進 localStorage，跨重整保留。
  const wxLabel = document.createElement('label');
  wxLabel.className = 'mf-check';
  const wxInput = document.createElement('input');
  wxInput.type = 'checkbox';
  wxInput.checked = weather ? weather.isVisible() : false;
  wxInput.disabled = !weather;
  wxInput.addEventListener('change', () => {
    weather?.setVisible(wxInput.checked);
  });
  wxLabel.append(wxInput, document.createTextNode('天氣面板'));

  panel.append(title, hint, radiusRow, ampRow, buttons, onLabel, wxLabel, info);

  const updateInfo = () => {
    if (!pointer) {
      info.textContent = 'A 離開編輯模式';
      return;
    }
    const u = pointer.x / rect.size;
    const v = pointer.y / rect.size;
    const c = field.sample(u, v);
    const deg = ((Math.atan2(c.y, c.x) * 180) / Math.PI + 360) % 360;
    info.textContent =
      '游標 ' + Math.round(u * 100) + ',' + Math.round(v * 100) + '%' +
      '　方向 ' + deg.toFixed(0) + '°' +
      '　振幅 ' + c.amp.toFixed(2) + '×';
  };

  // ------------------------------------------------------------- 互動
  const toCanvas = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const applyPaint = (p: { x: number; y: number }) => {
    const S = rect.size;
    const speed = Math.hypot(vel.x, vel.y) / S;
    const useDir = speed > BRUSH.minDragForDirection;
    // 螢幕 y 朝下、UV y 朝上 → 取負號
    field.paint(
      p.x / S, p.y / S, brushRadius,
      useDir ? vel.x : 0,
      useDir ? -vel.y : 0,
      brushAmp,
    );
    scene.markMotionFieldDirty();
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!active) return;
    canvas.setPointerCapture(e.pointerId);
    painting = true;
    const p = toCanvas(e);
    pointer = p;
    last = p;
    vel.x = 0;
    vel.y = 0;
    applyPaint(p);
    updateInfo();
    draw();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!active) return;
    const p = toCanvas(e);
    if (last) {
      // 平滑速度：單一 move 事件的位移太抖，方向會跳動
      vel.x = vel.x * 0.65 + (p.x - last.x) * 0.35;
      vel.y = vel.y * 0.65 + (p.y - last.y) * 0.35;
    }
    last = p;
    pointer = p;
    if (painting) applyPaint(p);
    updateInfo();
    draw();
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!painting) return;
    painting = false;
    last = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    // 每一筆結束就存，避免重整後白畫
    field.save();
  };

  const onPointerLeave = () => {
    pointer = null;
    updateInfo();
    draw();
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);

  const setActive = (next: boolean) => {
    active = next;
    canvas.classList.toggle('mf-active', active);
    panel.classList.toggle('mf-active', active);
    if (!active) {
      pointer = null;
      painting = false;
      last = null;
    }
    updateInfo();
    draw();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() !== TOGGLE_KEY) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.isContentEditable) return;
    const tag = target?.tagName;
    if (tag === 'INPUT' && (target as HTMLInputElement).type === 'text') return;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return;
    event.preventDefault();
    setActive(!active);
  };
  window.addEventListener('keydown', onKeyDown);

  layout();
  const unsubscribeResize = scene.onResize(layout);
  setActive(false);

  return {
    dispose() {
      if (flashTimer !== 0) window.clearTimeout(flashTimer);
      window.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      unsubscribeResize();
      canvas.remove();
      panel.remove();
    },
  };
}
