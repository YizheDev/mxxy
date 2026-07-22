#!/usr/bin/env python3
"""Decode TEX_SIZE / _g18IMG_ containers (offline).

Verified layout (skillicon / MsNonRepo samples):

* Optional ``TEX_SIZE`` + ``<u16le width><u16le height>``
* ``_g18IMG_`` magic (8)
* Body after magic is XOR-obfuscated for the first ``min(n, 0x80)`` bytes with
  ``byte[i] ^= (i - 2) & 0xFF`` (libGame.so ``0x2e7591c`` / ``0x2e756c4``).
* After XOR the body is usually ``ZZZ4`` + ``u32le unc_size`` + LZ4 block
  (same container as scripts). Some smaller textures already store the inner
  pixel container without a nested ZZZ4.
* Inner pixel container:
  * ``u32le magic = 0x5ca1ab13``
  * ``u8 block_w, u8 block_h`` (e.g. ``5,5`` → ASTC 5×5)
  * 10-byte dimension/flags header (width/height also in TEX_SIZE)
  * ASTC payload: ``ceil(w/bw) * ceil(h/bh) * 16`` bytes

The historical ``tag=0x355aa5a4`` / ``fmt=0x0504`` fields were the
XOR-obfuscated ``ZZZ4`` magic + size — not a separate codec id.
"""
from __future__ import annotations

import argparse
import json
import math
import struct
from pathlib import Path

IMG = b"_g18IMG_"
TEX = b"TEX_SIZE"
ZZZ4 = b"ZZZ4"
ASTC_MAGIC = 0x5CA1AB13
XOR_WINDOW = 0x80


def xor_deobfuscate(body: bytes, window: int = XOR_WINDOW) -> bytes:
    out = bytearray(body)
    n = min(len(out), window)
    for i in range(n):
        out[i] ^= (i - 2) & 0xFF
    return bytes(out)


def unwrap_zzz4(data: bytes) -> bytes:
    if not data.startswith(ZZZ4) or len(data) < 8:
        raise ValueError("missing ZZZ4 magic")
    import lz4.block

    unc = struct.unpack_from("<I", data, 4)[0]
    return lz4.block.decompress(data[8:], uncompressed_size=unc)


def parse_g18_img(data: bytes) -> dict:
    out: dict = {"input_size": len(data)}
    off = 0
    if data.startswith(TEX):
        if len(data) < 12:
            raise ValueError("TEX_SIZE too short")
        w, h = struct.unpack_from("<HH", data, 8)
        out["tex_size"] = {"width": w, "height": h}
        off = 12
    if not data[off:].startswith(IMG):
        raise ValueError("missing _g18IMG_ magic")
    body = xor_deobfuscate(data[off + 8 :])
    out["xor_window"] = XOR_WINDOW
    if body.startswith(ZZZ4):
        unc = struct.unpack_from("<I", body, 4)[0]
        out["zzz4"] = {"uncompressed_size": unc, "compressed_size": len(body) - 8}
        inner = unwrap_zzz4(body)
    else:
        out["zzz4"] = None
        inner = body
    out["inner_size"] = len(inner)
    if len(inner) >= 16:
        magic, bw, bh = struct.unpack_from("<IBB", inner, 0)
        out["inner"] = {
            "magic": f"0x{magic:08x}",
            "block_w": bw,
            "block_h": bh,
            "header_hex": inner[:16].hex(),
        }
        if magic == ASTC_MAGIC:
            out["payload"] = inner[16:]
            out["codec"] = f"astc_{bw}x{bh}"
        else:
            out["payload"] = inner
            out["codec"] = "unknown_inner"
    else:
        out["payload"] = inner
        out["codec"] = "short"
    return out


def decode_to_rgba(data: bytes) -> tuple[int, int, bytes, dict]:
    """Return (width, height, RGBA bytes, meta). Requires texture2ddecoder for ASTC."""
    parsed = parse_g18_img(data)
    payload = parsed.pop("payload")
    tex = parsed.get("tex_size") or {}
    w = int(tex.get("width") or 0)
    h = int(tex.get("height") or 0)
    inner = parsed.get("inner") or {}
    if parsed.get("codec", "").startswith("astc_"):
        bw = int(inner["block_w"])
        bh = int(inner["block_h"])
        if w <= 0 or h <= 0:
            # Infer square size from ASTC payload when TEX_SIZE absent.
            blocks = len(payload) // 16
            side_blocks = int(math.isqrt(blocks))
            w = side_blocks * bw
            h = side_blocks * bh
        expect = math.ceil(w / bw) * math.ceil(h / bh) * 16
        if len(payload) < expect:
            raise ValueError(f"ASTC payload short: {len(payload)} < {expect}")
        import texture2ddecoder

        bgra = texture2ddecoder.decode_astc(payload[:expect], w, h, bw, bh)
        # BGRA -> RGBA
        rgba = bytearray(w * h * 4)
        for i in range(0, len(bgra), 4):
            rgba[i] = bgra[i + 2]
            rgba[i + 1] = bgra[i + 1]
            rgba[i + 2] = bgra[i]
            rgba[i + 3] = bgra[i + 3]
        parsed["width"] = w
        parsed["height"] = h
        return w, h, bytes(rgba), parsed
    raise ValueError(f"unsupported codec {parsed.get('codec')}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", type=Path)
    ap.add_argument("--payload-out", type=Path)
    ap.add_argument("--png-out", type=Path)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    data = args.input.read_bytes()
    if args.png_out:
        w, h, rgba, meta = decode_to_rgba(data)
        from PIL import Image

        Image.frombytes("RGBA", (w, h), rgba).save(args.png_out)
        meta["png_out"] = str(args.png_out)
        meta["width"] = w
        meta["height"] = h
        print(json.dumps(meta, indent=2) if args.json else meta)
        return 0
    parsed = parse_g18_img(data)
    payload = parsed.pop("payload")
    if args.payload_out:
        args.payload_out.write_bytes(payload)
    if args.json:
        print(json.dumps(parsed, indent=2))
    else:
        print(parsed)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
