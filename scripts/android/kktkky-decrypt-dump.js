'use strict';

/*
 * Dump decrypted WPK payload buffers at known _g18RC4_ / _g18xxh_ parsers.
 * Observation only; no network or response forgery.
 *
 * Parser RVAs are for the authorized libGame.so
 * SHA-256 65fb150c91f4e625c31dd954da12fdbe92870bcfcb47eea5ac7b61bccf1e7f9a.
 */

const RC4_PARSER_RVA = 0x1cfe480;
const XXH_PARSER_RVA = 0x1cfd2e0;
const MAX_DUMPS = 12;
const MAX_BYTES = 4096;
const DUMP_DIR = '/sdcard/mxxy-decrypt';
let rc4Dumps = 0;
let xxhDumps = 0;
let installed = false;

function ensureDumpDir() {
  try {
    const mkdir = Module.findGlobalExportByName('mkdir') || Module.findExportByName(null, 'mkdir');
    if (mkdir) {
      const mkdirFn = new NativeFunction(mkdir, 'int', ['pointer', 'int']);
      const dir = Memory.allocUtf8String(DUMP_DIR);
      mkdirFn(dir, 0x1ed); // 0755
    }
  } catch (_) {}
}

function writeDump(name, pointer, size) {
  const dirs = [DUMP_DIR, '/data/local/tmp/mxxy-decrypt'];
  const count = Math.min(size, 8 * 1024 * 1024);
  if (!pointer || pointer.isNull() || count <= 0) {
    return null;
  }
  let lastError = null;
  for (let i = 0; i < dirs.length; i++) {
    try {
      const mkdir = Module.findGlobalExportByName('mkdir') || Module.findExportByName(null, 'mkdir');
      if (mkdir) {
        const mkdirFn = new NativeFunction(mkdir, 'int', ['pointer', 'int']);
        mkdirFn(Memory.allocUtf8String(dirs[i]), 0x1ed);
      }
      const path = dirs[i] + '/' + name;
      const file = new File(path, 'wb');
      file.write(pointer.readByteArray(count));
      file.flush();
      file.close();
      return path;
    } catch (error) {
      lastError = String(error);
    }
  }
  log('dump-write-failed', { name: name, error: lastError });
  return null;
}

function log(kind, fields) {
  send(Object.assign({ kind: kind, ts: Date.now() }, fields || {}));
}

function bytesHex(pointer, size) {
  try {
    const count = Math.min(size, MAX_BYTES);
    if (count <= 0 || pointer.isNull()) {
      return null;
    }
    const bytes = new Uint8Array(pointer.readByteArray(count));
    return Array.from(bytes, function (value) {
      return value.toString(16).padStart(2, '0');
    }).join('');
  } catch (_) {
    return null;
  }
}

function markerAt(pointer, size) {
  try {
    const text = pointer.readUtf8String(Math.min(size, 16));
    for (const marker of ['_g18RC4_', '_g18xxh_', '_g18IMG_']) {
      if (text.indexOf(marker) === 0 || text.indexOf(marker) !== -1) {
        return marker;
      }
    }
  } catch (_) {}
  return null;
}

function vectorFromPointers(begin, end) {
  try {
    if (!begin || begin.isNull() || !end || end.isNull()) {
      return null;
    }
    const size = end.sub(begin).toInt32();
    if (size < 0 || size > 64 * 1024 * 1024) {
      return null;
    }
    return {
      begin: begin,
      size: size,
      marker: markerAt(begin, Math.min(size, 16)),
      prefix: bytesHex(begin, size)
    };
  } catch (_) {
    return null;
  }
}

function readVectorView(containerPtr) {
  // Try common libc++ / wrapper layouts used by Messiah resource buffers.
  if (!containerPtr || containerPtr.isNull()) {
    return null;
  }
  const candidates = [];
  try {
    // layout A: vector<uint8_t> inline at container
    candidates.push(vectorFromPointers(
      containerPtr.readPointer(),
      containerPtr.add(Process.pointerSize).readPointer()
    ));
  } catch (_) {}
  try {
    // layout B: pointer to vector
    const vectorPtr = containerPtr.readPointer();
    if (vectorPtr && !vectorPtr.isNull()) {
      candidates.push(vectorFromPointers(
        vectorPtr.readPointer(),
        vectorPtr.add(Process.pointerSize).readPointer()
      ));
    }
  } catch (_) {}
  try {
    // layout C: shared_ptr-like -> vector*
    const shared = containerPtr.readPointer();
    if (shared && !shared.isNull()) {
      const vectorPtr = shared.readPointer();
      if (vectorPtr && !vectorPtr.isNull()) {
        candidates.push(vectorFromPointers(
          vectorPtr.readPointer(),
          vectorPtr.add(Process.pointerSize).readPointer()
        ));
      }
    }
  } catch (_) {}
  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i];
    if (item && item.size > 0) {
      return item;
    }
  }
  return null;
}

function moduleOffset(address) {
  const module = Process.findModuleByAddress(address);
  if (!module) {
    return { address: address.toString() };
  }
  return {
    module: module.name,
    offset: '0x' + address.sub(module.base).toString(16)
  };
}

function backtrace(context) {
  return Thread.backtrace(context, Backtracer.ACCURATE).slice(0, 10).map(moduleOffset);
}

function install(libGame) {
  if (installed) {
    return;
  }
  installed = true;

  Interceptor.attach(libGame.base.add(RC4_PARSER_RVA), {
    onEnter(args) {
      this.out = this.context.x8;
      this.x0 = args[0];
      this.x1 = args[1];
      this.input = readVectorView(args[0]) || readVectorView(args[1]);
      // Capture raw arg snapshots for ABI diagnosis when vector decode fails.
      this.argSnap = [];
      for (let i = 0; i < 3; i++) {
        try {
          this.argSnap.push({
            arg: i,
            ptr: args[i].toString(),
            peek: bytesHex(args[i], 32),
            marker: markerAt(args[i], 16)
          });
        } catch (_) {
          this.argSnap.push({ arg: i, ptr: args[i].toString() });
        }
      }
    },
    onLeave(retval) {
      if (rc4Dumps >= MAX_DUMPS) {
        return;
      }
      rc4Dumps += 1;
      let output = this.out ? readVectorView(this.out) : null;
      if (!output || !output.size) {
        output = readVectorView(retval) || output;
      }
      let dumpPath = null;
      let fullHex = null;
      if (output && output.begin && output.size) {
        dumpPath = writeDump('rc4-' + rc4Dumps + '-out.bin', output.begin, output.size);
        if (output.size <= 65536) {
          fullHex = bytesHex(output.begin, output.size);
        }
      }
      let inDump = null;
      if (this.input && this.input.begin && this.input.size && this.input.size <= 65536) {
        inDump = writeDump('rc4-' + rc4Dumps + '-in.bin', this.input.begin, this.input.size);
      }
      // Host-side prefix capture even if device file write fails.
      const hostPrefix = (output && output.prefix) || (this.input && this.input.prefix);
      log('rc4-parser', {
        inputSize: this.input && this.input.size,
        inputMarker: this.input && this.input.marker,
        inputPrefix: this.input && this.input.prefix,
        outputSize: output && output.size,
        outputMarker: output && output.marker,
        outputPrefix: output && output.prefix,
        outputFullHex: fullHex,
        hostPrefix: hostPrefix,
        dumpPath: dumpPath,
        inputDumpPath: inDump,
        outPtr: this.out ? this.out.toString() : null,
        argSnap: this.argSnap,
        bt: backtrace(this.context)
      });
    }
  });

  Interceptor.attach(libGame.base.add(XXH_PARSER_RVA), {
    onEnter(args) {
      this.out = this.context.x8;
      this.flag = args[1].toInt32();
      this.input = readVectorView(args[0]);
    },
    onLeave(retval) {
      if (xxhDumps >= MAX_DUMPS) {
        return;
      }
      xxhDumps += 1;
      const output = this.out ? readVectorView(this.out) : null;
      // Fallback: some paths store result directly in out as vector begin/end.
      let alt = null;
      if ((!output || !output.size) && this.out && !this.out.isNull()) {
        try {
          const begin = this.out.readPointer();
          const end = this.out.add(Process.pointerSize).readPointer();
          const size = end.sub(begin).toInt32();
          if (size > 0 && size < 64 * 1024 * 1024) {
            alt = {
              size: size,
              marker: markerAt(begin, Math.min(size, 16)),
              prefix: bytesHex(begin, size)
            };
          }
        } catch (_) {}
      }
      log('xxh-parser', {
        flag: this.flag,
        inputSize: this.input && this.input.size,
        inputMarker: this.input && this.input.marker,
        inputPrefix: this.input && this.input.prefix,
        outputSize: output && output.size,
        outputMarker: output && output.marker,
        outputPrefix: output && output.prefix,
        altOutput: alt,
        outPtr: this.out ? this.out.toString() : null,
        bt: backtrace(this.context)
      });
    }
  });

  log('decrypt-hooks-ready', {
    rc4: '0x' + RC4_PARSER_RVA.toString(16),
    xxh: '0x' + XXH_PARSER_RVA.toString(16),
    base: libGame.base.toString()
  });
}

function waitForLibGame() {
  const tryInstall = function () {
    if (installed) {
      return true;
    }
    const mod = Process.findModuleByName('libGame.so');
    if (!mod) {
      return false;
    }
    install(mod);
    return true;
  };
  if (tryInstall()) {
    return;
  }
  const dlopen = Module.findGlobalExportByName('android_dlopen_ext') ||
    Module.findExportByName(null, 'android_dlopen_ext') ||
    Module.findExportByName(null, 'dlopen');
  if (dlopen) {
    Interceptor.attach(dlopen, {
      onLeave() {
        tryInstall();
      }
    });
  }
  const poll = setInterval(function () {
    if (tryInstall()) {
      clearInterval(poll);
    }
  }, 100);
  log('waiting-libGame');
}

waitForLibGame();
log('decrypt-probe-loaded');
