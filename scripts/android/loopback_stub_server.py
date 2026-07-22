#!/usr/bin/env python3
"""Minimal raw HTTP stub for missing shapeconfig objects (offline loopback only)."""
from __future__ import annotations

import hashlib
import json
import socketserver
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STUB_DIR = ROOT / "shapeconfig-stubs"
DUMP = ROOT / "stub-requests.jsonl"

ROUTES = {
    b"/dynamic/c4/b00e0c05975f81d4025c0aa8212a9b": "c4b00e0c05975f81d4025c0aa8212a9b",
    b"/dynamic/d9/d4ea67004deafb19640d8e441ed182": "d9d4ea67004deafb19640d8e441ed182",
    b"/dynamic/8b/a3208b364f1e51fe3e499cea0f1026": "8ba3208b364f1e51fe3e499cea0f1026",
}


def md5_hex(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


class Handler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        try:
            req = b""
            while b"\r\n\r\n" not in req and len(req) < 65536:
                chunk = self.request.recv(4096)
                if not chunk:
                    break
                req += chunk
            if not req:
                return
            head = req.split(b"\r\n\r\n", 1)[0]
            lines = head.split(b"\r\n")
            req_line = lines[0].decode("latin1", "replace")
            headers = {}
            for line in lines[1:]:
                if b":" in line:
                    k, v = line.split(b":", 1)
                    headers[k.decode("latin1").strip().lower()] = v.decode("latin1").strip()
            DUMP.open("a").write(
                json.dumps({"req": req_line, "headers": headers}, ensure_ascii=False) + "\n"
            )
            parts = req_line.split()
            method = parts[0] if parts else "GET"
            path = parts[1].encode() if len(parts) > 1 else b"/"
            path_only = path.split(b"?", 1)[0]

            if path_only in ROUTES:
                body = (STUB_DIR / ROUTES[path_only]).read_bytes()
                content_md5 = md5_hex(body)
                resp = (
                    f"HTTP/1.1 200 OK\r\n"
                    f"Content-Type: application/octet-stream\r\n"
                    f"Content-Length: {len(body)}\r\n"
                    f"Content-MD5: {content_md5}\r\n"
                    f"Accept-Ranges: bytes\r\n"
                    f"Connection: close\r\n\r\n"
                ).encode()
                if method != "HEAD":
                    resp += body
                self.request.sendall(resp)
                return

            # Handle all patchlist / dynamic / static requests with 200 + empty/valid body
            if b"patchlist" in path_only or b"my_cloud" in path_only:
                body = b'{"list":[]}\n'
                content_md5 = md5_hex(body)
                self.request.sendall(
                    (
                        "HTTP/1.1 200 OK\r\n"
                        "Content-Type: application/json\r\n"
                        f"Content-Length: {len(body)}\r\n"
                        f"Content-MD5: {content_md5}\r\n"
                        "Accept-Ranges: bytes\r\n"
                        "Connection: close\r\n\r\n"
                    ).encode()
                    + body
                )
                return

            # For any other dynamic/static request, return minimal valid data
            if b"/dynamic/" in path_only or b"/static/" in path_only:
                body = b'_g18RC4_\x00\x00\x00\x00\x00\x00\x00\x00'
                content_md5 = md5_hex(body)
                self.request.sendall(
                    (
                        "HTTP/1.1 200 OK\r\n"
                        "Content-Type: application/octet-stream\r\n"
                        f"Content-Length: {len(body)}\r\n"
                        f"Content-MD5: {content_md5}\r\n"
                        "Accept-Ranges: bytes\r\n"
                        "Connection: close\r\n\r\n"
                    ).encode()
                    + body
                )
                return

            self.request.sendall(
                b"HTTP/1.1 404 Not Found\r\nContent-Length: 7\r\nConnection: close\r\n\r\nmissing"
            )
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"stub-error: {exc}\n")


class ThreadedServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    if DUMP.exists():
        DUMP.unlink()
    server = ThreadedServer(("127.0.0.1", port), Handler)
    print(f"listening 127.0.0.1:{port} mode=no-content-md5", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
