// Talking to the server (same origin). The browser never has the admin token: `bun run updates dashboard` opens a
// one-time link that gives this browser a session cookie (HttpOnly: scripts can't read it). Every call sends the cookie
// and the header `x-zn-admin: 1` (the server refuses a cookie without it, so another site can't act for you).
// Errors from the server are { error } JSON, written for people: we show them as they are.

export interface Auth {
  /** The person of this session (from the CLI's `--by`), shown in the activity log. */
  name: string
  expiresAt: string | null
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

// ---- Types (what /admin/* sends; see server/src/model.ts) --------------------------------------------------------------

export interface Signature {
  keyId: string
  value: string
}
export interface Requires {
  registry: number
  bytecode: number
  hostApi: number
  modules: Record<string, number>
}
export interface Capabilities {
  registry: number
  bytecode: number
  hostApi: number
  hostApiOldest: number
  modules: Record<string, number>
}
export interface Manifest {
  format: number
  app: string
  id: string
  serial: number
  bundleSha256: string
  requires: Requires
  zip: { path: string; sha256: string; size: number }
  git: { commit: string; dirty: boolean }
  builtAt: string
  signature: Signature
}
/** How soon phones update: normal = next start, high = may update at the splash, critical = update now. */
export type Priority = "normal" | "high" | "critical"
export interface Pointer {
  format: number
  app: string
  channel: string
  seq: number
  target: string
  rollout: number
  priority: Priority
  at: string
  reason?: string
  signature: Signature
}
export interface PointerRow {
  pointer: Pointer
  kind: "publish" | "rollback" | "rollout" | "kill" | string
  publishedBy: string
  at: string
}
/** A patch zip: it turns the bundle `fromId` (an OTA bundle, or a store build's built-in bundle) into `toId`. */
export interface Patch {
  toId: string
  fromId: string
  fromSha256: string
  path: string
  sha256: string
  size: number
  madeAt: string
}
export interface Bundle {
  app: string
  serial: number
  id: string
  manifest: Manifest
  gitSubject: string
  builtBy: string
  builtAt: string
  stableAt: string | null
  stableBy: string | null
  stableNote: string | null
  customerTitle: string | null
  note: string | null
  liveOn: string[]
  everOn: string[]
  /** Smaller than the full zip: what phones on an older bundle can download instead (made after the upload). */
  patches: Patch[]
  /** Marked for delete: hidden, removed for good 30 days after the mark was made (null = not marked). */
  deleteAt: string | null
  deleteBy: string | null
}
export interface AppRecord {
  id: string
  name: string
  publicKeys: string[]
  store: { android?: { packages?: Record<string, string> }; ios?: { appStoreId?: string; packages?: Record<string, string> } } & Record<string, unknown>
}
export type Os = "android" | "ios"
export interface StoreBuild {
  id: number
  os: Os
  channel: string
  label: string
  versionCode: number
  versionName: string
  builtinSerial: number
  builtinSha256: string
  capabilities: Capabilities | null
  family: string | null
  git: { commit: string; dirty: boolean }
  builtBy: string
  builtAt: string
  /** Size of the built-in bundle's zip kept as a patch base; null = none (phones on it get full zips). */
  baseSize: number | null
  /** Marked "live on Play / App Store" by a person: then it and its built-in bundle can't be deleted. */
  liveAt: string | null
  liveBy: string | null
  deleteAt: string | null
  deleteBy: string | null
}
export interface Family {
  family: string
  capabilities: Capabilities
  builds: { label: string; os: Os; channel: string; versionCode: number; versionName: string; builtinSerial: number }[]
  canRun: Record<string, string | null>
}
export interface Rule {
  id: number
  /** The channel whose phones the rule is for. */
  channel: string
  version: number
  critical: 0 | 1 | 2
  isTest: boolean
  title: string | null
  message: string | null
  note: string | null
  by: string
  at: string
}
export interface ChannelState {
  name: string
  current: PointerRow | null
  history: PointerRow[]
}
export interface State {
  app: AppRecord
  channels: ChannelState[]
  bundles: Bundle[]
  storeBuilds: StoreBuild[]
  families: Family[]
  rules: { android: Rule[]; ios: Rule[] }
}
export interface Stats {
  phones: { day: string; running: string; phones: number }[]
  events: { day: string; bundle: string; kind: string; detail: string; count: number }[]
  /** decoded: the stack with the app's TSX file:line (when the bundle's source map is on the server), else null. */
  errors: { at: string; bundle: string; kind: string; detail: string; stack: string | null; sha: string | null; decoded?: string | null }[]
}
/** The JS size by file and folder, read from a bundle's source map (the JS before Hermes, so about, not exact). */
export interface Sizes {
  mapped: number
  unmapped: number
  files: { name: string; bytes: number }[]
  folders: { name: string; bytes: number }[]
  fileCount: number
}
export interface ActivityRow {
  id: number
  at: string
  by: string
  action: string
  detail: Record<string, unknown> | null
}
export interface Env {
  database: string
  storage: string
  started: string
  version: string
  now: string
}
export interface StoreAnswer {
  version: number | string
  critical: 1 | 2
  title?: string
  message?: string
}

// ---- Calls ------------------------------------------------------------------------------------------------------------

let onSignedOut: () => void = () => {}

/** Called when the server says the session ended (401). */
export function onSessionEnd(f: () => void) {
  onSignedOut = f
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        "x-zn-admin": "1",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError("could not reach the server: check your network and try again", 0)
  }
  const text = await res.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { error: text.slice(0, 300) }
  }
  if (!res.ok) {
    if (res.status === 401) onSignedOut()
    throw new ApiError((data as { error?: string } | null)?.error ?? `HTTP ${res.status}`, res.status)
  }
  return data as T
}

const enc = encodeURIComponent
export const routes = {
  session: () => api<{ by: string; via: string; expiresAt: string | null }>("GET", "/admin/session"),
  logout: () => api<{ ok: boolean }>("POST", "/admin/logout"),
  apps: () => api<AppRecord[]>("GET", "/admin/apps"),
  env: () => api<Env>("GET", "/admin/env"),
  state: (app: string) => api<State>("GET", `/admin/apps/${enc(app)}/state`),
  stats: (app: string, channel: string, days: number) => api<Stats>("GET", `/admin/apps/${enc(app)}/stats?channel=${enc(channel)}&days=${days}`),
  activity: (app: string, before?: number, limit = 50) =>
    api<ActivityRow[]>("GET", `/admin/apps/${enc(app)}/activity?limit=${limit}${before ? `&before=${before}` : ""}`),
  next: (app: string, channel: string, target: string) =>
    api<{ seq: number; text: string }>("GET", `/admin/apps/${enc(app)}/channels/${enc(channel)}/next?target=${enc(target)}`),
  pointer: (app: string, pointer: unknown, confirm?: string) =>
    api<{ pointer: Pointer; kind: string }>("POST", `/admin/apps/${enc(app)}/pointers`, { pointer, confirm }),
  stable: (app: string, serial: number, on: boolean, note?: string) => api("POST", `/admin/apps/${enc(app)}/bundles/${serial}/stable`, { on, note }),
  title: (app: string, serial: number, title: string) => api("POST", `/admin/apps/${enc(app)}/bundles/${serial}/title`, { title }),
  /** on = mark for delete (removed in 30 days), off = undo. */
  markDelete: (app: string, serial: number, on: boolean) => api<{ deleteAt: string | null }>("POST", `/admin/apps/${enc(app)}/bundles/${serial}/delete`, { on }),
  bundlePhones: (app: string, serial: number) => api<{ phones: number; days: number }>("GET", `/admin/apps/${enc(app)}/bundles/${serial}/phones`),
  bundleSize: (app: string, serial: number) => api<{ sizes: Sizes | null; before: { serial: number; sizes: Sizes } | null }>("GET", `/admin/apps/${enc(app)}/bundles/${serial}/size`),
  storeLive: (app: string, id: number, on: boolean) => api("POST", `/admin/apps/${enc(app)}/store-builds/${id}/live`, { on }),
  storeDelete: (app: string, id: number, on: boolean) => api("POST", `/admin/apps/${enc(app)}/store-builds/${id}/delete`, { on }),
  storePhones: (app: string, id: number) => api<{ phones: number; days: number }>("GET", `/admin/apps/${enc(app)}/store-builds/${id}/phones`),
  saveRule: (app: string, body: Record<string, unknown>) => api("POST", `/admin/apps/${enc(app)}/store-rules`, body),
  deleteRule: (app: string, channel: string, os: Os, version: number) => api("DELETE", `/admin/apps/${enc(app)}/store-rules/${os}/${version}?channel=${enc(channel)}`),
  storeCheck: (app: string, channel: string, os: Os, version: string) =>
    api<{ update: StoreAnswer | null }>("GET", `/admin/apps/${enc(app)}/store-check?channel=${enc(channel)}&os=${os}&version=${enc(version)}`),
}

// ---- Saved sign-in (localStorage may be blocked: never throw) ---------------------------------------------------------

export function saved(key: string): string {
  try {
    return localStorage.getItem(key) ?? ""
  } catch {
    return ""
  }
}
export function save(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    /* the page still works without saving */
  }
}
