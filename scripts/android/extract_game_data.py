#!/usr/bin/env python3
"""Extract readable game data from decoded Lua scripts and resource files.
Usage: python3 extract_game_data.py <g1-local-evidence-dir> <output-dir>
"""
import json, os, re, sys
from pathlib import Path

def extract_strings(base_dir: Path) -> list:
    """Extract all meaningful strings from .strings.txt files."""
    all_strings = []
    for tf in sorted(base_dir.glob("*.strings.txt")):
        txt = tf.read_text(errors='ignore')
        strings = re.findall(r'[\w./-]{4,}', txt)
        strings = [s for s in strings if len(s) > 4 and not s.startswith('0x')]
        all_strings.extend(strings)
    return sorted(set(all_strings))

def categorize(strings: list) -> dict:
    """Categorize strings by game feature."""
    return {
        "beast_pet": [s for s in strings if re.search(r'beast|pet|shape|creature|monster', s, re.I)],
        "skill": [s for s in strings if re.search(r'skill|ability|talent', s, re.I)],
        "item_equip": [s for s in strings if re.search(r'item|equip|weapon|armor|fashion|accessory|prop|consum', s, re.I)],
        "game_features": [s for s in strings if re.search(r'lottery|summon|gacha|merge|fusion|fight|battle|shop|mall|buy|sell|trade|task|quest|mission|achieve|rank|pvp|dungeon|boss', s, re.I)],
    }

def main():
    base_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("extracted-data")
    out_dir.mkdir(exist_ok=True)

    all_strings = extract_strings(base_dir)
    cats = categorize(all_strings)

    for name, data in cats.items():
        (out_dir / f"{name}_strings.txt").write_text('\n'.join(data))

    report = {
        "total_unique_strings": len(all_strings),
        "categories": {k: len(v) for k, v in cats.items()},
        "sample_beast_pet": cats["beast_pet"][:50],
        "sample_skill": cats["skill"][:30],
        "sample_item_equip": cats["item_equip"][:50],
        "sample_game_features": cats["game_features"][:50],
    }
    with open(out_dir / "report.json", 'w') as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    print(f"Extracted {len(all_strings)} unique strings")
    for k, v in report['categories'].items():
        print(f"  {k}: {v}")

if __name__ == '__main__':
    main()
