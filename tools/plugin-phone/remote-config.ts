// Phone steps for the Remote Config plugin (examples/sample/src/RemoteConfigLab.tsx). No hands. Needs a sample built
// WITH android/sample/google-services.json; without it every step says SKIP and passes. The sample's Firebase project
// has the parameter zn_lab_greeting = "hello from Remote Config" (added 2026-11-04; tools/remote-config-lab.ts).
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { check, expectLog, ok, openFresh, sleep, tap, type Step } from "./helpers"

export const steps: Step[] = [
  {
    name: "remote config defaults, fetch and activate",
    run: async () => {
      await openFresh("dev/remote-config", "Set defaults")
      await tap("Set defaults")
      const d = await expectLog(/remote-config-lab defaults ok=/)
      if (d.includes("ok=false")) {
        console.log("SKIP remote config: Firebase is off in this build (no android/sample/google-services.json)")
        return
      }
      await tap("Read values")
      ok("defaults", await expectLog(/remote-config-lab values greeting=\S.* number=7 available=true/))
      await tap("Fetch every time")
      ok("settings", await expectLog(/remote-config-lab settings ok=true/))
      await tap("Fetch and activate")
      const f = await expectLog(/remote-config-lab fetched /, 30000)
      check(f.includes("ok=true") && f.includes("status=success"), `fetch failed: ${f}`)
      ok("fetched", f)
      await tap("Read values")
      const v = await expectLog(/remote-config-lab values greeting=hello from Remote Config source=remote number=7/)
      ok("remote value, and a default for the key the console doesn't have", v)
    },
  },
  {
    name: "remote config after a restart, from Firebase's cache",
    run: async () => {
      await openFresh("dev/remote-config", "Set defaults")
      await tap("Set defaults") // its answer brings the values Firebase kept from the last activate
      const d = await expectLog(/remote-config-lab defaults ok=/)
      if (d.includes("ok=false")) return console.log("SKIP remote config: Firebase is off in this build")
      await tap("Read values")
      ok("kept", await expectLog(/remote-config-lab values greeting=hello from Remote Config source=remote/))
    },
  },
  {
    name: "remote config live update",
    run: async () => {
      await openFresh("dev/remote-config", "Set defaults")
      await tap("Set defaults")
      const d = await expectLog(/remote-config-lab defaults ok=/)
      if (d.includes("ok=false")) return console.log("SKIP remote config: Firebase is off in this build")
      await tap("Listen for updates")
      await expectLog(/remote-config-lab listening/)
      await sleep(3000) // the stream connects
      // Publish a new value from the computer, then the old one back.
      const stamp = `hello at ${Date.now() % 100000}`
      const r = spawnSync("bun", ["run", join(import.meta.dir, "..", "remote-config-lab.ts"), "--value", stamp], { encoding: "utf8" })
      if (r.status !== 0) return console.log(`SKIP remote config live update: ${(r.stderr || r.stdout).trim().split("\n").at(-1)}`)
      ok("published", r.stdout.trim())
      ok("update heard", await expectLog(/remote-config-lab updated keys=zn_lab_greeting error=-/, 120000))
      await tap("Fetch and activate")
      await expectLog(/remote-config-lab fetched ok=true/, 30000)
      await tap("Read values")
      ok("new value", await expectLog(new RegExp(`remote-config-lab values greeting=${stamp} source=remote`)))
      spawnSync("bun", ["run", join(import.meta.dir, "..", "remote-config-lab.ts")], { encoding: "utf8" })
    },
  },
]
