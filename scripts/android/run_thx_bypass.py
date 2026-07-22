#!/usr/bin/env python3
import json, os, subprocess, sys, time
from pathlib import Path
import frida

REPO = Path(os.environ["MXXY_REPO"])
WORK = Path(os.environ["MXXY_WORK"])
LOG = WORK / "runtime/logs/thx-bypass-events.jsonl"
DURATION = int(os.environ.get("MXXY_PROBE_SECONDS", "90"))
SCRIPTS = [
    REPO / "scripts/android/kktkky-consent-click.js",
    REPO / "scripts/android/kktkky-thx-filter-bypass.js",
]

counts = {}
interesting = []
INTERESTING = {
    "path-format",
    "dynamic-url",
    "missing-md5-still-formatted",
    "consent-auto",
    "consent-click",
    "consent-armed",
    "frida-error",
    "alog-downloader",
    "downloader-log",
    "thx-libgame-ready",
    "thx-url-patched",
    "check-header-logcat-bt-loaded",
}


def on_message(message, _data):
    if message["type"] == "send":
        p = message.get("payload") or {}
        k = str(p.get("kind", "unknown"))
        counts[k] = counts.get(k, 0) + 1
        if k.startswith("thx-") or k in INTERESTING or p.get("shapeconfig"):
            interesting.append(p)
        LOG.open("a").write(json.dumps(p, ensure_ascii=False) + "\n")
    elif message["type"] == "error":
        p = {
            "kind": "frida-error",
            "description": message.get("description"),
            "stack": message.get("stack"),
        }
        counts["frida-error"] = counts.get("frida-error", 0) + 1
        interesting.append(p)
        LOG.open("a").write(json.dumps(p, ensure_ascii=False) + "\n")


def ensure_loopback_server():
    pid_path = WORK / "runtime/logs/loopback-server.pid"
    log_path = WORK / "runtime/logs/loopback-server.log"
    alive = False
    if pid_path.exists():
        try:
            pid = int(pid_path.read_text().strip())
            os.kill(pid, 0)
            alive = True
        except Exception:
            alive = False
    if not alive:
        proc = subprocess.Popen(
            [sys.executable, str(WORK / "runtime/logs/loopback_stub_server.py"), "8080"],
            stdout=log_path.open("a"),
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        pid_path.write_text(str(proc.pid))
        time.sleep(0.4)
    subprocess.run(["adb", "-s", "emulator-5554", "reverse", "tcp:80", "tcp:8080"], check=False)


def main():
    if LOG.exists():
        LOG.unlink()
    ensure_loopback_server()
    filtered = WORK / "runtime/logs/shapeconfig.thx.filtered"
    if filtered.exists():
        subprocess.run(
            [
                "adb",
                "-s",
                "emulator-5554",
                "push",
                str(filtered),
                "/storage/emulated/0/Android/data/com.netease.my/files/shapeconfig.thx.filtered",
            ],
            check=False,
        )
        subprocess.run(
            [
                "adb",
                "-s",
                "emulator-5554",
                "shell",
                "mkdir -p /storage/emulated/0/Android/data/com.netease.my/files/pkres/thd && "
                "cp /storage/emulated/0/Android/data/com.netease.my/files/shapeconfig.thx.filtered "
                "/storage/emulated/0/Android/data/com.netease.my/files/pkres/thd/shapeconfig.thx && "
                "chmod 644 /storage/emulated/0/Android/data/com.netease.my/files/pkres/thd/shapeconfig.thx",
            ],
            check=False,
        )
    subprocess.run(
        ["adb", "-s", "emulator-5554", "shell", "settings", "put", "global", "airplane_mode_on", "1"],
        check=False,
    )
    device = frida.get_usb_device(timeout=10)
    source = "\n".join(p.read_text() for p in SCRIPTS)
    print(f"spawn duration={DURATION}", flush=True)
    pid = device.spawn(["com.netease.my"])
    session = device.attach(pid)
    script = session.create_script(source)
    script.on("message", on_message)
    script.load()
    device.resume(pid)
    started = time.time()
    tapped = set()
    try:
        while time.time() - started < DURATION:
            time.sleep(1)
            e = int(time.time() - started)
            for t, x, y in [
                (5, 540, 1600),
                (8, 540, 1680),
                (11, 700, 1700),
                (14, 540, 1750),
                (18, 540, 1800),
                (25, 540, 1500),
                (35, 540, 1200),
                (40, 800, 1100),
                (50, 300, 1100),
                (60, 540, 1400),
            ]:
                if e >= t and t not in tapped:
                    subprocess.run(
                        ["adb", "-s", "emulator-5554", "shell", "input", "tap", str(x), str(y)],
                        check=False,
                    )
                    tapped.add(t)
            if e % 15 == 0:
                print(f"t={e}s counts={counts}", flush=True)
    finally:
        subprocess.run(
            ["adb", "-s", "emulator-5554", "shell", "am", "force-stop", "com.netease.my"],
            check=False,
        )
        time.sleep(0.3)
        try:
            script.unload()
        except Exception:
            pass
        try:
            session.detach()
        except Exception:
            pass
    summary = {"counts": counts, "interesting": interesting[:300]}
    print(json.dumps({"counts": counts, "interesting": len(interesting)}, indent=2))
    (WORK / "runtime/logs/thx-bypass-summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False)
    )
    out = subprocess.check_output(
        [
            "adb",
            "-s",
            "emulator-5554",
            "shell",
            "ls -t /storage/emulated/0/Android/data/com.netease.my/files/pkres/log/patchlog*.txt 2>/dev/null | head -1",
        ],
        text=True,
    ).strip()
    if out:
        dest = WORK / "runtime/logs/patchlog-thx-bypass.txt"
        subprocess.run(["adb", "-s", "emulator-5554", "pull", out, str(dest)], check=False)
        summary["patchlog"] = out
        print("patchlog", out)


if __name__ == "__main__":
    raise SystemExit(main())
