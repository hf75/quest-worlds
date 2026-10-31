// Schaut sich die Weltfunktion ohne Browser an: Karte von oben, Querschnitte, Begehbarkeit und Zeit pro Punkt.
//   node tools/dev/preview_world.mjs [--seed 1] [--out previews/world] [--size 4096] [--res 4]
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { World } from '../../src/world.ts';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const seed = Number(arg('seed', 1));
const out = arg('out', 'previews/world');
const size = Number(arg('size', 4096));
const res = Number(arg('res', 4));
const cx = Number(arg('x', 0)), cz = Number(arg('z', 0));
mkdirSync(out, { recursive: true });

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
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePng(path, w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]));
}

const planet = arg('planet', 'slate');
const world = new World(seed, planet);
const n = Math.round(size / res);
const H = new Float32Array(n * n);
const t0 = performance.now();
for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) H[j * n + i] = world.height(cx + (i - n / 2) * res, cz + (j - n / 2) * res);
const ms = performance.now() - t0;
let lo = Infinity, hi = -Infinity;
for (const v of H) { if (v < lo) lo = v; if (v > hi) hi = v; }
console.log(`Seed ${seed}: ${n}x${n} Punkte in ${ms.toFixed(0)} ms, ${((ms * 1000) / (n * n)).toFixed(2)} us pro Punkt, Hoehe ${lo.toFixed(0)} bis ${hi.toFixed(0)} m`);

// Karte: Schummerung aus Richtung des Hauptlichts, dazu Höhenfarbe
const rgb = new Uint8Array(n * n * 3);
const LIMIT = 1.1; // tan 48 Grad, die Grenze fürs Gehen
let steep = 0;
const walk = new Uint8Array(n * n);
for (let j = 0; j < n; j++) {
  for (let i = 0; i < n; i++) {
    const l = H[j * n + Math.max(i - 1, 0)], r = H[j * n + Math.min(i + 1, n - 1)];
    const u = H[Math.max(j - 1, 0) * n + i], d = H[Math.min(j + 1, n - 1) * n + i];
    const sx = (r - l) / (2 * res), sz = (d - u) / (2 * res);
    const len = Math.hypot(sx, 1, sz);
    // Licht von -z, 32 Grad hoch, wie im Viewer
    const nl = Math.max(0, (-sx * 0 + 0.53 + -sz * -0.848) / len);
    const e = (H[j * n + i] - lo) / (hi - lo);
    const shade = 0.25 + 0.9 * nl;
    const o = (j * n + i) * 3;
    rgb[o] = Math.min(255, 255 * shade * (0.35 + 0.55 * e));
    rgb[o + 1] = Math.min(255, 255 * shade * (0.38 + 0.5 * e));
    rgb[o + 2] = Math.min(255, 255 * shade * (0.45 + 0.42 * e));
    const ok = Math.hypot(sx, sz) < LIMIT;
    walk[j * n + i] = ok ? 1 : 0;
    if (!ok) steep++;
  }
}
writePng(`${out}/karte_${planet}${seed}.png`, n, n, rgb);
console.log(`Zu steil zum Gehen: ${((100 * steep) / (n * n)).toFixed(1)} %`);

// Zusammenhängende begehbare Gebiete: Kann man von fast überall nach fast überall laufen?
const label = new Int32Array(n * n);
const sizes = [0];
const stack = [];
for (let s = 0; s < n * n; s++) {
  if (!walk[s] || label[s]) continue;
  const id = sizes.length;
  let count = 0;
  label[s] = id;
  stack.push(s);
  while (stack.length) {
    const p = stack.pop();
    count++;
    const i = p % n, j = (p / n) | 0;
    if (i > 0 && walk[p - 1] && !label[p - 1]) { label[p - 1] = id; stack.push(p - 1); }
    if (i < n - 1 && walk[p + 1] && !label[p + 1]) { label[p + 1] = id; stack.push(p + 1); }
    if (j > 0 && walk[p - n] && !label[p - n]) { label[p - n] = id; stack.push(p - n); }
    if (j < n - 1 && walk[p + n] && !label[p + n]) { label[p + n] = id; stack.push(p + n); }
  }
  sizes.push(count);
}
const walkable = n * n - steep;
const biggest = Math.max(...sizes);
console.log(`Begehbare Gebiete: ${sizes.length - 1}, groesstes umfasst ${((100 * biggest) / walkable).toFixed(1)} % der begehbaren Flaeche`);

// Querschnitt durch die Mitte
const w = 1400, h = 320;
const sec = new Uint8Array(w * h * 3).fill(10);
const span = Number(arg('span', 1400));
for (let i = 0; i < w; i++) {
  const v = world.height(cx - span / 2 + (i / w) * span, cz);
  const top = Math.round(h - ((v - lo) / (hi - lo)) * (h - 20) - 10);
  for (let y = Math.max(0, top); y < h; y++) {
    const o = (y * w + i) * 3;
    sec[o] = 70; sec[o + 1] = 76; sec[o + 2] = 86;
  }
}
writePng(`${out}/schnitt_${planet}${seed}.png`, w, h, sec);
