'use strict';

/*
 * Local-only privacy consent clicker for offline probes.
 * Delayed Java use only — early Java.perform during spawn can deadlock ART.
 */

function log(kind, fields) {
  send(Object.assign({ kind: kind, ts: Date.now() }, fields || {}));
}

function tryClickButtons() {
  if (typeof Java === 'undefined' || !Java.available) {
    return;
  }
  try {
    Java.performNow(function () {
      Java.choose('android.widget.Button', {
        onMatch(instance) {
          try {
            const text = instance.getText() ? instance.getText().toString() : '';
            let res = '';
            try {
              const id = instance.getId();
              if (id) {
                res = instance.getResources().getResourceEntryName(id);
              }
            } catch (_) {}
            if (
              text.indexOf('接受') !== -1 ||
              text.indexOf('同意') !== -1 ||
              res.indexOf('uni_p_confirm') !== -1
            ) {
              log('consent-auto', { text: text, res: res });
              instance.performClick();
            }
          } catch (_) {}
        },
        onComplete() {}
      });
    });
  } catch (error) {
    log('consent-error', { error: String(error) });
  }
}

// Wait until after native/ART settle; host adb taps remain the primary path.
setTimeout(function () {
  log('consent-armed');
  tryClickButtons();
  for (const delay of [3000, 6000, 10000, 15000]) {
    setTimeout(tryClickButtons, delay);
  }
}, 8000);

log('consent-script-loaded');
