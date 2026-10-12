// Generates icons/icon-{16,32,48,128}.png: a theatre-curtain glyph, gold (#e8b04a) on a near-black
// (#0b0b0f) rounded square. Pure Node (zlib only), rendered at 4x and box-filtered down.
//   node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 32, 48, 128];
const SS = 4;                                   // supersampling factor per axis

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const BG = hex('#0b0b0f');
const RIM = hex('#26262f');
const GOLD = hex('#e8b04a');
const GOLD_DARK = hex('#8a5f1c');
const GOLD_LIGHT = hex('#f6d68c');
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// --- geometry, all in unit coordinates (0..1, y down) -------------------------------------------

// Inner edge of the left drape as a function of y, through evenly spaced control points
// (Catmull-Rom). It pinches in at the tie-back and flares back towards the floor.
const CURTAIN_TOP = 0.23;
const CURTAIN_BOTTOM = 0.87;
const OUTER_X = 0.13;
const TIEBACK_Y = 0.56;
const EDGE_PTS = [0.47, 0.385, 0.30, 0.325, 0.43];

function innerEdge(y) {
  const t = clamp01((y - CURTAIN_TOP) / (CURTAIN_BOTTOM - CURTAIN_TOP)) * (EDGE_PTS.length - 1);
  const k = Math.min(EDGE_PTS.length - 2, Math.floor(t));
  const u = t - k;
  const p0 = EDGE_PTS[Math.max(0, k - 1)];
  const p1 = EDGE_PTS[k];
  const p2 = EDGE_PTS[k + 1];
  const p3 = EDGE_PTS[Math.min(EDGE_PTS.length - 1, k + 2)];
  return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u
    + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
}

function insideRoundedSquare(x, y) {
  const r = 0.22;
  const dx = Math.max(r - x, x - (1 - r), 0);
  const dy = Math.max(r - y, y - (1 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

function nearRim(x, y) {
  // thin lighter ring just inside the edge, helps the glyph read on dark toolbars
  const r = 0.22;
  const w = 0.02;
  const dx = Math.max(r - x, x - (1 - r), 0);
  const dy = Math.max(r - y, y - (1 - r), 0);
  const d = Math.sqrt(dx * dx + dy * dy);
  if (dx === 0 && dy === 0) {
    const edge = Math.min(x, 1 - x, y, 1 - y);
    return edge <= w;
  }
  return d <= r && d > r - w;
}

// Colour of one sample, or null when outside the icon.
function shade(x, y) {
  if (!insideRoundedSquare(x, y)) return null;
  let c = nearRim(x, y) ? RIM : BG;

  // warm stage glow behind the opening
  const gx = x - 0.5;
  const gy = (y - 0.6) * 1.15;
  const gd = Math.sqrt(gx * gx + gy * gy);
  c = mix(c, GOLD, 0.30 * clamp01(1 - gd / 0.30) ** 1.6);

  // drapes (right one is the mirror image of the left)
  const mx = x < 0.5 ? x : 1 - x;
  if (y >= CURTAIN_TOP && y <= CURTAIN_BOTTOM) {
    const xi = innerEdge(y);
    if (mx >= OUTER_X && mx <= xi) {
      const t = (mx - OUTER_X) / (xi - OUTER_X);               // 0 at outer edge, 1 at pulled edge
      const folds = 0.5 + 0.5 * Math.cos(t * Math.PI * 5.2);   // soft vertical pleats
      let k = mix(GOLD_DARK, GOLD, 0.35 + 0.65 * folds);
      k = mix(k, GOLD_LIGHT, 0.22 * t * t);                    // the pulled edge catches the light
      k = mix(k, BG, 0.30 * clamp01((y - 0.70) / 0.17));       // fall off towards the floor
      c = k;
    }
    // tie-back band
    if (Math.abs(y - TIEBACK_Y) <= 0.026 && mx >= OUTER_X && mx <= xi + 0.03) {
      c = mix(GOLD_LIGHT, GOLD, 0.35 + 8 * Math.abs(y - TIEBACK_Y));
    }
  }

  // scalloped valance across the top
  const left = 0.11;
  const right = 0.89;
  if (x >= left && x <= right && y >= 0.14) {
    const u = ((x - left) / (right - left)) * 4 % 1;           // 4 swags
    const bottom = 0.215 + 0.085 * 4 * u * (1 - u);
    if (y <= bottom) {
      const s = Math.sin(Math.PI * u);
      let k = mix(GOLD, GOLD_LIGHT, 0.15 + 0.55 * s);
      k = mix(k, GOLD_DARK, 0.55 * (1 - s) ** 2);
      c = mix(k, GOLD_DARK, clamp01((y - 0.14) / (bottom - 0.14)) ** 3 * 0.35);
    }
  }
  return c;
}

// --- rasteriser ---------------------------------------------------------------------------------

function render(size) {
  const big = size * SS;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((px * SS + sx + 0.5) / big, (py * SS + sy + 0.5) / big);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }    // premultiplied accumulation
        }
      }
      const o = (py * size + px) * 4;
      if (a > 0) {
        out[o] = Math.round((r / a) * 255);
        out[o + 1] = Math.round((g / a) * 255);
        out[o + 2] = Math.round((b / a) * 255);
        out[o + 3] = Math.round((a / (SS * SS)) * 255);
      }
    }
  }
  return out;
}

// --- PNG writer ---------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;        // bit depth
  ihdr[9] = 6;        // colour type: RGBA
  ihdr[10] = 0;       // deflate
  ihdr[11] = 0;       // adaptive filtering
  ihdr[12] = 0;       // no interlace
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;                                  // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function makeIcons(outDir = join(ROOT, 'icons')) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const size of SIZES) {
    const file = join(outDir, `icon-${size}.png`);
    writeFileSync(file, encodePng(render(size), size));
    written.push(file);
  }
  return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const f of makeIcons()) console.log('wrote', f);
}
