/**
 * Zero-Native JS Runtime
 * Batched op queue, host communication, timers, and event routing.
 */

declare global {
  function __zn_flush(opsJson: string): void;
  function __zn_log(level: number, msg: string): void;
  function __zn_setTimeout(id: number, delayMs: number): void;
  function __zn_clearTimeout(id: number): void;
  function __zn_now(): number;
  var __zn_event: (id: number, eventName: string, payloadJson: string) => void;
  var __zn_timerFired: (id: number) => void;
}

export type ZnOp =
  | ["c", number, string] // create node: id, type
  | ["p", number, string, any] // set prop: id, key, value
  | ["i", number, number, number] // insert child: parentId, childId, index
  | ["r", number] // remove node: id
  | ["a", number, string, any, any] // animate prop: id, prop, target, spec
  | ["nav", string, ...any[]]; // navigation op: "push" | "pop" | "replace"

let nextNodeId = 1;
export function allocateNodeId(): number {
  return nextNodeId++;
}
export function ensureNodeIdAbove(id: number) {
  if (id >= nextNodeId) {
    nextNodeId = id + 1;
  }
}

let currentBatch: ZnOp[] = [];
let isFlushScheduled = false;

export function scheduleFlush() {
  if (!isFlushScheduled) {
    isFlushScheduled = true;
    // Microtask flush
    Promise.resolve().then(flushBatch);
  }
}

export function queueOp(op: ZnOp) {
  currentBatch.push(op);
  scheduleFlush();
}

export function flushBatch() {
  if (currentBatch.length === 0) {
    isFlushScheduled = false;
    return;
  }
  const ops = currentBatch;
  currentBatch = [];
  isFlushScheduled = false;

  if (typeof __zn_flush === "function") {
    __zn_flush(JSON.stringify(ops));
  } else {
    console.log("[zn mock flush]", JSON.stringify(ops));
  }
}

// --- Event Handling ---
const eventHandlers = new Map<string, (payload?: any) => void>();

export function registerEventHandler(nodeId: number, eventName: string, handler: (payload?: any) => void) {
  if (typeof __zn_log === "function") {
    __zn_log(1, `[EVENT_REG] ${nodeId}:${eventName} -> typeof: ${typeof handler}, val: ${String(handler).slice(0, 40)}`);
  }
  eventHandlers.set(`${nodeId}:${eventName}`, handler);
}

export function unregisterEventHandler(nodeId: number, eventName: string) {
  eventHandlers.delete(`${nodeId}:${eventName}`);
}

globalThis.__zn_event = function (nodeId: number, eventName: string, payloadJson: string) {
  const key = `${nodeId}:${eventName}`;
  const handler = eventHandlers.get(key);
  if (typeof __zn_log === "function") {
    __zn_log(1, `[EVENT_DISP] key: ${key}, handler typeof: ${typeof handler}`);
  }
  if (typeof handler === "function") {
    try {
      const payload = payloadJson ? JSON.parse(payloadJson) : undefined;
      handler(payload);
    } catch (e) {
      console.error(`Error in event handler ${key}`, e);
    }
  } else {
    console.error(`Handler for ${key} is not a function (typeof: ${typeof handler})`);
  }
};

// --- Timers on top of __zn_setTimeout ---
let nextTimerId = 1;
const activeTimers = new Map<number, () => void>();

globalThis.__zn_timerFired = function (id: number) {
  const cb = activeTimers.get(id);
  if (cb) {
    activeTimers.delete(id);
    try {
      cb();
    } catch (e) {
      console.error("Error in timer callback", e);
    }
  }
};

export function setTimeoutPolyfill(fn: () => void, delayMs: number): number {
  const id = nextTimerId++;
  activeTimers.set(id, fn);
  if (typeof __zn_setTimeout === "function") {
    __zn_setTimeout(id, delayMs);
  } else {
    setTimeout(fn, delayMs);
  }
  return id;
}

export function clearTimeoutPolyfill(id: number) {
  activeTimers.delete(id);
  if (typeof __zn_clearTimeout === "function") {
    __zn_clearTimeout(id);
  } else {
    clearTimeout(id);
  }
}

let nextIntervalId = 1;
const activeIntervals = new Map<number, () => void>();

export function setIntervalPolyfill(fn: () => void, intervalMs: number): number {
  const handleId = nextIntervalId++;
  let currentTimeoutId: number | null = null;
  let isCancelled = false;

  function tick() {
    if (isCancelled) return;
    fn();
    if (!isCancelled) {
      currentTimeoutId = setTimeoutPolyfill(tick, intervalMs);
    }
  }

  currentTimeoutId = setTimeoutPolyfill(tick, intervalMs);

  activeIntervals.set(handleId, () => {
    isCancelled = true;
    if (currentTimeoutId !== null) {
      clearTimeoutPolyfill(currentTimeoutId);
      currentTimeoutId = null;
    }
  });

  return handleId;
}

export function clearIntervalPolyfill(handleId: number) {
  const cancel = activeIntervals.get(handleId);
  if (cancel) {
    cancel();
    activeIntervals.delete(handleId);
  }
}

// Wire globals if in Hermes
if (typeof setTimeout === "undefined" || typeof __zn_setTimeout === "function") {
  globalThis.setTimeout = setTimeoutPolyfill as any;
  globalThis.clearTimeout = clearTimeoutPolyfill as any;
  globalThis.setInterval = setIntervalPolyfill as any;
  globalThis.clearInterval = clearIntervalPolyfill as any;
}

// Define console object on globalThis for Hermes V1
globalThis.console = {
  log: (...args: any[]) => {
    if (typeof __zn_log === "function") __zn_log(1, args.map(String).join(" "));
  },
  warn: (...args: any[]) => {
    if (typeof __zn_log === "function") __zn_log(2, args.map(String).join(" "));
  },
  error: (...args: any[]) => {
    if (typeof __zn_log === "function") __zn_log(3, args.map(String).join(" "));
  },
} as any;
