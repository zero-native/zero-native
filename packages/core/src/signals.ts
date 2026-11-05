// Signals (ARCHITECTURE.md §5.2): signal, computed, effect, batch, untrack, plus owners for cleanup.
//
// How updates flow (push-pull, glitch-free):
// - A write marks direct observers DIRTY and everything further down CHECK ("maybe changed"). Effects are queued.
// - Queued effects run after the write (or at the end of the outermost batch). Before running, an effect asks its
//   sources to bring themselves up to date; a computed whose inputs didn't really change keeps its value, and then
//   nothing below it runs. So an effect never sees half-updated values (the "diamond" case v0 got wrong).
// - set() with an Object.is-equal value does nothing (v0 lesson).
//
// Owners: every effect / computed created while another computation runs is owned by it, and is disposed when the
// owner re-runs or is disposed. createRoot() makes an owner for a mounted instance; disposing it cleans up all
// effects, onCleanup callbacks and child instances created inside it.

const CLEAN = 0
const CHECK = 1
const DIRTY = 2

type Cleanup = () => void

import { reportError } from "./errors"

export class Owner {
  owned: Owner[] | null = null
  cleanups: Cleanup[] | null = null
  disposed = false
  parent: Owner | null = null

  own(child: Owner) {
    child.parent = this
    ;(this.owned ??= []).push(child)
  }

  /** Disposes children and runs cleanups (latest first). The owner can still be used again afterwards. */
  clear() {
    if (this.owned) {
      const owned = this.owned
      this.owned = null
      for (let i = owned.length - 1; i >= 0; i--) owned[i].dispose()
    }
    if (this.cleanups) {
      const cleanups = this.cleanups
      this.cleanups = null
      for (let i = cleanups.length - 1; i >= 0; i--) runSafely(cleanups[i], "cleanup")
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.clear()
    // Detach from the parent so long-lived owners don't collect disposed children (a branch toggled many times).
    const siblings = this.parent?.owned
    if (siblings) {
      const i = siblings.indexOf(this)
      if (i >= 0) siblings.splice(i, 1)
    }
    this.parent = null
  }
}

interface Source {
  observers: Set<Computation>
  updateIfNecessary(): void
}

class SignalNode<T> implements Source {
  observers = new Set<Computation>()
  constructor(public value: T) {}
  updateIfNecessary() {}
}

class Computation extends Owner implements Source {
  observers = new Set<Computation>()
  sources = new Set<Source & { observers: Set<Computation> }>()
  state = DIRTY
  value: unknown = undefined

  constructor(
    private fn: () => unknown,
    readonly isEffect: boolean,
    readonly equals: (a: unknown, b: unknown) => boolean = Object.is,
  ) {
    super()
  }

  /** Called when an input changed (DIRTY) or may have changed (CHECK). */
  stale(state: number) {
    if (this.disposed || this.state >= state) return
    if (this.state === CLEAN && this.isEffect) queue.push(this)
    this.state = state
    for (const o of this.observers) o.stale(CHECK)
  }

  updateIfNecessary() {
    if (this.disposed) return
    if (this.state === CHECK) {
      for (const s of this.sources) {
        s.updateIfNecessary()
        if ((this.state as number) === DIRTY) break
      }
    }
    if (this.state === DIRTY) this.run()
    this.state = CLEAN
  }

  private run() {
    this.clear() // dispose effects/computeds created by the previous run, run its cleanups
    for (const s of this.sources) s.observers.delete(this)
    this.sources.clear()

    const prevObserver = observer
    const prevOwner = owner
    observer = this
    owner = this
    let next: unknown
    let ran = false
    try {
      next = this.fn()
      ran = true
    } catch (e) {
      // An error must not break the reactive graph; effects log it, computeds keep their old value.
      reportError(this.isEffect ? "effect" : "computed", e)
      next = this.value
    } finally {
      observer = prevObserver
      owner = prevOwner
    }
    // RN's useEffect habit (second-opinions 114): an effect that returns a function gets it as its cleanup, run before
    // the next run and when the effect is disposed. After onCleanup ones, so it runs first (latest first). Not after a
    // throw: `next` is then the old value, whose cleanup already ran in clear().
    if (ran && this.isEffect && typeof next === "function") (this.cleanups ??= []).push(next as Cleanup)
    if (!this.equals(this.value, next)) {
      this.value = next
      // Direct observers that were only "maybe changed" are now definitely dirty.
      for (const o of this.observers) o.state = DIRTY
    }
  }

  override dispose() {
    if (this.disposed) return
    super.dispose()
    queue = queue.filter((q) => q !== this)
    for (const s of this.sources) s.observers.delete(this)
    this.sources.clear()
    this.observers.clear()
  }
}

let observer: Computation | null = null // the computation currently tracking reads
let owner: Owner | null = null // the owner new computations attach to
let batchDepth = 0
let queue: Computation[] = []
let flushing = false

function track(source: Source & { observers: Set<Computation> }) {
  if (observer && !observer.disposed) {
    source.observers.add(observer)
    observer.sources.add(source)
  }
}

function flush() {
  if (flushing || batchDepth > 0) return
  flushing = true
  try {
    // Effects may write signals and queue more effects; keep going until nothing is left.
    while (queue.length > 0) {
      const effects = queue
      queue = []
      for (const e of effects) e.updateIfNecessary()
    }
  } finally {
    flushing = false
  }
}

function runSafely(fn: () => void, what: string) {
  try {
    fn()
  } catch (e) {
    reportError(what, e)
  }
}


// ---- Public API --------------------------------------------------------------------------------------------------

export interface Signal<T> {
  (): T
  set(next: T | ((prev: T) => T)): void
  /** Read without subscribing. */
  peek(): T
}

export function signal<T>(initial: T, options?: { equals?: (a: T, b: T) => boolean }): Signal<T> {
  const node = new SignalNode(initial)
  const equals = options?.equals ?? Object.is
  const read = (() => {
    track(node)
    return node.value
  }) as Signal<T>
  read.peek = () => node.value
  read.set = (next) => {
    const value = typeof next === "function" ? (next as (p: T) => T)(node.value) : next
    if (equals(node.value, value)) return
    node.value = value
    for (const o of node.observers) o.stale(DIRTY)
    flush()
  }
  return read
}

/** A derived value, computed lazily and cached until an input changes. */
export function computed<T>(fn: () => T, options?: { equals?: (a: T, b: T) => boolean }): () => T {
  const c = new Computation(fn, false, options?.equals as any)
  owner?.own(c)
  return () => {
    track(c)
    c.updateIfNecessary()
    return c.value as T
  }
}

/**
 * Runs fn now and again whenever what it read changes. Returns a function that stops it.
 * If fn returns a function (as with React's useEffect), that is its cleanup: it runs before the next run and when the
 * effect stops. Same as calling onCleanup inside fn.
 */
export function effect(fn: () => void | Cleanup): () => void {
  const e = new Computation(fn, true)
  owner?.own(e)
  e.updateIfNecessary()
  return () => e.dispose()
}

/** Groups writes: effects run once, after the outermost batch. */
export function batch<T>(fn: () => T): T {
  batchDepth++
  try {
    return fn()
  } finally {
    batchDepth--
    flush()
  }
}

/** Reads signals inside fn without subscribing to them. */
export function untrack<T>(fn: () => T): T {
  const prev = observer
  observer = null
  try {
    return fn()
  } finally {
    observer = prev
  }
}

/** Registers a cleanup on the current owner (runs when the effect re-runs or the owner is disposed). */
export function onCleanup(fn: Cleanup): void {
  if (owner) (owner.cleanups ??= []).push(fn)
}

/** The owner new computations would attach to right now (null outside any root or computation). */
export function getOwner(): Owner | null {
  return owner
}

/** Runs fn with `o` as the owner and no tracking (used to mount children under their instance, not an effect). */
export function runWithOwner<T>(o: Owner | null, fn: () => T): T {
  const prevOwner = owner
  const prevObserver = observer
  owner = o
  observer = null
  try {
    return fn()
  } finally {
    owner = prevOwner
    observer = prevObserver
  }
}

/**
 * Runs fn with an owner no screen owns, on purpose: its timers, effects and native calls go on when the screen that
 * started it closes (a payment check must outlive its screen). They end when `stop` runs (fn gets it, and it is
 * returned) or when the JS runtime is replaced. Code after an `await` in fn has no owner, as everywhere: `stop` doesn't
 * reach timers started there.
 */
export function detached(fn: (stop: () => void) => void): () => void {
  return runWithOwner(null, () =>
    createRoot((stop) => {
      try {
        fn(stop)
      } catch (err) {
        stop()
        throw err
      }
      return stop
    }),
  )
}

/**
 * Runs fn with a new owner that isn't tracked by the caller. fn gets a dispose function. Used for mounted instances
 * (a screen, a conditional branch, a list row, a component).
 */
export function createRoot<T>(fn: (dispose: () => void) => T): T {
  const root = new Owner()
  owner?.own(root)
  const prevOwner = owner
  const prevObserver = observer
  owner = root
  observer = null
  try {
    return fn(() => root.dispose())
  } finally {
    owner = prevOwner
    observer = prevObserver
  }
}
