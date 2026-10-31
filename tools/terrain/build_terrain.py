"""Erzeugt die Schieferoberfläche als drei nahtlose Kachelebenen.

    macro   2048 m   sanfte Wellen und lange Schichtstufen, ergibt die Silhouetten
    meso     256 m   Platten, Stufen, Risse, Sediment
    detail     8 m   Spaltflächen, Absplitterungen, Körnung für die Nähe

Aufruf:  python tools/terrain/build_terrain.py [--layers meso,macro,detail] [--meso-n 4096] [--out DIR]
"""
import argparse
import json
import time
from pathlib import Path

import cv2
import numpy as np

from tileable import (blur, hillshade, horizon_ao, linear_to_srgb, slopes, smoothstep,
                      spectral_noise, to_u8, voronoi)

ROOT = Path(__file__).resolve().parents[2]

# Schwaches Hauptlicht aus Richtung des Galaxienkerns, wird im Viewer gleich verwendet.
KEY_AZIMUTH = np.radians(-90.0)  # -z, also dort, wohin man beim Start blickt
KEY_ELEVATION = np.radians(32.0)

# Lineare Grundfarben. Anthrazit (RAL 7016) liegt bei etwa 0.022, 0.031, 0.033.
SLATE_BLUE = np.array([0.034, 0.041, 0.051], np.float32)
SLATE_COAL = np.array([0.033, 0.036, 0.040], np.float32)
SLATE_WARM = np.array([0.058, 0.052, 0.049], np.float32)
SEDIMENT = np.array([0.056, 0.057, 0.061], np.float32)
VEIN = np.array([0.30, 0.31, 0.33], np.float32)


def log(msg, t0):
    print(f"[{time.time() - t0:6.1f}s] {msg}", flush=True)


def save_rgba(path, r, g, b, a=None):
    chans = [to_u8(b, 3), to_u8(g, 2), to_u8(r, 1)]  # OpenCV erwartet BGR(A)
    if a is not None:
        chans.append(to_u8(a, 4))
    cv2.imwrite(str(path), np.dstack(chans), [cv2.IMWRITE_PNG_COMPRESSION, 6])


def encode_normal(sx, sy):
    """Hangneigung als Normalen-xz in 0..1. Der Viewer rechnet daraus wieder Neigungen und addiert die Ebenen."""
    n = np.sqrt(sx * sx + sy * sy + 1.0)
    return -sx / n * 0.5 + 0.5, -sy / n * 0.5 + 0.5


def strata(y_cycles, k, seed, amp_lo, amp_hi, mask_noise, coverage):
    """Schräg ausstreichende Schichten: flacher Anstieg, harte Kante, jede Stufe mit eigener Höhe und Länge.

    k ist die Zahl der Stufen je Kachel. Die Stufennummer läuft modulo k, sonst hätte dieselbe Stufe an der
    gegenüberliegenden Kachelkante eine andere Höhe und man sähe eine Naht.
    """
    ids = np.floor(y_cycles).astype(np.int64)
    t = (y_cycles - ids).astype(np.float32)
    r = np.random.default_rng(seed)
    amp = (r.uniform(amp_lo, amp_hi, k) * r.random(k) ** 1.6).astype(np.float32)
    shift = r.uniform(-1.2, 1.2, k).astype(np.float32)
    ids = ids % k
    mask = smoothstep(-coverage, 0.15 - coverage, mask_noise + shift[ids])
    return (t - 0.5) * amp[ids] * mask


def sheets(n, L, spec, seed):
    """Übereinander liegende Gesteinslagen mit eckigen Umrissen.

    spec: (zelle_x, zelle_y, dicke, bedeckung, neigung, einfallen, zacken). Jede Lage ist ein Voronoi-Muster,
    dessen Zellen vorhanden sind oder fehlen. So entstehen gerade Bruchkanten statt weicher Höhenlinien.
    Das gemeinsame Einfallen legt die Platten schindelartig übereinander.
    """
    h = np.zeros((n, n), np.float32)
    grain = np.zeros((n, n), np.float32)
    for i, (cx, cy, thick, cover, tilt, dip, jag) in enumerate(spec):
        s = seed + i * 11
        # Nur langwellig verbiegen: Kurzwelliges Rauschen macht aus Bruchkanten krümelige Umrisse
        fmin = max(2.0, L / cx)
        wx = spectral_noise(n, 3.6, s + 1, fmin=fmin) * cy * jag
        wy = spectral_noise(n, 3.6, s + 2, fmin=fmin) * cy * jag
        e, cid, ddx, ddy, count = voronoi(n, L, cx, cy, s, wx, wy)
        r = np.random.default_rng(s + 3)
        on = (r.random(count) < cover).astype(np.float32)
        th = (thick * (0.55 + 0.9 * r.random(count))).astype(np.float32)
        tx = r.normal(0, tilt, count).astype(np.float32)
        ty = (dip + r.normal(0, tilt, count)).astype(np.float32)
        tone = r.random(count).astype(np.float32) - 0.5
        layer = on[cid]
        h += layer * (th[cid] + tx[cid] * ddx + ty[cid] * ddy)
        grain += layer * tone[cid] / (i + 1.0)
    return h, grain


def scatter_meso(h, ao, sed_mask, dx, L, out):
    """Verteilt Steine dorthin, wo Schutt liegen bleibt: am Fuß der Stufen und auf dem Sediment."""
    n = h.shape[0]
    r = np.random.default_rng(900)
    sx, sy = slopes(blur(h, 4.0), dx)
    # Hohe Neigung fällt als Standort aus, Rinnen und Stufenfüße ziehen an
    likes = np.clip(0.18 + 1.4 * (1.0 - ao) + 0.55 * sed_mask, 0.0, 1.0) * (np.hypot(sx, sy) < 0.5)

    def pick(count, kind_lo, kind_hi, scale_lo, scale_hi, sigma, tilt):
        px = r.integers(0, n, count * 3)
        py = r.integers(0, n, count * 3)
        keep = r.random(count * 3) < likes[py, px]
        px, py = px[keep][:count], py[keep][:count]
        m = len(px)
        scale = np.clip(np.exp(r.normal(np.log(np.sqrt(scale_lo * scale_hi)), sigma, m)), scale_lo, scale_hi)
        yaw = r.normal(0.0, 0.5, m) + (r.random(m) < 0.5) * np.pi
        # Auf die tiefste Stelle unter dem Stein setzen: Sonst ragt er über Stufenkanten hinaus und scheint zu schweben
        k = (0.55 * scale / dx).astype(np.int64)
        y = np.minimum.reduce([h[py, px], h[(py + k) % n, px], h[(py - k) % n, px], h[py, (px + k) % n], h[py, (px - k) % n]])
        return np.column_stack((
            px * dx, py * dx, y, yaw,
            np.arctan(-sy[py, px]) + r.normal(0.03, tilt, m),
            np.arctan(sx[py, px]) + r.normal(0.0, tilt, m),
            scale, r.integers(kind_lo, kind_hi, m),
        )).astype(np.float32)

    # Art-Nummern entsprechen der Reihenfolge in tools/blender/build_rocks.py
    shards = pick(36000, 0, 8, 0.05, 0.42, 0.55, 0.12)
    slabs = pick(1500, 8, 14, 0.35, 2.6, 0.6, 0.14)

    # Die Felsplatte direkt vor dem Startpunkt ist gesetzt, nicht gewürfelt: Sie gibt dem ersten Blick den Maßstab.
    # Weltposition (-12.5, -10.5), der Startpunkt liegt bei (-16, -2).
    hero_x, hero_z = (-12.5 % L), (-10.5 % L)
    hero_y = h[int(hero_z / dx), int(hero_x / dx)]
    hero = np.array([[hero_x, hero_z, hero_y - 0.15, 0.42, 0.36, -0.20, 3.2, 12]], np.float32)
    rocks = np.vstack((shards, slabs, hero))
    rocks.tofile(out / "rocks_meso.bin")
    return rocks


def stamp_contact(ao, rocks, dx, L):
    """Dunkelt den Boden unter jedem Stein ab. Ohne diesen Kontaktschatten scheinen sie zu schweben."""
    n = ao.shape[0]
    ao = ao.copy()
    for x, z, _, _, _, _, scale, _ in rocks:
        rad = max(scale * 0.8, dx * 1.5)
        k = int(np.ceil(rad * 1.6 / dx))
        if k > 60:
            k = 60
        cx, cy = int(x / dx), int(z / dx)
        ax = np.arange(-k, k + 1)
        d2 = ((ax * dx)[None, :] ** 2 + (ax * dx)[:, None] ** 2) / (rad * rad)
        fall = 1.0 - 0.5 * np.exp(-d2 * 1.6)
        rows = (cy + ax) % n
        cols = (cx + ax) % n
        ao[np.ix_(rows, cols)] *= fall
    return ao


def soft_key_light(h, dx, radius_m):
    """Das Hauptlicht kommt von der ganzen Galaxie, also einer riesigen Fläche. Deshalb Mittelwert über viele Richtungen
    statt einer harten Schattenkante."""
    from tileable import horizon_scan
    radii = []
    r = 1.0
    while r * dx <= radius_m:
        radii.append(r)
        r = max(r + 1, r * 1.3)
    total = np.zeros_like(h)
    count = 0
    for daz in np.radians([-34.0, -17.0, 0.0, 17.0, 34.0]):
        t = horizon_scan(h, dx, KEY_AZIMUTH + daz, radii)
        for el in np.radians([14.0, 28.0, 42.0, 56.0]):
            total += 1.0 - smoothstep(np.tan(el) - 0.08, np.tan(el) + 0.08, t)
            count += 1
    return total / count


def build_meso(n, L, out, t0):
    dx = L / n
    xs = (np.arange(n) * dx).astype(np.float32)
    _, Y = np.meshgrid(xs, xs)

    warp_x = spectral_noise(n, 4.0, 11, fmin=2) * 2.6
    warp_y = spectral_noise(n, 4.0, 12, fmin=2) * 2.6
    jag_x = spectral_noise(n, 3.6, 13, fmin=12) * 0.10
    jag_y = spectral_noise(n, 3.6, 14, fmin=12) * 0.10

    # Lange Schollen: Grundgliederung und breite Risse
    e1, id1, dx1, dy1, c1 = voronoi(n, L, 34.0, 13.0, 21, warp_x * 0.4 + jag_x, warp_y * 0.4 + jag_y)
    r = np.random.default_rng(22)
    off1 = r.normal(0, 0.24, c1).astype(np.float32)
    tx1, ty1 = r.normal(0, 0.009, c1).astype(np.float32), r.normal(0, 0.012, c1).astype(np.float32)
    tint1 = r.random(c1).astype(np.float32)
    slabs = off1[id1] + tx1[id1] * dx1 + ty1[id1] * dy1
    log("Schollen", t0)

    # An Störungen sind die Schichten gegeneinander versetzt
    e3, id3, _, _, c3 = voronoi(n, L, 22.0, 9.0, 24, warp_x * 0.3 + jag_x * 0.8, warp_y * 0.3 + jag_y * 0.8)
    fault = r.random(c3).astype(np.float32)[id3]
    # Kleine Versätze zerlegen die Schichtkanten in kurze, gerade Stücke. Ohne sie laufen sie als weiche Bögen durchs Gelände.
    _, id4, _, _, c4 = voronoi(n, L, 5.5, 2.0, 25, jag_x, jag_y)
    fault = fault + r.random(c4).astype(np.float32)[id4] * 0.11
    cycles = spectral_noise(n, 4.0, 32, fmin=2) * 1.8
    mask_a = spectral_noise(n, 3.6, 33, fmin=3, stretch=(4.0, 1.0))
    mask_b = spectral_noise(n, 3.4, 34, fmin=6, stretch=(4.0, 1.0))
    # Die Zykluszahl muss ganzzahlig bleiben, sonst reißt die Kachel
    ledge_a = strata(Y / L * 36 + cycles + fault, 36, 35, 0.10, 0.50, mask_a, 0.30)
    ledge_b = strata(Y / L * 120 + cycles * 2.0 + fault * 2.0, 120, 36, 0.03, 0.12, mask_b, 0.45)
    log("Schichtstufen", t0)

    # Jede Platte bekommt ihre eigene leichte Neigung. Unter dem flachen Licht wird daraus der facettierte Schiefer-Eindruck.
    stack, grain = sheets(n, L, [
        (15.0, 5.0, 0.20, 0.52, 0.010, 0.012, 0.04),
        (6.0, 2.2, 0.10, 0.50, 0.014, 0.018, 0.04),
        (2.6, 0.95, 0.055, 0.46, 0.018, 0.024, 0.04),
        (1.1, 0.42, 0.028, 0.42, 0.022, 0.030, 0.04),
    ], 500)
    log("Gesteinslagen", t0)

    # Risse: nicht jede Grenze klafft auf
    gate = smoothstep(-0.3, 0.8, spectral_noise(n, 2.8, 31, fmin=5))
    crack1 = np.exp(-e1 / 0.08)
    crack3 = np.exp(-e3 / 0.07) * gate
    cracks = 0.36 * crack1 + 0.16 * crack3

    # Nur sehr langwellig: Weiche Beulen im Meterbereich lassen Fels wie Stoff oder Leder aussehen
    base = spectral_noise(n, 4.6, 41, fmin=2) * 0.40
    rock = base + slabs + ledge_a + ledge_b + stack - cracks

    # Sediment füllt nur die tiefsten Senken, der Fels ragt mit klarer Kante heraus. Der Pegel wird so gewählt,
    # dass ein fester Anteil der Fläche bedeckt ist, unabhängig davon, wie die Lagen gerade ausfallen.
    sediment = base * 0.9 + spectral_noise(n, 3.8, 51, fmin=2) * 0.26 + spectral_noise(n, 3.6, 52, fmin=12) * 0.016
    sediment += np.percentile(rock - sediment, 20.0)
    h = np.maximum(rock, sediment)
    sed_mask = smoothstep(0.012, -0.004, rock - sediment)
    h = blur(h, 0.55)
    log(f"Höhe zusammengesetzt, Sedimentanteil {sed_mask.mean() * 100:.0f} %", t0)
    seam_report("meso", h)

    sx, sy = slopes(h, dx)
    ao_near = horizon_ao(h, dx, 0.8, dirs=16)
    ao_far = horizon_ao(blur(h, 3.0), dx, 9.0, dirs=12)
    # Nicht zu kräftig: Sonst liegen entlang jeder Stufe breite, weiche Striche wie mit Kohle gezogen
    ao = np.clip(ao_near ** 0.75 * (0.78 + 0.22 * ao_far), 0.0, 1.0)
    log("Verdeckung", t0)

    rocks = scatter_meso(h, ao, sed_mask, dx, L, out)
    ao = stamp_contact(ao, rocks, dx, L)
    log(f"{len(rocks)} Steine verteilt", t0)

    # Farbe
    hue = np.clip(spectral_noise(n, 3.0, 61, fmin=3) * 0.42 + 0.5 + (tint1[id1] - 0.5) * 0.18 + grain * 0.9, 0, 1)[..., None]
    value = (1.0 + grain * 1.05 + (tint1[id1] - 0.5) * 0.28 + spectral_noise(n, 2.6, 62, fmin=8) * 0.055)[..., None]
    alb = (SLATE_COAL * (1 - hue) + SLATE_BLUE * hue) * value

    # Rostspuren entlang der Risse, sehr sparsam
    stain = (smoothstep(0.1, 0.9, crack1 + crack3 * 0.6) * smoothstep(0.1, 1.2, spectral_noise(n, 2.6, 63, fmin=10)))[..., None]
    alb = alb * (1 - stain * 0.75) + SLATE_WARM * 1.15 * stain * 0.75

    # Quarzadern quer durch die Platten
    v1 = np.abs(spectral_noise(n, 2.5, 64, fmin=6))
    vein_gate = smoothstep(0.55, 1.1, spectral_noise(n, 3.0, 65, fmin=3))
    # Breit genug für die halbe Albedo-Auflösung, sonst zerfallen die Adern in Punkte
    vein = (smoothstep(0.05, 0.012, v1) * vein_gate)[..., None]
    alb = alb * (1 - vein * 0.42) + VEIN * vein * 0.42

    sed_tone = (0.9 + spectral_noise(n, 2.6, 66, fmin=6) * 0.10)[..., None]
    sm = sed_mask[..., None]
    alb = alb * (1 - sm) + SEDIMENT * sed_tone * sm

    # Spaltflächen glänzen leicht, Sediment gar nicht
    rough = 0.56 + grain * 0.2 + spectral_noise(n, 2.6, 68, fmin=16) * 0.04
    rough = rough * (1 - sed_mask) + 0.9 * sed_mask
    rough = rough * (1 - vein[..., 0]) + 0.28 * vein[..., 0]
    log("Farbe und Rauheit", t0)

    nx, nz = encode_normal(sx, sy)
    save_rgba(out / "meso_nr.png", nx, nz, ao, np.clip(rough, 0.05, 1.0))
    h.astype(np.float16).tofile(out / "meso_height.bin")

    # Albedo reicht in halber Auflösung, Alpha trägt die Sedimentmaske
    size_alb = n // 2 if n > 2048 else n
    a = cv2.resize(alb, (size_alb, size_alb), interpolation=cv2.INTER_AREA) if size_alb != n else alb
    s = cv2.resize(sed_mask, (size_alb, size_alb), interpolation=cv2.INTER_AREA) if size_alb != n else sed_mask
    a_srgb = linear_to_srgb(a)
    save_rgba(out / "meso_albedo.png", a_srgb[..., 0], a_srgb[..., 1], a_srgb[..., 2], np.clip(s, 0.02, 1.0))
    log("Karten geschrieben", t0)

    # Tiefpass fürs Gehen, damit der Kopf nicht jede Kante nachfährt
    walk = cv2.resize(blur(h, 0.5 / dx), (1024, 1024), interpolation=cv2.INTER_AREA).astype(np.float32)
    walk.tofile(out / "meso_walk.bin")

    shade = np.dstack([hillshade(h, dx) * 0.9 + 0.05] * 3)
    pre = shade * (a_srgb if size_alb == n else cv2.resize(a_srgb, (n, n)))
    cv2.imwrite(str(ROOT / "previews" / "meso_top.png"),
                to_u8(np.clip(cv2.resize(pre, (1200, 1200), interpolation=cv2.INTER_AREA)[..., ::-1] * 1.6, 0, 1)))
    crop = int(32.0 / dx)
    cv2.imwrite(str(ROOT / "previews" / "meso_32m.png"),
                to_u8(np.clip(cv2.resize(pre[:crop, :crop], (1000, 1000), interpolation=cv2.INTER_LINEAR)[..., ::-1] * 1.6, 0, 1)))

    return {"size": L, "resolution": n, "heightMin": float(h.min()), "heightMax": float(h.max()), "albedoResolution": size_alb}


def seam_report(name, h):
    """Eine Kachelkante darf nicht größer springen als ein normaler Nachbarschritt."""
    inner = np.abs(np.diff(h, axis=0)).mean()
    across_y = np.abs(h[0, :] - h[-1, :]).mean()
    across_x = np.abs(h[:, 0] - h[:, -1]).mean()
    print(f"    Naht {name}: innen {inner:.4f} m, über z-Kante {across_y:.4f} m, über x-Kante {across_x:.4f} m", flush=True)


def build_macro(n, L, out, t0):
    dx = L / n
    xs = (np.arange(n) * dx).astype(np.float32)
    _, Y = np.meshgrid(xs, xs)

    rolling = spectral_noise(n, 4.2, 101, fmin=2, fmax=64) * 5.5
    warp = spectral_noise(n, 4.2, 102, fmin=2) * 0.8

    # Lange Schichtstufen (Cuesten). Der Anstieg ist flach, die Kante steil, daher die harten Silhouetten.
    k = 11
    y_cycles = Y / L * k + warp
    ids = np.floor(y_cycles).astype(np.int64) % k
    t = (y_cycles - np.floor(y_cycles)).astype(np.float32)
    r = np.random.default_rng(103)
    amp = (r.uniform(4.0, 18.0, k) * r.random(k) ** 0.5).astype(np.float32)
    gate = spectral_noise(n, 4.0, 104, fmin=2, stretch=(5.0, 1.0))
    shift = r.uniform(-0.7, 0.7, k).astype(np.float32)
    mask = smoothstep(-0.9, -0.2, gate + shift[ids])
    ramp = np.where(t < 0.9, t / 0.9, 1.0 - smoothstep(0.9, 1.0, t))
    cuesta = blur((ramp - 0.5) * amp[ids] * mask, 2.5)

    h = rolling + cuesta
    log("Makro-Höhe", t0)
    seam_report("macro", h)

    sx, sy = slopes(h, dx)
    ao = horizon_ao(h, dx, 180.0, dirs=16)
    shadow = soft_key_light(h, dx, 300.0)

    # Große Felsrippen und Blöcke entlang der Stufenkanten, sie zeichnen die Silhouette gegen den Himmel
    r = np.random.default_rng(901)
    steep = np.hypot(*slopes(blur(h, 3.0), dx))
    px = r.integers(0, n, 200000)
    py = r.integers(0, n, 200000)
    # Oberhalb der Kante stehen: Dort ist der Boden schon flacher, die Felsen wachsen aus dem Rand
    ok = (steep[py, px] > 0.10) & (steep[py, px] < 0.5)
    px, py = px[ok], py[ok]
    fins = np.column_stack((
        px[:46] * dx, py[:46] * dx, h[py[:46], px[:46]], r.normal(0.0, 0.3, 46),
        np.zeros(46), np.zeros(46),
        np.clip(np.exp(r.normal(np.log(17.0), 0.45, 46)), 7.0, 46.0),
        r.integers(14, 19, 46),
    )).astype(np.float32)
    m = min(170, len(px) - 46)
    blocks = np.column_stack((
        px[46:46 + m] * dx, py[46:46 + m] * dx, h[py[46:46 + m], px[46:46 + m]], r.normal(0.0, 0.6, m),
        r.normal(0.06, 0.12, m), r.normal(0.0, 0.12, m),
        np.clip(np.exp(r.normal(np.log(4.5), 0.5, m)), 2.2, 13.0),
        r.integers(8, 14, m),
    )).astype(np.float32)
    np.vstack((fins, blocks)).tofile(out / "rocks_macro.bin")

    nx, nz = encode_normal(sx, sy)
    size = 1024
    pack = cv2.resize(np.dstack((nx, nz, np.clip(ao, 0, 1), shadow)), (size, size), interpolation=cv2.INTER_AREA)
    save_rgba(out / "macro_nr.png", pack[..., 0], pack[..., 1], pack[..., 2], pack[..., 3])
    h.astype(np.float16).tofile(out / "macro_height.bin")
    walk = cv2.resize(blur(h, 1.5), (1024, 1024), interpolation=cv2.INTER_AREA).astype(np.float32)
    walk.tofile(out / "macro_walk.bin")

    prev = hillshade(h, dx, elevation=np.radians(20)) * ao
    cv2.imwrite(str(ROOT / "previews" / "macro_top.png"), to_u8(cv2.resize(prev, (1024, 1024))))
    log("Makro-Karten geschrieben", t0)
    return {"size": L, "resolution": n, "normalResolution": size, "heightMin": float(h.min()), "heightMax": float(h.max())}


def build_detail(n, L, out, t0):
    dx = L / n
    # Abblätternde Lagen, von handtellergroß bis fingernagelgroß
    stack, grain = sheets(n, L, [
        (1.7, 0.62, 0.0065, 0.50, 0.0025, 0.006, 0.04),
        (0.75, 0.28, 0.0038, 0.46, 0.0030, 0.009, 0.04),
        (0.32, 0.12, 0.0019, 0.42, 0.0040, 0.012, 0.05),
        (0.13, 0.05, 0.0009, 0.38, 0.0050, 0.015, 0.05),
    ], 700)
    log("Detail-Lagen", t0)

    # Feine Schieferung entlang des Streichens, nur stellenweise, und eine kaum sichtbare Körnung
    line_gate = smoothstep(-0.4, 0.9, spectral_noise(n, 3.2, 205, fmin=3, stretch=(3.0, 1.0)))
    lines = spectral_noise(n, 2.6, 206, fmin=10, stretch=(28.0, 1.0)) * 0.00016 * line_gate
    grit = spectral_noise(n, 2.2, 210, fmin=96) * 0.00006

    # Haarrisse
    wx = spectral_noise(n, 3.6, 201, fmin=4) * 0.012
    wy = spectral_noise(n, 3.6, 202, fmin=4) * 0.012
    e, _, _, _, _ = voronoi(n, L, 0.95, 0.34, 207, wx, wy)
    gate = smoothstep(-0.1, 0.9, spectral_noise(n, 2.6, 208, fmin=5))
    hair = np.exp(-e / 0.0035) * gate

    h = blur(stack + lines + grit - hair * 0.0028, 0.55)
    log("Detail-Höhe", t0)

    sx, sy = slopes(h, dx)
    cav = horizon_ao(h, dx, 0.10, dirs=12)

    # Konvexe Kanten aufhellen, Vertiefungen abdunkeln: das trägt die Form auch bei schwachem Umgebungslicht
    curv = blur(h, 1.0) - blur(h, 5.0)
    edge = smoothstep(0.00015, 0.0016, curv)
    shade = np.clip(0.5 * (0.5 + 0.5 * cav) + 0.22 * edge + grain * 0.10, 0.0, 1.0)

    # Glimmerpunkte: sehr glatte, winzige Flächen, die im Licht aufblitzen
    rng = np.random.default_rng(212)
    specks = (rng.random((n, n), dtype=np.float32) > 0.9975).astype(np.float32)
    specks = blur(specks, 0.6)
    specks = np.clip(specks / specks.max() * 1.6, 0, 1) * smoothstep(-0.2, 0.8, spectral_noise(n, 2.4, 213, fmin=8))
    rough = 0.46 + grain * 0.2 + 0.22 * edge - 0.32 * specks
    log("Detail-Masken", t0)

    nx, nz = encode_normal(sx, sy)
    save_rgba(out / "detail_nr.png", nx, nz, shade, np.clip(rough, 0.08, 1.0))

    prev = hillshade(h, dx, elevation=np.radians(28)) * (0.35 + 0.9 * shade)
    crop = int(2.0 / dx)
    cv2.imwrite(str(ROOT / "previews" / "detail_2m.png"),
                to_u8(np.clip(cv2.resize(prev[:crop, :crop], (800, 800), interpolation=cv2.INTER_LINEAR), 0, 1)))
    log("Detail-Karten geschrieben", t0)
    return {"size": L, "resolution": n}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--layers", default="meso,macro,detail")
    ap.add_argument("--meso-n", type=int, default=4096)
    ap.add_argument("--macro-n", type=int, default=2048)
    ap.add_argument("--detail-n", type=int, default=2048)
    ap.add_argument("--out", default=str(ROOT / "public" / "assets" / "terrain"))
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (ROOT / "previews").mkdir(exist_ok=True)
    meta_path = out / "terrain.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    meta["key"] = {"azimuth": float(KEY_AZIMUTH), "elevation": float(KEY_ELEVATION)}

    t0 = time.time()
    layers = args.layers.split(",")
    if "meso" in layers:
        meta["meso"] = build_meso(args.meso_n, 256.0, out, t0)
    if "macro" in layers:
        meta["macro"] = build_macro(args.macro_n, 2048.0, out, t0)
    if "detail" in layers:
        meta["detail"] = build_detail(args.detail_n, 8.0, out, t0)
    meta_path.write_text(json.dumps(meta, indent=2))
    log("fertig", t0)


if __name__ == "__main__":
    main()
