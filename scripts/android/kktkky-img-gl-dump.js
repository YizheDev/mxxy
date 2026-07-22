'use strict';

/*
 * Local-first G1 visual probe:
 * - Ignore remote shapeconfig blockers
 * - Dump glTexImage2D / glCompressedTexImage2D uploads (host hex via send)
 * - Hook _g18IMG_ identity helper @ 0x2e756a8 and nearby decode callers
 * Observation only; no network forgery.
 */

const BLOCKERS = {
  c4b00e0c05975f81d4025c0aa8212a9b: true,
  d9d4ea67004deafb19640d8e441ed182: true,
  '8ba3208b364f1e51fe3e499cea0f1026': true
};
const IMG_ID_RVA = 0x2e756a8; // builds/compares _g18IMG_
const PATH_FORMAT_RVA = 0x1cb53c0;
const XXH_PARSER_RVA = 0x1cfd2e0;
const RC4_PARSER_RVA = 0x1cfe480;
const MAX_GL = 64;
const MAX_PATH = 48;
let glCount = 0;
let pathCount = 0;
let imgCount = 0;
let glSeen = 0;
let installed = false;

function log(kind, fields) {
  send(Object.assign({ kind: kind, ts: Date.now() }, fields || {}));
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

function readMaybeString(ptr) {
  if (!ptr || ptr.isNull()) return null;
  try {
    const t = ptr.readUtf8String();
    if (t && t.length > 0 && t.length < 2048) return t;
  } catch (_) {}
  try {
    const tag = ptr.readU8();
    let size;
    let data;
    if ((tag & 1) === 0) {
      size = tag >> 1;
      data = ptr.add(1);
    } else {
      size = Number(ptr.add(8).readU64().toString());
      data = ptr.add(16).readPointer();
    }
    if (size > 0 && size < 2048 && !data.isNull()) return data.readUtf8String(size);
  } catch (_) {}
  return null;
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
    lower.indexOf('shape') !== -1
  );
}

function resolveExport(moduleName, name) {
  try {
    const mod = Process.findModuleByName(moduleName);
    if (mod) {
      const addr = mod.findExportByName(name);
      if (addr) {
        return addr;
      }
    }
  } catch (_) {}
  try {
    if (Module.getGlobalExportByName) {
      return Module.getGlobalExportByName(name);
    }
  } catch (_) {}
  try {
    if (Module.findGlobalExportByName) {
      return Module.findGlobalExportByName(name);
    }
  } catch (_) {}
  return null;
}

function installGl() {
  const names = ['glTexImage2D', 'glCompressedTexImage2D', 'glTexSubImage2D'];
  names.forEach(function (name) {
    const addr = resolveExport('libGLESv2.so', name) ||
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
        // glTexImage2D(target, level, internalformat, width, height, border, format, type, data)
        // glCompressedTexImage2D(target, level, internalformat, width, height, border, imageSize, data)
        const width = args[3].toInt32();
        const height = args[4].toInt32();
        if (width <= 0 || height <= 0 || width > 4096 || height > 4096) {
          if (glSeen <= 8) {
            log('gl-skip', { api: name, width: width, height: height });
          }
          return;
        }
        glCount += 1;
        let dataPtr = null;
        let size = 0;
        let internal = args[2].toInt32();
        if (name.indexOf('Compressed') !== -1) {
          size = args[6].toInt32();
          dataPtr = args[7];
        } else {
          dataPtr = args[8];
          // RGBA8 estimate; still capture prefix for any format
          size = Math.min(width * height * 4, 65536);
        }
        const hex = dataPtr && !dataPtr.isNull() ? bytesHex(dataPtr, Math.min(size, 16384)) : null;
        log('gl-tex', {
          api: name,
          width: width,
          height: height,
          internal: internal,
          size: size,
          dataHexPrefix: hex ? hex.slice(0, 512) : null,
          dataHex: (width <= 128 && height <= 128 && size <= 16384) ? hex : null
        });
      }
    });
    log('gl-hooked', { name: name, addr: addr.toString() });
  });
}

function install(libGame) {
  if (installed) return;
  installed = true;

  Interceptor.attach(libGame.base.add(IMG_ID_RVA), {
    onEnter(args) {
      this.x0 = args[0];
      this.x1 = args[1];
    },
    onLeave(retval) {
      if (imgCount >= 32) return;
      imgCount += 1;
      log('img-id', {
        ret: retval.toInt32(),
        x0: this.x0 ? this.x0.toString() : null,
        x1peek: this.x1 ? bytesHex(this.x1, 32) : null,
        x0peek: this.x0 ? bytesHex(this.x0, 32) : null
      });
    }
  });

  Interceptor.attach(libGame.base.add(PATH_FORMAT_RVA), {
    onEnter(args) {
      this.a0 = args[0];
      this.a1 = args[1];
      this.a2 = args[2];
    },
    onLeave(retval) {
      if (pathCount >= MAX_PATH) return;
      const s0 = readMaybeString(this.a0) || readMaybeString(retval);
      const s1 = readMaybeString(this.a1);
      const s2 = readMaybeString(this.a2);
      const joined = [s0, s1, s2].filter(Boolean).join(' | ');
      if (!interestingPath(joined) && !interestingPath(s0) && !interestingPath(s1)) return;
      // skip blockers
      for (const id in BLOCKERS) {
        if (joined.indexOf(id) !== -1) return;
      }
      pathCount += 1;
      log('path-format', { s0: s0, s1: s1, s2: s2, ret: readMaybeString(retval) });
    }
  });

  let xxhCount = 0;
  Interceptor.attach(libGame.base.add(XXH_PARSER_RVA), {
    onEnter(args) {
      this.out = this.context.x8;
      this.input = null;
      try {
        const vec = args[0].readPointer();
        if (vec && !vec.isNull()) {
          const begin = vec.readPointer();
          const end = vec.add(Process.pointerSize).readPointer();
          const size = end.sub(begin).toInt32();
          if (size > 0 && size < 8 * 1024 * 1024) {
            this.input = { size: size, prefix: bytesHex(begin, Math.min(size, 32)) };
          }
        }
      } catch (_) {}
    },
    onLeave(retval) {
      if (xxhCount >= 100) {
        return;
      }
      xxhCount += 1;
      let prefix = null;
      let size = null;
      let marker = null;
      // Try several out-vector layouts (x8 may point at vector or wrapper).
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
        try {
          const begin = base.readPointer();
          const end = base.add(Process.pointerSize).readPointer();
          const sz = end.sub(begin).toInt32();
          if (sz > 0 && sz < 8 * 1024 * 1024) {
            size = sz;
            prefix = bytesHex(begin, Math.min(sz, 96));
            try { marker = begin.readUtf8String(8); } catch (_) {}
            break;
          }
        } catch (_) {}
        try {
          // layout: begin at +8, end at +16
          const begin = base.add(Process.pointerSize).readPointer();
          const end = base.add(Process.pointerSize * 2).readPointer();
          const sz = end.sub(begin).toInt32();
          if (sz > 0 && sz < 8 * 1024 * 1024) {
            size = sz;
            prefix = bytesHex(begin, Math.min(sz, 96));
            try { marker = begin.readUtf8String(8); } catch (_) {}
            break;
          }
        } catch (_) {}
      }
      if (marker && (marker.indexOf('TEX_SIZE') === 0 || marker.indexOf('_g18IMG_') === 0 || marker.indexOf('ZZZ4') === 0 || marker.indexOf('_g18RC4_') === 0)) {
        let fullHex = null;
        if (size && size <= 131072) {
          try {
            const begin = tries[0] ? tries[0].readPointer() : null;
            // re-resolve begin from successful layout
            for (let t = 0; t < tries.length && !fullHex; t++) {
              const base = tries[t];
              if (!base || base.isNull()) continue;
              try {
                const b0 = base.readPointer();
                const e0 = base.add(Process.pointerSize).readPointer();
                if (e0.sub(b0).toInt32() === size) {
                  fullHex = bytesHex(b0, size);
                  break;
                }
              } catch (_) {}
              try {
                const b0 = base.add(Process.pointerSize).readPointer();
                const e0 = base.add(Process.pointerSize * 2).readPointer();
                if (e0.sub(b0).toInt32() === size) {
                  fullHex = bytesHex(b0, size);
                  break;
                }
              } catch (_) {}
            }
          } catch (_) {}
        }
        log('xxh-out', {
          size: size,
          marker: marker,
          prefix: prefix,
          fullHex: fullHex,
          input: this.input
        });
      } else if (xxhCount <= 12) {
        log('xxh-hit', { size: size, marker: marker, prefix: prefix, input: this.input });
      }
    }
  });

  Interceptor.attach(libGame.base.add(RC4_PARSER_RVA), {
    onLeave(retval) {
      log('rc4-hit', { ret: retval.toString() });
    }
  });


function installZlib() {
  const names = ['uncompress', 'inflate', 'inflateEnd', 'mz_inflate', 'MZ_inflate'];
  // Hook common inflate entry via libz and libGame imports
  const candidates = [];
  Process.enumerateModules().forEach(function (mod) {
    if (mod.name.indexOf('libz') === -1 && mod.name.indexOf('libGame') === -1 && mod.name.indexOf('libunity') === -1) {
      return;
    }
    ['uncompress', 'inflate', 'inflateInit2_', 'inflateInit_'].forEach(function (name) {
      try {
        const addr = mod.findExportByName(name);
        if (addr) {
          candidates.push({ mod: mod.name, name: name, addr: addr });
        }
      } catch (_) {}
    });
  });
  let zcount = 0;
  candidates.forEach(function (c) {
    if (c.name === 'uncompress') {
      Interceptor.attach(c.addr, {
        onEnter(args) {
          this.dest = args[0];
          this.destLenPtr = args[1];
          this.source = args[2];
          this.sourceLen = args[3].toInt32 ? args[3].toInt32() : Number(args[3]);
          this.srcHex = bytesHex(this.source, Math.min(this.sourceLen || 64, 64));
        },
        onLeave(retval) {
          if (zcount >= 40) return;
          let destLen = 0;
          try { destLen = this.destLenPtr.readU32(); } catch (_) {}
          if (destLen !== 64 * 64 * 4 && destLen !== 64 * 64 && destLen < 1024) return;
          zcount += 1;
          log('zlib-uncompress', {
            mod: c.mod,
            ret: retval.toInt32(),
            destLen: destLen,
            sourceLen: this.sourceLen,
            srcPrefix: this.srcHex,
            destHex: bytesHex(this.dest, Math.min(destLen, 16384))
          });
        }
      });
      log('zlib-hooked', { mod: c.mod, name: c.name });
    }
  });
  log('zlib-candidates', { n: candidates.length, items: candidates.map(function (x) { return x.mod + '!' + x.name; }) });
}

  installGl();
  installZlib();
  log('img-gl-ready', {
    imgId: '0x' + IMG_ID_RVA.toString(16),
    base: libGame.base.toString(),
    pid: Process.id
  });
}

function waitForLibGame() {
  const tryInstall = function () {
    if (installed) return true;
    const mod = Process.findModuleByName('libGame.so');
    if (!mod) return false;
    install(mod);
    return true;
  };
  if (tryInstall()) return;
  const poll = setInterval(function () {
    if (tryInstall()) clearInterval(poll);
  }, 200);
  log('waiting-libGame');
}

waitForLibGame();
