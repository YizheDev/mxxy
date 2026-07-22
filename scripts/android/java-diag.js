'use strict';
// Minimal Java diagnostics for Frida spawn mode
send({ kind: 'diag-start', ts: Date.now(), frida: Frida.version });

let javaChecks = 0;
let vmChecks = 0;

function checkJava() {
    javaChecks++;
    try {
        if (typeof Java !== 'undefined') {
            send({ kind: 'diag-java-defined', ts: Date.now(), available: Java.available, checks: javaChecks });
            if (Java.available) {
                try {
                    Java.performNow(function() {
                        send({ kind: 'diag-java-perform-ok', ts: Date.now() });
                    });
                } catch(e) {
                    send({ kind: 'diag-java-perform-failed', ts: Date.now(), error: String(e) });
                }
                return; // done
            }
        } else {
            if (javaChecks === 1 || javaChecks % 10 === 0) {
                send({ kind: 'diag-java-undefined', ts: Date.now(), checks: javaChecks });
            }
        }
    } catch(e) {
        if (javaChecks === 1 || javaChecks % 10 === 0) {
            send({ kind: 'diag-java-check-error', ts: Date.now(), checks: javaChecks, error: String(e) });
        }
    }

    try {
        if (typeof Dalvik !== 'undefined') {
            send({ kind: 'diag-dalvik-available', ts: Date.now(), checks: javaChecks });
        }
    } catch(e) {}

    // Check VM status via Process
    try {
        const mods = Process.enumerateModules();
        const dexMods = mods.filter(function(m) { return m.name.indexOf('.dex') !== -1 || m.name.indexOf('oat') !== -1; });
        if (dexMods.length > 0 && vmChecks === 0) {
            send({ kind: 'diag-vm-modules', ts: Date.now(), dexCount: dexMods.length, sample: dexMods.slice(0,3).map(function(m) { return m.name; }) });
        }
        vmChecks++;
    } catch(e) {}

    if (javaChecks < 300) { // check for 60 seconds
        setTimeout(checkJava, 200);
    } else {
        send({ kind: 'diag-timeout', ts: Date.now(), checks: javaChecks });
    }
}

setImmediate(checkJava);
