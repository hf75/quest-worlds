// Vernetzt die Höhlen im Hintergrund, die nächsten Würfel zuerst. Ein eigener Worker, damit die Bodenfenster beim Gehen nie
// auf eine Höhle warten müssen.
import { chunksOf, CHUNK_SIZE, meshChunk } from './caveMesh';
import { CAVE_CELL, Caves, type CaveSystem } from './caves';
import type { PlanetId } from './planets';
import { World } from './world';

// Das Mundloch sieht man schon von Weitem, solange der Boden dort ausgespart ist: bis er ins gröbere Fenster übergeht
const MOUTH_RANGE = 520;
const TUBE_RANGE = 120;
const FORGET = 60;
// So viele Zellen weit nennt der Worker die Mundlöcher für die Lichtfahnen: rund 2 km, weiter sieht man über den Horizont kaum
const LIGHT_CELLS = 3;
const POOL_REACH = 1800;

export interface CaveInit {
  type: 'init';
  generation: number;
  seed: number;
  planet: PlanetId;
}
export interface CaveMove {
  type: 'move';
  generation: number;
  x: number;
  y: number;
  z: number;
}
export interface CaveChunk {
  type: 'chunk';
  generation: number;
  key: string;
  position: Float32Array<ArrayBuffer>;
  normal: Int8Array<ArrayBuffer>;
  light: Uint8Array<ArrayBuffer>;
  index: Uint32Array<ArrayBuffer>;
  center: [number, number, number];
  radius: number;
  tube: boolean;
}
export interface CaveDrop {
  type: 'drop';
  generation: number;
  key: string;
}
export interface CaveIdle {
  type: 'idle';
  generation: number;
}
/** Das Mundloch ist vernetzt: Erst jetzt darf der Boden dort ein Loch bekommen. Oder es ist zu weit weg und braucht keines mehr. */
export interface CaveMouthState {
  type: 'mouth';
  generation: number;
  id: string;
  open: boolean;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  radius: number;
}
/** Alle Mundlöcher im weiten Umkreis, je vier Zahlen: x, y, z und ein Zufallswert. */
export interface CaveMouthList {
  type: 'mouths';
  generation: number;
  list: Float32Array<ArrayBuffer>;
  /** Die Wasserbecken im selben Umkreis, je vier Zahlen: x, Wasserspiegel, z, Radius */
  pools: Float32Array<ArrayBuffer>;
}
export type ToCaveWorker = CaveInit | CaveMove;
export type FromCaveWorker = CaveChunk | CaveDrop | CaveIdle | CaveMouthState | CaveMouthList;

interface Plan {
  system: CaveSystem;
  mouth: Map<string, [number, number, number]>;
  tube: Map<string, [number, number, number]>;
  open: boolean;
}

function announceMouth(plan: Plan, open: boolean) {
  plan.open = open;
  const m = plan.system.mouth;
  post({ type: 'mouth', generation, id: `${plan.system.cellX},${plan.system.cellZ}`, open, ax: m.ax, az: m.az, bx: m.bx, bz: m.bz, radius: m.radius });
}

let generation = 0;
let caves: Caves;
const plans = new Map<CaveSystem, Plan>();
const built = new Set<string>();
const head = { x: 0, y: 0, z: 0 };
let listedX = NaN;
let listedZ = NaN;
let scheduled = false;
let announcedIdle = true;

function post(message: FromCaveWorker, transfer: ArrayBuffer[] = []) {
  (self as unknown as Worker).postMessage(message, transfer);
}

/** Nur wenn der Kopf in eine neue Zelle kommt. Das Berechnen fremder Höhlensysteme hält hier niemanden auf. */
function announceMouths() {
  const cx = Math.floor(head.x / CAVE_CELL), cz = Math.floor(head.z / CAVE_CELL);
  if (cx === listedX && cz === listedZ) return;
  listedX = cx;
  listedZ = cz;
  const list: number[] = [];
  for (let j = -LIGHT_CELLS; j <= LIGHT_CELLS; j++) {
    for (let i = -LIGHT_CELLS; i <= LIGHT_CELLS; i++) {
      const system = caves.systemInCell(cx + i, cz + j);
      if (!system) continue;
      const m = system.mouth;
      const r = Math.sin((cx + i) * 12.9898 + (cz + j) * 78.233) * 43758.5453;
      list.push(m.ax, caves.world.height(m.ax, m.az), m.az, r - Math.floor(r));
    }
  }
  const message = new Float32Array(list);
  const pools = caves.world.poolsAround((cx + 0.5) * CAVE_CELL, (cz + 0.5) * CAVE_CELL, POOL_REACH);
  post({ type: 'mouths', generation, list: message, pools }, [message.buffer, pools.buffer]);
}

function distanceTo(c: [number, number, number]) {
  const half = CHUNK_SIZE / 2;
  return Math.hypot((c[0] * CHUNK_SIZE + half) - head.x, (c[1] * CHUNK_SIZE + half) - head.y, (c[2] * CHUNK_SIZE + half) - head.z);
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(work, 0);
}

/** Immer nur ein Würfel, dann zurück an die Nachrichtenschleife: So gilt für den nächsten schon die neue Kopfposition. */
function work() {
  scheduled = false;
  if (!caves) return;
  const cx = Math.floor(head.x / 700), cz = Math.floor(head.z / 700);
  const generationNow = generation;
  let best: { plan: Plan; key: string; at: [number, number, number]; surface: boolean; d: number } | null = null;

  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const system = caves.systemInCell(cx + i, cz + j);
      if (!system) continue;
      let plan = plans.get(system);
      if (!plan) {
        const { mouth, tube } = chunksOf(caves, system);
        plan = { system, mouth, tube, open: false };
        plans.set(system, plan);
      }
      for (const [key, at] of plan.mouth) {
        if (built.has(key)) continue;
        const d = distanceTo(at);
        if (d < MOUTH_RANGE && (!best || d < best.d)) best = { plan, key, at, surface: true, d };
      }
      for (const [key, at] of plan.tube) {
        if (built.has(key)) continue;
        const d = distanceTo(at);
        if (d < TUBE_RANGE && (!best || d < best.d)) best = { plan, key, at, surface: false, d };
      }
    }
  }

  // Was weit weg ist, wird wieder freigegeben. Das Mundloch später, denn es ist auch länger zu sehen.
  for (const plan of plans.values()) {
    for (const [key, at] of plan.tube) {
      if (built.has(key) && distanceTo(at) > TUBE_RANGE + FORGET) {
        built.delete(key);
        post({ type: 'drop', generation, key });
      }
    }
    for (const [key, at] of plan.mouth) {
      if (built.has(key) && distanceTo(at) > MOUTH_RANGE + FORGET) {
        // Das Loch im Boden muss zuerst zu, sonst schaute man hindurch
        if (plan.open) announceMouth(plan, false);
        built.delete(key);
        post({ type: 'drop', generation, key });
      }
    }
    if (!plan.open && [...plan.mouth.keys()].every((key) => built.has(key))) announceMouth(plan, true);
  }

  if (!best) {
    if (!announcedIdle) {
      announcedIdle = true;
      post({ type: 'idle', generation });
    }
    return;
  }
  announcedIdle = false;
  built.add(best.key);
  const mesh = meshChunk(caves, best.plan.system, best.at[0], best.at[1], best.at[2], best.surface);
  if (mesh && generationNow === generation) {
    post(
      { type: 'chunk', generation, key: best.key, tube: !best.surface, ...mesh },
      [mesh.position.buffer, mesh.normal.buffer, mesh.light.buffer, mesh.index.buffer],
    );
  }
  schedule();
}

self.onmessage = (event: MessageEvent<ToCaveWorker>) => {
  const message = event.data;
  if (message.type === 'init') {
    generation = message.generation;
    caves = new Caves(new World(message.seed, message.planet));
    plans.clear();
    built.clear();
    announcedIdle = false;
    listedX = listedZ = NaN;
  } else if (message.generation !== generation) return;
  else {
    head.x = message.x;
    head.y = message.y;
    head.z = message.z;
    announceMouths();
  }
  schedule();
};
