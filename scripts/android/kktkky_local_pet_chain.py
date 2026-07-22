#!/usr/bin/env python3
"""Enumerate locally closable pet-resource candidates from base HashRes.

Strategy (local-first):
- Do not wait on remote dynamic shapeconfig blobs.
- Read shapeconfig.thx / res_shape.thx / skillicon catalogs and IDX inventories.
- Mark species that only exist as remote THX IDs as missing_config.
- Emit a JSON report plus a small evidence pack of local MESSIAH / texture heads.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import struct
import sys

from kktkky_g18_crypto import RC4_MAGIC, XXH_MAGIC, decrypt_rc4, unwrap_xxh
from kktkky_wpk_index import WpkIndex


REMOTE_BLOCKERS = {
    "c4b00e0c05975f81d4025c0aa8212a9b",
    "d9d4ea67004deafb19640d8e441ed182",
    "8ba3208b364f1e51fe3e499cea0f1026",
}


def load_thx_ids(path: Path) -> list[dict[str, object]]:
    raw = path.read_bytes()
    if not raw.startswith(b"THDO") or len(raw) < 76 or (len(raw) - 76) % 28:
        raise ValueError(f"bad thx: {path}")
    rows: list[dict[str, object]] = []
    body = raw[76:]
    for i in range(len(body) // 28):
        rec = body[i * 28 : (i + 1) * 28]
        flags = struct.unpack_from("<I", rec, 0)[0]
        # Runtime path-format uses 16-byte IDs at offset 4 (verified).
        id16 = rec[4:20].hex()
        tail = rec[20:28].hex()
        rows.append(
            {
                "number": i,
                "flags": f"{flags:08x}",
                "id16": id16,
                "tail8": tail,
                "id12_prefix": id16[:24],
                "path_hint": f"{id16[:2]}/{id16[2:]}",
                "remote_blocker": id16 in REMOTE_BLOCKERS,
            }
        )
    return rows


def load_thi_ids(path: Path) -> list[str]:
    raw = path.read_bytes()
    if not raw.startswith(b"THDX") or len(raw) < 16 or (len(raw) - 16) % 12:
        raise ValueError(f"bad thi: {path}")
    body = raw[16:]
    return [body[i * 12 : (i + 1) * 12].hex() for i in range(len(body) // 12)]


def load_idx_ids(path: Path) -> list[dict[str, object]]:
    index = WpkIndex(path)
    return [
        {
            "number": entry.number,
            "id12": entry.path_id_hex,
            "stored_size": entry.stored_size,
            "offset": entry.offset,
            "part": entry.part,
        }
        for entry in index.entries()
    ]


def classify_payload(data: bytes) -> str:
    if data.startswith(b".MESSIAH"):
        return "messiah"
    if data.startswith(b"TEX_SIZE"):
        return "tex_size"
    if data.startswith(b"_g18IMG_"):
        return "g18_img"
    if data.startswith(b"ZZZ4"):
        return "zzz4"
    if data.startswith(b"\x1bLua"):
        return "lua"
    if data.startswith(RC4_MAGIC):
        return "g18_rc4"
    if data.startswith(XXH_MAGIC):
        return "g18_xxh"
    if data.startswith(b"\x89PNG"):
        return "png"
    return "other"


def maybe_decrypt(data: bytes, keystream: bytes | None) -> tuple[bytes, str]:
    kind = classify_payload(data)
    if kind == "g18_xxh":
        inner = unwrap_xxh(data)
        return maybe_decrypt(inner, keystream)
    if kind == "g18_rc4":
        if keystream is None:
            return data, kind
        plain = decrypt_rc4(data, keystream)
        return plain, classify_payload(plain)
    return data, kind


def scan_index_samples(
    index_path: Path,
    keystream: bytes | None,
    *,
    want_kinds: set[str],
    limit: int,
    scan_cap: int,
) -> list[dict[str, object]]:
    samples: list[dict[str, object]] = []
    with WpkIndex(index_path) as index:
        for entry in index.entries():
            if entry.number >= scan_cap and len(samples) >= limit:
                break
            try:
                blob = index.read(entry)
            except Exception:
                continue
            plain, kind = maybe_decrypt(blob, keystream)
            if kind in want_kinds:
                samples.append(
                    {
                        "id12": entry.path_id_hex,
                        "size": len(plain),
                        "kind": kind,
                        "head_hex": plain[:32].hex(),
                    }
                )
            if len(samples) >= limit:
                break
    return samples


def build_report(hashres: Path, keystream: Path | None, limit_extract: int) -> dict:
    data_dir = hashres / "data"
    thd_dir = hashres / "thd"
    ks = keystream.read_bytes() if keystream and keystream.exists() else None

    shapeconfig = load_thx_ids(thd_dir / "shapeconfig.thx")
    res_shape = load_thx_ids(thd_dir / "res_shape.thx")
    skill_thx = load_thx_ids(thd_dir / "res_skillicon.thx") if (thd_dir / "res_skillicon.thx").exists() else []

    repo_idx = load_idx_ids(data_dir / "repository.idx")
    skill_idx = load_idx_ids(data_dir / "res_skillicon.idx")
    shapes2d_idx = load_idx_ids(data_dir / "res_2dshapes.idx")

    repo_ids = {row["id12"] for row in repo_idx}
    skill_ids = {row["id12"] for row in skill_idx}

    shape_prefix_in_repo = [row for row in shapeconfig if row["id12_prefix"] in repo_ids]
    shape_prefix_in_skill = [row for row in shapeconfig if row["id12_prefix"] in skill_ids]
    res_shape_prefix_in_repo = [row for row in res_shape if row["id12_prefix"] in repo_ids]

    messiah_samples = scan_index_samples(
        data_dir / "repository.idx",
        ks,
        want_kinds={"messiah"},
        limit=limit_extract,
        scan_cap=max(limit_extract * 40, 800),
    )
    texture_samples = scan_index_samples(
        data_dir / "repository.idx",
        ks,
        want_kinds={"tex_size", "g18_img", "png"},
        limit=limit_extract,
        scan_cap=max(limit_extract * 40, 800),
    )
    skill_samples = scan_index_samples(
        data_dir / "res_skillicon.idx",
        ks,
        want_kinds={"tex_size", "g18_img", "png", "zzz4"},
        limit=limit_extract,
        scan_cap=max(limit_extract * 80, 1200),
    )

    blockers = [row for row in shapeconfig if row["remote_blocker"]]
    local_shapeconfig = [row for row in shapeconfig if not row["remote_blocker"]]

    return {
        "counts": {
            "shapeconfig_thx": len(shapeconfig),
            "shapeconfig_local_non_blocker": len(local_shapeconfig),
            "shapeconfig_remote_blockers": len(blockers),
            "res_shape_thx": len(res_shape),
            "skillicon_thx": len(skill_thx),
            "repository_idx": len(repo_idx),
            "skillicon_idx": len(skill_idx),
            "res_2dshapes_idx": len(shapes2d_idx),
            "shapeconfig_id12_prefix_in_repository": len(shape_prefix_in_repo),
            "shapeconfig_id12_prefix_in_skillicon": len(shape_prefix_in_skill),
            "res_shape_id12_prefix_in_repository": len(res_shape_prefix_in_repo),
        },
        "remote_blockers": blockers,
        "match_note": (
            "Direct 12-byte prefix overlap between THX id16 and IDX id12 is usually "
            "zero (known from prior audit). Local closability is evidenced by "
            "repository MESSIAH / skillicon texture payloads present in base WPK."
        ),
        "local_evidence": {
            "messiah_samples": messiah_samples,
            "repository_texture_samples": texture_samples,
            "skillicon_samples": skill_samples,
            "share_icons_available_in_apk": True,
        },
        "g1_candidate_policy": {
            "complete_requires": [
                "model_ref (repository .MESSIAH)",
                "material/texture",
                "action clips",
                "portrait",
                "skill_icon_refs",
            ],
            "current_status": "partial",
            "missing_config_species": sorted(REMOTE_BLOCKERS),
            "next": (
                "Use runtime path-format hits on NON-blocker ids, or recover "
                "shapeconfig->repository mapping from decrypted Json/script, "
                "then bind one local MESSIAH + skillicon into a render probe."
            ),
        },
        "sample_local_shapeconfig_ids": [row["id16"] for row in local_shapeconfig[:20]],
        "sample_res_shape_ids": [row["id16"] for row in res_shape[:20]],
        "sample_repository_ids": [row["id12"] for row in repo_idx[:20]],
    }


def extract_evidence_pack(
    hashres: Path,
    keystream: Path | None,
    out_dir: Path,
    limit: int,
) -> list[str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    ks = keystream.read_bytes() if keystream and keystream.exists() else None
    data_dir = hashres / "data"
    written: list[str] = []
    with WpkIndex(data_dir / "repository.idx") as index:
        for entry in index.entries():
            if len([p for p in written if "messiah_" in p]) >= limit:
                break
            try:
                blob = index.read(entry)
            except Exception:
                continue
            plain, kind = maybe_decrypt(blob, ks)
            if kind != "messiah":
                continue
            dest = out_dir / f"messiah_{entry.path_id_hex}.bin"
            dest.write_bytes(plain)
            written.append(str(dest))
    with WpkIndex(data_dir / "res_skillicon.idx") as index:
        skill_written = 0
        for entry in index.entries():
            if skill_written >= limit:
                break
            try:
                blob = index.read(entry)
            except Exception:
                continue
            plain, kind = maybe_decrypt(blob, ks)
            if kind not in {"tex_size", "g18_img", "png"}:
                continue
            dest = out_dir / f"skillicon_{entry.path_id_hex}_{kind}.bin"
            dest.write_bytes(plain)
            written.append(str(dest))
            skill_written += 1
    return written


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--hashres", type=Path, required=True)
    result.add_argument("--keystream", type=Path)
    result.add_argument("--json-out", type=Path)
    result.add_argument("--evidence-dir", type=Path)
    result.add_argument("--limit", type=int, default=8)
    return result


def main() -> int:
    args = parser().parse_args()
    report = build_report(args.hashres.resolve(), args.keystream, args.limit)
    if args.evidence_dir is not None:
        files = extract_evidence_pack(
            args.hashres.resolve(), args.keystream, args.evidence_dir, args.limit
        )
        report["evidence_files"] = files
    text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.json_out is not None:
        args.json_out.write_text(text)
    else:
        sys.stdout.write(text)
    print(
        "local_pet_chain "
        f"shapeconfig={report['counts']['shapeconfig_thx']} "
        f"repo={report['counts']['repository_idx']} "
        f"messiah_samples={len(report['local_evidence']['messiah_samples'])} "
        f"skill_samples={len(report['local_evidence']['skillicon_samples'])}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
