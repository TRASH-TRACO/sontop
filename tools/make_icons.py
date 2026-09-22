#!/usr/bin/env python3
"""Generate the PWA / apple-touch icons without any image library.

Draws a dark rounded square with a white "finger" capsule crossed out by a red
band, then writes it as a PNG. 3x supersampling gives cheap anti-aliasing.
"""
import math
import struct
import zlib
from pathlib import Path

SS = 3  # supersampling factor
OUT = Path(__file__).resolve().parent.parent / "icons"

BG_TOP = (27, 43, 58)
BG_BOTTOM = (11, 17, 23)
FINGER = (244, 247, 250)
NAIL = (255, 214, 224)
SLASH = (239, 68, 68)


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def rounded_rect(x, y, w, h, r):
    """Signed-ish membership test for a rounded rectangle."""
    def inside(px, py):
        cx = min(max(px, x + r), x + w - r)
        cy = min(max(py, y + r), y + h - r)
        if x + r <= px <= x + w - r or y + r <= py <= y + h - r:
            return x <= px <= x + w and y <= py <= y + h
        return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
    return inside


def capsule(x1, y1, x2, y2, r):
    dx, dy = x2 - x1, y2 - y1
    seg = dx * dx + dy * dy

    def inside(px, py):
        t = 0.0 if seg == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / seg))
        qx, qy = x1 + t * dx, y1 + t * dy
        return (px - qx) ** 2 + (py - qy) ** 2 <= r * r
    return inside


def render(size):
    n = size * SS
    bg = rounded_rect(0, 0, n, n, n * 0.22)
    # finger pointing up-left toward the mouth, tilted ~25 degrees
    ang = math.radians(115)
    cx, cy = n * 0.52, n * 0.54
    half = n * 0.30
    fx1, fy1 = cx - math.cos(ang) * half, cy - math.sin(ang) * half
    fx2, fy2 = cx + math.cos(ang) * half, cy + math.sin(ang) * half
    finger = capsule(fx1, fy1, fx2, fy2, n * 0.135)
    nail = capsule(fx2, fy2, fx2 + math.cos(ang) * n * 0.06, fy2 + math.sin(ang) * n * 0.06, n * 0.125)
    slash = capsule(n * 0.20, n * 0.80, n * 0.80, n * 0.20, n * 0.068)
    slash_gap = capsule(n * 0.20, n * 0.80, n * 0.80, n * 0.20, n * 0.090)

    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    fpx = px * SS + sx + 0.5
                    fpy = py * SS + sy + 0.5
                    if not bg(fpx, fpy):
                        continue
                    color = lerp(BG_TOP, BG_BOTTOM, fpy / n)
                    if finger(fpx, fpy) and not slash_gap(fpx, fpy):
                        color = NAIL if nail(fpx, fpy) else FINGER
                    if slash(fpx, fpy):
                        color = SLASH
                    acc[0] += color[0]
                    acc[1] += color[1]
                    acc[2] += color[2]
                    acc[3] += 255
            total = SS * SS
            if acc[3] == 0:
                row += bytes((0, 0, 0, 0))
            else:
                covered = acc[3] // 255
                row += bytes((acc[0] // covered, acc[1] // covered, acc[2] // covered, acc[3] // total))
        rows.append(bytes(row))
    return rows


def write_png(path, rows, size):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)
    print(f"{path.name}: {len(png)} bytes")


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for size, name in ((192, "icon-192.png"), (512, "icon-512.png"), (180, "apple-touch-icon.png")):
        write_png(OUT / name, render(size), size)
