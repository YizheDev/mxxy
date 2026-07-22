'use strict';

/*
 * Offline shapeconfig / resource-URL probe for com.netease.my.
 * Isolation only: no network enablement, no response forgery.
 *
 * Hooks libGame.so path/URL helpers recovered from ADRP+ADD xrefs and
 * disassembly of the authorized native library.
 */

const PATH_FORMAT_RVA = 0x1cb53c0;       // 16-byte id -> "xx/yyyy..."
const STATIC_BASE_GET_RVA = 0x1cb6040;   // returns static CDN base string
const DYNAMIC_BASE_GET_RVA = 0x1cb60d4;  // returns dynamic CDN base string
const DYNAMIC_URL_RVA = 0x1cbb4e4;       // dynamic_base + relative path
const PATH_FORMAT_CALLER_RVA = 0x1cb52cc; // true prologue for path helper caller
// ADRP xref sites (documentation only — do not Interceptor.attach mid-instruction):
// static 0x4b2e0e8 @ 0x1cb6050,0x1cb60a4,0x1cb6a8c,0x1cb753c
// dynamic 0x4b2e2e8 @ 0x1cb60e4,0x1cb6138,0x1cb6a2c,0x1cb727c,0x1cbb504,0x1cbb568
const CLUSTER_FUNCS = [
  0x1cb6a10, // dynamic base helper prologue
  0x1cb6a70  // static base helper prologue
];

const dumpedMarkers = new Set();
let consentArmed = false;
let libGameProbeInstalled = false;

function log(kind, fields) {
  send(Object.assign({ kind: kind, ts: Date.now() }, fields || {}));
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
  return Thread.backtrace(context, Backtracer.ACCURATE).slice(0, 12).map(moduleOffset);
}

function readMaybeString(ptr) {
  if (!ptr || ptr.isNull()) {
    return null;
  }
  try {
    const text = ptr.readUtf8String();
    if (text && text.length > 0 && text.length < 2048) {
      return text;
    }
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
    if (size > 0 && size < 2048 && !data.isNull()) {
      return data.readUtf8String(size);
    }
  } catch (_) {}
  return null;
}

function bytesHex(pointer, size) {
  try {
    const count = Math.min(size, 64);
    const bytes = new Uint8Array(pointer.readByteArray(count));
    return Array.from(bytes, function (value) {
      return value.toString(16).padStart(2, '0');
    }).join('');
  } catch (_) {
    return null;
  }
}

function markerAt(pointer, size) {
  if (!pointer || pointer.isNull() || size < 8) {
    return null;
  }
  try {
    const text = pointer.readUtf8String(Math.min(size, 32));
    for (const marker of ['_g18RC4_', '_g18xxh_', '_g18IMG_', 'SKPW', 'THDO', 'THDX']) {
      if (text.indexOf(marker) !== -1) {
        return marker;
      }
    }
  } catch (_) {}
  return null;
}

function installFunctionHooks(libGame) {
  if (libGameProbeInstalled) {
    return;
  }
  libGameProbeInstalled = true;
  function attach(name, rva, handlers) {
    const address = libGame.base.add(rva);
    try {
      Interceptor.attach(address, handlers);
      log('hook-installed', { name: name, rva: '0x' + rva.toString(16) });
    } catch (error) {
      log('hook-failed', { name: name, rva: '0x' + rva.toString(16), error: String(error) });
    }
  }

  attach('path-format', PATH_FORMAT_RVA, {
    onEnter(args) {
      this.idPtr = args[0];
      this.result = this.context.x8;
      this.idHex = bytesHex(args[0], 16);
    },
    onLeave() {
      const path = readMaybeString(this.result);
      log('path-format', {
        idHex: this.idHex,
        path: path,
        shapeconfig: Boolean(path && path.indexOf('shapeconfig') !== -1),
        bt: backtrace(this.context)
      });
    }
  });

  attach('static-base-get', STATIC_BASE_GET_RVA, {
    onEnter() {
      this.result = this.context.x8;
    },
    onLeave() {
      log('static-base', { value: readMaybeString(this.result), bt: backtrace(this.context) });
    }
  });

  attach('dynamic-base-get', DYNAMIC_BASE_GET_RVA, {
    onEnter() {
      this.result = this.context.x8;
    },
    onLeave() {
      log('dynamic-base', { value: readMaybeString(this.result), bt: backtrace(this.context) });
    }
  });

  attach('dynamic-url', DYNAMIC_URL_RVA, {
    onEnter(args) {
      this.idPtr = args[0];
      this.result = this.context.x8;
      this.idHex = bytesHex(args[0], 16);
      this.argStrings = [];
      for (let i = 0; i < 4; i++) {
        const value = readMaybeString(args[i]);
        if (value) {
          this.argStrings.push({ arg: i, value: value });
        }
      }
    },
    onLeave() {
      const value = readMaybeString(this.result);
      log('dynamic-url', {
        idHex: this.idHex,
        url: value,
        args: this.argStrings,
        shapeconfig: Boolean(value && value.indexOf('shapeconfig') !== -1),
        bt: backtrace(this.context)
      });
    }
  });

  attach('path-format-caller', PATH_FORMAT_CALLER_RVA, {
    onEnter(args) {
      const strings = [];
      for (let i = 0; i < 6; i++) {
        const value = readMaybeString(args[i]);
        if (value) {
          strings.push({ arg: i, value: value });
        }
      }
      log('path-format-caller', {
        strings: strings,
        x0: args[0].toString(),
        idHex: bytesHex(args[0], 16),
        bt: backtrace(this.context)
      });
    }
  });

  CLUSTER_FUNCS.forEach(function (rva, index) {
    attach('url-cluster-' + index, rva, {
      onEnter(args) {
        const strings = [];
        for (let i = 0; i < 6; i++) {
          const value = readMaybeString(args[i]);
          if (value) {
            strings.push({ arg: i, value: value });
          }
        }
        log('url-cluster', {
          rva: '0x' + rva.toString(16),
          strings: strings,
          idHex: bytesHex(args[0], 16),
          bt: backtrace(this.context)
        });
      }
    });
  });
}

function installMarkerReturnScan(libGame) {
  // Watch memcmp against known payload markers and dump nearby buffers once.
  const memcmp = Module.findGlobalExportByName('memcmp') || Module.findExportByName(null, 'memcmp');
  if (!memcmp) {
    return;
  }
  Interceptor.attach(memcmp, {
    onEnter(args) {
      const size = args[2].toUInt32();
      if (size < 8 || size > 16) {
        return;
      }
      const left = markerAt(args[0], size);
      const right = markerAt(args[1], size);
      const marker = left || right;
      if (!marker || marker.indexOf('_g18') !== 0) {
        return;
      }
      const key = marker + ':' + moduleOffset(this.returnAddress).offset;
      if (dumpedMarkers.has(key)) {
        return;
      }
      dumpedMarkers.add(key);
      const buffer = left ? args[0] : args[1];
      log('marker-hit', {
        marker: marker,
        size: size,
        prefix: bytesHex(buffer, 96),
        caller: moduleOffset(this.returnAddress),
        bt: backtrace(this.context)
      });
    }
  });
  log('marker-scan-ready', { module: libGame.name });
}

function installStringSearchHooks(libGame) {
  // Narrow scan: known URL/string RVAs only (avoid full-module Memory.scan).
  const known = [
    { needle: 'static-url', rva: 0x4b2e0e8 },
    { needle: 'dynamic-url', rva: 0x4b2e2e8 }
  ];
  known.forEach(function (item) {
    try {
      const text = libGame.base.add(item.rva).readUtf8String();
      log('string-hit', { needle: item.needle, offset: '0x' + item.rva.toString(16), value: text });
    } catch (error) {
      log('string-scan-failed', { needle: item.needle, error: String(error) });
    }
  });
}

function armConsentClicker() {
  if (consentArmed) {
    return;
  }
  if (typeof Java === 'undefined') {
    setTimeout(armConsentClicker, 200);
    return;
  }
  consentArmed = true;
  Java.perform(function () {
    try {
      const Button = Java.use('android.widget.Button');
      Button.performClick.implementation = function () {
        const text = this.getText() ? this.getText().toString() : '';
        if (text.indexOf('同意') !== -1 || text.indexOf('接受') !== -1 ||
            text.toLowerCase().indexOf('agree') !== -1) {
          log('consent-click', { text: text });
        }
        return this.performClick();
      };
    } catch (_) {}

    const tryClick = function () {
      try {
        Java.choose('android.widget.Button', {
          onMatch(instance) {
            try {
              const text = instance.getText() ? instance.getText().toString() : '';
              if (text.indexOf('同意') !== -1 || text.indexOf('接受') !== -1) {
                log('consent-auto', { text: text });
                instance.performClick();
              }
            } catch (_) {}
          },
          onComplete() {}
        });
      } catch (_) {}
    };
    for (const delay of [3000, 6000, 9000, 12000, 18000]) {
      setTimeout(tryClick, delay);
    }
  });
}

function waitForLibGame() {
  const tryInstall = function () {
    const mod = Process.findModuleByName('libGame.so');
    if (!mod || libGameProbeInstalled) {
      return Boolean(mod && libGameProbeInstalled);
    }
    installFunctionHooks(mod);
    installStringSearchHooks(mod);
    setTimeout(function () { installMarkerReturnScan(mod); }, 2500);
    log('ready', { base: mod.base.toString(), size: mod.size });
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
      onEnter(args) {
        this.path = args[0].isNull() ? null : args[0].readUtf8String();
      },
      onLeave() {
        if (this.path && this.path.indexOf('libGame.so') !== -1) {
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
  log('waiting-libGame');
}

// Native hooks first; Java consent clicker waits until the bridge exists.
waitForLibGame();
setTimeout(armConsentClicker, 500);
log('probe-loaded');
