// Phone steps for the auth plugin (examples/sample/src/AuthLab.tsx). The phone needs Play services and a SIM with a number.
// Steps with hands: one needs a tap in Google's sheet, and the SMS ones need a second phone to send the text the script prints.
// (The debug sample runs on an x86_64 emulator, but the hint needs a SIM number and the SMS steps a real text: use the phone.)
import { check, CLEAR_TASK, clearLog, expectLog, killInBackground, lines, ok, openFresh, pid, PKG, see, shell, sleep, stopApp, tap, texts, type Step } from "./helpers"

const lab = () => openFresh("dev/auth", "Open hint")

/** Like a tap on the app icon. A plain `am start -n` would put a new Activity on top of Google's sheet. */
const fromIcon = () => shell("am", "start", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", `${PKG}/.MainActivity`)

/** The lab, in a task started from the icon, so fromIcon() brings that same task back after a kill. */
async function labInIconTask() {
  await stopApp()
  clearLog()
  shell("am", "start", "-f", CLEAR_TASK, "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", `${PKG}/.MainActivity`)
  await sleep(2500)
  shell("am", "start", "-a", "android.intent.action.VIEW", "-d", "zn://sample/dev/auth", PKG)
  await see("Open hint", 15000)
}

const focus = () => shell("dumpsys", "window", "displays").match(/mCurrentFocus=.*/)?.[0] ?? ""
const sheetOpen = () => focus().includes("com.google.android.gms")

async function seeSheet() {
  const end = Date.now() + 12000
  while (Date.now() < end) {
    if (sheetOpen()) return
    await sleep(300)
  }
  throw new Error(`Google's sheet never showed (has this phone a SIM with a number?). On top: ${focus()}`)
}

/** Our own log lines, without the part with the process id. An OTP or a phone number must never be in them. */
const logged = (text: string) => lines(/./).some((l) => l.replace(/^.*?\): /, "").includes(text))
const phoneOnScreen = () => texts().find((t) => t.text.startsWith("phone: "))?.text.replace("phone: ", "") ?? "no phone on screen"

/** The app hash, as the SMS must carry it, for the build on this phone. */
async function appHash() {
  await tap("Get hash")
  return (await expectLog(/auth-lab hash: /)).replace("auth-lab hash: ", "").trim()
}

/** Prints the exact text for the second phone. */
const sendThis = (text: string) => console.log(`\n>>> SEND THIS SMS TO THE TEST PHONE, EXACTLY:\n\n${text}\n`)

const SMS_WAIT = 280000
const SMS_HANDS = "Have a second phone ready. The script prints one exact SMS below. Send it to this phone, word for word, within 4 minutes."

export const steps: Step[] = [
  {
    name: "auth app hash",
    run: async () => {
      await lab()
      const hash = await appHash()
      check(/^[A-Za-z0-9+/]{11}$/.test(hash), `not an 11-char hash: ${hash}`)
      ok("app hash", hash)
    },
  },
  {
    name: "auth sms timeout",
    run: async () => {
      await lab()
      const t0 = Date.now()
      await tap("Listen 3s")
      ok("timeout", await expectLog(/auth-lab otp short: none timeout/, 8000))
      check(Date.now() - t0 > 2000, "it ended too soon")
      ok("receiver off", await expectLog(/auth: otp listener off \(timeout\)/))
    },
  },
  {
    name: "auth second listen",
    run: async () => {
      await lab()
      await tap("Listen twice")
      ok("second answers first", await expectLog(/auth-lab otp first: none replaced/))
      await expectLog(/auth: otp listener off \(replaced\)/)
      await tap("Stop listening")
      ok("stop answers second", await expectLog(/auth-lab otp second: none cancelled/))
      await expectLog(/auth: otp listener off \(cancelled\)/)
      const on = lines(/auth: otp listener on/).length
      const off = lines(/auth: otp listener off/).length
      check(on === 2 && off === 2, `listeners on ${on}, off ${off}`)
      ok("no leak", `on ${on}, off ${off}`)
    },
  },
  {
    name: "auth joined listen",
    run: async () => {
      await lab()
      await tap("Listen and join")
      await expectLog(/auth: otp listener on/)
      await tap("Stop listening")
      await expectLog(/auth-lab otp joined-a: none cancelled/)
      ok("both answered", await expectLog(/auth-lab otp joined-b: none cancelled/))
      check(lines(/auth: otp listener on/).length === 1, "the join started a second listener")
    },
  },
  {
    name: "auth bad pattern",
    run: async () => {
      await lab()
      await tap("Listen bad pattern")
      ok("bad pattern", await expectLog(/auth-lab otp bad: none bad_pattern/))
      check(lines(/auth: otp listener on/).length === 0, "a listener started on a bad pattern")
    },
  },
  {
    name: "auth listen outlives its screen",
    run: async () => {
      await lab()
      await tap("Listen")
      await expectLog(/auth: otp listener on/)
      await tap("Rebuild screen")
      await sleep(800)
      check(lines(/auth: otp listener off/).length === 0, "closing the screen stopped the listener")
      await tap("Stop listening")
      ok("still answered", await expectLog(/auth-lab otp main: none cancelled/))
    },
  },
  {
    name: "auth JS replaced while listening",
    run: async () => {
      await lab()
      await tap("Listen")
      await expectLog(/auth: otp listener on/)
      const task = shell("am", "stack", "list").match(/taskId=(\d+):\s*dev\.zeronative\.sample\//)?.[1]
      check(task, "no task for the sample in am stack list")
      const before = pid()
      shell("am", "stack", "remove", task) // like a swipe from recents: the process stays
      await sleep(1000)
      check(pid() === before, "the process died, so JS wasn't replaced in place")
      fromIcon() // a new Activity with no saved state in a running process: starts fresh, on new JS
      ok("receiver off", await expectLog(/auth: otp listener off \(js replaced\)/, 15000))
      ok("started fresh", await expectLog(/starting fresh/))
    },
  },
  {
    name: "auth hint cancelled",
    run: async () => {
      await lab()
      await tap("Open hint")
      await seeSheet()
      shell("input", "keyevent", "KEYCODE_BACK")
      ok("cancelled", await expectLog(/auth-lab hint: none (cancelled|no_number)/))
      await see("Open hint")
    },
  },
  {
    name: "auth no reopen after restore",
    run: async () => {
      await labInIconTask()
      await tap("Open hint")
      await seeSheet()
      shell("input", "keyevent", "KEYCODE_BACK")
      await expectLog(/auth-lab hint: none/)
      await sleep(500)
      await killInBackground()
      clearLog()
      fromIcon()
      await expectLog(/auth-lab rebuilt/, 15000)
      ok("answers, no sheet", await expectLog(/auth-lab hint: none already_asked/))
      await sleep(2500)
      check(!sheetOpen(), "the sheet came back after a restore")
      check(lines(/launch auth\.phone-hint: opened/).length === 0, "the hint opened again after a restore")
    },
  },
  {
    name: "auth kill while the hint is open",
    run: async () => {
      await labInIconTask()
      await tap("Open hint")
      await seeSheet()
      await killInBackground()
      clearLog()
      fromIcon()
      await sleep(2000)
      // Google's sheet may have stayed on top of our task, or closed itself in the background. Both are fine here.
      if (sheetOpen()) shell("input", "keyevent", "KEYCODE_BACK")
      await expectLog(/auth-lab rebuilt/, 15000)
      ok("clean answer", await expectLog(/auth-lab hint: none (cancelled|no_number|lost)/, 15000))
      await sleep(2500)
      check(!sheetOpen(), "the sheet came back after a kill")
      check(lines(/launch auth\.phone-hint: opened/).length === 0, "the hint opened again after a kill")
    },
  },
  {
    name: "auth hint picked",
    hands: "Google's sheet with your phone numbers will open. Tap a number in it.",
    run: async () => {
      await lab()
      await tap("Open hint")
      await seeSheet()
      ok("picked", await expectLog(/auth-lab hint: picked/, 60000))
      await see(/^phone: \+?\d/)
      check(!logged(phoneOnScreen()), "the phone number reached the log")
    },
  },
  {
    name: "auth kill, then pick",
    hands: "The script opens Google's sheet and kills the app behind it. When it prints PICK NOW, tap a number in the sheet.",
    run: async () => {
      await labInIconTask()
      await tap("Open hint")
      await seeSheet()
      await killInBackground()
      clearLog()
      fromIcon()
      await seeSheet()
      console.log("\n>>> PICK NOW\n")
      // On the Lava, Google closes its sheet soon after our process dies (seen 2026-11-03): then there is nothing to pick,
      // and the right answer is the same as in "auth kill while the hint is open".
      const answer = await expectLog(/auth-lab hint: (picked|none (cancelled|no_number|lost))/, 90000)
      if (/picked/.test(answer)) {
        ok("number after a kill", answer)
        await see(/^phone: \+?\d/)
        check(!logged(phoneOnScreen()), "the phone number reached the log")
      } else ok("Google closed its sheet after the kill; clean answer", answer)
      await sleep(2500)
      check(lines(/launch auth\.phone-hint: opened/).length === 0, "the hint opened again after a kill")
      check(!sheetOpen(), "the sheet came back after a kill")
    },
  },
  {
    name: "auth sms read",
    hands: SMS_HANDS,
    run: async () => {
      await lab()
      const hash = await appHash()
      const code = String(100000 + Math.floor(Math.random() * 900000))
      await tap("Listen")
      await expectLog(/auth: otp listener on/)
      sendThis(`<#> ${code} is your test code. ${hash}`)
      await see(`otp: ${code}`, SMS_WAIT)
      ok("code on screen", "read from the SMS")
      await expectLog(/auth-lab otp main: code/)
      ok("receiver off", await expectLog(/auth: otp listener off \(code\)/))
      check(!logged(code), "the OTP reached the log")
    },
  },
  {
    name: "auth sms pattern",
    hands: SMS_HANDS,
    run: async () => {
      await lab()
      const hash = await appHash()
      const code = String(100000 + Math.floor(Math.random() * 900000))
      await tap("Listen pattern")
      await expectLog(/auth: otp listener on/)
      sendThis(`<#> ref 1234 code ${code} ${hash}`)
      await see(`otp: ${code}`, SMS_WAIT)
      ok("the app's pattern", "found the second number")
      check(!logged(code), "the OTP reached the log")
    },
  },
  {
    name: "auth sms with no code",
    hands: SMS_HANDS,
    run: async () => {
      await lab()
      const hash = await appHash()
      await tap("Listen")
      await expectLog(/auth: otp listener on/)
      sendThis(`<#> hello from the test ${hash}`)
      ok("no code", await expectLog(/auth-lab otp main: none no_code/, SMS_WAIT))
      ok("receiver off", await expectLog(/auth: otp listener off \(no_code\)/))
    },
  },
]
