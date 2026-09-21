#!/usr/bin/env python3
"""Generate the PWA icons referenced by web/public/manifest.webmanifest.

Dependency-free (stdlib zlib/struct only), so it runs anywhere Python 3 does.

    python3 scripts/gen-icons.py

Writes web/public/icons/icon-192.png and icon-512.png. Re-run after editing to
regenerate; the icons are committed so a plain `./build.sh web` includes them.
"""
from __future__ import annotations

import math
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "web" / "public" / "icons"

BG = (11, 13, 18, 255)
CYAN = (76, 201, 240, 255)
LIGHT = (230, 241, 255, 255)
DIM = (139, 211, 255, 255)


def write_png(path: Path, size: int) -> None:
    """Render the motif at `size` and write an 8-bit RGBA PNG."""
    s = size / 512.0  # design space is 512x512

    def scaled(pt):
        return (pt[0] * s, pt[1] * s)

    def circle(cx, cy, radius):
        out = []
        cx, cy, radius = cx * s, cy * s, radius * s
        r2 = radius * radius
        x0, x1 = int(cx - radius) - 1, int(cx + radius) + 2
        y0, y1 = int(cy - radius) - 1, int(cy + radius) + 2
        for y in range(max(0, y0), min(size, y1)):
            for x in range(max(0, x0), min(size, x1)):
                if (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r2:
                    out.append((x, y))
        return out

    def segment(a, b, width):
        out = []
        ax, ay = a[0] * s, a[1] * s
        bx, by = b[0] * s, b[1] * s
        half = (width * s) / 2.0
        minx, maxx = sorted((ax, bx))
        miny, maxy = sorted((ay, by))
        x0, x1 = int(minx - half) - 1, int(maxx + half) + 2
        y0, y1 = int(miny - half) - 1, int(maxy + half) + 2
        dx, dy = bx - ax, by - ay
        length_sq = dx * dx + dy * dy or 1.0
        for y in range(max(0, y0), min(size, y1)):
            for x in range(max(0, x0), min(size, x1)):
                px, py = x + 0.5, y + 0.5
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
                cx, cy = ax + t * dx, ay + t * dy
                if (px - cx) ** 2 + (py - cy) ** 2 <= half * half:
                    out.append((x, y))
        return out

    # Canvas: flat dark background (maskable icons want full bleed).
    surface = [[BG for _ in range(size)] for _ in range(size)]

    def paint(points, color):
        for x, y in points:
            if 0 <= x < size and 0 <= y < size:
                surface[y][x] = color

    entry = (92, 256)
    mix1 = (196, 150)
    mix2 = (256, 256)
    mix3 = (316, 362)
    dest = (420, 256)

    # Two intertwined paths through the mix layers.
    for a, b in ((entry, mix1), (mix1, mix2), (mix2, mix3), (mix3, dest)):
        paint(segment(a, b, 12), DIM)
    for a, b in ((entry, mix3), (mix3, mix2), (mix2, mix1), (mix1, dest)):
        paint(segment(a, b, 6), DIM)

    # Nodes: endpoints highlighted, mix nodes solid.
    paint(circle(*entry, 34), CYAN)
    paint(circle(*dest, 34), CYAN)
    for node in (mix1, mix2, mix3):
        paint(circle(*node, 24), LIGHT)

    raw = bytearray()
    for row in surface:
        raw.append(0)  # filter type 0
        for px in row:
            raw.extend(px)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def main() -> int:
    for size in (192, 512):
        target = OUT_DIR / f"icon-{size}.png"
        write_png(target, size)
        print(f"wrote {target.relative_to(ROOT)} ({target.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
