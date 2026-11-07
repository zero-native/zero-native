// Builds and runs the C++ core tests on this Mac, and with --sim also in a booted iOS simulator. The Mac counterpart
// of tools/run-core-tests.ps1 (which runs them on an Android phone). Needs Xcode, CMake, and Hermes for Apple:
//   bun run tools/fetch-hermes-apple.ts
//   bun run sample:js                       (the engine test runs the sample's main.hbc)
//
//   bun run tools/run-core-tests-apple.ts          Mac only
//   bun run tools/run-core-tests-apple.ts --sim    Mac, then the booted simulator (xcrun simctl boot <device> first)
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const src = join(root, "core/tests/apple")
const hbc = join(root, "android/sample/src/main/assets/main.hbc")
const sim = process.argv.includes("--sim")

function run(cmd: string[], env?: Record<string, string>): number {
  const p = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } })
  return p.exitCode ?? 1
}

function must(cmd: string[]) {
  if (run(cmd) !== 0) throw new Error(`failed: ${cmd.join(" ")}`)
}

if (!existsSync(hbc)) throw new Error(`no ${hbc}: run bun run sample:js first`)

let failed = 0
const testDir = join(tmpdir(), "zn-core-tests")
rmSync(testDir, { recursive: true, force: true })
mkdirSync(testDir, { recursive: true })

// Mac.
const mac = join(root, "core/build-apple/mac")
must(["cmake", "-S", src, "-B", mac, "-DCMAKE_BUILD_TYPE=Debug"])
must(["cmake", "--build", mac, "-j8"])
console.log("\n=== Mac: core tests")
failed += run([join(mac, "zn_core/zn_core_tests")], { ZN_TEST_DIR: testDir }) ? 1 : 0
console.log("\n=== Mac: engine tests")
failed += run([join(mac, "zn_engine_tests"), hbc], { ZN_TEST_DIR: testDir }) ? 1 : 0

// iOS simulator (arm64; CMake builds each test as a .app bundle).
if (sim) {
  const ios = join(root, "core/build-apple/iossim")
  must([
    "cmake", "-S", src, "-B", ios, "-DCMAKE_BUILD_TYPE=Debug", "-DCMAKE_SYSTEM_NAME=iOS",
    "-DCMAKE_OSX_SYSROOT=iphonesimulator", "-DCMAKE_OSX_ARCHITECTURES=arm64", "-DCMAKE_OSX_DEPLOYMENT_TARGET=17.0",
  ])
  must(["cmake", "--build", ios, "-j8"])
  const env = { SIMCTL_CHILD_ZN_TEST_DIR: testDir }
  console.log("\n=== iOS simulator: core tests")
  failed += run(["xcrun", "simctl", "spawn", "booted", join(ios, "zn_core/zn_core_tests.app/zn_core_tests")], env) ? 1 : 0
  console.log("\n=== iOS simulator: engine tests")
  failed += run(["xcrun", "simctl", "spawn", "booted", join(ios, "zn_engine_tests.app/zn_engine_tests"), hbc], env) ? 1 : 0
}

console.log(failed ? `\n${failed} test program(s) failed` : "\nall test programs passed")
process.exit(failed ? 1 : 0)
