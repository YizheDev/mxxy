'use strict';

/*
 * Local offline bypass for the three missing shapeconfig patches.
 *
 * - Redirect read-only shapeconfig.thx opens to a filtered catalog.
 * - Seed local stubs under pkres/.
 * - Resolve zy.czzdpb.com -> 127.0.0.1 so a host-side loopback stub
 *   server (adb reverse) can answer without contacting third parties.
 * - Force 16-byte memcmp equality for the three missing MD5 digests so
 *   local stubs are accepted after the loopback fetch.
 */

const FILTERED =
  '/storage/emulated/0/Android/data/com.netease.my/files/shapeconfig.thx.filtered';
const PKRES = '/storage/emulated/0/Android/data/com.netease.my/files/pkres/';
const CDN_HOST = 'zy.czzdpb.com';
// Same-length replacement so in-memory URL bases stay valid C strings.
const LOOPBACK_HOST = '127.0.0.1.com'; // 13 chars, matches zy.czzdpb.com
const STATIC_URL_RVA = 0x4b2e0e8;
const DYNAMIC_URL_RVA = 0x4b2e2e8;
const MISSING = {
  c4b00e0c05975f81d4025c0aa8212a9b: { suffix: 'e2shapeconfig', size: 46 },
  d9d4ea67004deafb19640d8e441ed182: { suffix: 'e1shapeconfig', size: 30 },
  '8ba3208b364f1e51fe3e499cea0f1026': { suffix: 'e1shapeconfig', size: 30 }
};
const MISSING_LIST = Object.keys(MISSING);
const PATH_FORMAT_RVA = 0x1cb53c0;

const skipMd5 = {};
let installed = false;
let fakeAddrInfo = null;

function log(kind, fields) {
  send(Object.assign({ kind: kind, ts: Date.now() }, fields || {}));
}

function findExport(name) {
  try {
    if (Module.findGlobalExportByName) {
      const a = Module.findGlobalExportByName(name);
      if (a) {
        return a;
      }
    }
  } catch (_) {}
  try {
    return Module.findExportByName(null, name);
  } catch (_) {}
  return null;
}

function readCString(value) {
  try {
    return value.isNull() ? null : value.readUtf8String();
  } catch (_) {
    return null;
  }
}

function bytesToHex(bytes) {
  return Array.from(bytes, function (b) {
    return ('0' + b.toString(16)).slice(-2);
  }).join('');
}

function isShapeconfigThx(path) {
  if (!path) {
    return false;
  }
  const lower = path.toLowerCase();
  return lower.indexOf('shapeconfig.thx') !== -1 &&
    lower.indexOf('filtered') === -1;
}

function seedStub(md5) {
  const info = MISSING[md5];
  if (!info) {
    return;
  }
  const fname = md5 + info.suffix;
  // Minimal valid-looking g18 payload: magic + zero ciphertext.
  const payload = new Uint8Array(info.size);
  const magic = [0x5f, 0x67, 0x31, 0x38, 0x52, 0x43, 0x34, 0x5f]; // _g18RC4_
  for (let i = 0; i < magic.length && i < payload.length; i++) {
    payload[i] = magic[i];
  }
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
  // Android arm64 addrinfo (verified via Frida getaddrinfo dump):
  // flags, family, socktype, protocol, addrlen, pad, ai_canonname*, ai_addr*, ai_next*
  // (canonname comes BEFORE ai_addr — opposite of common Linux desktop layouts)
  const block = Memory.alloc(128);
  const addr = block.add(48); // keep sockaddr in same allocation
  addr.writeU16(2);                 // sin_family = AF_INET
  addr.add(2).writeU8(0);           // sin_port htons(80)
  addr.add(3).writeU8(80);
  addr.add(4).writeByteArray([127, 0, 0, 1]);
  addr.add(8).writeByteArray([0, 0, 0, 0, 0, 0, 0, 0]);

  block.writeU32(0);                  // ai_flags
  block.add(4).writeU32(2);           // ai_family AF_INET
  block.add(8).writeU32(1);           // ai_socktype SOCK_STREAM
  block.add(12).writeU32(6);          // ai_protocol IPPROTO_TCP
  block.add(16).writeU32(16);         // ai_addrlen
  block.add(20).writeU32(0);          // padding
  block.add(24).writePointer(ptr(0)); // ai_canonname
  block.add(32).writePointer(addr);   // ai_addr
  block.add(40).writePointer(ptr(0)); // ai_next
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
    if (!resolved) {
      return;
    }
    Interceptor.attach(resolved, {
      onEnter(args) {
        const path = readCString(args[spec.pathIndex]);
        if (!isShapeconfigThx(path)) {
          return;
        }
        try {
          const flags = args[spec.flagsIndex].toInt32();
          const acc = flags & 3;
          if (acc !== 0 || (flags & 0x40) || (flags & 0x200)) {
            log('thx-redirect-skip-write', { from: path, flags: flags });
            return;
          }
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

  // APK asset path often bypasses open(); redirect AAssetManager_open too.
  const aassetOpen = findExport('AAssetManager_open');
  if (aassetOpen) {
    Interceptor.attach(aassetOpen, {
      onEnter(args) {
        const path = readCString(args[1]);
        if (!isShapeconfigThx(path) && !(path && path.indexOf('shapeconfig.thx') !== -1)) {
          return;
        }
        // Cannot return a File via AAsset; just log — filtered disk copy is the real path.
        log('thx-aasset-open', { path: path });
      }
    });
    log('thx-hook', { api: 'AAssetManager_open' });
  }
}

function hostNeedsLoopback(host) {
  if (!host) {
    return false;
  }
  return (
    host.indexOf(CDN_HOST) !== -1 ||
    host.indexOf(LOOPBACK_HOST) !== -1 ||
    host.indexOf('czzdpb') !== -1 ||
    host === '127.0.0.1'
  );
}

function hookGetAddrInfo() {
  fakeAddrInfo = buildFakeAddrInfo();
  let dnsLogLeft = 40;
  ['getaddrinfo', 'android_getaddrinfofornet', 'android_getaddrinfofornetcontext'].forEach(function (name) {
    const address = findExport(name);
    if (!address) {
      return;
    }
    Interceptor.attach(address, {
      onEnter(args) {
        this.host = readCString(args[0]);
        // getaddrinfo(..., res*) -> args[3]
        // android_getaddrinfofornet(..., netid, mark, res*) -> args[5]
        if (name === 'android_getaddrinfofornet') {
          this.out = args[5];
        } else if (name === 'android_getaddrinfofornetcontext') {
          this.out = args[6];
        } else {
          this.out = args[3];
        }
        this.redirect = hostNeedsLoopback(this.host);
        if (dnsLogLeft > 0 && this.host) {
          dnsLogLeft -= 1;
          log('thx-dns-seen', { api: name, host: this.host, redirect: this.redirect });
        }
      },
      onLeave(retval) {
        if (!this.redirect || !this.out) {
          return;
        }
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

function patchUrlStringAt(pointer, tag) {
  try {
    const old = pointer.readUtf8String();
    if (!old || old.indexOf(CDN_HOST) === -1) {
      return false;
    }
    const next = old.replace(CDN_HOST, LOOPBACK_HOST);
    if (next.length !== old.length) {
      log('thx-url-patch-len-mismatch', { tag: tag, old: old, next: next });
      return false;
    }
    Memory.protect(pointer, next.length + 1, 'rwx');
    pointer.writeUtf8String(next);
    log('thx-url-patched', { tag: tag, old: old, next: next });
    return true;
  } catch (error) {
    log('thx-url-patch-failed', { tag: tag, error: String(error) });
    return false;
  }
}

function patchUrlBases(libGame) {
  // Rewrite CDN bases to same-length loopback host; DNS hook maps it to 127.0.0.1.
  // Keep this synchronous and RVA-only — full-module scans of libGame (~90MB) stall spawn.
  [STATIC_URL_RVA, DYNAMIC_URL_RVA].forEach(function (rva) {
    patchUrlStringAt(libGame.base.add(rva), 'rva:0x' + rva.toString(16));
  });
}

function hookFreeAddrInfo() {
  const address = findExport('freeaddrinfo');
  if (!address || !fakeAddrInfo) {
    return;
  }
  Interceptor.attach(address, {
    onEnter(args) {
      if (args[0] && fakeAddrInfo && args[0].equals(fakeAddrInfo)) {
        // Our fake block is permanent; do not let libc free it.
        args[0] = ptr(0);
        log('thx-freeaddrinfo-skipped');
      }
    }
  });
  log('thx-freeaddrinfo-hook');
}

function installLibGameHooks(libGame) {
  patchUrlBases(libGame);
  Interceptor.attach(libGame.base.add(PATH_FORMAT_RVA), {
    onEnter(args) {
      try {
        const hex = bytesToHex(new Uint8Array(args[0].readByteArray(16)));
        if (MISSING[hex]) {
          skipMd5[hex] = Date.now();
          seedStub(hex);
          log('thx-missing-seen', { md5: hex });
        }
      } catch (_) {}
    }
  });
  log('thx-path-watch', { rva: '0x' + PATH_FORMAT_RVA.toString(16) });
}

function findLibGame() {
  let mod = Process.findModuleByName('libGame.so');
  if (mod) {
    return mod;
  }
  const mods = Process.enumerateModules();
  for (let i = 0; i < mods.length; i++) {
    if (mods[i].name === 'libGame.so' || /libGame\.so$/i.test(mods[i].path || '')) {
      return mods[i];
    }
  }
  return null;
}

function waitForLibGame() {
  const tryInstall = function () {
    if (installed) {
      return true;
    }
    const mod = findLibGame();
    if (!mod) {
      return false;
    }
    try {
      installLibGameHooks(mod);
      installed = true;
      log('thx-libgame-ready', { base: mod.base.toString(), size: mod.size });
    } catch (error) {
      log('thx-libgame-hook-failed', { error: String(error) });
    }
    return installed;
  };
  if (!tryInstall()) {
    const dlopen = findExport('android_dlopen_ext') || findExport('dlopen');
    if (dlopen) {
      Interceptor.attach(dlopen, {
        onEnter(args) {
          this.path = readCString(args[0]);
        },
        onLeave() {
          if (this.path && this.path.indexOf('libGame') !== -1) {
            log('thx-dlopen-libgame', { path: this.path });
            tryInstall();
          }
        }
      });
    }
    const poll = setInterval(function () {
      if (tryInstall()) {
        clearInterval(poll);
      }
    }, 100);
  }
}

function hookMissingDigestCompare() {
  // Narrow: only force equality when one operand is exactly a missing MD5.
  const address = findExport('memcmp');
  if (!address) {
    return;
  }
  Interceptor.attach(address, {
    onEnter(args) {
      this.force = false;
      try {
        if (args[2].toUInt32() !== 16) {
          return;
        }
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

function hookJavaDns() {
  // Frida 17 may not define Java until the runtime is ready; never throw at load.
  try {
    if (typeof Java === 'undefined' || !Java.available) {
      log('thx-java-dns-skip', { reason: 'no-java' });
      return;
    }
  } catch (error) {
    log('thx-java-dns-skip', { reason: String(error) });
    return;
  }
  Java.perform(function () {
    try {
      const InetAddress = Java.use('java.net.InetAddress');
      InetAddress.getAllByName.overload('java.lang.String').implementation = function (host) {
        const h = host ? String(host) : '';
        if (hostNeedsLoopback(h)) {
          log('thx-java-dns-loopback', { host: h });
          const bytes = Java.array('byte', [127, 0, 0, 1]);
          return Java.array('java.net.InetAddress', [
            InetAddress.getByAddress(Java.use('java.lang.String').$new(h), bytes)
          ]);
        }
        return this.getAllByName(host);
      };
      log('thx-java-dns-hook');
    } catch (error) {
      log('thx-java-dns-hook-failed', { error: String(error) });
    }
  });
}

hookOpenFamily();
hookGetAddrInfo();
hookFreeAddrInfo();
hookMissingDigestCompare();
hookJavaDns();
waitForLibGame();
log('thx-filter-bypass-loaded', { filtered: FILTERED, missing: MISSING_LIST, mode: 'loopback-stubs' });
