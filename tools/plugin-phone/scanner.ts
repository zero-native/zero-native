// Phone steps for the scanner plugin (examples/sample/src/ScannerLab.tsx). The steps that need a QR run last: the owner shows
// any QR on a laptop screen. Native lines are "scanner: ..." (CameraSession.kt).
import { check, clearLog, expectLog, killInBackground, lines, ok, openFresh, PKG, reopen, see, shell, sleep, tap, type Step } from "./helpers"

const CAMERA = "android.permission.CAMERA"
const lab = () => openFresh("dev/scanner", "Open full scanner")
const closeScanner = () => tap("Close")
/** Puts the permission back, with no "don't ask again" left behind. */
function grant() {
  shell("pm", "clear-permission-flags", PKG, CAMERA, "user-fixed", "user-set")
  shell("pm", "grant", PKG, CAMERA)
}
function revoke() {
  shell("pm", "revoke", PKG, CAMERA)
  shell("pm", "clear-permission-flags", PKG, CAMERA, "user-fixed", "user-set")
}
const refuse = () => tap(/^(Don.t allow|Deny)$/i)

export const steps: Step[] = [
  {
    name: "scanner denied permission",
    run: async () => {
      revoke()
      try {
        await lab()
        await tap("Open full scanner")
        await refuse()
        await see("Camera is off")
        await see("Allow camera")
        ok("denied", "message and a way to ask again, not a black screen")
        await tap("Allow camera")
        await refuse()
        await see("Open settings")
        ok("blocked", "the second no ends at the settings button")
        await tap("Open settings")
        await sleep(1200)
        shell("input", "keyevent", "KEYCODE_BACK")
        await see("Open settings")
        await closeScanner()
        ok("way out", await expectLog(/scanner-lab answer: null/))
      } finally {
        grant()
      }
    },
  },
  {
    name: "scanner permission given in settings",
    run: async () => {
      revoke()
      try {
        await lab()
        await tap("Open full scanner")
        await refuse()
        await see("Allow camera")
        shell("input", "keyevent", "KEYCODE_HOME")
        await sleep(800)
        // A grant doesn't restart the app; a revoke does, so this can only be tested this way round.
        shell("pm", "grant", PKG, CAMERA)
        reopen()
        ok("camera after return", await expectLog(/scanner: camera on/, 8000))
        await closeScanner()
      } finally {
        grant()
      }
    },
  },
  {
    name: "scanner view denied",
    run: async () => {
      revoke()
      try {
        await lab()
        await tap("Show view")
        await refuse()
        ok("view hears it", await expectLog(/scanner-lab view permission: denied/))
        await see("Allow camera")
      } finally {
        grant()
      }
    },
  },
  {
    name: "scanner close and back",
    run: async () => {
      grant()
      await lab()
      await tap("Open full scanner")
      ok("camera", await expectLog(/scanner: camera on/, 8000))
      await closeScanner()
      ok("close gives null", await expectLog(/scanner-lab answer: null/))
      ok("no camera leak", await expectLog(/scanner: camera off/))
      clearLog()
      await tap("Open dressed scanner")
      await see("Scan any code at the counter")
      await see("How it works")
      await expectLog(/scanner: camera on/, 8000)
      shell("input", "keyevent", "KEYCODE_BACK")
      ok("back gives null", await expectLog(/scanner-lab answer: null/))
    },
  },
  {
    name: "scanner torch off in background",
    run: async () => {
      grant()
      await lab()
      await tap("Show view")
      await expectLog(/scanner: camera on/, 8000)
      await tap("Torch on")
      await expectLog(/scanner: torch on/)
      clearLog()
      shell("input", "keyevent", "KEYCODE_HOME")
      ok("torch off", await expectLog(/scanner: torch off/))
      ok("JS hears", await expectLog(/scanner-lab view torch went off/))
      // Wait for the stop: a return while only paused keeps the camera open, and "camera on" never comes again.
      await expectLog(/scanner: camera off/, 8000)
      clearLog()
      reopen()
      await expectLog(/scanner: camera on/, 8000)
      await sleep(1000)
      check(lines(/scanner: torch on/).length === 0, "the torch came back by itself")
      ok("no surprise", "torch stayed off on return")
    },
  },
  {
    name: "scanner torch off on the full screen",
    run: async () => {
      grant()
      await lab()
      await tap("Open full scanner")
      await expectLog(/scanner: camera on/, 8000)
      await tap("Turn flash on")
      await expectLog(/scanner: torch on/)
      clearLog()
      shell("input", "keyevent", "KEYCODE_HOME")
      ok("torch off", await expectLog(/scanner: torch off/))
      clearLog()
      reopen()
      await see("Turn flash on")
      await sleep(1000)
      check(lines(/scanner: torch on/).length === 0, "the torch came back by itself")
      await closeScanner()
    },
  },
  {
    name: "scanner covered view",
    run: async () => {
      grant()
      await lab()
      await tap("Show view")
      await expectLog(/scanner: camera on/, 8000)
      await tap("Torch on")
      await expectLog(/scanner: torch on/)
      clearLog()
      await tap("Cover view")
      await see(/^fake screen: Cover/)
      ok("covered: torch", await expectLog(/scanner: torch off/))
      ok("covered: camera", await expectLog(/scanner: camera off/))
      clearLog()
      await tap("Cancel")
      ok("return: camera", await expectLog(/scanner: camera on/, 8000))
      await sleep(800)
      check(lines(/scanner: torch on/).length === 0, "the torch came back by itself")
      ok("return: torch", "stayed off")
    },
  },
  {
    name: "scanner kill while open",
    run: async () => {
      grant()
      await lab()
      await tap("Push full scanner")
      await expectLog(/scanner: camera on/, 8000)
      await killInBackground()
      clearLog()
      reopen()
      await see("Close", 15000)
      ok("restored", await expectLog(/scanner: camera on/, 10000))
      await closeScanner()
      await see("Open full scanner")
    },
  },
  {
    name: "scanner kill and scan",
    hands: "Show a QR code on the laptop and keep it there. Hold the phone away from it. When the scanner opens again, point the phone at the QR.",
    run: async () => {
      grant()
      await lab()
      await tap("Push full scanner")
      await expectLog(/scanner: camera on/, 8000)
      await killInBackground()
      clearLog()
      reopen()
      ok("answer after a kill", await expectLog(/scanner-lab nav result: .+ qr/, 60000))
    },
  },
  {
    name: "scanner scan and double scan",
    hands: "Keep the QR on the laptop, and point the phone at it now. Leave it there for this step: the same code stays in view.",
    run: async () => {
      grant()
      await lab()
      await tap("Open full scanner")
      ok("scan", await expectLog(/scanner-lab answer: .+ qr/, 60000))
      await sleep(2000)
      check(lines(/scanner-lab answer: /).length === 1, "two answers from one open")
      ok("double scan", "one answer, first code won")
      ok("camera stopped", await expectLog(/scanner: camera off/))
    },
  },
  {
    name: "scanner stale frames",
    hands: "Keep the phone pointed at the QR. The scanner opens with the code already in view.",
    run: async () => {
      grant()
      await lab()
      await tap("Open full scanner")
      const line = await expectLog(/scanner: code read \d+ ms after the first frame/, 30000)
      const ms = Number(/read (\d+) ms/.exec(line)![1])
      check(ms >= 500, `a code counted ${ms} ms after the first frame`)
      ok("stale frames, opening", line)
      await expectLog(/scanner-lab answer: .+ qr/)
    },
  },
  {
    name: "scanner stale frames after scan again",
    hands: "Keep the phone pointed at the QR. The view scans, stops, and starts again with the code still in view.",
    run: async () => {
      grant()
      await lab()
      await tap("Show view")
      await expectLog(/scanner-lab view scanned: .+ qr/, 30000)
      await tap("Hide view")
      await tap("Show view")
      await expectLog(/scanner: code read/, 30000)
      clearLog()
      await tap("Scan again")
      const line = await expectLog(/scanner: code read \d+ ms after the first frame/, 30000)
      check(Number(/read (\d+) ms/.exec(line)![1]) >= 500, `too early: ${line}`)
      ok("scan again", line)
      await tap("Hide view")
    },
  },
]
