// The auth plugin's JS side. Native side: android/.../AuthModule.kt. No side effects: nativeModule() only creates a handle.
//
//   const hint = await Auth.phoneHint({ draft })          // at most once per login attempt, even after a kill
//   if (hint.phone) sendOtp(hint.phone)
//   else focusPhoneField()                                // any failure: the user types it
//
//   const otp = await Auth.listenForOtp({ key: phone })   // never rejects
//   if (otp.code) verify(otp.code)
//
// Both answer with a value and never reject, so a Play services failure can't leave a screen waiting. Nothing here logs
// a phone number or an OTP. Keep it that way in your app too.
import { createStorage, detached, launches, nativeModule, type CallOptions, type LaunchRecord } from "@zero-native/core"

/** Why there is no number. All of them mean the same to the user: type it by hand. */
export type HintReason =
  /** The user closed the sheet. */
  | "cancelled"
  /** The sheet gave no number, or the phone has none to offer. */
  | "no_number"
  /** Play services is missing, too old, slow or failed. */
  | "unavailable"
  /** This draft already had its hint: after a restore the sheet must not come back. */
  | "already_asked"
  /** The app was closed while the sheet was open, and no answer came. */
  | "lost"
  /** Another hint is open. */
  | "busy"
  /** A newer `phoneHint` with another draft took over, or the hint was cleared. */
  | "replaced"
  /** The sheet couldn't open: ZnLaunch's reasons, and "failed". */
  | "no_app"
  | "no_activity"
  | "no_storage"
  | "unacked"
  | "failed"

export type PhoneHint = { phone: string; reason: null } | { phone: null; reason: HintReason }

/** Why there is no code. All of them mean the same to the user: type it by hand. */
export type OtpReason =
  /** No SMS in time. */
  | "timeout"
  /** An SMS came, and the pattern found no code in it. */
  | "no_code"
  /** The pattern is not a valid pattern. */
  | "bad_pattern"
  /** Play services is missing, too old or failed. */
  | "unavailable"
  /** Any other failure. */
  | "failed"
  /** A newer listen took over. */
  | "replaced"
  /** `stopListening` was called. */
  | "cancelled"

export type OtpResult = { code: string; reason: null } | { code: null; reason: OtpReason }

export interface ListenOptions {
  /** A pattern (Java regex) for the code. If it has a group, the code is group 1. Default: the first number of 4 or 6 digits. */
  pattern?: string
  /** At most 5 minutes, the default: that is when Play services stops. A short one is for tests. */
  timeoutMs?: number
  /**
   * For a screen rebuilt while it waits. A listen with the same key as the last one joins it, running or finished, and
   * starts nothing new. Use the phone number. With no key, each listen is a new one. For a new send of the OTP, call
   * `stopListening` first, or the new listen gets the old answer.
   */
  key?: string
}

interface OtpEvent {
  id: string
  code: string | null
  reason: OtpReason | null
}

export interface AuthModule {
  /** Asks for the hint and opens the sheet. launched false: it didn't open. The number comes through `launches`. */
  phoneHint(args: { id: string }, options?: CallOptions): Promise<{ launched: boolean; reason?: string }>
  /** Starts listening. The outcome comes as the event "otp", with this id. */
  listenOtp(args: { id: string; pattern?: string; timeoutMs?: number }, options?: CallOptions): Promise<boolean>
  stopOtp(args: Record<string, never>, options?: CallOptions): Promise<boolean>
  appHash(args?: Record<string, never>, options?: CallOptions): Promise<string>
  events: { otp: OtpEvent }
}

const Native = nativeModule<AuthModule>("Auth", { version: 1 })
const HINT_KEY = "auth.phone-hint" // AuthRules.HINT_KEY
const ASKED = "hint.asked"
const store = createStorage("zn.auth")
// Native calls here are not tied to a screen. A screen can be rebuilt while it waits; its own answer must still come.
const unowned = { owned: false }

// ---- The phone number hint --------------------------------------------------------------------------------------------

interface Ask {
  draft: string
  /** The launch this ask waits for. */
  id: string | null
  done: boolean
  answer: (hint: PhoneHint) => void
  promise: Promise<PhoneHint>
}

let ask: Ask | null = null
let hearingHints = false
const none = (reason: HintReason): PhoneHint => ({ phone: null, reason })

function newAsk(draft: string): Ask {
  let answer!: (hint: PhoneHint) => void
  const promise = new Promise<PhoneHint>((resolve) => (answer = resolve))
  return { draft, id: null, done: false, answer, promise }
}

function finish(a: Ask, hint: PhoneHint): void {
  if (a.done) return
  a.done = true
  a.answer(hint)
}

const draftOf = (id: string) => id.slice(0, id.lastIndexOf("|"))

function read(r: LaunchRecord): PhoneHint {
  if (r.status === "lost") return none("lost")
  const phone = r.extras?.phone
  if (typeof phone === "string" && phone !== "") return { phone, reason: null }
  const reason = r.extras?.reason
  return none(typeof reason === "string" ? (reason as HintReason) : "no_number")
}

/** Fails quietly: the record stays, and the next ask tries again. */
const ackQuietly = (id: string) => launches.ack(HINT_KEY, id).catch(() => false)

function onHintRecord(r: LaunchRecord): void {
  if (ask?.id === r.id) finish(ask, read(r))
  // Not after the app acted on it, as for a payment: a hint is only a help, and the number shouldn't stay on disk.
  void ackQuietly(r.id)
}

function hearHints(): void {
  if (hearingHints) return
  hearingHints = true
  detached(() => {
    launches.onResult(HINT_KEY, onHintRecord)
  })
}

async function startAsk(a: Ask): Promise<void> {
  // The launch record goes first: after a kill it is the answer to the hint that was open.
  const saved = launches.pending(HINT_KEY)
  if (saved) {
    if (draftOf(saved.id) === a.draft) {
      a.id = saved.id
      if (saved.status !== "waiting") onHintRecord(saved)
      return // waiting: its result comes to the listener
    }
    if (saved.status === "waiting") return finish(a, none("busy"))
    await ackQuietly(saved.id) // an earlier attempt's number is never handed to a new one
  }
  if (store.getString(ASKED) === a.draft) return finish(a, none("already_asked"))
  store.set(ASKED, a.draft) // before it opens, so a kill at any point after this can't bring the sheet back
  a.id = `${a.draft}|${Date.now()}`
  const started = await Native.phoneHint({ id: a.id }, unowned)
  if (!started.launched) finish(a, none((started.reason as HintReason | undefined) ?? "unavailable"))
}

function phoneHint(args: { draft: string }): Promise<PhoneHint> {
  if (ask?.draft === args.draft) return ask.promise
  if (ask) finish(ask, none("replaced"))
  hearHints()
  const a = newAsk(args.draft)
  ask = a
  startAsk(a).catch(() => finish(a, none("unavailable")))
  return a.promise
}

function clearPhoneHint(): void {
  if (ask) finish(ask, none("replaced"))
  ask = null
  store.delete(ASKED)
  const saved = launches.pending(HINT_KEY)
  if (saved && saved.status !== "waiting") void ackQuietly(saved.id)
}

// ---- The SMS Retriever ------------------------------------------------------------------------------------------------

const waiting = new Map<string, (result: OtpResult) => void>()
let lastListen: { key: string; promise: Promise<OtpResult> } | null = null
let hearingOtp = false
let nextOtpId = 1

function answerOtp(id: string, result: OtpResult): void {
  const answer = waiting.get(id)
  if (!answer) return
  waiting.delete(id)
  answer(result)
}

function hearOtp(): void {
  if (hearingOtp) return
  hearingOtp = true
  detached(() => {
    Native.on("otp", (e) => answerOtp(e.id, e.code ? { code: e.code, reason: null } : { code: null, reason: e.reason ?? "failed" }))
  })
}

function listenForOtp(options: ListenOptions = {}): Promise<OtpResult> {
  const { key, pattern, timeoutMs } = options
  if (key !== undefined && lastListen?.key === key) return lastListen.promise
  hearOtp()
  const id = String(nextOtpId++)
  const promise = new Promise<OtpResult>((resolve) => waiting.set(id, resolve))
  lastListen = key === undefined ? null : { key, promise }
  Native.listenOtp({ id, pattern, timeoutMs }, unowned).catch((err: { code?: string }) =>
    answerOtp(id, { code: null, reason: err.code === "unavailable" ? "unavailable" : "failed" }),
  )
  return promise
}

function stopListening(): void {
  lastListen = null
  Native.stopOtp({}, unowned).catch(() => false)
}

/** The plugin's API. Each call answers with a value: none of them rejects. */
export const Auth = {
  /**
   * The Google sheet with the phone's numbers, at most once per [draft], an id you make for one login attempt. Keep the
   * same draft across a restore, and a screen rebuilt after a kill gets the answer of the hint that was open, or
   * "already_asked". It never brings the sheet back. A rebuilt screen that asks again while the sheet is open joins it.
   * A new draft (a new login) can ask again. The number is what the user picked: it proves nothing, so verify it by OTP.
   */
  phoneHint,
  /** Forgets the hint: when a login ends, or the user backs out. Also clears a number that nobody read from disk. */
  clearPhoneHint,
  /** Waits for the OTP SMS. Start it just before you ask your server to send the SMS. Only one listen runs at a time. */
  listenForOtp,
  /** Stops the listen. It answers "cancelled". */
  stopListening,
  /**
   * The 11-char hash your server must put in the SMS, or "" if it can't be read. It depends on the package name and the
   * signing key: debug, release and Play signed builds each have their own (see the README).
   */
  appHash: (): Promise<string> => Native.appHash({}, unowned).catch(() => ""),
}
