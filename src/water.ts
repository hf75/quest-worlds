import * as THREE from 'three';
import { clipHeight } from './clipShader';

// Stilles Wasser. Es geht nur um den Spiegel: Wellen gibt es keine, und der Grund bleibt unsichtbar.
//
// Eine Würfelkarte könnte den Himmel nur unscharf spiegeln, und er bewegt sich ja. Darum wird er noch einmal gezeichnet, an der Waagerechten
// gespiegelt und nur dort, wo Wasser zu sehen ist: Erst merkt sich der Stencil-Puffer diese Pixel, dann kommt der gespiegelte Himmel hinein,
// und zuletzt legt sich das Wasser selbst darüber. So kostet es nur auf den Pixeln etwas, die wirklich Wasser zeigen.
const MAX_POOLS = 160;
const CORNERS = 32;

/** Materialeinstellungen für alles, was nur im Wasser zu sehen sein soll. */
export const inTheWater = {
  stencilWrite: true,
  stencilFunc: THREE.EqualStencilFunc,
  stencilRef: 1,
  stencilWriteMask: 0,
  depthTest: false,
  depthWrite: false,
};

// Reihenfolge beim Zeichnen: Boden, Stencil, gespiegelte Kuppel, normale Kuppel. Danach die durchscheinenden Dinge:
// erst alles Gespiegelte, dann das Wasser, und danach erst, was darüber liegt.
export const ORDER_MIRROR_DOME = 6;
export const ORDER_MIRROR = 2;
const ORDER_MARK = 5;
const ORDER_SURFACE = 5;

const vertexShader = `
  attribute vec4 aPool; // x, Wasserspiegel, z, Radius
  uniform vec3 uHead;
  uniform float uInvRadius;
  varying vec3 vPos;

  void main() {
    vec2 w = aPool.xz + position.xz * aPool.w;
    vec2 rel = w - uHead.xz;
    vec3 p = vec3(w.x, aPool.y - dot(rel, rel) * 0.5 * uInvRadius, w.y);
    vPos = p;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const markFragment = `
  void main() {
    gl_FragColor = vec4(0.0);
  }
`;

const surfaceFragment = `
  uniform vec3 uHead;
  uniform float uInvRadius;
  ${clipHeight}
  varying vec3 vPos;

  void main() {
    vec3 V = normalize(cameraPosition - vPos);
    // Echtes Wasser spiegelt von oben fast nichts. Hier geht es aber um den Himmel, also ist es schwarz und poliert wie Obsidian.
    float facing = 1.0 - max(V.y, 0.0);
    float mirror = 0.68 + 0.32 * facing * facing;

    // Gelände im Spiegel: Dem gespiegelten Blick folgen, bis er an einen Hang stößt. Dort sieht man keinen Himmel, sondern den Fels als dunkle Form.
    vec3 R = vec3(-V.x, V.y, -V.z);
    float blocked = 0.0;
    float t = 1.5;
    for (int i = 0; i < 7; i++) {
      vec3 p = vPos + R * t;
      vec2 rel = p.xz - uHead.xz;
      float h = clipHeightAt(p.xz) - dot(rel, rel) * 0.5 * uInvRadius;
      blocked = max(blocked, smoothstep(0.0, 0.1 + 0.03 * t, h - p.y));
      t *= 2.1;
    }

    vec3 deep = vec3(0.010, 0.014, 0.022);
    vec3 rock = vec3(0.115, 0.12, 0.135);
    gl_FragColor = vec4((1.0 - mirror) * deep + mirror * blocked * rock, 1.0 - mirror * (1.0 - blocked));
  }
`;

export class Water {
  readonly objects: THREE.Object3D[];
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly pools = new THREE.InstancedBufferAttribute(new Float32Array(MAX_POOLS * 4), 4);
  private list: Float32Array = new Float32Array(0);
  private readonly mark: THREE.Mesh;
  private readonly surface: THREE.Mesh;

  constructor(terrainUniforms: Record<string, THREE.IUniform>) {
    const position = [0, 0, 0];
    const index: number[] = [];
    for (let i = 0; i < CORNERS; i++) {
      const a = (i / CORNERS) * Math.PI * 2;
      position.push(Math.cos(a), 0, Math.sin(a));
      // Nach oben gewandt: Wer von unten käme, sähe nichts
      index.push(0, ((i + 1) % CORNERS) + 1, i + 1);
    }
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    this.geometry.setIndex(index);
    this.pools.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aPool', this.pools);
    this.geometry.instanceCount = 0;

    this.mark = new THREE.Mesh(this.geometry, new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: markFragment,
      uniforms: { uHead: terrainUniforms.uHead, uInvRadius: terrainUniforms.uInvRadius },
      colorWrite: false,
      depthWrite: false,
      stencilWrite: true,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilRef: 1,
      stencilZPass: THREE.ReplaceStencilOp,
    }));
    this.mark.frustumCulled = false;
    this.mark.renderOrder = ORDER_MARK;

    this.surface = new THREE.Mesh(this.geometry, new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: surfaceFragment,
      uniforms: terrainUniforms,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthWrite: true,
    }));
    this.surface.frustumCulled = false;
    this.surface.renderOrder = ORDER_SURFACE;
    this.objects = [this.mark, this.surface];
  }

  /** Je Becken vier Zahlen: x, Wasserspiegel, z, Radius. */
  set(list: Float32Array) {
    const count = Math.min(MAX_POOLS, list.length / 4);
    this.list = list;
    (this.pools.array as Float32Array).set(list.subarray(0, count * 4));
    this.pools.needsUpdate = true;
    this.geometry.instanceCount = count;
  }

  get active(): boolean {
    return this.geometry.instanceCount > 0;
  }

  setVisible(visible: boolean) {
    this.mark.visible = this.surface.visible = visible;
  }

  /** Der Spiegel des Beckens nächst diesem Punkt, wenn eines in der Nähe ist. */
  nearestLevel(x: number, z: number, within: number): number | null {
    let best = within, level: number | null = null;
    for (let o = 0; o < this.list.length; o += 4) {
      const d = Math.hypot(this.list[o] - x, this.list[o + 2] - z) - this.list[o + 3];
      if (d < best) {
        best = d;
        level = this.list[o + 1];
      }
    }
    return level;
  }
}
