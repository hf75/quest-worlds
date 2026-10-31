// Prüft die Höhlen ohne Browser: Wie viele gibt es, wie lang sind sie, was kostet das Vernetzen, und kommt man hindurch?
//   node tools/dev/check_caves.mjs [--seeds 6]
import './resolve-ts.mjs';

const { CAVE_CELL, Caves } = await import('../../src/caves.ts');
const { chunksOf, meshChunk } = await import('../../src/caveMesh.ts');
const { World } = await import('../../src/world.ts');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const SEEDS = arg('seeds', 6);

for (let seed = 1; seed <= SEEDS; seed++) {
  const planetAt = process.argv.indexOf('--planet');
  const world = new World(seed, planetAt >= 0 ? process.argv[planetAt + 1] : 'slate');
  const caves = new Caves(world);
  const t0 = performance.now();
  const systems = [];
  const CELLS = 4;
  for (let j = -CELLS; j < CELLS; j++) for (let i = -CELLS; i < CELLS; i++) {
    const s = caves.systemInCell(i, j);
    if (s) systems.push(s);
  }
  const buildMs = (performance.now() - t0) / (4 * CELLS * CELLS);
  const area = ((2 * CELLS * CAVE_CELL) / 1000) ** 2;
  console.log(`Seed ${seed}: ${systems.length} Hoehlen auf ${area.toFixed(0)} km2, ${buildMs.toFixed(1)} ms je Zelle`);
  if (!systems.length) continue;

  // Eine genauer ansehen: die längste
  const s = systems.reduce((a, b) => (a.length > b.length ? a : b));
  const { mouth, tube } = chunksOf(caves, s);
  const t1 = performance.now();
  let tris = 0, built = 0, verts = 0, worst = 0, surfaceTris = 0;
  for (const [ix, iy, iz] of mouth.values()) {
    const t = performance.now();
    const m = meshChunk(caves, s, ix, iy, iz, true);
    worst = Math.max(worst, performance.now() - t);
    if (m) {
      built++;
      surfaceTris += m.index.length / 3;
      verts += m.position.length / 3;
    }
  }
  const t2 = performance.now();
  for (const [ix, iy, iz] of tube.values()) {
    const t = performance.now();
    const m = meshChunk(caves, s, ix, iy, iz, false);
    worst = Math.max(worst, performance.now() - t);
    if (m) {
      built++;
      tris += m.index.length / 3;
      verts += m.position.length / 3;
    }
  }
  const t3 = performance.now();
  console.log(
    `  laengste: ${s.length.toFixed(0)} m, ${s.segments.length} Stuecke, ${s.rooms} Hallen-Punkte | Wuerfel Mundloch ${mouth.size} (${(t2 - t1).toFixed(0)} ms), Gang ${tube.size} (${(t3 - t2).toFixed(0)} ms), gefuellt ${built} | ` +
      `Dreiecke Mundloch ${surfaceTris}, Gang ${tris} | je Wuerfel ${((t3 - t1) / (mouth.size + tube.size)).toFixed(1)} ms, schlimmster ${worst.toFixed(0)} ms`,
  );

  // Kommt man den Gang entlang? Prüft die Mittellinie auf Luft in Körperhöhe und auf Stufen.
  const m = s.mouth;
  let blocked = 0, steps = 0, maxStep = 0, lowCeiling = 0;
  for (const g of s.segments) {
    const length = 1 / Math.sqrt(g.invLen2);
    let last = NaN;
    for (let t = 0; t <= length; t += 0.5) {
      const u = t / length;
      const x = g.ax + g.ex * u, z = g.az + g.ez * u;
      caves.setFocus(x, z);
      const floor = caves.floorAt(x, z);
      if (Number.isNaN(floor)) {
        blocked++;
        continue;
      }
      steps++;
      if (caves.air(x, floor + 1, z) < 0.2 && g.s > 2) blocked++;
      if (caves.air(x, floor + 1.8, z) < 0.05 && g.s > 2) lowCeiling++;
      if (!Number.isNaN(last)) maxStep = Math.max(maxStep, Math.abs(floor - last));
      last = floor;
    }
  }
  console.log(`  Mundloch bei (${m.ax.toFixed(0)}, ${m.az.toFixed(0)}), Radius ${m.radius.toFixed(1)} | Probe auf der Mittellinie: ${steps} Stellen, blockiert ${blocked}, zu niedrig ${lowCeiling}, groesste Stufe ${maxStep.toFixed(2)} m`);
}
