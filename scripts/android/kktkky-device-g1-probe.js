'use strict';

/*
 * Device-track combined probe (emulator-5554 exclusive):
 * 1) thx-filter / loopback stub path for three missing shapeconfig digests
 * 2) Hook _g18IMG_ XOR decode + dump post-XOR / post-parse buffers
 * 3) GL texture upload capture + optional screencap trigger flag
 * Does NOT forge third-party payment; CDN host rewritten to loopback only.
 */

const BLOCKERS = {
  c4b00e0c05975f81d4025c0aa8212a9b: true,
  d9d4ea67004deafb19640d8e441ed182: true,
  '8ba3208b364f1e51fe3e499cea0f1026': true
};
const MISSING = {
  c4b00e0c05975f81d4025c0aa8212a9b: { suffix: 'e2shapeconfig', size: 46 },
  d9d4ea67004deafb19640d8e441ed182: { suffix: 'e1shapeconfig', size: 30 },
  '8ba3208b364f1e51fe3e499cea0f1026': { suffix: 'e1shapeconfig', size: 30 }
};
const FILTERED =
  '/storage/emulated/0/Android/data/com.netease.my/files/shapeconfig.thx.filtered';
const PKRES = '/storage/emulated/0/Android/data/com.netease.my/files/pkres/';
const CDN_HOST = 'zy.czzdpb.com';
const LOOPBACK_HOST = '127.0.0.1.com';
const STATIC_URL_RVA = 0x4b2e0e8;
const DYNAMIC_URL_RVA = 0x4b2e2e8;
const PATH_FORMAT_RVA = 0x1cb53c0;
const XXH_PARSER_RVA = 0x1cfd2e0;
const RC4_PARSER_RVA = 0x1cfe480;
const IMG_ID_RVA = 0x2e756a8;
const IMG_DECODE_RVA = 0x2e7591c; // XOR-deobfuscate body after magic
const IMG_ENCODE_RVA = 0x2e756c4;
const IMG_ENCODE2_RVA = 0x2e7580c;

const MAX_GL = 96;
const MAX_IMG_DUMP = 48;
const MAX_PATH = 64;

let installedGame = false;
let installedBypass = false;
let glCount = 0;
let imgDumpCount = 0;
let pathCount = 0;
let glSeen = 0;
let fakeAddrInfo = null;
let wantScreenshot = false;

function log(kind, fields) {
  send(Object.assign({ kind: kind, ts: Date.now() }, fields || {}));
}

function findExport(name) {
  try {
    if (Module.findGlobalExportByName) {
      const a = Module.findGlobalExportByName(name);
      if (a) return a;
    }
  } catch (_) {}
  try {
    return Module.findExportByName(null, name);
  } catch (_) {}
  return null;
}

function resolveExport(moduleName, name) {
  try {
    const mod = Process.findModuleByName(moduleName);
    if (mod) {
      const addr = mod.findExportByName(name);
      if (addr) return addr;
    }
  } catch (_) {}
  return findExport(name);
}

function bytesHex(pointer, size) {
  try {
    const n = Math.min(size, 65536);
    if (!pointer || pointer.isNull() || n <= 0) return null;
    const bytes = new Uint8Array(pointer.readByteArray(n));
    return Array.from(bytes, function (v) {
      return v.toString(16).padStart(2, '0');
    }).join('');
  } catch (_) {
    return null;
  }
}

function readCString(value) {
  try {
    return !value || value.isNull() ? null : value.readUtf8String();
  } catch (_) {
    return null;
  }
}

function readMaybeString(ptr) {
  if (!ptr || ptr.isNull()) return null;
  try {
    const t = ptr.readUtf8String();
    if (t && t.length > 0 && t.length < 2048) return t;
  } catch (_) {}
  return null;
}

function bytesToHex(bytes) {
  return Array.from(bytes, function (b) {
    return ('0' + b.toString(16)).slice(-2);
  }).join('');
}

function interestingPath(path) {
  if (!path) return false;
  const lower = path.toLowerCase();
  return (
    lower.indexOf('3dshapes') !== -1 ||
    lower.indexOf('portrait') !== -1 ||
    lower.indexOf('skill') !== -1 ||
    lower.indexOf('beast') !== -1 ||
    lower.indexOf('.gim') !== -1 ||
    lower.indexOf('icon') !== -1 ||
    lower.indexOf('shape') !== -1 ||
    lower.indexOf('pkres') !== -1
  );
}

function isShapeconfigThx(path) {
  if (!path) return false;
  const lower = path.toLowerCase();
  return lower.indexOf('shapeconfig.thx') !== -1 && lower.indexOf('filtered') === -1;
}

function seedStub(md5) {
  const info = MISSING[md5];
  if (!info) return;
  const fname = md5 + info.suffix;
  const payload = new Uint8Array(info.size);
  payload[0] = 0x5f; // '_'
  [PKRES, PKRES + 'data/', PKRES + 'res/'].forEach(function (root) {
    const path = root + fname;
    try {
      const file = new File(path, 'wb');
      file.write(payload.buffer);
      file.flush();
      file.close();
      log('thx-stub-seeded', { path: path, bytes: info.size, md5: md5 });
    } catch (error) {
      log('thx-stub-seed-failed', { path: path, error: String(error) });
    }
  });
}

function buildFakeAddrInfo() {
  const block = Memory.alloc(128);
  const addr = block.add(48);
  addr.writeU16(2);
  addr.add(2).writeU8(0);
  addr.add(3).writeU8(80);
  addr.add(4).writeByteArray([127, 0, 0, 1]);
  addr.add(8).writeByteArray([0, 0, 0, 0, 0, 0, 0, 0]);
  block.writeU32(0);
  block.add(4).writeU32(2);
  block.add(8).writeU32(1);
  block.add(12).writeU32(6);
  block.add(16).writeU32(16);
  block.add(20).writeU32(0);
  block.add(24).writePointer(ptr(0));
  block.add(32).writePointer(addr);
  block.add(40).writePointer(ptr(0));
  return block;
}

function hookOpenFamily() {
  [
    { name: 'open', pathIndex: 0, flagsIndex: 1 },
    { name: 'open64', pathIndex: 0, flagsIndex: 1 },
    { name: 'openat', pathIndex: 1, flagsIndex: 2 },
    { name: 'openat64', pathIndex: 1, flagsIndex: 2 }
  ].forEach(function (spec) {
    const resolved = findExport(spec.name);
    if (!resolved) return;
    Interceptor.attach(resolved, {
      onEnter(args) {
        const path = readCString(args[spec.pathIndex]);
        if (!isShapeconfigThx(path)) return;
        try {
          const flags = args[spec.flagsIndex].toInt32();
          const acc = flags & 3;
          if (acc !== 0 || (flags & 0x40) || (flags & 0x200)) return;
        } catch (_) {}
        try {
          args[spec.pathIndex] = Memory.allocUtf8String(FILTERED);
          log('thx-redirect', { from: path, to: FILTERED });
        } catch (error) {
          log('thx-redirect-failed', { from: path, error: String(error) });
        }
      }
    });
    log('thx-hook', { api: spec.name });
  });
}

function hookGetAddrInfo() {
  fakeAddrInfo = buildFakeAddrInfo();
  ['getaddrinfo', 'android_getaddrinfofornet', 'android_getaddrinfofornetcontext'].forEach(function (name) {
    const address = findExport(name);
    if (!address) return;
    Interceptor.attach(address, {
      onEnter(args) {
        this.host = readCString(args[0]);
        if (name === 'android_getaddrinfofornet') this.out = args[5];
        else if (name === 'android_getaddrinfofornetcontext') this.out = args[6];
        else this.out = args[3];
        this.redirect = Boolean(
          this.host &&
            (this.host.indexOf(CDN_HOST) !== -1 ||
              this.host.indexOf(LOOPBACK_HOST) !== -1 ||
              this.host === '127.0.0.1')
        );
      },
      onLeave(retval) {
        if (!this.redirect || !this.out) return;
        try {
          this.out.writePointer(fakeAddrInfo);
          retval.replace(0);
          log('thx-getaddrinfo-loopback', { api: name, host: this.host });
        } catch (error) {
          log('thx-getaddrinfo-failed', { api: name, error: String(error) });
        }
      }
    });
    log('thx-getaddrinfo-hook', { api: name });
  });
}

function hookFreeAddrInfo() {
  const address = findExport('freeaddrinfo');
  if (!address || !fakeAddrInfo) return;
  Interceptor.attach(address, {
    onEnter(args) {
      if (args[0] && fakeAddrInfo && args[0].equals(fakeAddrInfo)) {
        args[0] = ptr(0);
      }
    }
  });
}

function hookMissingDigestCompare() {
  const address = findExport('memcmp');
  if (!address) return;
  Interceptor.attach(address, {
    onEnter(args) {
      this.force = false;
      try {
        if (args[2].toUInt32() !== 16) return;
        const left = bytesToHex(new Uint8Array(args[0].readByteArray(16)));
        const right = bytesToHex(new Uint8Array(args[1].readByteArray(16)));
        if (MISSING[left] || MISSING[right]) {
          this.force = true;
          this.pair = left + ':' + right;
        }
      } catch (_) {}
    },
    onLeave(retval) {
      if (this.force) {
        retval.replace(0);
        log('thx-digest-forced-eq', { pair: this.pair });
      }
    }
  });
  log('thx-memcmp-hook');
}

function patchUrlBases(libGame) {
  [STATIC_URL_RVA, DYNAMIC_URL_RVA].forEach(function (rva) {
    try {
      const p = libGame.base.add(rva);
      const old = p.readUtf8String();
      if (!old || old.indexOf(CDN_HOST) === -1) {
        log('thx-url-patch-skip', { rva: '0x' + rva.toString(16), old: old });
        return;
      }
      const next = old.replace(CDN_HOST, LOOPBACK_HOST);
      if (next.length !== old.length) {
        log('thx-url-patch-len-mismatch', { old: old, next: next });
        return;
      }
      p.writeUtf8String(next);
      log('thx-url-patched', { rva: '0x' + rva.toString(16), old: old, next: next });
    } catch (error) {
      log('thx-url-patch-failed', { rva: '0x' + rva.toString(16), error: String(error) });
    }
  });
}

function dumpImgBuffer(tag, pointer, size) {
  if (imgDumpCount >= MAX_IMG_DUMP) return;
  if (!pointer || pointer.isNull() || size <= 0) return;
  const n = Math.min(size, 131072);
  const hex = bytesHex(pointer, n);
  if (!hex) return;
  imgDumpCount += 1;
  let marker = null;
  try {
    marker = pointer.readUtf8String(8);
  } catch (_) {}
  log('img-buf', {
    tag: tag,
    size: size,
    marker: marker,
    prefix: hex.slice(0, 96),
    fullHex: n <= 65536 ? hex : null,
    truncated: n < size
  });
  if (marker === 'ZZZ4' || marker === '_g18IMG_' || marker === 'TEX_SIZE' || (hex && hex.indexOf('13aba15c') === 0)) {
    wantScreenshot = true;
    log('img-decoded-candidate', { tag: tag, marker: marker, size: size });
  }
}

function installGl() {
  ['glTexImage2D', 'glCompressedTexImage2D', 'glTexSubImage2D'].forEach(function (name) {
    const addr =
      resolveExport('libGLESv2.so', name) ||
      resolveExport('libGLESv3.so', name) ||
      resolveExport('libEGL.so', name);
    if (!addr) {
      log('gl-export-missing', { name: name });
      return;
    }
    Interceptor.attach(addr, {
      onEnter(args) {
        glSeen += 1;
        if (glCount >= MAX_GL) return;
        const width = args[3].toInt32();
        const height = args[4].toInt32();
        if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return;
        glCount += 1;
        let dataPtr = null;
        let size = 0;
        const internal = args[2].toInt32();
        if (name.indexOf('Compressed') !== -1) {
          size = args[6].toInt32();
          dataPtr = args[7];
        } else {
          dataPtr = args[8];
          size = Math.min(width * height * 4, 65536);
        }
        const hex = dataPtr && !dataPtr.isNull() ? bytesHex(dataPtr, Math.min(size, 16384)) : null;
        log('gl-tex', {
          api: name,
          width: width,
          height: height,
          internal: '0x' + (internal >>> 0).toString(16),
          size: size,
          dataHexPrefix: hex ? hex.slice(0, 512) : null,
          dataHex: width <= 128 && height <= 128 && size <= 16384 ? hex : null
        });
        wantScreenshot = true;
      }
    });
    log('gl-hooked', { name: name, addr: addr.toString() });
  });
}

function installImgHooks(libGame) {
  Interceptor.attach(libGame.base.add(IMG_ID_RVA), {
    onLeave(retval) {
      log('img-id', { ret: retval.toInt32() });
    }
  });

  // Decode path: copies src+8 then XOR first min(n,0x80)
  Interceptor.attach(libGame.base.add(IMG_DECODE_RVA), {
    onEnter(args) {
      this.x1 = args[1];
      this.x8 = this.context.x8;
    },
    onLeave(retval) {
      try {
        const outHolder = this.x8;
        if (!outHolder || outHolder.isNull()) return;
        const obj = outHolder.readPointer();
        if (!obj || obj.isNull()) return;
        const buf = obj.add(0x10).readPointer();
        // After decode, buffer starts with payload (no magic) or still has content
        dumpImgBuffer('decode-out', buf, 128);
        // Also try reading a length from nearby — best effort
        dumpImgBuffer('decode-out-512', buf, 512);
      } catch (error) {
        log('img-decode-leave-err', { error: String(error) });
      }
    }
  });

  [IMG_ENCODE_RVA, IMG_ENCODE2_RVA].forEach(function (rva) {
    Interceptor.attach(libGame.base.add(rva), {
      onLeave(retval) {
        log('img-encode-hit', { rva: '0x' + rva.toString(16) });
      }
    });
  });

  // XXH parser — dump TEX_SIZE / _g18IMG_ / ZZZ4 outs
  let xxhCount = 0;
  Interceptor.attach(libGame.base.add(XXH_PARSER_RVA), {
    onEnter(args) {
      this.out = this.context.x8;
    },
    onLeave(retval) {
      if (xxhCount >= 120) return;
      xxhCount += 1;
      const tries = [];
      try {
        if (this.out && !this.out.isNull()) {
          tries.push(this.out);
          tries.push(this.out.readPointer());
        }
      } catch (_) {}
      for (let t = 0; t < tries.length; t++) {
        const base = tries[t];
        if (!base || base.isNull()) continue;
        const layouts = [
          [0, 1],
          [1, 2]
        ];
        for (let L = 0; L < layouts.length; L++) {
          try {
            const begin = base.add(Process.pointerSize * layouts[L][0]).readPointer();
            const end = base.add(Process.pointerSize * layouts[L][1]).readPointer();
            const sz = end.sub(begin).toInt32();
            if (sz > 8 && sz < 8 * 1024 * 1024) {
              let marker = null;
              try {
                marker = begin.readUtf8String(8);
              } catch (_) {}
              if (
                marker &&
                (marker.indexOf('TEX_SIZE') === 0 ||
                  marker.indexOf('_g18IMG_') === 0 ||
                  marker.indexOf('ZZZ4') === 0 ||
                  marker.indexOf('_g18RC4_') === 0)
              ) {
                dumpImgBuffer('xxh-' + marker, begin, Math.min(sz, 65536));
                log('xxh-out', { size: sz, marker: marker, prefix: bytesHex(begin, 32) });
              }
              return;
            }
          } catch (_) {}
        }
      }
    }
  });

  Interceptor.attach(libGame.base.add(PATH_FORMAT_RVA), {
    onEnter(args) {
      try {
        const hex = bytesToHex(new Uint8Array(args[0].readByteArray(16)));
        if (MISSING[hex]) {
          seedStub(hex);
          log('thx-missing-seen', { md5: hex });
        }
      } catch (_) {}
      this.a0 = args[0];
      this.a1 = args[1];
    },
    onLeave(retval) {
      if (pathCount >= MAX_PATH) return;
      const s0 = readMaybeString(this.a0) || readMaybeString(retval);
      const s1 = readMaybeString(this.a1);
      const joined = [s0, s1].filter(Boolean).join(' | ');
      if (!interestingPath(joined)) return;
      for (const id in BLOCKERS) {
        if (joined.indexOf(id) !== -1) return;
      }
      pathCount += 1;
      log('path-format', { s0: s0, s1: s1 });
    }
  });

  Interceptor.attach(libGame.base.add(RC4_PARSER_RVA), {
    onLeave(retval) {
      log('rc4-hit', { ret: retval.toString() });
    }
  });
}

function installBypass() {
  if (installedBypass) return;
  installedBypass = true;
  hookOpenFamily();
  hookGetAddrInfo();
  hookFreeAddrInfo();
  hookMissingDigestCompare();
  log('bypass-ready');
}

function installGame(libGame) {
  if (installedGame) return;
  installedGame = true;
  patchUrlBases(libGame);
  installImgHooks(libGame);
  installGl();
  log('device-g1-ready', {
    base: libGame.base.toString(),
    pid: Process.id,
    imgDecode: '0x' + IMG_DECODE_RVA.toString(16)
  });
}

function waitForLibGame() {
  const tryInstall = function () {
    const mod = Process.findModuleByName('libGame.so');
    if (!mod) return false;
    try {
      installGame(mod);
    } catch (error) {
      log('libgame-install-failed', { error: String(error) });
    }
    return installedGame;
  };
  if (tryInstall()) return;
  const dlopen = findExport('android_dlopen_ext') || findExport('dlopen');
  if (dlopen) {
    Interceptor.attach(dlopen, {
      onLeave() {
        tryInstall();
      }
    });
  }
  const poll = setInterval(function () {
    if (tryInstall()) clearInterval(poll);
  }, 200);
  log('waiting-libGame');
}

// Early consent click (Java) — delayed to avoid ClassLoader issues
function armConsent() {
  try {
    Java.performLater(function () {
      try {
        const View = Java.use('android.view.View');
        const activityThread = Java.use('android.app.ActivityThread');
        log('consent-armed');
      } catch (error) {
        log('consent-arm-failed', { error: String(error) });
      }
    });
  } catch (error) {
    log('consent-schedule-failed', { error: String(error) });
  }
}

rpc.exports = {
  screenshotWanted() {
    return wantScreenshot;
  },
  stats() {
    return {
      glCount: glCount,
      glSeen: glSeen,
      imgDumpCount: imgDumpCount,
      pathCount: pathCount,
      installedGame: installedGame
    };
  }
};

installBypass();
waitForLibGame();
armConsent();
log('device-g1-probe-loaded');
