// The location plugin's JS side. Native side: android/.../LocationModule.kt (Android's LocationManager; Play services only
// for the turn-on dialog).
//
//   const { permission } = await Location.status()
//   if (permission === "denied") await Location.requestPermission()      // only from a tap: it shows Android's dialog
//   const r = await Location.getCurrentPosition({ timeoutMs: 8000 })
//   if (r.position) loadStores(r.position.coords)
//   else if (r.reason === "off") {
//     const t = await Location.turnOn()                                     // Google's "Turn on location" dialog
//     if (t.on) retry()
//     else if (t.reason === "unavailable") Location.openSettings()         // no Play services: check again on "active"
//   }
//   else if (r.reason === "blocked") Os.openSettings()                    // the app's page: only way out of "blocked"
//
// Each call answers with a value and never rejects. Nothing here shows a dialog except requestPermission and turnOn.
// Nothing here logs a coordinate or an address. Keep it that way in your app too.
import { detached, launches, nativeModule, onCleanup, Permissions, Platform, type CallOptions, type LaunchRecord, type PermissionState } from "@zero-native/core"

export type Accuracy =
  /** Waits for a fix within 25 m, until the timeout. Uses the GPS. */
  | "high"
  /** The first fix within 100 m. Usually the network, in 1-3 s. The default. */
  | "balanced"
  /** The first fix of any accuracy. Never starts the GPS when the network can answer. */
  | "low"

/** Why there is no position. */
export type LocationReason =
  /** No location permission. Ask with `requestPermission`. */
  | "denied"
  /** No permission, and Android won't ask again: only the app's settings page (`Os.openSettings`) can change it. */
  | "blocked"
  /** Location is off in the phone's settings. `Location.openSettings()` opens that screen. */
  | "off"
  /** Location is on, but no provider this app may use is (for example: only the rough permission, and no network one). */
  | "unavailable"
  /** No fix in time. Indoors, with only GPS, this is common. */
  | "timeout"
  /** The app was hidden. Android gives a hidden app no fix. */
  | "background"
  /** Your `signal` aborted it. */
  | "cancelled"
  /** The plugin is missing or failed. */
  | "failed"

export interface Coords {
  latitude: number
  longitude: number
  /** Metres, 68% sure. null if the provider gave none. */
  accuracy: number | null
  altitude: number | null
  altitudeAccuracy: number | null
  /** Degrees from north. */
  heading: number | null
  /** Metres per second. */
  speed: number | null
}

export interface Position {
  coords: Coords
  /** When the fix was made, ms since 1970 (the phone's clock). */
  timestamp: number
  /** How old the fix was when native sent it, ms. Unlike `timestamp`, a wrong phone clock doesn't change it. */
  ageMs: number
  /** "gps", "network", "passive" or "fused". */
  provider: string
  /** A mock location app made it. Don't trust it for anything that matters. */
  mocked: boolean
}

export type PositionResult =
  | { position: Position; reason: null; lastKnown: null }
  /** lastKnown: the newest cached fix, of any age (look at `ageMs`), or null. You decide if it is good enough. */
  | { position: null; reason: LocationReason; lastKnown: Position | null }

export interface CurrentOptions {
  accuracy?: Accuracy
  /** Default 10 s, at most 60 s. At the timeout you get the best fix seen so far, if any. */
  timeoutMs?: number
  /** A cached fix this new answers at once, with nothing started. Default 0: always a fresh fix. */
  maxAgeMs?: number
  signal?: AbortSignal
}

export interface WatchOptions {
  accuracy?: Accuracy
  /** How often, ms. Default 5000, at least 1000. Android may send sooner or later. */
  intervalMs?: number
  /** Only after moving this far, metres. Default 0. */
  distanceFilterM?: number
}

/** Why a watch sent no position. "off" can come and go; the others end the watch. */
export type WatchReason = "off" | "denied" | "blocked" | "unavailable" | "failed"

export interface LocationStatus {
  permission: PermissionState
  /** The precise permission. Without it, Android 12+ blurs every fix to about 2 km, and the GPS is not used. */
  precise: boolean
  /** Location is on in the phone's settings. */
  enabled: boolean
  /** These providers are on. */
  gps: boolean
  network: boolean
}

export interface Address {
  /** The best short name: area, else city, district, state. */
  name: string | null
  /** The first address line, as the geocoder writes it. */
  line: string | null
  area: string | null
  city: string | null
  district: string | null
  state: string | null
  /** A string: some countries have letters in it. */
  postalCode: string | null
  country: string | null
  countryCode: string | null
  latitude: number | null
  longitude: number | null
}

/** Why location is still off after `turnOn`. */
export type TurnOnReason =
  /** The user tapped "No thanks", or closed the dialog. */
  | "declined"
  /** No dialog for this: no Play services, too old, or the setting can't change now. Open `Location.openSettings()`. */
  | "unavailable"
  /** Another dialog of this app (a payment app, the phone hint) is open. */
  | "busy"
  /** No Activity: the app is not on screen. */
  | "no_activity"
  /** The app was closed while the dialog was open, and no answer came. Read `status()` again. */
  | "lost"
  /** The plugin is missing or failed. */
  | "failed"

export type TurnOnResult = { on: true; reason: null } | { on: false; reason: TurnOnReason }

/** "none": nothing found. "unavailable": this phone has no geocoder. "failed": often no internet. */
export type GeocodeResult = { addresses: Address[]; reason: null } | { addresses: []; reason: "none" | "unavailable" | "failed" | "timeout" | "invalid" }

type NativeFix = Omit<Position, "coords"> & Coords
type NativeAnswer = { position: NativeFix | null; reason: LocationReason | null; lastKnown: NativeFix | null }
interface Providers {
  enabled: boolean
  gps: boolean
  network: boolean
  hasGps: boolean
  hasNetwork: boolean
  fine: boolean
  coarse: boolean
}
interface WatchEvent {
  id: string
  position: NativeFix | null
  reason: WatchReason | null
}

export interface LocationModule {
  providers(args?: Record<string, never>, options?: CallOptions): Promise<Providers>
  lastKnown(args?: Record<string, never>, options?: CallOptions): Promise<NativeFix | null>
  current(args: { accuracy?: Accuracy; timeoutMs?: number; maxAgeMs?: number }, options?: CallOptions): Promise<NativeAnswer>
  /** Runs until cancelled; answers only if the watch can't run. */
  watch(args: { id: string } & WatchOptions, options?: CallOptions): Promise<{ reason: WatchReason }>
  /** launched: Google's dialog opened, and its answer comes through `launches` with this id. */
  turnOn(args: { id: string }, options?: CallOptions): Promise<{ on: boolean; launched?: boolean; reason?: TurnOnReason }>
  openSettings(args?: Record<string, never>, options?: CallOptions): Promise<boolean>
  reverseGeocode(args: { latitude: number; longitude: number; max?: number }, options?: CallOptions): Promise<GeocodeResult>
  geocode(args: { query: string; max?: number }, options?: CallOptions): Promise<GeocodeResult>
  events: { watch: WatchEvent }
}

const Native = nativeModule<LocationModule>("Location", { version: 2 }) // 2: turnOn
const TURN_ON_KEY = "location.turn-on" // LocationRules.TURN_ON_KEY
const FINE = "android.permission.ACCESS_FINE_LOCATION"
const COARSE = "android.permission.ACCESS_COARSE_LOCATION"
// iOS has one location permission ("while using"); whether fixes are precise is the user's switch in the same dialog,
// which core's Permissions answers as "location.precise". Android's two names mean nothing there.
const IOS_LOCATION = "location"
const IOS_PRECISE = "location.precise"
const ios = () => Platform.OS === "ios"
// A one-shot is not tied to a screen: its promise must settle even if the screen that asked closes. Native ends it by
// itself at its timeout (60 s at most).
const unowned = { owned: false }

function toPosition(f: NativeFix): Position {
  const { latitude, longitude, accuracy, altitude, altitudeAccuracy, heading, speed, timestamp, ageMs, provider, mocked } = f
  return { coords: { latitude, longitude, accuracy, altitude, altitudeAccuracy, heading, speed }, timestamp, ageMs, provider, mocked }
}

/** Granted if either one is: the user may pick "approximate". Blocked only when neither is, and Android won't ask again. */
function permissionOf(fine: PermissionState | undefined, coarse: PermissionState | undefined): PermissionState {
  if (fine === "granted" || coarse === "granted") return "granted"
  if (fine === "blocked" || coarse === "blocked") return "blocked"
  return "denied"
}

/** The location permission now, from core's Permissions (Android: fine or coarse; iOS: "location"). */
async function permissionNow(): Promise<PermissionState> {
  if (ios()) return (await Permissions.status([IOS_LOCATION]))[IOS_LOCATION] ?? "denied"
  const s = await Permissions.status([FINE, COARSE])
  return permissionOf(s[FINE], s[COARSE])
}

/** "denied" becomes "blocked" when the phone won't show the dialog again. Any failure keeps "denied". */
async function refine<R extends string>(reason: R): Promise<R | "blocked"> {
  if (reason !== "denied") return reason
  try {
    return (await permissionNow()) === "blocked" ? "blocked" : reason
  } catch {
    return reason
  }
}

async function getCurrentPosition(options: CurrentOptions = {}): Promise<PositionResult> {
  const { accuracy, timeoutMs, maxAgeMs, signal } = options
  try {
    const a = await Native.current({ accuracy, timeoutMs, maxAgeMs }, { ...unowned, signal })
    if (a.position) return { position: toPosition(a.position), reason: null, lastKnown: null }
    const reason = await refine(a.reason ?? "failed")
    return { position: null, reason, lastKnown: a.lastKnown ? toPosition(a.lastKnown) : null }
  } catch {
    return { position: null, reason: signal?.aborted ? "cancelled" : "failed", lastKnown: null }
  }
}

let nextWatch = 1

/**
 * Sends positions until you call the returned stop, or the screen that started it closes. Started outside a screen (a
 * store, a `detached` block), it runs until stop. It pauses while the app is hidden and goes on when it comes back.
 * `onError("off")` can come more than once: positions start again when the user turns location back on.
 */
function watchPosition(onPosition: (p: Position) => void, options: WatchOptions = {}, onError?: (reason: WatchReason) => void): () => void {
  const id = String(nextWatch++)
  const controller = new AbortController()
  let stopped = false
  const off = Native.on("watch", (e) => {
    if (stopped || e.id !== id) return
    if (e.position) onPosition(toPosition(e.position))
    else if (e.reason) onError?.(e.reason)
  })
  const stop = () => {
    if (stopped) return
    stopped = true
    off()
    controller.abort()
  }
  const { accuracy, intervalMs, distanceFilterM } = options
  Native.watch({ id, accuracy, intervalMs, distanceFilterM }, { signal: controller.signal })
    .then(async (end) => {
      if (stopped) return
      const reason = await refine(end?.reason ?? "failed")
      stop()
      onError?.(reason)
    })
    .catch(() => {
      if (stopped) return
      stop()
      onError?.("failed")
    })
  onCleanup(stop) // no owner: does nothing, and the watch runs until stop
  return stop
}

async function status(): Promise<LocationStatus> {
  let p: Providers
  try {
    p = await Native.providers({}, unowned)
  } catch {
    return { permission: "denied", precise: false, enabled: false, gps: false, network: false }
  }
  let permission: PermissionState = p.fine || p.coarse ? "granted" : "denied"
  if (permission !== "granted") {
    try {
      permission = await permissionNow()
    } catch {
      // No Activity (a background task): "denied" is the best we know.
    }
  }
  return { permission, precise: p.fine, enabled: p.enabled, gps: p.gps, network: p.network }
}

/**
 * Shows Android's dialog. Call it from a tap. `precise: false` asks only for the rough permission. With nothing to ask
 * (already granted, or blocked) it shows nothing and answers at once.
 */
async function requestPermission(options: { precise?: boolean } = {}): Promise<{ permission: PermissionState; precise: boolean }> {
  try {
    if (ios()) {
      // One dialog; the precise switch is in it, so `precise: false` changes nothing on iOS.
      const r = await Permissions.request([IOS_LOCATION])
      return { permission: r[IOS_LOCATION] ?? "denied", precise: r[IOS_PRECISE] === "granted" }
    }
    const names = options.precise === false ? [COARSE] : [FINE, COARSE]
    const r = await Permissions.request(names)
    const fine = r[FINE]
    return { permission: permissionOf(fine, r[COARSE]), precise: fine === "granted" || (await status()).precise }
  } catch {
    // busy, no_activity, not_declared (the app's manifest lost the permission): read what is true now.
    const s = await status()
    return { permission: s.permission, precise: s.precise }
  }
}

// ---- Turning location on ----------------------------------------------------------------------------------------------

const ON: TurnOnResult = { on: true, reason: null }
const stillOff = (reason: TurnOnReason): TurnOnResult => ({ on: false, reason })
const waitingTurnOn = new Map<string, (r: TurnOnResult) => void>()
let turning: Promise<TurnOnResult> | null = null
let hearingTurnOn = false
let nextTurnOn = 1

/** Fails quietly: the record stays, and the next turnOn clears it. */
const ackQuietly = (id: string) => launches.ack(TURN_ON_KEY, id).catch(() => false)

function onTurnOnRecord(r: LaunchRecord): void {
  const answer = waitingTurnOn.get(r.id)
  waitingTurnOn.delete(r.id)
  answer?.(r.status === "lost" ? stillOff("lost") : r.resultCode === -1 ? ON : stillOff("declined"))
  // Nothing to keep: the phone's setting is the real answer, and status() reads it.
  void ackQuietly(r.id)
}

function hearTurnOn(): void {
  if (hearingTurnOn) return
  hearingTurnOn = true
  detached(() => {
    launches.onResult(TURN_ON_KEY, onTurnOnRecord)
  })
}

async function askToTurnOn(): Promise<TurnOnResult> {
  const saved = launches.pending(TURN_ON_KEY)
  if (saved?.status === "waiting") return stillOff("busy")
  if (saved) await ackQuietly(saved.id) // an answer from before a kill: the setting itself tells now
  hearTurnOn()
  const id = `turn-on-${Date.now()}-${nextTurnOn++}`
  const answer = new Promise<TurnOnResult>((resolve) => waitingTurnOn.set(id, resolve))
  let started: Awaited<ReturnType<LocationModule["turnOn"]>>
  try {
    started = await Native.turnOn({ id }, unowned)
  } catch {
    waitingTurnOn.delete(id)
    return stillOff("failed")
  }
  if (started.launched) return answer
  waitingTurnOn.delete(id)
  return started.on ? ON : stillOff(started.reason ?? "unavailable")
}

/**
 * Google's "Turn on location" dialog, when location is off. "Turn on" switches it on at once, with no settings screen.
 * Already on: answers `{ on: true }` and shows nothing. Call it from a tap. A second call while the dialog is open joins it.
 */
function turnOn(): Promise<TurnOnResult> {
  if (turning) return turning
  const p = askToTurnOn().finally(() => {
    turning = null
  })
  turning = p
  return p
}

const noAddresses = (reason: "failed"): GeocodeResult => ({ addresses: [], reason })

/** The public API. Each call answers with a value: none of them rejects. */
export const Location = {
  getCurrentPosition,
  watchPosition,
  /** The newest cached fix, of any age, with no provider started. null if none, or no permission. */
  lastKnown: async (): Promise<Position | null> => {
    try {
      const f = await Native.lastKnown({}, unowned)
      return f ? toPosition(f) : null
    } catch {
      return null
    }
  },
  status,
  requestPermission,
  turnOn,
  /**
   * The phone's Location settings screen. false if it couldn't open. The fallback when `turnOn` says "unavailable". For a
   * blocked permission use `Os.openSettings()`.
   */
  openSettings: (): Promise<boolean> => Native.openSettings({}, unowned).catch(() => false),
  /**
   * Places at a point, best first, from Android's Geocoder. On most phones Google's servers do the lookup, so it needs
   * the internet and can be slow (10 s at most). `max`: 1 to 5, default 1.
   */
  reverseGeocode: (latitude: number, longitude: number, options: { max?: number } = {}): Promise<GeocodeResult> =>
    Native.reverseGeocode({ latitude, longitude, max: options.max }, unowned).catch(() => noAddresses("failed")),
  /** Places for a name or address ("Koramangala, Bengaluru"), best first. Same rules as reverseGeocode. */
  geocode: (query: string, options: { max?: number } = {}): Promise<GeocodeResult> =>
    Native.geocode({ query, max: options.max }, unowned).catch(() => noAddresses("failed")),
}

// ---- React Native's Geolocation, for code moved from RN (@react-native-community/geolocation) ---------------------------

export interface GeoError {
  code: 1 | 2 | 3
  message: string
  PERMISSION_DENIED: 1
  POSITION_UNAVAILABLE: 2
  TIMEOUT: 3
}

export interface GeoOptions {
  /** ms. RN's default is no limit; here at most 60 s. */
  timeout?: number
  /** ms. RN's default: any age (Infinity). */
  maximumAge?: number
  /** true: "high", false (default): "balanced". */
  enableHighAccuracy?: boolean
  /** Watch only: metres. */
  distanceFilter?: number
  /** Watch only: ms. */
  interval?: number
  fastestInterval?: number
}

function geoError(reason: LocationReason | WatchReason): GeoError {
  const code = reason === "denied" || reason === "blocked" ? 1 : reason === "timeout" ? 3 : 2
  return { code, message: `location: ${reason}`, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }
}

let rnConfig = { skipPermissionRequests: false }
const rnWatches = new Map<number, () => void>()
let nextRnWatch = 1

/** Like RN: asks for the permission first, unless `setRNConfiguration({ skipPermissionRequests: true })`. */
async function rnAllowed(): Promise<LocationReason | null> {
  if (rnConfig.skipPermissionRequests) return null
  const s = await status()
  if (s.permission === "granted") return null
  if (s.permission === "blocked") return "blocked"
  const r = await requestPermission()
  return r.permission === "granted" ? null : r.permission
}

export const Geolocation = {
  getCurrentPosition(success: (p: Position) => void, error?: (e: GeoError) => void, options: GeoOptions = {}): void {
    void (async () => {
      const refused = await rnAllowed()
      if (refused) return error?.(geoError(refused))
      const r = await getCurrentPosition({
        accuracy: options.enableHighAccuracy ? "high" : "balanced",
        timeoutMs: options.timeout,
        maxAgeMs: options.maximumAge ?? Number.MAX_SAFE_INTEGER,
      })
      if (r.position) success(r.position)
      else error?.(geoError(r.reason))
    })()
  },
  watchPosition(success: (p: Position) => void, error?: (e: GeoError) => void, options: GeoOptions = {}): number {
    const id = nextRnWatch++
    const stop = watchPosition(success, {
      accuracy: options.enableHighAccuracy ? "high" : "balanced",
      intervalMs: options.interval,
      distanceFilterM: options.distanceFilter,
    }, (reason) => error?.(geoError(reason)))
    rnWatches.set(id, stop)
    return id
  },
  clearWatch(id: number): void {
    rnWatches.get(id)?.()
    rnWatches.delete(id)
  },
  stopObserving(): void {
    for (const stop of rnWatches.values()) stop()
    rnWatches.clear()
  },
  requestAuthorization(success?: () => void, error?: (e: GeoError) => void): void {
    void requestPermission().then((r) => (r.permission === "granted" ? success?.() : error?.(geoError(r.permission))))
  },
  setRNConfiguration(config: { skipPermissionRequests?: boolean }): void {
    rnConfig = { skipPermissionRequests: config.skipPermissionRequests ?? false }
  },
}
