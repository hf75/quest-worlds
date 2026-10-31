import * as THREE from 'three';
import { clipNormalFragment } from './clipShader';
import type { CaveChunk, CaveDrop } from './caveWorker';
import { hazeVertex, lightingFunctions, lightingUniforms, setPlanetDefine } from './shading';
import { STRATA_PERIOD, STRATA_SAMPLES } from './world';

// Tief im Berg zählt nur, was in der Nähe ist. Die Würfel des Mundlochs dagegen sieht man schon von Weitem.
const TUBE_VISIBLE = 130;

const vertexShader = `
  attribute vec2 aLight;
  uniform vec3 uHead;
  uniform float uInvRadius;
  ${hazeVertex}
  varying vec3 vPos;
  varying vec3 vPlain;
  varying vec3 vNormal;
  varying vec2 vLight;

  void main() {
    vPlain = position;
    vNormal = normal;
    vLight = aLight;
    vec2 rel = position.xz - uHead.xz;
    vec3 p = vec3(position.x, position.y - dot(rel, rel) * 0.5 * uInvRadius, position.z);
    vPos = p;
    #ifdef MARS
    hazeAt(p);
    #endif
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = `
  ${lightingUniforms}
  uniform vec3 uHead;
  uniform sampler2D uMesoNR;
  uniform sampler2D uMesoAlbedo;
  uniform sampler2D uDetail;
  uniform sampler2D uStrata;
  uniform vec2 uDip;
  uniform float uMesoSize;
  uniform float uDetailSize;
  uniform float uMesoPixels;
  uniform float uDetailPixels;
  ${clipNormalFragment}
  varying vec3 vPos;
  varying vec3 vPlain;
  varying vec3 vNormal;
  varying vec2 vLight;
  ${lightingFunctions}

  vec2 slopeOf(vec2 enc) {
    vec2 n = enc * 2.0 - 1.0;
    return -n / sqrt(max(1.0 - dot(n, n), 0.02));
  }

  // Die Felswand kommt mit bis zu drei Projektionen: eine je Achse, weich überblendet, nur wo sie wirklich zählt.
  // Hart umgeschaltet stünden an jedem Wechsel helle Flächen mit scharfem Rand.
  void plates(vec2 uv, vec3 T, vec3 B, float stretch, float lod, float weight, inout vec3 tilt, inout vec3 albedo, inout float rough, inout float grain, inout float wander) {
    vec2 mUv = uv * vec2(stretch, 1.0) / uMesoSize;
    vec4 nr = textureLod(uMesoNR, mUv, lod);
    vec4 al = textureLod(uMesoAlbedo, mUv, lod - 1.0);
    vec2 sm = slopeOf(nr.xy);
    tilt += weight * (-T * sm.x * stretch - B * sm.y * 0.7);
    albedo += weight * al.rgb;
    rough += weight * nr.a;
    grain += weight * nr.b;
    wander += weight * (nr.x - 0.5);
  }

  void fine(vec2 uv, vec3 T, vec3 B, float lod, float weight, inout vec3 tilt, inout vec3 sum) {
    vec4 de = textureLod(uDetail, uv / uDetailSize, lod);
    vec2 sd = slopeOf(de.xy);
    tilt += weight * (-T * sd.x - B * sd.y);
    sum += weight * vec3(de.b, de.a, 0.0);
  }

  void main() {
    vec3 n = normalize(vNormal);
    vec3 a = abs(n);
    vec3 w = a * a;
    w = w * w * w;
    w /= w.x + w.y + w.z;
    w = step(0.04, w) * w;
    w /= w.x + w.y + w.z;

    // Die Detailstufe aus dem Weltmaß: An den Achsenwechseln springen die Koordinaten, die Pixelgröße aber nicht
    float pixel = max(length(dFdx(vPlain)), length(dFdy(vPlain)));
    float lodM = log2(max(pixel * uMesoPixels, 0.0001)) - 0.4;
    float lodD = log2(max(pixel * uDetailPixels, 0.0001)) - 0.4;
    const vec3 X = vec3(1.0, 0.0, 0.0), Y = vec3(0.0, 1.0, 0.0), Z = vec3(0.0, 0.0, 1.0);

    vec3 tilt = vec3(0.0), albedo = vec3(0.0), detail = vec3(0.0);
    float rough = 0.0, grain = 0.0, wander = 0.0;
    if (w.y > 0.0) plates(vPlain.xz, X, Z, 1.0, lodM, w.y, tilt, albedo, rough, grain, wander);
    if (w.x > 0.0) plates(vPlain.zy, Z, Y, 0.32, lodM, w.x, tilt, albedo, rough, grain, wander);
    if (w.z > 0.0) plates(vPlain.xy, X, Y, 0.32, lodM, w.z, tilt, albedo, rough, grain, wander);

    float layer = (vPlain.y + dot(uDip, vPlain.xz)) / ${STRATA_PERIOD.toFixed(1)};
    float layerStep = max(abs(dFdx(layer)), abs(dFdy(layer))) * ${STRATA_SAMPLES.toFixed(1)};
    vec4 strata = textureLod(uStrata, vec2(layer + wander * 3.0 / ${STRATA_PERIOD.toFixed(1)}, 0.5), log2(max(layerStep, 0.001)));

    vec2 shift = vec2(strata.g * 53.0, 0.0);
    if (w.y > 0.0) fine(vPlain.xz + shift, X, Z, lodD, w.y, tilt, detail);
    if (w.x > 0.0) fine(vPlain.zy + shift, Z, Y, lodD, w.x, tilt, detail);
    if (w.z > 0.0) fine(vPlain.xy + shift, X, Y, lodD, w.z, tilt, detail);

    float upright = 1.0 - a.y * a.y;
    float broken = smoothstep(0.12, 0.42, detail.x);
    float ledge = (strata.r * 2.0 - 1.0) * broken * upright;
    vec3 N = normalize(n + tilt * 0.85 + vec3(0.0, ledge * 0.85, 0.0));

    float tone = 0.62 + 0.76 * strata.g;
    albedo *= (0.2 + 1.6 * detail.x) * mix(1.0, tone, 0.45 + 0.55 * upright) * mix(vec3(0.92, 1.0, 1.1), vec3(1.14, 1.0, 0.88), strata.a);
    rough = clamp(mix(detail.y, rough, 0.55), 0.08, 1.0);
    grain *= (0.55 + 0.9 * detail.x) * (1.0 - 0.75 * strata.b * broken * upright);

    // Innen ist es dunkel, soweit das Tageslicht nicht reicht. Am Mundloch gilt dasselbe Licht wie auf dem Boden daneben.
    float day = vLight.y;
    float ao = grain * vLight.x * (0.012 + 0.988 * day);
    float shadow = 0.0;
    if (day > 0.02) {
      vec4 broadNR = clipNormalBroad(vPlain.xz);
      vec2 broad = broadNR.xy * 2.0 - 1.0;
      vec3 broadN = vec3(broad.x, sqrt(max(1.0 - dot(broad, broad), 0.0)), broad.y);
      ao *= mix(1.0, 0.38 + 0.62 * broadNR.b, day);
      shadow = broadNR.a * smoothstep(-0.2, 0.16, dot(broadN, uKeyDir)) * day * day;
    }

    vec3 V = normalize(cameraPosition - vPos);
    gl_FragColor = vec4(toDisplay(shadeSurface(vPos, N, V, albedo, rough, ao, shadow, 0.5, mix(0.55, 1.0, ao))), 1.0);
  }
`;

interface Chunk {
  mesh: THREE.Mesh;
  tube: boolean;
}

export class CaveMeshes {
  readonly group = new THREE.Group();
  private readonly material: THREE.ShaderMaterial;
  private readonly chunks = new Map<string, Chunk>();

  constructor(uniforms: Record<string, THREE.IUniform>) {
    this.material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms });
  }

  setPlanet(mars: boolean) {
    setPlanetDefine(this.material, mars);
  }

  reset() {
    for (const c of this.chunks.values()) {
      c.mesh.geometry.dispose();
      this.group.remove(c.mesh);
    }
    this.chunks.clear();
  }

  apply(m: CaveChunk | CaveDrop) {
    if (m.type === 'drop') {
      const c = this.chunks.get(m.key);
      if (c) {
        c.mesh.geometry.dispose();
        this.group.remove(c.mesh);
        this.chunks.delete(m.key);
      }
    } else {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 4, true));
      g.setAttribute('aLight', new THREE.BufferAttribute(m.light, 2, true));
      g.setIndex(new THREE.BufferAttribute(m.index, 1));
      // Der Radius bekommt einen Zuschlag: Der Shader krümmt den Boden noch vom Betrachter weg
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(...m.center), m.radius + 25);
      const mesh = new THREE.Mesh(g, this.material);
      mesh.matrixAutoUpdate = false;
      mesh.userData.center = m.center;
      this.group.add(mesh);
      this.chunks.set(m.key, { mesh, tube: m.tube });
    }
  }

  update(head: THREE.Vector3) {
    for (const c of this.chunks.values()) {
      if (!c.tube) continue;
      const m = c.mesh.userData.center as [number, number, number];
      c.mesh.visible = Math.hypot(m[0] - head.x, m[1] - head.y, m[2] - head.z) < TUBE_VISIBLE;
    }
  }

  get count() {
    return this.chunks.size;
  }
}
