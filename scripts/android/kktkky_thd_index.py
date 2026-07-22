#!/usr/bin/env python3
"""Inspect the fixed-record THI/THX patch catalogs used by kktkky.

The payload fields remain obfuscated, but their physical layouts are stable:

* THI: ``THDX`` + 12-byte header tail + 12-byte slots.
* THX: ``THDO`` + 72-byte header tail + 28-byte records.

The 76-byte THX header interpretation is supported by empty catalogs that are
exactly 76 bytes long. This tool validates lengths and reports opaque records;
it deliberately does not assign unverified meanings to individual fields.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import struct
import sys


FORMATS = {
    ".thi": (b"THDX", 16, 12),
    ".thx": (b"THDO", 76, 28),
}


def inspect(path: Path, limit: int) -> dict[str, object]:
    suffix = path.suffix.lower()
    if suffix not in FORMATS:
        raise ValueError(f"unsupported catalog extension: {path.suffix}")
    magic, header_size, record_size = FORMATS[suffix]
    raw = path.read_bytes()
    if not raw.startswith(magic):
        raise ValueError(f"unexpected magic in {path}: {raw[:4]!r}")
    if len(raw) < header_size or (len(raw) - header_size) % record_size:
        raise ValueError(
            f"invalid {suffix} size: size={len(raw)}, header={header_size}, "
            f"record={record_size}"
        )

    count = (len(raw) - header_size) // record_size
    rows: list[dict[str, object]] = []
    for number in range(min(count, limit)):
        start = header_size + number * record_size
        record = raw[start : start + record_size]
        row: dict[str, object] = {"number": number, "raw": record.hex()}
        if suffix == ".thx":
            flags = struct.unpack_from("<I", record)[0]
            row.update(
                {
                    "flags": f"{flags:08x}",
                    "opaque_id_a": record[4:16].hex(),
                    "opaque_id_b": record[16:28].hex(),
                }
            )
        rows.append(row)

    return {
        "path": str(path.resolve()),
        "format": suffix[1:],
        "size": len(raw),
        "header_size": header_size,
        "record_size": record_size,
        "record_count": count,
        "header": raw[:header_size].hex(),
        "rows": rows,
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("catalog", nargs="?", type=Path)
    result.add_argument("--inventory-dir", type=Path)
    result.add_argument("--limit", type=int, default=5)
    result.add_argument("--json", action="store_true")
    return result


def main() -> int:
    args = parser().parse_args()
    if args.inventory_dir is not None:
        if args.catalog is not None:
            raise ValueError("catalog and --inventory-dir are mutually exclusive")
        rows = [
            inspect(path, 0)
            for path in sorted(args.inventory_dir.iterdir())
            if path.suffix.lower() in FORMATS
        ]
        if not rows:
            raise ValueError(f"no THI/THX catalogs in {args.inventory_dir}")
        result: object = {
            "directory": str(args.inventory_dir.resolve()),
            "file_count": len(rows),
            "total_records": sum(int(row["record_count"]) for row in rows),
            "catalogs": rows,
        }
    else:
        if args.catalog is None:
            raise ValueError("provide a catalog or --inventory-dir")
        result = inspect(args.catalog, args.limit)

    if args.json:
        json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
        print()
    elif isinstance(result, dict) and "catalogs" in result:
        print(f"directory: {result['directory']}")
        print(f"files: {result['file_count']}")
        print(f"records: {result['total_records']}")
        for row in result["catalogs"]:
            print(
                f"{Path(str(row['path'])).name:32} "
                f"format={row['format']} records={row['record_count']:6d} "
                f"size={row['size']:8d}"
            )
    else:
        assert isinstance(result, dict)
        print(f"path: {result['path']}")
        print(
            f"format: {result['format']} records={result['record_count']} "
            f"header={result['header_size']} record={result['record_size']}"
        )
        for row in result["rows"]:
            print(json.dumps(row, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
