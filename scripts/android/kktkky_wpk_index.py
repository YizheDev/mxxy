#!/usr/bin/env python3
"""Read and optionally extract the SKPW/WPK resource containers in kktkky.

The index format was recovered from the APK without modifying the source files:

    36-byte header
      0x00  char[4]  magic = SKPW
      0x04  uint32   header/check value (meaning not yet confirmed)
      0x08  uint32   reserved
      0x0c  uint32   entry count
      0x10  byte[16] index key/salt (meaning not yet confirmed)
      0x20  uint32   header/check value (meaning not yet confirmed)

    entry[count], 28 bytes each
      0x00  byte[12] path identifier/hash
      0x0c  uint32   stored size
      0x10  uint32   offset in WPK part
      0x14  uint32   one-based WPK part number
      0x18  uint32   entry check/hash (meaning not yet confirmed)

This tool is deliberately read-only unless --extract-dir is supplied. It does
not decrypt the RC4-protected JSON/script payloads yet.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
from pathlib import Path
import struct
import sys
from typing import BinaryIO, Iterator


HEADER_SIZE = 36
ENTRY_SIZE = 28
HEADER_STRUCT = struct.Struct("<4sIII16sI")
ENTRY_STRUCT = struct.Struct("<12sIIII")


@dataclasses.dataclass(frozen=True)
class Header:
    magic: bytes
    check1: int
    reserved: int
    count: int
    key_or_salt: bytes
    check2: int


@dataclasses.dataclass(frozen=True)
class Entry:
    number: int
    path_id: bytes
    stored_size: int
    offset: int
    part: int
    check: int

    @property
    def path_id_hex(self) -> str:
        return self.path_id.hex()


class WpkIndex:
    def __init__(self, index_path: Path) -> None:
        self.index_path = index_path.resolve()
        raw = self.index_path.read_bytes()
        if len(raw) < HEADER_SIZE:
            raise ValueError(f"index is shorter than {HEADER_SIZE} bytes")

        values = HEADER_STRUCT.unpack_from(raw)
        self.header = Header(*values)
        if self.header.magic != b"SKPW":
            raise ValueError(f"unexpected index magic: {self.header.magic!r}")

        expected_size = HEADER_SIZE + self.header.count * ENTRY_SIZE
        if len(raw) != expected_size:
            raise ValueError(
                f"index size mismatch: actual={len(raw)}, expected={expected_size}"
            )

        self._raw = raw
        self._part_handles: dict[int, BinaryIO] = {}
        self._part_sizes: dict[int, int] = {}

    def close(self) -> None:
        for handle in self._part_handles.values():
            handle.close()
        self._part_handles.clear()
        self._part_sizes.clear()

    def __enter__(self) -> "WpkIndex":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def entries(self) -> Iterator[Entry]:
        for number in range(self.header.count):
            offset = HEADER_SIZE + number * ENTRY_SIZE
            values = ENTRY_STRUCT.unpack_from(self._raw, offset)
            yield Entry(number, *values)

    def part_path(self, part: int) -> Path:
        return self.index_path.with_name(f"{self.index_path.stem}{part}.wpk")

    def _part_handle(self, part: int) -> BinaryIO:
        if part <= 0:
            raise ValueError(f"invalid WPK part number: {part}")
        if part not in self._part_handles:
            path = self.part_path(part)
            handle = path.open("rb")
            self._part_handles[part] = handle
            self._part_sizes[part] = os.fstat(handle.fileno()).st_size
        return self._part_handles[part]

    def read(self, entry: Entry, size: int | None = None) -> bytes:
        handle = self._part_handle(entry.part)
        part_size = self._part_sizes[entry.part]
        if entry.offset + entry.stored_size > part_size:
            raise ValueError(
                f"entry {entry.number} exceeds {self.part_path(entry.part).name}: "
                f"offset={entry.offset}, size={entry.stored_size}, part_size={part_size}"
            )
        amount = entry.stored_size if size is None else min(size, entry.stored_size)
        handle.seek(entry.offset)
        data = handle.read(amount)
        if len(data) != amount:
            raise ValueError(f"short read for entry {entry.number}")
        return data


def payload_kind(prefix: bytes) -> str:
    if prefix.startswith(b"_g18xxh_"):
        secondary = prefix[12:]
        if secondary.startswith(b".MESSIAH"):
            return "messiah"
        if secondary.startswith(b"_g18RC4_"):
            return "rc4"
        if secondary.startswith(b"_g18IMG_"):
            return "image"
        if secondary.startswith(b"TEX_SIZE"):
            return "texture"
        return "g18-xxh-other"
    if prefix.startswith(b"_g18RC4_"):
        return "rc4"
    if prefix.startswith(b"_g18IMG_"):
        return "image"
    return "other"


def entry_dict(entry: Entry, kind: str | None = None) -> dict[str, object]:
    result: dict[str, object] = {
        "number": entry.number,
        "path_id": entry.path_id_hex,
        "stored_size": entry.stored_size,
        "offset": entry.offset,
        "part": entry.part,
        "check": f"{entry.check:08x}",
    }
    if kind is not None:
        result["kind"] = kind
    return result


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("index", nargs="?", type=Path, help="path to a .idx file")
    result.add_argument(
        "--inventory-dir",
        type=Path,
        help="verify and summarize every .idx file in a HashRes/data directory",
    )
    result.add_argument("--entry", type=int, help="show or extract one entry number")
    result.add_argument("--limit", type=int, default=20, help="maximum rows to print")
    result.add_argument(
        "--verify",
        action="store_true",
        help="validate every entry boundary and summarize payload markers",
    )
    result.add_argument(
        "--extract-dir",
        type=Path,
        help="extract the selected/listed entries using path-id filenames",
    )
    result.add_argument("--json", action="store_true", help="emit JSON")
    return result


def inventory(directory: Path) -> dict[str, object]:
    indexes: list[dict[str, object]] = []
    total_entries = 0
    total_stored_size = 0
    total_kinds: dict[str, int] = {}

    for path in sorted(directory.glob("*.idx")):
        kinds: dict[str, int] = {}
        stored_size = 0
        parts: set[int] = set()
        with WpkIndex(path) as index:
            for entry in index.entries():
                prefix = index.read(entry, 40)
                kind = payload_kind(prefix)
                kinds[kind] = kinds.get(kind, 0) + 1
                total_kinds[kind] = total_kinds.get(kind, 0) + 1
                stored_size += entry.stored_size
                parts.add(entry.part)

            indexes.append(
                {
                    "index": path.name,
                    "entries": index.header.count,
                    "stored_size": stored_size,
                    "parts": sorted(parts),
                    "payload_kinds": kinds,
                }
            )
            total_entries += index.header.count
            total_stored_size += stored_size

    if not indexes:
        raise ValueError(f"no .idx files found in {directory}")

    return {
        "directory": str(directory.resolve()),
        "index_count": len(indexes),
        "total_entries": total_entries,
        "total_stored_size": total_stored_size,
        "payload_kinds": total_kinds,
        "indexes": indexes,
    }


def main() -> int:
    args = parser().parse_args()
    if args.inventory_dir is not None:
        if args.index is not None:
            raise ValueError("index and --inventory-dir are mutually exclusive")
        result = inventory(args.inventory_dir)
        if args.json:
            json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
            print()
        else:
            print(f"directory: {result['directory']}")
            print(f"indexes: {result['index_count']}")
            print(f"entries: {result['total_entries']}")
            print(f"stored size: {result['total_stored_size']}")
            print(
                "payload kinds: "
                + json.dumps(result["payload_kinds"], sort_keys=True)
            )
            for row in result["indexes"]:
                print(
                    "{index:24} entries={entries:6d} size={stored_size:10d} "
                    "parts={parts} kinds={payload_kinds}".format(**row)
                )
        return 0

    if args.index is None:
        raise ValueError("provide an index path or --inventory-dir")

    with WpkIndex(args.index) as index:
        selected: list[Entry]
        if args.entry is not None:
            if args.entry < 0 or args.entry >= index.header.count:
                raise ValueError(f"entry is outside 0..{index.header.count - 1}")
            selected = [next(e for e in index.entries() if e.number == args.entry)]
        else:
            selected = list(index.entries())

        kinds: dict[str, int] = {}
        rows: list[dict[str, object]] = []
        for position, entry in enumerate(selected):
            prefix = index.read(entry, 40)
            kind = payload_kind(prefix)
            kinds[kind] = kinds.get(kind, 0) + 1
            if position < args.limit or args.entry is not None:
                rows.append(entry_dict(entry, kind))

            if args.extract_dir is not None and (
                args.entry is not None or position < args.limit
            ):
                args.extract_dir.mkdir(parents=True, exist_ok=True)
                suffix = {
                    "messiah": ".messiah",
                    "rc4": ".rc4",
                    "image": ".image",
                    "texture": ".texture",
                }.get(kind, ".bin")
                output = args.extract_dir / f"{entry.number:06d}-{entry.path_id_hex}{suffix}"
                output.write_bytes(index.read(entry))

        result = {
            "index": str(index.index_path),
            "header": {
                "magic": index.header.magic.decode("ascii"),
                "check1": f"{index.header.check1:08x}",
                "reserved": index.header.reserved,
                "count": index.header.count,
                "key_or_salt": index.header.key_or_salt.hex(),
                "check2": f"{index.header.check2:08x}",
            },
            "payload_kinds": kinds,
            "rows": rows,
        }

        if args.json:
            json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
            print()
        else:
            print(f"index: {result['index']}")
            print(f"entries: {index.header.count}")
            print(f"payload kinds: {json.dumps(kinds, sort_keys=True)}")
            for row in rows:
                print(
                    "{number:6d} {path_id} size={stored_size:8d} "
                    "part={part} offset={offset:9d} kind={kind}".format(**row)
                )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
