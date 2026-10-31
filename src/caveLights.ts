import * as THREE from 'three';

// Aus jedem Mundloch steigt eine schwache Lichtfahne auf. So findet man die Höhlen, ohne dass ein Symbol über der Welt schwebt: Sie
// überragt die Schluchtränder, ist von Weitem zu sehen und vergeht, sobald man dort ist. Je Fahne ein schmaler Streifen,
// der sich um die Senkrechte zum Betrachter dreht. Das kostet kaum Pixel und ist auch durch das Grün von allem anderen zu unterscheiden.
const MAX_LIGHTS = 49;
const SEGMENTS = 20;

const vertexShader = `
  attribute vec4 aMouth; // Fuß der Fahne, Zufall
  uniform vec3 uHead;
  uniform float uInvRadius;
  uniform float uTime;
  uniform float uPixel;
  uniform vec3 uPlume;
  varying float vAcross;
  varying vec3 vColor;

  void main() {
    float s = position.y;
    float phase = aMouth.w * 6.2832;
    // Sie schwankt, unten kaum und oben weit, wie aufsteigender Dunst
    float sway = s * s;
    vec3 w = aMouth.xyz + vec3(
      (sin(s * 4.0 + uTime * 0.13 + phase) * 11.0 + sin(s * 11.0 - uTime * 0.21 + phase * 2.0) * 3.0) * sway,
      s * 230.0,
      (cos(s * 3.3 - uTime * 0.11 + phase) * 11.0 + cos(s * 9.0 + uTime * 0.17 + phase * 3.0) * 3.0) * sway
    );
    vec2 rel = w.xz - uHead.xz;
    w.y -= dot(rel, rel) * 0.5 * uInvRadius;

    vec3 toEye = cameraPosition - w;
    float dist = length(toEye);
    vec3 across = normalize(vec3(toEye.z, 0.0, -toEye.x) + vec3(1e-5, 0.0, 0.0));
    // Mit der Entfernung wird sie breiter, als sie ist: Sonst bliebe aus einem Kilometer nur ein Strich, den niemand bemerkt.
    // Und nie schmaler als ein gutes Pixel, dann aber entsprechend schwächer: Sonst flimmert sie.
    float wide = mix(2.8, 1.3, s) * (1.0 + dist / 220.0);
    float half_ = max(wide, 0.9 * uPixel * dist);
    w += across * position.x * half_;
    gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
    vAcross = position.x;

    float along = smoothstep(0.0, 0.05, s) * (1.0 - smoothstep(0.45, 1.0, s));
    // Langsam steigende Wellen: Bewegung fällt aus dem Augenwinkel auf, auch wenn die Fahne schwach ist
    float rising = 0.7 + 0.3 * sin(s * 24.0 - uTime * 0.8 + phase);
    float reach = smoothstep(16.0, 70.0, dist) * (1.0 - smoothstep(2200.0, 3000.0, dist));
    vColor = uPlume * along * rising * reach * (wide / half_);
  }
`;

const fragmentShader = `
  varying float vAcross;
  varying vec3 vColor;
  void main() {
    float a = 1.0 - abs(vAcross);
    // Dither gegen Stufen im schwachen Schein: auf dem LCD wären sie sonst deutlich zu sehen
    float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    gl_FragColor = vec4(vColor * a * a + (n - 0.5) / 255.0, 1.0);
  }
`;

export class CaveLights {
  readonly mesh: THREE.Mesh;
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly mouths = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LIGHTS * 4), 4);
  private readonly time = { value: 0 };
  private readonly pixel = { value: 0.001 };
  private readonly plume = { value: new THREE.Color(0.272, 0.688, 0.576) };

  constructor(terrainUniforms: Record<string, THREE.IUniform>) {
    const position = new Float32Array((SEGMENTS + 1) * 2 * 3);
    const index: number[] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      position.set([-1, i / SEGMENTS, 0, 1, i / SEGMENTS, 0], i * 6);
      if (i < SEGMENTS) {
        const v = i * 2;
        index.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      }
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    this.geometry.setIndex(index);
    this.mouths.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aMouth', this.mouths);
    this.geometry.instanceCount = 0;
    this.mesh = new THREE.Mesh(
      this.geometry,
      new THREE.ShaderMaterial({
        uniforms: { uHead: terrainUniforms.uHead, uInvRadius: terrainUniforms.uInvRadius, uTime: this.time, uPixel: this.pixel, uPlume: this.plume },
        vertexShader,
        fragmentShader,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
  }

  setColor(color: readonly [number, number, number]) {
    this.plume.value.setRGB(color[0], color[1], color[2]);
  }

  /** Je Mundloch vier Zahlen: x, y, z und ein Zufallswert. */
  set(list: Float32Array) {
    const count = Math.min(MAX_LIGHTS, list.length / 4);
    (this.mouths.array as Float32Array).set(list.subarray(0, count * 4));
    this.mouths.needsUpdate = true;
    this.geometry.instanceCount = count;
  }

  update(time: number, pixelAngle: number) {
    this.time.value = time;
    this.pixel.value = pixelAngle;
  }
}
