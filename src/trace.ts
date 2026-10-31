import type * as THREE from 'three';

// Im Headset gibt es keine Konsole. Darum hält dies fest, was eine Sitzung erlebt: Fehler, Sichtbarkeit, verlorener Grafikkontext
// und die Bildrate der ersten Sekunden. Es übersteht auch ein Neuladen der Seite. Mitlesen am PC: tools/dev/vite.trace.config.ts

const STORE = 'worlds-trace';
const KEEP = 60;
const lines: string[] = [];
let sessionStart = 0;
let lastFrame = 0;
let lastReport = 0;
let frames = 0;
let worst = 0;

export function trace(message: string) {
  const line = `${(performance.now() / 1000).toFixed(2)}  ${message}`;
  lines.push(line);
  if (lines.length > KEEP) lines.shift();
  console.log(`[trace] ${line}`);
  try {
    sessionStorage.setItem(STORE, lines.join('\n'));
  } catch {
    // Ohne Speicher bleibt immer noch die Konsole
  }
  if (import.meta.env.VITE_TRACE) navigator.sendBeacon('/__trace', line);
}

/** Die letzten Zeilen, zum Anzeigen auf der Seite: Sie sollen auch ohne PC verraten, warum eine Sitzung endete. */
export function traceTail(count: number): string {
  return lines.slice(-count).join('\n');
}

export function installTrace(renderer: THREE.WebGLRenderer) {
  let before: string | null = null;
  try {
    before = sessionStorage.getItem(STORE);
  } catch {
    before = null;
  }
  if (before) trace(`Page reloaded. Last line before: ${before.split('\n').pop()}`);
  trace(`Start: ${navigator.userAgent}`);

  addEventListener('error', (e) => trace(`Error: ${e.message} (${e.filename}:${e.lineno})`));
  addEventListener('unhandledrejection', (e) => trace(`Rejected: ${e.reason}`));
  addEventListener('pagehide', () => trace('Leaving the page'));
  document.addEventListener('visibilitychange', () => trace(`Page: ${document.visibilityState}`));
  renderer.domElement.addEventListener('webglcontextlost', () => trace('WebGL context lost'));
  renderer.domElement.addEventListener('webglcontextrestored', () => trace('WebGL context restored'));
  renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
    trace(`Shader: ${gl.getProgramInfoLog(program)} | ${gl.getShaderInfoLog(vertex)} | ${gl.getShaderInfoLog(fragment)}`.slice(0, 900));
  };

  if (import.meta.hot) {
    import.meta.hot.on('vite:beforeFullReload', () => trace('The server reloads the page'));
    import.meta.hot.on('vite:ws:disconnect', () => trace('Lost the connection to the server'));
  }
}

export function traceSession(session: XRSession) {
  trace(`Session open, visibility ${session.visibilityState}, inputs ${session.inputSources.length}`);
  session.addEventListener('visibilitychange', () => trace(`Visibility ${session.visibilityState}`));
  session.addEventListener('inputsourceschange', () => trace(`Inputs ${session.inputSources.length}`));
  session.addEventListener('end', () => trace('Session ended'));
}

/** Je Bild aufrufen. Berichtet in den ersten Sekunden einer Sitzung einmal je Sekunde, danach alle 10 s: So zeigt sich die Bildrate auch unterwegs. */
export function traceFrame(renderer: THREE.WebGLRenderer) {
  if (!renderer.xr.isPresenting) {
    sessionStart = 0;
    return;
  }
  const now = performance.now();
  if (!sessionStart) {
    sessionStart = lastFrame = lastReport = now;
    frames = 0;
    worst = 0;
    trace('First frame in VR');
  }
  worst = Math.max(worst, now - lastFrame);
  lastFrame = now;
  frames++;
  if (now - lastReport >= (now - sessionStart < 15000 ? 1000 : 10000)) {
    const programs = (renderer.info.programs ?? []) as unknown as { diagnostics?: { runnable: boolean } }[];
    const broken = programs.filter((p) => p.diagnostics && !p.diagnostics.runnable).length;
    trace(`${((frames * 1000) / (now - lastReport)).toFixed(0)} frames/s, longest ${worst.toFixed(0)} ms, ${renderer.info.render.triangles} triangles, broken shaders ${broken}`);
    frames = 0;
    worst = 0;
    lastReport = now;
  }
}
