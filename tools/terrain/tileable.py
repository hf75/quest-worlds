"""Bausteine für nahtlos kachelbare Karten. Alles ist periodisch über die Kachelkante."""
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from scipy import fft as sfft
from scipy.spatial import cKDTree


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def spectral_noise(n, beta, seed, fmin=1.0, fmax=None, stretch=(1.0, 1.0)):
    """Rauschen mit Spektrum 1/f^beta, Mittel 0, Standardabweichung 1.

    stretch > 1 zieht die Strukturen entlang dieser Achse (x, y) in die Länge.
    """
    r = np.random.default_rng(seed)
    fy = sfft.fftfreq(n, 1.0 / n)[:, None] * stretch[1]
    fx = sfft.rfftfreq(n, 1.0 / n)[None, :] * stretch[0]
    f = np.sqrt(fx * fx + fy * fy)
    keep = f >= fmin
    if fmax is not None:
        keep &= f <= fmax
    amp = np.zeros_like(f)
    amp[keep] = f[keep] ** (-beta / 2.0)
    spec = amp * (r.standard_normal(f.shape) + 1j * r.standard_normal(f.shape))
    out = sfft.irfft2(spec, s=(n, n), workers=-1).astype(np.float32)
    out -= out.mean()
    out /= out.std()
    return out


def blur(a, sigma_px):
    """Periodische Gaußunschärfe über die FFT."""
    n = a.shape[0]
    fy = sfft.fftfreq(n)[:, None]
    fx = sfft.rfftfreq(n)[None, :]
    g = np.exp(-2.0 * (np.pi * sigma_px) ** 2 * (fx * fx + fy * fy))
    return sfft.irfft2(sfft.rfft2(a, workers=-1) * g, s=a.shape, workers=-1).astype(np.float32)


def slopes(h, dx):
    sx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) / (2.0 * dx)
    sy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) / (2.0 * dx)
    return sx, sy


def voronoi(n, L, cell_x, cell_y, seed, warp_x=None, warp_y=None, jitter=0.9):
    """Periodisches Voronoi-Muster mit länglichen Zellen.

    Liefert (kantenabstand in Metern, zellen-id, dx zum Zellzentrum, dy zum Zellzentrum).
    Das Stauchen der Metrik ergibt die entlang des Streichens gezogenen Platten.
    """
    r = np.random.default_rng(seed)
    nx, ny = max(1, round(L / cell_x)), max(1, round(L / cell_y))
    gx, gy = np.meshgrid(np.arange(nx), np.arange(ny))
    px = ((gx + 0.5 + (r.random(gx.shape) - 0.5) * jitter) * (L / nx)).ravel() % L
    py = ((gy + 0.5 + (r.random(gy.shape) - 0.5) * jitter) * (L / ny)).ravel() % L
    # Metrik so stauchen, dass die Zellen rund werden. Der Abstand zählt dann in Einheiten von cell_y.
    sx = cell_y / cell_x
    tree = cKDTree(np.column_stack((px * sx, py)), boxsize=(L * sx, L))

    dx = L / n
    xs = (np.arange(n) * dx).astype(np.float32)
    X, Y = np.meshgrid(xs, xs)
    if warp_x is not None:
        X = (X + warp_x) % L
        Y = (Y + warp_y) % L
    q = np.column_stack((np.clip(X.ravel() * sx, 0, np.nextafter(L * sx, 0)),
                         np.clip(Y.ravel(), 0, np.nextafter(L, 0))))
    d, idx = tree.query(q, k=2, workers=-1)
    edge = ((d[:, 1] - d[:, 0]) * 0.5).reshape(n, n).astype(np.float32)
    cid = idx[:, 0].reshape(n, n)
    ddx = ((X - px[cid] + L / 2) % L - L / 2).astype(np.float32)
    ddy = ((Y - py[cid] + L / 2) % L - L / 2).astype(np.float32)
    return edge, cid, ddx, ddy, len(px)


def horizon_scan(h, dx, azimuth, radii_px):
    """Größter Horizont-Tangens in Blickrichtung azimuth (Bogenmaß, 0 = +x, pi/2 = +y)."""
    ca, sa = np.cos(azimuth), np.sin(azimuth)
    best = np.full_like(h, -1e9)
    for r in radii_px:
        ox, oy = int(round(ca * r)), int(round(sa * r))
        dist = np.hypot(ox, oy) * dx
        if dist == 0:
            continue
        best = np.maximum(best, (np.roll(h, (-oy, -ox), (0, 1)) - h) / dist)
    return best


def horizon_ao(h, dx, radius_m, dirs=16):
    """Himmelssichtbarkeit aus den Horizonten in alle Richtungen. 1 = frei, 0 = verdeckt."""
    radii = []
    r = 1.0
    while r * dx <= radius_m:
        radii.append(r)
        r = max(r + 1, r * 1.5)

    def one(i):
        t = np.maximum(horizon_scan(h, dx, 2.0 * np.pi * i / dirs, radii), 0.0)
        return 1.0 / (1.0 + t * t)

    with ThreadPoolExecutor(max_workers=min(dirs, 12)) as pool:
        total = np.zeros_like(h)
        for part in pool.map(one, range(dirs)):
            total += part
    return total / dirs


def directional_shadow(h, dx, azimuth, elevation, radius_m, softness=0.12):
    """Weicher Schatten für ein Licht in fester Richtung. 1 = beleuchtet."""
    radii = []
    r = 1.0
    while r * dx <= radius_m:
        radii.append(r)
        r = max(r + 1, r * 1.25)
    t = horizon_scan(h, dx, azimuth, radii)
    te = np.tan(elevation)
    return 1.0 - smoothstep(te - softness, te + softness, t)


def linear_to_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1.0 / 2.4) - 0.055)


def to_u8(a, seed=1):
    """8 Bit mit Dither, damit in dunklen Verläufen und flachen Normalen keine Stufen entstehen."""
    r = np.random.default_rng(seed)
    return np.clip(a * 255.0 + r.random(a.shape, dtype=np.float32), 0, 255).astype(np.uint8)


def hillshade(h, dx, azimuth=np.radians(315), elevation=np.radians(28)):
    sx, sy = slopes(h, dx)
    n = np.sqrt(sx * sx + sy * sy + 1.0)
    lx, ly, lz = np.cos(elevation) * np.cos(azimuth), np.cos(elevation) * np.sin(azimuth), np.sin(elevation)
    return np.clip((-sx * lx - sy * ly + lz) / n, 0.0, 1.0)
