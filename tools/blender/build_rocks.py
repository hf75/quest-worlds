"""Baut die Felsen in Blender: Splitter, Platten und aufragende Rippen, jeweils aus echten übereinanderliegenden Schieferlagen.

Die Umgebungsverdeckung wird mit Cycles in die Eckpunkte gebacken. So kostet sie auf der Quest nichts.

Aufruf:
  blender --background --factory-startup --python tools/blender/build_rocks.py

Ergebnis: public/assets/rocks/rocks.bin und rocks.json für den Viewer, blender/rocks.blend zum Ansehen und Weiterbearbeiten.
"""
import json
import math
import random
import struct
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]


def polygon(rng, n, rx, ry):
    pts = []
    for i in range(n):
        a = 2 * math.pi * (i + rng.uniform(-0.28, 0.28)) / n
        r = rng.uniform(0.72, 1.0)
        pts.append((math.cos(a) * r * rx, math.sin(a) * r * ry))
    return pts


def clip(pts, nx, ny, d):
    """Polygon an einer Geraden abschneiden. Daraus entstehen die geraden Bruchkanten."""
    out = []
    for i, p in enumerate(pts):
        q = pts[(i + 1) % len(pts)]
        dp = nx * p[0] + ny * p[1] - d
        dq = nx * q[0] + ny * q[1] - d
        if dp <= 0:
            out.append(p)
        if (dp <= 0) != (dq <= 0):
            t = dp / (dp - dq)
            out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
    return out if len(out) >= 3 else pts


def jag(pts, rng, seg, amp):
    """Lange Kanten leicht ausbrechen, ohne dass der Umriss rund wird."""
    out = []
    for i, p in enumerate(pts):
        q = pts[(i + 1) % len(pts)]
        out.append(p)
        length = math.hypot(q[0] - p[0], q[1] - p[1])
        steps = int(length / seg)
        if steps < 1:
            continue
        nx, ny = -(q[1] - p[1]) / length, (q[0] - p[0]) / length
        for k in range(1, steps + 1):
            t = k / (steps + 1)
            off = rng.uniform(-amp, amp)
            out.append((p[0] + (q[0] - p[0]) * t + nx * off, p[1] + (q[1] - p[1]) * t + ny * off))
    return out


def centroid(pts):
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


def add_layer(bm, pts, z0, thick, tx, ty):
    """Eine Gesteinslage: Polygon, unten plan, oben leicht geneigt."""
    bottom = [bm.verts.new((x, y, z0)) for x, y in pts]
    top = [bm.verts.new((x, y, z0 + thick + tx * x + ty * y)) for x, y in pts]
    bm.faces.new(top)
    bm.faces.new(list(reversed(bottom)))
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((bottom[i], bottom[j], top[j], top[i]))


def lay_stack(rng, footprint, layers, height, jag_seg, jag_amp, shrink):
    """Stapelt Lagen. Jede ist um gerade Bruchkanten kleiner als die darunter, so entstehen die Stufen."""
    bm = bmesh.new()
    weights = [rng.uniform(0.4, 1.0) ** 2 + 0.12 for _ in range(layers)]
    scale = height / sum(weights)
    z = -0.06 * height
    pts = footprint
    for w in weights:
        thick = w * scale
        rough = jag(pts, rng, jag_seg, jag_amp)
        add_layer(bm, rough, z, thick, rng.uniform(-0.035, 0.035), rng.uniform(-0.035, 0.035))
        z += thick
        cx, cy = centroid(pts)
        next_pts = pts
        for _ in range(rng.randint(1, 3)):
            a = rng.uniform(0, 2 * math.pi)
            nx, ny = math.cos(a), math.sin(a)
            reach = max(nx * (p[0] - cx) + ny * (p[1] - cy) for p in next_pts)
            next_pts = clip(next_pts, nx, ny, nx * cx + ny * cy + reach * rng.uniform(1.0 - shrink, 1.0 - shrink * 0.25))
        if len(next_pts) >= 3:
            pts = next_pts
    return bm


def make_shard(rng):
    n = rng.randint(4, 7)
    rx = 1.0
    ry = rng.uniform(0.42, 0.85)
    fp = polygon(rng, n, rx, ry)
    return lay_stack(rng, fp, rng.randint(1, 3), rng.uniform(0.09, 0.26), 9.0, 0.0, 0.45)


def make_slab(rng):
    """Liefert die Platte zweimal: fein für die Nähe, stark vereinfacht mit gleichem Umriss für die Ferne."""
    n = rng.randint(6, 9)
    rx = 1.0
    ry = rng.uniform(0.45, 0.8)
    fp = polygon(rng, n, rx, ry)
    height = rng.uniform(0.3, 0.72)
    near = lay_stack(rng, fp, rng.randint(4, 9), height, 0.26, 0.025, 0.34)
    far = lay_stack(rng, fp, 2, height, 9.0, 0.0, 0.16)
    return near, far


def make_fin(rng):
    """Steil gestellte Schieferlagen, wie eine aus dem Boden ragende Rippe. Einheit: 1 = Höhe."""
    bm = bmesh.new()
    sheets = rng.randint(9, 18)
    length = rng.uniform(0.55, 1.2)
    offs = -0.07
    centre = sheets * 0.5
    seed = rng.uniform(0, 100)
    for s in range(sheets):
        thick = rng.uniform(0.006, 0.045)
        taper = 1.0 - abs(s - centre) / (centre + 1.0)
        height = rng.uniform(0.45, 1.0) * (0.3 + 0.7 * taper)
        half = length * rng.uniform(0.55, 1.0) * (0.45 + 0.55 * taper)
        steps = rng.randint(7, 16)
        pts = [(-half, -0.25), (half, -0.25)]
        for k in range(steps + 1):
            t = 1.0 - k / steps
            x = -half + 2 * half * t
            profile = math.sqrt(max(1.0 - (x / half) ** 2, 0.0))
            jagged = rng.uniform(0.72, 1.0) if k % 2 == 0 else rng.uniform(0.5, 0.92)
            pts.append((x, height * (0.12 + 0.88 * profile) * jagged))
        # Polygon liegt in der Ebene (x, Höhe), die Dicke geht in y
        y0, y1 = offs, offs + thick
        front = [bm.verts.new((p[0], y0, p[1])) for p in pts]
        back = [bm.verts.new((p[0], y1, p[1])) for p in pts]
        bm.faces.new(list(reversed(front)))
        bm.faces.new(back)
        m = len(pts)
        for i in range(m):
            j = (i + 1) % m
            bm.faces.new((front[i], front[j], back[j], back[i]))
        offs += thick
        seed += 1
    # Alle Lagen fallen in dieselbe Richtung ein, das erst macht daraus Gestein statt loser Bretter
    dip = math.radians(rng.uniform(16, 30))
    c, sn = math.cos(dip), math.sin(dip)
    for v in bm.verts:
        y, z = v.co.y, v.co.z
        v.co.y = y * c - z * sn
        v.co.z = y * sn + z * c
    return bm


def to_object(bm, name):
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for p in mesh.polygons:
        p.use_smooth = False
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def setup_cycles():
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 48
    scene.cycles.use_denoising = False
    scene.cycles.bake_type = 'AO'
    scene.render.bake.target = 'VERTEX_COLORS'
    scene.render.bake.use_selected_to_active = False
    scene.render.bake.margin = 0
    world = bpy.data.worlds.new("Himmel")
    world.color = (1, 1, 1)
    scene.world = world
    # Boden, damit die Unterseiten verdeckt werden
    bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 0, 0))
    bpy.context.active_object.name = "Boden"
    return scene


def bake_ao(obj, distance):
    """Verdeckung je Ecke backen. Die Flächen bleiben plan, die Tönung läuft trotzdem weich in die Kanten."""
    bpy.context.scene.world.light_settings.distance = distance
    mesh = obj.data
    mesh.color_attributes.new(name="AO", type='FLOAT_COLOR', domain='CORNER')
    mesh.color_attributes.active_color_index = 0
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.bake(type='AO')


def export(objects, out):
    out.mkdir(parents=True, exist_ok=True)
    meta = []
    data = bytearray()
    offset = 0
    for kind, obj, radius in objects:
        mesh = obj.data
        mesh.calc_loop_triangles()
        colors = mesh.color_attributes["AO"].data
        count = 0
        for tri in mesh.loop_triangles:
            n = tri.normal
            for li, vi in zip(tri.loops, tri.vertices):
                co = mesh.vertices[vi].co
                ao = colors[li].color[0]
                # Blender z-oben wird Viewer y-oben
                data += struct.pack("<7f", co.x, co.z, -co.y, n.x, n.z, -n.y, ao)
                count += 1
        meta.append({"name": obj.name, "kind": kind, "start": offset, "count": count, "radius": radius})
        offset += count
    (out / "rocks.bin").write_bytes(bytes(data))
    (out / "rocks.json").write_text(json.dumps({"stride": 7, "shapes": meta}, indent=1))
    print("Felsen:", len(meta), "Formen,", offset // 3, "Dreiecke")


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    setup_cycles()
    rng = random.Random(77)
    objects = []
    # Die Reihenfolge ist die Art-Nummer in tools/terrain/build_terrain.py: 8 Splitter, 6 Platten, 5 Rippen.
    # Die vereinfachten Platten stehen dahinter, damit sich an den Nummern nichts ändert.
    far_slabs = []
    for i in range(8):
        objects.append(("shard", to_object(make_shard(rng), f"splitter_{i}"), 1.2))
    for i in range(6):
        near, far = make_slab(rng)
        objects.append(("slab", to_object(near, f"platte_{i}"), 1.5))
        far_slabs.append(("slabFar", to_object(far, f"platte_fern_{i}"), 1.5))
    for i in range(5):
        objects.append(("fin", to_object(make_fin(rng), f"rippe_{i}"), 1.6))
    objects.extend(far_slabs)

    # Vor dem Backen nebeneinander aufstellen: Übereinander stehend würden sie sich gegenseitig verdecken.
    # Der Abstand ist auch für den Blick in Blender gedacht.
    for idx, (kind, obj, radius) in enumerate(objects):
        obj.location.x = (idx % 7) * 4.0
        obj.location.y = -(idx // 7) * 4.0
    bpy.context.view_layer.update()

    for kind, obj, radius in objects:
        bake_ao(obj, 0.5 if kind != "fin" else 0.35)

    blend = ROOT / "blender" / "rocks.blend"
    blend.parent.mkdir(exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(blend))

    export(objects, ROOT / "public" / "assets" / "rocks")


main()
