// Phone steps for the push plugin (examples/sample/src/PushLab.tsx). No hands. The local-notification steps work in
// any build; the FCM steps need a sample built WITH android/sample/google-services.json and a gcloud login allowed to
// send FCM messages for the project (tools/push-send.ts); without them those steps say SKIP and pass.
// The notification shade is driven with `cmd statusbar`; texts there are the phone's own (Android 14 on the Lava).
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { check, clearLog, expectLog, ok, openFresh, PKG, shell, sleep, stopApp, tap, texts, type Step } from "./helpers"

const NOTIFY = "android.permission.POST_NOTIFICATIONS"
const lab = () => openFresh("dev/push", "Read status")

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
      await stopApp() // kill -9, as low memory does; not force-stop (DuraSpeed), which also blocks FCM
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
]
