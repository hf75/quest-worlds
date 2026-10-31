// Das Modell des Himmels, gerechnet auf der Grafikkarte: mit weniger
// Schritten und einem Versatz im Rauschen, der aus dem Seed kommt. Es läuft nur beim Backen, nie während man sich umsieht.

export const bakeVertex = `
  varying vec2 vUv;
  void main() {
    vUv = position.xy;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const noise = `
  float cornerGrad(ivec3 c, vec3 f) {
    uint h = uint(c.x) * 73856093u ^ uint(c.y) * 19349663u ^ uint(c.z) * 83492791u;
    h ^= h >> 13u;
    h *= 0x5bd1e995u;
    h ^= h >> 15u;
    h &= 15u;
    float u = h < 8u ? f.x : f.y;
    float v = h < 4u ? f.y : (h == 12u || h == 14u ? f.x : f.z);
    return ((h & 1u) == 0u ? u : -u) + ((h & 2u) == 0u ? v : -v);
  }

  float noise(vec3 p) {
    vec3 fl = floor(p);
    ivec3 c = ivec3(fl);
    vec3 f = p - fl;
    vec3 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    return mix(
      mix(mix(cornerGrad(c, f), cornerGrad(c + ivec3(1, 0, 0), f - vec3(1.0, 0.0, 0.0)), w.x),
          mix(cornerGrad(c + ivec3(0, 1, 0), f - vec3(0.0, 1.0, 0.0)), cornerGrad(c + ivec3(1, 1, 0), f - vec3(1.0, 1.0, 0.0)), w.x), w.y),
      mix(mix(cornerGrad(c + ivec3(0, 0, 1), f - vec3(0.0, 0.0, 1.0)), cornerGrad(c + ivec3(1, 0, 1), f - vec3(1.0, 0.0, 1.0)), w.x),
          mix(cornerGrad(c + ivec3(0, 1, 1), f - vec3(0.0, 1.0, 1.0)), cornerGrad(c + ivec3(1, 1, 1), f - vec3(1.0, 1.0, 1.0)), w.x), w.y),
      w.z);
  }

  float fbm(vec3 p, int octaves, float gain) {
    float s = 0.0, a = 1.0, n = 0.0;
    for (int i = 0; i < octaves; i++) {
      s += a * noise(p);
      n += a;
      a *= gain;
      p = p * 2.03 + vec3(17.1, 3.7, 9.2);
    }
    return s / n;
  }

  // Scharfe Grate, daraus werden die fadenförmigen Staubbahnen
  float ridged(vec3 p, int octaves, float gain) {
    float s = 0.0, a = 1.0, n = 0.0;
    for (int i = 0; i < octaves; i++) {
      float v = 1.0 - abs(noise(p)) * 1.9;
      s += a * v * v;
      n += a;
      a *= gain;
      p = p * 2.07 + vec3(5.3, 11.9, 1.7);
    }
    return s / n;
  }

  float pixelNoise() {
    return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  }

  // Wie die Nachbearbeitung des alten Himmels: Schulter ohne Fuß, etwas mehr Sättigung
  vec3 developed(vec3 res) {
    vec3 c = 1.0 - exp(-max(res, vec3(0.0)));
    float g = (c.r + c.g + c.b) / 3.0;
    return clamp(g + (c - g) * 1.18, 0.0, 1.0);
  }

  vec3 toSrgb(vec3 c) {
    return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }

  vec3 fromSrgb(vec3 s) {
    return mix(s / 12.92, pow((s + 0.055) / 1.055, vec3(2.4)), step(0.04045, s));
  }
`;

const faceDirection = `
  uniform int uFace;
  vec3 faceDirection(vec2 st) {
    float s = st.x, t = st.y;
    if (uFace == 0) return normalize(vec3(1.0, -t, -s));
    if (uFace == 1) return normalize(vec3(-1.0, -t, s));
    if (uFace == 2) return normalize(vec3(s, 1.0, t));
    if (uFace == 3) return normalize(vec3(s, -1.0, -t));
    if (uFace == 4) return normalize(vec3(s, -t, 1.0));
    return normalize(vec3(-s, -t, -1.0));
  }
`;

/** Der weite Himmel: Sternenband, blasse Wolken und das Nachthimmelleuchten am Horizont. Alles sehr weich, es wird klein gebacken. */
export const backgroundFragment = `
  uniform vec3 uShift;
  uniform vec3 uBand;
  uniform vec3 uBandTint;
  varying vec2 vUv;
  ${noise}
  ${faceDirection}

  void main() {
    vec3 d = faceDirection(vUv);
    float lat = dot(d, uBand);
    float wob = fbm(d * 2.1 + vec3(1.0, 0.0, 0.0) + uShift, 4, 0.5);
    float band = exp(-pow(lat + wob * 0.12, 2.0) / 0.07);
    float fine = fbm(d * 6.0 + vec3(0.0, 4.0, 0.0) + uShift, 5, 0.55);
    float lane = clamp(0.5 + 1.8 * fbm(d * 3.4 + vec3(3.0, 0.0, 0.0) + uShift, 5, 0.55), 0.0, 1.0);
    float glow = band * (0.7 + 1.3 * clamp(0.5 + fine, 0.0, 1.0)) * (1.0 - 0.75 * lane * lane * exp(-lat * lat / 0.03));
    vec3 res = glow * uBandTint;

    float cloud = clamp(0.5 + 1.5 * fbm(d * 1.4 + vec3(8.0, 0.0, 0.0) + uShift, 5, 0.5), 0.0, 1.0);
    float tint = 0.5 + 0.5 * fbm(d * 0.8 + vec3(0.0, 4.0, 0.0) + uShift, 3, 0.5);
    res += cloud * cloud * vec3(0.0010 + 0.0022 * tint, 0.0013, 0.0040 - 0.0018 * tint);

    // Ganz feines grünliches Leuchten am Horizont, trennt Fels und Himmel
    float air = exp(-pow((d.y - 0.05) / 0.11, 2.0)) * step(-0.2, d.y);
    res += air * vec3(0.0024, 0.0048, 0.0052);
    gl_FragColor = vec4(res, 1.0);
  }
`;

/** Der klein gebackene Hintergrund, entwickelt und mit Dither auf die große Würfelkarte gebracht. */
export const upscaleFragment = `
  uniform samplerCube uBackground;
  varying vec2 vUv;
  ${noise}
  ${faceDirection}

  void main() {
    vec3 c = developed(texture(uBackground, faceDirection(vUv)).rgb);
    gl_FragColor = vec4(fromSrgb(toSrgb(c) + (pixelNoise() - 0.5) / 255.0), 1.0);
  }
`;

/** Die schwachen Sterne: eine halbe Million weicher Punkte, wild gestreut und in Haufen. Sie geben dem Himmel sein körniges Aussehen. */
export const grainVertex = `
  uniform int uFace;
  uniform uint uStarSeed;
  varying vec3 vColor;

  uvec3 pcg(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
  }

  vec3 random3(uint a, uint b) {
    return vec3(pcg(uvec3(a, b, uStarSeed))) / 4294967296.0;
  }

  vec3 onSphere(vec2 r) {
    float z = r.x * 2.0 - 1.0, a = r.y * 6.2832;
    float s = sqrt(1.0 - z * z);
    return vec3(s * cos(a), s * sin(a), z);
  }

  vec2 gaussian(vec2 r) {
    float m = sqrt(-2.0 * log(max(r.x, 1e-6)));
    return m * vec2(cos(r.y * 6.2832), sin(r.y * 6.2832));
  }

  void main() {
    uint id = uint(gl_VertexID);
    vec3 r1 = random3(id, 1u), r2 = random3(id, 2u);
    vec3 d;
    if (r1.z < 0.34) {
      // Ein Teil sammelt sich um feste Zentren: Gleichverteilung sieht aus wie Schneegestöber
      uint center = id % 70u;
      vec3 rc = random3(center, 3u);
      vec2 gs = gaussian(rc.yz);
      float spread = exp(log(0.05) + 0.6 * gs.x);
      vec2 ga = gaussian(r1.xy), gb = gaussian(r2.xy);
      d = normalize(onSphere(random3(center, 4u).xy) + vec3(ga, gb.x) * spread);
    } else {
      d = onSphere(r1.xy);
    }

    float flux = min((pow(1.0 - r2.z, -0.8) - 1.0 + 0.25) * 0.0125, 0.9);
    vec3 r3 = random3(id, 5u);
    vec3 warm = vec3(1.0, 0.8, 0.62), cool = vec3(0.7, 0.82, 1.0);
    vColor = mix(mix(warm, vec3(1.0), smoothstep(0.0, 0.5, r3.x)), cool, smoothstep(0.55, 1.0, r3.x)) * flux;

    float ma, s, t;
    if (uFace == 0) { ma = d.x; s = -d.z; t = -d.y; }
    else if (uFace == 1) { ma = -d.x; s = d.z; t = -d.y; }
    else if (uFace == 2) { ma = d.y; s = d.x; t = d.z; }
    else if (uFace == 3) { ma = -d.y; s = d.x; t = -d.z; }
    else if (uFace == 4) { ma = d.z; s = d.x; t = -d.y; }
    else { ma = -d.z; s = -d.x; t = -d.y; }
    gl_Position = ma > 0.0 ? vec4(s / ma, t / ma, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 5.0;
  }
`;

export const grainFragment = `
  varying vec3 vColor;
  void main() {
    vec2 q = (gl_PointCoord - 0.5) * 5.0;
    gl_FragColor = vec4(vColor * exp(-dot(q, q) / 0.77) / (3.14159 * 0.77), 1.0);
  }
`;

/** Die Scheibe der Galaxie als Bild in ihrer eigenen Ebene. Der Betrachter steht bei uOrigin. Am Himmel kann sie sich dann drehen. */
export const galaxyFragment = `
  uniform vec3 uShift;
  uniform vec3 uOrigin;
  uniform float uRb;
  uniform float uArms;
  uniform float uPitch;
  uniform vec3 uYoung;
  uniform vec3 uHii;
  uniform vec3 uKnots;
  uniform vec3 uOld;
  uniform vec3 uCore;
  varying vec2 vUv;
  ${noise}

  float bulgeAt(vec3 p) {
    float q = p.z / 0.68;
    float d2 = dot(p.xy, p.xy) + q * q;
    return 1.9 * pow(1.0 + d2 / 0.9025, -1.75) * (1.0 - smoothstep(9.0, 36.0, d2));
  }

  float dustSheet(vec2 q, float r, float armDust, float seed) {
    float wx = q.x + 0.5 * fbm(vec3(q.x * 0.8 + 5.0 + seed, q.y * 0.8, seed) + uShift, 3, 0.5);
    float wy = q.y + 0.5 * fbm(vec3(q.x * 0.8, q.y * 0.8 + 5.0 + seed, seed) + uShift, 3, 0.5);
    float fil = ridged(vec3(wx * 0.74, wy * 0.74, 2.0 + seed) + uShift, 7, 0.6);
    float filament = pow(clamp((fil - 0.30) * 1.8, 0.0, 1.0), 2.2);
    float clumps = clamp(0.62 + 1.4 * fbm(vec3(q.x * 0.3 + 8.0, q.y * 0.3 + 4.0, seed) + uShift, 3, 0.5), 0.0, 1.0);
    return pow(exp(-r / 4.9), 0.3) * smoothstep(0.4, 2.2, r) * (1.0 - smoothstep(13.0, 20.0, r)) * filament * clumps * (0.34 + 3.6 * armDust);
  }

  void main() {
    vec2 q = vUv * uRb;
    float r = length(q);
    if (r >= uRb) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    vec3 o = uOrigin;
    vec3 l = normalize(vec3(q, 0.0) - o);
    float tp = -o.z / l.z;
    float sgn = o.z > 0.0 ? 1.0 : -1.0;
    float slantRaw = 1.0 / max(abs(l.z), 1e-4);
    float slant = min(slantRaw, 7.0);

    // Das Spiralmuster: unregelmäßige, zerfaserte Arme, dazu Sporne dazwischen
    float rs = max(r, 0.25);
    float th = atan(q.y, q.x);
    float lr = log(rs);
    float wob = fbm(vec3(q.x * 0.13 + 3.1, q.y * 0.13 + 7.7, 0.3) + uShift, 3, 0.5);
    float wob2 = fbm(vec3(q.x * 0.47 + 9.3, q.y * 0.47 + 1.7, 0.6) + uShift, 3, 0.5);
    float ph = uArms * (th - lr / tan(uPitch)) + wob * 1.5 + wob2 * 0.55;
    float armC = 0.5 + 0.5 * cos(ph);
    float armOuter = 0.5 + 0.5 * cos(ph + 0.72);
    float spur = pow(0.5 + 0.5 * cos(3.0 * uArms * (th - lr / tan(uPitch + 0.23)) + wob2 * 3.0), 3.0);
    float arm = armC * armC * armC;
    float armAll = arm + 0.2 * spur * (0.4 + armC);
    float armDust = armOuter * armOuter * armOuter;
    float armFactor = 0.5 + 0.5 * armAll;

    // Staub vor und hinter der Mittelebene. Blau wird stärker geschluckt, deshalb färbt er das Licht dahinter rostbraun.
    float tNear = (sgn * 0.1 - o.z) / l.z, tFar = (-sgn * 0.1 - o.z) / l.z;
    vec2 qn = o.xy + l.xy * tNear, qf = o.xy + l.xy * tFar;
    float dn = dustSheet(qn, length(qn), armDust, 0.0);
    float df = dustSheet(qf, length(qf), armDust, 4.0);
    float k = 2.1 * slant;
    vec3 absorb = vec3(0.72, 1.0, 1.38);
    vec3 Tn = exp(-dn * k * absorb), Tf = exp(-df * k * absorb);

    // Die dünne Scheibe: junge Sterne, rosa Knoten auf dem Grat der Arme, kleine blaue Haufen
    float inner = smoothstep(1.1, 3.6, r);
    float outer = 1.0 - smoothstep(12.5, 20.0, r);
    float disk = exp(-r / 5.8);
    float n1 = fbm(vec3(q * 0.62, 0.5) + uShift, 4, 0.5);
    float n2 = fbm(vec3(q * 2.3 + vec2(4.1, 8.2), 1.5) + uShift, 6, 0.6);
    float clump = clamp(0.42 + 1.35 * n1 + 1.0 * n2, 0.0, 1.0);
    float young = disk * armAll * inner * outer * (0.10 + 4.2 * clump * clump);
    float kn = fbm(vec3(q * 4.4 + vec2(21.0, 2.0), 2.5) + uShift, 5, 0.62);
    float knot = pow(clamp(kn * 1.6 + 0.44, 0.0, 1.0), 8.0);
    float group = smoothstep(-0.05, 0.35, fbm(vec3(q * 0.42 + vec2(30.0, 6.0), 0.0) + uShift, 3, 0.5));
    float hii = disk * arm * arm * inner * outer * knot * group * 58.0;
    float kb = fbm(vec3(q * 11.5 + vec2(2.0, 13.0), 3.5) + uShift, 3, 0.6);
    float knotBlue = pow(clamp(kb * 1.3 + 0.48, 0.0, 1.0), 7.0) * disk * armAll * inner * outer * 5.5;
    vec3 thin = (young * uYoung + hii * uHii + knotBlue * uKnots) * 0.4 * slant;
    // Staub streut das Licht der Umgebung zurück
    thin += exp(-r / 4.9) * (0.5 + armAll) * 0.16 * slant * (dn + df) * vec3(1.05, 0.46, 0.19);

    // Kern und alte Sterne sind glatt und werden längs der Sichtlinie integriert, getrennt vor und hinter der Scheibe
    float oldNear = 0.0, oldFar = 0.0, coreNear = 0.0, coreFar = 0.0;
    float hh = 1.9 * slantRaw;
    float t0 = max(tp - hh, 0.0), t1 = tp + hh;
    float h = (t1 - t0) / 8.0;
    for (int i = 0; i < 8; i++) {
      float t = t0 + (float(i) + 0.5) * h;
      vec3 p = o + l * t;
      float rr = length(p.xy);
      float c = cosh(p.z / 0.55);
      float v = exp(-rr / 2.6) * 1.55 / (c * c) * (1.0 - smoothstep(12.5, 20.0, rr)) * h;
      if (t < tp) oldNear += v; else oldFar += v;
    }
    oldNear *= armFactor;
    oldFar *= armFactor;
    float tc = -dot(o, l);
    vec3 cp = o + l * tc;
    if (dot(cp, cp) < 49.0 && tc > 0.0) {
      float step_ = 14.0 / 10.0;
      for (int i = 0; i < 10; i++) {
        float t = tc - 7.0 + (float(i) + 0.5) * step_;
        float v = bulgeAt(o + l * t) * step_;
        if (t < tp) coreNear += v; else coreFar += v;
      }
    }
    vec3 nearLight = oldNear * uOld + coreNear * uCore;
    vec3 farLight = oldFar * uOld + coreFar * uCore;
    vec3 res = (nearLight + Tn * (thin + Tf * farLight)) * 0.62;
    gl_FragColor = vec4(toSrgb(developed(res)) + (pixelNoise() - 0.5) / 255.0, 1.0);
  }
`;

/** Nimmt das Korn aus dem frisch gerechneten Nebel. */
export const smoothFragment = `
  uniform sampler2D uRaw;
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec3 s = vec3(0.0);
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        float w = (j == 0 ? 2.0 : 1.0) * (i == 0 ? 2.0 : 1.0);
        s += w * texelFetch(uRaw, p + ivec2(i, j), 0).rgb;
      }
    }
    gl_FragColor = vec4(s / 16.0, 1.0);
  }
`;

/** Ein Emissionsnebel, durch ein Fenster am Himmel gerechnet: rostrote Fadenknäuel außen, Gaskern innen. */
export const nebulaFragment = `
  uniform vec3 uShift;
  uniform vec3 uCenter;
  uniform vec3 uRight;
  uniform vec3 uUp;
  uniform float uSpan;
  uniform vec3 uShell;
  uniform vec3 uGas;
  varying vec2 vUv;
  ${noise}

  const int STEPS = 16;
  const float DIST = 30.0;
  const float RADIUS = 18.0;

  void main() {
    vec3 d = normalize(uCenter + (uRight * vUv.x + uUp * vUv.y) * uSpan);
    float tc = DIST * dot(uCenter, d);
    vec3 pc = d * tc - uCenter * DIST;
    float d2 = dot(pc, pc);
    if (tc < 0.0 || d2 > RADIUS * RADIUS) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    float hh = sqrt(RADIUS * RADIUS - d2);
    float h = 2.0 * hh / float(STEPS);
    // Wenige Schritte mit zufälligem Anfang: Das gibt feines Korn statt Stufen, und das Korn nimmt der nächste Schritt wieder heraus
    uvec2 pixel = uvec2(gl_FragCoord.xy);
    uint mixed = (pixel.x * 1597334677u ^ pixel.y * 3812015801u) * 1597334677u;
    float jitter = float(mixed >> 8u) / 16777216.0;
    vec3 L = vec3(0.0), T = vec3(1.0);
    for (int i = 0; i < STEPS; i++) {
      vec3 p = d * (tc - hh + (float(i) + jitter) * h) - uCenter * DIST;
      // Umriss aufbrechen, sonst wirkt der Nebel wie eine Kugel
      float rr = length(p) / RADIUS + 0.52 * fbm(p * 0.075 + vec3(3.0, 0.0, 8.0) + uShift, 3, 0.5);
      float fall = 1.0 - smoothstep(0.34, 0.86, rr);
      if (fall <= 0.0) continue;

      vec3 w = p + 1.7 * vec3(
        fbm(p * 0.22 + uShift, 3, 0.5),
        fbm(p * 0.22 + vec3(7.0, 0.0, 0.0) + uShift, 3, 0.5),
        fbm(p * 0.22 + vec3(0.0, 7.0, 0.0) + uShift, 3, 0.5)
      );
      float fil = ridged(w * 0.3 + vec3(4.0, 0.0, 0.0) + uShift, 7, 0.62);
      float shell = pow(clamp((fil - 0.38) * 2.4, 0.0, 1.0), 3.1);
      float lobes = clamp(0.42 + 1.9 * fbm(w * 0.085 + vec3(0.0, 3.0, 0.0) + uShift, 4, 0.5), 0.0, 1.0);
      float rust = shell * lobes * fall * fall;

      float coreFall = 1.0 - smoothstep(0.0, 0.55, rr);
      float cloud = clamp(0.46 + 1.6 * fbm(w * 0.17 + vec3(9.0, 0.0, 0.0) + uShift, 6, 0.56), 0.0, 1.0);
      float oxy = cloud * cloud * coreFall;

      float dust = pow(clamp((ridged(w * 0.26 + vec3(2.0, 0.0, 5.0) + uShift, 6, 0.6) - 0.44) * 2.2, 0.0, 1.0), 2.6) * fall * 0.44;

      L += T * (rust * uShell + oxy * uGas) * h;
      T *= exp(-dust * h * vec3(0.78, 1.0, 1.3));
    }
    // Am Rand des Fensters muss alles auslaufen, sonst zeichnet es sich ab, wenn der Nebel wabert
    L *= 1.0 - smoothstep(0.9, 1.0, max(abs(vUv.x), abs(vUv.y)));
    gl_FragColor = vec4(toSrgb(developed(L)) + (pixelNoise() - 0.5) / 255.0, 1.0);
  }
`;
