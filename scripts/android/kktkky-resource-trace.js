'use strict';

/*
 * Resource decoder discovery tracer for com.netease.my.
 *
 * Run only on an isolated test device. The script records reads from HashRes
 * containers and backtraces code that compares the private resource markers.
 * It does not alter files, network traffic, purchases, or server state.
 */

const watchedFds = new Map();
const watchedAssets = new Map();
const markerHits = new Set();
const maxReadEventsPerFd = 12;

function log(kind, fields) {
  send(Object.assign({ kind: kind, ts: Date.now() }, fields || {}));
}

function findExport(name) {
  try {
    return Module.findGlobalExportByName(name);
  } catch (_) {
    try {
      return Module.findExportByName(null, name);
    } catch (_) {
      return null;
    }
  }
}

function readCString(value) {
  try {
    return value.isNull() ? null : value.readUtf8String();
  } catch (_) {
    return null;
  }
}

function interestingPath(path) {
  return Boolean(path) && (
    path.indexOf('HashRes') !== -1 ||
    path.indexOf('.wpk') !== -1 ||
    path.indexOf('.idx') !== -1 ||
    path.indexOf('.thi') !== -1 ||
    path.indexOf('.thx') !== -1
  );
}

function bytesHex(pointer, size) {
  try {
    const count = Math.min(size, 96);
    const bytes = new Uint8Array(pointer.readByteArray(count));
    return Array.from(bytes, function (value) {
      return value.toString(16).padStart(2, '0');
    }).join('');
  } catch (_) {
    return null;
  }
}

function markerAt(pointer, size) {
  if (size < 8) {
    return null;
  }
  try {
    const text = pointer.readUtf8String(Math.min(size, 32));
    for (const marker of ['_g18RC4_', '_g18xxh_', '_g18IMG_', 'TEX_SIZE']) {
      if (text.indexOf(marker) !== -1) {
        return marker;
      }
    }
  } catch (_) {
    // Binary buffers commonly fail UTF-8 decoding.
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
    offset: address.sub(module.base).toString()
  };
}

function backtrace(context) {
  return Thread.backtrace(context, Backtracer.ACCURATE).slice(0, 16).map(function (address) {
    return moduleOffset(address);
  });
}

function hookOpen(name, pathArgument) {
  const address = findExport(name);
  if (address === null) {
    return;
  }
  Interceptor.attach(address, {
    onEnter(args) {
      this.path = readCString(args[pathArgument]);
    },
    onLeave(retval) {
      const fd = retval.toInt32();
      if (fd >= 0 && interestingPath(this.path)) {
        watchedFds.set(fd, { path: this.path, reads: 0 });
        log('open', { api: name, fd: fd, path: this.path });
      }
    }
  });
}

function hookClose() {
  const address = findExport('close');
  if (address === null) {
    return;
  }
  Interceptor.attach(address, {
    onEnter(args) {
      this.fd = args[0].toInt32();
    },
    onLeave() {
      watchedFds.delete(this.fd);
    }
  });
}

function hookAssetOpen() {
  const openAddress = findExport('AAssetManager_open');
  if (openAddress !== null) {
    Interceptor.attach(openAddress, {
      onEnter(args) {
        this.path = readCString(args[1]);
      },
      onLeave(retval) {
        if (!retval.isNull() && interestingPath(this.path)) {
          watchedAssets.set(retval.toString(), { path: this.path, reads: 0 });
          log('asset-open', { asset: retval.toString(), path: this.path });
        }
      }
    });
  }
}

function hookAssetDataApi() {
  const readAddress = findExport('AAsset_read');
  if (readAddress !== null) {
    Interceptor.attach(readAddress, {
      onEnter(args) {
        this.asset = args[0].toString();
        this.buffer = args[1];
        this.requested = args[2].toUInt32();
      },
      onLeave(retval) {
        const item = watchedAssets.get(this.asset);
        const size = retval.toInt32();
        if (!item || size <= 0) {
          return;
        }
        const marker = markerAt(this.buffer, size);
        if (item.reads < maxReadEventsPerFd || marker !== null) {
          log('asset-read', {
            asset: this.asset,
            path: item.path,
            requested: this.requested,
            size: size,
            marker: marker,
            prefix: bytesHex(this.buffer, size),
            caller: moduleOffset(this.returnAddress)
          });
        }
        item.reads += 1;
      }
    });
  }

  const getBufferAddress = findExport('AAsset_getBuffer');
  if (getBufferAddress !== null) {
    Interceptor.attach(getBufferAddress, {
      onEnter(args) {
        this.asset = args[0].toString();
      },
      onLeave(retval) {
        const item = watchedAssets.get(this.asset);
        if (!item || retval.isNull()) {
          return;
        }
        log('asset-buffer', {
          asset: this.asset,
          path: item.path,
          marker: markerAt(retval, 32),
          prefix: bytesHex(retval, 96),
          caller: moduleOffset(this.returnAddress)
        });
      }
    });
  }

  const closeAddress = findExport('AAsset_close');
  if (closeAddress !== null) {
    Interceptor.attach(closeAddress, {
      onEnter(args) {
        watchedAssets.delete(args[0].toString());
      }
    });
  }
}

function hookRead(name, hasOffset) {
  const address = findExport(name);
  if (address === null) {
    return;
  }
  Interceptor.attach(address, {
    onEnter(args) {
      this.fd = args[0].toInt32();
      this.buffer = args[1];
      this.requested = args[2].toUInt32();
      this.offset = hasOffset ? args[3].toString() : null;
    },
    onLeave(retval) {
      const item = watchedFds.get(this.fd);
      const size = retval.toInt32();
      if (!item || size <= 0) {
        return;
      }
      const marker = markerAt(this.buffer, size);
      if (item.reads < maxReadEventsPerFd || marker !== null) {
        log('resource-read', {
          api: name,
          fd: this.fd,
          path: item.path,
          offset: this.offset,
          requested: this.requested,
          size: size,
          marker: marker,
          prefix: bytesHex(this.buffer, size),
          caller: moduleOffset(this.returnAddress)
        });
      }
      item.reads += 1;
    }
  });
}

function candidateMarker(pointer, size) {
  const marker = markerAt(pointer, size);
  if (marker === '_g18RC4_' || marker === '_g18xxh_' || marker === '_g18IMG_') {
    return marker;
  }
  return null;
}

function reportMarkerComparison(api, pointer, size, context, returnAddress) {
  const marker = candidateMarker(pointer, size);
  if (marker === null) {
    return;
  }
  const caller = moduleOffset(returnAddress);
  const key = api + ':' + marker + ':' + JSON.stringify(caller);
  if (markerHits.has(key)) {
    return;
  }
  markerHits.add(key);
  log('marker-compare', {
    api: api,
    marker: marker,
    caller: caller,
    backtrace: backtrace(context)
  });
}

function hookMemcmp() {
  const address = findExport('memcmp');
  if (address === null) {
    return;
  }
  Interceptor.attach(address, {
    onEnter(args) {
      const size = args[2].toUInt32();
      if (size < 8 || size > 32) {
        return;
      }
      reportMarkerComparison('memcmp:a', args[0], size, this.context, this.returnAddress);
      reportMarkerComparison('memcmp:b', args[1], size, this.context, this.returnAddress);
    }
  });
}

function hookStringCompare(name) {
  const address = findExport(name);
  if (address === null) {
    return;
  }
  Interceptor.attach(address, {
    onEnter(args) {
      const size = name === 'strncmp' ? Math.min(args[2].toUInt32(), 32) : 32;
      reportMarkerComparison(name + ':a', args[0], size, this.context, this.returnAddress);
      reportMarkerComparison(name + ':b', args[1], size, this.context, this.returnAddress);
    }
  });
}

setImmediate(function () {
  hookOpen('open', 0);
  hookOpen('open64', 0);
  hookOpen('openat', 1);
  hookOpen('openat64', 1);
  hookClose();
  hookAssetOpen();
  log('ready', { package: 'com.netease.my', purpose: 'resource-decoder-discovery' });

  // read/pread and libc comparison functions are extremely hot during ART's
  // pre-initialized spawn phase. Attaching them immediately can destabilize
  // perfetto_hprof on Android 11 userdebug images. Path opens stay active from
  // process start; data and marker hooks are enabled before resource startup.
  setTimeout(function () {
    hookAssetDataApi();
    hookRead('read', false);
    hookRead('pread64', true);
    log('resource-io-hooks-ready', { delayMs: 1500 });
  }, 1500);

  setTimeout(function () {
    hookMemcmp();
    hookStringCompare('strcmp');
    hookStringCompare('strncmp');
    log('marker-hooks-ready', { delayMs: 2500 });
  }, 2500);
});
