"""Schneidet die Aufnahme von film.js zum fertigen Film: Überblendungen zwischen den Szenen, darunter ein einziges Musikstück.

    python tools/dev/film_schnitt.py <Ordner mit shot00, shot01, ... und music.wav> <Ausgabe.mp4>

Für X: 1920x1080, 60 Bilder/s, H.264 und AAC, mit dem Index am Dateianfang. Keine Metadaten, die etwas über die Herkunft verraten.
"""
import subprocess
import sys
from pathlib import Path

FPS = 60
# Überblendung nach jeder Szene, in Sekunden. Der Wechsel vom Schiefer zum Mars geht durch Schwarz, genau beim Akkordwechsel und der Glocke in der Musik.
DISSOLVES = [(0.8, "fade"), (0.8, "fade"), (0.8, "fade"), (1.8, "fadeblack"), (0.8, "fade"), (0.8, "fade"), (0.8, "fade"), (0.8, "fade")]
FADE_IN = 1.8
FADE_OUT = 3.2
# Die Musik ist leise gemischt. Allein im Feed muss sie sich behaupten können: So liegt sie bei -14 LUFS.
GAIN_DB = 4.0


def main(folder, output):
    folder = Path(folder)
    shots = sorted(p for p in folder.iterdir() if p.is_dir() and p.name.startswith("shot"))
    lengths = [len(list(p.glob("*.jpg"))) / FPS for p in shots]
    print("Szenen:", ", ".join(f"{s:.2f} s" for s in lengths))
    assert len(shots) == len(DISSOLVES) + 1, "Anzahl der Szenen passt nicht zu den Überblendungen"

    inputs = []
    # Die Einzelbilder sind JPEG, also Vollbereich und BT.601. Ein Video muss Fernsehbereich und BT.709 sein, sonst wäre Schwarz im Abspieler grau.
    filters = []
    for i, shot in enumerate(shots):
        inputs += ["-framerate", str(FPS), "-i", str(shot / "%05d.jpg")]
        filters.append(f"[{i}:v]scale=1920:1080:flags=lanczos:in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p,setsar=1,fps={FPS},settb=AVTB[v{i}]")

    label = "v0"
    offset = lengths[0]
    for i, (dissolve, kind) in enumerate(DISSOLVES):
        offset -= dissolve
        filters.append(f"[{label}][v{i + 1}]xfade=transition={kind}:duration={dissolve}:offset={offset:.4f}[x{i}]")
        label = f"x{i}"
        offset += lengths[i + 1]
    total = offset
    print(f"Gesamtlänge {total:.2f} s")
    filters.append(f"[{label}]fade=t=in:st=0:d={FADE_IN},fade=t=out:st={total - FADE_OUT:.3f}:d={FADE_OUT}[video]")

    audio_index = len(shots)
    inputs += ["-i", str(folder / "music.wav")]
    filters.append(
        f"[{audio_index}:a]atrim=0:{total:.3f},volume={GAIN_DB}dB,alimiter=limit=0.89:attack=20:release=400:level=disabled,"
        f"afade=t=in:st=0:d=2.2,afade=t=out:st={total - FADE_OUT - 0.4:.3f}:d={FADE_OUT + 0.4}[audio]"
    )

    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "warning", "-stats", "-y", *inputs,
        "-filter_complex", ";".join(filters), "-map", "[video]", "-map", "[audio]",
        "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-maxrate", "25M", "-bufsize", "50M",
        "-profile:v", "high", "-level", "4.2", "-pix_fmt", "yuv420p", "-r", str(FPS),
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
        "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
        "-map_metadata", "-1", "-map_chapters", "-1", "-fflags", "+bitexact", "-movflags", "+faststart",
        str(output),
    ], check=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
