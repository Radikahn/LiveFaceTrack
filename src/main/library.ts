import { app, dialog, nativeImage, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultCalibration, type Asset, type AssetWithThumb } from '@shared/types';
import type { AssetPatch } from '@shared/ipc';

/**
 * Imported PNGs are copied into userData with generated UUID filenames and
 * decoded before they are trusted (§9). A user path is never loaded directly,
 * and the renderer never learns one -- it gets bytes over IPC.
 */
const THUMB = 96; // 48pt at 2x
const MAX_BYTES = 64 * 1024 * 1024;

let cache: Asset[] | null = null;
const thumbs = new Map<string, string>();

const dir = () => path.join(app.getPath('userData'), 'library');
const storePath = () => path.join(app.getPath('userData'), 'library.json');
export const assetPath = (a: Asset) => path.join(dir(), a.file);

async function load(): Promise<Asset[]> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await fs.readFile(storePath(), 'utf8'));
    cache = Array.isArray(raw?.assets) ? (raw.assets as Asset[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function save(assets: Asset[]): Promise<void> {
  cache = assets;
  await fs.mkdir(path.dirname(storePath()), { recursive: true });
  // Write-then-rename so a crash mid-write cannot leave a truncated store.
  const tmp = `${storePath()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ version: 1, assets }, null, 2));
  await fs.rename(tmp, storePath());
}

function thumbFor(id: string, image: Electron.NativeImage): string {
  const { width, height } = image.getSize();
  const scale = THUMB / Math.max(width, height, 1);
  const thumb = image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'better',
  });
  const url = thumb.toDataURL();
  thumbs.set(id, url);
  return url;
}

async function decorate(a: Asset): Promise<AssetWithThumb> {
  const cached = thumbs.get(a.id);
  if (cached) return { ...a, thumb: cached };
  try {
    const image = nativeImage.createFromBuffer(await fs.readFile(assetPath(a)));
    return { ...a, thumb: image.isEmpty() ? '' : thumbFor(a.id, image) };
  } catch {
    return { ...a, thumb: '' };
  }
}

export async function list(): Promise<AssetWithThumb[]> {
  const assets = await load();
  return Promise.all(assets.map(decorate));
}

/**
 * The single import path. Bytes in, validated Asset out -- so the file picker
 * and drag-and-drop cannot diverge in what they accept.
 */
async function importBytes(name: string, data: Buffer): Promise<AssetWithThumb | null> {
  if (data.byteLength === 0 || data.byteLength > MAX_BYTES) return null;

  // Decode before trusting: anything that is not a real image is rejected here.
  const image = nativeImage.createFromBuffer(data);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  if (width < 8 || height < 8 || width > 8192 || height > 8192) return null;

  const id = randomUUID();
  const file = `${id}.png`;
  await fs.mkdir(dir(), { recursive: true });
  // Re-encode rather than copying the original bytes: what lands on disk is
  // then something we produced, not something a stranger's file said it was.
  await fs.writeFile(path.join(dir(), file), image.toPNG());

  const asset: Asset = {
    id,
    name: path.basename(name).replace(/\.[^.]+$/, '') || 'Untitled',
    file,
    width,
    height,
    ...defaultCalibration(width, height),
    enabled: true,
    createdAt: Date.now(),
  };
  thumbFor(id, image);
  await save([...(await load()), asset]);
  return decorate(asset);
}

export async function importFromDialog(parent: BrowserWindow): Promise<AssetWithThumb[]> {
  const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
    title: 'Add overlays',
    buttonLabel: 'Add',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'webp', 'gif', 'jpg', 'jpeg'] }],
  });
  if (canceled) return [];

  const out: AssetWithThumb[] = [];
  for (const p of filePaths) {
    try {
      const stat = await fs.stat(p);
      if (!stat.isFile() || stat.size > MAX_BYTES) continue;
      const added = await importBytes(path.basename(p), await fs.readFile(p));
      if (added) out.push(added);
    } catch {
      /* skip unreadable files rather than failing the whole import */
    }
  }
  return out;
}

export async function importFromBuffers(
  files: { name: string; data: ArrayBuffer }[]
): Promise<AssetWithThumb[]> {
  const out: AssetWithThumb[] = [];
  for (const f of files) {
    const added = await importBytes(f.name, Buffer.from(f.data));
    if (added) out.push(added);
  }
  return out;
}

export async function update(patch: AssetPatch): Promise<AssetWithThumb | null> {
  const assets = await load();
  const i = assets.findIndex((a) => a.id === patch.id);
  if (i < 0) return null;
  const next: Asset = { ...assets[i], ...patch, id: assets[i].id, file: assets[i].file };
  const copy = assets.slice();
  copy[i] = next;
  await save(copy);
  return decorate(next);
}

export async function remove(id: string): Promise<void> {
  const assets = await load();
  const found = assets.find((a) => a.id === id);
  if (!found) return;
  await save(assets.filter((a) => a.id !== id));
  thumbs.delete(id);
  await fs.rm(assetPath(found), { force: true });
}

/** Full-resolution bytes for the compositor. */
export async function bytes(id: string): Promise<ArrayBuffer | null> {
  const found = (await load()).find((a) => a.id === id);
  if (!found) return null;
  try {
    const buf = await fs.readFile(assetPath(found));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  } catch {
    return null;
  }
}
