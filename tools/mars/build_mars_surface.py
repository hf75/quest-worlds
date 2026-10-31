"""Erzeugt die Marsoberfläche: dieselben Kacheln wie tools/terrain, nur aus Staub, Geröll und flachem Gestein.

    meso     256 m   Staubdecke mit Rippeln, darunter aufragende Gesteinsplatten, Geröll, Sonnenschatten der Steine
    detail     8 m   Sand, Kies und Kiesel für die Nähe

Die Sonne steht auf dem Mars immer an derselben Stelle (MARS_SUN in src/planets.ts). Darum tragen die Kacheln die langen Schatten
der Steine schon in sich: im Alphakanal der Albedo. Der Wind weht entlang z, die Rippeln laufen also entlang x, wie die Dünen in world.ts.

Aufruf:  python tools/mars/build_mars_surface.py
Schreibt nach public/assets/mars.
"""
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "terrain"))
from build_terrain import encode_normal, save_rgba, sheets, stamp_contact  # noqa: E402
from tileable import (blur, directional_shadow, horizon_ao, linear_to_srgb, slopes, smoothstep,  # noqa: E402
                      spectral_noise, voronoi)

OUT = ROOT / "public" / "assets" / "mars"
SUN_AZIMUTH = np.radians(-90.0)
SUN_ELEVATION = np.radians(11.0)

# Lineare Grundfarben. Der Staub ist viel heller als Schiefer, das Gestein darunter dunkel und nur rostig überzogen.
DUST = np.array([0.33, 0.165, 0.085], np.float32)
DUST_PALE = np.array([0.40, 0.235, 0.135], np.float32)
DUST_DEEP = np.array([0.25, 0.115, 0.06], np.float32)
ROCK = np.array([0.105, 0.078, 0.066], np.float32)
ROCK_RUST = np.array([0.20, 0.105, 0.066], np.float32)
GRAVEL = np.array([0.085, 0.065, 0.058], np.float32)


def log(msg, t0):
    print(f"[{time.time() - t0:6.1f}s] {msg}", flush=True)


def scatter(h, ao, dust, dx, L):
    """Steine überall, am dichtesten am Gestein und in Mulden. Auf dem Mars liegt fast nichts ganz frei von Geröll."""
    n = h.shape[0]
    r = np.random.default_rng(1900)
    sx, sy = slopes(blur(h, 4.0), dx)
    clump = smoothstep(-0.9, 1.1, spectral_noise(n, 3.4, 1901, fmin=3))
    likes = np.clip(0.12 + 1.2 * (1.0 - ao) + 0.5 * (1.0 - dust) + 0.55 * clump, 0.0, 1.0) * (np.hypot(sx, sy) < 0.55)

    def pick(count, kind_lo, kind_hi, scale_lo, scale_hi, sigma, tilt):
        px = r.integers(0, n, count * 3)
        py = r.integers(0, n, count * 3)
        keep = r.random(count * 3) < likes[py, px]
        px, py = px[keep][:count], py[keep][:count]
        m = len(px)
        scale = np.clip(np.exp(r.normal(np.log(np.sqrt(scale_lo * scale_hi)), sigma, m)), scale_lo, scale_hi)
        k = (0.55 * scale / dx).astype(np.int64)
        y = np.minimum.reduce([h[py, px], h[(py + k) % n, px], h[(py - k) % n, px], h[py, (px + k) % n], h[py, (px - k) % n]])
        return np.column_stack((
            px * dx, py * dx, y - 0.05 * scale, r.random(m) * np.pi * 2,
            np.arctan(-sy[py, px]) + r.normal(0.0, tilt, m),
            np.arctan(sx[py, px]) + r.normal(0.0, tilt, m),
            scale, r.integers(kind_lo, kind_hi, m),
        )).astype(np.float32)

    return np.vstack((pick(42000, 0, 8, 0.05, 0.5, 0.6, 0.25), pick(1700, 8, 14, 0.3, 2.2, 0.6, 0.22)))


def with_rocks(h, rocks, dx):
    """Der Boden samt Steinen als Höhenfeld: nur um ihre Schatten daraus zu rechnen."""
    n = h.shape[0]
    out = h.copy()
    for x, z, y, _, _, _, s, _ in rocks:
        radius = s * 0.6
        k = int(radius / dx) + 1
        if k < 2:
            continue
        ax = np.arange(-k, k + 1)
        d2 = ((ax * dx)[None, :] ** 2 + (ax * dx)[:, None] ** 2) / (radius * radius)
        dome = y + 0.85 * s * np.sqrt(np.clip(1.0 - d2, 0.0, 1.0))
        rows = (int(z / dx) + ax) % n
        cols = (int(x / dx) + ax) % n
        here = np.ix_(rows, cols)
        out[here] = np.where(d2 < 1.0, np.maximum(out[here], dome), out[here])
    return out


def build_meso(n, L, t0):
    dx = L / n
    hummock = spectral_noise(n, 4.4, 1101, fmin=2) * 0.2

    # Flache Sedimentplatten, wie sie der Rover in Gale fotografiert hat: gerade Bruchkanten, trockene Risse
    stack, grain = sheets(n, L, [
        (21.0, 8.0, 0.16, 0.56, 0.008, 0.008, 0.05),
        (8.0, 3.0, 0.085, 0.52, 0.012, 0.012, 0.05),
        (3.0, 1.2, 0.045, 0.48, 0.016, 0.016, 0.05),
    ], 1200)
    log("Gesteinsplatten", t0)
    jag_x = spectral_noise(n, 3.6, 1103, fmin=12) * 0.09
    jag_y = spectral_noise(n, 3.6, 1104, fmin=12) * 0.09
    edge, _, _, _, _ = voronoi(n, L, 2.6, 2.1, 1105, jag_x, jag_y)
    cracks = np.exp(-edge / 0.05) * smoothstep(-0.4, 0.7, spectral_noise(n, 2.8, 1106, fmin=4))
    rock = hummock * 0.85 + stack - 0.055 * cracks
    log("Risse", t0)

    # Der Staub deckt das meiste zu. Wind hat ihn in feine Rippeln gelegt, stellenweise deutlich, stellenweise kaum.
    ripple_gate = smoothstep(-0.7, 0.9, spectral_noise(n, 3.4, 1107, fmin=3))
    ripples = spectral_noise(n, 1.4, 1108, fmin=70, fmax=560, stretch=(14.0, 1.0)) * 0.016 * ripple_gate
    dust_h = hummock + spectral_noise(n, 3.8, 1109, fmin=3) * 0.11 + ripples
    dust_h += np.percentile(rock - dust_h, 74.0)
    h = np.maximum(rock, dust_h)
    dust = smoothstep(0.012, -0.004, rock - dust_h)

    # Kies, zu klein für eigene Steinmodelle, aber groß genug für einen Schatten
    gravel_gate = smoothstep(-0.5, 0.9, spectral_noise(n, 3.2, 1110, fmin=4)) * (0.45 + 0.55 * (1.0 - dust))
    cobbles = smoothstep(1.55, 2.25, spectral_noise(n, 1.0, 1111, fmin=230, fmax=1100)) * gravel_gate
    h = blur(h + cobbles * 0.055, 0.55)
    log(f"Höhe zusammengesetzt, Staubanteil {dust.mean() * 100:.0f} %", t0)

    sx, sy = slopes(h, dx)
    ao_near = horizon_ao(h, dx, 0.8, dirs=12)
    ao_far = horizon_ao(blur(h, 3.0), dx, 9.0, dirs=10)
    ao = np.clip(ao_near ** 0.85 * (0.84 + 0.16 * ao_far), 0.0, 1.0)
    log("Verdeckung", t0)

    rocks = scatter(h, ao, dust, dx, L)
    rocks.tofile(OUT / "rocks_meso.bin")
    ao = stamp_contact(ao, rocks, dx, L)
    log(f"{len(rocks)} Steine verteilt", t0)

    # Die langen Schatten der tief stehenden Sonne, samt der Steine, die darauf liegen
    sun = directional_shadow(with_rocks(h, rocks, dx), dx, SUN_AZIMUTH, SUN_ELEVATION, 20.0, softness=0.03)
    log(f"Sonnenschatten, beleuchtet {sun.mean() * 100:.0f} %", t0)

    # Farbe
    hue = np.clip(spectral_noise(n, 3.2, 1120, fmin=2) * 0.34 + 0.5, 0, 1)[..., None]
    deep = np.clip(spectral_noise(n, 3.0, 1121, fmin=3) * 0.36 + 0.42, 0, 1)[..., None]
    floury = (1.0 + spectral_noise(n, 2.4, 1122, fmin=10) * 0.05)[..., None]
    dust_col = (DUST * (1 - hue) + DUST_PALE * hue) * (1 - deep * 0.55) + DUST_DEEP * deep * 0.55
    dust_col = dust_col * floury
    rust = np.clip(grain * 1.6 + spectral_noise(n, 2.6, 1123, fmin=5) * 0.28 + 0.42, 0, 1)[..., None]
    rock_col = (ROCK * (1 - rust) + ROCK_RUST * rust) * (1.0 + grain * 0.7)[..., None]
    # Auf den Platten liegt immer ein Hauch Staub, in den Rissen mehr
    film = np.clip(0.18 + 0.5 * cracks + spectral_noise(n, 2.8, 1124, fmin=8) * 0.1, 0, 0.8)[..., None]
    rock_col = rock_col * (1 - film) + dust_col * film
    alb = rock_col * (1 - dust[..., None]) + dust_col * dust[..., None]
    alb = alb * (1 - cobbles[..., None] * 0.85) + GRAVEL * cobbles[..., None] * 0.85

    rough = 0.72 + grain * 0.12
    rough = rough * (1 - dust) + 0.97 * dust
    log("Farbe und Rauheit", t0)

    nx, nz = encode_normal(sx, sy)
    save_rgba(OUT / "meso_nr.png", nx, nz, ao, np.clip(rough, 0.05, 1.0))
    h.astype(np.float16).tofile(OUT / "meso_height.bin")

    size_alb = n // 2
    a = cv2.resize(alb, (size_alb, size_alb), interpolation=cv2.INTER_AREA)
    s = cv2.resize(sun, (size_alb, size_alb), interpolation=cv2.INTER_AREA)
    a_srgb = linear_to_srgb(a)
    save_rgba(OUT / "meso_albedo.png", a_srgb[..., 0], a_srgb[..., 1], a_srgb[..., 2], np.clip(s, 0.0, 1.0))

    walk = cv2.resize(blur(h, 0.5 / dx), (1024, 1024), interpolation=cv2.INTER_AREA).astype(np.float32)
    walk.tofile(OUT / "meso_walk.bin")
    log("Karten geschrieben", t0)
    return {"size": L, "resolution": n, "heightMin": float(h.min()), "heightMax": float(h.max()), "albedoResolution": size_alb}


def build_detail(n, L, t0):
    dx = L / n
    pebbles = smoothstep(1.2, 1.9, spectral_noise(n, 1.0, 1201, fmin=60, fmax=260))
    gravel = smoothstep(1.0, 1.7, spectral_noise(n, 1.0, 1202, fmin=240, fmax=620))
    gate = smoothstep(-0.6, 0.8, spectral_noise(n, 3.0, 1203, fmin=3))
    sand = spectral_noise(n, 1.2, 1204, fmin=500) * 0.00028 + spectral_noise(n, 2.8, 1205, fmin=4, fmax=120) * 0.0022
    ripple = spectral_noise(n, 1.6, 1206, fmin=30, fmax=180, stretch=(9.0, 1.0)) * 0.0011 * (1.0 - gate)
    h = blur(sand + ripple + pebbles * gate * 0.009 + gravel * (0.35 + 0.65 * gate) * 0.0028, 0.6)
    log("Detail-Höhe", t0)

    sx, sy = slopes(h, dx)
    cav = horizon_ao(h, dx, 0.07, dirs=10)
    stones = np.clip(pebbles * gate + 0.6 * gravel * (0.35 + 0.65 * gate), 0, 1)
    tone = spectral_noise(n, 1.0, 1207, fmin=60, fmax=400) * 0.05
    shade = np.clip(0.42 + 0.22 * cav - 0.2 * stones + tone, 0.0, 1.0)
    shade += 0.52 - float(shade.mean())
    rough = np.clip(0.94 - 0.2 * stones, 0.08, 1.0)
    log(f"Detail-Masken, Mittel {shade.mean():.3f} {rough.mean():.3f}", t0)

    nx, nz = encode_normal(sx, sy)
    save_rgba(OUT / "detail_nr.png", nx, nz, np.clip(shade, 0, 1), rough)
    return {"size": L, "resolution": n}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    meta = {"key": {"azimuth": float(SUN_AZIMUTH), "elevation": float(SUN_ELEVATION)}}
    meta["detail"] = build_detail(2048, 8.0, t0)
    meta["meso"] = build_meso(4096, 256.0, t0)
    (OUT / "terrain.json").write_text(json.dumps(meta, indent=2))
    log("fertig", t0)


if __name__ == "__main__":
    main()
