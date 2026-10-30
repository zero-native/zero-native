// The registry as last accepted (`registry.lock.json`), and the rules a registry change must follow so OTA bundles
// stay safe on older apps (docs/ota.md §3.2). Used by the registry test and by `bun run gen:registry`, which writes the
// lock only when there are no problems.
import { Added, BASE_VERSION, Component, DynamicProps, Enum, EventKind, Prop, REGISTRY_VERSION, since } from "./registry"

/** One entry: what must never change about it, and the registry version it needs. */
export interface LockEntry {
  id?: number
  type?: string
  since: number
}

export interface RegistryLock {
  version: number
  base: number
  /** Keys: "component:Switch", "prop:size", "dynamic:value", "enum:pressFeedback.highlight", "event:onPress". */
  entries: Record<string, LockEntry>
}

/** The current registry in lock form. */
export function registrySnapshot(): RegistryLock {
  const entries: Record<string, LockEntry> = {}
  for (const [name, id] of Object.entries(Component)) entries[`component:${name}`] = { id, since: since("component", name) }
  for (const [name, p] of Object.entries(Prop)) entries[`prop:${name}`] = { id: p.id, type: p.type, since: since("prop", name) }
  for (const name of DynamicProps) entries[`dynamic:${name}`] = { since: since("dynamic", name) }
  for (const [prop, values] of Object.entries(Enum)) {
    for (const [value, id] of Object.entries(values)) {
      entries[`enum:${prop}.${value}`] = { id, since: since("enumValue", `${prop}.${value}`) }
    }
  }
  for (const [name, id] of Object.entries(EventKind)) entries[`event:${name}`] = { id, since: since("event", name) }
  return { version: REGISTRY_VERSION, base: BASE_VERSION, entries }
}

/** Problems with the current registry compared with [lock] (empty = fine). */
export function registryProblems(lock: RegistryLock): string[] {
  const now = registrySnapshot()
  const problems: string[] = []
  if (now.version < lock.version) problems.push(`REGISTRY_VERSION went down: ${lock.version} → ${now.version}`)
  if (now.base !== lock.base) problems.push(`BASE_VERSION changed: ${lock.base} → ${now.base} (it never changes)`)

  for (const [key, old] of Object.entries(lock.entries)) {
    const cur = now.entries[key]
    if (!cur) {
      problems.push(`${key} was removed. Never remove or rename: bundles that use it would break (mark it unused instead)`)
      continue
    }
    if (cur.id !== old.id) problems.push(`${key}: id changed ${old.id} → ${cur.id}. Ids never change`)
    if (cur.type !== old.type) problems.push(`${key}: type changed ${old.type} → ${cur.type}. Add a new prop instead`)
    if (cur.since < old.since) problems.push(`${key}: since went down ${old.since} → ${cur.since}`)
    if (cur.since > old.since && cur.since !== now.version) {
      problems.push(`${key}: a changed entry must say since ${now.version} (the new REGISTRY_VERSION), not ${cur.since}`)
    }
  }
  for (const [key, cur] of Object.entries(now.entries)) {
    if (key in lock.entries) continue
    if (now.version <= lock.version) {
      problems.push(`${key} is new: raise REGISTRY_VERSION (now ${now.version}) and list it in Added`)
    } else if (cur.since !== now.version) {
      problems.push(`${key} is new: list it in Added with ${now.version} (the new REGISTRY_VERSION)`)
    }
  }
  // Every Added entry must name something that exists, within the version range.
  const kinds: Record<keyof typeof Added, string> = {
    component: "component", prop: "prop", dynamic: "dynamic", enumValue: "enum", event: "event",
  }
  for (const [kind, prefix] of Object.entries(kinds) as Array<[keyof typeof Added, string]>) {
    for (const [name, v] of Object.entries(Added[kind] as Record<string, number>)) {
      if (!(`${prefix}:${name}` in now.entries)) problems.push(`Added.${kind}.${name}: no such ${prefix} in the registry`)
      if (v <= BASE_VERSION || v > now.version) {
        problems.push(`Added.${kind}.${name} = ${v}: must be above BASE_VERSION ${BASE_VERSION} and at most ${now.version}`)
      }
    }
  }
  return problems
}
