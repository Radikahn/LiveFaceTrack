import type { AssetWithThumb, Mode, Permissions, ScreenSource } from '@shared/types';
import type { StageState } from '@shared/ipc';
import { openCalibration } from './calibrate';

const api = window.overlay;

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

const els = {
  root: document.documentElement,
  body: document.body,
  list: $<HTMLUListElement>('[data-list]'),
  empty: $('[data-empty]'),
  library: $('[data-library]'),
  count: $('[data-count]'),
  add: $<HTMLButtonElement>('[data-add]'),
  start: $<HTMLButtonElement>('[data-start]'),
  note: $('[data-note]'),
  screenPanel: $('[data-screen-panel]'),
  sources: $('[data-sources]'),
  overlayToggle: $<HTMLButtonElement>('[data-overlay-toggle]'),
};

type State = {
  mode: Mode;
  assets: AssetWithThumb[];
  sources: ScreenSource[];
  sourceId: string | null;
  overlayDesktop: boolean;
  running: boolean;
  runningMode: Mode | null;
  permissions: Permissions;
};

const state: State = {
  mode: 'camera',
  assets: [],
  sources: [],
  sourceId: null,
  overlayDesktop: false,
  running: false,
  runningMode: null,
  permissions: { camera: 'unknown', screen: 'unknown' },
};

/** Tiny signal helper in place of a framework: one render, driven by one state. */
function set(patch: Partial<State>): void {
  Object.assign(state, patch);
  render();
}

/* ------------------------------------------------------------------ render */

function render(): void {
  els.body.dataset.mode = state.running && state.runningMode ? state.runningMode : state.mode;

  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-mode-button]')) {
    btn.setAttribute('aria-selected', String(btn.dataset.modeButton === state.mode));
  }

  els.screenPanel.hidden = state.mode !== 'screen';
  els.overlayToggle.setAttribute('aria-pressed', String(state.overlayDesktop));

  renderList();
  renderSources();

  const enabled = state.assets.filter((a) => a.enabled).length;
  els.count.textContent = state.assets.length ? `${enabled}/${state.assets.length} on` : '';

  els.start.textContent = state.running ? 'Stop' : 'Start';
  els.start.dataset.running = String(state.running);
  els.start.disabled = !state.running && !canStart();

  renderNote();
}

function canStart(): boolean {
  if (state.assets.every((a) => !a.enabled)) return false;
  if (state.mode === 'screen') return Boolean(state.sourceId);
  return true;
}

function renderList(): void {
  const has = state.assets.length > 0;
  els.list.hidden = !has;
  els.empty.hidden = has;
  if (!has) {
    els.list.replaceChildren();
    return;
  }

  els.list.replaceChildren(
    ...state.assets.map((asset) => {
      const li = document.createElement('li');
      li.className = 'row';
      li.dataset.enabled = String(asset.enabled);
      li.innerHTML = `
        <span class="row__thumb">${asset.thumb ? `<img src="${asset.thumb}" alt="" />` : ''}</span>
        <span>
          <span class="row__name"></span>
          <span class="row__meta tabular">${asset.width}x${asset.height}</span>
        </span>
        <span class="row__actions">
          <button type="button" class="icon-button" data-calibrate title="Calibrate">
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
              <circle cx="7.5" cy="7.5" r="5" stroke="currentColor" stroke-width="1.3"/>
              <path d="M7.5 1v2M7.5 12v2M1 7.5h2M12 7.5h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
              <circle cx="7.5" cy="7.5" r="1.4" fill="currentColor"/>
            </svg>
          </button>
          <button type="button" class="icon-button" data-toggle aria-pressed="${asset.enabled}" title="${asset.enabled ? 'Disable' : 'Enable'}">
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
              <path d="M1.5 7.5S3.9 3.5 7.5 3.5s6 4 6 4-2.4 4-6 4-6-4-6-4Z" stroke="currentColor" stroke-width="1.3"/>
              <circle cx="7.5" cy="7.5" r="1.9" fill="currentColor"/>
            </svg>
          </button>
          <button type="button" class="icon-button" data-remove title="Remove">
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
              <path d="M4 4l7 7M11 4l-7 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
            </svg>
          </button>
        </span>`;
      // textContent, not innerHTML: the name comes from a filename.
      li.querySelector('.row__name')!.textContent = asset.name;
      li.querySelector('[data-toggle]')!.addEventListener('click', () => {
        void api.library.update({ id: asset.id, enabled: !asset.enabled });
      });
      li.querySelector('[data-calibrate]')!.addEventListener('click', async () => {
        const bytes = await api.library.bytes(asset.id);
        if (bytes) openCalibration(asset, bytes);
      });
      li.querySelector('[data-remove]')!.addEventListener('click', () => {
        void api.library.remove(asset.id);
      });
      return li;
    })
  );
}

function renderSources(): void {
  if (state.mode !== 'screen') return;
  els.sources.replaceChildren(
    ...state.sources.map((source) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'source';
      btn.setAttribute('aria-pressed', String(source.id === state.sourceId));
      btn.innerHTML = `<img src="${source.thumbnail}" alt="" /><span></span>`;
      btn.querySelector('span')!.textContent = source.name;
      btn.addEventListener('click', () => set({ sourceId: source.id }));
      return btn;
    })
  );
}

function renderNote(): void {
  const { permissions, mode } = state;
  if (mode === 'screen' && permissions.screen !== 'granted' && api.app.platform === 'darwin') {
    els.note.dataset.tone = 'warn';
    els.note.replaceChildren(
      document.createTextNode('Screen Recording is off. '),
      link('Open Settings', () => void api.capture.openScreenSettings()),
      document.createTextNode('. The grant resets whenever the app is re-signed.')
    );
    return;
  }
  if (mode === 'camera' && permissions.camera === 'denied') {
    els.note.dataset.tone = 'warn';
    els.note.textContent = 'Camera access is denied. Enable it in system settings.';
    return;
  }
  if (state.assets.length && state.assets.every((a) => !a.enabled)) {
    els.note.dataset.tone = 'warn';
    els.note.textContent = 'Turn on at least one overlay.';
    return;
  }
  delete els.note.dataset.tone;
  els.note.textContent = 'Nothing leaves this machine.';
}

function link(text: string, onClick: () => void): HTMLAnchorElement {
  const a = document.createElement('a');
  a.textContent = text;
  a.addEventListener('click', onClick);
  return a;
}

/* ------------------------------------------------------------------ events */

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-mode-button]')) {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.modeButton as Mode;
    if (mode === state.mode) return;
    set({ mode });
    if (mode === 'screen') void refreshSources();
    void refreshPermissions();
  });
}

els.overlayToggle.addEventListener('click', () => set({ overlayDesktop: !state.overlayDesktop }));

els.add.addEventListener('click', () => void api.library.import());

els.start.addEventListener('click', async () => {
  if (state.running) {
    await api.stage.stop();
    return;
  }
  if (state.mode === 'camera') await api.capture.requestCamera();
  const result = await api.stage.start({
    mode: state.mode,
    sourceId: state.mode === 'screen' ? (state.sourceId ?? undefined) : undefined,
    overlayDesktop: state.mode === 'screen' && state.overlayDesktop,
  });
  if (!result.ok) {
    els.note.dataset.tone = 'warn';
    els.note.textContent = result.error ?? 'Could not start.';
  }
});

/* The whole list is a drop target, not just the button. */
let dragDepth = 0;
const setDropping = (on: boolean) => {
  els.library.dataset.dropping = String(on);
};

window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (++dragDepth === 1) setDropping(true);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) {
    dragDepth = 0;
    setDropping(false);
  }
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  setDropping(false);
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (!files.length) return;
  // Bytes, not paths: main validates and re-encodes before anything is stored.
  const payload = await Promise.all(
    files.slice(0, 64).map(async (f) => ({ name: f.name, data: await f.arrayBuffer() }))
  );
  await api.library.importBuffers(payload);
});

api.library.onChanged((assets) => set({ assets }));
api.stage.onState((s: StageState) => set({ running: s.running, runningMode: s.mode }));
api.stage.onError((message) => {
  els.note.dataset.tone = 'warn';
  els.note.textContent = message;
});

/* -------------------------------------------------------------------- boot */

async function refreshSources(): Promise<void> {
  const sources = await api.capture.sources();
  set({ sources, sourceId: state.sourceId ?? sources[0]?.id ?? null });
}

async function refreshPermissions(): Promise<void> {
  set({ permissions: await api.capture.permissions() });
}

async function boot(): Promise<void> {
  els.root.dataset.nativeGlass = String(api.app.nativeGlass);
  set({ assets: await api.library.list() });
  await refreshPermissions();
}

void boot();
