#!/usr/bin/env python3
"""Combined gate bypass: consent + native hooks + Java failopen, spawn mode."""
import json, os, subprocess, sys, time
from pathlib import Path
import frida

REPO = Path(os.environ["MXXY_REPO"])
WORK = Path(os.environ["MXXY_WORK"])
LOG = WORK / "runtime/logs/gate-bypass-events.jsonl"
SHOTS = WORK / "runtime/logs/device-shots-bypass"
DURATION = int(os.environ.get("MXXY_PROBE_SECONDS", "90"))

SCRIPTS = [
    REPO / "scripts/android/kktkky-consent-click.js",
    REPO / "scripts/android/kktkky-thx-filter-bypass.js",
    WORK / "runtime/logs/patch-failopen.js",
]

counts = {}
interesting = []

def on_message(message, _data):
    if message["type"] == "send":
        p = message.get("payload") or {}
        k = str(p.get("kind", "unknown"))
        counts[k] = counts.get(k, 0) + 1
        interesting.append(p)
        LOG.open("a").write(json.dumps(p, ensure_ascii=False) + "\n")
    elif message["type"] == "error":
        p = {"kind": "frida-error", "description": message.get("description"),
             "stack": message.get("stack")}
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
            stdout=log_path.open("a"), stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        pid_path.write_text(str(proc.pid))
        time.sleep(0.4)
    subprocess.run(["adb", "-s", "emulator-5554", "reverse", "tcp:80", "tcp:8080"], check=False)
    print("loopback server ready", flush=True)


def take_shot(tag):
    SHOTS.mkdir(parents=True, exist_ok=True)
    path = SHOTS / f"{tag}.png"
    subprocess.run(
        ["adb", "-s", "emulator-5554", "exec-out", "screencap", "-p"],
        stdout=path.open("wb"), check=False,
    )
    return path


def push_filtered_shapeconfig():
    filtered = WORK / "runtime/logs/shapeconfig.thx.filtered"
    if not filtered.exists():
        print("WARNING: shapeconfig.thx.filtered not found, skipping push", flush=True)
        return
    subprocess.run(
        ["adb", "-s", "emulator-5554", "push", str(filtered),
         "/storage/emulated/0/Android/data/com.netease.my/files/shapeconfig.thx.filtered"],
        check=False,
    )
    subprocess.run(
        ["adb", "-s", "emulator-5554", "shell",
         "mkdir -p /storage/emulated/0/Android/data/com.netease.my/files/pkres/thd && "
         "cp /storage/emulated/0/Android/data/com.netease.my/files/shapeconfig.thx.filtered "
         "/storage/emulated/0/Android/data/com.netease.my/files/pkres/thd/shapeconfig.thx && "
         "chmod 644 /storage/emulated/0/Android/data/com.netease.my/files/pkres/thd/shapeconfig.thx"],
        check=False,
    )


def tap_screen(x, y):
    subprocess.run(
        ["adb", "-s", "emulator-5554", "shell", "input", "tap", str(x), str(y)],
        check=False,
    )


def main():
    if LOG.exists():
        LOG.unlink()

    # Force stop any existing instance
    subprocess.run(["adb", "-s", "emulator-5554", "shell", "am", "force-stop", "com.netease.my"], check=False)
    time.sleep(0.5)

    # Ensure airplane mode
    subprocess.run(["adb", "-s", "emulator-5554", "shell", "settings", "put", "global", "airplane_mode_on", "1"], check=False)

    ensure_loopback_server()
    push_filtered_shapeconfig()

    # Build combined script source
    source = "\n".join(p.read_text() for p in SCRIPTS)

    print(f"spawn mode, duration={DURATION}s", flush=True)
    device = frida.get_usb_device(timeout=10)
    pid = device.spawn(["com.netease.my"])
    session = device.attach(pid)
    script = session.create_script(source)
    script.on("message", on_message)
    script.load()
    device.resume(pid)

    started = time.time()
    tapped = set()
    shot_idx = 0

    # Screenshot every 10s and auto-tap consent
    try:
        while time.time() - started < DURATION:
            time.sleep(1)
            e = int(time.time() - started)

            # Auto-tap consent/repair buttons
            for t, x, y in [
                (3, 540, 1680),   # privacy consent
                (5, 540, 1600),
                (8, 700, 1700),
                (11, 540, 1750),
                (14, 540, 1800),
                (18, 540, 1500),
                (25, 540, 1200),
                (35, 540, 1000),
                (50, 540, 800),
            ]:
                if e >= t and t not in tapped:
                    tap_screen(x, y)
                    tapped.add(t)

            # Periodic screenshots
            if e % 10 == 0 or (e <= 15 and e % 5 == 0):
                p = take_shot(f"t{e:03d}")
                print(f"shot t={e}s {p.stat().st_size} bytes", flush=True)

            if e % 15 == 0:
                print(f"t={e}s counts={dict(counts)}", flush=True)
    finally:
        # Final screenshot before cleanup
        take_shot("final")
        subprocess.run(["adb", "-s", "emulator-5554", "shell", "am", "force-stop", "com.netease.my"], check=False)
        time.sleep(0.3)
        try:
            script.unload()
        except Exception:
            pass
        try:
            session.detach()
        except Exception:
            pass

    # Pull patchlog
    try:
        out = subprocess.check_output(
            ["adb", "-s", "emulator-5554", "shell",
             "ls -t /storage/emulated/0/Android/data/com.netease.my/files/pkres/log/patchlog*.txt 2>/dev/null | head -1"],
            text=True,
        ).strip()
        if out:
            dest = WORK / "runtime/logs/patchlog-gate-bypass.txt"
            subprocess.run(["adb", "-s", "emulator-5554", "pull", out, str(dest)], check=False)
            print(f"patchlog pulled: {out}", flush=True)
    except Exception:
        pass

    summary = {"counts": counts, "interesting": interesting[:200]}
    print(json.dumps({"counts": counts, "interesting": len(interesting)}, indent=2))
    (WORK / "runtime/logs/gate-bypass-summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False)
    )


if __name__ == "__main__":
    raise SystemExit(main())
