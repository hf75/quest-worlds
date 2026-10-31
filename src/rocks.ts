import * as THREE from 'three';
import { fetchBinary, fetchJson } from './assets';
import type { Planet } from './planets';
import { hazeVertex, lightingFunctions, lightingUniforms, setPlanetDefine } from './shading';
import type { Caves, CaveSystem } from './caves';
import type { Terrain } from './terrain';
import { STRATA_PERIOD, type World, type WorldInfo } from './world';

interface ShapeInfo {
  name: string;
  kind: 'shard' | 'slab' | 'slabFar' | 'fin';
  start: number;
  count: number;
}

// Pro Stein im Streuplan: x, z, y, Drehung, Neigung x, Neigung z, Größe, Form
const ROCK_STRIDE = 8;
const BUCKET = 16;

const REACH = { shard: 16, slab: 72, macro: 1100 };
// Ab dieser Entfernung zeigt eine Platte die vereinfachte Form. Das spart den größten Teil der Dreiecke.
const SLAB_DETAIL_DISTANCE = 26;
// Die Platten 8..13 haben ihre einfache Fassung unter derselben Nummer plus diesem Abstand
const FAR_SLAB_OFFSET = 11;
const CAPACITY = { shard: 130, slab: 60, slabFar: 150, fin: 30 };

// Große Felsen werden je Zelle ausgewürfelt: aus Seed und Zelle, also immer dieselben an derselben Stelle
const CELL = 48;
const CANDIDATES = 3;
// Auf einer so steilen Fläche hielte kein Stein
const STEEPEST_FOR_STONES = 0.8;
// Die ersten Formen im Satz sind die kleinen Splitter
const SHARD_LAYERS = 8;
// Nach so vielen Metern werden die nahen Steine neu gesetzt, die großen Felsen viel seltener
const STEP = 0.75;
const PLAN_STEP = 8;
const PLAN_CAPACITY = 1200;
// Grobe Höhe eines Felsens im Verhältnis zu seiner Größe. Reicht, um beim Schweben über ihn hinwegzukommen.
const ROCK_HEIGHT = 1.4;
// Pro Brocken in der Höhle: wie der Streuplan, dazu Verdeckung und Hauptlicht
const CAVE_STONE_STRIDE = 10;

const vertexShader = `
  attribute float aAO;
  uniform vec3 uHead;
  uniform float uInvRadius;
  ${hazeVertex}
  varying vec3 vPos;
  varying vec3 vPlain;
  varying vec3 vNormal;
  varying float vAO;
  varying float vTint;
  varying vec2 vMacroLight;
  varying float vLarge;
  varying float vBed;
  varying vec3 vUp;

  void main() {
    // Ein Fels in der Schlucht liegt im selben Schatten wie der Boden unter ihm. Der Wert steht je Stein in der sonst
    // ungenutzten letzten Zeile der Matrix: Ihn je Eckpunkt aus der Textur zu lesen, käme bei so vielen Punkten teuer.
    mat4 inst = instanceMatrix;
    vMacroLight = vec2(inst[0][3], inst[1][3]);
    inst[0][3] = 0.0;
    inst[1][3] = 0.0;
    vec4 p = inst * vec4(position, 1.0);
    vPlain = p.xyz;
    vNormal = normalize(mat3(inst) * normal);
    vAO = aAO;
    vTint = fract(sin(dot(inst[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
    // Die Gesteinslagen liegen im Stein selbst und kippen mit ihm, denn er ist ja von oben heruntergestürzt
    float size = length(inst[0].xyz);
    vLarge = smoothstep(1.2, 2.6, size);
    vBed = position.y * size + vTint * 40.0;
    vUp = normalize(mat3(inst) * vec3(0.0, 1.0, 0.0));
    vec2 rel = p.xz - uHead.xz;
    p.y -= dot(rel, rel) * 0.5 * uInvRadius;
    vPos = p.xyz;
    #ifdef MARS
    hazeAt(p.xyz);
    #endif
    gl_Position = projectionMatrix * viewMatrix * p;
  }
`;

const fragmentShader = `
  ${lightingUniforms}
  uniform sampler2D uDetail;
  uniform sampler2D uStrata;
  uniform float uDetailSize;
  uniform vec3 uRockDark;
  uniform vec3 uRockLight;
  varying vec3 vPos;
  varying vec3 vPlain;
  varying vec3 vNormal;
  varying float vAO;
  varying float vTint;
  varying vec2 vMacroLight;
  varying float vLarge;
  varying float vBed;
  varying vec3 vUp;
  ${lightingFunctions}

  void main() {
    // Die Flächen sind plan, deshalb reicht eine Projektion auf die passende Achse statt teurem Überblenden
    vec3 n = normalize(vNormal);
    vec3 a = abs(n);
    vec2 uv;
    vec3 T, B;
    if (a.y > a.x && a.y > a.z) { uv = vPlain.xz; T = vec3(1.0, 0.0, 0.0); B = vec3(0.0, 0.0, 1.0); }
    else if (a.x > a.z) { uv = vPlain.zy; T = vec3(0.0, 0.0, 1.0); B = vec3(0.0, 1.0, 0.0); }
    else { uv = vPlain.xy; T = vec3(1.0, 0.0, 0.0); B = vec3(0.0, 1.0, 0.0); }

    vec4 d = texture2D(uDetail, uv / uDetailSize);
    vec2 e = d.xy * 2.0 - 1.0;
    vec2 s = -e / sqrt(max(1.0 - dot(e, e), 0.02));
    vec3 N = normalize(n - T * s.x - B * s.y);

    vec3 base = mix(uRockDark, uRockLight, vTint);
    vec3 albedo = base * (0.75 + 0.55 * vTint) * (0.2 + 1.6 * d.b);
    // Einige Flächen lagen beim Backen im Boden und stehen durch die Neigung nun frei: nie ganz schwarz werden lassen
    float ao = max(vAO, 0.22) * (0.55 + 0.9 * d.b) * (0.38 + 0.62 * vMacroLight.x);
    float rough = clamp(d.a * 1.12, 0.08, 1.0);

    // Große Blöcke haben Flächen, die viel breiter sind als die Detailkarte. Zwei Zugriffe mehr geben ihnen Lagen und
    // großes Korn, sonst sähen sie von Nahem glatt aus wie Beton. Die kleinen Steine sparen sich das.
    if (vLarge > 0.0) {
      vec4 bed = texture2D(uStrata, vec2(vBed / ${STRATA_PERIOD.toFixed(1)}, 0.5));
      vec4 coarse = texture2D(uDetail, uv / (uDetailSize * 5.3));
      vec2 ce = coarse.xy * 2.0 - 1.0;
      vec2 cs = -ce / sqrt(max(1.0 - dot(ce, ce), 0.02));
      #ifdef MARS
      // Basalt hat keine Lagen, nur grobes Korn
      N = normalize(N + vLarge * (-T * cs.x * 0.8 - B * cs.y * 0.8));
      albedo *= mix(1.0, 0.55 + 0.9 * coarse.b, vLarge);
      ao *= 1.0 - vLarge * 0.3 * (1.0 - coarse.b);
      #else
      N = normalize(N + vLarge * (vUp * (bed.r * 2.0 - 1.0) * 0.7 - T * cs.x * 0.8 - B * cs.y * 0.8));
      albedo *= mix(1.0, (0.62 + 0.76 * bed.g) * (0.55 + 0.9 * coarse.b), vLarge);
      ao *= 1.0 - vLarge * (0.7 * bed.b + 0.3 * (1.0 - coarse.b));
      #endif
    }

    #ifdef MARS
    // Auf allem, was nach oben zeigt, liegt Staub
    float dusty = smoothstep(0.25, 0.8, N.y) * smoothstep(0.2, 0.62, d.b + 0.25 * vTint);
    albedo = mix(albedo, vec3(0.28, 0.14, 0.074) * (0.7 + 0.6 * d.b), dusty * 0.62);
    rough = mix(rough, 0.96, dusty);
    #endif

    // Direktes Licht kommt nicht in die Spalten zwischen den Platten: Auch dort gilt die gebackene Verdeckung, nicht nur fürs Umgebungslicht
    float open = mix(0.25, 1.0, smoothstep(0.2, 0.7, vAO));
    vec3 V = normalize(cameraPosition - vPos);
    gl_FragColor = vec4(toDisplay(shadeSurface(vPos, N, V, albedo, rough, ao, 0.8 * vMacroLight.y * open, 1.0, mix(0.55, 1.0, ao) * open)), 1.0);
  }
`;

interface Layer {
  mesh: THREE.InstancedMesh;
  used: number;
}

const m = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
const pos = new THREE.Vector3();
const scl = new THREE.Vector3();

function cellRandom(seed: number, cx: number, cz: number) {
  let a = (Math.imul(seed, 0x9e3779b1) ^ Math.imul(cx, 0x85ebca6b) ^ Math.imul(cz, 0xc2b2ae35)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rocks {
  readonly group = new THREE.Group();
  private readonly terrain: Terrain;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private world: World | null = null;
  private caves: Caves | null = null;
  private layers: Layer[] = [];
  private meso = new Float32Array(0);
  private shardBuckets: number[][] = [];
  private slabBuckets: number[][] = [];
  private lastX = Infinity;
  private lastZ = Infinity;
  private readonly blockers: { x: number; z: number; r: number; top: number }[] = [];
  private readonly cells = new Map<number, Float32Array>();
  private readonly slopeOut = { x: 0, z: 0 };
  private readonly lightOut = { ao: 1, key: 1 };
  private readonly shiftOut = { x: 0, z: 0, edge: 0 };
  private readonly probeOut = { x: 0, z: 0, edge: 0 };
  private shardsPending = false;
  private wasDeep = false;
  private readonly caveStones = new Map<CaveSystem, Float32Array>();
  private planX = Infinity;
  private planZ = Infinity;
  private planCount = 0;
  private readonly planMatrices = new Float32Array(PLAN_CAPACITY * 16);
  private readonly planLayers = new Uint8Array(PLAN_CAPACITY);
  private readonly planBlocks = new Float32Array(PLAN_CAPACITY * 4);
  private readonly info: WorldInfo = { distance: 0, wall: 0, cut: 0, tangentX: 0, tangentZ: 0 };
  private material: THREE.ShaderMaterial | null = null;
  private shapesFrom = '';

  constructor(terrain: Terrain, uniforms: Record<string, THREE.IUniform>) {
    this.terrain = terrain;
    this.uniforms = uniforms;
  }

  private async loadShapes(rockBase: string) {
    const [info, geo] = await Promise.all([
      fetchJson<{ stride: number; shapes: ShapeInfo[] }>(`${rockBase}/rocks.json`),
      fetchBinary(`${rockBase}/rocks.bin`),
    ]);
    for (const { mesh } of this.layers) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.layers = [];

    const raw = new Float32Array(geo);
    const material = this.material ??= new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms: this.uniforms });
    for (const shape of info.shapes) {
      const part = raw.subarray(shape.start * info.stride, (shape.start + shape.count) * info.stride);
      const ib = new THREE.InterleavedBuffer(part, info.stride);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0));
      g.setAttribute('normal', new THREE.InterleavedBufferAttribute(ib, 3, 3));
      g.setAttribute('aAO', new THREE.InterleavedBufferAttribute(ib, 1, 6));
      const mesh = new THREE.InstancedMesh(g, material, CAPACITY[shape.kind]);
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
      this.layers.push({ mesh, used: 0 });
    }
  }

  /** Formen und Streuplan der Steine gehören zu einer Welt. Die Kachel muss schon geladen sein. */
  async setPlanet(planet: Planet) {
    if (planet.rocks !== this.shapesFrom) await this.loadShapes(planet.rocks);
    this.shapesFrom = planet.rocks;
    this.meso = new Float32Array(await fetchBinary(`${planet.surface}/rocks_meso.bin`));
    setPlanetDefine(this.material!, planet.id === 'mars');

    // Streuplan nach Zellen ordnen, damit pro Schritt nur die nahen Steine angefasst werden
    const cells = BUCKET * BUCKET;
    this.shardBuckets = Array.from({ length: cells }, () => []);
    this.slabBuckets = Array.from({ length: cells }, () => []);
    const size = this.terrain.mesoSize;
    const count = this.meso.length / ROCK_STRIDE;
    for (let i = 0; i < count; i++) {
      const o = i * ROCK_STRIDE;
      const cx = Math.min(BUCKET - 1, Math.floor((this.meso[o] / size) * BUCKET));
      const cz = Math.min(BUCKET - 1, Math.floor((this.meso[o + 1] / size) * BUCKET));
      const kind = this.meso[o + 7];
      (kind < 8 ? this.shardBuckets : this.slabBuckets)[cz * BUCKET + cx].push(o);
    }
  }

  setWorld(world: World, caves: Caves) {
    this.world = world;
    this.caves = caves;
    this.caveStones.clear();
    this.cells.clear();
    this.lastX = Infinity;
    this.lastZ = Infinity;
    this.planX = Infinity;
    this.planZ = Infinity;
    this.blockers.length = 0;
  }

  /**
   * Schiebt den Gehenden um große Felsen herum. Durch Steine hindurchzulaufen zerstört die Illusion sofort.
   * Wer schwebt, gibt die Höhe seiner Füße an: Was darunter liegt, ist kein Hindernis mehr.
   */
  pushOut(x: number, z: number, out: { x: number; z: number }, feet = -Infinity) {
    out.x = x;
    out.z = z;
    for (const b of this.blockers) {
      if (feet > b.top) continue;
      const dx = out.x - b.x, dz = out.z - b.z;
      const d = Math.hypot(dx, dz);
      if (d < b.r && d > 1e-4) {
        out.x = b.x + (dx / d) * b.r;
        out.z = b.z + (dz / d) * b.r;
      }
    }
  }

  /** deep: tief im Berg. Dort zählen nur die Brocken im Gang, alles draußen ist ohnehin verdeckt. */
  update(head: THREE.Vector3, deep: boolean) {
    // Die Arbeit verteilt sich auf zwei Bilder, damit keines allein zu lang wird: In VR fällt jedes verpasste Bild auf.
    if (this.shardsPending) {
      this.shardsPending = false;
      for (let i = 0; i < SHARD_LAYERS; i++) this.layers[i].used = 0;
      if (!deep) this.addMeso(head, this.shardBuckets, REACH.shard);
      this.addCaveStones(head, true);
      this.finish(0, SHARD_LAYERS);
      return;
    }
    if (Math.hypot(head.x - this.lastX, head.z - this.lastZ) < STEP && deep === this.wasDeep) return;
    this.wasDeep = deep;
    this.blockers.length = 0;
    this.lastX = head.x;
    this.lastZ = head.z;
    for (let i = SHARD_LAYERS; i < this.layers.length; i++) this.layers[i].used = 0;

    if (!deep) {
      if (Math.hypot(head.x - this.planX, head.z - this.planZ) >= PLAN_STEP) this.planMacro(head);
      this.addMeso(head, this.slabBuckets, REACH.slab);
      this.addPlan();
    }
    this.addCaveStones(head, false);
    this.finish(SHARD_LAYERS, this.layers.length);
    this.shardsPending = true;
  }

  /**
   * Gesteinsbrocken in einem Gang, aus dem Seed gewürfelt: viele kleine und einige große an den Wänden. Ohne sie läge dort ein
   * blanker Boden wie frisch gefegt. Das Licht steht je Stein fest, denn es hängt nur vom Weg zum Mundloch ab.
   */
  private stonesOf(system: CaveSystem): Float32Array {
    const known = this.caveStones.get(system);
    if (known) return known;
    const caves = this.caves!;
    const placed: number[] = [];
    const r = cellRandom(this.world!.seed ^ 0x51ed27, system.cellX, system.cellZ);
    for (const g of system.segments) {
      if (g.s < 1) continue;
      const length = 1 / Math.sqrt(g.invLen2);
      const count = Math.round((length * (g.r + g.dr / 2)) / 3);
      for (let i = 0; i < count; i++) {
        const t = r(), side = r() * 2 - 1, kindRoll = r(), sizeRoll = r(), yaw = r() * Math.PI * 2, tiltX = r() - 0.5, tiltZ = r() - 0.5;
        const width = g.r + g.dr * t;
        // Große Brocken liegen eher am Rand, dorthin sind sie gestürzt
        const big = kindRoll < 0.3;
        const across = big ? Math.sign(side) * (0.45 + 0.35 * Math.abs(side)) : side * 0.82;
        const lx = g.ez / (Math.hypot(g.ex, g.ez) || 1), lz = -g.ex / (Math.hypot(g.ex, g.ez) || 1);
        const x = g.ax + g.ex * t + lx * across * width, z = g.az + g.ez * t + lz * across * width;
        const floor = g.floor + g.dFloor * t;
        const scale = big ? 0.9 + sizeRoll * sizeRoll * 3 : 0.18 + sizeRoll * sizeRoll * 1.1;
        // In der Wand stecken darf nichts
        if (caves.tube([g], x, floor + 0.6, z) < 0.2 + scale * 0.4) continue;
        const day = Math.exp(-Math.max(0, g.s + g.dS * t) / 15);
        const kind = big ? 8 + Math.floor(sizeRoll * 5.99) : Math.floor(sizeRoll * 7.99);
        placed.push(x, z, floor - 0.04 * scale, yaw, tiltX * (big ? 0.7 : 1.2), tiltZ * (big ? 0.7 : 1.2), scale, kind, Math.max(0.012, day), day * day);
      }
    }
    const list = new Float32Array(placed);
    this.caveStones.set(system, list);
    return list;
  }

  private addCaveStones(head: THREE.Vector3, small: boolean) {
    const system = this.caves?.systemAt(head.x, head.z);
    if (!system || this.caves!.mouthDistance(system, head.x, head.z) > 460) return;
    const list = this.stonesOf(system);
    const reach = small ? 26 : 70;
    for (let o = 0; o < list.length; o += CAVE_STONE_STRIDE) {
      const kind = list[o + 7];
      if (kind < SHARD_LAYERS !== small) continue;
      const x = list[o], z = list[o + 1];
      const dx = x - head.x, dz = z - head.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > reach * reach) continue;
      const d = Math.sqrt(d2);
      const far = !small && d > SLAB_DETAIL_DISTANCE + list[o + 6] * 8;
      const layer = this.layers[far ? kind + FAR_SLAB_OFFSET : kind];
      if (!layer || layer.used >= layer.mesh.instanceMatrix.count) continue;
      const s = list[o + 6];
      if (s > 0.7) this.blockers.push({ x, z, r: s * 0.72 + 0.25, top: list[o + 2] + s * ROCK_HEIGHT });
      e.set(list[o + 4], list[o + 3], list[o + 5], 'YXZ');
      q.setFromEuler(e);
      pos.set(x, list[o + 2], z);
      scl.set(s, s, s);
      m.compose(pos, q, scl);
      // Die Felsen rechnen die Verdeckung um, damit sie nie ganz schwarz werden. Hier soll es aber wirklich dunkel sein können.
      m.elements[3] = (list[o + 8] - 0.38) / 0.62;
      m.elements[7] = list[o + 9];
      layer.mesh.setMatrixAt(layer.used++, m);
    }
  }

  private finish(from: number, to: number) {
    for (let i = from; i < to; i++) {
      const l = this.layers[i];
      l.mesh.count = l.used;
      l.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private addMeso(head: THREE.Vector3, buckets: number[][], reachOnGround: number) {
    // Von hoch oben sind die kleinen Steine außer Reichweite, genau wie zu weit entfernte am Boden
    const altitude = this.terrain.altitude;
    if (altitude >= reachOnGround) return;
    const reach = Math.sqrt(reachOnGround * reachOnGround - altitude * altitude);
    const size = this.terrain.mesoSize;
    const cell = size / BUCKET;
    const x0 = Math.floor((head.x - reach) / cell), x1 = Math.floor((head.x + reach) / cell);
    const z0 = Math.floor((head.z - reach) / cell), z1 = Math.floor((head.z + reach) / cell);
    const slope = this.slopeOut;
    const shift = this.shiftOut, probe = this.probeOut;
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        // Der Streuplan gehört zur Kachel. Jede Kachelzelle ist anders verschoben, also auch ihre Steine.
        this.terrain.mesoCell((cx + 0.5) * cell, (cz + 0.5) * cell, shift);
        const wx = (((cx + Math.round(shift.x / cell)) % BUCKET) + BUCKET) % BUCKET;
        const wz = (((cz + Math.round(shift.z / cell)) % BUCKET) + BUCKET) % BUCKET;
        const ox = (cx - wx) * cell;
        const oz = (cz - wz) * cell;
        const nearEdge = shift.edge < 0.2;
        for (const o of buckets[wz * BUCKET + wx]) {
          const x = this.meso[o] + ox, z = this.meso[o + 1] + oz;
          const dx = x - head.x, dz = z - head.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > reach * reach) continue;
          if (nearEdge) {
            // Am Rand einer Zelle passt der Stein nicht mehr zum überblendeten Boden: dort lieber keiner
            this.terrain.mesoCell(x, z, probe);
            if (probe.x !== shift.x || probe.z !== shift.z || probe.edge < 0.06) continue;
          }
          this.terrain.slope(x, z, slope);
          if (slope.x * slope.x + slope.z * slope.z > STEEPEST_FOR_STONES * STEEPEST_FOR_STONES) continue;
          if (this.caves?.inMouth(x, z, 2)) continue;
          // Das Wasser bleibt ein freier Spiegel
          if (this.world!.waterLevel(x, z) > this.terrain.macroAt(x, z)) continue;
          // Auf Dünen liegt kein Geröll
          if (this.world!.dune(x, z) > 0.25) continue;
          const y = this.meso[o + 2] + this.terrain.macroAt(x, z);
          const d = Math.sqrt(d2);
          this.place(this.meso, o, x, y, z, 1 - THREE.MathUtils.smoothstep(d, reach * 0.8, reach), d);
        }
      }
    }
  }

  /** Die großen Felsen einer Zelle: Schutt am Fuß der Wände, Nadeln und Blöcke auf der Hochebene. */
  private scatterCell(cx: number, cz: number): Float32Array {
    const key = (cx + 32768) * 65536 + (cz + 32768);
    const known = this.cells.get(key);
    if (known) return known;
    const world = this.world!;
    const info = this.info;
    const r = cellRandom(world.seed, cx, cz);
    const placed: number[] = [];
    for (let c = 0; c < CANDIDATES; c++) {
      const x = (cx + r()) * CELL, z = (cz + r()) * CELL;
      const roll = r(), a = r(), b = r(), yaw = r() * Math.PI * 2, tiltX = r() - 0.5, tiltZ = r() - 0.5, shape = r();
      const h = world.height(x, z, info);
      let scale = 0, kind = 8 + Math.floor(shape * 6), tilt = 0.7;
      if (info.wall > 0.01 && info.wall < 0.42 && info.cut > 25) {
        if (roll < 0.85) scale = 2.5 + a * a * 7;
      } else if (info.wall <= 0.01 && info.cut > 20) {
        if (roll < 0.18) scale = 1.6 + a * a * 6;
      } else if (roll < 0.05) {
        // Felsnadeln gehören zum Schiefer. Auf dem Mars liegen die Brocken einfach da.
        if (b < 0.3 && !world.mars) {
          kind = 14 + Math.floor(shape * 5);
          scale = 7 + a * a * 27;
          tilt = 0.24;
        } else scale = 2.2 + a * a * 9;
      }
      if (scale === 0 || this.caves?.inMouth(x, z, scale + 3) || world.waterLevel(x, z) > h || world.dune(x, z) > 0.25) continue;
      // Auf den tiefsten Punkt unter dem Stein setzen, sonst hinge er an einem Hang in der Luft
      const foot = scale * 0.5;
      const xp = world.height(x + foot, z), xm = world.height(x - foot, z);
      const zp = world.height(x, z + foot), zm = world.height(x, z - foot);
      const steep = Math.hypot(xp - xm, zp - zm) / (2 * foot);
      if (steep > (world.mars ? 0.6 : 1)) continue;
      const y = Math.min(h, xp, xm, zp, zm) - 0.06 * scale;
      placed.push(x, z, y, yaw, tiltX * tilt, tiltZ * tilt, scale, kind);
    }
    const list = new Float32Array(placed);
    this.cells.set(key, list);
    return list;
  }

  /** Die großen Felsen ändern sich beim Gehen kaum. Ihre Matrizen werden auf Vorrat berechnet und nur alle paar Meter neu. */
  private planMacro(head: THREE.Vector3) {
    this.planX = head.x;
    this.planZ = head.z;
    this.planCount = 0;
    if (!this.world) return;
    const reach = REACH.macro;
    const x0 = Math.floor((head.x - reach) / CELL), x1 = Math.floor((head.x + reach) / CELL);
    const z0 = Math.floor((head.z - reach) / CELL), z1 = Math.floor((head.z + reach) / CELL);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const list = this.scatterCell(cx, cz);
        for (let o = 0; o < list.length && this.planCount < PLAN_CAPACITY; o += ROCK_STRIDE) {
          const x = list[o], z = list[o + 1];
          const dx = x - head.x, dz = z - head.z;
          const d = Math.sqrt(dx * dx + dz * dz);
          // Ein kleiner Block in einem Kilometer wäre nur noch ein Pixel, kostet aber dieselben Dreiecke
          if (d > Math.min(reach, list[o + 6] * 70)) continue;
          const kind = list[o + 7];
          const far = kind >= 8 && kind < 14 && d > SLAB_DETAIL_DISTANCE + list[o + 6] * 8;
          const s = list[o + 6];
          e.set(list[o + 4], list[o + 3], list[o + 5], 'YXZ');
          q.setFromEuler(e);
          pos.set(x, list[o + 2] + this.terrain.mesoAt(x, z), z);
          scl.set(s, s, s);
          m.compose(pos, q, scl);
          this.terrain.lightAt(x, z, this.lightOut);
          m.elements[3] = this.lightOut.ao;
          m.elements[7] = this.lightOut.key;
          const c = this.planCount++;
          m.toArray(this.planMatrices, c * 16);
          this.planLayers[c] = far ? kind + FAR_SLAB_OFFSET : kind;
          this.planBlocks[c * 4] = x;
          this.planBlocks[c * 4 + 1] = z;
          this.planBlocks[c * 4 + 2] = s * 0.72 + 0.25;
          this.planBlocks[c * 4 + 3] = pos.y + s * ROCK_HEIGHT;
        }
      }
    }
    // Was weit hinter dem Gehenden liegt, vergessen: Es lässt sich jederzeit genauso neu auswürfeln
    if (this.cells.size > 8000) {
      for (const key of this.cells.keys()) {
        const cx = Math.floor(key / 65536) - 32768, cz = key % 65536 - 32768;
        if (cx < x0 - 8 || cx > x1 + 8 || cz < z0 - 8 || cz > z1 + 8) this.cells.delete(key);
      }
    }
  }

  private addPlan() {
    for (let c = 0; c < this.planCount; c++) {
      const layer = this.layers[this.planLayers[c]];
      if (!layer || layer.used >= layer.mesh.instanceMatrix.count) continue;
      layer.mesh.instanceMatrix.array.set(this.planMatrices.subarray(c * 16, c * 16 + 16), layer.used++ * 16);
      const x = this.planBlocks[c * 4], z = this.planBlocks[c * 4 + 1];
      const dx = x - this.lastX, dz = z - this.lastZ;
      if (dx * dx + dz * dz < 3600) this.blockers.push({ x, z, r: this.planBlocks[c * 4 + 2], top: this.planBlocks[c * 4 + 3] });
    }
  }

  private place(list: Float32Array, o: number, x: number, y: number, z: number, grow: number, d: number) {
    const kind = list[o + 7];
    const far = kind >= 8 && kind < 14 && d > SLAB_DETAIL_DISTANCE + list[o + 6] * 8;
    const layer = this.layers[far ? kind + FAR_SLAB_OFFSET : kind];
    if (!layer || layer.used >= layer.mesh.instanceMatrix.count) return;
    const s = list[o + 6] * grow;
    if (s > 0.7) {
      const dx = x - this.lastX, dz = z - this.lastZ;
      if (dx * dx + dz * dz < 3600) this.blockers.push({ x, z, r: s * 0.72 + 0.25, top: y + s * ROCK_HEIGHT });
    }
    e.set(list[o + 4], list[o + 3], list[o + 5], 'YXZ');
    q.setFromEuler(e);
    pos.set(x, y, z);
    scl.set(s, s, s);
    m.compose(pos, q, scl);
    this.terrain.lightAt(x, z, this.lightOut);
    m.elements[3] = this.lightOut.ao;
    m.elements[7] = this.lightOut.key;
    layer.mesh.setMatrixAt(layer.used++, m);
  }
}
