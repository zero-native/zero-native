// Builds the app for the iOS simulator, installs it on the booted simulator and starts it with its console attached
// (as zero-native's tools/ios-sample.ts). Needs Xcode 26 and CMake (brew install cmake), and a booted simulator
// (open -a Simulator).
//
//   bun run ios                                 JS, build, install, launch
//   bun run ios --build-only                    JS and build only (CI)
//   bun run ios --device "iPhone 16"            another simulator (a name or UDID; default: the booted one)
//   bun run ios --link __APP_NAME__://app/about?from=link   then open this link in the app (iOS asks "Open in ...?" first)
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

const root = join(import.meta.dir, "..")
/** The zero-native checkout (the same folder as package.json, android/gradle.properties and ios/CMakeLists.txt name). */
const zn = resolve(root, "__ZN_DIR__")
const buildDir = join(root, "ios/build/sim")
const target = "__APP_CLASS__"
const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const device = opt("--device") ?? "booted"

function must(cmd: string[], quietFilter?: RegExp) {
  const p = Bun.spawnSync(cmd, { cwd: root, stdout: quietFilter ? "pipe" : "inherit", stderr: quietFilter ? "pipe" : "inherit" })
  if (quietFilter) {
    const out = p.stdout.toString() + p.stderr.toString()
    for (const line of out.split("\n")) if (quietFilter.test(line)) console.log(line)
  }
  if (p.exitCode !== 0) {
    console.error(`failed: ${cmd.join(" ")}`)
    process.exit(1)
  }
}

if (!existsSync(join(zn, "ios/ZnRuntime/Host/ZNHost.mm"))) {
  console.error(`No zero-native at ${zn}. Change the path in tools/ios.ts, package.json, android/gradle.properties and ios/CMakeLists.txt.`)
  process.exit(1)
}
// Hermes for Apple platforms, once per zero-native checkout (pinned by version and checksum).
if (!existsSync(join(zn, "ios/third_party/hermes/debug/destroot/Library/Frameworks/universal/hermesvm.xcframework/Info.plist"))) {
  must(["bun", "run", join(zn, "tools/fetch-hermes-apple.ts")])
}
must(["bun", "run", "app:js:ios"])

// Configured every time (about a second): the Swift files are globbed, so a new file needs a configure.
if (!existsSync(join(buildDir, `${target}.xcodeproj`))) {
  must(["cmake", "-G", "Xcode", "-S", join(root, "ios"), "-B", buildDir, "-DCMAKE_SYSTEM_NAME=iOS",
    "-DCMAKE_OSX_SYSROOT=iphonesimulator"], /error|Error/)
} else {
  must(["cmake", "-S", join(root, "ios"), "-B", buildDir], /error|Error/)
}
// By -target, not -scheme: Xcode 26 lists no destinations while the iOS device platform isn't installed. On a CI
// machine (CI is set) the app isn't signed at all, as zero-native's own CI builds its sample.
const arch = process.arch === "arm64" ? "arm64" : "x86_64"
must(["xcodebuild", "-project", join(buildDir, `${target}.xcodeproj`), "-target", target, "-sdk", "iphonesimulator",
  "-configuration", "Debug", `ARCHS=${arch}`, "ONLY_ACTIVE_ARCH=YES", ...(process.env.CI ? ["CODE_SIGNING_ALLOWED=NO"] : []),
  "build"], /error:|BUILD (SUCCEEDED|FAILED)/)
if (args.includes("--build-only")) process.exit(0)

const booted = Bun.spawnSync(["xcrun", "simctl", "list", "devices", "booted"], { stdout: "pipe" }).stdout.toString()
if (device === "booted" && !booted.includes("(Booted)")) {
  console.error("No simulator is booted. Start one (open -a Simulator), or pass --device <name or UDID>.")
  process.exit(1)
}
must(["xcrun", "simctl", "install", device, join(buildDir, `Debug-iphonesimulator/${target}.app`)])
const link = opt("--link")
// Attached to the console: the app's prints show here until it exits (Ctrl-C stops watching).
const p = Bun.spawn(["xcrun", "simctl", "launch", "--console-pty", "--terminate-running-process", device, "__APP_ID__"],
  { stdout: "inherit", stderr: "inherit" })
if (link) {
  await Bun.sleep(2000)
  must(["xcrun", "simctl", "openurl", device, link])
}
process.exit(await p.exited)
