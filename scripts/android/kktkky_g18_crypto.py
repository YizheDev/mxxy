#!/usr/bin/env python3
"""Offline helpers for authorized g18 container wrappers.

Verified runtime evidence (libGame.so parsers):

* ``_g18RC4_`` (8-byte magic): ciphertext XOR a package-static RC4 keystream
  recovered from known plaintext JSON (pkginfo / consolidate) and confirmed
  against the live RC4 S-box. Not a blind key search.
* ``_g18xxh_`` (8-byte magic + 4-byte trailer): unwrap removes 12 header bytes
  and yields either ``ZZZ4`` payloads or nested ``_g18RC4_...`` containers.
* Buffers that *look* like ``_g18RC4_2`` are still ``_g18RC4_`` plus a first
  ciphertext byte that happens to be ASCII ``2``; after decrypt the payload
  often begins with ``ZZZ4`` / binary-json. Always strip exactly 8 magic bytes.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys


RC4_MAGIC = b"_g18RC4_"
XXH_MAGIC = b"_g18xxh_"
XXH_HEADER = 12
ZZZ4_MAGIC = b"ZZZ4"


def unwrap_zzz4(data: bytes, *, check_prefix: bool = True) -> bytes:
    """Decompress ZZZ4 container (LZ4 block; verified on startup scripts)."""
    if check_prefix and not data.startswith(ZZZ4_MAGIC):
        raise ValueError("missing ZZZ4 magic")
    if len(data) < 8:
        raise ValueError("ZZZ4 too short")
    import struct
    import lz4.block
    unc = struct.unpack_from("<I", data, 4)[0]
    return lz4.block.decompress(data[8:], uncompressed_size=unc)


def unwrap_xxh(data: bytes, *, check_prefix: bool = True) -> bytes:
    if len(data) < XXH_HEADER:
        raise ValueError("buffer shorter than xxh header")
    if check_prefix and not data.startswith(XXH_MAGIC):
        raise ValueError("missing _g18xxh_ magic")
    return data[XXH_HEADER:]


def decrypt_rc4(data: bytes, keystream: bytes) -> bytes:
    if not data.startswith(RC4_MAGIC):
        raise ValueError("missing _g18RC4_ magic")
    cipher = data[len(RC4_MAGIC) :]
    if len(keystream) < len(cipher):
        raise ValueError(
            f"keystream too short: need {len(cipher)} bytes, have {len(keystream)}"
        )
    return bytes(a ^ b for a, b in zip(cipher, keystream))


def prga_from_sbox(sbox: bytes, length: int, *, drop: int = 0) -> bytes:
    if len(sbox) < 256:
        raise ValueError("sbox must be 256 bytes")
    state = list(sbox[:256])
    i = 0
    j = 0
    for _ in range(drop):
        i = (i + 1) & 0xFF
        j = (j + state[i]) & 0xFF
        state[i], state[j] = state[j], state[i]
    out = bytearray()
    for _ in range(length):
        i = (i + 1) & 0xFF
        j = (j + state[i]) & 0xFF
        state[i], state[j] = state[j], state[i]
        out.append(state[(state[i] + state[j]) & 0xFF])
    return bytes(out)


def encrypt_rc4(plain: bytes, keystream: bytes) -> bytes:
    if len(keystream) < len(plain):
        raise ValueError(
            f"keystream too short: need {len(plain)} bytes, have {len(keystream)}"
        )
    cipher = bytes(a ^ b for a, b in zip(plain, keystream))
    return RC4_MAGIC + cipher


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    sub = result.add_subparsers(dest="command", required=True)

    p_xxh = sub.add_parser("unwrap-xxh", help="Strip _g18xxh_ 12-byte header")
    p_xxh.add_argument("input", type=Path)
    p_xxh.add_argument("output", type=Path)

    p_z = sub.add_parser("unwrap-zzz4", help="LZ4-decompress ZZZ4 container")
    p_z.add_argument("input", type=Path)
    p_z.add_argument("output", type=Path)

    p_dec = sub.add_parser("decrypt-rc4", help="Decrypt _g18RC4_ with keystream file")
    p_dec.add_argument("input", type=Path)
    p_dec.add_argument("keystream", type=Path)
    p_dec.add_argument("output", type=Path)

    p_enc = sub.add_parser("encrypt-rc4", help="Encrypt payload as _g18RC4_")
    p_enc.add_argument("input", type=Path)
    p_enc.add_argument("keystream", type=Path)
    p_enc.add_argument("output", type=Path)

    p_ks = sub.add_parser(
        "recover-keystream",
        help="Recover keystream from _g18RC4_ ciphertext + plaintext pair",
    )
    p_ks.add_argument("cipher_input", type=Path)
    p_ks.add_argument("plain_output", type=Path)
    p_ks.add_argument("keystream_out", type=Path)
    return result


def main() -> int:
    args = parser().parse_args()
    if args.command == "unwrap-xxh":
        args.output.write_bytes(unwrap_xxh(args.input.read_bytes()))
    elif args.command == "unwrap-zzz4":
        args.output.write_bytes(unwrap_zzz4(args.input.read_bytes()))
    elif args.command == "decrypt-rc4":
        args.output.write_bytes(
            decrypt_rc4(args.input.read_bytes(), args.keystream.read_bytes())
        )
    elif args.command == "encrypt-rc4":
        args.output.write_bytes(
            encrypt_rc4(args.input.read_bytes(), args.keystream.read_bytes())
        )
    elif args.command == "recover-keystream":
        cipher = args.cipher_input.read_bytes()
        plain = args.plain_output.read_bytes()
        if not cipher.startswith(RC4_MAGIC):
            raise ValueError("cipher_input must start with _g18RC4_")
        body = cipher[len(RC4_MAGIC) :]
        if len(body) != len(plain):
            raise ValueError("cipher/plain length mismatch after magic")
        args.keystream_out.write_bytes(bytes(a ^ b for a, b in zip(body, plain)))
    else:
        raise ValueError(args.command)
    print(f"ok command={args.command}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
