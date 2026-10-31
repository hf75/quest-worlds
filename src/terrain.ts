import * as THREE from 'three';
import { fetchBinary, fetchBitmap, fetchJson, heightTexture, tileTexture } from './assets';
import { CLIP_BROAD_ONLY, clipHeight, clipNormalFragment, clipNormalVertex, MESO_CELL, MESO_SHIFTS, mesoCells } from './clipShader';
import { PATCH_DIP, PATCH_OVERLAP } from './caves';
import { CLIP_N, CLIP_RES, RAW_HEIGHT_LEVELS, RAW_LIGHT_LEVELS, windowOrigin, type RectMessage } from './clips';
import type { Planet } from './planets';
import { hazeVertex, lightingFunctions, lightingUniforms, setPlanetDefine } from './shading';
import { REGION_N, REGION_SIZE, STRATA_PERIOD, STRATA_SAMPLES, type World } from './world';

interface TerrainMeta {
  key: { azimuth: number; elevation: number };
  meso: { size: number; resolution: number };
  detail: { size: number; resolution: number };
}

// Gelände als Quadtree aus immer gleichen Gitterstücken. Nah sind die Zellen so fein wie die Höhenkarte, nach außen
// verdoppelt sich die Zellgröße je Stufe. An den Übergängen wandern die Punkte weich auf das gröbere Gitter.
const GRID = 24;
const BASE_CELL = 0.0625;
const FIRST_RANGE = 4.5;
const MAX_PATCHES = 1500;
const MORPH_START = 0.75;
// Der Boden reicht von tief unten in den Schluchten bis zu den Hochebenen
const WORLD_LOW = -90;
const WORLD_HIGH = 260;
// So viele Mundlöcher können gleichzeitig nah genug sein, um ein Loch im Boden zu brauchen
const MAX_MOUTHS = 9;
const MAX_HOLE_PATCHES = 180;

class Field {
  private readonly data: Float32Array;
  private readonly n: number;
  private readonly size: number;

  constructor(data: Float32Array, n: number, size: number) {
    this.data = data;
    this.n = n;
    this.size = size;
  }

  sample(x: number, z: number): number {
    const { data, n, size } = this;
    const u = ((x / size) % 1 + 1) % 1 * n;
    const v = ((z / size) % 1 + 1) % 1 * n;
    const x0 = Math.floor(u), y0 = Math.floor(v);
    const fx = u - x0, fy = v - y0;
    const x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
    const a = data[y0 * n + x0], b = data[y0 * n + x1], c = data[y1 * n + x0], d = data[y1 * n + x1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
}

const vertexShader = `
  attribute vec3 aNode;
  attribute vec2 aMorph;
  uniform sampler2D uMesoH;
  uniform vec3 uHead;
  uniform float uInvRadius;
  uniform float uMesoSize;
  uniform float uMesoTexel;
  uniform float uGrid;
  uniform float uLodLift;
  ${clipHeight}
  ${clipNormalVertex}
  ${mesoCells}
  ${hazeVertex}
  #ifdef MARS
  uniform sampler2D uRegion;
  #endif
  varying vec3 vPos;
  varying vec2 vXZ;
  varying float vHeight;

  #ifdef MOUTH_HOLES
  uniform vec4 uMouthLine[${MAX_MOUTHS}];
  uniform float uMouthRadius[${MAX_MOUTHS}];
  uniform int uMouthCount;

  float mouthRim(vec2 w) {
    float rim = 1e6;
    for (int i = 0; i < uMouthCount; i++) {
      vec2 pa = w - uMouthLine[i].xy, ba = uMouthLine[i].zw - uMouthLine[i].xy;
      rim = min(rim, length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)) - uMouthRadius[i]);
    }
    return rim;
  }
  #endif

  void main() {
    // Alle Gitterpunkte liegen auf Vielfachen von 1/16 m, und die kann ein Float exakt darstellen. Darum wird hier aus Index und
    // Zellgröße gerechnet: So kommen benachbarte Stufen bitgenau auf denselben Punkt. Schon ein Rundungsfehler von einer Stelle
    // ließ sonst an ihren Nähten den Himmel als helle Punkte durchscheinen.
    vec2 g = floor(position.xz * uGrid + 0.5);
    float cell = floor(aNode.z / uGrid * ${(1 / BASE_CELL).toFixed(1)} + 0.5) * ${BASE_CELL.toFixed(4)};
    vec2 w = aNode.xy + g * cell;
    float d = length(vec3(w - uHead.xz, uLodLift));
    float m = clamp((d - aMorph.x) / (aMorph.y - aMorph.x), 0.0, 1.0);

    // Ungerade Gitterpunkte rücken auf das nächstgröbere Gitter, so passen benachbarte Stufen fugenlos aneinander
    w -= mod(g, 2.0) * cell * m;

    // Die Stücke einer geteilten Stufe ragen über ihre Reichweite hinaus, bis dorthin, wo die nächstgröbere Stufe ihre Punkte schon
    // verschiebt. Das muss hier mitgehen, sonst klafft an der Naht ein Spalt. Weiter als diese eine Stufe reicht kein Stück.
    float dNext = length(vec3(w - uHead.xz, uLodLift));
    float mNext = clamp((dNext - 2.0 * aMorph.x) / (2.0 * (aMorph.y - aMorph.x)), 0.0, 1.0);
    w -= mod(floor(g * 0.5), 2.0) * 2.0 * cell * mNext;

    // An Wänden würden die von oben gemessenen Platten zu senkrechten Rippen verzerrt, deshalb treten sie dort zurück.
    // In der Ferne sind die Platten zu klein, um aufzufallen: Dort spart das je Punkt einen Zugriff.
    float keep = 1.0;
    if (cell < 2.0) {
      vec2 e = clipNormalAt(w).xy * 2.0 - 1.0;
      keep = 0.2 + 0.8 * smoothstep(0.50, 0.72, sqrt(max(1.0 - dot(e, e), 0.0)));
      // Die erste Stufe ohne diesen Zugriff rechnet mit 1. An den Nähten zu ihr muss schon dasselbe herauskommen, sonst klafft in der Wand ein Spalt.
      if (cell > 0.75) keep = mix(keep, 1.0, m);
      else if (cell > 0.375) keep = mix(keep, 1.0, mNext);
    }
    // Ganzzahlig, damit auch die Detailstufe auf beiden Seiten einer Naht genau gleich ist
    float lodMeso = max(floor(log2(cell / uMesoTexel) + 0.5) + m + mNext, 0.0);
    vec2 shiftA, shiftB;
    float weightB;
    mesoCells(w, shiftA, shiftB, weightB);
    float plates = 0.0;
    if (weightB < 1.0) plates += (1.0 - weightB) * textureLod(uMesoH, (w + shiftA) / uMesoSize, lodMeso).r;
    if (weightB > 0.0) plates += weightB * textureLod(uMesoH, (w + shiftB) / uMesoSize, lodMeso).r;
    #ifdef MARS
    // Der Dünensand deckt das Geröll zu
    plates *= 1.0 - textureLod(uRegion, w / ${REGION_SIZE.toFixed(1)}, 0.0).r;
    #endif
    float h = clipHeightAt(w) + plates * keep;
    #ifdef MOUTH_HOLES
    // Zum Lochrand hin sinkt der Boden unter das vernetzte Stück, das ihn dort überlappt. Läge er mit seinen Platten höher,
    // sähe man flach durch den Spalt unter den Boden und damit in den Himmel.
    h -= ${PATCH_DIP.toFixed(1)} * (1.0 - smoothstep(0.0, ${(PATCH_OVERLAP / 2).toFixed(1)}, mouthRim(w)));
    #endif

    // Der Planet ist klein genug, dass sich der Boden sichtbar vom Betrachter wegkrümmt
    vec2 rel = w - uHead.xz;
    vec3 p = vec3(w.x, h - dot(rel, rel) * 0.5 * uInvRadius, w.y);
    vPos = p;
    vXZ = w;
    vHeight = h;
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
  #ifdef MARS
  uniform sampler2D uRegion;
  ${clipHeight}
  #endif
  ${clipNormalFragment}
  ${mesoCells}
  varying vec3 vPos;
  varying vec2 vXZ;
  varying float vHeight;
  ${lightingFunctions}

  #ifdef MOUTH_HOLES
  uniform vec4 uMouthLine[${MAX_MOUTHS}];
  uniform float uMouthRadius[${MAX_MOUTHS}];
  uniform int uMouthCount;
  #endif

  vec2 slopeOf(vec2 enc) {
    vec2 n = enc * 2.0 - 1.0;
    return -n / sqrt(max(1.0 - dot(n, n), 0.02));
  }

  // Die Platten werden in der Waagerechten gedehnt: So entstehen aus ihnen liegende Bänke statt kreuz und quer laufender Risse
  const float WALL_STRETCH = 0.32;
  // Mittelwert der Detailkarte: So bleibt die Helligkeit gleich, wo das Korn entfällt
  #ifdef MARS
  const vec4 GRAIN_MEAN = vec4(0.5, 0.5, 0.52, 0.927);
  #else
  const vec4 GRAIN_MEAN = vec4(0.5, 0.5, 0.519, 0.481);
  #endif

  // Wände lesen ihre Karten mit fester Detailstufe statt anisotrop. Gedehnte Karten unter flachem Winkel kosten sonst ein
  // Vielfaches an Zugriffen, und an einer Wand steht man oft nah genug, dass sie das ganze Bild füllt.
  float wallLod(vec2 ddx, vec2 ddy, float texelsPerMeter) {
    return 0.5 * log2(max(max(dot(ddx, ddx), dot(ddy, ddy)) * texelsPerMeter * texelsPerMeter, 0.0001)) - 0.4;
  }

  void wallPlates(vec2 uv, vec2 ddx, vec2 ddy, vec3 T, inout vec3 tilt, inout vec3 albedo, inout float rough, inout float ao, inout float wander, float weight) {
    vec2 mUv = uv * vec2(WALL_STRETCH, 1.0) / uMesoSize;
    float lod = wallLod(ddx * vec2(WALL_STRETCH, 1.0), ddy * vec2(WALL_STRETCH, 1.0), uMesoPixels);
    vec4 nr = textureLod(uMesoNR, mUv, lod);
    vec4 al = textureLod(uMesoAlbedo, mUv, lod - 1.0);
    vec2 sm = slopeOf(nr.xy);
    tilt += weight * (-T * sm.x * WALL_STRETCH - vec3(0.0, 0.7, 0.0) * sm.y);
    albedo += weight * al.rgb;
    rough += weight * nr.a;
    ao += weight * nr.b;
    // Die Platten liefern auch den Zufall für die Lagen: Keine Fuge läuft kilometerweit lupenrein durch
    wander += weight * (nr.x - 0.5);
  }

  void wallGrain(vec2 uv, vec2 ddx, vec2 ddy, vec3 T, inout vec3 tilt, inout vec3 grain, float weight) {
    vec4 de = textureLod(uDetail, uv / uDetailSize, wallLod(ddx, ddy, uDetailPixels));
    vec2 sd = slopeOf(de.xy);
    tilt += weight * (-T * sd.x - vec3(0.0, 1.0, 0.0) * sd.y);
    grain += weight * vec3(de.b, de.a, 1.0);
  }

  void main() {
    #ifdef MOUTH_HOLES
    // Am Mundloch hört der Boden auf, dort übernimmt das vernetzte Stück. Dieser Shader läuft nur auf den wenigen
    // Gitterstücken, die ein Mundloch berühren: Ausstanzen kostet die Grafikkarte ihre frühe Tiefenprüfung.
    for (int i = 0; i < uMouthCount; i++) {
      vec2 pa = vXZ - uMouthLine[i].xy, ba = uMouthLine[i].zw - uMouthLine[i].xy;
      vec2 off = pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      if (dot(off, off) < uMouthRadius[i] * uMouthRadius[i]) discard;
    }
    #endif

    vec2 ddx = dFdx(vXZ), ddy = dFdy(vXZ);
    float ydx = dFdx(vHeight), ydy = dFdy(vHeight);

    // Weit draußen ist das grobe Raster genauso fein wie die Großform: Dort reicht ein Zugriff für beide
    vec4 broadNR = clipNormalBroad(vXZ);
    vec2 away = abs(vXZ - uHead.xz);
    vec4 macroNR = max(away.x, away.y) > ${CLIP_BROAD_ONLY.toFixed(1)} ? broadNR : clipNormalLod(vXZ, 0.5 * log2(max(max(dot(ddx, ddx), dot(ddy, ddy)), 0.000001)));
    vec2 mSlope = slopeOf(macroNR.xy);
    vec3 Nm = normalize(vec3(-mSlope.x, 1.0, -mSlope.y));
    float wall = 1.0 - smoothstep(0.50, 0.72, Nm.y);
    // Eine schmale Bank mitten im Fels ist immer noch Fels, auch wenn sie für sich genommen flach liegt
    vec2 broad = broadNR.xy * 2.0 - 1.0;
    vec3 broadN = vec3(broad.x, sqrt(max(1.0 - dot(broad, broad), 0.0)), broad.y);
    wall = max(wall, 1.0 - smoothstep(0.46, 0.66, broadN.y));
    // Auf einem Grat kippt die Normale zwischen zwei Texeln einmal durch die Senkrechte. Auch das ist Fels und keine Fläche.
    float kink = length(fwidth(mSlope)) / max(length(fwidth(vXZ)), 0.0001);
    wall = max(wall, smoothstep(0.8, 2.2, kink));

    // Gemeinsame Gesteinslagen: Sie laufen als waagerechte Bänder um jeden Hang und passen über die Schlucht hinweg zusammen
    // Auf dem hellen Mars fielen die Dreiecke steiler Wände auf: Sie brechen die Bänder zu Zickzack. Dort zählt die Höhe aus der Karte statt aus dem Gitter.
    #ifdef MARS
    float bandHeight = wall > 0.0 ? clipHeightAt(vXZ) : vHeight;
    #else
    float bandHeight = vHeight;
    #endif
    float layer = (bandHeight + dot(uDip, vXZ)) / ${STRATA_PERIOD.toFixed(1)};
    float layerStep = max(abs(dFdx(layer)), abs(dFdy(layer))) * ${STRATA_SAMPLES.toFixed(1)};
    float layerLod = log2(max(layerStep, 0.001));

    // In der Ferne ist das Korn kleiner als ein Pixel. Dort entfallen seine Zugriffe, und das spart am meisten:
    // Ferner Boden liegt unter flachem Winkel, wo jeder anisotrope Zugriff ein Vielfaches kostet.
    float grainNear = 1.0 - smoothstep(60.0, 100.0, distance(vPos, cameraPosition));

    vec3 N = Nm;
    vec3 albedo = vec3(0.0);
    float rough = 0.0;
    float ao = 0.0;
    #ifdef MARS
    // Die langen Schatten der Steine stecken in der Kachel. Die Karte der Gegend sagt, wo Dünen liegen und wie hell der Staub ist.
    float tileSun = 1.0;
    vec4 region = texture2D(uRegion, vXZ / ${REGION_SIZE.toFixed(1)});
    #endif

    // Die Koordinaten stehen vor den Verzweigungen, damit die Grafikkarte ihre Ableitungen auch am Rand bilden kann.
    // Gradienten von Hand wären sicherer, kosten aber deutlich mehr, und an diesen Rändern geht das Gewicht ohnehin gegen null.
    const float c = 0.7986, s = 0.6018;
    vec2 shiftA, shiftB;
    float weightB;
    mesoCells(vXZ, shiftA, shiftB, weightB);
    vec2 mesoA = (vXZ + shiftA) / uMesoSize, mesoB = (vXZ + shiftB) / uMesoSize;
    vec2 uvA = vXZ / uDetailSize;
    vec2 uvB = vec2(c * vXZ.x - s * vXZ.y, s * vXZ.x + c * vXZ.y) / (uDetailSize * 0.27);

    if (wall < 1.0) {
      vec4 mesoNR = vec4(0.0), mesoAlb = vec4(0.0);
      if (weightB < 1.0) {
        mesoNR += (1.0 - weightB) * texture2D(uMesoNR, mesoA);
        mesoAlb += (1.0 - weightB) * texture2D(uMesoAlbedo, mesoA);
      }
      if (weightB > 0.0) {
        mesoNR += weightB * texture2D(uMesoNR, mesoB);
        mesoAlb += weightB * texture2D(uMesoAlbedo, mesoB);
      }

      // Zwei Maßstäbe derselben Detailkarte, gegeneinander gedreht: So fällt die Wiederholung nicht auf
      vec4 dA = GRAIN_MEAN, dB = GRAIN_MEAN;
      if (grainNear > 0.0) {
        dA = mix(GRAIN_MEAN, texture2D(uDetail, uvA), grainNear);
        dB = mix(GRAIN_MEAN, texture2D(uDetail, uvB), grainNear);
      }

      vec2 sA = slopeOf(dA.xy);
      vec2 sBr = slopeOf(dB.xy);
      vec2 sB = vec2(c * sBr.x + s * sBr.y, -s * sBr.x + c * sBr.y);

      // Sediment trägt keine groben Spaltkanten, nur feines Korn
      #ifdef MARS
      tileSun = mesoAlb.a;
      const float sediment = 0.55;
      float sand = region.r;
      #else
      float sediment = mesoAlb.a;
      #endif
      vec2 slope = mSlope + slopeOf(mesoNR.xy) + sA * (1.0 - 0.8 * sediment) + sB * (0.45 + 0.3 * sediment);
      #ifdef MARS
      // Auf dem Dünensand gibt es kein Geröll, nur Rippeln quer zum Wind. Aus der Ferne wären sie nur Flimmern.
      if (sand > 0.0) {
        slope = mix(slope, mSlope + sA * 0.25, sand);
        float rippleFade = sand * (1.0 - smoothstep(14.0, 34.0, distance(vPos, cameraPosition)));
        if (rippleFade > 0.0) {
          // Das Korn stört die Kämme: Sonst lägen sie gleichmäßig wie gezeichnete Linien
          float wave = (vXZ.y + 0.9 * sin(vXZ.x * 0.21) + 0.35 * sin(vXZ.x * 0.83 + vXZ.y * 0.3)) * 13.5 + 7.0 * (dB.x + dA.y - 1.0);
          slope.y += rippleFade * 0.11 * cos(wave + 1.4 * sin(wave * 0.5));
        }
      }
      #endif
      vec3 Nf = normalize(vec3(-slope.x, 1.0, -slope.y));

      vec3 af = mesoAlb.rgb * mix(0.2 + 1.6 * dA.b, 1.0, sediment) * (0.55 + 0.9 * dB.b);
      #ifdef MARS
      af *= mix(0.74, 1.2, region.g);
      // Dünen aus dunklem Basaltsand, wie sie überall auf dem Mars zwischen dem rostigen Staub liegen
      af = mix(af, vec3(0.135, 0.086, 0.066) * (0.72 + 0.56 * dB.b), sand);
      #endif

      // An steilen Kanten treten die feinen Schichten zutage
      float steep = smoothstep(0.7, 1.6, length(slopeOf(mesoNR.xy)));
      af *= 1.0 - steep * (0.28 + 0.28 * sin(vHeight * 190.0 + dA.r * 9.0));

      float rf = clamp(mix(dA.a, mesoNR.a, 0.55) * (0.88 + 0.24 * dB.a), 0.08, 1.0);
      float aof = mesoNR.b * mix(0.55 + 0.9 * dA.b, 1.0, sediment);
      #ifdef MARS
      tileSun = mix(tileSun, 1.0, sand);
      aof = mix(aof, 1.0, sand * 0.7);
      #endif

      // Auch die Hänge tragen die Lagen, nur schwächer: Über größere Strecken sieht man sie als feine Höhenbänder.
      // Auf ebenem Boden ändert sich die Höhe kaum, dort lohnt der Zugriff nicht.
      float banded = 0.45 * smoothstep(0.985, 0.94, Nm.y);
      if (banded > 0.0) af *= mix(1.0, 0.62 + 0.76 * textureLod(uStrata, vec2(layer, 0.5), layerLod).g, banded);

      N = Nf;
      albedo = af;
      rough = rf;
      ao = aof;
    }

    if (wall > 0.0) {
      // Felswand: von der Seite projiziert statt von oben, sonst wären die Karten über die ganze Höhe verschmiert
      float pick = smoothstep(-0.12, 0.12, abs(Nm.x) - abs(Nm.z));
      vec3 tilt = vec3(0.0), aw = vec3(0.0), grain = vec3(0.0);
      float wander = 0.0, rw = 0.0, aow = 0.0;
      vec2 alongX = vec2(vXZ.y, vHeight), alongXdx = vec2(ddx.y, ydx), alongXdy = vec2(ddy.y, ydy);
      vec2 alongZ = vec2(vXZ.x, vHeight), alongZdx = vec2(ddx.x, ydx), alongZdy = vec2(ddy.x, ydy);
      if (pick > 0.0) wallPlates(alongX, alongXdx, alongXdy, vec3(0.0, 0.0, 1.0), tilt, aw, rw, aow, wander, pick);
      if (pick < 1.0) wallPlates(alongZ, alongZdx, alongZdy, vec3(1.0, 0.0, 0.0), tilt, aw, rw, aow, wander, 1.0 - pick);

      vec4 strata = textureLod(uStrata, vec2(layer + wander * 3.0 / ${STRATA_PERIOD.toFixed(1)}, 0.5), layerLod);

      // Jede Bank verschiebt die Detailkarte anders. Sonst stünde die Wiederholung als senkrechte Streifen über die ganze Wand.
      vec2 shift = vec2(strata.g * 53.0, 0.0);
      if (grainNear > 0.0) {
        vec3 tiltGrain = vec3(0.0);
        if (pick > 0.0) wallGrain(alongX + shift, alongXdx, alongXdy, vec3(0.0, 0.0, 1.0), tiltGrain, grain, pick);
        if (pick < 1.0) wallGrain(alongZ + shift, alongZdx, alongZdy, vec3(1.0, 0.0, 0.0), tiltGrain, grain, 1.0 - pick);
        tilt += tiltGrain * grainNear;
      }
      grain = mix(vec3(GRAIN_MEAN.ba, 1.0), grain, grainNear);

      float tone = 0.62 + 0.76 * strata.g;
      // Stellenweise setzt eine Fuge aus: Das nimmt den Linien das Gekämmte
      float broken = smoothstep(0.12, 0.42, grain.x);

      // Die Bänke kippen die Fläche: oben fängt eine Stufe Licht, unten liegt sie im Schatten
      float ledge = (strata.r * 2.0 - 1.0) * broken;
      // Die Wand als Ganzes bestimmt die Lage im Licht mit. Sonst leuchten Absätze im Gegenlicht wie Schneeflecken.
      vec3 Nw = normalize(mix(Nm, broadN, 0.55) + tilt * 0.85 + vec3(0.0, ledge * 0.85, 0.0));

      aw *= (0.2 + 1.6 * grain.x) * tone * mix(vec3(0.92, 1.0, 1.1), vec3(1.14, 1.0, 0.88), strata.a);
      #ifdef MARS
      // Die Wände zeigen das Gestein unter dem Staub: dunkler, in rostigen und fahlen Bändern
      aw *= mix(vec3(0.62, 0.56, 0.54), vec3(1.0, 0.82, 0.68), strata.g);
      #endif
      rw = clamp(mix(grain.y, rw, 0.55), 0.08, 1.0);
      aow *= (0.55 + 0.9 * grain.x) * (1.0 - 0.75 * strata.b * broken);

      N = normalize(mix(N, Nw, wall));
      albedo = mix(albedo, aw, wall);
      rough = mix(rough, rw, wall);
      ao = mix(ao, aow, wall);
    }

    // Die beleuchteten Wände hellen die Schlucht mit auf. Ohne dieses Streulicht wäre es dort auf dem LCD nur noch schwarz.
    // Verdeckung und Hauptlicht aus dem groben Raster: Das Licht kommt von einer großen Fläche, sein Schatten ist weich.
    ao *= 0.38 + 0.62 * broadNR.b;
    // Kehrt die Wand als Ganzes dem Licht den Rücken zu, dann erreicht es auch ihre kleinen Vorsprünge nicht
    float shadow = broadNR.a * smoothstep(-0.2, 0.16, dot(broadN, uKeyDir));
    float sheen = 1.0 - 0.7 * wall;
    #ifdef MARS
    shadow *= mix(tileSun, 1.0, max(wall, smoothstep(50.0, 160.0, distance(vPos, cameraPosition))));
    // Staub glänzt nicht
    sheen *= 0.25;
    #endif

    vec3 V = normalize(cameraPosition - vPos);
    vec3 col = shadeSurface(vPos, N, V, albedo, rough, ao, shadow, sheen, mix(0.55, 1.0, ao));
    gl_FragColor = vec4(toDisplay(col), 1.0);
  }
`;

export class Terrain {
  readonly mesh: THREE.Mesh;
  readonly uniforms: Record<string, THREE.IUniform>;
  private readonly raw = Array.from({ length: RAW_HEIGHT_LEVELS }, () => new Float32Array(CLIP_N * CLIP_N));
  private readonly rawLight = Array.from({ length: RAW_LIGHT_LEVELS }, () => new Uint8Array(CLIP_N * CLIP_N * 2));
  private meso!: Field;
  private readonly heightTextures: THREE.DataTexture[] = [];
  private readonly normalTextures: THREE.DataTexture[] = [];
  private readonly uploadSource = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  private readonly uploadAt = new THREE.Vector2();
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly holeGeometry: THREE.InstancedBufferGeometry;
  private readonly holeNodes = new Float32Array(MAX_HOLE_PATCHES * 3);
  private readonly holeMorphs = new Float32Array(MAX_HOLE_PATCHES * 2);
  private readonly holeNodeAttr: THREE.InstancedBufferAttribute;
  private readonly holeMorphAttr: THREE.InstancedBufferAttribute;
  private holeCount = 0;
  private mouths: { ax: number; az: number; bx: number; bz: number; radius: number }[] = [];
  private world: World | null = null;
  private readonly nodes = new Float32Array(MAX_PATCHES * 3);
  private readonly morphs = new Float32Array(MAX_PATCHES * 2);
  private readonly nodeAttr: THREE.InstancedBufferAttribute;
  private readonly morphAttr: THREE.InstancedBufferAttribute;
  private readonly ranges: number[] = [];
  private lods = 10;
  private readonly materials: THREE.ShaderMaterial[];
  private readonly frustum = new THREE.Frustum();
  private readonly box = new THREE.Box3();
  private readonly projView = new THREE.Matrix4();
  private count = 0;
  private headX = 0;
  private headZ = 0;
  private lift = 0;
  private readonly cellOut = { x: 0, z: 0, edge: 0 };
  private readonly originX = [0, 0];
  private readonly originZ = [0, 0];
  private cull = false;
  radius = 8000;

  constructor(shared: Record<string, THREE.IUniform>) {
    this.geometry = new THREE.InstancedBufferGeometry();
    const n = GRID + 1;
    const positions = new Float32Array(n * n * 3);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const o = (j * n + i) * 3;
        positions[o] = i / GRID;
        positions[o + 2] = j / GRID;
      }
    }
    const index: number[] = [];
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setIndex(index);
    this.nodeAttr = new THREE.InstancedBufferAttribute(this.nodes, 3);
    this.nodeAttr.setUsage(THREE.DynamicDrawUsage);
    this.morphAttr = new THREE.InstancedBufferAttribute(this.morphs, 2);
    this.morphAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aNode', this.nodeAttr);
    this.geometry.setAttribute('aMorph', this.morphAttr);

    for (let i = 0; i < this.lods; i++) this.ranges.push(FIRST_RANGE * 2 ** i);

    this.uniforms = {
      ...shared,
      uHead: { value: new THREE.Vector3() },
      uInvRadius: { value: 1 / this.radius },
      uGrid: { value: GRID },
      uLodLift: { value: 0 },
      uMesoH: { value: null },
      uMesoNR: { value: null }, uMesoAlbedo: { value: null }, uDetail: { value: null },
      uStrata: { value: null },
      uRegion: { value: null },
      uDip: { value: new THREE.Vector2() },
      uMesoSize: { value: 256 }, uDetailSize: { value: 8 },
      uMesoTexel: { value: 256 / 4096 },
      uMesoPixels: { value: 4096 / 256 }, uDetailPixels: { value: 2048 / 8 },
      uMesoShift: { value: Array.from({ length: MESO_SHIFTS * MESO_SHIFTS }, () => new THREE.Vector2()) },
    };
    CLIP_RES.forEach((_, level) => {
      const height = new THREE.DataTexture(new Uint16Array(CLIP_N * CLIP_N * 2), CLIP_N, CLIP_N, THREE.RGFormat, THREE.HalfFloatType);
      height.internalFormat = 'RG16F';
      height.wrapS = height.wrapT = THREE.RepeatWrapping;
      height.minFilter = height.magFilter = THREE.LinearFilter;
      height.generateMipmaps = false;
      height.needsUpdate = true;
      const normal = new THREE.DataTexture(new Uint8Array(CLIP_N * CLIP_N * 4), CLIP_N, CLIP_N, THREE.RGBAFormat, THREE.UnsignedByteType);
      normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
      normal.magFilter = THREE.LinearFilter;
      // Das feinste Fenster ändert sich dauernd und liegt nah. Die anderen brauchen Mipmaps gegen Flimmern in der Ferne
      normal.minFilter = level === 0 ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
      normal.generateMipmaps = level !== 0;
      normal.needsUpdate = true;
      this.heightTextures.push(height);
      this.normalTextures.push(normal);
      this.uniforms[`uClipH${level}`] = { value: height };
      this.uniforms[`uClipN${level}`] = { value: normal };
    });
    this.uniforms.uMouthLine = { value: Array.from({ length: MAX_MOUTHS }, () => new THREE.Vector4()) };
    this.uniforms.uMouthRadius = { value: new Array(MAX_MOUTHS).fill(0) };
    this.uniforms.uMouthCount = { value: 0 };

    const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms: this.uniforms });
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;

    // Dieselben Gitterstücke, nur mit dem Shader, der Löcher stanzen kann
    this.holeGeometry = new THREE.InstancedBufferGeometry();
    this.holeGeometry.setAttribute('position', this.geometry.getAttribute('position'));
    this.holeGeometry.setIndex(this.geometry.getIndex());
    this.holeNodeAttr = new THREE.InstancedBufferAttribute(this.holeNodes, 3);
    this.holeNodeAttr.setUsage(THREE.DynamicDrawUsage);
    this.holeMorphAttr = new THREE.InstancedBufferAttribute(this.holeMorphs, 2);
    this.holeMorphAttr.setUsage(THREE.DynamicDrawUsage);
    this.holeGeometry.setAttribute('aNode', this.holeNodeAttr);
    this.holeGeometry.setAttribute('aMorph', this.holeMorphAttr);
    this.holeGeometry.instanceCount = 0;
    const holeMaterial = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms: this.uniforms, defines: { MOUTH_HOLES: 1 } });
    const holeMesh = new THREE.Mesh(this.holeGeometry, holeMaterial);
    holeMesh.frustumCulled = false;
    this.mesh.add(holeMesh);
    this.materials = [material, holeMaterial];
  }

  /** Stellt Krümmung, Sichtweite und Shader auf eine Welt ein. Die Kacheln lädt load(). */
  setPlanet(planet: Planet) {
    this.radius = planet.radius;
    this.lods = planet.lods;
    this.ranges.length = 0;
    for (let i = 0; i < this.lods; i++) this.ranges.push(FIRST_RANGE * 2 ** i);
    for (const material of this.materials) setPlanetDefine(material, planet.id === 'mars');
  }

  /** Vernetzte Mundlöcher: Dort stanzt der Boden ein Loch. */
  setMouths(list: { ax: number; az: number; bx: number; bz: number; radius: number }[]) {
    this.mouths = list.slice(0, MAX_MOUTHS);
    const lines = this.uniforms.uMouthLine.value as THREE.Vector4[];
    const radii = this.uniforms.uMouthRadius.value as number[];
    this.mouths.forEach((m, i) => {
      lines[i].set(m.ax, m.az, m.bx, m.bz);
      radii[i] = m.radius;
    });
    this.uniforms.uMouthCount.value = this.mouths.length;
  }

  private touchesMouth(x: number, z: number, size: number): boolean {
    for (const m of this.mouths) {
      // Grob genügt: Lieber ein Stück zu viel mit dem teureren Shader als ein Loch, das fehlt.
      // Auch die Stücke im Ring um das Loch gehören dazu, denn dort sinkt der Boden schon.
      const reach = m.radius + PATCH_OVERLAP / 2 + size * 0.75 + size * 0.1;
      const cx = x + size / 2, cz = z + size / 2;
      const ex = m.bx - m.ax, ez = m.bz - m.az;
      const t = Math.max(0, Math.min(1, ((cx - m.ax) * ex + (cz - m.az) * ez) / (ex * ex + ez * ez || 1)));
      if (Math.hypot(cx - m.ax - ex * t, cz - m.az - ez * t) < reach) return true;
    }
    return false;
  }

  async load(base: string, anisotropy: number, canMipHeights: boolean) {
    const [meta, mesoH, mesoNR, mesoAlb, detail, mesoWalk] = await Promise.all([
      fetchJson<TerrainMeta>(`${base}/terrain.json`),
      fetchBinary(`${base}/meso_height.bin`),
      fetchBitmap(`${base}/meso_nr.png`),
      fetchBitmap(`${base}/meso_albedo.png`),
      fetchBitmap(`${base}/detail_nr.png`),
      fetchBinary(`${base}/meso_walk.bin`),
    ]);
    const u = this.uniforms;
    for (const name of ['uMesoH', 'uMesoNR', 'uMesoAlbedo', 'uDetail']) (u[name].value as THREE.Texture | null)?.dispose();
    u.uMesoSize.value = meta.meso.size;
    u.uDetailSize.value = meta.detail.size;
    u.uMesoTexel.value = meta.meso.size / meta.meso.resolution;
    u.uMesoPixels.value = meta.meso.resolution / meta.meso.size;
    u.uDetailPixels.value = meta.detail.resolution / meta.detail.size;
    u.uMesoH.value = heightTexture(new Uint16Array(mesoH), meta.meso.resolution, canMipHeights);
    u.uMesoNR.value = tileTexture(mesoNR, false, anisotropy);
    u.uMesoAlbedo.value = tileTexture(mesoAlb, true, anisotropy);
    u.uDetail.value = tileTexture(detail, false, anisotropy);
    this.meso = new Field(new Float32Array(mesoWalk), 1024, meta.meso.size);
    return meta;
  }

  /** Überträgt die Gesteinslagen dieser Welt in den Shader. */
  setWorld(world: World) {
    this.world = world;
    const data = world.strataData;
    const previous = this.uniforms.uStrata.value as THREE.DataTexture | null;
    previous?.dispose();
    const t = new THREE.DataTexture(data, STRATA_SAMPLES, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    this.uniforms.uStrata.value = t;
    (this.uniforms.uRegion.value as THREE.DataTexture | null)?.dispose();
    this.uniforms.uRegion.value = null;
    if (world.mars) {
      const region = new THREE.DataTexture(world.regionData, REGION_N, REGION_N, THREE.RGBAFormat, THREE.UnsignedByteType);
      region.wrapS = region.wrapT = THREE.RepeatWrapping;
      region.minFilter = region.magFilter = THREE.LinearFilter;
      region.needsUpdate = true;
      this.uniforms.uRegion.value = region;
    }
    (this.uniforms.uDip.value as THREE.Vector2).set(world.dipX, world.dipZ);
    // Vielfache von 16 m: So bleibt auch der Streuplan der Steine in seinem Raster
    const shifts = this.uniforms.uMesoShift.value as THREE.Vector2[];
    let a = (Math.imul(world.seed, 0x2f6e2b1) + 77) >>> 0;
    for (const shift of shifts) {
      a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
      shift.set(((a >>> 8) & 15) * 16, ((a >>> 16) & 15) * 16);
    }
  }

  /** Zu welcher Plattenzelle gehört der Punkt? out.edge ist der Abstand zum Zellrand, in Zellgrößen. */
  mesoCell(x: number, z: number, out: { x: number; z: number; edge: number }) {
    const qx = x / MESO_CELL + 0.06 * (Math.sin(z * 0.031) + Math.sin(z * 0.0113 + 2));
    const qz = z / MESO_CELL + 0.06 * (Math.sin(x * 0.027) + Math.sin(x * 0.0091 + 1));
    const ix = Math.floor(qx), iz = Math.floor(qz);
    const shift = (this.uniforms.uMesoShift.value as THREE.Vector2[])[(ix & (MESO_SHIFTS - 1)) + MESO_SHIFTS * (iz & (MESO_SHIFTS - 1))];
    out.x = shift.x;
    out.z = shift.y;
    out.edge = 0.5 - Math.max(Math.abs(qx - ix - 0.5), Math.abs(qz - iz - 0.5));
  }

  /** Höhe der Platten an einem Punkt, geglättet zum Gehen. Am Zellrand zählt einfach die eigene Zelle: Die Glättung überdeckt den Rest. */
  private plateAt(x: number, z: number): number {
    const c = this.cellOut;
    this.mesoCell(x, z, c);
    const plate = this.meso.sample(x + c.x, z + c.z);
    return this.world?.mars ? plate * (1 - this.world.dune(x, z)) : plate;
  }

  /** Lädt ein fertiges Rechteck des Workers hoch. Die Fenster sind ringförmig, ein Rechteck überschreitet nie den Rand. */
  applyRect(renderer: THREE.WebGLRenderer, m: RectMessage) {
    const src = this.uploadSource;
    this.uploadAt.set(m.tx, m.tz);
    src.image = { data: m.height, width: m.w, height: m.h } as unknown as typeof src.image;
    renderer.copyTextureToTexture(src, this.heightTextures[m.level], null, this.uploadAt);
    src.image = { data: m.nr, width: m.w, height: m.h } as unknown as typeof src.image;
    renderer.copyTextureToTexture(src, this.normalTextures[m.level], null, this.uploadAt);
    if (m.raw) {
      const target = this.raw[m.level];
      for (let j = 0; j < m.h; j++) target.set(m.raw.subarray(j * m.w, (j + 1) * m.w), (m.tz + j) * CLIP_N + m.tx);
    }
    if (m.light) {
      const target = this.rawLight[m.level];
      const row = m.w * 2;
      for (let j = 0; j < m.h; j++) target.set(m.light.subarray(j * row, (j + 1) * row), ((m.tz + j) * CLIP_N + m.tx) * 2);
    }
  }

  /** Verdeckung und Hauptlicht an einem Punkt, beide 0 bis 1. Reicht für einen ganzen Stein, deshalb ohne Filterung. */
  lightAt(x: number, z: number, out: { ao: number; key: number }) {
    const mask = CLIP_N - 1;
    // Das feinste Fenster übernimmt sein Licht ohnehin vom nächstgröberen
    for (let level = 1; level < RAW_LIGHT_LEVELS; level++) {
      const res = CLIP_RES[level];
      const i = Math.round(x / res), j = Math.round(z / res);
      if (i < windowOrigin(this.headX, res) + 8 || i >= windowOrigin(this.headX, res) + CLIP_N - 8) continue;
      if (j < windowOrigin(this.headZ, res) + 8 || j >= windowOrigin(this.headZ, res) + CLIP_N - 8) continue;
      const o = ((j & mask) * CLIP_N + (i & mask)) * 2;
      out.ao = this.rawLight[level][o] / 255;
      out.key = this.rawLight[level][o + 1] / 255;
      return;
    }
    out.ao = 1;
    out.key = 1;
  }

  /** Ungeglättete Makrohöhe aus dem feinsten Fenster, das die Stelle enthält. Genau das, was auch die Grafikkarte sieht. */
  macroAt(x: number, z: number): number {
    const mask = CLIP_N - 1;
    const { originX, originZ } = this;
    for (let level = 0; level < RAW_HEIGHT_LEVELS; level++) {
      const res = CLIP_RES[level];
      const u = x / res, v = z / res;
      const i = Math.floor(u), j = Math.floor(v);
      const ox = originX[level], oz = originZ[level];
      if (i < ox + 8 || i >= ox + CLIP_N - 8 || j < oz + 8 || j >= oz + CLIP_N - 8) continue;
      const data = this.raw[level];
      const fx = u - i, fz = v - j;
      const i0 = i & mask, i1 = (i + 1) & mask, j0 = (j & mask) * CLIP_N, j1 = ((j + 1) & mask) * CLIP_N;
      const a = data[j0 + i0], b = data[j0 + i1], c = data[j1 + i0], d = data[j1 + i1];
      return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
    }
    return NaN;
  }

  /** Höhe unter den Füßen. Die Platten zählen geglättet: Der Kopf soll nicht jede Kante nachfahren. Stilles Wasser trägt. */
  ground(x: number, z: number): number {
    return Math.max(this.macroAt(x, z) + this.plateAt(x, z), this.world?.waterLevel(x, z) ?? -Infinity);
  }

  /** Was man beim Schweben unter sich hat: den Boden oder den Wasserspiegel darüber. */
  surface(x: number, z: number): number {
    return Math.max(this.macroAt(x, z), this.world?.waterLevel(x, z) ?? -Infinity);
  }

  /** Steigung über drei Meter: Kleine Stufen übersteigt man einfach, erst eine echte Wand hält auf. */
  slope(x: number, z: number, out: { x: number; z: number }) {
    out.x = (this.macroAt(x + 1.5, z) - this.macroAt(x - 1.5, z)) / 3;
    out.z = (this.macroAt(x, z + 1.5) - this.macroAt(x, z - 1.5)) / 3;
  }

  mesoAt(x: number, z: number): number {
    return this.plateAt(x, z);
  }

  get mesoSize(): number {
    return this.uniforms.uMesoSize.value as number;
  }

  /** Der Kopf bestimmt, welches Fenster die Höhenabfragen benutzen. Das gilt schon, bevor das erste Bild entsteht. */
  setHead(x: number, z: number) {
    this.headX = x;
    this.headZ = z;
    for (let level = 0; level < RAW_HEIGHT_LEVELS; level++) {
      this.originX[level] = windowOrigin(x, CLIP_RES[level]);
      this.originZ[level] = windowOrigin(z, CLIP_RES[level]);
    }
  }

  update(head: THREE.Vector3, camera: THREE.Camera & { projectionMatrix: THREE.Matrix4; matrixWorldInverse: THREE.Matrix4 }) {
    this.uniforms.uHead.value.copy(head);
    this.uniforms.uInvRadius.value = 1 / this.radius;
    this.setHead(head.x, head.z);
    // Wer hoch über dem Boden schwebt, ist von allem weit weg. Das spart Gitterstücke, die ohnehin niemand aufgelöst sähe.
    const ground = this.macroAt(head.x, head.z);
    this.lift = Number.isNaN(ground) ? 0 : Math.max(0, head.y - ground - 2);
    this.uniforms.uLodLift.value = this.lift;
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    this.cull = true;

    this.count = 0;
    this.holeCount = 0;
    const top = this.lods - 1;
    const rootSize = GRID * BASE_CELL * 2 ** top;
    const reach = this.ranges[top];
    const x0 = Math.floor((head.x - reach) / rootSize), x1 = Math.floor((head.x + reach) / rootSize);
    const z0 = Math.floor((head.z - reach) / rootSize), z1 = Math.floor((head.z + reach) / rootSize);
    for (let j = z0; j <= z1; j++) {
      for (let i = x0; i <= x1; i++) {
        if (this.distanceTo(i * rootSize, j * rootSize, rootSize) <= reach) this.select(i * rootSize, j * rootSize, rootSize, top);
      }
    }
    this.geometry.instanceCount = this.count;
    this.nodeAttr.needsUpdate = true;
    this.morphAttr.needsUpdate = true;
    this.holeGeometry.instanceCount = this.holeCount;
    this.holeNodeAttr.needsUpdate = true;
    this.holeMorphAttr.needsUpdate = true;
  }

  get patches() {
    return this.count + this.holeCount;
  }

  private distanceTo(x: number, z: number, size: number) {
    const dx = Math.max(x - this.headX, 0, this.headX - (x + size));
    const dz = Math.max(z - this.headZ, 0, this.headZ - (z + size));
    return Math.sqrt(dx * dx + dz * dz + this.lift * this.lift);
  }

  /** Höhe des Kopfes über dem Boden, ohne die Augenhöhe. Für alles, was mit der Entfernung gröber werden darf. */
  get altitude(): number {
    return this.lift;
  }

  private select(x: number, z: number, size: number, lod: number) {
    // Kinder außerhalb ihrer Reichweite bleiben drin: Ihre Punkte liegen dort schon vollständig auf dem gröberen Gitter.
    // Ließe man sie weg, klafften Löcher neben feiner aufgelösten Geschwistern.
    const d = this.distanceTo(x, z, size);
    if (lod > 0 && d <= this.ranges[lod - 1]) {
      const h = size / 2;
      this.select(x, z, h, lod - 1);
      this.select(x + h, z, h, lod - 1);
      this.select(x, z + h, h, lod - 1);
      this.select(x + h, z + h, h, lod - 1);
      return;
    }
    if (this.cull && !this.visible(x, z, size, d)) return;
    const holed = this.touchesMouth(x, z, size) && this.holeCount < MAX_HOLE_PATCHES;
    if (!holed && this.count >= MAX_PATCHES) return;
    const nodes = holed ? this.holeNodes : this.nodes, morphs = holed ? this.holeMorphs : this.morphs;
    const c = holed ? this.holeCount++ : this.count++;
    nodes[c * 3] = x;
    nodes[c * 3 + 1] = z;
    nodes[c * 3 + 2] = size;
    morphs[c * 2] = this.ranges[lod] * MORPH_START;
    morphs[c * 2 + 1] = this.ranges[lod] * 0.98;
  }

  private visible(x: number, z: number, size: number, d: number) {
    // Großzügig nach Höhe begrenzen: Die Schluchten sind tief, die Krümmung kommt nach außen hinzu
    const far = d + size * 1.5;
    const drop = (far * far) / (2 * this.radius);
    this.box.min.set(x, WORLD_LOW - drop, z);
    this.box.max.set(x + size, WORLD_HIGH, z + size);
    return this.frustum.intersectsBox(this.box);
  }
}
