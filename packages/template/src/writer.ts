// Writes .zn.ui template files (ARCHITECTURE.md §6.1). Step 1.2: templates are built by hand with `el()`; from step
// 1.3 the compiler builds the same NodeSpec trees from TSX.
//
// File format (little-endian; reader: android/runtime/.../TemplateReader.kt):
//   file     = u32 magic "ZNUI" | u16 formatVersion | u16 registryVersion | u32 stringCount | string* |
//              u16 templateCount | template*
//   string   = u32 byteLength | UTF-8
//   template = u16 nodeCount | node* | u16 slotCount | slot* | u16 eventCount | event*
//   node     = u16 componentId | u16 parentIndex (0xFFFF = root) | u8 propCount | prop*
//   prop     = u16 propId | value
//   slot     = u16 nodeIndex | u16 propId | value (default shown until JS sends one)
//   event    = u16 nodeIndex | u16 eventKind | u16 eventId (sent to JS with the instance id)
//   value    = u8 kind | payload
//              kind 0 null, 1 false, 2 true, 3 number (f64), 4 string (u32 index), 5 colour (u32 ARGB),
//              6 percent (f64 fraction), 7 enum (u16)
// Nodes are stored in tree order (a parent always comes before its children; children keep their order).
import { parseColor } from "./color"
import {
  BASE_VERSION,
  ABSOLUTE_STRETCH_SINCE,
  ZINDEX_ANY_SINCE,
  Component,
  type ComponentName,
  DynamicProps,
  Enum,
  EventKind,
  type EventName,
  Formats,
  Prop,
  type PropName,
  REGISTRY_VERSION,
  since,
} from "./registry"

export const TEMPLATE_MAGIC = 0x49554e5a // "ZNUI" as little-endian bytes
export const FORMAT_VERSION = 1
const ROOT_PARENT = 0xffff

export type StaticValue = number | string | boolean | null

/** A prop whose value changes at runtime. `name` becomes the slot's id in the generated ids file. */
export interface SlotRef {
  $slot: string
  default: StaticValue
}

/** A native event the node sends to JS. Several nodes may share one event name (and so one id). */
export interface EventRef {
  $event: string
}

export const slot = (name: string, defaultValue: StaticValue): SlotRef => ({ $slot: name, default: defaultValue })
export const event = (name: string): EventRef => ({ $event: name })

type PropValue = StaticValue | SlotRef
export type NodeProps = { [K in PropName]?: PropValue } & { [K in EventName]?: EventRef } & {
  style?: { [K in PropName]?: PropValue }
}

export interface NodeSpec {
  type: ComponentName
  props: NodeProps
  children: NodeSpec[]
}

/** Builds a node. `style` keys and direct props are the same registry props; `style` is applied first. */
export function el(type: ComponentName, props: NodeProps = {}, ...children: NodeSpec[]): NodeSpec {
  return { type, props, children }
}

export interface TemplateIds {
  /** slot name → slot id (the number JS uses in patch()) */
  slots: Record<string, number>
  /** event name → event id (the number native sends with __zn_onEvent) */
  events: Record<string, number>
}

const isSlot = (v: unknown): v is SlotRef => typeof v === "object" && v !== null && "$slot" in v
const isEvent = (v: unknown): v is EventRef => typeof v === "object" && v !== null && "$event" in v

class ByteWriter {
  private buf = new Uint8Array(1024)
  private view = new DataView(this.buf.buffer)
  private pos = 0

  private ensure(n: number) {
    if (this.pos + n <= this.buf.length) return
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n))
    next.set(this.buf)
    this.buf = next
    this.view = new DataView(next.buffer)
  }
  u8(v: number) {
    this.ensure(1)
    this.view.setUint8(this.pos, v)
    this.pos += 1
  }
  u16(v: number) {
    this.ensure(2)
    this.view.setUint16(this.pos, v, true)
    this.pos += 2
  }
  u32(v: number) {
    this.ensure(4)
    this.view.setUint32(this.pos, v, true)
    this.pos += 4
  }
  f64(v: number) {
    this.ensure(8)
    this.view.setFloat64(this.pos, v, true)
    this.pos += 8
  }
  bytes(b: Uint8Array) {
    this.ensure(b.length)
    this.buf.set(b, this.pos)
    this.pos += b.length
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.pos)
  }
}

interface EncodedValue {
  write(w: ByteWriter): void
}

class Strings {
  readonly list: string[] = []
  private index = new Map<string, number>()
  get(s: string): number {
    let i = this.index.get(s)
    if (i === undefined) {
      i = this.list.length
      this.list.push(s)
      this.index.set(s, i)
    }
    return i
  }
}

function encodeValue(prop: PropName, value: StaticValue, strings: Strings, where: string): EncodedValue {
  const type = Prop[prop].type
  const fail = (why: string): never => {
    throw new Error(`${where}: prop "${prop}" ${why} (got ${JSON.stringify(value)})`)
  }
  if (value === null) return { write: (w) => w.u8(0) }
  if (prop === "value") {
    if (typeof value === "boolean") return { write: (w) => w.u8(value ? 2 : 1) }
    if (typeof value === "number" && Number.isFinite(value)) return { write: (w) => (w.u8(3), w.f64(value)) }
    if (typeof value === "string") {
      const i = strings.get(value)
      return { write: (w) => (w.u8(4), w.u32(i)) }
    }
  }
  switch (type) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) fail("needs a number")
      return { write: (w) => (w.u8(3), w.f64(value as number)) }
    case "size":
      if (typeof value === "number") return { write: (w) => (w.u8(3), w.f64(value)) }
      if (typeof value === "string" && /^\d+(\.\d+)?%$/.test(value)) {
        const fraction = parseFloat(value) / 100
        return { write: (w) => (w.u8(6), w.f64(fraction)) }
      }
      return fail('needs a number (dp) or "N%"')
    case "string": {
      if (typeof value !== "string") fail("needs a string")
      const i = strings.get(value as string)
      return { write: (w) => (w.u8(4), w.u32(i)) }
    }
    case "color": {
      if (typeof value !== "string") fail("needs a colour string")
      let argb = 0
      try {
        argb = parseColor(value as string)
      } catch (e) {
        fail((e as Error).message)
      }
      return { write: (w) => (w.u8(5), w.u32(argb)) }
    }
    case "enum": {
      const values = (Enum as Record<string, Record<string, number>>)[prop]
      if (typeof value !== "string" || !(value in values)) fail(`needs one of ${Object.keys(values).join(", ")}`)
      const n = values[value as string]
      return { write: (w) => (w.u8(7), w.u16(n)) }
    }
    case "bool":
      if (typeof value !== "boolean") fail("needs true or false")
      return { write: (w) => w.u8(value ? 2 : 1) }
  }
}

interface FlatNode {
  component: number
  parent: number
  props: Array<{ id: number; value: EncodedValue }>
}

/**
 * Encodes templates into one .zn.ui file. Throws a clear error for anything the registry doesn't allow.
 * [registry]: the lowest registry version that has everything these templates use (components, props, props bound
 * to slots, enum values, events). It goes in the file header and the bundle's requirements, so the templates run on
 * every app with at least that version, not only on apps as new as this compiler (docs/ota.md §3.2).
 */
export function writeTemplateFile(roots: NodeSpec[]): { bytes: Uint8Array; ids: TemplateIds[]; registry: number } {
  const strings = new Strings()
  const encoded: Array<{ nodes: FlatNode[]; slots: Array<[number, number, EncodedValue]>; events: Array<[number, number, number]> }> = []
  const ids: TemplateIds[] = []
  let registry = BASE_VERSION
  const needs = (version: number) => {
    if (version > registry) registry = version
  }

  roots.forEach((root, t) => {
    const nodes: FlatNode[] = []
    const slots: Array<[number, number, EncodedValue]> = []
    const events: Array<[number, number, number]> = []
    const tIds: TemplateIds = { slots: {}, events: {} }

    const visit = (spec: NodeSpec, parent: number, path: string) => {
      const component = Component[spec.type]
      if (component === undefined) throw new Error(`${path}: unknown component "${spec.type}"`)
      needs(since("component", spec.type))
      const index = nodes.length
      if (index >= ROOT_PARENT) throw new Error(`template ${t}: too many nodes`)
      const node: FlatNode = { component, parent, props: [] }
      nodes.push(node)

      const { style, ...direct } = spec.props
      const merged: Record<string, unknown> = { ...(style ?? {}), ...direct }
      // An absolute child with both sides of a pair stretches between them only on newer apps (registry 15).
      if (merged.position === "absolute" && (("start" in merged && "end" in merged) || ("top" in merged && "bottom" in merged))) {
        needs(ABSOLUTE_STRETCH_SINCE)
      }
      // zIndex outside a Stack is drawn only by newer apps (registry 16). A child at a template's root may sit in a
      // Stack of another template: it asks for 16 too (a false match only asks for a newer app than needed).
      if ("zIndex" in merged && (parent === ROOT_PARENT || nodes[parent]?.component !== Component.Stack)) needs(ZINDEX_ANY_SINCE)
      for (const [key, raw] of Object.entries(merged)) {
        if (raw === undefined) continue
        if (key in EventKind) {
          if (!isEvent(raw)) throw new Error(`${path}: "${key}" needs event("name")`)
          const id = (tIds.events[raw.$event] ??= Object.keys(tIds.events).length + 1)
          events.push([index, EventKind[key as EventName], id])
          needs(since("event", key))
          continue
        }
        if (!(key in Prop)) throw new Error(`${path}: unknown prop or style key "${key}"`)
        const prop = key as PropName
        needs(since("prop", prop))
        if (isSlot(raw)) {
          if (!DynamicProps.has(prop)) {
            throw new Error(`${path}: prop "${prop}" can't change at runtime yet (registry v${REGISTRY_VERSION})`)
          }
          needs(since("dynamic", prop))
          if (raw.$slot in tIds.slots) throw new Error(`${path}: slot name "${raw.$slot}" used twice`)
          tIds.slots[raw.$slot] = slots.length
          slots.push([index, Prop[prop].id, encodeValue(prop, raw.default, strings, path)])
          continue
        }
        node.props.push({ id: Prop[prop].id, value: encodeValue(prop, raw as StaticValue, strings, path) })
        if (Prop[prop].type === "enum" && typeof raw === "string") needs(since("enumValue", `${prop}.${raw}`))
        if (typeof raw === "string") {
          for (const [name, f] of Object.entries(Formats)) {
            if (f.props.includes(prop) && f.uses(raw)) needs(since("format", name))
          }
        }
      }
      if (node.props.length > 255) throw new Error(`${path}: too many props`)
      spec.children.forEach((child, i) => visit(child, index, `${path} > ${child.type}[${i}]`))
    }
    visit(root, ROOT_PARENT, `template ${t} ${root.type}`)
    encoded.push({ nodes, slots, events })
    ids.push(tIds)
  })

  const w = new ByteWriter()
  w.u32(TEMPLATE_MAGIC)
  w.u16(FORMAT_VERSION)
  w.u16(registry)
  w.u32(strings.list.length)
  const enc = new TextEncoder()
  for (const s of strings.list) {
    const b = enc.encode(s)
    w.u32(b.length)
    w.bytes(b)
  }
  w.u16(encoded.length)
  for (const tpl of encoded) {
    w.u16(tpl.nodes.length)
    for (const n of tpl.nodes) {
      w.u16(n.component)
      w.u16(n.parent)
      w.u8(n.props.length)
      for (const p of n.props) {
        w.u16(p.id)
        p.value.write(w)
      }
    }
    w.u16(tpl.slots.length)
    for (const [node, prop, value] of tpl.slots) {
      w.u16(node)
      w.u16(prop)
      value.write(w)
    }
    w.u16(tpl.events.length)
    for (const [node, kind, id] of tpl.events) {
      w.u16(node)
      w.u16(kind)
      w.u16(id)
    }
  }
  return { bytes: w.result(), ids, registry }
}

/**
 * The slot and event ids of one template. They only depend on that template (not on the file it ends up in), so the
 * compiler can emit JS for each template as it goes and write the file at the end.
 */
export function templateIds(root: NodeSpec): TemplateIds {
  return writeTemplateFile([root]).ids[0]
}

/** TypeScript source with the ids JS needs (slot and event numbers), one const per template. */
export function idsModule(names: string[], ids: TemplateIds[]): string {
  const out = ["// GENERATED from the .zn.ui templates. Do not edit.", ""]
  names.forEach((name, i) => {
    out.push(`export const ${name} = {`)
    out.push(`  template: ${i},`)
    out.push(`  slot: ${JSON.stringify(ids[i].slots)},`)
    out.push(`  event: ${JSON.stringify(ids[i].events)},`)
    out.push("} as const")
    out.push("")
  })
  return out.join("\n")
}
