#!/usr/bin/env python3
"""Generate the Android launcher, adaptive and splash icons from the Nysiris
mixnet motif (the same motif as `scripts/gen-icons.py`).

Dependency-free (stdlib zlib/struct only), so it runs anywhere Python 3 does.

    python3 scripts/gen-android-icons.py

Writes into web/android/app/src/main/res:
  mipmap-<density>/ic_launcher.png            legacy square icon
  mipmap-<density>/ic_launcher_round.png      legacy round icon
  mipmap-<density>/ic_launcher_foreground.png adaptive foreground (safe zone)
  drawable*/splash.png                        splash images

The adaptive background colour lives in res/values/ic_launcher_background.xml.
"""
from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "web" / "android" / "app" / "src" / "main" / "res"

BG = (11, 13, 18, 255)
CYAN = (76, 201, 240, 255)
LIGHT = (230, 241, 255, 255)
DIM = (139, 211, 255, 255)
CLEAR = (0, 0, 0, 0)

ENTRY = (92, 256)
MIX = [(196, 150), (256, 256), (316, 362)]
DEST = (420, 256)

# density name -> legacy launcher px (mdpi baseline 48)
DENSITIES = [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)]

SPLASHES = {
    "drawable": (480, 320),
    "drawable-port-mdpi": (320, 480),
    "drawable-port-hdpi": (480, 800),
    "drawable-port-xhdpi": (720, 1280),
    "drawable-port-xxhdpi": (960, 1600),
    "drawable-port-xxxhdpi": (1280, 1920),
    "drawable-land-mdpi": (480, 320),
    "drawable-land-hdpi": (800, 480),
    "drawable-land-xhdpi": (1280, 720),
    "drawable-land-xxhdpi": (1600, 960),
    "drawable-land-xxxhdpi": (1920, 1280),
}


def _segment_points(a, b, width, s, size):
    out = []
    ax, ay = a[0] * s, a[1] * s
    bx, by = b[0] * s, b[1] * s
    half = (width * s) / 2.0
    minx, maxx = sorted((ax, bx))
    miny, maxy = sorted((ay, by))
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy or 1.0
    for y in range(max(0, int(miny - half) - 1), min(size, int(maxy + half) + 2)):
        for x in range(max(0, int(minx - half) - 1), min(size, int(maxx + half) + 2)):
            px, py = x + 0.5, y + 0.5
            t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
            cx, cy = ax + t * dx, ay + t * dy
            if (px - cx) ** 2 + (py - cy) ** 2 <= half * half:
                out.append((x, y))
    return out


def _circle_points(center, radius, s, size):
    out = []
    cx, cy = center[0] * s, center[1] * s
    radius = radius * s
    r2 = radius * radius
    for y in range(max(0, int(cy - radius) - 1), min(size, int(cy + radius) + 2)):
        for x in range(max(0, int(cx - radius) - 1), min(size, int(cx + radius) + 2)):
            if (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r2:
                out.append((x, y))
    return out


def motif_layer(size):
    """Transparent RGBA `size`x`size` surface with the motif filling it (512 design)."""
    s = size / 512.0
    surface = [[CLEAR for _ in range(size)] for _ in range(size)]

    def paint(points, color):
        for x, y in points:
            if 0 <= x < size and 0 <= y < size:
                surface[y][x] = color

    for a, b in ((ENTRY, MIX[0]), (MIX[0], MIX[1]), (MIX[1], MIX[2]), (MIX[2], DEST)):
        paint(_segment_points(a, b, 12, s, size), DIM)
    for a, b in ((ENTRY, MIX[2]), (MIX[2], MIX[1]), (MIX[1], MIX[0]), (MIX[0], DEST)):
        paint(_segment_points(a, b, 6, s, size), DIM)
    paint(_circle_points(ENTRY, 34, s, size), CYAN)
    paint(_circle_points(DEST, 34, s, size), CYAN)
    for node in MIX:
        paint(_circle_points(node, 24, s, size), LIGHT)
    return surface


def new_canvas(w, h, bg):
    return [[bg for _ in range(w)] for _ in range(h)]


def paste(canvas, layer, ox, oy, canvas_w, canvas_h):
    size = len(layer)
    for y in range(size):
        ty = oy + y
        if ty < 0 or ty >= canvas_h:
            continue
        row = canvas[ty]
        lrow = layer[y]
        for x in range(size):
            tx = ox + x
            if 0 <= tx < canvas_w and lrow[x][3] != 0:
                row[tx] = lrow[x]


def mask_circle(canvas, size):
    cx = cy = size / 2.0
    r2 = (size / 2.0) ** 2
    for y in range(size):
        for x in range(size):
            if (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r2:
                canvas[y][x] = CLEAR


def write_png(path, surface):
    height = len(surface)
    width = len(surface[0])
    raw = bytearray()
    for row in surface:
        raw.append(0)  # filter type 0
        for px in row:
            raw.extend(px)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def main():
    for name, px in DENSITIES:
        target = RES / f"mipmap-{name}"

        square = new_canvas(px, px, BG)
        paste(square, motif_layer(px), 0, 0, px, px)
        write_png(target / "ic_launcher.png", square)

        rounded = new_canvas(px, px, BG)
        paste(rounded, motif_layer(px), 0, 0, px, px)
        mask_circle(rounded, px)
        write_png(target / "ic_launcher_round.png", rounded)

        # Adaptive foreground is a 108dp canvas; keep the motif inside the
        # ~66dp safe zone so launchers can mask it to any shape.
        fg = int(px * 108 / 48)
        fg_canvas = new_canvas(fg, fg, CLEAR)
        motif = int(fg * 0.62)
        paste(fg_canvas, motif_layer(motif), (fg - motif) // 2, (fg - motif) // 2, fg, fg)
        write_png(target / "ic_launcher_foreground.png", fg_canvas)

    for name, (w, h) in SPLASHES.items():
        canvas = new_canvas(w, h, BG)
        motif = int(min(w, h) * 0.7)
        paste(canvas, motif_layer(motif), (w - motif) // 2, (h - motif) // 2, w, h)
        write_png(RES / name / "splash.png", canvas)

    print("wrote Android launcher + adaptive + splash icons")
    return 0


if __name__ == "__main__":
    sys.exit(main())
