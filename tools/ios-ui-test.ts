// Runs the sample's UI tests (ios/SamplePackage/ZnSampleUITests, XCUITest) on one simulator, headless: builds the
// package sample and its test bundle (Debug), boots the simulator if it is off, runs the tests, prints one line per
// test and shuts the simulator down again if this run booted it. The JS bundle must be built first (bun run sample:js).
//   bun run tools/ios-ui-test.ts                              every test, on the first iPhone simulator
//   bun run tools/ios-ui-test.ts --device "iPhone 16"         another simulator (a name or UDID; or ZN_UI_TEST_DEVICE)
//   bun run tools/ios-ui-test.ts --only ComponentsTests       one class (or Class/testName); --only can repeat
//   bun run tools/ios-ui-test.ts --build-only | --test-only   just build, or run what was built before
//   bun run tools/ios-ui-test.ts --packages <dir>             SwiftPM checkouts kept between runs (CI's cache)
//   bun run tools/ios-ui-test.ts --derived-data <dir>         the build folder (default ios/build/ui-test)
//   bun run tools/ios-ui-test.ts --dump a11yLab [--ready id]  print a route's accessibility tree (to write a test)
//   bun run tools/ios-ui-test.ts --keep-booted                leave a simulator this run booted on afterwards
//   bun run tools/ios-ui-test.ts --only X/testY --repeat 5    run the tests 5 times (each run counts; to check a flaky one)
//   TEST_RUNNER_ZN_APP_<NAME>=v bun run tools/ios-ui-test.ts   the app gets <NAME>=v in its environment (ZnUITestCase)
import { existsSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root = join(import.meta.dir, "..")

export type SimDevice = { name: string; udid: string; state: string; isAvailable?: boolean; runtime: string }

// The simulators `xcrun simctl list devices available -j` lists, flattened, with their runtime ("iOS-26-3").
export function simDevices(json: string): SimDevice[] {
  const byRuntime = (JSON.parse(json).devices ?? {}) as Record<string, Omit<SimDevice, "runtime">[]>
  return Object.entries(byRuntime).flatMap(([rt, list]) =>
    list.filter((d) => d.isAvailable !== false).map((d) => ({ ...d, runtime: rt.replace(/^.*SimRuntime\./, "") })),
  )
}

// The one asked for (a UDID, else an exact name, the newest iOS first), or with none asked the first iPhone on the
// newest iOS. Undefined when there is no such simulator.
export function pickDevice(devices: SimDevice[], want?: string): SimDevice | undefined {
  const ios = devices.filter((d) => d.runtime.startsWith("iOS"))
  const version = (d: SimDevice) => d.runtime.replace(/^iOS-/, "").split("-").map(Number)
  const newestFirst = [...ios].sort((a, b) => {
    const [x, y] = [version(a), version(b)]
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0)
    return 0
  })
  if (want) return ios.find((d) => d.udid === want) ?? newestFirst.find((d) => d.name === want)
  return newestFirst.find((d) => d.name.startsWith("iPhone"))
}

// One line per finished test from xcodebuild's output ("Test Case '-[ZnSampleUITests.X testY]' passed (3.1 s)."),
// as "passed  X/testY  3.1 s"; undefined for every other line.
export function testLine(line: string): string | undefined {
  const m = line.match(/Test Case '-\[\w+\.(\w+) (\w+)\]' (passed|failed|skipped) \(([\d.]+) seconds\)/)
  return m ? `${m[3].padEnd(7)} ${m[1]}/${m[2]}  ${m[4]} s` : undefined
}

function opt(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function opts(name: string): string[] {
  return process.argv.flatMap((a, i) => (a === name && process.argv[i + 1] ? [process.argv[i + 1]] : []))
}

function sh(cmd: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync(cmd, { cwd: root, stdout: "pipe", stderr: "pipe" })
  return { ok: p.exitCode === 0, out: p.stdout.toString() + p.stderr.toString() }
}

async function main() {
  if (process.platform !== "darwin") throw new Error("iOS UI tests need a Mac with Xcode")
  const buildOnly = process.argv.includes("--build-only")
  const testOnly = process.argv.includes("--test-only")
  const derived = resolve(root, opt("--derived-data") ?? "ios/build/ui-test")
  const packages = opt("--packages")
  // --repeat takes a count (a missing one would take the next flag as it).
  const repeat = opt("--repeat")
  if (process.argv.includes("--repeat") && !/^[1-9]\d*$/.test(repeat ?? "")) {
    console.error("ios-ui-test: --repeat takes a count of 1 or more (--repeat 5)")
    process.exit(2)
  }

  if (!existsSync(join(root, "android/sample/src/main/assets/main.hbc"))) {
    throw new Error("no JS bundle (android/sample/src/main/assets/main.hbc). Run: bun run sample:js")
  }
  const list = sh(["xcrun", "simctl", "list", "devices", "available", "-j"])
  if (!list.ok) throw new Error(`simctl list failed:\n${list.out}`)
  const want = opt("--device") ?? process.env.ZN_UI_TEST_DEVICE
  const device = pickDevice(simDevices(list.out), want)
  if (!device) throw new Error(want ? `no simulator "${want}" (xcrun simctl list devices)` : "no iPhone simulator")

  // The same arguments for both steps, so test-without-building finds what build-for-testing made.
  const common = [
    "-project", "ios/SamplePackage/ZnSamplePackage.xcodeproj",
    "-scheme", "ZnSamplePackage",
    "-configuration", "Debug",
    // This Mac's arch only (a simulator offers arm64 and x86_64 on Apple silicon).
    "-destination", `id=${device.udid},arch=${process.arch === "arm64" ? "arm64" : "x86_64"}`,
    "-derivedDataPath", derived,
    // The package versions in Package.resolved only, as CI's and the release's builds of this project.
    "-onlyUsePackageVersionsFromResolvedFile",
    ...(packages ? ["-clonedSourcePackagesDirPath", resolve(root, packages)] : []),
  ]
  // Simulator builds need no signing identity (as CI's builds). So no entitlements are embedded: a test of a
  // Keychain screen (SecureStore) would get -34018 and needs an ad hoc signed build (CODE_SIGN_IDENTITY=-).
  const settings = ["CODE_SIGNING_ALLOWED=NO"]

  if (!testOnly) {
    console.log(`ui-test: building for ${device.name} (${device.runtime}) into ${derived}`)
    const t0 = Date.now()
    const b = Bun.spawnSync(["xcodebuild", "build-for-testing", ...common, ...settings, "-quiet"], {
      cwd: root, stdout: "inherit", stderr: "inherit",
    })
    if (b.exitCode !== 0) throw new Error("build failed")
    console.log(`ui-test: built in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  }
  if (buildOnly) return

  const booted = device.state === "Booted"
  if (!booted) {
    console.log(`ui-test: booting ${device.name}`)
    const boot = sh(["xcrun", "simctl", "bootstatus", device.udid, "-b"])
    if (!boot.ok) throw new Error(`couldn't boot ${device.name}:\n${boot.out}`)
  }
  const result = join(derived, "ZnSampleUITests.xcresult")
  rmSync(result, { recursive: true, force: true })
  const only = opts("--only").map((o) => `-only-testing:ZnSampleUITests/${o}`)
  // --dump <route>: DumpTests prints that route's accessibility tree (xcodebuild hands TEST_RUNNER_* to the tests).
  const dump = opt("--dump")
  const dumpEnv: Record<string, string> = dump
    ? { TEST_RUNNER_ZN_UI_DUMP_ROUTE: dump, TEST_RUNNER_ZN_UI_DUMP_READY: opt("--ready") ?? "" }
    : {}
  if (dump && only.length === 0) only.push("-only-testing:ZnSampleUITests/DumpTests")
  // Only the tree: DumpTests prints it between these two lines.
  let inDump = false
  const dumpOut = (line: string) => {
    if (line.includes("ZN-DUMP-BEGIN")) inDump = true
    else if (line.includes("ZN-DUMP-END")) inDump = false
    else return inDump
    return false
  }
  const log = join(derived, "ui-test.log")
  let text = ""
  let code = 1
  try {
    const p = Bun.spawn(
      ["xcodebuild", "test-without-building", ...common, ...settings, "-resultBundlePath", result,
        "-parallel-testing-enabled", "NO", "-test-timeouts-enabled", "YES", "-maximum-test-execution-time-allowance", "120",
        ...(repeat ? ["-test-iterations", repeat] : []),
        ...only],
      { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...dumpEnv } },
    )
    // One line per test as it ends; failures with their message (file:line: error: ...).
    const show = (line: string) => {
      const t = testLine(line)
      if (t) console.log(t)
      else if (dumpOut(line)) console.log(line)
      else if (/: error: |\*\* TEST|Testing failed|Test session results|^\s+Executed \d+ tests?/.test(line)) console.log(line)
    }
    const read = async (s: ReadableStream<Uint8Array>) => {
      let rest = ""
      for await (const chunk of s) {
        const lines = (rest + new TextDecoder().decode(chunk)).split("\n")
        rest = lines.pop() ?? ""
        for (const l of lines) { text += l + "\n"; show(l) }
      }
      if (rest) { text += rest; show(rest) }
    }
    await Promise.all([read(p.stdout), read(p.stderr)])
    code = await p.exited
  } finally {
    writeFileSync(log, text)
    if (!booted && !process.argv.includes("--keep-booted")) sh(["xcrun", "simctl", "shutdown", device.udid])
  }
  console.log(`ui-test: ${code === 0 ? "passed" : "FAILED"}; full log ${log}, results ${result}`)
  process.exit(code)
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`ui-test: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  })
}
