// The view runtime: what compiled TSX calls (ARCHITECTURE.md §5.3, §8.3). Authors don't call these directly.
//
// A component returns a View: its template id plus a setup function. Mounting a View creates an instance:
//   1. setup binds slots (each slot is an effect; its first value is collected) and events,
//   2. ready() sends MOUNT with the collected values (one op per instance, not one op plus K patches),
//   3. setup mounts children at anchors: components, conditionals (`&&`, `? :`) and lists (`.map`).
// Every instance has an owner (signals.ts). Disposing it stops its effects, events and child instances; only the
// top instance of a removed subtree sends REMOVE, because native removes the whole subtree.
import { motionSlotValue } from "./motion"
import { parseColor } from "./color"
import { reportError } from "./errors"
import { onEvent } from "./events"
import type { NativeValue } from "./native"
import { createRoot, effect, getOwner, onCleanup, runEventHandler, runWithOwner, untrack, type Owner } from "./signals"

export interface View {
  templateId: number
  setup: (inst: Instance) => void
}

export interface Instance {
  id: number
  /** Collected first slot values until ready() sends MOUNT; null once mounted (or for native-created roots). */
  collecting: NativeValue[] | null
  mount: { templateId: number; parent: number; anchor: number; index: number } | null
}

/** How a slot value is turned into a native value. */
export const SlotKind = { Plain: 0, Color: 1 } as const

interface Mounted {
  id: number
  /** remove: send REMOVE (only for the top of a removed subtree). */
  dispose(remove: boolean): void
}

// Instance ids allocated by JS. Native-allocated ids (screen roots) have the top bit set (ARCHITECTURE §8.3).
let nextInstanceId = 1
const JS_ID_LIMIT = 0x80000000

export function view(templateId: number, setup: (inst: Instance) => void): View {
  return { templateId, setup }
}

function toNative(v: unknown, kind: number): NativeValue {
  if (v === undefined || v === null) return null
  // A motion value or gesture (motion.ts): native follows it frame by frame.
  const motion = motionSlotValue(v)
  if (motion !== undefined) return motion
  if (kind === SlotKind.Color && typeof v === "string") return parseColor(v)
  if (typeof v === "string") return v.indexOf("\u0000f") > 0 || /\u0000f\d+\|\{.*\}./s.test(v) ? labelInText(v) : v
  if (typeof v === "number" || typeof v === "boolean") return v
  return String(v)
}

/**
 * `<Text>x {v.format()}</Text>`: the text joined around a motion label ("x \u0000f12|{...}") reached native as raw
 * characters (phone, 2026-11-09). The text before and after the label becomes its prefix and suffix, so native
 * still formats the number each frame. One label per Text; with more, the first one is kept and a warning logged.
 */
function labelInText(v: string): string {
  const at = v.indexOf("\u0000f")
  const bar = v.indexOf("|", at)
  if (bar < 0) return v
  for (let end = v.indexOf("}", bar); end >= 0; end = v.indexOf("}", end + 1)) {
    let f: Record<string, unknown>
    try {
      f = JSON.parse(v.slice(bar + 1, end + 1)) as Record<string, unknown>
    } catch {
      continue
    }
    let after = v.slice(end + 1)
    if (after.includes("\u0000f")) {
      globalThis.__zn_log(3, "Text: only one v.format(...) per <Text>; put each in its own <Text>")
      after = after.replace(/\u0000f\d+\|\{[^}]*\}/g, "")
    }
    f.p = v.slice(0, at) + (typeof f.p === "string" ? f.p : "")
    f.s = (typeof f.s === "string" ? f.s : "") + after
    return `${v.slice(at, bar + 1)}${JSON.stringify(f)}`
  }
  return v
}

/** Text content of a `<Text>` mixing literal text and `{expressions}`: null, undefined and false show nothing. */
export function str(v: unknown): string {
  if (v === null || v === undefined || v === false) return ""
  // A motion value as text (v.format(...)): native formats it each frame. Text around it: see labelInText.
  if (typeof v === "object" && typeof (v as { __znLabel?: unknown }).__znLabel === "string") return (v as { __znLabel: string }).__znLabel
  return String(v)
}

/** Binds one slot to an expression; re-sends it whenever what it reads changes. */
export function slot(inst: Instance, slotId: number, fn: () => unknown, kind: number = SlotKind.Plain): void {
  effect(() => {
    const value = toNative(fn(), kind)
    if (inst.collecting) inst.collecting[slotId] = value
    else if (answering?.inst === inst && answering.slot === slotId) return // textInput() answers instead
    else globalThis.__zn_patch(inst.id, slotId, value)
  })
}

/**
 * Binds a native event (tap, ...) of this instance to a handler. The handler runs under the instance's owner: an
 * interval or a listener it starts stops when the instance is disposed. Its native calls, timeouts and abort signals
 * belong to the screen (signals.ts oneShotOwner), so they end even if this instance goes away first.
 */
export function on(inst: Instance, eventId: number, handler: (payload: NativeValue) => void): void {
  const owner = getOwner()
  onCleanup(onEvent(inst.id, eventId, (payload) => runEventHandler(owner, () => handler(payload))))
}

/**
 * An event prop that is not a function written in place (`onPress={props.onPress}`, `onPress={busy() ? undefined : pay}`).
 * As in React Native, the event runs the handler the prop holds at that moment, and does nothing when it holds
 * `undefined` or `null` (RN's Pressability: `if (onPress != null) onPress(event)`). [get] reads the prop.
 */
export function latest(get: () => unknown): (payload: NativeValue) => void {
  return (payload) => {
    const h = untrack(get)
    if (h != null) (h as (payload: NativeValue) => void)(payload)
  }
}

/** Sends MOUNT for a JS-mounted instance, with the slot values collected so far. Safe to call twice. */
export function ready(inst: Instance): void {
  if (!inst.collecting || !inst.mount) {
    inst.collecting = null
    return
  }
  const values = Array.from(inst.collecting, (v) => (v === undefined ? null : v))
  inst.collecting = null
  const m = inst.mount
  globalThis.__zn_mount(m.templateId, m.parent, m.anchor, inst.id, m.index, values)
}

/**
 * Mounts a view as a child of `parent` at template node `anchor`, position `index`, owned by `owner`.
 * If building it throws, only this part fails (like Flutter's error widget, step 3.9): what it started is stopped,
 * what it already sent to native is removed, the error is reported, and the rest of the screen keeps working.
 * `guard` is the effect that mounted it (when / insert / each / list): it runs before this part's own effects
 * (signals.ts [runTop]), so the part is removed before it updates with a value the guard ruled out.
 */
function mountChild(
  owner: Owner | null,
  make: () => View,
  parent: number,
  anchor: number,
  index: number,
  guard: Owner | null = null,
): Mounted {
  return runWithOwner(owner, () =>
    createRoot((dispose) => {
      getOwner()!.guard = guard
      const id = allocInstanceId()
      let inst: Instance | null = null
      try {
        const v = make() // a component's body runs here, inside the instance's owner
        // `return null` (or undefined / false), as in React: nothing is drawn. What the body started (effects,
        // timers) lives on until the parent removes this part. Was a TypeError on `v.templateId` (RN sweep B1).
        if (v == null || (v as unknown) === false) return { id, dispose() { dispose() } }
        inst ={ id, collecting: [], mount: { templateId: v.templateId, parent, anchor, index } }
        v.setup(inst)
        ready(inst)
      } catch (e) {
        dispose()
        if (inst?.collecting === null) globalThis.__zn_remove(id) // its MOUNT was already sent
        reportError("a part of the screen (left empty)", e, "part")
        return { id, dispose() {} }
      }
      return {
        id,
        dispose(remove: boolean) {
          dispose()
          if (remove) globalThis.__zn_remove(id)
        },
      }
    }),
  )
}

/**
 * A List header / footer / empty value as a View. `ListHeaderComponent={props.header}` hands over what the parent
 * passed: JSX there is already a function that makes a View (see insert), and a component is a function too. So a
 * function is called (twice at most); null / undefined / false draw nothing. Before 2026-11-08 a function was mounted
 * as if it were a View, and nothing was drawn.
 */
function listExtra(v: unknown, depth = 0): View {
  if (typeof v === "function" && depth < 2) return listExtra((v as (p: object) => unknown)({}), depth + 1)
  return v as View
}

/** A component used in a template: mounted once at its anchor. */
export function component<P>(inst: Instance, anchor: number, Comp: (props: P) => View, props: P): void {
  ready(inst)
  mountChild(getOwner(), () => Comp(props), inst.id, anchor, 0)
}

/**
 * `{props.children}`, `{props.header}`: shows a View passed in by the parent (the compiler turns JSX children and JSX
 * props into functions that make a View). null / undefined / false show nothing. Mounted again if the value changes.
 */
export function insert(inst: Instance, anchor: number, value: () => unknown): void {
  ready(inst)
  const owner = getOwner()
  let current: Mounted | null = null
  let shown: unknown = undefined
  effect(() => {
    const v = value()
    if (v === shown) return
    shown = v
    const self = getOwner() // this effect: the guard of what it mounts
    untrack(() => {
      current?.dispose(true)
      current = null
      if (typeof v === "function") current = mountChild(owner, v as () => View, inst.id, anchor, 0, self)
      else if (isView(v)) current = mountChild(owner, () => v, inst.id, anchor, 0, self)
      else if (v !== null && v !== undefined && v !== false && v !== true) {
        globalThis.__zn_log(3, `can't show ${typeof v} "${String(v)}" here: only JSX (text must be inside <Text>)`)
      }
    })
  })
}

function isView(v: unknown): v is View {
  return typeof v === "object" && v !== null && "templateId" in v && "setup" in v
}

/** The controlled <TextField> whose onChangeText is running: its value slot isn't patched by its effect then. */
let answering: { inst: Instance; slot: number } | null = null

/**
 * A controlled <TextField> (`value` + `onChangeText`), as React Native does it. Native numbers each change the user
 * makes and sends "n\u0001text". After the handler runs, JS answers "n\u0001value" with what `value` now says (the
 * typed text, a reformatted one, or the old one if the handler rejected it), and the slot's own effect stays quiet
 * meanwhile. Native ignores an answer to an older change (the user has typed on since; the newer change gets its own
 * answer), so fast typing never jumps back. Set the value synchronously in the handler.
 */
export function textInput(
  inst: Instance,
  valueSlot: number,
  value: () => unknown,
  handler: (text: string) => void,
): (payload: NativeValue) => void {
  return (payload) => {
    const raw = String(payload ?? "")
    const sep = raw.indexOf("\u0001")
    const typed = sep >= 0 ? raw.slice(sep + 1) : raw
    const prev = answering
    answering = { inst, slot: valueSlot }
    try {
      handler(typed)
    } finally {
      answering = prev
    }
    const now = str(untrack(value))
    globalThis.__zn_patch(inst.id, valueSlot, sep >= 0 ? `${raw.slice(0, sep)}\u0001${now}` : now)
  }
}

/** `cond && <A/>` and `cond ? <A/> : <B/>`: mounts the branch whose condition holds, swaps it when that changes. */
export function when(inst: Instance, anchor: number, cond: () => unknown, a: () => View, b?: () => View): void {
  ready(inst)
  const owner = getOwner()
  let branch = -1
  let current: Mounted | null = null
  effect(() => {
    const next = cond() ? 0 : b ? 1 : -1
    if (next === branch) return
    const self = getOwner() // this effect: the guard of the branch it mounts
    untrack(() => {
      current?.dispose(true)
      current = null
      branch = next
      if (next >= 0) current = mountChild(owner, next === 0 ? a : b!, inst.id, anchor, 0, self)
    })
  })
}

/**
 * `items.map(item => <Row key={...}/>)`: a keyed list. Rows are kept by key; moved rows send MOVE, new rows MOUNT,
 * gone rows REMOVE. A row whose item changed (same key, different object) is mounted again. Short lists only;
 * long lists use <List> (docs/lists.md).
 */
export function each<T>(
  inst: Instance,
  anchor: number,
  items: () => readonly T[] | null | undefined,
  key: (item: T, index: number) => unknown,
  row: (item: T, index: number) => View,
): void {
  ready(inst)
  const owner = getOwner()
  let rows = new Map<unknown, { item: T; mounted: Mounted }>()
  let order: unknown[] = []

  effect(() => {
    const list = items() ?? []
    const self = getOwner() // this effect: the guard of the rows it mounts
    untrack(() => {
      const keys: unknown[] = []
      const seen = new Set<unknown>()
      list.forEach((item, i) => {
        const k = key(item, i)
        if (seen.has(k)) {
          globalThis.__zn_log(3, `list: duplicate key ${String(k)}; the second row is skipped`)
          return
        }
        seen.add(k)
        keys.push(k)
      })
      const itemsByKey = new Map<unknown, T>()
      list.forEach((item, i) => itemsByKey.set(key(item, i), item))

      // 1. Remove rows whose key is gone, or whose item changed (they are mounted again below).
      const next = new Map<unknown, { item: T; mounted: Mounted }>()
      const current: unknown[] = []
      for (const k of order) {
        const r = rows.get(k)!
        if (seen.has(k) && itemsByKey.get(k) === r.item) {
          next.set(k, r)
          current.push(k)
        } else {
          r.mounted.dispose(true)
        }
      }
      // 2. Walk the new order: move kept rows into place, mount new ones.
      keys.forEach((k, i) => {
        const kept = next.get(k)
        if (kept) {
          if (current[i] !== k) {
            current.splice(current.indexOf(k), 1)
            current.splice(i, 0, k)
            globalThis.__zn_move(kept.mounted.id, i)
          }
        } else {
          const item = itemsByKey.get(k)!
          const mounted = mountChild(owner, () => row(item, i), inst.id, anchor, i, self)
          next.set(k, { item, mounted })
          current.splice(i, 0, k)
        }
      })
      rows = next
      order = keys
    })
  })
}

/** How many rows <List> keeps mounted around the visible range (in rows; native reports the range). */
const LIST_AHEAD = 12 // below the last visible row (the usual scroll direction)
const LIST_BEHIND = 8 // above the first visible row
const LIST_INITIAL = 16 // before native reports a range (the first screen)

export interface ListOptions<T> {
  data: () => readonly T[] | null | undefined
  key: (item: T, index: number) => unknown
  row: (item: T, index: number) => View
  /** The row's template id, without building the row (compiler-generated from the row's branches). */
  type: (item: T, index: number) => number
  /** Event ids of the list node's onRange / onEndReached (0 = not bound). */
  rangeEvent: number
  endEvent: number
  onEndReached?: () => void
  /** RN stickyHeaderIndices (registry 15): rows native keeps pinned, so JS keeps them mounted wherever the list is. */
  sticky?: () => readonly number[] | null | undefined
  /** RN FlatList ListHeaderComponent */
  header?: () => View
  /** RN FlatList ListFooterComponent */
  footer?: () => View
  /** RN FlatList ListEmptyComponent */
  empty?: () => View
}

/**
 * `<List data key row>` (docs/lists.md): a virtualized list. Native knows every row's key and type (LIST_SET /
 * LIST_SPLICE) and draws rows that aren't mounted as placeholders. JS mounts a row (an ordinary instance) only while it
 * is near the visible range native reports (onRange), and removes it after it leaves a wider band, so a long list
 * costs one small key array, not thousands of instances. A row whose item object changes (same key) is mounted again.
 */
export function list<T>(inst: Instance, node: number, o: ListOptions<T>): void {
  ready(inst)
  const owner = getOwner()
  let keys: string[] = []
  let types: number[] = []
  let items: readonly T[] = []
  let keyIndex = new Map<string, number>()
  const mounted = new Map<string, { item: T; i: number; m: Mounted }>()
  // A row function that takes the index (row(item, i), RN's renderItem) is built again when its row moves (a reorder,
  // a row added above it), like RN's FlatList, so a rank or "first row" style shows the new place. Others are kept.
  const usesIndex = o.row.length > 1
  let first = 0
  let last = LIST_INITIAL - 1
  let sent = false
  let pinned = new Set<number>() // sticky rows' indices
  let dataEffect: Owner | null = null // the effect below: the guard of the rows (sync also runs from onRange)

  if (o.header) {
    let headerM: Mounted | null = null
    effect(() => {
      if (headerM) headerM.dispose(true)
      headerM = mountChild(owner, () => listExtra(o.header!()), inst.id, node, 0, dataEffect)
      globalThis.__zn_listRow(inst.id, node, "__zn_header", headerM.id)
    })
    onCleanup(() => {
      if (headerM) headerM.dispose(true)
    })
  }

  if (o.footer) {
    let footerM: Mounted | null = null
    effect(() => {
      if (footerM) footerM.dispose(true)
      footerM = mountChild(owner, () => listExtra(o.footer!()), inst.id, node, 0, dataEffect)
      globalThis.__zn_listRow(inst.id, node, "__zn_footer", footerM.id)
    })
    onCleanup(() => {
      if (footerM) footerM.dispose(true)
    })
  }

  if (o.empty) {
    let emptyM: Mounted | null = null
    effect(() => {
      if (emptyM) emptyM.dispose(true)
      emptyM = mountChild(owner, () => listExtra(o.empty!()), inst.id, node, 0, dataEffect)
      globalThis.__zn_listRow(inst.id, node, "__zn_empty", emptyM.id)
    })
    onCleanup(() => {
      if (emptyM) emptyM.dispose(true)
    })
  }

  const sync = () => {
    const n = keys.length
    const from = Math.max(0, first - LIST_BEHIND)
    const to = Math.min(n - 1, last + LIST_AHEAD)
    // Keep a wider band than we mount, so scrolling back and forth doesn't mount and remove the same rows.
    const keepFrom = first - 2 * LIST_BEHIND
    const keepTo = last + 2 * LIST_AHEAD
    for (const [k, r] of mounted) {
      const i = keyIndex.get(k)
      if (i === undefined || ((i < keepFrom || i > keepTo) && !pinned.has(i)) || items[i] !== r.item || (usesIndex && r.i !== i)) {
        r.m.dispose(true)
        mounted.delete(k)
      }
    }
    const mount = (i: number) => {
      const k = keys[i]
      if (mounted.has(k)) return
      const item = items[i]
      const m = mountChild(owner, () => o.row(item, i), inst.id, node, 0, dataEffect)
      globalThis.__zn_listRow(inst.id, node, k, m.id)
      mounted.set(k, { item, i, m })
    }
    for (let i = from; i <= to; i++) mount(i)
    // A pinned row shows at the top wherever the list is scrolled: it stays mounted.
    for (const i of pinned) if (i < n) mount(i)
  }

  effect(() => {
    const next = o.data() ?? []
    dataEffect = getOwner()
    untrack(() => {
      const nextKeys: string[] = new Array(next.length)
      const nextTypes: number[] = new Array(next.length)
      const seen = new Set<string>()
      next.forEach((item, i) => {
        let k = String(o.key(item, i))
        // "__zn_header" / "__zn_footer" / "__zn_empty" name the list's extras on the same channel; a row key that
        // starts with "__zn_" gets one more "_" so it can't take their place (2026-11-08 review).
        if (k.startsWith("__zn_")) k = `_${k}`
        if (seen.has(k)) {
          // Compose needs unique keys; a duplicate would crash the list. Keep the row, under a made-up key.
          globalThis.__zn_log(3, `list: duplicate key ${k} at row ${i}; give every row a unique key`)
          k = `${k}#${i}`
        }
        seen.add(k)
        nextKeys[i] = k
        nextTypes[i] = o.type(item, i)
      })

      if (!sent) {
        globalThis.__zn_listSet(inst.id, node, nextKeys, nextTypes)
        sent = true
      } else {
        // One splice covering what changed between the common start and the common end (a new row at the top, rows
        // added at the end, one row removed). Rows outside it keep their keys, so native keeps their state and scroll.
        let p = 0
        const max = Math.min(keys.length, nextKeys.length)
        while (p < max && keys[p] === nextKeys[p] && types[p] === nextTypes[p]) p++
        let s = 0
        while (
          s < max - p &&
          keys[keys.length - 1 - s] === nextKeys[nextKeys.length - 1 - s] &&
          types[types.length - 1 - s] === nextTypes[nextTypes.length - 1 - s]
        ) {
          s++
        }
        const removeCount = keys.length - p - s
        const insertKeys = nextKeys.slice(p, nextKeys.length - s)
        if (removeCount > 0 || insertKeys.length > 0) {
          globalThis.__zn_listSplice(inst.id, node, p, removeCount, insertKeys, nextTypes.slice(p, nextTypes.length - s))
        }
      }
      keys = nextKeys
      types = nextTypes
      items = next.slice()
      keyIndex = new Map(keys.map((k, i) => [k, i]))
      sync()
    })
  })

  if (o.sticky) {
    const read = o.sticky
    effect(() => {
      const next = new Set((read() ?? []).filter((i) => Number.isInteger(i) && i >= 0))
      untrack(() => {
        pinned = next
        if (sent) sync()
      })
    })
  }
  if (o.rangeEvent) {
    on(inst, o.rangeEvent, (payload) => {
      const [a, b] = String(payload).split(",").map(Number)
      if (!Number.isFinite(a) || !Number.isFinite(b)) return
      first = a
      last = b
      sync()
    })
  }
  if (o.endEvent && o.onEndReached) on(inst, o.endEvent, () => o.onEndReached!())
}

/** A new JS-allocated instance id (also used for back-stack entries: a screen's entry id is its root id). */
export function allocInstanceId(): number {
  if (nextInstanceId >= JS_ID_LIMIT) throw new Error("zero-native: out of instance ids")
  return nextInstanceId++
}

/**
 * Runs a screen component on a root instance that native already created from the template (no MOUNT). If it
 * throws, everything it started is stopped before the error goes on to the caller (nav shows the error screen).
 * [beforeSetup]: for a root native makes only once JS knows its template (an app layer, nav.ts mountLayer): called
 * with the template id after the component ran and before its slots are sent.
 */
export function renderRoot<P>(
  rootId: number,
  Screen: (props: P) => View,
  props: P,
  beforeSetup?: (templateId: number) => void,
): () => void {
  return createRoot((dispose) => {
    try {
      const v = Screen(props)
      // The app build already refuses this (compiler/src/plugin.ts checkScreenRoots); a clear error, not "setup of null".
      if (!isView(v)) throw new Error("a screen must return its JSX, not null or another value (guide notes §4)")
      beforeSetup?.(v.templateId)
      v.setup({ id: rootId, collecting: null, mount: null })
    } catch (e) {
      dispose()
      throw e
    }
    return dispose
  })
}

export interface ListScrollToIndexOptions {
  index: number
  animated?: boolean
  viewOffset?: number
}

export interface ListScrollToEndOptions {
  animated?: boolean
}

export interface ListScrollToOffsetOptions {
  offset: number
  animated?: boolean
}

export interface ListController {
  scrollToIndex(options: ListScrollToIndexOptions): void
  scrollToEnd(options?: ListScrollToEndOptions): void
  scrollToOffset(options: ListScrollToOffsetOptions): void
}

export interface ListRef {
  current: ListController | null
  scrollToIndex(options: ListScrollToIndexOptions): void
  scrollToEnd(options?: ListScrollToEndOptions): void
  scrollToOffset(options: ListScrollToOffsetOptions): void
}

export function listController(): ListController & ListRef {
  let target: ListController | null = null
  const queue: Array<() => void> = []

  const forward = (fn: (c: ListController) => void) => {
    if (target) fn(target)
    else queue.push(() => target && fn(target))
  }

  const ctrl: ListController & ListRef = {
    get current() {
      return target ?? ctrl
    },
    set current(val: ListController | null) {
      target = val
      if (val && queue.length > 0) {
        const queued = [...queue]
        queue.length = 0
        queued.forEach((q) => q())
      }
    },
    scrollToIndex: (opts) => forward((c) => c.scrollToIndex(opts)),
    scrollToEnd: (opts) => forward((c) => c.scrollToEnd(opts)),
    scrollToOffset: (opts) => forward((c) => c.scrollToOffset(opts)),
  }
  return ctrl
}

export function bindListController(ctrl: any, inst: Instance, slotId: number): void {
  if (!ctrl) return
  let seq = 0
  const send = (cmd: string) => {
    const value = `${cmd}:${++seq}`
    // Before this part's MOUNT, a PATCH would reach an instance native doesn't have yet and be lost (M7, 2026-11-08):
    // the value goes with the MOUNT instead, as slot() does. Native runs it once the List draws (lastScrollSeq).
    if (inst.collecting) inst.collecting[slotId] = value
    else globalThis.__zn_patch(inst.id, slotId, value)
  }
  const handler: ListController = {
    scrollToIndex: (opts) => {
      const idx = opts.index ?? 0
      const anim = opts.animated !== false ? 1 : 0
      const offset = opts.viewOffset ?? 0
      send(`index:${idx}:${anim}:${offset}`)
    },
    scrollToEnd: (opts) => {
      const anim = opts?.animated !== false ? 1 : 0
      send(`end:0:${anim}:0`)
    },
    scrollToOffset: (opts) => {
      const off = opts.offset ?? 0
      const anim = opts.animated !== false ? 1 : 0
      send(`offset:${off}:${anim}:0`)
    },
    // <Scroll ref> (registry 24): RN's ScrollView.scrollTo. A <List> takes it as scrollToOffset along its axis.
    scrollTo: (opts: { x?: number; y?: number; animated?: boolean } = {}) => {
      const anim = opts.animated !== false ? 1 : 0
      send(`to:${finiteOr(opts.x, 0)}:${anim}:${finiteOr(opts.y, 0)}`)
    },
  } as ListController & { scrollTo(o?: { x?: number; y?: number; animated?: boolean }): void }
  if (ctrl && typeof ctrl === "object") {
    if ("current" in ctrl) {
      // A listController() or a { current } ref: only `current` is set, so its own methods keep forwarding to
      // whichever List holds it now. Before 2026-11-08 they were overwritten with this List's handler and kept
      // sending to it after it was gone.
      ctrl.current = handler
      onCleanup(() => {
        if (ctrl.current === handler) ctrl.current = null
      })
    } else {
      Object.assign(ctrl, handler)
    }
  }
}

const finiteOr = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d)

/**
 * RN's snap props on a <Scroll> / <List> as the `snap` string native reads (registry 24; ZnScrollExtras.kt):
 * "p1;i80;a1;o0,120;s0;e0;m1;d0.99". Bad values are left out with a warning (the scroll still works, unsnapped).
 */
export function scrollSnap(o: {
  pagingEnabled?: boolean
  snapToInterval?: number
  snapToOffsets?: readonly number[]
  snapToAlignment?: "start" | "center" | "end"
  snapToStart?: boolean
  snapToEnd?: boolean
  disableIntervalMomentum?: boolean
  decelerationRate?: "normal" | "fast" | number
}): string {
  const out: string[] = []
  const warn = (m: string) => globalThis.__zn_log?.(2, `Scroll snap: ${m}`)
  if (o.pagingEnabled) out.push("p1")
  if (o.snapToInterval !== undefined && o.snapToInterval !== null) {
    if (typeof o.snapToInterval === "number" && Number.isFinite(o.snapToInterval) && o.snapToInterval > 0) out.push(`i${o.snapToInterval}`)
    else warn(`snapToInterval must be a number above 0, got ${String(o.snapToInterval)}`)
  }
  if (o.snapToOffsets !== undefined && o.snapToOffsets !== null) {
    const list = Array.isArray(o.snapToOffsets) ? o.snapToOffsets.filter((n) => typeof n === "number" && Number.isFinite(n)) : []
    if (list.length !== (Array.isArray(o.snapToOffsets) ? o.snapToOffsets.length : -1)) warn("snapToOffsets must be an array of numbers; others are left out")
    if (list.length > 0) out.push(`o${list.join(",")}`)
  }
  if (o.snapToAlignment === "center") out.push("a1")
  else if (o.snapToAlignment === "end") out.push("a2")
  else if (o.snapToAlignment !== undefined && o.snapToAlignment !== "start") warn(`snapToAlignment is "start", "center" or "end"`)
  if (o.snapToStart === false) out.push("s0")
  if (o.snapToEnd === false) out.push("e0")
  if (o.disableIntervalMomentum) out.push("m1")
  // RN's numbers depend on the platform: iOS keeps this much speed per ms (normal 0.998, fast 0.99); Android's
  // OverScroller uses 1 - rate as friction (normal 0.985, fast 0.9). zn reads iOS's scale, which is what "fast" sends
  // (it stops about as soon as Android's 0.9). A number of 0.95 or less can only be Android's scale: it is converted
  // (Android's friction 0.015 = iOS 0.998), so 0.9 written for Android stops soon instead of being read as "normal".
  const d = o.decelerationRate
  if (d === "fast") out.push("d0.99")
  else if (typeof d === "number") {
    if (Number.isFinite(d) && d > 0 && d <= 0.95) out.push(`d${Math.max(0.91, Number(Math.exp((Math.log(0.998) * (1 - d)) / 0.015).toFixed(5)))}`)
    else if (Number.isFinite(d) && d > 0 && d < 1) out.push(`d${d}`)
    else warn(`decelerationRate must be "normal", "fast" or a number between 0 and 1, got ${d}`)
  } else if (d !== undefined && d !== "normal") warn(`decelerationRate must be "normal", "fast" or a number`)
  return out.join(";")
}

/** RN's scroll event (registry 24). Numbers are dp. */
export interface ScrollEvent {
  nativeEvent: {
    contentOffset: { x: number; y: number }
    contentSize: { width: number; height: number }
    layoutMeasurement: { width: number; height: number }
    velocity?: { x: number; y: number }
    contentInset: { top: number; left: number; bottom: number; right: number }
    zoomScale: number
  }
}

type ScrollHandler = ((e: ScrollEvent) => void) | undefined

/** Native's one scroll event → the RN handler for its kind, with RN's nativeEvent (registry 24). */
export function scrollEvent(
  payload: unknown,
  h: { onScroll?: ScrollHandler; onScrollBeginDrag?: ScrollHandler; onScrollEndDrag?: ScrollHandler; onMomentumScrollBegin?: ScrollHandler; onMomentumScrollEnd?: ScrollHandler },
): void {
  let p: { k?: string; x?: number; y?: number; cw?: number; ch?: number; w?: number; h?: number; vx?: number; vy?: number }
  try {
    p = JSON.parse(String(payload))
  } catch {
    return
  }
  const fn = p.k === "s" ? h.onScroll : p.k === "b" ? h.onScrollBeginDrag : p.k === "e" ? h.onScrollEndDrag
    : p.k === "mb" ? h.onMomentumScrollBegin : p.k === "me" ? h.onMomentumScrollEnd : undefined
  if (typeof fn !== "function") return
  const nativeEvent: ScrollEvent["nativeEvent"] = {
    contentOffset: { x: p.x ?? 0, y: p.y ?? 0 },
    contentSize: { width: p.cw ?? 0, height: p.ch ?? 0 },
    layoutMeasurement: { width: p.w ?? 0, height: p.h ?? 0 },
    contentInset: { top: 0, left: 0, bottom: 0, right: 0 },
    zoomScale: 1,
  }
  if (p.vx !== undefined || p.vy !== undefined) nativeEvent.velocity = { x: p.vx ?? 0, y: p.vy ?? 0 }
  fn({ nativeEvent })
}
