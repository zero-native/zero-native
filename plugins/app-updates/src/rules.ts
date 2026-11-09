// When to ask the user for a store update. Pure logic: the store answer, Play, the clock, the "busy" state and the
// current screen are passed in, so every rule has a test with fakes (test/rules.test.ts). Ported from ZeroBill's
// src/system/appUpdate.ts (itself a port of the RN app's appUpdateService.ts and AppUpdateHost.tsx).
//
//   no update in the server's answer      -> nothing (no Play call)
//   Play has no update for this phone     -> ignore, ask again on the next return (staged rollout, Play is slow to see it)
//   critical 2 (forced)                   -> Android: Play's IMMEDIATE update (full screen; cancel opens it again)
//                                            iOS: the app's own full-screen "update" screen, shown on every start / return
//   critical 1 (optional)                 -> Android: Play's FLEXIBLE sheet. iOS: the app's own sheet.
//                                            Once per session, never on the "hold" routes (login, OTP)
//   the app is busy (a payment, a form)   -> nothing at all; the next return checks again
// A downloaded optional update is installed when the user comes back to the app, never while the app is busy.
// The check runs 1 s after start and 1 s after every return to the app, or (autoCheck false) after each of native's
// update checks, which bring the store answer.
//
// No import from @zero-native/core here: the file runs in plain bun tests.

/** One update rule from the server, for this phone. */
export interface StoreUpdate {
  /** The store version to reach: Android versionCode (a number), iOS "1.6.2". */
  version: number | string
  /** 1 = optional, 2 = forced. */
  critical: 1 | 2
  /** Text the app's own update screen may show (the server's rule). */
  title?: string
  message?: string
}

/** What the server says about this phone (with the OTA check: `Updates.status().store`). `update` null = nothing to do. */
export interface StoreCheck {
  update: StoreUpdate | null
  /** Store facts: the App Store id on iOS (for the "Update" button). */
  store: { appStoreId?: string }
}

/** Where the store answer comes from. `null` = no answer (offline, a server error): ask again next time. Never throws. */
export interface StoreSource {
  get(): Promise<StoreCheck | null>
}

/** Play's install state, as the native module sends it (same names as RN's `onUpdateState`). */
export interface PlayUpdateState {
  status: "accepted" | "declined" | "pending" | "downloading" | "downloaded" | "failed" | "canceled"
  bytesDownloaded: number
  totalBytes: number
  errorCode: number
}

/** The Play Core calls (Android). They never reject. */
export interface PlayUpdates {
  isAvailable(): Promise<{ available: boolean }>
  /** Opens Play's sheet: `flexible` true = optional (download in the background), false = forced (full screen). */
  start(options: { flexible: boolean }): Promise<unknown>
  /** Installs a downloaded update (Play restarts the app). */
  complete(): Promise<unknown>
}

/** The app's own update screens (iOS, or Android without Play). */
export interface UpdatePrompt {
  /** A full-screen screen the user can't close; its button opens the store. Called again on every start / return. */
  forced(update: StoreUpdate, store: StoreCheck["store"]): void
  /** A sheet the user can close. Called at most once per session. */
  optional(update: StoreUpdate, store: StoreCheck["store"]): void
}

export type TimerHandle = unknown

export interface Clock {
  setTimeout(fn: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

export interface Logger {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
}

export interface AppUpdateDeps {
  source: StoreSource
  /** Android: Play's in-app updates. When given, Play shows the update and `prompt` is not used. */
  play?: PlayUpdates
  /** iOS (or an Android app without Play): the app's own screens. */
  prompt?: UpdatePrompt
  /** The app is busy: a payment, a checkout, a form being sent. Nothing is shown or installed then. */
  isBusy(): boolean
  /** The top screen's route name, or undefined while the app has no screen yet. */
  currentRoute(): string | undefined
  /** Routes where the optional update waits (login, OTP). Forced updates do not wait. */
  holdRoutes?: ReadonlySet<string>
  /** The app is in front (the user can touch it). */
  isFront(): boolean
  /** Resolves when the app knows where it is going (the stored login), so the first answer lands on the right screen. */
  ready?: Promise<unknown>
  /**
   * True (default): a check 1 s after `onStart` and after each `onActive`. False: the app calls `check()` itself, e.g.
   * `checkAfterUpdateChecks(engine)` with `nativeStoreSource` (the answer comes with native's update check, so the
   * engine checks when that answer is new); `onActive` then only installs a downloaded update.
   */
  autoCheck?: boolean
  clock?: Clock
  log?: Logger
}

/** The check runs 1 s after start and after every return (RN `CHECK_DELAY_MS`). */
export const CHECK_DELAY_MS = 1000
/** An optional update that waits for a hold route to close asks again this often (zn has no "route changed" event). */
export const WAIT_RECHECK_MS = 2000
/** Play's availability answer counts as "none" after this (native answers "no update" itself after 10 s). */
export const PLAY_ANSWER_LIMIT_MS = 15_000

export type UpdatePhase = "idle" | "downloading" | "downloaded"

export interface AppUpdateEngine {
  /** One check now. Never throws. A second call while one runs does nothing. */
  check(): Promise<void>
  /** Start of the app: a check in 1 s. */
  onStart(): void
  /** The app came to the front: installs a downloaded update (not while busy), then a check in 1 s. */
  onActive(): void
  /** Install state from native (the Play sheet's answer, download progress, downloaded, failed). */
  onUpdateState(event: PlayUpdateState): void
  /** Installs a downloaded optional update now. Not while busy. */
  installDownloadedOnReturn(): void
  phase(): UpdatePhase
}

const defaultClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export function createAppUpdateEngine(deps: AppUpdateDeps): AppUpdateEngine {
  const { source, play, prompt } = deps
  const clock = deps.clock ?? defaultClock
  const log = deps.log ?? console
  const hold = deps.holdRoutes ?? new Set<string>()
  const TAG = "[AppUpdates]"

  /** A check is running (start, return and a waiting recheck can overlap). */
  let running = false
  let shownOptional = false
  let phase: UpdatePhase = "idle"
  let checkTimer: TimerHandle | null = null
  let waitTimer: TimerHandle | null = null

  function schedule(ms: number): void {
    if (checkTimer !== null) clock.clearTimeout(checkTimer)
    checkTimer = clock.setTimeout(() => {
      checkTimer = null
      void engine.check()
    }, ms)
  }

  /** [p]'s value, or null when it hasn't settled within [ms]. A rejection stays a rejection. */
  function withinLimit<T>(p: Promise<T>, ms: number): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
      const timer = clock.setTimeout(() => resolve(null), ms)
      p.then(
        (v) => {
          clock.clearTimeout(timer)
          resolve(v)
        },
        (e) => {
          clock.clearTimeout(timer)
          reject(e)
        },
      )
    })
  }

  /** The optional update waits for the user to leave a hold route: ask again soon, only while the app is in front. */
  function waitAndRecheck(): void {
    if (waitTimer !== null) return
    waitTimer = clock.setTimeout(() => {
      waitTimer = null
      if (deps.isFront()) void engine.check()
    }, WAIT_RECHECK_MS)
  }

  const engine: AppUpdateEngine = {
    phase: () => phase,

    onUpdateState(event) {
      switch (event.status) {
        case "accepted":
        case "pending":
        case "downloading":
          if (phase !== "downloaded") phase = "downloading"
          break
        case "downloaded":
          phase = "downloaded"
          break
        case "failed":
        case "canceled":
        case "declined":
          log.log(`${TAG} optional update ${event.status}${event.errorCode ? ` (error ${event.errorCode})` : ""}`)
          phase = "idle"
          break
      }
    },

    installDownloadedOnReturn() {
      if (!play || phase !== "downloaded" || deps.isBusy()) return
      log.log(`${TAG} update downloaded and the app is back in front: installing`)
      play.complete().catch((e) => log.warn(`${TAG} install on return failed:`, e))
    },

    onStart() {
      if (deps.autoCheck !== false) schedule(CHECK_DELAY_MS)
    },

    onActive() {
      engine.installDownloadedOnReturn()
      if (deps.autoCheck !== false) schedule(CHECK_DELAY_MS)
    },

    async check() {
      if (running) return
      if (deps.isBusy()) return
      running = true
      try {
        if (deps.ready) await deps.ready
        const answer = await source.get()
        if (!answer) {
          log.log(`${TAG} no answer from the store check (offline?); asking again on the next return`)
          return
        }
        const update = answer.update
        if (!update) return // Up to date: no Play call at all
        log.log(`${TAG} store ${update.version}, critical ${update.critical}`)

        // The app may have become busy while waiting
        if (deps.isBusy()) return
        if (update.critical === 1) {
          // The optional update shows once per session
          if (shownOptional) return
          const route = deps.currentRoute()
          // No screen yet counts as "not ready": the first screen may still change (Home sends a logged-out user to Login)
          if (route === undefined || hold.has(route)) {
            log.log(`${TAG} optional update waits until the user leaves ${route ?? "the start"}`)
            waitAndRecheck()
            return
          }
        }

        if (play) {
          // Play may not offer the build to this phone yet (staged rollout, propagation): ask again next return
          // With a time limit: a Play answer that never comes would keep `running` true, and no later check would run
          const status = await withinLimit(play.isAvailable(), PLAY_ANSWER_LIMIT_MS)
          if (status === null) {
            log.warn(`${TAG} Play gave no answer in ${PLAY_ANSWER_LIMIT_MS} ms; asking again on the next return`)
            return
          }
          if (!status.available) {
            log.log(`${TAG} Play has no update for this phone yet. Asking again on the next return.`)
            return
          }
          // The app may have become busy while Play answered: Play's sheet must not cover a payment
          if (deps.isBusy()) return
          if (update.critical === 2) {
            log.log(`${TAG} forced update: opening Play's full-screen update`)
            await play.start({ flexible: false })
            return
          }
          shownOptional = true
          log.log(`${TAG} optional update: opening Play's sheet`)
          // Its answer arrives as onUpdateState accepted / declined
          await play.start({ flexible: true })
          return
        }

        if (!prompt) {
          log.log(`${TAG} no Play and no prompt given: nothing to show`)
          return
        }
        if (update.critical === 2) {
          log.log(`${TAG} forced update: showing the app's update screen`)
          prompt.forced(update, answer.store)
          return
        }
        shownOptional = true
        log.log(`${TAG} optional update: showing the app's update sheet`)
        prompt.optional(update, answer.store)
      } catch (e) {
        // An update-check error must never affect the app; the next return checks again
        log.warn(`${TAG} check failed:`, e)
      } finally {
        running = false
      }
    },
  }

  return engine
}
