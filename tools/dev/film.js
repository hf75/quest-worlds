// Nimmt einen Film auf: Bild für Bild aus dem Emulator im Split-Screen, die Kamera auf festen Wegen.
// Server siehe vite.film.config.ts. Seite: /?seed=1&music=0&emulate=1, dort "Enter VR" drücken, dann in der Konsole:
//   const film = await import('/tools/dev/film.js'); film.setup(); await film.look({ x, z, above, yaw, pitch }); film.record();
import * as THREE from 'three';

const FPS = 60;
const QUALITY = 0.96;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
let v;

const PI = Math.PI;
/** Die Szenen, Welt 1 auf beiden Planeten. Jede ist eine Dauer und ein paar Stützpunkte: Ort, Höhe über dem Boden oder absolut, Blick. */
export const SHOTS = [
  { name: 'aufblick', planet: 'slate', seconds: 9, keys: [{ x: -832, z: 434, above: 1.7, yaw: 0.02, pitch: 0.62 }, { x: -832, z: 428, above: 1.7, yaw: 0.0, pitch: 0.42 }, { x: -832, z: 420, above: 1.7, yaw: -0.02, pitch: 0.05 }] },
  { name: 'tiefflug', planet: 'slate', seconds: 7, keys: [{ x: -764, z: 350, above: 15, yaw: 0.05, pitch: 0.03 }, { x: -760, z: 270, above: 12, yaw: 0.02, pitch: 0.0 }, { x: -752, z: 190, above: 10, yaw: -0.05, pitch: -0.03 }] },
  { name: 'nebel', planet: 'slate', seconds: 6.5, keys: [{ x: -926, z: 190, above: 16, yaw: PI + 0.04, pitch: 0.22 }, { x: -916, z: 250, above: 20, yaw: PI - 0.03, pitch: 0.15 }] },
  { name: 'spiegel', planet: 'slate', seconds: 9.5, keys: [{ x: -571, z: -46, y: 65.8, yaw: 0.02, pitch: 0.46 }, { x: -571, z: -62, y: 65.8, yaw: 0, pitch: 0.14 }, { x: -571, z: -78, y: 65.8, yaw: -0.01, pitch: -0.26 }, { x: -571, z: -92, y: 65.8, yaw: -0.02, pitch: -0.56 }] },
  { name: 'sonne', planet: 'mars', seconds: 8.5, keys: [{ x: 478, z: 121, above: 1.7, yaw: 0.04, pitch: 0.05 }, { x: 478, z: 110, above: 1.7, yaw: 0.01, pitch: 0.06 }, { x: 478, z: 99, above: 1.7, yaw: -0.02, pitch: 0.05 }] },
  { name: 'duenen', planet: 'mars', seconds: 6.5, devils: [{ x: 700, z: 400, windX: 2, windZ: 2 }], keys: [{ x: 880, z: 1046, above: 4.5, yaw: 0.03, pitch: -0.09 }, { x: 888, z: 985, above: 6.5, yaw: -0.03, pitch: -0.05 }] },
  { name: 'flug', planet: 'mars', seconds: 7, devils: [{ x: 760, z: -520, windX: -3, windZ: 3 }], keys: [{ x: 566, z: 190, above: 26, yaw: 0.2, pitch: -0.03 }, { x: 545, z: 100, above: 24, yaw: 0.14, pitch: -0.02 }, { x: 520, z: 10, above: 22, yaw: 0.04, pitch: 0.0 }] },
  { name: 'wand', planet: 'mars', seconds: 6, keys: [{ x: 440, z: 242, above: 1.7, yaw: 0.06, pitch: 0.08 }, { x: 446, z: 237, above: 1.7, yaw: 0.14, pitch: 0.2 }, { x: 452, z: 232, above: 1.7, yaw: 0.22, pitch: 0.34 }] },
  { name: 'nacht', planet: 'mars', seconds: 7.4, keys: [{ x: 484, z: 116, above: 1.7, yaw: -2.25, pitch: 0.12 }, { x: 484, z: 114, above: 1.7, yaw: -2.05, pitch: 0.3 }, { x: 484, z: 112, above: 1.7, yaw: -1.85, pitch: 0.5 }] },
];

export function setup() {
  v = window.__viewer;
  // Die Kamera folgt ihrem Weg, sie weicht keinem Stein aus
  v.rocks.pushOut = (x, z, out) => { out.x = x; out.z = z; };
  // Die Staubteufel kommen nur, wo eine Szene sie will
  v.dust.nextDevil = Infinity;
  return v;
}

function ground(x, z) {
  // Weich gemittelt: Sonst führe die Kamera jede Bodenwelle nach
  const w = v.world;
  let sum = 0;
  for (const [dx, dz] of [[0, 0], [7, 0], [-7, 0], [0, 7], [0, -7]]) sum += w.height(x + dx, z + dz, undefined, 8);
  return sum / 5;
}

const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const quaternion = new THREE.Quaternion();

/** Stellt Kopf und Füße ein. Die Höhe wirkt über die Schwebefunktion, die hält auch den Abstand zum Boden. */
function place({ x, z, above, y, yaw, pitch, roll = 0 }) {
  const rig = v.camera.parent;
  rig.rotation.y = 0;
  if (!v.hover.on) v.setHover(true);
  v.hover.risePending = 0;
  v.hover.velocity.set(0, 0, 0);
  const xr = window.__xr;
  const eye = y ?? ground(x, z) + Math.max(above, 1.7);
  // Die Schwebefunktion lässt 0,6 m unter den Füßen: Wer tiefer schauen will, senkt den Kopf
  v.hover.feet = eye - 1.05;
  v.moveTo(x, z);
  xr.position.set(0, 1.05, 0);
  euler.set(pitch, yaw, roll);
  quaternion.setFromEuler(euler);
  xr.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
}

/** Geht an einen Ort und wartet, bis dort alles berechnet ist. Für die Suche nach Einstellungen und vor jeder Aufnahme. */
export async function look(pose, settle = 1800) {
  window.__clock.auto = true;
  place(pose);
  await wait(300);
  place(pose);
  await wait(settle);
  place(pose);
  // Im Spiel führt jeder Sprung über ein Warten auf den Boden. Hier stehen die Steine noch auf dem alten: neu setzen.
  v.rocks.lastX = Infinity;
  v.rocks.planX = Infinity;
  await wait(400);
  return { x: pose.x, z: pose.z, eye: +(v.camera.parent.position.y + 1.05).toFixed(1), ground: +ground(pose.x, pose.z).toFixed(1) };
}

/** Speichert genau das Bild, das auch die Aufnahme bekäme. */
export async function snap(name) {
  const clock = window.__clock;
  clock.auto = false;
  clock.step(1000 / FPS);
  const blob = await new Promise((resolve) => { v.renderer.domElement.toBlob(resolve, 'image/jpeg', 0.9); });
  clock.auto = true;
  await fetch(`/__film?name=vorschau/${name}.jpg`, { method: 'POST', body: blob });
}

// Weiche Kurve durch die Stützpunkte
function along(keys, u) {
  const span = (keys.length - 1) * Math.min(u, 0.99999);
  const i = Math.floor(span), t = span - i;
  const p0 = keys[Math.max(i - 1, 0)], p1 = keys[i], p2 = keys[i + 1], p3 = keys[Math.min(i + 2, keys.length - 1)];
  const out = {};
  for (const name of ['x', 'z', 'above', 'y', 'yaw', 'pitch', 'roll']) {
    if (p1[name] === undefined) continue;
    const a = p0[name] ?? p1[name], b = p1[name], c = p2[name] ?? b, d = p3[name] ?? c;
    out[name] = 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
  }
  return out;
}

/** Ein Mensch steht nie ganz still: Der Kopf wandert ein wenig. */
function sway(pose, seconds) {
  pose.yaw += 0.006 * Math.sin(seconds * 0.71) + 0.003 * Math.sin(seconds * 1.73);
  pose.pitch += 0.004 * Math.sin(seconds * 0.93 + 1) + 0.002 * Math.sin(seconds * 2.11);
  return pose;
}

export function poseAt(shot, u) {
  return sway(along(shot.keys, u), u * shot.seconds);
}

/** Zeigt ein Bild aus einer Szene, um sie vor der Aufnahme zu beurteilen. */
export function preview(shot, u = 0) {
  return look(poseAt(shot, u));
}

/** Baut den Boden am Anfang der Szene frisch auf, damit auch nach dem Sprung dorthin alles aus einem Guss ist. */
export async function arrive(shot, u = 0) {
  const pose = poseAt(shot, u);
  window.__clock.auto = true;
  await v.arriveAt(pose.x, pose.z);
  await wait(600);
  return look(pose, shot.settle ?? 1500);
}

/** Setzt die Welt der Szene und nimmt sie auf. Die Bilder landen auf der Platte. */
export async function recordShot(shot, index, status = () => {}) {
  if (v.planet.id !== shot.planet) {
    await v.switchPlanet(v.PLANETS[shot.planet]);
    await wait(500);
  }
  await arrive(shot);
  v.dust.devils.fill(null);
  (shot.devils ?? []).forEach((devil, i) => {
    v.dust.devils[i] = { x: devil.x, z: devil.z, born: v.dust.moteUniforms.uTime.value - 30, windX: devil.windX ?? 1, windZ: devil.windZ ?? 3 };
  });
  const clock = window.__clock;
  clock.auto = false;
  const canvas = v.renderer.domElement;
  const frames = Math.round(shot.seconds * FPS);
  const uploads = [];
  for (let n = 0; n < frames; n++) {
    place(poseAt(shot, n / (frames - 1)));
    clock.step(1000 / FPS);
    const blob = await new Promise((resolve) => { canvas.toBlob(resolve, 'image/jpeg', QUALITY); });
    uploads.push(fetch(`/__film?name=shot${String(index).padStart(2, '0')}/${String(n).padStart(5, '0')}.jpg`, { method: 'POST', body: blob }));
    if (uploads.length >= 6) await uploads.shift();
    status(n + 1, frames);
    // Die Hintergrundrechner müssen drankommen, sonst fehlt in der Ferne das Gelände
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
  await Promise.all(uploads);
  clock.auto = true;
}

/** Nimmt alle Szenen auf. Der Fortschritt steht in window.__film. */
export async function record(shots, from = 0, to = shots.length) {
  window.__film = { done: false, shot: from, frame: 0, frames: 0, started: Date.now() };
  try {
    for (let i = from; i < to; i++) {
      window.__film.shot = i;
      await recordShot(shots[i], i, (frame, frames) => { window.__film.frame = frame; window.__film.frames = frames; });
    }
    window.__film.done = true;
  } catch (error) {
    window.__film.error = String(error?.stack ?? error);
  }
  return window.__film;
}

/** Rendert den Ton: ein einziges Stück über die ganze Länge, ab einer Stelle, an der schon alles klingt. */
export async function music({ seed = 1, planet = 'slate', from = 81, seconds = 60, rate = 48000 } = {}) {
  const { Music } = await import('/src/music.ts');
  const events = [];
  const total = from + seconds;
  const ctx = new OfflineAudioContext(2, Math.floor(total * rate), rate);
  const piece = new Music(ctx, (at, text) => events.push(`${at.toFixed(1)} ${text}`));
  piece.begin(seed, planet);
  piece.schedule(total);
  piece.start();
  const buffer = await ctx.startRendering();
  const start = Math.floor(from * rate), length = Math.floor(seconds * rate);
  const left = buffer.getChannelData(0).subarray(start, start + length), right = buffer.getChannelData(1).subarray(start, start + length);
  const wav = new DataView(new ArrayBuffer(44 + length * 4));
  const text = (at, s) => { for (let i = 0; i < s.length; i++) wav.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF');
  wav.setUint32(4, 36 + length * 4, true);
  text(8, 'WAVEfmt ');
  wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true);
  wav.setUint16(22, 2, true);
  wav.setUint32(24, rate, true);
  wav.setUint32(28, rate * 4, true);
  wav.setUint16(32, 4, true);
  wav.setUint16(34, 16, true);
  text(36, 'data');
  wav.setUint32(40, length * 4, true);
  for (let i = 0; i < length; i++) {
    wav.setInt16(44 + i * 4, Math.max(-1, Math.min(1, left[i])) * 32767, true);
    wav.setInt16(46 + i * 4, Math.max(-1, Math.min(1, right[i])) * 32767, true);
  }
  await fetch('/__film?name=music.wav', { method: 'POST', body: wav.buffer });
  return events;
}
