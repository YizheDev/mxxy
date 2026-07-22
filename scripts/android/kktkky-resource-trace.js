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
const watchedZipHandles = new Map();
const markerHits = new Set();
const resolvedApkHits = new Set();
const maxReadEventsPerFd = 12;
const maxMapEventsPerFd = 24;
const maxHashResReadEvents = 64;
let hashResReadEvents = 0;
let inflateEvents = 0;
let libGameHooksInstalled = false;
// Optional compact map from kktkky_apk_hashres_map.py:
// [data_offset, data_end, name, method, file_size]
const apkHashResMap = (typeof HASHRES_APK_MAP !== 'undefined' && Array.isArray(HASHRES_APK_MAP))
  ? HASHRES_APK_MAP
  : [];

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

function readLibcppString(value) {
  if (!value || value.isNull()) {
    return null;
  }
  try {
    const tag = value.readU8();
    let size;
    let data;
    if ((tag & 1) === 0) {
      size = tag >> 1;
      data = value.add(1);
    } else {
      size = Number(value.add(8).readU64().toString());
      data = value.add(16).readPointer();
    }
    if (size < 0 || size > 16384 || data.isNull()) {
      return null;
    }
    return data.readUtf8String(size);
  } catch (_) {
    return null;
  }
}

function interestingPath(path) {
  return Boolean(path) && (
    path.indexOf('HashRes') !== -1 ||
    path.indexOf('/pkres/') !== -1 ||
    path.indexOf('.wpk') !== -1 ||
    path.indexOf('.idx') !== -1 ||
    path.indexOf('.thi') !== -1 ||
    path.indexOf('.thx') !== -1 ||
    path.indexOf('shapeconfig') !== -1
  );
}

function containerPath(path) {
  if (!path) {
    return false;
  }
  return path.endsWith('/base.apk') ||
    path.indexOf('/base.apk!') !== -1 ||
    path.indexOf('split_config.') !== -1 && path.endsWith('.apk');
}

function lookupApkHashRes(offset) {
  if (!apkHashResMap.length || offset < 0) {
    return null;
  }
  let low = 0;
  let high = apkHashResMap.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const row = apkHashResMap[mid];
    const start = row[0];
    const end = row[1];
    if (offset < start) {
      high = mid - 1;
    } else if (offset >= end) {
      low = mid + 1;
    } else {
      return {
        name: row[2],
        method: row[3],
        fileSize: row[4],
        dataOffset: start,
        dataEnd: end,
        entryOffset: offset - start
      };
    }
  }
  return null;
}

function parseOffset(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 0);
    return Number.isFinite(parsed) ? parsed : null;
  }
  try {
    return parseInt(value.toString(), 0);
  } catch (_) {
    return null;
  }
}

function describeContainerAccess(path, absoluteOffset) {
  if (!containerPath(path) || absoluteOffset === null || absoluteOffset === undefined) {
    return null;
  }
  const offsetNumber = parseOffset(absoluteOffset);
  if (offsetNumber === null) {
    return null;
  }
  const hit = lookupApkHashRes(offsetNumber);
  if (!hit) {
    return { apkOffset: offsetNumber, hashres: null };
  }
  const key = hit.name + ':' + Math.floor(hit.entryOffset / 65536);
  if (!resolvedApkHits.has(key)) {
    resolvedApkHits.add(key);
    log('apk-hashres', {
      path: path,
      apkOffset: offsetNumber,
      entry: hit.name,
      entryOffset: hit.entryOffset,
      method: hit.method,
      fileSize: hit.fileSize
    });
  }
  return { apkOffset: offsetNumber, hashres: hit };
}

function watchablePath(path) {
  return interestingPath(path) || containerPath(path);
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
  if (size < 4) {
    return null;
  }
  try {
    const head = pointer.readByteArray(Math.min(size, 16));
    const bytes = new Uint8Array(head);
    if (bytes.length >= 4) {
      const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
      if (magic === 'SKPW' || magic === 'THDO' || magic === 'THDX') {
        return magic;
      }
    }
  } catch (_) {}
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
      if (fd >= 0 && watchablePath(this.path)) {
        watchedFds.set(fd, { path: this.path, reads: 0, maps: 0, source: name });
        log('open', {
          api: name,
          fd: fd,
          path: this.path,
          container: containerPath(this.path)
        });
      }
    }
  });
}

function copyWatchedFd(oldFd, newFd, api) {
  const item = watchedFds.get(oldFd);
  if (!item || newFd < 0) {
    return;
  }
  watchedFds.set(newFd, Object.assign({}, item, { source: api }));
  log('fd-duplicate', { api: api, oldFd: oldFd, newFd: newFd, path: item.path });
}

function hookLseek() {
  for (const name of ['lseek', 'lseek64']) {
    const address = findExport(name);
    if (address === null) {
      continue;
    }
    Interceptor.attach(address, {
      onEnter(args) {
        this.fd = args[0].toInt32();
        this.offset = args[1].toString();
        this.whence = args[2].toInt32();
      },
      onLeave(retval) {
        const item = watchedFds.get(this.fd);
        if (!item) {
          return;
        }
        const result = retval.toInt32();
        if (result >= 0) {
          item.position = result;
        }
        if (item.lseeks === undefined) {
          item.lseeks = 0;
        }
        const resolved = describeContainerAccess(item.path, result);
        if (item.lseeks < 8 || (resolved && resolved.hashres)) {
          log('resource-lseek', {
            api: name,
            fd: this.fd,
            path: item.path,
            offset: this.offset,
            whence: this.whence,
            result: result,
            hashres: resolved && resolved.hashres ? resolved.hashres.name : null
          });
        }
        item.lseeks += 1;
      }
    });
  }
}

function hookFdDuplication() {
  for (const name of ['dup', 'dup2', 'dup3']) {
    const address = findExport(name);
    if (address === null) {
      continue;
    }
    Interceptor.attach(address, {
      onEnter(args) {
        this.oldFd = args[0].toInt32();
      },
      onLeave(retval) {
        copyWatchedFd(this.oldFd, retval.toInt32(), name);
      }
    });
  }
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
        this.manager = args[0].toString();
        this.path = readCString(args[1]);
      },
      onLeave(retval) {
        if (retval.isNull()) {
          return;
        }
        if (interestingPath(this.path) || (this.path && this.path.indexOf('HashRes') !== -1)) {
          watchedAssets.set(retval.toString(), { path: this.path, reads: 0, manager: this.manager });
          log('asset-open', { asset: retval.toString(), path: this.path });
        }
      }
    });
  }

  for (const spec of [
    { name: 'AAssetManager_openFileDescriptor', wide: false },
    { name: 'AAssetManager_openFileDescriptor64', wide: true }
  ]) {
    const address = findExport(spec.name);
    if (address === null) {
      continue;
    }
    Interceptor.attach(address, {
      onEnter(args) {
        this.path = readCString(args[1]);
        this.startPointer = args[2];
        this.lengthPointer = args[3];
      },
      onLeave(retval) {
        const fd = retval.toInt32();
        if (fd < 0 || !watchablePath(this.path) && !(this.path && this.path.indexOf('HashRes') !== -1)) {
          return;
        }
        const wideOffset = spec.wide || Process.pointerSize === 8;
        const start = readAssetOffset(this.startPointer, wideOffset);
        const length = readAssetOffset(this.lengthPointer, wideOffset);
        const absolute = start !== null ? Number(start) : null;
        const resolved = absolute !== null ? lookupApkHashRes(absolute) : null;
        watchedFds.set(fd, {
          path: 'asset-manager://' + this.path,
          assetPath: this.path,
          assetOffset: start,
          assetLength: length,
          reads: 0,
          maps: 0,
          source: spec.name
        });
        log('asset-manager-fd', {
          api: spec.name,
          path: this.path,
          fd: fd,
          start: start,
          length: length,
          hashres: resolved,
          caller: moduleOffset(this.returnAddress),
          backtrace: backtrace(this.context)
        });
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

function readAssetOffset(pointer, wide) {
  if (pointer.isNull()) {
    return null;
  }
  try {
    return wide ? pointer.readS64().toString() : pointer.readS32().toString();
  } catch (_) {
    return null;
  }
}

function hookAssetFileDescriptorApi() {
  for (const spec of [
    { name: 'AAsset_openFileDescriptor', wide: false },
    { name: 'AAsset_openFileDescriptor64', wide: true }
  ]) {
    const address = findExport(spec.name);
    if (address === null) {
      continue;
    }
    Interceptor.attach(address, {
      onEnter(args) {
        this.asset = args[0].toString();
        this.startPointer = args[1];
        this.lengthPointer = args[2];
      },
      onLeave(retval) {
        const fd = retval.toInt32();
        const item = watchedAssets.get(this.asset);
        if (fd < 0 || !item) {
          return;
        }
        const wideOffset = spec.wide || Process.pointerSize === 8;
        const start = readAssetOffset(this.startPointer, wideOffset);
        const length = readAssetOffset(this.lengthPointer, wideOffset);
        watchedFds.set(fd, {
          path: 'asset://' + item.path,
          assetPath: item.path,
          assetOffset: start,
          assetLength: length,
          reads: 0,
          maps: 0,
          source: spec.name
        });
        log('asset-fd', {
          api: spec.name,
          asset: this.asset,
          path: item.path,
          fd: fd,
          start: start,
          length: length,
          caller: moduleOffset(this.returnAddress),
          backtrace: backtrace(this.context)
        });
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
      let absoluteOffset = parseOffset(this.offset);
      if (absoluteOffset === null && item.assetOffset) {
        absoluteOffset = parseOffset(item.assetOffset);
      }
      if (absoluteOffset === null && item.position !== undefined) {
        absoluteOffset = item.position;
      }
      const resolved = describeContainerAccess(item.path, absoluteOffset);
      const hashresHit = Boolean(resolved && resolved.hashres);
      if (hashresHit && hashResReadEvents < maxHashResReadEvents) {
        hashResReadEvents += 1;
      }
      if (
        item.reads < maxReadEventsPerFd ||
        marker !== null ||
        (hashresHit && hashResReadEvents <= maxHashResReadEvents)
      ) {
        log('resource-read', {
          api: name,
          fd: this.fd,
          path: item.path,
          offset: this.offset,
          absoluteOffset: absoluteOffset,
          requested: this.requested,
          size: size,
          marker: marker,
          hashres: resolved && resolved.hashres ? resolved.hashres.name : null,
          entryOffset: resolved && resolved.hashres ? resolved.hashres.entryOffset : null,
          prefix: bytesHex(this.buffer, size),
          caller: moduleOffset(this.returnAddress)
        });
      }
      if (item.position !== undefined) {
        item.position += size;
      } else if (absoluteOffset !== null) {
        item.position = absoluteOffset + size;
      }
      item.reads += 1;
    }
  });
}

function hookMmap(name) {
  const address = findExport(name);
  if (address === null) {
    return;
  }
  Interceptor.attach(address, {
    onEnter(args) {
      this.length = args[1].toUInt32();
      this.protection = args[2].toInt32();
      this.flags = args[3].toInt32();
      this.fd = args[4].toInt32();
      this.offset = args[5].toString();
    },
    onLeave(retval) {
      const item = watchedFds.get(this.fd);
      if (!item || retval.equals(ptr(-1))) {
        return;
      }
      if (item.maps >= maxMapEventsPerFd) {
        item.maps += 1;
        return;
      }
      const readable = (this.protection & 1) !== 0;
      const marker = readable ? markerAt(retval, Math.min(this.length, 32)) : null;
      const mapOffset = parseOffset(this.offset) || 0;
      const assetBase = parseOffset(item.assetOffset);
      const absoluteOffset = assetBase !== null ? assetBase + mapOffset : mapOffset;
      const resolved = describeContainerAccess(item.path, absoluteOffset);
      log('resource-map', {
        api: name,
        fd: this.fd,
        path: item.path,
        assetPath: item.assetPath || null,
        assetOffset: item.assetOffset || null,
        assetLength: item.assetLength || null,
        mapOffset: this.offset,
        address: retval.toString(),
        length: this.length,
        protection: this.protection,
        flags: this.flags,
        marker: marker,
        hashres: resolved && resolved.hashres ? resolved.hashres.name : null,
        entryOffset: resolved && resolved.hashres ? resolved.hashres.entryOffset : null,
        prefix: readable ? bytesHex(retval, Math.min(this.length, 96)) : null,
        caller: moduleOffset(this.returnAddress),
        backtrace: item.assetPath || marker !== null || (resolved && resolved.hashres)
          ? backtrace(this.context)
          : null
      });
      item.maps += 1;
    }
  });
}

function hookZipApi() {
  for (const name of ['unzOpen', 'unzOpen64', 'unzOpen2', 'unzOpen2_64']) {
    const address = findExport(name);
    if (address === null) {
      continue;
    }
    Interceptor.attach(address, {
      onEnter(args) {
        this.path = readCString(args[0]);
      },
      onLeave(retval) {
        if (!retval.isNull() && (watchablePath(this.path) || containerPath(this.path))) {
          watchedZipHandles.set(retval.toString(), { path: this.path, current: null, reads: 0 });
          log('zip-open', { api: name, handle: retval.toString(), path: this.path });
        }
      }
    });
  }

  const locate = findExport('unzLocateFile');
  if (locate !== null) {
    Interceptor.attach(locate, {
      onEnter(args) {
        this.handle = args[0].toString();
        this.name = readCString(args[1]);
      },
      onLeave(retval) {
        let item = watchedZipHandles.get(this.handle);
        if (!item && (interestingPath(this.name) || (this.name && this.name.indexOf('HashRes') !== -1))) {
          item = { path: '<unknown-zip>', current: null, reads: 0 };
          watchedZipHandles.set(this.handle, item);
        }
        if (item && retval.toInt32() === 0) {
          item.current = this.name;
          item.reads = 0;
          log('zip-locate', {
            handle: this.handle,
            archive: item.path,
            entry: this.name,
            caller: moduleOffset(this.returnAddress)
          });
        }
      }
    });
  }

  for (const name of ['unzOpenCurrentFile', 'unzOpenCurrentFile3']) {
    const address = findExport(name);
    if (address === null) {
      continue;
    }
    Interceptor.attach(address, {
      onEnter(args) {
        this.handle = args[0].toString();
      },
      onLeave(retval) {
        const item = watchedZipHandles.get(this.handle);
        if (!item) {
          return;
        }
        log('zip-open-current', {
          api: name,
          handle: this.handle,
          archive: item.path,
          entry: item.current,
          result: retval.toInt32(),
          caller: moduleOffset(this.returnAddress)
        });
      }
    });
  }

  const readCurrent = findExport('unzReadCurrentFile');
  if (readCurrent !== null) {
    Interceptor.attach(readCurrent, {
      onEnter(args) {
        this.handle = args[0].toString();
        this.buffer = args[1];
        this.requested = args[2].toUInt32();
      },
      onLeave(retval) {
        const item = watchedZipHandles.get(this.handle);
        const size = retval.toInt32();
        if (!item || size <= 0) {
          return;
        }
        const interesting = interestingPath(item.current) ||
          (item.current && item.current.indexOf('HashRes') !== -1);
        if (!interesting) {
          return;
        }
        const marker = markerAt(this.buffer, size);
        if (item.reads < maxReadEventsPerFd || marker !== null) {
          log('zip-read', {
            handle: this.handle,
            archive: item.path,
            entry: item.current,
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

  const close = findExport('unzClose');
  if (close !== null) {
    Interceptor.attach(close, {
      onEnter(args) {
        watchedZipHandles.delete(args[0].toString());
      }
    });
  }
}

function hookInflate() {
  const inflate = findExport('inflate');
  if (inflate === null) {
    return;
  }
  Interceptor.attach(inflate, {
    onEnter(args) {
      this.stream = args[0];
      try {
        this.nextIn = this.stream.readPointer();
        this.availIn = this.stream.add(Process.pointerSize).readU32();
        this.nextOut = this.stream.add(Process.pointerSize * 3).readPointer();
        this.availOut = this.stream.add(Process.pointerSize * 4).readU32();
      } catch (_) {
        this.nextIn = null;
      }
      this.inputMarker = this.nextIn && !this.nextIn.isNull()
        ? markerAt(this.nextIn, Math.min(this.availIn || 0, 32))
        : null;
      this.caller = moduleOffset(this.returnAddress);
    },
    onLeave(retval) {
      if (this.inputMarker === null && this.caller.module !== 'libGame.so') {
        return;
      }
      if (inflateEvents >= 48 && this.inputMarker === null) {
        return;
      }
      let outputMarker = null;
      let outputPrefix = null;
      try {
        const nextOut = this.stream.add(Process.pointerSize * 3).readPointer();
        const availOut = this.stream.add(Process.pointerSize * 4).readU32();
        const produced = (this.availOut || 0) - availOut;
        if (produced > 0 && nextOut && !nextOut.isNull()) {
          outputMarker = markerAt(nextOut.sub(produced), Math.min(produced, 32));
          outputPrefix = bytesHex(nextOut.sub(produced), Math.min(produced, 96));
        }
      } catch (_) {}
      if (this.inputMarker === null && outputMarker === null) {
        return;
      }
      inflateEvents += 1;
      log('zlib-inflate', {
        result: retval.toInt32(),
        inputMarker: this.inputMarker,
        outputMarker: outputMarker,
        inputPrefix: this.nextIn ? bytesHex(this.nextIn, Math.min(this.availIn || 0, 96)) : null,
        outputPrefix: outputPrefix,
        caller: this.caller,
        backtrace: backtrace(this.context)
      });
    }
  });
}

function hookUncompress(name, sourceLengthIsPointer) {
  const address = findExport(name);
  if (address === null) {
    return;
  }
  Interceptor.attach(address, {
    onEnter(args) {
      this.destination = args[0];
      this.destinationLength = args[1];
      this.source = args[2];
      this.sourceSize = sourceLengthIsPointer
        ? Number(args[3].readU64().toString())
        : args[3].toUInt32();
      this.inputMarker = markerAt(this.source, Math.min(this.sourceSize, 32));
      this.caller = moduleOffset(this.returnAddress);
    },
    onLeave(retval) {
      let outputSize = 0;
      try {
        outputSize = Number(this.destinationLength.readU64().toString());
      } catch (_) {
        return;
      }
      const outputMarker = markerAt(this.destination, Math.min(outputSize, 32));
      if (this.inputMarker === null && outputMarker === null && this.caller.module !== 'libGame.so') {
        return;
      }
      if (inflateEvents >= 24 && this.inputMarker === null && outputMarker === null) {
        return;
      }
      inflateEvents += 1;
      log('zlib-uncompress', {
        api: name,
        result: retval.toInt32(),
        sourceSize: this.sourceSize,
        outputSize: outputSize,
        inputMarker: this.inputMarker,
        outputMarker: outputMarker,
        inputPrefix: bytesHex(this.source, Math.min(this.sourceSize, 96)),
        outputPrefix: bytesHex(this.destination, Math.min(outputSize, 96)),
        caller: this.caller
      });
    }
  });
}

function hookLibGameCStringSetter(module, name, rva) {
  const address = module.base.add(rva);
  Interceptor.attach(address, {
    onEnter(args) {
      const values = [];
      for (let i = 0; i < 4; i++) {
        const cstr = readCString(args[i]);
        const libcpp = readLibcppString(args[i]);
        if (cstr || libcpp) {
          values.push({ arg: i, cstr: cstr, libcpp: libcpp });
        }
      }
      log('libgame-url-base-set', {
        name: name,
        rva: '0x' + rva.toString(16),
        value: values.length ? values[0].cstr || values[0].libcpp : null,
        values: values,
        x0: args[0].toString(),
        caller: moduleOffset(this.returnAddress),
        backtrace: backtrace(this.context)
      });
    }
  });
}

function hookLibGameStringResult(module, name, rva) {
  const address = module.base.add(rva);
  Interceptor.attach(address, {
    onEnter(args) {
      this.owner = args[0];
      this.arg1 = args[1];
      this.result = this.context.x8;
      this.idHex = null;
      try {
        this.idHex = bytesHex(args[0], 16);
      } catch (_) {}
    },
    onLeave() {
      const value = readLibcppString(this.result) || readCString(this.result);
      log('libgame-string-result', {
        name: name,
        rva: '0x' + rva.toString(16),
        owner: this.owner.toString(),
        resultStorage: this.result.toString(),
        value: value,
        idHex: this.idHex,
        shapeconfig: Boolean(value && value.indexOf('shapeconfig') !== -1),
        caller: moduleOffset(this.returnAddress),
        backtrace: backtrace(this.context)
      });
    }
  });
}

function installLibGameHooks() {
  if (libGameHooksInstalled) {
    return true;
  }
  let module;
  try {
    module = Process.getModuleByName('libGame.so');
  } catch (_) {
    return false;
  }
  // Function prologues only — mid-instruction ADRP site hooks destabilize the process.
  const targets = [
    0x1cb53c0, // relative path format
    0x1cb6040, // static CDN base getter
    0x1cb60d4, // dynamic CDN base getter
    0x1cb6a10, // dynamic base helper
    0x1cb6a70, // static base helper
    0x1cbb4e4  // dynamic resource URL builder
  ];
  for (const rva of targets) {
    if (rva >= module.size) {
      log('libgame-target-hooks-skipped', {
        reason: 'rva-outside-module',
        rva: '0x' + rva.toString(16),
        moduleSize: module.size
      });
      return false;
    }
  }

  // These RVAs apply only to the authorized libGame.so listed in the artifact
  // manifest (SHA-256 65fb...e7f9a). They are observation hooks and never
  // replace the URL or return value.
  hookLibGameStringResult(module, 'relative-resource-path', 0x1cb53c0);
  hookLibGameStringResult(module, 'static-base-get', 0x1cb6040);
  hookLibGameStringResult(module, 'dynamic-base-get', 0x1cb60d4);
  hookLibGameCStringSetter(module, 'dynamic-base-fn', 0x1cb6a10);
  hookLibGameCStringSetter(module, 'static-base-fn', 0x1cb6a70);
  hookLibGameStringResult(module, 'dynamic-resource-url', 0x1cbb4e4);
  libGameHooksInstalled = true;
  log('libgame-target-hooks-ready', {
    base: module.base.toString(),
    size: module.size,
    targets: targets.map(function (rva) { return '0x' + rva.toString(16); }),
    xrefSitesNoted: [
      '0x1cb6050', '0x1cb60a4', '0x1cb6a8c', '0x1cb753c',
      '0x1cb60e4', '0x1cb6138', '0x1cb6a2c', '0x1cb727c', '0x1cbb504', '0x1cbb568'
    ]
  });
  return true;
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
  hookFdDuplication();
  hookAssetOpen();
  hookAssetFileDescriptorApi();
  const libGamePoll = setInterval(function () {
    if (installLibGameHooks()) {
      clearInterval(libGamePoll);
    }
  }, 100);
  log('ready', {
    package: 'com.netease.my',
    purpose: 'resource-decoder-discovery',
    apkHashResMapEntries: apkHashResMap.length
  });

  // read/pread and libc comparison functions are extremely hot during ART's
  // pre-initialized spawn phase. Attaching them immediately can destabilize
  // perfetto_hprof on Android 11 userdebug images. Path opens stay active from
  // process start; data and marker hooks are enabled before resource startup.
  setTimeout(function () {
    hookAssetDataApi();
    hookLseek();
    hookRead('read', false);
    hookRead('pread', true);
    hookRead('pread64', true);
    hookMmap('mmap');
    hookMmap('mmap64');
    hookZipApi();
    log('resource-io-hooks-ready', { delayMs: 1500 });
  }, 1500);

  setTimeout(function () {
    hookMemcmp();
    hookStringCompare('strcmp');
    hookStringCompare('strncmp');
    log('marker-hooks-ready', { delayMs: 800 });
  }, 800);

  setTimeout(function () {
    hookUncompress('uncompress', false);
    hookUncompress('uncompress2', true);
    hookInflate();
    log('zlib-hooks-ready', { delayMs: 4000 });
  }, 4000);
});
