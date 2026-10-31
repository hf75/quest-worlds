"""Misst eine Aufnahme der Musik und zeichnet ihr Spektrogramm. Hören kann das Werkzeug nicht, aber Übersteuerung, Lautstärkeverlauf und Klangverteilung sieht es.

    python tools/dev/music_analyze.py previews/world_musik_welt1.wav
"""
import sys
import wave

import numpy as np
from PIL import Image


def db(x):
    return 20 * np.log10(np.maximum(x, 1e-9))


def rms(x):
    return float(np.sqrt(np.mean(x ** 2)))


def band(left, right, rate, low, high):
    """Anteil eines Frequenzbands an der ganzen Aufnahme, abschnittsweise gerechnet."""
    size = 1 << 15
    total = inside = 0.0
    window = np.hanning(size)
    for start in range(0, len(left) - size, size):
        for x in (left, right):
            spectrum = np.abs(np.fft.rfft(x[start:start + size] * window)) ** 2
            freqs = np.fft.rfftfreq(size, 1 / rate)
            total += spectrum.sum()
            inside += spectrum[(freqs >= low) & (freqs < high)].sum()
    return inside / max(total, 1e-30)


def spectrogram(mono, rate, out, height=512):
    size = 8192
    width = 1400
    hop = max(1, (len(mono) - size) // width)
    window = np.hanning(size)
    freqs = np.fft.rfftfreq(size, 1 / rate)
    edges = np.geomspace(28, min(14000, rate / 2 - 1), height + 1)
    image = np.zeros((height, width))
    for x in range(width):
        frame = mono[x * hop:x * hop + size]
        if len(frame) < size:
            break
        power = np.abs(np.fft.rfft(frame * window)) ** 2
        for y in range(height):
            mask = (freqs >= edges[y]) & (freqs < edges[y + 1])
            image[height - 1 - y, x] = power[mask].mean() if mask.any() else power[np.searchsorted(freqs, edges[y])]
    level = 10 * np.log10(np.maximum(image, 1e-12))
    level = np.clip((level - (level.max() - 75)) / 75, 0, 1)
    pixels = np.stack([np.clip(level * 2.2, 0, 1), np.clip(level * 2.2 - 0.8, 0, 1), np.clip(level * 2.5 - 1.6, 0, 1) * 0.9 + (1 - level) * 0.08], axis=-1)
    Image.fromarray((pixels * 255).astype(np.uint8)).save(out)


def main(path):
    with wave.open(path) as w:
        rate = w.getframerate()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768
    left, right = data[0::2], data[1::2]
    mono = (left + right) / 2
    side = (left - right) / 2

    print(f'{len(left) / rate:.0f} s bei {rate} Hz')
    print(f'Spitze {db(np.abs(data).max()):.1f} dBFS, Mittel {db(rms(data)):.1f} dBFS, Gleichanteil {mono.mean():.5f}')
    settled = data[rate * 16:]
    print(f'Ohne Einblenden: Mittel {db(rms(settled)):.1f} dBFS, Abstand Spitze zu Mittel {db(np.abs(settled).max()) - db(rms(settled)):.1f} dB')
    print(f'Stereo: Seitenanteil {db(rms(side)) - db(rms(mono)):.1f} dB, Korrelation {np.corrcoef(left, right)[0, 1]:.2f}')

    print('Lautstärke je 20 s (dBFS): ' + ' '.join(f'{db(rms(mono[i:i + rate * 20])):.0f}' for i in range(0, len(mono) - rate * 20 + 1, rate * 20)))

    bands = [(0, 60), (60, 150), (150, 500), (500, 2000), (2000, 8000), (8000, 24000)]
    print('Anteile: ' + ', '.join(f'{low}-{high} Hz {10 * np.log10(max(band(left, right, rate, low, high), 1e-12)):.1f} dB' for low, high in bands))
    print(f'Über 150 Hz bleiben {10 * np.log10(max(band(left, right, rate, 150, 24000), 1e-12)):.1f} dB: Das ist grob, was kleine Lautsprecher im Kopfband noch wiedergeben')

    out = path.rsplit('.', 1)[0] + '_spektrum.png'
    spectrogram(mono, rate, out)
    print(f'Spektrogramm (28 Hz bis 14 kHz, Zeit nach rechts): {out}')


if __name__ == '__main__':
    main(sys.argv[1])
