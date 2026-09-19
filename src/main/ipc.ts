import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { CH } from '@shared/ipc';
import {
  assetPatchSchema,
  idSchema,
  importBuffersSchema,
  interactiveSchema,
  perfSchema,
  stageConfigSchema,
} from '@shared/schema';
import type { PerfSample, StageConfig } from '@shared/types';
import * as library from './library';
import * as capture from './capture';
import { HOST, SCHEME } from './protocol';

export type IpcContext = {
  home(): BrowserWindow | null;
  startStage(cfg: StageConfig): Promise<{ ok: boolean; error?: string }>;
  stopStage(): void;
  stageConfig(): StageConfig | null;
  setStageInteractive(interactive: boolean): void;
  panicKey(): string | null;
  onPerf(sample: PerfSample): void;
  onStageError(message: string): void;
};

declare const APP_VITE_DEV_SERVER_URL: string | undefined;

/**
 * Only our own pages may talk to main. Without this any frame the renderer
 * happens to load -- an <iframe>, a redirected window -- inherits the whole
 * preload surface.
 */
function trusted(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  if (url.startsWith(`${SCHEME}://${HOST}/`)) return true;
  return Boolean(APP_VITE_DEV_SERVER_URL && url.startsWith(APP_VITE_DEV_SERVER_URL));
}

/** Every payload crosses a zod schema before it can reach the filesystem (§9). */
function handle<T>(
  channel: string,
  parse: (raw: unknown) => T,
  fn: (event: IpcMainInvokeEvent, arg: T) => unknown
): void {
  ipcMain.handle(channel, async (event, raw) => {
    if (!trusted(event)) throw new Error('untrusted sender');
    let arg: T;
    try {
      arg = parse(raw);
    } catch {
      throw new Error(`invalid payload for ${channel}`);
    }
    return fn(event, arg);
  });
}

const nothing = () => undefined;

export function registerIpc(ctx: IpcContext): void {
  const broadcastLibrary = async () => {
    const assets = await library.list();
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CH.onLibraryChanged, assets);
    }
  };

  handle(CH.libraryList, nothing, () => library.list());

  handle(CH.libraryImport, nothing, async () => {
    const parent = ctx.home();
    if (!parent) return [];
    const added = await library.importFromDialog(parent);
    if (added.length) await broadcastLibrary();
    return added;
  });

  handle(
    CH.libraryImportBuffers,
    (raw) => importBuffersSchema.parse(raw),
    async (_e, files) => {
      const added = await library.importFromBuffers(files);
      if (added.length) await broadcastLibrary();
      return added;
    }
  );

  handle(
    CH.libraryUpdate,
    (raw) => assetPatchSchema.parse(raw),
    async (_e, patch) => {
      const updated = await library.update(patch);
      if (updated) await broadcastLibrary();
      return updated;
    }
  );

  handle(
    CH.libraryRemove,
    (raw) => idSchema.parse(raw),
    async (_e, id) => {
      await library.remove(id);
      await broadcastLibrary();
    }
  );

  handle(
    CH.libraryBytes,
    (raw) => idSchema.parse(raw),
    (_e, id) => library.bytes(id)
  );

  handle(CH.capturePermissions, nothing, () => capture.permissions());
  handle(CH.captureRequestCamera, nothing, () => capture.requestCamera());
  handle(CH.captureOpenScreenSettings, nothing, () => capture.openScreenSettings());
  handle(CH.captureSources, nothing, () => capture.sources());

  handle(
    CH.stageStart,
    (raw) => stageConfigSchema.parse(raw),
    (_e, cfg) => ctx.startStage(cfg)
  );
  handle(CH.stageStop, nothing, () => ctx.stopStage());
  handle(CH.stageConfig, nothing, () => ctx.stageConfig());
  handle(
    CH.stageInteractive,
    (raw) => interactiveSchema.parse(raw),
    (_e, on) => ctx.setStageInteractive(on)
  );
  handle(CH.stagePanicKey, nothing, () => ctx.panicKey());

  handle(CH.appQuit, nothing, () => {
    ctx.stopStage();
    app.quit();
  });

  handle(CH.windowMinimize, nothing, (event) =>
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  );

  // Fire-and-forget telemetry from the stage loop. Never trusted for control
  // flow, so a bad sample is dropped rather than raised.
  ipcMain.on(CH.stagePerf, (event, raw) => {
    if (!BrowserWindow.fromWebContents(event.sender)) return;
    const parsed = perfSchema.safeParse(raw);
    if (parsed.success) ctx.onPerf(parsed.data);
  });

  ipcMain.on(CH.stageError, (_event, raw) => {
    if (typeof raw === 'string') ctx.onStageError(raw.slice(0, 500));
  });
}
