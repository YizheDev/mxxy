'use strict';

/*
 * Local patch adaptation for offline single-player experiments.
 *
 * Does NOT forge HTTP responses or enable network. It only:
 * 1) Treats local patch-list downloads as already satisfied when possible.
 * 2) Auto-dismisses the offline patch-failure dialog so the session can
 *    continue probing local HashRes / decrypt paths.
 */

function log(kind, fields) {
  send(Object.assign({ kind: kind, ts: Date.now() }, fields || {}));
}

function armJava() {
  if (typeof Java === 'undefined' || !Java.available) {
    setTimeout(armJava, 500);
    return;
  }
  // Delay past early spawn; Java.perform too early deadlocks ART.
  setTimeout(function () {
    Java.perform(function () {
      try {
        const Proxy = Java.use('com.netease.download.list.PatchListProxy');
        Proxy.needDownload.implementation = function () {
          log('patch-needDownload-skip', {});
          return false;
        };
        log('patch-adapt-hooked', { target: 'PatchListProxy.needDownload' });
      } catch (error) {
        log('patch-adapt-miss', { target: 'PatchListProxy.needDownload', error: String(error) });
      }

      try {
        const Core = Java.use('com.netease.download.listener.DownloadListenerProxy$DownloadListenerCore');
        Core.sendFinishMsg.overload(
          'int', 'long', 'long', 'java.lang.String', 'java.lang.String',
          '[B', 'java.lang.String', 'java.lang.String'
        ).implementation = function (code, a, b, name, path, bytes, sid, orbit) {
          const n = name ? String(name) : '';
          if (code !== 0 && (n.indexOf('shapeconfig') !== -1 || n.indexOf('DOWNLOAD') !== -1 || n.indexOf('patch') !== -1)) {
            log('patch-finish-remap', { from: code, name: n, path: String(path) });
            code = 0;
          }
          return this.sendFinishMsg(code, a, b, name, path, bytes, sid, orbit);
        };
        log('patch-adapt-hooked', { target: 'DownloadListenerCore.sendFinishMsg' });
      } catch (error) {
        log('patch-adapt-miss', { target: 'sendFinishMsg', error: String(error) });
      }

      const dismiss = function () {
        try {
          Java.choose('android.widget.Button', {
            onMatch(instance) {
              try {
                const text = instance.getText() ? instance.getText().toString() : '';
                if (text === '确定' || text === '取消' || text.indexOf('接受') !== -1) {
                  log('patch-dialog-click', { text: text });
                  instance.performClick();
                }
              } catch (_) {}
            },
            onComplete() {}
          });
        } catch (_) {}
      };
      for (const delay of [10000, 15000, 20000, 30000, 45000]) {
        setTimeout(dismiss, delay);
      }
      log('patch-adapt-ready');
    });
  }, 6000);
}

armJava();
log('patch-adapt-loaded');
