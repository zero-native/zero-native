// Phone steps for the push plugin (examples/sample/src/PushLab.tsx). No hands. The local-notification steps work in
// any build; the FCM steps need a sample built WITH android/sample/google-services.json and a gcloud login allowed to
// send FCM messages for the project (tools/push-send.ts); without them those steps say SKIP and pass.
// The notification shade is driven with `cmd statusbar`; texts there are the phone's own (Android 14 on the Lava).
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { adb, check, clearLog, expectLog, killInBackground, lines, ok, openFresh, PKG, shell, sleep, stopApp, tap, texts, type Step } from "./helpers"

const NOTIFY = "android.permission.POST_NOTIFICATIONS"
// The shade closed first: a step that failed with it open would hide the app from the next one.
const lab = () => {
  shell("cmd", "statusbar", "collapse")
  return openFresh("dev/push", "Read status")
}

/** Our notifications on the phone now, by tag (the app's id). */
const shown = () => [...shell("dumpsys", "notification", "--noredact").matchAll(/pkg=dev\.zeronative\.sample[^\n]*?tag=([^\s]+)/g)].map((m) => m[1])

async function seeShown(tag: string, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (shown().includes(tag)) return
    await sleep(300)
  }
  throw new Error(`notification ${tag} not shown; shown: ${shown().join(", ")}`)
}

const openShade = () => shell("cmd", "statusbar", "expand-notifications")

/** The plugin's own native lines (helpers' log filter leaves out zn-push). */
async function expectPushLog(re: RegExp, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = adb("logcat", "-d", "-v", "brief", "-s", "zn-push:*").split(/\r?\n/).filter((l) => re.test(l)).at(-1)
    if (hit) return hit.replace(/^.*?: /, "").trim()
    await sleep(400)
  }
  throw new Error(`never logged ${re}`)
}

/** Taps FCM's own notification (shown while the app is behind) by its body text, from the shade. */
async function tapInShade(body: string) {
  // Wait for FCM's delivery: the shade opened too early closes again when tap() scrolls to look for the text.
  const end = Date.now() + 40000
  while (!shell("dumpsys", "notification", "--noredact").includes(`android.text=String (${body})`)) {
    if (Date.now() > end) throw new Error(`FCM's notification "${body}" never came (on the emulator: svc data disable, then enable)`)
    await sleep(500)
  }
  openShade()
  await sleep(1500)
  await tap(new RegExp(body))
}
const closeShade = () => shell("cmd", "statusbar", "collapse")

/** Sends one FCM message with tools/push-send.ts. Null if this machine can't (no gcloud login, no json). */
function send(args: string[]): string | null {
  const r = spawnSync("bun", ["run", join(import.meta.dir, "..", "push-send.ts"), ...args], { encoding: "utf8" })
  if (r.status !== 0) {
    console.log(`SKIP push send: ${(r.stderr || r.stdout).trim().split("\n").at(-1)}`)
    return null
  }
  return r.stdout.trim()
}

/** The token on the lab screen, or null (no Firebase in this build: the step skips). */
async function token(): Promise<string | null> {
  await tap("Read status")
  const s = await expectLog(/push-lab status /)
  if (!s.includes("available=true")) {
    console.log(`SKIP push FCM: Firebase is off in this build (no android/sample/google-services.json): ${s}`)
    return null
  }
  await tap("Get token")
  const t = await expectLog(/push-lab (token|no token) /, 20000)
  check(t.includes("push-lab token "), `no token: ${t}`)
  return texts().find((x) => x.text.startsWith("token: "))?.text.slice(7) ?? null
}

export const steps: Step[] = [
  {
    name: "push permission",
    run: async () => {
      shell("pm", "grant", PKG, NOTIFY)
      await lab()
      await tap("Read status")
      ok("granted", await expectLog(/push-lab status .*canShow=ok/))
      await stopApp() // a revoke kills a running app
      shell("pm", "revoke", PKG, NOTIFY)
      shell("pm", "clear-permission-flags", PKG, NOTIFY, "user-set", "user-fixed")
      await lab()
      await tap("Read status")
      ok("revoked", await expectLog(/push-lab status .*canShow=off/))
      await tap("Show plain")
      ok("not shown without it", await expectLog(/push-lab show plain shown=false reason=off/))
      await tap("Ask permission")
      await sleep(1500)
      await tap(/^Allow$/)
      ok("allowed in Android's dialog", await expectLog(/push-lab permission granted/))
    },
  },
  {
    name: "push local notifications",
    run: async () => {
      shell("pm", "grant", PKG, NOTIFY)
      await lab()
      await tap("Cancel all")
      await tap("Show plain")
      ok("plain", await expectLog(/push-lab show plain shown=true/))
      await seeShown("lab-plain")
      await tap("Show long text")
      await expectLog(/push-lab show long shown=true/)
      await tap("Show picture")
      ok("picture", await expectLog(/push-lab show picture shown=true/, 12000))
      await tap("Show group of 3")
      await expectLog(/push-lab show group 3/)
      await seeShown("zn-summary:lab-group")
      ok("group summary", shown().filter((t) => t.startsWith("lab-group-")).length + " in the group, summary shown")
      await tap("Show with link")
      await expectLog(/push-lab show link shown=true/)
      clearLog()
      openShade()
      await sleep(1200)
      await tap(/Lab: link/)
      ok("tap opens the route", await expectLog(/push-lab opened from notification/, 10000))
      closeShade()
    },
  },
  {
    name: "push swipe away",
    run: async () => {
      shell("pm", "grant", PKG, NOTIFY)
      await lab()
      await tap("Show plain")
      await seeShown("lab-plain")
      clearLog()
      openShade()
      await sleep(1200)
      await tap(/^Clear all$/i)
      ok("dismiss task ran", await expectLog(/push-lab dismissed lab-plain from=plain/, 10000))
      closeShade()
    },
  },
  {
    name: "push data message in front",
    run: async () => {
      shell("pm", "grant", PKG, NOTIFY)
      await lab()
      const t = await token()
      if (!t) return
      clearLog()
      const sent = send(["--token", t, "--data", "lab=show,id=fcm-front,title=Push lab,body=Sent in front,link=zn://sample/dev/push?from=push"])
      if (!sent) return
      ok("sent", sent)
      ok("task ran", await expectLog(/push-lab message lab=show inFront=true/, 30000))
      ok("shown", await expectLog(/push-lab message shown=true/))
      await seeShown("fcm-front")
    },
  },
  {
    name: "push data message with the app closed",
    run: async () => {
      shell("pm", "grant", PKG, NOTIFY)
      await lab()
      const t = await token()
      if (!t) return
      // Behind, then killed as low memory does. Not stopApp(): on the emulator it falls back to a force-stop, and
      // Android gives no FCM message to a force-stopped app (DuraSpeed blocks it on the Lava too).
      await killInBackground()
      check(!shell("pidof", PKG).trim(), "the app still runs")
      clearLog()
      const sent = send(["--token", t, "--data", "lab=show,id=fcm-closed,title=Push lab,body=Sent while closed,link=zn://sample/dev/push?from=push"])
      if (!sent) return
      ok("sent", sent)
      ok("app started for it, task ran", await expectLog(/push-lab message lab=show inFront=false/, 40000))
      await seeShown("fcm-closed")
      clearLog()
      openShade()
      await sleep(1200)
      await tap(/Sent while closed/)
      ok("tap opens the route", await expectLog(/push-lab opened from push/, 15000))
      closeShade()
    },
  },
  {
    name: "push fcm notification tapped, app behind",
    run: async () => {
      shell("pm", "grant", PKG, NOTIFY)
      await lab()
      const t = await token()
      if (!t) return
      shell("input", "keyevent", "KEYCODE_HOME")
      await sleep(1500)
      clearLog()
      const sent = send(["--token", t, "--notification", "Push lab|Opened while behind", "--data", "lab=opened-behind"])
      if (!sent) return
      ok("sent", sent)
      await tapInShade("Opened while behind")
      ok("onNotificationOpenedApp", await expectLog(/push-lab fcm opened lab=opened-behind/, 15000))
      closeShade()
    },
  },
  {
    name: "push fcm notification tapped, app closed",
    run: async () => {
      shell("pm", "grant", PKG, NOTIFY)
      await lab()
      const t = await token()
      if (!t) return
      await killInBackground() // as low memory does: FCM still delivers (a force-stop would block it)
      clearLog()
      const sent = send(["--token", t, "--notification", "Push lab|Opened while closed", "--data", "lab=opened-closed"])
      if (!sent) return
      ok("sent", sent)
      await tapInShade("Opened while closed")
      ok("getInitialNotification", await expectLog(/push-lab initial lab=opened-closed/, 20000))
      closeShade()
    },
  },
  {
    name: "push ota check message",
    run: async () => {
      await lab()
      const t = await token()
      if (!t) return
      clearLog()
      const sent = send(["--token", t, "--data", "zn_ota=check"])
      if (!sent) return
      ok("sent", sent)
      ok("asked", await expectPushLog(/OTA check asked/, 30000))
      ok("checked", await expectPushLog(/OTA check from push: /, 30000))
      await sleep(1000)
      check(!lines(/push-lab message /).length, "the OTA message reached JS")
      ok("not in JS", "no push-lab message line")
    },
  },
  {
    name: "push buttons on a notification",
    run: async () => {
      shell("pm", "grant", PKG, NOTIFY)
      await lab()
      await tap("Read status")
      await expectLog(/push-lab status /)
      await tap("Show with buttons")
      ok("shown", await expectLog(/push-lab show buttons shown=true/))
      await seeShown("lab-buttons")
      clearLog()
      openShade()
      await sleep(1500)
      await tap(/^Later$/i)
      ok("button task", await expectLog(/push-lab action later on lab-buttons from=buttons input=-/, 15000))
      await sleep(1000)
      check(!shown().includes("lab-buttons"), "the task's cancel left it on screen")
      ok("cancelled by the task", "gone")
      closeShade()

      await tap("Show with buttons")
      await seeShown("lab-buttons")
      openShade()
      await sleep(1500)
      await tap(/^Reply$/i)
      await sleep(1200)
      shell("input", "text", "hello")
      await sleep(500)
      await tap("Send") // the reply field's send button (Enter doesn't send it)
      ok("reply task", await expectLog(/push-lab action reply on lab-buttons from=buttons input=hello/, 15000))
      await sleep(800)
      check(shell("dumpsys", "notification", "--noredact").includes("android.text=String (You said: hello)"), "the task's update didn't show")
      ok("updated by the task", "You said: hello")
      closeShade()

      await tap("Show with buttons")
      await seeShown("lab-buttons")
      clearLog()
      openShade()
      await sleep(1500)
      await tap(/^Pay now$/i)
      ok("link button opens the route", await expectLog(/push-lab opened from action/, 15000))
      closeShade()
    },
  },
  {
    name: "push lists, progress and lock screen",
    run: async () => {
      shell("pm", "grant", PKG, NOTIFY)
      await lab()
      await tap("Read status")
      await expectLog(/push-lab status /)
      await tap("Show progress")
      await seeShown("lab-progress")
      await tap("Show private")
      await seeShown("lab-private")
      const dump = shell("dumpsys", "notification", "--noredact")
      const block = (tag: string) => dump.split(/NotificationRecord\(/).find((b) => b.includes(`tag=${tag}`)) ?? ""
      check(/android\.progress=Integer \(30\)/.test(block("lab-progress")), "no progress 30 in the dump")
      // Notification.FLAG_ONGOING_EVENT (0x2) and FLAG_ONLY_ALERT_ONCE (0x8).
      const flags = parseInt(/flags=0x([0-9a-f]+)/.exec(block("lab-progress"))?.[1] ?? "0", 16)
      check((flags & 0x2) !== 0 && (flags & 0x8) !== 0, `lab-progress flags 0x${flags.toString(16)}: not ongoing and alert-once`)
      ok("progress", `android.progress=30, flags 0x${flags.toString(16)}`)
      check(/vis=SECRET/.test(block("lab-private")), "lab-private is not secret on the lock screen")
      ok("secret", "vis=SECRET")
      await tap("List shown")
      const listed = await expectLog(/push-lab displayed \d+ /)
      check(listed.includes("lab-progress:progress") && listed.includes("lab-private:private"), `not listed: ${listed}`)
      ok("getDisplayed", listed)
      await tap("List channels")
      const ch = await expectLog(/push-lab channels \d+ /)
      check(/lab_high=high\/lab/.test(ch) && /lab_quiet=low\/lab/.test(ch), `channels: ${ch}`)
      ok("getChannels", ch)
      await tap("Cancel all")
    },
  },
  {
    name: "push scheduled notifications",
    run: async () => {
      shell("pm", "grant", PKG, NOTIFY)
      await lab()
      await tap("Read status")
      await expectLog(/push-lab status /)
      await tap("Cancel all")
      await tap("Schedule daily")
      ok("daily", await expectLog(/push-lab schedule daily scheduled=true/))
      await tap("Schedule in 5 s")
      ok("once", await expectLog(/push-lab schedule once scheduled=true/))
      await tap("List scheduled")
      ok("listed", await expectLog(/push-lab scheduled 2 lab-scheduled:once,lab-daily:daily/))
      // The app closed (as low memory does): the alarm shows it with no JS.
      await killInBackground()
      await seeShown("lab-scheduled", 11 * 60_000) // not exact: within 10 minutes of its time
      ok("shown by the alarm, app closed", "lab-scheduled")
      // dumpsys shows the alarm's action, not its data: after the one-time one, the daily one is the app's only one.
      const ours = shell("dumpsys", "alarm").match(/dev\.zeronative\.sample\}\s+tag=\*walarm\*:dev\.zeronative\.push\.TRIGGER[^\n]*\n[^\n]*window=(\S+)/g) ?? []
      check(ours.length === 1, `the app has ${ours.length} scheduled alarms, not 1 (the daily one)`)
      check(/window=\+10m0s0ms/.test(ours[0]), `the daily alarm's window is not 10 minutes: ${ours[0]}`)
      ok("daily alarm still set, 10 minute window", "dumpsys alarm")
      await lab()
      await tap("List scheduled")
      ok("once is gone, daily stays", await expectLog(/push-lab scheduled 1 lab-daily:daily/))
      await tap("Power status")
      ok("power", await expectLog(/push-lab power exact=(true|false) optimized=(true|false)/))
    },
  },
]
