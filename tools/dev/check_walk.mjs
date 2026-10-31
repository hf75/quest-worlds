// Prüft mehrere Welten: Findet sich ein Start? Kommt man von dort weit genug, ohne an Wänden festzusitzen?
//   node tools/dev/check_walk.mjs [--seeds 12] [--size 4000] [--res 2]
import { World } from '../../src/world.ts';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const planetAt = process.argv.indexOf('--planet');
const planet = planetAt >= 0 ? process.argv[planetAt + 1] : 'slate';
const SEEDS = arg('seeds', 12);
const size = arg('size', 4000);
const res = arg('res', 2);
const LIMIT = 1.19; // wie WALK_LIMIT im Viewer
// Licht aus -z, wie im Viewer
const KEY = { x: 0, z: -1 };

const n = Math.round(size / res);
let worstReach = Infinity;
for (let seed = 1; seed <= SEEDS; seed++) {
  const world = new World(seed, planet);
  const t0 = performance.now();
  const start = world.findStart(KEY.x, KEY.z);
  const startMs = performance.now() - t0;
  const H = new Float32Array(n * n);
  const cx = start.x, cz = start.z;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) H[j * n + i] = world.height(cx + (i - n / 2) * res, cz + (j - n / 2) * res);
  const walk = new Uint8Array(n * n);
  let plateau = 0;
  const info = { distance: 0, wall: 0, cut: 0, tangentX: 0, tangentZ: 0 };
  const plateauMask = new Uint8Array(n * n);
  for (let j = 1; j < n - 1; j++) {
    for (let i = 1; i < n - 1; i++) {
      const o = j * n + i;
      const sx = (H[o + 1] - H[o - 1]) / (2 * res), sz = (H[o + n] - H[o - n]) / (2 * res);
      if (Math.hypot(sx, sz) <= LIMIT) walk[o] = 1;
    }
  }
  for (let j = 0; j < n; j += 8) {
    for (let i = 0; i < n; i += 8) {
      world.height(cx + (i - n / 2) * res, cz + (j - n / 2) * res, info);
      if (info.wall >= 1 && info.cut > 60) {
        plateauMask[j * n + i] = 1;
        plateau++;
      }
    }
  }
  // Füllung vom Start aus
  const seen = new Uint8Array(n * n);
  const stack = [(n >> 1) * n + (n >> 1)];
  seen[stack[0]] = 1;
  let reached = 0, border = false, reachedPlateau = 0, far = 0;
  while (stack.length) {
    const p = stack.pop();
    reached++;
    const i = p % n, j = (p / n) | 0;
    far = Math.max(far, Math.hypot(i - n / 2, j - n / 2) * res);
    if (plateauMask[p]) reachedPlateau++;
    if (i <= 1 || j <= 1 || i >= n - 2 || j >= n - 2) border = true;
    for (const q of [p - 1, p + 1, p - n, p + n]) {
      if (q >= 0 && q < n * n && walk[q] && !seen[q]) {
        seen[q] = 1;
        stack.push(q);
      }
    }
  }
  let walkable = 0;
  for (const v of walk) walkable += v;
  const flatAt = world.height(start.x, start.z, info);
  console.log(
    `Seed ${String(seed).padStart(2)}: Start (${start.x}, ${start.z}) in ${startMs.toFixed(0)} ms, Tiefe ${info.cut.toFixed(0)} m, Hoehe ${flatAt.toFixed(0)} m | ` +
      `erreichbar ${((reached * res * res) / 1e6).toFixed(2)} km2 = ${((100 * reached) / walkable).toFixed(0)} % des Begehbaren, ` +
      `bis ${far.toFixed(0)} m weit, Rand ${border ? 'ja' : 'NEIN'}, Hochebene ${plateau ? ((100 * reachedPlateau) / plateau).toFixed(0) : '-'} %`,
  );
  worstReach = Math.min(worstReach, far);
}
console.log(`Kleinste Reichweite: ${worstReach.toFixed(0)} m`);
