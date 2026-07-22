'use strict';

/*
 * Dump RC4 key-schedule inputs and post-decrypt buffers for _g18RC4_ / _g18RC4_2.
 * RVAs for authorized libGame.so SHA-256 65fb...e7f9a.
 */

const RC4_INIT_RVA = 0x1bc569c;   // builds RC4 state object
const RC4_KS_RVA = 0x1bc4c98;     // called from init; likely key setup
const RC4_CRYPT_RVA = 0x1bc58e8;  // PRGA xor into buffer
const RC4_PARSER_RVA = 0x1cfe480;
const XXH_PARSER_RVA = 0x1cfd2e0;

var keyProbeInstalled = false;
var cryptDumps = 0;
var keyDumps = 0;

function keyLog(kind, fields) {
  send(Object.assign({ kind: kind, ts: Date.now() }, fields || {}));
}

function keyBytesHex(pointer, size) {
  try {
    const count = Math.min(size, 4096);
    if (!pointer || pointer.isNull() || count <= 0) {
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

function installKeyProbe(libGame) {
  if (keyProbeInstalled) {
    return;
  }
  keyProbeInstalled = true;

  Interceptor.attach(libGame.base.add(RC4_INIT_RVA), {
    onEnter(args) {
      this.state = args[0];
    },
    onLeave() {
      if (keyDumps >= 24 || !this.state || this.state.isNull()) {
        return;
      }
      keyDumps += 1;
      // State layout observed in PRGA: S[256] then i/j at +0x100/+0x104.
      keyLog('rc4-state-init', {
        state: this.state.toString(),
        sbox: keyBytesHex(this.state, 256),
        ij: keyBytesHex(this.state.add(0x100), 8)
      });
    }
  });

  Interceptor.attach(libGame.base.add(RC4_KS_RVA), {
    onEnter(args) {
      if (keyDumps >= 48) {
        return;
      }
      const fields = { x0: args[0].toString(), x1: args[1].toString(), x2: args[2].toString() };
      try {
        fields.a0hex = keyBytesHex(args[0], 64);
      } catch (_) {}
      try {
        fields.a1hex = keyBytesHex(args[1], 64);
      } catch (_) {}
      try {
        const n = args[2].toInt32();
        if (n > 0 && n <= 256) {
          fields.keyLen = n;
          fields.keyHex = keyBytesHex(args[1], n);
        }
      } catch (_) {}
      keyLog('rc4-key-setup', fields);
    }
  });

  Interceptor.attach(libGame.base.add(RC4_CRYPT_RVA), {
    onEnter(args) {
      this.state = args[0];
      this.buffer = args[1];
      this.length = args[2].toInt32();
      this.before = keyBytesHex(this.buffer, Math.min(this.length, 64));
    },
    onLeave() {
      if (cryptDumps >= 32) {
        return;
      }
      if (this.length <= 0 || this.length > 16 * 1024 * 1024) {
        return;
      }
      const after = keyBytesHex(this.buffer, Math.min(this.length, 96));
      const interesting = (after && (
        after.indexOf('7b') === 0 ||
        after.indexOf('5f673138') === -1 && this.before && this.before.indexOf('5f673138') === 0
      )) || this.length < 4096;
      if (!interesting && cryptDumps > 8) {
        return;
      }
      cryptDumps += 1;
      keyLog('rc4-crypt', {
        length: this.length,
        before: this.before,
        after: after,
        state: this.state.toString()
      });
    }
  });

  Interceptor.attach(libGame.base.add(RC4_PARSER_RVA), {
    onEnter(args) {
      try {
        const vectorPtr = args[0].readPointer();
        const begin = vectorPtr.readPointer();
        const end = vectorPtr.add(8).readPointer();
        const size = end.sub(begin).toInt32();
        keyLog('rc4-parser-enter', {
          size: size,
          head: keyBytesHex(begin, Math.min(size, 32))
        });
      } catch (_) {}
    }
  });

  keyLog('rc4-key-probe-ready', {
    init: '0x' + RC4_INIT_RVA.toString(16),
    ks: '0x' + RC4_KS_RVA.toString(16),
    crypt: '0x' + RC4_CRYPT_RVA.toString(16)
  });
}

function waitForLibGameKeyProbe() {
  const existing = Process.findModuleByName('libGame.so');
  if (existing) {
    installKeyProbe(existing);
    return;
  }
  const dlopen = Module.findGlobalExportByName('android_dlopen_ext') ||
    Module.findExportByName(null, 'android_dlopen_ext') ||
    Module.findExportByName(null, 'dlopen');
  Interceptor.attach(dlopen, {
    onLeave() {
      const mod = Process.findModuleByName('libGame.so');
      if (mod) {
        installKeyProbe(mod);
      }
    }
  });
  keyLog('waiting-libGame');
}

waitForLibGameKeyProbe();
