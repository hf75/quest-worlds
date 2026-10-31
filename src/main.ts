import * as THREE from 'three';
import { trackProgress } from './assets';
import { CaveLights } from './caveLights';
import { CaveMeshes } from './caveMeshes';
import { Dust } from './dust';
import type { CaveChunk, CaveMouthState, FromCaveWorker, ToCaveWorker } from './caveWorker';
import { Caves } from './caves';
import type { FromWorker, RectMessage, ToWorker } from './clips';
import { Hud } from './hud';
import { MarsSky } from './marsSky';
import { Music, MUSIC_RATE } from './music';
import { PLANET_LIST, PLANETS, type Planet, type PlanetId } from './planets';
import { Rocks } from './rocks';
import type { Sky } from './sky';
import { GeneratedSky } from './skyGen';
import { Terrain } from './terrain';
import { installTrace, trace, traceFrame, traceSession, traceTail } from './trace';
import { Water } from './water';
import { mulberry, World } from './world';

const EYE_HEIGHT = 1.65;
const WALK_SPEED = 1.25;
// tan 50°: Steiler kommt man nicht hinauf und nicht hinunter. Wer an einer Kante hinabstürzt, dem wird in VR sofort übel.
const WALK_LIMIT = 1.19;
const DEFAULT_SEED = 1;
// So viele fertige Rechtecke je Bild hochladen. Beim Gehen sind es meist nur eines oder zwei.
const UPLOADS_PER_FRAME = 4;
const CAVE_UPLOADS_PER_FRAME = 2;
// Schweben: Abstand der Füße zum Boden, Grenze nach oben und wie schnell es von selbst aufwärts geht, wenn eine Wand kommt.
// Über der Höchstgrenze würde man den Rand des berechneten Bodens sehen.
const HOVER_CLEARANCE = 0.6;
const HOVER_MAX_ALTITUDE = 300;
const HOVER_MAX_RISE = 7;
const HOVER_CLIMB_SPEED = 4;
// Drehen mit dem rechten Stick: Am Anschlag rund 75° je Sekunde, bei wenig Ausschlag viel langsamer
const TURN_SPEED = 1.3;
const TURN_DEADZONE = 0.15;
// Die Home-Taste zeigt sich nur daran, dass das Systemmenü die Szene verdeckt. Das tut auch manches andere, vor allem das Begrenzungsmenü
// der Quest, das rund 3 s nach dem Eintritt aufgehen kann. Darum muss die Szene vorher so lange sichtbar gewesen sein, und das Menü muss so lange offen bleiben.
const HOME_SETTLED_MS = 6000;
const HOME_HOLD_MS = 800;
const EARLY_END_MS = 20000;

const params = new URLSearchParams(location.search);
const overlay = document.getElementById('overlay')!;
const statusLine = document.getElementById('status')!;
const enterButton = document.getElementById('enter') as HTMLButtonElement;
const traceLine = document.getElementById('trace')!;
const planetChoices = document.getElementById('planets')!;

// Der Stencil-Puffer merkt sich, wo Wasser zu sehen ist: Nur dort wird der Himmel ein zweites Mal gezeichnet
const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, powerPreference: 'high-performance' });
installTrace(renderer);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
// Zum Ausprobieren auf der Quest über die Adresse einstellbar, z. B. ?scale=1.2&foveation=0.7&hz=90
renderer.xr.setFoveation(Number(params.get('foveation') ?? 0.5));
renderer.xr.setFramebufferScaleFactor(Number(params.get('scale') ?? 1));
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(80, innerWidth / innerHeight, 0.05, 6000);
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);
const hud = new Hud();
camera.add(hud.panel);

const shared: Record<string, THREE.IUniform> = {
  uRockDark: { value: new THREE.Color() },
  uRockLight: { value: new THREE.Color() },
  uSky: { value: null },
  uSkyLod: { value: 6.5 },
  uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
  // Das Licht kommt flach aus Richtung der Galaxie. Es muss deutlich stärker sein als das Umgebungslicht,
  // sonst verschwindet das Relief des Schiefers.
  uKeyColor: { value: new THREE.Color(0.75, 0.69, 0.62) },
  uKeySpec: { value: new THREE.Vector2(0.03, 0.75) }, // Aufweitung und Stärke des Glanzes
  uAmbientTop: { value: new THREE.Color(0.10, 0.12, 0.165) },
  uAmbientLow: { value: new THREE.Color(0.02, 0.021, 0.027) },
  uLampPos: { value: new THREE.Vector3(0, -1000, 0) },
  uLampColor: { value: new THREE.Color(0, 0, 0) },
  uLampFalloff: { value: 1 },
  uExposure: { value: Number(params.get('exposure') ?? 1.3) },
};

const terrain = new Terrain(shared);
scene.add(terrain.mesh);
const rocks = new Rocks(terrain, terrain.uniforms);
scene.add(rocks.group);
const caveMeshes = new CaveMeshes(terrain.uniforms);
scene.add(caveMeshes.group);
const caveLights = new CaveLights(terrain.uniforms);
scene.add(caveLights.mesh);
const water = new Water(terrain.uniforms);
scene.add(...water.objects);
const dust = new Dust(terrain.uniforms);
scene.add(...dust.objects);
let stencilWorks = true;
let stencilChecked = false;

// Ein Pixel im Headset, als Winkel. Was feiner wäre, flimmert.
const XR_PIXEL_ANGLE = 0.00105;
// Eine warme Lampe vor dem Kopf. In der Höhle geht sie von selbst an und ist viel stärker, denn dort ist sie das einzige Licht. Wer sie ausschaltet, dem bleibt sie aus.
const LAMP_LIGHT = new THREE.Color(6.5, 4.6, 2.6);
const LAMP_CAVE_GLOW = 2.4;
const lamp = { on: false, level: 0, glow: 1, byCave: false, refused: false };
const lampAt = new THREE.Vector3();
let sightCheck = 0;
let deepInCave = false;
let wasOnWater = false;

function toggleLamp() {
  lamp.on = !lamp.on;
  lamp.byCave = false;
  lamp.refused = !lamp.on;
}

// Schwarze Hülle um den Kopf: Der Wechsel in eine neue Welt ist so sanft und zeigt nie halb gerechnetes Gelände
const fade = new THREE.Mesh(
  new THREE.SphereGeometry(1, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false }),
);
fade.renderOrder = 90;
fade.frustumCulled = false;
fade.visible = false;
scene.add(fade);
let fadeTarget = 0;
let fadeDone: (() => void) | null = null;

function fadeTo(value: number): Promise<void> {
  fadeTarget = value;
  return new Promise((resolve) => { fadeDone = resolve; });
}

function updateFade(dt: number) {
  const material = fade.material;
  const step = dt / 0.45;
  material.opacity += Math.max(-step, Math.min(step, fadeTarget - material.opacity));
  fade.visible = material.opacity > 0.001;
  fade.position.copy(head);
  if (material.opacity === fadeTarget && fadeDone) {
    const done = fadeDone;
    fadeDone = null;
    done();
  }
}

// ---------------------------------------------------------------- Musik

// Ein Browser spielt erst nach einer Berührung Klang ab, darum entsteht das alles erst beim Eintritt
let music: Music | null = null;
let musicOn = params.get('music') !== '0';

function startMusic() {
  if (!musicOn) return;
  if (!music) {
    const audio = new AudioContext({ sampleRate: MUSIC_RATE, latencyHint: 'playback' });
    audio.addEventListener('statechange', () => trace(`Music: ${audio.state}, ${audio.sampleRate} Hz, buffer ${Math.round(audio.baseLatency * 1000)} ms`));
    music = new Music(audio);
    music.begin(seed, planet.id);
  }
  music.start();
}

function toggleMusic() {
  musicOn = !musicOn;
  if (musicOn) startMusic();
  else music?.stop();
}

// ---------------------------------------------------------------- Welt

const worker = new Worker(new URL('./worldWorker.ts', import.meta.url), { type: 'module' });
const caveWorker = new Worker(new URL('./caveWorker.ts', import.meta.url), { type: 'module' });
const uploads: RectMessage[] = [];
const caveUploads: CaveChunk[] = [];
const openMouths = new Map<string, CaveMouthState>();
let generation = 0;
let seed = Number(params.get('seed') ?? DEFAULT_SEED);
let planet: Planet = PLANETS.slate;
let keyAzimuth = -Math.PI / 2;
let keyElevation = 0.5585;
let generatedSky: GeneratedSky | MarsSky | null = null;
let looping = false;

/** Vor dem Start läuft noch keine Bildschleife. Danach backt sie den Himmel mit, auch im Headset, wo diese Seite keine Bilder mehr bekommt. */
function pumpSky() {
  if (looping || !generatedSky || generatedSky.step()) return;
  requestAnimationFrame(pumpSky);
}
let world = new World(seed);
let caves = new Caves(world);
let worldStart = { x: 0, z: 0 };
let worldReady: (() => void) | null = null;
let posted = { x: Infinity, z: Infinity };
let postedCave = { x: Infinity, y: 0, z: Infinity };
let onProgress: (fraction: number) => void = () => {};
let caveIdle: (() => void) | null = null;
let settledAck = 0;
let settledWaiting: { ack: number; done: () => void } | null = null;

function send(message: ToWorker) {
  worker.postMessage(message);
}

function sendCave(message: ToCaveWorker) {
  caveWorker.postMessage(message);
}

worker.onmessage = (event: MessageEvent<FromWorker>) => {
  const message = event.data;
  if (message.generation !== generation) return; // Noch unterwegs aus einer Welt, die es nicht mehr gibt
  if (message.type === 'rect') uploads.push(message);
  else if (message.type === 'start') {
    worldStart = { x: message.x, z: message.z };
    terrain.setHead(message.x, message.z);
    sendCave({ type: 'init', generation, seed, planet: planet.id });
    sendCave({ type: 'move', generation, x: message.x, y: world.height(message.x, message.z), z: message.z });
  } else if (message.type === 'progress') onProgress(message.fraction);
  else if (message.type === 'settled') {
    while (uploads.length) terrain.applyRect(renderer, uploads.shift()!);
    if (settledWaiting?.ack === message.ack) {
      settledWaiting.done();
      settledWaiting = null;
    }
  } else if (message.type === 'ready') {
    console.log(`World ${seed}: ${Math.round(message.ms)} ms in the worker`);
    while (uploads.length) terrain.applyRect(renderer, uploads.shift()!);
    worldReady?.();
    worldReady = null;
  }
};

caveWorker.onmessage = (event: MessageEvent<FromCaveWorker>) => {
  const message = event.data;
  if (message.generation !== generation) return;
  if (message.type === 'chunk') caveUploads.push(message);
  else if (message.type === 'mouth') {
    // Erst alle Würfel des Mundlochs hochladen, dann das Loch stanzen: Sonst schaute man kurz hindurch
    if (message.open) while (caveUploads.length) caveMeshes.apply(caveUploads.shift()!);
    if (message.open) openMouths.set(message.id, message);
    else openMouths.delete(message.id);
    terrain.setMouths([...openMouths.values()]);
  } else if (message.type === 'drop') {
    const queued = caveUploads.findIndex((c) => c.key === message.key);
    if (queued >= 0) caveUploads.splice(queued, 1);
    caveMeshes.apply(message);
  } else if (message.type === 'mouths') {
    caveLights.set(message.list);
    water.set(message.pools);
  } else {
    while (caveUploads.length) caveMeshes.apply(caveUploads.shift()!);
    caveIdle?.();
    caveIdle = null;
  }
};

/** Wartet, bis die Höhlen um den Kopf vernetzt sind, aber nicht ewig: Sie sind das Letzte, was einen Start aufhalten soll. */
function waitForCaves(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      caveIdle = null;
      resolve();
    }, ms);
    caveIdle = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

async function beginWorld(nextSeed: number, at: { x: number; z: number } | null): Promise<{ x: number; z: number }> {
  generation++;
  seed = nextSeed;
  world = new World(seed, planet.id);
  caves = new Caves(world);
  terrain.setWorld(world);
  rocks.setWorld(world, caves);
  caveMeshes.reset();
  caveLights.set(new Float32Array(0));
  water.set(new Float32Array(0));
  openMouths.clear();
  terrain.setMouths([]);
  uploads.length = 0;
  caveUploads.length = 0;
  posted = { x: Infinity, z: Infinity };
  postedCave = { x: Infinity, y: 0, z: Infinity };
  music?.begin(seed, planet.id);
  if (generatedSky) {
    // Die Galaxie ist das Hauptlicht. In jeder Welt steht sie woanders, nur Welt 1 bleibt die vertraute.
    // Die Sonne des Mars steht immer gleich, denn die Kacheln tragen ihre Schatten.
    if (planet.id === 'slate') keyAzimuth = seed !== DEFAULT_SEED ? mulberry(seed ^ 0x2f1e77)() * Math.PI * 2 : -Math.PI / 2;
    (shared.uKeyDir.value as THREE.Vector3).set(
      Math.cos(keyElevation) * Math.cos(keyAzimuth), Math.sin(keyElevation), Math.cos(keyElevation) * Math.sin(keyAzimuth),
    ).normalize();
    generatedSky.begin(seed, keyAzimuth, keyElevation);
    pumpSky();
  }
  const cavesDone = waitForCaves(9000);
  const start = await new Promise<{ x: number; z: number }>((resolve) => {
    worldReady = () => resolve(worldStart);
    send({ type: 'init', generation, seed, planet: planet.id, keyAzimuth, at });
  });
  await cavesDone;
  await generatedSky?.finished;
  return start;
}

/** Lädt, was zu einer Welt gehört: Kacheln, Licht, Himmel. Das Bild ist dabei schwarz, oder es läuft noch gar nichts. */
async function preparePlanet(next: Planet) {
  planet = next;
  for (const [id, button] of choiceButtons) button.setAttribute('aria-pressed', String(id === next.id));
  trace(`World: ${next.name}`);
  terrain.setPlanet(next);
  caveMeshes.setPlanet(next.id === 'mars');
  caveLights.setColor(next.plume);
  dust.setActive(next.id === 'mars');
  const meta = await terrain.load(next.surface, anisotropy, canMipHeights);
  await rocks.setPlanet(next);
  keyAzimuth = meta.key.azimuth;
  keyElevation = meta.key.elevation;
  (shared.uKeyDir.value as THREE.Vector3).set(
    Math.cos(keyElevation) * Math.cos(keyAzimuth), Math.sin(keyElevation), Math.cos(keyElevation) * Math.sin(keyAzimuth),
  ).normalize();
  (shared.uKeyColor.value as THREE.Color).setRGB(...next.key.color);
  (shared.uKeySpec.value as THREE.Vector2).set(...next.key.spec);
  (shared.uAmbientTop.value as THREE.Color).setRGB(...next.ambientTop);
  (shared.uAmbientLow.value as THREE.Color).setRGB(...next.ambientLow);
  (shared.uRockDark.value as THREE.Color).setRGB(...next.rockDark);
  (shared.uRockLight.value as THREE.Color).setRGB(...next.rockLight);

  let sky: Sky;
  if (next.id === 'mars') {
    marsSky ??= new MarsSky(renderer);
    generatedSky = marsSky;
    sky = marsSky;
  } else {
    slateSky ??= new GeneratedSky(renderer);
    generatedSky = slateSky;
    sky = slateSky;
  }
  if (skyNow && skyNow !== sky) {
    scene.remove(...skyNow.objects, ...skyNow.mirrored);
    if (skyNow === slateSky || skyNow === marsSky) (skyNow as GeneratedSky | MarsSky).sleep();
  }
  if (skyNow !== sky) scene.add(...sky.objects, ...sky.mirrored);
  shared.uSky.value = sky.texture;
  shared.uSkyLod.value = sky.skyLod;
  skyNow = sky;
}

/** Eine Karte im Auswahldialog wurde gewählt. Beim ersten Mal wartet der Start darauf, später wird die Welt einfach gewechselt. */
function onChoice(next: Planet) {
  if (firstChoice) {
    const done = firstChoice;
    firstChoice = null;
    overlay.classList.remove('choosing');
    done(next);
  } else void switchPlanet(next);
}

async function switchPlanet(next: Planet) {
  if (next === planet || worldBusy || changingWorld) return;
  worldBusy = true;
  enterButton.disabled = true;
  await fadeTo(1);
  changingWorld = true;
  statusLine.textContent = `Loading ${next.name} …`;
  await preparePlanet(next);
  const start = await beginWorld(seed, null);
  moveTo(start.x, start.z);
  faceKeyLight();
  smoothGround = null;
  hover.on = false;
  changingWorld = false;
  statusLine.textContent = readyStatus;
  await fadeTo(0);
  worldBusy = false;
  enterButton.disabled = false;
}

/** Bringt die Bodenfenster an einen neuen Ort und wartet, bis sie dort angekommen sind. */
function settleAt(x: number, z: number): Promise<void> {
  const ack = ++settledAck;
  return new Promise((resolve) => {
    settledWaiting = { ack, done: resolve };
    send({ type: 'move', generation, x, z, ack });
  });
}

let changingWorld = true;
let worldBusy = false;

async function newWorld() {
  if (worldBusy || changingWorld) return;
  worldBusy = true;
  await fadeTo(1);
  changingWorld = true;
  const start = await beginWorld(1 + Math.floor(Math.random() * 999999), null);
  moveTo(start.x, start.z);
  faceKeyLight();
  smoothGround = null;
  hover.on = false;
  changingWorld = false;
  await fadeTo(0);
  worldBusy = false;
}

/** Zum nächsten Mundloch: In der Dunkelheit hin, davor stehen, Blick hinein. Die allernächste Höhle zählt nicht, da steht man ja schon. */
async function jumpToCave(fadeFirst = true) {
  if (worldBusy || (changingWorld && fadeFirst)) return;
  const near = caves.nearestMouth(head.x, head.z, 45);
  if (!near) return;
  worldBusy = true;
  if (fadeFirst) await fadeTo(1);
  changingWorld = true;
  const m = near.mouth;
  const x = m.ax - m.inX * 10, z = m.az - m.inZ * 10;
  await settleAt(x, z);
  moveTo(x, z);
  if (renderer.xr.isPresenting) {
    syncXrHead();
    turnAroundHead(Math.atan2(m.inX, m.inZ) - Math.atan2(forward.x, forward.z));
  } else {
    pose.yaw = Math.atan2(-m.inX, -m.inZ);
    pose.pitch = 0;
  }
  smoothGround = null;
  hover.on = false;
  const done = waitForCaves(5000);
  sendCave({ type: 'move', generation, x, y: world.height(x, z), z });
  await done;
  changingWorld = false;
  if (fadeFirst) await fadeTo(0);
  worldBusy = false;
}

// ---------------------------------------------------------------- Steuerung

const pose = {
  x: 0,
  z: 0,
  yaw: Number(params.get('yaw') ?? 0),
  pitch: Number(params.get('pitch') ?? 0),
  // Nur zum Prüfen von oben, ?lift=80 hebt den Blick über den Boden
  lift: Number(params.get('lift') ?? 0),
};
const keys = new Set<string>();
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyO') toggleLamp();
  if (e.code === 'KeyH') hud.toggle();
  if (e.code === 'KeyN') void newWorld();
  if (e.code === 'KeyF') setHover(!hover.on);
  if (e.code === 'KeyG') void jumpToCave();
  if (e.code === 'KeyM') toggleMusic();
});
addEventListener('keyup', (e) => keys.delete(e.code));

let dragging = false;
renderer.domElement.addEventListener('pointerdown', (e) => {
  dragging = true;
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointerup', () => { dragging = false; });
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  pose.yaw -= e.movementX * 0.0035;
  pose.pitch = THREE.MathUtils.clamp(pose.pitch - e.movementY * 0.0035, -1.5, 1.5);
});

addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const head = new THREE.Vector3();
const forward = new THREE.Vector3();
const lookDirection = new THREE.Vector3(0, 0, -1);
const hoverTarget = new THREE.Vector3();
const velocity = new THREE.Vector2();
const pushed = { x: 0, z: 0 };
const slopeHere = { x: 0, z: 0 };
const slopeThere = { x: 0, z: 0 };
const heldButtons = new Map<string, boolean>();
let smoothGround: number | null = null;
let turnRate = 0;

// Schweben: Die Füße haben eine eigene Höhe und folgen nicht mehr dem Boden
const hover = { on: false, feet: 0, lift: 0, risePending: 0, velocity: new THREE.Vector3() };

function setHover(on: boolean) {
  if (on === hover.on || changingWorld) return;
  hover.on = on;
  if (on) {
    hover.feet = smoothGround ?? 0;
    hover.risePending = 2.2;
    hover.velocity.set(velocity.x, 0, velocity.y);
  } else {
    // Die Landung übernimmt der Gehen-Zweig: Er zieht die Füße mit begrenzter Geschwindigkeit zum Boden
    smoothGround = hover.feet;
    velocity.set(hover.velocity.x, hover.velocity.z);
  }
  // Im Headset gibt es sonst keine Rückmeldung, dass der Knopf gewirkt hat
  for (const src of renderer.xr.getSession()?.inputSources ?? []) {
    if (src.handedness === 'left') (src.gamepad as unknown as { hapticActuators?: { pulse(v: number, ms: number): void }[] })?.hapticActuators?.[0]?.pulse(0.4, 60);
  }
}

function pressedOnce(id: string, pressed: boolean) {
  const was = heldButtons.get(id) ?? false;
  heldButtons.set(id, pressed);
  return pressed && !was;
}

function readXrInput(dt: number) {
  const session = renderer.xr.getSession();
  let moveX = 0, moveZ = 0, turn = 0;
  hover.lift = 0;
  if (!session) return { moveX, moveZ };
  for (const src of session.inputSources) {
    const pad = src.gamepad;
    if (!pad) continue;
    const ax = pad.axes[2] ?? 0, ay = pad.axes[3] ?? 0;
    if (src.handedness === 'left') {
      moveX = Math.abs(ax) > 0.12 ? ax : 0;
      moveZ = Math.abs(ay) > 0.12 ? ay : 0;
      if (pressedOnce('x', pad.buttons[4]?.pressed ?? false)) void newWorld();
      if (pressedOnce('y', pad.buttons[5]?.pressed ?? false)) setHover(!hover.on);
      if (pressedOnce('grip', pad.buttons[1]?.pressed ?? false)) void jumpToCave();
    } else if (src.handedness === 'right') {
      // Stufenlos, weil der Nutzer es so wollte. Stufen sind die übliche Vorsicht gegen Übelkeit, falls sie doch wieder gefragt sind.
      const side = Math.max(Math.abs(ax) - TURN_DEADZONE, 0) / (1 - TURN_DEADZONE);
      turn = -Math.sign(ax) * side * side * TURN_SPEED;
      if (pressedOnce('a', pad.buttons[4]?.pressed ?? false)) toggleLamp();
      if (pressedOnce('b', pad.buttons[5]?.pressed ?? false)) hud.toggle();
      if (pressedOnce('rightGrip', pad.buttons[1]?.pressed ?? false)) toggleMusic();
      // Beim Schweben steuert derselbe Stick die Höhe, sonst die Helligkeit. Wer ihn zum Drehen seitlich hält, soll dabei nicht versehentlich steigen oder abdunkeln.
      const justTurning = Math.abs(ax) > Math.abs(ay) * 1.5;
      if (hover.on) hover.lift = Math.abs(ay) > 0.2 && !justTurning ? -ay : 0;
      else if (Math.abs(ay) > 0.5 && !justTurning) {
        const e = shared.uExposure;
        e.value = THREE.MathUtils.clamp((e.value as number) * (1 - ay * dt * 0.6), 0.3, 5);
      }
    }
  }
  // Ein kurzer An- und Auslauf, damit der Blick nicht ruckt. Fehlt der Controller plötzlich, läuft die Drehung so auch sanft aus.
  turnRate += (turn - turnRate) * Math.min(1, dt * 12);
  if (Math.abs(turnRate) > 0.002) turnAroundHead(turnRate * dt);
  return { moveX, moveZ };
}

let enteredAt = 0;

/** Das Headset ist zu, egal wodurch: Die Seite übernimmt an derselben Stelle, und ein neuer Eintritt macht dort weiter. */
function onXrEnded() {
  pose.x = head.x;
  pose.z = head.z;
  pose.yaw = Math.atan2(-forward.x, -forward.z);
  pose.pitch = 0;
  overlay.classList.remove('hidden');
  music?.stop();
  // Wer lange unterwegs war, ist wohl selbst gegangen. Nach einem frühen Ende soll die Seite aber ohne PC verraten, was geschah.
  traceLine.textContent = performance.now() - enteredAt < EARLY_END_MS ? traceTail(6) : '';
}

// Die XR-Kamera direkt aus ihrer Weltmatrix lesen: getWorldPosition() rechnet die Matrix neu ohne das Rig
// und würde den Kopf zurück in den Raumursprung setzen.
function syncXrHead() {
  rig.updateMatrixWorld(true);
  renderer.xr.updateCamera(camera);
  const m = renderer.xr.getCamera().matrixWorld;
  head.setFromMatrixPosition(m);
  forward.setFromMatrixColumn(m, 2).negate();
}

function turnAroundHead(angle: number) {
  syncXrHead();
  rig.position.sub(head).applyAxisAngle(THREE.Object3D.DEFAULT_UP, angle).add(head);
  rig.rotation.y += angle;
}

function moveTo(x: number, z: number) {
  if (renderer.xr.isPresenting) {
    syncXrHead();
    rig.position.x += x - head.x;
    rig.position.z += z - head.z;
  } else {
    pose.x = x;
    pose.z = z;
  }
  head.x = x;
  head.z = z;
  terrain.setHead(x, z);
}

/** Blick zur Galaxie: Die Startplätze sind so gesucht, dass sie dort am Ende der Schlucht über dem Horizont steht. */
function faceKeyLight() {
  const kx = Math.cos(keyAzimuth), kz = Math.sin(keyAzimuth);
  if (renderer.xr.isPresenting) {
    syncXrHead();
    turnAroundHead(Math.atan2(kx, kz) - Math.atan2(forward.x, forward.z));
  } else {
    pose.yaw = Math.atan2(-kx, -kz);
    pose.pitch = 0;
  }
}

// Was die Füße gerade tragen könnte: der Boden oben oder die Sohle eines Gangs. Es gilt, was näher an ihnen liegt.
const groundOut = { y: 0, cave: false, terrain: 0 };

function groundUnder(x: number, z: number, feet: number) {
  const t = terrain.ground(x, z);
  const f = caves.floorAt(x, z);
  groundOut.terrain = t;
  groundOut.cave = !Number.isNaN(f) && (Number.isNaN(t) || Math.abs(f - feet) < Math.abs(t - feet));
  groundOut.y = groundOut.cave ? f : t;
}

/** Im Gang ist, wer eine Sohle unter sich und ein gutes Stück Fels über sich hat. */
function isUnderground(feet: number) {
  return groundOut.cave && groundOut.terrain - feet > 2.5;
}

function bodyFits(x: number, z: number, feet: number) {
  return caves.air(x, feet + 1, z) > 0.35 && caves.air(x, feet + 1.75, z) > 0.25;
}

/** Ein Schritt im Gang: Die Wände begrenzen, und an ihnen gleitet man entlang. */
function stepInCave(x: number, z: number, dx: number, dz: number, feet: number, out: { x: number; z: number }) {
  out.x = x + dx;
  out.z = z + dz;
  if (bodyFits(out.x, out.z, feet)) return;
  const e = 0.4, y = feet + 1;
  let gx = caves.air(x + e, y, z) - caves.air(x - e, y, z), gz = caves.air(x, y, z + e) - caves.air(x, y, z - e);
  const g = Math.hypot(gx, gz) || 1;
  gx /= g;
  gz /= g;
  const along = dx * gx + dz * gz;
  out.x = x + dx - Math.min(along, 0) * gx;
  out.z = z + dz - Math.min(along, 0) * gz;
  if (bodyFits(out.x, out.z, feet)) return;
  out.x = x;
  out.z = z;
}

/** Ein Schritt mit Felsen und Wänden: An einer Wand gleitet man entlang, statt hängenzubleiben. */
function stepFrom(x: number, z: number, dx: number, dz: number, out: { x: number; z: number }) {
  const feet = smoothGround ?? 0;
  groundUnder(x, z, feet);
  if (isUnderground(feet)) {
    stepInCave(x, z, dx, dz, feet, out);
    return;
  }
  rocks.pushOut(x + dx, z + dz, out);
  // Auf dem Weg ins Mundloch zählt die Sohle des Gangs, nicht die Steigung der Wand darüber
  const floor = caves.floorAt(out.x, out.z);
  if (!Number.isNaN(floor) && Math.abs(floor - feet) < 1.2 && bodyFits(out.x, out.z, floor)) return;
  terrain.slope(out.x, out.z, slopeThere);
  const there = Math.hypot(slopeThere.x, slopeThere.z);
  if (there <= WALK_LIMIT) return;

  // Wer schon im Steilen steht, etwa nach einem echten Schritt im Raum, darf jedenfalls wieder hinaus
  terrain.slope(x, z, slopeHere);
  if (Math.hypot(slopeHere.x, slopeHere.z) > WALK_LIMIT && (there < Math.hypot(slopeHere.x, slopeHere.z) || terrain.macroAt(out.x, out.z) < terrain.macroAt(x, z))) return;

  const ux = slopeThere.x / there, uz = slopeThere.z / there;
  const along = dx * ux + dz * uz;
  rocks.pushOut(x + dx - along * ux, z + dz - along * uz, out);
  terrain.slope(out.x, out.z, slopeThere);
  if (Math.hypot(slopeThere.x, slopeThere.z) <= WALK_LIMIT) return;
  out.x = x;
  out.z = z;
}

/**
 * Ein Bild lang schweben: Man fliegt dorthin, wohin man schaut, und höher oben schneller. Der Boden hält die Füße auf Abstand.
 * An einer Wand geht es von selbst aufwärts, mit begrenzter Geschwindigkeit, statt durch den Fels hindurch.
 */
function stepHover(dt: number, moveX: number, moveZ: number, fast: boolean, out: { x: number; z: number }) {
  const x = head.x, z = head.z;
  const here = terrain.surface(x, z);
  const altitude = Math.max(0, hover.feet - here);
  const speed = THREE.MathUtils.clamp(3 + 0.05 * altitude, 3, 15) * (fast ? 4 : 1);

  const flat = Math.hypot(lookDirection.x, lookDirection.z) || 1;
  const rx = -lookDirection.z / flat, rz = lookDirection.x / flat;
  hoverTarget.set(
    (-lookDirection.x * moveZ + rx * moveX) * speed,
    -lookDirection.y * moveZ * speed + hover.lift * HOVER_CLIMB_SPEED,
    (-lookDirection.z * moveZ + rz * moveX) * speed,
  );
  hover.velocity.lerp(hoverTarget, Math.min(1, dt * 3));

  let nx = x + hover.velocity.x * dt, nz = z + hover.velocity.z * dt;
  let feet = hover.feet + hover.velocity.y * dt;
  if (hover.risePending > 0) {
    const rise = Math.min(hover.risePending, 1.6 * dt);
    feet += rise;
    hover.risePending -= rise;
  }

  // Im Gang oder auf dem Flug hinein: Hier begrenzen Sohle und Decke, nicht der Boden oben
  groundUnder(x, z, hover.feet);
  const inside = isUnderground(hover.feet);
  const tubeAhead = caves.air(nx, feet + 1, nz) > 0.35;
  if (inside || tubeAhead) {
    if (inside && !bodyFits(nx, nz, feet)) {
      nx = x;
      nz = z;
      feet = hover.feet;
      hover.velocity.multiplyScalar(0.5);
    }
    const floor = caves.floorAt(nx, nz);
    if (!Number.isNaN(floor)) feet = Math.max(feet, floor + 0.3);
    if (caves.air(nx, feet + 1.85, nz) < 0.2) feet = Math.min(feet, hover.feet);
    hover.feet = feet;
    out.x = nx;
    out.z = nz;
    return;
  }

  // Etwas vorausschauen: So steigt man rechtzeitig und klebt nicht mit der Nase an der Wand
  const moving = Math.hypot(hover.velocity.x, hover.velocity.z) || 1;
  let floor = terrain.surface(nx + (hover.velocity.x / moving) * 2.5, nz + (hover.velocity.z / moving) * 2.5);
  if (Number.isNaN(floor)) floor = here;
  const need = Math.max(floor, here) + HOVER_CLEARANCE - feet;
  if (need > 0) {
    const step = HOVER_MAX_RISE * dt;
    feet += Math.min(need, step);
    // Zu steil, um noch im Vorbeiflug hinaufzukommen: stehen bleiben und erst steigen
    if (need > step * 4) {
      nx = x;
      nz = z;
      hover.velocity.x *= 0.5;
      hover.velocity.z *= 0.5;
      floor = here;
    }
  }
  if (feet > floor + HOVER_MAX_ALTITUDE) feet = Math.min(feet, Math.max(hover.feet, floor + HOVER_MAX_ALTITUDE));
  hover.feet = feet;
  rocks.pushOut(nx, nz, out, feet);
}

function update(dt: number, time: number) {
  const presenting = renderer.xr.isPresenting;
  let moveX = 0, moveZ = 0;

  if (presenting) {
    ({ moveX, moveZ } = readXrInput(dt));
    syncXrHead();
    lookDirection.copy(forward);
  } else {
    if (keys.has('KeyW') || keys.has('ArrowUp')) moveZ -= 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) moveZ += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) moveX -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) moveX += 1;
    hover.lift = (keys.has('Space') || keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') || keys.has('KeyC') ? 1 : 0);
    camera.rotation.set(pose.pitch, pose.yaw, 0, 'YXZ');
    forward.set(-Math.sin(pose.yaw), 0, -Math.cos(pose.yaw));
    lookDirection.set(-Math.sin(pose.yaw) * Math.cos(pose.pitch), Math.sin(pose.pitch), -Math.cos(pose.yaw) * Math.cos(pose.pitch));
  }

  if (changingWorld) {
    // Während die neue Welt entsteht, steht man still im Dunkeln. Nur der Kopf dreht sich weiter.
    velocity.set(0, 0);
    if (!presenting) {
      rig.position.set(pose.x, smoothGround ?? 0, pose.z);
      camera.position.set(0, 0, 0);
      camera.updateMatrixWorld(true);
    }
    return;
  }

  // Weiches Anlaufen und Abbremsen statt Ruck
  const yawLen = Math.hypot(forward.x, forward.z) || 1;
  const fx = forward.x / yawLen, fz = forward.z / yawLen;
  const speed = (keys.has('ShiftLeft') ? 5 : 1) * WALK_SPEED;
  const tx = (-fx * moveZ - fz * moveX) * speed;
  const tz = (-fz * moveZ + fx * moveX) * speed;
  velocity.x += (tx - velocity.x) * Math.min(1, dt * 7);
  velocity.y += (tz - velocity.y) * Math.min(1, dt * 7);

  if (!presenting) head.set(pose.x, 0, pose.z);
  caves.setFocus(head.x, head.z);
  if (hover.on) stepHover(dt, moveX, moveZ, keys.has('ShiftLeft'), pushed);
  else stepFrom(head.x, head.z, velocity.x * dt, velocity.y * dt, pushed);
  if (presenting) {
    rig.position.x += pushed.x - head.x;
    rig.position.z += pushed.z - head.z;
  } else {
    pose.x = pushed.x;
    pose.z = pushed.z;
  }
  head.x = pushed.x;
  head.z = pushed.z;

  if (Math.hypot(head.x - posted.x, head.z - posted.z) > 1) {
    posted = { x: head.x, z: head.z };
    send({ type: 'move', generation, x: head.x, z: head.z });
  }

  // Außerhalb der fertigen Fenster gibt es noch keine Höhe. Das passiert nur bei einem Sprung, dann bleibt die alte.
  caves.setFocus(head.x, head.z);
  groundUnder(head.x, head.z, hover.on ? hover.feet : smoothGround ?? Infinity);
  const g = groundOut.y;
  if (hover.on) smoothGround = hover.feet;
  else if (!Number.isNaN(g)) {
    if (smoothGround === null) smoothGround = g;
    else {
      // Beim Landen darf es schneller gehen als beim Gehen, aber nie wie ein Sturz
      const fall = Math.max(3, Math.min(20, 0.6 * Math.abs(g - smoothGround))) * dt;
      smoothGround += THREE.MathUtils.clamp((g - smoothGround) * Math.min(1, dt * 5), -fall, fall);
    }
  }
  smoothGround ??= 0;

  if (presenting) {
    // Lokaler Boden: Die reale Augenhöhe liefert das Headset
    rig.position.y = smoothGround;
    syncXrHead();
  } else {
    head.y = smoothGround + EYE_HEIGHT + pose.lift;
    rig.position.set(head.x, head.y, head.z);
    rig.rotation.y = 0;
    camera.position.set(0, 0, 0);
    camera.updateMatrixWorld(true);
  }

  const feetNow = smoothGround;
  const underground = isUnderground(feetNow);

  if (underground && !lamp.on && !lamp.refused) {
    lamp.on = true;
    lamp.byCave = true;
  } else if (!underground && !Number.isNaN(g)) {
    if (lamp.byCave) lamp.on = false;
    lamp.byCave = false;
    lamp.refused = false;
  }
  lamp.glow += ((underground ? LAMP_CAVE_GLOW : 1) - lamp.glow) * Math.min(1, dt * 1.2);
  lamp.level += ((lamp.on ? 1 : 0) - lamp.level) * Math.min(1, dt * 3);

  const pixelAngle = presenting ? XR_PIXEL_ANGLE : (2 * Math.tan((camera.fov * Math.PI) / 360)) / renderer.domElement.height;
  caveLights.update(time, pixelAngle);
  (shared.uLampPos.value as THREE.Vector3).copy(lampAt.set(head.x + fx * 1.2, head.y + 0.25, head.z + fz * 1.2));
  (shared.uLampColor.value as THREE.Color).copy(LAMP_LIGHT).multiplyScalar(lamp.glow * lamp.level);
  // Mit der Helligkeit wächst die Reichweite: Sonst blieben die Wände einer Halle im Dunkeln
  shared.uLampFalloff.value = THREE.MathUtils.mapLinear(lamp.glow, 1, LAMP_CAVE_GLOW, 0.6, 0.14);

  // Ist das Mundloch außer Sicht, sieht man vom Rest der Welt nichts mehr. Das spart ihn ganz. Gefragt wird nur ab und zu.
  sightCheck -= dt;
  if (sightCheck <= 0) {
    sightCheck = 0.25;
    deepInCave = underground && caves.pathAt(head.x, head.y, head.z) > 12 && !caves.seesMouth(head.x, head.y, head.z);
    // Mitten auf einem See zeichnet das Headset am meisten. Im Verlauf soll stehen, ob ein Einbruch der Bildrate damit zusammenfällt.
    const onWater = water.nearestLevel(head.x, head.z, 0) !== null;
    if (onWater !== wasOnWater) trace(onWater ? 'On the water' : 'Off the water');
    wasOnWater = onWater;
  } else if (!underground) deepInCave = false;
  const deep = deepInCave;
  music?.setMuffle(deep ? 1 : underground ? 0.5 : 0);
  terrain.mesh.visible = !deep;
  caveLights.mesh.visible = !deep;
  skyNow?.setVisible(!deep);
  const waterShown = !deep && water.active && stencilWorks;
  water.setVisible(waterShown);
  skyNow?.setMirrorVisible(waterShown);

  if (Math.hypot(head.x - postedCave.x, head.y - postedCave.y, head.z - postedCave.z) > 3) {
    postedCave = { x: head.x, y: head.y, z: head.z };
    sendCave({ type: 'move', generation, x: head.x, y: head.y, z: head.z });
  }

  const cam = presenting ? renderer.xr.getCamera() : camera;
  terrain.update(head, cam);
  rocks.update(head, deep);
  caveMeshes.update(head);
}

// ---------------------------------------------------------------- Start

const anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 4);
const canMipHeights = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
let skyNow: Sky | null = null;
let slateSky: GeneratedSky | null = null;
let marsSky: MarsSky | null = null;
let readyStatus = '';
let firstChoice: ((next: Planet) => void) | null = null;
const choiceButtons = new Map<PlanetId, HTMLButtonElement>();

function buildChoices() {
  for (const p of PLANET_LIST) {
    const button = document.createElement('button');
    button.className = 'planet';
    button.setAttribute('aria-pressed', 'false');
    const picture = document.createElement('img');
    picture.src = p.picture;
    picture.alt = '';
    const name = document.createElement('b');
    name.textContent = p.name;
    const line = document.createElement('span');
    line.textContent = p.line;
    button.append(picture, name, line);
    button.addEventListener('click', () => onChoice(p));
    planetChoices.append(button);
    choiceButtons.set(p.id, button);
  }
}

/** Die untere Zeile der Anzeige. Sie kostet ein paar Abfragen, deshalb nur, solange die Anzeige auch zu sehen ist. */
function statusNote(): string {
  if (!hud.panel.visible) return '';
  const near = caves.nearestMouth(head.x, head.z);
  const cave = near ? `Cave ${Math.round(near.distance)} m` : 'no cave nearby';
  return hover.on ? `Hovering, ${Math.round(hover.feet - terrain.macroAt(head.x, head.z))} m  ·  ${cave}` : cave;
}

async function start() {
  // Nur zum Testen ohne Headset: emuliert eine Quest 3 im Browser
  if (import.meta.env.DEV && params.has('emulate')) {
    const { XRDevice, metaQuest3 } = await import('iwer');
    const device = new XRDevice(metaQuest3);
    device.installRuntime({ forceInstall: true });
    device.stereoEnabled = true;
    device.position.set(0, 1.65, 0);
    (window as unknown as Record<string, unknown>).__xr = device;
  }
  buildChoices();
  // Wer eine Adresse mit Welt oder Seed aufruft, weiß schon, wohin er will. Das nutzen auch die Prüfwerkzeuge.
  const wanted = params.get('world') as PlanetId | null;
  const direct = wanted && PLANETS[wanted] ? PLANETS[wanted] : params.has('seed') || params.has('cave') ? PLANETS.slate : null;
  const chosen = direct ?? await new Promise<Planet>((resolve) => {
    overlay.classList.add('choosing');
    firstChoice = resolve;
  });
  trackProgress((f) => { statusLine.textContent = `Loading ${chosen.name} … ${Math.round(f * 100)} %`; });
  await preparePlanet(chosen);

  onProgress = (f) => { statusLine.textContent = f < 1 ? `Generating world ${seed} … ${Math.round(f * 100)} %` : 'Meshing nearby caves …'; };
  const at = params.has('x') && params.has('z') ? { x: Number(params.get('x')), z: Number(params.get('z')) } : null;
  statusLine.textContent = `Generating world ${seed} …`;
  const first = await beginWorld(seed, at);
  moveTo(first.x, first.z);
  if (!params.has('yaw')) faceKeyLight();
  changingWorld = false;
  // Nur zum Prüfen: gleich vor der nächsten Höhle anfangen
  if (params.has('cave')) await jumpToCave(false);

  let last = performance.now();
  const t0 = last;
  looping = true;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    traceFrame(renderer);
    // Ohne Stencil-Puffer läge der gespiegelte Himmel über dem ganzen Bild. Das Headset könnte ihn verweigern, also einmal nachsehen.
    // Hier ist sein Zeichenziel schon gebunden, und es wurde noch nichts anderes angefasst.
    if (renderer.xr.isPresenting && !stencilChecked) {
      stencilChecked = true;
      const gl = renderer.getContext();
      const bits = gl.getParameter(gl.STENCIL_BITS) as number;
      stencilWorks = bits > 0;
      trace(`Headset stencil buffer: ${bits} bits`);
    }
    generatedSky?.step();
    hud.update(now - last, terrain.patches, shared.uExposure.value as number, seed, statusNote());
    last = now;
    const time = (now - t0) / 1000;
    for (let i = 0; i < UPLOADS_PER_FRAME && uploads.length; i++) terrain.applyRect(renderer, uploads.shift()!);
    for (let i = 0; i < CAVE_UPLOADS_PER_FRAME && caveUploads.length; i++) caveMeshes.apply(caveUploads.shift()!);
    update(dt, time);
    updateFade(dt);
    music?.update(forward.x, forward.z);
    // Die Punktgröße der Sterne soll zur Auflösung passen, nicht zu einer festen Pixelzahl
    const size = renderer.xr.isPresenting ? 1800 : renderer.domElement.height;
    skyNow?.update(time, Math.max(size / 1200, 0.8));
    dust.update(time, Math.max(size / 1200, 0.8), head, world, deepInCave);
    renderer.render(scene, camera);
  });

  const xrOk = navigator.xr ? await navigator.xr.isSessionSupported('immersive-vr') : false;
  if (xrOk) {
    readyStatus = 'Left stick: walk. X: new world. Y: hover. Left grip: next cave. Right stick: turn and brightness, height while hovering. A: lamp. B: frame rate. Right grip: music on or off. Meta button: leave VR.';
    statusLine.textContent = readyStatus;
    enterButton.disabled = false;
    enterButton.addEventListener('click', async () => {
      trace('Entering VR');
      enteredAt = performance.now();
      traceLine.textContent = '';
      startMusic();
      const session = await navigator.xr!.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
      await renderer.xr.setSession(session);
      // Beim ersten Bild im Headset an der Startposition stehen und in dieselbe Richtung schauen: Die Quest beginnt irgendwo im Raum
      rig.position.set(pose.x, 0, pose.z);
      rig.rotation.y = pose.yaw;
      const hz = Number(params.get('hz'));
      if (hz && session.updateTargetFrameRate) await session.updateTargetFrameRate(hz);
      overlay.classList.add('hidden');
      traceSession(session);
      session.addEventListener('end', onXrEnded);
      // Die Home-Taste meldet der Browser der Seite nicht, nur ihre Wirkung: Das Systemmenü legt sich vor die Szene.
      // Jedes andere Systemfenster, das lange offen bleibt, beendet VR darum genauso.
      let visibleSince = session.visibilityState === 'visible' ? performance.now() : Infinity;
      let leaving = 0;
      session.addEventListener('end', () => clearTimeout(leaving));
      session.addEventListener('visibilitychange', () => {
        if (session.visibilityState === 'visible') {
          clearTimeout(leaving);
          visibleSince = performance.now();
          return;
        }
        // Es zählt nur der Moment, in dem die Szene verdeckt wird: Ein Systemmenü geht danach oft noch von "visible-blurred" zu "hidden" über
        if (performance.now() - visibleSince > HOME_SETTLED_MS) {
          leaving = window.setTimeout(() => {
            trace('System menu stays open: leaving VR');
            void session.end();
          }, HOME_HOLD_MS);
        }
        visibleSince = Infinity;
      });
    });
  } else {
    readyStatus = 'Preview: drag to look, WASD to walk, F: hover (Space and Q: height), G: next cave, N: new world, O: lamp, H: frame rate, M: music on or off.';
    statusLine.textContent = readyStatus;
    enterButton.style.display = 'none';
    // Am PC beginnt die Musik mit der ersten Berührung der Seite und schweigt, solange sie verdeckt ist: Ohne Bildschleife ginge ihr sonst nach dem geplanten Stück der Stoff aus
    addEventListener('pointerdown', startMusic, { once: true });
    addEventListener('keydown', startMusic, { once: true });
    document.addEventListener('visibilitychange', () => {
      if (!music || !musicOn) return;
      if (document.hidden) music.stop();
      else music.start();
    });
  }
}

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__viewer = {
    pose, lamp, shared, terrain, rocks, renderer, camera, hud, newWorld, moveTo, hover, setHover, jumpToCave, caveMeshes,
    get sky() { return skyNow; },
    water,
    dust,
    switchPlanet,
    PLANETS,
    get planet() { return planet; },
    get music() { return music; },
    settleFeet() { smoothGround = null; },
    /** Baut die Bodenfenster an einem Ort ganz neu auf, wie beim Start. Nach einem Sprung ohne das wäre das Licht ihrer alten Teile nicht ganz dasselbe wie das der neuen. */
    async arriveAt(x: number, z: number) {
      changingWorld = true;
      await beginWorld(seed, { x, z });
      moveTo(x, z);
      smoothGround = null;
      hover.on = false;
      changingWorld = false;
    },
    get caves() { return caves; },
    get world() { return world; },
    get seed() { return seed; },
  };
}

start().catch((err) => {
  statusLine.textContent = `Failed to load: ${err.message}`;
  console.error(err);
});
