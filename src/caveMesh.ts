// Macht aus dem Gang Dreiecke: Naive Surface Nets auf einem 0,5-m-Raster, in Würfeln von 16 m. Ein Punkt je Zelle, Vierecke
// über die Kanten mit Vorzeichenwechsel. Benachbarte Würfel passen fugenlos, weil sie dieselben Werte auswerten.
import { PATCH_DIP, PATCH_OVERLAP, segmentDistance, type Caves, type CaveSegment, type CaveSystem } from './caves';

export const CHUNK_CELLS = 32;
export const VOXEL = 0.5;
export const CHUNK_SIZE = CHUNK_CELLS * VOXEL;

export interface ChunkMesh {
  position: Float32Array<ArrayBuffer>;
  normal: Int8Array<ArrayBuffer>;
  /** Verdeckung und Tageslicht je Punkt */
  light: Uint8Array<ArrayBuffer>;
  index: Uint32Array<ArrayBuffer>;
  center: [number, number, number];
  radius: number;
}

/** Welche Würfel braucht ein Höhlensystem? Die mit dem Mundloch sind schon von Weitem zu sehen, die anderen nur von Nahem. */
export function chunksOf(caves: Caves, system: CaveSystem): { mouth: Map<string, [number, number, number]>; tube: Map<string, [number, number, number]> } {
  const mouth = new Map<string, [number, number, number]>();
  const tube = new Map<string, [number, number, number]>();
  const mark = (target: Map<string, [number, number, number]>, x: number, y: number, z: number) => {
    const ix = Math.floor(x / CHUNK_SIZE), iy = Math.floor(y / CHUNK_SIZE), iz = Math.floor(z / CHUNK_SIZE);
    target.set(`${ix},${iy},${iz}`, [ix, iy, iz]);
  };

  // Die Wände sind rau, deshalb etwas Spielraum um den glatten Gang
  const pad = 3.5;
  for (const g of system.segments) {
    const length = 1 / Math.sqrt(g.invLen2);
    const steps = Math.ceil(length / 6);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = g.ax + g.ex * t, cz = g.az + g.ez * t;
      const r = g.r + g.dr * t + pad;
      const bottom = g.floor + g.dFloor * t - 1, top = bottom + 2 + g.height + g.dHeight * t + pad;
      for (let a = -r; a <= r + 0.01; a += Math.min(r, 8)) {
        for (let b = -r; b <= r + 0.01; b += Math.min(r, 8)) {
          for (let y = bottom; y <= top + 0.01; y += 8) mark(tube, cx + a, y, cz + b);
          mark(tube, cx + a, top, cz + b);
        }
      }
    }
  }

  // Das Stück Oberfläche über dem Mundloch: so hoch und so tief, wie der Boden dort eben liegt
  const m = system.mouth;
  const reach = m.radius + PATCH_OVERLAP + 1;
  const x0 = Math.min(m.ax, m.bx) - reach, x1 = Math.max(m.ax, m.bx) + reach;
  const z0 = Math.min(m.az, m.bz) - reach, z1 = Math.max(m.az, m.bz) + reach;
  for (let x = x0; x <= x1 + 0.01; x += 2) {
    for (let z = z0; z <= z1 + 0.01; z += 2) {
      if (caves.mouthDistance(system, x, z) > reach) continue;
      const h = caves.world.height(x, z);
      for (let y = h - 3; y <= h + 3.01; y += 3) mark(mouth, x, y, z);
    }
  }
  for (const key of mouth.keys()) tube.delete(key);
  return { mouth, tube };
}

export function meshChunk(caves: Caves, system: CaveSystem, ix: number, iy: number, iz: number, hasSurface: boolean): ChunkMesh | null {
  const s = CHUNK_CELLS + 3;
  const ox = ix * CHUNK_SIZE - VOXEL, oy = iy * CHUNK_SIZE - VOXEL, oz = iz * CHUNK_SIZE - VOXEL;
  const cx = ox + VOXEL + CHUNK_SIZE / 2, cz = oz + VOXEL + CHUNK_SIZE / 2;

  const segments: CaveSegment[] = system.segments.filter((g) => segmentDistance(g, cx, cz) < g.r + Math.abs(g.dr) + CHUNK_SIZE + 16);

  // Über dem Boden ist Luft. Das gilt aber nur für die Würfel am Mundloch, alle anderen liegen tief im Fels.
  const ground = hasSurface ? new Float32Array(s * s) : null;
  if (ground) {
    for (let k = 0; k < s; k++) {
      for (let i = 0; i < s; i++) {
        const x = ox + i * VOXEL, z = oz + k * VOXEL;
        // Zum Außenrand hin taucht das Stück unter den Boden ab
        const t = Math.min(1, Math.max(0, (caves.mouthDistance(system, x, z) - system.mouth.radius) / PATCH_OVERLAP * 2 - 1));
        ground[k * s + i] = caves.world.height(x, z) - PATCH_DIP * t * t * (3 - 2 * t);
      }
    }
  }

  const field = new Float32Array(s * s * s);
  const surfaceWins = hasSurface ? new Uint8Array(s * s * s) : null;
  let anyAir = false, anySolid = false;
  let o = 0;
  for (let k = 0; k < s; k++) {
    const z = oz + k * VOXEL;
    for (let j = 0; j < s; j++) {
      const y = oy + j * VOXEL;
      for (let i = 0; i < s; i++) {
        const x = ox + i * VOXEL;
        let v = segments.length ? caves.tube(segments, x, y, z) : -1e3;
        if (ground) {
          const above = y - ground[k * s + i];
          if (above > v) {
            v = above;
            surfaceWins![o] = 1;
          }
        }
        field[o++] = v;
        if (v < 0) anySolid = true;
        else anyAir = true;
      }
    }
  }
  if (!anyAir || !anySolid) return null;

  const at = (i: number, j: number, k: number) => i + j * s + k * s * s;

  // Ein Punkt je Zelle mit Vorzeichenwechsel, in der Mitte der Durchstoßpunkte
  const cellIndex = new Int32Array(s * s * s).fill(-1);
  const px: number[] = [], nx: number[] = [];
  for (let k = 0; k < s - 1; k++) {
    for (let j = 0; j < s - 1; j++) {
      for (let i = 0; i < s - 1; i++) {
        const b = at(i, j, k);
        const c000 = field[b], c100 = field[b + 1], c010 = field[b + s], c110 = field[b + s + 1];
        const c001 = field[b + s * s], c101 = field[b + s * s + 1], c011 = field[b + s + s * s], c111 = field[b + s + s * s + 1];
        const neg = (c000 < 0 ? 1 : 0) + (c100 < 0 ? 1 : 0) + (c010 < 0 ? 1 : 0) + (c110 < 0 ? 1 : 0) + (c001 < 0 ? 1 : 0) + (c101 < 0 ? 1 : 0) + (c011 < 0 ? 1 : 0) + (c111 < 0 ? 1 : 0);
        if (neg === 0 || neg === 8) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        const edge = (v0: number, v1: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
          if (v0 < 0 === v1 < 0) return;
          const t = v0 / (v0 - v1);
          sx += x0 + (x1 - x0) * t;
          sy += y0 + (y1 - y0) * t;
          sz += z0 + (z1 - z0) * t;
          n++;
        };
        edge(c000, c100, 0, 0, 0, 1, 0, 0);
        edge(c010, c110, 0, 1, 0, 1, 1, 0);
        edge(c001, c101, 0, 0, 1, 1, 0, 1);
        edge(c011, c111, 0, 1, 1, 1, 1, 1);
        edge(c000, c010, 0, 0, 0, 0, 1, 0);
        edge(c100, c110, 1, 0, 0, 1, 1, 0);
        edge(c001, c011, 0, 0, 1, 0, 1, 1);
        edge(c101, c111, 1, 0, 1, 1, 1, 1);
        edge(c000, c001, 0, 0, 0, 0, 0, 1);
        edge(c100, c101, 1, 0, 0, 1, 0, 1);
        edge(c010, c011, 0, 1, 0, 0, 1, 1);
        edge(c110, c111, 1, 1, 0, 1, 1, 1);
        cellIndex[b] = px.length / 3;
        px.push(ox + (i + sx / n) * VOXEL, oy + (j + sy / n) * VOXEL, oz + (k + sz / n) * VOXEL);
        // Die Normale zeigt in die Luft: dorthin, wo der Wert steigt
        const gx = c100 + c110 + c101 + c111 - c000 - c010 - c001 - c011;
        const gy = c010 + c110 + c011 + c111 - c000 - c100 - c001 - c101;
        const gz = c001 + c101 + c011 + c111 - c000 - c100 - c010 - c110;
        const len = Math.hypot(gx, gy, gz) || 1;
        nx.push(gx / len, gy / len, gz / len);
      }
    }
  }

  // Vierecke über die Kanten. Dieser Würfel besitzt jede Kante, deren unteres Ende in ihm liegt.
  const quads: number[] = [];
  const outer = new Set<number>();
  const keepSurface = (p: number) => {
    // Von der Oberfläche bleibt nur das Stück ums Mundloch. Daneben liegt ja schon der normale Boden.
    const vx = px[p * 3], vz = px[p * 3 + 2];
    return caves.mouthDistance(system, vx, vz) < system.mouth.radius + PATCH_OVERLAP;
  };
  const add = (a: number, b: number, c: number, d: number, lowerSolid: boolean, flip: boolean, isSurface: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (isSurface && !(keepSurface(a) && keepSurface(b) && keepSurface(c) && keepSurface(d))) return;
    if (lowerSolid !== flip) quads.push(a, b, c, a, c, d);
    else quads.push(a, c, b, a, d, c);
    if (isSurface) {
      outer.add(a);
      outer.add(b);
      outer.add(c);
      outer.add(d);
    }
  };
  for (let k = 1; k <= CHUNK_CELLS; k++) {
    for (let j = 1; j <= CHUNK_CELLS; j++) {
      for (let i = 1; i <= CHUNK_CELLS; i++) {
        const b = at(i, j, k);
        const v = field[b];
        const solid = v < 0;
        const surf = (other: number) => !!surfaceWins && (surfaceWins[b] === 1 || surfaceWins[other] === 1);
        if (solid !== field[b + 1] < 0) add(cellIndex[at(i, j - 1, k - 1)], cellIndex[at(i, j, k - 1)], cellIndex[b], cellIndex[at(i, j - 1, k)], solid, false, surf(b + 1));
        if (solid !== field[b + s] < 0) add(cellIndex[at(i - 1, j, k - 1)], cellIndex[at(i, j, k - 1)], cellIndex[b], cellIndex[at(i - 1, j, k)], solid, true, surf(b + s));
        if (solid !== field[b + s * s] < 0) add(cellIndex[at(i - 1, j - 1, k)], cellIndex[at(i, j - 1, k)], cellIndex[b], cellIndex[at(i - 1, j, k)], solid, false, surf(b + s * s));
      }
    }
  }
  if (!quads.length) return null;

  // Nur die Punkte behalten, die ein Dreieck wirklich benutzt
  const remap = new Int32Array(px.length / 3).fill(-1);
  let used = 0;
  for (const q of quads) if (remap[q] < 0) remap[q] = used++;
  const position = new Float32Array(used * 3);
  const normal = new Int8Array(used * 4);
  const light = new Uint8Array(used * 2);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let p = 0; p < remap.length; p++) {
    const q = remap[p];
    if (q < 0) continue;
    const x = px[p * 3], y = px[p * 3 + 1], z = px[p * 3 + 2];
    position[q * 3] = x;
    position[q * 3 + 1] = y;
    position[q * 3 + 2] = z;
    const a = nx[p * 3], b = nx[p * 3 + 1], c = nx[p * 3 + 2];
    normal[q * 4] = Math.round(a * 127);
    normal[q * 4 + 1] = Math.round(b * 127);
    normal[q * 4 + 2] = Math.round(c * 127);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);

    if (outer.has(p) || !segments.length) {
      light[q * 2] = 255;
      light[q * 2 + 1] = 255;
      continue;
    }
    // Verdeckung: Wie schnell wird es entlang der Normalen frei? Die Offenheit ist ungefähr der Abstand zur nächsten Wand.
    let occlusion = 0;
    for (const d of [1.2, 2.8, 6]) {
      const open = caves.coarse(segments, x + a * d, y + b * d, z + c * d);
      occlusion += Math.max(0, Math.min(1, (d - Math.min(open, y + b * d - caves.lastFloor)) / d)) / 3;
    }
    light[q * 2] = Math.round(255 * (1 - 0.78 * occlusion));
    // Tageslicht: Es nimmt mit dem Weg vom Mundloch ab, nach wenigen Biegungen ist es fort
    caves.coarse(segments, x, y, z);
    light[q * 2 + 1] = Math.round(255 * Math.exp(-Math.max(0, caves.lastPathS) / 15));
  }
  const index = new Uint32Array(quads.length);
  for (let i = 0; i < quads.length; i++) index[i] = remap[quads[i]];
  return {
    position,
    normal,
    light,
    index,
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    radius: Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2,
  };
}
