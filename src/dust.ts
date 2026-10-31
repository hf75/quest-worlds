import * as THREE from 'three';
import type { World } from './world';

// Die dünne Luft des Mars trägt Staub. Nah am Kopf treiben einzelne Körner vorbei: Das gibt dem leeren Raum Tiefe, in VR sieht man, dass sie in
// verschiedenen Entfernungen schweben. Und in der Ferne wandern Staubteufel über die Ebene, die einzigen Bewegungen weit und breit.
const MOTES = 420;
const MOTE_BOX = 14;
const DEVILS = 3;
const DEVIL_SEGMENTS = 22;
const DEVIL_LIFE = 95;

const moteVertex = `
  attribute float aSeed;
  uniform vec3 uHead;
  uniform float uTime;
  uniform float uPixelScale;
  varying float vLight;
  void main() {
    // Die Körner treiben mit dem Wind und tauchen hinter dem Kopf wieder auf: Eine Schachtel, die immer mitwandert
    vec3 drift = vec3(0.1, 0.012 * sin(uTime * 0.13 + aSeed * 40.0), 0.42) * uTime * (0.6 + 0.8 * aSeed);
    drift.x += 0.35 * sin(uTime * 0.21 + aSeed * 70.0);
    vec3 p = mod(position + drift - uHead + ${(MOTE_BOX / 2).toFixed(1)}, ${MOTE_BOX.toFixed(1)}) - ${(MOTE_BOX / 2).toFixed(1)};
    float dist = length(p);
    vec4 view = viewMatrix * vec4(p + uHead, 1.0);
    gl_Position = projectionMatrix * view;
    gl_PointSize = clamp(uPixelScale * 7.0 / max(-view.z, 0.2), 1.0, 5.0);
    // Am Rand der Schachtel und direkt vor dem Auge blenden sie aus, sonst sähe man sie springen
    vLight = smoothstep(${(MOTE_BOX / 2).toFixed(1)}, ${(MOTE_BOX * 0.3).toFixed(1)}, dist) * smoothstep(0.2, 0.9, dist) * (0.35 + 0.65 * fract(aSeed * 17.0));
  }
`;

const moteFragment = `
  varying float vLight;
  void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float a = max(1.0 - dot(q, q), 0.0);
    gl_FragColor = vec4(vec3(0.5, 0.36, 0.26) * a * vLight * 0.55, 1.0);
  }
`;

const devilVertex = `
  attribute vec4 aDevil; // x, Boden, z, Stärke
  attribute float aPhase;
  uniform float uTime;
  uniform float uInvRadius;
  uniform vec3 uHead;
  varying vec2 vAt;
  varying float vAlpha;
  void main() {
    float s = position.y;
    float tall = 150.0 + 170.0 * fract(aPhase * 7.3);
    // Der Rüssel schwankt, oben weiter als unten
    vec3 w = aDevil.xyz + vec3(
      sin(s * 3.1 + uTime * 0.37 + aPhase * 9.0) * 16.0 * s * s + sin(s * 11.0 - uTime * 0.9 + aPhase) * 2.2 * s,
      s * tall,
      cos(s * 2.7 - uTime * 0.31 + aPhase * 5.0) * 16.0 * s * s
    );
    vec2 rel = w.xz - uHead.xz;
    w.y -= dot(rel, rel) * 0.5 * uInvRadius;
    vec3 toEye = cameraPosition - w;
    vec3 across = normalize(vec3(toEye.z, 0.0, -toEye.x) + vec3(1e-5, 0.0, 0.0));
    w += across * position.x * (8.0 + 46.0 * s * sqrt(s));
    gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
    vAt = vec2(position.x, s);
    vAlpha = aDevil.w * exp(-length(toEye) / 1500.0);
  }
`;

const devilFragment = `
  uniform float uTime;
  varying vec2 vAt;
  varying float vAlpha;
  void main() {
    float s = vAt.y;
    // Streifen winden sich um den Rüssel nach oben
    float swirl = 0.72 + 0.28 * sin(s * 42.0 - uTime * 2.6 + vAt.x * 3.4) * sin(s * 17.0 + vAt.x * 5.0 + uTime * 0.7);
    float edge = 1.0 - vAt.x * vAt.x;
    float a = edge * edge * swirl * smoothstep(0.0, 0.05, s) * (1.0 - smoothstep(0.42, 1.0, s)) * vAlpha;
    gl_FragColor = vec4(0.5, 0.345, 0.24, a * 0.9);
  }
`;

interface Devil {
  x: number;
  z: number;
  born: number;
  windX: number;
  windZ: number;
}

export class Dust {
  readonly objects: THREE.Object3D[];
  private readonly moteUniforms: Record<string, THREE.IUniform>;
  private readonly devilUniforms: Record<string, THREE.IUniform>;
  private readonly motes: THREE.Points;
  private readonly devilMesh: THREE.Mesh;
  private readonly devilData = new THREE.InstancedBufferAttribute(new Float32Array(DEVILS * 4), 4);
  private readonly devils: (Devil | null)[] = Array.from({ length: DEVILS }, () => null);
  private nextDevil = 8;
  private active = false;

  constructor(terrainUniforms: Record<string, THREE.IUniform>) {
    const position = new Float32Array(MOTES * 3);
    const seeds = new Float32Array(MOTES);
    for (let i = 0; i < MOTES; i++) {
      position.set([Math.random() * MOTE_BOX, Math.random() * MOTE_BOX, Math.random() * MOTE_BOX], i * 3);
      seeds[i] = Math.random();
    }
    const moteGeometry = new THREE.BufferGeometry();
    moteGeometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    moteGeometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    this.moteUniforms = { uHead: terrainUniforms.uHead, uTime: { value: 0 }, uPixelScale: { value: 1 } };
    this.motes = new THREE.Points(moteGeometry, new THREE.ShaderMaterial({
      uniforms: this.moteUniforms, vertexShader: moteVertex, fragmentShader: moteFragment, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.motes.frustumCulled = false;
    this.motes.renderOrder = 13;

    const ribbon = new Float32Array((DEVIL_SEGMENTS + 1) * 2 * 3);
    const index: number[] = [];
    for (let i = 0; i <= DEVIL_SEGMENTS; i++) {
      ribbon.set([-1, i / DEVIL_SEGMENTS, 0, 1, i / DEVIL_SEGMENTS, 0], i * 6);
      if (i < DEVIL_SEGMENTS) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const devilGeometry = new THREE.InstancedBufferGeometry();
    devilGeometry.setAttribute('position', new THREE.BufferAttribute(ribbon, 3));
    devilGeometry.setIndex(index);
    this.devilData.setUsage(THREE.DynamicDrawUsage);
    devilGeometry.setAttribute('aDevil', this.devilData);
    devilGeometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(Float32Array.from({ length: DEVILS }, () => Math.random()), 1));
    devilGeometry.instanceCount = DEVILS;
    this.devilUniforms = { uHead: terrainUniforms.uHead, uInvRadius: terrainUniforms.uInvRadius, uTime: this.moteUniforms.uTime };
    this.devilMesh = new THREE.Mesh(devilGeometry, new THREE.ShaderMaterial({
      uniforms: this.devilUniforms, vertexShader: devilVertex, fragmentShader: devilFragment, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.devilMesh.frustumCulled = false;
    this.devilMesh.renderOrder = 12;
    this.objects = [this.devilMesh, this.motes];
    this.setActive(false);
  }

  setActive(active: boolean) {
    this.active = active;
    this.motes.visible = this.devilMesh.visible = active;
    if (!active) this.devils.fill(null);
  }

  update(time: number, pixelScale: number, head: THREE.Vector3, world: World, deep: boolean) {
    if (!this.active) return;
    this.motes.visible = this.devilMesh.visible = !deep;
    this.moteUniforms.uTime.value = time;
    this.moteUniforms.uPixelScale.value = pixelScale;
    const data = this.devilData.array as Float32Array;
    for (let i = 0; i < DEVILS; i++) {
      let devil = this.devils[i];
      if (!devil && time > this.nextDevil) {
        // Einer nach dem anderen, in sicherer Entfernung: Aus der Nähe wäre die Täuschung dahin
        this.nextDevil = time + 12 + Math.random() * 30;
        const a = Math.random() * Math.PI * 2, r = 420 + Math.random() * 1000;
        devil = { x: head.x + Math.cos(a) * r, z: head.z + Math.sin(a) * r, born: time, windX: (Math.random() - 0.5) * 4, windZ: 3 + Math.random() * 4 };
        this.devils[i] = devil;
      }
      let strength = 0;
      if (devil) {
        const age = time - devil.born;
        const x = devil.x + devil.windX * age, z = devil.z + devil.windZ * age;
        strength = THREE.MathUtils.smoothstep(age, 0, 14) * (1 - THREE.MathUtils.smoothstep(age, DEVIL_LIFE - 18, DEVIL_LIFE));
        data.set([x, world.height(x, z, undefined, 8) - 1, z, strength], i * 4);
        if (age > DEVIL_LIFE) this.devils[i] = null;
      } else data[i * 4 + 3] = 0;
    }
    this.devilData.needsUpdate = true;
  }
}
