// Checkpoint 1 test script
let nextTimerId = 1;
const timerCallbacks = new Map();

globalThis.__zn_timerFired = function(id) {
    const cb = timerCallbacks.get(id);
    if (cb) {
        timerCallbacks.delete(id);
        cb();
    }
};

globalThis.setTimeout = function(fn, delayMs) {
    const id = nextTimerId++;
    timerCallbacks.set(id, fn);
    __zn_setTimeout(id, delayMs);
    return id;
};

globalThis.clearTimeout = function(id) {
    timerCallbacks.delete(id);
    __zn_clearTimeout(id);
};

// 1. Evaluate 1 + 1 and log "zn: 2"
const sum = 1 + 1;
__zn_log(1, "zn: " + sum);

// 2. Test __zn_now()
const now = __zn_now();
__zn_log(1, "zn: uptime ms = " + now);

// 3. Fire setTimeout(..., 500)
setTimeout(() => {
    __zn_log(1, "zn: timer fired after 500ms!");
    __zn_flush(JSON.stringify([["test", "ok"]]));
}, 500);
