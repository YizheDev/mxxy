'use strict';

/*
 * Runtime DEX/CDex dumper for the owned com.netease.my test package.
 *
 * The on-disk .unzip/classes.dex emitted by libunisec uses a private format.
 * This script scans readable process mappings for structurally valid standard
 * DEX headers and writes only those complete mappings into the app files dir.
 * It does not alter bytecode or application behavior.
 */

const outputDir = '/data/user/0/com.netease.my/files/frida-dex';
const maxDexSize = 256 * 1024 * 1024;
const seen = new Set();

function log(kind, fields) {
  send(Object.assign({ kind: kind, ts: Date.now() }, fields || {}));
}

function findExport(name) {
  try {
    return Module.findGlobalExportByName(name);
  } catch (_) {
    return null;
  }
}

function ensureOutputDir() {
  const address = findExport('mkdir');
  if (address === null) {
    throw new Error('mkdir export not found');
  }
  const mkdir = new NativeFunction(address, 'int', ['pointer', 'uint']);
  mkdir(Memory.allocUtf8String(outputDir), 0x1c0);
}

function magicAt(address) {
  try {
    const bytes = new Uint8Array(address.readByteArray(8));
    const text = Array.from(bytes).map(function (value) {
      return String.fromCharCode(value);
    }).join('');
    if (text.indexOf('dex\n03') === 0 || text.indexOf('cdex00') === 0) {
      return text.slice(0, 7).replace('\n', '\\n');
    }
  } catch (_) {
    // Ignore an unreadable candidate.
  }
  return null;
}

function validateDex(address, range) {
  try {
    const magic = magicAt(address);
    if (magic === null) {
      return null;
    }
    const fileSize = address.add(0x20).readU32();
    const headerSize = address.add(0x24).readU32();
    const endianTag = address.add(0x28).readU32();
    if (fileSize < 0x70 || fileSize > maxDexSize) {
      return null;
    }
    if (headerSize < 0x70 || headerSize > 0x200) {
      return null;
    }
    if (endianTag !== 0x12345678 && endianTag !== 0x78563412) {
      return null;
    }
    if (address.add(fileSize).compare(range.base.add(range.size)) > 0) {
      return null;
    }
    return { magic: magic, fileSize: fileSize, headerSize: headerSize };
  } catch (_) {
    return null;
  }
}

function dumpDex(address, metadata) {
  const key = address.toString() + ':' + metadata.fileSize;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);

  const suffix = address.toString().replace(/^0x/, '');
  const extension = metadata.magic.indexOf('cdex') === 0 ? '.cdex' : '.dex';
  const path = outputDir + '/memory-' + suffix + '-' + metadata.fileSize + extension;
  try {
    const file = new File(path, 'wb');
    file.write(address.readByteArray(metadata.fileSize));
    file.flush();
    file.close();
    log('dex-dumped', {
      address: address.toString(),
      path: path,
      magic: metadata.magic,
      fileSize: metadata.fileSize,
      headerSize: metadata.headerSize
    });
  } catch (error) {
    log('dump-error', {
      address: address.toString(),
      fileSize: metadata.fileSize,
      error: String(error)
    });
  }
}

function scanPattern(range, pattern, done) {
  Memory.scan(range.base, range.size, pattern, {
    onMatch(address) {
      const metadata = validateDex(address, range);
      if (metadata !== null) {
        dumpDex(address, metadata);
      }
    },
    onError(reason) {
      log('scan-error', {
        base: range.base.toString(),
        size: range.size,
        reason: String(reason)
      });
    },
    onComplete: done
  });
}

function scanRanges() {
  ensureOutputDir();
  const ranges = Process.enumerateRanges({ protection: 'r--', coalesce: true });
  let pending = ranges.length * 2;
  if (pending === 0) {
    log('complete', { ranges: 0, dumps: 0 });
    return;
  }

  function finishedOne() {
    pending -= 1;
    if (pending === 0) {
      log('complete', { ranges: ranges.length, dumps: seen.size });
    }
  }

  ranges.forEach(function (range) {
    scanPattern(range, '64 65 78 0a 30 33 ?? 00', finishedOne);
    scanPattern(range, '63 64 65 78 30 30 ?? 00', finishedOne);
  });
}

setImmediate(function () {
  log('ready', { package: 'com.netease.my', outputDir: outputDir });
  scanRanges();
});
