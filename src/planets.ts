// Was eine Welt ausmacht, an einer Stelle: Eine weitere Welt ist ein weiterer Eintrag hier, dazu ihre Geländeform in world.ts und ihr Himmel.
// Diese Datei läuft auch in den Workern und unter Node, darum nur Daten.

export type PlanetId = 'slate' | 'mars';

export interface Planet {
  id: PlanetId;
  name: string;
  /** Eine Zeile im Auswahldialog */
  line: string;
  picture: string;
  /** Die Oberfläche: Kacheln und Streuplan der Steine */
  surface: string;
  /** Die Formen der Felsen */
  rocks: string;
  /** Krümmung des Bodens in Metern. Je kleiner, desto näher der Horizont. */
  radius: number;
  /** Detailstufen des Bodens. Eine mehr verdoppelt die Sichtweite. */
  lods: number;
  key: {
    /** Das Hauptlicht ist je Welt eine breite Fläche am Himmel oder eine Sonne: Zwischen diesen Winkeln verschwindet es hinter einer Kante, in Grad. */
    fadeFrom: number;
    fadeTo: number;
    spread: number;
    color: readonly [number, number, number];
    /** Aufweitung und Stärke des Glanzes */
    spec: readonly [number, number];
  };
  ambientTop: readonly [number, number, number];
  ambientLow: readonly [number, number, number];
  /** Die dunkelste und die hellste Farbe der Felsen, linear */
  rockDark: readonly [number, number, number];
  rockLight: readonly [number, number, number];
  /** Die Lichtfahne über den Höhlen */
  plume: readonly [number, number, number];
}

// Der Pfad, unter dem die Seite liegt: So läuft sie auch in einem Unterordner, etwa auf GitHub Pages
const BASE = import.meta.env.BASE_URL;

export const PLANETS: Record<PlanetId, Planet> = {
  slate: {
    id: 'slate',
    name: 'Slate',
    line: 'Night, anthracite canyons and still water that mirrors the galaxy',
    picture: `${BASE}assets/cards/slate.jpg`,
    surface: `${BASE}assets/terrain`,
    rocks: `${BASE}assets/rocks`,
    radius: 8000,
    lods: 10,
    key: { fadeFrom: 22, fadeTo: 42, spread: 16, color: [0.75, 0.69, 0.62], spec: [0.03, 0.75] },
    ambientTop: [0.10, 0.12, 0.165],
    ambientLow: [0.02, 0.021, 0.027],
    rockDark: [0.033, 0.036, 0.041],
    rockLight: [0.036, 0.046, 0.060],
    plume: [0.272, 0.688, 0.576],
  },
  mars: {
    id: 'mars',
    name: 'Mars',
    line: 'Dusk, rusty dust, craters and dunes under a blue sun',
    picture: `${BASE}assets/cards/mars.jpg`,
    surface: `${BASE}assets/mars`,
    rocks: `${BASE}assets/mars/rocks`,
    radius: 60000,
    lods: 11,
    // Eine kleine Sonne, tief am Horizont: Ihr Licht verschwindet fast auf einmal
    key: { fadeFrom: 9, fadeTo: 13, spread: 1.2, color: [2.1, 1.72, 1.42], spec: [0.02, 0.35] },
    ambientTop: [0.30, 0.215, 0.18],
    ambientLow: [0.15, 0.095, 0.07],
    rockDark: [0.052, 0.040, 0.034],
    rockLight: [0.105, 0.070, 0.052],
    plume: [0.30, 0.62, 1.0],
  },
};

export const PLANET_LIST: readonly Planet[] = [PLANETS.slate, PLANETS.mars];

/** Der Mars hat überall dieselbe Sonne: Der Staub auf den Kacheln trägt ihre Schatten schon in sich. */
export const MARS_SUN = { azimuth: -Math.PI / 2, elevation: (11 * Math.PI) / 180 };
