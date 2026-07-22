'use strict';

/*
 * Shortest 3-step patch fail-open (no CDN forgery, no device-side network).
 *
 * Step1: MessiahNativeActivity.showPatcher* → no-op + Platform.OnPatcherAlert(1)
 * Step2: PatchListProxy.needDownload → false; start → 0
 * Step3: sendFinishMsg remap list/DNS/patch failures → code 0
 *
 * CRITICAL: Platform/SplashDialog live in com.netease.messiah (NOT .game).
 *
 * Usage (device track; this file itself does NOT attach):
 *   frida -U -n com.netease.my -l patch-failopen.js
 *   # or spawn with early Java: prefer performNow / attach-after-privacy
 */

function log(kind, fields) {
  send(Object.assign({ kind: kind, ts: Date.now() }, fields || {}));
}

function callOnPatcherAlert(arg) {
  try {
    const Platform = Java.use('com.netease.messiah.Platform');
    Platform.OnPatcherAlert(arg);
    log('failopen-OnPatcherAlert', { arg: arg, pkg: 'com.netease.messiah' });
    return true;
  } catch (e1) {
    try {
      // fallback only for diagnosis
      const Platform2 = Java.use('com.netease.game.Platform');
      Platform2.OnPatcherAlert(arg);
      log('failopen-OnPatcherAlert', { arg: arg, pkg: 'com.netease.game' });
      return true;
    } catch (e2) {
      log('failopen-OnPatcherAlert-miss', {
        messiah: String(e1),
        game: String(e2)
      });
      return false;
    }
  }
}

function installFailOpen() {
  // --- Step 1: kill latch UI + nudge native continue ---
  try {
    const Act = Java.use('com.netease.game.MessiahNativeActivity');
    ['showPatcherRepair', 'showPatcherAlert', 'showPatcherHint'].forEach(function (name) {
      try {
        Act[name].implementation = function () {
          const args = Array.prototype.slice.call(arguments).map(String);
          log('failopen-showPatcher-skip', { method: name, args: args.slice(0, 3) });
          if (name !== 'showPatcherHint') {
            callOnPatcherAlert(1);
          }
        };
        log('hooked', { target: 'MessiahNativeActivity.' + name });
      } catch (err) {
        log('hook-miss', { target: 'MessiahNativeActivity.' + name, error: String(err) });
      }
    });
    try {
      Act.onClickPatchRepair.implementation = function (view) {
        log('failopen-onClickPatchRepair', {});
        callOnPatcherAlert(1);
      };
      log('hooked', { target: 'MessiahNativeActivity.onClickPatchRepair' });
    } catch (err) {
      log('hook-miss', { target: 'onClickPatchRepair', error: String(err) });
    }
  } catch (err) {
    log('hook-miss', { target: 'MessiahNativeActivity', error: String(err) });
  }

  try {
    const Splash = Java.use('com.netease.messiah.SplashDialog');
    ['showPatcherRepair', 'showPatcherHint', 'showPatcherAlert'].forEach(function (name) {
      try {
        if (Splash[name]) {
          Splash[name].implementation = function () {
            log('failopen-splash-skip', { method: name });
          };
          log('hooked', { target: 'SplashDialog.' + name });
        }
      } catch (err) {
        log('hook-miss', { target: 'SplashDialog.' + name, error: String(err) });
      }
    });
  } catch (err) {
    log('hook-miss', { target: 'SplashDialog', error: String(err) });
  }

  // --- Step 2: short-circuit list download ---
  try {
    const Proxy = Java.use('com.netease.download.list.PatchListProxy');
    // needDownload→false makes start() take the verified skip exit:
    // sendFinishMsg(0, …) + return 0 (no HTTP).
    Proxy.needDownload.implementation = function () {
      log('failopen-needDownload', { ret: false });
      return false;
    };
    log('hooked', { target: 'PatchListProxy.needDownload' });
  } catch (err) {
    log('hook-miss', { target: 'PatchListProxy', error: String(err) });
  }

  // --- Step 3: remap finish codes (local signal only) ---
  try {
    const Handler = Java.use(
      'com.netease.download.listener.DownloadListenerProxy$DownloadListenerHandler'
    );
    Handler.sendFinishMsg
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
      const p = path ? String(path) : '';
      if (
        code !== 0 &&
        (n.indexOf('DOWNLOAD') !== -1 ||
          n.indexOf('list') !== -1 ||
          n.indexOf('List') !== -1 ||
          n.indexOf('patch') !== -1 ||
          p.indexOf('list') !== -1 ||
          p.indexOf('patch') !== -1)
      ) {
        log('failopen-finish-remap', { from: code, name: n, path: p });
        code = 0;
      }
      return this.sendFinishMsg(code, a, b, name, path, bytes, sid, orbit);
    };
    log('hooked', { target: 'DownloadListenerHandler.sendFinishMsg' });
  } catch (err) {
    log('hook-miss', { target: 'sendFinishMsg', error: String(err) });
  }

  // Late nudge if latch already on screen when hooks arm
  for (const delay of [2000, 5000, 10000, 15000]) {
    setTimeout(function () {
      callOnPatcherAlert(1);
    }, delay);
  }

  log('patch-failopen-ready', { steps: 3 });
}

function armJava() {
  if (typeof Java === 'undefined' || !Java.available) {
    setTimeout(armJava, 200);
    return;
  }
  const run = function () {
    try {
      installFailOpen();
    } catch (err) {
      log('java-install-failed', { error: String(err) });
      setTimeout(armJava, 500);
    }
  };
  try {
    if (Java.performNow) {
      Java.performNow(run);
    } else {
      Java.perform(run);
    }
  } catch (err) {
    log('java-perform-failed', { error: String(err) });
    setTimeout(function () {
      try {
        Java.perform(run);
      } catch (err2) {
        log('java-perform-retry-failed', { error: String(err2) });
      }
    }, 800);
  }
}

setImmediate(function () {
  log('patch-failopen-loaded', {});
  armJava();
});
