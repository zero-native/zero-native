// Records the zn runtime's Baseline Profile (startup rule 6, docs/startup-and-performance.md) in one command:
//
//   bun run tools/baseline-profile.ts [--avd <name>] [--keep-emulator]
//
// 1. Starts the emulator with no window (default AVD: Medium_Phone_API_33_-_Android_13; Android 13 needs no root to
//    record). If emulator-5554 already runs, it is used and left running.
// 2. Builds the sample's JS, starts tools/fetch-test-server.ts (the tabs lab loads its lists from it, over adb reverse).
// 3. Runs `:runtime:generateBaselineProfile -PznX86Release` with ANDROID_SERIAL=emulator-5554, so Gradle uses only the
//    emulator (the module sets useConnectedDevices: without the serial it would also run on a phone on adb).
// 4. Prints the rule counts, then shuts the emulator down (if this script started it).
//
// Writes android/runtime/src/main/generated/baselineProfiles/baseline-prof.txt: commit it. Never uses a real phone.
// Needs: the Android SDK (ANDROID_HOME, or the default folder) and Android Studio's JDK (or JAVA_HOME).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"

const { values: args } = parseArgs({ options: { avd: { type: "string" }, "keep-emulator": { type: "boolean" } } })

const root = resolve(import.meta.dir, "..")
const androidDir = join(root, "android")
const SERIAL = "emulator-5554"
const AVD = args.avd ?? "Medium_Phone_API_33_-_Android_13"
const profile = join(androidDir, "runtime/src/main/generated/baselineProfiles/baseline-prof.txt")
const logFile = join(root, "android/build/baseline-profile-gradle.log")
const win = process.platform === "win32"

const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ??
  (win ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "Android/Sdk") : join(homedir(), "Library/Android/sdk"))
const emulatorExe = join(sdk, "emulator", win ? "emulator.exe" : "emulator")
const javaHome = process.env.JAVA_HOME ??
  (win ? "C:/Program Files/Android/Android Studio/jbr" : "/Applications/Android Studio.app/Contents/jbr/Contents/Home")
// Every child gets the serial: adb and Gradle then only see the emulator.
const env = { ...process.env, ANDROID_SERIAL: SERIAL, JAVA_HOME: javaHome }

function run(cmd: string[], cwd = root): { code: number; out: string } {
  const p = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" })
  return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() }
}
const adb = (...a: string[]) => run(["adb", "-s", SERIAL, ...a]).out.trim()
const say = (s: string) => console.log(`baseline-profile: ${s}`)

const emulatorRuns = () => run(["adb", "-s", SERIAL, "get-state"]).out.trim() === "device"

async function waitForBoot() {
  const end = Date.now() + 240_000
  while (Date.now() < end) {
    if (emulatorRuns() && adb("shell", "getprop", "sys.boot_completed") === "1") return
    await Bun.sleep(3_000)
  }
  throw new Error(`${SERIAL} did not finish starting within 4 minutes`)
}

function counts() {
  const lines = readFileSync(profile, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "")
  const zn = lines.filter((l) => l.includes("dev/zeronative/")).length
  say(`profile: ${lines.length} rules, ${zn} of them dev/zeronative (${profile})`)
}

let started = false
let server: ReturnType<typeof Bun.spawn> | null = null
try {
  if (emulatorRuns()) {
    say(`${SERIAL} already runs: using it, and leaving it running`)
  } else {
    if (!existsSync(emulatorExe)) throw new Error(`no emulator at ${emulatorExe} (set ANDROID_HOME)`)
    say(`starting ${AVD} with no window`)
    Bun.spawn([emulatorExe, "-avd", AVD, "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot-save"], {
      env, stdout: "ignore", stderr: "ignore",
    })
    started = true
  }
  await waitForBoot()
  say(`${SERIAL} is ready`)

  say("building the sample's JS")
  const js = run(["bun", "run", "sample:js"])
  if (js.code !== 0) throw new Error(`sample:js failed:\n${js.out.trim().split("\n").slice(-8).join("\n")}`)

  // The tabs lab's lists come from this server. If the port is taken, one already runs: fine.
  server = Bun.spawn(["bun", "run", "tools/fetch-test-server.ts"], { cwd: root, env, stdout: "ignore", stderr: "ignore" })
  adb("reverse", "tcp:8788", "tcp:8788")
  adb("reverse", "tcp:8789", "tcp:8789")

  say("recording (takes about 50 minutes on an emulator; Gradle log: android/build/baseline-profile-gradle.log)")
  const gradle = run(
    win ? ["cmd", "/c", join(androidDir, "gradlew.bat"), ":runtime:generateBaselineProfile", "-PznX86Release"]
      : ["./gradlew", ":runtime:generateBaselineProfile", "-PznX86Release"],
    androidDir,
  )
  mkdirSync(dirname(logFile), { recursive: true })
  writeFileSync(logFile, gradle.out)
  if (gradle.code !== 0) {
    const errors = gradle.out.split(/\r?\n/).filter((l) => /error|FAILED|Exception|did not|not found/.test(l)).slice(0, 20)
    throw new Error(`Gradle failed (exit ${gradle.code}). First error lines:\n${errors.join("\n")}`)
  }
  counts()
} finally {
  server?.kill()
  if (emulatorRuns()) {
    adb("reverse", "--remove", "tcp:8788")
    adb("reverse", "--remove", "tcp:8789")
  }
  if (started && !args["keep-emulator"]) {
    say(`shutting ${SERIAL} down`)
    adb("emu", "kill")
  }
}
