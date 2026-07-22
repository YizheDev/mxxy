#!/usr/bin/env python3
"""Find direct AArch64 references to known RVAs in a 64-bit little-endian ELF.

This is a deliberately narrow alternative to full binary analysis. It scans
executable PT_LOAD segments for ADR and ADRP followed by ADD-immediate, and it
also reports literal 64-bit values equal to a target RVA. Results are candidate
xrefs; callers still need disassembly or a runtime hook for confirmation.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
from pathlib import Path
import struct
import sys


ELF_HEADER = struct.Struct("<16sHHIQQQIHHHHHH")
PROGRAM_HEADER = struct.Struct("<IIQQQQQQ")
PT_LOAD = 1
PF_X = 1
EM_AARCH64 = 183


@dataclasses.dataclass(frozen=True)
class Segment:
    offset: int
    virtual_address: int
    file_size: int
    flags: int


def parse_integer(value: str) -> int:
    return int(value, 0)


def sign_extend(value: int, bits: int) -> int:
    sign = 1 << (bits - 1)
    return (value ^ sign) - sign


def parse_load_segments(raw: bytes) -> list[Segment]:
    if len(raw) < ELF_HEADER.size:
        raise ValueError("file is shorter than an ELF64 header")
    header = ELF_HEADER.unpack_from(raw)
    ident = header[0]
    machine = header[2]
    program_offset = header[5]
    program_entry_size = header[9]
    program_count = header[10]
    if ident[:4] != b"\x7fELF" or ident[4] != 2 or ident[5] != 1:
        raise ValueError("expected a 64-bit little-endian ELF")
    if machine != EM_AARCH64:
        raise ValueError(f"expected AArch64 ELF machine={EM_AARCH64}, got {machine}")
    if program_entry_size < PROGRAM_HEADER.size:
        raise ValueError("program header entries are unexpectedly small")

    segments: list[Segment] = []
    for number in range(program_count):
        offset = program_offset + number * program_entry_size
        if offset + PROGRAM_HEADER.size > len(raw):
            raise ValueError("program header table exceeds the file")
        values = PROGRAM_HEADER.unpack_from(raw, offset)
        kind, flags, file_offset, virtual_address, _, file_size, _, _ = values
        if kind == PT_LOAD and file_size:
            if file_offset + file_size > len(raw):
                raise ValueError(f"PT_LOAD {number} exceeds the file")
            segments.append(Segment(file_offset, virtual_address, file_size, flags))
    if not segments:
        raise ValueError("ELF has no file-backed PT_LOAD segments")
    return segments


def adr_target(instruction: int, pc: int) -> tuple[int, int] | None:
    if instruction & 0x9F000000 != 0x10000000:
        return None
    immediate = ((instruction >> 5) & 0x7FFFF) << 2
    immediate |= (instruction >> 29) & 0x3
    return instruction & 0x1F, pc + sign_extend(immediate, 21)


def adrp_page(instruction: int, pc: int) -> tuple[int, int] | None:
    if instruction & 0x9F000000 != 0x90000000:
        return None
    immediate = ((instruction >> 5) & 0x7FFFF) << 2
    immediate |= (instruction >> 29) & 0x3
    page = (pc & ~0xFFF) + (sign_extend(immediate, 21) << 12)
    return instruction & 0x1F, page


def add_immediate(instruction: int, source_register: int) -> tuple[int, int] | None:
    if instruction & 0x7F000000 != 0x11000000:
        return None
    if (instruction >> 5) & 0x1F != source_register:
        return None
    immediate = (instruction >> 10) & 0xFFF
    if instruction & (1 << 22):
        immediate <<= 12
    return instruction & 0x1F, immediate


def scan_code(
    raw: bytes, segments: list[Segment], targets: set[int], window: int
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for segment in segments:
        if not segment.flags & PF_X:
            continue
        data = raw[segment.offset : segment.offset + segment.file_size]
        usable = len(data) - len(data) % 4
        for relative in range(0, usable, 4):
            instruction = struct.unpack_from("<I", data, relative)[0]
            pc = segment.virtual_address + relative

            direct = adr_target(instruction, pc)
            if direct is not None and direct[1] in targets:
                rows.append(
                    {
                        "kind": "adr",
                        "target_rva": direct[1],
                        "instruction_rva": pc,
                        "register": direct[0],
                        "instruction": f"{instruction:08x}",
                    }
                )

            page = adrp_page(instruction, pc)
            if page is None:
                continue
            register, page_address = page
            for distance in range(1, window + 1):
                next_relative = relative + distance * 4
                if next_relative >= usable:
                    break
                following = struct.unpack_from("<I", data, next_relative)[0]
                next_page = adrp_page(following, pc + distance * 4)
                next_direct = adr_target(following, pc + distance * 4)
                if (
                    next_page is not None
                    and next_page[0] == register
                    or next_direct is not None
                    and next_direct[0] == register
                ):
                    break
                addition = add_immediate(following, register)
                if addition is None:
                    continue
                destination, immediate = addition
                target = page_address + immediate
                if target in targets:
                    rows.append(
                        {
                            "kind": "adrp+add",
                            "target_rva": target,
                            "instruction_rva": pc,
                            "add_rva": pc + distance * 4,
                            "register": register,
                            "destination_register": destination,
                            "adrp_instruction": f"{instruction:08x}",
                            "add_instruction": f"{following:08x}",
                            "distance": distance,
                        }
                    )
                # Once ADD writes the ADRP register, subsequent instructions no
                # longer use the page value produced by this ADRP.
                if addition[0] == register:
                    break
    return rows


def scan_literals(
    raw: bytes, segments: list[Segment], targets: set[int]
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for segment in segments:
        data = raw[segment.offset : segment.offset + segment.file_size]
        for target in targets:
            needle = struct.pack("<Q", target)
            start = 0
            while True:
                position = data.find(needle, start)
                if position < 0:
                    break
                rows.append(
                    {
                        "kind": "literal-u64",
                        "target_rva": target,
                        "value_rva": segment.virtual_address + position,
                        "file_offset": segment.offset + position,
                    }
                )
                start = position + 1
    return rows


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("elf", type=Path, help="AArch64 ELF shared object")
    result.add_argument(
        "--rva",
        action="append",
        type=parse_integer,
        required=True,
        help="target RVA, repeatable; decimal or 0x-prefixed",
    )
    result.add_argument(
        "--window",
        type=int,
        default=12,
        help="instructions after ADRP to inspect for ADD (default: 12)",
    )
    result.add_argument("--json", action="store_true")
    return result


def main() -> int:
    args = parser().parse_args()
    if args.window < 1 or args.window > 128:
        raise ValueError("--window must be between 1 and 128")
    raw = args.elf.read_bytes()
    segments = parse_load_segments(raw)
    targets = set(args.rva)
    rows = scan_code(raw, segments, targets, args.window)
    rows.extend(scan_literals(raw, segments, targets))
    rows.sort(
        key=lambda row: (
            int(row["target_rva"]),
            int(row.get("instruction_rva", row.get("value_rva", 0))),
        )
    )
    result = {
        "elf": str(args.elf.resolve()),
        "targets": [f"0x{target:x}" for target in sorted(targets)],
        "window": args.window,
        "matches": rows,
    }
    if args.json:
        json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
        print()
    else:
        print(f"ELF: {result['elf']}")
        print(f"targets: {', '.join(result['targets'])}")
        print(f"matches: {len(rows)}")
        for row in rows:
            formatted = dict(row)
            for key in ["target_rva", "instruction_rva", "add_rva", "value_rva", "file_offset"]:
                if key in formatted:
                    formatted[key] = f"0x{int(formatted[key]):x}"
            print(json.dumps(formatted, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
