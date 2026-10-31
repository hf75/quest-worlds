import * as THREE from 'three';
import { inTheWater, ORDER_MIRROR } from './water';

const STAR_STRIDE = 8; // x, y, z, helligkeit, r, g, b, phase

export interface Sky {
  /** Für die Spiegelung im Schiefer */
  texture: THREE.Texture;
  /** Die Detailstufe, die in dieser Karte dem breiten Schein der Spiegelung entspricht */
  skyLod: number;
  objects: THREE.Object3D[];
  /** Derselbe Himmel noch einmal, an der Waagerechten gespiegelt und nur im Wasser zu sehen */
  mirrored: THREE.Object3D[];
  setVisible(visible: boolean): void;
  setMirrorVisible(visible: boolean): void;
  update(timeSeconds: number, pixelScale: number): void;
}

/** Die hellen Einzelsterne: Sie bleiben gestochen scharf und können funkeln. Je Stern acht Zahlen, siehe STAR_STRIDE. */
export function createStars(raw: Float32Array) {
  const count = raw.length / STAR_STRIDE;
  const position = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  const info = new Float32Array(count * 2);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
  geometry.setAttribute('aInfo', new THREE.BufferAttribute(info, 2));
  const setData = (next: Float32Array) => {
    for (let i = 0; i < count; i++) {
      const o = i * STAR_STRIDE;
      position.set(next.subarray(o, o + 3), i * 3);
      color.set(next.subarray(o + 4, o + 7), i * 3);
      info[i * 2] = next[o + 3];
      info[i * 2 + 1] = next[o + 7];
    }
    for (const name of ['position', 'aColor', 'aInfo']) geometry.getAttribute(name).needsUpdate = true;
  };
  setData(raw);

  const starUniforms = { uTime: { value: 0 }, uPixelScale: { value: 1 } };
  const material = (extra: THREE.ShaderMaterialParameters) => new THREE.ShaderMaterial({
      uniforms: starUniforms,
      vertexShader: `
        attribute vec3 aColor;
        attribute vec2 aInfo;
        uniform float uTime;
        uniform float uPixelScale;
        varying vec3 vColor;
        varying float vRound;
        void main() {
          float flux = aInfo.x;
          // Tief am Horizont blickt man durch mehr Atmosphäre, dort funkeln die Sterne stärker
          float low = 1.0 - smoothstep(0.0, 0.45, position.y);
          float wave = sin(uTime * (1.3 + aInfo.y * 2.6) + aInfo.y * 91.0) * sin(uTime * 0.7 + aInfo.y * 37.0);
          float tw = 1.0 + wave * (0.06 + 0.26 * low);
          // Die meisten Sterne sind schwach, nur wenige stechen heraus. Das erst erzeugt Tiefe.
          vColor = aColor * min(0.10 + 0.30 * sqrt(flux), 1.6) * tw;
          vec3 q = position;
          #ifdef MIRROR
          q.y = -q.y;
          #endif
          vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * q, 1.0);
          gl_Position = p.xyww;
          // Ein Punkt ist ein Quadrat. Reicht der Schein bis an dessen Rand, wird der Stern eckig. Bei den kleinen fällt das nicht auf,
          // die großen bekommen mehr Platz, damit er vorher rund auslaufen kann.
          float size = clamp(1.45 + 0.85 * sqrt(flux), 1.45, 8.5) * uPixelScale;
          vRound = smoothstep(2.0, 4.5, size);
          gl_PointSize = size * (1.0 + 0.8 * vRound);
        }`,
      fragmentShader: `
        varying vec3 vColor;
        varying float vRound;
        void main() {
          vec2 q = gl_PointCoord * 2.0 - 1.0;
          float d2 = dot(q, q);
          float scale = 1.0 + 0.8 * vRound;
          float core = exp(-1.7 * scale * scale * d2);
          float fade = max(1.0 - d2, 0.0);
          fade *= fade;
          gl_FragColor = vec4(vColor * mix(core, core * fade + 0.07 * fade * fade, vRound), 1.0);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      ...extra,
    });
  const points = new THREE.Points(geometry, material({}));
  points.frustumCulled = false;
  points.renderOrder = 11;
  const mirrored = new THREE.Points(geometry, material({ defines: { MIRROR: 1 }, ...inTheWater }));
  mirrored.frustumCulled = false;
  mirrored.renderOrder = ORDER_MIRROR;

  return {
    points,
    mirrored,
    setData,
    update(time: number, pixelScale: number) {
      starUniforms.uTime.value = time;
      starUniforms.uPixelScale.value = pixelScale;
    },
  };
}
