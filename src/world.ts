// Die Welt als reine Funktion: Aus Seed und Ort folgt die Höhe, ganz ohne gespeicherte Daten. Deshalb lässt sich jedes
// Stück unabhängig und in beliebiger Reihenfolge berechnen, und eine einzige Zahl genügt, um denselben Planeten
// wiederzufinden. Diese Datei läuft im Worker, im Hauptthread und in den Prüfskripten unter Node.
import type { PlanetId } from './planets';

export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Abstand von einer Mittellinie, unten gerundet. Der reine Betrag hätte dort einen scharfen Knick, und wo eine Seitenschlucht
 * verschlossen auf eine Wand trifft, liefe dieser Knick als Reißverschluss die ganze Wand hinunter.
 */
function roundedDistance(signed: number) {
  return Math.sqrt(signed * signed + 100) - 10;
}

const NOISE_SCALE = 1.5; // Gradientenrauschen erreicht sonst nur etwa ±0,7

/** Gradientenrauschen. grad() liefert zusätzlich die Ableitungen, die braucht die Breite der Schluchten. */
class Noise {
  readonly perm = new Uint8Array(512);
  readonly gx = new Float32Array(256);
  readonly gy = new Float32Array(256);
  dx = 0;
  dy = 0;

  constructor(random: () => number) {
    const t = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const v = t[i];
      t[i] = t[j];
      t[j] = v;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = t[i & 255];
    for (let i = 0; i < 256; i++) {
      const a = random() * Math.PI * 2;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
    }
  }

  at(x: number, y: number): number {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const X = xi & 255, Y = yi & 255;
    const { perm: p, gx, gy } = this;
    const a = p[p[X] + Y], b = p[p[X + 1] + Y], c = p[p[X] + Y + 1], d = p[p[X + 1] + Y + 1];
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const n0 = gx[a] * fx + gy[a] * fy;
    const n1 = gx[b] * (fx - 1) + gy[b] * fy;
    const n2 = gx[c] * fx + gy[c] * (fy - 1);
    const n3 = gx[d] * (fx - 1) + gy[d] * (fy - 1);
    const e = n0 + (n1 - n0) * u;
    return (e + (n2 + (n3 - n2) * u - e) * v) * NOISE_SCALE;
  }

  /**
   * Felsblöcke: rechteckige Zellen mit je eigenem Versatz, dazwischen eine schmale Kluft. Fels bricht an Klüften in zwei
   * Richtungen. Fließendes Rauschen ergäbe runde Linien wie geschmolzen, spitzwinklige Zellen ganze Reihen von Zähnen.
   */
  blocks(x: number, y: number): number {
    const iu = Math.floor(x), iv = Math.floor(y);
    const fu = x - iu, fv = y - iv;
    const { perm: p, gx } = this;
    const X = iu & 255, Y = iv & 255;
    const a = gx[p[p[X] + Y]], b = gx[p[p[X + 1] + Y]], c = gx[p[p[X] + Y + 1]], d = gx[p[p[X + 1] + Y + 1]];
    // Kein harter Sprung: Der fiele auf dem Raster als flimmernde Linie auf
    const su = fu <= 0.44 ? 0 : fu >= 0.56 ? 1 : (fu - 0.44) / 0.12;
    const sv = fv <= 0.44 ? 0 : fv >= 0.56 ? 1 : (fv - 0.44) / 0.12;
    const e = a + (b - a) * su;
    return e + (c + (d - c) * su - e) * sv;
  }

  grad(x: number, y: number): number {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const X = xi & 255, Y = yi & 255;
    const { perm: p, gx, gy } = this;
    const a = p[p[X] + Y], b = p[p[X + 1] + Y], c = p[p[X] + Y + 1], d = p[p[X + 1] + Y + 1];
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const du = 30 * fx * fx * (fx * (fx - 2) + 1);
    const dv = 30 * fy * fy * (fy * (fy - 2) + 1);
    const n0 = gx[a] * fx + gy[a] * fy;
    const n1 = gx[b] * (fx - 1) + gy[b] * fy;
    const n2 = gx[c] * fx + gy[c] * (fy - 1);
    const n3 = gx[d] * (fx - 1) + gy[d] * (fy - 1);
    const k1 = n1 - n0, k2 = n2 - n0, k3 = n0 - n1 - n2 + n3;
    this.dx = (gx[a] + (gx[b] - gx[a]) * u + (gx[c] - gx[a]) * v + (gx[a] - gx[b] - gx[c] + gx[d]) * u * v + du * (k1 + k3 * v)) * NOISE_SCALE;
    this.dy = (gy[a] + (gy[b] - gy[a]) * u + (gy[c] - gy[a]) * v + (gy[a] - gy[b] - gy[c] + gy[d]) * u * v + dv * (k2 + k3 * u)) * NOISE_SCALE;
    return (n0 + k1 * u + k2 * v + k3 * u * v) * NOISE_SCALE;
  }
}

// Die Gesteinslagen wiederholen sich erst nach dieser Höhe, das ist mehr, als ein Standort je überblickt
export const STRATA_PERIOD = 512;
export const STRATA_SAMPLES = 4096;

// Stilles Wasser in Senken. Je Zelle höchstens ein Becken, und es bleibt in seiner Zelle: So genügt immer eine Abfrage.
export const POOL_CELL = 220;
const POOL_CHANCE = 0.7;
// So weit bleibt der Spiegel unter dem niedrigsten Punkt des Rands: So tief reichen die Schieferplatten kaum, das Wasser schwebt nie über dem Ufer
const POOL_BANK = 1.2;
const POOL_DEPTH = 2.5;

// Der Mars hat eine Landkarte, die Hauptthread und Shader gemeinsam lesen: wo Dünenfelder liegen, wo heller Staub und wo dunkler Sand.
// Sie wiederholt sich nach 8 km und ist so grob, dass ihre Texel nie auffallen.
export const REGION_N = 512;
export const REGION_SIZE = 8192;
// Die Krater, je Größe ein eigenes Raster. Jeder bleibt in seiner Zelle: So genügt je Größe eine Abfrage.
const CRATER_LEVELS = [
  { cell: 1900, low: 170, high: 600, chance: 0.42 },
  { cell: 540, low: 40, high: 165, chance: 0.5 },
  { cell: 390, low: 25, high: 90, chance: 0.3 },
  { cell: 130, low: 8, high: 40, chance: 0.5 },
  { cell: 83, low: 4, high: 22, chance: 0.35 },
  { cell: 34, low: 1.6, high: 9, chance: 0.28 },
];
// Bis dahin reicht der Auswurf um einen Krater, in Radien
const CRATER_REACH = 1.55;
const DUNE_SPACING = 58;

interface Crater {
  x: number;
  z: number;
  r: number;
  depth: number;
  rim: number;
  /** Bis hierhin ist der Boden flach, in Radien */
  flat: number;
  peak: number;
}

export interface Pool {
  x: number;
  z: number;
  radius: number;
  /** Höhe des Wasserspiegels */
  level: number;
  /** So viel wird in der Mitte ausgehoben. Zum Rand hin läuft es weich aus. */
  carve: number;
}

/** Was eine Auswertung neben der Höhe weiß. Für Felsen, Prüfskripte und die Startsuche. */
export interface WorldInfo {
  /** Entfernung von der Mittellinie der nächsten Schlucht */
  distance: number;
  /** Lage in der Felswand: 0 Fuß, 1 Oberkante */
  wall: number;
  /** Tiefe der Schlucht an dieser Stelle */
  cut: number;
  /** Laufrichtung der Hauptschlucht */
  tangentX: number;
  tangentZ: number;
}

export class World {
  readonly seed: number;
  readonly dipX: number;
  readonly dipZ: number;
  /** Abweichung der gestuften von der glatten Höhe: Bänke und Steilstufen je Lage, wiederholt nach STRATA_PERIOD */
  readonly ledges = new Float32Array(STRATA_SAMPLES + 1);
  /** Dasselbe im Großen: Hochebenen und ihre Abbruchkanten */
  private readonly benches = new Float32Array(STRATA_SAMPLES + 1);
  /** Die feinen Lagen für den Shader, einmal je Welt gewürfelt */
  readonly strataData: Uint8Array<ArrayBuffer>;
  private readonly beds = new Float32Array(STRATA_SAMPLES);
  private readonly noise: Noise;
  private readonly o: Float64Array;
  private readonly jointCos: number;
  private readonly jointSin: number;
  private readonly pools = new Map<number, Pool | null>();
  private lastPoolKey = NaN;
  private lastPool: Pool | null = null;
  readonly mars: boolean;
  /** Die Landkarte für den Shader: Dünen, Helligkeit des Staubs */
  readonly regionData: Uint8Array<ArrayBuffer>;
  private readonly craters = CRATER_LEVELS.map(() => new Map<number, Crater | null>());

  constructor(seed: number, planet: PlanetId = 'slate') {
    this.seed = seed;
    this.mars = planet === 'mars';
    this.regionData = this.mars ? regionMap(seed) : new Uint8Array(0);
    const r = mulberry(seed);
    this.noise = new Noise(r);
    // Eigene Verschiebung je Feld, sonst hingen alle Felder am selben Muster
    this.o = new Float64Array(58);
    for (let i = 0; i < this.o.length; i++) this.o[i] = r() * 256;
    // Die Lagen fallen leicht ein: Über Kilometer wandern sie sichtbar nach oben oder unten
    const dipAngle = r() * Math.PI * 2, dip = 0.012 + r() * 0.02;
    this.dipX = Math.cos(dipAngle) * dip;
    this.dipZ = Math.sin(dipAngle) * dip;
    // Die Klüfte streichen überall in dieselben zwei Richtungen, wie in einem echten Gesteinskörper
    const jointAngle = r() * Math.PI;
    this.jointCos = Math.cos(jointAngle);
    this.jointSin = Math.sin(jointAngle);
    // Dünne und mächtige Lagen im Wechsel, sonst sähe die Wand aus wie eine Treppe
    this.fillSteps(this.ledges, () => (r() < 0.35 ? 3 + r() * 4 : 8 + r() * 14), () => 0.3 + r() * 0.5);
    this.fillSteps(this.benches, () => 22 + r() * 26, () => 0.6 + r() * 0.28);
    this.strataData = this.strataProfile();
  }

  private fillSteps(table: Float32Array, thickness: () => number, bench: () => number) {
    const step = STRATA_PERIOD / STRATA_SAMPLES;
    let e0 = 0;
    let i = 0;
    while (e0 < STRATA_PERIOD) {
      let th = thickness();
      if (STRATA_PERIOD - (e0 + th) < 3) th = STRATA_PERIOD - e0;
      const b = bench();
      for (; i <= STRATA_SAMPLES && i * step <= e0 + th; i++) {
        const e = i * step;
        table[i] = e0 + th * smoothstep(b, 1, (e - e0) / th) - e;
      }
      e0 += th;
    }
    table[STRATA_SAMPLES] = table[0];
  }

  /** Felsblöcke in den Kluftrichtungen dieser Welt, für alles, was nicht zur Höhenkarte gehört. */
  joints(x: number, z: number, sizeA: number, sizeB: number): number {
    return this.noise.blocks((this.jointCos * x + this.jointSin * z) / sizeA, (this.jointCos * z - this.jointSin * x) / sizeB);
  }

  /** Wie weit eine Gesteinsbank auf dieser Höhe vorsteht, in Metern. Passt zu den Bändern im Shader. */
  bedOffset(y: number, x: number, z: number): number {
    const u = (((y + this.dipX * x + this.dipZ * z) / STRATA_PERIOD) % 1 + 1) % 1 * STRATA_SAMPLES;
    return this.beds[Math.floor(u)];
  }

  private stepAt(table: Float32Array, e: number): number {
    const u = ((e / STRATA_PERIOD) % 1 + 1) % 1 * STRATA_SAMPLES;
    const i = Math.floor(u);
    const a = table[i];
    return a + (table[i + 1] - a) * (u - i);
  }

  /**
   * Höhe an einem Punkt. Mit grid sagt der Aufrufer, in welchem Raster er abtastet: Was kleiner ist als das Raster, fällt weg.
   * Sonst treffen die Abtastpunkte zufällig Blöcke und Stufen, und in der Ferne wachsen daraus Zacken.
   */
  height(x: number, z: number, info?: WorldInfo, grid = 0): number {
    if (this.mars) return this.marsHeight(x, z, info, grid);
    const h = this.rockHeight(x, z, info, grid);
    const pool = this.poolIn(Math.floor(x / POOL_CELL), Math.floor(z / POOL_CELL));
    if (!pool) return h;
    const dx = x - pool.x, dz = z - pool.z;
    const s = (dx * dx + dz * dz) / (pool.radius * pool.radius);
    if (s >= 1) return h;
    return h - pool.carve * (1 - s) * (1 - s);
  }

  /** Der Wasserspiegel an dieser Stelle, oder -Infinity, wo kein Wasser ist. Unter ihm liegt nur noch der Grund des Beckens. */
  waterLevel(x: number, z: number): number {
    if (this.mars) return -Infinity;
    const pool = this.poolIn(Math.floor(x / POOL_CELL), Math.floor(z / POOL_CELL));
    if (!pool) return -Infinity;
    const dx = x - pool.x, dz = z - pool.z;
    return dx * dx + dz * dz < pool.radius * pool.radius ? pool.level : -Infinity;
  }

  /** Alle Becken in diesem Umkreis, je vier Zahlen: x, Wasserspiegel, z, Radius. */
  poolsAround(x: number, z: number, reach: number): Float32Array<ArrayBuffer> {
    if (this.mars) return new Float32Array(0);
    const list: number[] = [];
    const x0 = Math.floor((x - reach) / POOL_CELL), x1 = Math.floor((x + reach) / POOL_CELL);
    const z0 = Math.floor((z - reach) / POOL_CELL), z1 = Math.floor((z + reach) / POOL_CELL);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const pool = this.poolIn(cx, cz);
        if (pool) list.push(pool.x, pool.level, pool.z, pool.radius);
      }
    }
    return new Float32Array(list);
  }

  private poolIn(cx: number, cz: number): Pool | null {
    const key = (cx + 32768) * 65536 + (cz + 32768);
    if (key === this.lastPoolKey) return this.lastPool;
    let pool = this.pools.get(key);
    if (pool === undefined) {
      pool = this.findPool(cx, cz);
      this.pools.set(key, pool);
    }
    this.lastPoolKey = key;
    this.lastPool = pool;
    return pool;
  }

  /** Läuft von einem Zufallspunkt aus bergab bis in eine Mulde. Ist das Gelände dort ruhig genug, füllt sie sich bis knapp unter den Rand. */
  private findPool(cx: number, cz: number): Pool | null {
    const r = mulberry(Math.imul(this.seed, 0x9e3779b1) ^ Math.imul(cx, 0x85ebca6b) ^ Math.imul(cz, 0xc2b2ae35));
    if (r() > POOL_CHANCE) return null;
    const wanted = 24 + r() * r() * 52;
    const low = wanted + 4, high = POOL_CELL - wanted - 4;
    const info: WorldInfo = { distance: 0, wall: 0, cut: 0, tangentX: 0, tangentZ: 0 };
    for (let attempt = 0; attempt < 3; attempt++) {
      let x = cx * POOL_CELL + low + r() * (high - low), z = cz * POOL_CELL + low + r() * (high - low);
      let h = this.rockHeight(x, z, undefined, 8);
      for (let i = 0; i < 8; i++) {
        let bx = x, bz = z;
        for (let k = 0; k < 4; k++) {
          const nx = Math.max(cx * POOL_CELL + low, Math.min((cx + 1) * POOL_CELL - low, x + [14, -14, 0, 0][k]));
          const nz = Math.max(cz * POOL_CELL + low, Math.min((cz + 1) * POOL_CELL - low, z + [0, 0, 14, -14][k]));
          const nh = this.rockHeight(nx, nz, undefined, 8);
          if (nh < h) {
            h = nh;
            bx = nx;
            bz = nz;
          }
        }
        if (bx === x && bz === z) break;
        x = bx;
        z = bz;
      }

      // Schluchtsohlen sind schmal: Passt die gewünschte Größe nicht, dann vielleicht eine kleinere
      for (const radius of [wanted, wanted * 0.6, Math.max(wanted * 0.36, 14)]) {
        let rim = Infinity, top = -Infinity, calm = true;
        for (let k = 0; k < 16 && calm; k++) {
          const a = (k / 16) * Math.PI * 2;
          const here = this.rockHeight(x + Math.cos(a) * radius, z + Math.sin(a) * radius, info, 8);
          // In einer Felswand gibt es kein ruhiges Wasser. Auf der Sohle ist wall 0, auf der Hochebene 1.
          calm = info.wall < 0.02 || info.wall > 0.98;
          rim = Math.min(rim, here);
          top = Math.max(top, here);
        }
        if (!calm || top - rim > radius * 0.35) continue;
        const level = rim - POOL_BANK;
        return { x, z, radius, level, carve: Math.max(0, h - (level - POOL_DEPTH)) };
      }
    }
    return null;
  }

  private rockHeight(x: number, z: number, info?: WorldInfo, grid = 0): number {
    const n = this.noise, o = this.o;

    // Weite Verzerrung: Sie lässt die Schluchten mäandern und bricht das Raster des Rauschens
    const px = x + 120 * n.at(x / 560 + o[0], z / 560 + o[1]) + 38 * n.at(x / 150 + o[2], z / 150 + o[3]);
    const pz = z + 120 * n.at(x / 560 + o[4], z / 560 + o[5]) + 38 * n.at(x / 150 + o[6], z / 150 + o[7]);

    // Die Schluchten liegen auf den Nullstellen eines Rauschfelds. Wert durch Steigung ergibt näherungsweise den Abstand
    // in Metern. Ohne diese Teilung wäre die Breite nur vom Zufall abhängig.
    const a0 = n.grad(px / 1100 + o[8], pz / 1100 + o[9]);
    let ax = n.dx / 1100, az = n.dy / 1100;
    const a1 = n.grad(px / 470 + o[10], pz / 470 + o[11]);
    ax += (0.3 * n.dx) / 470;
    az += (0.3 * n.dy) / 470;
    const mainField = a0 + 0.3 * a1;
    const mainD = roundedDistance(mainField / Math.max(Math.hypot(ax, az), 0.0005));

    const b0 = n.grad(px / 480 + o[12], pz / 480 + o[13]);
    let bx = n.dx / 480, bz = n.dy / 480;
    const b1 = n.grad(px / 200 + o[14], pz / 200 + o[15]);
    bx += (0.3 * n.dx) / 200;
    bz += (0.3 * n.dy) / 200;
    // Seitenschluchten laufen irgendwo aus: Der Abstand wächst, und der Einschnitt wird zur flachen Mulde
    const gate = smoothstep(-0.35, 0.15, n.at(x / 1300 + o[16], z / 1300 + o[17]));
    const sideD = roundedDistance((b0 + 0.3 * b1) / Math.max(Math.hypot(bx, bz), 0.001)) + (1 - gate) * 280;

    // Die Grundform, in der die Schluchtsohlen liegen
    const base = 30 * n.at(x / 2400 + o[18], z / 2400 + o[19]) + 12 * n.at(x / 900 + o[20], z / 900 + o[21]);
    const floorRoll = 3.5 * n.at(x / 170 + o[28], z / 170 + o[29]) + 1.2 * n.at(x / 61 + o[30], z / 61 + o[31]);

    // Darüber die Hochebene. Wo sie niedrig ist, öffnet sich die Schlucht zur Ebene: Das sind die Ausstiege.
    const rise = n.at(x / 1000 + o[22], z / 1000 + o[23]) + 0.35 * n.at(x / 430 + o[24], z / 430 + o[25])
      + 0.16 * n.at(x / 190 + o[40], z / 190 + o[41]) + 0.07 * n.at(x / 83 + o[42], z / 83 + o[43]);
    const depth = 7 + 133 * smoothstep(-0.5, 0.2, rise);

    // Stellenweise ist die Wand zu einem breiten Schutthang eingestürzt. Das sind die Wege hinauf auf die Hochebene.
    const ramp = smoothstep(0.22, 0.42, n.at(x / 560 + o[56], z / 560 + o[57]));

    // Flachliegende Schichten brechen in Stufen ab. Mal als harte Kante, mal als begehbare Rampe.
    const hard = (0.25 + 0.75 * smoothstep(-0.15, 0.3, n.at(x / 700 + o[44], z / 700 + o[45]))) * (1 - ramp);
    const smoothTop = base + depth;
    // Die Blöcke verschieben nur die Abbruchkante. Auf den Bänken selbst darf nichts springen, die bleiben begehbar.
    const jointX = this.jointCos * x + this.jointSin * z + 3 * n.at(x / 41 + o[28], z / 41 + o[29]);
    const jointZ = this.jointCos * z - this.jointSin * x + 3 * n.at(x / 41 + o[30], z / 41 + o[31]);
    const edgeShift = 6 * n.blocks(jointX / 34 + o[52], jointZ / 52 + o[53]);
    const stepped = smoothTop + hard * (this.stepAt(this.benches, smoothTop + this.dipX * x + this.dipZ * z + edgeShift) + edgeShift);
    const roll = 9 * n.at(x / 380 + o[26], z / 380 + o[27]) + 4 * n.at(x / 150 + o[46], z / 150 + o[47]) + 1.6 * n.at(x / 61 + o[48], z / 61 + o[49]);
    let plateau = stepped + roll * smoothstep(5, 30, depth);

    // Weiche Vereinigung beider Netze. Die Seitenschlucht schneidet weniger tief ein.
    const k = 24;
    const hmix = Math.max(0, Math.min(1, 0.5 + (0.5 * (sideD - mainD)) / k));
    const d = sideD + (mainD - sideD) * hmix - k * hmix * (1 - hmix);
    // Die Sohle wechselt viel langsamer zwischen beiden Netzen als die Form. Täte sie es auf derselben Strecke, stünde an
    // jeder Mündung ein messerscharfer Grat, und aus dem wüchse eine Reihe von Zacken.
    const floor = base + depth * 0.38 * (1 - smoothstep(-120, 120, sideD - mainD)) + floorRoll;
    if (plateau < floor + 3) plateau = floor + 3;
    const cut = plateau - floor;

    // Die Wandlinie springt vor und zurück: Buttressen und Nischen, in der Größe passend zur Tiefe
    const wiggle = (0.12 * cut + 4) * (n.at(x / 85 + o[32], z / 85 + o[33]) + (grid < 16 ? 0.5 * n.at(x / 31 + o[34], z / 31 + o[35]) : 0));
    const wide = smoothstep(-0.4, 0.5, n.at(x / 340 + o[38], z / 340 + o[39]));
    const floorHalf = (8 + 34 * wide + 60 * wide * wide * wide) * (0.6 + 0.4 * hmix);
    // Manche Schluchten fallen senkrecht ab, andere in breiten Stufen wie ein Amphitheater
    const open = smoothstep(0, 0.6, n.at(x / 800 + o[50], z / 800 + o[51]));
    const cliffWidth = (0.5 * cut + 20) * (1 + 2.5 * open);
    // Flach genug, dass man hinaufkommt: Die steilste Stelle der Kurve unten ist 2,2-mal so steil wie der Durchschnitt
    const wallWidth = cliffWidth + (Math.max(cliffWidth, 3.7 * cut + 20) - cliffWidth) * ramp;
    let t = (d + wiggle - floorHalf) / wallWidth;
    // Klüfte zerlegen die Wand in Blöcke, große und kleine. Auf Sohle und Hochebene wäre das vergebene Rechenzeit.
    if (t > -0.4 && t < 1.4 && ramp < 1 && grid < 16) {
      // Nicht zu stark: Ein Versatz, der an die Breite der Wand herankommt, macht aus jedem Block einen spitzen Zahn
      let jointed = (0.05 * cut + 2) * n.blocks(jointX / 27 + o[36], jointZ / 41 + o[37]);
      if (grid < 4) jointed += (0.018 * cut + 0.6) * n.blocks(jointX / 8.5 + o[54], jointZ / 13 + o[55]);
      t += (jointed * (1 - ramp)) / wallWidth;
    }

    // Unten eine Schutthalde, darüber Fels. Beides stetig verbunden, die Oberkante läuft flach aus.
    let s: number;
    if (t <= 0) s = 0;
    else if (t < 0.45) {
      const q = t / 0.45;
      s = 0.14 * q * q;
    } else if (t < 1) {
      const u = (t - 0.45) / 0.55;
      s = 0.14 + 0.86 * (-1.6 * u * u * u + 2.2 * u * u + 0.4 * u);
    } else s = 1;

    let h = floor + cut * s;

    // Die Gesteinslagen liegen auf gemeinsamen Ebenen, deshalb passen sie auf beiden Seiten der Schlucht zusammen
    const cliff = smoothstep(0.38, 0.55, t) * (1 - smoothstep(0.96, 1.04, t)) * smoothstep(14, 38, cut);
    const flat = 0.3 * smoothstep(0.96, 1.2, t);
    const amount = Math.max(cliff, flat) * (1 - ramp) * (grid < 4 ? 1 : grid < 16 ? 0.5 : 0);
    if (amount > 0) h += amount * this.stepAt(this.ledges, h + this.dipX * x + this.dipZ * z);

    if (info) {
      info.distance = d;
      info.wall = Math.max(0, Math.min(1, t));
      info.cut = cut;
      const g = Math.hypot(ax, az) || 1;
      info.tangentX = -az / g;
      info.tangentZ = ax / g;
    }
    return h;
  }

  /** Wie sehr hier Dünensand liegt, 0 bis 1. Genau das liest auch der Shader aus der Landkarte. */
  dune(x: number, z: number): number {
    if (!this.mars) return 0;
    const u = ((x / REGION_SIZE) % 1 + 1) % 1 * REGION_N, v = ((z / REGION_SIZE) % 1 + 1) % 1 * REGION_N;
    // Der Grafikkarte liegen die Texel in ihrer Mitte, darum hier eine halbe Zelle versetzt
    const uc = u - 0.5, vc = v - 0.5;
    const i = Math.floor(uc), j = Math.floor(vc);
    const fx = uc - i, fz = vc - j;
    const mask = REGION_N - 1;
    const data = this.regionData;
    const at = (a: number, b: number) => data[((b & mask) * REGION_N + (a & mask)) * 4];
    const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1);
    return (a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz) / 255;
  }

  /**
   * Der Mars: weite, wellige Ebene statt Schluchten. Darüber stehen Tafelberge aus denselben flach liegenden Schichten,
   * in die Ebene sind Krater jeder Größe geschlagen, und in den Senken liegen Dünen.
   */
  private marsHeight(x: number, z: number, info?: WorldInfo, grid = 0): number {
    const n = this.noise, o = this.o;
    const base = 34 * n.at(x / 3000 + o[18], z / 3000 + o[19]) + 12 * n.at(x / 1100 + o[20], z / 1100 + o[21]);
    const roll = 5 * n.at(x / 340 + o[28], z / 340 + o[29]) + 2 * n.at(x / 130 + o[30], z / 130 + o[31]) + 0.7 * n.at(x / 53 + o[40], z / 53 + o[41]);
    const floor = base + roll;

    // Wo das Feld über der Schwelle liegt, steht noch Tafelland. Es ist in Metern gemeint: Die Steigung des Felds liegt nahe bei 1.
    // Manche Gegenden sind offene Ebene, andere voller Tafelberge.
    const field = n.at(x / 680 + o[8], z / 680 + o[9]) + 0.5 * n.at(x / 290 + o[10], z / 290 + o[11]) + 0.22 * n.at(x / 120 + o[12], z / 120 + o[13]);
    const d = (field + 0.4 * n.at(x / 3400 + o[16], z / 3400 + o[17]) - 0.56) * 300;

    const rise = n.at(x / 1000 + o[22], z / 1000 + o[23]) + 0.35 * n.at(x / 430 + o[24], z / 430 + o[25]);
    const depth = 30 + 105 * smoothstep(-0.5, 0.35, rise);
    // Stellenweise ist die Wand zu einem breiten Schutthang eingestürzt. Das sind die Wege hinauf.
    const ramp = smoothstep(0.1, 0.34, n.at(x / 460 + o[56], z / 460 + o[57]));
    const hard = (0.35 + 0.65 * smoothstep(-0.15, 0.3, n.at(x / 700 + o[44], z / 700 + o[45]))) * (1 - ramp);
    const smoothTop = base + depth;
    const jointX = this.jointCos * x + this.jointSin * z + 3 * n.at(x / 41 + o[28], z / 41 + o[29]);
    const jointZ = this.jointCos * z - this.jointSin * x + 3 * n.at(x / 41 + o[30], z / 41 + o[31]);
    const edgeShift = 6 * n.blocks(jointX / 34 + o[52], jointZ / 52 + o[53]);
    const stepped = smoothTop + hard * (this.stepAt(this.benches, smoothTop + this.dipX * x + this.dipZ * z + edgeShift) + edgeShift);
    let plateau = stepped + (6 * n.at(x / 380 + o[26], z / 380 + o[27]) + 1.6 * n.at(x / 61 + o[48], z / 61 + o[49])) * smoothstep(5, 30, depth);
    if (plateau < floor + 3) plateau = floor + 3;
    const cut = plateau - floor;

    const wiggle = (0.12 * cut + 4) * (n.at(x / 85 + o[32], z / 85 + o[33]) + (grid < 16 ? 0.5 * n.at(x / 31 + o[34], z / 31 + o[35]) : 0));
    const cliffWidth = (0.42 * cut + 18) * (1 + 1.6 * smoothstep(0, 0.6, n.at(x / 800 + o[50], z / 800 + o[51])));
    const wallWidth = cliffWidth + (Math.max(cliffWidth, 3.7 * cut + 20) - cliffWidth) * ramp;
    let t = (d + wiggle) / wallWidth;
    if (t > -0.4 && t < 1.4 && ramp < 1 && grid < 16) {
      let jointed = (0.05 * cut + 2) * n.blocks(jointX / 27 + o[36], jointZ / 41 + o[37]);
      if (grid < 4) jointed += (0.018 * cut + 0.6) * n.blocks(jointX / 8.5 + o[54], jointZ / 13 + o[55]);
      t += (jointed * (1 - ramp)) / wallWidth;
    }

    // Unten eine Schutthalde, darüber Fels: dasselbe Profil wie in den Schluchten
    let s: number;
    if (t <= 0) s = 0;
    else if (t < 0.45) {
      const q = t / 0.45;
      s = 0.14 * q * q;
    } else if (t < 1) {
      const u = (t - 0.45) / 0.55;
      s = 0.14 + 0.86 * (-1.6 * u * u * u + 2.2 * u * u + 0.4 * u);
    } else s = 1;
    let h = floor + cut * s;

    const cliff = smoothstep(0.38, 0.55, t) * (1 - smoothstep(0.96, 1.04, t)) * smoothstep(14, 38, cut);
    const flat = 0.3 * smoothstep(0.96, 1.2, t);
    const amount = Math.max(cliff, flat) * (1 - ramp) * (grid < 4 ? 1 : grid < 16 ? 0.5 : 0);
    if (amount > 0) h += amount * this.stepAt(this.ledges, h + this.dipX * x + this.dipZ * z);

    // Krater auf der Ebene und auf den Tafeln, aber nicht in den Wänden: Dort hätte die Erosion sie längst abgetragen
    const keep = 1 - smoothstep(-0.45, -0.05, t) + smoothstep(1.05, 1.4, t);
    if (keep > 0) h += keep * this.craterRelief(x, z, grid);

    const plain = 1 - smoothstep(-0.8, -0.25, t);
    if (plain > 0 && grid < 16) {
      const sand = this.dune(x, z) * plain;
      if (sand > 0) h += sand * this.duneRelief(x, z);
    }

    if (info) {
      info.distance = d;
      info.wall = Math.max(0, Math.min(1, t));
      info.cut = cut;
      info.tangentX = 1;
      info.tangentZ = 0;
    }
    return h;
  }

  private craterRelief(x: number, z: number, grid: number): number {
    const n = this.noise, o = this.o;
    let sum = 0;
    for (let level = 0; level < CRATER_LEVELS.length; level++) {
      const cell = CRATER_LEVELS[level].cell;
      const c = this.craterIn(level, Math.floor(x / cell), Math.floor(z / cell));
      if (!c || c.r < grid * 1.5) continue;
      const dx = x - c.x, dz = z - c.z;
      const d2 = dx * dx + dz * dz, reach = c.r * CRATER_REACH;
      if (d2 >= reach * reach) continue;
      let s = Math.sqrt(d2) / c.r;
      // Kein Einschlag ist kreisrund
      if (c.r > 5 && grid < c.r / 4) s *= 1 + 0.07 * n.at(x / (c.r * 0.55) + o[14], z / (c.r * 0.55) + o[15]);
      if (s >= CRATER_REACH) continue;
      sum += s < 1 ? c.rim - (c.depth + c.rim) * (1 - smoothstep(c.flat, 1, s)) : c.rim * (1 - smoothstep(1, 1.5, s));
      if (c.peak > 0) sum += c.peak * Math.exp((-s * s) / 0.03);
    }
    return sum;
  }

  private craterIn(level: number, cx: number, cz: number): Crater | null {
    const memo = this.craters[level];
    const key = (cx + 32768) * 65536 + (cz + 32768);
    let c = memo.get(key);
    if (c !== undefined) return c;
    const { cell, low, high, chance } = CRATER_LEVELS[level];
    const r = mulberry(Math.imul(this.seed, 0x7f4a7c15) ^ Math.imul(cx, 0x85ebca6b) ^ Math.imul(cz, 0xc2b2ae35) ^ (level * 0x1b873593));
    c = null;
    // Krater liegen nicht gleichmäßig: Manche Gegenden sind übersät, andere fast frei. Sonst stünde das Raster als Punktmuster in der Landschaft.
    const crowded = 0.25 + 1.5 * smoothstep(-0.45, 0.55, this.noise.at((cx * cell) / 1500 + this.o[6], (cz * cell) / 1500 + this.o[7]));
    if (r() < chance * crowded) {
      const a = r();
      const radius = low + (high - low) * a * a;
      const margin = Math.min(radius * CRATER_REACH + 1, cell / 2);
      const big = smoothstep(90, 400, radius);
      c = {
        x: cx * cell + margin + r() * (cell - 2 * margin),
        z: cz * cell + margin + r() * (cell - 2 * margin),
        r: Math.min(radius, (margin - 1) / CRATER_REACH),
        depth: radius * (0.2 - 0.09 * big) * (0.75 + 0.5 * r()),
        rim: radius * (0.045 - 0.018 * big),
        flat: 0.12 + 0.36 * big,
        peak: radius > 240 && r() < 0.6 ? radius * 0.07 : 0,
      };
    }
    memo.set(key, c);
    return c;
  }

  /** Quer zum Wind laufende Kämme, leicht geschwungen: Auf der Luvseite flach, im Lee steil. Der Wind weht entlang z. */
  private duneRelief(x: number, z: number): number {
    const n = this.noise, o = this.o;
    const bend = 44 * n.at(x / 300 + o[44], z / 300 + o[45]) + 11 * n.at(x / 80 + o[46], z / 80 + o[47]);
    const q = (z + bend) / DUNE_SPACING;
    const id = Math.floor(q);
    const f = q - id;
    // Die Kämme reißen stellenweise ab, sonst lägen sie wie mit dem Kamm gezogen
    const crest = 6.2 * smoothstep(-0.55, 0.55, n.at(x / 120 + id * 3.7 + o[48], id * 2.1 + o[49]));
    const up = f < 0.78 ? f / 0.78 : (1 - f) / 0.22;
    return crest * up * up * (3 - 2 * up) - 1.2;
  }

  /**
   * Die feinen Gesteinslagen für den Shader, als Streifen über die Höhe:
   * Neigung der Bank, Helligkeit, dunkle Fuge, Farbton. Sie werden aus demselben Seed gewürfelt wie die Stufen.
   */
  private strataProfile(): Uint8Array<ArrayBuffer> {
    const r = mulberry(this.seed ^ 0x5bd1e995);
    const data = new Uint8Array(STRATA_SAMPLES * 4);
    const step = STRATA_PERIOD / STRATA_SAMPLES;
    let e0 = 0;
    while (e0 < STRATA_PERIOD) {
      // Mächtige Bänke wechseln mit Paketen aus dünnen Lagen. Überall gleich dünne Lagen sähen aus wie gekämmt.
      const massive = r() < 0.55;
      const th = massive ? 3 + r() * 11 : 1 + r() * 4;
      const packTone = r();
      const packHue = r() < 0.75 ? r() * 0.3 : 0.5 + r() * 0.5;
      const packOffset = (r() - 0.5) * (massive ? 1.5 : 0.5);
      for (let i = Math.ceil(e0 / step); i * step < e0 + th && i < STRATA_SAMPLES; i++) this.beds[i] = packOffset;
      let b0 = e0;
      while (b0 < e0 + th) {
        const bed = massive ? th : 0.25 + r() * 0.5;
        const tone = Math.max(0, Math.min(1, packTone * 0.8 + r() * (massive ? 0.12 : 0.3)));
        const end = Math.min(b0 + bed, e0 + th);
        const edge = Math.min(0.28, (end - b0) * 0.3);
        const strength = massive ? 1 : 0.45;
        for (let i = Math.ceil(b0 / step); i * step < end && i < STRATA_SAMPLES; i++) {
          const below = i * step - b0, above = end - i * step;
          const o = i * 4;
          // Am Fuß springt die Bank zurück, oben steht sie vor. Dazwischen bleibt die Fläche ruhig.
          const tilt = below < edge ? -1 : above < edge ? 1 : 0;
          const fuge = Math.max(1 - below / 0.2, 0) * strength;
          data[o] = Math.round((tilt * strength * 0.5 + 0.5) * 255);
          data[o + 1] = Math.round(tone * 255);
          data[o + 2] = Math.round(fuge * 255);
          data[o + 3] = Math.round(packHue * 255);
        }
        b0 = end;
      }
      e0 += th;
    }
    return data;
  }

  /**
   * Sucht einen Startplatz: auf der Sohle einer tiefen Schlucht, die in Richtung des Hauptlichts läuft. Dort steht die
   * Galaxie am Ende der Schlucht über dem Horizont, und das Licht fällt der Länge nach hinein. Mit bonus lässt sich ein
   * Platz bevorzugen, etwa einer mit einer Höhle in Sichtweite.
   */
  findStart(towardX: number, towardZ: number, bonus: (x: number, z: number) => number = () => 1): { x: number; z: number } {
    if (this.mars) return this.findMarsStart(towardX, towardZ, bonus);
    const info: WorldInfo = { distance: 0, wall: 0, cut: 0, tangentX: 0, tangentZ: 0 };
    const clear = Math.tan((24 * Math.PI) / 180);
    const STEP = 16;
    let best = { x: 0, z: 0 }, bestScore = -Infinity;
    for (let ring = 0; ring < 300; ring++) {
      const side = ring * 2 + 1;
      for (let k = 0; k < side * 4; k++) {
        // Quadratische Spirale um den Ursprung: nahe Plätze zuerst, damit derselbe Seed stets denselben Start findet
        const edge = Math.floor(k / side), along = (k % side) - ring;
        const a = edge === 0 ? along : edge === 1 ? ring + 1 : edge === 2 ? -along : -ring - 1;
        const b = edge === 0 ? -ring - 1 : edge === 1 ? along : edge === 2 ? ring + 1 : -along;
        const x = a * STEP, z = b * STEP;
        const h = this.height(x, z, info);
        if (info.wall > 0 || info.cut < 70) continue;
        const align = Math.abs(info.tangentX * towardX + info.tangentZ * towardZ);
        if (align < 0.8) continue;
        // Freier Blick zur Galaxie, sonst stünde man vor einer Wand statt vor dem Himmel
        let open = true;
        for (let r = 24; r < 1400 && open; r *= 1.35) {
          if (this.height(x + towardX * r, z + towardZ * r) - h > clear * r) open = false;
        }
        if (!open) continue;
        const flat = Math.abs(this.height(x + 2, z) - this.height(x - 2, z)) + Math.abs(this.height(x, z + 2) - this.height(x, z - 2));
        if (flat > 1) continue;
        const extra = bonus(x, z);
        if (extra <= 0 && bestScore > 0) continue;
        // Nur wo man auch weit kommt: Ein Start in einer abgeschlossenen Kammer wäre nach ein paar Minuten zu Ende
        const reach = this.walkReach(x, z);
        const score = align - flat + Math.min(reach, 900) / 900 - ring * 0.002 + extra;
        if (score > bestScore) {
          bestScore = score;
          best = { x, z };
        }
        if (align > 0.93 && reach >= 900 && extra > 0) return { x, z };
      }
    }
    return best;
  }

  /** Auf dem Mars: auf der offenen Ebene, mit freiem Blick zur tief stehenden Sonne und mit etwas, das diesen Blick einrahmt. */
  private findMarsStart(towardX: number, towardZ: number, bonus: (x: number, z: number) => number): { x: number; z: number } {
    const info: WorldInfo = { distance: 0, wall: 0, cut: 0, tangentX: 0, tangentZ: 0 };
    const clear = Math.tan((6.5 * Math.PI) / 180);
    const STEP = 24;
    let best = { x: 0, z: 0 }, bestScore = -Infinity;
    for (let ring = 0; ring < 90; ring++) {
      const side = ring * 2 + 1;
      for (let k = 0; k < side * 4; k++) {
        const edge = Math.floor(k / side), along = (k % side) - ring;
        const a = edge === 0 ? along : edge === 1 ? ring + 1 : edge === 2 ? -along : -ring - 1;
        const b = edge === 0 ? -ring - 1 : edge === 1 ? along : edge === 2 ? ring + 1 : -along;
        const x = a * STEP, z = b * STEP;
        const h = this.height(x, z, info);
        if (info.wall > 0) continue;
        let open = true;
        for (let r = 24; r < 2600 && open; r *= 1.3) {
          if (this.height(x + towardX * r, z + towardZ * r) - h > clear * r) open = false;
        }
        if (!open) continue;
        const flat = Math.abs(this.height(x + 2, z) - this.height(x - 2, z)) + Math.abs(this.height(x, z + 2) - this.height(x, z - 2));
        if (flat > 0.7 || this.dune(x, z) > 0.3) continue;
        // Links und rechts der Sonne soll etwas stehen: ein Tafelberg oder ein Kraterrand, nicht zu nah
        let frame = 0;
        for (const turn of [-0.9, -0.5, 0.5, 0.9]) {
          const dx = towardX * Math.cos(turn) - towardZ * Math.sin(turn), dz = towardX * Math.sin(turn) + towardZ * Math.cos(turn);
          let most = 0;
          for (let r = 180; r < 2400; r *= 1.35) most = Math.max(most, (this.height(x + dx * r, z + dz * r) - h) / r);
          frame += Math.min(most, 0.08);
        }
        const extra = bonus(x, z);
        const score = frame * 12 - flat - ring * 0.004 + extra * 0.3;
        if (score <= bestScore) continue;
        if (this.walkReach(x, z) < 900) continue;
        bestScore = score;
        best = { x, z };
        if (frame > 0.2 && extra > 0) return best;
      }
    }
    return best;
  }

  /** Wie weit kommt man von hier zu Fuß? Füllt auf einem groben Raster, was flach genug zum Gehen ist. */
  private walkReach(x0: number, z0: number): number {
    const RES = 6, RADIUS = 1000;
    const n = Math.floor((2 * RADIUS) / RES);
    const heights = new Float32Array(n * n).fill(NaN);
    const at = (i: number, j: number) => {
      const o = j * n + i;
      if (Number.isNaN(heights[o])) heights[o] = this.height(x0 + (i - n / 2) * RES, z0 + (j - n / 2) * RES);
      return heights[o];
    };
    const limit = 1.19 * 2 * RES;
    const seen = new Uint8Array(n * n);
    const stack = [(n >> 1) * n + (n >> 1)];
    seen[stack[0]] = 1;
    let far = 0;
    while (stack.length) {
      const p = stack.pop()!;
      const i = p % n, j = Math.floor(p / n);
      far = Math.max(far, Math.hypot(i - n / 2, j - n / 2) * RES);
      if (far >= 900) return far;
      if (i < 2 || j < 2 || i >= n - 2 || j >= n - 2) continue;
      for (const [a, b] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
        const q = b * n + a;
        if (seen[q]) continue;
        if (Math.hypot(at(a + 1, b) - at(a - 1, b), at(a, b + 1) - at(a, b - 1)) > limit) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    return far;
  }
}

/** Die Landkarte des Mars: R Dünenfelder, G Helligkeit des Staubs. Weiches, in sich geschlossenes Rauschen, das Worker und Shader gleich lesen. */
function regionMap(seed: number): Uint8Array<ArrayBuffer> {
  const r = mulberry(seed ^ 0x4d415253);
  const field = (cells: number) => {
    const grid = Float32Array.from({ length: cells * cells }, () => r());
    return (u: number, v: number) => {
      const x = u * cells, y = v * cells;
      const i = Math.floor(x), j = Math.floor(y);
      const fx = smoothstep(0, 1, x - i), fy = smoothstep(0, 1, y - j);
      const at = (a: number, b: number) => grid[(b % cells) * cells + (a % cells)];
      const top = at(i, j) + (at(i + 1, j) - at(i, j)) * fx;
      return top + (at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fx - top) * fy;
    };
  };
  const dunes = [field(7), field(17), field(43)];
  const tone = [field(11), field(29), field(79)];
  const data = new Uint8Array(REGION_N * REGION_N * 4);
  for (let j = 0; j < REGION_N; j++) {
    for (let i = 0; i < REGION_N; i++) {
      const u = (i + 0.5) / REGION_N, v = (j + 0.5) / REGION_N;
      const o = (j * REGION_N + i) * 4;
      const dune = 0.55 * dunes[0](u, v) + 0.3 * dunes[1](u, v) + 0.15 * dunes[2](u, v);
      const bright = 0.5 * tone[0](u, v) + 0.32 * tone[1](u, v) + 0.18 * tone[2](u, v);
      data[o] = Math.round(smoothstep(0.58, 0.68, dune) * 255);
      data[o + 1] = Math.round(smoothstep(0.25, 0.75, bright) * 255);
      data[o + 2] = 0;
      data[o + 3] = 255;
    }
  }
  return data;
}
