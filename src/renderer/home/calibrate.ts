import type { AssetWithThumb } from '@shared/types';

const api = window.overlay;

/**
 * §5.5's calibration sheet. Ten seconds per asset, and every overlay sits right
 * forever after.
 *
 * The model is simple: drag two markers onto the PNG to say where the wearer's
 * eyes go. That gives `refEyeGap` (the distance between them, in the PNG's own
 * design space) and the anchor (their midpoint) in one gesture -- which is
 * exactly the pair the runtime transform needs. A schematic face sits behind
 * the art purely so the placement has something to read against.
 */

type Marker = { x: number; y: number };

export function openCalibration(asset: AssetWithThumb, bytes: ArrayBuffer): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));

  // Start from whatever the asset already has, so re-opening resumes.
  let right: Marker = {
    x: asset.anchorX - asset.refEyeGap / 2,
    y: asset.anchorY,
  };
  let left: Marker = { x: asset.anchorX + asset.refEyeGap / 2, y: asset.anchorY };
  let scale = asset.scale;
  let offsetY = asset.offsetY;
  let anchorMode = asset.anchorMode;

  const root = document.createElement('div');
  root.className = 'cal';
  root.innerHTML = `
    <div class="cal__sheet pane" role="dialog" aria-modal="true" aria-label="Calibrate overlay">
      <header class="cal__head">
        <span class="cal__title"></span>
        <button type="button" class="icon-button" data-close title="Close">
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
            <path d="M4 4l7 7M11 4l-7 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
        </button>
      </header>

      <div class="cal__stage" data-stage>
        <svg class="cal__face" viewBox="0 0 200 240" aria-hidden="true">
          <ellipse cx="100" cy="118" rx="62" ry="80" fill="none" stroke="currentColor" stroke-width="1.5"/>
          <ellipse cx="78" cy="104" rx="9" ry="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/>
          <ellipse cx="122" cy="104" rx="9" ry="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/>
          <path d="M100 110v22l-8 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M82 160q18 12 36 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <img class="cal__art" data-art alt="" />
        <button type="button" class="cal__marker" data-marker="right" aria-label="Right eye marker"></button>
        <button type="button" class="cal__marker" data-marker="left" aria-label="Left eye marker"></button>
        <svg class="cal__link" data-link aria-hidden="true"><line stroke="currentColor" stroke-width="1" stroke-dasharray="3 3"/></svg>
      </div>

      <p class="cal__hint">Drag the two dots onto the eyes of the art.</p>

      <label class="cal__field">
        <span>Size <em class="tabular" data-scale-out></em></span>
        <input type="range" data-scale min="0.2" max="3" step="0.01" />
      </label>
      <label class="cal__field">
        <span>Vertical nudge <em class="tabular" data-offset-out></em></span>
        <input type="range" data-offset min="-3" max="3" step="0.01" />
      </label>

      <div class="cal__field">
        <span>Anchor to</span>
        <div class="cal__seg" role="group">
          <button type="button" data-anchor="eyes">Eyes</button>
          <button type="button" data-anchor="nose">Nose</button>
        </div>
      </div>

      <footer class="cal__foot">
        <button type="button" class="cal__ghost" data-reset>Reset</button>
        <button type="button" class="start" data-save>Save</button>
      </footer>
    </div>`;

  const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  $('.cal__title').textContent = asset.name;
  const art = $<HTMLImageElement>('[data-art]');
  art.src = url;

  const stage = $<HTMLElement>('[data-stage]');
  const dots = {
    right: $<HTMLElement>('[data-marker="right"]'),
    left: $<HTMLElement>('[data-marker="left"]'),
  };
  const link = $<SVGSVGElement>('[data-link]');
  const scaleInput = $<HTMLInputElement>('[data-scale]');
  const offsetInput = $<HTMLInputElement>('[data-offset]');

  scaleInput.value = String(scale);
  offsetInput.value = String(offsetY);

  /** The art is letterboxed inside the stage; markers live in PNG pixels. */
  function artRect(): { x: number; y: number; w: number; h: number } {
    const s = stage.getBoundingClientRect();
    const k = Math.min(s.width / asset.width, s.height / asset.height);
    const w = asset.width * k;
    const h = asset.height * k;
    return { x: (s.width - w) / 2, y: (s.height - h) / 2, w, h };
  }

  function draw(): void {
    const r = artRect();
    const k = r.w / asset.width;
    for (const [name, marker] of [
      ['right', right],
      ['left', left],
    ] as const) {
      dots[name].style.left = `${r.x + marker.x * k}px`;
      dots[name].style.top = `${r.y + marker.y * k}px`;
    }
    const line = link.querySelector('line')!;
    line.setAttribute('x1', String(r.x + right.x * k));
    line.setAttribute('y1', String(r.y + right.y * k));
    line.setAttribute('x2', String(r.x + left.x * k));
    line.setAttribute('y2', String(r.y + left.y * k));

    art.style.transform = `scale(${scale}) translateY(${offsetY * eyeGap() * (r.w / asset.width) * 0.2}px)`;
    $('[data-scale-out]').textContent = `${scale.toFixed(2)}x`;
    $('[data-offset-out]').textContent = offsetY.toFixed(2);
    for (const btn of root.querySelectorAll<HTMLButtonElement>('[data-anchor]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.anchor === anchorMode));
    }
  }

  const eyeGap = () => Math.hypot(left.x - right.x, left.y - right.y);

  function drag(name: 'right' | 'left', event: PointerEvent): void {
    event.preventDefault();
    const dot = dots[name];
    dot.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const r = artRect();
      const s = stage.getBoundingClientRect();
      const k = r.w / asset.width;
      const px = (e.clientX - s.left - r.x) / k;
      const py = (e.clientY - s.top - r.y) / k;
      const clamped = {
        x: Math.max(0, Math.min(asset.width, px)),
        y: Math.max(0, Math.min(asset.height, py)),
      };
      if (name === 'right') right = clamped;
      else left = clamped;
      draw();
    };
    const up = () => {
      dot.releasePointerCapture(event.pointerId);
      dot.removeEventListener('pointermove', move);
      dot.removeEventListener('pointerup', up);
    };
    dot.addEventListener('pointermove', move);
    dot.addEventListener('pointerup', up);
  }

  dots.right.addEventListener('pointerdown', (e) => drag('right', e));
  dots.left.addEventListener('pointerdown', (e) => drag('left', e));
  scaleInput.addEventListener('input', () => {
    scale = Number(scaleInput.value);
    draw();
  });
  offsetInput.addEventListener('input', () => {
    offsetY = Number(offsetInput.value);
    draw();
  });
  for (const btn of root.querySelectorAll<HTMLButtonElement>('[data-anchor]')) {
    btn.addEventListener('click', () => {
      anchorMode = btn.dataset.anchor as 'eyes' | 'nose';
      draw();
    });
  }

  $('[data-reset]').addEventListener('click', () => {
    right = { x: asset.width * 0.29, y: asset.height / 2 };
    left = { x: asset.width * 0.71, y: asset.height / 2 };
    scale = 1;
    offsetY = 0;
    scaleInput.value = '1';
    offsetInput.value = '0';
    draw();
  });

  function close(): void {
    URL.revokeObjectURL(url);
    window.removeEventListener('resize', draw);
    document.removeEventListener('keydown', onKey);
    root.remove();
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };

  $('[data-close]').addEventListener('click', close);
  root.addEventListener('click', (e) => {
    if (e.target === root) close();
  });
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', draw);

  $('[data-save]').addEventListener('click', async () => {
    const gap = eyeGap();
    await api.library.update({
      id: asset.id,
      // Guard against both markers landing on the same pixel, which would make
      // the runtime scale divide by ~0 and blow the PNG up to infinity.
      refEyeGap: Math.max(gap, 1),
      // The anchor is the marker midpoint regardless of mode; `anchorMode`
      // only decides which facial keypoint that midpoint tracks at runtime.
      anchorX: (right.x + left.x) / 2,
      anchorY: (right.y + left.y) / 2,
      offsetY,
      scale,
      anchorMode,
    });
    close();
  });

  document.body.appendChild(root);
  if (art.complete) draw();
  else art.addEventListener('load', draw, { once: true });
}
