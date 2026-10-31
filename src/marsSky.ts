import * as THREE from 'three';
import { marsHorizon } from './shading';
import { createStars, type Sky } from './sky';
import { pointStars } from './skyGen';
import { bakeVertex } from './skyShaders';
import { trace } from './trace';
import { mulberry } from './world';

// Der Himmel des Mars in der Dämmerung, wie ihn die Rover fotografiert haben: Der Staub färbt ihn butterfarben, aber um die Sonne herum streut
// er das Blau nach vorn, genau umgekehrt wie auf der Erde. Der Verlauf ist glatt und wird einmal gebacken, in Halbfloat gegen Stufen.
// Darüber liegen, was sich bewegt oder scharf sein muss: Eiswolken, Sonne, Phobos und die ersten Sterne.

const CUBE_SIZE = 512;
const REFLECTION_SIZE = 128;
const STARS = 1800;
const CLOUD_SIZE = 256;
const SUN_RADIUS = 0.0042;
const SUN_REACH = 0.075;
const PHOBOS_REACH = 0.0085;

const skyColor = `
  ${marsHorizon}
  vec3 marsSky(vec3 d) {
    vec3 horizon = marsHorizon(d);
    float toSun = dot(d, uKeyDir);
    float angle = acos(clamp(toSun, -1.0, 1.0));

    // Nach oben wird es rasch dunkler, gegenüber der Sonne am dunkelsten. Dort beginnt schon die Nacht.
    float up = pow(max(d.y, 0.0), 0.6);
    vec3 overhead = mix(vec3(0.02, 0.0125, 0.017), vec3(0.105, 0.062, 0.05), smoothstep(-0.3, 1.0, toSun));
    vec3 c = mix(horizon, overhead, smoothstep(0.0, 0.82, up));

    // Das blaue Licht um die Sonne ersetzt die Butterfarbe, statt sich nur darüberzulegen
    // Tief am Horizont blickt man durch zu viel Staub, dort kommt es nicht mehr an: Sonst stünde eine Linie, wo der Boden endet.
    float clearAir = smoothstep(-0.005, 0.15, d.y);
    float halo = exp(-angle / 0.17);
    c = mix(c, vec3(0.31, 0.44, 0.72), halo * 0.92 * clearAir);
    c += vec3(0.42, 0.56, 0.78) * exp(-angle / 0.075) * 0.75 * clearAir;

    // Unter dem Horizont bleibt nur Dunst: Dorthinein läuft der Boden in der Ferne aus
    return mix(c, horizon, smoothstep(0.0, -0.015, d.y));
  }
`;

const bakeFragment = `
  uniform int uFace;
  uniform vec3 uKeyDir;
  varying vec2 vUv;
  ${skyColor}
  vec3 faceDirection(vec2 st) {
    float s = st.x, t = st.y;
    if (uFace == 0) return normalize(vec3(1.0, -t, -s));
    if (uFace == 1) return normalize(vec3(-1.0, -t, s));
    if (uFace == 2) return normalize(vec3(s, 1.0, t));
    if (uFace == 3) return normalize(vec3(s, -1.0, -t));
    if (uFace == 4) return normalize(vec3(s, -t, 1.0));
    return normalize(vec3(-s, -t, -1.0));
  }
  void main() {
    gl_FragColor = vec4(marsSky(faceDirection(vUv)), 1.0);
  }
`;

const domeVertex = `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
    gl_Position = p.xyww;
  }
`;

const domeFragment = `
  uniform samplerCube uCube;
  uniform sampler2D uClouds;
  uniform vec3 uKeyDir;
  uniform vec2 uDrift;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    vec3 c = texture(uCube, d).rgb;
    // Dünne Eiswolken in großer Höhe, wie sie der Rover nach Sonnenuntergang gesehen hat. Sie ziehen in langen Fahnen und fangen noch Licht.
    if (d.y > 0.015) {
      vec2 q = d.xz / (d.y + 0.16);
      float a = texture(uClouds, q * vec2(0.05, 0.16) + uDrift).r;
      float b = texture(uClouds, q * vec2(0.13, 0.47) - uDrift * 1.7).r;
      float veil = smoothstep(0.5, 0.86, a * 0.72 + b * 0.42) * smoothstep(0.015, 0.2, d.y);
      float lit = exp(-acos(clamp(dot(d, uKeyDir), -1.0, 1.0)) / 1.05);
      c = mix(c, mix(vec3(0.115, 0.07, 0.056), vec3(0.74, 0.66, 0.66), lit), veil * 0.3);
    }
    vec3 s = mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
    float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    gl_FragColor = vec4(s + (n - 0.5) / 255.0, 1.0);
  }
`;

const discVertex = `
  attribute vec2 aDisc;
  varying vec2 vDisc;
  void main() {
    vDisc = aDisc;
    vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
    gl_Position = p.xyww;
  }
`;

const sunFragment = `
  varying vec2 vDisc;
  void main() {
    float r = length(vDisc) * ${SUN_REACH.toFixed(4)};
    float disc = smoothstep(${(SUN_RADIUS * 1.12).toFixed(5)}, ${(SUN_RADIUS * 0.88).toFixed(5)}, r);
    float glow = exp(-r / 0.006) * 0.75 + exp(-r / 0.02) * 0.22;
    glow *= 1.0 - smoothstep(0.6, 1.0, length(vDisc));
    gl_FragColor = vec4(vec3(1.0, 0.99, 0.97) * disc + vec3(0.72, 0.84, 1.0) * glow, 1.0);
  }
`;

// Phobos ist kein Ball: Sein Umriss wird aus ein paar Wellen gebildet, und die Beleuchtung kommt von der Sonne
const phobosFragment = `
  uniform vec3 uLight;
  varying vec2 vDisc;
  void main() {
    vec2 p = vDisc;
    float a = atan(p.y, p.x);
    float edge = 0.8 + 0.09 * sin(a * 2.0 + 0.7) + 0.05 * sin(a * 3.0 + 2.1) + 0.03 * sin(a * 7.0);
    float r = length(p) / edge;
    float inside = smoothstep(1.0, 0.92, r);
    if (inside <= 0.0) discard;
    vec3 n = vec3(p / edge, sqrt(max(1.0 - r * r, 0.0)));
    // Der große Krater Stickney und ein paar kleine
    float pits = smoothstep(0.34, 0.26, length(p - vec2(-0.26, 0.2))) * 0.3 + smoothstep(0.16, 0.1, length(p - vec2(0.3, -0.22))) * 0.2 + smoothstep(0.12, 0.07, length(p - vec2(0.1, 0.4))) * 0.16;
    float lit = max(dot(n, uLight), 0.0);
    // Im Gegenlicht der Dämmerung leuchtet selbst dieses dunkle Gestein heller als der Himmel dahinter, solange die Sonne es trifft
    gl_FragColor = vec4(vec3(0.92, 0.78, 0.66) * (0.04 + 1.05 * lit) * (1.0 - pits), inside);
  }
`;

function cloudTexture(random: () => number): THREE.DataTexture {
  // Nahtloses Rauschen in Oktaven, einmal gerechnet
  const n = CLOUD_SIZE;
  const octaves = [4, 8, 16, 32, 64].map((cells, i) => ({ cells, weight: 0.55 ** i, grid: Float32Array.from({ length: cells * cells }, () => random()) }));
  const data = new Uint8Array(n * n * 4);
  const fade = (t: number) => t * t * (3 - 2 * t);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let sum = 0, total = 0;
      for (const { cells, weight, grid } of octaves) {
        const u = (i / n) * cells, v = (j / n) * cells;
        const x = Math.floor(u), y = Math.floor(v), fx = fade(u - x), fy = fade(v - y);
        const at = (a: number, b: number) => grid[(b % cells) * cells + (a % cells)];
        const top = at(x, y) + (at(x + 1, y) - at(x, y)) * fx;
        sum += weight * (top + (at(x, y + 1) + (at(x + 1, y + 1) - at(x, y + 1)) * fx - top) * fy);
        total += weight;
      }
      const o = (j * n + i) * 4;
      data[o] = Math.round(Math.max(0, Math.min(1, (sum / total - 0.5) * 2.1 + 0.5)) * 255);
      data[o + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, n, n);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function basisAround(n: THREE.Vector3) {
  const helper = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(helper, n).normalize();
  return { u, v: new THREE.Vector3().crossVectors(n, u) };
}

export class MarsSky implements Sky {
  readonly skyLod = 2.5;
  readonly objects: THREE.Object3D[];
  readonly mirrored: THREE.Object3D[] = [];
  private readonly renderer: THREE.WebGLRenderer;
  private readonly cube: THREE.WebGLCubeRenderTarget;
  private readonly reflection: THREE.WebGLCubeRenderTarget;
  private readonly bakeScene = new THREE.Scene();
  private readonly bakeCamera = new THREE.Camera();
  private readonly bake: THREE.ShaderMaterial;
  private readonly keyDir = new THREE.Vector3(0, 1, 0);
  private readonly drift = new THREE.Vector2();
  private readonly sun: THREE.Mesh;
  private readonly phobos: THREE.Mesh;
  private readonly phobosLight = new THREE.Vector3(0, 0, 1);
  private readonly stars: ReturnType<typeof createStars>;
  private readonly dome: THREE.Mesh;
  private readonly orbitAxis = new THREE.Vector3(0, 1, 0);
  private readonly orbitStart = new THREE.Vector3(1, 0, 0);
  private readonly phobosAt = new THREE.Vector3();
  private readonly u = new THREE.Vector3();
  private readonly v = new THREE.Vector3();
  private cloudShift = new THREE.Vector2();
  private steps: (() => void)[] = [];
  private stepIndex = 0;
  private bakeStart = 0;
  private finish: (() => void) | null = null;

  finished: Promise<void> = Promise.resolve();

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    const canHalfFloat = renderer.extensions.has('EXT_color_buffer_half_float') || renderer.extensions.has('EXT_color_buffer_float');
    this.cube = new THREE.WebGLCubeRenderTarget(CUBE_SIZE, {
      depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: canHalfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
    });
    this.reflection = new THREE.WebGLCubeRenderTarget(REFLECTION_SIZE, {
      depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.SRGBColorSpace,
    });
    this.bake = new THREE.ShaderMaterial({
      vertexShader: bakeVertex, fragmentShader: bakeFragment, uniforms: { uFace: { value: 0 }, uKeyDir: { value: this.keyDir } },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bake);
    quad.frustumCulled = false;
    this.bakeScene.add(quad);

    this.dome = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.ShaderMaterial({
      uniforms: {
        uCube: { value: this.cube.texture }, uClouds: { value: cloudTexture(mulberry(4711)) }, uKeyDir: { value: this.keyDir }, uDrift: { value: this.drift },
      },
      vertexShader: domeVertex, fragmentShader: domeFragment, side: THREE.BackSide, depthWrite: false,
    }));
    this.dome.frustumCulled = false;
    this.dome.renderOrder = 10;

    this.sun = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
      vertexShader: discVertex, fragmentShader: sunFragment, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.sun.frustumCulled = false;
    this.sun.renderOrder = 11;

    this.phobos = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
      uniforms: { uLight: { value: this.phobosLight } }, vertexShader: discVertex, fragmentShader: phobosFragment, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.phobos.frustumCulled = false;
    this.phobos.renderOrder = 11;
    const phobosPosition = new THREE.BufferAttribute(new Float32Array(12), 3);
    phobosPosition.setUsage(THREE.DynamicDrawUsage);
    this.phobos.geometry.setAttribute('position', phobosPosition);
    this.phobos.geometry.setAttribute('aDisc', new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2));
    this.phobos.geometry.setIndex([0, 1, 2, 0, 2, 3]);

    this.stars = createStars(new Float32Array(STARS * 8));
    this.objects = [this.dome, this.sun, this.phobos, this.stars.points];
  }

  get texture(): THREE.Texture {
    return this.reflection.texture;
  }

  get baking(): boolean {
    return this.stepIndex < this.steps.length;
  }

  setVisible(visible: boolean) {
    for (const o of this.objects) o.visible = visible;
  }

  setMirrorVisible() {}

  /** Die Sonne steht immer gleich, denn die Kacheln tragen ihre Schatten. Der Seed verschiebt nur, was am Himmel sonst noch ist. */
  begin(seed: number, keyAzimuth: number, keyElevation: number) {
    const r = mulberry(seed ^ 0x6d617273);
    this.keyDir.set(Math.cos(keyElevation) * Math.cos(keyAzimuth), Math.sin(keyElevation), Math.cos(keyElevation) * Math.sin(keyAzimuth)).normalize();

    // Die Sonne als kleines Vieleck am Himmel
    const { u, v } = basisAround(this.keyDir);
    const corners = 16, position = [this.keyDir.x, this.keyDir.y, this.keyDir.z], disc = [0, 0], index: number[] = [];
    const scale = SUN_REACH / Math.cos(Math.PI / corners);
    for (let i = 0; i < corners; i++) {
      const a = (i / corners) * Math.PI * 2, x = Math.cos(a) / Math.cos(Math.PI / corners), y = Math.sin(a) / Math.cos(Math.PI / corners);
      position.push(this.keyDir.x + (u.x * x + v.x * y) * scale * Math.cos(Math.PI / corners), this.keyDir.y + (u.y * x + v.y * y) * scale * Math.cos(Math.PI / corners), this.keyDir.z + (u.z * x + v.z * y) * scale * Math.cos(Math.PI / corners));
      disc.push(x, y);
      index.push(0, i + 1, ((i + 1) % corners) + 1);
    }
    const sunGeometry = new THREE.BufferGeometry();
    sunGeometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    sunGeometry.setAttribute('aDisc', new THREE.Float32BufferAttribute(disc, 2));
    sunGeometry.setIndex(index);
    this.sun.geometry.dispose();
    this.sun.geometry = sunGeometry;

    // Die ersten Sterne stehen dort, wo der Himmel schon dunkel ist. Die Erde ist der hellste Abendstern, nah bei der Sonne, und Deimos ein heller Punkt.
    const raw = pointStars(r, STARS);
    const star = new THREE.Vector3();
    for (let i = 0; i < STARS; i++) {
      const o = i * 8;
      star.set(raw[o], raw[o + 1], raw[o + 2]);
      const dark = THREE.MathUtils.smoothstep(star.y, 0.12, 0.55) * THREE.MathUtils.smoothstep(Math.acos(star.dot(this.keyDir)), 0.75, 1.9);
      raw[o + 3] *= dark * 0.8;
      raw[o + 4] *= dark;
      raw[o + 5] *= dark;
      raw[o + 6] *= dark;
    }
    const earth = new THREE.Vector3().copy(this.keyDir).addScaledVector(u, (r() < 0.5 ? -1 : 1) * 0.3).addScaledVector(new THREE.Vector3(0, 1, 0), 0.2).normalize();
    raw.set([earth.x, earth.y, earth.z, 12, 0.62, 0.8, 1.0, 0.1], 0);
    const deimosAt = new THREE.Vector3(Math.cos(keyAzimuth + 2.2 + r()), 0.55 + r() * 0.3, Math.sin(keyAzimuth + 2.2 + r())).normalize();
    raw.set([deimosAt.x, deimosAt.y, deimosAt.z, 8, 1.0, 0.92, 0.84, 0.3], 8);
    this.stars.setData(raw);

    // Phobos zieht auf einer flachen Bahn über den Himmel, von Westen nach Osten, viel schneller als alles andere dort oben
    const tilt = 0.25 + r() * 0.25;
    this.orbitAxis.set(Math.sin(tilt) * Math.cos(keyAzimuth), Math.cos(tilt), Math.sin(tilt) * Math.sin(keyAzimuth)).normalize();
    const away = new THREE.Vector3(-Math.cos(keyAzimuth), 0, -Math.sin(keyAzimuth));
    this.orbitStart.copy(away).addScaledVector(this.orbitAxis, -away.dot(this.orbitAxis)).normalize();
    this.orbitStart.applyAxisAngle(this.orbitAxis, 0.6 + r() * 1.4);
    this.cloudShift.set(r(), r());

    this.steps = [];
    for (let face = 0; face < 6; face++) this.steps.push(() => this.draw(this.cube, face, false));
    for (let face = 0; face < 6; face++) this.steps.push(() => this.draw(this.reflection, face, face === 5));
    this.stepIndex = 0;
    this.bakeStart = performance.now();
    this.finished = new Promise((resolve) => { this.finish = resolve; });
  }

  private draw(target: THREE.WebGLCubeRenderTarget, face: number, withMips: boolean) {
    const renderer = this.renderer;
    const previous = renderer.getRenderTarget();
    const xrWas = renderer.xr.enabled;
    const clearWas = renderer.autoClear;
    renderer.xr.enabled = false;
    renderer.autoClear = false;
    this.bake.uniforms.uFace.value = face;
    renderer.setRenderTarget(target, face);
    target.texture.generateMipmaps = withMips;
    renderer.render(this.bakeScene, this.bakeCamera);
    renderer.setRenderTarget(previous);
    renderer.autoClear = clearWas;
    renderer.xr.enabled = xrWas;
  }

  step(): boolean {
    if (this.stepIndex >= this.steps.length) return true;
    this.steps[this.stepIndex++]();
    if (this.stepIndex < this.steps.length) return false;
    trace(`Sky baked: ${Math.round(performance.now() - this.bakeStart)} ms, ${this.steps.length} steps`);
    this.finish?.();
    this.finish = null;
    return true;
  }

  /** Die Karten werden erst gebraucht, wenn man wieder hierher kommt. Bis dahin ist der Speicher anderswo besser aufgehoben. */
  sleep() {
    this.cube.dispose();
    this.reflection.dispose();
  }

  update(time: number, pixelScale: number) {
    this.stars.update(time, pixelScale);
    this.drift.set(this.cloudShift.x + time * 0.0011, this.cloudShift.y + time * 0.00035);

    const at = this.phobosAt.copy(this.orbitStart).applyAxisAngle(this.orbitAxis, time * 0.00085);
    this.phobos.visible = this.dome.visible && at.y > -0.05;
    if (!this.phobos.visible) return;
    const { u, v } = basisAround(at);
    this.u.copy(u);
    this.v.copy(v);
    const attribute = this.phobos.geometry.getAttribute('position') as THREE.BufferAttribute;
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([x, y], i) => {
      attribute.setXYZ(i, at.x + (u.x * x + v.x * y) * PHOBOS_REACH, at.y + (u.y * x + v.y * y) * PHOBOS_REACH, at.z + (u.z * x + v.z * y) * PHOBOS_REACH);
    });
    attribute.needsUpdate = true;
    // Die Sonne in den Achsen der Scheibe. Vorn ist dort, wo der Betrachter steht, also gegen die Blickrichtung.
    this.phobosLight.set(this.keyDir.dot(this.u), this.keyDir.dot(this.v), -this.keyDir.dot(at)).normalize();
  }
}
