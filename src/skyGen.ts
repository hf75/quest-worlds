import * as THREE from 'three';
import { createStars, type Sky } from './sky';
import {
  backgroundFragment, bakeVertex, galaxyFragment, grainFragment, grainVertex, nebulaFragment, smoothFragment, upscaleFragment,
} from './skyShaders';
import { trace } from './trace';
import { inTheWater, ORDER_MIRROR, ORDER_MIRROR_DOME } from './water';
import { mulberry } from './world';

// Jede Welt hat ihren eigenen Himmel, und er bewegt sich. Das Modell wäre je Bild viel zu teuer, darum backt die Grafikkarte es beim
// Weltwechsel in kleinen Stücken, während das Bild ohnehin schwarz ist. Danach kosten Galaxie und Nebel nur noch je einen
// Zugriff: Sie sind eigene Scheiben am Himmel, die sich drehen und wabern, ohne dass je Bild etwas neu berechnet wird.

const CUBE_SIZE = 2048;
const BACKGROUND_SIZE = 512;
const REFLECTION_SIZE = 128;
const GALAXY_SIZE = 2048;
const NEBULA_SIZE = 1536;
// So viele Stücke je Seite: Keines darf die Grafikkarte so lange aufhalten, dass das System eingreift
const GALAXY_TILES = 8;
const NEBULA_TILES = 12;
const GRAIN_STARS = 500000;
const POINT_STARS = 5000;
const GALAXY_RADIUS = 21;
const GALAXY_DISTANCE = 27;
const NEBULA_SPAN = 0.8;

// Galaxie: Farben der jungen Sterne, der Knoten und der kleinen Haufen. Nebel: Farben der Fäden und des Gaskerns.
const GALAXY_COLORS = [
  { young: [0.36, 0.56, 1.0], hii: [1.0, 0.18, 0.46], knots: [0.5, 0.72, 1.0] },
  { young: [0.3, 0.72, 0.9], hii: [1.0, 0.42, 0.22], knots: [0.5, 0.9, 0.95] },
  { young: [0.62, 0.48, 1.0], hii: [1.0, 0.2, 0.62], knots: [0.72, 0.62, 1.0] },
  { young: [0.86, 0.72, 0.5], hii: [1.0, 0.3, 0.2], knots: [1.0, 0.86, 0.62] },
];
const NEBULA_COLORS = [
  { shell: [0.3, 0.062, 0.034], gas: [0.012, 0.074, 0.104] },
  { shell: [0.26, 0.04, 0.16], gas: [0.03, 0.05, 0.13] },
  { shell: [0.3, 0.13, 0.03], gas: [0.05, 0.03, 0.12] },
  { shell: [0.08, 0.27, 0.22], gas: [0.13, 0.05, 0.11] },
];

const skyDirection = (azimuth: number, elevation: number) => new THREE.Vector3(
  Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.sin(azimuth),
);

function basisAround(n: THREE.Vector3, spin: number) {
  const helper = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(helper, n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u);
  const c = Math.cos(spin), s = Math.sin(spin);
  return { e1: u.clone().multiplyScalar(c).addScaledVector(v, s), e2: u.clone().multiplyScalar(-s).addScaledVector(v, c) };
}

/** Die hellen Einzelsterne als Punktliste: Sie bleiben gestochen scharf und funkeln. */
export function pointStars(random: () => number, count = POINT_STARS): Float32Array {
  const gaussian = () => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-6))) * Math.cos(random() * Math.PI * 2);
  const unit = (out: THREE.Vector3) => out.set(gaussian(), gaussian(), gaussian()).normalize();
  const centers = Array.from({ length: 70 }, () => ({ at: unit(new THREE.Vector3()), spread: Math.exp(Math.log(0.05) + 0.6 * gaussian()) }));
  const raw = new Float32Array(count * 8);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    if (random() < 0.3) {
      const c = centers[Math.floor(random() * centers.length)];
      v.set(c.at.x + gaussian() * c.spread, c.at.y + gaussian() * c.spread, c.at.z + gaussian() * c.spread).normalize();
    } else unit(v);
    const flux = Math.min((Math.pow(1 - random(), -1 / 1.2) - 1) * 0.5 + 0.03, 18);
    const heat = Math.min(1, Math.max(0, 0.5 + 0.28 * gaussian()));
    const r = heat < 0.5 ? 1 : 1 - (heat - 0.5) * 0.56;
    const g = heat < 0.5 ? 0.72 + heat * 0.5 : 0.97 - (heat - 0.5) * 0.14;
    const b = heat < 0.5 ? 0.46 + heat * 1.0 : 0.96 + (heat - 0.5) * 0.08;
    raw.set([v.x, v.y, v.z, flux, r * 0.72 + 0.28, g * 0.72 + 0.28, b * 0.72 + 0.28, random()], i * 8);
  }
  return raw;
}

const domeVertex = `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec3 q = position;
    #ifdef MIRROR
    q.y = -q.y;
    #endif
    vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * q, 1.0);
    gl_Position = p.xyww;
  }
`;

const domeFragment = `
  uniform samplerCube uCube;
  varying vec3 vDir;
  void main() {
    vec3 c = texture(uCube, vDir).rgb;
    #ifdef LINEAR_OUT
    gl_FragColor = vec4(c, 1.0);
    #else
    vec3 s = mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
    float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    gl_FragColor = vec4(s + (n - 0.5) / 255.0, 1.0);
    #endif
  }
`;

// Galaxie und Nebel liegen im Unendlichen wie die Kuppel. Ihre Bilder enthalten schon fertige Bildwerte: Das spart den Rechenschritt je Pixel.
const discVertex = `
  attribute vec2 aDisc;
  varying vec2 vDisc;
  void main() {
    vDisc = aDisc;
    vec3 q = position;
    #ifdef MIRROR
    q.y = -q.y;
    #endif
    vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * q, 1.0);
    gl_Position = p.xyww;
  }
`;

const galaxyDiscFragment = `
  uniform sampler2D uImage;
  uniform float uTurn;
  uniform float uTwist;
  varying vec2 vDisc;
  void main() {
    // Sie dreht sich als Ganzes, dazu windet sich die Mitte langsam vor und zurück: Ständig schneller wäre sie bald nur noch ein Kreis
    float a = uTurn + uTwist * (1.0 - min(length(vDisc), 1.0));
    float c = cos(a), s = sin(a);
    vec3 v = texture(uImage, mat2(c, s, -s, c) * vDisc * 0.5 + 0.5).rgb;
    #ifdef LINEAR_OUT
    gl_FragColor = vec4(pow(v, vec3(2.2)), 1.0);
    #else
    gl_FragColor = vec4(v, 1.0);
    #endif
  }
`;

const nebulaDiscFragment = `
  uniform sampler2D uImage;
  uniform sampler2D uWarp;
  uniform float uTime;
  varying vec2 vDisc;
  void main() {
    // Zwei langsam treibende Felder verschieben das Bild ein wenig: Das Gas wabert, ohne dass es je neu berechnet würde
    vec2 a = texture(uWarp, vDisc * 0.9 + uTime * vec2(0.0034, 0.0027)).xy - 0.5;
    vec2 b = texture(uWarp, vDisc * 2.1 - uTime * vec2(0.0052, 0.0044)).xy - 0.5;
    vec3 v = texture(uImage, (vDisc + a * 0.07 + b * 0.022) * 0.5 + 0.5).rgb;
    #ifdef LINEAR_OUT
    gl_FragColor = vec4(pow(v, vec3(2.2)), 1.0);
    #else
    gl_FragColor = vec4(v, 1.0);
    #endif
  }
`;

const meteorVertex = `
  uniform vec3 uFrom;
  uniform vec3 uTo;
  uniform float uProgress;
  varying float vLight;
  void main() {
    // Der Kopf wandert von uFrom nach uTo, dahinter läuft der Schweif aus
    float along = position.x;
    vec3 d = normalize(mix(uFrom, uTo, max(uProgress - 0.3 * (1.0 - along), 0.0)));
    vec3 side = normalize(cross(uTo - uFrom, d));
    vec3 q = d + side * position.y * 0.0016 * (0.25 + 0.75 * along);
    #ifdef MIRROR
    q.y = -q.y;
    #endif
    vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * q, 1.0);
    gl_Position = p.xyww;
    vLight = along * along * smoothstep(0.0, 0.12, uProgress) * (1.0 - smoothstep(0.7, 1.0, uProgress)) * (1.0 - abs(position.y));
  }
`;

const meteorFragment = `
  varying float vLight;
  void main() {
    gl_FragColor = vec4(vec3(0.82, 0.92, 1.0) * vLight, 1.0);
  }
`;

const additive = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false };

function warpTexture(random: () => number): THREE.DataTexture {
  // Glattes, nahtloses Rauschen für das Wabern: Es wird nur einmal gerechnet, und weiches Filtern besorgt den Rest
  const n = 64;
  const coarse = Array.from({ length: 8 * 8 * 2 }, () => random());
  const data = new Uint8Array(n * n * 4);
  const at = (c: number, x: number, y: number) => coarse[(((y + 8) % 8) * 8 + ((x + 8) % 8)) * 2 + c];
  const fade = (t: number) => t * t * (3 - 2 * t);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = (i / n) * 8, v = (j / n) * 8;
      const x = Math.floor(u), y = Math.floor(v), fx = fade(u - x), fy = fade(v - y);
      for (let c = 0; c < 2; c++) {
        const a = at(c, x, y) + (at(c, x + 1, y) - at(c, x, y)) * fx;
        const b = at(c, x, y + 1) + (at(c, x + 1, y + 1) - at(c, x, y + 1)) * fx;
        data[(j * n + i) * 4 + c] = Math.round((a + (b - a) * fy) * 255);
      }
      data[(j * n + i) * 4 + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, n, n);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export class GeneratedSky implements Sky {
  readonly skyLod = 2.5;
  readonly objects: THREE.Object3D[];
  readonly mirrored: THREE.Object3D[];
  private readonly renderer: THREE.WebGLRenderer;
  private readonly cube: THREE.WebGLCubeRenderTarget;
  private readonly background: THREE.WebGLCubeRenderTarget;
  private readonly reflection: THREE.WebGLCubeRenderTarget;
  private readonly reflectionCamera: THREE.CubeCamera;
  private readonly reflectionScene = new THREE.Scene();
  private readonly galaxyImage: THREE.WebGLRenderTarget;
  private readonly nebulaImage: THREE.WebGLRenderTarget;
  private readonly nebulaRaw: THREE.WebGLRenderTarget;
  private readonly bakeScene = new THREE.Scene();
  private readonly bakeCamera = new THREE.Camera();
  private readonly quad: THREE.Mesh;
  private readonly grain: THREE.Points;
  private readonly stars: ReturnType<typeof createStars>;
  private readonly galaxyDisc: THREE.Mesh;
  private readonly galaxyDiscReflected: THREE.Mesh;
  private readonly nebulaDisc: THREE.Mesh;
  private readonly nebulaDiscReflected: THREE.Mesh;
  private readonly galaxyDiscMirrored: THREE.Mesh;
  private readonly nebulaDiscMirrored: THREE.Mesh;
  private readonly meteor: THREE.Mesh;
  private readonly meteorMirrored: THREE.Mesh;
  private mirrorShown = false;
  private readonly meteorUniforms = { uFrom: { value: new THREE.Vector3() }, uTo: { value: new THREE.Vector3() }, uProgress: { value: 0 } };
  private readonly galaxyUniforms = { uImage: { value: null as THREE.Texture | null }, uTurn: { value: 0 }, uTwist: { value: 0 } };
  private readonly nebulaUniforms = { uImage: { value: null as THREE.Texture | null }, uWarp: { value: null as THREE.Texture | null }, uTime: { value: 0 } };
  private readonly materials;
  private steps: (() => void)[] = [];
  private stepIndex = 0;
  private bakeStart = 0;
  private finish: (() => void) | null = null;
  private shown = true;
  private turnSpeed = 0.003;
  private nextMeteor = 14;
  private meteorStart = -1;

  /** Erfüllt, sobald der zuletzt begonnene Himmel fertig gebacken ist. */
  finished: Promise<void> = Promise.resolve();

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    const canHalfFloat = renderer.extensions.has('EXT_color_buffer_half_float') || renderer.extensions.has('EXT_color_buffer_float');
    this.background = new THREE.WebGLCubeRenderTarget(BACKGROUND_SIZE, {
      depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      type: canHalfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
    });
    this.cube = new THREE.WebGLCubeRenderTarget(CUBE_SIZE, {
      depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.SRGBColorSpace,
    });
    this.reflection = new THREE.WebGLCubeRenderTarget(REFLECTION_SIZE, {
      generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.SRGBColorSpace,
    });
    this.reflectionCamera = new THREE.CubeCamera(1, 100, this.reflection);
    const image = (size: number) => new THREE.WebGLRenderTarget(size, size, {
      depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, anisotropy: 4,
    });
    this.galaxyImage = image(GALAXY_SIZE);
    this.nebulaImage = image(NEBULA_SIZE);
    this.nebulaRaw = new THREE.WebGLRenderTarget(NEBULA_SIZE, NEBULA_SIZE, { depthBuffer: false, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.galaxyUniforms.uImage.value = this.galaxyImage.texture;
    this.nebulaUniforms.uImage.value = this.nebulaImage.texture;
    this.nebulaUniforms.uWarp.value = warpTexture(mulberry(90210));

    const bake = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) => new THREE.ShaderMaterial({
      vertexShader: bakeVertex, fragmentShader, uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this.materials = {
      background: bake(backgroundFragment, {
        uFace: { value: 0 }, uShift: { value: new THREE.Vector3() }, uBand: { value: new THREE.Vector3(0, 1, 0) }, uBandTint: { value: new THREE.Vector3() },
      }),
      upscale: bake(upscaleFragment, { uFace: { value: 0 }, uBackground: { value: this.background.texture } }),
      galaxy: bake(galaxyFragment, {
        uShift: { value: new THREE.Vector3() }, uOrigin: { value: new THREE.Vector3() }, uRb: { value: GALAXY_RADIUS }, uArms: { value: 2 }, uPitch: { value: 0.33 },
        uYoung: { value: new THREE.Vector3() }, uHii: { value: new THREE.Vector3() }, uKnots: { value: new THREE.Vector3() },
        uOld: { value: new THREE.Vector3(0.98, 0.8, 0.58) }, uCore: { value: new THREE.Vector3(1.0, 0.84, 0.64) },
      }),
      nebula: bake(nebulaFragment, {
        uShift: { value: new THREE.Vector3() }, uCenter: { value: new THREE.Vector3() }, uRight: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3() },
        uSpan: { value: NEBULA_SPAN }, uShell: { value: new THREE.Vector3() }, uGas: { value: new THREE.Vector3() },
      }),
      smooth: bake(smoothFragment, { uRaw: { value: this.nebulaRaw.texture } }),
    };
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.materials.background);
    this.quad.frustumCulled = false;
    this.bakeScene.add(this.quad);

    const grainGeometry = new THREE.BufferGeometry();
    grainGeometry.setAttribute('position', new THREE.BufferAttribute(new Uint8Array(GRAIN_STARS * 3), 3));
    this.grain = new THREE.Points(grainGeometry, new THREE.ShaderMaterial({
      vertexShader: grainVertex, fragmentShader: grainFragment, uniforms: { uFace: { value: 0 }, uStarSeed: { value: 1 } },
      depthTest: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
    }));
    this.grain.frustumCulled = false;
    this.grain.visible = false;
    this.bakeScene.add(this.grain);

    // Was am Himmel zu sehen ist
    const domeGeometry = new THREE.BoxGeometry(2, 2, 2);
    const domeUniforms = { uCube: { value: this.cube.texture } };
    const dome = new THREE.Mesh(domeGeometry, new THREE.ShaderMaterial({
      uniforms: domeUniforms, vertexShader: domeVertex, fragmentShader: domeFragment, side: THREE.BackSide, depthWrite: false,
    }));
    dome.frustumCulled = false;
    dome.renderOrder = 10;
    const domeReflected = new THREE.Mesh(domeGeometry, new THREE.ShaderMaterial({
      uniforms: domeUniforms, vertexShader: domeVertex, fragmentShader: domeFragment, side: THREE.BackSide, depthTest: false, depthWrite: false, defines: { LINEAR_OUT: 1 },
    }));
    domeReflected.frustumCulled = false;
    domeReflected.renderOrder = 1;

    const disc = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>, reflected: boolean) => {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
        uniforms, vertexShader: discVertex, fragmentShader, ...additive, side: THREE.DoubleSide, defines: reflected ? { LINEAR_OUT: 1 } : {}, depthTest: !reflected,
      }));
      mesh.frustumCulled = false;
      mesh.renderOrder = reflected ? 2 : 10;
      return mesh;
    };
    this.galaxyDisc = disc(galaxyDiscFragment, this.galaxyUniforms, false);
    this.nebulaDisc = disc(nebulaDiscFragment, this.nebulaUniforms, false);
    this.galaxyDiscReflected = disc(galaxyDiscFragment, this.galaxyUniforms, true);
    this.nebulaDiscReflected = disc(nebulaDiscFragment, this.nebulaUniforms, true);
    this.reflectionScene.add(domeReflected, this.galaxyDiscReflected, this.nebulaDiscReflected);

    // Dasselbe noch einmal fürs Wasser
    const inWater = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) => {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
        uniforms, vertexShader: discVertex, fragmentShader, transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, defines: { MIRROR: 1 }, ...inTheWater,
      }));
      mesh.frustumCulled = false;
      mesh.renderOrder = ORDER_MIRROR;
      return mesh;
    };
    this.galaxyDiscMirrored = inWater(galaxyDiscFragment, this.galaxyUniforms);
    this.nebulaDiscMirrored = inWater(nebulaDiscFragment, this.nebulaUniforms);
    const domeMirrored = new THREE.Mesh(domeGeometry, new THREE.ShaderMaterial({
      uniforms: domeUniforms, vertexShader: domeVertex, fragmentShader: domeFragment, side: THREE.FrontSide, defines: { MIRROR: 1 }, ...inTheWater,
    }));
    domeMirrored.frustumCulled = false;
    domeMirrored.renderOrder = ORDER_MIRROR_DOME;

    this.stars = createStars(new Float32Array(POINT_STARS * 8));

    const meteorPositions: number[] = [];
    const meteorIndex: number[] = [];
    const segments = 16;
    for (let i = 0; i <= segments; i++) {
      meteorPositions.push(i / segments, -1, 0, i / segments, 1, 0);
      if (i < segments) meteorIndex.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const meteorGeometry = new THREE.BufferGeometry();
    meteorGeometry.setAttribute('position', new THREE.Float32BufferAttribute(meteorPositions, 3));
    meteorGeometry.setIndex(meteorIndex);
    this.meteor = new THREE.Mesh(meteorGeometry, new THREE.ShaderMaterial({
      uniforms: this.meteorUniforms, vertexShader: meteorVertex, fragmentShader: meteorFragment, ...additive, side: THREE.DoubleSide,
    }));
    this.meteor.frustumCulled = false;
    this.meteor.renderOrder = 12;
    this.meteor.visible = false;
    this.meteorMirrored = new THREE.Mesh(meteorGeometry, new THREE.ShaderMaterial({
      uniforms: this.meteorUniforms, vertexShader: meteorVertex, fragmentShader: meteorFragment, transparent: true, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide, defines: { MIRROR: 1 }, ...inTheWater,
    }));
    this.meteorMirrored.frustumCulled = false;
    this.meteorMirrored.renderOrder = ORDER_MIRROR;
    this.meteorMirrored.visible = false;

    this.objects = [dome, this.galaxyDisc, this.nebulaDisc, this.stars.points, this.meteor];
    this.mirrored = [domeMirrored, this.galaxyDiscMirrored, this.nebulaDiscMirrored, this.stars.mirrored, this.meteorMirrored];
  }

  get texture(): THREE.Texture {
    return this.reflection.texture;
  }

  get baking(): boolean {
    return this.stepIndex < this.steps.length;
  }

  setVisible(visible: boolean) {
    this.shown = visible;
    for (const o of this.objects) if (o !== this.meteor) o.visible = visible;
    if (!visible) this.meteor.visible = false;
  }

  setMirrorVisible(visible: boolean) {
    this.mirrorShown = visible;
    for (const o of this.mirrored) if (o !== this.meteorMirrored) o.visible = visible;
    this.meteorMirrored.visible = visible && this.meteor.visible;
  }

  /** Legt fest, wie der Himmel dieser Welt aussieht, und plant das Backen. keyAzimuth: Dort steht die Galaxie, von dort kommt das Hauptlicht. */
  begin(seed: number, keyAzimuth: number, keyElevation: number) {
    const r = mulberry(seed ^ 0x51a7c3);
    const shift = new THREE.Vector3(r() * 800 - 400, r() * 800 - 400, r() * 800 - 400);
    const m = this.materials;

    // Das Sternenband zieht schräg über den Himmel, damit keine Richtung leer wirkt
    const band = new THREE.Vector3(r() - 0.5, r() * 0.6 + 0.2, r() - 0.5).normalize();
    (m.background.uniforms.uBand.value as THREE.Vector3).copy(band);
    (m.background.uniforms.uShift.value as THREE.Vector3).copy(shift);
    const warmth = r();
    (m.background.uniforms.uBandTint.value as THREE.Vector3).set(0.0034 + 0.0014 * warmth, 0.004, 0.0066 - 0.002 * warmth);
    (this.grain.material as THREE.ShaderMaterial).uniforms.uStarSeed.value = Math.floor(r() * 4294967295) >>> 0;
    this.stars.setData(pointStars(r));

    // Die Galaxie steht über dem Horizont, nahe der Richtung des Hauptlichts. Der Betrachter steht außerhalb der Scheibe.
    const dir = skyDirection(keyAzimuth + (r() - 0.5) * 0.3, keyElevation + 0.05);
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(dir, -dir.y).normalize();
    const right = new THREE.Vector3().crossVectors(dir, up);
    const positionAngle = (r() - 0.5) * 1.1;
    const u = up.clone().multiplyScalar(Math.cos(positionAngle)).addScaledVector(right, Math.sin(positionAngle));
    const inclination = 0.62 + r() * 0.4;
    const normal = dir.clone().multiplyScalar(Math.cos(inclination)).addScaledVector(u, Math.sin(inclination));
    const b = basisAround(normal, r() * Math.PI * 2);
    const center = dir.clone().multiplyScalar(GALAXY_DISTANCE);
    (m.galaxy.uniforms.uOrigin.value as THREE.Vector3).set(-center.dot(b.e1), -center.dot(b.e2), -center.dot(normal));
    (m.galaxy.uniforms.uShift.value as THREE.Vector3).set(r() * 800 - 400, r() * 800 - 400, r() * 800 - 400);
    m.galaxy.uniforms.uArms.value = r() < 0.6 ? 2 : r() < 0.7 ? 3 : 4;
    m.galaxy.uniforms.uPitch.value = 0.27 + r() * 0.14;
    const colors = GALAXY_COLORS[seed === 1 ? 0 : Math.floor(r() * GALAXY_COLORS.length)];
    (m.galaxy.uniforms.uYoung.value as THREE.Vector3).fromArray(colors.young);
    (m.galaxy.uniforms.uHii.value as THREE.Vector3).fromArray(colors.hii);
    (m.galaxy.uniforms.uKnots.value as THREE.Vector3).fromArray(colors.knots);
    this.turnSpeed = 0.002 + r() * 0.0015;
    this.placeDisc(this.galaxyDisc, [this.galaxyDiscReflected, this.galaxyDiscMirrored], center, b.e1, b.e2, GALAXY_RADIUS * 1.01);

    // Der Nebel steht ungefähr im Rücken der Galaxie
    const nebulaDir = skyDirection(keyAzimuth + Math.PI + (r() - 0.5) * 1.4, 0.35 + r() * 0.45);
    const nb = basisAround(nebulaDir, r() * Math.PI * 2);
    (m.nebula.uniforms.uCenter.value as THREE.Vector3).copy(nebulaDir);
    (m.nebula.uniforms.uRight.value as THREE.Vector3).copy(nb.e1);
    (m.nebula.uniforms.uUp.value as THREE.Vector3).copy(nb.e2);
    (m.nebula.uniforms.uShift.value as THREE.Vector3).set(r() * 800 - 400, r() * 800 - 400, r() * 800 - 400);
    const nebulaColors = NEBULA_COLORS[seed === 1 ? 0 : Math.floor(r() * NEBULA_COLORS.length)];
    (m.nebula.uniforms.uShell.value as THREE.Vector3).fromArray(nebulaColors.shell);
    (m.nebula.uniforms.uGas.value as THREE.Vector3).fromArray(nebulaColors.gas);
    this.placeDisc(this.nebulaDisc, [this.nebulaDiscReflected, this.nebulaDiscMirrored], nebulaDir, nb.e1.clone().multiplyScalar(NEBULA_SPAN), nb.e2.clone().multiplyScalar(NEBULA_SPAN), 1);

    this.steps = this.planSteps();
    this.stepIndex = 0;
    this.bakeStart = performance.now();
    this.finished = new Promise((resolve) => { this.finish = resolve; });
  }

  /** Bringt einen Mittelpunkt und zwei Achsen an den Himmel: als Vieleck, das das Bild umschließt. Die Ecken wären nur teures Schwarz. */
  private placeDisc(mesh: THREE.Mesh, others: THREE.Mesh[], center: THREE.Vector3, e1: THREE.Vector3, e2: THREE.Vector3, reach: number) {
    const corners = 16;
    const position: number[] = [center.x, center.y, center.z];
    const disc: number[] = [0, 0];
    const index: number[] = [];
    // Die Ecken liegen außerhalb des Kreises, die Kanten berühren ihn. Beim Nebel muss das Quadrat ganz hinein.
    const scale = reach * (mesh === this.nebulaDisc ? Math.SQRT2 : 1) / Math.cos(Math.PI / corners);
    for (let i = 0; i < corners; i++) {
      const a = (i / corners) * Math.PI * 2;
      const x = Math.cos(a) * scale, y = Math.sin(a) * scale;
      position.push(center.x + e1.x * x + e2.x * y, center.y + e1.y * x + e2.y * y, center.z + e1.z * x + e2.z * y);
      disc.push(x / reach, y / reach);
      index.push(0, i + 1, ((i + 1) % corners) + 1);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    geometry.setAttribute('aDisc', new THREE.Float32BufferAttribute(disc, 2));
    geometry.setIndex(index);
    mesh.geometry.dispose();
    mesh.geometry = geometry;
    for (const other of others) other.geometry = geometry;
  }

  private planSteps(): (() => void)[] {
    const steps: (() => void)[] = [];
    const m = this.materials;
    for (let face = 0; face < 6; face++) {
      steps.push(() => {
        m.background.uniforms.uFace.value = face;
        this.draw(this.background, m.background, face);
      });
    }
    for (let face = 0; face < 6; face++) {
      steps.push(() => {
        m.upscale.uniforms.uFace.value = face;
        this.draw(this.cube, m.upscale, face);
      });
    }
    for (let face = 0; face < 6; face++) {
      steps.push(() => {
        (this.grain.material as THREE.ShaderMaterial).uniforms.uFace.value = face;
        this.quad.visible = false;
        this.grain.visible = true;
        this.draw(this.cube, null, face, face === 5);
        this.grain.visible = false;
        this.quad.visible = true;
      });
    }
    this.tileSteps(steps, this.galaxyImage, m.galaxy, GALAXY_SIZE, GALAXY_TILES);
    this.tileSteps(steps, this.nebulaRaw, m.nebula, NEBULA_SIZE, NEBULA_TILES, false);
    this.tileSteps(steps, this.nebulaImage, m.smooth, NEBULA_SIZE, 2);
    steps.push(() => {
      this.reflectionCamera.update(this.renderer, this.reflectionScene);
    });
    return steps;
  }

  private tileSteps(steps: (() => void)[], target: THREE.WebGLRenderTarget, material: THREE.ShaderMaterial, size: number, tiles: number, mips = true) {
    const tile = size / tiles;
    for (let j = 0; j < tiles; j++) {
      for (let i = 0; i < tiles; i++) {
        const last = mips && i === tiles - 1 && j === tiles - 1;
        steps.push(() => {
          target.scissorTest = true;
          target.scissor.set(i * tile, j * tile, tile, tile);
          this.draw(target, material, 0, last);
          target.scissorTest = false;
        });
      }
    }
  }

  /** withMips: Das ist der letzte Schritt an diesem Bild, jetzt erst lohnen sich die Detailstufen. */
  private draw(target: THREE.WebGLRenderTarget, material: THREE.ShaderMaterial | null, face: number, withMips = false) {
    const renderer = this.renderer;
    const previous = renderer.getRenderTarget();
    const xrWas = renderer.xr.enabled;
    const clearWas = renderer.autoClear;
    renderer.xr.enabled = false;
    renderer.autoClear = false;
    if (material) this.quad.material = material;
    renderer.setRenderTarget(target, face);
    target.texture.generateMipmaps = withMips;
    renderer.render(this.bakeScene, this.bakeCamera);
    renderer.setRenderTarget(previous);
    renderer.autoClear = clearWas;
    renderer.xr.enabled = xrWas;
  }

  /** Die Karten werden erst gebraucht, wenn man wieder hierher kommt. Bis dahin ist der Speicher anderswo besser aufgehoben. */
  sleep() {
    this.cube.dispose();
    this.reflection.dispose();
    this.galaxyImage.dispose();
    this.nebulaImage.dispose();
  }

  /** Einmal je Bild, solange gebacken wird. Liefert true, wenn nichts mehr zu tun ist. */
  step(): boolean {
    if (this.stepIndex >= this.steps.length) return true;
    this.steps[this.stepIndex++]();
    if (this.stepIndex < this.steps.length) return false;
    trace(`Sky baked: ${Math.round(performance.now() - this.bakeStart)} ms, ${this.steps.length} steps`);
    // Die Zwischenstufen werden erst beim nächsten Weltwechsel wieder gebraucht. Bis dahin ist der Speicher anderswo besser aufgehoben.
    this.background.dispose();
    this.nebulaRaw.dispose();
    this.finish?.();
    this.finish = null;
    return true;
  }

  update(time: number, pixelScale: number) {
    this.stars.update(time, pixelScale);
    this.galaxyUniforms.uTurn.value = time * this.turnSpeed;
    this.galaxyUniforms.uTwist.value = 0.5 * Math.sin(time * 0.012);
    this.nebulaUniforms.uTime.value = time;

    // Hin und wieder eine Sternschnuppe
    if (this.meteorStart < 0 && time > this.nextMeteor && this.shown) {
      this.meteorStart = time;
      const a = Math.random() * Math.PI * 2;
      const from = skyDirection(a, 0.3 + Math.random() * 0.8);
      const to = skyDirection(a + (Math.random() < 0.5 ? -1 : 1) * (0.25 + Math.random() * 0.35), Math.max(0.08, from.y - 0.25 - Math.random() * 0.3));
      this.meteorUniforms.uFrom.value.copy(from);
      this.meteorUniforms.uTo.value.copy(to);
    }
    if (this.meteorStart >= 0) {
      const p = (time - this.meteorStart) / 0.85;
      this.meteorUniforms.uProgress.value = p;
      this.meteor.visible = p < 1 && this.shown;
      this.meteorMirrored.visible = this.meteor.visible && this.mirrorShown;
      if (p >= 1) {
        this.meteorStart = -1;
        this.nextMeteor = time + 10 + Math.random() * 35;
      }
    }
  }
}
