// "Check for an update now" pushes (docs/zn-updates-server.md §4.4). After a channel change, the server sends one FCM
// data message to the topic `zn-ota-<app>-<channel>`; the phone (plugins/firebase-messaging, PushPlugin with otaCheck)
// schedules a background check after a random wait of 0..zn_ota_delay_ms, so not every phone asks at the same minute.
// The check only downloads: the new bundle runs from the next start, as with a check at launch (as ZeroBill's RN app).
// Nothing here can fail a publish: a failed push is logged in the activity and the phones still find the update at
// their next start.
import type { Db } from "./db"
import { type App, logActivity } from "./model"

/** Per app (apps.push): which Firebase project sends, and the longest wait per channel. No fcmProject = no pushes. */
export interface PushConfig {
  fcmProject?: string
  /** Longest random wait per channel, in ms. Default: staging 3 s, production 6 h (as RN). */
  delayMs?: Record<string, number>
}

/** Sends one FCM v1 message; answers FCM's message name. */
export type PushSender = (project: string, message: Record<string, unknown>) => Promise<string>

export const DEFAULT_DELAY_MS: Record<string, number> = { staging: 3_000, production: 6 * 3_600_000 }
/** A kill switch should reach phones sooner than a normal update: its wait is at most 10 minutes. */
export const KILL_DELAY_MAX_MS = 10 * 60_000
const MAX_DELAY_MS = 24 * 3_600_000

export function topicFor(app: string, channel: string): string {
  return `zn-ota-${app}-${channel}`.replace(/[^a-zA-Z0-9\-_.~%]/g, "_")
}

/** The longest wait for this change: the channel's setting (or the default), shorter for a kill switch. */
export function delayFor(cfg: PushConfig, channel: string, kind: string): number {
  const set = cfg.delayMs?.[channel] ?? DEFAULT_DELAY_MS[channel] ?? DEFAULT_DELAY_MS.staging!
  const d = Math.max(0, Math.min(MAX_DELAY_MS, Math.round(Number(set) || 0)))
  return kind === "kill" ? Math.min(d, KILL_DELAY_MAX_MS) : d
}

/** Which changes are worth a push: anything that gives phones something new. A lower rollout gives nobody anything. */
export function worthPush(kind: string, rollout: number, previousRollout: number | null): boolean {
  if (kind === "publish" || kind === "rollback" || kind === "kill") return true
  if (kind === "rollout") return previousRollout === null || rollout > previousRollout
  return false
}

export function message(app: string, channel: string, delayMs: number): Record<string, unknown> {
  return {
    topic: topicFor(app, channel),
    data: { zn_ota: "check", zn_ota_delay_ms: String(delayMs) },
    // High: a data message at normal priority can wait for hours in Doze. The phone itself spreads the checks.
    android: { priority: "HIGH", ttl: "86400s" },
  }
}

/** Sends the push for one channel and writes the outcome in the activity log. Never throws. */
export async function tellPhones(
  db: Db,
  send: PushSender,
  app: App,
  channel: string,
  o: { kind: string; seq?: number; by: string },
): Promise<{ sent: boolean; name?: string; error?: string; delayMs?: number; topic: string }> {
  const cfg = (app.push ?? {}) as PushConfig
  const topic = topicFor(app.id, channel)
  if (!cfg.fcmProject) return { sent: false, error: "no fcmProject set for this app", topic }
  const delayMs = delayFor(cfg, channel, o.kind)
  try {
    const name = await send(cfg.fcmProject, message(app.id, channel, delayMs))
    await logActivity(db, app.id, o.by, "push.sent", { channel, topic, kind: o.kind, seq: o.seq, delayMs, name }).catch(() => {})
    return { sent: true, name, delayMs, topic }
  } catch (e) {
    const error = (e as Error).message.slice(0, 300)
    console.warn(`push ${topic}: ${error}`)
    await logActivity(db, app.id, o.by, "push.failed", { channel, topic, kind: o.kind, seq: o.seq, error }).catch(() => {})
    return { sent: false, error, topic }
  }
}

// ---- The real sender: FCM HTTP v1 -------------------------------------------------------------------------------------

let cached: { token: string; until: number } | null = null

/**
 * An OAuth token for FCM. On GKE: the pod's Google account from the metadata server (Workload Identity; the account
 * needs "Firebase Cloud Messaging Admin" on the Firebase project). For a local run: FCM_ACCESS_TOKEN
 * (e.g. `gcloud auth print-access-token`).
 */
async function accessToken(): Promise<string> {
  const fromEnv = process.env.FCM_ACCESS_TOKEN
  if (fromEnv) return fromEnv
  if (cached && cached.until > Date.now() + 60_000) return cached.token
  const res = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) throw new Error(`no Google token from the metadata server (${res.status}); set FCM_ACCESS_TOKEN for a local run`)
  const t = (await res.json()) as { access_token: string; expires_in: number }
  cached = { token: t.access_token, until: Date.now() + t.expires_in * 1000 }
  return t.access_token
}

export const fcmSender: PushSender = async (project, msg) => {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(project)}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ message: msg }),
    signal: AbortSignal.timeout(10_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`FCM answered ${res.status}: ${text.slice(0, 200)}`)
  return (JSON.parse(text) as { name: string }).name
}
