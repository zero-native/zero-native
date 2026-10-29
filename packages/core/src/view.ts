// The view runtime: what compiled TSX calls (ARCHITECTURE.md §5.3, §8.3). Authors don't call these directly.
//
// A component returns a View: its template id plus a setup function. Mounting a View creates an instance:
//   1. setup binds slots (each slot is an effect; its first value is collected) and events,
//   2. ready() sends MOUNT with the collected values (one op per instance, not one op plus K patches),
//   3. setup mounts children at anchors: components, conditionals (`&&`, `? :`) and lists (`.map`).
// Every instance has an owner (signals.ts). Disposing it stops its effects, events and child instances; only the
// top instance of a removed subtree sends REMOVE, because native removes the whole subtree.
import { parseColor } from "./color"
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

/** Mounts a view as a child of `parent` at template node `anchor`, position `index`, owned by `owner`. */
function mountChild(owner: Owner | null, make: () => View, parent: number, anchor: number, index: number): Mounted {
  return runWithOwner(owner, () =>
    createRoot((dispose) => {
      const id = allocInstanceId()
      const v = make() // a component's body runs here, inside the instance's owner
      const inst: Instance = { id, collecting: [], mount: { templateId: v.templateId, parent, anchor, index } }
      v.setup(inst)
      ready(inst)
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

/** A new JS-allocated instance id (also used for back-stack entries: a screen's entry id is its root id). */
export function allocInstanceId(): number {
  if (nextInstanceId >= JS_ID_LIMIT) throw new Error("zero-native: out of instance ids")
  return nextInstanceId++
}

/** Runs a screen component on a root instance that native already created from the template (no MOUNT). */
export function renderRoot<P>(rootId: number, Screen: (props: P) => View, props: P): () => void {
  return createRoot((dispose) => {
    const v = Screen(props)
    v.setup({ id: rootId, collecting: null, mount: null })
    return dispose
  })
}
