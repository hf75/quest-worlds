"""Erzeugt die Felsen des Mars: kantig gebrochener, vom Wind rund geschliffener Basalt statt Schieferplatten.

Dieselbe Aufteilung wie tools/blender/build_rocks.py, damit der Streuplan weiter passt:
Splitter 0-7, Brocken 8-13, große Blöcke 14-18, einfache Fassung der Brocken 19-24.

Aufruf:  python tools/mars/build_mars_rocks.py
Schreibt nach public/assets/mars/rocks.
"""
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "assets" / "mars" / "rocks"


def icosphere(subdivisions):
    t = (1.0 + 5.0 ** 0.5) / 2.0
    v = np.array([[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
                  [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]], np.float64)
    f = np.array([[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
                  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]])
    for _ in range(subdivisions):
        verts = list(v)
        memo = {}

        def middle(a, b):
            key = (min(a, b), max(a, b))
            if key not in memo:
                memo[key] = len(verts)
                verts.append((verts[a] + verts[b]) / 2.0)
            return memo[key]

        faces = []
        for a, b, c in f:
            ab, bc, ca = middle(a, b), middle(b, c), middle(c, a)
            faces += [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]
        v = np.array(verts)
        f = np.array(faces)
    return v / np.linalg.norm(v, axis=1, keepdims=True), f


def bumps(d, r, count, freq):
    """Glatte Unebenheit auf der Kugel: eine Summe von Wellen in zufälligen Richtungen."""
    out = np.zeros(len(d))
    for i in range(count):
        axis = r.normal(size=3)
        axis /= np.linalg.norm(axis)
        out += np.sin(d @ axis * freq * (1.0 + 0.5 * i) + r.uniform(0, 6.28)) / (1.0 + 0.6 * i)
    return out / 2.2


def rock(seed, subdivisions, planes, rounding, flat, dents):
    """Ein Fels aus einer Kugel: gebrochen an ein paar Ebenen, die Kanten vom Wind gerundet, mit Löchern wie in Blasenbasalt."""
    r = np.random.default_rng(seed)
    d, f = icosphere(subdivisions)
    n = r.normal(size=(planes, 3))
    n /= np.linalg.norm(n, axis=1, keepdims=True)
    h = r.uniform(0.62, 0.98, planes)
    dots = d @ n.T
    radius = np.min(np.where(dots > 0.02, h[None, :] / np.maximum(dots, 0.02), 9.0), axis=1)
    radius = np.minimum(radius, 1.15)
    radius = radius * (1.0 - rounding) + np.mean(radius) * rounding
    radius *= 1.0 + 0.1 * bumps(d, r, 5, 3.2) + 0.035 * bumps(d, r, 6, 9.0)

    depth = np.zeros(len(d))
    for _ in range(dents):
        at = r.normal(size=3)
        at /= np.linalg.norm(at)
        size = r.uniform(0.09, 0.26)
        depth += r.uniform(0.04, 0.12) * np.exp(-np.sum((d - at) ** 2, axis=1) / (size * size))
    radius *= 1.0 - depth

    p = d * radius[:, None]
    # Breiter als hoch und unten abgeschnitten: Er liegt, er balanciert nicht
    p *= np.array([r.uniform(0.5, 0.9), flat * r.uniform(0.7, 1.15), r.uniform(0.5, 0.9)])
    floor = -0.12
    below = p[:, 1] < floor
    p[below, 1] = floor + (p[below, 1] - floor) * 0.15
    p[:, 1] += 0.12

    # Normalen: etwas Kante soll bleiben, sonst wirkt er wie geknetet
    a, b, c = p[f[:, 0]], p[f[:, 1]], p[f[:, 2]]
    face = np.cross(b - a, c - a)
    face /= np.maximum(np.linalg.norm(face, axis=1, keepdims=True), 1e-9)
    smooth = np.zeros_like(p)
    for i in range(3):
        np.add.at(smooth, f[:, i], face)
    smooth /= np.maximum(np.linalg.norm(smooth, axis=1, keepdims=True), 1e-9)

    ao = np.clip(0.3 + 0.7 * np.clip((p[:, 1] - 0.02) / 0.4, 0, 1), 0, 1) * (1.0 - np.clip(depth * 4.0, 0, 0.55))
    verts = []
    for tri, fn in zip(f, face):
        for i in tri:
            nrm = fn * 0.62 + smooth[i] * 0.38
            nrm /= np.linalg.norm(nrm)
            verts.append((*p[i], *nrm, ao[i]))
    return np.array(verts, np.float32)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    shapes = []
    data = []
    start = 0

    def add(name, kind, verts):
        nonlocal start
        shapes.append({"name": name, "kind": kind, "start": start, "count": len(verts)})
        data.append(verts)
        start += len(verts)

    for i in range(8):
        add(f"splitter_{i}", "shard", rock(100 + i, 1, 6, 0.05, 0.8, 0))
    for i in range(6):
        add(f"brocken_{i}", "slab", rock(200 + i, 3, 7, 0.08, 0.78, 16))
    for i in range(5):
        add(f"block_{i}", "fin", rock(300 + i, 3, 8, 0.08, 0.95, 22))
    for i in range(6):
        add(f"brocken_fern_{i}", "slabFar", rock(200 + i, 1, 7, 0.08, 0.78, 0))

    (OUT / "rocks.bin").write_bytes(np.vstack(data).tobytes())
    (OUT / "rocks.json").write_text(json.dumps({"stride": 7, "shapes": shapes}, indent=2))
    print(f"{len(shapes)} Formen, {start // 3} Dreiecke, {start * 28 / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
