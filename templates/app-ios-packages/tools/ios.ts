// Builds the app for the iOS simulator, installs it on the booted simulator and starts it with its console attached.
// The iOS host is a plain Xcode project (ios/__APP_CLASS__.xcodeproj) on zero-native's Swift package, from the
// checkout below (until the packages are published). Needs Xcode 26 and a booted simulator (open -a Simulator).
//
//   bun run ios                                 JS, build, install, launch
//   bun run ios --build-only                    JS and build only (CI)
//   bun run ios --device "iPhone 16"            another simulator (a name or UDID; default: the booted one)
//   bun run ios --link __APP_NAME__://app/about?from=link   then open this link in the app (iOS asks "Open in ...?" first)
//
// You can also open ios/__APP_CLASS__.xcodeproj in Xcode (after `bun run app:js:ios`) and press Run.
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

const root = join(import.meta.dir, "..")
/** The zero-native checkout (the same folder as package.json, android/gradle.properties and the Xcode project name). */
const zn = resolve(root, "__ZN_DIR__")
const project = join(root, "ios/__APP_CLASS__.xcodeproj")
const scheme = "__APP_CLASS__"
const derived = join(root, "ios/build")
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
    // The filter keeps a good build short; a failed one shows its end, where xcodebuild says why.
    if (quietFilter) console.error((p.stdout.toString() + p.stderr.toString()).trim().split("\n").slice(-40).join("\n"))
    console.error(`failed: ${cmd.join(" ")}`)
    process.exit(1)
  }
}

if (!existsSync(join(zn, "Package.swift"))) {
  console.error(`No zero-native at ${zn}. Change the path in tools/ios.ts, package.json, android/gradle.properties and the Xcode project's package.`)
  process.exit(1)
}
// The Swift package takes Hermes from the checkout's release download (pinned by version and checksum), once.
if (!existsSync(join(zn, "ios/third_party/hermes/release/destroot/Library/Frameworks/universal/hermesvm.xcframework/Info.plist"))) {
  must(["bun", "run", join(zn, "tools/fetch-hermes-apple.ts"), "release"])
}
must(["bun", "run", "app:js:ios"])

// On a CI machine (CI is set) the app isn't signed at all, as zero-native's own CI builds its sample.
const arch = process.arch === "arm64" ? "arm64" : "x86_64"
must(["xcodebuild", "-project", project, "-scheme", scheme, "-destination", "generic/platform=iOS Simulator",
  "-configuration", "Debug", "-derivedDataPath", derived, `ARCHS=${arch}`, "ONLY_ACTIVE_ARCH=YES",
  ...(process.env.CI ? ["CODE_SIGNING_ALLOWED=NO"] : []), "build"], /error:|BUILD (SUCCEEDED|FAILED)/)
if (args.includes("--build-only")) process.exit(0)

const booted = Bun.spawnSync(["xcrun", "simctl", "list", "devices", "booted"], { stdout: "pipe" }).stdout.toString()
if (device === "booted" && !booted.includes("(Booted)")) {
  console.error("No simulator is booted. Start one (open -a Simulator), or pass --device <name or UDID>.")
  process.exit(1)
}
must(["xcrun", "simctl", "install", device, join(derived, `Build/Products/Debug-iphonesimulator/${scheme}.app`)])
const link = opt("--link")
// Attached to the console: the app's prints show here until it exits (Ctrl-C stops watching).
const p = Bun.spawn(["xcrun", "simctl", "launch", "--console-pty", "--terminate-running-process", device, "__APP_ID__"],
  { stdout: "inherit", stderr: "inherit" })
if (link) {
  await Bun.sleep(2000)
  must(["xcrun", "simctl", "openurl", device, link])
}
process.exit(await p.exited)
