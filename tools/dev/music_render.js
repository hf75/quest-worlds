// Rendert die Musik schneller als in Echtzeit in eine Datei, zum Messen und zum Anhören am PC. Server siehe vite.music.config.ts, dann in der Konsole:
//   (await import('/tools/dev/music_render.js')).render({ seed: 1, seconds: 240 })
// Das Ergebnis steht danach in window.__music. Gemessen wird die Datei mit tools/dev/music_analyze.py.
export async function render({ seed = 1, planet = 'slate', seconds = 240, name = `music_${planet}${seed}` } = {}) {
  window.__music = null;
  const { Music, MUSIC_RATE: rate } = await import('/src/music.ts');
  const events = [];
  const ctx = new OfflineAudioContext(2, Math.floor(seconds * rate), rate);
  const t0 = performance.now();
  const music = new Music(ctx, (at, text) => events.push(`${at.toFixed(1).padStart(6)}  ${text}`));
  const setupMs = performance.now() - t0;
  music.begin(seed, planet);
  music.schedule(seconds);
  music.start();
  const t1 = performance.now();
  const buffer = await ctx.startRendering();
  const renderMs = performance.now() - t1;

  const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
  const wav = new DataView(new ArrayBuffer(44 + left.length * 4));
  const text = (at, s) => { for (let i = 0; i < s.length; i++) wav.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF');
  wav.setUint32(4, 36 + left.length * 4, true);
  text(8, 'WAVEfmt ');
  wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true);
  wav.setUint16(22, 2, true);
  wav.setUint32(24, rate, true);
  wav.setUint32(28, rate * 4, true);
  wav.setUint16(32, 4, true);
  wav.setUint16(34, 16, true);
  text(36, 'data');
  wav.setUint32(40, left.length * 4, true);
  for (let i = 0; i < left.length; i++) {
    wav.setInt16(44 + i * 4, Math.max(-1, Math.min(1, left[i])) * 32767, true);
    wav.setInt16(46 + i * 4, Math.max(-1, Math.min(1, right[i])) * 32767, true);
  }
  const answer = await fetch(`/__musik?name=${name}`, { method: 'POST', body: wav.buffer });
  window.__music = { setupMs, renderMs, realtimeFactor: (seconds * 1000) / renderMs, saved: answer.status, events };
  return window.__music;
}
