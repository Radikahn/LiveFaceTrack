import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  nativeImage,
  session,
  systemPreferences,
  Tray,
} from 'electron';
import path from 'node:path';
import { CH, type StageState } from '@shared/ipc';
import type { PerfSample, StageConfig } from '@shared/types';
import * as capture from './capture';
import { registerIpc } from './ipc';
import { isDev, pageUrl, registerProtocolHandler, registerScheme } from './protocol';
import { createHomeWindow, createStageWindow, nativeGlass } from './windows';

// Privileged schemes must be declared before the app is ready.
registerScheme();

let home: BrowserWindow | null = null;
let stage: BrowserWindow | null = null;
let stageCfg: StageConfig | null = null;
let tray: Tray | null = null;
let panicAccelerator: string | null = null;
let quitting = false;

/** `npm run selftest`: prove the runtime, print the report, exit non-zero on failure. */
const selftest = process.argv.includes('--selftest');

/** Packaged, extraResource lands files directly in Contents/Resources. */
const resource = (file: string) =>
  app.isPackaged
    ? path.join(process.resourcesPath, file)
    : path.join(__dirname, '../../resources', file);

/* ------------------------------------------------------------------ stage */

function broadcastStage(): void {
  const state: StageState = { running: stage !== null, mode: stageCfg?.mode ?? null };
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CH.onStageState, state);
  }
  updateTray();
}

async function startStage(cfg: StageConfig): Promise<{ ok: boolean; error?: string }> {
  // Pre-flight. Without the Screen Recording grant macOS does not reject the
  // desktop getUserMedia -- it simply never resolves -- so a stage window
  // opened here would hang on "Starting..." with no way to explain itself.
  if (cfg.mode === 'screen' && process.platform === 'darwin') {
    if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      void capture.openScreenSettings();
      return {
        ok: false,
        error:
          'Screen Recording permission is required. Grant it in System Settings, ' +
          'then restart Overlay. (The grant resets whenever the app is re-signed, ' +
          'so dev builds need re-approving.)',
      };
    }
  }
  if (cfg.mode === 'screen' && !cfg.sourceId) {
    return { ok: false, error: 'Pick a screen first.' };
  }

  stopStage();
  try {
    stageCfg = cfg;
    stage = createStageWindow(cfg);
    stage.on('closed', () => {
      stage = null;
      stageCfg = null;
      broadcastStage();
      home?.show();
    });
    // The home window would otherwise sit on top of a full-screen overlay.
    if (cfg.mode === 'screen' && cfg.overlayDesktop) home?.hide();
    broadcastStage();
    return { ok: true };
  } catch (err) {
    stageCfg = null;
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function stopStage(): void {
  const win = stage;
  stage = null;
  stageCfg = null;
  if (win && !win.isDestroyed()) win.destroy();
  broadcastStage();
  if (!quitting) home?.show();
}

/**
 * The desktop overlay is click-through, which is the point -- but it also means
 * its own Stop button cannot be clicked. `forward: true` keeps mouse *move*
 * events flowing to the renderer, so the stage hit-tests the pointer against
 * its controls and asks for real mouse events back only while it is over one.
 */
function setStageInteractive(interactive: boolean): void {
  if (!stage || stage.isDestroyed()) return;
  if (!stageCfg || stageCfg.mode !== 'screen' || !stageCfg.overlayDesktop) return;
  stage.setIgnoreMouseEvents(!interactive, { forward: true });
}

/* ------------------------------------------------------- panic + lifecycle */

/**
 * §6: a click-through, always-on-top, full-screen window with a bug in it is
 * genuinely hard to dismiss. Build the way out before building the thing.
 *
 * Ctrl+Shift+Esc is Task Manager on Windows and cannot be registered, so we
 * try candidates in order and keep the first that takes.
 */
function registerPanicKey(): void {
  const candidates =
    process.platform === 'darwin'
      ? ['Command+Shift+Escape', 'Command+Alt+Shift+O']
      : ['Control+Alt+Shift+O', 'Control+Shift+F12'];

  for (const accelerator of candidates) {
    try {
      if (globalShortcut.register(accelerator, stopStage)) {
        panicAccelerator = accelerator;
        return;
      }
    } catch {
      /* try the next one */
    }
  }
  console.warn('[overlay] no panic hotkey could be registered');
}

function updateTray(): void {
  if (!tray) return;
  const mode = stageCfg?.mode;
  const file =
    mode === 'camera'
      ? 'tray-camera.png'
      : mode === 'screen'
        ? 'tray-screen.png'
        : 'trayTemplate.png';
  const image = nativeImage.createFromPath(resource(file));
  // Only the idle glyph gets system tinting; the live ones carry the accent.
  image.setTemplateImage(!mode);
  tray.setImage(image);
  tray.setToolTip(mode ? `Overlay - ${mode} is live` : 'Overlay');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: mode ? `Stop ${mode} overlay` : 'Not running',
        enabled: Boolean(mode),
        click: stopStage,
      },
      { type: 'separator' },
      {
        label: 'Show Overlay',
        click: () => {
          home?.show();
          home?.focus();
        },
      },
      ...(panicAccelerator
        ? [
            {
              label: `Panic key: ${panicAccelerator.replace(/\+/g, ' + ')}`,
              enabled: false,
            } as const,
          ]
        : []),
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

function runSelftest(): void {
  home?.hide();
  const win = new BrowserWindow({
    width: 760,
    height: 620,
    show: process.env.OVERLAY_SELFTEST_VISIBLE === '1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const threads = process.env.OVERLAY_THREADS;
  void win.loadURL(
    pageUrl('selftest') + (threads ? `?threads=${encodeURIComponent(threads)}` : '')
  );
  // A hang is a failure too -- most often ORT never resolving because
  // SharedArrayBuffer is missing.
  setTimeout(() => {
    console.error('selftest timed out after 120s');
    app.exit(1);
  }, 120_000);
}

function hardenSession(): void {
  const ses = session.defaultSession;

  // Media is the whole point of the app, but only for our own pages.
  ses.setPermissionRequestHandler((contents, permission, callback) => {
    const url = contents.getURL();
    const ours =
      url.startsWith('app://overlay/') || (isDev() && url.startsWith('http://localhost'));
    callback(ours && (permission === 'media' || permission === 'display-capture'));
  });
  ses.setPermissionCheckHandler((_c, permission) => permission === 'media');

  // Nothing leaves the machine (§9). Anything that tries is a bug, so make it
  // loud rather than silent.
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (url !== contents.getURL()) event.preventDefault();
    });
    // Renderer logs are the only view into the capture loop, and the stage
    // window has no devtools in overlay mode. Also on for --selftest, whose
    // whole job is to report from inside a packaged build.
    if (isDev() || selftest) {
      contents.on('console-message', (details) => {
        const url = contents.getURL();
        const where = url.includes('/stage/')
          ? 'stage'
          : url.includes('/selftest/')
            ? 'selftest'
            : 'home';
        console.log(`[${where}:${details.level}] ${details.message}`);
      });
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    home?.show();
    home?.focus();
  });

  app.whenReady().then(() => {
    registerProtocolHandler();
    hardenSession();
    registerPanicKey();

    tray = new Tray(nativeImage.createFromPath(resource('trayTemplate.png')));
    home = createHomeWindow();
    home.on('closed', () => {
      home = null;
    });
    updateTray();

    registerIpc({
      home: () => home,
      startStage,
      stopStage,
      stageConfig: () => stageCfg,
      setStageInteractive,
      panicKey: () => panicAccelerator,
      onPerf: (sample: PerfSample) => {
        if (isDev())
          process.stdout.write(
            `\r[overlay] ${sample.fps.toFixed(0)}fps  cap ${sample.captureMs.toFixed(1)}  ` +
              `infer ${sample.inferMs.toFixed(1)}  draw ${sample.drawMs.toFixed(1)}  ` +
              `faces ${sample.faces}  threads ${sample.threads}${sample.isolated ? '' : ' NOT-ISOLATED'}   `
          );
      },
      onStageError: (message) => {
        if (selftest && message.startsWith('SELFTEST')) {
          console.log(`\n${message}\n`);
          // Let stdout flush before tearing the process down.
          setTimeout(() => app.exit(message.startsWith('SELFTEST PASS') ? 0 : 1), 100);
          return;
        }
        console.error('[overlay:stage]', message);
        home?.webContents.send(CH.onStageError, message);
      },
    });

    if (selftest) runSelftest();

    app.on('activate', () => {
      if (selftest) return;
      if (!home) {
        home = createHomeWindow();
        home.on('closed', () => {
          home = null;
        });
      } else {
        home.show();
      }
    });
  });

  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

export { nativeGlass, pageUrl };
