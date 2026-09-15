/**
 * A rasteriser for rounded rectangles, which is all the Fourier mark is.
 *
 * Writing ~150 lines of PNG here beats depending on a native image library:
 * `pnpm brand` runs on a clean checkout with nothing installed, in CI, on any
 * platform, and the bytes are byte-identical every time. It also lets the
 * favicon sizes snap to the pixel grid, which is the difference between crisp
 * bars and grey mush at 16px.
 */
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA8 pixels in, a PNG file out. */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none. The mark is flat colour; nothing to predict.
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Is a point inside a rounded rectangle? */
function inside(px, py, s) {
  if (px < s.x || px > s.x + s.w || py < s.y || py > s.y + s.h) return false;
  const r = Math.min(s.r ?? 0, s.w / 2, s.h / 2);
  if (r <= 0) return true;
  const cx = px < s.x + r ? s.x + r : px > s.x + s.w - r ? s.x + s.w - r : px;
  const cy = py < s.y + r ? s.y + r : py > s.y + s.h - r ? s.y + s.h - r : py;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * Nudge a shape onto whole pixels. Below about 32px a bar landing on a half
 * pixel turns into two half-lit ones, and the mark loses its rhythm; rounding
 * the edges keeps three distinct bars no matter how small the icon gets.
 */
function snap(s) {
  const x = Math.round(s.x);
  const y = Math.round(s.y);
  return {
    x,
    y,
    w: Math.max(1, Math.round(s.x + s.w) - x),
    h: Math.max(1, Math.round(s.y + s.h) - y),
    r: s.r >= 1 ? Math.round(s.r) : 0,
    fill: s.fill,
  };
}

/**
 * Paint a list of `{x, y, w, h, r, fill}` shapes, in order, over `background`
 * (a hex string, or null for transparent). Coordinates are in pixels.
 */
export function render(width, height, shapes, { background = null, samples = 8, pixelSnap = false } = {}) {
  const buf = Buffer.alloc(width * height * 4);
  if (background) {
    const [r, g, b] = hexToRgb(background);
    for (let i = 0; i < width * height; i++) {
      buf[i * 4] = r;
      buf[i * 4 + 1] = g;
      buf[i * 4 + 2] = b;
      buf[i * 4 + 3] = 255;
    }
  }
  const list = pixelSnap ? shapes.map(snap) : shapes;
  const step = 1 / samples;
  const offset = step / 2;
  const total = samples * samples;

  for (const s of list) {
    const [sr, sg, sb] = hexToRgb(s.fill);
    const x0 = Math.max(0, Math.floor(s.x));
    const x1 = Math.min(width, Math.ceil(s.x + s.w));
    const y0 = Math.max(0, Math.floor(s.y));
    const y1 = Math.min(height, Math.ceil(s.y + s.h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        let hits = 0;
        for (let sy = 0; sy < samples; sy++) {
          const fy = py + offset + sy * step;
          for (let sx = 0; sx < samples; sx++) {
            if (inside(px + offset + sx * step, fy, s)) hits++;
          }
        }
        if (!hits) continue;
        const a = hits / total;
        const i = (py * width + px) * 4;
        const da = buf[i + 3] / 255;
        const outA = a + da * (1 - a);
        // Source-over, un-premultiplied.
        buf[i] = Math.round((sr * a + buf[i] * da * (1 - a)) / outA);
        buf[i + 1] = Math.round((sg * a + buf[i + 1] * da * (1 - a)) / outA);
        buf[i + 2] = Math.round((sb * a + buf[i + 2] * da * (1 - a)) / outA);
        buf[i + 3] = Math.round(outA * 255);
      }
    }
  }
  return buf;
}

/**
 * An .ico is a directory of images; since Vista each one may simply be a PNG,
 * which is what every browser reads today.
 */
export function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  const blobs = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, png } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 0 means 256
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // palette entries
    e[3] = 0;
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    blobs.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}
