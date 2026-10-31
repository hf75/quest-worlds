import type { PlanetId } from './planets';
import { mulberry } from './world';

// Die Musik entsteht hier im Browser. Es gibt keine Tondatei und keine fremde Aufnahme: Der Seed legt Tonart, Stimmung und Verlauf fest,
// und das Stück läuft ohne Ende und ohne Wiederholung. Jede Welt hat ihr eigenes.
//
// Das Vorbild ist der Klang der Synthesizer-Filmmusik der frühen Achtziger: langsam aufblühende Akkorde aus verstimmten Sägezähnen,
// ein riesiger dunkler Hall und darunter ein Ton wie eine ferne Maschine. Noten sind keine übernommen, Akkordfolge und Linie würfelt der Seed.
//
// Geplant wird immer ein Stück voraus, die Klänge laufen dann im Audio-Thread von selbst weiter. Ruckelnde Bilder stören sie also nicht.
const LOOKAHEAD = 20;
const FADE_IN = 6;
const LEVEL = 0.95;
/** Über 8 kHz ist hier ohnehin fast nichts, und der Hall kostet bei dieser Abtastrate weniger als die Hälfte. Auf einer Quest zählt das. */
export const MUSIC_RATE = 32000;
const HALL_SECONDS = 9.5;
const HALL_T60 = 8;
const HALL_LEVEL = 0.55;

const TONICS = [38, 36, 40, 41, 37, 39, 35];

// Offene Lagen, von unten nach oben, in Halbtönen über dem Grundton
const MIN9 = [0, 7, 15, 22, 26];
const MIN11 = [0, 7, 15, 22, 29];
const MIN6 = [0, 7, 15, 21, 26];
const MIN_MAJ = [0, 7, 15, 23, 26];
const MAJ7 = [0, 7, 16, 23, 26];
const SUS = [0, 7, 14, 19, 22];

interface Mood {
  chords: readonly (readonly [root: number, voicing: readonly number[]])[];
  next: readonly (readonly number[])[];
}

// Die Stimmungen sind kleine Wege durch wenige Akkorde. Keiner führt weit vom Grundton weg, aber keiner geht im Kreis.
const MOODS: readonly Mood[] = [
  { // Natürliches Moll
    chords: [[0, MIN9], [8, MAJ7], [5, MIN11], [10, SUS], [3, MAJ7]],
    next: [[1, 2, 3, 4], [0, 2, 4], [0, 1, 3], [0, 4], [1, 2, 0]],
  },
  { // Terzverwandtschaft: Der Boden wechselt, ohne dass ein Ton dorthin geführt hätte
    chords: [[0, MIN9], [8, MIN9], [4, MAJ7], [5, MIN6], [11, MIN_MAJ]],
    next: [[1, 2, 3], [0, 2], [0, 3], [0, 1, 4], [0]],
  },
  { // Phrygisch: der Halbton über dem Grundton, die dunkelste Färbung
    chords: [[0, MIN11], [1, MAJ7], [5, MIN9], [10, MIN9], [8, MAJ7]],
    next: [[1, 2, 3], [0, 4], [0, 1, 3], [0, 4], [1, 2, 0]],
  },
  { // Dorisch: am offensten, fast hoffnungsvoll
    chords: [[0, MIN9], [5, SUS], [3, MAJ7], [10, SUS], [7, MIN11]],
    next: [[1, 2, 3, 4], [0, 2], [1, 3, 0], [0, 4], [0, 1]],
  },
];

// Jede Welt klingt anders, aus denselben Bausteinen. Der Mars ist trockener: dunklere Tonarten, weniger Glocken, mehr Wind.
const STYLES: Record<PlanetId, { tonic: number; mood: number; tonics: readonly number[]; moods: readonly number[]; wind: number; bells: number; lines: number }> = {
  slate: { tonic: 38, mood: 0, tonics: TONICS, moods: [0, 1, 2, 3], wind: 1, bells: 1, lines: 1 },
  mars: { tonic: 40, mood: 2, tonics: [40, 35, 37, 42], moods: [2, 1], wind: 2.1, bells: 1.7, lines: 0.75 },
};

// Unten trägt es, nach oben wird es dünner
const PAD_LEVELS = [0.062, 0.05, 0.05, 0.042, 0.032];
const PAD_PANS = [0, -0.35, 0.35, -0.65, 0.65];

// Teiltöne einer Glocke: Verhältnis, Lautstärke, Länge. Sie passen nicht zueinander, das macht das Metall.
const BELL = [[1, 1, 1], [2.01, 0.5, 0.7], [2.76, 0.32, 0.5], [5.4, 0.16, 0.28], [8.93, 0.06, 0.14]] as const;

// Jede Stellgröße einzeln je Sample nachzuführen, ist hier das Teuerste überhaupt: Ein Filter rechnet dann seine Koeffizienten für jedes Sample neu.
// Bei Bewegungen über Sekunden genügt einmal je Block, also alle paar Millisekunden.
function filter(ctx: BaseAudioContext, type: BiquadFilterType, frequency: number, q: number): BiquadFilterNode {
  const node = ctx.createBiquadFilter();
  node.type = type;
  node.frequency.automationRate = 'k-rate';
  node.Q.automationRate = 'k-rate';
  node.detune.automationRate = 'k-rate';
  node.gain.automationRate = 'k-rate';
  node.frequency.value = frequency;
  node.Q.value = q;
  return node;
}

const midiToHz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const wrapInto = (value: number, low: number) => low + (((value - low) % 12) + 12) % 12;

/** Analoge Oszillatoren laufen nie ganz gerade: ein langsames Wandern um den Grundwert. */
function wander(param: AudioParam, t: number, end: number, base: number, depth: number, r: () => number) {
  param.setValueAtTime(base + (r() - 0.5) * 2 * depth, t);
  for (let at = t + 3 + r() * 5; at < end; at += 3 + r() * 5) param.linearRampToValueAtTime(base + (r() - 0.5) * 2 * depth, at);
}

/** Die Antwort eines riesigen dunklen Raums: Rauschen, das verklingt, und je länger es klingt, desto mehr fehlen die Höhen. */
function hallResponse(ctx: BaseAudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.floor(HALL_SECONDS * rate);
  const buffer = ctx.createBuffer(2, length, rate);
  const silence = Math.floor(0.035 * rate);
  const fall = (-6.9 / HALL_T60) / rate;
  const r = mulberry(0x2b1d59);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let low = 0;
    for (let i = silence; i < length; i++) {
      const t = (i - silence) / rate;
      const a = 0.035 + 0.5 * Math.exp(-t * 1.5);
      low += a * (r() * 2 - 1 - low);
      // Ein Tiefpass nimmt dem Rauschen auch Kraft. Die wird hier zurückgegeben, sonst würde es mit den Höhen zugleich leiser.
      data[i] = (low / Math.sqrt(a / (2 - a))) * Math.exp(fall * (i - silence)) * Math.min(1, t / 0.09);
    }
  }
  return buffer;
}

function softLimit(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(1025);
  for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh((i / 512 - 1) * 1.0);
  return curve;
}

/** Ein Stück, von seinem Seed bis zum Ausblenden. */
class Piece {
  private readonly rChord: () => number;
  private readonly rBell: () => number;
  private readonly rFar: () => number;
  private readonly sources = new Set<AudioScheduledSourceNode>();
  private readonly farAway: { pan: StereoPannerNode; x: number; z: number; until: number }[] = [];
  private readonly mood: Mood;
  private readonly tonic: number;
  private readonly tidePhase: readonly [number, number];
  private readonly style: (typeof STYLES)[PlanetId];
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly padBus: GainNode;
  private readonly lineBus: GainNode;
  private readonly bellBus: GainNode;
  private readonly droneOscillators: OscillatorNode[] = [];
  private readonly windLow: BiquadFilterNode;
  private readonly windHigh: BiquadFilterNode;
  private readonly windLowLevel: GainNode;
  private readonly windHighLevel: GainNode;
  private index = 0;
  private played = 0;
  private droneMidi: number;
  private pitches: number[] = [];
  private lastLineNote = 72;
  private nextChord: number;
  private nextBell: number;
  private nextFar: number;
  private right = { x: 1, z: 0 };

  constructor(
    private readonly ctx: BaseAudioContext,
    mix: AudioNode,
    hall: AudioNode,
    private readonly noise: AudioBuffer,
    seed: number,
    planet: PlanetId,
    private readonly log?: (at: number, text: string) => void,
  ) {
    const r = mulberry(seed ^ 0x6d757369);
    const style = STYLES[planet];
    this.style = style;
    this.rChord = mulberry(seed ^ 0x13c7a1);
    this.rBell = mulberry(seed ^ 0x51be11);
    this.rFar = mulberry(seed ^ 0x7fa23);
    // Welt 1 bleibt die vertraute: Auf dem Schiefer ist das D-Moll
    this.tonic = seed === 1 ? style.tonic : style.tonics[Math.floor(r() * style.tonics.length)];
    this.mood = MOODS[seed === 1 ? style.mood : style.moods[Math.floor(r() * style.moods.length)]];
    this.tidePhase = [r() * Math.PI * 2, r() * Math.PI * 2];

    const t0 = ctx.currentTime + 0.1;
    this.nextChord = t0 + 1.5;
    this.nextBell = t0 + 30 + r() * 30;
    this.nextFar = t0 + 45 + r() * 50;

    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    for (const out of [this.dry, this.wet]) {
      out.gain.setValueAtTime(0, t0);
      out.gain.linearRampToValueAtTime(1, t0 + 8);
    }
    this.dry.connect(mix);
    this.wet.connect(hall);

    // Akkorde: trocken, durch den Chor und in den Hall
    this.padBus = ctx.createGain();
    this.send(this.padBus, this.dry, 0.42);
    this.send(this.padBus, this.wet, 0.7);
    this.chorus(this.padBus, this.dry, 0.55);

    // Linie und Glocken: fast nur als Echo und Hall, sie kommen von weit her
    const echoIn = ctx.createGain();
    const echoOut = ctx.createGain();
    this.echo(echoIn, echoOut);
    this.send(echoOut, this.dry, 0.5);
    this.send(echoOut, this.wet, 0.6);
    this.lineBus = ctx.createGain();
    this.send(this.lineBus, this.dry, 0.32);
    this.send(this.lineBus, this.wet, 0.8);
    this.lineBus.connect(echoIn);
    this.bellBus = ctx.createGain();
    this.send(this.bellBus, this.dry, 0.12);
    this.send(this.bellBus, this.wet, 1);
    this.send(this.bellBus, echoIn, 0.5);

    // Der Wind ist Rauschen, aus dem zwei wandernde Filter je ein schmales Band herausschneiden
    const wind = ctx.createBufferSource();
    wind.buffer = noise;
    wind.loop = true;
    this.windLow = this.band(170, 0.9);
    this.windHigh = this.band(1500, 1.4);
    this.windLowLevel = ctx.createGain();
    this.windHighLevel = ctx.createGain();
    this.windLowLevel.gain.value = 0.2 * style.wind;
    this.windHighLevel.gain.value = 0.012 * style.wind;
    wind.connect(this.windLow).connect(this.windLowLevel);
    wind.connect(this.windHigh).connect(this.windHighLevel);
    for (const level of [this.windLowLevel, this.windHighLevel]) {
      level.connect(this.dry);
      this.send(level, this.wet, 0.25);
    }
    wind.start(t0, r() * noise.duration);
    this.sources.add(wind);

    this.droneMidi = wrapInto(this.tonic, 33);
    this.startDrone(t0);
  }

  private send(from: AudioNode, to: AudioNode, level: number) {
    const gain = this.ctx.createGain();
    gain.gain.value = level;
    from.connect(gain).connect(to);
  }

  private band(frequency: number, q: number) {
    return filter(this.ctx, 'bandpass', frequency, q);
  }

  /** Links und rechts je ein kurzes, langsam schwankendes Echo: Das macht die Akkorde breit und lässt sie leicht schweben wie alte Bandmaschinen. */
  private chorus(from: AudioNode, to: AudioNode, level: number) {
    const { ctx } = this;
    const merge = ctx.createChannelMerger(2);
    [[0.017, 0.13, 0.0041], [0.023, 0.19, 0.0035]].forEach(([delay, rate, depth], side) => {
      const line = ctx.createDelay(0.1);
      line.delayTime.value = delay;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rate;
      const amount = ctx.createGain();
      amount.gain.value = depth;
      lfo.connect(amount).connect(line.delayTime);
      lfo.start();
      this.sources.add(lfo);
      from.connect(line).connect(merge, 0, side);
    });
    this.send(merge, to, level);
  }

  /** Ein langes Echo, das zwischen links und rechts wandert und dabei dunkler wird. */
  private echo(input: AudioNode, output: AudioNode) {
    const { ctx } = this;
    const merge = ctx.createChannelMerger(2);
    const left = ctx.createDelay(4);
    const right = ctx.createDelay(4);
    left.delayTime.value = 1.37;
    right.delayTime.value = 2.11;
    const dark = filter(ctx, 'lowpass', 1500, 0.7);
    input.connect(left);
    left.connect(dark).connect(right);
    this.send(right, left, 0.42);
    left.connect(merge, 0, 0);
    right.connect(merge, 0, 1);
    merge.connect(output);
  }

  private startDrone(t: number) {
    const { ctx } = this;
    const lowpass = filter(ctx, 'lowpass', 230, 1.8);
    const amp = ctx.createGain();
    amp.gain.value = 0.05;
    lowpass.connect(amp);
    amp.connect(this.dry);
    this.send(amp, this.wet, 0.12);

    const f = midiToHz(this.droneMidi);
    // Ungleich laut und kaum verstimmt: Zwei gleiche Sägezähne löschen sich im Takt der Schwebung aus, das wäre ein Pumpen
    for (const [type, ratio, cents, level] of [['sawtooth', 1, -2, 1], ['sawtooth', 1, 2, 0.55], ['sine', 0.5, 0, 1]] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.automationRate = 'k-rate';
      osc.detune.automationRate = 'k-rate';
      osc.frequency.value = f * ratio;
      osc.detune.value = cents;
      const gain = ctx.createGain();
      gain.gain.value = level;
      osc.connect(gain).connect(lowpass);
      osc.start(t);
      this.sources.add(osc);
      this.droneOscillators.push(osc);
    }
    // Sie atmet und öffnet sich, viel langsamer als jeder Akkord
    this.lfo(0.11, 0.008, amp.gain, t);
    this.lfo(0.037, 80, lowpass.frequency, t);
  }

  private lfo(rate: number, depth: number, param: AudioParam, t: number) {
    const { ctx } = this;
    const osc = ctx.createOscillator();
    osc.frequency.value = rate;
    const amount = ctx.createGain();
    amount.gain.value = depth;
    osc.connect(amount).connect(param);
    osc.start(t);
    this.sources.add(osc);
  }

  /** Über Minuten steigt und fällt die Spannung, sonst klänge jeder Moment wie jeder andere. */
  private tide(t: number): number {
    const a = Math.sin((t * Math.PI * 2) / 210 + this.tidePhase[0]);
    const b = Math.sin((t * Math.PI * 2) / 97 + this.tidePhase[1]);
    return 0.5 + 0.32 * a + 0.18 * b;
  }

  private oscillator(type: OscillatorType, t: number, stop: number): OscillatorNode {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.automationRate = 'k-rate';
    osc.detune.automationRate = 'k-rate';
    osc.start(t);
    osc.stop(stop);
    this.sources.add(osc);
    osc.onended = () => this.sources.delete(osc);
    return osc;
  }

  schedule(until: number) {
    for (;;) {
      const t = Math.min(this.nextChord, this.nextBell, this.nextFar);
      if (t >= until) return;
      if (t === this.nextChord) this.chord(t);
      else if (t === this.nextBell) this.bell(t);
      else this.far(t);
    }
  }

  private chord(t: number) {
    const r = this.rChord;
    const tide = this.tide(t);
    this.index = this.played === 0 ? 0 : this.mood.next[this.index][Math.floor(r() * this.mood.next[this.index].length)];
    const [root, voicing] = this.mood.chords[this.index];
    const base = wrapInto(this.tonic + root, 45);
    const hold = 24 + r() * 18;
    const attack = 8 + r() * 7;
    const release = 14 + r() * 8;
    const end = t + hold + 3;
    this.pitches = voicing.map((semitones) => base + semitones);
    this.log?.(t, `Akkord +${root} auf ${base}, ${Math.round(hold)} s, Spannung ${tide.toFixed(2)}`);
    voicing.forEach((semitones, voice) => {
      // Von unten nach oben kommen die Stimmen nacheinander: Der Akkord blüht auf
      const start = t + voice * (0.5 + r() * 1.5);
      this.pad(start, end, attack, release, base + semitones, PAD_LEVELS[voice] * lerp(0.6, 1.15, tide), tide, PAD_PANS[voice]);
    });

    // Der tiefe Ton gleitet zum neuen Grundton, in Sekunden, wie etwas sehr Schweres
    let bass = wrapInto(this.tonic + root, 33);
    if (bass - this.droneMidi > 6) bass -= 12;
    else if (this.droneMidi - bass > 6) bass += 12;
    this.droneMidi = bass;
    for (const [i, osc] of this.droneOscillators.entries()) osc.frequency.setTargetAtTime(midiToHz(bass) * (i === 2 ? 0.5 : 1), t, 3.5);

    this.windLow.frequency.linearRampToValueAtTime(120 + r() * 180, t + hold);
    this.windHigh.frequency.linearRampToValueAtTime(900 + r() * 1500, t + hold);
    this.windLowLevel.gain.linearRampToValueAtTime((0.14 + r() * 0.16) * this.style.wind, t + hold);
    this.windHighLevel.gain.linearRampToValueAtTime((0.006 + r() * 0.012) * this.style.wind, t + hold);

    if (this.played > 1 && r() < (0.2 + 0.35 * tide) * this.style.lines) this.line(t + 5 + r() * 5, end, tide);
    if (tide > 0.45 && r() < 0.45) this.glass(t + 4 + r() * 8, end + 6);
    this.played++;
    // Manchmal bleibt nur der tiefe Ton: Stille gehört dazu
    this.nextChord = t + hold + (this.played > 2 && r() < 0.18 ? 10 + r() * 16 : 0);
  }

  private pad(t: number, end: number, attack: number, release: number, midi: number, level: number, open: number, pan: number) {
    const { ctx, rChord: r } = this;
    const f = midiToHz(midi);
    const stop = end + release;
    const closed = Math.max(f * 1.1, 140);
    const peak = Math.min(f * lerp(2, 6, open), 3200);
    const first = filter(ctx, 'lowpass', closed, 0.6);
    const second = filter(ctx, 'lowpass', closed, 1.3);
    for (const lowpass of [first, second]) {
      lowpass.frequency.setValueAtTime(closed, t);
      lowpass.frequency.exponentialRampToValueAtTime(peak, t + attack * 1.4);
      lowpass.frequency.exponentialRampToValueAtTime(closed * 1.3, stop);
    }
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(level, t + attack);
    amp.gain.setValueAtTime(level, end);
    amp.gain.setTargetAtTime(0, end, release / 4);
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    first.connect(second).connect(amp).connect(panner).connect(this.padBus);

    const spread = lerp(9, 5, (midi - 45) / 40);
    for (const [type, cents, gain] of [['sawtooth', -spread, 1], ['sawtooth', spread, 1], ['square', 0, 0.4]] as const) {
      const osc = this.oscillator(type, t, stop);
      osc.frequency.value = f;
      wander(osc.detune, t, stop, cents, 2.5, r);
      if (gain === 1) osc.connect(first);
      else {
        const quiet = ctx.createGain();
        quiet.gain.value = gain;
        osc.connect(quiet).connect(first);
      }
    }
  }

  /** Eine einsame Linie, wie auf einem Band mit dem Finger gezogen: Die Töne gleiten ineinander, das Vibrato kommt erst spät. */
  private line(t: number, end: number, tide: number) {
    const { ctx, rChord: r } = this;
    const pool: number[] = [];
    for (const pitch of this.pitches) for (let o = -12; o <= 36; o += 12) if (pitch + o >= 62 && pitch + o <= 79 && !pool.includes(pitch + o)) pool.push(pitch + o);
    if (pool.length < 2) return;
    pool.sort((a, b) => a - b);
    let place = pool.reduce((best, pitch, i) => (Math.abs(pitch - this.lastLineNote) < Math.abs(pool[best] - this.lastLineNote) ? i : best), 0);

    const notes: { midi: number; at: number; length: number }[] = [];
    let at = t;
    const wanted = 3 + Math.floor(r() * 3);
    for (let n = 0; n < wanted; n++) {
      const length = n === 0 ? 6 + r() * 4 : 3.5 + r() * 5;
      if (at + length > end) break;
      notes.push({ midi: pool[place], at, length });
      at += length;
      const moved = place + (r() < 0.55 ? -1 : 1) * (r() < 0.75 ? 1 : 2);
      place = moved < 0 || moved >= pool.length ? (place === 0 ? 1 : place - 1) : moved;
    }
    if (notes.length < 2) return;
    const last = notes[notes.length - 1];
    const finish = last.at + last.length;
    const stop = finish + 10;
    this.lastLineNote = last.midi;
    this.log?.(t, `Linie ${notes.map((note) => note.midi).join(' ')}`);

    const lowpass = filter(ctx, 'lowpass', 800, 1.6);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    const panner = ctx.createStereoPanner();
    panner.pan.value = (r() - 0.5) * 0.7;
    lowpass.connect(amp).connect(panner).connect(this.lineBus);

    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = 4.2 + r() * 1.1;
    const vibratoDepth = ctx.createGain();
    vibratoDepth.gain.setValueAtTime(0, t);
    vibrato.connect(vibratoDepth);
    vibrato.start(t);
    vibrato.stop(stop);
    this.sources.add(vibrato);
    vibrato.onended = () => this.sources.delete(vibrato);

    const oscillators = [this.oscillator('sawtooth', t, stop), this.oscillator('sawtooth', t, stop), this.oscillator('triangle', t, stop)];
    oscillators[0].detune.value = -4;
    oscillators[1].detune.value = 4;
    const level = 0.09 + 0.04 * tide;
    for (const osc of oscillators) {
      osc.frequency.setValueAtTime(midiToHz(notes[0].midi), t);
      vibratoDepth.connect(osc.detune);
      osc.connect(lowpass);
    }
    lowpass.frequency.setValueAtTime(midiToHz(notes[0].midi), t);
    for (const [n, note] of notes.entries()) {
      const f = midiToHz(note.midi);
      for (const osc of oscillators) if (n > 0) osc.frequency.setTargetAtTime(f, note.at, 0.32);
      amp.gain.setTargetAtTime(level, note.at, n === 0 ? 1.1 : 0.7);
      amp.gain.setTargetAtTime(level * 0.55, note.at + note.length * 0.5, note.length * 0.32);
      lowpass.frequency.setTargetAtTime(Math.min(f * lerp(2.6, 4.2, tide), 3400), note.at, 0.9);
      lowpass.frequency.setTargetAtTime(f * 1.4, note.at + note.length * 0.45, note.length * 0.35);
      vibratoDepth.gain.setTargetAtTime(0, note.at, 0.15);
      vibratoDepth.gain.setTargetAtTime(13, note.at + note.length * 0.4, note.length * 0.18);
    }
    // Am Ende sackt sie ab, wie ein Finger, der das Band verlässt
    amp.gain.setTargetAtTime(0, finish, 1.7);
    for (const osc of oscillators) osc.frequency.setTargetAtTime(midiToHz(last.midi) * 0.982, finish - 0.5, 2.2);
  }

  /** Zwei hohe, fast gleiche Sinustöne: kaltes Licht über allem, kaum zu hören. */
  private glass(t: number, end: number) {
    const { ctx, rChord: r } = this;
    const pitch = this.pitches[1 + Math.floor(r() * (this.pitches.length - 1))];
    const f = midiToHz(wrapInto(pitch, 84));
    const stop = end + 12;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(0.012, t + 7);
    amp.gain.setTargetAtTime(0, end, 3);
    amp.connect(this.bellBus);
    for (const cents of [-2.5, 2.5]) {
      const osc = this.oscillator('sine', t, stop);
      osc.frequency.value = f;
      osc.detune.value = cents;
      osc.connect(amp);
    }
  }

  private bell(t: number) {
    const { ctx, rBell: r } = this;
    if (this.pitches.length) {
      const low = r() < 0.3;
      const midi = wrapInto(this.pitches[Math.floor(r() * this.pitches.length)], low ? 57 : 69);
      const level = low ? 0.22 : 0.13;
      const decay = (low ? 15 : 9) + r() * 5;
      const panner = ctx.createStereoPanner();
      panner.pan.value = (r() - 0.5) * 1.5;
      panner.connect(this.bellBus);
      this.log?.(t, `Glocke ${midi}`);
      for (const [ratio, volume, length] of BELL) {
        const osc = this.oscillator('sine', t, t + decay * length + 0.5);
        osc.frequency.value = midiToHz(midi) * ratio;
        const amp = ctx.createGain();
        amp.gain.setValueAtTime(0, t);
        amp.gain.linearRampToValueAtTime(level * volume, t + 0.02);
        amp.gain.setTargetAtTime(0, t + 0.02, (decay * length) / 5);
        osc.connect(amp).connect(panner);
      }
    }
    this.nextBell = t + (25 + r() * 55) * this.style.bells;
  }

  /** Etwas Fernes draußen in der Dunkelheit. Es bleibt an seinem Ort: Wer den Kopf dreht, hört es auf der anderen Seite. */
  private far(t: number) {
    const r = this.rFar;
    const angle = r() * Math.PI * 2;
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = Math.cos(angle) * this.right.x + Math.sin(angle) * this.right.z;
    panner.connect(this.wet);
    this.send(panner, this.dry, 0.1);
    const until = r() < 0.6 ? this.horn(t, panner, r) : this.thunder(t, panner, r);
    this.farAway.push({ pan: panner, x: Math.cos(angle), z: Math.sin(angle), until });
    this.nextFar = t + 70 + r() * 110;
  }

  private horn(t: number, out: AudioNode, r: () => number): number {
    const { ctx } = this;
    const midi = wrapInto(this.tonic + (r() < 0.3 ? 7 : 0), 38);
    const attack = 3 + r() * 2.5, hold = 3 + r() * 4, release = 6 + r() * 4;
    const end = t + attack + hold;
    const stop = end + release * 1.4;
    this.log?.(t, `Horn ${midi}`);
    const lowpass = filter(ctx, 'lowpass', 170, 1.2);
    lowpass.frequency.setValueAtTime(170, t);
    lowpass.frequency.exponentialRampToValueAtTime(620, t + attack);
    lowpass.frequency.exponentialRampToValueAtTime(190, stop);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(0.06, t + attack);
    amp.gain.setValueAtTime(0.06, end);
    amp.gain.setTargetAtTime(0, end, release / 4);
    lowpass.connect(amp).connect(out);
    for (const cents of [-7, 0, 8]) {
      const osc = this.oscillator('sawtooth', t, stop);
      osc.frequency.setValueAtTime(midiToHz(midi), t);
      osc.frequency.setTargetAtTime(midiToHz(midi) * 0.975, end, release / 2);
      osc.detune.value = cents;
      osc.connect(lowpass);
    }
    return stop;
  }

  private thunder(t: number, out: AudioNode, r: () => number): number {
    const { ctx } = this;
    const length = 6 + r() * 5;
    const stop = t + length * 1.5;
    this.log?.(t, 'Donner');
    const rumble = ctx.createBufferSource();
    rumble.buffer = this.noise;
    rumble.loop = true;
    const lowpass = filter(ctx, 'lowpass', 520, 0.7);
    lowpass.frequency.setValueAtTime(520, t);
    lowpass.frequency.exponentialRampToValueAtTime(70, t + length);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(0.28, t + 0.35);
    amp.gain.setTargetAtTime(0, t + 0.35, length / 4);
    rumble.connect(lowpass).connect(amp).connect(out);
    rumble.start(t, r() * 8);
    rumble.stop(stop);
    this.sources.add(rumble);
    rumble.onended = () => this.sources.delete(rumble);

    const body = this.oscillator('sine', t, stop);
    body.frequency.setValueAtTime(58, t);
    body.frequency.exponentialRampToValueAtTime(34, t + length * 0.6);
    const bodyAmp = ctx.createGain();
    bodyAmp.gain.setValueAtTime(0, t);
    bodyAmp.gain.linearRampToValueAtTime(0.05, t + 0.2);
    bodyAmp.gain.setTargetAtTime(0, t + 0.2, length / 5);
    body.connect(bodyAmp).connect(out);
    return stop;
  }

  /** Wo die fernen Klänge gerade zu hören sind, hängt daran, wohin der Kopf schaut. */
  listen(rightX: number, rightZ: number, now: number) {
    this.right = { x: rightX, z: rightZ };
    for (let i = this.farAway.length - 1; i >= 0; i--) {
      const far = this.farAway[i];
      if (now > far.until) this.farAway.splice(i, 1);
      else far.pan.pan.setTargetAtTime(far.x * rightX + far.z * rightZ, now, 0.08);
    }
  }

  release() {
    const now = this.ctx.currentTime;
    this.dry.gain.cancelScheduledValues(now);
    this.wet.gain.cancelScheduledValues(now);
    this.dry.gain.setTargetAtTime(0, now, 0.8);
    this.wet.gain.setTargetAtTime(0, now, 0.8);
    setTimeout(() => {
      for (const source of this.sources) source.stop();
      this.dry.disconnect();
      this.wet.disconnect();
    }, 6000);
  }
}

export class Music {
  private readonly master: GainNode;
  private readonly muffle: BiquadFilterNode;
  private readonly mix: GainNode;
  private readonly hall: AudioNode;
  private readonly noise: AudioBuffer;
  private piece: Piece | null = null;
  private nextSchedule = 0;
  private nextListen = 0;
  private sleeping = 0;
  private muffled = 0;

  constructor(private readonly ctx: BaseAudioContext, private readonly log?: (at: number, text: string) => void) {
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.mix = ctx.createGain();
    this.muffle = filter(ctx, 'lowpass', 15000, 0.5);
    // Kein Kompressor, der pumpen könnte: Bei so langsamer Musik genügt eine weiche Grenze für die seltenen Spitzen
    const limit = ctx.createWaveShaper();
    limit.curve = softLimit();
    this.mix.connect(this.muffle).connect(limit).connect(this.master).connect(ctx.destination);

    const convolver = ctx.createConvolver();
    convolver.buffer = hallResponse(ctx);
    const clean = filter(ctx, 'highpass', 90, 0.7);
    // Der Browser gleicht den Hall für weißes Rauschen aus. Dieser Raum ist dunkel, seine Kraft liegt also genau dort, wo die Musik spielt, und er käme viel zu laut.
    const hallLevel = ctx.createGain();
    hallLevel.gain.value = HALL_LEVEL;
    clean.connect(convolver).connect(hallLevel).connect(this.mix);
    this.hall = clean;

    // Weißes Rauschen hat keine Naht, die man hören könnte: Es lässt sich ohne Weiteres im Kreis abspielen
    this.noise = ctx.createBuffer(2, ctx.sampleRate * 11, ctx.sampleRate);
    const r = mulberry(0x77a1d3);
    for (let channel = 0; channel < 2; channel++) {
      const data = this.noise.getChannelData(channel);
      for (let i = 0; i < data.length; i++) data[i] = r() * 2 - 1;
    }
  }

  /** Ein neues Stück zum Seed. Das alte verklingt von selbst, der Hall läuft weiter. */
  begin(seed: number, planet: PlanetId = 'slate') {
    this.piece?.release();
    this.piece = new Piece(this.ctx, this.mix, this.hall, this.noise, seed, planet, this.log);
    this.nextSchedule = 0;
  }

  /** Plant das Stück bis zu diesem Zeitpunkt. Beim Rendern geschieht das einmal für die ganze Länge. */
  schedule(until: number) {
    this.piece?.schedule(until);
  }

  start() {
    clearTimeout(this.sleeping);
    const { ctx } = this;
    if (ctx instanceof AudioContext) void ctx.resume();
    const gain = this.master.gain;
    gain.cancelScheduledValues(ctx.currentTime);
    gain.setTargetAtTime(LEVEL, ctx.currentTime, FADE_IN / 3);
  }

  stop() {
    const { ctx } = this;
    const gain = this.master.gain;
    gain.cancelScheduledValues(ctx.currentTime);
    gain.setTargetAtTime(0, ctx.currentTime, 0.5);
    if (ctx instanceof AudioContext) this.sleeping = window.setTimeout(() => void ctx.suspend(), 2500);
  }

  /** Einmal je Bild, mit der Blickrichtung auf dem Boden. */
  update(forwardX: number, forwardZ: number) {
    const now = this.ctx.currentTime;
    if (now >= this.nextSchedule) {
      this.nextSchedule = now + 2;
      this.piece?.schedule(now + LOOKAHEAD);
    }
    if (now >= this.nextListen) {
      this.nextListen = now + 0.1;
      const length = Math.hypot(forwardX, forwardZ) || 1;
      this.piece?.listen(-forwardZ / length, forwardX / length, now);
    }
  }

  /** In der Höhle bleibt die Musik draußen: 0 im Freien, 1 tief drinnen. */
  setMuffle(amount: number) {
    if (amount === this.muffled) return;
    this.muffled = amount;
    this.muffle.frequency.setTargetAtTime(amount === 0 ? 15000 : lerp(1100, 340, amount), this.ctx.currentTime, 1.1);
    this.mix.gain.setTargetAtTime(lerp(1, 0.75, amount), this.ctx.currentTime, 1.1);
  }
}
