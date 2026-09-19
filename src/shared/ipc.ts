import type {
  AssetWithThumb, Mode, Permissions, PerfSample, ScreenSource, StageConfig,
} from './types';

/** Channel names. Kept as one object so preload and main can't drift. */
export const CH = {
  // renderer -> main (invoke)
  libraryList: 'library:list',
  libraryImport: 'library:import',
  libraryImportBuffers: 'library:importBuffers',
  libraryUpdate: 'library:update',
  libraryRemove: 'library:remove',
  libraryBytes: 'library:bytes',
  capturePermissions: 'capture:permissions',
  captureRequestCamera: 'capture:requestCamera',
  captureOpenScreenSettings: 'capture:openScreenSettings',
  captureSources: 'capture:sources',
  stageStart: 'stage:start',
  stageStop: 'stage:stop',
  stageConfig: 'stage:config',
  appQuit: 'app:quit',
  windowMinimize: 'window:minimize',
  // main -> renderer (send)
  onStageState: 'evt:stageState',
  onLibraryChanged: 'evt:libraryChanged',
  onStageError: 'evt:stageError',
  // stage -> main
  stagePerf: 'stage:perf',
  stageError: 'stage:error',
} as const;

export type AssetPatch = {
  id: string;
  name?: string;
  refEyeGap?: number;
  anchorX?: number;
  anchorY?: number;
  offsetX?: number;
  offsetY?: number;
  scale?: number;
  anchorMode?: 'eyes' | 'nose';
  enabled?: boolean;
};

export type StageState = { running: boolean; mode: Mode | null };

/** The entire surface exposed to the renderer through contextBridge. */
export type OverlayAPI = {
  library: {
    list(): Promise<AssetWithThumb[]>;
    /** Opens a native file picker. */
    import(): Promise<AssetWithThumb[]>;
    /** Drag-and-drop path: raw bytes, validated in main. */
    importBuffers(files: { name: string; data: ArrayBuffer }[]): Promise<AssetWithThumb[]>;
    update(patch: AssetPatch): Promise<AssetWithThumb | null>;
    remove(id: string): Promise<void>;
    /** Full-resolution PNG bytes for compositing. */
    bytes(id: string): Promise<ArrayBuffer | null>;
    onChanged(cb: (assets: AssetWithThumb[]) => void): () => void;
  };
  capture: {
    permissions(): Promise<Permissions>;
    requestCamera(): Promise<boolean>;
    openScreenSettings(): Promise<void>;
    sources(): Promise<ScreenSource[]>;
  };
  stage: {
    start(cfg: StageConfig): Promise<{ ok: boolean; error?: string }>;
    stop(): Promise<void>;
    /** Stage window only: the config it was launched with. */
    config(): Promise<StageConfig | null>;
    reportPerf(sample: PerfSample): void;
    reportError(message: string): void;
    onState(cb: (s: StageState) => void): () => void;
    /** Failures reported by the stage window, surfaced in Home. */
    onError(cb: (message: string) => void): () => void;
  };
  app: {
    quit(): void;
    minimize(): void;
    platform: NodeJS.Platform;
    /** Windows 11 22621+ gets real acrylic; older builds need the CSS fallback (§6). */
    nativeGlass: boolean;
  };
};

declare global {
  interface Window {
    overlay: OverlayAPI;
  }
}
