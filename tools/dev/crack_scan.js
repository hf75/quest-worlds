// Sucht im laufenden Bild nach Rissen im Gelände: Der Himmel wird magenta gefärbt, und jeder kleine, ringsum geschlossene
// Fleck davon ist eine Stelle, an der man durch den Boden hindurchsieht. Läuft auf einer festen Strecke, damit sich
// Messungen vergleichen lassen.
//
// Im Browser auf /?seed=1 öffnen, die Seite muss sichtbar bleiben. Dann in der Konsole:
//   (await import('/tools/dev/crack_scan.js')).start({ hops: 26 })
// Das Ergebnis steht danach in window.__scanResult, der Fortschritt in window.__scanProgress.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setUp(v) {
  document.getElementById('overlay').style.display = 'none';
  let root = v.camera;
  while (root.parent) root = root.parent;
  const dome = root.children.find((o) => o.renderOrder === 10);
  const stars = root.children.find((o) => o.renderOrder === 11);
  dome.material.fragmentShader = 'void main() { gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); }';
  dome.material.needsUpdate = true;
  Object.defineProperty(stars, 'visible', { get: () => false, set: () => {}, configurable: true });
  // Tief im Berg blendet der Viewer den Himmel aus. Hier soll er auch dort hinter den Wänden stehen.
  Object.defineProperty(dome, 'visible', { get: () => true, set: () => {}, configurable: true });

  const gl = v.renderer.getContext();
  let want = null;
  const render = v.renderer.render.bind(v.renderer);
  v.renderer.render = (s, c) => {
    render(s, c);
    if (!want) return;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const done = want;
    want = null;
    done({ w, h, px });
  };
  return () => new Promise((r) => { want = r; });
}

export function holesOf({ w, h, px }, maxArea = 40) {
  const mask = new Uint8Array(w * h);
  for (let i = 0, o = 0; i < w * h; i++, o += 4) if (px[o] - px[o + 1] > 22 && px[o + 2] - px[o + 1] > 22) mask[i] = 1;
  const seen = new Uint8Array(w * h);
  const found = [];
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    stack.length = 0;
    stack.push(i);
    seen[i] = 1;
    let area = 0, touches = false, sx = 0, sy = 0;
    while (stack.length) {
      const c = stack.pop();
      area++;
      const x = c % w, y = (c / w) | 0;
      sx += x;
      sy += y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (mask[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (!touches && area <= maxArea) found.push({ area, x: Math.round(sx / area), y: Math.round(h - sy / area) });
  }
  return found;
}

/** views: eine Liste aus { x, z, yaw, pitch, lift } statt der Zufallsstrecke. lift hebt oder senkt das Auge, zum Beispiel in eine Höhle. */
export async function start({ hops = 26, step = 24, views: list = null, pitch = -0.15 } = {}) {
  window.__scanResult = null;
  window.__scanProgress = 0;
  for (let i = 0; i < 120 && !(window.__viewer && document.getElementById('status').textContent.includes('Vorschau')); i++) await sleep(250);
  const v = window.__viewer;
  const grab = setUp(v);
  window.__grab = grab;
  window.__holesOf = holesOf;
  await sleep(1500);

  let a = 12345;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const spots = list ?? [];
  if (!list) {
    let x = v.pose.x, z = v.pose.z, dir = rnd() * 6.28;
    for (let hop = 0; hop < hops; hop++) {
      dir += (rnd() - 0.5) * 1.2;
      x += Math.cos(dir) * step;
      z += Math.sin(dir) * step;
      for (let k = 0; k < 3; k++) spots.push({ x, z, yaw: dir + k * 2.1, pitch, fresh: k === 0 });
    }
  }

  let views = 0, total = 0, ground = 0, biggest = 0, single = 0;
  const worst = [];
  const t0 = performance.now();
  for (const spot of spots) {
    v.pose.x = spot.x;
    v.pose.z = spot.z;
    v.pose.yaw = spot.yaw;
    v.pose.pitch = spot.pitch ?? pitch;
    v.pose.lift = spot.lift ?? 0;
    if (spot.fresh !== false) {
      await sleep(350);
      v.settleFeet();
      await sleep(60);
    }
    await sleep(40);
    const frame = await grab();
    const holes = holesOf(frame);
    views++;
    total += holes.length;
    for (const c of holes) {
      biggest = Math.max(biggest, c.area);
      if (c.y > frame.h * 0.62) ground++;
      if (c.area === 1) single++;
    }
    if (holes.length) worst.push({ n: holes.length, x: +spot.x.toFixed(1), z: +spot.z.toFixed(1), yaw: +spot.yaw.toFixed(3), pitch: +v.pose.pitch.toFixed(2), at: holes.slice(0, 4).map((c) => [c.x, c.y, c.area]) });
    window.__scanProgress = views;
  }
  worst.sort((p, q) => q.n - p.n);
  window.__scanResult = { views, total, perView: +(total / views).toFixed(2), ground, single, biggest, seconds: Math.round((performance.now() - t0) / 1000), worst: worst.slice(0, 5) };
}
