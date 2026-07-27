/**
 * Genereerib PWA ikoonid (`public/icon-192.png`, `icon-512.png`).
 *
 * Miks käsitsi ja ilma teekideta: ikoon on kaks lihtsat kujundit ja PNG
 * kirjutamine on paarkümmend rida. Sharp või ImageMagick tooks kaasa
 * natiivsõltuvuse ja mitmekümne megabaidise paigalduse ühe ühekordse
 * genereerimise pärast.
 *
 * Käivita:  node scripts/make-icons.mjs
 * Tulemus commititakse — käivitamist on vaja ainult siis, kui logo muutub.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, '../public');

/** Sama palett mis rakendusel: sügav ookean + messing. */
const BG = [11, 53, 80]; // #0b3550
const WAVE = [74, 163, 224]; // #4aa3e0
const SAIL = [232, 244, 250]; // #e8f4fa

function render(size) {
  const px = new Uint8Array(size * size * 4);

  const set = (x, y, [r, g, b], alpha = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    // Lihtne alfa-segamine olemasoleva peale.
    const a = alpha / 255;
    px[i] = Math.round(px[i] * (1 - a) + r * a);
    px[i + 1] = Math.round(px[i + 1] * (1 - a) + g * a);
    px[i + 2] = Math.round(px[i + 2] * (1 - a) + b * a);
    px[i + 3] = 255;
  };

  // Taust ümarate nurkadega, et ikoon näeks välja nagu äpiikoon ka seal,
  // kus platvorm ise maski ei lisa.
  const radius = size * 0.22;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (insideRoundedRect(x, y, size, radius)) set(x, y, BG);
    }
  }

  // Puri: kolmnurk ülemises pooles.
  const apex = { x: size / 2, y: size * 0.16 };
  const left = { x: size * 0.32, y: size * 0.56 };
  const right = { x: size * 0.68, y: size * 0.56 };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inTriangle(x + 0.5, y + 0.5, apex, left, right)) set(x, y, SAIL);
    }
  }

  // Kaks lainet alumises kolmandikus.
  for (const [yBase, amplitude] of [
    [size * 0.68, size * 0.045],
    [size * 0.8, size * 0.038],
  ]) {
    const thickness = size * 0.055;
    for (let x = 0; x < size; x++) {
      const wave = yBase + Math.sin((x / size) * Math.PI * 3) * amplitude;
      for (let dy = 0; dy < thickness; dy++) {
        const y = Math.round(wave + dy);
        if (insideRoundedRect(x, y, size, radius)) set(x, y, WAVE);
      }
    }
  }

  return px;
}

function insideRoundedRect(x, y, size, radius) {
  if (x < 0 || y < 0 || x >= size || y >= size) return false;
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function inTriangle(px, py, a, b, c) {
  const sign = (p1, p2, p3) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const p = { x: px, y: py };
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** Minimaalne PNG-kirjutaja: IHDR + IDAT + IEND, RGBA, filter 0. */
function toPng(pixels, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    // Iga rea ees on filtribait; 0 = filtreerimata.
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(pixels.subarray(y * size * 4, (y + 1) * size * 4)).copy(
      raw,
      y * (size * 4 + 1) + 1,
    );
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bitisügavus
  ihdr[9] = 6; // värvitüüp: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [192, 512]) {
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, toPng(render(size), size));
  console.log(`kirjutasin ${file}`);
}
