// What the dashboard may offer for a bundle or channel. The server checks every rule again; this only explains them
// sooner (docs/zn-updates-server.md §5).
import type { Bundle, Priority, State } from "./api"
import { BUILT_IN, serialOf } from "./util"
import type { DialogSpec } from "./ui"

export const STAGING = "staging"
export const PRODUCTION = "production"

export interface ChannelNow {
  name: string
  /** The bundle serial the channel serves, or null when it serves nothing or the app's own bundle. */
  serial: number | null
  killed: boolean
  empty: boolean
  rollout: number
  priority: Priority
  seq: number
  at: string | null
  by: string | null
  kind: string | null
  reason: string | null
  target: string | null
}

export function channelNow(s: State, name: string): ChannelNow {
  const c = s.channels.find((x) => x.name === name)
  const cur = c?.current ?? null
  const p = cur?.pointer
  return {
    name,
    serial: p && p.target !== BUILT_IN ? serialOf(p.target) : null,
    killed: p?.target === BUILT_IN,
    empty: !p,
    rollout: p?.rollout ?? 100,
    priority: p?.priority ?? "normal",
    seq: p?.seq ?? 0,
    at: cur?.at ?? null,
    by: cur?.publishedBy ?? null,
    kind: cur?.kind ?? null,
    reason: p?.reason ?? null,
    target: p?.target ?? null,
  }
}

export interface RowAction {
  id: string
  label: string
  enabled: boolean
  why?: string
  dialog: DialogSpec
  danger?: boolean
}

export function newestSerial(s: State): number {
  return s.bundles.reduce((m, b) => Math.max(m, b.serial), 0)
}

/** The three "next step" actions, in order, and the extra ones. The row shows the first two that are allowed. */
export function bundleActions(s: State, b: Bundle): { steps: RowAction[]; extras: RowAction[] } {
  const stg = channelNow(s, STAGING)
  const prd = channelNow(s, PRODUCTION)
  const dirty = b.manifest.git.dirty
  const steps: RowAction[] = []
  if (!b.liveOn.includes(STAGING)) {
    const back = stg.serial !== null && b.serial < stg.serial
    steps.push({ id: "staging", label: back ? "Roll back staging" : "To staging", enabled: true, dialog: { t: "change", mode: back ? "rollback" : "publish", channel: STAGING, serial: b.serial } })
  }
  if (!b.stableAt) {
    const ok = b.everOn.includes(STAGING)
    steps.push({ id: "stable", label: "Mark stable", enabled: ok, why: "Staging has not served it yet", dialog: { t: "stable", serial: b.serial, on: true } })
  }
  if (!b.liveOn.includes(PRODUCTION)) {
    const back = prd.serial !== null && b.serial < prd.serial
    const known = !!b.stableAt || b.everOn.includes(PRODUCTION)
    steps.push({
      id: "production",
      label: back ? "Roll back production…" : "To production…",
      enabled: known && !dirty,
      why: dirty ? "Built from uncommitted changes" : "Mark it stable first",
      dialog: { t: "change", mode: back ? "rollback" : "publish", channel: PRODUCTION, serial: b.serial },
    })
  }
  // A bundle marked for delete can't be published (the server refuses): undo the mark first
  if (b.deleteAt) for (const a of steps) Object.assign(a, { enabled: false, why: "Marked for delete: undo that first" })
  const extras: RowAction[] = [{ id: "title", label: "Customer title…", enabled: true, dialog: { t: "title", serial: b.serial } }]
  if (b.stableAt) extras.push({ id: "unstable", label: "Remove stable mark", enabled: true, dialog: { t: "stable", serial: b.serial, on: false } })
  if (b.deleteAt) {
    extras.push({ id: "undelete", label: "Keep it…", enabled: true, dialog: { t: "delete", serial: b.serial, on: false } })
  } else {
    const keep = whyKeep(s, b)
    extras.push({ id: "delete", label: "Delete…", danger: true, enabled: !keep, why: keep ?? undefined, dialog: { t: "delete", serial: b.serial, on: true } })
  }
  return { steps, extras }
}

/** Why a bundle can't be marked for delete now, or null when it can (the same rules as the server's whyKeepBundle). */
export function whyKeep(s: State, b: Bundle): string | null {
  if (b.liveOn.length) return `${b.liveOn.join(" and ")} serves it now: publish another bundle there first`
  const live = s.storeBuilds.find((x) => x.builtinSerial === b.serial && x.liveAt && !x.deleteAt)
  if (live) return `It is the built-in bundle of ${live.label}, marked live on the store`
  return null
}

/** Store builds that are not marked for delete (the marked ones show in their own list). */
export function keptStoreBuilds(s: State) {
  return s.storeBuilds.filter((x) => !x.deleteAt)
}

/** Families (app builds) that cannot run this bundle, with what each lacks. */
export function cannotRun(s: State, b: Bundle): { family: string; labels: string[]; why: string }[] {
  const out: { family: string; labels: string[]; why: string }[] = []
  for (const f of s.families) {
    const why = f.canRun[b.id]
    if (why) out.push({ family: f.family, labels: f.builds.map((x) => x.label), why })
  }
  return out
}

/** Store builds whose built-in bundle is as new as this bundle or newer: their phones ignore this bundle. */
export function olderThanStoreBuilds(s: State, b: Bundle, channel: string) {
  return s.storeBuilds.filter((x) => x.channel === channel && x.builtinSerial >= b.serial)
}

export interface Hint {
  tone: "amber" | "red" | "blue" | "green"
  text: string
  to?: string
}

export function nextHints(s: State, keyLoaded: boolean): Hint[] {
  const out: Hint[] = []
  const stg = channelNow(s, STAGING)
  const prd = channelNow(s, PRODUCTION)
  const by = (n: number) => s.bundles.find((b) => b.serial === n)
  if (s.app.publicKeys.length === 0) out.push({ tone: "red", text: "This app has no public keys yet: nothing can be uploaded or published.", to: "/env" })
  if (s.bundles.length === 0) out.push({ tone: "blue", text: "No bundles yet. Build one with the CLI, then it shows up here.", to: "/builds" })
  if (prd.killed) out.push({ tone: "red", text: "Production is killed: phones run the app's own bundle. Publish a bundle to end it.", to: "/channels" })
  if (stg.killed) out.push({ tone: "amber", text: "Staging is killed: phones run the app's own bundle.", to: "/channels" })
  const newest = s.bundles.find((b) => !b.deleteAt)
  if (newest && !newest.everOn.includes(STAGING)) out.push({ tone: "blue", text: `#${newest.serial} is built but not on staging yet.`, to: `/bundles/${newest.serial}` })
  if (stg.serial !== null) {
    const b = by(stg.serial)
    if (b && !b.stableAt) out.push({ tone: "blue", text: `#${b.serial} is on staging and not marked stable. Test it on a phone, then mark it stable.`, to: `/bundles/${b.serial}` })
    if (b?.stableAt && prd.serial !== null && b.serial > prd.serial) out.push({ tone: "green", text: `#${b.serial} is stable and ready for production (production has #${prd.serial}).`, to: `/bundles/${b.serial}` })
    if (b?.stableAt && prd.empty) out.push({ tone: "green", text: `#${b.serial} is stable. Production has nothing yet.`, to: `/bundles/${b.serial}` })
  }
  if (prd.serial !== null && prd.rollout < 100) out.push({ tone: "blue", text: `Production is at ${prd.rollout}% for #${prd.serial}. Raise it when the numbers look good.`, to: "/channels" })
  if (!keyLoaded && s.bundles.length > 0) out.push({ tone: "blue", text: "Load your signing key (top bar) before you publish, roll back or kill." })
  const lacking = newest ? cannotRun(s, newest) : []
  if (lacking.length) out.push({ tone: "amber", text: `#${newest!.serial} cannot run on: ${lacking.map((l) => l.labels.join(", ")).join("; ")}.`, to: `/bundles/${newest!.serial}` })
  return out
}

/** Channels in the order people work: staging first, production second, then any others. */
export function orderedChannels(s: State) {
  const rank = (n: string) => (n === STAGING ? 0 : n === PRODUCTION ? 1 : 2)
  return [...s.channels].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
}

/** How many needs colours the dashboard has (styles.css --needs-0 .. --needs-7). */
export const NEEDS_COLOURS = 8

/**
 * One colour per distinct needs tag, so bundles and store builds that need exactly the same things show the same colour
 * (Pavan, 2026-11-10). Colours go by the oldest serial with each tag, so an older bundle keeps its colour when newer ones
 * come; after 8 tags the colours repeat (the tag's text still tells them apart).
 */
export function needsColours(s: State): Map<string, number> {
  const first = new Map<string, number>()
  const seen = (tag: string | null, serial: number) => {
    if (tag && (!first.has(tag) || serial < first.get(tag)!)) first.set(tag, serial)
  }
  for (const b of s.bundles) seen(b.needs, b.serial)
  for (const sb of s.storeBuilds) seen(sb.needs, sb.builtinSerial)
  const order = [...first.entries()].sort((a, b) => a[1] - b[1])
  return new Map(order.map(([tag], i) => [tag, i % NEEDS_COLOURS]))
}

/** The other bundle numbers (OTA bundles and built-in ones) with the same needs tag, oldest first. */
export function sameNeeds(s: State, tag: string, serial: number): number[] {
  const out = new Set<number>()
  for (const b of s.bundles) if (b.needs === tag && b.serial !== serial) out.add(b.serial)
  for (const sb of s.storeBuilds) if (sb.needs === tag && sb.builtinSerial !== serial) out.add(sb.builtinSerial)
  return [...out].sort((a, b) => a - b)
}
