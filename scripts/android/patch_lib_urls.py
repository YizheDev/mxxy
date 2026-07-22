#!/usr/bin/env python3
"""Patch libGame.so URLs in an APK to point to localhost.

Replaces:
  - http://zy.czzdpb.com/static/  → http://127.0.0.1:8080/s/
  - http://zy.czzdpb.com/dynamic/ → http://127.0.0.1:8080/d/
"""
import sys, zipfile

OLD_STATIC = b'http://zy.czzdpb.com/static/'
OLD_DYNAMIC = b'http://zy.czzdpb.com/dynamic/'
NEW_BASE = b'http://127.0.0.1:8080/s/'
NEW_STATIC = NEW_BASE + b'\x00' * (len(OLD_STATIC) - len(NEW_BASE))
NEW_DYNAMIC = NEW_BASE.replace(b'/s/', b'/d/') + b'\x00' * (len(OLD_DYNAMIC) - len(NEW_BASE))

def patch(data: bytes) -> bytes:
    data = bytearray(data)
    p1 = data.find(OLD_STATIC)
    p2 = data.find(OLD_DYNAMIC)
    if p1 != -1:
        data[p1:p1 + len(NEW_STATIC)] = NEW_STATIC
    if p2 != -1:
        data[p2:p2 + len(NEW_DYNAMIC)] = NEW_DYNAMIC
    if p1 == -1 and p2 == -1:
        print("Warning: no URL patterns found in libGame.so")
    else:
        print(f"Patched: static@{hex(p1)} dynamic@{hex(p2)}")
    return bytes(data)

if __name__ == '__main__':
    apk_path = sys.argv[1]
    output = sys.argv[2] if len(sys.argv) > 2 else apk_path.replace('.apk', '-libpatched.apk')
    with zipfile.ZipFile(apk_path, 'r') as zin:
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                data = zin.read(item.filename)
                if 'libGame.so' in item.filename:
                    data = patch(data)
                zout.writestr(item, data)
    print(f"Output: {output}")
