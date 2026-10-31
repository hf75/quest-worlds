import type * as THREE from 'three';

// Gemeinsame Bausteine für Boden und Felsen, damit beide unter demselben Licht stehen

/** Eine Welt schaltet ihre Shader-Zweige um. Der Schiefer behält so genau seinen Code, und nur beim Wechsel wird einmal neu übersetzt. */
export function setPlanetDefine(material: THREE.ShaderMaterial, mars: boolean) {
  if (mars === 'MARS' in material.defines) return;
  if (mars) material.defines.MARS = 1;
  else delete material.defines.MARS;
  material.needsUpdate = true;
}

/**
 * Die Farbe des Dunsts am Horizont des Mars, je nach Richtung zur Sonne. Der gebackene Himmel läuft unten in genau diese Farbe aus,
 * und der Boden löst sich in der Ferne darin auf: So gibt es keine Kante, wo das berechnete Gelände endet.
 */
export const marsHorizon = `
  vec3 marsHorizon(vec3 d) {
    float toward = dot(normalize(d.xz + vec2(0.0001, 0.0)), normalize(uKeyDir.xz)) * 0.5 + 0.5;
    return mix(vec3(0.125, 0.064, 0.042), vec3(0.47, 0.262, 0.14), toward * toward);
  }
`;

/** Für den Vertex-Shader: wie viel Dunst zwischen Auge und Punkt liegt. Je Eckpunkt genügt, er ändert sich ja nur langsam. */
export const hazeVertex = `
  #ifdef MARS
  uniform vec3 uKeyDir;
  varying vec4 vHaze;
  ${marsHorizon}
  void hazeAt(vec3 p) {
    vec3 toP = p - cameraPosition;
    float dist = length(toP);
    vHaze = vec4(marsHorizon(toP), max(1.0 - exp(-dist / 2300.0), smoothstep(3200.0, 4400.0, dist)));
  }
  #endif
`;

export const lightingUniforms = `
  #ifdef MARS
  varying vec4 vHaze;
  #endif
  uniform samplerCube uSky;
  uniform float uSkyLod;
  uniform vec3 uKeyDir;
  uniform vec3 uKeyColor;
  uniform vec2 uKeySpec;
  uniform vec3 uAmbientTop;
  uniform vec3 uAmbientLow;
  uniform vec3 uLampPos;
  uniform vec3 uLampColor;
  uniform float uLampFalloff;
  uniform float uExposure;
`;

export const lightingFunctions = `
  float ggxSpecular(vec3 N, vec3 L, vec3 V, float a2) {
    vec3 H = normalize(L + V);
    float nh = max(dot(N, H), 0.0);
    float nl = max(dot(N, L), 0.0);
    float nv = max(dot(N, V), 0.001);
    float vh = max(dot(V, H), 0.0);
    float d = nh * nh * (a2 - 1.0) + 1.0;
    float D = a2 / (3.14159 * d * d);
    float k = (sqrt(a2) + 1.0);
    k = k * k / 8.0;
    float vis = 0.25 / (mix(nl, 1.0, k) * mix(nv, 1.0, k));
    float f = 0.04 + 0.96 * pow(1.0 - vh, 5.0);
    return D * vis * f * nl;
  }

  // Spiegelung nur so stark, wie die Normale innerhalb eines Pixels wirklich gleich ist. Das verhindert Flimmern,
  // das in VR sofort auffällt.
  float filteredA2(vec3 N, float roughness) {
    vec3 dx = dFdx(N), dy = dFdy(N);
    float variance = 0.25 * (dot(dx, dx) + dot(dy, dy));
    float a = roughness * roughness;
    return clamp(a * a + min(2.0 * variance, 0.2), 0.0005, 1.0);
  }

  vec3 shadeSurface(vec3 P, vec3 N, vec3 V, vec3 albedo, float roughness, float ao, float keyShadow, float sheen, float lampShade) {
    float a2 = filteredA2(N, roughness);
    float nv = max(dot(N, V), 0.001);

    vec3 ambient = mix(uAmbientLow, uAmbientTop, N.y * 0.5 + 0.5) * ao;
    vec3 color = albedo * ambient;

    // Das Hauptlicht ist die ganze Galaxie, keine Punktlampe. Eine so große Fläche gibt nur einen breiten, schwachen
    // Glanz. Mit dem Punktlicht-Glanz blitzen plane Felsflächen als Ganzes weiß auf.
    float nl = max(dot(N, uKeyDir), 0.0);
    float keySpec = ggxSpecular(N, uKeyDir, V, clamp(a2 + uKeySpec.x, 0.0, 1.0)) * uKeySpec.y;
    color += (albedo * nl / 3.14159 + vec3(keySpec)) * uKeyColor * keyShadow;

    // Der Himmel spiegelt sich flach über den Platten, das verbindet Boden und Galaxie. Rauer Wandfels spiegelt kaum.
    vec3 R = reflect(-V, N);
    R.y = abs(R.y) + 0.02;
    float fres = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
    color += textureLod(uSky, R, uSkyLod + 1.5 * roughness).rgb * fres * ao * (1.0 - roughness * 0.7) * 0.75 * sheen;

    // Die Lampe. Sie ist kein Punkt, entsprechend breit ist ihr Glanz, und aus der Nähe mehr als aus der Ferne. Als Punktlicht ließe sie plane Felsflächen als Ganzes aufblitzen.
    vec3 toLamp = uLampPos - P;
    float d2 = dot(toLamp, toLamp);
    float lampD = sqrt(d2);
    vec3 L = toLamp / lampD;
    float lampFall = 1.0 / (1.0 + d2 * uLampFalloff);
    float lnl = max(dot(N, L), 0.0);
    float lampA = sqrt(a2) + 0.25 / lampD;
    color += (albedo * lnl / 3.14159 + vec3(ggxSpecular(N, L, V, min(lampA * lampA, 1.0)))) * uLampColor * lampFall * lampShade;
    return color;
  }

  vec3 toDisplay(vec3 c) {
    c = 1.0 - exp(-c * uExposure);
    #ifdef MARS
    c = mix(c, vHaze.rgb, vHaze.a);
    #endif
    vec3 s = mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
    // Dither gegen Stufen in dunklen Verläufen: auf dem LCD wären sie sonst deutlich zu sehen
    float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    return s + (n - 0.5) / 255.0;
  }
`;
