// Höhlen als Inseln im Höhenfeld: Der Boden bleibt, wie er ist, nur am Mundloch wird er ausgestanzt und durch ein
// vernetztes Stück ersetzt. Der Verlauf folgt wie alles andere aus dem Seed. Diese Datei läuft im Worker, im Hauptthread
// und unter Node.
import { mulberry, type World, type WorldInfo } from './world';

/** Jede Zelle dieser Größe hat höchstens ein Höhlensystem, und es bleibt in seiner Zelle. So genügt immer eine Abfrage. */
export const CAVE_CELL = 700;
const CELL_MARGIN = 70;
const CAVE_CHANCE = 0.8;
// So viel Fels muss mindestens über dem Gang bleiben, sonst bricht er an der Oberfläche durch
const ROOF_ROCK = 9;
/** So weit reicht das Stück Oberfläche um das Mundloch über das Loch im Boden hinaus. Es überlappt den Boden und schließt die Fuge. */
export const PATCH_OVERLAP = 3;
/**
 * Beide Flächen sind nur von oben sichtbar. Dicht ist die Fuge deshalb nur, wenn sie sich durchdringen: Am Lochrand sinkt der Boden
 * unter das Stück, an dessen Außenrand sinkt das Stück unter den Boden. So tief, dass auch die Schieferplatten sie nicht umkehren.
 */
export const PATCH_DIP = 1.2;

export interface CaveSegment {
  ax: number;
  az: number;
  ex: number;
  ez: number;
  invLen2: number;
  // Je Anfang und Änderung bis zum Ende: Halbbreite, Sohle, lichte Höhe, Weglänge vom Mundloch
  r: number;
  dr: number;
  floor: number;
  dFloor: number;
  height: number;
  dHeight: number;
  s: number;
  dS: number;
}

export interface CaveMouth {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  radius: number;
  /** Blickrichtung hinein */
  inX: number;
  inZ: number;
  /** Sohle am Mundloch */
  floor: number;
}

export interface CaveSystem {
  cellX: number;
  cellZ: number;
  segments: CaveSegment[];
  mouth: CaveMouth;
  length: number;
  rooms: number;
}

interface Node {
  x: number;
  z: number;
  r: number;
  floor: number;
  height: number;
  s: number;
}

function capsuleDistance(m: CaveMouth, x: number, z: number): number {
  const ex = m.bx - m.ax, ez = m.bz - m.az;
  const t = Math.max(0, Math.min(1, ((x - m.ax) * ex + (z - m.az) * ez) / (ex * ex + ez * ez || 1)));
  return Math.hypot(x - m.ax - ex * t, z - m.az - ez * t);
}

/** Gradientenrauschen in drei Richtungen, nur für die Höhlenwände: Das Höhenfeld kommt mit zwei aus. */
class Noise3 {
  private readonly perm = new Uint8Array(512);

  constructor(random: () => number) {
    const t = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const v = t[i];
      t[i] = t[j];
      t[j] = v;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = t[i & 255];
  }

  at(x: number, y: number, z: number): number {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const fx = x - xi, fy = y - yi, fz = z - zi;
    const X = xi & 255, Y = yi & 255, Z = zi & 255;
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const w = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
    const p = this.perm;
    const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z, B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
    const g = Noise3.grad;
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    return lerp(
      lerp(
        lerp(g(p[AA], fx, fy, fz), g(p[BA], fx - 1, fy, fz), u),
        lerp(g(p[AB], fx, fy - 1, fz), g(p[BB], fx - 1, fy - 1, fz), u),
        v,
      ),
      lerp(
        lerp(g(p[AA + 1], fx, fy, fz - 1), g(p[BA + 1], fx - 1, fy, fz - 1), u),
        lerp(g(p[AB + 1], fx, fy - 1, fz - 1), g(p[BB + 1], fx - 1, fy - 1, fz - 1), u),
        v,
      ),
      w,
    );
  }

  private static grad(h: number, x: number, y: number, z: number): number {
    h &= 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return (h & 1 ? -u : u) + (h & 2 ? -v : v);
  }
}

export class Caves {
  readonly world: World;
  private readonly noise: Noise3;
  private readonly cells = new Map<number, CaveSystem | null>();
  private lastKey = NaN;
  private lastSystem: CaveSystem | null = null;
  private focus: CaveSegment[] = [];
  private focusX = Infinity;
  private focusZ = Infinity;
  // Ergebnis der letzten Auswertung, ohne bei jedem Punkt ein Objekt anzulegen
  private hitFloor = 0;
  private hitS = 0;
  private hitR = 0;

  constructor(world: World) {
    this.world = world;
    this.noise = new Noise3(mulberry(world.seed ^ 0x3c6ef372));
  }

  systemInCell(cx: number, cz: number): CaveSystem | null {
    const key = (cx + 32768) * 65536 + (cz + 32768);
    if (key === this.lastKey) return this.lastSystem;
    let system = this.cells.get(key);
    if (system === undefined) {
      system = this.build(cx, cz);
      this.cells.set(key, system);
    }
    this.lastKey = key;
    this.lastSystem = system;
    return system;
  }

  systemAt(x: number, z: number): CaveSystem | null {
    return this.systemInCell(Math.floor(x / CAVE_CELL), Math.floor(z / CAVE_CELL));
  }

  /** Das nächste Mundloch in dieser und den umliegenden Zellen, wahlweise ohne die allernächsten. */
  nearestMouth(x: number, z: number, atLeast = 0): { mouth: CaveMouth; distance: number } | null {
    const cx = Math.floor(x / CAVE_CELL), cz = Math.floor(z / CAVE_CELL);
    let best: { mouth: CaveMouth; distance: number } | null = null;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const s = this.systemInCell(cx + i, cz + j);
        if (!s) continue;
        const d = Math.hypot(s.mouth.ax - x, s.mouth.az - z);
        if (d >= atLeast && (!best || d < best.distance)) best = { mouth: s.mouth, distance: d };
      }
    }
    return best;
  }

  /** Liegt der Punkt im Bereich des Mundlochs? Dort gehören keine Felsen hin. */
  inMouth(x: number, z: number, extra: number): boolean {
    const system = this.systemAt(x, z);
    return !!system && capsuleDistance(system.mouth, x, z) < system.mouth.radius + extra;
  }

  mouthDistance(system: CaveSystem, x: number, z: number): number {
    return capsuleDistance(system.mouth, x, z);
  }

  /**
   * Offenheit eines Punkts im Gang: positiv ist Luft, negativ Fels, der Betrag ungefähr der Abstand zur Wand. Ohne Rauschen und
   * Sohle. Die Ergebnisse stehen danach in hitFloor, hitS und hitR.
   */
  coarse(segments: CaveSegment[], x: number, y: number, z: number): number {
    let best = -1e9, bestRaw = -1e9;
    for (let i = 0; i < segments.length; i++) {
      const g = segments[i];
      const px = x - g.ax, pz = z - g.az;
      let t = (px * g.ex + pz * g.ez) * g.invLen2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = px - g.ex * t, qz = pz - g.ez * t;
      const h = Math.sqrt(qx * qx + qz * qz);
      const r = g.r + g.dr * t, floor = g.floor + g.dFloor * t, height = g.height + g.dHeight * t;
      const top = floor + height;
      let a: number;
      if (y >= top) a = top - y - h;
      else {
        // Unten senkrechte Wände, darüber ein flacher Bogen
        const q = Math.max(0, ((y - floor) / height - 0.25) / 0.75);
        a = r * Math.sqrt(1 - q * q) - h;
        if (a > top - y) a = top - y;
      }
      if (a > bestRaw) {
        bestRaw = a;
        this.hitFloor = floor;
        this.hitS = g.s + g.dS * t;
        this.hitR = r;
      }
      // Weiche Vereinigung, sonst läge an jedem Knick des Gangs eine Kante
      const k = 2.5;
      const m = Math.max(k - Math.abs(a - best), 0) / k;
      best = Math.max(a, best) + m * m * k * 0.25;
    }
    return best;
  }

  private floorBump(x: number, z: number): number {
    return 0.22 * this.noise.at(x / 2.7, 7.3, z / 2.7);
  }

  /** Dasselbe mit rauen Wänden, Gesteinsbänken, Klüften und der Sohle: die endgültige Form des Gangs. */
  tube(segments: CaveSegment[], x: number, y: number, z: number): number {
    let a = this.coarse(segments, x, y, z);
    const floor = this.hitFloor + this.floorBump(x, z);
    const rough = Math.min(2.8, 0.2 * this.hitR + 0.5);
    if (a > -rough - 2.5 && a < rough + 2.5) {
      const n = this.noise;
      const sz = 3.5 + this.hitR * 0.35;
      a += rough * (n.at(x / sz, (y / sz) * 1.7, z / sz) + 0.5 * n.at((x / sz) * 2.3 + 11, (y / sz) * 3.4, (z / sz) * 2.3 + 5));
      a += this.world.bedOffset(y, x, z) + 0.6 * this.world.joints(x, z, 5.5, 8);
    }
    return Math.min(a, y - floor);
  }

  /** Stellt die Abfragen für den Gehenden auf die Gangstücke in der Nähe ein. Mehr als ein paar braucht es nie. */
  setFocus(x: number, z: number) {
    if (Math.abs(x - this.focusX) < 5 && Math.abs(z - this.focusZ) < 5) return;
    this.focusX = x;
    this.focusZ = z;
    const system = this.systemAt(x, z);
    this.focus = system ? system.segments.filter((g) => segmentDistance(g, x, z) < g.r + Math.abs(g.dr) + 34) : [];
  }

  /** Offenheit an einem Punkt nahe beim Fokus, mit der endgültigen Form. */
  air(x: number, y: number, z: number): number {
    return this.focus.length ? this.tube(this.focus, x, y, z) : -1e9;
  }

  /** Höhlensohle unter dem Punkt oder NaN, wenn er waagerecht nicht in einem Gang liegt. */
  floorAt(x: number, z: number): number {
    if (!this.focus.length) return NaN;
    let best = NaN, bestA = 0;
    for (const g of this.focus) {
      const px = x - g.ax, pz = z - g.az;
      let t = (px * g.ex + pz * g.ez) * g.invLen2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const a = g.r + g.dr * t - Math.hypot(px - g.ex * t, pz - g.ez * t);
      if (a > bestA) {
        bestA = a;
        best = g.floor + g.dFloor * t;
      }
    }
    return Number.isNaN(best) ? NaN : best + this.floorBump(x, z);
  }

  /**
   * Ist von hier aus das Mundloch zu sehen? Prüft drei Sichtlinien durch den Gang. Ohne Sichtverbindung nach draußen
   * braucht man die ganze Außenwelt nicht zu zeichnen. Liegt das Mundloch weit weg, zählt das immer als verdeckt.
   */
  seesMouth(x: number, y: number, z: number): boolean {
    const system = this.systemAt(x, z);
    if (!system) return true;
    const m = system.mouth;
    const dist = Math.hypot(m.ax - x, m.az - z);
    if (dist > 130) return false;
    const segments = system.segments.filter((g) => segmentDistance(g, (x + m.ax) / 2, (z + m.az) / 2) < dist / 2 + g.r + 14);
    const sideX = -m.inZ * (m.radius - 3), sideZ = m.inX * (m.radius - 3);
    for (const side of [-1, 0, 1]) {
      const tx = m.ax + m.inX * 3 + sideX * side, tz = m.az + m.inZ * 3 + sideZ * side, ty = m.floor + 2.5;
      const steps = Math.ceil(dist / 2.5);
      let clear = true;
      for (let i = 1; i < steps && clear; i++) {
        const t = i / steps;
        if (this.coarse(segments, x + (tx - x) * t, y + (ty - y) * t, z + (tz - z) * t) < -1) clear = false;
      }
      if (clear) return true;
    }
    return false;
  }

  /** Weglänge vom Mundloch bis zur nächsten Stelle des Gangs, für Punkte nahe beim Fokus. */
  pathAt(x: number, y: number, z: number): number {
    if (!this.focus.length) return Infinity;
    this.coarse(this.focus, x, y, z);
    return this.hitS;
  }

  get lastPathS(): number {
    return this.hitS;
  }

  get lastFloor(): number {
    return this.hitFloor;
  }

  private build(cx: number, cz: number): CaveSystem | null {
    const world = this.world;
    const r = mulberry((Math.imul(world.seed, 0x9e3779b1) ^ Math.imul(cx, 0x85ebca6b) ^ Math.imul(cz, 0xc2b2ae35)) >>> 0);
    if (r() > CAVE_CHANCE) return null;
    const info: WorldInfo = { distance: 0, wall: 0, cut: 0, tangentX: 0, tangentZ: 0 };
    const minX = cx * CAVE_CELL + CELL_MARGIN, maxX = (cx + 1) * CAVE_CELL - CELL_MARGIN;
    const minZ = cz * CAVE_CELL + CELL_MARGIN, maxZ = (cz + 1) * CAVE_CELL - CELL_MARGIN;
    const inside = (x: number, z: number) => x > minX && x < maxX && z > minZ && z < maxZ;

    for (let tries = 0; tries < 420; tries++) {
      const x = minX + r() * (maxX - minX), z = minZ + r() * (maxZ - minZ);
      const h = world.height(x, z, info);
      // Am oberen Rand der Schutthalde: hinkommen lässt es sich noch, und gleich dahinter steht die Wand
      if (info.wall < 0.24 || info.wall > 0.5 || info.cut < 40) continue;

      const D = (a: number, b: number) => {
        world.height(a, b, info);
        return info.distance;
      };
      let ix = D(x + 3, z) - D(x - 3, z), iz = D(x, z + 3) - D(x, z - 3);
      const il = Math.hypot(ix, iz);
      if (il < 0.01) continue;
      ix /= il;
      iz /= il;
      if (world.height(x + ix * 22, z + iz * 22) - h < 14) continue;
      // Von der Schluchtsohle aus muss man hinaufgehen können
      let reachable = true;
      for (let s = 2; s <= 34 && reachable; s += 4) {
        const ax = x - ix * s, az = z - iz * s;
        if (Math.hypot(world.height(ax + 2, az) - world.height(ax - 2, az), world.height(ax, az + 2) - world.height(ax, az - 2)) > 4.4) reachable = false;
      }
      if (!reachable) continue;
      const system = this.buildFrom(r, x, z, ix, iz, cx, cz, inside);
      if (system) return system;
    }
    return null;
  }

  private buildFrom(r: () => number, x: number, z: number, ix: number, iz: number, cx: number, cz: number, inside: (x: number, z: number) => boolean): CaveSystem | null {
    const world = this.world;
    const nodes: Node[] = [];
    const segments: [number, number][] = [];

    const floor0 = world.height(x, z);
    const mouthR = 4.2 + r() * 1.8, mouthH = 6 + r() * 2.5;
    nodes.push({ x: x - ix * 7, z: z - iz * 7, r: mouthR + 1, floor: world.height(x - ix * 7, z - iz * 7) - 0.15, height: mouthH + 1, s: -7 });
    nodes.push({ x, z, r: mouthR, floor: floor0 - 0.1, height: mouthH, s: 0 });
    segments.push([0, 1]);

    const fits = (nx: number, nz: number, nr: number, nf: number, nh: number, parent: number) => {
      if (!inside(nx, nz)) return false;
      // Dicht hinter dem Mundloch liegt naturgemäß noch wenig Fels über dem Gang, tiefer drin muss es ein ganzes Stück sein
      const fromMouth = Math.hypot(nx - x, nz - z);
      const rock = Math.min(ROOF_ROCK, 0.35 * fromMouth);
      if (world.height(nx, nz) - (nf + nh) < rock) return false;
      // Seitlich genauso: Sonst bricht eine Halle durch die nächste Felswand. Nah am Mundloch steht die Wand aber ja gleich daneben.
      if (fromMouth > 26) {
        for (let a = 0; a < 6; a++) {
          const ang = (a / 6) * Math.PI * 2;
          const sx = nx + Math.cos(ang) * (nr + 5), sz = nz + Math.sin(ang) * (nr + 5);
          if (world.height(sx, sz) - (nf + nh) < rock * 0.6) return false;
        }
      }
      for (let i = 0; i < nodes.length; i++) {
        if (i === parent || i === parent - 1) continue;
        const n = nodes[i];
        if (Math.hypot(n.x - nx, n.z - nz) < n.r + nr + 6) return false;
      }
      return true;
    };

    const grow = (start: number, heading0: number, count: number): number => {
      let at = start, heading = heading0, curve = (r() - 0.5) * 0.3, sinceRoom = 0, made = 0, roomLeft = 0;
      for (let i = 0; i < count; i++) {
        const prev = nodes[at];
        // Hallen entstehen in Abständen. Dazwischen ist es eng, das macht sie erst groß.
        if (roomLeft === 0 && sinceRoom >= 5 && r() < 0.3) roomLeft = 2 + Math.floor(r() * 2);
        const room = { r: 10 + r() * 9, height: 9 + r() * 7, length: 11 + r() * 3.5 };
        const passage = { r: 3.2 + r() * 2.6, height: 5.2 + r() * 2.8, length: 8.5 + r() * 3.5 };
        const nf = prev.floor + (r() - 0.62) * 1.5;
        curve += (r() - 0.5) * 0.28;
        curve = Math.max(-0.42, Math.min(0.42, curve));
        // Nach dem ersten Stück eine deutliche Biegung: Tiefer drin soll man das Tageslicht nicht mehr sehen
        const bend = start === 1 && i >= 2 && i <= 4 ? (cx + cz) % 2 === 0 ? 0.35 : -0.35 : 0;
        heading += curve + bend;
        let placed = false;
        // Passt keine Halle hinein, geht es als Gang weiter
        for (const shape of roomLeft > 0 ? [room, passage] : [passage]) {
          for (const turn of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.2, -2.2]) {
            const a = heading + turn;
            const nx = prev.x + Math.cos(a) * shape.length, nz = prev.z + Math.sin(a) * shape.length;
            if (!fits(nx, nz, shape.r, nf, shape.height, at)) continue;
            nodes.push({ x: nx, z: nz, r: shape.r, floor: nf, height: shape.height, s: prev.s + shape.length });
            segments.push([at, nodes.length - 1]);
            at = nodes.length - 1;
            heading = a;
            placed = true;
            break;
          }
          if (placed) break;
        }
        if (!placed) break;
        made++;
        if (roomLeft > 0) {
          roomLeft--;
          sinceRoom = 0;
        } else sinceRoom++;
      }
      return made;
    };

    const main = grow(1, Math.atan2(iz, ix), 18 + Math.floor(r() * 16));
    // Zu kurz gibt nur eine Nische: lieber woanders neu ansetzen
    if (main < 6) return null;
    const count = nodes.length;
    const branches = 1 + Math.floor(r() * 3);
    for (let b = 0; b < branches; b++) {
      const at = 5 + Math.floor(r() * (count - 6));
      const prev = nodes[at];
      const dir = Math.atan2(prev.z - nodes[at - 1].z, prev.x - nodes[at - 1].x);
      grow(at, dir + (r() < 0.5 ? 1 : -1) * (1 + r() * 0.6), 6 + Math.floor(r() * 10));
    }

    // Das Mundloch reicht so weit hinein, bis genug Fels über dem Gang liegt: Bis dahin ersetzt es die Oberfläche
    let inner = 3;
    for (; inner < 40; inner += 1.5) {
      const px = x + ix * inner, pz = z + iz * inner;
      if (world.height(px, pz) - (floor0 + mouthH) > 2.5) break;
    }
    const mouth: CaveMouth = {
      ax: x - ix * 3,
      az: z - iz * 3,
      bx: x + ix * inner,
      bz: z + iz * inner,
      radius: mouthR + 2.5,
      inX: ix,
      inZ: iz,
      floor: floor0,
    };

    const list = segments.map(([a, b]) => {
      const A = nodes[a], B = nodes[b];
      const ex = B.x - A.x, ez = B.z - A.z;
      const segment: CaveSegment = {
        ax: A.x,
        az: A.z,
        ex,
        ez,
        invLen2: 1 / (ex * ex + ez * ez),
        r: A.r,
        dr: B.r - A.r,
        floor: A.floor,
        dFloor: B.floor - A.floor,
        height: A.height,
        dHeight: B.height - A.height,
        s: A.s,
        dS: B.s - A.s,
      };
      return segment;
    });
    const rooms = nodes.filter((n) => n.r > 9).length;
    return { cellX: cx, cellZ: cz, segments: list, mouth, length: Math.max(...nodes.map((n) => n.s)), rooms };
  }
}

function segmentDistance(g: CaveSegment, x: number, z: number): number {
  const px = x - g.ax, pz = z - g.az;
  const t = Math.max(0, Math.min(1, (px * g.ex + pz * g.ez) * g.invLen2));
  return Math.hypot(px - g.ex * t, pz - g.ez * t);
}

export { segmentDistance };
