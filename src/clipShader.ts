import { CLIP_N, CLIP_RES } from './clips';

// Die Übergänge hängen am Kopf, nicht am Fenster: Das Fenster springt in Schritten, der Kopf bewegt sich stetig. So rückt
// auch der Übergang stetig mit, und nichts springt sichtbar.
const f = (v: number) => v.toFixed(1);
const half = (level: number) => (CLIP_N / 2 - 16) * CLIP_RES[level];
const BLEND = [0, 1, 2].map((l) => ({ from: f(half(l) * 0.68), to: f(half(l) * 0.9) }));
/** Ab hier hat das feine Fenster nichts mehr beizutragen */
export const CLIP_BROAD_ONLY = half(1) * 0.9;

function pick(read: (level: number) => string): string {
  return `
    vec2 clipQ = abs(w - uHead.xz);
    float clipD = max(clipQ.x, clipQ.y);
    if (clipD < ${BLEND[0].from}) return ${read(0)};
    if (clipD < ${BLEND[0].to}) return mix(${read(0)}, ${read(1)}, smoothstep(${BLEND[0].from}, ${BLEND[0].to}, clipD));
    if (clipD < ${BLEND[1].from}) return ${read(1)};
    if (clipD < ${BLEND[1].to}) return mix(${read(1)}, ${read(2)}, smoothstep(${BLEND[1].from}, ${BLEND[1].to}, clipD));
    if (clipD < ${BLEND[2].from}) return ${read(2)};
    if (clipD < ${BLEND[2].to}) return mix(${read(2)}, ${read(3)}, smoothstep(${BLEND[2].from}, ${BLEND[2].to}, clipD));
    return ${read(3)};
  `;
}

const uv = (level: number) => `(w / ${CLIP_RES[level].toFixed(1)} + 0.5) / ${CLIP_N.toFixed(1)}`;

/**
 * Die Schieferplatten sind eine Kachel von 256 m. Damit sie sich nicht sichtbar wiederholen, zeigt jede Zelle von 128 m
 * einen anderen Ausschnitt, mit schmaler Überblendung an den welligen Rändern. Die Zellen sind schachbrettartig auf zwei
 * Zugriffe A und B verteilt: Über eine Zellgrenze hinweg ändert sich so keine Koordinate, und mitten in der Zelle reicht einer.
 */
export const MESO_CELL = 128;
export const MESO_SHIFTS = 8;
export const mesoCells = `
  uniform vec2 uMesoShift[${MESO_SHIFTS * MESO_SHIFTS}];
  void mesoCells(vec2 w, out vec2 shiftA, out vec2 shiftB, out float weightB) {
    vec2 q = w / ${MESO_CELL.toFixed(1)} + 0.06 * vec2(sin(w.y * 0.031) + sin(w.y * 0.0113 + 2.0), sin(w.x * 0.027) + sin(w.x * 0.0091 + 1.0));
    vec2 id = floor(q);
    vec2 f = q - id - 0.5;
    vec2 a = abs(f);
    vec2 other = id + (a.x > a.y ? vec2(sign(f.x), 0.0) : vec2(0.0, sign(f.y)));
    float blend = 0.5 * (1.0 - smoothstep(0.0, 0.055, 0.5 - max(a.x, a.y)));
    vec2 own = uMesoShift[int(mod(id.x, ${MESO_SHIFTS.toFixed(1)})) + ${MESO_SHIFTS} * int(mod(id.y, ${MESO_SHIFTS.toFixed(1)}))];
    vec2 next = uMesoShift[int(mod(other.x, ${MESO_SHIFTS.toFixed(1)})) + ${MESO_SHIFTS} * int(mod(other.y, ${MESO_SHIFTS.toFixed(1)}))];
    bool even = mod(id.x + id.y, 2.0) < 0.5;
    shiftA = even ? own : next;
    shiftB = even ? next : own;
    weightB = even ? blend : 1.0 - blend;
  }
`;

export const clipHeight = `
  uniform sampler2D uClipH0;
  uniform sampler2D uClipH1;
  uniform sampler2D uClipH2;
  uniform sampler2D uClipH3;
  float clipRG(vec4 v) { return v.r + v.g; }
  float clipHeightAt(vec2 w) {
    ${pick((l) => `clipRG(textureLod(uClipH${l}, ${uv(l)}, 0.0))`)}
  }
`;

const normalSamplers = `
  uniform sampler2D uClipN0;
  uniform sampler2D uClipN1;
  uniform sampler2D uClipN2;
  uniform sampler2D uClipN3;
`;

/** Für den Vertex-Shader: ohne Ableitungen */
export const clipNormalVertex = `
  ${normalSamplers}
  vec4 clipNormalAt(vec2 w) {
    ${pick((l) => `textureLod(uClipN${l}, ${uv(l)}, 0.0)`)}
  }
`;

/**
 * Für den Fragment-Shader. Die Detailstufe kommt als Zahl herein, sie muss nur einmal je Pixel berechnet werden: Logarithmus
 * der Pixelgröße in Metern. Das feinste Fenster hat keine Mipmaps.
 */
export const clipNormalFragment = `
  ${normalSamplers}
  vec4 clipNormalLod(vec2 w, float lod) {
    ${pick((l) => (l === 0
      ? `textureLod(uClipN0, ${uv(0)}, 0.0)`
      : `textureLod(uClipN${l}, ${uv(l)}, max(lod - ${Math.log2(CLIP_RES[l]).toFixed(1)}, 0.0))`))}
  }

  // Die Großform in einem festen Raster von 8 m: Eine schmale Bank mitten in der Felswand bleibt darin Teil der Wand
  vec4 clipNormalBroad(vec2 w) {
    vec2 q = abs(w - uHead.xz);
    float d = max(q.x, q.y);
    if (d < ${BLEND[1].to}) return textureLod(uClipN1, ${uv(1)}, 2.0);
    if (d < ${BLEND[2].to}) return textureLod(uClipN2, ${uv(2)}, 0.0);
    return textureLod(uClipN3, ${uv(3)}, 0.0);
  }
`;
