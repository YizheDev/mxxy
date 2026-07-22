'use strict';

/*
 * Light device-track fail-open for G1 (no CDN success forgery).
 * - PatchListProxy.needDownload → false
 * - MessiahNativeActivity.showPatcher* → no-op
 * - buyProduct* → block real pay
 * - Light GLES capture + screencap trigger
 * Avoid heavy buffer dumps (prior ANR).
 */

const MAX_GL = 80;
const PATH_FORMAT_RVA = 0x1cb53c0;
const TARGET_SHAPES = { '4': true, '8': true, '15': true };
let glCount = 0;
let glSeen = 0;
let javaReady = false;
let gameReady = false;
let pathHits = 0;

function log(kind, fields) {
  send(Object.assign({ kind: kind, ts: Date.now() }, fields || {}));
}

function findExport(name) {
  try {
    if (Module.findGlobalExportByName) {
      const a = Module.findGlobalExportByName(name);
      if (a) return a;
    }
  } catch (_) {}
  try {
    return Module.findExportByName(null, name);
  } catch (_) {}
  return null;
}

function resolveExport(modName, name) {
  try {
    const mod = Process.findModuleByName(modName);
    if (mod) {
      const a = mod.findExportByName(name);
      if (a) return a;
    }
  } catch (_) {}
  return findExport(name);
}

function bytesHex(pointer, size) {
  try {
    const n = Math.min(size, 4096);
    if (!pointer || pointer.isNull() || n <= 0) return null;
    const bytes = new Uint8Array(pointer.readByteArray(n));
    return Array.from(bytes, function (v) {
      return ('0' + v.toString(16)).slice(-2);
    }).join('');
  } catch (_) {
    return null;
  }
}

function installGl() {
  ['glTexImage2D', 'glCompressedTexImage2D', 'glTexSubImage2D'].forEach(function (name) {
    const addr =
      resolveExport('libGLESv2.so', name) ||
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
        const width = args[3].toInt32();
        const height = args[4].toInt32();
        if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return;
        // Ignore tiny/zero uploads; keep UI-sized and up
        if (width < 16 || height < 16) return;
        glCount += 1;
        let size = 0;
        let dataPtr = null;
        const internal = args[2].toInt32();
        if (name.indexOf('Compressed') !== -1) {
          size = args[6].toInt32();
          dataPtr = args[7];
        } else {
          dataPtr = args[8];
          size = Math.min(width * height * 4, 4096);
        }
        log('gl-tex', {
          api: name,
          width: width,
          height: height,
          internal: '0x' + (internal >>> 0).toString(16),
          size: size,
          prefix: dataPtr && !dataPtr.isNull() ? bytesHex(dataPtr, Math.min(size, 128)) : null
        });
      }
    });
    log('gl-hooked', { name: name });
  });
}

function tryCallPatcherContinue() {
  try {
    const Platform = Java.use('com.netease.game.Platform');
    // Alert(1)=confirm path used by showPatcherAlert positive button
    if (Platform.OnPatcherAlert) {
      Platform.OnPatcherAlert(1);
      log('failopen-OnPatcherAlert', { arg: 1 });
    }
  } catch (error) {
    log('failopen-OnPatcherAlert-miss', { error: String(error) });
  }
}

function installJavaFailOpen(delayMs) {
  const delay = typeof delayMs === 'number' ? delayMs : 0;
  const arm = function () {
    if (typeof Java === 'undefined' || !Java.available) {
      setTimeout(arm, 300);
      return;
    }
    // Attach mode: perform immediately. Spawn mode: caller passes delay>0.
    setTimeout(function () {
      try {
        Java.perform(function () {
          if (javaReady) return;
          javaReady = true;

      // --- Patch fail-open ---
      try {
        const Proxy = Java.use('com.netease.download.list.PatchListProxy');
        Proxy.needDownload.implementation = function () {
          log('failopen-needDownload', { ret: false });
          return false;
        };
        log('hooked', { target: 'PatchListProxy.needDownload' });
      } catch (error) {
        log('hook-miss', { target: 'PatchListProxy.needDownload', error: String(error) });
      }

      try {
        const Core = Java.use('com.netease.download.list.PatchListCore');
        if (Core.needDownload) {
          Core.needDownload.implementation = function () {
            log('failopen-PatchListCore.needDownload', {});
            return false;
          };
          log('hooked', { target: 'PatchListCore.needDownload' });
        }
      } catch (error) {
        log('hook-miss', { target: 'PatchListCore.needDownload', error: String(error) });
      }

      // Remap download finish failures for shapeconfig/patch names to code 0
      // (local-complete signal only — does not invent CDN payload bytes).
      try {
        const DL = Java.use(
          'com.netease.download.listener.DownloadListenerProxy$DownloadListenerCore'
        );
        DL.sendFinishMsg
          .overload(
            'int',
            'long',
            'long',
            'java.lang.String',
            'java.lang.String',
            '[B',
            'java.lang.String',
            'java.lang.String'
          )
          .implementation = function (code, a, b, name, path, bytes, sid, orbit) {
          const n = name ? String(name) : '';
          if (
            code !== 0 &&
            (n.indexOf('shapeconfig') !== -1 ||
              n.indexOf('DOWNLOAD') !== -1 ||
              n.indexOf('patch') !== -1 ||
              n.indexOf('patchlist') !== -1)
          ) {
            log('failopen-finish-remap', { from: code, name: n });
            code = 0;
          }
          return this.sendFinishMsg(code, a, b, name, path, bytes, sid, orbit);
        };
        log('hooked', { target: 'DownloadListenerCore.sendFinishMsg' });
      } catch (error) {
        log('hook-miss', { target: 'sendFinishMsg', error: String(error) });
      }

      try {
        const Act = Java.use('com.netease.game.MessiahNativeActivity');
        ['showPatcherAlert', 'showPatcherHint', 'showPatcherRepair'].forEach(function (m) {
          try {
            Act[m].implementation = function () {
              const args = Array.prototype.slice.call(arguments).map(String);
              log('failopen-showPatcher-skip', { method: m, args: args.slice(0, 3) });
              // Skip UI; nudge native continue (no CDN forgery)
              tryCallPatcherContinue();
            };
            log('hooked', { target: 'MessiahNativeActivity.' + m });
          } catch (error) {
            log('hook-miss', { target: 'MessiahNativeActivity.' + m, error: String(error) });
          }
        });
        try {
          Act.onClickPatchRepair.implementation = function (view) {
            log('failopen-onClickPatchRepair-skip', {});
            tryCallPatcherContinue();
          };
          log('hooked', { target: 'MessiahNativeActivity.onClickPatchRepair' });
        } catch (error) {
          log('hook-miss', { target: 'onClickPatchRepair', error: String(error) });
        }
        try {
          if (Act.closePatcherAlert) {
            // leave available for rpc
          }
        } catch (_) {}
      } catch (error) {
        log('hook-miss', { target: 'MessiahNativeActivity', error: String(error) });
      }

      // SplashDialog variants if present
      try {
        const Splash = Java.use('com.netease.game.SplashDialog');
        ['showPatcherHint', 'showPatcherRepair', 'showPatcherAlert'].forEach(function (m) {
          try {
            if (Splash[m]) {
              Splash[m].implementation = function () {
                log('failopen-splash-skip', { method: m });
              };
              log('hooked', { target: 'SplashDialog.' + m });
            }
          } catch (error) {
            log('hook-miss', { target: 'SplashDialog.' + m, error: String(error) });
          }
        });
      } catch (error) {
        log('hook-miss', { target: 'SplashDialog', error: String(error) });
      }

      // --- Block real pay (record only; no fake success) ---
      try {
        const Sdk = Java.use('com.netease.my.SdkController');
        ['buyProduct', 'buyProductGas3'].forEach(function (m) {
          try {
            Sdk[m].implementation = function () {
              log('pay-blocked', { method: m });
              return;
            };
            log('hooked', { target: 'SdkController.' + m });
          } catch (error) {
            log('hook-miss', { target: 'SdkController.' + m, error: String(error) });
          }
        });
      } catch (error) {
        log('hook-miss', { target: 'SdkController.buy*', error: String(error) });
      }

      // --- Consent / dismiss common buttons ---
      const clickPass = function () {
        try {
          Java.choose('android.widget.Button', {
            onMatch(instance) {
              try {
                const text = instance.getText() ? instance.getText().toString() : '';
                let res = '';
                try {
                  const id = instance.getId();
                  if (id) res = instance.getResources().getResourceEntryName(id);
                } catch (_) {}
                if (
                  text.indexOf('接受') !== -1 ||
                  text.indexOf('同意') !== -1 ||
                  text === '确定' ||
                  text === '进入' ||
                  res.indexOf('uni_p_confirm') !== -1
                ) {
                  log('ui-auto-click', { text: text, res: res });
                  instance.performClick();
                }
              } catch (_) {}
            },
            onComplete() {}
          });
        } catch (_) {}
      };
      for (const d of [8000, 12000, 18000, 25000, 35000, 50000]) {
        setTimeout(clickPass, d);
      }

      log('java-failopen-ready');
        });
      } catch (error) {
        log('java-perform-failed', { error: String(error) });
        javaReady = false;
        setTimeout(function () {
          installJavaFailOpen(500);
        }, 800);
      }
    }, delay);
  };
  arm();
}

function interestingShapePath(s) {
  if (!s) return false;
  const lower = s.toLowerCase();
  if (lower.indexOf('photo/portrait/8') !== -1 || lower.indexOf('photo/portrait/4') !== -1 || lower.indexOf('photo/portrait/15') !== -1) {
    return true;
  }
  if (lower.indexOf('0008.mtg') !== -1 || lower.indexOf('0004.mtg') !== -1 || lower.indexOf('0015.mtg') !== -1) {
    return true;
  }
  if (lower.indexOf('3dshapes/0008') !== -1 || lower.indexOf('3dshapes/0004') !== -1 || lower.indexOf('3dshapes/0015') !== -1) {
    return true;
  }
  if (lower.indexOf('3dshapes/8') !== -1 || lower.indexOf('3dshapes/4/') !== -1) {
    return true;
  }
  return false;
}

function readMaybeString(ptr) {
  if (!ptr || ptr.isNull()) return null;
  try {
    const t = ptr.readUtf8String();
    if (t && t.length > 0 && t.length < 2048) return t;
  } catch (_) {}
  return null;
}

function installPathWatch(libGame) {
  Interceptor.attach(libGame.base.add(PATH_FORMAT_RVA), {
    onEnter(args) {
      this.a0 = args[0];
      this.a1 = args[1];
    },
    onLeave(retval) {
      if (pathHits >= 64) return;
      const s0 = readMaybeString(this.a0) || readMaybeString(retval);
      const s1 = readMaybeString(this.a1);
      const joined = [s0, s1].filter(Boolean).join(' | ');
      if (!interestingShapePath(joined) && !interestingShapePath(s0) && !interestingShapePath(s1)) {
        return;
      }
      pathHits += 1;
      log('shape-path', { s0: s0, s1: s1, priority: '8/4/15' });
    }
  });
  log('path-watch-ready', { targets: ['8', '4', '15'] });
}

function waitLibGame() {
  const tryInstall = function () {
    const mod = Process.findModuleByName('libGame.so');
    if (!mod || gameReady) return Boolean(mod && gameReady);
    gameReady = true;
    installGl();
    try {
      installPathWatch(mod);
    } catch (error) {
      log('path-watch-failed', { error: String(error) });
    }
    log('libGame-ready', { base: mod.base.toString(), pid: Process.id });
    return true;
  };
  if (!tryInstall()) {
    const dl = findExport('android_dlopen_ext') || findExport('dlopen');
    if (dl) {
      Interceptor.attach(dl, {
        onLeave() {
          tryInstall();
        }
      });
    }
    const t = setInterval(function () {
      if (tryInstall()) clearInterval(t);
    }, 250);
    log('waiting-libGame');
  }
}

rpc.exports = {
  stats() {
    return {
      glCount: glCount,
      glSeen: glSeen,
      javaReady: javaReady,
      gameReady: gameReady,
      pathHits: pathHits
    };
  }
};

// Prefer attach-after-start (delay 0). Spawn hosts should call rpc.armJava(4000).
installJavaFailOpen(0);
waitLibGame();
log('failopen-g1-loaded');

rpc.exports.armJava = function (delayMs) {
  javaReady = false;
  installJavaFailOpen(delayMs || 0);
  return true;
};
rpc.exports.nudgePatcher = function () {
  let ok = false;
  Java.perform(function () {
    try {
      tryCallPatcherContinue();
      ok = true;
    } catch (error) {
      log('nudge-failed', { error: String(error) });
    }
  });
  return ok;
};

// Record-only gameplay symbols for later (no hooks)
log('gameplay-symbols-deferred', {
  gacha: ['ImgBeastLottery', 'CLotteryBigAward', 'CSuperSummonGiftBox'],
  fusion: ['NewServerMergePets', 'cur_child_beast'],
  battle: ['BeastFight', 'NostalgiaBeastBattle', 'FightWinUI']
});
