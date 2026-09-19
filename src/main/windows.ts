import { BrowserWindow, screen, type BrowserWindowConstructorOptions } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { pageUrl } from './protocol';
import type { StageConfig } from '@shared/types';

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

/**
 * `backgroundMaterial` needs Windows 11 build 22621+. On anything older it
 * silently no-ops, which is why the renderer is told about it: the CSS falls
 * back to a near-opaque tint rather than a grey box (§6).
 */
export const nativeGlass: boolean = isMac || (isWin && winBuild() >= 22621);

function winBuild(): number {
  // os.release() on Windows looks like "10.0.22631"
  return Number(os.release().split('.')[2] ?? 0) || 0;
}

const preload = () => path.join(__dirname, 'preload.js');

/** §9: no Node in the renderer, no ipcRenderer handle, everything through preload. */
const secureWebPreferences = () => ({
  preload: preload(),
  // The preload is sandboxed and cannot read `nativeGlass` itself, so hand it
  // over as an argv flag; the CSS fallback keys off it (§6).
  additionalArguments: nativeGlass ? ['--native-glass'] : [],
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  spellcheck: false,
});

/**
 * Trap (§6): on Windows, `backgroundMaterial` and `transparent: true` are
 * mutually exclusive. Set both and acrylic is silently disabled, leaving a
 * black rectangle. So the configs must branch rather than merge.
 */
function glassOptions(): BrowserWindowConstructorOptions {
  if (isMac) {
    return {
      transparent: true,
      vibrancy: 'under-window',
      visualEffectState: 'active',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 18 },
      backgroundColor: '#00000000',
    };
  }
  if (isWin && nativeGlass) {
    return {
      transparent: false,
      backgroundMaterial: 'acrylic',
      backgroundColor: '#00000000',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: '#F2F4F8', height: 38 },
    };
  }
  // Windows 10 and everything else: opaque, CSS carries the whole look.
  return {
    transparent: false,
    backgroundColor: '#0E1116',
    titleBarStyle: isWin ? 'hidden' : 'default',
    ...(isWin
      ? { titleBarOverlay: { color: '#00000000', symbolColor: '#F2F4F8', height: 38 } }
      : {}),
  };
}

export function createHomeWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 400,
    height: 620,
    minWidth: 400,
    maxWidth: 400,
    minHeight: 420,
    show: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    webPreferences: secureWebPreferences(),
    ...glassOptions(),
  });

  win.once('ready-to-show', () => win.show());
  void win.loadURL(pageUrl('home'));
  return win;
}

export function createStageWindow(cfg: StageConfig): BrowserWindow {
  const overlay = cfg.mode === 'screen' && cfg.overlayDesktop;
  const win = overlay ? desktopOverlayWindow() : cameraStageWindow(cfg);

  // §4: the overlay draws on the desktop and the capture captures the desktop.
  // Without exclusion we capture our own output, detect the faces we just drew,
  // and recurse into garbage within three frames. This maps to
  // NSWindowSharingNone / WDA_EXCLUDEFROMCAPTURE, and must be set before the
  // window first shows.
  win.setContentProtection(true);

  if (overlay) {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Clicks pass straight through; `forward` keeps move events flowing so the
    // renderer can still see where the pointer is.
    win.setIgnoreMouseEvents(true, { forward: true });
  }

  win.once('ready-to-show', () => {
    win.show();
    if (overlay) win.setIgnoreMouseEvents(true, { forward: true });
  });
  void win.loadURL(pageUrl('stage'));
  return win;
}

function cameraStageWindow(cfg: StageConfig): BrowserWindow {
  return new BrowserWindow({
    width: cfg.mode === 'camera' ? 960 : 1280,
    height: cfg.mode === 'camera' ? 720 : 760,
    minWidth: 480,
    minHeight: 360,
    show: false,
    backgroundColor: '#07090C',
    title: 'Overlay',
    webPreferences: {
      ...secureWebPreferences(),
      // Chromium throttles timers and rAF in unfocused windows, which stalls
      // the capture loop the moment the user clicks away.
      backgroundThrottling: false,
    },
  });
}

function desktopOverlayWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;
  return new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    focusable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      ...secureWebPreferences(),
      backgroundThrottling: false,
    },
  });
}
