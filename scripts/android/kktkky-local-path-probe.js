'use strict';

/*
 * Local-first path probe: log path-format / dynamic-url for NON-blocker IDs only.
 * Ignores the three known remote shapeconfig blobs so probes do not spin on CDN.
 */

const PATH_FORMAT_RVA = 0x1cb53c0;
const DYNAMIC_URL_RVA = 0x1cbb4e4;
const BLOCKERS = {
  c4b00e0c05975f81d4025c0aa8212a9b: true,
  d9d4ea67004deafb19640d8e441ed182: true,
  '8ba3208b364f1e51fe3e499cea0f1026': true
};
const MAX_EVENTS = 64;
let events = 0;
let installed = false;

function log(kind, fields) {
  send(Object.assign({ kind: kind, ts: Date.now() }, fields || {}));
}

function bytesHex(pointer, size) {
  try {
    const bytes = new Uint8Array(pointer.readByteArray(Math.min(size, 16)));
    return Array.from(bytes, function (value) {
      return value.toString(16).padStart(2, '0');
    }).join('');
  } catch (_) {
    return null;
  }
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

function interestingPath(path) {
  if (!path) {
    return false;
  }
  const lower = path.toLowerCase();
  return (
    lower.indexOf('3dshapes') !== -1 ||
    lower.indexOf('portrait') !== -1 ||
    lower.indexOf('skill') !== -1 ||
    lower.indexOf('beast') !== -1 ||
    lower.indexOf('mesh') !== -1 ||
    lower.indexOf('.gim') !== -1 ||
    lower.indexOf('icon') !== -1
  );
}

function install(libGame) {
  if (installed) {
    return;
  }
  installed = true;

  Interceptor.attach(libGame.base.add(PATH_FORMAT_RVA), {
    onEnter(args) {
      this.idHex = bytesHex(args[0], 16);
      this.result = this.context.x8;
    },
    onLeave() {
      if (events >= MAX_EVENTS) {
        return;
      }
      if (!this.idHex || BLOCKERS[this.idHex]) {
        return;
      }
      const path = readMaybeString(this.result);
      if (!interestingPath(path) && !(path && path.indexOf('/') !== -1)) {
        return;
      }
      events += 1;
      log('local-path-format', {
        idHex: this.idHex,
        path: path,
        interesting: interestingPath(path)
      });
    }
  });

  Interceptor.attach(libGame.base.add(DYNAMIC_URL_RVA), {
    onEnter(args) {
      this.idHex = bytesHex(args[0], 16);
      this.result = this.context.x8;
    },
    onLeave() {
      if (events >= MAX_EVENTS) {
        return;
      }
      if (!this.idHex || BLOCKERS[this.idHex]) {
        return;
      }
      const url = readMaybeString(this.result);
      if (!url) {
        return;
      }
      // Still log local-looking relative pieces; skip pure remote shapeconfig names.
      if (url.indexOf('shapeconfig') !== -1) {
        return;
      }
      events += 1;
      log('local-dynamic-url', { idHex: this.idHex, url: url });
    }
  });

  log('local-path-probe-ready', {
    pathFormat: '0x' + PATH_FORMAT_RVA.toString(16),
    dynamicUrl: '0x' + DYNAMIC_URL_RVA.toString(16)
  });
}

function wait() {
  const mod = Process.findModuleByName('libGame.so');
  if (mod) {
    install(mod);
    return;
  }
  setTimeout(wait, 200);
}

wait();
log('local-path-probe-loaded');
