import type { PlanetId } from './planets';

// Der Boden liegt in vier Fenstern um den Kopf, jedes vierfach gröber und größer als das vorige. Die Fenster sind
// ringförmig adressiert: Beim Gehen kommen nur die neuen Zeilen dazu, der Rest bleibt, wo er ist.

export const CLIP_N = 512;
export const CLIP_RES = [0.5, 2, 8, 32];
/** Um so viele Texel springt ein Fenster. Kleinere Schritte brächten nur mehr Nachrichten für dieselbe Arbeit. */
export const CLIP_STEP = 8;
/** Die Höhe braucht der Hauptthread nur nah beim Kopf, das Licht für die Felsen bis in die Ferne */
export const RAW_HEIGHT_LEVELS = 2;
export const RAW_LIGHT_LEVELS = 3;

export interface InitMessage {
  type: 'init';
  generation: number;
  seed: number;
  planet: PlanetId;
  keyAzimuth: number;
  /** Fester Standort, sonst sucht der Worker selbst einen Start */
  at: { x: number; z: number } | null;
}

export interface MoveMessage {
  type: 'move';
  generation: number;
  x: number;
  z: number;
  /** Wer nach einem Sprung auf die neuen Fenster wartet, bekommt mit dieser Nummer Bescheid */
  ack?: number;
}

export interface SettledMessage {
  type: 'settled';
  generation: number;
  ack: number;
}

export interface RectMessage {
  type: 'rect';
  generation: number;
  level: number;
  /** Lage in der Textur, nie über den Rand hinweg */
  tx: number;
  tz: number;
  w: number;
  h: number;
  /** Zwei Halbfloats je Texel: Vielfaches von 16 m und Rest, sonst reicht die Genauigkeit nicht */
  height: Uint16Array<ArrayBuffer>;
  /** Normale x, Normale z, Verdeckung, Sichtbarkeit des Hauptlichts */
  nr: Uint8Array<ArrayBuffer>;
  /** Dieselbe Höhe für den Hauptthread, nur für die feinen Fenster */
  raw: Float32Array<ArrayBuffer> | null;
  /** Verdeckung und Hauptlicht für den Hauptthread: Die Felsen bekommen sie je Stein mit, nicht je Eckpunkt */
  light: Uint8Array<ArrayBuffer> | null;
}

export interface StartMessage {
  type: 'start';
  generation: number;
  x: number;
  z: number;
}

export interface ProgressMessage {
  type: 'progress';
  generation: number;
  fraction: number;
}

export interface ReadyMessage {
  type: 'ready';
  generation: number;
  ms: number;
}

export type ToWorker = InitMessage | MoveMessage;
export type FromWorker = RectMessage | StartMessage | ProgressMessage | ReadyMessage | SettledMessage;

/** Fensterlage zu einer Kopfposition. Worker und Hauptthread rechnen damit gleich. */
export function windowOrigin(head: number, res: number): number {
  return Math.floor(Math.floor(head / res) / CLIP_STEP) * CLIP_STEP - CLIP_N / 2;
}
