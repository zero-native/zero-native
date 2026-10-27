/**
 * Zero-Native Fine-Grained Reactive Signals
 * Clean, lightweight dependency-free reactive graph.
 */

type Subscriber = () => void;

interface Computation {
  run(): void;
  dependencies: Set<Set<Computation>>;
}

let activeSubscriber: Computation | null = null;
let isUntracking = false;
let batchDepth = 0;
const pendingEffects = new Set<Computation>();

export function untrack<T>(fn: () => T): T {
  const prevUntracking = isUntracking;
  isUntracking = true;
  try {
    return fn();
  } finally {
    isUntracking = prevUntracking;
  }
}

export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) {
      flushPendingEffects();
    }
  }
}

function flushPendingEffects() {
  while (pendingEffects.size > 0) {
    const effectsToRun = Array.from(pendingEffects);
    pendingEffects.clear();
    for (const effect of effectsToRun) {
      effect.run();
    }
  }
}

export type SignalGetter<T> = () => T;
export type SignalSetter<T> = (value: T | ((prev: T) => T)) => void;

export function signal<T>(initialValue: T): [SignalGetter<T>, SignalSetter<T>] {
  let value = initialValue;
  const subscribers = new Set<Computation>();

  const get: SignalGetter<T> = () => {
    if (activeSubscriber && !isUntracking) {
      subscribers.add(activeSubscriber);
      activeSubscriber.dependencies.add(subscribers);
    }
    return value;
  };

  const set: SignalSetter<T> = (next) => {
    const nextVal = typeof next === "function" ? (next as (p: T) => T)(value) : next;
    if (!Object.is(value, nextVal)) {
      value = nextVal;
      for (const sub of Array.from(subscribers)) {
        if (batchDepth > 0) {
          pendingEffects.add(sub);
        } else {
          try {
            sub.run();
          } catch (e: any) {
            console.error("[SUB_ERROR]", e?.message, e?.stack);
          }
        }
      }
    }
  };

  return [get, set];
}

export function computed<T>(fn: () => T): SignalGetter<T> {
  let cachedValue: T;
  let isDirty = true;
  const subscribers = new Set<Computation>();

  const computation: Computation = {
    dependencies: new Set(),
    run() {
      if (!isDirty) {
        isDirty = true;
        for (const sub of Array.from(subscribers)) {
          if (batchDepth > 0) {
            pendingEffects.add(sub);
          } else {
            try {
              sub.run();
            } catch (e: any) {
              console.error("[COMP_SUB_ERROR]", e?.message, e?.stack);
            }
          }
        }
      }
    },
  };

  return () => {
    if (activeSubscriber && !isUntracking) {
      subscribers.add(activeSubscriber);
      activeSubscriber.dependencies.add(subscribers);
    }

    if (isDirty) {
      cleanupDependencies(computation);
      const prev = activeSubscriber;
      activeSubscriber = computation;
      try {
        cachedValue = fn();
        isDirty = false;
      } catch (e: any) {
        console.error("[COMPUTED_FN_ERROR]", e?.message, e?.stack);
        throw e;
      } finally {
        activeSubscriber = prev;
      }
    }

    return cachedValue;
  };
}

export function effect(fn: () => void | (() => void)): () => void {
  let cleanup: (() => void) | void;
  let isDisposed = false;

  const computation: Computation = {
    dependencies: new Set(),
    run() {
      if (isDisposed) return;
      if (typeof cleanup === "function") {
        try {
          cleanup();
        } catch (e: any) {
          console.error("Error in effect cleanup", e?.message, e?.stack);
        }
        cleanup = undefined;
      }
      cleanupDependencies(computation);
      const prev = activeSubscriber;
      activeSubscriber = computation;
      try {
        const res = fn();
        cleanup = typeof res === "function" ? res : undefined;
      } catch (e: any) {
        console.error("[EFFECT_FN_ERROR]", e?.message, e?.stack);
        throw e;
      } finally {
        activeSubscriber = prev;
      }
    },
  };

  computation.run();

  return () => {
    isDisposed = true;
    if (typeof cleanup === "function") {
      cleanup();
      cleanup = undefined;
    }
    cleanupDependencies(computation);
  };
}

function cleanupDependencies(comp: Computation) {
  for (const depSet of comp.dependencies) {
    depSet.delete(comp);
  }
  comp.dependencies.clear();
}
