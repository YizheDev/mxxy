'use strict';

/*
 * Observe download/fname paths and optionally seed local stub files under
 * pkres/ for the three missing shapeconfig objects. Does not enable network
 * and does not forge HTTP responses.
 */

const MISSING = [
  {
    md5: 'c4b00e0c05975f81d4025c0aa8212a9b',
    fname: 'c4b00e0c05975f81d4025c0aa8212a9be2shapeconfig',
    suffix: 'e2shapeconfig'
  },
  {
    md5: 'd9d4ea67004deafb19640d8e441ed182',
    fname: 'd9d4ea67004deafb19640d8e441ed182e1shapeconfig',
    suffix: 'e1shapeconfig'
  },
  {
    md5: '8ba3208b364f1e51fe3e499cea0f1026',
    fname: '8ba3208b364f1e51fe3e499cea0f1026e1shapeconfig',
    suffix: 'e1shapeconfig'
  }
];

// Minimal _g18RC4_ stub encrypted with recovered keystream (built offline).
// Placeholder filled at load via rpc or embedded hex from host.
var STUB_HEX = typeof MXXY_RC4_STUB_HEX !== 'undefined' ? MXXY_RC4_STUB_HEX : null;

function log(kind, fields) {
  send(Object.assign({ kind: kind, ts: Date.now() }, fields || {}));
}

function readCString(value) {
  try {
    return value.isNull() ? null : value.readUtf8String();
  } catch (_) {
    return null;
  }
}

function interesting(path) {
  if (!path) {
    return false;
  }
  const lower = path.toLowerCase();
  return lower.indexOf('shapeconfig') !== -1 ||
    lower.indexOf('pkres') !== -1 ||
    lower.indexOf('hashres') !== -1 ||
    MISSING.some(function (item) {
      return path.indexOf(item.fname) !== -1 || path.indexOf(item.md5) !== -1;
    });
}

function seedStubs() {
  if (!STUB_HEX) {
    log('stub-missing');
    return;
  }
  const stub = STUB_HEX.match(/.{1,2}/g).map(function (byte) {
    return parseInt(byte, 16);
  });
  const bytes = new Uint8Array(stub);
  const roots = [
    '/storage/emulated/0/Android/data/com.netease.my/files/pkres/data/',
    '/storage/emulated/0/Android/data/com.netease.my/files/pkres/res/',
    '/storage/emulated/0/Android/data/com.netease.my/files/pkres/'
  ];
  roots.forEach(function (root) {
    MISSING.forEach(function (item) {
      const path = root + item.fname;
      try {
        const file = new File(path, 'wb');
        file.write(bytes.buffer);
        file.flush();
        file.close();
        log('stub-seeded', { path: path, bytes: bytes.length, suffix: item.suffix });
      } catch (error) {
        log('stub-seed-failed', { path: path, error: String(error) });
      }
    });
  });
}

function hookOpen() {
  ['open', 'open64', 'openat', 'openat64', 'creat'].forEach(function (name) {
    const address = Module.findGlobalExportByName(name) || Module.findExportByName(null, name);
    if (!address) {
      return;
    }
    Interceptor.attach(address, {
      onEnter(args) {
        const pathArg = name.indexOf('openat') === 0 ? args[1] : args[0];
        this.path = readCString(pathArg);
      },
      onLeave(retval) {
        if (interesting(this.path)) {
          log('path-open', { api: name, path: this.path, fd: retval.toInt32() });
        }
      }
    });
  });
}

function hookLibGameDownloadStrings(libGame) {
  // relative-resource-path / dynamic-resource-url already traced elsewhere;
  // also watch fopen-style helpers if present later.
  log('libgame-ready', { base: libGame.base.toString(), size: libGame.size });
}

function waitForLibGame() {
  const existing = Process.findModuleByName('libGame.so');
  if (existing) {
    hookLibGameDownloadStrings(existing);
    return;
  }
  const dlopen = Module.findGlobalExportByName('android_dlopen_ext') ||
    Module.findExportByName(null, 'android_dlopen_ext') ||
    Module.findExportByName(null, 'dlopen');
  if (!dlopen) {
    return;
  }
  Interceptor.attach(dlopen, {
    onLeave() {
      const mod = Process.findModuleByName('libGame.so');
      if (mod) {
        hookLibGameDownloadStrings(mod);
      }
    }
  });
}

setImmediate(function () {
  hookOpen();
  seedStubs();
  waitForLibGame();
  // Re-seed after app creates pkres dirs.
  setTimeout(seedStubs, 5000);
  setTimeout(seedStubs, 12000);
  log('patch-bypass-loaded', { stub: Boolean(STUB_HEX) });
});
