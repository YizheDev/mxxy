'use strict';
// Hook __android_log_print via global export lookup to trace "Check header" call site

function log(kind, fields) {
    send(Object.assign({ kind: kind, ts: Date.now() }, fields || {}));
}

function findSym(name) {
    try {
        const a = Module.findGlobalExportByName(name);
        if (a) return a;
    } catch(_) {}
    try {
        return Module.findExportByName(null, name);
    } catch(_) {}
    return null;
}

// Try finding and hooking __android_log_print
const logPrint = findSym('__android_log_print');
log('sym-check', { name: '__android_log_print', found: !!logPrint, addr: logPrint ? logPrint.toString() : 'null' });

if (logPrint) {
    Interceptor.attach(logPrint, {
        onEnter(args) {
            const prio = args[0].toInt32();
            const tagPtr = args[1];
            const fmtPtr = args[2];

            if (tagPtr.isNull() || fmtPtr.isNull()) return;
            const tag = tagPtr.readCString();
            const fmt = fmtPtr.readCString();
            if (!tag || !fmt) return;

            // Match downloader logs
            if (tag.indexOf('Download') !== -1 || fmt.indexOf('Check header') !== -1 || fmt.indexOf('Get error') !== -1) {
                log('dl-log-hit', { prio: prio, tag: tag, fmt: fmt });

                // Capture backtrace
                const bt = Thread.backtrace(this.context, Backtracer.ACCURATE);
                const frames = bt.map(function(addr) {
                    const sym = DebugSymbol.fromAddress(addr);
                    return sym ? sym.toString() : addr.toString();
                });
                log('dl-log-bt', { tag: tag, fmt: fmt, bt: frames.slice(0, 15) });
            }
        }
    });
    log('hooked', { target: '__android_log_print' });
}

// Also try to enumerate libc exports for android_log functions
try {
    const libc = Process.findModuleByName('libc.so');
    if (libc) {
        const logFuncs = [];
        libc.enumerateExports().forEach(function(exp) {
            if (exp.name.indexOf('android_log') !== -1 || exp.name.indexOf('__android_log') !== -1) {
                logFuncs.push({ name: exp.name, addr: exp.address.toString() });
            }
        });
        log('libc-log-exports', { count: logFuncs.length, sample: logFuncs.slice(0, 10) });
    }
} catch(e) {
    log('libc-enum-err', { error: String(e) });
}

// Try curl
['curl_easy_perform', 'curl_easy_init'].forEach(function(n) {
    const a = findSym(n);
    if (a) {
        log('curl-found', { name: n, addr: a.toString() });
    }
});
