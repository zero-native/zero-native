// The view runtime: what compiled TSX calls (ARCHITECTURE.md §5.3, §8.3). Authors don't call these directly.
//
// A component returns a View: its template id plus a setup function. Mounting a View creates an instance:
//   1. setup binds slots (each slot is an effect; its first value is collected) and events,
//   2. ready() sends MOUNT with the collected values (one op per instance, not one op plus K patches),
//   3. setup mounts children at anchors: components, conditionals (`&&`, `? :`) and lists (`.map`).
// Every instance has an owner (signals.ts). Disposing it stops its effects, events and child instances; only the
// top instance of a removed subtree sends REMOVE, because native removes the whole subtree.
import { parseColor } from "./color"
import { reportError } from "./errors"
import { onEvent } from "./events"
import type { NativeValue } from "./native"
import { createRoot, effect, getOwner, onCleanup, runWithOwner, untrack, type Owner } from "./signals"

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
  if (kind === SlotKind.Color && typeof v === "string") return parseColor(v)
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v
  return String(v)
}

/** Text content of a `<Text>` mixing literal text and `{expressions}`: null, undefined and false show nothing. */
export function str(v: unknown): string {
  return v === null || v === undefined || v === false ? "" : String(v)
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
 * Binds a native event (tap, ...) of this instance to a handler. The handler runs under the instance's owner, so a
 * timer it starts stops when the instance (its screen) is disposed.
 */
export function on(inst: Instance, eventId: number, handler: (payload: NativeValue) => void): void {
  const owner = getOwner()
  onCleanup(onEvent(inst.id, eventId, (payload) => runWithOwner(owner, () => handler(payload))))
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
 */
function mountChild(owner: Owner | null, make: () => View, parent: number, anchor: number, index: number): Mounted {
  return runWithOwner(owner, () =>
    createRoot((dispose) => {
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
    untrack(() => {
      current?.dispose(true)
      current = null
      if (typeof v === "function") current = mountChild(owner, v as () => View, inst.id, anchor, 0)
      else if (isView(v)) current = mountChild(owner, () => v, inst.id, anchor, 0)
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
    untrack(() => {
      current?.dispose(true)
      current = null
      branch = next
      if (next >= 0) current = mountChild(owner, next === 0 ? a : b!, inst.id, anchor, 0)
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
          const mounted = mountChild(owner, () => row(item, i), inst.id, anchor, i)
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
  const mounted = new Map<string, { item: T; m: Mounted }>()
  let first = 0
  let last = LIST_INITIAL - 1
  let sent = false
  let pinned = new Set<number>() // sticky rows' indices

  const sync = () => {
    const n = keys.length
    const from = Math.max(0, first - LIST_BEHIND)
    const to = Math.min(n - 1, last + LIST_AHEAD)
    // Keep a wider band than we mount, so scrolling back and forth doesn't mount and remove the same rows.
    const keepFrom = first - 2 * LIST_BEHIND
    const keepTo = last + 2 * LIST_AHEAD
    for (const [k, r] of mounted) {
      const i = keyIndex.get(k)
      if (i === undefined || ((i < keepFrom || i > keepTo) && !pinned.has(i)) || items[i] !== r.item) {
        r.m.dispose(true)
        mounted.delete(k)
      }
    }
    const mount = (i: number) => {
      const k = keys[i]
      if (mounted.has(k)) return
      const item = items[i]
      const m = mountChild(owner, () => o.row(item, i), inst.id, node, 0)
      globalThis.__zn_listRow(inst.id, node, k, m.id)
      mounted.set(k, { item, m })
    }
    for (let i = from; i <= to; i++) mount(i)
    // A pinned row shows at the top wherever the list is scrolled: it stays mounted.
    for (const i of pinned) if (i < n) mount(i)
  }

  effect(() => {
    const next = o.data() ?? []
    untrack(() => {
      const nextKeys: string[] = new Array(next.length)
      const nextTypes: number[] = new Array(next.length)
      const seen = new Set<string>()
      next.forEach((item, i) => {
        let k = String(o.key(item, i))
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
