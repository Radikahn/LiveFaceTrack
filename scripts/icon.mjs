// Minimal dependency-free icon rasteriser + PNG/ICO encoders.
// The mark: a graphite glass tile with a lens ring that runs camera-blue
// through screen-magenta -- the app's two modes, in one object.
import zlib from 'node:zlib';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

const GRAPHITE_TOP = [26, 31, 40];
const GRAPHITE_BOT = [11, 14, 19];
const BLUE = [43, 107, 255];
const MAGENTA = [224, 66, 155];

/** Signed distance to a rounded rect centred at (0,0). Negative = inside. */
function sdRoundRect(px, py, hw, hh, r) {
  const qx = Math.abs(px) - (hw - r);
  const qy = Math.abs(py) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

export function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size / 1024; // design space is 1024
  const px = 1 / s; // one device pixel, in design units
  // macOS icon grid: the art sits inset from the canvas edge.
  const hw = 400, hh = 400, radius = 190;
  const ringR = 215, ringW = 34;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / s - 512;
      const dy = (y + 0.5) / s - 512;

      const d = sdRoundRect(dx, dy, hw, hh, radius);
      const tileA = 1 - smoothstep(-px, px, d);
      if (tileA <= 0) continue;

      // Body: vertical graphite gradient.
      let col = mix(GRAPHITE_TOP, GRAPHITE_BOT, clamp01((dy + hh) / (2 * hh)));

      // Specular rim: a bright hairline just inside the top edge, fading down.
      const rim = (1 - smoothstep(0, 5 * px, Math.abs(d + 1.5 * px))) *
        clamp01(1 - (dy + hh) / (1.1 * hh));
      col = mix(col, [255, 255, 255], rim * 0.55);

      // Lens ring: hue sweeps blue -> magenta around the circle.
      const rr = Math.hypot(dx, dy);
      const ringA = (1 - smoothstep(ringW / 2 - px, ringW / 2 + px, Math.abs(rr - ringR)));
      if (ringA > 0) {
        const ang = Math.atan2(dy, dx); // -pi..pi
        const t = clamp01((Math.cos(ang - Math.PI * 0.75) + 1) / 2);
        col = mix(col, mix(BLUE, MAGENTA, t), ringA);
      }

      // Glass inside the lens, with an off-centre highlight.
      const inner = 1 - smoothstep(ringR - ringW / 2 - px, ringR - ringW / 2 + px, rr);
      if (inner > 0) {
        const glass = mix(col, [8, 10, 14], 0.55 * inner);
        const hx = dx + 90, hy = dy + 110;
        const spec = (1 - smoothstep(60, 240, Math.hypot(hx, hy * 1.4))) * 0.16;
        col = mix(glass, [255, 255, 255], spec * inner);
      }

      const o = (y * size + x) * 4;
      rgba[o] = Math.round(clamp01(col[0] / 255) * 255);
      rgba[o + 1] = Math.round(clamp01(col[1] / 255) * 255);
      rgba[o + 2] = Math.round(clamp01(col[2] / 255) * 255);
      rgba[o + 3] = Math.round(tileA * 255);
    }
  }
  return rgba;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePNG(rgba, size) {
  // Filter type 0 (None) on every scanline; zlib does the rest.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO with PNG-compressed entries (Vista+, which is every target we support). */
export function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir.writeUInt16LE(1, o + 4);   // colour planes
    dir.writeUInt16LE(32, o + 6);  // bits per pixel
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

/**
 * Tray glyph: just the lens ring. At 22px the full mark is mush, and the tray
 * icon has one job -- say which mode is live, in the mode's own colour (§6).
 */
export function renderRing(size, [r, g, b]) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size / 44;
  const px = 1 / s;
  const R = 16, W = 5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / s - 22;
      const dy = (y + 0.5) / s - 22;
      const d = Math.abs(Math.hypot(dx, dy) - R);
      const a = 1 - smoothstep(W / 2 - px, W / 2 + px, d);
      if (a <= 0) continue;
      const o = (y * size + x) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b;
      rgba[o + 3] = Math.round(clamp01(a) * 255);
    }
  }
  return rgba;
}

export const TRAY_COLORS = {
  idle: [0, 0, 0],
  camera: [43, 107, 255],
  screen: [224, 66, 155],
};
