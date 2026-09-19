import { contextBridge, ipcRenderer } from 'electron';
import { CH, type AssetPatch, type OverlayAPI, type StageState } from '@shared/ipc';
import type { AssetWithThumb, PerfSample, StageConfig } from '@shared/types';

/**
 * The entire renderer surface. §9: a narrow, typed API over contextBridge --
 * no `ipcRenderer` handle escapes into the page.
 */
function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, value: T) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: OverlayAPI = {
  library: {
    list: () => ipcRenderer.invoke(CH.libraryList),
    import: () => ipcRenderer.invoke(CH.libraryImport),
    importBuffers: (files) => ipcRenderer.invoke(CH.libraryImportBuffers, files),
    update: (patch: AssetPatch) => ipcRenderer.invoke(CH.libraryUpdate, patch),
    remove: (id) => ipcRenderer.invoke(CH.libraryRemove, id),
    bytes: (id) => ipcRenderer.invoke(CH.libraryBytes, id),
    onChanged: (cb) => subscribe<AssetWithThumb[]>(CH.onLibraryChanged, cb),
  },
  capture: {
    permissions: () => ipcRenderer.invoke(CH.capturePermissions),
    requestCamera: () => ipcRenderer.invoke(CH.captureRequestCamera),
    openScreenSettings: () => ipcRenderer.invoke(CH.captureOpenScreenSettings),
    sources: () => ipcRenderer.invoke(CH.captureSources),
  },
  stage: {
    start: (cfg: StageConfig) => ipcRenderer.invoke(CH.stageStart, cfg),
    stop: () => ipcRenderer.invoke(CH.stageStop),
    config: () => ipcRenderer.invoke(CH.stageConfig),
    reportPerf: (sample: PerfSample) => ipcRenderer.send(CH.stagePerf, sample),
    reportError: (message: string) => ipcRenderer.send(CH.stageError, message),
    onState: (cb) => subscribe<StageState>(CH.onStageState, cb),
    onError: (cb) => subscribe<string>(CH.onStageError, cb),
  },
  app: {
    quit: () => ipcRenderer.invoke(CH.appQuit),
    minimize: () => ipcRenderer.invoke(CH.windowMinimize),
    platform: process.platform,
    nativeGlass: process.argv.includes('--native-glass'),
  },
};

contextBridge.exposeInMainWorld('overlay', api);
