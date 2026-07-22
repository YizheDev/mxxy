'use strict';

/*
 * Pre-unpack tracer for com.netease.my.
 * It records candidate files, DEX loaders, native libraries and JNI bindings.
 * It does not modify app files or bypass server-side controls.
 */

const watchedFds = new Map();

function log(kind, fields) {
  send(Object.assign({ kind: kind, ts: Date.now() }, fields || {}));
}

function readCString(pointer) {
  try {
    if (pointer === null || pointer.isNull()) {
      return null;
    }
    return pointer.readUtf8String();
  } catch (_) {
    return null;
  }
}

function interestingPath(path) {
  if (!path) {
    return false;
  }
  return path.indexOf('.dex') !== -1 ||
    path.indexOf('_ntcfg') !== -1 ||
    path.indexOf('HashRes') !== -1 ||
    path.indexOf('libunisec') !== -1 ||
    path.indexOf('libGame') !== -1 ||
    path.indexOf('.wpk') !== -1 ||
    path.indexOf('.idx') !== -1;
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
        watchedFds.set(fd, this.path);
        log(name, { fd: fd, path: this.path });
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
      this.path = watchedFds.get(this.fd);
    },
    onLeave(retval) {
      if (this.path) {
        log('close', { fd: this.fd, path: this.path, result: retval.toInt32() });
        watchedFds.delete(this.fd);
      }
    }
  });
}

function hookDlopen(name) {
  const address = findExport(name);
  if (address === null) {
    return;
  }
  Interceptor.attach(address, {
    onEnter(args) {
      this.path = readCString(args[0]);
      if (this.path && (this.path.indexOf('libunisec') !== -1 || this.path.indexOf('libGame') !== -1)) {
        log(name, { phase: 'enter', path: this.path });
      }
    },
    onLeave(retval) {
      if (this.path && (this.path.indexOf('libunisec') !== -1 || this.path.indexOf('libGame') !== -1)) {
        log(name, { phase: 'leave', path: this.path, handle: retval.toString() });
      }
    }
  });
}

function hookAssetOpen() {
  const address = findExport('AAssetManager_open');
  if (address === null) {
    return;
  }
  Interceptor.attach(address, {
    onEnter(args) {
      const path = readCString(args[1]);
      if (interestingPath(path)) {
        log('AAssetManager_open', { path: path });
      }
    }
  });
}

function hookRegisterNatives() {
  let art;
  try {
    art = Process.getModuleByName('libart.so');
  } catch (_) {
    return;
  }

  const symbol = art.enumerateSymbols().find(function (item) {
    return item.name.indexOf('RegisterNatives') !== -1 && item.name.indexOf('CheckJNI') === -1;
  });
  if (!symbol) {
    return;
  }

  Interceptor.attach(symbol.address, {
    onEnter(args) {
      const methods = args[2];
      const count = args[3].toInt32();
      if (count <= 0 || count > 4096) {
        return;
      }
      for (let index = 0; index < count; index++) {
        try {
          const row = methods.add(index * Process.pointerSize * 3);
          const name = readCString(row.readPointer());
          const signature = readCString(row.add(Process.pointerSize).readPointer());
          const implementation = row.add(Process.pointerSize * 2).readPointer();
          const module = Process.findModuleByAddress(implementation);
          if (module && (module.name.indexOf('libGame') !== -1 || module.name.indexOf('libunisec') !== -1)) {
            log('RegisterNatives', {
              name: name,
              signature: signature,
              module: module.name,
              offset: implementation.sub(module.base).toString()
            });
          }
        } catch (_) {
          // Keep tracing the remaining entries if a single row is unreadable.
        }
      }
    }
  });
}

function hookJavaLoaders() {
  if (!Java.available) {
    return;
  }
  Java.perform(function () {
    try {
      const DexClassLoader = Java.use('dalvik.system.DexClassLoader');
      const init = DexClassLoader.$init.overload(
        'java.lang.String',
        'java.lang.String',
        'java.lang.String',
        'java.lang.ClassLoader'
      );
      init.implementation = function (dexPath, optimizedDirectory, librarySearchPath, parent) {
        log('DexClassLoader', {
          dexPath: String(dexPath),
          optimizedDirectory: optimizedDirectory ? String(optimizedDirectory) : null,
          librarySearchPath: librarySearchPath ? String(librarySearchPath) : null
        });
        return init.call(this, dexPath, optimizedDirectory, librarySearchPath, parent);
      };
    } catch (error) {
      log('hook-error', { target: 'DexClassLoader', error: String(error) });
    }

    try {
      const DexFile = Java.use('dalvik.system.DexFile');
      const loadDex = DexFile.loadDex.overload('java.lang.String', 'java.lang.String', 'int');
      loadDex.implementation = function (sourcePathName, outputPathName, flags) {
        log('DexFile.loadDex', {
          source: String(sourcePathName),
          output: outputPathName ? String(outputPathName) : null,
          flags: flags
        });
        return loadDex.call(this, sourcePathName, outputPathName, flags);
      };
    } catch (error) {
      log('hook-error', { target: 'DexFile.loadDex', error: String(error) });
    }

    // Do not replace System.loadLibrary here. Calling it through a Frida Java
    // wrapper changes the VM's caller-class lookup, so Android may search the
    // bootstrap namespace instead of the application's native library path.
    // The dlopen/android_dlopen_ext hooks above observe the same load without
    // perturbing class-loader semantics.
  });
}

setImmediate(function () {
  hookOpen('open', 0);
  hookOpen('open64', 0);
  hookOpen('openat', 1);
  hookOpen('openat64', 1);
  hookClose();
  hookDlopen('dlopen');
  hookDlopen('android_dlopen_ext');
  hookAssetOpen();
  hookRegisterNatives();
  hookJavaLoaders();
  log('ready', { package: 'com.netease.my' });
});
