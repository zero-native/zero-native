// Builds the iOS sample app (ios/CMakeLists.txt) for the simulator, installs it on the booted simulator and starts it
// with its console attached. Needs Xcode, CMake, `bun run tools/fetch-hermes-apple.ts` and `bun run sample:js`.
//
//   bun run tools/ios-sample.ts                        build, install, launch (route "amount")
//   bun run tools/ios-sample.ts --count                log SwiftUI body runs per batch (ZN_COUNT_BODIES=1)
//   bun run tools/ios-sample.ts --delay 3000           start JS 3 s late, to see the skeleton alone
//   bun run tools/ios-sample.ts --route home --params '{}'
//   bun run tools/ios-sample.ts --build-only
import { existsSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const buildDir = join(root, "ios/build/sim")
const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function must(cmd: string[], quietFilter?: RegExp) {
  const p = Bun.spawnSync(cmd, { stdout: quietFilter ? "pipe" : "inherit", stderr: quietFilter ? "pipe" : "inherit" })
  if (quietFilter) {
    const out = p.stdout.toString() + p.stderr.toString()
    for (const line of out.split("\n")) if (quietFilter.test(line)) console.log(line)
  }
  if (p.exitCode !== 0) throw new Error(`failed: ${cmd.join(" ")}`)
}

// Configured every time (about a second): the Swift files are globbed, so a new file needs a configure.
if (!existsSync(join(buildDir, "zn_ios.xcodeproj"))) {
  must(["cmake", "-G", "Xcode", "-S", join(root, "ios"), "-B", buildDir, "-DCMAKE_SYSTEM_NAME=iOS",
    "-DCMAKE_OSX_SYSROOT=iphonesimulator"], /error|Error/)
} else {
  must(["cmake", "-S", join(root, "ios"), "-B", buildDir], /error|Error/)
}
// By -target, not -scheme: Xcode 26 lists no destinations while the iOS device platform isn't installed.
must(["xcodebuild", "-project", join(buildDir, "zn_ios.xcodeproj"), "-target", "ZnSample", "-sdk", "iphonesimulator",
  "-configuration", "Debug", "ARCHS=arm64", "ONLY_ACTIVE_ARCH=YES", "build"], /error|BUILD (SUCCEEDED|FAILED)/)
if (args.includes("--build-only")) process.exit(0)

const app = join(buildDir, "Debug-iphonesimulator/ZnSample.app")
must(["xcrun", "simctl", "install", "booted", app])
const env: Record<string, string> = { ...process.env } as Record<string, string>
if (args.includes("--count")) env.SIMCTL_CHILD_ZN_COUNT_BODIES = "1"
// i.1c switches (ios/ZnRuntime/Swift/ZnImpl.swift): ZN_IOS_PRESS=swiftui bun run tools/ios-sample.ts
for (const [k, v] of Object.entries(process.env)) if (k.startsWith("ZN_IOS_") && v) env[`SIMCTL_CHILD_${k}`] = v
// Plugin test hooks, e.g. ZN_SCANNER_FAKE=<code>: the scanner reads that code on a simulator with no camera (debug).
if (process.env.ZN_SCANNER_FAKE) env.SIMCTL_CHILD_ZN_SCANNER_FAKE = process.env.ZN_SCANNER_FAKE
if (opt("--delay")) env.SIMCTL_CHILD_ZN_JS_DELAY_MS = opt("--delay")!
if (opt("--route")) env.SIMCTL_CHILD_ZN_ROUTE = opt("--route")!
if (opt("--params")) env.SIMCTL_CHILD_ZN_PARAMS = opt("--params")!
// Attached to the console: the app's prints show here until it exits (Ctrl-C stops watching).
const p = Bun.spawn(["xcrun", "simctl", "launch", "--console-pty", "--terminate-running-process", "booted",
  "dev.zeronative.sample"], { stdout: "inherit", stderr: "inherit", env })
process.exit(await p.exited)
