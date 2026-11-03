// Phone steps for the location plugin (examples/sample/src/LocationLab.tsx). No hands: the script taps Android's permission
// dialog itself. It turns location off and takes the permission away, and puts both back after each step.
// Indoors is fine: the network provider answers there. On the emulator, `adb emu geo fix 77.6 12.9` gives a GPS fix first.
import { check, clearLog, expectLog, lines, ok, openFresh, PKG, reopen, see, shell, sleep, stopApp, tap, texts, type Step } from "./helpers"

const FINE = "android.permission.ACCESS_FINE_LOCATION"
const COARSE = "android.permission.ACCESS_COARSE_LOCATION"

const lab = () => openFresh("dev/location", "Get once")

const permissions = () => {
  const d = shell("dumpsys", "package", PKG)
  return { fine: d.includes(`${FINE}: granted=true`), coarse: d.includes(`${COARSE}: granted=true`) }
}
const locationOn = () => shell("cmd", "location", "is-location-enabled").trim() === "true"
const setLocation = (on: boolean) => shell("cmd", "location", "set-location-enabled", String(on))

function grant() {
  shell("pm", "grant", PKG, FINE)
  shell("pm", "grant", PKG, COARSE)
}

/** Takes both away, so Android shows its dialog again. The app is ended first: a revoke kills a running app. */
async function revoke() {
  await stopApp()
  for (const p of [FINE, COARSE]) {
    shell("pm", "revoke", PKG, p)
    shell("pm", "clear-permission-flags", PKG, p, "user-set", "user-fixed")
  }
}

/** Puts both back as they were before the step. */
async function restore(before: { fine: boolean; coarse: boolean }, on = true) {
  setLocation(on)
  if (before.fine && before.coarse) return grant()
  await revoke()
  if (before.coarse) shell("pm", "grant", PKG, COARSE)
}

const focus = () => shell("dumpsys", "window", "displays").match(/mCurrentFocus=.*/)?.[0] ?? ""
const dialogOpen = () => focus().includes("permissioncontroller")

/** Google's "turn on location" dialog is a Play services window on top of ours. */
const googleDialog = () => focus().includes("com.google.android.gms")

async function seeGoogleDialog(ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (googleDialog()) return true
    await sleep(300)
  }
  return false
}

async function seeDialog(ms = 6000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (dialogOpen()) return true
    await sleep(300)
  }
  return false
}

/**
 * This app's live location requests: the providers' "listeners:" lines of `dumpsys location`, like
 * `11444/dev.zeronative.sample/63A29CE1 Request[@+2s0ms BALANCED, ...]`. History lines say "+registration" instead.
 * Only the request part is kept: other lines of that dump hold real coordinates, and they must not reach the output.
 */
const liveRequests = () =>
  shell("dumpsys", "location")
    .split(/\r?\n/)
    .filter((l) => new RegExp(`^\\s*\\d+/${PKG.replaceAll(".", "\\.")}/[0-9A-F]+ .*Request\\[`).test(l) && !l.includes("registration"))
    .map((l) => l.trim().replace(/,? ?WorkSource\{.*$/, ""))

/** Before every step: permissions granted and location on, from a known state. */
async function ready() {
  const before = { ...permissions(), on: locationOn() }
  grant()
  setLocation(true)
  await lab()
  return before
}

export const steps: Step[] = [
  {
    name: "location fix",
    run: async () => {
      const before = await ready()
      try {
        await tap("Get once")
        const fix = await expectLog(/location-lab once balanced: (fix|none)/, 12000)
        check(fix.includes(": fix "), `no fix: ${fix}`)
        ok("fix", fix)
        ok("took", await expectLog(/location-lab once balanced took/))
        ok("asked", await expectLog(/location: ask on /))
        ok("listeners off", await expectLog(/location: ask off \(fix/))
        check(texts().some((t) => /^position: -?\d+\.\d{5}, -?\d+\.\d{5}/.test(t.text)), "no position on screen")
        check(!lines(/location/).some((l) => /\d+\.\d{4,}/.test(l)), "a coordinate is in the log")
        ok("no coordinate in the log", "checked")
        await tap("Reverse geocode")
        ok("reverse geocode", await expectLog(/location-lab reverse: /, 15000))
        await tap("Geocode")
        ok("geocode", await expectLog(/location-lab geocode: /, 15000))
      } finally {
        await restore(before, before.on)
      }
    },
  },
  {
    name: "location cached low and timeout",
    run: async () => {
      const before = await ready()
      try {
        await tap("Get once")
        await expectLog(/location-lab once balanced: fix/, 12000)
        await tap("Get cached")
        ok("cached", await expectLog(/location-lab once cached: fix/))
        ok("from cache, nothing started", await expectLog(/location: ask answered from cache/))
        await tap("Get once low")
        ok("low", await expectLog(/location-lab once low: (fix|none)/, 12000))
        ok("low skips the GPS", await expectLog(/location: ask on network \(low\)/))
        clearLog()
        await tap("Get once 1s high")
        const short = await expectLog(/location-lab once short: /, 6000)
        const took = Number((await expectLog(/location-lab once short took \d+ms/)).match(/(\d+)ms/)![1])
        check(took < 2500, `1 s timeout took ${took} ms`)
        ok("1 s high", `${short}, ${took} ms`)
        ok("listeners off", await expectLog(/location: ask off \((timeout|fix)/))
      } finally {
        await restore(before, before.on)
      }
    },
  },
  {
    name: "location watch pauses in background",
    run: async () => {
      const before = await ready()
      try {
        await tap("Watch")
        await expectLog(/location: watch \d+ on /)
        await expectLog(/location-lab watch: fix/, 15000)
        check(liveRequests().length > 0, "no live request while watching")
        ok("watching", `${lines(/location-lab watch: fix/).length} fixes, ${liveRequests().length} live requests`)
        shell("input", "keyevent", "KEYCODE_HOME")
        ok("paused", await expectLog(/location: watch \d+ paused/))
        await sleep(1500)
        check(liveRequests().length === 0, `still asking in background: ${liveRequests().join(" | ")}`)
        ok("no request in background", "dumpsys location")
        clearLog()
        reopen()
        ok("resumed", await expectLog(/location: watch \d+ resumed/))
        ok("fixes again", await expectLog(/location-lab watch: fix/, 15000))
        await tap("Stop watch")
        ok("stopped", await expectLog(/location: watch \d+ off \(stopped\)/))
        await sleep(1000)
        check(liveRequests().length === 0, "a request left after stop")
      } finally {
        await restore(before, before.on)
      }
    },
  },
  {
    name: "location one-shot in background",
    run: async () => {
      const before = await ready()
      try {
        await tap("Get once high")
        await expectLog(/location: ask on /)
        shell("input", "keyevent", "KEYCODE_HOME")
        ok("answered", await expectLog(/location-lab once high: (fix|none background)/))
        ok("listeners off", await expectLog(/location: ask off \((background|fix)/))
        reopen()
        await see("Get once")
      } finally {
        await restore(before, before.on)
      }
    },
  },
  {
    name: "location screen closes stops watch",
    run: async () => {
      const before = await ready()
      try {
        await tap("Watch")
        await expectLog(/location: watch \d+ on /)
        shell("input", "keyevent", "KEYCODE_BACK")
        ok("stopped with its screen", await expectLog(/location: watch \d+ off \(stopped\)/))
      } finally {
        await restore(before, before.on)
      }
    },
  },
  {
    name: "location off",
    run: async () => {
      const before = await ready()
      try {
        setLocation(false)
        await sleep(800)
        await tap("Read status")
        ok("status", await expectLog(/location-lab status .*enabled=false/))
        await tap("Get once")
        ok("one-shot", await expectLog(/location-lab once balanced: none off/))
        await tap("Watch")
        ok("watch", await expectLog(/location-lab watch: error off/))
        setLocation(true)
        ok("watch goes on when turned on", await expectLog(/location-lab watch: fix/, 20000))
        await tap("Stop watch")
        await tap("Location settings")
        await sleep(1500)
        check(focus().includes("settings"), `not the settings screen: ${focus()}`)
        ok("settings screen", focus())
        clearLog()
        shell("input", "keyevent", "KEYCODE_BACK")
        ok("read again on return", await expectLog(/location-lab status /))
      } finally {
        await restore(before, before.on)
      }
    },
  },
  {
    name: "location turn on dialog",
    run: async () => {
      const before = await ready()
      try {
        await tap("Turn on location")
        ok("already on: no dialog", await expectLog(/location-lab turn on: on/))
        check(!googleDialog(), "a dialog showed while location was on")

        setLocation(false)
        await sleep(800)
        clearLog()
        await tap("Turn on location")
        check(await seeGoogleDialog(), `no Google dialog. On top: ${focus()}`)
        ok("dialog", texts().map((t) => t.text).filter((t) => t.length < 60).join(" | "))
        await tap(/^No,? thanks$/i)
        ok("no thanks", await expectLog(/location-lab turn on: declined/))
        check(!locationOn(), "location turned on after No thanks")

        clearLog()
        await tap("Turn on location")
        check(await seeGoogleDialog(), "no Google dialog the second time")
        await tap(/^(Turn on|OK)$/i)
        ok("turn on", await expectLog(/location-lab turn on: on/))
        check(locationOn(), "location still off after Turn on")
        ok("location on", "cmd location is-location-enabled")
        await tap("Get once")
        ok("a fix right after", await expectLog(/location-lab once balanced: fix/, 12000))
      } finally {
        await restore(before, before.on)
      }
    },
  },
  {
    name: "location denied blocked approximate",
    run: async () => {
      const before = { ...permissions(), on: locationOn() }
      setLocation(true)
      try {
        await revoke()
        await lab()
        await tap("Get once")
        ok("no permission, no dialog", await expectLog(/location-lab once balanced: none (denied|blocked)/))
        check(!dialogOpen(), "a one-shot showed a dialog")

        // Core's "location" is the precise permission alone (ZnPermissions.kt). Does Android 14 show a dialog for it?
        await tap("Core ask location")
        const coreDialog = await seeDialog()
        ok("core 'location' shows a dialog", String(coreDialog))
        if (coreDialog) await tap(/^Don.t allow$/)
        ok("core answer", await expectLog(/location-lab core location /))

        // That "Don't allow" counts: a second one now would block. Start the count again.
        await revoke()
        await lab()
        await tap("Ask permission")
        check(await seeDialog(), "no dialog")
        await tap(/^Don.t allow$/)
        ok("first no", await expectLog(/location-lab permission denied/))
        await tap("Get once")
        ok("denied", await expectLog(/location-lab once balanced: none denied/))
        await tap("Ask permission")
        if (await seeDialog()) await tap(/^Don.t allow$/)
        ok("second no", await expectLog(/location-lab permission (denied|blocked)/))
        await tap("Get once")
        ok("blocked", await expectLog(/location-lab once balanced: none blocked/))
        await tap("Ask permission")
        ok("blocked shows nothing", await expectLog(/location-lab permission blocked/))
        check(!dialogOpen(), "a dialog showed while blocked")

        await revoke()
        await lab()
        await tap("Ask permission")
        check(await seeDialog(), "no dialog")
        await tap("Approximate")
        await tap("While using the app")
        ok("approximate", await expectLog(/location-lab permission granted precise=false/))
        await tap("Get once")
        const rough = await expectLog(/location-lab once balanced: (fix|none)/, 12000)
        check(rough.includes("fix network"), `rough fix: ${rough}`)
        // Android sends a rough-only app its cached rough fix at once, and a new one at most every 10 minutes.
        const took = Number((await expectLog(/location-lab once balanced took \d+ms/)).match(/(\d+)ms/)![1])
        check(took < 4000, `the rough fix took ${took} ms: it waited for a new one`)
        ok("rough fix, network only, at once", `${rough}, ${took} ms`)
      } finally {
        await restore(before, before.on)
      }
    },
  },
]
