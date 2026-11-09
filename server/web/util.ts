// Small helpers: dates, sizes, plain words for the server's codes.
import type { ActivityRow, Capabilities, Os, Requires } from "./api"

export const BUILT_IN = "BUILT_IN"

export function serialOf(id: string): number {
  return Number(id.slice(id.lastIndexOf("_") + 1))
}
/** "demo_12" -> "#12"; BUILT_IN -> "the app's own bundle". */
export function targetLabel(target: string): string {
  return target === BUILT_IN ? "app's own bundle" : `#${serialOf(target)}`
}

// ---- Time -------------------------------------------------------------------------------------------------------------

export function ago(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return iso
  const s = Math.round((now - t) / 1000)
  if (s < -30) return "in the future"
  if (s < 45) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 45) return `${d} d ago`
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
}

export function dateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
}

export function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" })
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export const num = (n: number) => n.toLocaleString("en-IN")

// ---- Versions ---------------------------------------------------------------------------------------------------------

export function iosVersionString(n: number): string {
  return `${Math.floor(n / 1_000_000)}.${Math.floor(n / 1_000) % 1_000}.${n % 1_000}`
}
export function iosVersionNumber(v: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,3}))?(?:\.(\d{1,3}))?$/.exec(v.trim())
  if (!m) return null
  return Number(m[1]) * 1_000_000 + Number(m[2] ?? 0) * 1_000 + Number(m[3] ?? 0)
}
/** The version as people read it: Android versionCode, iOS "1.6.2". */
export function showVersion(os: Os, n: number): string {
  return os === "ios" ? iosVersionString(n) : String(n)
}
/** Same checks as the server (storeRules.ts versionNumber). */
export function versionNumber(os: Os, v: string): number | null {
  if (os === "ios") return iosVersionNumber(v)
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

// ---- Needs and capabilities -------------------------------------------------------------------------------------------

export function requiresList(r: Requires): string[] {
  return [
    `Registry v${r.registry}`,
    `Bytecode ${r.bytecode}`,
    `Host API v${r.hostApi}`,
    ...Object.keys(r.modules)
      .sort()
      .map((m) => `${m} v${r.modules[m]}`),
  ]
}
export function capabilityList(c: Capabilities): string[] {
  return [
    `Registry v${c.registry}`,
    `Bytecode ${c.bytecode}`,
    `Host API v${c.hostApiOldest} to v${c.hostApi}`,
    ...Object.keys(c.modules)
      .sort()
      .map((m) => `${m} v${c.modules[m]}`),
  ]
}

// ---- Plain words for codes --------------------------------------------------------------------------------------------

const EVENT_WORDS: Record<string, string> = {
  downloaded: "downloaded",
  applied: "applied",
  healthy: "ran fine",
  error_screen: "error screen",
  error_rollback: "rolled back after an error",
  launch_crashed: "crashed on start",
  watchdog_block: "blocked by the safety timer",
  apply_failed: "could not apply",
  init_failed: "app start failed",
  ota_off: "updates switched off by the app",
  signature: "bad signature",
  zip_sha: "download did not match",
  kept: "kept an older bundle",
  skipped: "skipped",
}
export const SERIOUS = ["error_rollback", "error_screen", "launch_crashed", "watchdog_block", "apply_failed", "init_failed", "ota_off", "signature", "zip_sha"]

export function eventWords(kind: string): string {
  return EVENT_WORDS[kind] ?? kind.replace(/_/g, " ")
}

export function kindWords(kind: string): string {
  return ({ publish: "Publish", rollback: "Roll back", rollout: "Rollout change", kill: "Kill switch" } as Record<string, string>)[kind] ?? kind
}

export function criticalWords(c: number): string {
  return c === 2 ? "Forced" : c === 1 ? "Optional" : "None"
}

export function runningLabel(running: string): string {
  if (running.startsWith("built-in:")) return `built-in ${running.slice(9)}`
  return running
}
/** A running id such as "demo_3" or "built-in:demo_0" in short form: "#3" or "built-in". */
export function runningShort(running: string): string {
  if (running.startsWith("built-in:")) return "built-in"
  return `#${serialOf(running)}`
}

export function actionWords(a: ActivityRow): { title: string; detail: string } {
  const d = (a.detail ?? {}) as Record<string, unknown>
  const s = (k: string) => (d[k] === undefined || d[k] === null ? "" : String(d[k]))
  const target = (t: string) => (t === BUILT_IN ? "the app's own bundle" : `#${serialOf(t)}`)
  switch (a.action) {
    case "app.save":
      return { title: "App saved", detail: [d.name ? `name ${s("name")}` : "", d.keys !== undefined ? `${s("keys")} public key(s)` : "", d.store ? "store facts" : ""].filter(Boolean).join(", ") }
    case "serial.reserve":
      return { title: d.kind === "store" ? "Serial taken for a store build" : "Serial taken for a bundle", detail: `#${s("serial")}` }
    case "bundle.upload":
      return { title: "Bundle uploaded", detail: `#${s("serial")}, ${bytes(Number(d.size ?? 0))}, commit ${s("commit").slice(0, 7)}${d.dirty ? " (uncommitted changes)" : ""}` }
    case "bundle.stable":
      return { title: "Marked stable", detail: `#${s("serial")}${s("note") ? `: ${s("note")}` : ""}` }
    case "bundle.unstable":
      return { title: "Stable mark removed", detail: `#${s("serial")}` }
    case "bundle.title":
      return { title: "Customer title set", detail: `#${s("serial")}: ${s("title") ? `"${s("title")}"` : "empty (silent fix)"}` }
    case "bundle.delete":
      return { title: "Bundle deleted", detail: `#${s("serial")}` }
    case "channel.publish":
    case "channel.rollback":
    case "channel.rollout":
    case "channel.kill": {
      const kind = a.action.slice(8)
      const head = { publish: "Published to", rollback: "Rolled back", rollout: "Rollout changed on", kill: "Kill switch on" }[kind]
      const bits = [`${target(s("target"))}`, kind === "kill" ? "" : `${s("rollout")}%`, s("priority") === "high" ? "high priority" : "", s("reason") ? `because: ${s("reason")}` : ""].filter(Boolean)
      return { title: `${head} ${s("channel")}`, detail: bits.join(", ") + (d.seq ? ` (seq ${s("seq")})` : "") }
    }
    case "storebuild.add":
      return { title: "Store build added", detail: `${s("label")}: ${s("os")}, code ${s("versionCode")}, built-in #${s("serial")}` }
    case "store.rule": {
      const os = s("os") as Os
      const v = typeof d.version === "number" ? showVersion(os, d.version) : s("version")
      return { title: `Store rule saved (${os === "ios" ? "App Store" : "Play"})`, detail: `${v}: ${criticalWords(Number(d.critical)).toLowerCase()}${d.isTest ? ", test version" : ""}${s("note") ? `, ${s("note")}` : ""}` }
    }
    case "store.rule.delete": {
      const os = s("os") as Os
      return { title: `Store rule deleted (${os === "ios" ? "App Store" : "Play"})`, detail: typeof d.version === "number" ? showVersion(os, d.version) : s("version") }
    }
    default:
      return { title: a.action, detail: Object.entries(d).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(", ") }
  }
}

export const ACTION_FILTERS: [string, string][] = [
  ["channel.publish", "Published"],
  ["channel.rollback", "Rolled back"],
  ["channel.rollout", "Rollout changed"],
  ["channel.kill", "Kill switch"],
  ["bundle.upload", "Bundle uploaded"],
  ["bundle.stable", "Marked stable"],
  ["bundle.unstable", "Stable mark removed"],
  ["bundle.title", "Customer title"],
  ["bundle.delete", "Bundle deleted"],
  ["store.rule", "Store rule saved"],
  ["store.rule.delete", "Store rule deleted"],
  ["storebuild.add", "Store build added"],
  ["serial.reserve", "Serial taken"],
  ["app.save", "App saved"],
]

export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const t = document.createElement("textarea")
      t.value = text
      t.style.position = "fixed"
      t.style.opacity = "0"
      document.body.appendChild(t)
      t.select()
      const ok = document.execCommand("copy")
      t.remove()
      return ok
    } catch {
      return false
    }
  }
}
