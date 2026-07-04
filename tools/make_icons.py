#!/usr/bin/env python3
"""Generate Larder's app icons and iOS splash screens.

Pure-stdlib PNG writer; shapes are rendered with signed-distance functions
and analytic anti-aliasing, so no image libraries are required.
Re-run any time: python3 tools/make_icons.py
"""

import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

GREEN_TOP = (0x37, 0x79, 0x5C)
GREEN_BOT = (0x1E, 0x4A, 0x37)
GREEN = (0x2E, 0x6B, 0x51)
CREAM = (0xF6, 0xF1, 0xE7)
SPLASH_BG = (0xF6, 0xF2, 0xEA)


def chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data))


def write_png(path, w, h, rows):
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    raw = b''.join(b'\x00' + bytes(r) for r in rows)
    idat = zlib.compress(raw, 9)
    with open(path, 'wb') as f:
        f.write(sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b''))
    print(f'  wrote {os.path.relpath(path, ROOT)} ({w}x{h})')


def rrect_sdf(px, py, cx, cy, w, h, r):
    dx = abs(px - cx) - (w / 2 - r)
    dy = abs(py - cy) - (h / 2 - r)
    ax = max(dx, 0.0)
    ay = max(dy, 0.0)
    return math.hypot(ax, ay) + min(max(dx, dy), 0.0) - r


def jar_sdf(px, py, S, ox, oy):
    """Stylised jar: lid + body, as a union of two rounded rects."""
    lid = rrect_sdf(px, py, ox + 0.5 * S, oy + 0.335 * S, 0.34 * S, 0.075 * S, 0.03 * S)
    body = rrect_sdf(px, py, ox + 0.5 * S, oy + 0.585 * S, 0.42 * S, 0.40 * S, 0.07 * S)
    return min(lid, body)


def draw_jar(rows, w, h, S, ox, oy, color):
    x0 = max(0, int(ox + 0.26 * S))
    x1 = min(w, int(ox + 0.74 * S) + 2)
    y0 = max(0, int(oy + 0.27 * S))
    y1 = min(h, int(oy + 0.81 * S) + 2)
    cr, cg, cb = color
    for py in range(y0, y1):
        row = rows[py]
        for px in range(x0, x1):
            d = jar_sdf(px + 0.5, py + 0.5, S, ox, oy)
            cov = min(1.0, max(0.0, 0.5 - d))
            if cov > 0:
                i = px * 3
                row[i] = int(row[i] + (cr - row[i]) * cov)
                row[i + 1] = int(row[i + 1] + (cg - row[i + 1]) * cov)
                row[i + 2] = int(row[i + 2] + (cb - row[i + 2]) * cov)


def make_icon(size, path):
    rows = []
    for y in range(size):
        t = y / (size - 1)
        c = bytes(int(GREEN_TOP[i] + (GREEN_BOT[i] - GREEN_TOP[i]) * t) for i in range(3))
        rows.append(bytearray(c * size))
    draw_jar(rows, size, size, size, 0, 0, CREAM)
    write_png(path, size, size, rows)


def make_splash(w, h, path):
    base = bytearray(bytes(SPLASH_BG) * w)
    rows = [bytearray(base) for _ in range(h)]
    S = int(h * 0.30)  # jar glyph occupies ~15% of screen height
    ox = w / 2 - 0.5 * S
    oy = h / 2 - 0.54 * S  # optical centre of the glyph
    draw_jar(rows, w, h, S, ox, oy, GREEN)
    write_png(path, w, h, rows)


def main():
    icons = os.path.join(ROOT, 'icons')
    splash = os.path.join(ROOT, 'splash')
    os.makedirs(icons, exist_ok=True)
    os.makedirs(splash, exist_ok=True)

    print('Icons:')
    for size in (512, 192, 180):
        make_icon(size, os.path.join(icons, f'icon-{size}.png'))

    print('Splash screens:')
    for w, h in [(750, 1334), (828, 1792), (1125, 2436), (1170, 2532), (1179, 2556),
                 (1206, 2622), (1284, 2778), (1290, 2796), (1320, 2868)]:
        make_splash(w, h, os.path.join(splash, f'splash-{w}x{h}.png'))


if __name__ == '__main__':
    main()
