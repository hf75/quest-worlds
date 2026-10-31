// Berechnet die Bodenfenster im Hintergrund. Der Hauptthread bekommt fertige Rechtecke und lädt sie nur noch hoch,
// damit das Bild im Headset nie auf das Gelände warten muss.
import { CLIP_N, CLIP_RES, RAW_HEIGHT_LEVELS, RAW_LIGHT_LEVELS, windowOrigin, type FromWorker, type RectMessage, type ToWorker } from './clips';
import { Caves } from './caves';
import { PLANETS } from './planets';
import { World } from './world';

const N = CLIP_N;
const MASK = N - 1;

// Radien der Horizontsuche je Fenster. Das feinste Fenster übernimmt Verdeckung und Licht vom nächstgröberen.
const RADII = [[], [4, 9, 20, 45, 100, 220, 480], [16, 36, 80, 180, 400, 900], [64, 140, 300, 650, 1400]];
const AO_DIRS = 8;
// Die tief stehende Sonne des Mars braucht eine viel dichtere Suche als die breite Galaxie: Ihre Schatten sind lang und ihre Kante schmal
const SUN_RADII = [[], [3, 6, 10, 15, 22, 32, 46, 66, 95, 135, 190, 270, 380, 540, 760], [16, 24, 36, 54, 80, 120, 180, 270, 400, 600, 900], [64, 96, 144, 216, 320, 480, 720, 1080, 1600]];

interface Level {
  res: number;
  height: Float32Array;
  ao: Uint8Array;
  vis: Uint8Array;
  ox: number;
  oz: number;
  filled: boolean;
}

const levels: Level[] = CLIP_RES.map((res) => ({
  res,
  height: new Float32Array(N * N),
  ao: new Uint8Array(N * N),
  vis: new Uint8Array(N * N),
  ox: 0,
  oz: 0,
  filled: false,
}));

let world: World;
let caves: Caves;
let generation = 0;
// Das Hauptlicht ist je Welt anders breit: Es verschwindet zwischen diesen beiden Höhenwinkeln hinter einer Kante
let keyTanLow = 0;
let keyTanHigh = 1;
let keySun = false;
const rays: { x: number; z: number }[] = [];
const keyRays: { x: number; z: number }[] = [];

const floatView = new Float32Array(1);
const intView = new Int32Array(floatView.buffer);
function toHalf(v: number): number {
  floatView[0] = v;
  const x = intView[0];
  let bits = (x >> 16) & 0x8000;
  let m = (x >> 12) & 0x07ff;
  const e = (x >> 23) & 0xff;
  if (e < 103) return bits;
  if (e > 142) return bits | 0x7c00;
  if (e < 113) {
    m |= 0x0800;
    return bits | ((m >> (114 - e)) + ((m >> (113 - e)) & 1));
  }
  bits |= ((e - 112) << 10) | (m >> 1);
  return bits + (m & 1);
}

function sampleLevel(l: Level, x: number, z: number): number {
  const u = x / l.res, v = z / l.res;
  const i = Math.floor(u), j = Math.floor(v);
  if (!l.filled || i < l.ox || i + 1 >= l.ox + N || j < l.oz || j + 1 >= l.oz + N) return NaN;
  const fx = u - i, fz = v - j;
  const H = l.height;
  const i0 = i & MASK, i1 = (i + 1) & MASK, j0 = (j & MASK) * N, j1 = ((j + 1) & MASK) * N;
  const a = H[j0 + i0], b = H[j0 + i1], c = H[j1 + i0], d = H[j1 + i1];
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

function sampleByte(l: Level, data: Uint8Array, x: number, z: number): number {
  const u = x / l.res, v = z / l.res;
  const i = Math.floor(u), j = Math.floor(v);
  const fx = u - i, fz = v - j;
  const i0 = i & MASK, i1 = (i + 1) & MASK, j0 = (j & MASK) * N, j1 = ((j + 1) & MASK) * N;
  const a = data[j0 + i0], b = data[j0 + i1], c = data[j1 + i0], d = data[j1 + i1];
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

function heightAtIndex(l: Level, i: number, j: number): number {
  if (i >= l.ox && i < l.ox + N && j >= l.oz && j < l.oz + N) return l.height[(j & MASK) * N + (i & MASK)];
  return world.height(i * l.res, j * l.res, undefined, l.res);
}

/**
 * Steigung an einem Texel. Auf einem scharfen Grat heben sich beide Seiten im Mittel auf, die Fläche schiene dort nach oben
 * zu zeigen. Deshalb gilt an Knicken die steilere Seite.
 */
function slopeAcross(before: number, after: number, res: number): number {
  const a = before / res, b = after / res;
  const average = (a + b) / 2;
  const steeper = Math.abs(a) > Math.abs(b) ? a : b;
  return average + (steeper - average) * Math.min(1, Math.abs(a - b));
}

/** Tangens des höchsten Horizonts in einer Richtung. Reicht ein Fenster nicht, übernimmt das nächstgröbere. */
function horizon(index: number, radii: number[], x: number, z: number, h0: number, dx: number, dz: number): number {
  let best = 0;
  for (const r of radii) {
    let q = NaN;
    for (let k = index; k < levels.length && Number.isNaN(q); k++) q = sampleLevel(levels[k], x + dx * r, z + dz * r);
    if (Number.isNaN(q)) break;
    const t = (q - h0) / r;
    if (t > best) best = t;
  }
  return best;
}

function fillHeights(index: number, i0: number, j0: number, w: number, h: number) {
  const l = levels[index];
  const res = l.res;
  for (let j = j0; j < j0 + h; j++) {
    const row = (j & MASK) * N;
    const z = j * res;
    for (let i = i0; i < i0 + w; i++) l.height[row + (i & MASK)] = world.height(i * res, z, undefined, res);
  }
}

function computeRect(index: number, i0: number, j0: number, w: number, h: number) {
  const l = levels[index];
  const res = l.res;

  const heightData = new Uint16Array(w * h * 2);
  const nr = new Uint8Array(w * h * 4);
  const raw = index < RAW_HEIGHT_LEVELS ? new Float32Array(w * h) : null;
  const light = index < RAW_LIGHT_LEVELS ? new Uint8Array(w * h * 2) : null;
  const radii = RADII[index];
  const finer = index === 0 ? levels[1] : null;

  for (let j = 0; j < h; j++) {
    const wj = j0 + j;
    const z = wj * res;
    for (let i = 0; i < w; i++) {
      const wi = i0 + i;
      const x = wi * res;
      const v = l.height[(wj & MASK) * N + (wi & MASK)];
      const o = j * w + i;

      const hi = 16 * Math.round(v / 16);
      heightData[o * 2] = toHalf(hi);
      heightData[o * 2 + 1] = toHalf(v - hi);
      if (raw) raw[o] = v;

      const sx = slopeAcross(v - heightAtIndex(l, wi - 1, wj), heightAtIndex(l, wi + 1, wj) - v, res);
      const sz = slopeAcross(v - heightAtIndex(l, wi, wj - 1), heightAtIndex(l, wi, wj + 1) - v, res);
      const len = Math.sqrt(sx * sx + sz * sz + 1);
      nr[o * 4] = Math.round((-sx / len) * 127.5 + 127.5);
      nr[o * 4 + 1] = Math.round((-sz / len) * 127.5 + 127.5);

      let ao: number, vis: number;
      if (finer) {
        ao = sampleByte(finer, finer.ao, x, z);
        vis = sampleByte(finer, finer.vis, x, z);
      } else {
        let sum = 0, keyTan = 0;
        for (let k = 0; k < AO_DIRS; k++) {
          const t = horizon(index, radii, x, z, v, rays[k].x, rays[k].z);
          sum += 1 / (1 + t * t);
          if (k === 0) keyTan = t;
        }
        ao = (255 * sum) / AO_DIRS;
        const band = (t: number) => Math.max(0, Math.min(1, (keyTanHigh - t) / (keyTanHigh - keyTanLow)));
        const keyRadii = keySun ? SUN_RADII[index] : radii;
        const a = horizon(index, keyRadii, x, z, v, keyRays[0].x, keyRays[0].z);
        const b = horizon(index, keyRadii, x, z, v, keyRays[1].x, keyRays[1].z);
        if (keySun) keyTan = horizon(index, keyRadii, x, z, v, rays[0].x, rays[0].z);
        vis = (255 * (band(a) + band(keyTan) + band(b))) / 3;
        l.ao[(wj & MASK) * N + (wi & MASK)] = ao;
        l.vis[(wj & MASK) * N + (wi & MASK)] = vis;
      }
      nr[o * 4 + 2] = ao;
      nr[o * 4 + 3] = vis;
      if (light) {
        light[o * 2] = ao;
        light[o * 2 + 1] = vis;
      }
    }
  }

  const message: RectMessage = {
    type: 'rect', generation, level: index, tx: i0 & MASK, tz: j0 & MASK, w, h, height: heightData, nr, raw, light,
  };
  const transfer: ArrayBuffer[] = [heightData.buffer, nr.buffer];
  if (raw) transfer.push(raw.buffer);
  if (light) transfer.push(light.buffer);
  post(message, transfer);
}

/** Teilt ein Rechteck an den Texturrändern. So muss der Hauptthread beim Hochladen nichts umbrechen. */
function eachRect(i0: number, j0: number, w: number, h: number, visit: (i: number, j: number, w: number, h: number) => void) {
  let j = j0, remainingH = h;
  while (remainingH > 0) {
    const stepH = Math.min(remainingH, N - (j & MASK));
    let i = i0, remainingW = w;
    while (remainingW > 0) {
      const stepW = Math.min(remainingW, N - (i & MASK));
      visit(i, j, stepW, stepH);
      i += stepW;
      remainingW -= stepW;
    }
    j += stepH;
    remainingH -= stepH;
  }
}

/** Erst alle neuen Höhen, dann erst Normalen, Verdeckung und Licht: Die schauen weit über ihr eigenes Rechteck hinaus. */
function computeStrips(index: number, strips: [number, number, number, number][]) {
  for (const [i, j, w, h] of strips) eachRect(i, j, w, h, (a, b, c, d) => fillHeights(index, a, b, c, d));
  for (const [i, j, w, h] of strips) eachRect(i, j, w, h, (a, b, c, d) => computeRect(index, a, b, c, d));
}

function moveLevel(index: number, x: number, z: number) {
  const l = levels[index];
  const nx = windowOrigin(x, l.res), nz = windowOrigin(z, l.res);
  if (l.filled && nx === l.ox && nz === l.oz) return;
  const dx = nx - l.ox, dz = nz - l.oz;
  const ox = l.ox, oz = l.oz;
  const whole = !l.filled || Math.abs(dx) >= N || Math.abs(dz) >= N;
  l.ox = nx;
  l.oz = nz;
  if (whole) {
    computeStrips(index, [[nx, nz, N, N]]);
    l.filled = true;
    return;
  }
  // Neue Spalten über die ganze Höhe, neue Zeilen nur noch über die alte Breite
  const strips: [number, number, number, number][] = [];
  if (dx > 0) strips.push([ox + N, nz, dx, N]);
  else if (dx < 0) strips.push([nx, nz, -dx, N]);
  const keepI = Math.max(ox, nx), keepW = N - Math.abs(dx);
  if (dz > 0) strips.push([keepI, oz + N, keepW, dz]);
  else if (dz < 0) strips.push([keepI, nz, keepW, -dz]);
  computeStrips(index, strips);
}

function post(message: FromWorker, transfer: ArrayBuffer[] = []) {
  (self as unknown as Worker).postMessage(message, transfer);
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === 'init') {
    const t0 = performance.now();
    generation = message.generation;
    world = new World(message.seed, message.planet);
    caves = new Caves(world);
    const key = PLANETS[message.planet].key;
    keyTanLow = Math.tan((key.fadeFrom * Math.PI) / 180);
    keyTanHigh = Math.tan((key.fadeTo * Math.PI) / 180);
    keySun = message.planet === 'mars';
    const keySpread = (key.spread * Math.PI) / 180;
    rays.length = 0;
    keyRays.length = 0;
    for (let k = 0; k < AO_DIRS; k++) {
      const a = message.keyAzimuth + (k * Math.PI * 2) / AO_DIRS;
      rays.push({ x: Math.cos(a), z: Math.sin(a) });
    }
    for (const a of [message.keyAzimuth - keySpread, message.keyAzimuth + keySpread]) keyRays.push({ x: Math.cos(a), z: Math.sin(a) });
    // Am liebsten mit einer Höhle in Sichtweite: Sie soll man finden, ohne lange zu suchen
    const start = message.at ?? world.findStart(Math.cos(message.keyAzimuth), Math.sin(message.keyAzimuth), (x, z) => {
      const near = caves.nearestMouth(x, z);
      return near && near.distance > 35 && near.distance < 170 ? 1 : 0;
    });
    post({ type: 'start', generation, x: start.x, z: start.z });
    for (const l of levels) l.filled = false;
    // Von grob nach fein, denn die feineren Fenster schauen für ihren Horizont in die gröberen
    for (let k = levels.length - 1; k >= 0; k--) {
      moveLevel(k, start.x, start.z);
      post({ type: 'progress', generation, fraction: (levels.length - k) / levels.length });
    }
    post({ type: 'ready', generation, ms: performance.now() - t0 });
  } else if (message.type === 'move' && message.generation === generation) {
    for (let k = levels.length - 1; k >= 0; k--) moveLevel(k, message.x, message.z);
    if (message.ack !== undefined) post({ type: 'settled', generation, ack: message.ack });
  }
};
