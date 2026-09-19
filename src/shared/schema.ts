// Every IPC payload is validated here before it reaches the filesystem (§9).
// A compromised renderer should not be able to reach past this file.
import { z } from 'zod';

const finite = z.number().finite();

export const assetPatchSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200).optional(),
  refEyeGap: finite.min(1).max(20000).optional(),
  anchorX: finite.min(-20000).max(20000).optional(),
  anchorY: finite.min(-20000).max(20000).optional(),
  offsetX: finite.min(-20).max(20).optional(),
  offsetY: finite.min(-20).max(20).optional(),
  scale: finite.min(0.05).max(20).optional(),
  anchorMode: z.enum(['eyes', 'nose']).optional(),
  enabled: z.boolean().optional(),
});

export const idSchema = z.string().min(1).max(64);

export const importBuffersSchema = z
  .array(
    z.object({
      name: z.string().min(1).max(260),
      // 64 MB ceiling: a PNG larger than this is not a face sticker.
      data: z.instanceof(ArrayBuffer).refine((b) => b.byteLength > 0 && b.byteLength < 64 * 1024 * 1024),
    })
  )
  .max(64);

export const stageConfigSchema = z.object({
  mode: z.enum(['camera', 'screen']),
  sourceId: z.string().max(200).optional(),
  overlayDesktop: z.boolean(),
});

export const perfSchema = z.object({
  captureMs: finite,
  inferMs: finite,
  drawMs: finite,
  fps: finite,
  faces: finite,
  threads: finite,
  isolated: z.boolean(),
});
